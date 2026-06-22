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
    segmentDurationSec: 2,
    redWaitSec: 12,
    startMoney: 100,
    moneyLossPerSec: 2.0
  };
}

const formalConfig: ExperimentConfig = makeConfig("full", 1);
const practiceConfig: ExperimentConfig = makeConfig("full", 1);

function createLogger(config: ExperimentConfig, runKind: "formal" | "practice"): ExperimentLogger {
  return new ExperimentLogger(config, {
    participantId,
    startedAtIso: new Date().toISOString(),
    runKind
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
  keyboard: false,
  mouseMove: false,
  mouseClick: false
};
let desktopGateReady = false;
let desktopGateVisible = false;
let pausedByDesktopGate = false;
let desktopGateEnteredOnce = false;
let desktopGateIntroductionAcknowledged = false;
let instructionsShownOnce = false;
let practiceCompletedOnce = false;
type DisplayCheckMode = "initial" | "restart" | "before_start";
const DISPLAY_CHECK_MAX_DURATION_MS = 6000;
let displayCheckMode: DisplayCheckMode | null = null;
let displayCheckNotice = "按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。请连续完成，不要滚动页面。";
let displayCheckCertified = false;
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

function startDisplayCornerCheck(
  mode: DisplayCheckMode,
  notice = "按住鼠标左键，依次经过左上、右上、右下、左下四个圆点。请连续完成，不要滚动页面。"
): void {
  displayCheckMode = mode;
  displayCheckCertified = false;
  displayCheckNotice = notice;
  renderDisplayCornerCheck();
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
        <p class="hint">必须在 6 秒内连续经过四角。检测期间滚动、缩放或调整窗口会要求重新检查。</p>
      </div>
    </section>
  `;
  els.desktopGate.style.display = "grid";
  desktopGateVisible = true;

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
  const complete = (): void => {
    displayCheckCertified = true;
    displayCheckMode = null;
    els.desktopGate.classList.remove("display-corner-check-active");
    els.desktopGate.style.display = "none";
    desktopGateVisible = false;
    lastViewportSignature = getViewportSignature();

    if (mode === "initial") {
      desktopGateEnteredOnce = true;
      renderDesktopPreflightGate();
      return;
    }
    if (mode === "restart") {
      restartCurrentTask();
      return;
    }
    updateHud();
  };

  surface.addEventListener(
    "wheel",
    (event) => {
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
    if (nextCorner === targets.length) complete();
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
  displayCheckCertified = false;
  if (!displayCheckMode) return false;
  displayCheckNotice = notice;
  renderDisplayCornerCheck();
  return true;
}

function renderDesktopPreflightGate(): void {
  if (displayCheckMode) {
    renderDisplayCornerCheck();
    return;
  }
  const pointerReady = hasDesktopPointer();
  const hoverReady = hasDesktopHover();
  const keyboardReady = desktopInputProof.keyboard;
  const mouseReady = desktopInputProof.mouseMove && desktopInputProof.mouseClick;
  const prerequisitesReady = pointerReady && hoverReady && keyboardReady && mouseReady;

  if (!desktopGateIntroductionAcknowledged) {
    if (!pausedByDesktopGate && engine.state.phase !== "idle" && engine.state.phase !== "finished") {
      engine.pause(performance.now());
      pausedByDesktopGate = true;
    }

    els.desktopGate.innerHTML = `
      <section class="desktop-preflight-card desktop-entry-card">
        <h1>欢迎参加学术调查</h1>
        <p>感谢您参与本次学术研究。初始酬金为 <strong>100 元人民币</strong>，最终酬金取决于任务中的决策，介乎 <strong>0 元–92 元人民币</strong>。</p>
        <p>任务包括练习与正式任务，预计 <strong>15–20 分钟</strong>。参与完全自愿，可随时退出；退出无法获得酬金。作答匿名，数据仅用于学术研究。</p>
        <p class="hint">请使用台式机或笔记本电脑。开始后请保持页面可见，不要缩放或离开网页。</p>
        <div class="desktop-preflight-actions">
          <button class="btn primary" id="btnDesktopGateCheck">开始设备检查</button>
        </div>
      </section>
    `;
    els.desktopGate.style.display = "grid";
    desktopGateVisible = true;
    els.desktopGate
      .querySelector<HTMLButtonElement>("#btnDesktopGateCheck")
      ?.addEventListener("click", () => {
        desktopGateIntroductionAcknowledged = true;
        renderDesktopPreflightGate();
      });
    return;
  }

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

  const pointerLabel = pointerReady ? "检测到精细指针设备" : "请进行精细指针设备检测";
  const hoverLabel = hoverReady ? "检测到悬停能力" : "请进行悬停能力检测";
  const keyboardLabel = keyboardReady ? "已检测到实体键盘输入" : "请按一次实体键盘按键";
  const mouseLabel = mouseReady ? "已检测到鼠标移动和点击" : "请移动鼠标并点击一次";

  const readyNotice = prerequisitesReady
    ? `
        <div class="desktop-preflight-ready">
          桌面端校验已通过。
        </div>
        <div class="desktop-preflight-actions">
          <button class="btn primary" id="btnDesktopGateContinue">下一步：检查实验显示区域</button>
        </div>
      `
    : "";

  els.desktopGate.innerHTML = `
    <section class="desktop-preflight-card desktop-entry-card">
      <h1>设备检查</h1>
      <p>请按一次实体键盘按键，并移动、点击一次鼠标。</p>
      <div class="desktop-preflight-checklist">
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
        startDisplayCornerCheck("initial");
      });
  }
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

