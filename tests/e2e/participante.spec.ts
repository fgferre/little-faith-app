import { expect, test } from "@playwright/test";
import type { Browser, Page, Route } from "@playwright/test";
import { mockCaixa } from "./caixa";

// The Node fixture on :4190 does not serve the participant routes (the real `api` runs in Deno,
// covered by `npm run test:api`), so the four routes are simulated here with `page.route`.
// One at a time: the Arrecadar flows reset the shared fixture at their start, like the financial ones do.
test.describe.configure({ mode: "serial" });
const origin = "http://127.0.0.1:4182";
const actorId = "50100000-0000-4000-8000-000000000001";
const poolId = "50400000-0000-4000-8000-000000000001";
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function reply(route: Route, status: number, body: unknown) {
  return route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 204, headers: cors })
    : route.fulfill({
      status,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

/** The organizer's browser, signed in, with the link and phone routes simulated; returns the server's state. */
async function organizerPage(browser: Browser) {
  const server = {
    token: "tok_Nov0-link_123",
    name: "",
    revoked: false,
    // The link the organizer created, as the pull returns it; the server never gives the token back.
    link: null as
      | { id: string; personId: string; createdAt: string; revokedAt: string | null }
      | null,
    phones: {} as Record<string, string>,
    // What the cards answered and when the treasurer reminded someone, as the server returns them.
    answers: [] as Record<string, unknown>[],
    reminders: [] as Record<string, unknown>[],
  };
  const context = await browser.newContext();
  await mockCaixa(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await context.addInitScript((actorId) => {
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
  }, actorId);
  const page = await context.newPage();
  await page.route("**/v1/participant_links_pull", (route) =>
    reply(route, 200, { links: server.link ? [server.link] : [] }));
  await page.route("**/v1/participant_link", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    const created = {
      id: "50800000-0000-4000-8000-000000000001",
      personId: route.request().postDataJSON().personId,
      createdAt: "2026-10-11T15:00:00.000Z",
    };
    server.link = { ...created, revokedAt: null };
    return reply(route, 201, { ...created, token: server.token });
  });
  await page.route("**/v1/participant_responses_pull", (route) =>
    reply(route, 200, { responses: server.answers, reminders: server.reminders }));
  await page.route("**/v1/participant_reminder", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    const body = route.request().postDataJSON() as Record<string, string>;
    const mark = {
      id: `50a00000-0000-4000-8000-00000000000${server.reminders.length + 1}`,
      poolId: body.poolId,
      personId: body.personId,
      remindedAt: "2026-10-16T13:30:00.000Z",
    };
    server.reminders.push(mark);
    return reply(route, 200, mark);
  });
  await page.route("**/v1/participant_link_revoke", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    server.revoked = true;
    if (server.link) server.link.revokedAt = "2026-10-11T16:00:00.000Z";
    return reply(route, 200, {
      id: "50800000-0000-4000-8000-000000000001",
      revokedAt: "2026-10-11T16:00:00.000Z",
    });
  });
  await page.route("**/v1/groups/*/phones", (route) =>
    reply(route, 200, {
      phones: Object.entries(server.phones).map(([personId, phone]) => ({
        personId,
        phone,
      })),
    }));
  await page.route("**/v1/groups/*/persons/*/phone", (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return reply(route, 204, {});
    const personId = route.request().url().match(/persons\/([^/]+)\/phone/)![1];
    if (method === "DELETE") {
      delete server.phones[personId];
      return route.fulfill({ status: 204, headers: cors });
    }
    const { phone } = route.request().postDataJSON();
    server.phones[personId] = phone;
    return reply(route, 200, { personId, phone });
  });
  return { page, context, server };
}

