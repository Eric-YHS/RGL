import "./style.css";

import type { ExperimentConfig, RevealMode } from "./experiment/types";
import { ExperimentEngine } from "./experiment/engine";
import type { ClientDeviceInfo, SessionSubmission } from "./experiment/logger";
import { ExperimentLogger } from "./experiment/logger";
import { formatMoney, formatSeconds } from "./experiment/utils";
import { findTreatment, resolveTreatmentId } from "./experiment/treatments";
import { World2D } from "./scene/world2d";
import { getPersistentManipulationQuestions } from "./experiment/manipulationChecks";
import { resolveServerAssignment } from "./experiment/assignmentClient";

type SubmitOutcome = "sent" | "queued";
const params = new URLSearchParams(window.location.search);
const participantId = (params.get("pid") ?? params.get("participant_id") ?? "").trim();
const apiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const surveyUrl = (import.meta.env.VITE_SURVEY_URL ?? "").trim();
const PENDING_SUBMISSIONS_KEY = "honglvdeng_pending_submissions_v1";
const CONTINUE_SURVEY_EVENT = "honglvdeng:continue-survey";
const EXPERIMENT_UI_FONT = '"Experiment Sans"';
const EXPERIMENT_MONEY_FONT = '"Experiment Mono"';
const isCredamoEmbedded =
  window.self !== window.top || window.location.hostname.toLowerCase().includes("credamo");

if (isCredamoEmbedded) {
  document.documentElement.classList.add("credamo-embedded");
}

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
  // Deterministic fallback: timestamp + high-precision performance counter.
  // Avoids Math.random() per task.md randomness requirements.
  const perf = performance.now().toString(36).replace(".", "");
  return `fallback-${Date.now().toString(36)}-${perf}`;
}

function makeConfig(revealMode: RevealMode, numLights: number): ExperimentConfig {
  return {
    revealMode,
    numLights,
    segmentDurationSec: 4,
    redWaitSec: 15,
    startMoney: 100,
    moneyLossPerSec: 2.0
  };
}

const formalConfig: ExperimentConfig = makeConfig("full", 1);
const practiceConfig: ExperimentConfig = makeConfig("full", 1);

// 优先沿用被试在本浏览器的首次分配，重新进入不受新 treatment 参数影响。
let treatmentId = resolveTreatmentId(window.location.search, participantId);
let treatmentMaterial = findTreatment(treatmentId)!;
// 首次打开即保存题目排列，避免退出后或重复进入检验页重新洗牌。
let manipulationQuestions = getPersistentManipulationQuestions(treatmentId, participantId);
// 批注第 2 条：强制最低阅读时间，确保 treatment 生效。
const INTERVENTION_MIN_READ_SEC = 15;
let interventionShown = false;
let interventionStartedAtMs = 0;
let interventionDurationMs = 0;
let interventionTimer: number | null = null;
// 理解测试答案在练习/正式 logger 切换时会丢失（enterPracticeMode/enterFormalMode
// 均新建 logger），这里留存原始事件，正式 logger 创建时以原始时间戳补记。
let lastComprehensionEvent: { nowMs: number; note: string } | null = null;

