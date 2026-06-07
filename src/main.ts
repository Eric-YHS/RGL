import "./style.css";

import type { ExperimentConfig, RevealMode } from "./experiment/types";
import { ExperimentEngine } from "./experiment/engine";
import type { ClientDeviceInfo, SessionSubmission } from "./experiment/logger";
import { ExperimentLogger } from "./experiment/logger";
import { formatMoney, formatSeconds } from "./experiment/utils";
import { World2D } from "./scene/world2d";

type SubmitOutcome = "sent" | "queued";
type DesktopInputProof = {
  keyboard: boolean;
  mouseMove: boolean;
  mouseClick: boolean;
};

const params = new URLSearchParams(window.location.search);
const participantId = (params.get("pid") ?? "").trim();
const apiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const surveyUrl = (import.meta.env.VITE_SURVEY_URL ?? "").trim();
const PENDING_SUBMISSIONS_KEY = "honglvdeng_pending_submissions_v1";
const EXPERIMENT_UI_FONT = '"Experiment Sans"';
const EXPERIMENT_MONEY_FONT = '"Experiment Mono"';

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
    segmentDurationSec: 2,
    redWaitSec: 20,
    startMoney: 100,
    moneyLossPerSec: 2.5
  };
}

const formalConfig: ExperimentConfig = makeConfig("full", 1);