/** The organizer sends the personal link in Arrecadar; returns the copied message's link and name. */
async function sendLink(browser: Browser) {
  const { page, context, server } = await organizerPage(browser);
  await page.goto(`${origin}/#/boloes/${poolId}/arrecadar`);
  const send = page.getByRole("button", { name: "Enviar link pessoal" })
    .first();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText(/Link enviado em/)).toBeVisible();
  const message = await page.evaluate(() => navigator.clipboard.readText());
  server.name = message.match(/^Oi, (.+)\. Este é seu cartão/)![1];
  const link = message.match(/https?:\/\/\S+#\/p\/[\w-]+/)![0];
  await expect(
    page.locator(".pool-person-link").getByRole("link", {
      name: "Enviar no WhatsApp",
    }),
  ).toHaveAttribute("href", `https://wa.me/?text=${encodeURIComponent(message)}`);
  return { page, context, link, server };
}

/** The participant's browser: no login, the card route answers like the server would. */
async function openCard(
  browser: Browser,
  link: string,
  server: { token: string; name: string; revoked: boolean },
  changes: { group?: object; pool?: object } = {},
) {
  const context = await browser.newContext();
  await mockCaixa(context);
  const page = await context.newPage();
  await page.route("**/v1/participant_card", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    if (route.request().headers().authorization) {
      return reply(route, 400, { code: "unexpected_authorization" });
    }
    if (route.request().postDataJSON().token !== server.token) {
      return reply(route, 404, { code: "link_unknown" });
    }
    if (server.revoked) return reply(route, 410, { code: "link_revoked" });
    return reply(route, 200, {
      version: 1,
      generatedAt: "2026-10-11T15:00:00.000Z",
      group: { name: "Grupo de teste", pix: null, ...changes.group },
      person: { id: "p-1", name: server.name },
      pools: [{
        id: "pool-mega",
        title: "Mega entre amigos",
        modality: "mega-sena",
        contest: 2930,
        drawAt: "2026-10-10T23:00:00.000Z",
        status: "registered",
        participationMode: "internal",
        quota: { units: 100, dueCents: "6000", paidCents: "6000", paid: true },
        games: [{ numbers: [4, 15, 17, 26, 40, 55], registered: true }],
        registration: { status: "registered", ticketHolderName: "Rafael" },
        result: null,
        share: null,
        closed: false,
        ...changes.pool,
      }],
    });
  });
  await page.goto(link);
  return { page, context };
}

test("a personal link opens the participant's card without login", async ({ browser }) => {
  const organizer = await sendLink(browser);
  const participant = await openCard(
    browser,
    organizer.link,
    organizer.server,
  );
  await expect(
    participant.page.getByText(`Você: ${organizer.server.name}`),
  ).toBeVisible();
  await expect(participant.page.getByText("Suas cotas", { exact: true }))
    .toBeVisible();
  await participant.context.close();
  await organizer.context.close();
});

test("a saved WhatsApp number makes the personal link open in that person's chat", async ({ browser }) => {
  const { page, context } = await organizerPage(browser);
  await page.goto(`${origin}/#/boloes/${poolId}/arrecadar`);
  const row = page.locator(".pool-person").first();
  await row.getByRole("button", { name: /^WhatsApp de / }).click();
  await page.getByLabel("WhatsApp com DDD").fill("11 96948 4954");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(row.getByRole("button", { name: /\+55 11 96948-4954/ }))
    .toBeVisible();
  await page.reload();
  await expect(row.getByRole("button", { name: /\+55 11 96948-4954/ }))
    .toBeVisible();
  await row.getByRole("button", { name: "Enviar link pessoal" }).click();
  await expect(row.getByRole("link", { name: "Enviar no WhatsApp" }))
    .toHaveAttribute("href", /^https:\/\/wa\.me\/5511969484954\?text=/);
  // The message stays on this device: after leaving and coming back, the same link can be resent.
  await page.reload();
  await expect(row.getByRole("link", { name: "Enviar no WhatsApp" }))
    .toHaveAttribute("href", /^https:\/\/wa\.me\/5511969484954\?text=/);
  await context.close();
});

test("cancelling the personal link closes the participant's card", async ({ browser }) => {
  const organizer = await sendLink(browser);
  const participant = await openCard(
    browser,
    organizer.link,
    organizer.server,
  );
  await expect(participant.page.getByText("Suas cotas", { exact: true }))
    .toBeVisible();
  await organizer.page.getByRole("button", { name: "Cancelar link" }).first()
    .click();
  await expect(
    organizer.page.getByRole("button", { name: "Enviar link pessoal" })
      .first(),
  ).toBeVisible();
  await participant.page.reload();
  await expect(
    participant.page.getByText("Este link foi cancelado pelo organizador."),
  ).toBeVisible();
  await participant.context.close();
  await organizer.context.close();
});

