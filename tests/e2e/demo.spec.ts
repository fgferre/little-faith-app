import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

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
