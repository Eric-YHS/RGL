/** Record the real practice task at 1400x850 for the narrated tutorial. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const outDir = path.resolve("output/playwright/auto-green-capture");
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
  await page.evaluate(() => {
    const cursor = document.createElement("div");
    cursor.style.cssText = "position:fixed;z-index:99999;width:27px;height:36px;pointer-events:none;filter:drop-shadow(1px 2px 1px #555)";
    cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="27" height="36" viewBox="0 0 27 36"><path d="M2 2v27l7-7 5 12 5-2-5-12h10Z" fill="white" stroke="black" stroke-width="2"/></svg>';
    document.body.append(cursor);
    const began = performance.now();
    window.setInterval(() => {
      const t = (performance.now() - began) / 1000;
      let x = 700, y = 620;
      if (t < 6) { x = 350 + t * 105; y = 400; }
      else if (t < 19.5) { x = 720 + 35 * Math.cos(t * 2); y = 110 + 10 * Math.sin(t * 2); }
      else if (t < 25.1) { x = 700; y = 180; }
      else if (t < 35.0) { x = 700 + 50 * Math.cos(t * 2.5); y = 620 + 23 * Math.sin(t * 2.5); }
      else if (t < 39) { x = 345 + (t - 35) * 84; y = 470; }
      else if (t < 45) { x = 720; y = 110; }
      else if (t < 51) { x = 700 + 48 * Math.cos(t * 2); y = 620 + 24 * Math.sin(t * 2); }
      else if (t < 55) { x = 700; y = 190; }
      else { x = 1015; y = 440; }
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }, 16);
  });
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
