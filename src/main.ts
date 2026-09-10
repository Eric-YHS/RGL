import "./style.css";

import type { ExperimentConfig, RevealMode } from "./experiment/types";
import { ExperimentEngine } from "./experiment/engine";
import type { ClientDeviceInfo, SessionSubmission } from "./experiment/logger";
import { ExperimentLogger } from "./experiment/logger";
import { formatMoney, formatSeconds } from "./experiment/utils";
import { findTreatment, resolveTreatmentId } from "./experiment/treatments";
import { World2D } from "./scene/world2d";

type SubmitOutcome = "sent" | "queued";
type DesktopInputProof = {
  keyboard: boolean;
};

const params = new URLSearchParams(window.location.search);
const participantId = (params.get("pid") ?? "").trim();
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

// 干预材料分配：URL treatment 参数（见数随机化后与操纵检验联动）> pid 哈希 >
// 本地持久化随机；同一被试退出再进仍进入同一处理组（需求批注第 1 条）。
const treatmentId = resolveTreatmentId(window.location.search, participantId);
const treatmentMaterial = findTreatment(treatmentId)!;
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

    <div class="desktop-preflight" id="desktopGate" style="display:none;"></div>
  </div>
  <div class="attention-warning" id="attentionWarning" style="display:none;" role="alertdialog" aria-modal="true"></div>
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
  attentionWarning: document.querySelector<HTMLDivElement>("#attentionWarning")!
};

const currentConfig: ExperimentConfig = formalConfig;
let logger: ExperimentLogger = createLogger(currentConfig, "formal");
let engine: ExperimentEngine = new ExperimentEngine(currentConfig, logger);
let world: World2D | null = null;
let formalClientSessionId = createClientSessionId();
let formalSubmission: SessionSubmission | null = null;
let isPracticeMode = false;
const desktopInputProof: DesktopInputProof = {
  keyboard: false
};
let desktopGateReady = false;
let desktopGateVisible = false;
let pausedByDesktopGate = false;
let desktopGateIntroductionAcknowledged = false;
let practiceCompletedOnce = false;
let resumeDeviceCornerCheck: (() => void) | null = null;
type ModalScreen = "instructions" | "comprehension" | "practice_ready" | "intervention" | "manipulation_check";
let currentModalScreen: ModalScreen | null = null;
type AttentionResumeTarget =
  | { kind: "task_restart" }
  | { kind: "modal"; screen: ModalScreen }
  | { kind: "task_idle" };
let attentionResumeTarget: AttentionResumeTarget | null = null;

type DisplayCheckMode = "initial" | "recheck" | "before_start";
const DISPLAY_CHECK_MAX_DURATION_MS = 6000;
let displayCheckMode: DisplayCheckMode | null = null;
let displayCheckNotice = "按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。请连续完成，不要滚动页面。";
let displayCheckCertified = false;
let cornerCheckCompleted = false;
let lastDeviceCheckPassedMs = 0;
const DEVICE_CHECK_COOLDOWN_MS = 2000;
type AttentionIssue =
  | "document_hidden"
  | "window_blurred"
  | "viewport_changed"
  | "experiment_region_not_fully_visible";

let attentionWarningVisible = false;
let currentAttentionIssue: AttentionIssue | null = null;
let visibilityCheckQueued = false;
let lastViewportSignature = getViewportSignature();

function hasDesktopPointer(): boolean {
  return window.matchMedia("(pointer: fine)").matches;
}

function hasDesktopHover(): boolean {
  return window.matchMedia("(hover: hover)").matches;
}

function renderCornerCheckStatusItems(): string {
  const pointerReady = hasDesktopPointer();
  const hoverReady = hasDesktopHover();
  const keyboardReady = desktopInputProof.keyboard;

  const items = [
    { ready: pointerReady, label: pointerReady ? "检测到精细指针设备" : "请进行精细指针设备检测" },
    { ready: hoverReady, label: hoverReady ? "检测到悬停能力" : "请进行悬停能力检测" },
    { ready: keyboardReady, label: keyboardReady ? "已检测到实体键盘输入" : "请按一次实体键盘按键" }
  ];

  return items
    .map((item) => `<div class="${item.ready ? "ready" : ""}">${item.ready ? "✓" : "•"} ${item.label}</div>`)
    .join("");
}

function updateCornerCheckStatus(): void {
  const container = els.desktopGate.querySelector<HTMLElement>("#displayCornerCheckStatus");
  if (!container) return;
  container.innerHTML = renderCornerCheckStatusItems();
}

