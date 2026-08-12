// server/test/admin-export-api.test.js
// 端到端 API 测试：认证、筛选预览、XLSX 下载、限流与上限。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";

import express from "express";
import XLSX from "xlsx";

import { createAdminExportRouter } from "../admin-export-routes.js";
import { closeTestDb, createTestDb } from "./helpers.js";

const TOKEN = "api-test-token-0123456789abcdef";
const TOKEN_SHA256 = crypto.createHash("sha256").update(TOKEN, "utf8").digest("hex");

const envSnapshot = { ...process.env };
let testDb;
let server;
let base;

before(async () => {
  process.env.EXPORT_ADMIN_ENABLED = "true";
  process.env.EXPORT_ADMIN_TOKEN_SHA256 = TOKEN_SHA256;
  process.env.EXPORT_MAX_SESSIONS = "5000";
  process.env.EXPORT_MAX_EVENTS = "100000";
  process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "100";
  process.env.EXPORT_PREVIEW_MAX_PER_MIN = "1000";
  process.env.EXPORT_VERIFY_MAX_PER_10MIN = "100";

  testDb = createTestDb();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/admin/export", createAdminExportRouter({ db: testDb.db }));

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
  if (server) server.close();
  if (testDb) closeTestDb(testDb);
});

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

async function get(path, headers = authHeaders) {
  return fetch(`${base}${path}`, { headers });
}

async function postXlsx(body, headers = authHeaders) {
  return fetch(`${base}/api/admin/export/xlsx`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

test("未启用时管理 API 返回 404", async () => {
  process.env.EXPORT_ADMIN_ENABLED = "false";
  try {
    const res = await get("/api/admin/export/status");
    assert.equal(res.status, 404);
  } finally {
    process.env.EXPORT_ADMIN_ENABLED = "true";
  }
});

test("无令牌与错误令牌均返回 401（不泄露差异）", async () => {
  const noToken = await get("/api/admin/export/status", {});
  assert.equal(noToken.status, 401);
  const wrongToken = await get("/api/admin/export/status", {
    Authorization: "Bearer wrong-token"
  });
  assert.equal(wrongToken.status, 401);
  const body = await wrongToken.json();
  assert.equal(body.error, "Unauthorized");
});

test("正确令牌可以获取状态", async () => {
  const res = await get("/api/admin/export/status");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.timeZone, "Asia/Shanghai");
  assert.equal(body.maxSessions, 5000);
  assert.equal(body.maxEvents, 100000);
  const cache = res.headers.get("cache-control");
  assert.match(cache ?? "", /no-store/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("不允许的 Origin 返回 403", async () => {
  const res = await fetch(`${base}/api/admin/export/status`, {
    headers: { ...authHeaders, Origin: "https://evil.example" }
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// 会话预览
// ---------------------------------------------------------------------------

test("预览参数校验：400", async () => {
  const cases = [
    "/api/admin/export/sessions?from=2026-08-07T04:00:00.000Z",
    "/api/admin/export/sessions?from=2026-08-08T00:00:00.000Z&to=2026-08-07T00:00:00.000Z",
    "/api/admin/export/sessions?from=oops&to=2026-08-08T00:00:00.000Z",
    "/api/admin/export/sessions?pageSize=33",
    "/api/admin/export/sessions?page=0",
    "/api/admin/export/sessions?minSessionId=0",
    "/api/admin/export/sessions?minSessionId=9&maxSessionId=3",
    "/api/admin/export/sessions?runKind=bogus"
  ];
  for (const path of cases) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
  }
});

test("8 月 7 日全天范围预览：命中 10 条（42–50 + 边界内 60）", async () => {
  const res = await get(
    "/api/admin/export/sessions?from=2026-08-07T04:00:00.000Z&to=2026-08-07T16:00:00.000Z&page=1&pageSize=50"
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 10);
  assert.equal(body.pageSize, 50);
  const ids = body.items.map((item) => item.id);
  assert.deepEqual(ids.slice(0, 9), [42, 43, 44, 45, 46, 47, 48, 49, 50]);
  assert.equal(body.items[0].startedAtChina, "2026-08-07 12:00:29");
  assert.equal(body.items[0].submittedAtChina, "2026-08-07 12:07:40");
  assert.equal(body.items[0].eventCount, 6);
  assert.equal(body.items[0].runKind, "formal");
  assert.equal(body.items[0].revealMode, "full");
});

test("被试编号 contains 查询只按字面匹配", async () => {
  const res = await get(
    "/api/admin/export/sessions?participant=pct%25&participantMatch=contains&pageSize=50"
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items.map((item) => item.id), [70]);
});

test("筛选 + 分页组合：练习任务", async () => {
  const res = await get(
    "/api/admin/export/sessions?runKind=practice&pageSize=20"
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items.map((item) => item.id), [43, 46, 48]);
});

// ---------------------------------------------------------------------------
// XLSX 下载
// ---------------------------------------------------------------------------

test("ids 模式导出：响应头、文件名与内容", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42, 44] },
    sheets: ["summary", "sessions", "events", "walks", "violations"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-type") ?? "",
    /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
  );
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename\*=UTF-8''honglvdeng_20260807_1200_to_20260807_1226_2_sessions\.xlsx$/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);

  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  assert.deepEqual(wb.SheetNames, ["导出说明", "会话数据", "事件明细", "通行按键", "闯红灯记录"]);

  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((row) => row["会话ID"]), [42, 44]);
  assert.equal(sessions[0]["开始时间_北京时间"], "2026-08-07 12:00:29");
  assert.ok(!("IP地址" in sessions[0]), "默认不含敏感字段");

  const walks = XLSX.utils.sheet_to_json(wb.Sheets["通行按键"], { defval: "" });
  assert.equal(walks.length, 2);

  const summary = XLSX.utils.sheet_to_json(wb.Sheets["导出说明"], { header: 1, defval: "" });
  const summaryMap = new Map(summary.map((row) => [row[0], row[1]]));
  assert.equal(summaryMap.get("会话数"), 2);
  assert.equal(summaryMap.get("包含敏感技术字段"), "否");
});

test("ids 模式：勾选不存在的会话返回 404", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [999999] },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(res.status, 404);
});

