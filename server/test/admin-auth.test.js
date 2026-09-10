// server/test/admin-auth.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";

import {
  allowedOrigin,
  createIpRateLimiter,
  extractBearerToken,
  extractClientIp,
  getAdminConfig,
  isAdminExportEnabled,
  verifyAdminToken
} from "../admin-auth.js";

const TOKEN = "test-admin-token-0123456789abcdef";
const TOKEN_SHA256 = crypto.createHash("sha256").update(TOKEN, "utf8").digest("hex");

test("verifyAdminToken: 正确令牌通过、错误令牌拒绝", () => {
  process.env.EXPORT_ADMIN_TOKEN_SHA256 = TOKEN_SHA256;
  try {
    assert.equal(verifyAdminToken(TOKEN), true);
    assert.equal(verifyAdminToken("wrong-token"), false);
    assert.equal(verifyAdminToken(""), false);
    assert.equal(verifyAdminToken(undefined), false);
    assert.equal(verifyAdminToken(null), false);
    assert.equal(verifyAdminToken("x".repeat(2000)), false);
  } finally {
    delete process.env.EXPORT_ADMIN_TOKEN_SHA256;
  }
});

test("verifyAdminToken: 摘要未配置或长度错误时拒绝服务", () => {
  delete process.env.EXPORT_ADMIN_TOKEN_SHA256;
  assert.equal(verifyAdminToken(TOKEN), false, "未配置摘要 → false");

  process.env.EXPORT_ADMIN_TOKEN_SHA256 = "abc"; // 长度不足 64
  try {
    assert.equal(verifyAdminToken(TOKEN), false);
  } finally {
    delete process.env.EXPORT_ADMIN_TOKEN_SHA256;
  }
});

test("verifyAdminToken: 大写十六进制摘要同样有效", () => {
  process.env.EXPORT_ADMIN_TOKEN_SHA256 = TOKEN_SHA256.toUpperCase();
  try {
    assert.equal(verifyAdminToken(TOKEN), true);
  } finally {
    delete process.env.EXPORT_ADMIN_TOKEN_SHA256;
  }
});

test("isAdminExportEnabled: 只有精确 'true' 才启用", () => {
  process.env.EXPORT_ADMIN_ENABLED = "true";
  try {
    assert.equal(isAdminExportEnabled(), true);
  } finally {
    delete process.env.EXPORT_ADMIN_ENABLED;
  }
  process.env.EXPORT_ADMIN_ENABLED = "TRUE";
  assert.equal(isAdminExportEnabled(), false);
  process.env.EXPORT_ADMIN_ENABLED = "1";
  assert.equal(isAdminExportEnabled(), false);
  delete process.env.EXPORT_ADMIN_ENABLED;
  assert.equal(isAdminExportEnabled(), false, "默认关闭");
});

test("getAdminConfig: 上限与时区默认值", () => {
  delete process.env.EXPORT_MAX_SESSIONS;
  delete process.env.EXPORT_MAX_EVENTS;
  delete process.env.EXPORT_TIME_ZONE;
  const config = getAdminConfig();
  assert.equal(config.maxSessions, 5000);
  assert.equal(config.maxEvents, 100000);
  assert.equal(config.timeZone, "Asia/Shanghai");
});

test("allowedOrigin: 允许列表、拒绝列表与缺失 Origin", () => {
  const req = (origin) => ({ headers: origin ? { origin } : {} });
  assert.equal(allowedOrigin(req("https://experiments.top")), true);
  assert.equal(allowedOrigin(req("http://localhost:5173")), true);
  assert.equal(allowedOrigin(req("https://evil.example")), false);
  assert.equal(allowedOrigin(req(undefined)), true, "无 Origin（curl/同源导航）放行");
});

test("extractBearerToken: 只接受 Bearer 前缀", () => {
  const req = (value) => ({ headers: value !== undefined ? { authorization: value } : {} });
  assert.equal(extractBearerToken(req("Bearer abc123")), "abc123");
  assert.equal(extractBearerToken(req("bearer abc")), "", "大小写敏感");
  assert.equal(extractBearerToken(req("Basic abc")), "");
  assert.equal(extractBearerToken(req(undefined)), "");
});

test("extractClientIp: 不信任 X-Forwarded-For，只使用 req.ip / socket 地址", () => {
  // 伪造链首 XFF 一律被忽略：优先使用 Express 计算的 req.ip。
  assert.equal(
    extractClientIp({
      ip: "203.0.113.7",
      headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" },
      socket: { remoteAddress: "10.0.0.9" }
    }),
    "203.0.113.7"
  );
  // req.ip 缺失（非 Express 上下文）时回退到 socket 地址。
  assert.equal(
    extractClientIp({ headers: { "x-forwarded-for": "6.6.6.6" }, socket: { remoteAddress: "10.0.0.9" } }),
    "10.0.0.9"
  );
  assert.equal(extractClientIp({ headers: {}, socket: {} }), "");
});


test("createIpRateLimiter: 伪造 X-Forwarded-For 无法改变限流桶", () => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, max: 2 });
  const calls = [];
  // 同一真实客户端不断改变伪造的链首 XFF，仍落入同一个桶：
  // req.ip 由 Express 根据 trust proxy 计算（本机代理之外不可伪造），XFF 头被忽略。
  const forgedXff = ["1.1.1.1", "2.2.2.2", "3.3.3.3"];
  const makeReq = (xff) => ({
    ip: "10.0.0.1", // 信任 IP 恒定（攻击者无法通过请求头改变）
    headers: { "x-forwarded-for": `${xff}, 9.9.9.9` },
    socket: { remoteAddress: "10.0.0.1" }
  });
  const res = {
    set() {},
    status(code) {
      calls.push(code);
      return this;
    },
    json() {
      return this;
    }
  };
  for (const xff of forgedXff) {
    limiter(makeReq(xff), res, () => calls.push("next"));
  }
  assert.deepEqual(calls, ["next", "next", 429], "第三次必须命中同一 IP 的桶");

  // 非 Express 上下文（无 req.ip）：回退 socket 地址，同样与 XFF 头无关。
  const limiter2 = createIpRateLimiter({ windowMs: 60_000, max: 1 });
  const calls2 = [];
  const res2 = {
    set() {},
    status(code) {
      calls2.push(code);
      return this;
    },
    json() {
      return this;
    }
  };
  limiter2(
    { headers: { "x-forwarded-for": "7.7.7.7" }, socket: { remoteAddress: "10.0.0.2" } },
    res2,
    () => calls2.push("next")
  );
  limiter2(
    { headers: { "x-forwarded-for": "8.8.8.8" }, socket: { remoteAddress: "10.0.0.2" } },
    res2,
    () => calls2.push("next")
  );
  assert.deepEqual(calls2, ["next", 429]);
});

test("createIpRateLimiter: 不同可信客户端 IP 互不影响", () => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, max: 1 });
  const results = [];
  const make = (ip) => ({
    req: { ip, headers: {}, socket: { remoteAddress: ip } },
    res: {
      set() {},
      status(code) {
        results.push(code);
        return this;
      },
      json() {
        return this;
      }
    }
  });

  const a = make("10.0.0.1");
  const b = make("10.0.0.2");
  limiter(a.req, a.res, () => results.push("next-a1"));
  limiter(b.req, b.res, () => results.push("next-b1"));
  limiter(a.req, a.res, () => results.push("next-a2"));
  assert.deepEqual(results, ["next-a1", "next-b1", 429]);
});