function createLogger(config: ExperimentConfig, runKind: "formal" | "practice"): ExperimentLogger {
  const next = new ExperimentLogger(config, {
    participantId,
    startedAtIso: new Date().toISOString(),
    runKind,
    treatment: treatmentId
  });
  // 正式轮的提交由最新 logger 生成；把理解测试答案以原始时间戳补进新 logger，
  // 避免切换练习/正式 logger 时丢失（8 月内测数据该字段为空即此原因）。
  if (runKind === "formal" && lastComprehensionEvent) {
    next.log({
      nowMs: lastComprehensionEvent.nowMs,
      tSec: 0,
      event: "comprehension_answer",
      phase: "idle",
      lightIndex: null,
      lightColor: null,
      money: config.startMoney,
      note: lastComprehensionEvent.note
    });
  }
  return next;
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
  <div class="stage" id="experimentStage">
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

    <aside class="desktop-entry-zoom-hints">若显示不全，可按 Ctrl + 减号（Mac：⌘ + 减号）缩小页面。</aside>
    <div class="desktop-preflight" id="desktopGate" style="display:none;"></div>
  </div>
`;

const els = {
  stage: document.querySelector<HTMLElement>("#experimentStage")!,
  canvas: document.querySelector<HTMLCanvasElement>("canvas.webgl")!,
  btnAction: document.querySelector<HTMLButtonElement>("#btnAction")!,
  posText: document.querySelector<HTMLDivElement>("#posText")!,
  timeText: document.querySelector<HTMLDivElement>("#timeText")!,
  moneyText: document.querySelector<HTMLDivElement>("#moneyText")!,
  lightText: document.querySelector<HTMLDivElement>("#lightText")!,
  lightRow: document.querySelector<HTMLDivElement>("#lightRow")!,
  modal: document.querySelector<HTMLDivElement>("#modal")!,
  modalCard: document.querySelector<HTMLDivElement>("#modalCard")!,
  desktopGate: document.querySelector<HTMLDivElement>("#desktopGate")!,
};

const currentConfig: ExperimentConfig = formalConfig;
let logger: ExperimentLogger = createLogger(currentConfig, "formal");
let engine: ExperimentEngine = new ExperimentEngine(currentConfig, logger);
let world: World2D | null = null;
let formalClientSessionId = createClientSessionId();
let formalSubmission: SessionSubmission | null = null;
let manipulationAnswers: string | null = null;
let isPracticeMode = false;
let desktopGateIntroductionAcknowledged = false;

type View = "welcome" | "modal" | "practice_complete" | "task" | "intervention" | "completion" | "manipulation";
type Frame = { view: View; nodes: Node[]; engine: ExperimentEngine; logger: ExperimentLogger; practice: boolean };
let view: View = "welcome";
let navigationVersion = 0;
let restoring = false;
let navigationLocked = false;
const backStack: Frame[] = [];
let formalRun: { engine: ExperimentEngine; logger: ExperimentLogger } | null = null;
let practiceRun: { engine: ExperimentEngine; logger: ExperimentLogger } | null = null;
let completionState: CompletionScreenState = "saving";
const backButton = document.createElement("button");
backButton.className = "btn navigation-back";
backButton.id = "btnPageBack";
backButton.textContent = "返回";
backButton.hidden = true;
document.body.append(backButton);
const reviewButton = document.createElement("button");
reviewButton.className = "btn navigation-review";
reviewButton.textContent = "查看完成结果";
reviewButton.hidden = true;
document.body.append(reviewButton);
reviewButton.addEventListener("click", showTaskSubmitScreen);
const comprehensionChoices: Record<string, string> = {};

function leaveView(): void {
  els.modalCard.querySelectorAll("video").forEach(video => video.pause());
  engine.pause(performance.now());
  if (view === "intervention") {
    interventionDurationMs += Math.max(0, performance.now() - interventionStartedAtMs);
    clearInterventionTimer();
  }
}

function canGoBack(): boolean {
  return !navigationLocked && backStack.length > 0 &&
    view !== "practice_complete" && view !== "completion";
}

function navigate(next: View): void {
  if (!restoring) {
    if (view !== "manipulation") {
      backStack.push({ view, nodes: Array.from(els.modalCard.childNodes), engine, logger, practice: isPracticeMode });
    }
    leaveView();
  }
  view = next;
  navigationVersion++;
  backButton.hidden = !canGoBack();
}

function goBack(): void {
  if (!canGoBack()) return;
  const frame = backStack.pop();
  if (!frame) return;
  leaveView();
  view = frame.view;
  navigationVersion++;
  engine = frame.engine;
  logger = frame.logger;
  isPracticeMode = frame.practice;
  world?.dispose();
  world = new World2D(els.canvas, engine.config);
  lastPhase = engine.state.phase;
  finishGate = engine.state.phase === "finished";
  els.desktopGate.style.display = view === "welcome" ? "grid" : "none";
  els.modalCard.replaceChildren(...frame.nodes);
  els.modal.style.display = view === "welcome" || view === "task" ? "none" : "grid";
  if (view === "task") engine.resume(performance.now());
  restoring = true;
  if (view === "intervention") showIntervention();
  if (view === "completion") showCompletionScreen(completionState);
  restoring = false;
  backButton.hidden = !canGoBack();
  updateHud();
}
backButton.addEventListener("click", goBack);

function renderDesktopPreflightGate(): void {
  if (desktopGateIntroductionAcknowledged) {
    // Keep the welcome page from replacing an active task.
    return;
  }

  els.desktopGate.innerHTML = `
    <section class="desktop-preflight-card desktop-entry-card">
      <h1>欢迎参加学术调查</h1>
      <p>感谢您参与本次学术研究。我们是中山大学学术研究团队。本研究的初始酬金为 <strong>100 元人民币</strong>，但最终酬金将完全取决于您在任务中的决策，介乎 <strong>0 元–84 元人民币</strong>。</p>
      <p>本次任务共两轮，其中第一轮为<strong>练习</strong>，帮助参与者熟悉任务。第二轮为<strong>正式任务</strong>，将直接决定薪酬。完成整个调查需 <strong>15-20 分钟</strong>。</p>
      <p>本次参与完全自愿，您可以随时退出，但退出无法获得酬金。作答完全匿名，数据仅用于学术研究，请放心作答。</p>
      <div class="desktop-preflight-actions">
        <button class="btn primary" id="btnDesktopGateCheck">阅读任务指导</button>
      </div>
    </section>
  `;
  els.desktopGate.style.display = "grid";
  els.desktopGate
    .querySelector<HTMLButtonElement>("#btnDesktopGateCheck")
    ?.addEventListener("click", () => {
      desktopGateIntroductionAcknowledged = true;
      els.desktopGate.style.display = "none";
      showInstructions();
    });
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
  const payload = logger.buildSubmission({
    clientSessionId: formalClientSessionId,
    submittedAtIso: new Date().toISOString(),
    summary: {
      elapsedSec: engine.state.elapsedSec,
      money: engine.getRecordedMoney(),
      violations: engine.state.violations
    },
    device: collectDeviceInfo(),
    interventionMs: Math.round(interventionDurationMs)
  });
  if (manipulationAnswers) payload.manipulationAnswers = manipulationAnswers;
  // 保存实际展示的题目和选项文本顺序，便于独立还原本次作答。
  payload.manipulationQuestions = JSON.stringify(manipulationQuestions);
  return payload;
}

function showInstructions(): void {
  navigate("modal");
  openModal(`
    <h1>指导语</h1>
    <p>在本次任务中，您将控制一个<strong>圆点</strong>，并在屏幕上将其移动至<strong>终点线</strong>。</p>
    <ul>
      <li>当您点击屏幕<strong>底部</strong>的<strong>【开始】</strong>按钮后，圆点会靠近一个红绿信号灯并停下等待。</li>
      <li>此时按钮会由<strong>【开始】</strong>变为<strong>【移动】</strong>。要让圆点再次移动并通过红绿灯，请点击<strong>【移动】</strong>按钮，您可以在任何时刻点击该按钮让圆点通过红绿灯。</li>
    </ul>
    <h2>示例短片</h2>
    <p>请观看下面的示例短片，了解任务画面和操作方式。</p>
    <div class="instruction-video">
      <video controls preload="metadata" playsinline poster="./demo-own-0702.png">
        <source src="./demo-own-0702.mp4" type="video/mp4" />
        当前浏览器无法直接播放示例短片。
      </video>
    </div>
    <h2>任务规则</h2>
    <p>在红绿灯处等待，直至其变为<strong>绿灯</strong>后通行。</p>
    <h2>酬金计算</h2>
    <p>任务酬金取决于您将圆点移至终点线所花费的时间。注意：计时从点击<strong>【开始】</strong>按钮起计时。其中，从起点到红绿灯处，耗时 <strong>${engine.config.segmentDurationSec} 秒</strong>，从红绿灯处抵达终点线，耗时 <strong>${engine.config.segmentDurationSec} 秒</strong>。</p>
    <p>初始报酬为 <strong>100 元人民币整</strong>，每耗时 <strong>1</strong> 秒，资金减少 <strong>￥${engine.config.moneyLossPerSec}</strong>；红灯等待 <strong>${engine.config.redWaitSec} 秒</strong>后变为绿灯。</p>
    <div class="actions">
      <button class="btn primary" id="btnToCompTest">下一步：理解测试</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnToCompTest")?.addEventListener("click", () => {
    showComprehensionTest();
  });
}

