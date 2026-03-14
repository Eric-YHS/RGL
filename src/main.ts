import "./style.css";

import type { ExperimentConfig, RevealMode } from "./experiment/types";
import { ExperimentEngine } from "./experiment/engine";
import type { ClientDeviceInfo, SessionSubmission } from "./experiment/logger";
import { ExperimentLogger } from "./experiment/logger";
import { formatMoney, formatSeconds } from "./experiment/utils";
import { World2D } from "./scene/world2d";

type RunKind = "practice" | "formal";
type SubmitOutcome = "sent" | "queued";

const params = new URLSearchParams(window.location.search);
const participantId = (params.get("pid") ?? "").trim();
const apiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const PENDING_SUBMISSIONS_KEY = "honglvdeng_pending_submissions_v1";

function normalizeApiBaseUrl(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function makeApiUrl(pathname: string): string {
  if (apiBaseUrl) return `${apiBaseUrl}${pathname}`;
  return pathname;
}

function createClientSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rand = Math.random().toString(36).slice(2);
  return `fallback-${Date.now().toString(36)}-${rand}`;
}

function makeConfig(revealMode: RevealMode, numLights: number): ExperimentConfig {
  return {
    revealMode,
    numLights,
    segmentDurationSec: 4,
    redWaitSec: 5,
    startMoney: 10,
    moneyLossPerSec: 0.1
  };
}

let formalConfig: ExperimentConfig = makeConfig("full", 5);
let practiceConfig: ExperimentConfig = makeConfig("full", 2);

function createLogger(config: ExperimentConfig, runKind_: RunKind): ExperimentLogger {
  return new ExperimentLogger(config, {
    participantId,
    startedAtIso: new Date().toISOString(),
    runKind: runKind_
  });
}

type SubmissionApiResponse = {
  ok: boolean;
  sessionId: number;
  deduplicated?: boolean;
};

