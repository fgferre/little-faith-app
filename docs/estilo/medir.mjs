// Medições da C2 (Noite afinada): contraste de todo texto e das bordas tocáveis
// (pixels reais com o texto escondido), estouro de largura a 320/360/390, tamanhos, alvos de toque e movimento.
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const url = pathToFileURL(here + "direcao-visual.html").href;
const browser = await chromium.launch();

// ---------- 1) contraste ----------
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
await page.goto(url);
await page.waitForTimeout(3500);
const fonts = await page.evaluate(async () => {
  await document.fonts.ready;
  return { sora800: document.fonts.check('800 16px "Sora"'), sora500: document.fonts.check('500 16px "Sora"'),
    faces: [...document.fonts].filter(f => f.family.replace(/"/g, "") === "Sora").map(f => `${f.weight}:${f.status}`).join(" ") };
});
const groups = await page.evaluate(() => [...document.querySelectorAll("[data-grupo]")].map(s => s.dataset.grupo));

const collect = g => page.evaluate(g => {
  const sec = document.querySelector(`[data-grupo="${g}"]`); const sr = sec.getBoundingClientRect();
  const desc = el => (el.closest("[data-metal]") ? `[${el.closest("[data-metal]").dataset.metal}] ` : "") + (el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 30) + ` <${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}>`;
  const clipOf = el => {
    let c = null;
    for (let a = el.parentElement; a && a !== sec; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const r = a.getBoundingClientRect(); const fade = a.matches(".steps ol") && cs.maskImage !== "none";
        const fl = fade ? parseFloat(cs.getPropertyValue("--fl")) || 0 : 0, fr = fade ? parseFloat(cs.getPropertyValue("--fr")) || 0 : 0;
        const box = { l: r.left + fl, t: r.top, r: r.right - fr, b: r.bottom };
        c = c ? { l: Math.max(c.l, box.l), t: Math.max(c.t, box.t), r: Math.min(c.r, box.r), b: Math.min(c.b, box.b) } : box;
      }
    }
    return c;
  };
  const texts = [], skipped = [];
  sec.querySelectorAll(".screen *").forEach(el => {
    const isInput = el.tagName === "INPUT";
    const nodes = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
    if (!isInput && !nodes.length) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden") return;
    const scr = el.closest(".screen");
    if (scr.querySelector(".sheet-wrap") && !el.closest(".sheet")) { skipped.push(desc(el) + " (atrás da folha)"); return; }
    let x, y, w, h;
    if (isInput) { const b = el.getBoundingClientRect(); x = b.left + 2; y = b.top + b.height * .3; w = Math.min(90, b.width - 4); h = b.height * .4; }
    else {
      let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
      nodes.forEach(n => { const rg = document.createRange(); rg.selectNodeContents(n); const q = rg.getBoundingClientRect(); if (!q.width) return; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); });
      if (r <= l) return;
      x = l; w = r - l; y = t + (b - t) * .2; h = (b - t) * .6;
    }
    const c = clipOf(el);
    if (c) {
      const vl = Math.max(x, c.l), vr = Math.min(x + w, c.r), vt = Math.max(y, c.t), vb = Math.min(y + h, c.b);
      const vis = Math.max(0, vr - vl) * Math.max(0, vb - vt) / (w * h);
      if (vis < .9) { skipped.push(desc(el) + " (fora da área visível)"); return; }
    }
    texts.push({ label: desc(el), color: cs.color, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), x: x - sr.left, y: y - sr.top, w, h });
  });
  const borders = [];
  sec.querySelectorAll(".screen button, .screen a, .screen .input, .screen [role=radio]").forEach(el => {
    const cs = getComputedStyle(el); const bw = parseFloat(cs.borderLeftWidth);
    const a = (cs.borderLeftColor.match(/[\d.]+/g) || []).map(Number);
    if (bw < 1 || cs.borderLeftStyle === "none" || (a.length === 4 && a[3] === 0)) return;
    const r = el.getBoundingClientRect();
    borders.push({ label: desc(el), bw, x: r.left - sr.left, y: r.top + r.height / 2 - sr.top, w: r.width });
  });
  return { texts, skipped, borders };
}, g);

