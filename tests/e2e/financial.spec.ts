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
  await page.getByRole("button", { name: "Conferir recebimento", exact: true })
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
    page.getByRole("cell", { name: "Estorno do recebimento", exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Participação de Pessoa financeira em Mega financeira revogada/,
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
  await page.getByRole("button", { name: "Conferir recebimento", exact: true })
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
    page.getByText("Uma decisão precisa de verificação", { exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Verificar decisão", exact: true }),
  ).toBeVisible();
  expect(decisions).toBe(1);
  await page.getByRole("button", { name: "Verificar decisão", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", {
    name: "Consultar recibo",
    exact: true,
  }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByText("Uma decisão precisa de verificação", { exact: true }),
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
  await page.getByRole("button", { name: "Conferir recebimento", exact: true })
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
    page.getByRole("heading", {
      name: "Decisões não confirmadas",
      exact: true,
    }),
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
  await page.getByRole("button", { name: "Conferir recebimento", exact: true })
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
  await page.getByRole("button", { name: "Conferir recebimento", exact: true })
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
  await page.getByRole("button", { name: "Conferir recebimento", exact: true })
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
    page.getByText("A conexão Supabase ainda não foi configurada.", {
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
    name: "Verificar decisão do plano",
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
    page.getByRole("heading", {
      name: "Decisões de plano que precisam de revisão",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Decisões de plano que precisam de revisão",
      exact: true,
    }),
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
  await page.getByLabel("Selecionar original").setInputFiles({
    name: "comprovante-sintetico.pdf",
    mimeType: "application/pdf",
    buffer: syntheticOriginal,
  });
  await expect(page.locator(".evidence-file small")).toContainText(
    "Salvo neste aparelho",
  );
  await page.getByRole("button", { name: "Enviar original", exact: true })
    .click();
  await expect(page.locator(".evidence-file small")).toContainText(
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
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${
    part("minute")
  }:${part("second")}`;
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
  await page.getByLabel("Selecionar original").setInputFiles({
    name: "comprovante-sintetico.pdf",
    mimeType: "application/pdf",
    buffer: syntheticOriginal,
  });
  await expect(page.locator(".evidence-file small")).toContainText(
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
  await expect(page.locator(".evidence-file small")).toContainText(
    "Original verificado",
  );
  const before = await fixturePost(request, "registration_pull", { groupId });
  expect(before.reports).toHaveLength(0);
  expect(before.evidence[0].sha256).toBe(
    createHash("sha256").update(syntheticOriginal).digest("hex"),
  );
  const checklistPromise = page.waitForEvent("download");
  await page.getByRole("button", {
    name: "Baixar lista privada para o registrador",
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
  const report = page.locator('[aria-label="Registro conferido"]');
  await expect(report.getByText("Conferência completa", { exact: true }))
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
    name: "Verificar conferência do registro",
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
  await page.getByText("Informar resultado manual com fonte", { exact: true })
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
  await expect(
    page.locator('[aria-label="Apuração dos jogos registrados"]').getByText(
      /R\$ 1\.000,00/,
    ).first(),
  ).toBeVisible();
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
  await page.getByRole("button", {
    name: "Consultar resultado da CAIXA",
    exact: true,
  })
    .click();
  const resultPanel = page.locator('[aria-label="Resultado do concurso"]');
  await expect(
    resultPanel.getByText("Diferenças entre versões precisam de revisão", {
      exact: true,
    }),
  )
    .toBeVisible();
  const officialVersion =
    (await fixturePost(request, "results_pull", { groupId })).results.find((
      item: { source: string; version: number },
    ) => item.source === "caixa" && item.version === 2);
  expect(officialVersion).toBeTruthy();
  await page.getByLabel("Versão para usar").selectOption(officialVersion.id);
  await page.getByLabel("Motivo da escolha").fill(
    "Resultado sintético oficial escolhido após comparar as duas fontes.",
  );
  await page.getByRole("button", {
    name: "Revisar escolha do resultado",
    exact: true,
  }).click();
  await approveRecord(page);
  await expect(resultPanel.getByText(/Versão 2 · Fonte CAIXA/)).toBeVisible();
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
      hasText: "último resultado válido preservado",
    }),
  ).toBeVisible();
  const resultSnapshot = await fixturePost(request, "results_pull", {
    groupId,
  });
  expect(resultSnapshot.results).toHaveLength(2);
  expect(resultSnapshot.selections).toHaveLength(1);
  expect(resultSnapshot.results[1].drawnNumbers).toEqual([1, 2, 3, 4, 5, 60]);
  await page.getByText("Informar ou revisar horários com fonte", {
    exact: true,
  }).click();
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
    resultPanel.getByText("Diferenças entre versões precisam de revisão", {
      exact: true,
    }),
  )
    .toBeVisible();
});
