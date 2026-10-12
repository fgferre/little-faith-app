import type { LotteryId } from "@bolao/core";
import { LACO } from "./BrandMark";

/** Um jogo no cartão: só os números, nunca dados de pagamento. */
export interface ShareCardGame {
  numbers: number[];
  /** Selo do jogo premiado ("Quadra!"): os acertos ficam em ouro. */
  tag?: string | undefined;
  /** Contagem apagada do jogo sem prêmio ("3 acertos"): os acertos ganham anel de ouro. */
  hits?: string | undefined;
  /** Jogo ampliado, em letra pequena: "7 dezenas". */
  size?: string | undefined;
}

/** Os jogos de quem escolheu ("Rafael · 4 jogos"); os sem autor em "Jogos da turma · 18". */
export interface ShareCardGroup {
  label: string;
  games: ShareCardGame[];
}

export interface ShareCardData {
  title: string;
  modality: LotteryId;
  /** "Mega-Sena · 11/10" */
  chip: string;
  /** Números sorteados; null antes do sorteio. */
  drawn: number[] | null;
  /** Jogos por quem escolheu, em ordem; o cartão mostra até 6 jogos e conta o resto. */
  groups: ShareCardGroup[];
  /** Linha final: título e prêmio em ouro (value), ou título com um detalhe apagado. */
  result: {
    title: string;
    value?: string | undefined;
    detail?: string | undefined;
  };
}

type Ctx = CanvasRenderingContext2D;
type Finish = "silver" | "gold" | "ring";

const W = 1080;
const H = 1350;
const TAU = Math.PI * 2;
const FONT = "Sora, system-ui, sans-serif";
const INK = "#f4f1ff";
const MUTED = "#a9a3cc";
const GOLD = "#ffcf4a";
const GOLD_INK = "#2a1d00";
const MOD: Record<LotteryId, string> = {
  "mega-sena": "#3ee6a0",
  lotofacil: "#f07cf5",
  quina: "#5cc8ff",
};
// cartão de vidro e área do conteúdo
const CARD = { x: 28, y: 28, w: W - 56, h: H - 56, r: 52 };
const X0 = 84;
const X1 = W - 84;
const CW = X1 - X0;
const TOP = 84;
const BOTTOM = H - 76;
// Nada abaixo de 36 px: o cartão aparece com uns 360 px de largura no WhatsApp (36 px viram 12 px).
const SMALL = 36;
const MAX_GAMES = 6;

/** As mesmas camadas das bolas de metal polido do kit (ui.css, --ag e --au). */
const METAL = {
  silver: {
    base: [
      [0, "#f6f6fb"],
      [.34, "#e8e8f0"],
      [.58, "#b4b4c7"],
      [.84, "#8e8ea3"],
      [1, "#9f9bbd"],
    ],
    sheen: "255, 255, 255",
    under: "168, 146, 255",
    underAlpha: .42,
    edge: "27, 20, 70",
    edgeAlpha: .38,
    ink: "#1b1446",
    inkLight: "rgba(255, 255, 255, .4)",
  },
  gold: {
    base: [
      [0, "#fff3c6"],
      [.34, "#ffe08a"],
      [.58, "#e6b03a"],
      [.84, "#b8860b"],
      [1, "#c99a2a"],
    ],
    sheen: "255, 248, 222",
    under: "255, 214, 120",
    underAlpha: .55,
    edge: "96, 54, 0",
    edgeAlpha: .42,
    ink: GOLD_INK,
    inkLight: "rgba(255, 246, 214, .45)",
  },
} as const;
const RING = [
  [0, "#fff2bd"],
  [.18, "#d9a12a"],
  [.38, "#ffe08a"],
  [.6, "#9a6a05"],
  [.8, "#ffd66e"],
  [1, "#fff2bd"],
] as const;

function font(ctx: Ctx, weight: number, size: number, spacing = 0) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
}