function isExperimentRegionFullyVisible(): boolean {
  const targets = [els.stage, els.canvas, els.btnAction];
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? window.innerWidth);
  const bottom = top + (viewport?.height ?? window.innerHeight);
  // A one-CSS-pixel tolerance avoids false alarms from fractional layout pixels.
  const tolerance = 1;

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
    money: engine.state.money,
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

  els.attentionWarning.innerHTML = `
    <section class="attention-warning-card" aria-labelledby="attentionWarningTitle">
      <h1 id="attentionWarningTitle">实验已暂停</h1>
      <p>${attentionIssueMessage(currentAttentionIssue)}</p>
      <p>本轮任务将作废。请重新完成实验显示区域检查；检查通过后将从本轮起点重新开始。</p>
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
      startDisplayCornerCheck("restart");
    });
}

function pauseForAttentionIssue(issue: AttentionIssue): void {
  if (!isTaskInProgress() || attentionWarningVisible) return;

  const nowMs = performance.now();
  engine.pause(nowMs);
  if (!isTaskInProgress()) return;

  attentionWarningVisible = true;
  currentAttentionIssue = issue;
  logAttentionEvent("attention_lost", issue, nowMs);
  renderAttentionWarning();
}

function scheduleExperimentVisibilityCheck(): void {
  if (!isTaskInProgress() || attentionWarningVisible || visibilityCheckQueued) return;
  visibilityCheckQueued = true;
  requestAnimationFrame(() => {
    visibilityCheckQueued = false;
    if (!isTaskInProgress() || attentionWarningVisible || document.hidden) return;
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
      lastViewportSignature = nextSignature;
      if (
        invalidateDisplayCheckForEnvironmentChange(
          "检测到窗口大小或页面缩放变化。请确认四角同时可见后，从左上角重新开始。"
        )
      ) {
        return;
      }
      pauseForAttentionIssue("viewport_changed");
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
    <h1>操作说明（1/3）</h1>
    <p>在本次任务中，您将控制一个<strong>圆点</strong>，并在屏幕上将其移动至<strong>终点线</strong>。</p>
    <ul>
      <li>当您点击屏幕<strong>底部</strong>的<strong>【开始】</strong>按钮后，圆点会靠近一个红绿信号灯并停下等待。</li>
      <li>按钮会变为<strong>【移动】</strong>。再次点击即可让圆点继续移动并通过红绿灯。</li>
    </ul>
    <div class="actions">
      <button class="btn primary" id="btnToInstructionVideo">下一步：观看示例短片</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnToInstructionVideo")?.addEventListener("click", () => {
    showInstructionVideo();
  });
}

function showInstructionVideo(): void {
  openModal(`
    <h1>示例短片（2/3）</h1>
    <p>请观看下面的示例短片，了解任务画面和操作方式。</p>
    <div class="instruction-video">
      <video controls preload="metadata" playsinline poster="/demo-poster.svg">
        <source src="/demo.mp4" type="video/mp4" />
        当前浏览器无法直接播放示例短片，请点击下方链接打开。
      </video>
      <a class="video-fallback-link" href="/demo.mp4" target="_blank" rel="noopener">打开示例短片</a>
    </div>
    <div class="actions">
      <button class="btn" id="btnBackToOperation">上一步</button>
      <button class="btn primary" id="btnToTaskRules">下一步：任务规则</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnBackToOperation")?.addEventListener("click", () => {
    showInstructions();
  });
  document.querySelector<HTMLButtonElement>("#btnToTaskRules")?.addEventListener("click", () => {
    showTaskRules();
  });
}

function showTaskRules(): void {
  openModal(`
    <h1>任务规则和酬金（3/3）</h1>
    <p>任务规则：在红绿灯处等待，直至其变为<strong>绿灯</strong>后通行。</p>
    <p>点击<strong>【开始】</strong>后开始计时。从起点到红绿灯、以及从红绿灯到终点线，各需 <strong>${engine.config.segmentDurationSec} 秒</strong>。</p>
    <p>初始报酬为 <strong>100 元人民币整</strong>，每耗时 <strong>1</strong> 秒，资金减少 <strong>￥${engine.config.moneyLossPerSec}</strong>；红灯等待 <strong>${engine.config.redWaitSec} 秒</strong>后变为绿灯。</p>
    <div class="actions">
      <button class="btn" id="btnBackToInstructionVideo">上一步</button>
      <button class="btn primary" id="btnToCompTest">下一步：理解测试</button>
    </div>
  `);

  document.querySelector<HTMLButtonElement>("#btnBackToInstructionVideo")?.addEventListener("click", () => {
    showInstructionVideo();
  });
  document.querySelector<HTMLButtonElement>("#btnToCompTest")?.addEventListener("click", () => {
    showComprehensionTest();
  });
}

