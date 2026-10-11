import { expect, test } from "@playwright/test";
import type { Browser, Route } from "@playwright/test";

// The Node fixture on :4190 does not serve the participant routes (the real `api` runs in Deno,
// covered by `npm run test:api`), so the four routes are simulated here with `page.route`.
const origin = "http://127.0.0.1:4182";
const actorId = "50100000-0000-4000-8000-000000000001";
const poolId = "50400000-0000-4000-8000-000000000001";
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

/** The organizer sends the personal link in Arrecadar; returns the copied message's link and name. */
async function sendLink(browser: Browser) {
  const server = { token: "tok_Nov0-link_123", name: "", revoked: false };
  const context = await browser.newContext();
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
    reply(route, 200, { links: [] }));
  await page.route("**/v1/participant_link", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    return reply(route, 201, {
      id: "50800000-0000-4000-8000-000000000001",
      personId: route.request().postDataJSON().personId,
      createdAt: "2026-10-11T15:00:00.000Z",
      token: server.token,
    });
  });
  await page.route("**/v1/participant_link_revoke", (route) => {
    if (route.request().method() !== "POST") return reply(route, 204, {});
    server.revoked = true;
    return reply(route, 200, {
      id: "50800000-0000-4000-8000-000000000001",
      revokedAt: "2026-10-11T16:00:00.000Z",
    });
  });
  await page.goto(`${origin}/#/boloes/${poolId}/arrecadar`);
  const send = page.getByRole("button", { name: "Enviar link pessoal" })
    .first();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText(/Link enviado em/)).toBeVisible();
  const message = await page.evaluate(() => navigator.clipboard.readText());
  server.name = message.match(/^Oi (.+)! Seu cartão/)![1];
  const link = message.match(/https?:\/\/\S+#\/p\/[\w-]+/)![0];
  return { page, context, link, server };
}

/** The participant's browser: no login, the card route answers like the server would. */
async function openCard(
  browser: Browser,
  link: string,
  server: { token: string; name: string; revoked: boolean },
) {
  const context = await browser.newContext();
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
      group: { name: "Grupo de teste" },
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
        games: [{ numbers: [4, 15, 17, 26, 40, 55] }],
        registration: { status: "registered", ticketHolderName: "Rafael" },
        result: null,
        share: null,
        closed: false,
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
