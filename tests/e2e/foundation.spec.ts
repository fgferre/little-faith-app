import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function createGroup(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Faça sua fezinha/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Criar meu grupo", exact: true })
    .click();
  await page.getByLabel("Nome do grupo").fill("Grupo de teste");
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Novo bolão" })).toBeVisible();
}

async function createPool(page: Page, lottery = "mega-sena") {
  await page.getByRole("button", { name: "Novo bolão" }).click();
  await page.getByLabel("Nome do bolão").fill("Bolão de teste");
  await page.getByLabel("Modalidade").selectOption(lottery);
  await page.getByLabel("Valor por cota").fill("30,00");
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(
    page.getByRole("heading", { name: "Bolão de teste", exact: true }),
  ).toBeVisible();
}

test("demo is clearly marked and never mixes with the organizer drafts", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Um gostinho do app: estes são dados de exemplo."),
  ).toBeVisible();
  await expect(page.getByText("R$ 360,00", { exact: true })).toBeVisible();
  await createGroup(page);
  await expect(page.getByText("Turma da sorte", { exact: true })).not
    .toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Novo bolão" })).toBeVisible();
  await expect(
    page.getByText("Um gostinho do app: estes são dados de exemplo."),
  ).not.toBeVisible();
});

test("offline drafts survive closing the page, and a payment proposal never increases the balance", async ({ page, context }) => {
  await createGroup(page);
  await createPool(page);
  await page.getByRole("tab", { name: "Pessoas e cotas" }).click();
  await page.getByRole("button", { name: "Adicionar pessoa" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Pessoa de teste");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await page.getByRole("button", { name: "Preparar cota", exact: true })
    .click();
  await page.getByLabel("Quantidade de cotas").fill("1,25");
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByRole("cell", { name: "R$ 37,50", exact: true }))
    .toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByRole("button", { name: "Preparar pagamento" }).click();
  await page.getByLabel("Valor informado").fill("37,50");
  await page.getByRole("button", { name: "Salvar para revisão" }).click();
  await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  await expect(
    page.locator(".stat-card").filter({ hasText: "Recebimentos no caixa" })
      .getByText("R$ 0,00", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".stat-card").filter({ hasText: "Não aumenta o saldo" })
      .getByText("R$ 37,50", { exact: true }),
  ).toBeVisible();
  const url = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url);
  await expect(
    reopened.getByRole("heading", { name: "Bolão de teste", exact: true }),
  ).toBeVisible();
  await reopened.getByRole("tab", { name: "Pessoas e cotas" }).click();
  await expect(reopened.getByRole("cell", { name: /Pessoa de teste/ }))
    .toBeVisible();
  await expect(reopened.getByRole("cell", { name: "R$ 37,50", exact: true }))
    .toBeVisible();
  await expect(reopened.getByText("Você pode preparar jogos e rascunhos."))
    .toBeVisible();
});

for (const lottery of ["mega-sena", "lotofacil", "quina"]) {
  test(`generates valid ${lottery} games in a worker and restores them after reload`, async ({ page }) => {
    await createGroup(page);
    await createPool(page, lottery);
    await page.getByRole("tab", { name: "Jogos", exact: true }).click();
    await page.getByRole("button", { name: "Gerar jogos", exact: true })
      .click();
    await page.getByLabel("Quantidade de jogos").fill("3");
    await page.getByRole("button", { name: "Gerar e salvar jogos" }).click();
    await expect(page.locator(".bet-row")).toHaveCount(3);
    await page.reload();
    await page.getByRole("tab", { name: "Jogos", exact: true }).click();
    await expect(page.locator(".bet-row")).toHaveCount(3);
    const numbers = await page.locator(".number-row").allTextContents();
    expect(new Set(numbers).size).toBe(3);
  });
}