function showComprehensionTest(): void {
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

  document
    .querySelector<HTMLButtonElement>("#btnBackToInstructions")
    ?.addEventListener("click", () => {
      showTaskRules();
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
      note: `q1=${choice1};q2=${choice2}`
    });

    showPracticeReady();
  });
}

function showPracticeReady(): void {
  if (!practiceCompletedOnce) {
    // 第一次：只显示进入练习按钮
    openModal(`
      <h1>准备开始练习</h1>
      <p>回答正确！请点击下方按钮进入练习界面。</p>
      <p>进入练习界面后，底部按钮会先显示为<strong>【开始】</strong>；点击<strong>【开始】</strong>后，练习开始计时，圆点开始移动，按钮会切换为<strong>【移动】</strong>。</p>
      <p class="hint">规则提醒：你可以在任意时刻点击<strong>【移动】</strong>，但实验规则要求你在红绿灯处等待，直到红灯变为绿色后再通行。</p>
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
      <h1>准备开始正式实验</h1>
      <p>您已完成练习轮次。您可以选择返回导语重新阅读说明、继续练习，或进入正式决策任务。</p>
      <div class="actions">
        <button class="btn" id="btnBackToInstructions">返回导语</button>
        <button class="btn" id="btnContinuePractice">继续练习</button>
        <button class="btn primary" id="btnEnterFormal">进入正式决策任务</button>
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

function enterPracticeMode(): void {
  isPracticeMode = true;
  const practiceLogger = createLogger(practiceConfig, "practice");
  const practiceEngine = new ExperimentEngine(practiceConfig, practiceLogger);
  logger = practiceLogger;
  engine = practiceEngine;
  if (world) {
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
  const waitSec = Math.max(0, elapsed - engine.config.segmentDurationSec * 2);
  const taskMoney = engine.state.money;
  const fixedFee = 0; // fixed participation fee; set to 0 if not applicable
  const totalMoney = fixedFee + taskMoney;
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
    <h1>决策任务完成</h1>
    <div class="completion-card-body">
      <h2>感谢您的参与</h2>
      <p>您获得的固定参与费用为 <strong>${formatMoney(fixedFee)}</strong>；</p>
      <p>在决策任务中，初始酬金 <strong>${formatMoney(engine.config.startMoney)}</strong>，您在红绿灯处等待了 <strong>${formatSeconds(waitSec, 1)}</strong>，按照任务规则，每等待 1 秒扣除酬金 <strong>${formatMoney(engine.config.moneyLossPerSec)}</strong>。</p>
      <p>因此，您总计获得酬金 <strong>${formatMoney(totalMoney)}</strong>。</p>
      <p>感谢您参与我们的研究。</p>
      ${statusBlock}
      <p class="completion-close-note">后续填写完简短问卷后，您将在见数平台领取自己的收益。</p>
      ${surveyAction}
    </div>
  `);
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
      showPracticeReady();
    } else {
      showCompletionScreen("saving");
      void submitFormalResultsSilently().then((outcome) => {
        showCompletionScreen(outcome);
      });
    }
  });
}

els.btnAction.addEventListener("click", () => {
  if (!world || engine.state.phase === "finished") return;

  const nowMs = performance.now();
  if (engine.state.phase === "idle") {
    if (!displayCheckCertified || !isExperimentRegionFullyVisible()) {
      startDisplayCornerCheck("before_start");
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
    lastViewportSignature = nextSignature;
    if (
      invalidateDisplayCheckForEnvironmentChange(
        "检测到窗口大小或页面缩放变化。请确认四角同时可见后，从左上角重新开始。"
      )
    ) {
      return;
    }
    pauseForAttentionIssue("viewport_changed");
    return;
  }
  scheduleExperimentVisibilityCheck();
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
  if (document.hidden) {
    invalidateDisplayCheckForEnvironmentChange("检测到您离开了实验页面。返回后请从左上角重新开始检查。");
    pauseForAttentionIssue("document_hidden");
    return;
  }
  renderDesktopPreflightGate();
  scheduleExperimentVisibilityCheck();
});

window.addEventListener("blur", () => {
  invalidateDisplayCheckForEnvironmentChange("检测到浏览器窗口失去焦点。请返回后从左上角重新开始检查。");
  pauseForAttentionIssue("window_blurred");
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
