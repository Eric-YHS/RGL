import type { ExperimentConfig, ExperimentState } from "../experiment/types";
import { formatMoney } from "../experiment/utils";

const UI_FONT_FAMILY = '"Experiment Sans", sans-serif';
const MONEY_FONT_FAMILY = '"Experiment Mono", monospace';
const CIRCLE_RADIUS = 16;
const CIRCLE_COLOR = "#2f6fed";
const RED_ON = "#ff0f1f";
const RED_OFF = "#8a4545";
const YELLOW_OFF = "#8f7a3a";
const GREEN_ON = "#00f050";
const GREEN_OFF = "#3d6e3d";
const STRONG_LINE_COLOR = "#111111";
const SECONDARY_LINE_COLOR = "#555555";
const GUIDE_LINE_COLOR = "#8c8c8c";
const TRAFFIC_POLE_COLOR = "#8a8a8a";
const TRAFFIC_HOUSING_COLOR = "#b6b6b6";
const DESKTOP_BG = "#e7e7e7";
const WINDOW_BLUE = "#17689a";
const WINDOW_BLUE_DARK = "#0f4e78";
const WINDOW_BORDER = "#7d7d7d";
const WINDOW_CHROME = "#f3f3f3";

export class World2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: ExperimentConfig;
  private disposed = false;
  private resizeHandler: () => void;
  private resizeObserver: ResizeObserver | null = null;

  private w = 0;
  private h = 0;
  private dpr = 1;
  private layoutScale = 1;
  private panelX = 0;
  private panelY = 0;
  private panelW = 0;
  private panelH = 0;
  private trackY = 0;
  private startX = 0;
  private lightX = 0;
  private finishLineX = 0;
  private smoothAvatarX = -1;

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
    requestAnimationFrame(() => this.recalcLayout());
  }

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

    this.layoutScale = Math.min(1, Math.max(0.55, Math.min(this.w / 1200, this.h / 760)));
    const sideInset = Math.max(24, 75 * this.layoutScale);
    const controlsReserve = Math.max(104, 148 * this.layoutScale);
    const topMargin = Math.max(24, 42 * this.layoutScale);

    this.panelW = Math.max(
      1,
      Math.min(Math.max(780 * this.layoutScale, this.w * 0.66), this.w - sideInset * 2)
    );
    this.panelH = Math.max(
      1,
      Math.min(Math.max(370 * this.layoutScale, this.h * 0.57), this.h - controlsReserve - topMargin)
    );
    this.panelX = Math.round((this.w - this.panelW) / 2);
    this.panelY = Math.round(
      Math.max(topMargin, Math.min(this.h * 0.07, this.h - this.panelH - controlsReserve))
    );

    this.trackY = this.panelY + 28 + (this.panelH - 28) * 0.79;
    this.startX = this.panelX + this.panelW * 0.1;
    this.lightX = this.panelX + this.panelW * 0.48;
    this.finishLineX = this.panelX + this.panelW * 0.84;

    this.syncStageAnchors(parent);
  }

  private syncStageAnchors(parent: HTMLElement): void {
    const controlsY = Math.min(
      this.h - Math.max(48, 72 * this.layoutScale),
      this.panelY + this.panelH + Math.max(50, 76 * this.layoutScale)
    );
    parent.style.setProperty("--walk-center-y", `${controlsY}px`);
  }

  private syncLayoutToCanvasSize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);

    if (cssW <= 0 || cssH <= 0 || cssW !== this.w || cssH !== this.h || nextDpr !== this.dpr) {
      this.recalcLayout();
    }
  }

  render(state: ExperimentState, _progress01: number, nowMs: number): void {
    if (this.disposed) return;
    this.syncLayoutToCanvasSize();

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    try {
      this.clear(ctx);
      this.drawTaskPanel(ctx);
      this.drawEndowment(ctx, state.money);
      this.drawTrafficLight(ctx, state, nowMs);
      this.drawFinishLine(ctx);
      this.drawAvatar(ctx, state, nowMs);
    } finally {
      ctx.restore();
    }
  }

  private clear(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = DESKTOP_BG;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawTaskPanel(ctx: CanvasRenderingContext2D): void {
    const titleH = 27;
    const contentY = this.panelY + titleH;
    const contentH = this.panelH - titleH;

    ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
    ctx.fillRect(this.panelX + 2, this.panelY + 2, this.panelW, this.panelH);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(this.panelX, this.panelY, this.panelW, this.panelH);
    ctx.strokeStyle = WINDOW_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panelX, this.panelY, this.panelW, this.panelH);

    ctx.fillStyle = WINDOW_BLUE;
    ctx.fillRect(this.panelX + 1, this.panelY + 1, this.panelW - 2, titleH - 1);
    ctx.strokeStyle = WINDOW_BLUE_DARK;
    ctx.beginPath();
    ctx.moveTo(this.panelX + 1, this.panelY + titleH);
    ctx.lineTo(this.panelX + this.panelW - 1, this.panelY + titleH);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `700 14px ${UI_FONT_FAMILY}`;
    ctx.fillText("决策任务", this.panelX + 10, this.panelY + titleH / 2 + 1);

    ctx.fillStyle = WINDOW_CHROME;
    ctx.fillRect(this.panelX + 1, contentY + 1, this.panelW - 2, 35);
    ctx.strokeStyle = "#c7c7c7";
    ctx.beginPath();
    ctx.moveTo(this.panelX + 1, contentY + 36);
    ctx.lineTo(this.panelX + this.panelW - 1, contentY + 36);
    ctx.stroke();

    ctx.strokeStyle = "#d5d5d5";
    ctx.beginPath();
    ctx.moveTo(this.panelX + 1, contentY + contentH - 28);
    ctx.lineTo(this.panelX + this.panelW - 1, contentY + contentH - 28);
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = GUIDE_LINE_COLOR;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.moveTo(this.startX, this.trackY);
    ctx.lineTo(this.finishLineX, this.trackY);
    ctx.stroke();
    ctx.restore();
  }

  private drawEndowment(ctx: CanvasRenderingContext2D, money: number): void {
    const label = "剩余报酬：";
    const moneyText = formatMoney(money);
    const labelH = 24;
    ctx.font = `400 15px ${UI_FONT_FAMILY}`;
    const labelTextW = ctx.measureText(label).width;
    ctx.font = `700 15px ${MONEY_FONT_FAMILY}`;
    const moneyTextW = ctx.measureText(moneyText).width;
    const labelW = Math.max(238, labelTextW + moneyTextW + 38);
    const x = this.panelX + this.panelW / 2 - labelW / 2;
    const y = this.panelY + 32;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, labelW, labelH);
    ctx.strokeStyle = WINDOW_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, labelW, labelH);

    ctx.fillStyle = "#202020";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `400 15px ${UI_FONT_FAMILY}`;
    const textX = x + (labelW - labelTextW - moneyTextW) / 2;
    ctx.fillText(label, textX, y + labelH / 2 + 1);
    ctx.font = `700 15px ${MONEY_FONT_FAMILY}`;
    ctx.fillText(moneyText, textX + labelTextW, y + labelH / 2 + 1);
  }

  private drawTrafficLight(ctx: CanvasRenderingContext2D, state: ExperimentState, nowMs: number): void {
    const lightTop = this.panelY + Math.max(84, this.panelH * 0.16);
    const poleTop = lightTop + 86;
    const poleBottom = this.trackY + 44;
    const housingW = 22;
    const housingH = 78;
    const housingX = this.lightX - housingW / 2;
    const housingY = lightTop + 10;
    const color = this.getTrafficLightColor(state);

    ctx.fillStyle = TRAFFIC_POLE_COLOR;
    ctx.fillRect(this.lightX - 2, poleTop, 4, poleBottom - poleTop);

    ctx.fillStyle = TRAFFIC_HOUSING_COLOR;
    ctx.fillRect(housingX, housingY, housingW, housingH);
    ctx.strokeStyle = SECONDARY_LINE_COLOR;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(housingX, housingY, housingW, housingH);

    this.drawLightBulb(ctx, this.lightX, housingY + 12, 9, color === "red", RED_ON, RED_OFF, nowMs);
    this.drawLightBulb(ctx, this.lightX, housingY + 34, 9, false, YELLOW_OFF, YELLOW_OFF, nowMs);
    this.drawLightBulb(ctx, this.lightX, housingY + 56, 9, color === "green", GREEN_ON, GREEN_OFF, nowMs);

    this.drawCountdown(ctx, state, this.lightX, housingY + 12);
  }

  private drawLightBulb(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    active: boolean,
    activeColor: string,
    inactiveColor: string,
    nowMs: number
  ): void {
    ctx.save();
    if (active) {
      const pulse = Math.abs(Math.sin(nowMs * 0.004));
      const glowRadius = 16 + pulse * 12;

      // Outer halo for a neon/fluorescent look.
      ctx.fillStyle = activeColor;
      ctx.globalAlpha = 0.18 + pulse * 0.1;
      ctx.beginPath();
      ctx.arc(x, y, r + glowRadius * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Strong colored glow around the bulb.
      ctx.shadowColor = activeColor;
      ctx.shadowBlur = glowRadius;
      ctx.fillStyle = activeColor;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = inactiveColor;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Subtle rim so both on and off bulbs keep their shape against the housing.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = active ? "rgba(255, 255, 255, 0.35)" : "rgba(0, 0, 0, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawCountdown(ctx: CanvasRenderingContext2D, state: ExperimentState, x: number, y: number): void {
    const remaining = this.getRedCountdownSec(state);
    const passedOnGreen = state.passedOutcome[state.lightIndex] === "green";
    const isGreen = state.currentLightColor === "green" || passedOnGreen || remaining <= 0;
    if (isGreen) return;

    const text = String(remaining);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 9px ${MONEY_FONT_FAMILY}`;
    ctx.strokeStyle = "rgba(120,0,0,0.72)";
    ctx.lineWidth = 1.6;
    ctx.strokeText(text, x, y + 0.5);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x, y + 0.5);
  }

  private getRedCountdownSec(state: ExperimentState): number {
    if (
      (state.phase === "waiting_red" || state.phase === "moving_to_finish" || state.phase === "finished") &&
      state.greenAtSec !== null
    ) {
      return Math.max(0, Math.ceil(state.greenAtSec - state.elapsedSec));
    }
    return this.config.redWaitSec;
  }

  private drawFinishLine(ctx: CanvasRenderingContext2D): void {
    const top = this.panelY + Math.max(70, this.panelH * 0.14);
    const bottom = this.panelY + this.panelH - 36;

    ctx.strokeStyle = STRONG_LINE_COLOR;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(this.finishLineX, top);
    ctx.lineTo(this.finishLineX, bottom);
    ctx.stroke();
  }

  private drawAvatar(ctx: CanvasRenderingContext2D, state: ExperimentState, nowMs: number): void {
    const targetX = this.computeAvatarX(state);
    if (this.smoothAvatarX < 0 || state.phase === "idle") {
      this.smoothAvatarX = targetX;
    } else {
      const maxStepPx = 7;
      const dx = targetX - this.smoothAvatarX;
      this.smoothAvatarX += Math.abs(dx) > maxStepPx ? Math.sign(dx) * maxStepPx : dx;
    }

    const isMoving = state.phase === "moving" || state.phase === "moving_to_finish";
    const bounce = isMoving ? Math.abs(Math.sin(nowMs * 0.01)) * 2 : 0;
    const y = this.trackY - bounce;

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.beginPath();
    ctx.ellipse(this.smoothAvatarX, this.trackY + CIRCLE_RADIUS + 6, CIRCLE_RADIUS * 0.85, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = "rgba(47,111,237,0.32)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = CIRCLE_COLOR;
    ctx.beginPath();
    ctx.arc(this.smoothAvatarX, y, CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private computeAvatarX(state: ExperimentState): number {
    const stopOffset = CIRCLE_RADIUS + 12;
    if (state.phase === "idle") return this.startX;
    if (state.phase === "finished") return this.finishLineX + CIRCLE_RADIUS + 2;

    const seg = this.config.segmentDurationSec;
    if (state.phase === "moving") {
      const toX = this.lightX - stopOffset;
      const fraction = Math.min(1, state.segmentProgressSec / seg);
      return this.startX + (toX - this.startX) * fraction;
    }
    if (state.phase === "waiting_red") return this.lightX - stopOffset;
    if (state.phase === "moving_to_finish") {
      const fromX = this.lightX - stopOffset;
      const toX = this.finishLineX + CIRCLE_RADIUS + 2;
      const fraction = Math.min(1, state.segmentProgressSec / seg);
      return fromX + (toX - fromX) * fraction;
    }
    return this.startX;
  }

  private getTrafficLightColor(state: ExperimentState): "red" | "green" {
    if (state.phase === "waiting_red") return state.currentLightColor;
    if (state.phase === "moving_to_finish" || state.phase === "finished") {
      return state.passedOutcome[state.lightIndex] === "green" || this.getRedCountdownSec(state) <= 0
        ? "green"
        : "red";
    }
    return "red";
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.resizeHandler);
    this.resizeObserver?.disconnect();
  }
}
