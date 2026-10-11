// Medições de uma tela real do app (adaptado de docs/estilo/medir.mjs): contraste de todo texto visível
// (pixels reais com o texto escondido), bordas tocáveis abaixo de 3:1, letra abaixo de 12 px e transbordo lateral.
// Uso: node scripts/visual/medir.mjs <url> <largura>
import { chromium } from "@playwright/test";

const [url, widthArg] = process.argv.slice(2);
if (!url || !widthArg) {
  console.error("Uso: node scripts/visual/medir.mjs <url> <largura>");
  process.exit(1);
}
const width = Number(widthArg);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
});
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);

// 1) transbordo lateral e letra pequena, na janela real
const layout = await page.evaluate(() => {
  const desc = (el) => (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 32) +
    ` <${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : ""}>`;
  const W = window.innerWidth;
  const offenders = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= W + .5) continue;
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== "visible" && a.getBoundingClientRect().right <= W + .5) {
        clipped = true;
        break;
      }
    }
    if (!clipped) offenders.push(`${desc(el)} +${(r.right - W).toFixed(1)}px`);
  }
  const small = {};
  for (const el of document.body.querySelectorAll("*")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
    const size = parseFloat(cs.fontSize);
    if (size < 12) small[`${size}px ${desc(el)}`] = (small[`${size}px ${desc(el)}`] || 0) + 1;
  }
  return {
    overflow: { page: `${document.documentElement.scrollWidth}/${W}`, offenders: offenders.slice(0, 12) },
    small,
    sora: document.fonts.check('600 16px "Sora"'),
  };
});

// 2) contraste: a janela cresce até a altura da página para que posições e foto coincidam
const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width, height: Math.min(fullHeight, 8000) });
await page.waitForTimeout(500);
const collected = await page.evaluate(() => {
  const desc = (el) => (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 32) +
    ` <${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : ""}>`;
  const opacityOf = (el) => {
    let o = 1;
    for (let a = el; a; a = a.parentElement) o *= Number(getComputedStyle(a).opacity);
    return o;
  };
  const visibleArea = (el, box) => {
    let c = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const r = a.getBoundingClientRect();
        const fade = cs.maskImage && cs.maskImage !== "none";
        const fl = fade ? parseFloat(cs.getPropertyValue("--fl")) || 0 : 0;
        const fr = fade ? parseFloat(cs.getPropertyValue("--fr")) || 0 : 0;
        c = { l: Math.max(c.l, r.left + fl), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right - fr), b: Math.min(c.b, r.bottom) };
      }
    }
    const w = Math.max(0, Math.min(box.r, c.r) - Math.max(box.l, c.l));
    const h = Math.max(0, Math.min(box.b, c.b) - Math.max(box.t, c.t));
    return (w * h) / ((box.r - box.l) * (box.b - box.t));
  };
  const texts = [], skipped = [];
  for (const el of document.body.querySelectorAll("*")) {
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    const isField = ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
    if (!nodes.length && !isField) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const opacity = opacityOf(el);
    if (opacity < .05) continue;
    let box;
    if (isField) {
      const b = el.getBoundingClientRect();
      if (!b.width) continue;
      box = { l: b.left + 4, t: b.top + b.height * .3, r: b.left + Math.min(90, b.width - 4), b: b.top + b.height * .7 };
    } else {
      let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
      for (const n of nodes) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const q of range.getClientRects()) {
          if (!q.width) continue;
          l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
        }
      }
      if (r <= l) continue;
      box = { l, t: t + (b - t) * .2, r, b: t + (b - t) * .8 };
    }
    if (visibleArea(el, box) < .9) { skipped.push(`${desc(el)} (fora da área visível)`); continue; }
    const hit = document.elementFromPoint((box.l + box.r) / 2, (box.t + box.b) / 2);
    if (hit && !(hit === el || el.contains(hit) || hit.contains(el))) { skipped.push(`${desc(el)} (coberto)`); continue; }
    texts.push({ label: desc(el), color: cs.color, opacity, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), ...box });
  }
  const borders = [];
  for (const el of document.body.querySelectorAll("button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=switch]")) {
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderLeftWidth);
    const alpha = (cs.borderLeftColor.match(/[\d.]+/g) || []).map(Number)[3];
    if (bw < 1 || cs.borderLeftStyle === "none" || alpha === 0 || opacityOf(el) < .05) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || visibleArea(el, { l: r.left, t: r.top, r: r.right, b: r.bottom }) < .9) continue;
    borders.push({ label: desc(el), bw, x: r.left, y: r.top + r.height / 2 });
  }
  return { texts, skipped, borders };
});

await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}" });
await page.waitForTimeout(300);
const shot = (await page.screenshot()).toString("base64");
const measured = await page.evaluate(async ({ shot, texts, borders }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + shot;
  await img.decode();
  const k = img.width / window.innerWidth;
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const lin = (c) => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  const L = (r, g, b) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
  const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  const t = texts.map((x) => {
    const [r, g, b, a = 1] = x.color.match(/[\d.]+/g).map(Number);
    const alpha = a * x.opacity;
    const px = cx.getImageData(Math.round(x.l * k), Math.round(x.t * k), Math.max(1, Math.round((x.r - x.l) * k)), Math.max(1, Math.round((x.b - x.t) * k))).data;
    const rs = [];
    for (let i = 0; i < px.length; i += 4) {
      const mix = (c, bg) => alpha * c + (1 - alpha) * bg;
      rs.push(ratio(L(mix(r, px[i]), mix(g, px[i + 1]), mix(b, px[i + 2])), L(px[i], px[i + 1], px[i + 2])));
    }
    rs.sort((p, q) => p - q);
    const large = x.size >= 24 || (x.size >= 18.66 && x.weight >= 700);
    return { label: x.label, color: x.color, size: x.size, worst: +rs[Math.floor(rs.length * .02)].toFixed(2), need: large ? 3 : 4.5 };
  });
  const col = (dx, y) => {
    const v = [];
    for (let d = -6; d <= 6; d += 2) { const p = cx.getImageData(dx, Math.round((y + d) * k), 1, 1).data; v.push(L(p[0], p[1], p[2])); }
    v.sort((p, q) => p - q);
    return v[3];
  };
  const b = borders.map((e) => {
    const out = col(Math.round((e.x - 3) * k), e.y), fill = col(Math.round((e.x + e.bw + 3) * k), e.y);
    let best = 1;
    for (let dx = Math.floor(e.x * k) - 1; dx <= Math.ceil((e.x + e.bw) * k) + 1; dx++) best = Math.max(best, ratio(col(dx, e.y), out));
    return { label: e.label, border: +best.toFixed(2), fill: +ratio(fill, out).toFixed(2) };
  });
  return { t, b };
}, { shot, texts: collected.texts, borders: collected.borders });
await browser.close();

const sorted = measured.t.slice().sort((a, b) => a.worst - b.worst);
const report = {
  url,
  width,
  sora: layout.sora,
  textCount: measured.t.length,
  lowestText: sorted[0] ?? null,
  textBelowAA: sorted.filter((x) => x.worst < x.need),
  bordersBelow3: measured.b.filter((x) => x.border < 3).sort((a, b) => a.border - b.border),
  fontsUnder12px: layout.small,
  overflow: layout.overflow,
  skipped: collected.skipped.length,
};
console.log(JSON.stringify(report, null, 1));
