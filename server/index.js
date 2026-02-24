import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import Database from "better-sqlite3";
import express from "express";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.DB_PATH ?? path.resolve(__dirname, "..", "data", "experiment.db");
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
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
`);

const insertSessionStmt = db.prepare(`
INSERT INTO sessions (
  client_session_id,
  participant_id,
  started_at_iso,
  submitted_at_iso,
  run_kind,
  reveal_mode,
  comprehension_answer,
  post_rule_attitude,
  post_rule_attitude_text,
  elapsed_sec,
  money,
  violations,
  user_agent,
  language,
  platform,
  screen_width,
  screen_height,
  viewport_width,
  viewport_height,
  time_zone,
  ip_address
)
VALUES (
  @clientSessionId,
  @participantId,
  @startedAtIso,
  @submittedAtIso,
  @runKind,
  @revealMode,
  @comprehensionAnswer,
  @postRuleAttitude,
  @postRuleAttitudeText,
  @elapsedSec,
  @money,
  @violations,
  @userAgent,
  @language,
  @platform,
  @screenWidth,
  @screenHeight,
  @viewportWidth,
  @viewportHeight,
  @timeZone,
  @ipAddress
)
ON CONFLICT(client_session_id) DO NOTHING;
`);

const insertEventStmt = db.prepare(`
INSERT INTO events (
  session_id,
  seq,
  t_ms,
  t_sec,
  event,
  phase,
  light_index,
  light_color,
  money,
  route_pos_01,
  route_pos_10,
  note
)
VALUES (
  @sessionId,
  @seq,
  @tMs,
  @tSec,
  @event,
  @phase,
  @lightIndex,
  @lightColor,
  @money,
  @routePos01,
  @routePos10,
  @note
);
`);

const findSessionByClientIdStmt = db.prepare(
  "SELECT id FROM sessions WHERE client_session_id = ? LIMIT 1;"
);

const insertSubmissionTx = db.transaction((payload, ipAddress) => {
  const info = insertSessionStmt.run({
    ...payload,
    ipAddress,
    elapsedSec: payload.summary.elapsedSec,
    money: payload.summary.money,
    violations: payload.summary.violations,
    userAgent: payload.device.userAgent,
    language: payload.device.language,
    platform: payload.device.platform,
    screenWidth: payload.device.screenWidth,
    screenHeight: payload.device.screenHeight,
    viewportWidth: payload.device.viewportWidth,
    viewportHeight: payload.device.viewportHeight,
    timeZone: payload.device.timeZone
  });

  const session = findSessionByClientIdStmt.get(payload.clientSessionId);
  if (!session || typeof session.id !== "number") {
    throw new Error("Failed to resolve session id");
  }

  if (info.changes === 0) {
    return {
      sessionId: session.id,
      deduplicated: true
    };
  }

  payload.events.forEach((eventRow, idx) => {
    insertEventStmt.run({
      sessionId: session.id,
      seq: idx + 1,
      tMs: eventRow.tMs,
      tSec: eventRow.tSec,
      event: eventRow.event,
      phase: eventRow.phase,
      lightIndex: eventRow.lightIndex,
      lightColor: eventRow.lightColor,
      money: eventRow.money,
      routePos01: eventRow.routePos01,
      routePos10: eventRow.routePos10,
      note: eventRow.note
    });
  });

  return {
    sessionId: session.id,
    deduplicated: false
  };
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

if (CORS_ORIGIN.trim()) {
  const allowlist = CORS_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowlist.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin not allowed"));
      }
    })
  );
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "honglvdeng-api", nowIso: new Date().toISOString() });
});

app.post("/api/submissions", (req, res) => {
  const parsed = parseSubmission(req.body);
  if (!parsed.ok) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }

  try {
    const ipAddress = extractClientIp(req);
    const result = insertSubmissionTx(parsed.payload, ipAddress);
    res.json({ ok: true, sessionId: result.sessionId, deduplicated: result.deduplicated });
  } catch (error) {
    console.error("[POST /api/submissions] failed:", error);
    res.status(500).json({ ok: false, error: "Failed to store submission" });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`);
  console.log(`[api] sqlite db: ${DB_PATH}`);
});

function extractClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = String(forwarded[0]).trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "";
}

function parseSubmission(body) {
  if (!isRecord(body)) return fail("Body must be a JSON object");

  const clientSessionId = readString(body.clientSessionId, { max: 128, required: true });
  if (!clientSessionId.ok) return clientSessionId;

  const participantId = readString(body.participantId, { max: 128, required: false, trim: true });
  if (!participantId.ok) return participantId;

  const startedAtIso = readString(body.startedAtIso, { max: 64, required: true });
  if (!startedAtIso.ok) return startedAtIso;

  const submittedAtIso = readString(body.submittedAtIso, { max: 64, required: true });
  if (!submittedAtIso.ok) return submittedAtIso;

  const runKind = readEnum(body.runKind, ["practice", "formal"]);
  if (!runKind.ok) return runKind;

  const revealMode = readEnum(body.revealMode, ["full", "sequential"]);
  if (!revealMode.ok) return revealMode;

  const comprehensionAnswer = readEnum(body.comprehensionAnswer ?? "", ["", "yes", "no"]);
  if (!comprehensionAnswer.ok) return comprehensionAnswer;

  const postRuleAttitude = readEnum(body.postRuleAttitude ?? "", ["", "A", "B", "C", "D"]);
  if (!postRuleAttitude.ok) return postRuleAttitude;

  const postRuleAttitudeText = readString(body.postRuleAttitudeText ?? "", {
    max: 2000,
    required: false
  });
  if (!postRuleAttitudeText.ok) return postRuleAttitudeText;

  if (!isRecord(body.summary)) return fail("summary must be an object");
  const elapsedSec = readNumber(body.summary.elapsedSec, { min: 0, max: 600000 });
  if (!elapsedSec.ok) return elapsedSec;
  const money = readNumber(body.summary.money, { min: -1000000, max: 1000000 });
  if (!money.ok) return money;
  const violations = readInteger(body.summary.violations, { min: 0, max: 100000 });
  if (!violations.ok) return violations;

  if (!isRecord(body.device)) return fail("device must be an object");
  const userAgent = readString(body.device.userAgent ?? "", { max: 2000, required: false });
  if (!userAgent.ok) return userAgent;
  const language = readString(body.device.language ?? "", { max: 64, required: false });
  if (!language.ok) return language;
  const platform = readString(body.device.platform ?? "", { max: 128, required: false });
  if (!platform.ok) return platform;
  const screenWidth = readInteger(body.device.screenWidth, { min: 0, max: 100000 });
  if (!screenWidth.ok) return screenWidth;
  const screenHeight = readInteger(body.device.screenHeight, { min: 0, max: 100000 });
  if (!screenHeight.ok) return screenHeight;
  const viewportWidth = readInteger(body.device.viewportWidth, { min: 0, max: 100000 });
  if (!viewportWidth.ok) return viewportWidth;
  const viewportHeight = readInteger(body.device.viewportHeight, { min: 0, max: 100000 });
  if (!viewportHeight.ok) return viewportHeight;
  const timeZone = readString(body.device.timeZone ?? "", { max: 128, required: false });
  if (!timeZone.ok) return timeZone;

  if (!Array.isArray(body.events)) return fail("events must be an array");
  if (body.events.length > 5000) return fail("events exceeds maximum length (5000)");

  const events = [];
  for (let i = 0; i < body.events.length; i += 1) {
    const row = body.events[i];
    if (!isRecord(row)) return fail(`events[${i}] must be an object`);

    const tMs = readInteger(row.tMs, { min: 0, max: 2_000_000_000 });
    if (!tMs.ok) return fail(`events[${i}].tMs invalid`);

    const tSec = readNumber(row.tSec, { min: 0, max: 600000 });
    if (!tSec.ok) return fail(`events[${i}].tSec invalid`);

    const event = readString(row.event, { max: 64, required: true });
    if (!event.ok) return fail(`events[${i}].event invalid`);

    const phase = readEnum(row.phase, ["idle", "moving", "waiting_red", "finished"]);
    if (!phase.ok) return fail(`events[${i}].phase invalid`);

    const lightIndex = readNullableInteger(row.lightIndex, { min: 0, max: 1000 });
    if (!lightIndex.ok) return fail(`events[${i}].lightIndex invalid`);

    const lightColor = readNullableEnum(row.lightColor, ["red", "green"]);
    if (!lightColor.ok) return fail(`events[${i}].lightColor invalid`);

    const eventMoney = readNumber(row.money, { min: -1000000, max: 1000000 });
    if (!eventMoney.ok) return fail(`events[${i}].money invalid`);

    const routePos01 = readNullableNumber(row.routePos01, { min: 0, max: 1 });
    if (!routePos01.ok) return fail(`events[${i}].routePos01 invalid`);

    const routePos10 = readNullableNumber(row.routePos10, { min: 0, max: 1000 });
    if (!routePos10.ok) return fail(`events[${i}].routePos10 invalid`);

    const note = readNullableString(row.note, { max: 2000 });
    if (!note.ok) return fail(`events[${i}].note invalid`);

    events.push({
      tMs: tMs.value,
      tSec: tSec.value,
      event: event.value,
      phase: phase.value,
      lightIndex: lightIndex.value,
      lightColor: lightColor.value,
      money: eventMoney.value,
      routePos01: routePos01.value,
      routePos10: routePos10.value,
      note: note.value
    });
  }

  return {
    ok: true,
    payload: {
      clientSessionId: clientSessionId.value,
      participantId: participantId.value,
      startedAtIso: startedAtIso.value,
      submittedAtIso: submittedAtIso.value,
      runKind: runKind.value,
      revealMode: revealMode.value,
      comprehensionAnswer: comprehensionAnswer.value,
      postRuleAttitude: postRuleAttitude.value,
      postRuleAttitudeText: postRuleAttitudeText.value,
      summary: {
        elapsedSec: elapsedSec.value,
        money: money.value,
        violations: violations.value
      },
      device: {
        userAgent: userAgent.value,
        language: language.value,
        platform: platform.value,
        screenWidth: screenWidth.value,
        screenHeight: screenHeight.value,
        viewportWidth: viewportWidth.value,
        viewportHeight: viewportHeight.value,
        timeZone: timeZone.value
      },
      events
    }
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function fail(error) {
  return { ok: false, error };
}

function success(value) {
  return { ok: true, value };
}

function readString(value, options) {
  const { max, required, trim = false } = options;
  if (value === undefined || value === null) {
    return required ? fail("missing required string") : success("");
  }
  if (typeof value !== "string") return fail("must be a string");
  const normalized = trim ? value.trim() : value;
  if (required && normalized.length === 0) return fail("must be non-empty");
  if (normalized.length > max) return fail(`must be <= ${max} chars`);
  return success(normalized);
}

function readNullableString(value, options) {
  if (value === undefined || value === null || value === "") return success(null);
  const text = readString(value, { ...options, required: true });
  if (!text.ok) return text;
  return success(text.value);
}

function readEnum(value, allowed) {
  if (typeof value !== "string") return fail("must be a string enum value");
  if (!allowed.includes(value)) return fail(`must be one of: ${allowed.join(", ")}`);
  return success(value);
}

function readNullableEnum(value, allowed) {
  if (value === undefined || value === null || value === "") return success(null);
  return readEnum(value, allowed);
}

function readNumber(value, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fail("must be a finite number");
  if (n < min || n > max) return fail(`must be in [${min}, ${max}]`);
  return success(n);
}

function readNullableNumber(value, bounds) {
  if (value === undefined || value === null || value === "") return success(null);
  const n = readNumber(value, bounds);
  if (!n.ok) return n;
  return success(n.value);
}

function readInteger(value, { min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fail("must be an integer");
  if (n < min || n > max) return fail(`must be in [${min}, ${max}]`);
  return success(n);
}

function readNullableInteger(value, bounds) {
  if (value === undefined || value === null || value === "") return success(null);
  const n = readInteger(value, bounds);
  if (!n.ok) return n;
  return success(n.value);
}
