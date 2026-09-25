/** Record the real practice task at 1400x850 for the narrated tutorial. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const outDir = path.resolve("output/playwright/cursor-free-capture");
await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const context = await browser.newContext({
  viewport: { width: 1400, height: 850 },
  recordVideo: { dir: outDir, size: { width: 1400, height: 850 } }
});
const page = await context.newPage();
const pageCreatedAt = Date.now();
try {
  await page.goto("http://127.0.0.1:5173/?pid=video-auto-green-0924");
  await page.getByRole("button", { name: "阅读任务指导" }).click();
  await page.getByRole("button", { name: "下一步：理解测试" }).click();
  await page.getByRole("radio", { name: "B. 越来越少" }).click();
  await page.getByRole("radio", { name: "B. 在红绿灯处等待，直到绿灯亮起" }).click();
  await page.getByRole("button", { name: "我已作答，下一步" }).click();
  await page.getByRole("button", { name: "开始" }).waitFor();
  const offsetSec = (Date.now() - pageCreatedAt) / 1000;
  // Pointer is composed later from the final narration timeline.
  await page.addStyleTag({ content: "* { cursor: none !important; }" });
  await page.waitForTimeout(35000);
  await page.getByRole("button", { name: "开始" }).click();
  await page.waitForTimeout(25000);
  const practiceComplete = await page.getByRole("heading", { name: "练习完成" }).isVisible();
  if (!practiceComplete) throw new Error("Practice did not complete automatically after green");
  const videoPath = await page.video().path();
  await context.close();
  await fs.copyFile(videoPath, path.join(outDir, "recording.webm"));
  await fs.writeFile(path.join(outDir, "timing.json"), JSON.stringify({ offsetSec, actionAtSec: offsetSec + 35, greenAtSec: offsetSec + 51, finishAtSec: offsetSec + 55 }, null, 2));
  console.log(JSON.stringify({ offsetSec, practiceComplete, videoPath }));
} finally {
  await browser.close();
}
