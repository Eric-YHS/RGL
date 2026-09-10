// server/test/admin-export-api.test.js
// 端到端 API 测试：认证、筛选预览、XLSX 下载、限流与上限。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
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

test("8 月 7 日全天范围预览：左闭右开边界（42–50 + 边界内 60，排除 61）", async () => {
  const res = await get(
    "/api/admin/export/sessions?from=2026-08-07T04:00:00.000Z&to=2026-08-07T16:00:00.000Z&page=1&pageSize=50"
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 10);
  assert.equal(body.pageSize, 50);
  const ids = body.items.map((item) => item.id);
  assert.deepEqual(ids.slice(0, 9), [42, 43, 44, 45, 46, 47, 48, 49, 50]);
  assert.ok(ids.includes(60), "边界内 60（04:00:00Z 属于 [04:00, 16:00)）");
  assert.ok(!ids.includes(61), "边界外 61（16:00:00Z 不属于 [04:00, 16:00)）");
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

test("ids 模式导出：响应头、文件名与固定四张表内容（旧参数被忽略）", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42, 44] },
    // 旧页面遗留参数：可接收但必须被忽略，不能改变实际结果。
    sheets: ["summary"],
    includeSensitive: false,
    includeChinaTime: false
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
  // 固定四张表，顺序严格一致，不存在“导出说明”。
  assert.deepEqual(wb.SheetNames, ["会话数据", "事件明细", "通行按键", "闯红灯记录"]);
  assert.equal(wb.Sheets["导出说明"], undefined, "不得再生成导出说明");

  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((row) => row["会话ID"]), [42, 44]);
  // 固定包含北京时间和敏感技术字段。
  assert.equal(sessions[0]["开始时间_北京时间"], "2026-08-07 12:00:29");
  assert.equal(sessions[0]["IP地址"], "1.2.3.4");
  assert.equal(sessions[0]["浏览器标识_原文"], "Mozilla/5.0 (iPhone) AppleWebKit");
  assert.equal(sessions[0]["时区"], "中国标准时间(UTC+8)");

  const events = XLSX.utils.sheet_to_json(wb.Sheets["事件明细"], { defval: "" });
  assert.equal(events.length, 8);

  const walks = XLSX.utils.sheet_to_json(wb.Sheets["通行按键"], { defval: "" });
  assert.equal(walks.length, 2);

  const violations = XLSX.utils.sheet_to_json(wb.Sheets["闯红灯记录"], { defval: "" });
  assert.equal(violations.length, 1);
});