test("blocks duplicate bets and keeps the existing game", async ({ page }) => {
  await createGroup(page);
  await createPool(page);
  await page.getByRole("tab", { name: "Jogos", exact: true }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "Adicionar dezenas" }).click();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await page.getByRole("button", { name: `Dezena ${n}`, exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    if (attempt === 0) await expect(page.getByRole("dialog")).not.toBeVisible();
    else {await expect(page.getByRole("alert")).toHaveText(
        /Este jogo já está no bolão/,
      );}
  }
  await expect(page.locator(".bet-row")).toHaveCount(1);
});

test("rejects a quota that would create a fraction of a cent without damaging the pool", async ({ page }) => {
  await createGroup(page);
  await page.getByRole("button", { name: "Novo bolão" }).click();
  await page.getByLabel("Nome do bolão").fill("Bolão dos centavos");
  await page.getByLabel("Valor por cota").fill("30,01");
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await page.getByRole("tab", { name: "Pessoas e cotas" }).click();
  await page.getByRole("button", { name: "Adicionar pessoa" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Pessoa da cota");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await page.getByRole("button", { name: "Preparar cota", exact: true })
    .click();
  await page.getByLabel("Quantidade de cotas").fill("0,25");
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByRole("alert")).toHaveText(/fração de centavo/);
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bolão dos centavos" }))
    .toBeVisible();
  await expect(
    page.locator(".stat-card").filter({
      hasText: "Valor devido, sem confirmação",
    }).getByText("R$ 0,00", { exact: true }),
  ).toBeVisible();
});

for (const width of [320, 390, 768, 1440]) {
  test(`navigation fits at ${width}px, with no horizontal page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Faça sua fezinha/ }))
      .toBeVisible();
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth
      ),
    ).toBe(true);
    await page.locator(width <= 760 ? ".bottom-nav" : ".sidebar nav").getByRole(
      "link",
      { name: "Bolões", exact: true },
    ).click();
    await expect(
      page.getByRole("heading", { name: "Nossos bolões", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth
      ),
    ).toBe(true);
    await page.getByRole("button", { name: /Mega entre amigos/ }).click();
    await page.getByRole("tab", { name: "Jogos", exact: true }).click();
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth
      ),
    ).toBe(true);
    if (width === 1440 || width === 390) {
      await page.goto("/#/inicio");
      await expect(page.locator(".home-hero")).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: `test-results/dashboard-${
          width === 1440 ? "desktop" : "mobile"
        }.png`,
        fullPage: true,
      });
    }
  });
}

test("modal traps focus, closes with Escape, and respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Novo bolão" }).click();
  await expect(page.getByLabel("Nome do bolão")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Novo bolão" })).toBeFocused();
});

test("the current group never shows another group pool list", async ({ page }) => {
  await createGroup(page);
  await createPool(page);
  await page.goto("/#/dados");
  await page.getByRole("button", { name: "Adicionar outro grupo" }).click();
  await page.getByLabel("Nome do grupo").fill("Outro grupo");
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await page.goto("/#/boloes");
  await expect(page.getByRole("button", { name: /Bolão de teste/ })).not
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "O primeiro bolão da turma" }))
    .toBeVisible();
  await page.getByLabel("Grupo atual", { exact: true }).selectOption({
    label: "Grupo de teste",
  });
  await page.goto("/#/boloes");
  await expect(page.getByRole("button", { name: /Bolão de teste/ }))
    .toBeVisible();
});

test("hash routes and the offline worker work under a static Pages-style subdirectory", async ({ page, context }) => {
  const origin = "http://127.0.0.1:4181";
  await page.goto(`${origin}/little-faith-app/#/boloes`);
  await expect(
    page.getByRole("heading", { name: "Nossos bolões", exact: true }),
  ).toBeVisible();
  const scope = await page.evaluate(async () =>
    (await navigator.serviceWorker.ready).scope
  );
  expect(scope).toBe(`${origin}/little-faith-app/`);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: /Mega entre amigos/ }).click();
  await page.getByRole("tab", { name: "Jogos", exact: true }).click();
  await page.getByRole("button", { name: "Gerar jogos", exact: true }).click();
  await page.getByLabel("Quantidade de jogos").fill("2");
  await page.getByRole("button", { name: "Gerar e salvar jogos" }).click();
  await expect(page.locator(".bet-row")).toHaveCount(26);
  const names = await page.evaluate(async () => caches.keys());
  expect(
    names.every((key) =>
      key.startsWith("little-faith-shell:%2Flittle-faith-app%2F:")
    ),
  ).toBe(true);
});