function showComprehensionTest(): void {
  navigate("modal");
  openModal(`
    <h1>理解测试</h1>
    <p>请回答以下问题，以确认您已理解任务规则。两题均需回答正确才能继续。</p>
    <div class="comp-question">
      <p><strong>1. 根据上述说明，如果圆点抵达终点线所花费的总时间越长，您最终获得的金钱报酬会如何变化。</strong></p>
      <div class="choice-stack" style="display:grid; gap:10px;">
        <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
          <input type="radio" name="comp1" value="more" />
          <span>A. 越来越多</span>
        </label>
        <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
          <input type="radio" name="comp1" value="less" />
          <span>B. 越来越少</span>
        </label>
        <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
          <input type="radio" name="comp1" value="same" />
          <span>C. 保持不变</span>
        </label>
      </div>
    </div>
    <div class="comp-question">
      <p><strong>2. 根据指导语，本次任务的规则是什么？</strong></p>
      <div class="choice-stack" style="display:grid; gap:10px;">
        <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
          <input type="radio" name="comp2" value="fast" />
          <span>A. 圆点移动得越快越好</span>
        </label>
        <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
          <input type="radio" name="comp2" value="wait" />
          <span>B. 在红绿灯处等待，直到绿灯亮起</span>
        </label>
        <label style="display:flex; gap:10px; align-items:flex-start; cursor:pointer;">
          <input type="radio" name="comp2" value="none" />
          <span>C. 本实验没有设定任何规则</span>
        </label>
      </div>
    </div>
    <div class="hint" id="compHint"></div>
    <div class="actions">
      <button class="btn primary" id="btnBeginExperiment">我已作答，下一步</button>
    </div>
  `);

  els.modalCard.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => {
    input.checked = comprehensionChoices[input.name] === input.value;
    input.addEventListener("change", () => { comprehensionChoices[input.name] = input.value; });
  });

  document.querySelector<HTMLButtonElement>("#btnBeginExperiment")?.addEventListener("click", () => {
    const nowMs = performance.now();
    const choice1 = document.querySelector<HTMLInputElement>('input[name="comp1"]:checked')?.value;
    const choice2 = document.querySelector<HTMLInputElement>('input[name="comp2"]:checked')?.value;
    const hint = document.querySelector<HTMLDivElement>("#compHint");
    if (!choice1 || !choice2) {
      if (hint) hint.textContent = "请回答全部两个问题后再继续。";
      return;
    }
    if (choice1 !== "less" || choice2 !== "wait") {
      if (hint) hint.textContent = "回答错误，请重新阅读指导语后再继续";
      return;
    }

    if (hint) hint.textContent = "";
    const comprehensionNote = `q1=${choice1};q2=${choice2}`;
    lastComprehensionEvent = { nowMs, note: comprehensionNote };
    logger.log({
      nowMs,
      tSec: 0,
      event: "comprehension_answer",
      phase: engine.state.phase,
      lightIndex: null,
      lightColor: null,
      money: engine.state.money,
      note: comprehensionNote
    });

    enterPracticeMode();
    closeModal();
  });
}

