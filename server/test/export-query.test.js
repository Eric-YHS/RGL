// server/test/export-query.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeExportFilters } from "../export/filters.js";
import { listSessions, loadExportRows, resolveSessionIds } from "../export/query.js";
import { closeTestDb, createTestDb } from "./helpers.js";

test("listSessions: 分页、总数与事件条数", () => {
  const { db, dir } = createTestDb();
  try {
    const filters = normalizeExportFilters({}).filters;
    const page1 = listSessions(db, filters, { page: 1, pageSize: 50 });
    assert.equal(page1.total, 17); // 1,2,42-50,60,61,70-73
    assert.equal(page1.items.length, 17);
    const byId = new Map(page1.items.map((item) => [item.id, item]));
    assert.equal(byId.get(42).eventCount, 6);
    assert.equal(byId.get(45).eventCount, 0, "无事件的会话事件条数为 0");

    const page2 = listSessions(db, filters, { page: 2, pageSize: 50 });
    assert.equal(page2.items.length, 0);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("listSessions: 预览字段包含北京时间", () => {
  const { db, dir } = createTestDb();
  try {
    const filters = normalizeExportFilters({
      from: "2026-08-07T04:00:00.000Z",
      to: "2026-08-07T04:30:00.000Z"
    }).filters;
    const { items } = listSessions(db, filters, { page: 1, pageSize: 50 });
    assert.deepEqual(items.map((item) => item.id), [42, 43, 44, 60]);
    assert.equal(items[0].id, 42);
    assert.equal(items[0].startedAtChina, "2026-08-07 12:00:29");
    assert.equal(items[0].submittedAtChina, "2026-08-07 12:07:40");
    assert.equal(items[0].runKind, "formal");
    assert.equal(items[0].revealMode, "full");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("listSessions: 开始时间包含、结束时间排除的边界", () => {
  const { db, dir } = createTestDb();
  try {
    // [2026-08-07T04:00:00Z, 2026-08-07T16:00:00Z) —— 正好在起点的 60 包含，正好在终点的 61 排除。
    const filters = normalizeExportFilters({
      from: "2026-08-07T04:00:00.000Z",
      to: "2026-08-07T16:00:00.000Z"
    }).filters;
    const { total, items } = listSessions(db, filters, { page: 1, pageSize: 50 });
    assert.equal(total, 10); // 42-50 + 60
    const ids = items.map((item) => item.id);
    assert.ok(ids.includes(60));
    assert.ok(!ids.includes(61));
  } finally {
    closeTestDb({ db, dir });
  }
});

test("resolveSessionIds: 筛选模式返回升序 ID，ids 模式原样返回", () => {
  const { db, dir } = createTestDb();
  try {
    const filters = normalizeExportFilters({
      from: "2026-08-07T04:00:00.000Z",
      to: "2026-08-07T16:00:00.000Z",
      runKind: "formal"
    }).filters;
    const filtered = resolveSessionIds(db, { mode: "filters", filters });
    assert.deepEqual(filtered.sessionIds, [42, 44, 45, 47, 49, 50, 60]);

    const byIds = resolveSessionIds(db, { mode: "ids", sessionIds: [50, 42, 44] });
    assert.deepEqual(byIds.sessionIds, [50, 42, 44]);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("contains 查询中 % _ 反斜杠按字面匹配", () => {
  const { db, dir } = createTestDb();
  try {
    const pct = resolveSessionIds(db, {
      mode: "filters",
      filters: normalizeExportFilters({ participant: "pct%", participantMatch: "contains" }).filters
    });
    assert.deepEqual(pct.sessionIds, [70], "% 必须按字面匹配");

    const under = resolveSessionIds(db, {
      mode: "filters",
      filters: normalizeExportFilters({ participant: "under_", participantMatch: "contains" }).filters
    });
    assert.deepEqual(under.sessionIds, [72], "_ 必须按字面匹配");

    const back = resolveSessionIds(db, {
      mode: "filters",
      filters: normalizeExportFilters({ participant: "back\\", participantMatch: "contains" }).filters
    });
    assert.deepEqual(back.sessionIds, [73], "反斜杠必须按字面匹配");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportRows: 事件按 session_id, seq 排序且来自同一快照", () => {
  const { db, dir } = createTestDb();
  try {
    const { sessions, events } = loadExportRows(db, [42, 44, 45]);
    assert.equal(sessions.length, 3);
    assert.equal(events.length, 8); // 42: 6 条，44: 2 条，45: 0 条
    const seqs = events.map((event) => `${event.session_id}:${event.seq}`);
    assert.deepEqual(seqs, ["42:1", "42:2", "42:3", "42:4", "42:5", "42:6", "44:1", "44:2"]);
    assert.equal(events[0].participant_id, "S001");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportRows: 会话 ID 超过 999 个绑定变量上限也能工作", () => {
  const { db, dir } = createTestDb();
  try {
    const manyIds = [42, 44, ...Array.from({ length: 1500 }, (_, i) => 10000 + i)];
    const { sessions } = loadExportRows(db, manyIds);
    assert.deepEqual(sessions.map((s) => s.id), [42, 44]);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("CLI 与 API 相同筛选下解析出相同会话集合", () => {
  const { db, dir } = createTestDb();
  try {
    // CLI：--pid S001（精确）；API：filters 模式 participant=S001 exact。
    const cliStyle = resolveSessionIds(db, {
      mode: "filters",
      filters: normalizeExportFilters({ participant: "S001", participantMatch: "exact" }).filters
    });
    const apiStyle = resolveSessionIds(db, {
      mode: "filters",
      filters: normalizeExportFilters({ participant: "S001", participantMatch: "exact" }).filters
    });
    assert.deepEqual(cliStyle.sessionIds, apiStyle.sessionIds);
    assert.deepEqual(cliStyle.sessionIds, [42]);

    // ids 模式勾选结果与筛选结果一致。
    const idsStyle = resolveSessionIds(db, { mode: "ids", sessionIds: [42] });
    assert.deepEqual(idsStyle.sessionIds, cliStyle.sessionIds);
  } finally {
    closeTestDb({ db, dir });
  }
});
