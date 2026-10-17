import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FRESH_MS,
  isFresh,
  parseProximoSorteio,
  retryAfter,
} from "./proximo-sorteio";

const raw = readFileSync(
  new URL("../../../packages/core/src/fixtures/caixa-megasena-3000.json", import.meta.url),
  "utf8",
);

describe("próximo sorteio no aparelho", () => {
  it("aceita a resposta da CAIXA só da modalidade pedida e com o próximo concurso", () => {
    const value = parseProximoSorteio("mega-sena", raw, "2026-10-17T12:00:00.000Z");
    expect(value?.extras.nextContestNumber).toBe(3001);
    expect(value?.extras.nextEstimatedPrizeCents).toBe("11500000000");
    expect(parseProximoSorteio("quina", raw, "2026-10-17T12:00:00.000Z")).toBeNull();
    expect(parseProximoSorteio("mega-sena", "não é json", "2026-10-17T12:00:00.000Z")).toBeNull();
  });

  it("vale por algumas horas e depois é dado velho, nunca zero", () => {
    const value = parseProximoSorteio("mega-sena", raw, "2026-10-17T12:00:00.000Z")!;
    const at = Date.parse(value.fetchedAt);
    expect(isFresh(value, at + FRESH_MS - 1)).toBe(true);
    expect(isFresh(value, at + FRESH_MS)).toBe(false);
    expect(isFresh(null, at)).toBe(false);
  });

  it("espera mais a cada falha seguida, até um teto", () => {
    expect(retryAfter(1)).toBe(15 * 60 * 1000);
    expect(retryAfter(2)).toBe(30 * 60 * 1000);
    expect(retryAfter(3)).toBe(60 * 60 * 1000);
    expect(retryAfter(20)).toBe(6 * 60 * 60 * 1000);
  });
});
