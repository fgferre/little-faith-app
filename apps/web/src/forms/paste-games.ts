import type { LotteryRule } from "@bolao/core";

export type PastedGame =
  | { text: string; numbers: number[] }
  | { text: string; error: string }
  | { text: string; skipped: string };

/** Rótulo de jogo no começo da linha: "Jogo 1", "Aposta 2 -", "Cartela nº 3)". */
const NAMED = /^\s*(?:jogo|aposta|cartela|bilhete|linha)s?\s*(?:n[º°o.]\s*)?\d{1,3}\s*[-–—).]?\s*/iu;
/** Número da lista: "1)", "2º", "3." (o ponto só quando ele não separa as dezenas, como em "05.08.12"). */
const INDEX = /^\s*\d{1,3}\s*(?:\)|[ºª°]|\.(?!.*\d\.))\s*/u;

/** O que vem antes do jogo não é dezena: tudo até o último ":" ("Jogo 1:", "15/10:"), um rótulo e o número da lista. */
function withoutLabel(line: string) {
  return line.slice(line.lastIndexOf(":") + 1).replace(NAMED, "").replace(
    INDEX,
    "",
  );
}

/**
 * Cada linha não vazia do texto colado vira um jogo (dezenas em ordem), o motivo de não valer ou, se o jogo já está no
 * bolão, o aviso de que fica de fora (assim uma colagem salva pela metade pode ser repetida).
 * Qualquer trecho sem dígitos separa as dezenas: "05-08-12", "19 – 27 – 29", "06,13,27".
 */
export function parsePastedGames(
  text: string,
  rule: Pick<LotteryRule, "minNumbers" | "maxNumbers" | "universeSize">,
  existing: readonly (readonly number[])[],
): PastedGame[] {
  const key = (numbers: readonly number[]) =>
    [...numbers].sort((a, b) => a - b).join(",");
  const inPool = new Set(existing.map(key));
  const inPaste = new Set<string>();
  const games: PastedGame[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tokens = withoutLabel(line).match(/\d+/g) ?? [];
    const numbers = tokens.map(Number);
    const outside = tokens.find((t) =>
      Number(t) < 1 || Number(t) > rule.universeSize
    );
    const repeated = numbers.find((n, i) => numbers.indexOf(n) !== i);
    const sorted = [...numbers].sort((a, b) => a - b);
    const error = outside !== undefined
      ? `A dezena ${outside} está fora de 1 a ${rule.universeSize}.`
      : repeated !== undefined
      ? `A dezena ${String(repeated).padStart(2, "0")} aparece duas vezes.`
      : numbers.length < rule.minNumbers
      ? `Faltam dezenas: são pelo menos ${rule.minNumbers}.`
      : numbers.length > rule.maxNumbers
      ? `Dezenas demais: são no máximo ${rule.maxNumbers}.`
      : inPaste.has(key(sorted))
      ? "Este jogo aparece duas vezes na colagem."
      : null;
    if (error) games.push({ text: line, error });
    else if (inPool.has(key(sorted))) {
      games.push({ text: line, skipped: "Já está no bolão; fica de fora." });
    } else {
      inPaste.add(key(sorted));
      games.push({ text: line, numbers: sorted });
    }
  }
  return games;
}
