import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { loadCore } from "./load-core.mjs";

const core = await loadCore();
const originals = new Map();
let officialSource = null;

// Browser integration fixture only. SQL runs the real migrations/RPCs; Auth and
// Storage below are local stubs, not a replacement for real Supabase validation.
const actorId = "50100000-0000-4000-8000-000000000001";
const groupId = "50200000-0000-4000-8000-000000000001";
const personId = "50300000-0000-4000-8000-000000000001";
const poolId = "50400000-0000-4000-8000-000000000001";
const secondPoolId = "50400000-0000-4000-8000-000000000002";
const quotaId = "50500000-0000-4000-8000-000000000001";
const proposalId = "50600000-0000-4000-8000-000000000001";
let db;
let serial = Promise.resolve();

async function rpc(name, parameters = [], role = "authenticated") {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({
        sub: actorId,
        role,
        aud: "authenticated",
        session_id: "50700000-0000-4000-8000-000000000001",
        is_anonymous: false,
        app_metadata: {},
      }),
    ]);
    await tx.exec(`set local role ${role}`);
    const placeholders = parameters.map((parameter, index) =>
      `$${index + 1}${
        parameter !== null && typeof parameter === "object" ? "::jsonb" : ""
      }`
    ).join(",");
    const result = await tx.query(
      `select public.${name}(${placeholders}) as response`,
      parameters.map((parameter) =>
        parameter !== null && typeof parameter === "object"
          ? JSON.stringify(parameter)
          : parameter
      ),
    );
    return result.rows[0].response;
  });
}

