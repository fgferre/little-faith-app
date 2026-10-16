import type { LotteryRule } from "@bolao/core";

export type PastedGame =
  | { text: string; numbers: number[] }
  | { text: string; error: string };

/**
 * Cada linha não vazia do texto colado vira um jogo (dezenas em ordem) ou o motivo de não valer.
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
    const tokens = line.match(/\d+/g) ?? [];
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
      : inPool.has(key(sorted))
      ? "Este jogo já está no bolão."
      : inPaste.has(key(sorted))
      ? "Este jogo aparece duas vezes na colagem."
      : null;
    if (error) games.push({ text: line, error });
    else {
      inPaste.add(key(sorted));
      games.push({ text: line, numbers: sorted });
    }
  }
  return games;
}
