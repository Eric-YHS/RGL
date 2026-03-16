import type { ExperimentConfig, ExperimentState, Phase } from "../experiment/types";
import greenSignalBmpUrl from "../assets/kimbrough-rf/green.bmp";
import manBmpUrl from "../assets/kimbrough-rf/man.bmp";
import humanMaleWalkingSpriteSheetUrl from "../assets/pedestrian/human-male-walking.png";
import redSignalBmpUrl from "../assets/kimbrough-rf/red.bmp";

type SignalGlyphCrop = { x: number; y: number; w: number; h: number };
type SignalGlyphKind = "red" | "green";
type CanvasPoint = { x: number; y: number };
type PedestrianPoseFrame = {
  torso: CanvasPoint[];
  leftArm: CanvasPoint[];
  rightArm: CanvasPoint[];
  leftLeg: CanvasPoint[];
  rightLeg: CanvasPoint[];
  headCenter: CanvasPoint;
  headR: number;
  shadowScaleX: number;
};

const RED_SIGNAL_GLYPH_CROP: SignalGlyphCrop = { x: 17, y: 8, w: 15, h: 35 };
const GREEN_SIGNAL_GLYPH_CROP: SignalGlyphCrop = { x: 14, y: 52, w: 24, h: 28 };
const SIGNAL_RED_ON = "#c32128";
const SIGNAL_RED_OFF = "#35171a";
const SIGNAL_GREEN_ON = "#1c7a3b";
const SIGNAL_GREEN_OFF = "#162a1b";
const PED_SPRITE_FRAME_WIDTH = 16;
const PED_SPRITE_FRAME_HEIGHT = 32;
const PED_STAND_FRAME_INDEX = 0;
const PED_WALK_SEQUENCE = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
const UI_FONT_FAMILY = '"Experiment Sans", sans-serif';
const MONEY_FONT_FAMILY = '"Experiment Mono", monospace';
const STAND_PED_POSE: PedestrianPoseFrame = {
  torso: [
    { x: -8, y: -86 },
    { x: 8, y: -86 },
    { x: 11, y: -60 },
    { x: 4, y: -38 },
    { x: -4, y: -38 },
    { x: -11, y: -60 }
  ],
  leftArm: [
    { x: -7, y: -82 },
    { x: -14, y: -62 },
    { x: -10, y: -42 }
  ],
  rightArm: [
    { x: 7, y: -82 },
    { x: 13, y: -60 },
    { x: 9, y: -42 }
  ],
  leftLeg: [
    { x: -4, y: -38 },
    { x: -7, y: -15 },
    { x: -13, y: 0 }
  ],
  rightLeg: [
    { x: 4, y: -38 },
    { x: 8, y: -15 },
    { x: 12, y: 0 }
  ],
  headCenter: { x: 0, y: -102 },
  headR: 10,
  shadowScaleX: 1
};
const WALK_PED_POSES: PedestrianPoseFrame[] = [
  {
    torso: [
      { x: -10, y: -86 },
      { x: 7, y: -82 },
      { x: 11, y: -58 },
      { x: 3, y: -38 },
      { x: -6, y: -40 },
      { x: -13, y: -62 }
    ],
    leftArm: [
      { x: -6, y: -81 },
      { x: -12, y: -66 },
      { x: -11, y: -46 }
    ],
    rightArm: [
      { x: 6, y: -79 },
      { x: 13, y: -64 },
      { x: 16, y: -47 }
    ],
    leftLeg: [
      { x: -4, y: -38 },
      { x: -9, y: -17 },
      { x: -24, y: 0 }
    ],
    rightLeg: [
      { x: 4, y: -38 },
      { x: 9, y: -14 },
      { x: 17, y: 0 }
    ],
    headCenter: { x: -1, y: -103 },
    headR: 10,
    shadowScaleX: 1.08
  },
  {
    torso: [
      { x: -9, y: -85 },
      { x: 8, y: -84 },
      { x: 11, y: -58 },
      { x: 4, y: -38 },
      { x: -4, y: -38 },
      { x: -11, y: -59 }
    ],
    leftArm: [
      { x: -6, y: -81 },
      { x: -10, y: -62 },
      { x: -8, y: -44 }
    ],
    rightArm: [
      { x: 6, y: -80 },
      { x: 11, y: -62 },
      { x: 9, y: -44 }
    ],
    leftLeg: [
      { x: -4, y: -38 },
      { x: -8, y: -17 },
      { x: -11, y: 0 }
    ],
    rightLeg: [
      { x: 4, y: -38 },
      { x: 7, y: -17 },
      { x: 12, y: 0 }
    ],
    headCenter: { x: 0, y: -101 },
    headR: 10,
    shadowScaleX: 0.94
  },
  {
    torso: [
      { x: -7, y: -82 },
      { x: 10, y: -86 },
      { x: 13, y: -62 },
      { x: 6, y: -40 },
      { x: -3, y: -38 },
      { x: -11, y: -58 }
    ],
    leftArm: [
      { x: -6, y: -79 },
      { x: -13, y: -64 },
      { x: -16, y: -47 }
    ],
    rightArm: [
      { x: 6, y: -81 },
      { x: 12, y: -66 },
      { x: 11, y: -46 }
    ],
    leftLeg: [
      { x: -4, y: -38 },
      { x: -9, y: -14 },
      { x: -17, y: 0 }
    ],
    rightLeg: [
      { x: 4, y: -38 },
      { x: 9, y: -17 },
      { x: 24, y: 0 }
    ],
    headCenter: { x: 1, y: -103 },
    headR: 10,
    shadowScaleX: 1.08
  },
  {
    torso: [
      { x: -8, y: -84 },
      { x: 9, y: -85 },
      { x: 12, y: -59 },
      { x: 4, y: -38 },
      { x: -4, y: -38 },
      { x: -11, y: -58 }
    ],
    leftArm: [
      { x: -6, y: -80 },
      { x: -11, y: -62 },
      { x: -9, y: -44 }
    ],
    rightArm: [
      { x: 6, y: -81 },
      { x: 10, y: -62 },
      { x: 8, y: -44 }
    ],
    leftLeg: [
      { x: -4, y: -38 },
      { x: -7, y: -17 },
      { x: -12, y: 0 }
    ],
    rightLeg: [
      { x: 4, y: -38 },
      { x: 8, y: -17 },
      { x: 11, y: 0 }
    ],
    headCenter: { x: 0, y: -101 },
    headR: 10,
    shadowScaleX: 0.94
  }
];

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
  private resizeObserver: ResizeObserver | null = null;

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
  private readonly originalPedestrianSprite = loadCanvasImage(manBmpUrl);
  private readonly pedestrianSpriteSheet = loadCanvasImage(humanMaleWalkingSpriteSheetUrl);
  private redSignalGlyph: HTMLCanvasElement | null = null;
  private greenSignalGlyph: HTMLCanvasElement | null = null;
  private originalPedestrianGlyph: HTMLCanvasElement | null = null;
  private pedestrianGlyphFrames: (HTMLCanvasElement | null)[] = [];
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
    const compactPortrait = cssH > cssW && cssW <= 560;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.w = cssW;
    this.h = cssH;

    const defaultRoadY = this.h * (compactPortrait ? 0.6 : 0.59);
    this.roadH = this.h * (compactPortrait ? 0.098 : 0.104);
    this.roadLeft = this.w * 0.08;
    this.roadRight = this.w * 0.92;
    const manualSceneDownShiftPx = 20;
    this.roadY =
      defaultRoadY +
      this.getDesktopSceneDownShift(parent, compactPortrait, defaultRoadY) +
      manualSceneDownShiftPx;
    this.syncStageAnchors(parent, compactPortrait);

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

  private getDesktopSceneDownShift(
    parent: HTMLElement,
    compactPortrait: boolean,
    defaultRoadY: number
  ): number {
    if (compactPortrait) return 0;

    const statusPanel = parent.querySelector<HTMLElement>(".panel-status");
    if (!statusPanel) return 0;

    const parentRect = parent.getBoundingClientRect();
    const statusRect = statusPanel.getBoundingClientRect();
    const statusBottomY = statusRect.bottom - parentRect.top;
    if (!Number.isFinite(statusBottomY)) return 0;

    const { poleH, housingH } = this.getTrafficLightMetrics(compactPortrait);
    const currentLightTopY = defaultRoadY - this.roadH / 2 - poleH - housingH;
    const rawShift = statusBottomY - currentLightTopY;
    const alignmentBias = Math.min(16, this.h * 0.018);
    const desiredShift = Math.max(0, rawShift) + alignmentBias;
    const maxShift = this.h * 0.075;

    return Math.min(maxShift, desiredShift);
  }

  private getTrafficLightMetrics(compactPortrait: boolean): {
    poleH: number;
    housingH: number;
  } {
    const trafficLightScale = compactPortrait ? 1 : 1.52;
    return {
      poleH: this.h * 0.14 * (compactPortrait ? 1 : 1.12),
      housingH: 42 * trafficLightScale
    };
  }

  private syncStageAnchors(parent: HTMLElement, compactPortrait: boolean): void {
    const roadBottomY = this.roadY + this.roadH / 2;
    const lowerBlankHeight = Math.max(0, this.h - roadBottomY);
    const walkCenterFactor = compactPortrait ? 0.48 : 0.44;
    const walkCenterY = roadBottomY + lowerBlankHeight * walkCenterFactor;
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
    this.drawBulb(ctx, cx, redCY, bulbR, color === "red", SIGNAL_RED_ON, SIGNAL_RED_OFF, pulse);
    // Green bulb
    this.drawBulb(ctx, cx, greenCY, bulbR, color === "green", SIGNAL_GREEN_ON, SIGNAL_GREEN_OFF, pulse);

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
    phase: Phase,
    nowMs: number,
    isActuallyMoving: boolean
  ): void {
    const h = this.figH;
    const footY = this.roadY + this.roadH / 2 + 8;
    const pose = phase === "moving" || isActuallyMoving ? "walk" : "stand";
    const originalPedFrame = this.getOriginalPedestrianGlyph();
    const spriteCycle01 = !originalPedFrame && pose === "walk" ? this.getWalkSpriteCycle(nowMs) : 0;
    const spriteBobY = !originalPedFrame && pose === "walk" ? this.getWalkSpriteBob(spriteCycle01, h) : 0;
    const pedFrame = originalPedFrame
      ? { current: originalPedFrame, next: null, mix01: 0 }
      : this.getPedestrianSpriteFrame(pose, nowMs);

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.beginPath();
    ctx.ellipse(
      x,
      footY + 3,
      h * 0.16 * (pose === "walk" ? 1.05 : 0.96),
      h * 0.04,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.restore();

    if (pedFrame) {
      this.drawPedestrianSpriteFrame(ctx, pedFrame, x, footY + spriteBobY, h, pose);
    }
  }

  private getOriginalPedestrianGlyph(): HTMLCanvasElement | null {
    if (this.originalPedestrianGlyph) return this.originalPedestrianGlyph;
    if (!this.isRenderableImage(this.originalPedestrianSprite)) return null;
    this.originalPedestrianGlyph = this.preparePedestrianSprite(this.originalPedestrianSprite);
    return this.originalPedestrianGlyph;
  }

  private getPedestrianSpriteFrame(
    pose: "stand" | "walk",
    nowMs: number
  ): { current: CanvasImageSource; next: CanvasImageSource | null; mix01: number } | null {
    const glyphs = this.getPedestrianGlyphFrames();
    if (glyphs.length === 0) return null;

    if (pose === "stand") {
      const standGlyph = glyphs[Math.min(PED_STAND_FRAME_INDEX, glyphs.length - 1)];
      return standGlyph ? { current: standGlyph, next: null, mix01: 0 } : null;
    }

    const scaled = this.getWalkSpriteCycle(nowMs) * PED_WALK_SEQUENCE.length;
    const sequenceIndex = Math.floor(scaled) % PED_WALK_SEQUENCE.length;
    const index = PED_WALK_SEQUENCE[sequenceIndex];
    const glyph = glyphs[index];
    if (!glyph) return null;

    return {
      current: glyph,
      next: null,
      mix01: 0
    };
  }

  private getPedestrianGlyphFrames(): HTMLCanvasElement[] {
    const frameCount = Math.max(
      1,
      Math.floor(this.pedestrianSpriteSheet.naturalWidth / PED_SPRITE_FRAME_WIDTH)
    );

    if (this.pedestrianGlyphFrames.length !== frameCount) {
      this.pedestrianGlyphFrames = new Array(frameCount).fill(null);
    }

    if (!this.isRenderableImage(this.pedestrianSpriteSheet)) return [];

    for (let index = 0; index < frameCount; index += 1) {
      if (this.pedestrianGlyphFrames[index]) continue;
      this.pedestrianGlyphFrames[index] = this.extractPedestrianSpriteFrame(index);
    }

    return this.pedestrianGlyphFrames.filter((glyph): glyph is HTMLCanvasElement => !!glyph);
  }

  private extractPedestrianSpriteFrame(frameIndex: number): HTMLCanvasElement | null {
    if (!this.isRenderableImage(this.pedestrianSpriteSheet)) return null;

    const frameCount = Math.floor(this.pedestrianSpriteSheet.naturalWidth / PED_SPRITE_FRAME_WIDTH);
    if (frameIndex < 0 || frameIndex >= frameCount) return null;

    const canvas = document.createElement("canvas");
    canvas.width = PED_SPRITE_FRAME_WIDTH;
    canvas.height = PED_SPRITE_FRAME_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      this.pedestrianSpriteSheet,
      frameIndex * PED_SPRITE_FRAME_WIDTH,
      0,
      PED_SPRITE_FRAME_WIDTH,
      PED_SPRITE_FRAME_HEIGHT,
      0,
      0,
      PED_SPRITE_FRAME_WIDTH,
      PED_SPRITE_FRAME_HEIGHT
    );
    return canvas;
  }

  private getWalkSpriteCycle(nowMs: number): number {
    return (nowMs * 0.0012) % 1;
  }

  private getWalkSpriteBob(cycle01: number, h: number): number {
    const wave = Math.sin(cycle01 * Math.PI * 2);
    return Math.round((0.5 - 0.5 * wave) * h * 0.012);
  }

  private drawPedestrianSpriteFrame(
    ctx: CanvasRenderingContext2D,
    frame: { current: CanvasImageSource; next: CanvasImageSource | null; mix01: number },
    x: number,
    footY: number,
    h: number,
    pose: "stand" | "walk"
  ): void {
    const spriteW =
      "width" in frame.current && "height" in frame.current
        ? (h * frame.current.width) / Math.max(frame.current.height, 1)
        : h * 0.6;
    const anchorRatio = pose === "walk" ? 0.46 : 0.48;
    const drawW = Math.round(spriteW);
    const drawH = Math.round(h);
    const drawX = Math.round(x - drawW * anchorRatio);
    const drawY = Math.round(footY - drawH);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = frame.next ? 1 - frame.mix01 : 1;
    ctx.drawImage(frame.current, drawX, drawY, drawW, drawH);
    if (frame.next) {
      ctx.globalAlpha = frame.mix01;
      ctx.drawImage(frame.next, drawX, drawY, drawW, drawH);
    }
    ctx.restore();
  }

  private drawPedestrianSilhouette(
    ctx: CanvasRenderingContext2D,
    x: number,
    footY: number,
    u: number,
    poseFrame: PedestrianPoseFrame
  ): void {
    const limbWidth = Math.max(4, 11 * u);
    const silhouetteColor = "#161616";

    ctx.save();
    ctx.translate(x, 0);
    ctx.strokeStyle = silhouetteColor;
    ctx.fillStyle = silhouetteColor;
    ctx.lineWidth = limbWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    this.drawPedestrianLimb(ctx, poseFrame.leftArm, u, footY);
    this.drawPedestrianLimb(ctx, poseFrame.rightArm, u, footY);
    this.drawPedestrianLimb(ctx, poseFrame.leftLeg, u, footY);
    this.drawPedestrianLimb(ctx, poseFrame.rightLeg, u, footY);

    ctx.beginPath();
    ctx.moveTo(poseFrame.torso[0].x * u, footY + poseFrame.torso[0].y * u);
    for (let i = 1; i < poseFrame.torso.length; i += 1) {
      ctx.lineTo(poseFrame.torso[i].x * u, footY + poseFrame.torso[i].y * u);
    }
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(
      poseFrame.headCenter.x * u,
      footY + poseFrame.headCenter.y * u,
      poseFrame.headR * u,
      0,
      Math.PI * 2
    );
    ctx.fill();

    ctx.restore();
  }

  private drawPedestrianLimb(
    ctx: CanvasRenderingContext2D,
    points: CanvasPoint[],
    u: number,
    footY: number
  ): void {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x * u, footY + points[0].y * u);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x * u, footY + points[i].y * u);
    }
    ctx.stroke();
  }

  private getPedestrianPoseFrame(
    pose: "stand" | "walk",
    cycle01: number
  ): PedestrianPoseFrame {
    if (pose === "stand") return STAND_PED_POSE;

    const frameCount = WALK_PED_POSES.length;
    const scaled = cycle01 * frameCount;
    const index = Math.floor(scaled) % frameCount;
    const nextIndex = (index + 1) % frameCount;
    const t = this.easePedestrianCycle(scaled - Math.floor(scaled));

    return this.interpolatePedestrianPose(WALK_PED_POSES[index], WALK_PED_POSES[nextIndex], t);
  }

  private interpolatePedestrianPose(
    from: PedestrianPoseFrame,
    to: PedestrianPoseFrame,
    t: number
  ): PedestrianPoseFrame {
    return {
      torso: this.interpolatePedestrianPoints(from.torso, to.torso, t),
      leftArm: this.interpolatePedestrianPoints(from.leftArm, to.leftArm, t),
      rightArm: this.interpolatePedestrianPoints(from.rightArm, to.rightArm, t),
      leftLeg: this.interpolatePedestrianPoints(from.leftLeg, to.leftLeg, t),
      rightLeg: this.interpolatePedestrianPoints(from.rightLeg, to.rightLeg, t),
      headCenter: this.interpolatePedestrianPoint(from.headCenter, to.headCenter, t),
      headR: this.lerp(from.headR, to.headR, t),
      shadowScaleX: this.lerp(from.shadowScaleX, to.shadowScaleX, t)
    };
  }

  private interpolatePedestrianPoints(
    from: CanvasPoint[],
    to: CanvasPoint[],
    t: number
  ): CanvasPoint[] {
    return from.map((point, index) => this.interpolatePedestrianPoint(point, to[index], t));
  }

  private interpolatePedestrianPoint(from: CanvasPoint, to: CanvasPoint, t: number): CanvasPoint {
    return {
      x: this.lerp(from.x, to.x, t),
      y: this.lerp(from.y, to.y, t)
    };
  }

  private easePedestrianCycle(t: number): number {
    return 0.5 - Math.cos(t * Math.PI) * 0.5;
  }

  private lerp(from: number, to: number, t: number): number {
    return from + (to - from) * t;
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
    const pulseWindowMs = stage >= 2 ? 220 : stage === 1 ? 190 : 170;
    if (this.lastMoneyPulseStep === null) {
      this.lastMoneyPulseStep = pulseStep;
    } else if (pulseStep < this.lastMoneyPulseStep) {
      this.moneyPulseUntilMs = nowMs + pulseWindowMs;
      this.lastMoneyPulseStep = pulseStep;
    } else if (pulseStep > this.lastMoneyPulseStep) {
      this.lastMoneyPulseStep = pulseStep;
    }

    const pulseProgress = Math.max(0, this.moneyPulseUntilMs - nowMs) / pulseWindowMs;
    const pulseKick = pulseProgress > 0 ? Math.sin((1 - pulseProgress) * Math.PI) : 0;
    const cardScale = 1 + pulseKick * (stage === 2 ? 0.042 : stage === 1 ? 0.032 : 0.024);
    const alpha = 1;
    const cardJoltY = pulseKick * (stage === 2 ? 1.8 : 1.2);

    const flashStrength = 0.08 + pressure * 0.05 + pulseKick * 0.22;
    let mainTextColor = "#ff5c5c";
    let labelColor = "#ffd0d0";
    let subPrefixColor = "#efb8b8";
    let subValueColor = "#ffdede";
    let panelTop = "#690000";
    let panelMid = "#460000";
    let panelBottom = "#180000";
    let borderColor = "#9f0909";

    if (stage === 0) {
      mainTextColor = "#ff7474";
      labelColor = "#ffe0e0";
      subPrefixColor = "#f4c8c8";
      subValueColor = "#ffe8e8";
      panelTop = "#5e0202";
      panelMid = "#410101";
      panelBottom = "#160000";
      borderColor = "#861010";
    } else if (stage === 1) {
      mainTextColor = "#ff5555";
      labelColor = "#ffd1d1";
      subPrefixColor = "#efb4b4";
      subValueColor = "#ffdfdf";
      panelTop = "#670000";
      panelMid = "#470000";
      panelBottom = "#170000";
      borderColor = "#ad0808";
    } else {
      mainTextColor = pulseKick > 0 ? "#ff7070" : "#ff4a4a";
      labelColor = "#ffd3d3";
      subPrefixColor = "#f0bcbc";
      subValueColor = pulseKick > 0 ? "#fff0f0" : "#ffe0e0";
      panelTop = "#720000";
      panelMid = "#4b0000";
      panelBottom = "#140000";
      borderColor = pulseKick > 0 ? "#d20c0c" : "#bc0000";
    }

    const compactPortrait = this.isCompactPortraitLayout();
    const routeCenterX =
      this.lightXs.length > 0 ? (this.lightXs[0] + this.lightXs[this.lightXs.length - 1]) / 2 : this.w / 2;
    const routeSpan =
      this.lightXs.length > 1 ? this.lightXs[this.lightXs.length - 1] - this.lightXs[0] : this.w * 0.42;
    const fontSize = compactPortrait ? Math.min(46, this.w * 0.094) : Math.min(68, this.w * 0.053);
    const labelFontSize = compactPortrait ? Math.min(18, this.w * 0.038) : Math.min(24, this.w * 0.02);
    const subFontSize = compactPortrait ? Math.min(17, this.w * 0.039) : Math.min(21, this.w * 0.017);
    const roadTop = this.roadY - this.roadH / 2;
    const { poleH, housingH } = this.getTrafficLightMetrics(compactPortrait);
    const lightsTopY = roadTop - poleH - housingH;

    const displayTickMs = 80;
    const displayMoneyStep = Math.max(this.config.moneyLossPerSec * (displayTickMs / 1000), 0.001);
    const displayedMoney = Math.max(0, Math.round(Math.max(0, money) / displayMoneyStep) * displayMoneyStep);
    const mainText = `￥${displayedMoney.toFixed(3)}`;
    const labelText = "剩余报酬";
    const subPrefixText = "每秒正在减少";
    const subValueText = `-￥${this.config.moneyLossPerSec.toFixed(2)}`;
    const indicatorSize = compactPortrait ? 8 : 10;
    const labelGap = compactPortrait ? 10 : 12;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${labelFontSize}px ${UI_FONT_FAMILY}`;
    const labelWidth = ctx.measureText(labelText).width;
    ctx.font = `900 ${fontSize}px ${MONEY_FONT_FAMILY}`;
    const mainWidth = ctx.measureText(mainText).width;
    ctx.font = `800 ${subFontSize}px ${UI_FONT_FAMILY}`;
    const subPrefixWidth = ctx.measureText(subPrefixText).width;
    ctx.font = `900 ${subFontSize}px ${MONEY_FONT_FAMILY}`;
    const subValueWidth = ctx.measureText(subValueText).width;
    const subWidth = subPrefixWidth + subValueWidth + (compactPortrait ? 10 : 12);
    const ribbonW = Math.min(
      compactPortrait ? this.w - 36 : 468,
      Math.max(
        compactPortrait ? 252 : 344,
        indicatorSize + labelGap + labelWidth + mainWidth + 112,
        subWidth + 76,
        routeSpan * (compactPortrait ? 0.58 : 0.38)
      )
    );
    const ribbonH = compactPortrait ? 84 : 104;
    const cx = routeCenterX;
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
    ctx.font = `700 ${labelFontSize}px ${UI_FONT_FAMILY}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, labelX, topRowY);

    ctx.font = `900 ${fontSize}px ${MONEY_FONT_FAMILY}`;
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