async function reset() {
  if (db) await db.close();
  db = new PGlite();
  originals.clear();
  officialSource = null;
  await db.exec(`
    create role authenticated nologin;
    create role anon nologin;
    create role service_role nologin;
    create schema auth;
    create schema storage;
    create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb, '{}'::jsonb) $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
    insert into auth.users(id,email) values ('${actorId}','organizer@example.test');
  `);
  for (
    const migration
      of (await readdir(new URL("../../supabase/migrations/", import.meta.url)))
        .filter((name) => name.endsWith(".sql")).sort()
  ) {
    await db.exec(
      await readFile(
        new URL(`../../supabase/migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const drafts = [
    [groupId, "group", {
      name: "Grupo financeiro de teste",
      statute:
        "Pagamento integral no prazo e aceite registrado são necessários para confirmar a participação.",
    }],
    [personId, "person", {
      name: "Pessoa financeira",
      nickname: "",
      adultDeclared: true,
    }],
    [poolId, "pool", {
      title: "Mega financeira",
      lotteryId: "mega-sena",
      contestNumber: null,
      deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
      quotaPriceCents: "6000",
      participationMode: "internal",
      status: "draft",
    }],
    [secondPoolId, "pool", {
      title: "Quina financeira",
      lotteryId: "quina",
      contestNumber: null,
      deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
      quotaPriceCents: "3000",
      participationMode: "internal",
      status: "draft",
    }],
    [quotaId, "quota", { poolId, personId, units: 100 }],
    [proposalId, "payment-proposal", {
      poolId,
      personId,
      amountCents: "3000",
      note: "Primeira transferência parcial.",
      status: "pending",
    }],
  ];
  for (const [entityId, kind, data] of drafts) {
    const receipt = await rpc("sync_push", [{
      apiVersion: "v1",
      idempotencyKey: randomUUID(),
      groupId,
      entityId,
      kind,
      expectedVersion: 0,
      data,
      createdAt: new Date().toISOString(),
    }]);
    if (receipt.status !== "accepted") {
      throw new Error(`Fixture draft rejected: ${receipt.message}`);
    }
  }
}

async function handle(request, response) {
  const url = new URL(request.url, "http://127.0.0.1:4190");
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:4182");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, apikey, content-type, x-client-info",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === "/__test/health") {
    response.end("{}");
    return;
  }
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    await reset();
    response.end(
      JSON.stringify({
        actorId,
        groupId,
        personId,
        poolId,
        secondPoolId,
        quotaId,
        proposalId,
      }),
    );
    return;
  }
  if (url.pathname === "/__test/source" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    officialSource = JSON.parse(Buffer.concat(chunks).toString());
    response.end("{}");
    return;
  }
  if (!request.headers.authorization?.startsWith("Bearer ")) {
    response.writeHead(401).end("{}");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const route = url.pathname.split("/").at(-1);
  if (route === "evidence_upload") {
    const form = await new Request("http://127.0.0.1/upload", {
      method: "POST",
      headers: { "Content-Type": request.headers["content-type"] },
      body: Buffer.concat(chunks),
    }).formData();
    const metadata = core.validateEvidenceUploadMetadata(
      JSON.parse(form.get("metadata")),
    );
    const bytes = new Uint8Array(await form.get("original").arrayBuffer());
    await core.validateEvidenceBytes(bytes, metadata);
    const context = await rpc("evidence_upload_context", [metadata]);
    if (!originals.has(context.storagePath)) {
      await db.query(
        "insert into storage.objects(bucket_id,name) values ('evidence',$1)",
        [context.storagePath],
      );
      originals.set(context.storagePath, bytes);
    }
    if (
      await core.hashEvidenceBytes(originals.get(context.storagePath)) !==
        metadata.sha256
    ) throw new Error("Originals cannot be replaced.");
    const result = await rpc(
      "evidence_seal",
      [metadata, actorId],
      "service_role",
    );
    response.end(JSON.stringify(core.validateEvidenceMetadata(result)));
    return;
  }
  if (route === "evidence_download") {
    const evidence = await rpc("evidence_status", [url.searchParams.get("id")]);
    if (!evidence) {
      response.writeHead(404).end("{}");
      return;
    }
    response.setHeader("Content-Type", evidence.mimeType);
    response.end(Buffer.from(originals.get(evidence.storagePath)));
    return;
  }
  const value = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : null;
  let result;
  switch (route) {
    case "groups":
      result = await rpc("sync_groups");
      break;
    case "sync_push": {
      const receipts = [];
      for (const operation of value.operations) {
        receipts.push(await rpc("sync_push", [operation]));
      }
      result = { receipts };
      break;
    }
    case "sync_pull":
      result = await rpc("sync_pull", [value.groupId, value.cursor]);
      break;
    case "finance_pull":
      result = await rpc("finance_pull", [value.groupId]);
      break;
    case "plan_pull":
      result = await rpc("plan_pull", [value.groupId]);
      break;
    case "registration_pull":
      result = await rpc("registration_pull", [value.groupId]);
      break;
    case "results_pull":
      result = await rpc("results_pull", [value.groupId]);
      break;
    case "settlement_pull":
      result = await rpc("settlement_pull", [value.groupId]);
      break;
    case "evidence_status":
      result = await rpc("evidence_status", [url.searchParams.get("id")]);
      break;
    case "results_collect": {
      const context = await rpc("result_collection_context", [
        value.groupId,
        value.poolId,
      ]);
      if (!officialSource || officialSource.fail) {
        await rpc("result_collection_attempt", [
          value.groupId,
          value.poolId,
          "http-error",
          "http_503",
          null,
          null,
        ], "service_role");
        response.writeHead(503).end(
          JSON.stringify({
            message:
              "Fonte oficial indisponível na simulação; último resultado válido preservado.",
          }),
        );
        return;
      }
      const parsed = core.parseCaixaResult({
        lotteryId: context.lotteryId,
        contestNumber: context.contestNumber,
        sourceUrl: `${
          core.RESULT_SOURCE_URLS[context.lotteryId]
        }/${context.contestNumber}`,
        rawText: officialSource.rawText,
        collectedAt: new Date().toISOString(),
      });
      result = await rpc("result_collect_seal", [
        value.groupId,
        value.poolId,
        actorId,
        parsed,
      ], "service_role");
      await rpc("result_collection_attempt", [
        value.groupId,
        value.poolId,
        "success",
        "",
        parsed.sourceUrl,
        parsed.rawText,
      ], "service_role");
      core.validateResultSnapshot(result);
      break;
    }
    case "review_decide":
      result = await rpc(
        ["plan_apply", "pool_lock"].includes(value.command.action.type)
          ? "planning_decide"
          : value.command.action.type === "registration_confirm"
          ? "registration_decide"
          : ["result_manual", "result_resolve", "calendar_confirm"].includes(
              value.command.action.type,
            )
          ? "result_decide"
          : "review_decide",
        [value.command],
      );
      break;
    case "command_status":
      result = await rpc("command_status", [
        url.searchParams.get("idempotencyKey"),
      ]);
      break;
    case "finance_command_status":
      result = await rpc("finance_command_status", [
        url.searchParams.get("idempotencyKey"),
      ]);
      break;
    case "plan_command_status":
      result = await rpc("plan_command_status", [
        url.searchParams.get("idempotencyKey"),
      ]);
      break;
    case "registration_command_status":
      result = await rpc("registration_command_status", [
        url.searchParams.get("idempotencyKey"),
      ]);
      break;
    case "result_command_status":
      result = await rpc("result_command_status", [
        url.searchParams.get("idempotencyKey"),
      ]);
      break;
    default:
      response.writeHead(404).end("{}");
      return;
  }
  if (result === null) response.writeHead(404);
  response.end(JSON.stringify(result));
}

try {
  await reset();
} catch (error) {
  console.error("Financial browser fixture initialization:", error.message);
  process.exit(1);
}
createServer((request, response) => {
  serial = serial.then(() => handle(request, response)).catch((error) => {
    console.error("Financial browser fixture:", error.message);
    if (!response.headersSent) {
      response.writeHead(error.code === "42501" ? 403 : 500);
    }
    response.end(JSON.stringify({ message: error.message }));
  });
}).listen(
  4190,
  "127.0.0.1",
  () =>
    console.log(
      "Financial SQL browser fixture ready on localhost:4190 (Auth/Storage stubs).",
    ),
);
