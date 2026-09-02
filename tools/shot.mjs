// Скриншот страницы в мобильной и десктоп ширине — для сверки вёрстки с макетом.
// Запуск:  node tools/shot.mjs <url> [имя]
//   node tools/shot.mjs http://127.0.0.1:3000/            home
//   node tools/shot.mjs http://127.0.0.1:3000/mockup.html mockup
// PNG кладутся в tools/shots/<имя>-mobile.png и <имя>-desktop.png
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:3000/";
const name = process.argv[3] || "shot";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "shots");

const VIEWS = [
  { tag: "mobile", width: 390, height: 844, dpr: 2, full: true },
  { tag: "desktop", width: 1280, height: 900, dpr: 1, full: false },
];

const browser = await chromium.launch();
try {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.dpr,
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(400); // шрифты/анимация fade
    const file = join(outDir, `${name}-${v.tag}.png`);
    await page.screenshot({ path: file, fullPage: v.full });
    console.log("saved", file);
    await ctx.close();
  }
} finally {
  await browser.close();
}