function startDisplayCornerCheck(
  mode: DisplayCheckMode,
  notice = "按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。请连续完成，不要滚动页面。"
): void {
  displayCheckMode = mode;
  displayCheckCertified = false;
  displayCheckNotice = notice;
  renderDisplayCornerCheck();
}

function startDisplayDeviceCheck(mode: DisplayCheckMode): void {
  closeModal();  // 关闭可能处于打开状态的 modal，防止旧按钮残留焦点（Space/Enter keyup 误触发 click）
  displayCheckMode = mode;
  displayCheckCertified = false;
  cornerCheckCompleted = false;
  resetDesktopInputProof();
  resumeDeviceCornerCheck = null;
  renderDeviceCheck();
}

function areAllDeviceChecksReady(): boolean {
  const pointerReady = hasDesktopPointer();
  const hoverReady = hasDesktopHover();
  const keyboardReady = desktopInputProof.keyboard;
  return pointerReady && hoverReady && keyboardReady;
}

function renderDeviceCheck(): void {
  const mode = displayCheckMode;
  if (!mode) return;

  els.desktopGate.classList.add("display-corner-check-active");
  els.desktopGate.innerHTML = `
    <section class="display-corner-check display-device-check" id="displayCornerCheck" aria-label="输入设备检查">
      <div class="display-corner-check-instructions">
        <h1>输入设备检查</h1>
        <p id="displayCornerCheckHint">${displayCheckNotice}</p>
        <div class="display-corner-check-status" id="displayCornerCheckStatus">
          ${renderCornerCheckStatusItems()}
        </div>
        <p class="hint">请按一次键盘按键。完成后将自动进入显示区域检查。</p>
      </div>
    </section>
  `;
  els.desktopGate.style.display = "grid";
  desktopGateVisible = true;

  // 记录当前视口签名，避免因 overflow 变化（滚动条显隐）
  // 导致的 resize 事件误触发 invalidateDisplayCheckForEnvironmentChange。
  lastViewportSignature = getViewportSignature();

  // 键盘检测由持久化监听器统一处理（见 installDesktopKeyboardDetector 附近），
  // 此处设置回调以便键盘检测后自动进入角落检查阶段。
  resumeDeviceCornerCheck = () => {
    if (!displayCheckMode) return;
    if (cornerCheckCompleted) return;
    if (areAllDeviceChecksReady()) {
      startDisplayCornerCheck(
        displayCheckMode,
        "设备检查已完成。请按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。"
      );
    }
  };

  if (areAllDeviceChecksReady()) {
    startDisplayCornerCheck(mode, "设备检查已完成。请按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。");
  }
}

