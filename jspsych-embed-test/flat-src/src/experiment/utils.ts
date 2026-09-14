export function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function formatMoney(amount: number): string {
  const clamped = Math.max(0, amount);
  const rounded = Math.round(clamped * 10) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return "￥".concat(text);
}

export function formatSeconds(sec: number, digits = 1): string {
  const clamped = Math.max(0, sec);
  if (digits <= 0) return `${Math.floor(clamped)}s`;
  return `${clamped.toFixed(digits)}s`;
}

export function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  if (raw.includes('"') || raw.includes(",") || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}