const perGroup = {};
for (const g of groups) perGroup[g] = await collect(g);
await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}" });
await page.waitForTimeout(300);
const textRes = [], borderRes = [];
for (const g of groups) {
  const b64 = (await page.locator(`[data-grupo="${g}"]`).screenshot()).toString("base64");
  const out = await page.evaluate(async ({ b64, texts, borders }) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0);
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const t = texts.map(t => {
      const [r, g, b] = t.color.match(/[\d.]+/g).map(Number); const lt = L(r, g, b);
      const d = cx.getImageData(Math.round(t.x * 2), Math.round(t.y * 2), Math.max(1, Math.round(t.w * 2)), Math.max(1, Math.round(t.h * 2))).data; const rs = [];
      for (let i = 0; i < d.length; i += 4) rs.push(ratio(lt, L(d[i], d[i + 1], d[i + 2])));
      rs.sort((a, b) => a - b);
      return { label: t.label, color: t.color, size: t.size, weight: t.weight, worst: +rs[Math.floor(rs.length * .02)].toFixed(2), median: +rs[Math.floor(rs.length / 2)].toFixed(2) };
    });
    const colD = (dx, y) => { const v = []; for (let k = -6; k <= 6; k += 2) { const p = cx.getImageData(dx, Math.round((y + k) * 2), 1, 1).data; v.push(L(p[0], p[1], p[2])); } v.sort((a, b) => a - b); return v[3]; };
    const col = (x, y) => colD(Math.round(x * 2), y);
    const b = borders.map(e => {
      const lo = col(e.x - 3, e.y), li = col(e.x + e.bw + 3, e.y);
      let lb = lo, best = 0;
      for (let dx = Math.floor(e.x * 2) - 1; dx <= Math.ceil((e.x + e.bw) * 2) + 1; dx++) { const v = colD(dx, e.y); const r = ratio(v, lo); if (r > best) { best = r; lb = v; } }
      return { label: e.label, outside: +ratio(lb, lo).toFixed(2), inside: +ratio(lb, li).toFixed(2) };
    });
    return { t, b };
  }, { b64, texts: perGroup[g].texts, borders: perGroup[g].borders });
  out.t.forEach(x => textRes.push({ g, ...x }));
  out.b.forEach(x => borderRes.push({ g, ...x }));
}
await page.close();