test("ids 模式：全部 ID 存在才成功，缺任一即 404 且不生成部分工作簿", async () => {
  // 全部存在：正好导出两个会话。
  const ok = await postXlsx({
    selection: { mode: "ids", sessionIds: [42, 44] },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(ok.status, 200);
  const wb = XLSX.read(Buffer.from(await ok.arrayBuffer()), { type: "buffer" });
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.deepEqual(sessions.map((row) => row["会话ID"]), [42, 44]);

  // 部分缺失：不能静默漏导，响应不是 XLSX。
  const partial = await postXlsx({
    selection: { mode: "ids", sessionIds: [42, 999999] },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(partial.status, 404);
  assert.match(partial.headers.get("content-type") ?? "", /application\/json/);
  const partialBody = await partial.json();
  assert.match(partialBody.error, /会话不存在/);

  // 全部缺失：同样 404。
  const missing = await postXlsx({
    selection: { mode: "ids", sessionIds: [999998, 999999] },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(missing.status, 404);
});

test("ids 模式：重复 ID 在参数校验阶段返回 400", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42, 42] },
    sheets: ["sessions"],
    includeSensitive: false,
    includeChinaTime: true
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /duplicates/);
});

test("ids 模式：空数组与非法 ID 返回 400（严格类型校验，不生成工作簿）", async () => {
  // 覆盖：数字字符串、前导零、小数形态字符串、普通字符串、布尔、null、小数、零、负数。
  for (const sessionIds of [
    [],
    [0],
    [-1],
    [1.5],
    ["abc"],
    ["42"],
    ["0042"],
    ["42.0"],
    [true],
    [false],
    [null]
  ]) {
    const res = await postXlsx({
      selection: { mode: "ids", sessionIds },
      sheets: ["sessions"],
      includeSensitive: false,
      includeChinaTime: true
    });
    assert.equal(res.status, 400, JSON.stringify(sessionIds));
    // 必须返回 JSON 错误体而不是 XLSX：证明未生成部分工作簿。
    assert.match(
      res.headers.get("content-type") ?? "",
      /application\/json/,
      `content-type 必须是 JSON: ${JSON.stringify(sessionIds)}`
    );
    const body = await res.json();
    assert.equal(body.ok, false, JSON.stringify(sessionIds));
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

test("filters 模式：8 月 7 日下午真实九样本批次导出 42–50 共 9 个", async () => {
  const res = await postXlsx({
    selection: {
      mode: "filters",
      filters: {
        // 北京时间范围覆盖该批次（12:00–24:00），配合会话 ID 区间排除边界会话 60/61；
        // 不额外使用 runKind，避免排除练习样本 43/46/48。
        from: "2026-08-07T04:00:00.000Z",
        to: "2026-08-07T16:00:00.000Z",
        minSessionId: 42,
        maxSessionId: 50
      }
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
    [42, 43, 44, 45, 46, 47, 48, 49, 50],
    "真实九样本批次必须恰好为 42–50 共 9 个"
  );
  assert.equal(sessions.length, 9);
});

test("敏感技术字段固定包含：includeSensitive=false 也不移除", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42] },
    includeSensitive: false
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.equal(sessions[0]["IP地址"], "1.2.3.4");
  assert.equal(sessions[0]["浏览器标识_原文"], "Mozilla/5.0 (iPhone) AppleWebKit");
  assert.equal(sessions[0]["时区"], "中国标准时间(UTC+8)");
});

test("北京时间列固定包含：includeChinaTime=false 也不移除", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42] },
    includeChinaTime: false
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
  assert.equal(sessions[0]["开始时间_北京时间"], "2026-08-07 12:00:29");
  assert.equal(sessions[0]["提交时间_北京时间"], "2026-08-07 12:07:40");
});

test("sheets 旧参数被忽略：固定输出四张表且无导出说明", async () => {
  const res = await postXlsx({
    selection: { mode: "ids", sessionIds: [42] },
    sheets: ["violations"]
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  assert.deepEqual(wb.SheetNames, ["会话数据", "事件明细", "通行按键", "闯红灯记录"]);
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

// ---------------------------------------------------------------------------
// 安全：守卫顺序、IP 信任、审计日志
// ---------------------------------------------------------------------------

/** 启动一个独立 tiny 服务（环境变量在创建 router 时读取）。 */
async function startTinyApp(dbOptions = {}) {
  const tiny = createTestDb(dbOptions);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/admin/export", createAdminExportRouter({ db: tiny.db }));
  const tinyServer = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  return {
    db: tiny.db,
    dir: tiny.dir,
    base: `http://127.0.0.1:${tinyServer.address().port}`,
    close() {
      tinyServer.close();
      closeTestDb(tiny);
    }
  };
}

test("功能关闭时超过各接口限流阈值仍全部返回 404", async () => {
  process.env.EXPORT_ADMIN_ENABLED = "false";
  process.env.EXPORT_VERIFY_MAX_PER_10MIN = "1";
  process.env.EXPORT_PREVIEW_MAX_PER_MIN = "1";
  process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "1";
  const tiny = await startTinyApp();
  try {
    for (let i = 0; i < 5; i += 1) {
      const statusRes = await fetch(`${tiny.base}/api/admin/export/status`);
      assert.equal(statusRes.status, 404, `status 第 ${i + 1} 次必须仍是 404`);
      const sessionsRes = await fetch(`${tiny.base}/api/admin/export/sessions`);
      assert.equal(sessionsRes.status, 404, `sessions 第 ${i + 1} 次必须仍是 404`);
      const xlsxRes = await fetch(`${tiny.base}/api/admin/export/xlsx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection: { mode: "ids", sessionIds: [42] } })
      });
      assert.equal(xlsxRes.status, 404, `xlsx 第 ${i + 1} 次必须仍是 404`);
      const delRes = await fetch(`${tiny.base}/api/admin/export/sessions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: [42] })
      });
      assert.equal(delRes.status, 404, `delete 第 ${i + 1} 次必须仍是 404`);
    }
  } finally {
    tiny.close();
    process.env.EXPORT_ADMIN_ENABLED = "true";
    process.env.EXPORT_VERIFY_MAX_PER_10MIN = "100";
    process.env.EXPORT_PREVIEW_MAX_PER_MIN = "1000";
    process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "100";
  }
});

test("/sessions 预览限流在令牌校验前执行：错误令牌也不能无限尝试", async () => {
  process.env.EXPORT_PREVIEW_MAX_PER_MIN = "2";
  const tiny = await startTinyApp();
  try {
    const url = `${tiny.base}/api/admin/export/sessions`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url)).status, 429);
  } finally {
    tiny.close();
    process.env.EXPORT_PREVIEW_MAX_PER_MIN = "1000";
  }
});

