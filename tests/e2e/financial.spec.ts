import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolManifest } from "@bolao/core";

test.describe.configure({ mode: "serial" });
const actorId = "50100000-0000-4000-8000-000000000001";
const groupId = "50200000-0000-4000-8000-000000000001";
const poolId = "50400000-0000-4000-8000-000000000001";
const api = "http://127.0.0.1:4190/functions/v1/api/v1";

async function login(page: Page, proposalVisible = true) {
  await page.addInitScript(({ actorId }) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    const token = `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
      btoa(
        JSON.stringify({
          sub: actorId,
          role: "authenticated",
          aud: "authenticated",
          exp: expiresAt,
        }),
      )
    }.local-test-signature`;
    localStorage.setItem(
      "sb-127-auth-token",
      JSON.stringify({
        access_token: token,
        refresh_token: "local-test-refresh-token",
        token_type: "bearer",
        expires_in: 86_400,
        expires_at: expiresAt,
        user: {
          id: actorId,
          aud: "authenticated",
          role: "authenticated",
          email: "organizer@example.test",
          app_metadata: { provider: "google", providers: ["google"] },
          user_metadata: {},
          identities: [],
          created_at: "2026-10-07T00:00:00.000Z",
          is_anonymous: false,
        },
      }),
    );
  }, { actorId });
  await page.goto("http://127.0.0.1:4182/#/revisao");
  if (proposalVisible) {
    await expect(
      page.getByText("Primeira transferência parcial.", { exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      page.locator('[aria-label="Caixa do grupo"]').getByText("R$ 60,00", {
        exact: true,
      }),
    ).toHaveCount(2);
  }
}

async function step(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Etapas do bolão" })
    .getByRole("button", { name, exact: true }).click();
}

async function approve(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox").last()).toBeEnabled();
  await dialog.getByRole("checkbox").last().check();
  await dialog.getByRole("button", {
    name: "Confirmar no servidor",
    exact: true,
  }).click();
  await expect(dialog).not.toBeVisible();
}

async function publishAndAccept(page: Page) {
  await page.getByRole("button", { name: "Publicar combinados", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Será publicada a versão 1.", {
      exact: false,
    }),
  ).toBeVisible();
  await approve(page);
  await page.getByRole("button", { name: "Registrar aceite", exact: true })
    .click();
  await page.getByLabel("Evidência do aceite").fill(
    "Mensagem da pessoa confirmando que aceitou os combinados da versão 1.",
  );
  await approve(page);
  await expect(page.getByText("Aceite registrado", { exact: true }))
    .toBeVisible();
}

test.beforeEach(async ({ request }) => {
  const response = await request.post("http://127.0.0.1:4190/__test/reset");
  expect(response.ok()).toBe(true);
});