function loadPendingSubmissions(): SessionSubmission[] {
  try {
    const raw = window.localStorage.getItem(PENDING_SUBMISSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SessionSubmission[];
  } catch {
    return [];
  }
}

function savePendingSubmissions(payloads: SessionSubmission[]): void {
  try {
    if (payloads.length === 0) {
      window.localStorage.removeItem(PENDING_SUBMISSIONS_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_SUBMISSIONS_KEY, JSON.stringify(payloads));
  } catch {
    // Ignore storage quota errors; submission retries will still work for current tab.
  }
}

function enqueuePendingSubmission(payload: SessionSubmission): void {
  const pending = loadPendingSubmissions();
  const idx = pending.findIndex((p) => p.clientSessionId === payload.clientSessionId);
  if (idx >= 0) {
    pending[idx] = payload;
  } else {
    pending.push(payload);
  }
  savePendingSubmissions(pending);
}

function removePendingSubmission(clientSessionId: string): void {
  const pending = loadPendingSubmissions();
  const next = pending.filter((p) => p.clientSessionId !== clientSessionId);
  if (next.length !== pending.length) savePendingSubmissions(next);
}

async function postSubmission(payload: SessionSubmission): Promise<SubmissionApiResponse> {
  const res = await fetch(makeApiUrl("/api/submissions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  const body: unknown = await res.json();
  const data = body as Partial<SubmissionApiResponse>;
  if (!data.ok || typeof data.sessionId !== "number") {
    throw new Error("Unexpected submission response");
  }
  return {
    ok: true,
    sessionId: data.sessionId,
    deduplicated: Boolean(data.deduplicated)
  };
}

async function submitSubmissionWithFallback(payload: SessionSubmission): Promise<SubmitOutcome> {
  try {
    await postSubmission(payload);
    removePendingSubmission(payload.clientSessionId);
    return "sent";
  } catch (err) {
    console.error("[submitSubmissionWithFallback] failed, queued for retry:", err);
    enqueuePendingSubmission(payload);
    return "queued";
  }
}

async function flushPendingSubmissions(): Promise<void> {
  const pending = loadPendingSubmissions();
  if (pending.length === 0) return;
  const remained: SessionSubmission[] = [];

  for (const payload of pending) {
    try {
      await postSubmission(payload);
    } catch (err) {
      console.error("[flushPendingSubmissions] still pending:", err);
      remained.push(payload);
    }
  }

  savePendingSubmissions(remained);
}

function collectDeviceInfo(): ClientDeviceInfo {
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  };
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

app.innerHTML = `
  <div class="stage">
    <canvas class="webgl" aria-label="实验场景"></canvas>

    <div class="hud">
      <div class="left">
        <div class="panel panel-control">
          <div class="panel-head">
            <div class="panel-title">控制</div>
            <div class="hint" id="runHint"></div>
          </div>
          <div class="control-actions">
            <button class="btn primary" id="btnStart">开始</button>
            <div class="hint control-tip">
              提示：仅在<strong>红灯等待</strong>时点击“通行（WALK）”才会闯红灯。
            </div>
          </div>
        </div>

        <div class="panel status panel-status">
          <div class="row"><div class="label">当前位置</div><div class="value" id="posText">—</div></div>
          <div class="row"><div class="label">耗费时间</div><div class="value" id="timeText">0.0s</div></div>
          <div class="row"><div class="label">剩余金额</div><div class="value money" id="moneyText">￥10.00</div></div>
          <div class="row" id="lightRow" style="display:none;"><div class="label">信号灯</div><div class="value" id="lightText">—</div></div>
        </div>

      </div>
    </div>

    <div class="center-controls">
      <button class="btn danger" id="btnWalk" disabled>通行（WALK）</button>
    </div>

    <div class="modal" id="modal">
      <div class="card" id="modalCard"></div>
    </div>
  </div>
`;

const els = {
  canvas: document.querySelector<HTMLCanvasElement>("canvas.webgl")!,
  runHint: document.querySelector<HTMLDivElement>("#runHint")!,
  btnStart: document.querySelector<HTMLButtonElement>("#btnStart")!,
  btnWalk: document.querySelector<HTMLButtonElement>("#btnWalk")!,
  posText: document.querySelector<HTMLDivElement>("#posText")!,
  timeText: document.querySelector<HTMLDivElement>("#timeText")!,
  moneyText: document.querySelector<HTMLDivElement>("#moneyText")!,
  lightText: document.querySelector<HTMLDivElement>("#lightText")!,
  lightRow: document.querySelector<HTMLDivElement>("#lightRow")!,
  modal: document.querySelector<HTMLDivElement>("#modal")!,
  modalCard: document.querySelector<HTMLDivElement>("#modalCard")!
};

let runKind: RunKind = "practice";
let currentConfig: ExperimentConfig = practiceConfig;
let logger: ExperimentLogger = createLogger(currentConfig, runKind);
let engine: ExperimentEngine = new ExperimentEngine(currentConfig, logger);
let world: World2D | null = null;
let formalClientSessionId = createClientSessionId();
let formalSubmission: SessionSubmission | null = null;

function updateTopHints(): void {
  els.runHint.textContent = runKind === "practice" ? "练习" : "正式实验";
}

function openModal(html: string): void {
  els.modalCard.innerHTML = html;
  els.modal.style.display = "grid";
}

function closeModal(): void {
  els.modal.style.display = "none";
}

function switchRun(next: RunKind): void {
  runKind = next;
  currentConfig = next === "practice" ? practiceConfig : formalConfig;
  logger = createLogger(currentConfig, runKind);
  engine = new ExperimentEngine(currentConfig, logger);
  formalClientSessionId = createClientSessionId();
  formalSubmission = null;
  world?.dispose();
  world = new World2D(els.canvas, currentConfig);
  lastPhase = engine.state.phase;
  finishGate = false;
  updateTopHints();
}

function buildFormalSubmission(): SessionSubmission {
  if (runKind !== "formal") {
    throw new Error("Formal submission requested outside formal run");
  }
  return logger.buildSubmission({
    clientSessionId: formalClientSessionId,
    submittedAtIso: new Date().toISOString(),
    summary: {
      elapsedSec: engine.state.elapsedSec,
      money: engine.state.money,
      violations: engine.state.violations
    },
    device: collectDeviceInfo()
  });
}

function setRevealMode(mode: RevealMode): void {
  formalConfig = makeConfig(mode, 5);
  practiceConfig = makeConfig(mode, 2);
  switchRun("practice");
}

function showRevealModeSelect(): void {
  openModal(`
    <h1>请选择呈现方式</h1>
    <p class="hint">请在开始前选择一种呈现方式（本次任务中将保持不变）。</p>
    <div class="actions" style="flex-direction:column; align-items:stretch; gap:12px;">
      <button class="btn primary" id="btnRevealFull">全呈现（一次性显示所有信号灯）</button>
      <button class="btn" id="btnRevealSequential">逐个呈现（前方有雾，逐步揭示）</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnRevealFull")?.addEventListener("click", () => {
    setRevealMode("full");
    showPracticeIntro();
  });
  document
    .querySelector<HTMLButtonElement>("#btnRevealSequential")
    ?.addEventListener("click", () => {
      setRevealMode("sequential");
      showPracticeIntro();
    });
}

function showPracticeIntro(): void {
  openModal(`
    <h1>熟悉基本操作</h1>
    <p>在该部分，您需要控制屏幕上的“虚拟人”行走。</p>
    <ul>
      <li>点击屏幕左侧的【开始】按钮，“虚拟人”将开始行走。</li>
      <li>行走途中将遇到交通信号灯，红灯会阻止通行，等待一段时间后会变为绿灯。</li>
      <li>您可以点击屏幕中央的【通行（WALK）】按钮在红灯时直接通行。</li>
    </ul>
    <p class="hint">阅读完后，请点击左侧【开始】按钮开始练习。</p>
    <h2>示例短片</h2>
    <p class="hint">请将示例短片放到 <code>public/demo.mp4</code>。</p>
    <video style="width:100%; border-radius:14px; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.04);" controls muted playsinline>
      <source src="/demo.mp4" type="video/mp4" />
    </video>
    <div class="actions">
      <button class="btn primary" id="btnBeginPractice">我已阅读</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnBeginPractice")?.addEventListener("click", () => {
    closeModal();
  });
}

function showPracticeComplete(): void {
  openModal(`
    <h1>练习已完成</h1>
    <p>如果您没有疑问，请进入正式决策任务。</p>
    <div class="actions">
      <button class="btn primary" id="btnToFormal">进入正式实验</button>
    </div>
  `);
  document.querySelector<HTMLButtonElement>("#btnToFormal")?.addEventListener("click", () => {
    switchRun("formal");
    showFormalIntro();
  });
}

function showFormalIntro(): void {
  openModal(`
    <h1>正式决策任务</h1>
    <p>请注意，实验正式开始；请仔细阅读，确保理解每一个细节。</p>
    <h2>场景设置</h2>
    <ul>
      <li>点击左侧【开始】按钮后，“虚拟人”将开始行走并经过一系列交通信号灯。</li>
      <li>两个交通信号灯之间的行走距离固定为 <strong>${currentConfig.segmentDurationSec}s</strong>。</li>
    </ul>
    <h2>交通机制</h2>
    <ul>
      <li>任务开始时，所有路灯均为红色。</li>
      <li>当“虚拟人”到达路口时将自动停下等待红灯。</li>
      <li>等待 <strong>${currentConfig.redWaitSec}s</strong> 后，红灯将自动转为绿灯。</li>
    </ul>
    <h2>操作按钮</h2>
    <ul>
      <li>屏幕中央有一个【通行（WALK）】按钮，您可以在任何时刻点击（无论行走中还是等待中）。</li>
      <li>但只有当“虚拟人”<strong>等待红灯</strong>时点击，才会驱使“虚拟人”闯红灯；行走途中点击无任何效果。</li>
    </ul>
    <h2>收益规则</h2>
    <ul>
      <li>本阶段初始资金 <strong>￥${currentConfig.startMoney.toFixed(2)}</strong>。</li>
      <li>每耗时 <strong>1</strong> 秒，资金减少 <strong>￥${currentConfig.moneyLossPerSec.toFixed(
        2
      )}</strong>。</li>
      <li>规则要求：在每个交通信号灯前等待，直到红灯变绿，方可通行。</li>
    </ul>
    <div class="actions">
      <button class="btn primary" id="btnToCompTest">下一步：理解测试</button>
    </div>
    <p class="hint" style="margin-top:10px;">阅读完提示语后，请先完成下一页“理解测试”。</p>
  `);

  document.querySelector<HTMLButtonElement>("#btnToCompTest")?.addEventListener("click", () => {
    showFormalComprehensionTest();
  });
}

function showFormalComprehensionTest(): void {
  openModal(`
    <h1>理解测试</h1>
    <p>根据上一页说明，为获得最大经济收益，我应该闯红灯以便缩短时间；但为了遵守规则，我必须等待红灯变绿。</p>
    <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:8px;">
      <label style="display:flex; gap:8px; align-items:center; cursor:pointer;">
        <input type="radio" name="comp" value="yes" />
        <span>是</span>
      </label>
      <label style="display:flex; gap:8px; align-items:center; cursor:pointer;">
        <input type="radio" name="comp" value="no" />
        <span>否</span>
      </label>
      <div class="hint" id="compHint"></div>
    </div>
    <div class="actions">
      <button class="btn" id="btnBackToFormalIntro">返回提示语</button>
      <button class="btn primary" id="btnBeginFormal">我已作答，去开始</button>
    </div>
    <p class="hint" style="margin-top:10px;">作答后，请点击左侧【开始】按钮开始正式实验。</p>
  `);

  document
    .querySelector<HTMLButtonElement>("#btnBackToFormalIntro")
    ?.addEventListener("click", () => {
      showFormalIntro();
    });

  document.querySelector<HTMLButtonElement>("#btnBeginFormal")?.addEventListener("click", () => {
    const nowMs = performance.now();
    const choice = document.querySelector<HTMLInputElement>('input[name="comp"]:checked')?.value;
    const hint = document.querySelector<HTMLDivElement>("#compHint");
    if (!choice) {
      if (hint) hint.textContent = "请选择答案后继续。";
      return;
    }

    logger.log({
      nowMs,
      tSec: 0,
      event: "comprehension_answer",
      phase: engine.state.phase,
      lightIndex: null,
      lightColor: null,
      money: engine.state.money,
      note: choice
    });

    closeModal();
  });
}

function showPostQuestion(): void {
  const elapsed = engine.state.elapsedSec;
  const money = engine.state.money;
  const v = engine.state.violations;

  openModal(`
    <h1>实验已完成</h1>
    <p class="hint">耗时：${formatSeconds(elapsed, 1)}；最终金额：${formatMoney(money)}；闯红灯次数：${v}</p>
    <h2>请回答</h2>
    <p>刚才的任务中，关于“等待红灯”的规则，您的真实想法是？</p>
    <div style="display:grid; gap:10px; margin-top:10px;">
      <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
        <input type="radio" name="post" value="A" />
        <span>A. 我严格遵守，因为这是规则。</span>
      </label>
      <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
        <input type="radio" name="post" value="B" />
        <span>B. 我有时未遵守，因为等待时间太长，扣钱太多。</span>
      </label>
      <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
        <input type="radio" name="post" value="C" />
        <span>C. 我觉得只要无人监督，为了效率（省钱）可以适当变通。</span>
      </label>
      <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
        <input type="radio" name="post" value="D" />
        <span>D. 我以为按钮随时能点，没太在意红灯。</span>
      </label>
    </div>
    <h2>补充（可选）</h2>
    <textarea class="textarea" id="postText" placeholder="如愿意，可补充一句原因…"></textarea>
    <div class="actions">
      <button class="btn primary" id="btnSubmitPost">提交并保存数据</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnSubmitPost")?.addEventListener("click", () => {
    const nowMs = performance.now();
    const choice = document.querySelector<HTMLInputElement>('input[name="post"]:checked')?.value;
    const text = (document.querySelector<HTMLTextAreaElement>("#postText")?.value ?? "").trim();

    if (!choice) return;

    logger.log({
      nowMs,
      tSec: engine.state.elapsedSec,
      event: "post_rule_attitude",
      phase: engine.state.phase,
      lightIndex: engine.state.lightIndex,
      lightColor: null,
      money: engine.state.money,
      note: choice
    });

    if (text) {
      logger.log({
        nowMs,
        tSec: engine.state.elapsedSec,
        event: "post_rule_attitude_text",
        phase: engine.state.phase,
        lightIndex: engine.state.lightIndex,
        lightColor: null,
        money: engine.state.money,
        note: text
      });
    }

    showFormalResults();
  });
}

function showFormalResults(): void {
  const elapsed = engine.state.elapsedSec;
  const money = engine.state.money;
  const v = engine.state.violations;
  if (!formalSubmission) {
    formalSubmission = buildFormalSubmission();
  }

  openModal(`
    <h1>实验已完成</h1>
    <p>耗时：<strong>${formatSeconds(elapsed, 1)}</strong>；最终金额：<strong>${formatMoney(
      money
    )}</strong>；闯红灯次数：<strong>${v}</strong></p>
    <h2>数据上报</h2>
    <p class="hint" id="submitStatus">正在提交到服务器，请稍候…</p>
    <div class="actions">
      <button class="btn primary" id="btnRetrySubmit" style="display:none;">重试提交</button>
      <button class="btn" id="btnCloseResults">关闭</button>
    </div>
  `);

  const submitStatus = document.querySelector<HTMLParagraphElement>("#submitStatus");
  const btnRetrySubmit = document.querySelector<HTMLButtonElement>("#btnRetrySubmit");

  document.querySelector<HTMLButtonElement>("#btnCloseResults")?.addEventListener("click", () => {
    closeModal();
  });

  let inFlight = false;
  const runSubmit = async (): Promise<void> => {
    if (inFlight || !formalSubmission) return;
    inFlight = true;
    if (btnRetrySubmit) btnRetrySubmit.style.display = "none";
    if (submitStatus) submitStatus.textContent = "正在提交到服务器，请稍候…";
    const outcome = await submitSubmissionWithFallback(formalSubmission);
    if (outcome === "sent") {
      if (submitStatus) submitStatus.textContent = "数据已成功保存到服务器。";
      void flushPendingSubmissions();
    } else {
      if (submitStatus) {
        submitStatus.textContent =
          "网络异常，数据已暂存于当前设备；恢复联网后将自动补传，可点击重试。";
      }
      if (btnRetrySubmit) btnRetrySubmit.style.display = "inline-flex";
    }
    inFlight = false;
  };

  btnRetrySubmit?.addEventListener("click", () => {
    void runSubmit();
  });
  void runSubmit();
}

els.btnStart.addEventListener("click", () => {
  if (!world || engine.state.phase !== "idle") return;
  closeModal();
  engine.start(performance.now());
});

els.btnWalk.addEventListener("click", () => {
  engine.pressWalk(performance.now());
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    if (engine.state.phase !== "idle" && engine.state.phase !== "finished") {
      e.preventDefault();
      engine.pressWalk(performance.now());
    }
  }
});

let lastPhase: typeof engine.state.phase = engine.state.phase;
let finishGate = false;

const hudCache = {
  btnWalkDisabled: null as boolean | null,
  btnStartDisabled: null as boolean | null,
  posText: "",
  timeText: "",
  moneyText: "",
  lightText: "",
  moneyUrgent: null as boolean | null,
  lightRed: null as boolean | null,
  lightGreen: null as boolean | null
};

updateTopHints();
void flushPendingSubmissions();
showRevealModeSelect();

window.addEventListener("online", () => {
  void flushPendingSubmissions();
});

function updateHud(): void {
  const s = engine.state;
  const nextWalkDisabled = s.phase === "idle" || s.phase === "finished";
  const nextStartDisabled = s.phase !== "idle";
  if (hudCache.btnWalkDisabled !== nextWalkDisabled) {
    els.btnWalk.disabled = nextWalkDisabled;
    hudCache.btnWalkDisabled = nextWalkDisabled;
  }
  if (hudCache.btnStartDisabled !== nextStartDisabled) {
    els.btnStart.disabled = nextStartDisabled;
    hudCache.btnStartDisabled = nextStartDisabled;
  }

  let posText = "—";
  let timeText = formatSeconds(0, 1);
  let moneyText = formatMoney(currentConfig.startMoney);
  let lightText = "—";
  let moneyUrgent = false;
  let lightRed = false;
  let lightGreen = false;

  if (s.phase !== "idle") {
    if (s.phase === "finished") {
      posText = "已完成";
    } else if (currentConfig.revealMode === "full") {
      posText = `交通信号灯${s.lightIndex}（${s.lightIndex}/${currentConfig.numLights}）`;
    } else {
      posText = s.phase === "moving" ? "行走中" : "交通信号灯";
    }
    timeText = formatSeconds(s.elapsedSec, 1);
    moneyText = formatMoney(s.money);
    const pulseRate = 2.4;
    moneyUrgent = s.phase !== "finished" && Math.floor(s.elapsedSec * pulseRate) % 2 === 0;

    if (s.phase === "moving") {
      lightText = "行走中";
    } else if (s.phase === "waiting_red") {
      const isRed = s.currentLightColor === "red";
      lightText = isRed ? "🔴 红灯" : "🟢 绿灯";
      lightRed = isRed;
      lightGreen = !isRed;
    } else if (s.phase === "finished") {
      lightText = "✅ 完成";
    }
  }

  if (hudCache.posText !== posText) {
    els.posText.textContent = posText;
    hudCache.posText = posText;
  }
  if (hudCache.timeText !== timeText) {
    els.timeText.textContent = timeText;
    hudCache.timeText = timeText;
  }
  if (hudCache.moneyText !== moneyText) {
    els.moneyText.textContent = moneyText;
    hudCache.moneyText = moneyText;
  }
  if (hudCache.lightText !== lightText) {
    els.lightText.textContent = lightText;
    hudCache.lightText = lightText;
  }
  if (hudCache.moneyUrgent !== moneyUrgent) {
    els.moneyText.classList.toggle("urgent", moneyUrgent);
    hudCache.moneyUrgent = moneyUrgent;
  }
  if (hudCache.lightRed !== lightRed) {
    els.lightText.classList.toggle("light-red", lightRed);
    hudCache.lightRed = lightRed;
  }
  if (hudCache.lightGreen !== lightGreen) {
    els.lightText.classList.toggle("light-green", lightGreen);
    hudCache.lightGreen = lightGreen;
  }
}


function loop(): void {
  const nowMs = performance.now();
  engine.tick(nowMs);

  world?.render(engine.state, engine.getRouteProgress01(), nowMs);
  updateHud();

  if (!finishGate && lastPhase !== engine.state.phase) {
    lastPhase = engine.state.phase;
    if (engine.state.phase === "finished") {
      finishGate = true;
      if (runKind === "practice") {
        showPracticeComplete();
      } else {
        showPostQuestion();
      }
    }
  } else {
    lastPhase = engine.state.phase;
  }

  requestAnimationFrame(loop);
}

loop();
