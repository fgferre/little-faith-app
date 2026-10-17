import { describe, expect, it } from "vitest";
import { LOTTERIES } from "@bolao/core";
import { parsePastedGames } from "./paste-games";

const mega = LOTTERIES["mega-sena"];

describe("parsePastedGames", () => {
  it("reads the usual ways a ticket is written and sorts the numbers", () => {
    const games = parsePastedGames(
      [
        "10 20 23 33 45 50 55",
        "05-08-12-26-48-51",
        "19 – 27 – 29 – 43 – 54 – 60",
        "06,13,27, 31, 40, 59",
      ].join("\n"),
      mega,
      [],
    );
    expect(games.map((g) => "numbers" in g && g.numbers)).toEqual([
      [10, 20, 23, 33, 45, 50, 55],
      [5, 8, 12, 26, 48, 51],
      [19, 27, 29, 43, 54, 60],
      [6, 13, 27, 31, 40, 59],
    ]);
  });

  it("skips blank lines and accepts Windows line breaks", () => {
    const games = parsePastedGames(
      "\r\n01 02 03 04 05 06\r\n   \r\n\r\n07 08 09 10 11 12\r\n",
      mega,
      [],
    );
    expect(games).toHaveLength(2);
  });

  it("explains each invalid line in Portuguese", () => {
    const [outside, repeated, few, many, noDigits] = parsePastedGames(
      [
        "01 02 03 04 05 61",
        "01 02 03 04 05 05",
        "01 02 03 04 05",
        Array.from({ length: 21 }, (_, i) => i + 1).join(" "),
        "sem números aqui",
      ].join("\n"),
      mega,
      [],
    );
    expect(outside).toMatchObject({ error: "A dezena 61 está fora de 1 a 60." });
    expect(repeated).toMatchObject({ error: "A dezena 05 aparece duas vezes." });
    expect(few).toMatchObject({ error: "Faltam dezenas: são pelo menos 6." });
    expect(many).toMatchObject({
      error: "Dezenas demais: são no máximo 20.",
    });
    expect(noDigits).toMatchObject({
      text: "sem números aqui",
      error: "Faltam dezenas: são pelo menos 6.",
    });
  });

  it("rejects zero as outside the universe", () => {
    const [game] = parsePastedGames("00 01 02 03 04 05", mega, []);
    expect(game).toMatchObject({ error: "A dezena 00 está fora de 1 a 60." });
  });

  it("skips a game already in the pool, in any order, without blocking the rest", () => {
    const inPool = [[1, 2, 3, 4, 5, 6]];
    const [game] = parsePastedGames("06 05 04 03 02 01", mega, inPool);
    expect(game).toMatchObject({ skipped: "Já está no bolão; fica de fora." });
  });

  it("does not count list numbers, labels or dates as numbers", () => {
    const games = parsePastedGames(
      [
        "1) 05 12 23 34 45 56",
        "2. 05 12 23 34 45 57",
        "3º 05 12 23 34 45 58",
        "Jogo 4 - 05 12 23 34 45 59",
        "Jogo 5: 05 12 23 34 45 60",
        "15/10: 06 12 23 34 45 56",
        "05.08.12.26.48.51",
      ].join("\n"),
      mega,
      [],
    );
    expect(games.map((g) => "numbers" in g && g.numbers)).toEqual([
      [5, 12, 23, 34, 45, 56],
      [5, 12, 23, 34, 45, 57],
      [5, 12, 23, 34, 45, 58],
      [5, 12, 23, 34, 45, 59],
      [5, 12, 23, 34, 45, 60],
      [6, 12, 23, 34, 45, 56],
      [5, 8, 12, 26, 48, 51],
    ]);
  });

  it("keeps the first copy and flags the repeats inside the paste", () => {
    const games = parsePastedGames(
      "01 02 03 04 05 06\n06-05-04-03-02-01\n01 02 03 04 05 07",
      mega,
      [],
    );
    expect(games[0]).toHaveProperty("numbers");
    expect(games[1]).toMatchObject({
      error: "Este jogo aparece duas vezes na colagem.",
    });
    expect(games[2]).toHaveProperty("numbers");
  });

  it("uses the rule of the lottery", () => {
    const lotofacil = LOTTERIES["lotofacil"];
    const [game] = parsePastedGames(
      "01 02 03 04 05 06 07 08 09 10 11 12 13 14 26",
      lotofacil,
      [],
    );
    expect(game).toMatchObject({
      error: `A dezena 26 está fora de 1 a ${lotofacil.universeSize}.`,
    });
  });
});
