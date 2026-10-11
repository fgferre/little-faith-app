// Capturas da C2 (Noite afinada), estado final do movimento (movimento reduzido).
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const base = pathToFileURL(here + "direcao-visual.html").href;
const browser = await chromium.launch();
const open = async (so, width, height = 900) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await page.goto(`${base}?so=${so}`);
  await page.waitForTimeout(3500);
  return page;
};

// 1) todas as telas de celular a 390
let page = await open("inicio,antes,fosca,semp,loto,quina,zap,form", 2120);
await page.screenshot({ path: here + "noite-celular.png", fullPage: true });
await page.close();

// 2) bolão antes + Lotofácil + Início a 320
page = await open("inicio,antes,loto", 1100);
await page.addStyleTag({ content: ".phone{width:320px!important}" });
await page.waitForTimeout(500);
await page.screenshot({ path: here + "noite-320.png", fullPage: true });
await page.close();

// 2b) cartão do WhatsApp a 320 (encolhe inteiro, nomes visíveis)
page = await open("zap", 1000);
await page.addStyleTag({ content: ".phone{width:320px!important}" });
await page.waitForTimeout(500);
await page.locator('[data-grupo="zap"] .screen').screenshot({ path: here + "noite-zap-320.png" });
await page.close();

// 3) bolas de metal: três acabamentos lado a lado (cada um com 390 de largura)
page = await open("metais", 1320);
await page.locator('[data-grupo="metais"]').screenshot({ path: here + "noite-metais.png" });
await page.close();

// 4) computador 1440 x 900
page = await open("desk", 1440, 900);
await page.screenshot({ path: here + "noite-computador.png" });
await page.close();

await browser.close();
console.log("ok");