function createLogger(config: ExperimentConfig): ExperimentLogger {
  return new ExperimentLogger(config, {
    participantId,
    startedAtIso: new Date().toISOString(),
    runKind: "formal"
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

async function waitForExperimentFonts(): Promise<void> {
  if (!("fonts" in document)) return;

  const timeoutMs = 2500;
  const fontLoads = Promise.all([
    document.fonts.load(`400 16px ${EXPERIMENT_UI_FONT}`, "控制剩余报酬正式实验"),
    document.fonts.load(`700 16px ${EXPERIMENT_UI_FONT}`, "开始通行每秒正在减少"),
    document.fonts.load(`800 16px ${EXPERIMENT_UI_FONT}`, "提示交通信号灯"),
    document.fonts.load(`900 16px ${EXPERIMENT_MONEY_FONT}`, "￥0123456789.-"),
    document.fonts.load(`700 16px ${EXPERIMENT_MONEY_FONT}`, "￥0123456789.-")
  ]).then(() => undefined);

  await Promise.race([
    fontLoads.catch(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))
  ]);

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function shouldBlockMobileAccess(): boolean {
  const nav = navigator as Navigator & {
    userAgentData?: {
      mobile?: boolean;
    };
  };
  const ua = navigator.userAgent ?? "";
  const platform = navigator.platform ?? "";
  const isIpadLike = platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const uaSaysMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(
    ua
  );
  const uaDataSaysMobile = Boolean(nav.userAgentData?.mobile);
  const coarseTouchSmallScreen =
    window.matchMedia("(hover: none) and (pointer: coarse)").matches &&
    Math.max(window.screen.width || 0, window.screen.height || 0) <= 1366;

  return isIpadLike || uaSaysMobile || uaDataSaysMobile || coarseTouchSmallScreen;
}

const DESKTOP_MIN_VIEWPORT_WIDTH = 1100;
const DESKTOP_MIN_VIEWPORT_HEIGHT = 680;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

if (shouldBlockMobileAccess()) {
  document.body.classList.add("desktop-only-blocked");
  app.innerHTML = `
    <main class="desktop-only-gate">
      <section class="desktop-only-card">
        <div class="desktop-only-eyebrow">访问受限</div>
        <h1>本实验仅支持电脑端作答</h1>
        <p>检测到您当前正在使用手机或平板访问。本实验需要在电脑浏览器中完成，以保证页面布局、操作方式和实验记录一致。</p>
        <div class="desktop-only-tips">
          <div>请改用电脑打开当前链接后再继续。</div>
          <div>推荐使用 Chrome、Edge 或 Safari 的桌面浏览器。</div>
        </div>
      </section>
    </main>
  `;
} else {
document.body.classList.add("app-fonts-loading");
app.innerHTML = `
  <div class="stage">
    <canvas class="webgl" aria-label="实验场景"></canvas>

    <div class="hud">
      <div class="left">
        <div class="panel status panel-status">
          <div class="row"><div class="label">当前位置</div><div class="value" id="posText">—</div></div>
          <div class="row"><div class="label">耗费时间</div><div class="value" id="timeText">0.0s</div></div>
          <div class="row"><div class="label">剩余报酬</div><div class="value money" id="moneyText">${formatMoney(formalConfig.startMoney)}</div></div>
          <div class="row" id="lightRow"><div class="label">信号灯</div><div class="value" id="lightText">—</div></div>
        </div>

      </div>
    </div>

    <div class="center-controls">
      <button class="btn primary" id="btnAction">开始</button>
    </div>

    <div class="modal" id="modal" style="display:none;">
      <div class="card" id="modalCard"></div>
    </div>

    <div class="desktop-preflight" id="desktopGate" style="display:none;"></div>
  </div>
`;

const els = {
  canvas: document.querySelector<HTMLCanvasElement>("canvas.webgl")!,
  btnAction: document.querySelector<HTMLButtonElement>("#btnAction")!,
  posText: document.querySelector<HTMLDivElement>("#posText")!,
  timeText: document.querySelector<HTMLDivElement>("#timeText")!,
  moneyText: document.querySelector<HTMLDivElement>("#moneyText")!,
  lightText: document.querySelector<HTMLDivElement>("#lightText")!,
  lightRow: document.querySelector<HTMLDivElement>("#lightRow")!,
  modal: document.querySelector<HTMLDivElement>("#modal")!,
  modalCard: document.querySelector<HTMLDivElement>("#modalCard")!,
  desktopGate: document.querySelector<HTMLDivElement>("#desktopGate")!
};

const currentConfig: ExperimentConfig = formalConfig;
let logger: ExperimentLogger = createLogger(currentConfig);
let engine: ExperimentEngine = new ExperimentEngine(currentConfig, logger);
let world: World2D | null = null;
let formalClientSessionId = createClientSessionId();
let formalSubmission: SessionSubmission | null = null;
const desktopInputProof: DesktopInputProof = {
  keyboard: false,
  mouseMove: false,
  mouseClick: false
};
let desktopGateReady = false;
let desktopGateVisible = false;
let pausedByDesktopGate = false;
let desktopGateEnteredOnce = false;
let instructionsShownOnce = false;

function hasDesktopViewport(): boolean {
  return window.innerWidth >= DESKTOP_MIN_VIEWPORT_WIDTH && window.innerHeight >= DESKTOP_MIN_VIEWPORT_HEIGHT;
}

function hasDesktopPointer(): boolean {
  return window.matchMedia("(pointer: fine)").matches;
}

function hasDesktopHover(): boolean {
  return window.matchMedia("(hover: hover)").matches;
}

function renderDesktopPreflightGate(): void {
  const viewportReady = hasDesktopViewport();
  const pointerReady = hasDesktopPointer();
  const hoverReady = hasDesktopHover();
  const keyboardReady = desktopInputProof.keyboard;
  const mouseReady = desktopInputProof.mouseMove && desktopInputProof.mouseClick;
  const prerequisitesReady = viewportReady && pointerReady && hoverReady && keyboardReady && mouseReady;
  const canEnter = prerequisitesReady && desktopGateEnteredOnce;

  if (canEnter) {
    if (desktopGateVisible) {
      els.desktopGate.style.display = "none";
      desktopGateVisible = false;
    }

    if (pausedByDesktopGate) {
      engine.resume(performance.now());
      pausedByDesktopGate = false;
    }

    if (!desktopGateReady) {
      desktopGateReady = true;
    }

    // First time the desktop gate clears, walk the participant through the
    // instructions -> comprehension test -> ready-to-start flow.
    if (!instructionsShownOnce) {
      instructionsShownOnce = true;
      showInstructions();
    }
    return;
  }

  if (!pausedByDesktopGate && engine.state.phase !== "idle" && engine.state.phase !== "finished") {
    engine.pause(performance.now());
    pausedByDesktopGate = true;
  }

  const viewportLabel = viewportReady
    ? `窗口尺寸已满足（至少 ${DESKTOP_MIN_VIEWPORT_WIDTH}×${DESKTOP_MIN_VIEWPORT_HEIGHT}）`
    : `请将浏览器窗口调整到至少 ${DESKTOP_MIN_VIEWPORT_WIDTH}×${DESKTOP_MIN_VIEWPORT_HEIGHT}`;
  const pointerLabel = pointerReady ? "检测到精细指针设备" : "请使用鼠标或触控板操作";
  const hoverLabel = hoverReady ? "检测到悬停能力" : "当前设备不具备桌面端悬停能力";
  const keyboardLabel = keyboardReady ? "已检测到实体键盘输入" : "请按一次实体键盘按键";
  const mouseLabel = mouseReady ? "已检测到鼠标移动和点击" : "请移动鼠标并点击一次";

  const readyNotice = prerequisitesReady
    ? `
        <div class="desktop-preflight-ready">
          桌面端校验已通过。
        </div>
        <div class="desktop-preflight-actions">
          <button class="btn primary" id="btnDesktopGateContinue">继续阅读指导语</button>
        </div>
      `
    : "";

  els.desktopGate.innerHTML = `
    <section class="desktop-preflight-card desktop-entry-card">
      <h1>欢迎</h1>
      <p>该部分人类智能任务的报酬取决于您的决策。</p>
      <p>注意：如果你使用台式机或笔记本电脑完成此人类智能任务，请在开始前将浏览器屏幕最大化。在完成决策任务期间，请不要关闭此窗口，也不要以其他任何方式离开网页。</p>
      <p>为保证实验环境一致，进入实验前必须同时满足桌面窗口尺寸、精细指针、悬停能力，以及真实键盘和鼠标交互。</p>
      <div class="desktop-preflight-checklist">
        <div class="${viewportReady ? "ready" : ""}">${viewportReady ? "✓" : "•"} ${viewportLabel}</div>
        <div class="${pointerReady ? "ready" : ""}">${pointerReady ? "✓" : "•"} ${pointerLabel}</div>
        <div class="${hoverReady ? "ready" : ""}">${hoverReady ? "✓" : "•"} ${hoverLabel}</div>
        <div class="${keyboardReady ? "ready" : ""}">${keyboardReady ? "✓" : "•"} ${keyboardLabel}</div>
        <div class="${mouseReady ? "ready" : ""}">${mouseReady ? "✓" : "•"} ${mouseLabel}</div>
      </div>
      ${readyNotice}
    </section>
  `;
  els.desktopGate.style.display = "grid";
  desktopGateVisible = true;

  if (prerequisitesReady) {
    els.desktopGate
      .querySelector<HTMLButtonElement>("#btnDesktopGateContinue")
      ?.addEventListener("click", () => {
        desktopGateEnteredOnce = true;
        renderDesktopPreflightGate();
      });
  }
}

function openModal(html: string): void {
  els.modalCard.innerHTML = html;
  els.modal.style.display = "grid";
}

function closeModal(): void {
  els.modal.style.display = "none";
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildFormalSubmission(): SessionSubmission {
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

function showInstructions(): void {
  openModal(`
    <h1>指导语</h1>
    <p>决策任务中，您将控制一个<strong>圆形图形</strong>，并在屏幕上将其移动至<strong>终点线</strong>。</p>
    <ul>
      <li>当您点击屏幕<strong>底部</strong>的<strong>【开始】</strong>按钮后，您的圆圈会靠近红绿灯并停下等待。</li>
      <li>按钮会由<strong>【开始】</strong>变为<strong>【移动】</strong>。要让您的圆圈再次移动，请点击<strong>【移动】</strong>按钮，您<strong>可以在任何时刻</strong>点击该按钮。</li>
    </ul>
    <h2>示例短片</h2>
    <div class="instruction-video">
      <video controls preload="metadata" playsinline poster="/demo-poster.svg">
        <source src="/demo.mp4" type="video/mp4" />
        当前浏览器无法直接播放示例短片，请点击下方链接打开。
      </video>
      <a class="video-fallback-link" href="/demo.mp4" target="_blank" rel="noopener">打开示例短片</a>
    </div>
    <h2>实验规则</h2>
    <p>在红绿灯处等待，直至其变为<strong>绿色</strong>后通行。</p>
    <h2>收益规则</h2>
    <ul>
      <li>本部分收益取决于您将圆圈移过终点线所花费的时间，<strong>从点击【开始】按钮起计时</strong>。</li>
      <li>本阶段初始资金为 <strong>${formatMoney(currentConfig.startMoney)}</strong>，每耗时 <strong>1</strong> 秒，资金减少 <strong>${formatMoney(currentConfig.moneyLossPerSec)}</strong>，直至您冲过终点线。</li>
    </ul>
    <h2>场景设置</h2>
    <ul>
      <li>圆圈从初始位置到红绿灯、从红绿灯到终点线<strong>各需 ${currentConfig.segmentDurationSec} 秒</strong>。</li>
      <li>红灯等待 <strong>${currentConfig.redWaitSec} 秒</strong>后变为绿灯。</li>
    </ul>
    <div class="actions">
      <button class="btn primary" id="btnToCompTest">下一步：理解测试</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnToCompTest")?.addEventListener("click", () => {
    showComprehensionTest();
  });
}

function showComprehensionTest(): void {
  openModal(`
    <h1>理解测试</h1>
    <p>请回答以下问题：根据上述说明，为获得最大经济收益，我应该闯红灯以便缩短时间；但为了遵守规则，我必须等待红灯变绿。</p>
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
      <button class="btn" id="btnBackToInstructions">上一步</button>
      <button class="btn primary" id="btnBeginExperiment">我已作答，下一步</button>
    </div>
  `);

  document
    .querySelector<HTMLButtonElement>("#btnBackToInstructions")
    ?.addEventListener("click", () => {
      showInstructions();
    });

  document.querySelector<HTMLButtonElement>("#btnBeginExperiment")?.addEventListener("click", () => {
    const nowMs = performance.now();
    const choice = document.querySelector<HTMLInputElement>('input[name="comp"]:checked')?.value;
    const hint = document.querySelector<HTMLDivElement>("#compHint");
    if (!choice) {
      if (hint) hint.textContent = "请选择答案后继续。";
      return;
    }
    if (choice !== "yes") {
      if (hint) hint.textContent = "回答不正确，请重新阅读指导语后再继续。";
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

    showReadyToStart();
  });
}

function showReadyToStart(): void {
  openModal(`
    <h1>准备开始决策任务</h1>
    <p>回答正确。请点击下方按钮进入正式任务界面。</p>
    <p>进入正式任务界面后，底部按钮会先显示为<strong>【开始】</strong>；点击<strong>【开始】</strong>后，任务开始计时，圆圈开始移动，按钮会切换为<strong>【移动】</strong>。</p>
    <p class="hint">规则提醒：你可以在任意时刻点击<strong>【移动】</strong>，但实验规则要求你在红绿灯处等待，直到红灯变为绿色后再通行。</p>
    <div class="actions">
      <button class="btn" id="btnBackToCompTest">上一步</button>
      <button class="btn primary" id="btnReadyToStart">进入决策任务</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnBackToCompTest")?.addEventListener("click", () => {
    showComprehensionTest();
  });

  document.querySelector<HTMLButtonElement>("#btnReadyToStart")?.addEventListener("click", () => {
    closeModal();
  });
}

type CompletionScreenState = "saving" | SubmitOutcome;

async function submitFormalResultsSilently(): Promise<SubmitOutcome> {
  if (!formalSubmission) {
    formalSubmission = buildFormalSubmission();
  }
  enqueuePendingSubmission(formalSubmission);
  const outcome = await submitSubmissionWithFallback(formalSubmission);
  if (outcome === "sent") {
    void flushPendingSubmissions();
  }
  return outcome;
}

function showCompletionScreen(state: CompletionScreenState): void {
  const elapsed = engine.state.elapsedSec;
  const waitSec = Math.max(0, elapsed - currentConfig.segmentDurationSec * 2);
  const taskMoney = engine.state.money;
  const surveyAction =
    state === "saving"
      ? ""
      : surveyUrl
        ? `
          <div class="completion-actions">
            <a class="btn primary" href="${escapeHtmlAttr(surveyUrl)}">跳转见数</a>
          </div>
        `
        : "";

  const statusBlock =
    state === "saving"
      ? `<div class="completion-status saving">数据正在保存，请稍候…</div>`
      : state === "sent"
        ? `<div class="completion-status success">数据已成功保存。</div>`
        : `<div class="completion-status queued">网络暂时不稳定，数据已保存并会继续尝试提交。</div>`;

  openModal(`
    <div class="completion-card-body">
      <div class="completion-eyebrow">决策任务完成</div>
      <h1>感谢您的参与</h1>
      <p>您在红绿灯处等待了 <strong>${formatSeconds(waitSec, 1)}</strong>，获得 <strong>${formatMoney(taskMoney)}</strong>。</p>
      ${statusBlock}
      <p class="completion-close-note">后续填写完简短问卷后，您将在见数平台领取自己的收益。</p>
      ${surveyAction}
    </div>
  `);
}

function showTaskSubmitScreen(): void {
  openModal(`
    <h1>决策任务</h1>
    <p>圆圈已越过终点线。请点击下方按钮进入下一屏幕。</p>
    <div class="actions">
      <button class="btn primary" id="btnTaskSubmit">提交</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnTaskSubmit")?.addEventListener("click", () => {
    showPostQuestion();
  });
}

function showPostQuestion(): void {
  const elapsed = engine.state.elapsedSec;
  const money = engine.state.money;
  const v = engine.state.violations;

  openModal(`
    <p class="hint">耗时：${formatSeconds(elapsed, 1)}；最终金额：${formatMoney(money)}；闯红灯次数：${v}</p>
    <h2>请回答</h2>
    <p>刚才的任务中，关于"等待红灯"的规则，您的真实想法是？</p>
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
    <div class="actions">
      <button class="btn primary" id="btnSubmitPost">提交并保存数据</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnSubmitPost")?.addEventListener("click", () => {
    const nowMs = performance.now();
    const choice = document.querySelector<HTMLInputElement>('input[name="post"]:checked')?.value;

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

    showCompletionScreen("saving");
    void submitFormalResultsSilently().then((outcome) => {
      showCompletionScreen(outcome);
    });
  });
}

els.btnAction.addEventListener("click", () => {
  if (!world || engine.state.phase === "finished") return;

  const nowMs = performance.now();
  if (engine.state.phase === "idle") {
    closeModal();
    engine.start(nowMs);
    return;
  }

  engine.pressWalk(nowMs);
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
  btnActionDisabled: null as boolean | null,
  btnActionText: "",
  posText: "",
  timeText: "",
  moneyText: "",
  lightText: "",
  moneyUrgent: null as boolean | null,
  lightRed: null as boolean | null,
  lightGreen: null as boolean | null
};

async function bootstrapDesktopApp(): Promise<void> {
  await waitForExperimentFonts();
  document.body.classList.remove("app-fonts-loading");
  document.body.classList.add("app-fonts-ready");
  void flushPendingSubmissions();

  world = new World2D(els.canvas, currentConfig);
  lastPhase = engine.state.phase;
  finishGate = false;

  renderDesktopPreflightGate();
  loop();
}

void bootstrapDesktopApp();

window.addEventListener("online", () => {
  void flushPendingSubmissions();
});

window.addEventListener("resize", () => {
  renderDesktopPreflightGate();
});

window.addEventListener("keydown", (e) => {
  if (
    !desktopInputProof.keyboard &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)
  ) {
    desktopInputProof.keyboard = true;
    renderDesktopPreflightGate();
  }
});

window.addEventListener("mousemove", () => {
  if (!desktopInputProof.mouseMove) {
    desktopInputProof.mouseMove = true;
    renderDesktopPreflightGate();
  }
});

window.addEventListener("mousedown", () => {
  if (!desktopInputProof.mouseClick) {
    desktopInputProof.mouseClick = true;
    renderDesktopPreflightGate();
  }
});

document.addEventListener("visibilitychange", () => {
  const nowMs = performance.now();
  if (document.hidden) {
    engine.pause(nowMs);
    return;
  }
  engine.resume(nowMs);
  renderDesktopPreflightGate();
});

function updateHud(): void {
  const s = engine.state;
  const nextActionDisabled = s.phase === "finished";
  const nextActionText = s.phase === "idle" ? "开始" : "移动";
  if (hudCache.btnActionDisabled !== nextActionDisabled) {
    els.btnAction.disabled = nextActionDisabled;
    hudCache.btnActionDisabled = nextActionDisabled;
  }
  if (hudCache.btnActionText !== nextActionText) {
    els.btnAction.textContent = nextActionText;
    hudCache.btnActionText = nextActionText;
  }
  els.btnAction.classList.toggle("action-start", s.phase === "idle");
  els.btnAction.classList.toggle("action-move", s.phase !== "idle" && s.phase !== "finished");

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
    } else if (s.phase === "moving") {
      posText = "走向红绿灯";
    } else if (s.phase === "waiting_red") {
      posText = "红绿灯前等待";
    } else if (s.phase === "moving_to_finish") {
      posText = "冲向终点线";
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
    } else if (s.phase === "moving_to_finish") {
      const passedOnRed = s.passedOutcome[s.lightIndex] === "run_red";
      lightText = passedOnRed ? "🔴 红灯" : "已通过";
      lightRed = passedOnRed;
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
      showTaskSubmitScreen();
    }
  } else {
    lastPhase = engine.state.phase;
  }

  requestAnimationFrame(loop);
}

}
