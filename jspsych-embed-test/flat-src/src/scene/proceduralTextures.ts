import * as THREE from "three";

type TextureOpts = {
  size?: number;
  seed?: number;
};

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function makeSeamlessNoiseGrid(size: number, rng: () => number): Float32Array {
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return grid;
}

function sampleSeamlessNoise(
  grid: Float32Array,
  gridSize: number,
  x01: number,
  y01: number
): number {
  const fx = x01 * gridSize;
  const fy = y01 * gridSize;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;

  const x0 = ((ix % gridSize) + gridSize) % gridSize;
  const y0 = ((iy % gridSize) + gridSize) % gridSize;
  const x1 = (x0 + 1) % gridSize;
  const y1 = (y0 + 1) % gridSize;

  const v00 = grid[x0 + y0 * gridSize];
  const v10 = grid[x1 + y0 * gridSize];
  const v01 = grid[x0 + y1 * gridSize];
  const v11 = grid[x1 + y1 * gridSize];

  const ux = smoothstep(tx);
  const uy = smoothstep(ty);
  const a = lerp(v00, v10, ux);
  const b = lerp(v01, v11, ux);
  return lerp(a, b, uy);
}

function makeCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function createAsphaltTexture(opts: TextureOpts = {}): THREE.CanvasTexture {
  const size = opts.size ?? 512;
  const rng = mulberry32(opts.seed ?? 1);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return makeCanvasTexture(canvas);

  // Base
  ctx.fillStyle = "#2c2f34";
  ctx.fillRect(0, 0, size, size);

  // Fine noise (per-pixel)
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  const base = { r: 44, g: 47, b: 52 };
  const gridSize = 96;
  const grid = makeSeamlessNoiseGrid(gridSize, rng);
  const grid2 = makeSeamlessNoiseGrid(Math.floor(gridSize / 2), rng);
  for (let i = 0; i < data.length; i += 4) {
    const px = ((i / 4) % size) / size;
    const py = Math.floor(i / 4 / size) / size;
    const n1 = sampleSeamlessNoise(grid, gridSize, px, py);
    const n2 = sampleSeamlessNoise(grid2, Math.floor(gridSize / 2), px, py);
    const n = (n1 - 0.5) * 28 + (n2 - 0.5) * 14;
    const v = (n2 - 0.5) * 18;
    data[i + 0] = clampByte(base.r + n);
    data[i + 1] = clampByte(base.g + n + v * 0.15);
    data[i + 2] = clampByte(base.b + n + v * 0.2);
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Aggregate speckles
  for (let i = 0; i < 4200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.4 + rng() * 1.4;
    const a = 0.05 + rng() * 0.08;
    const c = rng() > 0.5 ? 255 : 20;
    ctx.fillStyle = `rgba(${c},${c},${c},${a})`;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Oil stains / patches
  for (let i = 0; i < 20; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rr = 18 + rng() * 42;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, `rgba(0,0,0,${0.12 + rng() * 0.1})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.fillRect(x - rr + ox, y - rr + oy, rr * 2, rr * 2);
      }
    }
  }

  // Hairline cracks
  ctx.lineCap = "round";
  for (let i = 0; i < 55; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.07 + rng() * 0.07})`;
    ctx.lineWidth = 0.6 + rng() * 0.9;
    const x0 = rng() * size;
    const y0 = rng() * size;
    const segs = 3 + Math.floor(rng() * 6);
    const pts: Array<[number, number]> = [[x0, y0]];
    let x = x0;
    let y = y0;
    for (let s = 0; s < segs; s++) {
      x += (rng() - 0.5) * (size * 0.2);
      y += (rng() - 0.5) * (size * 0.2);
      pts.push([x, y]);
    }
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(pts[0]![0] + ox, pts[0]![1] + oy);
        for (let p = 1; p < pts.length; p++) {
          ctx.lineTo(pts[p]![0] + ox, pts[p]![1] + oy);
        }
        ctx.stroke();
      }
    }
  }

  // Subtle direction gradient (helps sense of lighting)
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, "rgba(255,255,255,0.04)");
  grad.addColorStop(1, "rgba(0,0,0,0.08)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  return makeCanvasTexture(canvas);
}

