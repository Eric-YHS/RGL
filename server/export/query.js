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

  const json = JSON.stringify(sessionIds);
  const sessionWhere = idListWhere("s", "id", json);
  const eventWhere = idListWhere("e", "session_id", json);

  const read = db.transaction(() => {
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
  });

  return read();
}