// ---------- 2) estouro de largura, tamanhos e alvos ----------
const p2 = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
await p2.goto(url);
await p2.waitForTimeout(3000);
const overflow = {};
for (const W of [320, 360, 390]) {
  await p2.evaluate(W => document.querySelectorAll(".phone").forEach(p => (p.style.width = W + "px")), W);
  await p2.waitForTimeout(400);
  overflow[W] = await p2.evaluate(() => [...document.querySelectorAll(".phone")].map(ph => {
    const scr = ph.querySelector(".screen"); const label = ph.querySelector(".frame-label").textContent;
    const desc = el => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24) + ` <${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).trim().split(/\s+/).join(".")}>`;
    const bad = [];
    scr.querySelectorAll("*").forEach(el => {
      if (el.closest(".steps, .tabbar, svg") || el.matches(".sheet-wrap, .sheet")) return;
      const box = el.parentElement.closest(".card, .sheet, .share, .prob-box, .screen");
      const r = el.getBoundingClientRect(); if (!r.width) return;
      const b = box.getBoundingClientRect(), cs = getComputedStyle(box), isScr = box === scr, k = box.offsetWidth ? b.width / box.offsetWidth : 1;
      const L = b.left + (isScr ? 0 : (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) * k);
      const R = b.right - (isScr ? 0 : (parseFloat(cs.borderRightWidth) + parseFloat(cs.paddingRight)) * k);
      const over = Math.max(r.right - R, L - r.left);
      if (over > .5) bad.push(`${desc(el)} +${over.toFixed(1)}`);
    });
    const collide = [...scr.querySelectorAll(".game")].filter(g => {
      const w = g.querySelector(".who"), bl = g.querySelector(".balls"); if (!w || !bl) return false;
      return [...w.children].some(c => { const a = c.getBoundingClientRect(), d = bl.getBoundingClientRect(); return a.width && a.right > d.left && a.left < d.right && a.bottom > d.top && a.top < d.bottom; });
    }).map(g => g.querySelector(".who b").textContent);
    const steps = [...scr.querySelectorAll(".steps ol")].map(ol => {
      const n = ol.querySelector(".now").getBoundingClientRect(), o = ol.getBoundingClientRect(), cs = getComputedStyle(ol);
      const fl = parseFloat(cs.getPropertyValue("--fl")) || 0, fr = parseFloat(cs.getPropertyValue("--fr")) || 0;
      return n.left >= o.left + fl && n.right <= o.right - fr ? "atual visível" : `atual cortada (${Math.round(n.left - o.left)}..${Math.round(n.right - o.left)} de ${Math.round(o.width)})`;
    });
    const share = scr.querySelector(".share");
    const sheet = scr.querySelector(".sheet");
    const prize = scr.querySelector(".prize");
    return { label, screen: `${scr.scrollWidth}/${scr.clientWidth}`, bad, collide, steps: [...new Set(steps)],
      share: share ? `${Math.round(share.getBoundingClientRect().width)}x${Math.round(share.getBoundingClientRect().height)} (conteúdo ${share.scrollHeight}/${share.clientHeight}, nomes ${[...share.querySelectorAll(".who")].filter(w => w.getBoundingClientRect().width > 20).length})` : undefined,
      sheetTop: sheet ? Math.round(sheet.getBoundingClientRect().top - scr.getBoundingClientRect().top) : undefined,
      prize: prize ? `${getComputedStyle(prize).fontSize}` : undefined,
      ball: getComputedStyle(scr.querySelector(".game .ball") || scr).width };
  }));
}
await p2.evaluate(() => document.querySelectorAll(".phone").forEach(p => (p.style.width = "")));
await p2.waitForTimeout(300);
const sizes = await p2.evaluate(() => {
  const small = {}, taps = [];
  document.querySelectorAll(".screen *").forEach(el => {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
    const cs = getComputedStyle(el); const s = parseFloat(cs.fontSize);
    if (s < 13) { const k = `${s}px ${el.className || el.tagName}`; small[k] = (small[k] || 0) + 1; }
  });
  document.querySelectorAll(".phone .screen button, .phone .screen a, .phone .screen input").forEach(el => {
    const r = el.getBoundingClientRect(); if (r.height < 44 || r.width < 44) taps.push(`${(el.textContent || el.id).trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  });
  const m = document.querySelector(".dmain"), cols = [...document.querySelectorAll(".desk .col")].map(c => Math.round(m.getBoundingClientRect().bottom - c.lastElementChild.getBoundingClientRect().bottom));
  const stepW = [...document.querySelectorAll(".steps ol")].map(ol => `${ol.scrollWidth}/${ol.clientWidth}`);
  return { small, taps, desk: { main: `${m.scrollHeight}/${m.clientHeight}`, mainW: `${m.scrollWidth}/${m.clientWidth}`, gapBelowCols: cols }, stepW };
});
await p2.close();

// ---------- 3) movimento ----------
const p3 = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await p3.goto(url);
await p3.waitForTimeout(7000);
const motion = await p3.evaluate(() => ({ runningAfter7s: document.getAnimations().filter(a => a.playState === "running").length, prize: document.querySelector(".prize").textContent }));
await p3.close();
const p4 = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: "reduce" });
await p4.goto(url);
await p4.waitForTimeout(800);
const reduced = await p4.evaluate(() => ({ animations: document.getAnimations().length, prize: document.querySelector(".prize").textContent }));
await p4.close();
await browser.close();

const lowText = textRes.filter(t => t.worst < 4.5).sort((a, b) => a.worst - b.worst);
const minText = textRes.reduce((m, t) => (t.worst < m.worst ? t : m));
const minBorder = borderRes.map(b => ({ ...b, min: Math.min(b.outside, b.inside) })).sort((a, b) => a.min - b.min);
const out = { fonts, textCount: textRes.length, minText, lowText, minBorder, overflow, sizes, motion, reduced,
  skipped: Object.fromEntries(groups.map(g => [g, perGroup[g].skipped.length])), texts: textRes };
writeFileSync(here + "medidas.json", JSON.stringify(out, null, 1));
const summary = { fonts, textCount: textRes.length, minText, lowText, minBorder: minBorder.slice(0, 8), sizes, motion, reduced,
  overflow: Object.fromEntries(Object.entries(overflow).map(([W, fs]) => [W, fs.map(f => ({ ...f, bad: f.bad.length ? f.bad : undefined, collide: f.collide.length ? f.collide : undefined }))])) };
console.log(JSON.stringify(summary, null, 0));