/** Escreve com a altura das maiúsculas centrada em `cy`. */
function line(
  ctx: Ctx,
  text: string,
  x: number,
  cy: number,
  color: string,
  align: CanvasTextAlign = "left",
) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, cy + ctx.measureText("H").actualBoundingBoxAscent / 2);
}

/** Corta com reticências o que não cabe em `max`. */
function clip(ctx: Ctx, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

/** Maior tamanho (até `size`, não menos que `min`) em que o texto cabe em `max`. */
function fit(
  ctx: Ctx,
  text: string,
  max: number,
  weight: number,
  size: number,
  min: number,
  spacing = 0,
) {
  let s = size;
  font(ctx, weight, s, s * spacing);
  while (s > min && ctx.measureText(text).width > max) {
    s -= 2;
    font(ctx, weight, s, s * spacing);
  }
  return s;
}

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** linear-gradient(<deg>) do CSS sobre a caixa dada. */
function cssLinear(ctx: Ctx, x: number, y: number, size: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(size * dx) + Math.abs(size * dy)) / 2;
  const cx = x + size / 2;
  const cy = y + size / 2;
  return ctx.createLinearGradient(
    cx - dx * half,
    cy - dy * half,
    cx + dx * half,
    cy + dy * half,
  );
}

/** Uma bola de metal polido, como .ui-ball do kit (1 px do kit = d/32 aqui). */
function ball(
  ctx: Ctx,
  cx: number,
  cy: number,
  d: number,
  finish: Finish,
  label?: string,
  fontRatio = .46,
) {
  const k = d / 32;
  const r = d / 2;
  const x = cx - r;
  const y = cy - r;
  const metal = METAL[finish === "gold" ? "gold" : "silver"];

  // sombra; o ouro ainda brilha em volta
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = metal.base[2][1];
  if (finish === "gold") {
    ctx.shadowColor = "rgba(255, 207, 74, .45)";
    ctx.shadowBlur = 12 * k;
    ctx.fill();
  }
  ctx.shadowColor = `rgba(0, 0, 0, ${finish === "gold" ? .3 : .35})`;
  ctx.shadowBlur = 2 * k;
  ctx.shadowOffsetY = k;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  const base = cssLinear(ctx, x, y, d, 172);
  for (const [at, color] of metal.base) base.addColorStop(at, color);
  ctx.fillStyle = base;
  ctx.fillRect(x, y, d, d);

  const edge = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  edge.addColorStop(.7, `rgba(${metal.edge}, 0)`);
  edge.addColorStop(1, `rgba(${metal.edge}, ${metal.edgeAlpha})`);
  ctx.fillStyle = edge;
  ctx.fillRect(x, y, d, d);

  // luz refletida embaixo: elipse 70 % x 42 % em (50 %, 104 %)
  ctx.save();
  ctx.translate(cx, y + 1.04 * d);
  ctx.scale(1, .42 / .7);
  const under = ctx.createRadialGradient(0, 0, 0, 0, 0, .7 * d);
  under.addColorStop(0, `rgba(${metal.under}, ${metal.underAlpha})`);
  under.addColorStop(1, `rgba(${metal.under}, 0)`);
  ctx.fillStyle = under;
  ctx.fillRect(-d, -3 * d, 2 * d, 6 * d);
  ctx.restore();

  const sheen = cssLinear(ctx, x, y, d, 128);
  sheen.addColorStop(.19, `rgba(${metal.sheen}, 0)`);
  sheen.addColorStop(.3, `rgba(${metal.sheen}, .9)`);
  sheen.addColorStop(.37, `rgba(${metal.sheen}, .25)`);
  sheen.addColorStop(.45, `rgba(${metal.sheen}, 0)`);
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, d, d);

  const spot = ctx.createRadialGradient(
    x + .3 * d,
    y + .22 * d,
    0,
    x + .3 * d,
    y + .22 * d,
    .08 * d,
  );
  spot.addColorStop(.45, "#fff");
  spot.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = spot;
  ctx.fillRect(x, y, d, d);
  ctx.restore();

  // acerto de jogo sem prêmio: anel fino de ouro
  if (finish === "ring") {
    ctx.save();
    if (typeof ctx.createConicGradient === "function") {
      // o conic-gradient do CSS começa no alto; o do canvas, à direita
      const ring = ctx.createConicGradient(((200 - 90) * Math.PI) / 180, cx, cy);
      for (const [at, color] of RING) ring.addColorStop(at, color);
      ctx.strokeStyle = ring;
    } else {
      ctx.strokeStyle = "#e6b03a";
    }
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1.25 * k, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  if (label) {
    ctx.save();
    font(ctx, 700, Math.round(d * fontRatio));
    ctx.fillStyle = metal.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = metal.inkLight;
    ctx.shadowOffsetY = k;
    const m = ctx.measureText(label);
    ctx.fillText(
      label,
      cx,
      cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
    );
    ctx.restore();
  }
}

