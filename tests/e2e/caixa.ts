import { readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";

const FIXTURES = {
  megasena: "caixa-megasena-3000.json",
  lotofacil: "caixa-lotofacil-3600.json",
  quina: "caixa-quina-7000.json",
};

/**
 * The next-draw query the app makes from the device (the bare CAIXA URL, no contest number) answers with the captured
 * fixtures, so no flow touches the internet and the home, sidebar, invite and card show the same numbers everywhere.
 * Numbered URLs (the manual result fill) are left alone: the flows that need them mock them themselves.
 */
export async function mockCaixa(context: BrowserContext) {
  for (const [path, file] of Object.entries(FIXTURES)) {
    const body = readFileSync(
      new URL(`../../packages/core/src/fixtures/${file}`, import.meta.url),
      "utf8",
    );
    await context.route(
      `https://servicebus2.caixa.gov.br/portaldeloterias/api/${path}`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body,
        }),
    );
  }
}