test("a waiting update keeps online and offline navigation on the active public shell", async ({ page, context, request }) => {
  const origin = "http://127.0.0.1:4191";
  await request.get(`${origin}/__test/reset`);
  await page.goto(`${origin}/#/inicio`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator('meta[name="shell-fixture-build"]'))
    .toHaveAttribute("content", "a");
  await request.get(`${origin}/__test/next-build`);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration!.update();
  });
  await expect.poll(() =>
    page.evaluate(async () =>
      !!(await navigator.serviceWorker.getRegistration())?.waiting
    )
  ).toBe(true);
  await page.reload();
  await expect(page.locator('meta[name="shell-fixture-build"]'))
    .toHaveAttribute("content", "a");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('meta[name="shell-fixture-build"]'))
    .toHaveAttribute("content", "a");
  await expect(page.getByRole("heading", { name: /Faça sua fezinha/ }))
    .toBeVisible();
  const cachedRequests = await page.evaluate(async () => {
    const names = await caches.keys();
    return (await Promise.all(
      names.map(async (name) =>
        (await (await caches.open(name)).keys()).map((entry) => entry.url)
      ),
    )).flat();
  });
  expect(
    cachedRequests.every((url) =>
      !url.includes("/functions/") && !url.includes("/auth/")
    ),
  ).toBe(true);
});

test("offline portfolio planning and simulation resume saved batches after closing the page", async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.locator(".bottom-nav").getByRole("link", { name: "Bolões", exact: true }).click();
  await page.getByRole("button", { name: /Mega entre amigos/ }).click();
  await page.getByRole("tab", { name: "Planejador", exact: true }).click();
  await page.getByRole("button", { name: "Comparar alternativas", exact: true }).click();
  await expect(page.getByRole("article", { name: "Plano Espalhada", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisar aplicação do plano", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Simular carteira", exact: true }).click();
  const progress = page.getByRole("progressbar", { name: "Progresso da simulação", exact: true });
  await expect.poll(async () => Number(await progress.getAttribute("value"))).toBeGreaterThanOrEqual(2_000);
  await page.getByRole("button", { name: "Pausar simulação", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retomar simulação", exact: true })).toBeVisible();
  const samples = Number(await progress.getAttribute("value"));
  const url = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url);
  await reopened.getByRole("tab", { name: "Planejador", exact: true }).click();
  await expect(reopened.getByRole("progressbar", { name: "Progresso da simulação", exact: true })).toHaveAttribute("value", String(samples));
  await reopened.getByRole("button", { name: "Retomar simulação", exact: true }).click();
  await expect(reopened.getByRole("button", { name: "Refinar para 1 milhão", exact: true })).toBeVisible({ timeout: 35_000 });
  await expect(reopened.getByText("Zero ocorrências nesta amostra não significa chance zero.", { exact: false })).toBeVisible();
  await reopened.getByRole("button", { name: "Refinar para 1 milhão", exact: true }).click();
  await expect.poll(async () => Number(await reopened.getByRole("progressbar", { name: "Progresso da simulação", exact: true }).getAttribute("value"))).toBeGreaterThanOrEqual(200_000);
  await reopened.getByRole("button", { name: "Pausar simulação", exact: true }).click();
  await expect(reopened.getByRole("button", { name: "Retomar simulação", exact: true })).toBeVisible();
  await reopened.screenshot({ path: "test-results/planning-simulation-mobile.png", fullPage: true });
});