/** Números tabulares: cada algarismo ocupa a mesma largura (o canvas não tem font-variant-numeric). */
function tabular(ctx: Ctx, text: string, cx: number, cy: number, spacing = 0) {
  const digit = Math.max(
    ..."0123456789".split("").map((d) => ctx.measureText(d).width),
  );
  const runs = text.match(/\d|\D+/g) ?? [];
  const widths = runs.map((run) =>
    /^\d$/.test(run) ? digit : ctx.measureText(run).width
  );
  const total = widths.reduce((a, b) => a + b, 0) +
    spacing * (runs.length - 1);
  const baseline = cy + ctx.measureText("0").actualBoundingBoxAscent / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let x = cx - total / 2;
  runs.forEach((run, i) => {
    const w = widths[i] ?? 0;
    ctx.fillText(run, x + w / 2, baseline);
    x += w + spacing;
  });
  return total;
}

function tabularWidth(ctx: Ctx, text: string, spacing = 0) {
  const digit = Math.max(
    ..."0123456789".split("").map((d) => ctx.measureText(d).width),
  );
  const runs = text.match(/\d|\D+/g) ?? [];
  return runs.reduce(
    (sum, run) =>
      sum + (/^\d$/.test(run) ? digit : ctx.measureText(run).width),
    0,
  ) + spacing * (runs.length - 1);
}

