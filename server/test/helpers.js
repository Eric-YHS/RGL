// server/test/helpers.js
// 测试共享工具：内存临时数据库 + 种子数据（含 8 月 7 日下午批次 42–50）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_session_id TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  started_at_iso TEXT NOT NULL,
  submitted_at_iso TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  reveal_mode TEXT NOT NULL,
  comprehension_answer TEXT NOT NULL,
  post_rule_attitude TEXT NOT NULL,
  post_rule_attitude_text TEXT NOT NULL,
  elapsed_sec REAL NOT NULL,
  money REAL NOT NULL,
  violations INTEGER NOT NULL,
  user_agent TEXT NOT NULL,
  language TEXT NOT NULL,
  platform TEXT NOT NULL,
  screen_width INTEGER NOT NULL,
  screen_height INTEGER NOT NULL,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  t_sec REAL NOT NULL,
  event TEXT NOT NULL,
  phase TEXT NOT NULL,
  light_index INTEGER,
  light_color TEXT,
  money REAL NOT NULL,
  route_pos_01 REAL,
  route_pos_10 REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_sessions_participant ON sessions(participant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at_iso);
`;

export function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "honglvdeng-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  seed(db);
  return { db, dir };
}

export function closeTestDb({ db, dir }) {
  try {
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seed(db) {
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, client_session_id, participant_id, started_at_iso, submitted_at_iso,
      run_kind, reveal_mode, comprehension_answer, post_rule_attitude,
      post_rule_attitude_text, elapsed_sec, money, violations,
      user_agent, language, platform, screen_width, screen_height,
      viewport_width, viewport_height, time_zone, ip_address
    ) VALUES (
      @id, @clientSessionId, @participantId, @startedAtIso, @submittedAtIso,
      @runKind, @revealMode, @comprehensionAnswer, @postRuleAttitude,
      @postRuleAttitudeText, @elapsedSec, @money, @violations,
      @userAgent, @language, @platform, @screenWidth, @screenHeight,
      @viewportWidth, @viewportHeight, @timeZone, @ipAddress
    )
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (
      session_id, seq, t_ms, t_sec, event, phase, light_index, light_color,
      money, route_pos_01, route_pos_10, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const session = (id, overrides = {}) =>
    insertSession.run({
      id,
      clientSessionId: `client-${id}`,
      participantId: `P${String(id).padStart(3, "0")}`,
      startedAtIso: "2026-06-01T00:00:00.000Z",
      submittedAtIso: "2026-06-01T00:05:00.000Z",
      runKind: "formal",
      revealMode: "full",
      comprehensionAnswer: "yes",
      postRuleAttitude: "A",
      postRuleAttitudeText: "",
      elapsedSec: 300,
      money: 83.1,
      violations: 0,
      userAgent: "Mozilla/5.0 (iPhone) AppleWebKit",
      language: "zh-CN",
      platform: "iPhone",
      screenWidth: 390,
      screenHeight: 844,
      viewportWidth: 390,
      viewportHeight: 700,
      timeZone: "Asia/Shanghai",
      ipAddress: "1.2.3.4",
      ...overrides
    });

  const event = (sessionId, seq, overrides = {}) =>
    insertEvent.run(
      sessionId,
      seq,
      overrides.tMs ?? seq * 1000,
      overrides.tSec ?? seq,
      overrides.event ?? "start",
      overrides.phase ?? "moving",
      overrides.lightIndex ?? null,
      overrides.lightColor ?? null,
      overrides.money ?? 83.1,
      overrides.routePos01 ?? null,
      overrides.routePos10 ?? null,
      overrides.note ?? null
    );

  // 基础数据（与线上结构一致的示例）。
  session(1, { participantId: "codex-green", startedAtIso: "2026-06-03T12:24:57.635Z", money: 88.8 });
  session(2, { participantId: "codex-check", startedAtIso: "2026-06-03T12:22:54.168Z", money: 90 });

  // 8 月 7 日下午批次（会话 42–50，共 9 个），北京时间 12:00–16:08。
  const aug7 = [
    [42, "S001", "2026-08-07T04:00:29.461Z", "2026-08-07T04:07:40.100Z", "formal", "full", 3],
    [43, "S002", "2026-08-07T04:11:02.300Z", "2026-08-07T04:13:55.000Z", "practice", "sequential", 0],
    [44, "S003", "2026-08-07T04:20:15.900Z", "2026-08-07T04:26:01.500Z", "formal", "sequential", 2],
    [45, "S004", "2026-08-07T04:35:44.200Z", "2026-08-07T04:41:20.000Z", "formal", "full", 0],
    [46, "S005", "2026-08-07T05:02:11.000Z", "2026-08-07T05:09:33.600Z", "practice", "full", 1],
    [47, "S006", "2026-08-07T05:28:49.800Z", "2026-08-07T05:31:02.400Z", "formal", "full", 1],
    [48, "S007", "2026-08-07T06:01:37.300Z", "2026-08-07T06:04:12.900Z", "practice", "sequential", 0],
    [49, "S008", "2026-08-07T07:15:03.700Z", "2026-08-07T07:21:47.100Z", "formal", "full", 2],
    [50, "S009", "2026-08-07T08:00:00.000Z", "2026-08-07T08:08:01.000Z", "formal", "full", 0]
  ];
  for (const [id, pid, started, submitted, runKind, revealMode, violations] of aug7) {
    session(id, {
      participantId: pid,
      startedAtIso: started,
      submittedAtIso: submitted,
      runKind,
      revealMode,
      violations,
      elapsedSec: 300 + id,
      money: 80 + id * 0.5
    });
  }

  // 边界会话：左闭右开。04:00:00.000Z 属于 [04:00, 16:00)，16:00:00.000Z 不属于。
  session(60, {
    participantId: "BOUNDARY-IN",
    startedAtIso: "2026-08-07T04:00:00.000Z",
    submittedAtIso: "2026-08-07T04:02:00.000Z"
  });
  session(61, {
    participantId: "BOUNDARY-OUT",
    startedAtIso: "2026-08-07T16:00:00.000Z",
    submittedAtIso: "2026-08-07T16:02:00.000Z"
  });

  // LIKE 转义测试：% 、_ 、反斜杠。
  session(70, { participantId: "pct%user" });
  session(71, { participantId: "pct100user" });
  session(72, { participantId: "under_score" });
  session(73, { participantId: "back\\slash" });

  // 事件：42 号会话含 start / walk_press / pass_light / violation / finish。
  event(42, 1, { event: "start", phase: "idle" });
  event(42, 2, { event: "arrive_light", phase: "moving", lightIndex: 1, routePos10: 3 });
  event(42, 3, { event: "walk_press", phase: "waiting_red", lightIndex: 1, lightColor: "red", routePos10: 5 });
  event(42, 4, { event: "violation", phase: "waiting_red", lightIndex: 1, routePos10: 6 });
  event(42, 5, { event: "pass_light", phase: "moving_to_finish", lightIndex: 1, routePos10: 8 });
  event(42, 6, { event: "finish", phase: "finished", routePos10: 10 });

  // 44 号会话：只有 walk_press（绿灯通行，无闯红灯）。
  event(44, 1, { event: "start", phase: "idle" });
  event(44, 2, { event: "walk_press", phase: "waiting_red", lightIndex: 1, lightColor: "green", routePos10: 5 });

  // 45 号会话：无事件（会话存在但无事件）。

  // 46 号会话：练习 + 闯红灯。
  event(46, 1, { event: "start", phase: "idle" });
  event(46, 2, { event: "violation", phase: "waiting_red", lightIndex: 1, routePos10: 4 });

  // 47 号会话：walk_press 但无效果（非红灯等待）。
  event(47, 1, { event: "start", phase: "idle" });
  event(47, 2, { event: "walk_press", phase: "moving", lightIndex: 1, lightColor: "green", routePos10: 2 });

  // 49 号会话：两次 walk_press。
  event(49, 1, { event: "start", phase: "idle" });
  event(49, 2, { event: "walk_press", phase: "waiting_red", lightIndex: 1, lightColor: "red", routePos10: 3 });
  event(49, 3, { event: "walk_press", phase: "waiting_red", lightIndex: 1, lightColor: "green", routePos10: 6 });
}