test("the group's Pix key gives a Pix code in Arrecadar and on the participant's card", async ({ browser }) => {
  // Arrecadar on the demo (data only on this device), so registering the key touches no shared fixture server.
  const demo = "http://127.0.0.1:4173";
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await mockCaixa(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: demo,
  });
  const page = await context.newPage();
  await page.goto(`${demo}/`);
  await expect(
    page.getByText("Veja como funciona: os dados são de exemplo."),
  ).toBeVisible();
  await page.goto(`${demo}/#/boloes/d0000000-0000-4000-8000-000000000011/arrecadar`);
  await page.getByRole("button", { name: "Preparar cota" }).click();
  await page.getByRole("dialog").getByRole("button", {
    name: "Salvar neste aparelho",
  }).click();
  await page.getByRole("button", { name: "Cadastrar chave Pix do grupo" })
    .click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Tipo de chave").selectOption("email");
  await form.getByLabel("Chave Pix").fill("Chave@Exemplo.com");
  await form.getByLabel("Nome de quem recebe").fill("Ana Cláudia");
  await form.getByLabel("Cidade").fill("Niterói");
  await form.getByRole("button", { name: "Salvar neste aparelho" }).click();
  await page.getByRole("button", { name: "Pix da cota" }).click();
  const panel = page.getByRole("dialog", { name: "Pix da cota" });
  const code = panel.getByText(/^000201/);
  await expect(code).toHaveText(
    /^000201.+0117chave@exemplo\.com.+540535\.00.+5911Ana Claudia6007Niteroi.+6304[0-9A-F]{4}$/,
  );
  await expect(panel.getByRole("img", { name: "QR code do Pix" }))
    .toBeVisible();
  await panel.getByRole("button", { name: "Copiar código Pix" }).click();
  await expect(panel.getByRole("button", { name: "Código copiado" }))
    .toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await code.textContent(),
  );
  await context.close();

  const server = { token: "tok_Pix0-card_123", name: "Camila", revoked: false };
  const participant = await openCard(
    browser,
    `${origin}/#/p/${server.token}`,
    server,
    {
      group: {
        pix: {
          key: "chave@exemplo.com",
          keyType: "email",
          name: "Ana Claudia",
          city: "Niteroi",
        },
      },
      pool: {
        status: "draft",
        quota: { units: 100, dueCents: "6000", paidCents: "2000", paid: false },
        registration: null,
      },
    },
  );
  const pay = participant.page.getByRole("region", { name: "Pagar sua cota" });
  await expect(pay).toContainText("R$ 40,00");
  await expect(pay.getByText(/^000201/)).toHaveText(/540540\.00.+6304[0-9A-F]{4}$/);
  await expect(pay.getByRole("button", { name: "Copiar código Pix" }))
    .toBeVisible();
  await expect(pay).toContainText(
    "Pague no seu banco; o organizador confirma quando o dinheiro cair.",
  );
  await participant.context.close();
});