function hexAlpha(hex: string, alpha: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const sorted = (numbers: number[]) => [...numbers].sort((a, b) => a - b);

/**
 * A marca: o laço da turma em vetor (LACO, caixa de 100; na tela a marca é a imagem 3D), centrado na linha. O laço
 * ocupa uns 70 da caixa de 100 com a borda; aqui ele ocupa os 1,9em de largura que as duas bolas ocupavam.
 */
function brandMark(ctx: Ctx, x: number, cy: number, em: number) {
  const size = 1.9 * em;
  const k = size / 70;
  const petal = new Path2D(LACO.petal);
  const shine = new Path2D(LACO.shine);
  ctx.save();
  ctx.translate(x + size / 2, cy);
  ctx.scale(k, k);
  ctx.translate(-50, -50);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = hexAlpha(LACO.rim, .55);
  LACO.petals.forEach((p, i) => {
    ctx.save();
    ctx.translate(50, 50);
    ctx.rotate((45 + 90 * i) * Math.PI / 180);
    ctx.translate(-50, -50);
    // o degradê do SVG vai de canto a canto da pétala (34 × 46); este vetor dá as mesmas faixas
    const fill = ctx.createLinearGradient(33, 8, 77, 40.5);
    for (const [offset, color] of p.stops) fill.addColorStop(offset, color);
    ctx.fillStyle = fill;
    ctx.fill(petal);
    ctx.stroke(petal);
    ctx.fillStyle = `rgba(255, 255, 255, ${p.shine})`;
    ctx.fill(shine);
    ctx.restore();
  });
  // o nó: o radial do SVG (centro em .35/.3 e raio .8 da caixa do círculo)
  const knot = ctx.createRadialGradient(48.35, 47.8, 0, 48.35, 47.8, 8.8);
  for (const [offset, color] of LACO.knot) knot.addColorStop(offset, color);
  ctx.fillStyle = knot;
  ctx.beginPath();
  ctx.arc(50, 50, 5.5, 0, TAU);
  ctx.fill();
  ctx.restore();
  return size;
}

interface GamesLayout {
  groups: ShareCardGroup[];
  shown: { game: ShareCardGame; group: number }[];
  more: number;
  d: number;
  gap: number;
  perLine: number;
  lines: number;
  rowH: number;
  rowGap: number;
  height: number;
}
const HEAD_SIZE = 40;
const HEAD_H = 52; // cabeçalho "Rafael · 4 jogos" com o espaço abaixo
const HEAD_GAP = 10;
const TAG_H = 52;
const TEXT_H = 44; // uma linha pequena: "3 acertos", "7 dezenas"
const MORE_H = 60; // linha "+N jogos" com o espaço acima

/** O que vai ao lado das bolas, de cima para baixo: o selo ou os acertos, e o "7 dezenas". */
function noteParts(ctx: Ctx, game: ShareCardGame) {
  const parts: { tag: boolean; text: string; w: number; h: number }[] = [];
  if (game.tag) {
    font(ctx, 800, SMALL);
    parts.push({ tag: true, text: game.tag, w: ctx.measureText(game.tag).width + 36, h: TAG_H });
  } else if (game.hits) {
    font(ctx, 600, SMALL);
    parts.push({ tag: false, text: game.hits, w: ctx.measureText(game.hits).width, h: TEXT_H });
  }
  if (game.size) {
    font(ctx, 600, SMALL);
    parts.push({ tag: false, text: game.size, w: ctx.measureText(game.size).width, h: TEXT_H });
  }
  return {
    parts,
    w: Math.max(0, ...parts.map((part) => part.w)),
    h: parts.reduce((sum, part) => sum + part.h, 0) + Math.max(0, parts.length - 1) * 6,
  };
}

/**
 * Quantos jogos cabem (até 6) e em que tamanho, com o cabeçalho de cada grupo em cima: as bolas numa
 * fileira quando cabem, senão em duas linhas (ou mais). Bolas menores que 70 px (64 em várias linhas)
 * viram "+N jogos" em vez de encolher mais.
 */
function layoutGames(
  ctx: Ctx,
  groups: ShareCardGroup[],
  rings: boolean,
  space: number,
): GamesLayout {
  const gap = rings ? 12 : 10;
  const all = groups.flatMap((group, index) =>
    group.games.map((game) => ({ game, group: index }))
  );
  const fallback = (count: number): GamesLayout | null => {
    const shown = all.slice(0, count);
    const more = all.length - count;
    const heads = new Set(shown.map((item) => item.group)).size;
    const notes = shown.map((item) => noteParts(ctx, item.game));
    const noteW = Math.max(0, ...notes.map((note) => note.w));
    const noteH = Math.max(0, ...notes.map((note) => note.h));
    const n = Math.max(1, ...shown.map((item) => item.game.numbers.length));
    const avail = CW - (noteW ? noteW + 24 : 0);
    const maxD = noteW ? 84 : 96;
    const least = (lines: number) => lines === 1 ? 70 : 64;
    const across = (lines: number) => {
      const perLine = Math.ceil(n / lines);
      return Math.min(maxD, Math.floor((avail - (perLine - 1) * gap) / perLine));
    };
    let lines = 1;
    while (lines < 4 && across(lines) < least(lines)) lines++;
    const perLine = Math.ceil(n / lines);
    const rowGap = lines === 1 ? 12 : 22;
    const fixed = heads * (HEAD_H + HEAD_GAP) + (more > 0 ? MORE_H : 0);
    const tall = Math.floor(
      ((space - fixed - (count - 1) * rowGap) / count - (lines - 1) * 8) / lines,
    );
    const d = Math.max(36, Math.min(across(lines), tall));
    const rowH = Math.max(lines * d + (lines - 1) * 8, noteH);
    const height = fixed + count * rowH + (count - 1) * rowGap;
    if ((d < least(lines) || height > space) && count > 1) return null;
    return { groups, shown, more, d, gap, perLine, lines, rowH, rowGap, height };
  };
  for (let count = Math.min(MAX_GAMES, all.length); count > 1; count--) {
    const layout = fallback(count);
    if (layout) return layout;
  }
  return fallback(Math.min(1, all.length))!;
}

function drawNote(ctx: Ctx, game: ShareCardGame, x: number, cy: number) {
  const note = noteParts(ctx, game);
  let top = cy - note.h / 2;
  for (const part of note.parts) {
    const mid = top + part.h / 2;
    if (part.tag) {
      font(ctx, 800, SMALL);
      rounded(ctx, x, top, part.w, TAG_H, TAG_H / 2);
      ctx.fillStyle = GOLD;
      ctx.fill();
      line(ctx, part.text, x + part.w / 2, mid, GOLD_INK, "center");
    } else {
      font(ctx, 600, SMALL);
      line(ctx, part.text, x, mid, MUTED);
    }
    top += part.h + 6;
  }
}

/** "Rafael · 4 jogos": o nome em destaque e a contagem apagada. */
function drawHead(ctx: Ctx, label: string, cy: number) {
  const cut = label.lastIndexOf(" · ");
  const count = cut < 0 ? "" : label.slice(cut);
  font(ctx, 600, HEAD_SIZE);
  const countW = ctx.measureText(count).width;
  font(ctx, 700, HEAD_SIZE);
  const name = clip(ctx, cut < 0 ? label : label.slice(0, cut), CW - countW);
  line(ctx, name, X0, cy, INK);
  const x = X0 + ctx.measureText(name).width;
  font(ctx, 600, HEAD_SIZE);
  line(ctx, count, x, cy, MUTED);
}

function drawGames(
  ctx: Ctx,
  layout: GamesLayout,
  drawn: Set<number> | null,
  top: number,
) {
  let y = top;
  let group = -1;
  const { d, gap } = layout;
  const finish = (game: ShareCardGame, n: number): Finish =>
    drawn?.has(n) ? game.tag ? "gold" : "ring" : "silver";
  for (const item of layout.shown) {
    if (item.group !== group) {
      group = item.group;
      drawHead(ctx, layout.groups[group]!.label, y + HEAD_H / 2);
      y += HEAD_H + HEAD_GAP;
    }
    const numbers = sorted(item.game.numbers);
    const lines = Math.ceil(numbers.length / layout.perLine);
    const ballsTop = y + (layout.rowH - (lines * d + (lines - 1) * 8)) / 2;
    numbers.forEach((n, i) => {
      const col = i % layout.perLine;
      const row = Math.floor(i / layout.perLine);
      ball(
        ctx,
        X0 + col * (d + gap) + d / 2,
        ballsTop + row * (d + 8) + d / 2,
        d,
        finish(item.game, n),
        pad(n),
        .48,
      );
    });
    const used = Math.min(numbers.length, layout.perLine);
    drawNote(ctx, item.game, X0 + used * (d + gap) - gap + 24, y + layout.rowH / 2);
    y += layout.rowH + layout.rowGap;
  }
  if (layout.more > 0) {
    font(ctx, 600, SMALL);
    line(
      ctx,
      `+${layout.more} ${layout.more === 1 ? "jogo" : "jogos"}`,
      X0,
      y - layout.rowGap + MORE_H - 22,
      MUTED,
    );
  }
}

/** Os sorteados em ouro: uma fileira espalhada; 15 números viram duas fileiras desencontradas. */
function drawnHeight(count: number) {
  if (count <= 8) return Math.min(104, Math.floor((CW - (count - 1) * 14) / count));
  const perLine = Math.ceil(count / 2);
  const d = Math.min(100, Math.floor((CW - (perLine - 1) * 14) / perLine));
  const pitch = (CW - d) / (perLine - 1);
  return d + Math.max(d + 6, pitch * .866);
}

function drawDrawn(ctx: Ctx, numbers: number[], top: number) {
  const list = sorted(numbers);
  const count = list.length;
  if (count <= 8) {
    const d = Math.min(104, Math.floor((CW - (count - 1) * 14) / count));
    const pitch = count > 1 ? (CW - d) / (count - 1) : 0;
    list.forEach((n, i) =>
      ball(ctx, X0 + d / 2 + i * pitch, top + d / 2, d, "gold", pad(n), .44)
    );
    return;
  }
  const perLine = Math.ceil(count / 2);
  const d = Math.min(100, Math.floor((CW - (perLine - 1) * 14) / perLine));
  const pitch = (CW - d) / (perLine - 1);
  const rise = Math.max(d + 6, pitch * .866);
  list.forEach((n, i) => {
    const row = i < perLine ? 0 : 1;
    const col = row ? i - perLine : i;
    const shift = row && count - perLine < perLine ? pitch / 2 : 0;
    ball(
      ctx,
      X0 + d / 2 + shift + col * pitch,
      top + d / 2 + row * rise,
      d,
      "gold",
      pad(n),
      .44,
    );
  });
}

function eyebrow(ctx: Ctx, text: string, top: number) {
  font(ctx, 700, SMALL, SMALL * .08);
  line(ctx, text.toUpperCase(), X0, top + 20, MUTED);
  return top + 40;
}

function resultHeight(result: ShareCardData["result"]) {
  if (result.value !== undefined) return 54 + 112;
  return 72 + (result.detail ? 54 : 0);
}

function drawResult(ctx: Ctx, result: ShareCardData["result"], top: number) {
  const cx = W / 2;
  if (result.value !== undefined) {
    fit(ctx, result.title, CW, 700, 44, SMALL);
    line(ctx, clip(ctx, result.title, CW), cx, top + 27, INK, "center");
    // prêmio em ouro com brilho, algarismos tabulares
    let size = 104;
    font(ctx, 800, size);
    while (size > 56 && tabularWidth(ctx, result.value, -size * .02) > CW) {
      size -= 4;
      font(ctx, 800, size);
    }
    ctx.save();
    ctx.fillStyle = GOLD;
    ctx.shadowColor = "rgba(255, 207, 74, .4)";
    ctx.shadowBlur = 56;
    tabular(ctx, result.value, cx, top + 54 + 56, -size * .02);
    ctx.restore();
    return;
  }
  fit(ctx, result.title, CW, 700, 60, 40, -.01);
  line(ctx, clip(ctx, result.title, CW), cx, top + 36, INK, "center");
  if (result.detail) {
    font(ctx, 600, SMALL);
    line(ctx, clip(ctx, result.detail, CW), cx, top + 72 + 30, MUTED, "center");
  }
}

function draw(ctx: Ctx, data: ShareCardData) {
  // fundo da noite: radial-gradient(120% 80% at 50% 0%, ...)
  ctx.fillStyle = "#0f0a19";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.setTransform(1, 0, 0, (.8 * H) / (1.2 * W), W / 2, 0);
  const sky = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.2 * W);
  sky.addColorStop(0, "#2a1b3e");
  sky.addColorStop(.6, "#160f23");
  sky.addColorStop(1, "#0f0a19");
  ctx.fillStyle = sky;
  ctx.fillRect(-W, 0, 2 * W, 2 * H);
  ctx.restore();

  // cartão de vidro: branco a 6 %, borda a 12 %
  rounded(ctx, CARD.x, CARD.y, CARD.w, CARD.h, CARD.r);
  ctx.fillStyle = "rgba(255, 255, 255, .06)";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, .12)";
  ctx.stroke();

  // título e selo da modalidade
  let y = TOP;
  fit(ctx, data.title, CW, 700, 56, 44, -.01);
  line(ctx, clip(ctx, data.title, CW), X0, y + 31, INK);
  y += 62 + 16;
  const mod = MOD[data.modality];
  font(ctx, 700, SMALL);
  const chip = clip(ctx, data.chip, CW - 80);
  const chipW = 24 + 16 + 14 + ctx.measureText(chip).width + 26;
  rounded(ctx, X0, y, chipW, 60, 30);
  ctx.fillStyle = hexAlpha(mod, .16);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(X0 + 24 + 8, y + 30, 8, 0, TAU);
  ctx.fillStyle = mod;
  ctx.fill();
  line(ctx, chip, X0 + 24 + 16 + 14, y + 30, mod);
  y += 60;

  if (data.drawn) {
    y = eyebrow(ctx, "Números sorteados", y + 32) + 14;
    drawDrawn(ctx, data.drawn, y);
    y += drawnHeight(data.drawn.length);
  }

  // rodapé, de baixo para cima: marca + "sem dados de pagamento"; acima, a linha do resultado
  const footer = BOTTOM - 26;
  const markW = brandMark(ctx, X0, footer, 28);
  font(ctx, 700, SMALL);
  line(ctx, "Little Faith", X0 + markW + 14, footer, MUTED);
  font(ctx, 600, SMALL);
  line(ctx, "sem dados de pagamento", X1, footer, "rgba(169, 163, 204, .8)", "right");
  const resultH = resultHeight(data.result);
  const resultLimit = BOTTOM - 52 - 44 - resultH;

  let gamesEnd = y;
  if (data.groups.some((group) => group.games.length)) {
    const top = eyebrow(ctx, "Nossos jogos", y + 32) + 16;
    const layout = layoutGames(ctx, data.groups, !!data.drawn, resultLimit - 40 - top);
    drawGames(ctx, layout, data.drawn ? new Set(data.drawn) : null, top);
    gamesEnd = top + layout.height;
  }
  // a linha do resultado fica no meio do espaço que sobrou
  const free = Math.max(0, resultLimit - (gamesEnd + 40));
  drawResult(ctx, data.result, gamesEnd + 40 + free / 2);
}