test("伪造 X-Forwarded-For 链首不能绕过每 IP 限流（状态/预览/下载）", async () => {
  process.env.EXPORT_VERIFY_MAX_PER_10MIN = "2";
  process.env.EXPORT_PREVIEW_MAX_PER_MIN = "2";
  process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "2";
  const tiny = await startTinyApp();
  try {
    const forgedValues = ["6.6.6.1", "6.6.6.2", "6.6.6.3", "6.6.6.4"];

    // 同一真实客户端不断改变伪造 XFF，/status 仍在第 3 次被 429。
    for (let i = 0; i < forgedValues.length; i += 1) {
      const res = await fetch(`${tiny.base}/api/admin/export/status`, {
        headers: { "X-Forwarded-For": `${forgedValues[i]}, 1.2.3.4` }
      });
      assert.equal(res.status, i < 2 ? 401 : 429, `/status 第 ${i + 1} 次`);
    }

    // /sessions：错误令牌 + 伪造 XFF，仍按同一桶限流。
    for (let i = 0; i < forgedValues.length; i += 1) {
      const res = await fetch(`${tiny.base}/api/admin/export/sessions`, {
        headers: { "X-Forwarded-For": `${forgedValues[i]}, 1.2.3.4` }
      });
      assert.equal(res.status, i < 2 ? 401 : 429, `/sessions 第 ${i + 1} 次`);
    }

    // /xlsx：正确令牌 + 伪造 XFF，下载限流同样不可绕过。
    const payload = {
      selection: { mode: "ids", sessionIds: [42] },
      sheets: ["sessions"],
      includeSensitive: false,
      includeChinaTime: true
    };
    for (let i = 0; i < forgedValues.length; i += 1) {
      const res = await fetch(`${tiny.base}/api/admin/export/xlsx`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          "X-Forwarded-For": `${forgedValues[i]}, 1.2.3.4`
        },
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, i < 2 ? 200 : 429, `/xlsx 第 ${i + 1} 次`);
    }
    // /sessions DELETE：正确令牌 + 伪造 XFF，删除限流同样不可绕过（独立实例重新计桶）。
    const delTiny = await startTinyApp();
    try {
      for (let i = 0; i < forgedValues.length; i += 1) {
        const res = await fetch(`${delTiny.base}/api/admin/export/sessions`, {
          method: "DELETE",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
            "X-Forwarded-For": `${forgedValues[i]}, 1.2.3.4`
          },
          body: JSON.stringify({ sessionIds: [42 + i * 2] })
        });
        assert.equal(res.status, i < 2 ? 200 : 429, `DELETE 第 ${i + 1} 次`);
      }
    } finally {
      delTiny.close();
    }
  } finally {
    tiny.close();
    process.env.EXPORT_VERIFY_MAX_PER_10MIN = "100";
    process.env.EXPORT_PREVIEW_MAX_PER_MIN = "1000";
    process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "100";
  }
});

