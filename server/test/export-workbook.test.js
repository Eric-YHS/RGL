// server/test/export-workbook.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import XLSX from "xlsx";

import { loadExportRows } from "../export/query.js";
import { buildSummaryRows, transformExportRows } from "../export/transform.js";
import { buildWorkbookBuffer, readZipEntries } from "../export/workbook.js";
import { closeTestDb, createTestDb } from "./helpers.js";

function buildData(db, sessionIds, options) {
  const raw = loadExportRows(db, sessionIds);
  const data = transformExportRows(raw, options);
  return {
    data,
    summaryRows: buildSummaryRows({
      exportedAtIso: "2026-08-07T08:00:00.000Z",
      modeText: "导出全部筛选结果",
      filterText: "测试筛选",
      sessionIdsText: "",
      sessionCount: raw.sessions.length,
      eventCount: raw.events.length,
      walkCount: data.walks.rows.length,
      violationCount: data.violations.rows.length,
      firstStartedIso: raw.sessions[0]?.started_at_iso ?? null,
      lastSubmittedIso: raw.sessions[raw.sessions.length - 1]?.submitted_at_iso ?? null,
      includeSensitive: options.includeSensitive
    })
  };
}

test("buildWorkbookBuffer: 工作表名称、行数与数值类型", () => {
  const { db, dir } = createTestDb();
  try {
    const { data, summaryRows } = buildData(
      db,
      [42, 44, 45],
      { includeChinaTime: true, includeSensitive: false }
    );
    const buffer = buildWorkbookBuffer(
      { summaryRows, ...data },
      { sheets: ["summary", "sessions", "events", "walks", "violations"] }
    );
    const wb = XLSX.read(buffer, { type: "buffer" });
    assert.deepEqual(wb.SheetNames, ["导出说明", "会话数据", "事件明细", "通行按键", "闯红灯记录"]);

    const sessionsSheet = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { defval: "" });
    assert.equal(sessionsSheet.length, 3, "表头之外每会话一行");
    assert.equal(typeof sessionsSheet[0]["会话ID"], "number", "数值保持数值类型");
    assert.equal(typeof sessionsSheet[0]["最终金额_元"], "number");

    const eventsSheet = XLSX.utils.sheet_to_json(wb.Sheets["事件明细"], { defval: "" });
    assert.equal(eventsSheet.length, 8, "事件行数 = 8");

    const walksSheet = XLSX.utils.sheet_to_json(wb.Sheets["通行按键"], { defval: "" });
    assert.equal(walksSheet.length, 2, "42 与 44 各有 walk_press（45 无事件）");

    const violationsSheet = XLSX.utils.sheet_to_json(wb.Sheets["闯红灯记录"], { defval: "" });
    assert.equal(violationsSheet.length, 1, "只有 42 有 violation");
    assert.equal(violationsSheet[0]["事件"], "闯红灯");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("buildWorkbookBuffer: 无闯红灯记录时仍保留表头", () => {
  const { db, dir } = createTestDb();
  try {
    const { data, summaryRows } = buildData(
      db,
      [44],
      { includeChinaTime: true, includeSensitive: false }
    );
    const buffer = buildWorkbookBuffer(
      { summaryRows, ...data },
      { sheets: ["sessions", "events", "walks", "violations"] }
    );
    const wb = XLSX.read(buffer, { type: "buffer" });
    const violationsSheet = wb.Sheets["闯红灯记录"];
    const rows = XLSX.utils.sheet_to_json(violationsSheet, { defval: "" });
    assert.equal(rows.length, 0);
    const raw = XLSX.utils.sheet_to_json(violationsSheet, { header: 1, defval: "" });
    assert.equal(raw[0][0], "被试编号", "表头必须存在");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("buildWorkbookBuffer: 冻结表头 pane 已注入", () => {
  const { db, dir } = createTestDb();
  try {
    const { data, summaryRows } = buildData(
      db,
      [42],
      { includeChinaTime: true, includeSensitive: false }
    );
    const buffer = buildWorkbookBuffer(
      { summaryRows, ...data },
      { sheets: ["summary", "sessions", "events", "walks", "violations"] }
    );
    const entries = readZipEntries(buffer);
    for (let i = 1; i <= 5; i += 1) {
      const xml = entries.get(`xl/worksheets/sheet${i}.xml`).data.toString("utf8");
      assert.match(xml, /<pane ySplit="1" topLeftCell="A2"[^>]*state="frozen"\/>/, `sheet${i} 冻结表头`);
    }
    // 打补丁后的 zip 仍可被 xlsx 正常读取。
    const wb = XLSX.read(buffer, { type: "buffer" });
    assert.equal(wb.SheetNames.length, 5);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("buildWorkbookBuffer: 自动筛选与列宽", () => {
  const { db, dir } = createTestDb();
  try {
    const { data, summaryRows } = buildData(
      db,
      [42],
      { includeChinaTime: true, includeSensitive: false }
    );
    const buffer = buildWorkbookBuffer(
      { summaryRows, ...data },
      { sheets: ["sessions"] }
    );
    const wb = XLSX.read(buffer, { type: "buffer", cellStyles: true });
    const ws = wb.Sheets["会话数据"];
    assert.ok(ws["!autofilter"], "启用筛选");
    assert.ok(Array.isArray(ws["!cols"]) && ws["!cols"].length > 0, "设置列宽");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("transformExportRows: 敏感字段默认不存在、主动开启后存在", () => {
  const { db, dir } = createTestDb();
  try {
    const raw = loadExportRows(db, [42]);

    const safe = transformExportRows(raw, { includeChinaTime: true, includeSensitive: false });
    for (const header of ["IP地址", "浏览器标识_原文", "屏幕宽", "屏幕高", "视口宽", "视口高", "平台", "时区", "语言"]) {
      assert.ok(!safe.sessions.headers.includes(header), `${header} 默认不导出`);
    }
    assert.ok(safe.sessions.headers.includes("开始时间_北京时间"));
    assert.ok(safe.sessions.headers.includes("开始时间"));
    assert.ok(safe.sessions.headers.includes("会话ID"));

    const full = transformExportRows(raw, { includeChinaTime: true, includeSensitive: true });
    assert.ok(full.sessions.headers.includes("IP地址"));
    assert.ok(full.sessions.headers.includes("浏览器标识_原文"));
    const row = full.sessions.rows[0];
    assert.equal(row["IP地址"], "1.2.3.4");
    assert.equal(row["开始时间_北京时间"], "2026-08-07 12:00:29");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("transformExportRows: CLI 旧布局保持不变（无北京时间、含敏感字段）", () => {
  const { db, dir } = createTestDb();
  try {
    const raw = loadExportRows(db, [42]);
    const cli = transformExportRows(raw, { includeChinaTime: false, includeSensitive: true });
    assert.ok(!cli.sessions.headers.includes("开始时间_北京时间"));
    assert.ok(cli.sessions.headers.includes("IP地址"));
    assert.equal(cli.sessions.headers[0], "会话ID");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("buildWorkbookBuffer: 空结果直接返回表头（API 层会先拦截空结果）", () => {
  const { db, dir } = createTestDb();
  try {
    const { data, summaryRows } = buildData(db, [], { includeChinaTime: true, includeSensitive: false });
    const buffer = buildWorkbookBuffer(
      { summaryRows, ...data },
      { sheets: ["sessions", "events", "walks", "violations"] }
    );
    const wb = XLSX.read(buffer, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["会话数据"], { header: 1, defval: "" });
    assert.equal(rows.length, 1, "仅表头");
    assert.equal(rows[0][0], "会话ID");
  } finally {
    closeTestDb({ db, dir });
  }
});