function renderDisplayCornerCheck(): void {
  const mode = displayCheckMode;
  if (!mode) return;

  els.desktopGate.classList.add("display-corner-check-active");
  els.desktopGate.innerHTML = `
    <section class="display-corner-check" id="displayCornerCheck" aria-label="实验显示区域检查">
      <svg class="display-corner-check-line" id="displayCornerCheckLine" aria-hidden="true">
        <polyline fill="none" stroke="#17689a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <button type="button" class="display-corner-target top-left" data-corner="0" aria-label="左上角"></button>
      <button type="button" class="display-corner-target top-right" data-corner="1" aria-label="右上角"></button>
      <button type="button" class="display-corner-target bottom-right" data-corner="2" aria-label="右下角"></button>
      <button type="button" class="display-corner-target bottom-left" data-corner="3" aria-label="左下角"></button>
      <div class="display-corner-check-instructions">
        <h1>实验显示区域检查</h1>
        <p id="displayCornerCheckHint">${displayCheckNotice}</p>
        <div class="display-corner-check-status" id="displayCornerCheckStatus">
          ${renderCornerCheckStatusItems()}
        </div>
        <p class="hint">如需调整浏览器缩放，请按 Ctrl（Mac 为 ⌘）+ 减号，或按住 Ctrl（⌘）滚动鼠标滚轮/触摸板；调整完成后请重新从左上角开始。</p>
      </div>
    </section>
  `;
  els.desktopGate.style.display = "grid";
  desktopGateVisible = true;

  // 记录当前视口签名，避免因 overflow 变化（滚动条显隐）
  // 导致的 resize 事件误触发 invalidateDisplayCheckForEnvironmentChange。
  lastViewportSignature = getViewportSignature();

  const surface = els.desktopGate.querySelector<HTMLElement>("#displayCornerCheck");
  const line = els.desktopGate.querySelector<SVGPolylineElement>("#displayCornerCheckLine polyline");
  const targets = Array.from(els.desktopGate.querySelectorAll<HTMLElement>("[data-corner]"));
  if (!surface || !line || targets.length !== 4) return;

  let nextCorner = 0;
  let pointerId: number | null = null;
  let startedAtMs = 0;
  const connectedCorners: Array<{ x: number; y: number }> = [];
  let previewPoint: { x: number; y: number } | null = null;

  const pointFromEvent = (event: PointerEvent): { x: number; y: number } => {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const centerOfTarget = (index: number): { x: number; y: number } => {
    const surfaceRect = surface.getBoundingClientRect();
    const targetRect = targets[index].getBoundingClientRect();
    return {
      x: targetRect.left - surfaceRect.left + targetRect.width / 2,
      y: targetRect.top - surfaceRect.top + targetRect.height / 2
    };
  };
  const isOnTarget = (point: { x: number; y: number }, index: number): boolean => {
    const targetRect = targets[index].getBoundingClientRect();
    const center = centerOfTarget(index);
    return Math.hypot(point.x - center.x, point.y - center.y) <= Math.max(targetRect.width, targetRect.height) * 1.2;
  };
  const redraw = (): void => {
    const points = previewPoint ? [...connectedCorners, previewPoint] : connectedCorners;
    line.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
  };
  const reset = (notice: string): void => {
    displayCheckNotice = notice;
    renderDisplayCornerCheck();
  };

  resumeDeviceCornerCheck = () => {
    if (!displayCheckMode) return;

    // We are currently in the device-check phase; wait until all device checks
    // pass, then automatically switch to the corner check for the same mode.
    if (!cornerCheckCompleted) {
      if (areAllDeviceChecksReady()) {
        startDisplayCornerCheck(displayCheckMode, "设备检查已完成。请按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。");
      }
      return;
    }

    const pointerReady = hasDesktopPointer();
    const hoverReady = hasDesktopHover();
    const keyboardReady = desktopInputProof.keyboard;
    if (!pointerReady || !hoverReady || !keyboardReady) {
      // If the corner check is already done but some device check is still
      // pending, reset corner state so the participant can complete it again
      // after satisfying all device checks.  Without the reset, the
      // re-rendered corner check would never fire completion because
      // cornerCheckCompleted stays true and completeCornerCheck returns early.
      displayCheckNotice = "连线已完成，请继续完成设备检查：按一次键盘按键。";
      cornerCheckCompleted = false;
      renderDisplayCornerCheck();
      return;
    }

    displayCheckCertified = true;
    displayCheckMode = null;
    lastDeviceCheckPassedMs = performance.now();
    els.desktopGate.classList.remove("display-corner-check-active");
    els.desktopGate.style.display = "none";
    desktopGateVisible = false;

    const finishedMode = mode;
    if (finishedMode === "initial") {
      desktopGateReady = true;
      lastViewportSignature = getViewportSignature();
      showInstructions();
      return;
    }
    if (finishedMode === "recheck") {
      desktopGateReady = true;
      lastViewportSignature = getViewportSignature();
      resumeAfterAttentionRecheck();
      return;
    }
    if (finishedMode === "before_start") {
      desktopGateReady = true;
      lastViewportSignature = getViewportSignature();
      updateHud();
    }
  };
  const completeCornerCheck = (): void => {
    if (cornerCheckCompleted) return;
    cornerCheckCompleted = true;
    resumeDeviceCornerCheck?.();
  };

  surface.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        reset("正在调整浏览器缩放。调整完成并确认四角同时可见后，请从左上角重新开始。");
        return;
      }
      event.preventDefault();
      reset("检测到滚轮操作。请停止滚动，确认实验区完整显示后重新从左上角开始。");
    },
    { passive: false }
  );
  surface.addEventListener("contextmenu", (event) => event.preventDefault());

  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const point = pointFromEvent(event);
    if (!isOnTarget(point, 0)) {
      reset("请从左上角圆点开始，按住鼠标左键后连续经过四个角。");
      return;
    }
    pointerId = event.pointerId;
    startedAtMs = performance.now();
    nextCorner = 1;
    connectedCorners.length = 0;
    connectedCorners.push(centerOfTarget(0));
    previewPoint = point;
    redraw();
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId || nextCorner >= targets.length) return;
    if (performance.now() - startedAtMs > DISPLAY_CHECK_MAX_DURATION_MS) {
      reset("连续连线超时。请确认四角同时可见后，从左上角重新开始。");
      return;
    }

    const point = pointFromEvent(event);
    previewPoint = point;
    redraw();
    if (!isOnTarget(point, nextCorner)) return;

    connectedCorners.push(centerOfTarget(nextCorner));
    nextCorner += 1;
    redraw();
    if (nextCorner === targets.length) completeCornerCheck();
  });

  surface.addEventListener("pointerup", (event) => {
    if (pointerId !== event.pointerId || nextCorner === targets.length) return;
    reset("连线未经过全部四个角。请从左上角重新开始并保持按住鼠标左键。");
  });
  surface.addEventListener("pointercancel", () => {
    reset("检测中断。请确认实验区完整显示后，从左上角重新开始。");
  });
}

