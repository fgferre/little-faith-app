// Foto da página inteira de uma tela real do app, com movimento reduzido (estado final).
// Uso: node scripts/visual/foto.mjs <url> <largura> <saida.png>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [url, width, out] = process.argv.slice(2);
if (!url || !width || !out) {
  console.error("Uso: node scripts/visual/foto.mjs <url> <largura> <saida.png>");
  process.exit(1);
}
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
});
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