test("/xlsx 下载限流在令牌校验前执行：错误令牌 401、401、429", async () => {
  process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "2";
  const tiny = await startTinyApp();
  try {
    // 结构合法的导出请求，但三次都使用同一个错误 Bearer 令牌。
    const payload = {
      selection: { mode: "ids", sessionIds: [42] },
      sheets: ["sessions"],
      includeSensitive: false,
      includeChinaTime: true
    };
    const wrongHeaders = {
      Authorization: "Bearer wrong-token-for-download-limit",
      "Content-Type": "application/json"
    };
    const url = `${tiny.base}/api/admin/export/xlsx`;
    const send = () =>
      fetch(url, { method: "POST", headers: wrongHeaders, body: JSON.stringify(payload) });

    // 限流在令牌校验之前执行：错误令牌也消耗下载额度。
    assert.equal((await send()).status, 401, "第一次：错误令牌被拒");
    assert.equal((await send()).status, 401, "第二次：错误令牌被拒");

    const third = await send();
    assert.equal(third.status, 429, "第三次：达到下载限流阈值");

    // 429 响应体符合统一约定。
    const body = await third.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "Too many requests");

    // Retry-After 必须是有效正数。
    const retryAfter = Number(third.headers.get("retry-after"));
    assert.ok(
      Number.isInteger(retryAfter) && retryAfter > 0,
      `Retry-After 必须有效，实际: ${third.headers.get("retry-after")}`
    );

    // 安全头与 401/403/404/429 约定一致。
    assert.match(third.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(third.headers.get("pragma"), "no-cache");
    assert.equal(third.headers.get("x-content-type-options"), "nosniff");
  } finally {
    tiny.close();
    process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "100";
  }
});

test("审计日志：IP 与限流一致，且不出现令牌或 Authorization 头", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    const res = await postXlsx(
      {
        selection: { mode: "ids", sessionIds: [42] },
        sheets: ["sessions"],
        includeSensitive: false,
        includeChinaTime: true
      },
      { ...authHeaders, "X-Forwarded-For": "6.6.6.6, 1.2.3.4" }
    );
    assert.equal(res.status, 200);
  } finally {
    console.log = originalLog;
  }

  const auditLine = logs.find((line) => line.includes('"audit":"admin-export"'));
  assert.ok(auditLine, "必须产生审计日志");
  const entry = JSON.parse(auditLine);
  // 测试应用未开启 trust proxy，req.ip = 套接字地址（伪造 XFF 不影响）。
  assert.equal(entry.ipAddress, "127.0.0.1");
  assert.ok(!auditLine.includes(TOKEN), "日志不得出现令牌");
  assert.ok(!/authorization/i.test(auditLine), "日志不得出现 Authorization 头");
});

// ---------------------------------------------------------------------------
// 会话删除（DELETE /sessions）
// ---------------------------------------------------------------------------

function countSessionsAndEvents(db) {
  return {
    sessions: db.prepare("SELECT COUNT(*) AS total FROM sessions").get().total,
    events: db.prepare("SELECT COUNT(*) AS total FROM events").get().total
  };
}

async function delSessions(tinyBase, sessionIds, headers = {}) {
  return fetch(`${tinyBase}/api/admin/export/sessions`, {
    method: "DELETE",
    headers: { ...authHeaders, ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionIds })
  });
}

test("删除单个会话成功：关联事件级联删除，其它会话不变", async () => {
  const tiny = await startTinyApp();
  try {
    const before = countSessionsAndEvents(tiny.db);
    const res = await delSessions(tiny.base, [44]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, deletedSessions: 1, deletedEvents: 2 });
    const after = countSessionsAndEvents(tiny.db);
    assert.equal(after.sessions, before.sessions - 1);
    assert.equal(after.events, before.events - 2);
    assert.equal(
      tiny.db.prepare("SELECT COUNT(*) AS total FROM events WHERE session_id = 44").get().total,
      0
    );
    // 未选会话及其事件不变。
    assert.equal(tiny.db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = 42").get().total, 1);
    assert.equal(tiny.db.prepare("SELECT COUNT(*) AS total FROM events WHERE session_id = 42").get().total, 6);
  } finally {
    tiny.close();
  }
});

test("删除多个会话成功：批量删除并返回关联事件总数", async () => {
  const tiny = await startTinyApp();
  try {
    const res = await delSessions(tiny.base, [42, 46, 49]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, deletedSessions: 3, deletedEvents: 11 });
    for (const id of [42, 46, 49]) {
      assert.equal(tiny.db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = ?").get(id).total, 0);
      assert.equal(tiny.db.prepare("SELECT COUNT(*) AS total FROM events WHERE session_id = ?").get(id).total, 0);
    }
  } finally {
    tiny.close();
  }
});