function invalidateDisplayCheckForEnvironmentChange(notice: string): boolean {
  if (!displayCheckMode) return false;
  displayCheckCertified = false;
  displayCheckNotice = notice;
  renderDisplayCornerCheck();
  return true;
}

function renderDesktopPreflightGate(): void {
  if (displayCheckMode) {
    // 设备/角落检查已在进行中，由检查渲染函数自行管理 UI。
    // resize/visibilitychange 处理器会单独调用 invalidateDisplayCheckForEnvironmentChange
    // 在需要时重新渲染角落检查，因此此处无需重复调用 renderDisplayCornerCheck。
    return;
  }
  if (desktopGateIntroductionAcknowledged) {
    // The participant has already passed the welcome gate and is either in the
    // combined device + corner check or reading the instructions. Nothing to render.
    return;
  }

  if (!pausedByDesktopGate && engine.state.phase !== "idle" && engine.state.phase !== "finished") {
    engine.pause(performance.now());
    pausedByDesktopGate = true;
  }

  els.desktopGate.innerHTML = `
    <section class="desktop-preflight-card desktop-entry-card">
      <div class="desktop-entry-zoom-hints">
        <p>若显示不全</p>
        <p>按 <strong>Ctrl + 减号</strong>（⌘ + 减号）。</p>
      </div>
      <h1>欢迎参加学术调查</h1>
      <p>感谢您参与本次学术研究。我们是中山大学学术研究团队。本研究的初始酬金为 <strong>100 元人民币</strong>，但实际酬金将完全取决于您在任务中的决策，介乎 <strong>0 元–84 元人民币</strong>。</p>
      <p>本次任务共两轮，其中第一轮为<strong>练习</strong>，帮助参与者熟悉任务。第二轮为<strong>正式任务</strong>，将直接决定薪酬。完成整个调查需 <strong>15-20 分钟</strong>。</p>
      <p>本次参与完全自愿，您可以随时退出，但退出无法获得酬金。作答完全匿名，数据仅用于学术研究，请放心作答。</p>
      <p>为了确保您能顺利开展实验，请先完成设备与环境检测。</p>
      <p class="hint">请使用台式机或笔记本电脑。开始后请保持页面可见，不要缩放或离开网页。</p>
      <div class="desktop-preflight-actions">
        <button class="btn primary" id="btnDesktopGateCheck">阅读任务指导</button>
      </div>
    </section>
  `;
  els.desktopGate.style.display = "grid";
  desktopGateVisible = true;
  els.desktopGate
    .querySelector<HTMLButtonElement>("#btnDesktopGateCheck")
    ?.addEventListener("click", () => {
      desktopGateIntroductionAcknowledged = true;
      els.desktopGate.style.display = "none";
      desktopGateVisible = false;
      if (pausedByDesktopGate) {
        engine.resume(performance.now());
        pausedByDesktopGate = false;
      }
      startDisplayDeviceCheck("initial");
    });
}

function getViewportSignature(): string {
  const viewport = window.visualViewport;
  return [
    window.innerWidth,
    window.innerHeight,
    Math.round(viewport?.width ?? window.innerWidth),
    Math.round(viewport?.height ?? window.innerHeight),
    Math.round((window.devicePixelRatio || 1) * 100)
  ].join("x");
}

function isTaskInProgress(): boolean {
  return engine.state.phase !== "idle" && engine.state.phase !== "finished";
}

function captureAttentionResumeTarget(): AttentionResumeTarget {
  if (isTaskInProgress()) {
    return { kind: "task_restart" };
  }
  if (currentModalScreen) {
    return { kind: "modal", screen: currentModalScreen };
  }
  return { kind: "task_idle" };
}

function resumeAfterAttentionRecheck(): void {
  const target = attentionResumeTarget ?? { kind: "task_idle" };
  attentionResumeTarget = null;

  if (target.kind === "task_restart") {
    restartCurrentTask();
    return;
  }

  if (target.kind === "modal") {
    if (target.screen === "instructions") {
      showInstructions();
    } else if (target.screen === "comprehension") {
      showComprehensionTest();
    } else if (target.screen === "intervention") {
      showIntervention();
    } else if (target.screen === "manipulation_check") {
      showManipulationCheckScreen();
    } else {
      showPracticeReady();
    }
    return;
  }

  updateHud();
}

