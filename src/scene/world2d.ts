import type { ExperimentConfig, ExperimentState } from "../experiment/types";

const UI_FONT_FAMILY = '"Experiment Sans", sans-serif';
const MONEY_FONT_FAMILY = '"Experiment Mono", monospace';
const CIRCLE_RADIUS = 16;
const CIRCLE_COLOR = "#2f6fed";
const RED_ON = "#f20f16";
const RED_OFF = "#e9b7b7";
const YELLOW_OFF = "#dcc36d";
const GREEN_ON = "#37a447";
const GREEN_OFF = "#b9d4b7";

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

    this.panelW = Math.min(Math.max(760, this.w * 0.64), this.w - 160);
    this.panelH = Math.min(Math.max(360, this.h * 0.56), this.h - 260);
    this.panelX = (this.w - this.panelW) / 2;
    this.panelY = Math.max(48, Math.min(this.h * 0.08, this.h - this.panelH - 154));

    this.trackY = this.panelY + this.panelH * 0.8;
    this.startX = this.panelX + this.panelW * 0.1;
    this.lightX = this.panelX + this.panelW * 0.48;
    this.finishLineX = this.panelX + this.panelW * 0.84;

    this.syncStageAnchors(parent);
  }

  private syncStageAnchors(parent: HTMLElement): void {
    const controlsY = Math.min(this.h - 72, this.panelY + this.panelH + 76);
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
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawTaskPanel(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(this.panelX, this.panelY, this.panelW, this.panelH);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2.4;
    ctx.strokeRect(this.panelX, this.panelY, this.panelW, this.panelH);

    ctx.save();
    ctx.strokeStyle = "#bdbdbd";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.moveTo(this.startX, this.trackY);
    ctx.lineTo(this.finishLineX, this.trackY);
    ctx.stroke();
    ctx.restore();
  }

  private drawEndowment(ctx: CanvasRenderingContext2D, money: number): void {
    const label = "剩余报酬：";
    const moneyText = `￥${money.toFixed(2)}`;
    const labelH = 28;
    ctx.font = `400 15px ${UI_FONT_FAMILY}`;
    const labelTextW = ctx.measureText(label).width;
    ctx.font = `700 15px ${MONEY_FONT_FAMILY}`;
    const moneyTextW = ctx.measureText(moneyText).width;
    const labelW = Math.max(252, labelTextW + moneyTextW + 42);
    const x = this.panelX + this.panelW / 2 - labelW / 2;
    const y = this.panelY + 10;

    ctx.fillStyle = "#ffffff";
    this.roundRect(ctx, x, y, labelW, labelH, 8);
    ctx.fill();
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1.8;
    this.roundRect(ctx, x, y, labelW, labelH, 8);
    ctx.stroke();

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
    const lightTop = this.panelY + Math.max(64, this.panelH * 0.12);
    const poleTop = lightTop + 86;
    const poleBottom = this.trackY + 44;
    const housingW = 22;
    const housingH = 78;
    const housingX = this.lightX - housingW / 2;
    const housingY = lightTop + 10;
    const color = this.getTrafficLightColor(state);

    ctx.fillStyle = "#d4d4d4";
    ctx.fillRect(this.lightX - 1.5, poleTop, 3, poleBottom - poleTop);

    ctx.fillStyle = "#cfcfcf";
    ctx.fillRect(housingX, housingY, housingW, housingH);

    this.drawLightBulb(ctx, this.lightX, housingY + 12, 9, color === "red", RED_ON, RED_OFF, nowMs);
    this.drawLightBulb(ctx, this.lightX, housingY + 34, 9, false, YELLOW_OFF, YELLOW_OFF, nowMs);
    this.drawLightBulb(ctx, this.lightX, housingY + 56, 9, color === "green", GREEN_ON, GREEN_OFF, nowMs);

    this.drawCountdown(ctx, state, this.lightX + 42, housingY + 7);
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
      ctx.shadowColor = activeColor;
      ctx.shadowBlur = 6 + Math.abs(Math.sin(nowMs * 0.004)) * 4;
      ctx.fillStyle = activeColor;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = inactiveColor;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawCountdown(ctx: CanvasRenderingContext2D, state: ExperimentState, x: number, y: number): void {
    const remaining = this.getRedCountdownSec(state);
    const passedOnGreen = state.passedOutcome[state.lightIndex] === "green";
    const isGreen = state.currentLightColor === "green" || passedOnGreen || remaining <= 0;
    const text = isGreen ? "0" : String(remaining);

    ctx.fillStyle = "#ffffff";
    this.roundRect(ctx, x - 23, y, 46, 22, 4);
    ctx.fill();
    ctx.strokeStyle = isGreen ? GREEN_ON : RED_ON;
    ctx.lineWidth = 1.4;
    this.roundRect(ctx, x - 23, y, 46, 22, 4);
    ctx.stroke();

    ctx.fillStyle = isGreen ? GREEN_ON : RED_ON;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 13px ${MONEY_FONT_FAMILY}`;
    ctx.fillText(text, x, y + 11);
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

    ctx.strokeStyle = "#111111";
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

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
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

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.resizeHandler);
    this.resizeObserver?.disconnect();
  }
}