test("after the draw the card opens with the result and the games with most hits first", async ({ browser }) => {
  const server = { token: "tok_Draw-card_123", name: "Camila", revoked: false };
  // Plan order with hits: 0, 2, 4, 3, 0, 1, 0, 0 for the draw 07 18 26 33 49 54.
  const games = [
    [2, 9, 15, 28, 44, 51],
    [3, 18, 27, 39, 49, 56],
    [7, 18, 26, 33, 41, 58],
    [1, 7, 26, 31, 45, 54],
    [5, 13, 22, 37, 46, 59],
    [10, 21, 33, 40, 52, 60],
    [6, 17, 24, 36, 43, 55],
    [8, 19, 29, 34, 47, 57],
  ].map((numbers) => ({ numbers, registered: true }));
  const cards = (page: Page) =>
    page.locator(".card-grid > .ui-card").evaluateAll((all) =>
      all.map((card) => card.getAttribute("aria-label"))
    );
  const drawn = await openCard(
    browser,
    `${origin}/#/p/${server.token}`,
    server,
    {
      pool: {
        status: "settled",
        games,
        result: {
          drawnNumbers: [7, 18, 26, 33, 49, 54],
          prizeCalculatedCents: "0",
          prizeConfirmedCents: null,
        },
        share: {
          rightCents: null,
          receivedCents: "0",
          pendingCents: null,
          paidByName: null,
          refundRightCents: null,
          refundedCents: "0",
        },
      },
    },
  );
  await expect(drawn.page.getByText("Suas cotas", { exact: true }))
    .toBeVisible();
  expect(await cards(drawn.page)).toEqual([
    "Resultado",
    "Sua parte",
    "Suas cotas",
    "Jogos",
    "Registro",
  ]);
  const list = drawn.page.getByRole("region", { name: "Jogos" }).locator(
    ".pool-game",
  );
  const best = [
    /^0718.*4 acertos$/,
    /^0107.*3 acertos$/,
    /^0318.*2 acertos$/,
    /^1021.*1 acerto$/,
    /^0209.*0 acertos$/,
    /^0513.*0 acertos$/,
  ];
  await expect(list).toHaveText(best);
  await drawn.page.getByRole("button", { name: "Ver os 8 jogos" }).click();
  await expect(list).toHaveText([
    ...best,
    /^0617.*0 acertos$/,
    /^0819.*0 acertos$/,
  ]);
  await drawn.page.getByRole("button", { name: "Mostrar menos" }).click();
  await expect(list).toHaveText(best);
  await drawn.context.close();

  // The 4-hit game was not read from the registered receipt: it gets no hits, no prize and goes last.
  const unchecked = await openCard(
    browser,
    `${origin}/#/p/${server.token}`,
    server,
    {
      pool: {
        status: "registered",
        games: games.map((game, index) =>
          index === 2 ? { ...game, registered: false } : game
        ),
        result: {
          drawnNumbers: [7, 18, 26, 33, 49, 54],
          prizeCalculatedCents: "0",
          prizeConfirmedCents: null,
        },
      },
    },
  );
  const result = unchecked.page.getByRole("region", { name: "Resultado" });
  await expect(result.getByRole("heading")).toHaveText("Não foi dessa vez.");
  await expect(result).toContainText("Melhor jogo: 3 acertos");
  await expect(result).toContainText(
    "1 jogo ainda não foi conferido com o bilhete.",
  );
  await unchecked.page.getByRole("button", { name: "Ver os 8 jogos" }).click();
  await expect(
    unchecked.page.getByRole("region", { name: "Jogos" }).locator(".pool-game")
      .last(),
  ).toHaveText(/^0718.*Ainda não conferido$/);
  await unchecked.context.close();

  const waiting = await openCard(
    browser,
    `${origin}/#/p/${server.token}`,
    server,
    { pool: { games } },
  );
  await expect(waiting.page.getByText("Suas cotas", { exact: true }))
    .toBeVisible();
  expect(await cards(waiting.page)).toEqual([
    "Suas cotas",
    "Jogos",
    "Registro",
    "Resultado",
  ]);
  await expect(waiting.page.getByRole("button", { name: /^Ver os/ }))
    .toHaveCount(0);
  await waiting.context.close();
});

test("the welcome band closes and stays closed on this device", async ({ page, context }) => {
  await mockCaixa(context);
  await page.goto("/#/p/demo");
  const band = page.getByRole("complementary", { name: "Boas-vindas" });
  await expect(band).toContainText("Seu cartão do bolão");
  await expect(band).toContainText("Aqui ficam sua cota");
  await band.getByRole("button", { name: "Fechar aviso" }).click();
  await expect(band).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Cartão de exemplo")).toBeVisible();
  await expect(band).toHaveCount(0);
});