function isTaskMonitoringArmed(): boolean {
  return (
    desktopGateReady &&
    displayCheckCertified &&
    !displayCheckMode &&
    !desktopGateVisible &&
    !attentionWarningVisible &&
    engine.state.phase !== "finished"
  );
}

function isExperimentRegionFullyVisible(): boolean {
  const targets = [els.stage, els.canvas, els.btnAction];
  // 使用 window.innerWidth/Height 而非 visualViewport，以保证在不同浏览器
  // （尤其是 visualViewport API 行为不一致的桌面浏览器）上的兼容性。
  const left = 0;
  const top = 0;
  const right = window.innerWidth;
  const bottom = window.innerHeight;
  // 增加容差以适配不同操作系统/DPI 缩放下的亚像素渲染差异。
  const tolerance = 5;

  // The decision task must never require horizontal scrolling. This also
  // catches a canvas whose drawing area overflows while its parent still fits.
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + tolerance) {
    return false;
  }

  return targets.every((target) => {
    const rect = target.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= left - tolerance &&
      rect.top >= top - tolerance &&
      rect.right <= right + tolerance &&
      rect.bottom <= bottom + tolerance
    );
  });
}

function logAttentionEvent(event: "attention_lost" | "attention_restored", issue: AttentionIssue, nowMs: number): void {
  // Practice data is never submitted, so keep the persisted audit trail limited
  // to the formal decision task.
  if (isPracticeMode) return;

  logger.log({
    nowMs,
    tSec: engine.state.elapsedSec,
    event,
    phase: engine.state.phase,
    lightIndex: engine.state.lightIndex,
    lightColor: engine.getCurrentLightColor(),
    money: engine.getRecordedMoney(),
    note: issue
  });
}

function attentionIssueMessage(issue: AttentionIssue): string {
  switch (issue) {
    case "document_hidden":
      return "检测到实验页面被切换到后台、最小化或暂时不可见。";
    case "window_blurred":
      return "检测到浏览器窗口已失去焦点，可能切换到了其他窗口。";
    case "viewport_changed":
      return "检测到浏览器窗口大小或页面缩放发生了变化。";
    case "experiment_region_not_fully_visible":
      return "检测到红绿灯实验区没有完整显示在当前浏览器视口内。";
  }
}

function renderAttentionWarning(): void {
  if (!currentAttentionIssue) return;

  const target = attentionResumeTarget ?? captureAttentionResumeTarget();
  const recoveryMessage = target.kind === "task_restart"
    ? "本轮任务将作废。请重新完成实验显示区域检查；检查通过后将从当前页面起始状态重新开始。"
    : "请重新完成实验显示区域检查；检查通过后将回到刚刚的页面继续。";

  els.attentionWarning.innerHTML = `
    <section class="attention-warning-card" aria-labelledby="attentionWarningTitle">
      <h1 id="attentionWarningTitle">实验已暂停</h1>
      <p>${attentionIssueMessage(currentAttentionIssue)}</p>
      <p>${recoveryMessage}</p>
      <div class="attention-warning-actions">
        <button class="btn primary" id="btnResumeAfterAttentionWarning">重新检查显示区域</button>
      </div>
      <p class="hint" id="attentionWarningHint"></p>
    </section>
  `;
  els.attentionWarning.style.display = "grid";

  els.attentionWarning
    .querySelector<HTMLButtonElement>("#btnResumeAfterAttentionWarning")
    ?.addEventListener("click", () => {
      if (!currentAttentionIssue) return;
      attentionWarningVisible = false;
      currentAttentionIssue = null;
      els.attentionWarning.style.display = "none";
      attentionResumeTarget = attentionResumeTarget ?? target;
      startDisplayDeviceCheck("recheck");
    });
}

function pauseForAttentionIssue(issue: AttentionIssue, force = false): void {
  if ((!force && !isTaskMonitoringArmed()) || attentionWarningVisible) return;

  const nowMs = performance.now();

  // 设备检测刚通过不久（冷却期内），忽略非强制触发，防止检测-通过-暂停-重启循环。
  if (!force && lastDeviceCheckPassedMs > 0 && nowMs - lastDeviceCheckPassedMs < DEVICE_CHECK_COOLDOWN_MS) return;

  attentionResumeTarget = captureAttentionResumeTarget();
  if (isTaskInProgress()) engine.pause(nowMs);
  displayCheckCertified = false;

  attentionWarningVisible = true;
  currentAttentionIssue = issue;
  logAttentionEvent("attention_lost", issue, nowMs);
  renderAttentionWarning();
}

