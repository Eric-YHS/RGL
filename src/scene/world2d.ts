import type { ExperimentConfig, ExperimentState, Phase } from "../experiment/types";
import greenSignalBmpUrl from "../assets/kimbrough-rf/green.bmp";
import redSignalBmpUrl from "../assets/kimbrough-rf/red.bmp";

type SignalGlyphCrop = { x: number; y: number; w: number; h: number };

const RED_SIGNAL_GLYPH_CROP: SignalGlyphCrop = { x: 17, y: 8, w: 15, h: 35 };
const GREEN_SIGNAL_GLYPH_CROP: SignalGlyphCrop = { x: 14, y: 52, w: 24, h: 28 };

function loadCanvasImage(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img;
}

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

const SEQUENTIAL_POSITION_TEMPLATES: Record<number, number[][]> = {
  2: [
    [0.22, 0.72],
    [0.19, 0.68],
    [0.27, 0.76]
  ],
  5: [
    [0.16, 0.42, 0.54, 0.75, 0.85],
    [0.18, 0.30, 0.56, 0.69, 0.84],
    [0.14, 0.39, 0.51, 0.77, 0.87]
  ]
};

/**
 * Generate uneven spacing ratios for sequential mode.
 * Returns cumulative positions in [0,1] for each light.
 * Uses a fixed seed so every participant gets the same layout.
 */