test("a human confirms cash, allocates across pools, confirms a fully paid quota and reverses without deleting history", async ({ page, request }) => {
  await login(page);
  await publishAndAccept(page);
  await page.getByRole("button", { name: "Conferir", exact: true })
    .click();
  await page.getByLabel("Referência bancária").fill("transferencia-parcial-1");
  await approve(page);
  await expect(page.getByText("Pagamento integral pendente", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByRole("button", { name: "Conferir participação", exact: true }),
  ).toBeDisabled();
  const balance = page.locator('[aria-label="Caixa do grupo"]');
  await expect(balance.getByText("R$ 30,00", { exact: true })).toHaveCount(2);

  await page.goto(`http://127.0.0.1:4182/#/boloes/${poolId}`);
  await step(page, "Arrecadar");
  await page.getByRole("button", { name: "Registrar pagamento", exact: true })
    .click();
  await page.getByLabel("Valor informado").fill("60,00");
  await page.getByLabel("Origem e observações").fill(
    "Segunda transferência para dois bolões.",
  );
  await page.getByRole("checkbox", {
    name: "Conferir o recebimento agora, depois de sincronizar.",
  }).check();
  await page.getByRole("button", { name: "Salvar para revisão" }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", {
      name: "Conferir recebimento",
    }),
  ).toBeVisible();
  await page.getByLabel("Referência bancária").fill("transferencia-grupo-2");
  await page.getByLabel("Valor a destinar").fill("30,00");
  await approve(page);
  await page.goto("http://127.0.0.1:4182/#/revisao");
  await page.getByRole("button", { name: "Destinar saldo", exact: true }).and(
    page.locator(":enabled"),
  ).click();
  await page.getByLabel("Bolão de destino").selectOption({
    label: "Quina financeira",
  });
  await page.getByLabel("Valor a destinar").fill("30,00");
  await approve(page);
  await expect(balance.getByText("R$ 90,00", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Conferir participação", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("1 cota(s)", { exact: false }),
  ).toBeVisible();
  await approve(page);
  await expect(page.getByText("Confirmada", { exact: true })).toBeVisible();

  const firstPayment = page.getByRole("row").filter({
    hasText: "transferencia-parcial-1",
  });
  await firstPayment.getByRole("button", { name: "Estornar", exact: true })
    .click();
  await page.getByLabel("Motivo do estorno").fill(
    "Transferência devolvida à pessoa; conferido no banco.",
  );
  await approve(page);
  await expect(balance.getByText("R$ 60,00", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Pagamento integral pendente", { exact: true }))
    .toBeVisible();
  await page.goto("http://127.0.0.1:4182/#/historico");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(
    page.getByText("Estorno do recebimento", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /A cota de Pessoa financeira em Mega financeira foi cancelada/,
    ),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/finance-history-desktop.png",
    fullPage: true,
  });

  const result = await request.post(`${api}/finance_pull`, {
    headers: { Authorization: "Bearer browser-fixture" },
    data: { groupId },
  });
  const snapshot = await result.json();
  expect(snapshot.payments).toHaveLength(2);
  expect(snapshot.allocations).toHaveLength(3);
  expect(snapshot.quotas).toHaveLength(1);
  expect(snapshot.revocations).toHaveLength(1);
  expect(
    snapshot.movements.filter((movement: { kind: string }) =>
      movement.kind === "payment-reversed"
    ),
  ).toHaveLength(1);
});

test("a committed payment with a lost response recovers its receipt, and reconnect never replays it", async ({ page, context, request }) => {
  await login(page);
  let decisions = 0;
  await page.route(`${api}/review_decide`, async (route) => {
    decisions++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Conferir", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").last().check();
  await dialog.getByRole("button", {
    name: "Confirmar no servidor",
    exact: true,
  }).click();
  await expect(
    dialog.getByRole("button", { name: "Consultar recibo", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Fechar revisão", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Conferir decisão", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Conferir decisão", exact: true }),
  ).toBeVisible();
  expect(decisions).toBe(1);
  await page.getByRole("button", { name: "Conferir decisão", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", {
    name: "Consultar recibo",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Conferir decisão", exact: true }),
  ).not.toBeVisible();
  expect(decisions).toBe(1);
  const snapshot = await (await request.post(`${api}/finance_pull`, {
    headers: { Authorization: "Bearer browser-fixture" },
    data: { groupId },
  })).json();
  expect(snapshot.payments).toHaveLength(1);
  expect(snapshot.movements).toHaveLength(2);
});

test("a concurrent group change invalidates the reviewed decision without moving cash", async ({ page, request }) => {
  await login(page);
  await page.getByRole("button", { name: "Conferir", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByLabel("Referência bancária"))
    .toBeVisible();
  const operation = {
    apiVersion: "v1",
    idempotencyKey: crypto.randomUUID(),
    groupId,
    entityId: groupId,
    kind: "group",
    expectedVersion: 1,
    data: {
      name: "Grupo alterado durante revisão",
      statute: "Os dados atuais precisam de nova conferência.",
    },
    createdAt: new Date().toISOString(),
  };
  const changed = await request.post(`${api}/sync_push`, {
    headers: { Authorization: "Bearer browser-fixture" },
    data: { operations: [operation] },
  });
  expect((await changed.json()).receipts[0].status).toBe("accepted");
  await approve(page);
  const snapshot = await (await request.post(`${api}/finance_pull`, {
    headers: { Authorization: "Bearer browser-fixture" },
    data: { groupId },
  })).json();
  expect(snapshot.payments).toHaveLength(0);
  expect(snapshot.movements).toHaveLength(0);
  await expect(
    page.getByText("Primeira transferência parcial.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Não deram certo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A revisão do grupo mudou; atualize os dados e aprove novamente.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("a deliberate retry after reconnect shows and resends exactly the original destination and amount", async ({ page, context, request }) => {
  await login(page);
  const decisions: unknown[] = [];
  await page.route(`${api}/review_decide`, async (route) => {
    decisions.push(route.request().postDataJSON().command);
    if (decisions.length === 1) await route.abort("failed");
    else await route.fulfill({ response: await route.fetch() });
  });
  await page.getByRole("button", { name: "Conferir", exact: true })
    .click();
  await page.getByLabel("Bolão de destino").selectOption({
    label: "Quina financeira",
  });
  await page.getByLabel("Valor a destinar").fill("10,00");
  await page.getByRole("dialog").getByRole("checkbox").last().check();
  await page.getByRole("dialog").getByRole("button", {
    name: "Confirmar no servidor",
    exact: true,
  }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", {
      name: "Consultar recibo",
      exact: true,
    }),
  ).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByRole("dialog").getByText(/Você está offline/))
    .toBeVisible();
  await context.setOffline(false);
  const original = page.getByRole("dialog").locator(
    '[aria-label="Decisão original"]',
  );
  await expect(
    original.getByText("Destinação: R$ 10,00 para Quina financeira.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(original.getByText(/Sem destino: R\$ 20,00/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", {
    name: "Consultar recibo",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "ainda não retornou um recibo",
  );
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("dialog").getByRole("button", {
    name: "Reenviar mesma decisão",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(decisions).toHaveLength(2);
  expect(decisions[1]).toEqual(decisions[0]);
  const snapshot = await (await request.post(`${api}/finance_pull`, {
    headers: { Authorization: "Bearer browser-fixture" },
    data: { groupId },
  })).json();
  expect(snapshot.payments).toHaveLength(1);
  expect(snapshot.allocations).toHaveLength(1);
  expect(snapshot.allocations[0].amountCents).toBe("1000");
  expect(snapshot.allocations[0].poolId).toBe(
    "50400000-0000-4000-8000-000000000002",
  );
});

test("going offline while the review loads still allows closing the dialog", async ({ page, context }) => {
  await login(page);
  let pullStarted: () => void;
  const started = new Promise<void>((resolve) => {
    pullStarted = resolve;
  });
  let releasePull: () => void;
  const released = new Promise<void>((resolve) => {
    releasePull = resolve;
  });
  await page.route(`${api}/finance_pull`, async (route) => {
    pullStarted();
    await released;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Conferir", exact: true })
    .click();
  await started;
  await context.setOffline(true);
  await expect(page.getByRole("dialog").getByText(/Você está offline/))
    .toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  releasePull!();
});

test("refreshing a changed proposal after reconnect requires a new human check", async ({ page, context, request }) => {
  await login(page);
  await page.getByRole("button", { name: "Conferir", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Valor a destinar")).toHaveValue("30,00");
  await dialog.getByRole("checkbox").last().check();
  await dialog.getByLabel("Valor a destinar").fill("20,00");
  await expect(dialog.getByRole("checkbox").last()).not.toBeChecked();
  await dialog.getByRole("checkbox").last().check();
  await context.setOffline(true);
  await expect(dialog.getByText(/Você está offline/)).toBeVisible();
  const operation = {
    apiVersion: "v1",
    idempotencyKey: crypto.randomUUID(),
    groupId,
    entityId: "50600000-0000-4000-8000-000000000001",
    kind: "payment-proposal",
    expectedVersion: 1,
    data: {
      poolId,
      personId: "50300000-0000-4000-8000-000000000001",
      amountCents: "4500",
      note: "Valor atualizado em outro aparelho.",
      status: "pending",
    },
    createdAt: new Date().toISOString(),
  };
  const changed = await request.post(`${api}/sync_push`, {
    headers: { Authorization: "Bearer browser-fixture" },
    data: { operations: [operation] },
  });
  expect((await changed.json()).receipts[0].status).toBe("accepted");
  await context.setOffline(false);
  await expect(dialog.getByLabel("Valor a destinar")).toHaveValue("45,00");
  await expect(dialog.getByRole("checkbox").last()).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Confirmar no servidor", exact: true }),
  ).toBeDisabled();
  await approve(page);
});

test("editing combinados publishes a new frozen version and pool edits preserve existing drafts", async ({ page }) => {
  await login(page);
  await publishAndAccept(page);
  await page.goto("http://127.0.0.1:4182/#/dados");
  await page.getByRole("button", {
    name: "Editar grupo e combinados",
    exact: true,
  }).click();
  await page.getByLabel("Combinados do grupo").fill(
    "Nova regra da versão 2. Participação integral no prazo, com autorização registrada.",
  );
  await page.getByRole("button", { name: "Salvar neste aparelho" }).click();
  await page.goto("http://127.0.0.1:4182/#/revisao");
  await page.getByRole("button", { name: "Publicar nova versão", exact: true })
    .click();
  await approve(page);
  await expect(page.getByText(/Versão 2 publicada em/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Registrar aceite", exact: true }),
  ).toBeEnabled();
  await page.goto(`http://127.0.0.1:4182/#/boloes/${poolId}`);
  await step(page, "Montar");
  await page.getByRole("button", { name: "Editar bolão", exact: true }).click();
  await page.getByLabel("Nome do bolão").fill("Mega financeira revisada");
  await page.getByRole("button", { name: "Salvar neste aparelho" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Mega financeira revisada",
      exact: true,
    }),
  ).toBeVisible();
  await step(page, "Arrecadar");
  await expect(page.locator(".pool-person-due", { hasText: "R$ 60,00" }))
    .toBeVisible();
});

test("offline and unconfigured groups keep proposals outside real financial confirmations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Criar meu grupo", exact: true })
    .click();
  await page.getByLabel("Nome do grupo").fill("Grupo local sem servidor");
  await page.getByRole("button", { name: "Salvar neste aparelho" }).click();
  await page.goto("/#/revisao");
  await expect(
    page.getByRole("button", { name: "Publicar combinados", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("A conta compartilhada ainda não foi ligada neste app.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/finance-review-mobile.png",
    fullPage: true,
  });
});

const personId = "50300000-0000-4000-8000-000000000001";
const fixedBetId = "50800000-0000-4000-8000-000000000001";
const fixtureHeaders = { Authorization: "Bearer browser-fixture" };

async function fixturePost(
  request: APIRequestContext,
  route: string,
  data: unknown,
) {
  const response = await request.post(`${api}/${route}`, {
    headers: fixtureHeaders,
    data,
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function preparePlannerFixture(request: APIRequestContext, ready = true) {
  const drafts = [
    {
      entityId: poolId,
      kind: "pool",
      expectedVersion: 1,
      data: {
        title: "Mega financeira",
        lotteryId: "mega-sena",
        contestNumber: ready ? 1234 : null,
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        quotaPriceCents: "6000",
        participationMode: ready ? "internal" : "undecided",
        status: "draft",
      },
    },
    {
      entityId: "50600000-0000-4000-8000-000000000001",
      kind: "payment-proposal",
      expectedVersion: 1,
      data: {
        poolId,
        personId,
        amountCents: "6000",
        note: "Primeira transferência parcial.",
        status: "pending",
      },
    },
    {
      entityId: fixedBetId,
      kind: "bet",
      expectedVersion: 0,
      data: {
        poolId,
        lotteryId: "mega-sena",
        numbers: [1, 2, 3, 4, 5, 6],
        authorIds: [personId],
        catalogVersion: "caixa-basic-2026-10-07-v1",
        seed: null,
        generationAlgorithmVersion: null,
      },
    },
  ];
  for (const draft of drafts) {
    const result = await fixturePost(request, "sync_push", {
      operations: [{
        apiVersion: "v1",
        idempotencyKey: randomUUID(),
        groupId,
        ...draft,
        createdAt: new Date().toISOString(),
      }],
    });
    expect(result.receipts[0].status).toBe("accepted");
  }
  const decide = async (action: unknown) => {
    const snapshot = await fixturePost(request, "finance_pull", { groupId });
    const receipt = await fixturePost(request, "review_decide", {
      command: {
        apiVersion: "v1",
        idempotencyKey: randomUUID(),
        groupId,
        expectedRevision: snapshot.groupRevision,
        action,
      },
    });
    expect(receipt.status, receipt.message).toBe("accepted");
    return receipt;
  };
  const published = await decide({ type: "statute_publish", groupVersion: 1 });
  const statuteId = published.snapshot.statutes[0].id;
  await decide({
    type: "statute_accept",
    statuteId,
    personId,
    evidence: "Aceite sintético para verificar o planejamento e a trava.",
  });
  await decide({
    type: "payment_confirm",
    proposalId: "50600000-0000-4000-8000-000000000001",
    proposalVersion: 2,
    bankReference: "planner-fixture-fully-funded",
    declaredReceivedAt: null,
    allocations: [{ poolId, amountCents: "6000" }],
  });
  await decide({
    type: "quota_confirm",
    quotaId: "50500000-0000-4000-8000-000000000001",
    quotaVersion: 1,
    statuteId,
  });
}

async function openPlanner(page: Page) {
  await login(page, false);
  await page.goto(`http://127.0.0.1:4182/#/boloes/${poolId}`);
  await step(page, "Jogar");
  await expect(
    page.getByRole("button", { name: "Comparar alternativas", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Destino de eventual sobra").selectOption(
    "refund-pro-rata",
  );
  await page.getByRole("button", { name: "Comparar alternativas", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Plano Espalhada", exact: true }),
  ).toBeVisible();
}

async function approvePlan(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toBeEnabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", {
    name: "Confirmar plano no servidor",
    exact: true,
  }).click();
  await expect(dialog).not.toBeVisible();
}

test("planning preserves fixed bets, applies the budget, locks rights and downloads a verified private manifest", async ({ page, request }) => {
  await preparePlannerFixture(request);
  await openPlanner(page);
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  await approvePlan(page);
  const confirmed = page.locator('[aria-label="Plano confirmado"]');
  await expect(
    confirmed.getByRole("heading", {
      name: "Plano confirmado · versão 1",
      exact: true,
    }),
  ).toBeVisible();
  await confirmed.getByRole("button", {
    name: "Revisar trava do bolão",
    exact: true,
  }).click();
  await page.getByLabel("Responsável pelo registro externo").selectOption(
    personId,
  );
  await page.getByLabel("Titular dos bilhetes").selectOption(personId);
  await approvePlan(page);
  await expect(
    confirmed.getByText("Bolão travado · registro da trava versão 1.", { exact: true }),
  ).toBeVisible();
  const snapshot = await fixturePost(request, "plan_pull", { groupId });
  expect(snapshot.appliedPlans).toHaveLength(1);
  expect(snapshot.manifests).toHaveLength(1);
  expect(snapshot.appliedPlans[0].plan.sourceBets).toEqual([{
    id: fixedBetId,
    version: 1,
  }]);
  expect(
    snapshot.manifests[0].content.plan.bets.filter((
      bet: { sourceBetId: string | null },
    ) => bet.sourceBetId === fixedBetId),
  ).toHaveLength(1);
  const downloadPromise = page.waitForEvent("download");
  await confirmed.getByRole("button", {
    name: "Baixar registro da trava",
    exact: true,
  }).click();
  const download = await downloadPromise;
  const canonical = await readFile((await download.path())!, "utf8");
  expect(createHash("sha256").update(canonical).digest("hex")).toBe(
    snapshot.manifests[0].sha256,
  );
  expect(JSON.parse(canonical).responsible).toEqual({
    organizerUserId: actorId,
    registrarPersonId: personId,
    ticketHolderPersonId: personId,
  });
  const financial = await fixturePost(request, "finance_pull", { groupId });
  expect(financial.movements).toHaveLength(2);
  await step(page, "Jogar");
  await expect(page.getByRole("button", { name: "Gerar jogos", exact: true }))
    .toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Adicionar dezenas", exact: true }),
  ).toBeDisabled();
  await step(page, "Montar");
  await expect(page.getByRole("button", { name: "Editar bolão", exact: true }))
    .toBeDisabled();
  await step(page, "Jogar");
  await page.screenshot({
    path: "test-results/planning-locked-desktop.png",
    fullPage: true,
  });
});

test("a lost plan response is recovered after reload without replaying the application", async ({ page, request }) => {
  await preparePlannerFixture(request);
  await openPlanner(page);
  let decisions = 0;
  await page.route("**/review_decide", async (route) => {
    decisions++;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toBeEnabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", {
    name: "Confirmar plano no servidor",
    exact: true,
  }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "O resultado precisa ser verificado",
  );
  await dialog.getByRole("button", { name: "Fechar revisão", exact: true })
    .click();
  await page.goto("http://127.0.0.1:4182/#/revisao");
  await page.reload();
  await page.getByRole("button", {
    name: "Conferir decisão do plano",
    exact: true,
  }).click();
  await page.getByRole("button", {
    name: "Consultar recibo do plano",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(decisions).toBe(1);
  expect((await fixturePost(request, "plan_pull", { groupId })).appliedPlans)
    .toHaveLength(1);
});

test("a stale plan approval reports a persistent conflict without reserving another budget", async ({ page, request }) => {
  await preparePlannerFixture(request);
  await openPlanner(page);
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toBeEnabled();
  await dialog.getByRole("checkbox").check();
  await fixturePost(request, "sync_push", {
    operations: [{
      apiVersion: "v1",
      idempotencyKey: randomUUID(),
      groupId,
      entityId: randomUUID(),
      kind: "person",
      expectedVersion: 0,
      data: {
        name: "Pessoa adicionada em outro aparelho",
        nickname: "",
        adultDeclared: true,
      },
      createdAt: new Date().toISOString(),
    }],
  });
  await dialog.getByRole("button", {
    name: "Confirmar plano no servidor",
    exact: true,
  }).click();
  await expect(dialog).not.toBeVisible();
  await page.goto("http://127.0.0.1:4182/#/revisao");
  await expect(
    page.getByRole("region", { name: "Plano: Aplicar o plano", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Plano: Aplicar o plano", exact: true }),
  ).toBeVisible();
  expect((await fixturePost(request, "plan_pull", { groupId })).appliedPlans)
    .toHaveLength(0);
});

test("a revised lock preserves the first financial snapshot and both manifest versions", async ({ page, request }) => {
  await preparePlannerFixture(request);
  await openPlanner(page);
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  await approvePlan(page);
  const confirmed = page.locator('[aria-label="Plano confirmado"]');
  await confirmed.getByRole("button", {
    name: "Revisar trava do bolão",
    exact: true,
  }).click();
  await page.getByLabel("Responsável pelo registro externo").selectOption(
    personId,
  );
  await page.getByLabel("Titular dos bilhetes").selectOption(personId);
  await approvePlan(page);
  const first =
    (await fixturePost(request, "plan_pull", { groupId })).manifests[0];
  await expect(
    page.getByText("Bolão travado · registro da trava versão 1.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Comparar alternativas", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Comparar alternativas", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  await approvePlan(page);
  await expect(
    confirmed.getByRole("heading", {
      name: "Plano confirmado · versão 2",
      exact: true,
    }),
  ).toBeVisible();
  await confirmed.getByRole("button", {
    name: "Revisar nova trava",
    exact: true,
  }).click();
  await expect(page.getByLabel("Responsável pelo registro externo"))
    .toBeDisabled();
  await approvePlan(page);
  await expect(
    confirmed.getByText("Bolão travado · registro da trava versão 2.", { exact: true }),
  ).toBeVisible();
  const last = await fixturePost(request, "plan_pull", { groupId });
  expect(last.appliedPlans).toHaveLength(2);
  expect(last.manifests).toHaveLength(2);
  expect(last.manifests[0]).toEqual(first);
  expect(last.manifests[1].content.financial).toEqual(first.content.financial);
  expect(last.manifests[1].content.persons).toEqual(first.content.persons);
});

test("a lock review rejects records from an older server head", async ({ page, request }) => {
  await preparePlannerFixture(request);
  await openPlanner(page);
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  await approvePlan(page);
  await expect(page.getByRole("button", { name: "Conectado", exact: true }))
    .toBeVisible();
  let changed = false;
  await page.route("**/sync_pull", async (route) => {
    const response = await route.fetch();
    if (!changed) {
      changed = true;
      const renamed = await fixturePost(request, "sync_push", {
        operations: [{
          apiVersion: "v1",
          idempotencyKey: randomUUID(),
          groupId,
          entityId: personId,
          kind: "person",
          expectedVersion: 1,
          data: {
            name: "Nome alterado durante a consulta",
            nickname: "",
            adultDeclared: true,
          },
          createdAt: new Date().toISOString(),
        }],
      });
      expect(renamed.receipts[0].status).toBe("accepted");
    }
    await route.fulfill({ response });
  });
  await page.locator('[aria-label="Plano confirmado"]').getByRole("button", {
    name: "Revisar trava do bolão",
    exact: true,
  }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("mesma versão");
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  expect((await fixturePost(request, "plan_pull", { groupId })).manifests)
    .toHaveLength(0);
  await page.unroute("**/sync_pull");
  await dialog.getByRole("button", { name: "Atualizar revisão", exact: true })
    .click();
  await expect(
    page.getByLabel("Responsável pelo registro externo").getByRole("option", {
      name: "Nome alterado durante a consulta",
      exact: true,
    }),
  ).toHaveCount(1);
  await page.getByLabel("Responsável pelo registro externo").selectOption(
    personId,
  );
  await page.getByLabel("Titular dos bilhetes").selectOption(personId);
  await approvePlan(page);
  expect(
    (await fixturePost(request, "plan_pull", { groupId })).manifests[0].content
      .persons[0].data.name,
  ).toBe("Nome alterado durante a consulta");
});

test("a funded pool can define its contest and participation mode before its first plan", async ({ page, request }) => {
  await preparePlannerFixture(request, false);
  await login(page, false);
  await page.goto(`http://127.0.0.1:4182/#/boloes/${poolId}`);
  await step(page, "Jogar");
  await page.getByRole("button", { name: "Completar bolão", exact: true })
    .click();
  await page.getByLabel("Concurso", { exact: false }).fill("1234");
  await page.getByLabel("Forma de participação").selectOption("internal");
  await page.getByRole("button", { name: "Salvar neste aparelho", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await step(page, "Montar");
  await expect(page.getByText("Sincronizado", { exact: true })).toBeVisible();
  await step(page, "Jogar");
  await expect(
    page.getByRole("button", { name: "Comparar alternativas", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Comparar alternativas", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Plano Espalhada", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  await approvePlan(page);
  expect((await fixturePost(request, "plan_pull", { groupId })).appliedPlans)
    .toHaveLength(1);
});

async function lockRegistrationFixture(
  page: Page,
  request: APIRequestContext,
): Promise<PoolManifest> {
  await preparePlannerFixture(request);
  await openPlanner(page);
  await page.getByRole("button", {
    name: "Revisar aplicação do plano",
    exact: true,
  }).click();
  await approvePlan(page);
  await page.locator('[aria-label="Plano confirmado"]').getByRole("button", {
    name: "Revisar trava do bolão",
    exact: true,
  }).click();
  await page.getByLabel("Responsável pelo registro externo").selectOption(
    personId,
  );
  await page.getByLabel("Titular dos bilhetes").selectOption(personId);
  await approvePlan(page);
  const snapshot = await fixturePost(request, "plan_pull", { groupId });
  await step(page, "Registrar");
  return snapshot.manifests[0];
}

const syntheticOriginal = Buffer.from(
  "%PDF-1.4\nOriginal sintético de integração; não é recibo CAIXA.\n%%EOF\n",
);
async function addOriginal(page: Page) {
  await page.getByLabel("Anexar comprovante").setInputFiles({
    name: "comprovante-sintetico.pdf",
    mimeType: "application/pdf",
    buffer: syntheticOriginal,
  });
  await expect(page.locator(".pool-file")).toContainText(
    "Salvo neste aparelho",
  );
  await page.getByRole("button", { name: "Enviar original", exact: true })
    .click();
  await expect(page.locator(".pool-file")).toContainText(
    "Original verificado",
  );
}
function brasiliaCivil(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((item) => item.type === type)!.value;
  // The browser drops ":00" seconds from a datetime-local value, and Playwright then reports "Malformed value".
  const seconds = part("second") === "00" ? "" : `:${part("second")}`;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${
    part("minute")
  }${seconds}`;
}
async function fillObserved(
  page: Page,
  manifest: PoolManifest,
  partial = false,
) {
  const plan = manifest.content.plan;
  for (let index = 0; index < (partial ? 1 : plan.tickets.length); index++) {
    const ticket = plan.tickets[index];
    await page.getByLabel("Cartela a conferir").selectOption(String(index));
    await page.getByRole("checkbox", {
      name: "Comprovante apresentado para esta cartela.",
      exact: true,
    }).check();
    await page.getByRole("group", {
      name: "Originais verificados desta cartela",
    }).getByRole("checkbox").check();
    await page.getByLabel("Modalidade lida no recibo").selectOption(
      plan.lotteryId,
    );
    await page.getByLabel("Concurso lido no recibo").fill(
      String(plan.contestNumber),
    );
    await page.getByLabel("Dezenas lidas no recibo").fill(
      ticket.betKeys.map((key) =>
        plan.bets.find((bet) => bet.key === key)!.numbers.join(" ")
      ).join("\n"),
    );
    if (!partial) {
      await page.getByLabel("Valor das apostas lido (R$)").fill(
        (Number(ticket.betCostCents) / 100).toFixed(2).replace(".", ","),
      );
      await page.getByLabel("Taxa externa lida (R$)").fill("0,00");
      await page.getByLabel("Horário lido no recibo (Brasília)").fill(
        brasiliaCivil(new Date()),
      );
    } else {await page.getByLabel("Observação da cartela").fill(
        "Valores e horário não legíveis no original sintético.",
      );}
  }
  await page.getByLabel("Motivo da conferência ou correção").fill(
    partial
      ? "Conferência parcial sintética; demais dados continuam pendentes."
      : "Todos os dados sintéticos foram lidos e conferidos pelo organizador.",
  );
  await page.getByRole("button", {
    name: "Revisar conferência do registro",
    exact: true,
  }).click();
}
async function approveRecord(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toBeEnabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", {
    name: "Confirmar conferência no servidor",
    exact: true,
  }).click();
  await expect(dialog).not.toBeVisible();
}

test("originals persist offline, registration is reviewed separately and the registered plan freezes", async ({ page, request, context }) => {
  test.setTimeout(90_000);
  const manifest = await lockRegistrationFixture(page, request);
  await context.setOffline(true);
  await page.getByLabel("Anexar comprovante").setInputFiles({
    name: "comprovante-sintetico.pdf",
    mimeType: "application/pdf",
    buffer: syntheticOriginal,
  });
  await expect(page.locator(".pool-file")).toContainText(
    "Salvo neste aparelho",
  );
  await page.reload();
  await step(page, "Registrar");
  await expect(page.getByText("comprovante-sintetico.pdf", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enviar original", exact: true }),
  ).toBeDisabled();
  const localDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar original", exact: true })
    .click();
  expect(await readFile((await (await localDownloadPromise).path())!)).toEqual(
    syntheticOriginal,
  );
  await context.setOffline(false);
  await expect(
    page.getByRole("button", { name: "Enviar original", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Enviar original", exact: true })
    .click();
  await expect(page.locator(".pool-file")).toContainText(
    "Original verificado",
  );
  const before = await fixturePost(request, "registration_pull", { groupId });
  expect(before.reports).toHaveLength(0);
  expect(before.evidence[0].sha256).toBe(
    createHash("sha256").update(syntheticOriginal).digest("hex"),
  );
  const checklistPromise = page.waitForEvent("download");
  await page.getByRole("button", {
    name: "Baixar lista",
    exact: true,
  }).click();
  const checklist = await readFile(
    (await (await checklistPromise).path())!,
    "utf8",
  );
  expect(checklist).toContain("Pessoa financeira");
  expect(checklist).not.toContain("planner-fixture-fully-funded");
  expect(checklist).not.toContain("sourceProposal");
  await fillObserved(page, manifest);
  await expect(page.getByRole("dialog").getByText(/SHA-256/)).toHaveCount(
    manifest.content.plan.tickets.length,
  );
  await approveRecord(page);
  const report = page.locator('[aria-label="O que foi registrado"]');
  await expect(report.getByText("Registro completo", { exact: true }))
    .toBeVisible();
  const recorded = await fixturePost(request, "registration_pull", { groupId });
  expect(recorded.reports[0].comparison.status).toBe("complete");
  expect(recorded.reports[0].manifestId).toBe(manifest.id);
  expect((await fixturePost(request, "finance_pull", { groupId })).movements)
    .toHaveLength(2);
  await step(page, "Jogar");
  await expect(
    page.locator('[aria-label="Plano confirmado"]').getByRole("button", {
      name: "Revisar nova trava",
      exact: true,
    }),
  ).toBeDisabled();
  await step(page, "Registrar");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/registration-mobile.png",
    fullPage: true,
  });
});

test("an accepted partial registration with a lost response is recovered without replaying or changing financial facts", async ({ page, request }) => {
  test.setTimeout(90_000);
  const manifest = await lockRegistrationFixture(page, request);
  await addOriginal(page);
  await fillObserved(page, manifest, true);
  let decisions = 0;
  await page.route("**/review_decide", async (route) => {
    decisions++;
    await route.fetch();
    await route.abort("failed");
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toBeEnabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", {
    name: "Confirmar conferência no servidor",
    exact: true,
  }).click();
  await expect(
    dialog.getByRole("button", {
      name: "Consultar recibo da conferência",
      exact: true,
    }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Fechar revisão", exact: true })
    .click();
  await page.unroute("**/review_decide");
  await page.goto("http://127.0.0.1:4182/#/revisao");
  await page.reload();
  await page.getByRole("button", {
    name: "Conferir o registro",
    exact: true,
  }).click();
  await page.getByRole("button", {
    name: "Consultar recibo da conferência",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(decisions).toBe(1);
  const recorded = await fixturePost(request, "registration_pull", { groupId });
  expect(recorded.reports).toHaveLength(1);
  expect(recorded.reports[0].comparison.status).toBe("partial");
  expect(recorded.reports[0].comparison.observedFeeCents).toBeNull();
  expect((await fixturePost(request, "finance_pull", { groupId })).movements)
    .toHaveLength(2);
  await page.goto(`http://127.0.0.1:4182/#/boloes/${poolId}`);
  await step(page, "Jogar");
  await expect(
    page.locator('[aria-label="Plano confirmado"]').getByRole("button", {
      name: "Revisar nova trava",
      exact: true,
    }),
  ).toBeDisabled();
});

test("manual results, official conflicts, failed collection and contest times preserve the evidence and keep calculated prizes separate", async ({ page, request }) => {
  test.setTimeout(120_000);
  const manifest = await lockRegistrationFixture(page, request);
  await addOriginal(page);
  await fillObserved(page, manifest);
  await approveRecord(page);
  await step(page, "Sorteio");
  await page.getByRole("button", { name: "Informar resultado", exact: true })
    .click();
  await page.getByLabel("Data do sorteio em Brasília").fill("2026-10-08");
  await page.getByLabel("Dezenas sorteadas", { exact: true }).fill(
    "1 2 3 4 5 6",
  );
  await page.getByLabel("Prêmio de 6 acertos (R$)").fill("1000,00");
  await page.getByLabel("Prêmio de 5 acertos (R$)").fill("100,00");
  await page.getByLabel("Prêmio de 4 acertos (R$)").fill("10,00");
  await page.getByLabel("Fonte do resultado", { exact: true }).fill(
    "Publicação sintética de integração.",
  );
  await page.getByLabel("Motivo do resultado manual").fill(
    "Conferência humana sintética para testar a apuração.",
  );
  await page.getByRole("button", {
    name: "Revisar resultado informado",
    exact: true,
  }).click();
  await approveRecord(page);
  const resultCard = page.locator('[aria-label="Resultado"]');
  await expect(
    resultCard.getByRole("heading", { name: "Acertamos a sena!" }),
  ).toBeVisible();
  await resultCard.getByText("Ver cálculo", { exact: true }).click();
  await expect(resultCard.getByText(/R\$ 1\.000,00/).first()).toBeVisible();
  const originalNumbers = ["01", "02", "03", "04", "05", "60"];
  const source = (numbers = originalNumbers) =>
    JSON.stringify({
      numero: 1234,
      tipoJogo: "MEGA_SENA",
      dataApuracao: "08/10/2026",
      listaDezenas: numbers,
      listaRateioPremio: [
        { faixa: 1, numeroDeGanhadores: 1, valorPremio: 1000 },
        { faixa: 2, numeroDeGanhadores: 1, valorPremio: 100 },
        { faixa: 3, numeroDeGanhadores: 1, valorPremio: 10 },
      ],
    });
  await request.post("http://127.0.0.1:4190/__test/source", {
    data: { rawText: source() },
  });
  await page.getByText("Atualizar o resultado", { exact: true }).click();
  await page.getByRole("button", {
    name: "Consultar resultado da CAIXA",
    exact: true,
  })
    .click();
  const resultPanel = page.locator('[aria-label="Números sorteados"]');
  await expect(
    resultPanel.getByText("Dois resultados não batem", { exact: true }),
  )
    .toBeVisible();
  const officialVersion =
    (await fixturePost(request, "results_pull", { groupId })).results.find((
      item: { source: string; version: number },
    ) => item.source === "caixa" && item.version === 2);
  expect(officialVersion).toBeTruthy();
  await resultPanel.locator(`input[type="radio"][value="${officialVersion.id}"]`)
    .check();
  await page.getByLabel("Motivo da escolha").fill(
    "Resultado sintético oficial escolhido após comparar as duas fontes.",
  );
  await page.getByRole("button", { name: "Revisar", exact: true }).click();
  await approveRecord(page);
  await expect(resultPanel.getByText(/^CAIXA · coletado em/)).toBeVisible();
  await expect(resultPanel.locator(".pool-drawn")).toContainText("60");
  await request.post("http://127.0.0.1:4190/__test/source", {
    data: { fail: true },
  });
  await page.getByRole("button", {
    name: "Consultar resultado da CAIXA",
    exact: true,
  })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "O último resultado válido continua valendo.",
    }),
  ).toBeVisible();
  const resultSnapshot = await fixturePost(request, "results_pull", {
    groupId,
  });
  expect(resultSnapshot.results).toHaveLength(2);
  expect(resultSnapshot.selections).toHaveLength(1);
  expect(resultSnapshot.results[1].drawnNumbers).toEqual([1, 2, 3, 4, 5, 60]);
  await page.getByText("Horários do concurso", { exact: true }).click();
  await page.getByLabel("Data do concurso em Brasília").fill("2026-10-08");
  await page.getByLabel("Sorteio previsto (Brasília)").fill("2026-10-08T20:00");
  await page.getByLabel("Encerramento do canal (Brasília)").fill(
    "2026-10-08T19:00",
  );
  await page.getByLabel("Fonte dos horários").fill(
    "Calendário sintético de integração.",
  );
  await page.getByLabel("Motivo da definição ou correção").fill(
    "Horários separados do prazo interno do grupo.",
  );
  await page.getByRole("button", {
    name: "Revisar horários do concurso",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog").getByText(/23:00:00\.000Z/))
    .toBeVisible();
  await approveRecord(page);
  expect(
    (await fixturePost(request, "results_pull", { groupId })).calendarVersions
      .at(-1).expectedDrawAt,
  ).toBe("2026-10-08T23:00:00.000Z");
  expect((await fixturePost(request, "finance_pull", { groupId })).movements)
    .toHaveLength(2);
  await page.screenshot({
    path: "test-results/results-desktop.png",
    fullPage: true,
  });
  await request.post("http://127.0.0.1:4190/__test/source", {
    data: { rawText: source(["01", "02", "03", "04", "05", "59"]) },
  });
  await page.getByRole("button", {
    name: "Consultar resultado da CAIXA",
    exact: true,
  })
    .click();
  await expect(
    resultPanel.getByText("Dois resultados não batem", { exact: true }),
  )
    .toBeVisible();
});

test("repeating with the same group carries the games, suggests the next contest and calls last round's people in Arrecadar", async ({ page, request }) => {
  test.setTimeout(120_000);
  const manifest = await lockRegistrationFixture(page, request);
  await addOriginal(page);
  await fillObserved(page, manifest);
  await approveRecord(page);
  await step(page, "Jogar");
  await expect(page.locator(".pool-game").first()).toBeVisible();
  const games = await page.locator(".pool-game .ui-balls").allTextContents();
  // A draw that hits no planned game on four or more numbers, so the result card offers "Repetir".
  const drawn = Array.from({ length: 55 }, (_, i) => [1, 2, 3, 4, 5, 6].map((k) => i + k))
    .find((c) => manifest.content.plan.bets.every((b) => c.filter((n) => b.numbers.includes(n)).length < 4))!;
  await step(page, "Sorteio");
  await page.getByRole("button", { name: "Informar resultado", exact: true }).click();
  await page.getByLabel("Data do sorteio em Brasília").fill("2026-10-08");
  await page.getByLabel("Dezenas sorteadas", { exact: true }).fill(drawn.join(" "));
  await page.getByLabel("Prêmio de 6 acertos (R$)").fill("1000,00");
  await page.getByLabel("Prêmio de 5 acertos (R$)").fill("100,00");
  await page.getByLabel("Prêmio de 4 acertos (R$)").fill("10,00");
  await page.getByLabel("Fonte do resultado", { exact: true }).fill("Publicação sintética de integração.");
  await page.getByLabel("Motivo do resultado manual").fill("Conferência humana sintética para testar a repetição.");
  await page.getByRole("button", { name: "Revisar resultado informado", exact: true }).click();
  await approveRecord(page);
  await page.getByRole("button", { name: "Repetir com a mesma turma", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`Vão junto: ${games.length} ${games.length === 1 ? "jogo" : "jogos"}. As pessoas entram em Arrecadar conforme responderem.`)).toBeVisible();
  await expect(dialog.getByLabel(/^Concurso/)).toHaveValue("1235");
  await expect(dialog.getByLabel("Forma de participação")).toHaveValue("internal");
  await dialog.getByRole("button", { name: "Salvar neste aparelho" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/#\/boloes\/(?!50400000)[^/]+\/montar$/);
  await expect(page.locator("dd", { hasText: /^1235$/ })).toBeVisible();
  await step(page, "Arrecadar");
  const call = page.getByRole("region", { name: "Chamada" });
  const caller = call.locator(".pool-call-person", { hasText: "Pessoa financeira" });
  await expect(caller).toContainText("1 cota");
  await expect(call.getByText("1 ainda não respondeu")).toBeVisible();
  await caller.getByRole("button", { name: "Pessoa financeira entrou" }).click();
  await expect(call).not.toBeVisible();
  const person = page.locator(".pool-person", { hasText: "Pessoa financeira" });
  await expect(person.locator(".pool-person-sub")).toHaveText("1 cota · pagou R$ 0,00");
  await expect(person.getByText("Ainda não pagou")).toBeVisible();
  await step(page, "Jogar");
  await expect(page.locator(".pool-game")).toHaveCount(games.length);
  expect(await page.locator(".pool-game .ui-balls").allTextContents()).toEqual(games);
});

test("an official result that rolled over says so and calls the group to the next contest", async ({ page, request }) => {
  test.setTimeout(120_000);
  const manifest = await lockRegistrationFixture(page, request);
  await addOriginal(page);
  await fillObserved(page, manifest);
  await approveRecord(page);
  const drawn = Array.from({ length: 55 }, (_, i) => [1, 2, 3, 4, 5, 6].map((k) => i + k))
    .find((c) => manifest.content.plan.bets.every((b) => c.filter((n) => b.numbers.includes(n)).length < 4))!;
  await request.post("http://127.0.0.1:4190/__test/source", {
    data: {
      rawText: JSON.stringify({
        acumulado: true,
        numero: 1234,
        tipoJogo: "MEGA_SENA",
        dataApuracao: "08/10/2026",
        listaDezenas: drawn.map((n) => String(n).padStart(2, "0")),
        listaRateioPremio: [
          { faixa: 1, numeroDeGanhadores: 0, valorPremio: 0 },
          { faixa: 2, numeroDeGanhadores: 1, valorPremio: 100 },
          { faixa: 3, numeroDeGanhadores: 1, valorPremio: 10 },
        ],
        numeroConcursoProximo: 1235,
        valorEstimadoProximoConcurso: 115000000,
      }),
    },
  });
  await step(page, "Sorteio");
  await page.getByRole("button", { name: "Consultar resultado da CAIXA", exact: true }).click();
  const resultCard = page.locator('[aria-label="Resultado"]');
  await expect(resultCard.getByText("Acumulou! Próximo prêmio estimado R$ 115.000.000,00", { exact: true })).toBeVisible();
  await expect(resultCard.getByRole("button", { name: "Chamar a turma: concurso 1235", exact: true })).toBeVisible();
});

const brl = (cents: string | bigint) => {
  const value = BigInt(cents);
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${whole},${(value % 100n).toString().padStart(2, "0")}`;
};
async function confirmSplit(
  page: Page,
  done: string,
  reason?: string,
) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", {
    name: "comprovante-sintetico.pdf",
    exact: true,
  }).check();
  if (reason) await dialog.getByLabel("Motivo", { exact: true }).fill(reason);
  const reviewed = dialog.getByRole("checkbox", {
    name: "Conferi o valor e o comprovante.",
  });
  await expect(reviewed).toBeEnabled();
  await reviewed.check();
  await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(dialog.getByText(done, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Pronto", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("the prize split confirms cost and prize, records the redemption, pays, reverses, pays again, closes and reopens on the real SQL", async ({ page, request }) => {
  test.setTimeout(150_000);
  const manifest = await lockRegistrationFixture(page, request);
  await addOriginal(page);
  await fillObserved(page, manifest);
  await approveRecord(page);
  await step(page, "Sorteio");
  await page.getByRole("button", { name: "Informar resultado", exact: true })
    .click();
  await page.getByLabel("Data do sorteio em Brasília").fill("2026-10-08");
  await page.getByLabel("Dezenas sorteadas", { exact: true }).fill(
    "1 2 3 4 5 6",
  );
  await page.getByLabel("Prêmio de 6 acertos (R$)").fill("1000,00");
  await page.getByLabel("Prêmio de 5 acertos (R$)").fill("100,00");
  await page.getByLabel("Prêmio de 4 acertos (R$)").fill("10,00");
  await page.getByLabel("Fonte do resultado", { exact: true }).fill(
    "Publicação sintética de integração.",
  );
  await page.getByLabel("Motivo do resultado manual").fill(
    "Conferência humana sintética para testar a divisão.",
  );
  await page.getByRole("button", {
    name: "Revisar resultado informado",
    exact: true,
  }).click();
  await approveRecord(page);
  await step(page, "Dividir");

  const cost = page.locator('[aria-label="Custo das apostas"]');
  await cost.getByRole("button", { name: /^Confirmar custo R\$/ }).click({
    timeout: 20_000,
  });
  await confirmSplit(page, "Custo confirmado.");
  await expect(cost.getByText(/^Custo confirmado em/)).toBeVisible();

  const prizeCard = page.locator('[aria-label="Prêmio"]');
  await expect(prizeCard.getByText("Prêmio calculado", { exact: true }))
    .toBeVisible();
  await prizeCard.getByRole("button", { name: "Confirmar prêmio", exact: true })
    .click();
  await confirmSplit(page, "Prêmio confirmado.");
  await expect(prizeCard.getByText(/^Confirmado em/)).toBeVisible();

  const redemption = page.locator('[aria-label="Resgate"]');
  await redemption.getByRole("button", { name: "Recebi o prêmio", exact: true })
    .click();
  await confirmSplit(page, "Resgate registrado.");
  await expect(redemption.getByText("Prêmio todo resgatado", { exact: true }))
    .toBeVisible();

  const confirmed = await fixturePost(request, "settlement_pull", { groupId });
  const prize = BigInt(confirmed.prizes[0].amountCents);
  const expense = BigInt(confirmed.expenses[0].totalCostCents);
  expect(prize > 0n).toBe(true);
  expect(confirmed.redemptions[0].amountCents).toBe(prize.toString());

  const division = page.locator('[aria-label="Como fica a divisão"]');
  const row = division.locator(".pool-person").filter({
    hasText: "Pessoa financeira",
  });
  await expect(row.getByText("A pagar", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Já paguei", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Valor pago (R$)").fill(
    brl(prize + 1n).slice(3),
  );
  await dialog.getByRole("checkbox", {
    name: "comprovante-sintetico.pdf",
    exact: true,
  }).check();
  await expect(
    dialog.getByText(
      "Pagamento não pode exceder direito e resgate interno disponíveis.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "Conferi o valor e o comprovante." }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await row.getByRole("button", { name: "Já paguei", exact: true }).click();
  await confirmSplit(page, "Pagamento registrado.");
  await expect(row.getByText("Pago", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Desfazer", exact: true }).click();
  await confirmSplit(
    page,
    "Pagamento desfeito.",
    "Pagamento devolvido pela pessoa no teste.",
  );
  await expect(row.getByText("A pagar", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Já paguei", exact: true }).click();
  await dialog.getByRole("checkbox", {
    name: "comprovante-sintetico.pdf",
    exact: true,
  }).check();
  const pushed = await fixturePost(request, "sync_push", {
    operations: [{
      apiVersion: "v1",
      idempotencyKey: randomUUID(),
      groupId,
      entityId: randomUUID(),
      kind: "person",
      expectedVersion: 0,
      data: { name: "Pessoa nova", nickname: "", adultDeclared: true },
      createdAt: new Date().toISOString(),
    }],
  });
  expect(pushed.receipts[0].status).toBe("accepted");
  await dialog.getByRole("checkbox", {
    name: "Conferi o valor e o comprovante.",
  }).check();
  await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    dialog.getByText("Alguém mudou o grupo; atualize e confira de novo", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Atualizar e conferir", exact: true })
    .click();
  await confirmSplit(page, "Pagamento registrado.");
  await expect(row.getByText("Pago", { exact: true })).toBeVisible();

  const totals = division.getByLabel("Totais da divisão");
  await expect(totals).toContainText(`Já pago${brl(prize)}`);
  await expect(totals).toContainText("A pagarR$ 0,00");
  const leftover = page.locator('[aria-label="Sobra e devoluções"]');
  await leftover.getByText("Ver conta", { exact: true }).click();
  await expect(leftover.locator(".split-formula")).toHaveText(
    `Caixa do organizador: ${brl(6000n - expense)} = contribuições ${
      brl(6000n)
    } + resgates ${brl(prize)} − custos ${brl(expense)} − pagamentos ${
      brl(prize)
    }`,
  );
  const settled = await fixturePost(request, "settlement_pull", { groupId });
  expect(
    settled.distributions.map((item: { direction: string }) => item.direction),
  ).toEqual(["paid", "returned", "paid"]);
  expect(settled.redemptions).toHaveLength(1);
  expect(settled.prizes).toHaveLength(1);
  expect(settled.expenses).toHaveLength(1);

  // Nothing left open: the pool closes without an explanation and reopens by a human decision.
  const closing = page.locator('[aria-label="Encerrar o bolão"]');
  const review = async (done: string) => {
    await dialog.getByRole("checkbox", { name: "Conferi a conta do bolão." })
      .check();
    await dialog.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(dialog.getByText(done, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Pronto", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  };
  await expect(closing).toContainText("Prêmio a pagarR$ 0,00");
  await expect(closing).toContainText("Devoluções pendentesR$ 0,00");
  await closing.getByRole("button", { name: "Encerrar o bolão", exact: true })
    .click();
  await review("Bolão encerrado.");
  const closed = page.locator('[aria-label="Encerramento"]');
  await expect(closed.getByText(/^Bolão encerrado em \d{2}\/\d{2}$/))
    .toBeVisible();
  await expect(closing).not.toBeVisible();
  await closed.getByRole("button", { name: "Reabrir o bolão", exact: true })
    .click();
  await review("Bolão reaberto.");
  await expect(
    closing.getByRole("button", { name: "Encerrar o bolão", exact: true }),
  ).toBeVisible();
  const reopened = await fixturePost(request, "settlement_pull", { groupId });
  expect(
    reopened.closures.map((item: { direction: string }) => item.direction),
  ).toEqual(["closed", "reopened"]);
});