function scheduleExperimentVisibilityCheck(): void {
  if (!isTaskMonitoringArmed() || attentionWarningVisible || visibilityCheckQueued) return;
  visibilityCheckQueued = true;
  requestAnimationFrame(() => {
    visibilityCheckQueued = false;
    if (!isTaskMonitoringArmed() || attentionWarningVisible || document.hidden) return;
    if (!isExperimentRegionFullyVisible()) {
      pauseForAttentionIssue("experiment_region_not_fully_visible");
    }
  });
}

function installExperimentVisibilityMonitor(): void {
  const observer = new IntersectionObserver(
    () => {
      scheduleExperimentVisibilityCheck();
    },
    { threshold: [0, 1] }
  );
  observer.observe(els.stage);
  observer.observe(els.canvas);
  observer.observe(els.btnAction);

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      scheduleExperimentVisibilityCheck();
    });
    resizeObserver.observe(els.stage);
    resizeObserver.observe(els.canvas);
    resizeObserver.observe(els.btnAction);
  }

  document.addEventListener("scroll", scheduleExperimentVisibilityCheck, true);
  window.visualViewport?.addEventListener("scroll", scheduleExperimentVisibilityCheck);
  window.visualViewport?.addEventListener("resize", () => {
    const nextSignature = getViewportSignature();
    if (nextSignature !== lastViewportSignature) {
      const wasMonitoring = isTaskMonitoringArmed();
      lastViewportSignature = nextSignature;
      if (
        invalidateDisplayCheckForEnvironmentChange(
          "检测到窗口大小或页面缩放变化。请确认四角同时可见后，从左上角重新开始。"
        )
      ) {
        return;
      }
      pauseForAttentionIssue("viewport_changed", wasMonitoring);
      return;
    }
    scheduleExperimentVisibilityCheck();
  });
}

function openModal(html: string): void {
  els.modalCard.innerHTML = html;
  els.modal.style.display = "grid";
}

function closeModal(): void {
  els.modal.style.display = "none";
  currentModalScreen = null;
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
      money: engine.getRecordedMoney(),
      violations: engine.state.violations
    },
    device: collectDeviceInfo(),
    interventionMs: Math.round(interventionDurationMs)
  });
}

function continueSurveyAfterCompletion(): void {
  if (!formalSubmission) {
    formalSubmission = buildFormalSubmission();
  }
  window.dispatchEvent(new CustomEvent(CONTINUE_SURVEY_EVENT, { detail: formalSubmission }));
}

function showInstructions(): void {
  currentModalScreen = "instructions";
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
      <video controls preload="metadata" playsinline poster="./demo-poster.svg">
        <source src="./demo.mp4" type="video/mp4" />
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
  currentModalScreen = "comprehension";
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
      <button class="btn" id="btnBackToInstructions">上一步</button>
      <button class="btn primary" id="btnBeginExperiment">我已作答，下一步</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnBackToInstructions")?.addEventListener("click", () => {
    showInstructions();
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
      if (hint) hint.textContent = "回答错误，请重新阅读指导语后再继续。";
      return;
    }

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

    showPracticeReady();
  });
}

function showPracticeReady(): void {
  currentModalScreen = "practice_ready";
  if (!practiceCompletedOnce) {
    // 第一次：只显示进入练习按钮
    openModal(`
      <h1>任务准备</h1>
      <p>回答正确！请点击下方按钮进入练习界面。</p>
      <div class="actions">
        <button class="btn" id="btnBackToCompTest">上一步</button>
        <button class="btn primary" id="btnEnterPractice">进入练习</button>
      </div>
    `);

    document.querySelector<HTMLButtonElement>("#btnBackToCompTest")?.addEventListener("click", () => {
      showComprehensionTest();
    });

    document.querySelector<HTMLButtonElement>("#btnEnterPractice")?.addEventListener("click", () => {
      enterPracticeMode();
      closeModal();
    });
  } else {
    // 练习完成后：显示返回导语、继续练习、进入正式决策任务
    openModal(`
      <h1>任务准备</h1>
      <p>您已完成练习轮次。您可以选择返回导语重新阅读说明、继续练习，或进入决策任务。</p>
      <div class="actions">
        <button class="btn" id="btnBackToInstructions">返回导语</button>
        <button class="btn" id="btnContinuePractice">继续练习</button>
        <button class="btn primary" id="btnEnterFormal">进入决策任务</button>
      </div>
    `);

    document.querySelector<HTMLButtonElement>("#btnBackToInstructions")?.addEventListener("click", () => {
      showInstructions();
    });

    document.querySelector<HTMLButtonElement>("#btnContinuePractice")?.addEventListener("click", () => {
      enterPracticeMode();
      closeModal();
    });

    document.querySelector<HTMLButtonElement>("#btnEnterFormal")?.addEventListener("click", () => {
      enterFormalMode();
      closeModal();
    });
  }
}

