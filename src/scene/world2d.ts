import type { ExperimentConfig, ExperimentState, Phase } from "../experiment/types";

/* Deterministic PRNG (mulberry32) for reproducible uneven spacing */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate uneven spacing ratios for sequential mode.
 * Returns cumulative positions in [0,1] for each light.
 * Uses a fixed seed so every participant gets the same layout.
 */
function generateUnevenPositions(numLights: number, seed = 42): number[] {
  const rng = mulberry32(seed);
  // Generate random segment lengths, then normalize
  const raw: number[] = [];
  for (let i = 0; i <= numLights; i++) {
    // Each segment between 0.6 and 1.4 relative weight
    raw.push(0.6 + rng() * 0.8);
  }
  const total = raw.reduce((a, b) => a + b, 0);
  // Cumulative positions for lights (after each segment except the last)
  const positions: number[] = [];
  let cum = 0;
  for (let i = 0; i < numLights; i++) {
    cum += raw[i] / total;
    positions.push(cum);
  }
  return positions;
}

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
  private lightPositions01: number[] = []; // normalized [0,1] positions of lights on route
  private figH = 0;
  private lastAvatarX = -1; // track movement to decide walk animation
  private smoothAvatarX = -1; // smoothed position to prevent jumps

  /* Fog parameters for sequential mode */
  private readonly fogLeadPx = 0.12; // how far ahead of avatar (as fraction of road width) is clear
  private readonly fogFadePx = 0.08; // fade zone width as fraction of road width

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
    const isSequential = this.config.revealMode === "sequential";

    if (isSequential) {
      // Uneven spacing with fixed seed
      this.lightPositions01 = generateUnevenPositions(n);
    } else {
      // Even spacing
      this.lightPositions01 = [];
      for (let i = 1; i <= n; i++) {
        this.lightPositions01.push(i / (n + 1));
      }
    }

    const roadW = this.roadRight - this.roadLeft;
    this.lightXs = this.lightPositions01.map((p) => this.roadLeft + roadW * p);

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
    }

    // Stick figure — interpolate between actual light X positions
    const stopOffset = 28; // pixels before the light pole
    const targetX = this.computeAvatarX(state, progress01, stopOffset);

    // Smooth movement: limit max jump per frame to prevent teleporting
    const maxStepPx = 8; // max pixels per frame (~480px/sec at 60fps)
    if (this.smoothAvatarX < 0) {
      this.smoothAvatarX = targetX; // first frame
    } else if (Math.abs(targetX - this.smoothAvatarX) > maxStepPx) {
      // Move toward target at max speed
      this.smoothAvatarX += Math.sign(targetX - this.smoothAvatarX) * maxStepPx;
    } else {
      this.smoothAvatarX = targetX;
    }
    if (state.phase === "idle") this.smoothAvatarX = targetX; // reset on idle

    const avatarX = this.smoothAvatarX;
    this.drawStickFigure(ctx, avatarX, state.phase, nowMs, avatarX !== this.lastAvatarX);
    this.lastAvatarX = avatarX;

    // Fog overlay for sequential mode (drawn after scene, before money overlay)
    if (this.config.revealMode === "sequential") {
      this.drawFog(ctx, progress01);
    }

    // Prominent money overlay (always on top)
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
    this.drawBulb(ctx, cx, redCY, bulbR, color === "red", "#ff4d4f", "#4a2020", pulse);
    // Green bulb
    this.drawBulb(ctx, cx, greenCY, bulbR, color === "green", "#52c41a", "#1e3a1f", pulse);
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
  /*  Fog (sequential mode)                                              */
  /* ------------------------------------------------------------------ */

  private drawFog(ctx: CanvasRenderingContext2D, progress01: number): void {
    const roadW = this.roadRight - this.roadLeft;
    const avatarX = this.roadLeft + roadW * progress01;

    // Clear zone ends a bit ahead of the avatar
    const clearEndX = avatarX + roadW * this.fogLeadPx;
    // Fog fully opaque starts after the fade zone
    const fogSolidX = clearEndX + roadW * this.fogFadePx;

    if (fogSolidX >= this.w) return;

    ctx.save();

    const fadeLeft = Math.max(0, clearEndX);
    const fadeRight = Math.min(this.w, fogSolidX);

    // Repaint background bands over the fogged area to fully hide scene elements.
    // We draw three horizontal strips (sky, road area, ground) with horizontal
    // alpha gradients so the transition is smooth.

    const roadTop = this.roadY - this.roadH / 2 - 4; // include sidewalk
    const roadBot = this.roadY + this.roadH / 2 + 4;

    const bands: Array<{ y: number; h: number; color: string }> = [
      { y: 0, h: roadTop, color: "#ddeef6" },            // sky (bottom of gradient)
      { y: roadTop, h: roadBot - roadTop, color: "#b0b0a8" }, // road + sidewalk
      { y: roadBot, h: this.h - roadBot, color: "#c8d8c0" }  // ground
    ];

    for (const band of bands) {
      // Gradient fade zone
      if (fadeRight > fadeLeft) {
        const grad = ctx.createLinearGradient(fadeLeft, 0, fadeRight, 0);
        grad.addColorStop(0, "rgba(0,0,0,0)"); // transparent
        grad.addColorStop(1, band.color);       // solid band color
        ctx.fillStyle = grad;
        ctx.fillRect(fadeLeft, band.y, fadeRight - fadeLeft, band.h);
      }

      // Solid fog: fully repaint background from fadeRight to canvas edge
      if (fadeRight < this.w) {
        ctx.fillStyle = band.color;
        ctx.fillRect(fadeRight, band.y, this.w - fadeRight, band.h);
      }
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Avatar position                                                    */
  /* ------------------------------------------------------------------ */

  private computeAvatarX(state: ExperimentState, _progress01: number, stopOffset: number): number {
    if (state.phase === "idle") return this.roadLeft;

    // When finished, stay at the last waiting position (no jump)
    if (state.phase === "finished") {
      const lastLightX = this.lightXs[this.lightXs.length - 1];
      return lastLightX - stopOffset;
    }

    const idx = state.lightIndex; // 1-based, current target light
    const targetLightX = this.lightXs[idx - 1];

    // The stop point just before target light
    const toX = targetLightX - stopOffset;

    // Departure point: road start, or the stop position at the previous light
    // (must match where the avatar was standing when waiting_red)
    const fromX = idx <= 1
      ? this.roadLeft
      : this.lightXs[idx - 2] - stopOffset;

    // segmentFraction: 0 at segment start, 1 when arrived at light
    const segFrac = state.phase === "moving"
      ? Math.min(1, state.segmentProgressSec / this.config.segmentDurationSec)
      : 1; // waiting_red: fully arrived

    return fromX + (toX - fromX) * segFrac;
  }

  /* ------------------------------------------------------------------ */
  /*  Stick figure                                                       */
  /* ------------------------------------------------------------------ */

  private drawStickFigure(
    ctx: CanvasRenderingContext2D,
    x: number,
    _phase: Phase,
    nowMs: number,
    isActuallyMoving: boolean
  ): void {
    const h = this.figH;
    const headR = h * 0.12;
    const neckY = this.roadY + this.roadH / 2 + 8;
    const headCY = neckY - h + headR;
    const shoulderY = headCY + headR + h * 0.06;
    const hipY = shoulderY + h * 0.35;
    const footY = hipY + h * 0.35;
    const armLen = h * 0.25;
    const legLen = footY - hipY;

    // Static spread so limbs are always visible (even when standing still)
    const spread = 6; // pixels outward for each side

    // Walk animation: extra horizontal displacement on top of spread
    const walkDx = isActuallyMoving ? Math.sin(nowMs * 0.008) * armLen * 0.6 : 0;

    ctx.save();
    ctx.strokeStyle = "#1a1a1a";
    ctx.fillStyle = "#1a1a1a";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";

    // Head
    ctx.beginPath();
    ctx.arc(x, headCY, headR, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.moveTo(x, shoulderY);
    ctx.lineTo(x, hipY);
    ctx.stroke();

    // Left arm: base spread left + walk swing
    ctx.beginPath();
    ctx.moveTo(x, shoulderY);
    ctx.lineTo(x - spread + walkDx, shoulderY + armLen * 0.85);
    ctx.stroke();

    // Right arm: base spread right - walk swing (contralateral)
    ctx.beginPath();
    ctx.moveTo(x, shoulderY);
    ctx.lineTo(x + spread - walkDx, shoulderY + armLen * 0.85);
    ctx.stroke();

    // Left leg: base spread left - walk swing (opposite to left arm)
    ctx.beginPath();
    ctx.moveTo(x, hipY);
    ctx.lineTo(x - spread - walkDx, hipY + legLen * 0.95);
    ctx.stroke();

    // Right leg: base spread right + walk swing (opposite to right arm)
    ctx.beginPath();
    ctx.moveTo(x, hipY);
    ctx.lineTo(x + spread + walkDx, hipY + legLen * 0.95);
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
