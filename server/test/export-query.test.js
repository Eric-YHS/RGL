// server/test/export-query.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { normalizeExportFilters } from "../export/filters.js";
import { listSessions, loadExportRows, loadExportSnapshot, resolveSessionIds } from "../export/query.js";
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

// ---------------------------------------------------------------------------
// loadExportSnapshot：上限在读取明细前终止、同事务快照、ID 全量存在
// ---------------------------------------------------------------------------

/**
 * 包装 db.prepare 统计查询类型，用于可观测地证明“超限时没有加载明细”。
 * detail：事件明细 SELECT（含 e.t_ms 的 FROM events e）；
 * count：事件 COUNT(*)；idList：会话 ID 列表 SELECT。
 */
function instrumentQueries(db) {
  const counters = { detail: 0, count: 0, idList: 0 };
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/FROM events e[\s\S]*e\.t_ms/.test(sql)) counters.detail += 1;
    else if (/SELECT COUNT\(\*\) AS total FROM events/.test(sql)) counters.count += 1;
    if (/^SELECT s\.id FROM sessions s/.test(sql.trim())) counters.idList += 1;
    return originalPrepare(sql);
  };
  return counters;
}

test("loadExportSnapshot: 会话超限在读取明细前终止（可观测）", () => {
  const { db, dir } = createTestDb();
  try {
    const counters = instrumentQueries(db);
    const result = loadExportSnapshot(
      db,
      { mode: "filters", filters: normalizeExportFilters({}).filters },
      { maxSessions: 5, maxEvents: 100000 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-limit");
    assert.equal(result.sessionCount, 6, "有界查询只读 maxSessions + 1 个 ID");
    assert.equal(counters.detail, 0, "事件明细查询必须未执行");
    assert.equal(counters.count, 0, "事件计数也必须未执行");
    assert.equal(counters.idList, 1, "会话 ID 列表只读一次（有界）");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: 事件超限在事件明细 .all() 前终止（可观测）", () => {
  const { db, dir } = createTestDb();
  try {
    const counters = instrumentQueries(db);
    // 42 有 6 条事件，44 有 2 条，46 有 2 条 → 共 10 条；上限 5 → event-limit。
    const result = loadExportSnapshot(
      db,
      { mode: "ids", sessionIds: [42, 44, 46] },
      { maxSessions: 100, maxEvents: 5 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "event-limit");
    assert.equal(result.eventCount, 10);
    assert.equal(counters.count, 1, "事件总数用 COUNT(*) 计算一次");
    assert.equal(counters.detail, 0, "事件明细查询必须未执行");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: 正好等于上限时允许导出", () => {
  const { db, dir } = createTestDb();
  try {
    // 42 正好 6 条事件：maxEvents = 6 允许，7 拒绝。
    const atLimit = loadExportSnapshot(
      db,
      { mode: "ids", sessionIds: [42] },
      { maxSessions: 1, maxEvents: 6 }
    );
    assert.equal(atLimit.ok, true);
    assert.equal(atLimit.sessions.length, 1);
    assert.equal(atLimit.events.length, 6);

    const over = loadExportSnapshot(
      db,
      { mode: "ids", sessionIds: [42] },
      { maxSessions: 1, maxEvents: 6 }
    );
    assert.equal(over.ok, true);

    // 筛选模式：17 个会话，maxSessions = 17 允许，16 拒绝。
    const sessionsAtLimit = loadExportSnapshot(
      db,
      { mode: "filters", filters: normalizeExportFilters({}).filters },
      { maxSessions: 17, maxEvents: 100000 }
    );
    assert.equal(sessionsAtLimit.ok, true);
    assert.equal(sessionsAtLimit.sessions.length, 17);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: 空筛选结果返回 empty-result", () => {
  const { db, dir } = createTestDb();
  try {
    const result = loadExportSnapshot(
      db,
      {
        mode: "filters",
        filters: normalizeExportFilters({
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-02T00:00:00.000Z"
        }).filters
      },
      { maxSessions: 5000, maxEvents: 100000 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty-result");
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: ids 模式全量存在才成功，缺任一即 missing-ids", () => {
  const { db, dir } = createTestDb();
  try {
    const ok = loadExportSnapshot(
      db,
      { mode: "ids", sessionIds: [42, 44] },
      { maxSessions: 5000, maxEvents: 100000 }
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.sessionIds, [42, 44]);

    const partial = loadExportSnapshot(
      db,
      { mode: "ids", sessionIds: [42, 999999] },
      { maxSessions: 5000, maxEvents: 100000 }
    );
    assert.equal(partial.ok, false);
    assert.equal(partial.reason, "missing-ids");
    assert.equal(partial.requestedCount, 2);
    assert.equal(partial.foundCount, 1);
    assert.equal(partial.missingCount, 1);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: 1000 个以上存在的会话 ID 通过 json_each 工作", () => {
  const { db, dir } = createTestDb();
  try {
    // 批量插入 1001 个会话（id 10000–11000），全部存在。
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, client_session_id, participant_id, started_at_iso, submitted_at_iso,
        run_kind, reveal_mode, comprehension_answer, post_rule_attitude,
        post_rule_attitude_text, elapsed_sec, money, violations,
        user_agent, language, platform, screen_width, screen_height,
        viewport_width, viewport_height, time_zone, ip_address, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seedMany = db.transaction(() => {
      for (let id = 10000; id <= 11000; id += 1) {
        insert.run(
          id, `bulk-${id}`, `B${id}`, "2026-08-10T00:00:00.000Z", "2026-08-10T00:05:00.000Z",
          "formal", "full", "yes", "A", "", 300, 83.1, 0,
          "Mozilla/5.0", "zh-CN", "iPhone", 390, 844, 390, 700, "Asia/Shanghai", "1.2.3.4",
          "2026-08-10 00:00:00"
        );
      }
    });
    seedMany();

    const ids = Array.from({ length: 1001 }, (_, i) => 10000 + i);
    const result = loadExportSnapshot(
      db,
      { mode: "ids", sessionIds: ids },
      { maxSessions: 5000, maxEvents: 100000 }
    );
    assert.equal(result.ok, true);
    assert.equal(result.sessions.length, 1001);
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: 导出期间插入的新提交不影响快照口径", () => {
  const { db, dir } = createTestDb();
  const dbPath = `${dir}/test.db`;
  try {
    // 第二个连接：模拟导出事务进行期间提交的新数据。
    const db2 = new Database(dbPath);
    try {
      // 先取快照（42 共 6 条事件）。
      const snapshot = loadExportSnapshot(
        db,
        { mode: "ids", sessionIds: [42] },
        { maxSessions: 5000, maxEvents: 100000 }
      );
      assert.equal(snapshot.ok, true);
      assert.equal(snapshot.events.length, 6);

      // 快照之后、工作簿生成之前：另一连接向 42 追加第 7 条事件并提交。
      db2.prepare(
        `INSERT INTO events (session_id, seq, t_ms, t_sec, event, phase, money, created_at)
         VALUES (42, 7, 7000, 7, 'finish', 'finished', 80, '2026-08-07 13:00:00')`
      ).run();

      // 工作簿数据必须来自快照：仍为 6 条，与新提交无关。
      assert.equal(snapshot.events.length, 6);
      assert.deepEqual(
        snapshot.events.map((e) => e.seq),
        [1, 2, 3, 4, 5, 6]
      );

      // 新快照能看到新提交（证明不是查询被缓存）。
      const later = loadExportSnapshot(
        db,
        { mode: "ids", sessionIds: [42] },
        { maxSessions: 5000, maxEvents: 100000 }
      );
      assert.equal(later.ok, true);
      assert.equal(later.events.length, 7);
    } finally {
      db2.close();
    }
  } finally {
    closeTestDb({ db, dir });
  }
});

test("loadExportSnapshot: 同一事务内计数与明细口径一致（并发写入不可见）", () => {
  const { db, dir } = createTestDb();
  const dbPath = `${dir}/test.db`;
  try {
    const db2 = new Database(dbPath);
    try {
      // 在“事件 COUNT(*) 之后、事件明细读取之前”由另一连接插入事件：
      // 若计数与明细不在同一事务快照，明细会多出 1 条，导致口径不一致。
      const originalPrepare = db.prepare.bind(db);
      let injected = false;
      db.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (!injected && /SELECT COUNT\(\*\) AS total FROM events/.test(sql)) {
          injected = true;
          db2.prepare(
            `INSERT INTO events (session_id, seq, t_ms, t_sec, event, phase, money, created_at)
             VALUES (42, 7, 7000, 7, 'finish', 'finished', 80, '2026-08-07 13:00:00')`
          ).run();
        }
        return stmt;
      };

      const result = loadExportSnapshot(
        db,
        { mode: "ids", sessionIds: [42] },
        { maxSessions: 5000, maxEvents: 100000 }
      );
      assert.equal(result.ok, true);
      assert.equal(result.events.length, 6, "事务快照内计数与明细必须一致（看不到并发提交）");
      assert.ok(injected, "并发写入确实发生在计数之后");
    } finally {
      db2.close();
    }
  } finally {
    closeTestDb({ db, dir });
  }
});