/** Espera a Sora do app (empacotada, funciona sem internet); sem ela, a letra do sistema. */
async function fontsReady() {
  if (typeof document === "undefined" || !document.fonts) return;
  const loads = [600, 700, 800].map((weight) =>
    document.fonts.load(`${weight} 40px Sora`)
  );
  await Promise.race([
    Promise.allSettled(loads),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/** O cartão do WhatsApp: PNG 1080 × 1350 (4:5) desenhado num canvas fora da tela. */
export async function renderShareCard(data: ShareCardData): Promise<Blob> {
  await fontsReady();
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Este navegador não desenha imagens.");
  draw(ctx, data);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Não deu para gerar a imagem.")),
      "image/png",
    )
  );
}

/** "bolao-mega-entre-amigos.png" */
export function shareCardFileName(title: string) {
  const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `bolao-${slug || "cartao"}.png`;
}

/** Baixa a imagem com o nome dado. */
export function downloadImage(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Celular: abre o compartilhar do sistema com a imagem (WhatsApp aparece lá).
 * Sem compartilhamento de arquivos (computador): baixa a imagem.
 * Chamar direto do toque, sem esperar nada antes: o navegador exige o gesto.
 */
export async function shareCardImage(
  blob: Blob,
  name: string,
  title: string,
): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], name, { type: "image/png" });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
    }
  }
  downloadImage(blob, name);
  return "downloaded";
}