export function createSidewalkTexture(opts: TextureOpts = {}): THREE.CanvasTexture {
  const size = opts.size ?? 512;
  const rng = mulberry32(opts.seed ?? 2);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return makeCanvasTexture(canvas);

  ctx.fillStyle = "#8a8d91";
  ctx.fillRect(0, 0, size, size);

  // Subtle concrete noise
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  const base = { r: 138, g: 141, b: 145 };
  const gridSize = 72;
  const grid = makeSeamlessNoiseGrid(gridSize, rng);
  for (let i = 0; i < data.length; i += 4) {
    const px = ((i / 4) % size) / size;
    const py = Math.floor(i / 4 / size) / size;
    const n = (sampleSeamlessNoise(grid, gridSize, px, py) - 0.5) * 26;
    data[i + 0] = clampByte(base.r + n);
    data[i + 1] = clampByte(base.g + n);
    data[i + 2] = clampByte(base.b + n);
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Tile joints
  const tile = Math.max(32, Math.floor(size / 8));
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 2;
  for (let x = 0; x <= size; x += tile) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, size);
    ctx.stroke();
  }
  for (let y = 0; y <= size; y += tile) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(size, y + 0.5);
    ctx.stroke();
  }

  // Random stains
  for (let i = 0; i < 28; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rr = 14 + rng() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, `rgba(0,0,0,${0.05 + rng() * 0.08})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.fillRect(x - rr + ox, y - rr + oy, rr * 2, rr * 2);
      }
    }
  }

  return makeCanvasTexture(canvas);
}

export function createGrassTexture(opts: TextureOpts = {}): THREE.CanvasTexture {
  const size = opts.size ?? 512;
  const rng = mulberry32(opts.seed ?? 3);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return makeCanvasTexture(canvas);

  ctx.fillStyle = "#496b3f";
  ctx.fillRect(0, 0, size, size);

  // Noise base
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  const base = { r: 73, g: 107, b: 63 };
  const gridSize = 86;
  const grid = makeSeamlessNoiseGrid(gridSize, rng);
  const grid2 = makeSeamlessNoiseGrid(Math.floor(gridSize / 2), rng);
  for (let i = 0; i < data.length; i += 4) {
    const px = ((i / 4) % size) / size;
    const py = Math.floor(i / 4 / size) / size;
    const n1 = sampleSeamlessNoise(grid, gridSize, px, py);
    const n2 = sampleSeamlessNoise(grid2, Math.floor(gridSize / 2), px, py);
    const n = (n1 - 0.5) * 56 + (n2 - 0.5) * 22;
    const g = (n2 - 0.5) * 18;
    data[i + 0] = clampByte(base.r + n * 0.35);
    data[i + 1] = clampByte(base.g + n + g);
    data[i + 2] = clampByte(base.b + n * 0.25);
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Blades strokes
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 2200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 6 + rng() * 14;
    const ang = (rng() - 0.5) * 0.8;
    const hue = 95 + rng() * 22;
    const sat = 35 + rng() * 25;
    const lit = 20 + rng() * 20;
    ctx.strokeStyle = `hsl(${hue} ${sat}% ${lit}%)`;
    ctx.lineWidth = 1;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + Math.sin(ang) * len, y + oy - Math.cos(ang) * len);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  // Darker patches
  for (let i = 0; i < 18; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rr = 22 + rng() * 70;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, `rgba(0,0,0,${0.08 + rng() * 0.08})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.fillRect(x - rr + ox, y - rr + oy, rr * 2, rr * 2);
      }
    }
  }

  return makeCanvasTexture(canvas);
}

export function createBuildingFacadeTexture(opts: TextureOpts = {}): THREE.CanvasTexture {
  const size = opts.size ?? 256;
  const rng = mulberry32(opts.seed ?? 4);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return makeCanvasTexture(canvas);

  // Base vertical gradient (slightly warm + darker than sky, helps fog separation)
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, "#f0eee8");
  grad.addColorStop(1, "#cfc6b9");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Subtle warm/cool side tint
  const gradX = ctx.createLinearGradient(0, 0, size, 0);
  gradX.addColorStop(0, "rgba(255,248,236,0.06)");
  gradX.addColorStop(0.55, "rgba(255,255,255,0)");
  gradX.addColorStop(1, "rgba(228,242,255,0.07)");
  ctx.fillStyle = gradX;
  ctx.fillRect(0, 0, size, size);

  // Subtle floor lines
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 1;
  const floor = Math.max(18, Math.floor(size / 10));
  for (let y = 0; y <= size; y += floor) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(size, y + 0.5);
    ctx.stroke();
  }

  // Random panel strips
  for (let i = 0; i < 10; i++) {
    const x = rng() * size;
    const w = 8 + rng() * 18;
    ctx.fillStyle = `rgba(255,255,255,${0.08 + rng() * 0.1})`;
    ctx.fillRect(x, 0, w, size);
  }

  // Occasional darker shadow strips (adds depth without "dirty")
  for (let i = 0; i < 6; i++) {
    const x = rng() * size;
    const w = 10 + rng() * 26;
    ctx.fillStyle = `rgba(0,0,0,${0.02 + rng() * 0.03})`;
    ctx.fillRect(x, 0, w, size);
  }

  // Fine noise
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng() - 0.5) * 16;
    data[i + 0] = clampByte(data[i + 0] + n);
    data[i + 1] = clampByte(data[i + 1] + n);
    data[i + 2] = clampByte(data[i + 2] + n);
  }
  ctx.putImageData(img, 0, 0);

  return makeCanvasTexture(canvas);
}
