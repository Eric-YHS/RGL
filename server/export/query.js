// server/export/query.js
// 查询 sessions/events，返回结构化原始数据。
// 一次导出在同一个只读事务内完成会话与事件的读取，保证来自同一快照。

import { buildSessionWhere } from "./filters.js";
import { toChinaTime } from "./transform.js";

const SESSION_COLUMNS = `
  s.id,
  s.client_session_id,
  s.participant_id,
  s.started_at_iso,
  s.submitted_at_iso,
  s.run_kind,
  s.reveal_mode,
  s.comprehension_answer,
  s.post_rule_attitude,
  s.post_rule_attitude_text,
  s.treatment,
  s.intervention_ms,
  s.elapsed_sec,
  s.money,
  s.violations,
  s.user_agent,
  s.language,
  s.platform,
  s.screen_width,
  s.screen_height,
  s.viewport_width,
  s.viewport_height,
  s.time_zone,
  s.ip_address,
  s.created_at
`;

// 会话 ID 用 json_each 展开，避免 SQLite 999 个绑定变量的上限。
function idListWhere(alias, column, json) {
  return {
    sql: `${alias}.${column} IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
    params: [json]
  };
}

/**
 * 分页列出匹配筛选条件的会话。
 * 返回 { total, items }，items 每项含 id/participantId/startedAtIso/startedAtChina/
 * submittedAtChina/elapsedSec/money/violations/eventCount/runKind/revealMode。
 */
export function listSessions(db, filters, { page, pageSize }) {
  const { whereSql, params } = buildSessionWhere(filters);

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sessions s ${whereSql}`)
    .get(...params);

  const rows = db
    .prepare(
      `SELECT
        s.id,
        s.participant_id,
        s.started_at_iso,
        s.submitted_at_iso,
        s.run_kind,
        s.reveal_mode,
        s.elapsed_sec,
        s.money,
        s.violations
      FROM sessions s
      ${whereSql}
      ORDER BY s.id ASC
      LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);

  const items = rows.map((row) => ({
    id: row.id,
    participantId: row.participant_id,
    startedAtIso: row.started_at_iso,
    startedAtChina: toChinaTime(row.started_at_iso),
    submittedAtChina: toChinaTime(row.submitted_at_iso),
    elapsedSec: row.elapsed_sec,
    money: row.money,
    violations: row.violations,
    eventCount: 0,
    runKind: row.run_kind,
    revealMode: row.reveal_mode
  }));

  if (items.length > 0) {
    const idWhere = idListWhere("e", "session_id", JSON.stringify(items.map((item) => item.id)));
    const counts = db
      .prepare(
        `SELECT e.session_id AS sessionId, COUNT(*) AS eventCount
         FROM events e
         WHERE ${idWhere.sql}
         GROUP BY e.session_id`
      )
      .all(...idWhere.params);
    const bySession = new Map(counts.map((c) => [c.sessionId, c.eventCount]));
    for (const item of items) {
      item.eventCount = bySession.get(item.id) ?? 0;
    }
  }

  return { total, items };
}

/**
 * 根据选择（筛选条件或显式会话 ID 列表）解析最终会话 ID 列表（升序）。
 * selection: { mode: "filters", filters } | { mode: "ids", sessionIds }
 */
export function resolveSessionIds(db, selection) {
  if (selection.mode === "ids") {
    return { ok: true, sessionIds: [...selection.sessionIds], filters: null };
  }

  const { whereSql, params } = buildSessionWhere(selection.filters);
  const rows = db
    .prepare(`SELECT s.id FROM sessions s ${whereSql} ORDER BY s.id ASC`)
    .all(...params);
  return {
    ok: true,
    sessionIds: rows.map((row) => row.id),
    filters: selection.filters
  };
}

/**
 * 在同一个只读事务内加载会话与事件。
 * 返回 { sessions, events }，events 按 session_id, seq 排序。
 */
export function loadExportRows(db, sessionIds) {
  if (sessionIds.length === 0) {
    return { sessions: [], events: [] };
  }

  const read = db.transaction(() => readExportRows(db, sessionIds));
  return read();
}

/** 事务内部的明细读取（不开启新事务）。 */
function readExportRows(db, sessionIds) {
  const json = JSON.stringify(sessionIds);
  const sessionWhere = idListWhere("s", "id", json);
  const eventWhere = idListWhere("e", "session_id", json);

  const sessions = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s WHERE ${sessionWhere.sql} ORDER BY s.id ASC`
    )
    .all(...sessionWhere.params);

  const events = db
    .prepare(
      `SELECT
        e.id,
        e.session_id,
        e.seq,
        e.t_ms,
        e.t_sec,
        e.event,
        e.phase,
        e.light_index,
        e.light_color,
        e.money,
        e.route_pos_01,
        e.route_pos_10,
        e.note,
        e.created_at,
        s.participant_id,
        s.started_at_iso,
        s.run_kind,
        s.reveal_mode,
        s.comprehension_answer,
        s.post_rule_attitude,
        s.post_rule_attitude_text
      FROM events e
      JOIN sessions s ON s.id = e.session_id
      WHERE ${eventWhere.sql}
      ORDER BY e.session_id ASC, e.seq ASC`
    )
    .all(...eventWhere.params);

  return { sessions, events };
}