test("a card with a PIN asks for it, opens with the right one and lets the person change it", async ({ browser }) => {
  const server = {
    token: "tok_Pin0-link_123",
    pin: "1234",
    changes: [] as unknown[],
  };
  const context = await browser.newContext();
  await mockCaixa(context);
  const page = await context.newPage();
  await page.route("**/v1/participant_card", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    const { token, pin } = route.request().postDataJSON();
    if (token !== server.token) return reply(route, 404, { code: "link_unknown" });
    if (!pin) {
      return reply(route, 401, {
        code: "pin_required",
        message: "Este cartão tem PIN.",
      });
    }
    if (pin !== server.pin) {
      return reply(route, 401, {
        code: "pin_wrong",
        message: "PIN errado.",
        attemptsLeft: 4,
      });
    }
    return reply(route, 200, {
      version: 1,
      generatedAt: "2026-10-11T15:00:00.000Z",
      group: { name: "Grupo de teste", pix: null },
      person: { id: "p-1", name: "Marina" },
      pools: [{
        id: "pool-mega",
        title: "Mega entre amigos",
        modality: "mega-sena",
        contest: 2930,
        drawAt: "2026-10-10T23:00:00.000Z",
        status: "registered",
        participationMode: "internal",
        quota: { units: 100, dueCents: "6000", paidCents: "6000", paid: true },
        games: [{ numbers: [4, 15, 17, 26, 40, 55], registered: true }],
        registration: { status: "registered", ticketHolderName: "Rafael" },
        result: null,
        share: null,
        closed: false,
      }],
      pinSet: true,
    });
  });
  await page.route("**/v1/participant_pin", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    const body = route.request().postDataJSON();
    server.changes.push(body);
    server.pin = body.pin;
    return reply(route, 200, { pinSet: true });
  });

  await page.goto(`${origin}/#/p/${server.token}`);
  await expect(page.getByRole("heading", { name: "Este cartão tem PIN" }))
    .toBeVisible();
  await expect(page.getByText("Esqueceu? Peça um link novo")).toBeVisible();
  await page.getByLabel("PIN de 4 números").fill("0000");
  await page.getByRole("button", { name: "Abrir" }).click();
  await expect(page.getByText("PIN errado. Restam 4 tentativas.")).toBeVisible();
  await page.getByLabel("PIN de 4 números").fill("1234");
  await page.getByRole("button", { name: "Abrir" }).click();
  await expect(page.getByText("Suas cotas", { exact: true })).toBeVisible();
  await expect(page.getByText("Seu cartão está protegido com PIN."))
    .toBeVisible();

  // Changing the PIN asks for the current one, even on the device that keeps it to open the card.
  await page.getByRole("button", { name: "Trocar PIN" }).click();
  await page.getByLabel("PIN atual").fill("1234");
  await page.getByLabel("Novo PIN", { exact: true }).fill("5678");
  await page.getByLabel("Repita o PIN").fill("5678");
  await page.getByRole("button", { name: "Salvar PIN" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Seu cartão está protegido com PIN."))
    .toBeVisible();
  expect(server.changes).toEqual([
    { token: server.token, pin: "5678", currentPin: "1234" },
  ]);

  // The new PIN stays on this device: the card opens again without the gate.
  await page.reload();
  await expect(page.getByText("Suas cotas", { exact: true })).toBeVisible();
  await context.close();
});

