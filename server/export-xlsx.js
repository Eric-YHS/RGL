import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(__dirname, args.dbPath ?? "../data/experiment.db");
const outPath = path.resolve(
  __dirname,
  args.outPath ?? `../exports/honglvdeng_export_${compactTimestamp()}.xlsx`
);

if (!fs.existsSync(dbPath)) {
  console.error(`[export-xlsx] database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

try {
  const filters = buildFilters({
    participantId: args.participantId,
    sessionId: args.sessionId
  });

  const sessions = db
    .prepare(
      `
      SELECT
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
      FROM sessions s
      ${filters.whereSql}
      ORDER BY s.id ASC
    `
    )
    .all(filters.params);

  const events = db
    .prepare(
      `
      SELECT
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
      ${filters.whereSql}
      ORDER BY e.session_id ASC, e.seq ASC
    `
    )
    .all(filters.params);

  const walkRows = events
    .filter((row) => row.event === "walk_press")
    .map((row) => ({
      被试编号: row.participant_id,
      开始时间_ISO: row.started_at_iso,
      任务类型: formatRunKind(row.run_kind),
      呈现方式: formatRevealMode(row.reveal_mode),
      理解测验回答: formatComprehensionAnswer(row.comprehension_answer),
      规则看法选项: formatPostRuleAttitude(row.post_rule_attitude),
      规则看法补充: row.post_rule_attitude_text,
      事件: "按下WALK",
      页面时间_ms: row.t_ms,
      实验用时_秒: row.t_sec,
      位置刻度_0_10: row.route_pos_10,
      阶段: formatPhase(row.phase),
      信号灯序号: row.light_index,
      灯色: formatLightColor(row.light_color),
      剩余金额_元: row.money,
      按键效果: formatWalkEffect(row)
    }));

  const violationRows = events
    .filter((row) => row.event === "violation")
    .map((row) => ({
      被试编号: row.participant_id,
      开始时间_ISO: row.started_at_iso,
      任务类型: formatRunKind(row.run_kind),
      呈现方式: formatRevealMode(row.reveal_mode),
      理解测验回答: formatComprehensionAnswer(row.comprehension_answer),
      规则看法选项: formatPostRuleAttitude(row.post_rule_attitude),
      规则看法补充: row.post_rule_attitude_text,
      事件: "闯红灯",
      页面时间_ms: row.t_ms,
      实验用时_秒: row.t_sec,
      位置刻度_0_10: row.route_pos_10,
      信号灯序号: row.light_index,
      剩余金额_元: row.money
    }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sessions), "Sessions");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(events), "Events");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(walkRows), "WALK按键");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(violationRows), "闯红灯");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);

  console.log(`[export-xlsx] ok`);
  console.log(`[export-xlsx] db: ${dbPath}`);
  console.log(`[export-xlsx] out: ${outPath}`);
  console.log(`[export-xlsx] sessions: ${sessions.length}`);
  console.log(`[export-xlsx] events: ${events.length}`);
} finally {
  db.close();
}

function parseArgs(argv) {
  const out = {
    dbPath: undefined,
    outPath: undefined,
    participantId: undefined,
    sessionId: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];

    if (k === "--db" && v) {
      out.dbPath = v;
      i += 1;
      continue;
    }
    if (k === "--out" && v) {
      out.outPath = v;
      i += 1;
      continue;
    }
    if (k === "--pid" && v) {
      out.participantId = v;
      i += 1;
      continue;
    }
    if (k === "--session-id" && v) {
      const id = Number(v);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Invalid --session-id: ${v}`);
      }
      out.sessionId = id;
      i += 1;
      continue;
    }

    if (k === "--help" || k === "-h") {
      printHelpAndExit(0);
    }

    throw new Error(`Unknown argument: ${k}`);
  }

  return out;
}

function printHelpAndExit(code) {
  console.log(`Usage:\n  npm --prefix server run export:xlsx -- [options]\n\nOptions:\n  --db <path>          sqlite path (default: ../data/experiment.db)\n  --out <path>         output xlsx path (default: ../exports/honglvdeng_export_*.xlsx)\n  --pid <id>           filter by participant_id\n  --session-id <id>    filter by sessions.id\n  -h, --help           show help\n`);
  process.exit(code);
}

function buildFilters(args) {
  const clauses = [];
  const params = {};

  if (args.participantId) {
    clauses.push("s.participant_id = @participantId");
    params.participantId = args.participantId;
  }
  if (args.sessionId) {
    clauses.push("s.id = @sessionId");
    params.sessionId = args.sessionId;
  }

  if (clauses.length === 0) {
    return {
      whereSql: "",
      params
    };
  }

  return {
    whereSql: `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

function compactTimestamp() {
  return new Date().toISOString().replaceAll(/[\-:]/g, "").replaceAll(".", "");
}

function formatRunKind(v) {
  return v === "practice" ? "练习" : "正式实验";
}

function formatRevealMode(v) {
  return v === "sequential" ? "逐个呈现" : "全呈现";
}

function formatComprehensionAnswer(v) {
  if (v === "yes") return "是";
  if (v === "no") return "否";
  return "";
}

function formatPostRuleAttitude(v) {
  switch (v) {
    case "A":
      return "A.我严格遵守，因为这是规则。";
    case "B":
      return "B.我有时未遵守，因为等待时间太长，扣钱太多。";
    case "C":
      return "C.我觉得只要无人监督，为了效率（省钱）可以适当变通。";
    case "D":
      return "D.我以为按钮随时能点，没太在意红灯。";
    default:
      return "";
  }
}

function formatPhase(v) {
  switch (v) {
    case "idle":
      return "未开始";
    case "moving":
      return "行走中";
    case "waiting_red":
      return "红灯等待";
    case "finished":
      return "已完成";
    default:
      return String(v ?? "");
  }
}

function formatLightColor(v) {
  if (v === "red") return "红";
  if (v === "green") return "绿";
  return "";
}

function formatWalkEffect(row) {
  if (row.phase === "waiting_red" && row.light_color === "red") return "闯红灯通行";
  if (row.phase === "waiting_red" && row.light_color === "green") return "绿灯等待中";
  return "无效果";
}