/**
 * 一次导出的完整读取流水线，全部在同一个只读事务快照内完成：
 *
 * 1. 解析最终会话集合：筛选模式用 `LIMIT maxSessions + 1` 的有界查询，避免先把无限多的 ID 读入数组。
 * 2. 校验显式 ID 是否全部存在（缺失即失败，不静默漏导）。
 * 3. 会话数超限立即返回 session-limit，不读取事件明细。
 * 4. 用 COUNT(*) 计算事件总数；超限立即返回 event-limit，不执行事件明细 .all()。
 * 5. 两项上限都通过后才读取完整 sessions/events。
 *
 * selection: { mode: "filters", filters } | { mode: "ids", sessionIds }
 * limits:   { maxSessions, maxEvents }
 *
 * 返回成功 { ok: true, sessionIds, filters, sessions, events }；
 * 或失败 { ok: false, reason: "session-limit" | "event-limit" | "missing-ids" | "empty-result", ... }。
 */
export function loadExportSnapshot(db, selection, { maxSessions, maxEvents }) {
  const read = db.transaction(() => {
    let sessionIds;
    let filters = null;

    if (selection.mode === "ids") {
      sessionIds = [...selection.sessionIds];
      // 防御：即使参数校验与配置读取之间存在上限变化，也不允许越界。
      if (sessionIds.length > maxSessions) {
        return { ok: false, reason: "session-limit", sessionCount: sessionIds.length };
      }
    } else {
      filters = selection.filters;
      const { whereSql, params } = buildSessionWhere(filters);
      // 有界查询：最多读 maxSessions + 1 个 ID 即可判断是否超限。
      const rows = db
        .prepare(`SELECT s.id FROM sessions s ${whereSql} ORDER BY s.id ASC LIMIT ?`)
        .all(...params, maxSessions + 1);
      sessionIds = rows.map((row) => row.id);
      if (sessionIds.length > maxSessions) {
        return { ok: false, reason: "session-limit", sessionCount: sessionIds.length };
      }
      if (sessionIds.length === 0) {
        return { ok: false, reason: "empty-result" };
      }
    }

    // ids 模式：所有请求 ID 必须全部存在，缺任一即失败（不生成部分工作簿）。
    if (selection.mode === "ids") {
      const found = countExistingSessions(db, sessionIds);
      if (found !== sessionIds.length) {
        return {
          ok: false,
          reason: "missing-ids",
          requestedCount: sessionIds.length,
          foundCount: found,
          missingCount: sessionIds.length - found
        };
      }
    }

    // 事件总数用 COUNT(*) 计算，超限时不执行事件明细读取。
    const eventJson = JSON.stringify(sessionIds);
    const eventWhere = idListWhere("e", "session_id", eventJson);
    const { total: eventCount } = db
      .prepare(`SELECT COUNT(*) AS total FROM events e WHERE ${eventWhere.sql}`)
      .get(...eventWhere.params);
    if (eventCount > maxEvents) {
      return { ok: false, reason: "event-limit", eventCount };
    }

    const { sessions, events } = readExportRows(db, sessionIds);
    return { ok: true, sessionIds, filters, sessions, events };
  });

  return read();
}

/** 统计给定会话 ID 中有多少个真实存在（与明细读取同一事务内调用）。 */
function countExistingSessions(db, sessionIds) {
  const where = idListWhere("s", "id", JSON.stringify(sessionIds));
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where.sql}`)
    .get(...where.params);
  return total;
}