function generateUnevenPositions(numLights: number, seed = 42): number[] {
  const templates = SEQUENTIAL_POSITION_TEMPLATES[numLights];
  if (templates && templates.length > 0) {
    const templateIndex = Math.abs(seed) % templates.length;
    return templates[templateIndex].slice();
  }

  const rng = mulberry32(seed);
  const raw: number[] = [];
  for (let i = 0; i <= numLights; i++) {
    const edge = i === 0 || i === numLights;
    raw.push(edge ? 0.9 + rng() * 0.45 : 0.55 + rng() * 2.0);
  }
  const total = raw.reduce((a, b) => a + b, 0);
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
  private readonly redSignalSprite = loadCanvasImage(redSignalBmpUrl);
  private readonly greenSignalSprite = loadCanvasImage(greenSignalBmpUrl);
  private redSignalGlyph: HTMLCanvasElement | null = null;
  private greenSignalGlyph: HTMLCanvasElement | null = null;
  private fogFadeLeftX = -1;
  private fogFadeRightX = -1;
  private lastMoneyPulseStep: number | null = null;
  private moneyPulseUntilMs = 0;

  /* Fog parameters for sequential mode */
  private readonly fogLeadPx = 0.03; // how far ahead of avatar (as fraction of road width) is clear
  private readonly fogFadePx = 0.04; // fade zone width as fraction of road width

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
    const compactPortrait = cssH > cssW && cssW <= 560;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.w = cssW;
    this.h = cssH;

    this.roadY = this.h * (compactPortrait ? 0.6 : 0.59);
    this.roadH = this.h * (compactPortrait ? 0.098 : 0.104);
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
    this.resetFogTracking();
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

      this.drawTrafficLight(ctx, x, this.getTrafficLightColor(state, i + 1), "top", nowMs);
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
      this.drawFog(ctx, state, avatarX);
    }

    this.drawPressureVignette(ctx, state.money, this.config.startMoney, nowMs, state.phase);

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
    const trafficLightScale = this.getTrafficLightScale();
    const poleH = this.h * 0.14 * (this.isCompactPortraitLayout() ? 1 : 1.12);
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

    // Pole
    ctx.fillStyle = "#444";
    ctx.fillRect(x - poleW / 2, Math.min(poleTop, poleBottom), poleW, poleH);

    // Housing
    const hx = x - housingW / 2;
    const hy = side === "top" ? poleTop - housingH : poleTop;

    ctx.fillStyle = "#2a2a2a";
    this.roundRect(ctx, hx, hy, housingW, housingH, 5 * trafficLightScale);
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

    if (color === "red") {
      const glyph = this.getSignalGlyph("red");
      if (glyph) this.drawSignalGlyph(ctx, glyph, cx, redCY, bulbR, pulse);
    } else if (color === "green") {
      const glyph = this.getSignalGlyph("green");
      if (glyph) this.drawSignalGlyph(ctx, glyph, cx, greenCY, bulbR, pulse);
    }
  }

  private getTrafficLightColor(
    state: ExperimentState,
    lightIdx: number
  ): "red" | "green" | "off" {
    if (state.phase === "idle") return "red";
    if (state.phase === "finished") {
      return this.getResolvedPassedLightColor(state, lightIdx);
    }
    if (lightIdx < state.lightIndex) {
      return this.getResolvedPassedLightColor(state, lightIdx);
    }
    if (lightIdx === state.lightIndex && state.phase === "waiting_red") {
      return state.currentLightColor;
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

  private getSignalGlyph(kind: "red" | "green"): HTMLCanvasElement | null {
    if (kind === "red") {
      if (this.redSignalGlyph) return this.redSignalGlyph;
      if (!this.isRenderableImage(this.redSignalSprite)) return null;
      this.redSignalGlyph = this.prepareSignalGlyph(this.redSignalSprite, RED_SIGNAL_GLYPH_CROP);
      return this.redSignalGlyph;
    }

    if (this.greenSignalGlyph) return this.greenSignalGlyph;
    if (!this.isRenderableImage(this.greenSignalSprite)) return null;
    this.greenSignalGlyph = this.prepareSignalGlyph(this.greenSignalSprite, GREEN_SIGNAL_GLYPH_CROP);
    return this.greenSignalGlyph;
  }

  private prepareSignalGlyph(
    sprite: HTMLImageElement,
    crop: SignalGlyphCrop
  ): HTMLCanvasElement | null {
    const canvas = document.createElement("canvas");
    canvas.width = crop.w;
    canvas.height = crop.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(sprite, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    const imgData = ctx.getImageData(0, 0, crop.w, crop.h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r < 40 && g < 40 && b < 40) {
        data[i + 3] = 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
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
    const scale = Math.min((bulbR * 2.08) / glyph.width, (bulbR * 2.2) / glyph.height);
    const drawW = glyph.width * scale;
    const drawH = glyph.height * scale;
    const drawX = cx - drawW / 2;
    const drawY = cy - drawH / 2;
    const thickenOffset = Math.max(0.75, bulbR * 0.08);
    const thickenPasses = [
      [-thickenOffset, 0],
      [thickenOffset, 0],
      [0, -thickenOffset],
      [0, thickenOffset]
    ] as const;

    ctx.save();
    ctx.globalAlpha = 0.9 + pulse * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, bulbR, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    for (const [dx, dy] of thickenPasses) {
      ctx.drawImage(glyph, drawX + dx, drawY + dy, drawW, drawH);
    }
    ctx.drawImage(glyph, drawX, drawY, drawW, drawH);
    ctx.restore();
  }

  private getTrafficLightScale(): number {
    return this.isCompactPortraitLayout() ? 1 : 1.52;
  }

  private isRenderableImage(img: HTMLImageElement): boolean {
    return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Fog (sequential mode)                                              */
  /* ------------------------------------------------------------------ */

  private drawFog(ctx: CanvasRenderingContext2D, state: ExperimentState, avatarX: number): void {
    if (state.phase === "idle") {
      this.resetFogTracking();
    }

    const roadW = this.roadRight - this.roadLeft;
    const baseFadeW = this.getFogFadeWidthPx(roadW);
    const currentTargetX = state.phase !== "idle" && state.phase !== "finished"
      ? this.lightXs[state.lightIndex - 1]
      : undefined;
    const clearEndX = this.getFogClearEndX(state, avatarX, roadW, currentTargetX);
    let fadeLeft = Math.max(0, clearEndX);
    let fogSolidX = fadeLeft + baseFadeW;

    if (state.phase !== "idle" && state.phase !== "finished") {
      const nextHiddenX = this.lightXs[state.lightIndex];

      if (currentTargetX !== undefined && nextHiddenX !== undefined) {
        const revealCapX = nextHiddenX - this.getFogLightSafeHalfWidthPx();
        fogSolidX = Math.min(fogSolidX, revealCapX);
        fogSolidX = Math.max(fogSolidX, fadeLeft);
      }
    }

    if (this.fogFadeLeftX >= 0) {
      fadeLeft = Math.max(fadeLeft, this.fogFadeLeftX);
    }
    if (this.fogFadeRightX >= 0) {
      fogSolidX = Math.max(fogSolidX, this.fogFadeRightX);
    }
    fogSolidX = Math.max(fogSolidX, fadeLeft);

    if (fogSolidX >= this.w) return;

    ctx.save();
    const fadeRight = Math.min(this.w, fogSolidX);
    this.fogFadeLeftX = fadeLeft;
    this.fogFadeRightX = fadeRight;

    // Repaint background bands over the fogged area to fully hide scene elements.
    // We draw three horizontal strips (sky, road area, ground) with horizontal
    // alpha gradients so the transition is smooth.

    const roadTop = this.roadY - this.roadH / 2 - 4; // include sidewalk
    const roadBot = this.roadY + this.roadH / 2 + 4;

    // [r,g,b] for each band to build proper transparent→solid gradients
    const bands: Array<{ y: number; h: number; color: string; rgb: string }> = [
      { y: 0, h: roadTop, color: "#ddeef6", rgb: "221,238,246" },
      { y: roadTop, h: roadBot - roadTop, color: "#b0b0a8", rgb: "176,176,168" },
      { y: roadBot, h: this.h - roadBot, color: "#c8d8c0", rgb: "200,216,192" }
    ];

    for (const band of bands) {
      // Gradient fade zone: from transparent version of the SAME color to solid
      if (fadeRight > fadeLeft) {
        const grad = ctx.createLinearGradient(fadeLeft, 0, fadeRight, 0);
        grad.addColorStop(0, `rgba(${band.rgb},0)`);
        grad.addColorStop(1, `rgba(${band.rgb},1)`);
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
    const pulseStep = Math.floor((money + 1e-6) * 10);
    if (this.lastMoneyPulseStep === null) {
      this.lastMoneyPulseStep = pulseStep;
    } else if (pulseStep < this.lastMoneyPulseStep) {
      this.moneyPulseUntilMs = nowMs + (stage >= 2 ? 420 : stage === 1 ? 320 : 240);
      this.lastMoneyPulseStep = pulseStep;
    } else if (pulseStep > this.lastMoneyPulseStep) {
      this.lastMoneyPulseStep = pulseStep;
    }

    const pulseWindowMs = stage >= 2 ? 420 : stage === 1 ? 320 : 240;
    const pulseProgress = Math.max(0, this.moneyPulseUntilMs - nowMs) / pulseWindowMs;
    const pulseKick = pulseProgress > 0 ? Math.sin((1 - pulseProgress) * Math.PI) : 0;
    const heartbeat = Math.pow((Math.sin(nowMs * (0.002 + stage * 0.0006 + pressure * 0.0022)) + 1) / 2, 2.1);
    const cardScale =
      1 + pulseKick * (stage === 2 ? 0.085 : stage === 1 ? 0.06 : 0.035) + heartbeat * pressure * 0.025;
    const alpha = 0.97 + heartbeat * pressure * 0.03;
    const cardJoltY = pulseKick * (stage === 2 ? 4 : stage === 1 ? 2.5 : 1.5);

    let textColor = "#f4f1e8";
    let glowColor = "rgba(255,255,255,0.18)";
    let accentColor = "rgba(255,255,255,0.68)";
    let panelTop = "rgba(38, 26, 28, 0.92)";
    let panelBottom = "rgba(20, 16, 18, 0.94)";
    let borderColor = "rgba(255,255,255,0.12)";

    if (stage === 0) {
      textColor = "#fff0d2";
      glowColor = "rgba(255, 201, 106, 0.3)";
      accentColor = "rgba(255, 205, 144, 0.82)";
      panelTop = "rgba(60, 34, 24, 0.92)";
      panelBottom = "rgba(26, 16, 12, 0.96)";
      borderColor = "rgba(255, 189, 112, 0.2)";
    } else if (stage === 1) {
      textColor = "#ffc070";
      glowColor = "rgba(255, 132, 38, 0.44)";
      accentColor = "rgba(255, 169, 104, 0.86)";
      panelTop = "rgba(78, 28, 18, 0.94)";
      panelBottom = "rgba(34, 12, 10, 0.98)";
      borderColor = "rgba(255, 123, 60, 0.28)";
    } else {
      textColor = "#ff7466";
      glowColor = "rgba(255, 64, 64, 0.68)";
      accentColor = "rgba(255, 151, 133, 0.98)";
      panelTop = "rgba(88, 12, 14, 0.96)";
      panelBottom = "rgba(34, 4, 6, 0.99)";
      borderColor = "rgba(255, 96, 80, 0.42)";
    }

    const compactPortrait = this.isCompactPortraitLayout();
    const routeCenterX =
      this.lightXs.length > 0 ? (this.lightXs[0] + this.lightXs[this.lightXs.length - 1]) / 2 : this.w / 2;
    const routeSpan =
      this.lightXs.length > 1 ? this.lightXs[this.lightXs.length - 1] - this.lightXs[0] : this.w * 0.42;
    const fontSize = compactPortrait ? Math.min(42, this.w * 0.089) : Math.min(60, this.w * 0.047);
    const labelFontSize = compactPortrait ? Math.min(16, this.w * 0.034) : Math.min(20, this.w * 0.017);
    const subFontSize = compactPortrait ? Math.min(16, this.w * 0.037) : Math.min(18, this.w * 0.015);
    const roadTop = this.roadY - this.roadH / 2;
    const lightsTopY = roadTop - this.h * 0.14 - 42;

    const mainText = `￥${money.toFixed(2)}`;
    const labelText = "剩余金额";
    const subText = `每秒 -￥${this.config.moneyLossPerSec.toFixed(2)}`;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${labelFontSize}px system-ui, sans-serif`;
    const labelWidth = ctx.measureText(labelText).width;
    ctx.font = `italic 900 ${fontSize}px system-ui, sans-serif`;
    const mainWidth = ctx.measureText(mainText).width;
    ctx.font = `800 ${subFontSize}px system-ui, sans-serif`;
    const subWidth = ctx.measureText(subText).width;
    const ribbonW = Math.min(
      compactPortrait ? this.w - 44 : 420,
      Math.max(
        compactPortrait ? 238 : 312,
        labelWidth + mainWidth + 86,
        subWidth + 64,
        routeSpan * (compactPortrait ? 0.54 : 0.34)
      )
    );
    const ribbonH = compactPortrait ? 78 : 92;
    const cx = routeCenterX;
    const overlayLift = compactPortrait ? 16 : 32;
    const cy = Math.max(
      compactPortrait ? this.h * 0.228 : this.h * 0.208,
      lightsTopY - (compactPortrait ? 54 : 70)
    );

    ctx.translate(cx, cy - overlayLift - cardJoltY);
    ctx.scale(cardScale, cardScale);

    const pillX = -ribbonW / 2;
    const pillY = -ribbonH / 2;
    const cornerRadius = compactPortrait ? 18 : 20;

    const panelGrad = ctx.createLinearGradient(0, pillY, 0, pillY + ribbonH);
    panelGrad.addColorStop(0, panelTop);
    panelGrad.addColorStop(1, panelBottom);

    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 18 + (stage === 2 ? 20 : stage === 1 ? 14 : 8) + pulseKick * 14;
    ctx.fillStyle = panelGrad;
    this.roundRect(ctx, pillX, pillY, ribbonW, ribbonH, cornerRadius);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    this.roundRect(ctx, pillX, pillY, ribbonW, ribbonH, cornerRadius);
    ctx.stroke();

    const leftInset = pillX + (compactPortrait ? 18 : 22);
    const rightInset = pillX + ribbonW - (compactPortrait ? 18 : 22);
    const topRowY = pillY + (compactPortrait ? 22 : 25);
    const bottomRowY = pillY + ribbonH - (compactPortrait ? 16 : 18);

    ctx.fillStyle = accentColor;
    ctx.font = `700 ${labelFontSize}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, leftInset, topRowY);

    ctx.fillStyle = textColor;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 12 + (stage === 2 ? 16 : stage === 1 ? 12 : 8) + pressure * 12;
    ctx.font = `italic 900 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(mainText, rightInset, topRowY + (compactPortrait ? 2 : 3));

    ctx.shadowBlur = 0;
    ctx.font = `800 ${subFontSize}px system-ui, sans-serif`;
    ctx.fillStyle =
      stage === 2
        ? `rgba(255, 160, 160, ${0.9 + pressure * 0.1})`
        : stage === 1
          ? `rgba(255, 177, 138, ${0.88 + pressure * 0.08})`
          : `rgba(255, 208, 168, ${0.84 + pressure * 0.06})`;
    ctx.textAlign = "center";
    ctx.fillText(subText, 0, bottomRowY);

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

  private resetFogTracking(): void {
    this.fogFadeLeftX = -1;
    this.fogFadeRightX = -1;
  }

  private getResolvedPassedLightColor(
    state: ExperimentState,
    lightIdx: number
  ): "red" | "green" {
    const outcome = state.passedOutcome[lightIdx];
    if (outcome === "green") return "green";

    const greenAtSec = state.lightGreenAtSecByIndex[lightIdx];
    if (outcome === "run_red" && greenAtSec !== null && state.elapsedSec >= greenAtSec) {
      return "green";
    }
    return "red";
  }

  private getFogClearEndX(
    state: ExperimentState,
    avatarX: number,
    roadW: number,
    currentTargetX: number | undefined
  ): number {
    const baseClearEndX = avatarX + roadW * this.fogLeadPx;
    if (currentTargetX === undefined) return baseClearEndX;

    const safeClearEndX = currentTargetX + this.getFogLightSafeHalfWidthPx();
    const extraRevealNeeded = Math.max(0, safeClearEndX - baseClearEndX);
    if (extraRevealNeeded <= 0) return baseClearEndX;

    const distanceToTarget = Math.max(0, currentTargetX - avatarX);
    const revealStartDist = this.getFogApproachRevealDistancePx(roadW);
    const fullRevealDist = this.getFogApproachFullRevealDistancePx();
    const revealT =
      state.phase === "waiting_red"
        ? 1
        : Math.max(
            0,
            Math.min(1, (revealStartDist - distanceToTarget) / Math.max(revealStartDist - fullRevealDist, 1))
          );

    return baseClearEndX + extraRevealNeeded * revealT;
  }

  private getFogFadeWidthPx(roadW: number): number {
    return Math.max(roadW * this.fogFadePx, this.isCompactPortraitLayout() ? 18 : 14);
  }

  private getFogLightSafeHalfWidthPx(): number {
    return this.isCompactPortraitLayout() ? 24 : 20;
  }

  private getFogApproachRevealDistancePx(roadW: number): number {
    return this.isCompactPortraitLayout() ? Math.max(roadW * 0.22, 84) : Math.max(roadW * 0.18, 72);
  }

  private getFogApproachFullRevealDistancePx(): number {
    return this.isCompactPortraitLayout() ? 34 : 30;
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