test("请求中混入不存在 ID：返回 404 且数据库完全不变", async () => {
  const tiny = await startTinyApp();
  try {
    const snapshot = countSessionsAndEvents(tiny.db);
    const res = await delSessions(tiny.base, [42, 999999]);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /不存在/);
    // 响应不暴露具体缺失 ID。
    assert.ok(!JSON.stringify(body).includes("999999"));
    assert.deepEqual(countSessionsAndEvents(tiny.db), snapshot);
    assert.equal(tiny.db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = 42").get().total, 1);
  } finally {
    tiny.close();
  }
});

test("空数组、非法 ID、重复 ID 返回 400 且数据库不变", async () => {
  const tiny = await startTinyApp();
  try {
    // 覆盖：数字字符串、前导零、小数形态字符串、普通字符串、布尔、null、小数、零、负数、重复 ID。
    for (const sessionIds of [
      [],
      [0],
      [-1],
      [1.5],
      ["abc"],
      ["42"],
      ["0042"],
      ["42.0"],
      [true],
      [false],
      [null],
      [42, 42]
    ]) {
      const snapshot = countSessionsAndEvents(tiny.db);
      const res = await delSessions(tiny.base, sessionIds);
      assert.equal(res.status, 400, JSON.stringify(sessionIds));
      const body = await res.json();
      assert.equal(body.ok, false);
      // 会话总数与事件总数完全不变。
      assert.deepEqual(countSessionsAndEvents(tiny.db), snapshot, JSON.stringify(sessionIds));
      // 会话 42 及其关联事件仍存在，证明没有发生任何删除。
      assert.equal(
        tiny.db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = 42").get().total,
        1,
        JSON.stringify(sessionIds)
      );
      assert.equal(
        tiny.db.prepare("SELECT COUNT(*) AS total FROM events WHERE session_id = 42").get().total,
        6,
        JSON.stringify(sessionIds)
      );
    }
  } finally {
    tiny.close();
  }
});

test("超过数量上限返回 413", async () => {
  process.env.EXPORT_MAX_SESSIONS = "3";
  const tiny = await startTinyApp();
  try {
    const res = await delSessions(tiny.base, [42, 44, 46, 48]);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error, /exceeds maximum/);
    assert.deepEqual(countSessionsAndEvents(tiny.db), { sessions: 17, events: 15 });
  } finally {
    tiny.close();
    process.env.EXPORT_MAX_SESSIONS = "5000";
  }
});

test("外键未开启时删除返回 500 且数据不变", async () => {
  const tiny = await startTinyApp({ foreignKeys: false });
  try {
    const snapshot = countSessionsAndEvents(tiny.db);
    const res = await delSessions(tiny.base, [42]);
    assert.equal(res.status, 500);
    assert.deepEqual(countSessionsAndEvents(tiny.db), snapshot);
    assert.equal(tiny.db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = 42").get().total, 1);
  } finally {
    tiny.close();
  }
});

test("删除事务中发生异常时完整回滚", async () => {
  const tiny = createTestDb();
  const dbPath = path.join(tiny.dir, "test.db");
  tiny.db.close();
  // 只读连接：外键检查通过后 DELETE 写入失败，事务必须完整回滚（不产生部分删除）。
  const readonlyDb = new Database(dbPath, { readonly: true });
  readonlyDb.pragma("foreign_keys = ON");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/admin/export", createAdminExportRouter({ db: readonlyDb }));
  const srv = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await delSessions(base, [42]);
    assert.equal(res.status, 500);
  } finally {
    srv.close();
    readonlyDb.close();
  }
  // 重新打开数据库确认没有发生部分删除。
  const checkDb = new Database(dbPath, { readonly: true });
  try {
    assert.equal(checkDb.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = 42").get().total, 1);
    assert.equal(checkDb.prepare("SELECT COUNT(*) AS total FROM events WHERE session_id = 42").get().total, 6);
  } finally {
    checkDb.close();
    fs.rmSync(tiny.dir, { recursive: true, force: true });
  }
});

test("删除接口鉴权：错误 Origin 返回 403，错误令牌返回 401", async () => {
  const tiny = await startTinyApp();
  try {
    const badOrigin = await delSessions(tiny.base, [42], { Origin: "https://evil.example" });
    assert.equal(badOrigin.status, 403);
    const badToken = await fetch(`${tiny.base}/api/admin/export/sessions`, {
      method: "DELETE",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: [42] })
    });
    assert.equal(badToken.status, 401);
  } finally {
    tiny.close();
  }
});

