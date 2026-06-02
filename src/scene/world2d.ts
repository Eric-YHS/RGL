import type { ExperimentConfig, ExperimentState, Phase } from "../experiment/types";
import greenSignalBmpUrl from "../assets/kimbrough-rf/green.bmp";
import redSignalBmpUrl from "../assets/kimbrough-rf/red.bmp";

type SignalGlyphCrop = { x: number; y: number; w: number; h: number };
type SignalGlyphKind = "red" | "green";

const RED_SIGNAL_GLYPH_CROP: SignalGlyphCrop = { x: 17, y: 8, w: 15, h: 35 };
const GREEN_SIGNAL_GLYPH_CROP: SignalGlyphCrop = { x: 14, y: 52, w: 24, h: 28 };
const SIGNAL_RED_ON = "#c32128";
const SIGNAL_RED_OFF = "#35171a";
const SIGNAL_GREEN_ON = "#1c7a3b";
const SIGNAL_GREEN_OFF = "#162a1b";
const UI_FONT_FAMILY = '"Experiment Sans", sans-serif';
const MONEY_FONT_FAMILY = '"Experiment Mono", monospace';
const CIRCLE_RADIUS = 18;
const CIRCLE_COLOR = "#2563eb";

function loadCanvasImage(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img;
}

export class World2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: ExperimentConfig;
  private disposed = false;
  private resizeHandler: () => void;
  private resizeObserver: ResizeObserver | null = null;

  /* Layout constants (recomputed on resize) */
  private w = 0;
  private h = 0;
  private dpr = 1;
  private roadY = 0;
  private roadH = 0;
  private roadLeft = 0;
  private roadRight = 0;
  private lightX = 0;
  private finishLineX = 0;
  private lastAvatarX = -1;
  private smoothAvatarX = -1;
  private readonly redSignalSprite = loadCanvasImage(redSignalBmpUrl);
  private readonly greenSignalSprite = loadCanvasImage(greenSignalBmpUrl);
  private redSignalGlyph: HTMLCanvasElement | null = null;
  private greenSignalGlyph: HTMLCanvasElement | null = null;
  private lastMoneyPulseStep: number | null = null;
  private moneyPulseUntilMs = 0;

  constructor(canvas: HTMLCanvasElement, config: ExperimentConfig) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Cannot get 2d context");
    this.ctx = ctx;
    this.config = config;

    this.resizeHandler = () => this.recalcLayout();
    window.addEventListener("resize", this.resizeHandler);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.recalcLayout());
      const parent = this.canvas.parentElement;
      if (parent) this.resizeObserver.observe(parent);
      this.resizeObserver.observe(this.canvas);
    }
    this.recalcLayout();
    requestAnimationFrame(() => {
      if (this.disposed) return;
      this.recalcLayout();
      requestAnimationFrame(() => {
        if (this.disposed) return;
        this.recalcLayout();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Layout                                                             */
  /* ------------------------------------------------------------------ */

  private recalcLayout(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.w = cssW;
    this.h = cssH;

    const defaultRoadY = this.h * 0.59;
    this.roadH = this.h * 0.104;
    this.roadLeft = this.w * 0.08;
    this.roadRight = this.w * 0.92;
    const manualSceneDownShiftPx = 20;
    this.roadY = defaultRoadY + manualSceneDownShiftPx;

    const roadW = this.roadRight - this.roadLeft;
    this.lightX = this.roadLeft + roadW * 0.4;
    this.finishLineX = this.roadLeft + roadW * 0.85;

    this.syncStageAnchors(parent);
  }

  private syncStageAnchors(parent: HTMLElement): void {
    const roadBottomY = this.roadY + this.roadH / 2;
    const lowerBlankHeight = Math.max(0, this.h - roadBottomY);
    const walkCenterY = roadBottomY + lowerBlankHeight * 0.44;
    parent.style.setProperty("--walk-center-y", `${walkCenterY}px`);
  }

  private syncLayoutToCanvasSize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);

    if (
      cssW <= 0 ||
      cssH <= 0 ||
      cssW !== this.w ||
      cssH !== this.h ||
      nextDpr !== this.dpr
    ) {
      this.recalcLayout();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Main render                                                        */
  /* ------------------------------------------------------------------ */

  render(state: ExperimentState, progress01: number, nowMs: number): void {
    if (this.disposed) return;
    this.syncLayoutToCanvasSize();
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    try {
      this.drawBackground(ctx);
      this.drawRoad(ctx);
      this.drawFinishLine(ctx);
      this.drawCrosswalk(ctx, this.lightX);
      this.drawTrafficLight(ctx, this.lightX, this.getTrafficLightColor(state), "top", nowMs);

      // Circle avatar
      const targetX = this.computeAvatarX(state);
      const maxStepPx = 8;
      if (this.smoothAvatarX < 0) {
        this.smoothAvatarX = targetX;
      } else if (Math.abs(targetX - this.smoothAvatarX) > maxStepPx) {
        this.smoothAvatarX += Math.sign(targetX - this.smoothAvatarX) * maxStepPx;
      } else {
        this.smoothAvatarX = targetX;
      }
      if (state.phase === "idle") this.smoothAvatarX = targetX;

      const avatarX = this.smoothAvatarX;
      this.drawCircle(ctx, avatarX, state.phase, nowMs, avatarX !== this.lastAvatarX);
      this.lastAvatarX = avatarX;

      this.drawPressureVignette(ctx, state.money, this.config.startMoney, nowMs, state.phase);
      this.drawMoneyOverlay(ctx, state.money, this.config.startMoney, nowMs, state.phase);
    } finally {
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Background                                                         */
  /* ------------------------------------------------------------------ */

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, this.roadY - this.roadH);
    skyGrad.addColorStop(0, "#b8dced");
    skyGrad.addColorStop(1, "#ddeef6");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, this.w, this.roadY - this.roadH / 2);

    ctx.fillStyle = "#c8d8c0";
    ctx.fillRect(0, this.roadY + this.roadH / 2, this.w, this.h - (this.roadY + this.roadH / 2));
  }

  /* ------------------------------------------------------------------ */
  /*  Road                                                               */
  /* ------------------------------------------------------------------ */

  private drawRoad(ctx: CanvasRenderingContext2D): void {
    const top = this.roadY - this.roadH / 2;

    ctx.fillStyle = "#b0b0a8";
    ctx.fillRect(0, top - 4, this.w, this.roadH + 8);

    ctx.fillStyle = "#6b6b6b";
    ctx.fillRect(0, top, this.w, this.roadH);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([18, 14]);
    ctx.beginPath();
    ctx.moveTo(0, this.roadY);
    ctx.lineTo(this.w, this.roadY);
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Finish line                                                        */
  /* ------------------------------------------------------------------ */

  private drawFinishLine(ctx: CanvasRenderingContext2D): void {
    const x = this.finishLineX;
    const top = this.roadY - this.roadH / 2;
    const bottom = this.roadY + this.roadH / 2;
    const checkerSize = 6;
    const lineW = 18;

    ctx.save();
    // Draw checkerboard pattern
    for (let row = 0; row * checkerSize < (bottom - top); row++) {
      for (let col = 0; col * checkerSize < lineW; col++) {
        const isWhite = (row + col) % 2 === 0;
        ctx.fillStyle = isWhite ? "#ffffff" : "#1a1a1a";
        ctx.fillRect(
          x - lineW / 2 + col * checkerSize,
          top + row * checkerSize,
          checkerSize,
          checkerSize
        );
      }
    }
    ctx.restore();

    // Label
    ctx.save();
    ctx.font = `700 12px ${UI_FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#333";
    ctx.fillText("终点线", x, bottom + 18);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Crosswalk                                                          */
  /* ------------------------------------------------------------------ */

  private drawCrosswalk(ctx: CanvasRenderingContext2D, x: number): void {
    const top = this.roadY - this.roadH / 2;
    const stripeW = 6;
    const stripeGap = 5;
    const numStripes = Math.floor(this.roadH / (stripeW + stripeGap));
    const contentH = (numStripes - 1) * (stripeW + stripeGap) + stripeW;
    const startY = top + (this.roadH - contentH) / 2 + 1;

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const crossW = 22;
    for (let s = 0; s < numStripes; s++) {
      const sy = startY + s * (stripeW + stripeGap);
      ctx.fillRect(x - crossW / 2, sy, crossW, stripeW);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Traffic light                                                      */
  /* ------------------------------------------------------------------ */

  private drawTrafficLight(
    ctx: CanvasRenderingContext2D,
    x: number,
    color: "red" | "green" | "off",
    side: "top" | "bottom",
    nowMs: number
  ): void {
    const trafficLightScale = 1.52;
    const poleH = this.h * 0.14 * 1.12;
    const poleW = 3 * trafficLightScale;
    const housingW = 20 * trafficLightScale;
    const housingH = 42 * trafficLightScale;
    const bulbR = 7 * trafficLightScale;
    const bulbSpacing = 18 * trafficLightScale;

    const roadEdge =
      side === "top"
        ? this.roadY - this.roadH / 2
        : this.roadY + this.roadH / 2;

    const dir = side === "top" ? -1 : 1;
    const poleTop = roadEdge + dir * poleH;
    const poleBottom = roadEdge;

    ctx.fillStyle = "#444";
    ctx.fillRect(x - poleW / 2, Math.min(poleTop, poleBottom), poleW, poleH);

    const hx = x - housingW / 2;
    const hy = side === "top" ? poleTop - housingH : poleTop;

    ctx.fillStyle = "#2a2a2a";
    this.roundRect(ctx, hx, hy, housingW, housingH, 5 * trafficLightScale);
    ctx.fill();

    const cx = x;
    const redCY = hy + housingH / 2 - bulbSpacing / 2;
    const greenCY = hy + housingH / 2 + bulbSpacing / 2;

    const pulse = 0.7 + 0.3 * Math.abs(Math.sin(nowMs * 0.005));

    this.drawBulb(ctx, cx, redCY, bulbR, color === "red", SIGNAL_RED_ON, SIGNAL_RED_OFF, pulse);
    this.drawBulb(ctx, cx, greenCY, bulbR, color === "green", SIGNAL_GREEN_ON, SIGNAL_GREEN_OFF, pulse);

    if (color === "red") {
      const glyph = this.getSignalGlyph("red");
      if (glyph) this.drawSignalGlyph(ctx, glyph, cx, redCY, bulbR, pulse);
    } else if (color === "green") {
      const glyph = this.getSignalGlyph("green");
      if (glyph) this.drawSignalGlyph(ctx, glyph, cx, greenCY, bulbR, pulse);
    }
  }

  private getTrafficLightColor(state: ExperimentState): "red" | "green" | "off" {
    if (state.phase === "idle") return "red";
    if (state.phase === "finished") {
      const outcome = state.passedOutcome[1];
      if (outcome === "green") return "green";
      return "red";
    }
    if (state.phase === "waiting_red") {
      return state.currentLightColor;
    }
    // moving or moving_to_finish: show the resolved color
    if (state.phase === "moving_to_finish") {
      const outcome = state.passedOutcome[1];
      if (outcome === "green") return "green";
      return "red";
    }
    return "red";
  }

  private drawBulb(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    active: boolean,
    onColor: string,
    offColor: string,
    pulse: number
  ): void {
    ctx.save();
    if (active) {
      ctx.shadowColor = onColor;
      ctx.shadowBlur = 18 * pulse;
      ctx.fillStyle = onColor;
      ctx.globalAlpha = 0.96;
    } else {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.fillStyle = offColor;
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private getSignalGlyph(kind: "red" | "green"): HTMLCanvasElement | null {
    if (kind === "red") {
      if (this.redSignalGlyph) return this.redSignalGlyph;
      if (!this.isRenderableImage(this.redSignalSprite)) return null;
      this.redSignalGlyph = this.prepareSignalGlyph(this.redSignalSprite, RED_SIGNAL_GLYPH_CROP, "red");
      return this.redSignalGlyph;
    }

    if (this.greenSignalGlyph) return this.greenSignalGlyph;
    if (!this.isRenderableImage(this.greenSignalSprite)) return null;
    this.greenSignalGlyph = this.prepareSignalGlyph(this.greenSignalSprite, GREEN_SIGNAL_GLYPH_CROP, "green");
    return this.greenSignalGlyph;
  }

  private prepareSignalGlyph(
    sprite: HTMLImageElement,
    crop: SignalGlyphCrop,
    kind: SignalGlyphKind
  ): HTMLCanvasElement | null {
    const canvas = document.createElement("canvas");
    canvas.width = crop.w;
    canvas.height = crop.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(sprite, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    const imgData = ctx.getImageData(0, 0, crop.w, crop.h);
    const data = imgData.data;
    const keepMask = new Uint8Array(crop.w * crop.h);
    let seedCount = 0;

    for (let y = 0; y < crop.h; y += 1) {
      for (let x = 0; x < crop.w; x += 1) {
        const idx = (y * crop.w + x) * 4;
        const a = data[idx + 3];
        if (a < 10) continue;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (!this.isSignalForegroundPixel(r, g, b, kind)) continue;
        seedCount += 1;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= crop.h || nx < 0 || nx >= crop.w) continue;
            keepMask[ny * crop.w + nx] = 1;
          }
        }
      }
    }

    if (seedCount === 0) return this.inflateSignalGlyph(canvas);

    for (let i = 0; i < data.length; i += 4) {
      if (!keepMask[i / 4]) {
        data[i + 3] = 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return this.inflateSignalGlyph(canvas);
  }

  private isSignalForegroundPixel(r: number, g: number, b: number, kind: SignalGlyphKind): boolean {
    if (kind === "red") return r > 110 && r > g + 35 && r > b + 35;
    return g > 70 && g > r + 20 && g > b + 15;
  }

  private inflateSignalGlyph(source: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return source;

    const aspect = source.width / Math.max(source.height, 1);
    const scaleX = aspect < 0.6 ? 1.16 : 1.1;
    const scaleY = aspect < 0.6 ? 1.06 : 1.04;

    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(source, -source.width / 2, -source.height / 2, source.width, source.height);
    ctx.restore();
    return canvas;
  }

  private drawSignalGlyph(
    ctx: CanvasRenderingContext2D,
    glyph: HTMLCanvasElement,
    cx: number,
    cy: number,
    bulbR: number,
    pulse: number
  ): void {
    const scale = Math.min((bulbR * 2.04) / glyph.width, (bulbR * 2.16) / glyph.height);
    const drawW = glyph.width * scale;
    const drawH = glyph.height * scale;

    ctx.save();
    ctx.globalAlpha = 0.9 + pulse * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, bulbR, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(glyph, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    ctx.restore();
  }

  private isRenderableImage(img: HTMLImageElement): boolean {
    return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Circle avatar                                                      */
  /* ------------------------------------------------------------------ */

  private computeAvatarX(state: ExperimentState): number {
    const stopOffset = CIRCLE_RADIUS + 10;

    if (state.phase === "idle") return this.roadLeft + CIRCLE_RADIUS;

    if (state.phase === "finished") return this.finishLineX;

    const seg = this.config.segmentDurationSec;

    if (state.phase === "moving") {
      const fromX = this.roadLeft + CIRCLE_RADIUS;
      const toX = this.lightX - stopOffset;
      const fraction = Math.min(1, state.segmentProgressSec / seg);
      return fromX + (toX - fromX) * fraction;
    }

    if (state.phase === "waiting_red") {
      return this.lightX - stopOffset;
    }

    if (state.phase === "moving_to_finish") {
      const fromX = this.lightX - stopOffset;
      const toX = this.finishLineX;
      const fraction = Math.min(1, state.segmentProgressSec / seg);
      return fromX + (toX - fromX) * fraction;
    }

    return this.roadLeft + CIRCLE_RADIUS;
  }

  private drawCircle(
    ctx: CanvasRenderingContext2D,
    x: number,
    phase: Phase,
    nowMs: number,
    isMoving: boolean
  ): void {
    const footY = this.roadY + this.roadH / 2 + 8;
    const circleY = footY - CIRCLE_RADIUS - 4;
    const isAnimating = phase === "moving" || phase === "moving_to_finish";

    // Shadow
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.beginPath();
    ctx.ellipse(
      x,
      footY + 3,
      CIRCLE_RADIUS * (isAnimating ? 1.05 : 0.96),
      CIRCLE_RADIUS * 0.22,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.restore();

    // Bounce animation when moving
    let bounceY = 0;
    if (isAnimating && isMoving) {
      bounceY = Math.abs(Math.sin(nowMs * 0.008)) * 4;
    }

    // Circle body
    ctx.save();
    ctx.shadowColor = "rgba(37, 99, 235, 0.3)";
    ctx.shadowBlur = isAnimating ? 12 : 6;
    ctx.fillStyle = CIRCLE_COLOR;
    ctx.beginPath();
    ctx.arc(x, circleY - bounceY, CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Highlight
    ctx.shadowBlur = 0;
    const highlightGrad = ctx.createRadialGradient(
      x - CIRCLE_RADIUS * 0.3,
      circleY - bounceY - CIRCLE_RADIUS * 0.3,
      CIRCLE_RADIUS * 0.1,
      x,
      circleY - bounceY,
      CIRCLE_RADIUS
    );
    highlightGrad.addColorStop(0, "rgba(255,255,255,0.35)");
    highlightGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = highlightGrad;
    ctx.beginPath();
    ctx.arc(x, circleY - bounceY, CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Money overlay (prominent)                                          */
  /* ------------------------------------------------------------------ */

  private drawPressureVignette(
    ctx: CanvasRenderingContext2D,
    money: number,
    startMoney: number,
    nowMs: number,
    phase: Phase
  ): void {
    if (phase === "idle") return;

    const { stage, pressure } = this.getMoneyStress(money, startMoney);
    if (pressure <= 0) return;

    const heartbeat = Math.pow((Math.sin(nowMs * (0.0024 + pressure * 0.003)) + 1) / 2, 2.2);
    const innerRadius = Math.max(this.w, this.h) * (0.56 - pressure * 0.1);
    const outerRadius = Math.max(this.w, this.h) * 0.95;
    const grad = ctx.createRadialGradient(
      this.w / 2,
      this.h / 2,
      innerRadius,
      this.w / 2,
      this.h / 2,
      outerRadius
    );

    grad.addColorStop(0, "rgba(0,0,0,0)");
    if (stage === 0) {
      grad.addColorStop(0.62, `rgba(94, 10, 12, ${0.02 + pressure * 0.03})`);
      grad.addColorStop(1, `rgba(38, 0, 0, ${0.05 + pressure * 0.06 + heartbeat * pressure * 0.02})`);
    } else if (stage === 1) {
      grad.addColorStop(0.56, `rgba(118, 28, 16, ${0.04 + pressure * 0.05})`);
      grad.addColorStop(0.8, `rgba(78, 20, 12, ${0.08 + pressure * 0.08 + heartbeat * pressure * 0.03})`);
      grad.addColorStop(1, `rgba(42, 8, 8, ${0.12 + pressure * 0.1 + heartbeat * pressure * 0.05})`);
    } else {
      grad.addColorStop(0.52, `rgba(94, 10, 12, ${0.05 + pressure * 0.08})`);
      grad.addColorStop(0.74, `rgba(70, 0, 0, ${0.10 + pressure * 0.1 + heartbeat * pressure * 0.05})`);
      grad.addColorStop(1, `rgba(38, 0, 0, ${0.16 + pressure * 0.14 + heartbeat * pressure * 0.08})`);
    }

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  private drawMoneyOverlay(
    ctx: CanvasRenderingContext2D,
    money: number,
    startMoney: number,
    nowMs: number,
    phase: Phase
  ): void {
    if (phase === "idle") {
      this.lastMoneyPulseStep = null;
      this.moneyPulseUntilMs = 0;
      return;
    }

    const { stage, pressure } = this.getMoneyStress(money, startMoney);
    const compactPortrait = this.isCompactPortraitLayout();
    const moneyStep = Math.floor(money * 10);
    if (this.lastMoneyPulseStep !== null && moneyStep < this.lastMoneyPulseStep) {
      this.moneyPulseUntilMs = nowMs + 520;
    }
    this.lastMoneyPulseStep = moneyStep;

    const isPulsing = nowMs < this.moneyPulseUntilMs;
    const pulseT = isPulsing ? Math.max(0, (this.moneyPulseUntilMs - nowMs) / 520) : 0;
    const pulseKick = isPulsing ? Math.pow(pulseT, 0.6) * 0.28 : 0;
    const flashStrength = isPulsing ? Math.pow(pulseT, 1.6) : 0;

    const scaleBase = compactPortrait ? 0.96 : 1;
    const cardScale = scaleBase * (1 + pulseKick * 0.06);
    const cardJoltY = pulseKick * -4;

    const ribbonW = compactPortrait ? 240 : 296;
    const ribbonH = compactPortrait ? 82 : 98;

    const cx = this.w / 2;
    const lightsTopY = this.roadY - this.roadH / 2 - (compactPortrait ? 100 : 130);
    const topBlankCenterY = lightsTopY * 0.5;
    const overlayMargin = compactPortrait ? 16 : 20;
    const overlayCenterY = Math.min(
      lightsTopY - ribbonH / 2 - overlayMargin,
      Math.max(ribbonH / 2 + overlayMargin, topBlankCenterY)
    );

    ctx.translate(cx, overlayCenterY - cardJoltY);
    ctx.scale(cardScale, cardScale);

    const pillX = -ribbonW / 2;
    const pillY = -ribbonH / 2;
    const cornerRadius = compactPortrait ? 16 : 18;

    let panelTop: string;
    let panelMid: string;
    let panelBottom: string;
    let borderColor: string;
    let labelColor: string;
    let mainTextColor: string;
    let subPrefixColor: string;
    let subValueColor: string;
    let labelText: string;

    if (stage === 0) {
      panelTop = "#1e293b";
      panelMid = "#172033";
      panelBottom = "#0f172a";
      borderColor = "rgba(148,163,184,0.22)";
      labelColor = "#94a3b8";
      mainTextColor = "#e2e8f0";
      subPrefixColor = "#64748b";
      subValueColor = "#94a3b8";
      labelText = "剩余报酬";
    } else if (stage === 1) {
      panelTop = "#2a1518";
      panelMid = "#221015";
      panelBottom = "#1a0a10";
      borderColor = "rgba(248,113,113,0.3)";
      labelColor = "#fca5a5";
      mainTextColor = "#fecaca";
      subPrefixColor = "#f87171";
      subValueColor = "#fca5a5";
      labelText = "剩余报酬";
    } else {
      const urgency = Math.min(1, pressure * 1.1);
      const r1 = Math.round(42 + urgency * 16);
      const g1 = Math.round(8 + urgency * 4);
      const b1 = Math.round(12 + urgency * 4);
      panelTop = `rgb(${r1},${g1},${b1})`;
      panelMid = `rgb(${Math.round(r1 * 0.82)},${Math.round(g1 * 0.7)},${Math.round(b1 * 0.7)})`;
      panelBottom = `rgb(${Math.round(r1 * 0.6)},${Math.round(g1 * 0.5)},${Math.round(b1 * 0.5)})`;
      borderColor = `rgba(248,113,113,${0.36 + urgency * 0.14})`;
      labelColor = "#fca5a5";
      mainTextColor = "#fee2e2";
      subPrefixColor = "#f87171";
      subValueColor = "#fca5a5";
      labelText = "剩余报酬";
    }

    const panelGrad = ctx.createLinearGradient(0, pillY, 0, pillY + ribbonH);
    panelGrad.addColorStop(0, panelTop);
    panelGrad.addColorStop(0.52, panelMid);
    panelGrad.addColorStop(1, panelBottom);

    ctx.shadowColor = `rgba(18, 0, 0, ${0.34 + pulseKick * 0.1})`;
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 9;
    ctx.fillStyle = panelGrad;
    this.roundRect(ctx, pillX, pillY, ribbonW, ribbonH, cornerRadius);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.save();
    this.roundRect(ctx, pillX, pillY, ribbonW, ribbonH, cornerRadius);
    ctx.clip();
    const topShade = ctx.createLinearGradient(0, pillY, 0, pillY + ribbonH * 0.48);
    topShade.addColorStop(0, `rgba(0, 0, 0, ${0.38 + pulseKick * 0.08})`);
    topShade.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = topShade;
    ctx.fillRect(pillX, pillY, ribbonW, ribbonH * 0.48);
    const innerPress = ctx.createLinearGradient(0, pillY + ribbonH * 0.4, 0, pillY + ribbonH);
    innerPress.addColorStop(0, "rgba(0, 0, 0, 0)");
    innerPress.addColorStop(1, `rgba(0, 0, 0, ${0.26 + pulseKick * 0.1})`);
    ctx.fillStyle = innerPress;
    ctx.fillRect(pillX, pillY + ribbonH * 0.4, ribbonW, ribbonH * 0.6);
    ctx.restore();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = compactPortrait ? 1.8 : 2;
    this.roundRect(ctx, pillX, pillY, ribbonW, ribbonH, cornerRadius);
    ctx.stroke();

    ctx.strokeStyle = `rgba(255, 210, 210, ${0.08 + flashStrength * 0.16})`;
    ctx.lineWidth = 0.9;
    this.roundRect(ctx, pillX + 2, pillY + 2, ribbonW - 4, ribbonH - 4, Math.max(6, cornerRadius - 2));
    ctx.stroke();

    const indicatorSize = compactPortrait ? 11 : 13;
    const labelGap = compactPortrait ? 8 : 10;
    const mainFontSize = compactPortrait ? 26 : 31;
    const subFontSize = compactPortrait ? 11 : 12.5;
    const subPrefixText = "每秒扣除";
    const subPrefixWidth = ctx.measureText(subPrefixText).width;
    const subValueText = `￥${this.config.moneyLossPerSec.toFixed(2)}`;
    const mainText = `￥${money.toFixed(2)}`;

    const leftInset = pillX + (compactPortrait ? 20 : 26);
    const rightInset = pillX + ribbonW - (compactPortrait ? 20 : 26);
    const topRowY = pillY + (compactPortrait ? 28 : 37);
    const bottomRowY = pillY + ribbonH - (compactPortrait ? 17 : 20);
    const indicatorX = leftInset + indicatorSize / 2;
    const labelX = indicatorX + indicatorSize / 2 + labelGap;
    const subLeft = -subWidth / 2;

    ctx.fillStyle = pulseKick > 0 ? "#ff7676" : SIGNAL_RED_ON;
    ctx.beginPath();
    ctx.arc(indicatorX, topRowY, indicatorSize / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 226, 226, ${0.32 + flashStrength * 0.3})`;
    ctx.beginPath();
    ctx.arc(indicatorX - indicatorSize * 0.14, topRowY - indicatorSize * 0.14, indicatorSize * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = labelColor;
    ctx.font = `700 ${compactPortrait ? 13 : 15}px ${UI_FONT_FAMILY}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, labelX, topRowY);

    ctx.font = `900 ${mainFontSize}px ${MONEY_FONT_FAMILY}`;
    ctx.textAlign = "right";
    ctx.lineWidth = compactPortrait ? 1.4 : 1.6;
    ctx.strokeStyle = "rgba(28, 0, 0, 0.65)";
    ctx.strokeText(mainText, rightInset, topRowY);
    ctx.fillStyle = mainTextColor;
    ctx.fillText(mainText, rightInset, topRowY);

    ctx.font = `800 ${subFontSize}px ${UI_FONT_FAMILY}`;
    ctx.textAlign = "left";
    ctx.fillStyle = subPrefixColor;
    ctx.fillText(subPrefixText, subLeft, bottomRowY);
    ctx.font = `900 ${subFontSize}px ${MONEY_FONT_FAMILY}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(28, 0, 0, 0.6)";
    ctx.strokeText(subValueText, subLeft + subPrefixWidth + (compactPortrait ? 10 : 12), bottomRowY);
    ctx.fillStyle = subValueColor;
    ctx.fillText(subValueText, subLeft + subPrefixWidth + (compactPortrait ? 10 : 12), bottomRowY);

    ctx.restore();
  }

  private getMoneyStress(
    _money: number,
    _startMoney: number
  ): { stage: 0 | 1 | 2; pressure: number } {
    return { stage: 2, pressure: 0.92 };
  }

  private isCompactPortraitLayout(): boolean {
    return this.h > this.w && this.w <= 560;
  }

  /* ------------------------------------------------------------------ */
  /*  Utilities                                                          */
  /* ------------------------------------------------------------------ */

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    if (r <= 0) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.closePath();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /* ------------------------------------------------------------------ */
  /*  Cleanup                                                            */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.resizeHandler);
    this.resizeObserver?.disconnect();
  }
}
