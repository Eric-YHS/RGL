// server/export-xlsx.js
// CLI 导出入口：复用 server/export/ 下的共享查询与生成模块。
// 默认行为与旧版一致（无导出说明工作表、不含北京时间列、包含敏感技术字段），
// 避免破坏已有工作流；新增 --from/--to/--run-kind/--reveal-mode/--session-id 列表。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { normalizeExportFilters } from "./export/filters.js";
import { loadExportRows, resolveSessionIds } from "./export/query.js";
import { transformExportRows } from "./export/transform.js";
import { buildWorkbookBuffer } from "./export/workbook.js";

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
  const filtersInput = {
    from: args.from,
    to: args.to,
    participant: args.participantId,
    participantMatch: "exact",
    runKind: args.runKind,
    revealMode: args.revealMode
  };

  let selection;
  if (args.sessionIds.length === 1) {
    filtersInput.minSessionId = args.sessionIds[0];
    filtersInput.maxSessionId = args.sessionIds[0];
    selection = { mode: "filters", filters: filtersInput };
  } else if (args.sessionIds.length > 1) {
    selection = { mode: "ids", sessionIds: args.sessionIds };
  } else {
    selection = { mode: "filters", filters: filtersInput };
  }

  if (selection.mode === "filters") {
    const normalized = normalizeExportFilters(selection.filters);
    if (!normalized.ok) {
      console.error(`[export-xlsx] invalid filters: ${normalized.error}`);
      process.exit(1);
    }
    selection = { ...selection, filters: normalized.filters };
  }

  const resolved = resolveSessionIds(db, selection);
  const raw = loadExportRows(db, resolved.sessionIds);

  const data = transformExportRows(raw, {
    includeChinaTime: false,
    includeSensitive: true
  });

  const buffer = buildWorkbookBuffer(
    {
      summaryRows: [],
      sessions: data.sessions,
      events: data.events,
      walks: data.walks,
      violations: data.violations
    },
    { sheets: ["sessions", "events", "walks", "violations"] }
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);

  console.log(`[export-xlsx] ok`);
  console.log(`[export-xlsx] db: ${dbPath}`);
  console.log(`[export-xlsx] out: ${outPath}`);
  console.log(`[export-xlsx] sessions: ${raw.sessions.length}`);
  console.log(`[export-xlsx] events: ${raw.events.length}`);
} finally {
  db.close();
}

function parseArgs(argv) {
  const out = {
    dbPath: undefined,
    outPath: undefined,
    participantId: undefined,
    sessionIds: [],
    from: undefined,
    to: undefined,
    runKind: undefined,
    revealMode: undefined
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
      for (const part of v.split(",")) {
        const id = Number(part.trim());
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`Invalid --session-id: ${part}`);
        }
        out.sessionIds.push(id);
      }
      i += 1;
      continue;
    }
    if (k === "--from" && v) {
      out.from = v;
      i += 1;
      continue;
    }
    if (k === "--to" && v) {
      out.to = v;
      i += 1;
      continue;
    }
    if (k === "--run-kind" && v) {
      if (v !== "practice" && v !== "formal") {
        throw new Error(`Invalid --run-kind: ${v} (expected practice|formal)`);
      }
      out.runKind = v;
      i += 1;
      continue;
    }
    if (k === "--reveal-mode" && v) {
      if (v !== "full" && v !== "sequential") {
        throw new Error(`Invalid --reveal-mode: ${v} (expected full|sequential)`);
      }
      out.revealMode = v;
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
  console.log(`Usage:
  npm --prefix server run export:xlsx -- [options]

Options:
  --db <path>          sqlite path (default: ../data/experiment.db)
  --out <path>         output xlsx path (default: ../exports/honglvdeng_export_*.xlsx)
  --pid <id>           filter by participant_id (exact match)
  --session-id <ids>   filter by sessions.id; comma-separated list allowed, e.g. 42,43,44
  --from <iso>         UTC ISO start time (inclusive)
  --to <iso>           UTC ISO end time (exclusive)
  --run-kind <kind>    practice | formal
  --reveal-mode <mode> full | sequential
  -h, --help           show help
`);
  process.exit(code);
}

function compactTimestamp() {
  return new Date().toISOString().replaceAll(/[\-:]/g, "").replaceAll(".", "");
}