function clearInterventionTimer(): void {
  if (interventionTimer !== null) {
    window.clearInterval(interventionTimer);
    interventionTimer = null;
  }
}

// 文本干预页：练习结束后、正式任务前展示分配到的一篇材料（15 选 1）。
// 阅读时间累计仅计算材料实际显示的时间；返回后继续累计。
function showIntervention(): void {
  navigate("intervention");
  interventionStartedAtMs = performance.now();
  openModal(`
    <h1>干预材料</h1>
    <p>${treatmentMaterial.prompt}</p>
    <div class="intervention-material">
      ${treatmentMaterial.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
    </div>
    <div class="actions">
      <button class="btn primary" id="btnFinishIntervention" disabled></button>
    </div>
  `);

  const btn = document.querySelector<HTMLButtonElement>("#btnFinishIntervention");
  const refreshButton = (): void => {
    if (!btn) return;
    const remainingSec = Math.ceil(
      INTERVENTION_MIN_READ_SEC - (interventionDurationMs + performance.now() - interventionStartedAtMs) / 1000
    );
    if (remainingSec > 0) {
      btn.disabled = true;
      btn.textContent = `请认真阅读（${remainingSec} 秒后可继续）`;
    } else {
      btn.disabled = false;
      btn.textContent = "我已完成阅读，下一步";
    }
  };
  clearInterventionTimer();
  refreshButton();
  interventionTimer = window.setInterval(refreshButton, 250);

  btn?.addEventListener("click", () => {
    interventionShown = true;
    clearInterventionTimer();
    enterFormalMode();
    closeModal();
  });
}