function clearInterventionTimer(): void {
  if (interventionTimer !== null) {
    window.clearInterval(interventionTimer);
    interventionTimer = null;
  }
}

// 文本干预页：练习结束后、正式任务前展示分配到的一篇材料（15 选 1）。
// 批注要求：强制最低阅读时间；本页不设返回（返回入口在随后的任务准备页）。
function showIntervention(): void {
  currentModalScreen = "intervention";
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
      INTERVENTION_MIN_READ_SEC - (performance.now() - interventionStartedAtMs) / 1000
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
    interventionDurationMs += Math.max(0, performance.now() - interventionStartedAtMs);
    interventionShown = true;
    clearInterventionTimer();
    showPracticeReady();
  });
}

// 操纵检验跳转页：正式数据保存完成后展示。批注要求：本页不允许返回，
// 只保留前往见数问卷的入口；操纵检验题目在见数问卷中呈现。
function showManipulationCheckScreen(): void {
  currentModalScreen = "manipulation_check";
  const action = surveyUrl
    ? `<a class="btn primary" href="${escapeHtmlAttr(surveyUrl)}">继续答题</a>`
    : `<button class="btn primary" id="btnGotoSurvey">继续答题</button>`;
  openModal(`
    <h1>操纵检验</h1>
    <p>点击下方按钮后继续完成见数问卷。</p>
    <div class="actions">
      ${action}
    </div>
  `);
  document
    .querySelector<HTMLButtonElement>("#btnGotoSurvey")
    ?.addEventListener("click", continueSurveyAfterCompletion);
}

function enterPracticeMode(): void {
  isPracticeMode = true;
  const practiceLogger = createLogger(practiceConfig, "practice");
  const practiceEngine = new ExperimentEngine(practiceConfig, practiceLogger);
  logger = practiceLogger;
  engine = practiceEngine;
  if (world) {
    world.dispose();
    world = new World2D(els.canvas, practiceConfig);
  }
  lastPhase = engine.state.phase;
  finishGate = false;
  updateHud();
}

function enterFormalMode(): void {
  isPracticeMode = false;
  const newLogger = createLogger(formalConfig, "formal");
  const newEngine = new ExperimentEngine(formalConfig, newLogger);
  logger = newLogger;
  engine = newEngine;
  if (world) {
    world.dispose();
    world = new World2D(els.canvas, formalConfig);
  }
  lastPhase = engine.state.phase;
  finishGate = false;
  updateHud();
}

function restartCurrentTask(): void {
  const config = isPracticeMode ? practiceConfig : formalConfig;
  const runKind: "practice" | "formal" = isPracticeMode ? "practice" : "formal";

  // Do not resume the interrupted state. A new engine/logger makes this round
  // start at the initial position with a fresh timer and compensation amount.
  if (!isPracticeMode) {
    formalClientSessionId = createClientSessionId();
    formalSubmission = null;
  }
  logger = createLogger(config, runKind);
  engine = new ExperimentEngine(config, logger);
  world?.dispose();
  world = new World2D(els.canvas, config);
  lastPhase = engine.state.phase;
  finishGate = false;
  updateHud();
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
  const baseTravelSec = engine.config.segmentDurationSec * 2;
  const waitSec = Math.floor(Math.max(0, elapsed - baseTravelSec));
  const taskMoney = engine.state.money;
  const surveyAction =
    state === "saving"
      ? ""
      : `
          <div class="completion-actions">
            <button class="btn primary" id="btnToManipulationCheck">继续答题</button>
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
      .querySelector<HTMLButtonElement>("#btnToManipulationCheck")
      ?.addEventListener("click", showManipulationCheckScreen);
  }
}

function showTaskSubmitScreen(): void {
  openModal(`
    <h1>${isPracticeMode ? "练习完成" : "决策任务"}</h1>
    <p>圆点已越过终点线。请点击下方按钮${isPracticeMode ? "返回导语" : "进入下一屏幕"}。</p>
    <div class="actions">
      <button class="btn primary" id="btnTaskSubmit">${isPracticeMode ? "返回" : "提交并保存数据"}</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnTaskSubmit")?.addEventListener("click", () => {
    if (isPracticeMode) {
      practiceCompletedOnce = true;
      // 9.10 需求顺序：练习任务 → 文本干预 → 正式任务。首次完成练习后先进入
      // 干预材料页；再次练习（任务准备页点“继续练习”）后直接进入任务准备。
      if (!interventionShown) {
        showIntervention();
      } else {
        showPracticeReady();
      }
    } else {
      showCompletionScreen("saving");
      void submitFormalResultsSilently().then((outcome) => {
        showCompletionScreen(outcome);
      });
    }
  });
}

