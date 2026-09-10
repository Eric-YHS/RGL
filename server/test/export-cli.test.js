// server/test/export-cli.test.js
// CLI 语义兼容基线：以固定 fixture 为准，逐表（4 个工作表）比较完整数据。
// 比较维度：工作表名称与顺序、表头顺序、行顺序、单元格值、数值/文本类型。
// 不比较 ZIP 字节/SHA-256 —— 冻结表头、筛选、列宽与压缩方式本身就会改变文件字节，
// 因此“与拆分前逐字节一致”不作为验收口径。

import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import XLSX from "xlsx";

import { closeTestDb, createTestDb } from "./helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const CLI_SCRIPT = path.join(SERVER_DIR, "export-xlsx.js");

const BASELINE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "cli-export-baseline.json"), "utf8")
);

/** 运行真实 CLI 进程（node export-xlsx.js），返回输出文件路径。 */
function runCli(dbPath, sessionIds) {
  const outPath = path.join(os.tmpdir(), `cli-export-${process.pid}-${Date.now()}.xlsx`);
  const result = spawnSync(
    process.execPath,
    [CLI_SCRIPT, "--db", dbPath, "--session-id", sessionIds.join(","), "--out", outPath],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, `CLI 必须成功退出\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(fs.existsSync(outPath), "CLI 必须生成输出文件");
  return outPath;
}

/** 按 fixture 相同的读取方式解析 XLSX：{ sheetNames, sheets: { 名称: { headers, rows } } }。 */
function parseWorkbook(filePath) {
  const wb = XLSX.readFile(filePath);
  const out = { sheetNames: wb.SheetNames, sheets: {} };
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
    out.sheets[name] = { headers: rows.length ? Object.keys(rows[0]) : [], rows };
  }
  return out;
}

test("CLI 语义兼容：四个工作表完整数据与基线一致（含数值/文本类型）", () => {
  const { db, dir } = createTestDb();
  const dbPath = path.join(dir, "test.db");
  let outPath;
  try {
    db.close();
    outPath = runCli(dbPath, [42, 44, 45, 46]);
    const actual = parseWorkbook(outPath);

    // 工作表名称与顺序。
    assert.deepEqual(actual.sheetNames, BASELINE.sheetNames);
    assert.deepEqual(actual.sheetNames, ["会话数据", "事件明细", "通行按键", "闯红灯记录"]);

    for (const name of BASELINE.sheetNames) {
      // 表头顺序逐列一致。
      assert.deepEqual(
        actual.sheets[name].headers,
        BASELINE.sheets[name].headers,
        `${name} 表头顺序`
      );
      // 行数一致。
      assert.equal(actual.sheets[name].rows.length, BASELINE.sheets[name].rows.length, `${name} 行数`);
      // 单元格值 + 类型逐行逐列一致（deepEqual 同时比较 number/string/null 类型）。
      assert.deepEqual(actual.sheets[name].rows, BASELINE.sheets[name].rows, `${name} 完整数据`);
    }

    // CLI 默认行为：包含敏感字段（IP/UA/平台/时区/语言），且无北京时间列、无导出说明表。
    const sessionHeaders = actual.sheets["会话数据"].headers;
    for (const header of ["IP地址", "浏览器标识_原文", "平台", "时区", "语言"]) {
      assert.ok(sessionHeaders.includes(header), `CLI 默认必须包含 ${header}`);
    }
    assert.ok(!sessionHeaders.includes("开始时间_北京时间"), "CLI 默认无北京时间列");
  } finally {
    if (outPath && fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
    closeTestDb({ db, dir });
  }
});

test("CLI 语义兼容：闯红灯工作表与通行按键工作表逐行校验", () => {
  const { db, dir } = createTestDb();
  const dbPath = path.join(dir, "test.db");
  let outPath;
  try {
    db.close();
    outPath = runCli(dbPath, [42, 44, 45, 46]);
    const actual = parseWorkbook(outPath);

    const violations = actual.sheets["闯红灯记录"].rows;
    assert.equal(violations.length, 2);
    assert.deepEqual(
      violations.map((row) => [row["被试编号"], row["事件"]]),
      [
        ["S001", "闯红灯"],
        ["S005", "闯红灯"]
      ],
      "42 与 46 各一条闯红灯，44/45 没有"
    );

    const walks = actual.sheets["通行按键"].rows;
    assert.equal(walks.length, 2);
    assert.deepEqual(
      walks.map((row) => [row["被试编号"], row["按键效果"]]),
      [
        ["S001", "闯红灯通行"],
        ["S003", "绿灯通行（遵守规则）"]
      ],
      "42 红灯通行、44 绿灯通行，46 无按键"
    );
  } finally {
    if (outPath && fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
    closeTestDb({ db, dir });
  }
});