test("the person answers from the card: in, then paid with the proof, and the answer stays after a reload", async ({ browser }) => {
  const organizer = await sendLink(browser);
  // An invitation: a draft pool of the group where the person has no quota yet.
  const invitation = {
    status: "draft",
    quota: null,
    responseOpen: true,
    response: null as unknown,
    registration: null,
    games: [],
  };
  const participant = await openCard(browser, organizer.link, organizer.server, { pool: invitation });
  const { page, context } = participant;
  const answers: Record<string, unknown>[] = [];
  let proofMetadata: Record<string, unknown> | null = null;
  let proofFileName = "";
  await page.route("**/v1/participant_respond", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    if (route.request().headers().authorization) {
      return reply(route, 400, { code: "unexpected_authorization" });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    answers.push(body);
    const createdAt = "2026-10-16T17:02:00.000Z";
    invitation.response = { kind: body.kind, amountCents: body.amountCents ?? null, proofSent: false, at: createdAt };
    return reply(route, 200, {
      response: {
        id: "50900000-0000-4000-8000-000000000001",
        poolId: body.poolId,
        personId: "p-1",
        linkId: "50800000-0000-4000-8000-000000000001",
        kind: body.kind,
        amountCents: body.amountCents ?? null,
        proofId: null,
        createdAt,
      },
    });
  });
  await page.route("**/v1/participant_proof", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    const raw = route.request().postDataBuffer()?.toString("latin1") ?? "";
    proofMetadata = JSON.parse(raw.match(/name="metadata"\r\n\r\n([\s\S]*?)\r\n--/)![1]!);
    proofFileName = raw.match(/name="original"; filename="([^"]+)"/)?.[1] ?? "";
    const createdAt = "2026-10-16T17:05:00.000Z";
    invitation.response = { kind: "paid", amountCents: proofMetadata!.amountCents, proofSent: true, at: createdAt };
    return reply(route, 200, {
      response: {
        id: "50900000-0000-4000-8000-000000000002",
        poolId: proofMetadata!.poolId,
        personId: "p-1",
        linkId: "50800000-0000-4000-8000-000000000001",
        kind: "paid",
        amountCents: proofMetadata!.amountCents,
        proofId: "50700000-0000-4000-8000-000000000001",
        createdAt,
      },
    });
  });

  await expect(page.getByText("Vai entrar nesta rodada?")).toBeVisible();
  await expect(page.getByText("Suas cotas", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Estou dentro" }).click();
  await expect(page.getByText("Você disse que está dentro")).toBeVisible();
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ token: organizer.server.token, poolId: "pool-mega", kind: "in" });
  expect(answers[0]!.amountCents).toBeUndefined();
  expect(answers[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

  // "Já paguei" sends the amount and the file together; the card shows the Pix as told, not as confirmed.
  await page.getByRole("button", { name: "Já paguei" }).click();
  await page.getByLabel("Valor pago").fill("60,00");
  await page.locator('input[type="file"]').setInputFiles({
    name: "pix.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]),
  });
  await expect(page.getByText("pix.png")).toBeVisible();
  await page.getByRole("button", { name: "Avisar que paguei" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Você avisou um Pix de")).toBeVisible();
  await expect(page.getByText("R$ 60,00", { exact: true })).toBeVisible();
  await expect(page.getByText("O tesoureiro confirma quando o dinheiro cair.")).toBeVisible();
  expect(proofMetadata).toMatchObject({ token: organizer.server.token, poolId: "pool-mega", amountCents: "6000" });
  expect(proofFileName).toBe("pix.png");
  expect(answers).toHaveLength(1);

  // The server keeps the answer: the card reopened shows it, read from the card, not from this device.
  await page.reload();
  await expect(page.getByText("Você avisou um Pix de")).toBeVisible();
  await expect(page.getByText("Pix avisado")).toBeVisible();
  await context.close();
  await organizer.context.close();
});

test("the treasurer sees the card answers in Arrecadar: the reminder is noted and a Pix told shows up with its proof", async ({ browser, request }) => {
  // The financial flows leave the fixture's person paid; this one starts from the seeded state (a partial proposal waiting).
  await request.post("http://127.0.0.1:4190/__test/reset");
  const organizer = await sendLink(browser);
  const { page, server } = organizer;
  const personId = server.link!.personId;
  const row = page.locator(".pool-person").first();
  await expect(row.getByText("Ainda não respondeu", { exact: true })).toBeVisible();

  // Resending the link counts as a reminder, noted on the server and shown in the row.
  await row.getByRole("button", { name: "Copiar" }).click();
  await expect(row.getByText("Ainda não respondeu · lembrado 16/10, 10:30")).toBeVisible();
  expect(server.reminders).toHaveLength(1);
  expect(server.reminders[0]).toMatchObject({ poolId, personId });

  // The person told a Pix through the card, with a proof, while an earlier partial proposal still waits in the review:
  // the row says what the card said and opens the proof; the money is still sorted in the review.
  server.answers = [{
    id: "50900000-0000-4000-8000-000000000001",
    poolId,
    personId,
    linkId: server.link!.id,
    kind: "paid",
    amountCents: "6000",
    proofId: "50700000-0000-4000-8000-000000000001",
    createdAt: "2026-10-16T17:05:00.000Z",
    proof: { id: "50700000-0000-4000-8000-000000000001", sha256: "ab".repeat(32), mimeType: "image/png", byteSize: 16 },
  }];
  await page.reload();
  await expect(row.getByText("Pix avisado")).toBeVisible();
  await expect(row.getByText("Mandou R$ 60,00 com comprovante · 16/10, 14:05")).toBeVisible();
  await expect(row.getByRole("button", { name: "Ver comprovante" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Ver na Revisão" })).toBeVisible();
  if (process.env.SHOTS) {
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 1200 });
      // The layout switch fades the screen in; wait for it before the shot.
      await page.waitForTimeout(800);
      await page.screenshot({ path: `.tmp/cartao/arrecadar-${width}.png`, fullPage: true });
    }
  }
  await organizer.context.close();
});

test("in Arrecadar, who said 'dentro' joins with one tap, who said 'fora' stays aside, and a Pix told becomes a proposal to check", async ({ browser, request }) => {
  await request.post("http://127.0.0.1:4190/__test/reset");
  const secondPoolId = "50400000-0000-4000-8000-000000000002";
  const { page, context, server } = await organizerPage(browser);
  // The fixture's person has a quota in the first pool only; in the second she answered through her card.
  const answer = (kind: string, at: string, amountCents: string | null = null) => ({
    id: `50900000-0000-4000-8000-00000000000${server.answers.length + 1}`,
    poolId: secondPoolId,
    personId: "50300000-0000-4000-8000-000000000001",
    linkId: "50800000-0000-4000-8000-000000000001",
    kind,
    amountCents,
    proofId: null,
    createdAt: at,
    proof: null,
  });
  server.answers = [answer("out", "2026-10-15T20:00:00.000Z")];
  await page.goto(`${origin}/#/boloes/${secondPoolId}/arrecadar`);
  await expect(page.getByText(/Disse que desta vez está fora · 15\/10, 17:00/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrou" })).toHaveCount(0);

  // The latest answer stands: now she is in, so the call offers "Entrou" with one quota, prefilled.
  server.answers = [...server.answers, answer("in", "2026-10-16T12:00:00.000Z")];
  await page.reload();
  await expect(page.getByText("Responderam pelo cartão ou estavam na rodada passada.")).toBeVisible();
  const call = page.locator(".pool-call-person").first();
  await expect(call.getByText(/1 cota · Disse que está dentro · 16\/10, 09:00/)).toBeVisible();
  await expect(page.getByText(/ainda não respond/)).toHaveCount(0);
  await call.getByRole("button", { name: "Entrou" }).click();
  await expect(page.getByText(/entrou com 1 cota\./)).toBeVisible();
  const row = page.locator(".pool-person").first();
  await expect(row.getByText("Dentro", { exact: true })).toBeVisible();
  await expect(row.getByText("Disse que está dentro · 16/10, 09:00")).toBeVisible();
  await expect(page.locator(".pool-call-person")).toHaveCount(0);

  // She tells a Pix of the whole quota: "Conferir" turns it into the usual payment proposal and opens the review.
  server.answers = [...server.answers, answer("paid", "2026-10-16T13:00:00.000Z", "3000")];
  await page.reload();
  await expect(row.getByText("Pix avisado")).toBeVisible();
  await expect(row.getByText("Mandou R$ 30,00 · 16/10, 10:00")).toBeVisible();
  await row.getByRole("button", { name: "Conferir" }).click();
  await expect(page).toHaveURL(/revisao/);
  await expect(page.getByText("Avisado pelo cartão em 16/10, 10:00.")).toBeVisible();
  await page.goto(`${origin}/#/boloes/${secondPoolId}/arrecadar`);
  await expect(row.getByText("Pagamento em conferência")).toBeVisible();
  await expect(row.getByRole("button", { name: "Conferir" })).toHaveCount(0);
  await context.close();
});