els.btnAction.addEventListener("click", () => {
  if (
    !world ||
    engine.state.phase === "finished" ||
    attentionWarningVisible ||
    displayCheckMode
  ) return;

  const nowMs = performance.now();
  if (engine.state.phase === "idle") {
    if (!displayCheckCertified) {
      startDisplayDeviceCheck("before_start");
      return;
    }
    closeModal();
    engine.start(nowMs);
    return;
  }

  engine.pressWalk(nowMs);
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    if (
      !attentionWarningVisible &&
      !displayCheckMode &&
      engine.state.phase !== "idle" &&
      engine.state.phase !== "finished"
    ) {
      e.preventDefault();
      engine.pressWalk(performance.now());
    }
  }
});

// 持久化键盘检测监听器 — 在设备检查/角落检查阶段全程生效。
// 采用单一持久化监听器而非动态添加/移除，从根源上消除监听器生命周期
// 管理带来的竞态问题（如：按住按键时通过检测，松开后状态异常回退）。
window.addEventListener("keydown", (e) => {
  if (desktopInputProof.keyboard) return;                         // 已检测到键盘
  if (e.metaKey || e.ctrlKey || e.altKey) return;                // 修饰键忽略
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return; // 特殊键忽略
  if (!displayCheckMode) return;                                  // 非设备检查阶段

  e.preventDefault();                                              // 阻止 Space/Enter 在 keyup 时触发聚焦按钮的 click
  desktopInputProof.keyboard = true;
  updateCornerCheckStatus();
  resumeDeviceCornerCheck?.();
});

let lastPhase: typeof engine.state.phase = engine.state.phase;
let finishGate = false;

const hudCache = {
  btnActionDisabled: null as boolean | null,
  btnActionSelected: null as boolean | null,
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

  world = new World2D(els.canvas, engine.config);
  lastPhase = engine.state.phase;
  finishGate = false;

  installExperimentVisibilityMonitor();
  renderDesktopPreflightGate();
  loop();
}

void bootstrapDesktopApp();

window.addEventListener("online", () => {
  void flushPendingSubmissions();
});

window.addEventListener("resize", () => {
  renderDesktopPreflightGate();
  const nextSignature = getViewportSignature();
  if (nextSignature !== lastViewportSignature) {
    const wasMonitoring = isTaskMonitoringArmed();
    lastViewportSignature = nextSignature;
    if (
      invalidateDisplayCheckForEnvironmentChange(
        "检测到窗口大小或页面缩放变化。请确认四角同时可见后，从左上角重新开始。"
      )
    ) {
      return;
    }
    pauseForAttentionIssue("viewport_changed", wasMonitoring);
    return;
  }
  scheduleExperimentVisibilityCheck();
});

function resetDesktopInputProof(): void {
  desktopInputProof.keyboard = false;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    const wasMonitoring = isTaskMonitoringArmed();
    invalidateDisplayCheckForEnvironmentChange("检测到您离开了实验页面。返回后请从左上角重新开始检查。");
    pauseForAttentionIssue("document_hidden", wasMonitoring);
    return;
  }
  renderDesktopPreflightGate();
  scheduleExperimentVisibilityCheck();
});

window.addEventListener("blur", () => {
  const wasMonitoring = isTaskMonitoringArmed();
  invalidateDisplayCheckForEnvironmentChange("检测到浏览器窗口失去焦点。请返回后从左上角重新开始检查。");
  pauseForAttentionIssue("window_blurred", wasMonitoring);
});

function updateHud(): void {
  const s = engine.state;
  const nextActionDisabled = s.phase === "finished";
  const nextActionSelected = s.phase === "moving_to_finish";
  const nextActionText = s.phase === "idle" ? "开始" : "移动";
  if (hudCache.btnActionDisabled !== nextActionDisabled) {
    els.btnAction.disabled = nextActionDisabled;
    hudCache.btnActionDisabled = nextActionDisabled;
  }
  if (hudCache.btnActionSelected !== nextActionSelected) {
    els.btnAction.classList.toggle("action-selected", nextActionSelected);
    els.btnAction.setAttribute("aria-pressed", nextActionSelected ? "true" : "false");
    hudCache.btnActionSelected = nextActionSelected;
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
