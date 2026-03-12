import type { ExperimentConfig, ExperimentState, Phase } from "../experiment/types";

export class World2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: ExperimentConfig;
  private disposed = false;
  private resizeHandler: () => void;

  /* Layout constants (recomputed on resize) */
  private w = 0;
  private h = 0;
  private dpr = 1;
  private roadY = 0;
  private roadH = 0;
  private roadLeft = 0;
  private roadRight = 0;
  private lightXs: number[] = [];
  private figH = 0;

  constructor(canvas: HTMLCanvasElement, config: ExperimentConfig) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Cannot get 2d context");
    this.ctx = ctx;
    this.config = config;

    this.resizeHandler = () => this.recalcLayout();
    window.addEventListener("resize", this.resizeHandler);
    this.recalcLayout();
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

    this.roadY = this.h * 0.54;
    this.roadH = this.h * 0.10;
    this.roadLeft = this.w * 0.08;
    this.roadRight = this.w * 0.92;

    const n = this.config.numLights;
    this.lightXs = [];
    for (let i = 1; i <= n; i++) {
      this.lightXs.push(this.roadLeft + ((this.roadRight - this.roadLeft) * i) / (n + 1));
    }

    this.figH = Math.min(70, this.h * 0.12);
  }

  /* ------------------------------------------------------------------ */
  /*  Main render                                                        */
  /* ------------------------------------------------------------------ */

  render(state: ExperimentState, progress01: number, nowMs: number): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    this.drawBackground(ctx);
    this.drawRoad(ctx);

    // Crosswalks & traffic lights
    for (let i = 0; i < this.config.numLights; i++) {
      const x = this.lightXs[i];
      this.drawCrosswalk(ctx, x);

      // Determine light color for this intersection
      const lightIdx = i + 1; // 1-based
      let color: "red" | "green" | "off" = "off";
      if (state.phase !== "idle") {
        if (lightIdx < state.lightIndex) {
          color = "green"; // already passed
        } else if (lightIdx === state.lightIndex && state.phase === "waiting_red") {
          color = state.currentLightColor;
        } else {
          color = "red"; // upcoming
        }
      }

      this.drawTrafficLight(ctx, x, color, "top", nowMs);
      this.drawTrafficLight(ctx, x, color, "bottom", nowMs);
    }

    // Stick figure
    const avatarX = this.roadLeft + (this.roadRight - this.roadLeft) * progress01;
    this.drawStickFigure(ctx, avatarX, state.phase, nowMs);

    // Prominent money overlay
    this.drawMoneyOverlay(ctx, state.money, this.config.startMoney, nowMs, state.phase);

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Background                                                         */
  /* ------------------------------------------------------------------ */

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    // Sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, this.roadY - this.roadH);
    skyGrad.addColorStop(0, "#b8dced");
    skyGrad.addColorStop(1, "#ddeef6");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, this.w, this.roadY - this.roadH / 2);

    // Ground
    ctx.fillStyle = "#c8d8c0";
    ctx.fillRect(0, this.roadY + this.roadH / 2, this.w, this.h - (this.roadY + this.roadH / 2));
  }

  /* ------------------------------------------------------------------ */
  /*  Road                                                               */
  /* ------------------------------------------------------------------ */

  private drawRoad(ctx: CanvasRenderingContext2D): void {
    const top = this.roadY - this.roadH / 2;

    // Sidewalk edges
    ctx.fillStyle = "#b0b0a8";
    ctx.fillRect(0, top - 4, this.w, this.roadH + 8);

    // Asphalt
    ctx.fillStyle = "#6b6b6b";
    ctx.fillRect(0, top, this.w, this.roadH);

    // Dashed center line
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
  /*  Crosswalk                                                          */
  /* ------------------------------------------------------------------ */

  private drawCrosswalk(ctx: CanvasRenderingContext2D, x: number): void {
    const top = this.roadY - this.roadH / 2;
    const stripeW = 6;
    const stripeGap = 5;
    const numStripes = Math.floor(this.roadH / (stripeW + stripeGap));

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const crossW = 22;
    for (let s = 0; s < numStripes; s++) {
      const sy = top + s * (stripeW + stripeGap) + 2;
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
    const poleH = this.h * 0.14;
    const poleW = 3;
    const housingW = 20;
    const housingH = 42;
    const bulbR = 7;
    const bulbSpacing = 18;

    const roadEdge =
      side === "top"
        ? this.roadY - this.roadH / 2
        : this.roadY + this.roadH / 2;

    const dir = side === "top" ? -1 : 1;
    const poleTop = roadEdge + dir * poleH;
    const poleBottom = roadEdge;

    // Pole
    ctx.fillStyle = "#444";
    ctx.fillRect(x - poleW / 2, Math.min(poleTop, poleBottom), poleW, poleH);

    // Housing
    const hx = x - housingW / 2;
    const hy = side === "top" ? poleTop - housingH : poleTop;

    ctx.fillStyle = "#2a2a2a";
    this.roundRect(ctx, hx, hy, housingW, housingH, 5);
    ctx.fill();

    // Bulbs: red on top, green on bottom within housing
    const cx = x;
    const redCY = hy + housingH / 2 - bulbSpacing / 2;
    const greenCY = hy + housingH / 2 + bulbSpacing / 2;

    // Pulse for active light
    const pulse = 0.7 + 0.3 * Math.abs(Math.sin(nowMs * 0.005));

    // Red bulb
    this.drawBulb(ctx, cx, redCY, bulbR, color === "red", "#ff4d4f", "#4a2020", pulse, nowMs);
    // Green bulb
    this.drawBulb(ctx, cx, greenCY, bulbR, color === "green", "#52c41a", "#1e3a1f", pulse, nowMs);
  }

  private drawBulb(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    active: boolean,
    onColor: string,
    offColor: string,
    pulse: number,
    _nowMs: number
  ): void {
    ctx.save();
    if (active) {
      ctx.shadowColor = onColor;
      ctx.shadowBlur = 18 * pulse;
      ctx.fillStyle = onColor;
      ctx.globalAlpha = pulse;
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

  /* ------------------------------------------------------------------ */
  /*  Stick figure                                                       */
  /* ------------------------------------------------------------------ */

  private drawStickFigure(
    ctx: CanvasRenderingContext2D,
    x: number,
    phase: Phase,
    nowMs: number
  ): void {
    const h = this.figH;
    const headR = h * 0.12;
    const neckY = this.roadY + this.roadH / 2 + 8; // stand on south sidewalk
    const headCY = neckY - h + headR;
    const shoulderY = headCY + headR + h * 0.06;
    const hipY = shoulderY + h * 0.35;
    const footY = hipY + h * 0.35;
    const armLen = h * 0.25;
    const legLen = footY - hipY;

    const isWalking = phase === "moving";
    const swing = isWalking ? Math.sin(nowMs * 0.0085) * 0.6 : 0;

    ctx.save();
    ctx.strokeStyle = "#1a1a1a";
    ctx.fillStyle = "#1a1a1a";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";

    // Head
    ctx.beginPath();
    ctx.arc(x, headCY, headR, 0, Math.PI * 2);
    ctx.fill();

    // Body (neck to hip)
    ctx.beginPath();
    ctx.moveTo(x, shoulderY);
    ctx.lineTo(x, hipY);
    ctx.stroke();

    // Arms
    const armSwing = swing;
    // Left arm
    ctx.beginPath();
    ctx.moveTo(x, shoulderY);
    ctx.lineTo(
      x - Math.cos(1.2 + armSwing) * armLen,
      shoulderY + Math.sin(1.2 + armSwing) * armLen
    );
    ctx.stroke();
    // Right arm
    ctx.beginPath();
    ctx.moveTo(x, shoulderY);
    ctx.lineTo(
      x + Math.cos(1.2 - armSwing) * armLen,
      shoulderY + Math.sin(1.2 - armSwing) * armLen
    );
    ctx.stroke();

    // Legs
    const legSwing = swing;
    // Left leg
    ctx.beginPath();
    ctx.moveTo(x, hipY);
    ctx.lineTo(
      x - Math.sin(0.3 + legSwing) * legLen * 0.5,
      hipY + Math.cos(0.3 + legSwing) * legLen
    );
    ctx.stroke();
    // Right leg
    ctx.beginPath();
    ctx.moveTo(x, hipY);
    ctx.lineTo(
      x + Math.sin(0.3 - legSwing) * legLen * 0.5,
      hipY + Math.cos(0.3 - legSwing) * legLen
    );
    ctx.stroke();

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Money overlay (prominent)                                          */
  /* ------------------------------------------------------------------ */

  private drawMoneyOverlay(
    ctx: CanvasRenderingContext2D,
    money: number,
    startMoney: number,
    nowMs: number,
    phase: Phase
  ): void {
    if (phase === "idle") return;

    const fraction = money / startMoney;
    let textColor: string;
    let glowColor: string;
    let alpha = 1;

    if (fraction > 0.7) {
      textColor = "#52c41a";
      glowColor = "rgba(82,196,26,0.6)";
    } else if (fraction > 0.4) {
      textColor = "#faad14";
      glowColor = "rgba(250,173,20,0.6)";
    } else {
      textColor = "#ff4d4f";
      glowColor = "rgba(255,77,79,0.7)";
      alpha = 0.7 + 0.3 * Math.abs(Math.sin(nowMs * 0.004));
    }

    const fontSize = Math.min(48, this.w * 0.06);
    const subFontSize = Math.min(18, this.w * 0.024);
    const cx = this.w / 2;
    const cy = this.h * 0.1;

    const mainText = `￥${money.toFixed(2)}`;
    const subText = `-￥${this.config.moneyLossPerSec.toFixed(2)}/秒`;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Measure text for background pill
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
    const mainMetrics = ctx.measureText(mainText);
    const pillW = mainMetrics.width + 40;
    const pillH = fontSize + subFontSize + 24;
    const pillX = cx - pillW / 2;
    const pillY = cy - fontSize / 2 - 8;

    // Background pill
    ctx.fillStyle = "rgba(0,0,0,0.50)";
    this.roundRect(ctx, pillX, pillY, pillW, pillH, 14);
    ctx.fill();

    // Main money text
    ctx.fillStyle = textColor;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 22;
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mainText, cx, cy);

    // Sub text (loss rate)
    ctx.shadowBlur = 0;
    ctx.font = `600 ${subFontSize}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText(subText, cx, cy + fontSize / 2 + subFontSize / 2 + 4);

    ctx.restore();
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
  }
}