// 操纵检验在程序内作答；进入后清空返回路径，不能回看材料。
function showManipulationCheckScreen(): void {
  navigate("manipulation");
  navigationLocked = true;
  backStack.length = 0;
  backButton.hidden = true;
  const questions = manipulationQuestions;
  openModal(`
    <h1>操纵检验</h1>
    <p>请根据您刚才阅读的材料作答。每道题请选择一个答案。</p>
    ${questions.map((q,i)=>`<fieldset class="comp-question"><legend>${i+1}. ${q.prompt}</legend>${q.options.map((o,j)=>`<label style="display:flex;gap:10px;margin:8px 0"><input type="radio" name="manip-${q.id}" value="${escapeHtmlAttr(o)}" />${String.fromCharCode(65+j)}. ${o}</label>`).join("")}</fieldset>`).join("")}
    <div class="hint" id="manipHint"></div>
    <div class="actions">
      <button class="btn primary" id="btnGotoSurvey">下一步</button>
    </div>
  `);
  document.querySelector<HTMLButtonElement>("#btnGotoSurvey")?.addEventListener("click", () => {
    const answers = questions.map(q => document.querySelector<HTMLInputElement>(`input[name="manip-${q.id}"]:checked`)?.value);
    const hint = document.querySelector<HTMLDivElement>("#manipHint");
    if (answers.some(a => !a)) { if (hint) hint.textContent = "请回答全部题目后再继续。"; return; }
    manipulationAnswers = JSON.stringify(answers);
    showCompletionScreen("saving");
    const version = navigationVersion;
    void submitFormalResultsSilently().then((outcome) => {
      completionState = outcome;
      if (view === "completion" && navigationVersion === version) {
        restoring = true;
        showCompletionScreen(outcome);
        restoring = false;
      }
    });
  });
}

function enterPracticeMode(): void {
  navigate("task");
  isPracticeMode = true;
  if (!practiceRun || practiceRun.engine.state.phase === "finished") {
    const practiceLogger = createLogger(practiceConfig, "practice");
    practiceRun = { logger: practiceLogger, engine: new ExperimentEngine(practiceConfig, practiceLogger) };
  }
  ({ logger, engine } = practiceRun);
  engine.resume(performance.now());
  if (world) {
    world.dispose();
    world = new World2D(els.canvas, practiceConfig);
  }
  lastPhase = engine.state.phase;
  finishGate = false;
  updateHud();
}

function enterFormalMode(): void {
  navigate("task");
  isPracticeMode = false;
  if (!formalRun) {
    const newLogger = createLogger(formalConfig, "formal");
    formalRun = { logger: newLogger, engine: new ExperimentEngine(formalConfig, newLogger) };
  }
  ({ logger, engine } = formalRun);
  engine.resume(performance.now());
  if (world) {
    world.dispose();
    world = new World2D(els.canvas, formalConfig);
  }
  lastPhase = engine.state.phase;
  finishGate = false;
  updateHud();
}

type CompletionScreenState = "saving" | SubmitOutcome;
let formalSavePromise: Promise<SubmitOutcome> | null = null;

function submitFormalResultsSilently(): Promise<SubmitOutcome> {
  if (formalSavePromise) return formalSavePromise;
  formalSavePromise = saveFormalResults();
  return formalSavePromise;
}

