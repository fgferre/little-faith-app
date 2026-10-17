import {
  formatBRL,
  LOTTERIES,
  officialPoolRule,
  redemptionCountdown,
} from "@bolao/core";
import type { LotteryId } from "@bolao/core";

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

export const PHONE_INVALID = "Telefone inválido: use só números, com DDI e DDD.";

/** WhatsApp como o servidor guarda: só dígitos, DDI primeiro; sem "+", 10 ou 11 dígitos são do Brasil (entra o 55). `null` quando não serve. */
export function normalizePhone(input: string) {
  let digits = input.replace(/\D/g, "");
  const country = input.trim().startsWith("+");
  if (!country && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }
  return /^[1-9][0-9]{9,14}$/.test(digits) ? digits : null;
}

/** "5511969484954" vira "+55 11 96948-4954"; de outros países, "+" e os dígitos. */
export function formatPhone(phone: string) {
  const br = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : `+${phone}`;
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

/**
 * Dinheiro grande em palavras, como a CAIXA anuncia: "R$ 170 milhões", "R$ 97,4 milhões", "R$ 1,8 milhão", "R$ 850 mil";
 * abaixo de mil, em reais. `short` dá a forma curta do cartão: "R$ 170 mi", "R$ 850 mil".
 */
export function reaisGrandes(cents: string, short = false) {
  const value = Number(BigInt(cents) / 100n);
  if (value >= 1e6) {
    const millions = three.format(value / 1e6);
    return `R$ ${millions} ${short ? "mi" : millions === "1" ? "milhão" : "milhões"}`;
  }
  if (value >= 1e3) return `R$ ${three.format(value / 1e3)} mil`;
  return reais(cents);
}

/** Uma data civil "AAAA-MM-DD" como "domingo, 18/10", sem virar instante (meia-noite UTC mudaria o dia). */
export function diaSemana(date: string) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(new Date(year, month - 1, day));
  return `${weekday}, ${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
}

/**
 * O concurso do bolão como texto: "Concurso 3071", "Concursos 3072 a 3075 · teimosinha de 4" ou "Concurso a definir";
 * `short` tira a palavra "Concurso": "3071", "3072 a 3075 (teimosinha de 4)", "A definir".
 */
export function concursos(
  pool: { contestNumber: number | null; contestCount?: number },
  short = false,
) {
  const count = pool.contestCount ?? 1;
  if (pool.contestNumber === null) {
    return short ? (count > 1 ? `A definir (teimosinha de ${count})` : "A definir") : count > 1
      ? `Concursos a definir · teimosinha de ${count}`
      : "Concurso a definir";
  }
  if (count === 1) return short ? String(pool.contestNumber) : `Concurso ${pool.contestNumber}`;
  const range = `${pool.contestNumber} a ${pool.contestNumber + count - 1}`;
  return short ? `${range} (teimosinha de ${count})` : `Concursos ${range} · teimosinha de ${count}`;
}

/** Dia e hora em Brasília, "16/10, 14:02": quando uma resposta ou um lembrete aconteceu. */
export function quando(at: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(at));
}

/** Só o dia: "11/10". */
export function diaMes(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
  }).format(new Date(value));
}

/** Hoje no calendário de Brasília, "AAAA-MM-DD": a data civil dos prazos e dos registros. */
export const hoje = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/**
 * O prazo oficial de resgate (AAAA-MM-DD) contado a partir de hoje (Brasília), com o tom do aviso:
 * "Prazo para resgatar: 06/01/2027 (84 dias)." · "Faltam 7 dias para resgatar: até 06/01/2027." ·
 * "Último dia para resgatar: hoje, 06/01/2027." · "O prazo para resgatar venceu em 06/01/2027."
 */
export function prazoResgate(deadlineDate: string, today: string) {
  const { daysLeft, tone } = redemptionCountdown(deadlineDate, today);
  const date = deadlineDate.split("-").reverse().join("/");
  const text = tone === "overdue"
    ? `O prazo para resgatar venceu em ${date}.`
    : daysLeft === 0
    ? `Último dia para resgatar: hoje, ${date}.`
    : tone === "alert"
    ? `${
      daysLeft === 1 ? "Falta 1 dia" : `Faltam ${daysLeft} dias`
    } para resgatar: até ${date}.`
    : `Prazo para resgatar: ${date} (${daysLeft} dias).`;
  return { text, tone };
}

/** A regra da autoria, uma vez sob "Nossos jogos". */
export const AUTORIA =
  "Quem escolheu os números não ganha mais por isso: o prêmio é dividido pelas cotas.";

/**
 * Jogo com mais dezenas que o mínimo, pela tabela oficial da modalidade: "7 dezenas · vale 7 jogos · R$ 42,00";
 * null no jogo simples.
 */
export function ampliado(lotteryId: LotteryId, count: number) {
  if (count <= LOTTERIES[lotteryId].minNumbers) return null;
  const rule = officialPoolRule(lotteryId, count);
  return `${count} dezenas · vale ${
    Number(rule.elementaryCombinations).toLocaleString("pt-BR")
  } jogos · ${formatBRL(rule.betPriceCents)}`;
}

/** Quem escolheu o jogo: "Rafael" · "Rafael e Ana" · "Rafael, Ana e Bia"; null quando não tem autor. */
export function autores(
  ids: readonly string[],
  nameOf: (id: string) => string | null,
) {
  const names = ids.map(nameOf).filter((name): name is string => !!name);
  if (!names.length) return null;
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

export interface GrupoDeJogos<T> {
  /** "Rafael · 4 jogos" · "Rafael e Ana · 1 jogo" · "Jogos da turma · 18" */
  label: string;
  games: T[];
}

/** Jogos por quem escolheu, na ordem em que aparecem; os sem autor (do plano ou do organizador) por último. */
export function porAutor<T>(
  games: readonly T[],
  authorIds: (game: T) => readonly string[],
  nameOf: (id: string) => string | null,
): GrupoDeJogos<T>[] {
  const groups = new Map<string, { name: string; games: T[] }>();
  const turma: T[] = [];
  for (const game of games) {
    const ids = authorIds(game).filter((id) => nameOf(id));
    const name = autores(ids, nameOf);
    if (!name) {
      turma.push(game);
      continue;
    }
    const key = [...ids].sort().join(",");
    const group = groups.get(key) ?? { name, games: [] };
    group.games.push(game);
    groups.set(key, group);
  }
  const plural = (n: number) => `${n} ${n === 1 ? "jogo" : "jogos"}`;
  return [
    ...[...groups.values()].map((group) => ({
      label: `${group.name} · ${plural(group.games.length)}`,
      games: group.games,
    })),
    ...(turma.length
      ? [{ label: `Jogos da turma · ${turma.length}`, games: turma }]
      : []),
  ];
}
