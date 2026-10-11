import { formatBRL } from "@bolao/core";

/** Dinheiro grande sem centavos quando eles são zero: "R$ 240"; senão "R$ 240,50". */
export function reais(cents: string) {
  const full = formatBRL(cents);
  return full.endsWith(",00") ? full.slice(0, -3) : full;
}

const SCALES: [number, string, string][] = [
  [1e18, "quintilhão", "quintilhões"],
  [1e15, "quatrilhão", "quatrilhões"],
  [1e12, "trilhão", "trilhões"],
  [1e9, "bilhão", "bilhões"],
  [1e6, "milhão", "milhões"],
  [1e3, "mil", "mil"],
];
const three = new Intl.NumberFormat("pt-BR", { maximumSignificantDigits: 3 });

/** Chance em linguagem de gente: "1 em 2.340" · "1 em 834 mil" · "1 em 50,1 milhões"; nunca porcentagem com muitas casas. */
export function umEm(probability: number) {
  if (!(probability > 0)) return "quase zero";
  if (probability >= 1) return "certa";
  const n = 1 / probability;
  if (n < 10) {
    return `1 em ${
      new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(n)
    }`;
  }
  const rounded = n < 10_000 ? Math.round(n) : Number(n.toPrecision(3));
  if (rounded < 10_000) return `1 em ${rounded.toLocaleString("pt-BR")}`;
  if (rounded >= 1e21) return "1 em mais de mil quintilhões";
  const [scale, one, many] = SCALES.find(([size]) => rounded >= size)!;
  const value = rounded / scale;
  return `1 em ${three.format(value)} ${value < 2 ? one : many}`;
}

/** Copia um texto; true quando deu certo (com plano B para navegadores sem a área de transferência moderna). */
export async function copiar(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

/** Data e hora curtas no fuso escolhido: "11/10/2026, 14:02"; "A definir" quando não há data. */
export function formatInstant(value: string | null, timeZone: string) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value))
    : "A definir";
}

/** Só o dia: "11/10". */
export function diaMes(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
  }).format(new Date(value));
}