async function saveFormalResults(): Promise<SubmitOutcome> {
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
  navigate("completion");
  completionState = state;
  const elapsed = engine.state.elapsedSec;
  const baseTravelSec = engine.config.segmentDurationSec * 2;
  const waitSec = Math.floor(Math.max(0, elapsed - baseTravelSec));
  const taskMoney = engine.state.money;
  const surveyAction =
    state === "saving"
      ? ""
      : `
          <div class="completion-actions">
            <button class="btn primary" id="btnContinueSurvey">继续答题</button>
          </div>
        `;

  const statusBlock =
    state === "saving"
      ? `<div class="completion-status saving">数据正在保存，请稍候…</div>`
      : state === "sent"
        ? `<div class="completion-status success">数据已成功保存。</div>`
        : `<div class="completion-status queued">网络暂时不稳定，数据已保存并会继续尝试提交。</div>`;

  openModal(`
    <h1>任务完成</h1>
    <div class="completion-card-body">
      ${statusBlock}
      <p>在决策任务中，初始酬金 <strong>${formatMoney(engine.config.startMoney)}</strong>，您从起点到终点耗时 <strong>${baseTravelSec} 秒</strong>，在红绿灯处等待了 <strong>${waitSec} 秒</strong>，按照任务规则，每等待 1 秒扣除酬金 <strong>${formatMoney(engine.config.moneyLossPerSec)}</strong>。因此，您在该部分总计获得酬金 <strong>${formatMoney(taskMoney)}</strong>；</p>
      <p class="completion-close-note">后续填写完成简短问卷后，除固定参与费用外，您将在见数平台通过额外奖励渠道领取此部分收益。</p>
      <p>感谢您的参与。</p>
      ${surveyAction}
    </div>
  `);

  if (state !== "saving") {
    document
      .querySelector<HTMLButtonElement>("#btnContinueSurvey")
      ?.addEventListener("click", () => {
        const payload = formalSubmission ?? buildFormalSubmission();
        if (surveyUrl) window.location.assign(surveyUrl);
        else window.dispatchEvent(new CustomEvent(CONTINUE_SURVEY_EVENT, { detail: payload }));
      });
  }
}

function showTaskSubmitScreen(): void {
  if (!isPracticeMode) {
    showManipulationCheckScreen();
    return;
  }
  navigate("practice_complete");
  openModal(`
    <h1>练习完成</h1>
    <p>圆点已越过终点线。请点击下方按钮进入下一屏幕。</p>
    <div class="actions">
      <button class="btn" id="btnRepeatPractice">重新练习</button>
      <button class="btn primary" id="btnTaskSubmit">下一步</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnRepeatPractice")?.addEventListener("click", () => {
    enterPracticeMode();
    closeModal();
  });
  document.querySelector<HTMLButtonElement>("#btnTaskSubmit")?.addEventListener("click", () => {
    // 顺序：练习（可重练）→ 干预材料 → 正式任务 → 操纵检验 → 保存。
    if (!interventionShown) {
      showIntervention();
    } else {
      enterFormalMode();
      closeModal();
    }
  });
}

els.btnAction.addEventListener("click", () => {
  if (
    !world || view !== "task" ||
    engine.state.phase === "finished"
  ) return;

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
    if (
      view === "task" && engine.state.phase !== "idle" &&
      engine.state.phase !== "finished"
    ) {
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
  openModal('<h1>正在准备实验</h1><p>请稍候…</p>');
  try {
    const assignment = await resolveServerAssignment(makeApiUrl('/api/assignments/resolve'), participantId, treatmentId, manipulationQuestions);
    treatmentId = assignment.treatment;
    treatmentMaterial = findTreatment(treatmentId)!;
    manipulationQuestions = assignment.questions;
    logger = createLogger(currentConfig, "formal");
    engine = new ExperimentEngine(currentConfig, logger);
    closeModal();
  } catch {
    // 分配未确认前不进入实验，避免网络失败时静默换材料。
    openModal('<h1>暂时无法连接</h1><p>请检查网络后重试。</p><div class="actions"><button class="btn primary" id="retryAssignment">重试</button></div>');
    document.querySelector('#retryAssignment')?.addEventListener('click', () => { void bootstrapDesktopApp(); }, { once: true });
    return;
  }
  void flushPendingSubmissions();

  world = new World2D(els.canvas, engine.config);
  lastPhase = engine.state.phase;
  finishGate = false;

  renderDesktopPreflightGate();
  loop();
}

void bootstrapDesktopApp();

window.addEventListener("online", () => {
  void flushPendingSubmissions();
});

function updateHud(): void {
  reviewButton.hidden = view !== "task" || engine.state.phase !== "finished";
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
  let timeText = formatSeconds(0, 0);
  let moneyText = formatMoney(engine.config.startMoney);
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
    timeText = formatSeconds(s.elapsedSec, 0);
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

  if (view === "task" && !finishGate && (lastPhase !== engine.state.phase || engine.state.phase === "finished")) {
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
