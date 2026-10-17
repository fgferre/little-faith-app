import { expect, test } from "@playwright/test";
import { mockCaixa } from "./caixa";
import type { Page } from "@playwright/test";

test.beforeEach(({ context }) => mockCaixa(context));

async function step(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Etapas do bolão" })
    .getByRole("button", { name, exact: true }).click();
}

test("demo shows a drawn pool with its prize confirmed, redeemed and partly paid", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Veja como funciona: os dados são de exemplo."),
  ).toBeVisible();
  await page.goto("/#/boloes");
  await page.getByRole("button", { name: /Mega da sexta/ }).click();
  await expect(
    page.getByRole("heading", { name: "Mega da sexta", exact: true }),
  ).toBeVisible();

  await step(page, "Registrar");
  await expect(page.getByText("Registro completo", { exact: true }))
    .toBeVisible();

  await step(page, "Sorteio");
  await expect(
    page.getByText("R$ 1.287,20").filter({ visible: true }).first(),
  ).toBeVisible();

  await step(page, "Dividir");
  await expect(page.getByText("Prêmio todo resgatado", { exact: true }))
    .toBeVisible();
  const totals = page.getByLabel("Totais da divisão");
  await expect(totals).toContainText("R$ 965,40");
  await expect(totals).toContainText("R$ 321,80");

  await page.goto("/#/historico");
  await expect(
    page.getByText("Mega da sexta").filter({ visible: true }).first(),
  ).toBeVisible();
});

test("the home shows the next draw read from CAIXA, with the special amounts kept apart from the estimate", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(".home-next");
  await expect(card.getByText("Próximo sorteio · Mega-Sena")).toBeVisible();
  await expect(card.getByText("Acumulou", { exact: true })).toBeVisible();
  await expect(card.getByText("R$ 115 milhões", { exact: true })).toBeVisible();
  await expect(card.getByText("Concurso 3001 · terça-feira, 28/04")).toBeVisible();
  await expect(card.getByText(/Fonte: CAIXA · atualizado/)).toBeVisible();
  await card.getByText("Acumulado para concursos especiais").click();
  await expect(card.getByText("R$ 89,2 milhões")).toBeVisible();
  await expect(card.getByText(/Concurso 3005, final 5/)).toBeVisible();
  await expect(card.getByText("R$ 7,11 milhões")).toBeVisible();
  // The sidebar says it is a day for a fezinha; the card page of a pool without a contest number carries the estimate.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByText("Acumulou. Dia de fezinha.")).toBeVisible();
  await expect(page.getByText("Mega-Sena 3001, terça-feira: R$ 115 milhões estimados.")).toBeVisible();
});