test("删除与下载共享限流：超出返回 429", async () => {
  process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "2";
  const tiny = await startTinyApp();
  try {
    const xlsx = () =>
      fetch(`${tiny.base}/api/admin/export/xlsx`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ selection: { mode: "ids", sessionIds: [46] } })
      });
    assert.equal((await delSessions(tiny.base, [42])).status, 200);
    assert.equal((await xlsx()).status, 200);
    assert.equal((await delSessions(tiny.base, [44])).status, 429);
    const res = await xlsx();
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "Too many requests");
    assert.ok(Number(res.headers.get("retry-after")) > 0, "Retry-After 必须有效");
  } finally {
    tiny.close();
    process.env.EXPORT_DOWNLOAD_MAX_PER_10MIN = "100";
  }
});

test("删除审计日志：含操作类型与计数，不含令牌或敏感字段", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  const tiny = await startTinyApp();
  try {
    const res = await delSessions(tiny.base, [42, 44], { "X-Forwarded-For": "6.6.6.6, 1.2.3.4" });
    assert.equal(res.status, 200);
  } finally {
    tiny.close();
    console.log = originalLog;
  }

  const auditLine = logs.find((line) => line.includes('"operation":"delete-sessions"'));
  assert.ok(auditLine, "必须产生删除审计日志");
  const entry = JSON.parse(auditLine);
  assert.equal(entry.ok, true);
  assert.equal(entry.requestedCount, 2);
  assert.equal(entry.foundCount, 2);
  assert.equal(entry.deletedSessions, 2);
  assert.equal(entry.deletedEvents, 8);
  // 测试应用未开启 trust proxy，req.ip = 套接字地址（伪造 XFF 不影响）。
  assert.equal(entry.ipAddress, "127.0.0.1");
  assert.ok(!auditLine.includes(TOKEN), "日志不得出现令牌");
  assert.ok(!/authorization/i.test(auditLine), "日志不得出现 Authorization 头");
  assert.ok(!auditLine.includes("Mozilla"), "日志不得出现浏览器标识等敏感字段");
});

test("正常路径保护：数字 [42] 导出与删除均返回 200", async () => {
  const tiny = await startTinyApp();
  try {
    // 真正的 JSON number 仍可用于 ids 模式导出并返回 200。
    const xlsx = await fetch(`${tiny.base}/api/admin/export/xlsx`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { mode: "ids", sessionIds: [42] } })
    });
    assert.equal(xlsx.status, 200);
    assert.match(
      xlsx.headers.get("content-type") ?? "",
      /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
    );
    const wb = XLSX.read(Buffer.from(await xlsx.arrayBuffer()), { type: "buffer" });
    const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
    assert.deepEqual(sessions.map((row) => row["会话ID"]), [42]);

    // 真正的 JSON number 仍可用于删除接口并返回 200。
    const del = await delSessions(tiny.base, [42]);
    assert.equal(del.status, 200);
    const delBody = await del.json();
    assert.equal(delBody.ok, true);
    assert.equal(delBody.deletedSessions, 1);
    assert.equal(
      tiny.db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE id = 42").get().total,
      0
    );
  } finally {
    tiny.close();
  }
});

test("删除后预览总数减少，再次导出不包含已删除会话", async () => {
  const tiny = await startTinyApp();
  try {
    const before = await fetch(`${tiny.base}/api/admin/export/sessions?pageSize=50`, {
      headers: authHeaders
    });
    const beforeBody = await before.json();
    const totalBefore = beforeBody.total;

    const del = await delSessions(tiny.base, [42]);
    assert.equal(del.status, 200);

    const after = await fetch(`${tiny.base}/api/admin/export/sessions?pageSize=50`, {
      headers: authHeaders
    });
    const afterBody = await after.json();
    assert.equal(afterBody.total, totalBefore - 1);
    assert.ok(!afterBody.items.some((item) => item.id === 42));

    const xlsx = await fetch(`${tiny.base}/api/admin/export/xlsx`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { mode: "filters", filters: {} } })
    });
    assert.equal(xlsx.status, 200);
    const wb = XLSX.read(Buffer.from(await xlsx.arrayBuffer()), { type: "buffer" });
    const sessions = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
    assert.ok(!sessions.some((row) => row["会话ID"] === 42));
  } finally {
    tiny.close();
  }
});
