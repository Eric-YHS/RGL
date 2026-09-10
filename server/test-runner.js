// server/test-runner.js
// 跨平台测试入口：只运行 server/test/ 下 *.test.js 文件。
//
// 为什么需要它：
// - `node --test test` 在 Windows（Node 22）会被当作模块路径解析而失败（MODULE_NOT_FOUND）。
// - `node --test "test/*.test.js"` 依赖 Node 21+ 的 glob 支持，目标环境包含 Node 18.19，不可用。
// - 裸 `node --test`（目录扫描）会把 server/test/helpers.js 这类辅助模块也当作成功子测试计入总数。
//
// 本脚本用 node:fs 显式枚举 *.test.js 并按文件名排序，用参数数组 + spawnSync 启动
// `node --test <文件>...`：不拼 shell 命令、不用 glob、不依赖 Bash/PowerShell 展开，
// Windows/Linux、Node 18 及以上均可直接执行。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, "test");

const testFiles = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(TEST_DIR, name))
  .sort();

if (testFiles.length === 0) {
  console.error(`[test-runner] no *.test.js files found in ${TEST_DIR}`);
  process.exit(1);
}

console.log(`[test-runner] ${testFiles.length} test file(s):`);
for (const file of testFiles) {
  console.log(`  - ${path.basename(file)}`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit"
});

if (result.error) {
  console.error(`[test-runner] failed to start node: ${result.error.message}`);
  process.exit(1);
}
if (result.status === null) {
  console.error(`[test-runner] test process terminated by signal ${result.signal ?? "unknown"}`);
  process.exit(1);
}
process.exit(result.status);