test("ids 模式：空数组与非法 ID 返回 400", async () => {
  for (const sessionIds of [[], [0], [1.5], ["abc"]]) {
    const res = await postXlsx({
      selection: { mode: "ids", sessionIds },
      sheets: ["sessions"],
      includeSensitive: false,
      includeChinaTime: true
    });
    assert.equal(res.status, 400, JSON.stringify(sessionIds));
  }
});

test("filters 模式：空结果返回 400", async () => {
  const res = await postXlsx({
    selection: {
      mode: "filters",
      filters: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" }
    },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /没有可导出的会话/);
});

test("filters 模式：8 月 7 日下午批次导出 9 个会话（42–50）", async () => {
  const res = await postXlsx({
    selection: {
      mode: "filters",
      filters: { from: "2026-08-07T04:00:00.000Z", to: "2026-08-07T16:00:00.000Z", runKind: "formal" }
    },
    sheets: ["sessions", "events", "walks", "violations"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.deepEqual(
    sessions.map((row) => row["会话ID"]),
    [42, 44, 45, 47, 49, 50, 60],
    "formal：42,44,45,47,49,50 + 边界内 60"
  );
});

test("includeSensitive=true 时敏感字段出现，false 时不出现", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42] },
    sheets: ["sessions"],
    includeSensitive: true,
    includeChinaTime: true
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.equal(sessions[0]["IP地址"], "1.2.3.4");
  assert.equal(sessions[0]["浏览器标识_原文"], "Mozilla/5.0 (iPhone) AppleWebKit");
  assert.equal(sessions[0]["时区"], "中国标准时间(UTC+8)");
});

test("includeChinaTime=false 时无北京时间列", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42] },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: false
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.ok(!("开始时间_北京时间" in sessions[0]));
});

test("sheets 子集只生成所选工作表", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42] },
    sheets: ["violations"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  assert.deepEqual(wb.SheetNames, ["闯红灯记录"]);
});

test("会话超限返回 413", async () => {
  process.env.EXPORT_MAX_SESSIONS = "5";
  try {
    const res = await postXlsx({
      selection: { mode: "filters", filters: {} },
      sheets: ["sessions"],
      includeSensitive: false,
      includeChinaTime: true
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error, /会话数超过单次导出上限/);
  } finally {
    process.env.EXPORT_MAX_SESSIONS = "5000";
  }
});

test("事件超限返回 413", async () => {
  process.env.EXPORT_MAX_EVENTS = "3";
  try {
    const res = await postXlsx({
      selection: { mode: "ids", sessionIds: [42] },
      sheets: ["sessions", "events"],
      includeSensitive: false,
      includeChinaTime: true
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error, /事件数超过单次导出上限/);
  } finally {
    process.env.EXPORT_MAX_EVENTS = "100000";
  }
});

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

test("下载与验证限流：超出返回 429", async () => {
  const tiny = createTestDb();
  process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "2";
  process.env.EXPORT_VERIFY_MAX_PER_10MIN = "2";
  let tinyServer;
  try {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/admin/export", createAdminExportRouter({ db: tiny.db }));
    const tinyBase = await new Promise((resolve) => {
      tinyServer = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${tinyServer.address().port}`));
    });

    // 验证限流在认证之前生效（无令牌也会消耗额度）。
    const statusUrl = `${tinyBase}/api/admin/export/status`;
    assert.equal((await fetch(statusUrl)).status, 401);
    assert.equal((await fetch(statusUrl)).status, 401);
    assert.equal((await fetch(statusUrl)).status, 429);

    // 下载限流：第 3 次返回 429。
    const payload = {
      selection: { mode: "ids", sessionIds: [42] },
      sheets: ["sessions"],
      includeSensitive: false,
      includeChinaTime: true
    };
    const headers = { ...authHeaders, "Content-Type": "application/json" };
    assert.equal((await fetch(`${tinyBase}/api/admin/export/xlsx`, { method: "POST", headers, body: JSON.stringify(payload) })).status, 200);
    assert.equal((await fetch(`${tinyBase}/api/admin/export/xlsx`, { method: "POST", headers, body: JSON.stringify(payload) })).status, 200);
    assert.equal((await fetch(`${tinyBase}/api/admin/export/xlsx`, { method: "POST", headers, body: JSON.stringify(payload) })).status, 429);
  } finally {
    if (tinyServer) tinyServer.close();
    closeTestDb(tiny);
    process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "100";
    process.env.EXPORT_VERIFY_MAX_PER_10MIN = "100";
  }
});
