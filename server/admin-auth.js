// server/admin-auth.js
// 管理令牌验证、限流、同源检查。
// 后端只保存令牌 SHA-256 摘要（EXPORT_ADMIN_TOKEN_SHA256），用 timingSafeEqual 比较。

import crypto from "node:crypto";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://experiments.top",
  "https://www.experiments.top",
  "https://m.experiments.top",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

export function isAdminExportEnabled() {
  return process.env.EXPORT_ADMIN_ENABLED === "true";
}

export function getAdminConfig() {
  return {
    digestHex: (process.env.EXPORT_ADMIN_TOKEN_SHA256 ?? "").trim().toLowerCase(),
    maxSessions: readEnvInteger("EXPORT_MAX_SESSIONS", 5000, 1, 100000),
    maxEvents: readEnvInteger("EXPORT_MAX_EVENTS", 100000, 1, 10000000),
    timeZone: (process.env.EXPORT_TIME_ZONE ?? "Asia/Shanghai").trim() || "Asia/Shanghai"
  };
}

/**
 * 校验 Bearer 令牌。
 * 配置缺失或摘要长度错误时一律返回 false（拒绝服务，不降级为免认证）。
 */
export function verifyAdminToken(token) {
  const { digestHex } = getAdminConfig();
  if (!/^[0-9a-f]{64}$/.test(digestHex)) return false;
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) return false;

  const expected = Buffer.from(digestHex, "hex");
  const actual = crypto.createHash("sha256").update(token, "utf8").digest();
  return crypto.timingSafeEqual(expected, actual);
}

/** 从请求中提取 Bearer 令牌，无令牌时返回空字符串。 */
export function extractBearerToken(req) {
  const header = req.headers.authorization ?? "";
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

/** 同源检查：无 Origin（curl/同源导航）或命中允许列表时放行。 */
export function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return true;
  return readOriginAllowlist().has(origin);
}

/** 管理接口前置中间件：启用检查 → 同源检查 → 令牌检查。 */
export function requireAdmin(req, res, next) {
  if (!isAdminExportEnabled()) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }
  if (!allowedOrigin(req)) {
    res.status(403).json({ ok: false, error: "Origin not allowed" });
    return;
  }
  if (!verifyAdminToken(extractBearerToken(req))) {
    // 统一返回 401，不区分“令牌缺失”与“令牌错误”。
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

/** 每 IP 滑动窗口限流（与 index.js 提交限流同构）。 */
export function createIpRateLimiter({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = 0;

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      sweepExpiredBuckets(hits, now);
      lastSweep = now;
    }

    const ipAddress = extractClientIp(req) || "unknown";
    const bucket = hits.get(ipAddress);
    const activeBucket =
      bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + windowMs };
    activeBucket.count += 1;
    hits.set(ipAddress, activeBucket);

    if (activeBucket.count > max) {
      res.set("Retry-After", String(Math.ceil((activeBucket.resetAt - now) / 1000)));
      res.status(429).json({ ok: false, error: "Too many requests" });
      return;
    }

    next();
  };
}

export function extractClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = String(forwarded[0]).trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "";
}

function sweepExpiredBuckets(hits, now) {
  for (const [ipAddress, bucket] of hits.entries()) {
    if (bucket.resetAt <= now) {
      hits.delete(ipAddress);
    }
  }
}

function readOriginAllowlist() {
  const raw = process.env.POST_ALLOWED_ORIGINS;
  const origins = (raw && raw.trim() ? raw.split(",") : DEFAULT_ALLOWED_ORIGINS)
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(origins);
}

function readEnvInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
