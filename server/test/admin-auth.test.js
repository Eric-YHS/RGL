// server/test/admin-auth.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";

import {
  allowedOrigin,
  createIpRateLimiter,
  extractBearerToken,
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

test("createIpRateLimiter: 超过上限返回 429", () => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, max: 2 });
  const calls = [];
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
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

  limiter(req, res, () => calls.push("next"));
  limiter(req, res, () => calls.push("next"));
  limiter(req, res, () => calls.push("next"));

  assert.deepEqual(calls, ["next", "next", 429]);
});

test("createIpRateLimiter: 不同 IP 互不影响", () => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, max: 1 });
  const results = [];
  const make = (ip) => ({
    req: { headers: {}, socket: { remoteAddress: ip } },
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
