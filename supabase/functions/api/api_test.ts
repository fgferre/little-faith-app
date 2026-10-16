import { createApi } from './app.ts';
import { createResultsCollector } from './collector.ts';
import { evidenceMime, hashBytes, uploadOriginal, EvidenceFailure } from './evidence.ts';
import { collectOfficialResult, ResultCollectionFailure } from './results.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFinancialReceipt, isFinancialSnapshot, isHumanSession, isPlanningReceipt, isPlanningSnapshot, isSettlementReceipt, isSettlementSnapshot, parseFinancialReview, parsePlanningReview, parsePush, parseSettlementReview } from './contract.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const id = '11111111-1111-4111-8111-111111111111';
const operation = {
  apiVersion: 'v1', idempotencyKey: id, groupId: id, entityId: id, kind: 'group', expectedVersion: 0,
  createdAt: '2026-10-07T12:00:00.000Z', data: { name: 'Teste', statute: '' },
};

Deno.test('original bytes require matching hash/type and remain bound to immutable private metadata', async () => {
  const bytes = new TextEncoder().encode('%PDF-original privado');
  const metadata = { id, groupId: id, poolId: id, sha256: await hashBytes(bytes), mimeType: 'application/pdf' as const, byteSize: bytes.length, originalName: 'Comprovante.pdf' };
  const evidence = { ...metadata, storagePath: `${id}/${id}.pdf`, uploadedByUserId: id, uploadedAt: '2026-10-08T18:00:00.000Z' };
  let uploaded = 0; let sealed = 0; let existing: unknown = null; let wrongActor = false;
  const human = { rpc: () => Promise.resolve({ data: { storagePath: evidence.storagePath, evidence: existing }, error: null }),
    storage: { from: () => ({ upload: (_path: string, _body: unknown, options: { upsert: boolean }) => {
      assert(options.upsert === false, 'original is never overwritten'); uploaded++; return Promise.resolve({ error: null });
    }, download: () => Promise.resolve({ data: new Blob([bytes]), error: null }) }) } } as unknown as SupabaseClient;
  const server = { rpc: (name: string, parameters: { p_metadata: unknown; p_actor_id: string }) => {
    assert(name === 'evidence_seal' && parameters.p_actor_id === id, 'server seal keeps the verified human actor'); sealed++;
    return Promise.resolve({ data: wrongActor ? { ...evidence, uploadedByUserId: '22222222-2222-4222-8222-222222222222' } : evidence, error: null });
  } } as unknown as SupabaseClient;
  assert(evidenceMime(bytes) === 'application/pdf', 'magic signature known');
  const accepted = await uploadOriginal(human, server, id, metadata, new Blob([bytes]));
  assert(accepted.sha256 === metadata.sha256 && uploaded === 1 && sealed === 1, 'incoming and stored originals independently hashed');
  existing = evidence;
  assert((await uploadOriginal(human, server, id, metadata, new Blob([bytes]))).uploadedAt === evidence.uploadedAt && uploaded === 1, 'lost-response retry reuses immutable metadata');
  for (const invalid of [{ ...metadata, sha256: 'a'.repeat(64) }, { ...metadata, mimeType: 'image/png' as const }, { ...metadata, byteSize: bytes.length + 1 }]) {
    try { await uploadOriginal(human, server, id, invalid, new Blob([bytes])); throw new Error('Bad original accepted.'); }
    catch (error) { assert(error instanceof EvidenceFailure && error.status === 400, 'bad original rejected before Storage'); }
  }
  existing = null; wrongActor = true;
  try { await uploadOriginal(human, server, id, metadata, new Blob([bytes])); throw new Error('Foreign seal accepted.'); }
  catch (error) { assert(error instanceof EvidenceFailure && error.status === 503, 'unbound backend seal fails closed'); }
});

Deno.test('official collection preserves raw lexemes and never forwards credentials or follows redirects', async () => {
  const rawText = ' {"numero":42,"tipoJogo":"MEGA_SENA","dataApuracao":"08/10/2026","listaDezenas":["01","02","03","04","05","06"],"listaRateioPremio":[{"faixa":1,"numeroDeGanhadores":null,"valorPremio":64627.76}]}\r\n';
  const calls: { name: string; data: Record<string, unknown> }[] = [];
  const server = { rpc: (name: string, data: Record<string, unknown>) => { calls.push({ name, data }); return Promise.resolve({ data: { ok: true }, error: null }); } } as unknown as SupabaseClient;
  const originalFetch = globalThis.fetch; let invalid = false; let requested = 0;
  globalThis.fetch = (input, init) => {
    requested++; assert(String(input) === 'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena/42', 'exact allowlisted URL');
    assert(init?.credentials === 'omit' && init.redirect === 'error' && new Headers(init.headers).get('Authorization') === null, 'source gets no token');
    return Promise.resolve(new Response(invalid ? '{broken}' : rawText));
  };
  try {
    const context = { groupId: id, poolId: id, lotteryId: 'mega-sena' as const, contestNumber: 42 };
    await collectOfficialResult(server, id, context);
    const parsed = calls.find(call => call.name === 'result_collect_seal')?.data.p_parsed as { rawText: string; sha256: string; payouts: { prizeCents: string | null }[] };
    assert(parsed.rawText === rawText && parsed.sha256 === await hashBytes(new TextEncoder().encode(rawText)), 'exact source whitespace and hash preserved');
    assert(parsed.payouts[0]?.prizeCents === '6462776' && parsed.payouts[1]?.prizeCents === null, 'money exact and missing payouts unknown');
    invalid = true;
    try { await collectOfficialResult(server, id, context); throw new Error('Malformed source accepted.'); } catch (error) { assert(error instanceof ResultCollectionFailure, 'bad source reports collection failure'); }
    assert(calls.filter(call => call.name === 'result_collect_seal').length === 1 && calls.at(-1)?.data.p_raw_text === '{broken}', 'failed original audit preserves last valid version');
    const count = requested;
    try { await collectOfficialResult(server, id, { ...context, contestNumber: -1 }); throw new Error('Invalid contest accepted.'); } catch (error) { assert(error instanceof ResultCollectionFailure, 'invalid scope rejected'); }
    assert(requested === count, 'invalid backend context cannot construct a public request');
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('scheduler entry point exposes only the bounded private collection capability', async () => {
  const secret = 'fixture-private-collector-capability-32chars';
  const collector = createResultsCollector({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'public', serviceRoleKey: 'server-fixture', resultsJobSecret: secret, allowedOrigins: [] });
  assert((await collector(new Request('https://fixture.invalid/results-collector/v1/review_decide', { method: 'POST' }))).status === 404, 'no human actions exposed by JWT-disabled collector');
  assert((await collector(new Request('https://fixture.invalid/results-collector/v1/run', { method: 'POST', headers: { Authorization: 'Bearer other' }, body: '{}' }))).status === 403, 'capability required');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert(new URL(request.url).pathname === '/rest/v1/rpc/result_jobs_due', 'collector only asks for due jobs');
    assert(request.headers.get('Authorization') === 'Bearer server-fixture', 'privileged key stays on server RPC');
    assert((await request.json()).p_limit === 2, 'batch bound preserved'); return Response.json([]);
  };
  try {
    const response = await collector(new Request('https://fixture.invalid/results-collector/v1/run', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{"limit":2}' }));
    assert(response.status === 200 && JSON.stringify(await response.json()) === '{"outcomes":[]}', 'explicit private trigger; no schedule installed');
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('registration/result HTTP families preserve decisions and recover private evidence without a public URL', async () => {
  const token = `fixture.${btoa(JSON.stringify({ sub: id, role: 'authenticated', session_id: id, app_metadata: {} }))}.fixture`;
  const registration = { groupId: id, groupRevision: 0, manifests: [], evidence: [], reports: [] };
  const results = { groupId: id, groupRevision: 0, results: [], selections: [], calendarVersions: [] };
  const registrationCommand = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0, action: {
    type: 'registration_confirm', poolId: id, poolVersion: 1, manifestId: id, reason: '', items: [{ plannedTicketKey: 'ticket-1', evidenceIds: [id], reason: '',
      observed: { lotteryId: null, contestNumber: null, betNumbers: null, betCostCents: null, feeCents: null, officialQuotaCount: null, officialAssignments: null, registeredAt: null } }] } };
  const resultCommand = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0, action: {
    type: 'result_manual', poolId: id, poolVersion: 1, data: { lotteryId: 'mega-sena', contestNumber: 42, drawDate: null, drawnNumbers: [1,2,3,4,5,6], payouts: null },
    sourceReference: 'Fonte humana', reason: 'Conferência explícita.' } };
  const receipt = (snapshot: unknown) => ({ apiVersion: 'v1', idempotencyKey: id, receiptId: null, groupId: id, status: 'rejected', groupRevision: 0, message: 'Bolão não encontrado.', confirmedAt: null, snapshot });
  const bytes = new TextEncoder().encode('%PDF-private-original');
  const evidence = { id, groupId: id, poolId: id, sha256: await hashBytes(bytes), mimeType: 'application/pdf', byteSize: bytes.length, originalName: 'Privado.pdf', storagePath: `${id}/${id}.pdf`, uploadedByUserId: id, uploadedAt: '2026-10-08T18:00:00.000Z' };
  const calls: { name: string; data: unknown }[] = []; let missing = false; let invalid = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); const path = new URL(request.url).pathname;
    assert(request.headers.get('Authorization') === `Bearer ${token}` && request.headers.get('apikey') === 'public', 'private calls use current human JWT and public project key');
    if (path === '/auth/v1/user') return Response.json({ id, app_metadata: {}, is_anonymous: false });
    if (path.startsWith('/storage/v1/object/')) return new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
    const name = path.replace('/rest/v1/rpc/', ''); const data = await request.json(); calls.push({ name, data });
    if (name === 'registration_pull') return Response.json(invalid ? { ...registration, reports: undefined } : registration);
    if (name === 'results_pull') return Response.json(invalid ? { ...results, results: undefined } : results);
    if (name === 'evidence_status') return Response.json(missing ? null : evidence);
    if (name === 'registration_decide' || name === 'registration_command_status') return Response.json(missing ? null : receipt(registration));
    if (name === 'result_decide' || name === 'result_command_status') return Response.json(missing ? null : receipt(results));
    throw new Error(`Unexpected RPC ${name}`);
  };
  try {
    const app = createApi({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'public', allowedOrigins: [] });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const [family, command, snapshot, rpc] of [['registration', registrationCommand, registration, 'registration_decide'], ['result', resultCommand, results, 'result_decide']] as const) {
      const reviewed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) });
      assert(reviewed.status === 200 && JSON.stringify(calls.at(-1)) === JSON.stringify({ name: rpc, data: { p_command: command } }), 'family route preserves exact command content');
      const recovered = await app.request(`/api/v1/${family}_command_status?idempotencyKey=${id}`, { headers });
      assert(recovered.status === 200 && JSON.stringify(await recovered.json()) === JSON.stringify(receipt(snapshot)), 'original receipt recovery');
    }
    assert((await app.request(`/api/v1/evidence_download?id=${id}`, { headers })).headers.get('Content-Disposition')?.includes('attachment'), 'authenticated bytes downloaded as attachment');
    const downloaded = await app.request(`/api/v1/evidence_download?id=${id}`, { headers });
    assert(new TextDecoder().decode(await downloaded.arrayBuffer()) === new TextDecoder().decode(bytes) && !downloaded.headers.has('Location'), 'private original bytes verified, no public URL');
    assert((await app.request('/api/v1/evidence_upload', { method: 'POST', headers, body: '{}' })).status === 503, 'missing server capability is explicit');
    assert((await app.request('/api/v1/results_collect', { method: 'POST', headers, body: '{}' })).status === 503, 'base API works without collector capability');
    missing = true;
    assert((await app.request(`/api/v1/evidence_status?id=${id}`, { headers })).status === 404, 'absent seal cannot become upload success');
    assert((await app.request(`/api/v1/registration_command_status?idempotencyKey=${id}`, { headers })).status === 404, 'missing report receipt unknown');
    invalid = true;
    for (const path of ['registration_pull', 'results_pull']) assert((await app.request(`/api/v1/${path}`, { method: 'POST', headers, body: JSON.stringify({ groupId: id }) })).status === 503, 'incomplete history fails closed');
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('envelope rejects unsafe versions, extra identity and malformed UUID', () => {
  assert(parsePush({ operations: [operation] })?.length === 1, 'valid envelope');
  assert(parsePush({ operations: [{ ...operation, actorId: id }] }) === null, 'identity is not client controlled');
  assert(parsePush({ operations: [{ ...operation, expectedVersion: 9007199254740992 }] }) === null, 'unsafe version');
  assert(parsePush({ operations: [{ ...operation, groupId: '../other-group' }] }) === null, 'malformed group');
  assert(parsePush({ operations: Array(101).fill(operation) }) === null, 'bounded batch');
});

Deno.test('delegated OAuth, marked agent, anonymous and service credentials fail human gate', () => {
  const claims = { sub: id, role: 'authenticated', session_id: id, app_metadata: {}, is_anonymous: false };
  const user = { id, app_metadata: {}, is_anonymous: false };
  assert(isHumanSession(claims, user), 'verified first-party session');
  assert(!isHumanSession({ ...claims, client_id: id }, user), 'delegated token');
  assert(!isHumanSession({ ...claims, client_id: null }, user), 'unexpected delegated claim');
  assert(!isHumanSession({ ...claims, app_metadata: { actor_type: 'agent' } }, user), 'marked agent token');
  assert(!isHumanSession(claims, { ...user, app_metadata: { actor_type: 'agent' } }), 'latest server user marks agent');
  assert(!isHumanSession({ ...claims, role: 'service_role' }, user), 'service credential');
  assert(!isHumanSession(claims, { ...user, is_anonymous: true }), 'anonymous user');
});

Deno.test('API uses the shared draft validator and preserves original content for idempotency', () => {
  const bet = { ...operation, kind: 'bet', data: {
    poolId: id, lotteryId: 'mega-sena', numbers: [6, 5, 4, 3, 2, 1], authorIds: [],
    catalogVersion: 'caixa-basic-2026-10-07-v1', seed: 'AA'.repeat(32),
    generationAlgorithmVersion: 'chacha20-lexicographic-rank-v1',
  } };
  const parsed = parsePush({ operations: [bet] });
  assert(parsed?.[0] === bet, 'input content remains unchanged for receipt identity');
  assert(parsePush({ operations: [{ ...bet, data: { ...bet.data, catalogVersion: 'old' } }] }) === null, 'catalog enforced');
  assert(parsePush({ operations: [{ ...bet, data: { ...bet.data, generationAlgorithmVersion: null } }] }) === null, 'generated version required');
  assert(parsePush({ operations: [{ ...bet, data: { ...bet.data, seed: null } }] }) === null, 'manual version must be null');
  assert(parsePush({ operations: [{ ...operation, data: { name: 'Teste', statute: 'x'.repeat(12001) } }] }) === null, 'core text limits');
  assert(parsePush({ operations: [{ ...operation, createdAt: '2026-02-30T12:00:00Z' }] }) === null, 'calendar validation');
});

Deno.test('CORS is explicit and preflight skips authentication only', async () => {
  const app = createApi({ supabaseUrl: 'https://example.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] });
  const denied = await app.request('/api/v1/groups', { headers: { Origin: 'https://other.example' } });
  assert(denied.status === 403, 'cross-origin denial');
  assert(!denied.headers.has('Access-Control-Allow-Origin'), 'no wildcard CORS');
  const preflight = await app.request('/api/v1/sync_push', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } });
  assert(preflight.status === 204, 'preflight permitted');
  assert(preflight.headers.get('Access-Control-Allow-Origin') === 'https://app.example', 'exact allowed origin');
  const unsigned = await app.request('/api/v1/groups', { headers: { Origin: 'https://app.example' } });
  assert(unsigned.status === 401, 'CORS does not grant authentication');
});

Deno.test('oversized unauthenticated request is bounded before an Auth call', async () => {
  const app = createApi({ supabaseUrl: 'https://example.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] });
  const response = await app.request('/api/v1/sync_push', {
    method: 'POST', headers: { Origin: 'https://app.example', 'Content-Length': '1048577', 'Content-Type': 'application/json' },
    body: 'x'.repeat(1048577),
  });
  assert(response.status === 413, 'body size bounded');
});

Deno.test('financial review preserves command identity and enforces the real shared validator', () => {
  const command = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0,
    action: { type: 'payment_confirm', proposalId: id, proposalVersion: 1, bankReference: ' Pix-1 ',
      declaredReceivedAt: null, allocations: [{ poolId: id, amountCents: '2500' }] } };
  assert(parseFinancialReview({ command }) === command, 'unmodified idempotency content');
  assert(parseFinancialReview({ command: { ...command, actorId: id } }) === null, 'author comes from authentication');
  assert(parseFinancialReview({ command: { ...command, expectedRevision: -1 } }) === null, 'expected revision required');
  assert(parseFinancialReview({ command: { ...command, action: { ...command.action, allocations: [{ poolId: id, amountCents: '-2500' }] } } }) === null, 'negative allocation is not a reversal');
  assert(parseFinancialReview({ command: { ...command, action: { ...command.action, allocations: [...command.action.allocations, ...command.action.allocations] } } }) === null, 'duplicate pool in one receipt rejected');
  const snapshot = { groupId: id, groupRevision: 0, statutes: [], acceptances: [], payments: [], allocations: [], movements: [], quotas: [], revocations: [] };
  assert(isFinancialSnapshot(snapshot), 'initial complete empty snapshot');
  assert(!isFinancialSnapshot({ ...snapshot, movements: undefined }), 'incomplete financial data rejected');
  assert(!isFinancialReceipt({ apiVersion: 'v1', idempotencyKey: id, groupId: id, status: 'accepted', groupRevision: 0, message: null, confirmedAt: null, snapshot }), 'no fabricated offline confirmation');
});

Deno.test('financial HTTP routes pass the human token and exact command to RPC; invalid confirmations fail closed', async () => {
  // Transport wiring only: this fixture deliberately does not claim real Supabase Auth integration.
  const claims = { sub: id, role: 'authenticated', session_id: id, app_metadata: {}, is_anonymous: false };
  const token = `fixture.${btoa(JSON.stringify(claims))}.fixture`;
  const snapshot = { groupId: id, groupRevision: 0, statutes: [], acceptances: [], payments: [], allocations: [], movements: [], quotas: [], revocations: [] };
  const command = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0,
    action: { type: 'payment_confirm', proposalId: id, proposalVersion: 1, bankReference: ' Pix-1 ', declaredReceivedAt: null, allocations: [] } };
  const receipt = { apiVersion: 'v1', idempotencyKey: id, groupId: id, status: 'rejected', groupRevision: 0,
    message: 'Proposta não encontrada.', confirmedAt: null, snapshot };
  const calls: { name: string; parameters: unknown }[] = [];
  let invalidBackend = false;
  let missingReceipt = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    assert(request.headers.get('Authorization') === `Bearer ${token}`, 'human token propagated unchanged');
    assert(request.headers.get('apikey') === 'test-public-key', 'public project key only');
    if (path === '/auth/v1/user') return Response.json({ id, app_metadata: {}, is_anonymous: false });
    const name = path.replace('/rest/v1/rpc/', '');
    const parameters = await request.json();
    calls.push({ name, parameters });
    if (name === 'finance_pull') return Response.json(invalidBackend ? { ...snapshot, payments: undefined } : snapshot);
    if (name === 'review_decide') return Response.json(invalidBackend ? { ...receipt, status: 'accepted' } : receipt);
    if (name === 'finance_command_status') return Response.json(missingReceipt ? null : receipt);
    throw new Error(`Unexpected mocked RPC: ${name}`);
  };
  try {
    const app = createApi({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] });
    const headers = { Authorization: `Bearer ${token}`, Origin: 'https://app.example', 'Content-Type': 'application/json' };
    const pulled = await app.request('/api/v1/finance_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) });
    assert(pulled.status === 200 && JSON.stringify(await pulled.json()) === JSON.stringify(snapshot), 'complete snapshot returned');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'finance_pull', parameters: { p_group_id: id } }), 'pull RPC parameters');
    const reviewed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) });
    assert(reviewed.status === 200, 'business rejection is a valid receipt');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'review_decide', parameters: { p_command: command } }), 'command content preserved for idempotency');
    const count = calls.length;
    const malformed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command: { ...command, expectedRevision: -1 } }) });
    assert(malformed.status === 400 && calls.length === count, 'invalid command rejected before RPC');
    const recovered = await app.request(`/api/v1/finance_command_status?idempotencyKey=${id}`, { headers });
    assert(recovered.status === 200 && JSON.stringify(await recovered.json()) === JSON.stringify(receipt), 'lost receipt recovered');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'finance_command_status', parameters: { p_idempotency_key: id } }), 'status RPC parameters');
    missingReceipt = true;
    assert((await app.request(`/api/v1/finance_command_status?idempotencyKey=${id}`, { headers })).status === 404, 'missing receipt is not a confirmation');
    invalidBackend = true;
    assert((await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) })).status === 503, 'accepted without server timestamp fails closed');
    assert((await app.request('/api/v1/finance_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) })).status === 503, 'incomplete snapshot fails closed');
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('planning uses the shared validator and requires a real receipt fact', () => {
  const command = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0,
    action: { type: 'pool_lock', poolId: id, poolVersion: 1, appliedPlanId: id,
      responsible: { registrarPersonId: id, ticketHolderPersonId: null } } };
  assert(parsePlanningReview({ command }) === command, 'original command preserved for idempotency');
  assert(parsePlanningReview({ command: { ...command, actorId: id } }) === null, 'organizer identity comes from Auth');
  assert(parsePlanningReview({ command: { ...command, action: { ...command.action, poolVersion: 0 } } }) === null, 'offline version cannot lock');
  assert(parsePlanningReview({ command: { ...command, action: { ...command.action, responsible: undefined } } }) === null, 'responsibles required explicitly');
  const snapshot = { groupId: id, groupRevision: 0, appliedPlans: [], manifests: [] };
  assert(isPlanningSnapshot(snapshot), 'complete empty planning history');
  assert(!isPlanningSnapshot({ ...snapshot, manifests: undefined }), 'history arrays cannot be omitted');
  assert(!isPlanningReceipt({ apiVersion: 'v1', idempotencyKey: id, receiptId: id, groupId: id, status: 'accepted',
    groupRevision: 0, message: null, confirmedAt: '2026-10-08T12:00:00.000Z', snapshot }), 'server UUID alone cannot confirm a plan or manifest');
});

Deno.test('planning HTTP routes forward human decisions, recover receipts and fail closed on incomplete history', async () => {
  // The mocked transport checks wiring and contract validation; real Auth remains an integration check.
  const claims = { sub: id, role: 'authenticated', session_id: id, app_metadata: {}, is_anonymous: false };
  const token = `fixture.${btoa(JSON.stringify(claims))}.fixture`;
  const snapshot = { groupId: id, groupRevision: 0, appliedPlans: [], manifests: [] };
  const command = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0,
    action: { type: 'pool_lock', poolId: id, poolVersion: 1, appliedPlanId: id,
      responsible: { registrarPersonId: id, ticketHolderPersonId: null } } };
  const receipt = { apiVersion: 'v1', idempotencyKey: id, receiptId: null, groupId: id, status: 'rejected',
    groupRevision: 0, message: 'Plano aplicado não encontrado.', confirmedAt: null, snapshot };
  const calls: { name: string; parameters: unknown }[] = [];
  let invalidBackend = false;
  let missingReceipt = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert(request.headers.get('Authorization') === `Bearer ${token}`, 'human token propagated unchanged');
    assert(request.headers.get('apikey') === 'test-public-key', 'public project key only');
    const path = new URL(request.url).pathname;
    if (path === '/auth/v1/user') return Response.json({ id, app_metadata: {}, is_anonymous: false });
    const name = path.replace('/rest/v1/rpc/', '');
    calls.push({ name, parameters: await request.json() });
    if (name === 'plan_pull') return Response.json(invalidBackend ? { ...snapshot, manifests: undefined } : snapshot);
    if (name === 'planning_decide') return Response.json(invalidBackend ? { ...receipt, receiptId: id, status: 'accepted', confirmedAt: '2026-10-08T12:00:00.000Z' } : receipt);
    if (name === 'plan_command_status') return Response.json(missingReceipt ? null : receipt);
    throw new Error(`Unexpected mocked RPC: ${name}`);
  };
  try {
    const app = createApi({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] });
    const headers = { Authorization: `Bearer ${token}`, Origin: 'https://app.example', 'Content-Type': 'application/json' };
    const pulled = await app.request('/api/v1/plan_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) });
    assert(pulled.status === 200 && JSON.stringify(await pulled.json()) === JSON.stringify(snapshot), 'complete planning snapshot returned');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'plan_pull', parameters: { p_group_id: id } }), 'pull RPC parameters');
    const reviewed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) });
    assert(reviewed.status === 200, 'planning business rejection is a valid receipt');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'planning_decide', parameters: { p_command: command } }), 'planning action routes to its own RPC');
    const count = calls.length;
    const malformed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command: { ...command, action: { ...command.action, poolVersion: 0 } } }) });
    assert(malformed.status === 400 && calls.length === count, 'offline lock rejected before RPC');
    const recovered = await app.request(`/api/v1/plan_command_status?idempotencyKey=${id}`, { headers });
    assert(recovered.status === 200 && JSON.stringify(await recovered.json()) === JSON.stringify(receipt), 'lost planning receipt recovered');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'plan_command_status', parameters: { p_idempotency_key: id } }), 'status RPC parameters');
    missingReceipt = true;
    assert((await app.request(`/api/v1/plan_command_status?idempotencyKey=${id}`, { headers })).status === 404, 'missing planning receipt cannot become acceptance');
    invalidBackend = true;
    assert((await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) })).status === 503, 'accepted without bound server fact fails closed');
    assert((await app.request('/api/v1/plan_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) })).status === 503, 'incomplete manifest history fails closed');
  } finally { globalThis.fetch = originalFetch; }
});

function emptySettlement(groupRevision = 0) {
  return { groupId: id, groupRevision,
    financial: { groupId: id, groupRevision, statutes: [], acceptances: [], payments: [], allocations: [], movements: [], quotas: [], revocations: [] },
    registration: { groupId: id, groupRevision, manifests: [], evidence: [], reports: [] },
    results: { groupId: id, groupRevision, results: [], selections: [], calendarVersions: [] },
    expenses: [], prizes: [], redemptions: [], distributions: [], closures: [] };
}

Deno.test('settlement uses the shared validator and requires a real receipt fact', () => {
  const command = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0,
    action: { type: 'distribution_record', poolId: id, poolVersion: 2, personId: id, kind: 'prize-payment', amountCents: '1500',
      evidenceIds: [id], sourceReference: 'Transferência identificada', eventAt: '2026-10-10T12:00:00.000Z', reason: 'Pagamento do direito.' } };
  assert(parseSettlementReview({ command }) === command, 'original command preserved for idempotency');
  assert(parseSettlementReview({ command: { ...command, actorId: id } }) === null, 'organizer identity comes from Auth');
  assert(parseSettlementReview({ command: { ...command, action: { ...command.action, amountCents: '1500.00' } } }) === null, 'cents are canonical integer strings');
  assert(parseSettlementReview({ command: { ...command, action: { ...command.action, reason: ' ' } } }) === null, 'payments keep a human reason');
  assert(parseSettlementReview({ command: { ...command, action: { ...command.action, poolVersion: 0 } } }) === null, 'offline version cannot settle');
  const settle = { ...command, action: { type: 'pool_settle', poolId: id, poolVersion: 2, registrationReportId: id, prizeConfirmationId: null,
    expenseConfirmationId: null, leftoverDisposition: 'group-reserve', pendingExplanation: '', reason: 'Encerramento.' } };
  assert(parseSettlementReview({ command: settle }) === settle, 'closing reaches SQL, which answers with an explicit rejection');
  const huge = { ...command, action: { ...command.action, sourceReference: 'x'.repeat(1_048_576) } };
  assert(parseSettlementReview({ command: huge }) === null, 'commands above 1 MiB rejected before the RPC');
  const snapshot = emptySettlement();
  assert(isSettlementSnapshot(snapshot), 'complete empty settlement history');
  assert(!isSettlementSnapshot({ ...snapshot, closures: undefined }), 'history arrays cannot be omitted');
  assert(!isSettlementSnapshot({ ...snapshot, results: { ...snapshot.results, groupRevision: 1 } }), 'source families share one revision cut');
  assert(!isSettlementReceipt({ apiVersion: 'v1', idempotencyKey: id, receiptId: id, groupId: id, status: 'accepted',
    groupRevision: 0, message: null, confirmedAt: '2026-10-10T12:00:00.000Z', snapshot }), 'server UUID alone cannot confirm a settlement fact');
});

Deno.test('settlement HTTP routes forward human decisions, recover receipts and fail closed', async () => {
  // The mocked transport checks wiring and contract validation; real Auth remains an integration check.
  const claims = { sub: id, role: 'authenticated', session_id: id, app_metadata: {}, is_anonymous: false };
  const token = `fixture.${btoa(JSON.stringify(claims))}.fixture`;
  const snapshot = emptySettlement();
  const command = { apiVersion: 'v1', idempotencyKey: id, groupId: id, expectedRevision: 0,
    action: { type: 'pool_settle', poolId: id, poolVersion: 2, registrationReportId: id, prizeConfirmationId: null,
      expenseConfirmationId: null, leftoverDisposition: 'group-reserve', pendingExplanation: '', reason: 'Encerramento.' } };
  const receipt = { apiVersion: 'v1', idempotencyKey: id, receiptId: null, groupId: id, status: 'rejected',
    groupRevision: 0, message: 'Encerramento exige as versões atuais de registro, despesas e prêmio.', confirmedAt: null, snapshot };
  const calls: { name: string; parameters: unknown }[] = [];
  let invalidBackend = false;
  let missingReceipt = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert(request.headers.get('Authorization') === `Bearer ${token}`, 'human token propagated unchanged');
    assert(request.headers.get('apikey') === 'test-public-key', 'public project key only');
    const path = new URL(request.url).pathname;
    if (path === '/auth/v1/user') return Response.json({ id, app_metadata: {}, is_anonymous: false });
    const name = path.replace('/rest/v1/rpc/', '');
    calls.push({ name, parameters: await request.json() });
    if (name === 'settlement_pull') return Response.json(invalidBackend ? { ...snapshot, closures: undefined } : snapshot);
    if (name === 'settlement_decide') return Response.json(invalidBackend ? { ...receipt, receiptId: id, status: 'accepted', message: null, confirmedAt: '2026-10-10T12:00:00.000Z' } : receipt);
    if (name === 'settlement_command_status') return Response.json(missingReceipt ? null : receipt);
    throw new Error(`Unexpected mocked RPC: ${name}`);
  };
  try {
    const app = createApi({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] });
    const headers = { Authorization: `Bearer ${token}`, Origin: 'https://app.example', 'Content-Type': 'application/json' };
    const pulled = await app.request('/api/v1/settlement_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) });
    assert(pulled.status === 200 && JSON.stringify(await pulled.json()) === JSON.stringify(snapshot), 'complete settlement snapshot returned');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'settlement_pull', parameters: { p_group_id: id } }), 'pull RPC parameters');
    const reviewed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) });
    assert(reviewed.status === 200 && (await reviewed.json()).message === receipt.message, 'unavailable closing is forwarded as a valid rejection receipt');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'settlement_decide', parameters: { p_command: command } }), 'settlement action routes to its own RPC');
    const count = calls.length;
    const malformed = await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command: { ...command, action: { ...command.action, leftoverDisposition: 'wallet' } } }) });
    assert(malformed.status === 400 && calls.length === count, 'malformed settlement rejected before RPC');
    const recovered = await app.request(`/api/v1/settlement_command_status?idempotencyKey=${id}`, { headers });
    assert(recovered.status === 200 && JSON.stringify(await recovered.json()) === JSON.stringify(receipt), 'lost settlement receipt recovered');
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'settlement_command_status', parameters: { p_idempotency_key: id } }), 'status RPC parameters');
    missingReceipt = true;
    assert((await app.request(`/api/v1/settlement_command_status?idempotencyKey=${id}`, { headers })).status === 404, 'missing settlement receipt cannot become acceptance');
    invalidBackend = true;
    assert((await app.request('/api/v1/review_decide', { method: 'POST', headers, body: JSON.stringify({ command }) })).status === 503, 'accepted without bound server fact fails closed');
    assert((await app.request('/api/v1/settlement_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) })).status === 503, 'incomplete settlement history fails closed');
  } finally { globalThis.fetch = originalFetch; }
});
Deno.test('participant links: token only at creation, card opens by POST without a session, unknown 404, revoked 410, non-organizer refused', async () => {
  // The mocked transport checks wiring; the SQL suite proves RLS, revocation and the card values.
  const token = `fixture.${btoa(JSON.stringify({ sub: id, role: 'authenticated', session_id: id, app_metadata: {}, is_anonymous: false }))}.fixture`;
  const linkId = '22222222-2222-4222-8222-222222222222';
  const card = { version: 1, generatedAt: '2026-10-11T12:00:00.000Z', group: { name: 'Bolão da firma' }, person: { id, name: 'Pessoa B' }, pools: [] };
  const links = new Map<string, 'active' | 'revoked'>();
  const calls: { name: string; authorization: string | null; parameters: Record<string, string> }[] = [];
  let organizer = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/v1/user') return Response.json({ id, app_metadata: {}, is_anonymous: false });
    const name = path.replace('/rest/v1/rpc/', '');
    const parameters = await request.json();
    calls.push({ name, authorization: request.headers.get('Authorization'), parameters });
    if (name !== 'participant_card_open' && !organizer) return Response.json({ code: '42501', details: null, hint: null, message: 'group_access_denied' }, { status: 403 });
    if (name === 'participant_link_create') {
      links.set(parameters.p_token_hash, 'active');
      return Response.json({ id: linkId, personId: parameters.p_person_id, createdAt: '2026-10-11T12:00:00.000Z' });
    }
    if (name === 'participant_link_revoke') {
      for (const hash of links.keys()) links.set(hash, 'revoked');
      return Response.json({ id: parameters.p_id, revokedAt: '2026-10-11T12:05:00.000Z' });
    }
    if (name === 'participant_links_pull') return Response.json({ links: [{ id: linkId, personId: id, createdAt: '2026-10-11T12:00:00.000Z', revokedAt: null, hasPin: false }] });
    if (name === 'participant_card_open') {
      const state = links.get(parameters.p_token_hash);
      return Response.json(state === 'active' ? card : { error: state === 'revoked' ? 'link_revoked' : 'link_unknown' });
    }
    throw new Error(`Unexpected mocked RPC: ${name}`);
  };
  try {
    const open = (cardToken: string, headers: Record<string, string> = {}) => ({ method: 'POST', headers, body: JSON.stringify({ token: cardToken }) });
    const config = { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] };
    const unconfigured = await createApi(config).request('/api/v1/participant_card', open('a'.repeat(43)));
    assert(unconfigured.status === 503 && (await unconfigured.json()).code === 'participant_card_unconfigured' && calls.length === 0, 'card needs the server key');
    const app = createApi({ ...config, serviceRoleKey: 'server-fixture' });
    const headers = { Authorization: `Bearer ${token}`, Origin: 'https://app.example', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ groupId: id, personId: id });
    const created = await app.request('/api/v1/participant_link', { method: 'POST', headers, body });
    const link = await created.json();
    assert(created.status === 201 && link.id === linkId && link.personId === id && /^[A-Za-z0-9_-]{43}$/.test(link.token), 'created with a 32-byte token');
    const sent = calls.at(-1);
    assert(sent?.authorization === `Bearer ${token}` && sent.parameters.p_group_id === id && sent.parameters.p_person_id === id
      && sent.parameters.p_token_hash === await hashBytes(new TextEncoder().encode(link.token)) && !JSON.stringify(calls).includes(link.token), 'organizer session stores only the SHA-256');
    const again = await (await app.request('/api/v1/participant_link', { method: 'POST', headers, body })).json();
    assert(again.token !== link.token, 'every link gets a fresh random token');
    const opened = await app.request('/api/v1/participant_card', open(link.token, { Origin: 'https://app.example', 'Content-Type': 'application/json' }));
    assert(opened.status === 200 && JSON.stringify(await opened.json()) === JSON.stringify(card) && opened.headers.get('Cache-Control') === 'no-store', 'card opens without a session and is never cached');
    assert(calls.at(-1)?.name === 'participant_card_open' && calls.at(-1)?.authorization === 'Bearer server-fixture' && calls.at(-1)?.parameters.p_pin === null, 'card read with the server key only, without a PIN');
    const count = calls.length;
    assert((await app.request('/api/v1/participant_card', open('short'))).status === 404 && calls.length === count, 'malformed token never reaches the database');
    assert((await app.request(`/api/v1/participant_card?token=${link.token}`)).status === 401 && calls.length === count, 'token in the URL is not accepted');
    assert((await app.request('/api/v1/participant_card', { method: 'POST', body: JSON.stringify({ token: link.token, extra: 1 }) })).status === 404 && calls.length === count, 'unexpected fields refused');
    const unknown = await app.request('/api/v1/participant_card', open('b'.repeat(43)));
    assert(unknown.status === 404 && (await unknown.json()).code === 'link_unknown', 'unknown link answers 404');
    const pulled = await app.request('/api/v1/participant_links_pull', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) });
    assert(pulled.status === 200 && (await pulled.json()).links[0].hasPin === false && JSON.stringify(calls.at(-1)?.parameters) === JSON.stringify({ p_group_id: id }), 'links listed for the organizer');
    const revoked = await app.request('/api/v1/participant_link_revoke', { method: 'POST', headers, body: JSON.stringify({ groupId: id, id: linkId }) });
    assert(revoked.status === 200 && JSON.stringify(await revoked.json()) === JSON.stringify({ id: linkId, revokedAt: '2026-10-11T12:05:00.000Z' })
      && JSON.stringify(calls.at(-1)?.parameters) === JSON.stringify({ p_group_id: id, p_id: linkId }), 'link revoked');
    const closed = await app.request('/api/v1/participant_card', open(link.token));
    assert(closed.status === 410 && (await closed.json()).code === 'link_revoked', 'revoked link answers 410');
    assert((await app.request('/api/v1/participant_link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status === 401, 'creating a link needs a session');
    assert((await app.request('/api/v1/participant_link', { method: 'POST', headers, body: JSON.stringify({ groupId: id }) })).status === 400, 'person required');
    organizer = false;
    const refused = await app.request('/api/v1/participant_link', { method: 'POST', headers, body });
    assert(refused.status === 403 && (await refused.json()).code === 'access_denied', 'non-organizer cannot create a link');
  } finally { globalThis.fetch = originalFetch; }
});
Deno.test('participant PIN: the card answers 401 without or with a wrong PIN and 429 when locked; the PIN route needs no session and refuses bad bodies before the database', async () => {
  // The mocked transport checks wiring; the SQL suite proves the counting, the lock and that only a salted hash is stored.
  const card = { version: 1, generatedAt: '2026-10-15T12:00:00.000Z', group: { name: 'Bolão da firma' }, person: { id, name: 'Pessoa B' }, pools: [], pinSet: true };
  const calls: { name: string; authorization: string | null; parameters: Record<string, unknown> }[] = [];
  let reply: unknown = card; let failing = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/v1/user') throw new Error('The public PIN routes never look at a session.');
    calls.push({ name: path.replace('/rest/v1/rpc/', ''), authorization: request.headers.get('Authorization'), parameters: await request.json() });
    return failing ? Response.json({ code: 'XX000', details: null, hint: null, message: 'fixture failure' }, { status: 500 }) : Response.json(reply);
  };
  try {
    const config = { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] };
    const linkToken = 'c'.repeat(43);
    const open = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const unconfigured = await createApi(config).request('/api/v1/participant_pin', open({ token: linkToken, pin: '1234', currentPin: null }));
    assert(unconfigured.status === 503 && calls.length === 0, 'the PIN route needs the server key');
    const app = createApi({ ...config, serviceRoleKey: 'server-fixture' });
    // Card route.
    reply = card;
    const withPin = await app.request('/api/v1/participant_card', open({ token: linkToken, pin: '1234' }));
    assert(withPin.status === 200 && (await withPin.json()).pinSet === true && calls.at(-1)?.name === 'participant_card_open' && calls.at(-1)?.authorization === 'Bearer server-fixture'
      && calls.at(-1)?.parameters.p_pin === '1234' && calls.at(-1)?.parameters.p_token_hash === await hashBytes(new TextEncoder().encode(linkToken)), 'card opens with the PIN');
    reply = { error: 'pin_required' };
    const required = await app.request('/api/v1/participant_card', open({ token: linkToken }));
    assert(required.status === 401 && JSON.stringify(await required.json()) === JSON.stringify({ code: 'pin_required', message: 'Este cartão tem PIN.' }) && calls.at(-1)?.parameters.p_pin === null, 'card with PIN asks for it');
    reply = { error: 'pin_wrong', attemptsLeft: 3 };
    const wrong = await app.request('/api/v1/participant_card', open({ token: linkToken, pin: '0000' }));
    assert(wrong.status === 401 && JSON.stringify(await wrong.json()) === JSON.stringify({ code: 'pin_wrong', message: 'PIN errado.', attemptsLeft: 3 }), 'wrong PIN answers 401 with the tries left');
    reply = { error: 'pin_locked', retryAt: '2026-10-15T12:15:00.000Z' };
    const locked = await app.request('/api/v1/participant_card', open({ token: linkToken, pin: '0000' }));
    assert(locked.status === 429 && JSON.stringify(await locked.json()) === JSON.stringify({ code: 'pin_locked', message: 'Muitas tentativas erradas. Tente de novo mais tarde.', retryAt: '2026-10-15T12:15:00.000Z' }), 'locked card answers 429 with the retry moment');
    reply = { ...card, pinSet: 'yes' };
    assert((await app.request('/api/v1/participant_card', open({ token: linkToken, pin: '1234' }))).status === 503, 'a card with a malformed pinSet fails closed');
    reply = { error: 'pin_wrong' };
    assert((await app.request('/api/v1/participant_card', open({ token: linkToken, pin: '1234' }))).status === 503, 'a wrong-PIN answer without the tries left fails closed');
    const count = calls.length;
    for (const body of [{ token: linkToken, pin: '1234', extra: 1 }, { token: linkToken, pin: 1234 }, { token: linkToken, pin: null }, { pin: '1234' }, { token: 'short', pin: '1234' }]) {
      assert((await app.request('/api/v1/participant_card', open(body))).status === 404 && calls.length === count, 'any other body shape is an unknown link, before the database');
    }
    failing = true;
    assert((await app.request('/api/v1/participant_card', open({ token: linkToken, pin: '1234' }))).status === 503, 'database failure on the card is 503');
    failing = false;
    // PIN route.
    reply = { pinSet: true };
    const set = await app.request('/api/v1/participant_pin', open({ token: linkToken, pin: '1234', currentPin: null }));
    assert(set.status === 200 && JSON.stringify(await set.json()) === JSON.stringify({ pinSet: true }) && calls.at(-1)?.name === 'participant_pin_set'
      && calls.at(-1)?.authorization === 'Bearer server-fixture' && JSON.stringify(calls.at(-1)?.parameters) === JSON.stringify({
        p_token_hash: await hashBytes(new TextEncoder().encode(linkToken)), p_pin: '1234', p_current_pin: null }), 'the PIN is set without a session');
    reply = { pinSet: false };
    const removed = await app.request('/api/v1/participant_pin', open({ token: linkToken, pin: null, currentPin: '1234' }));
    assert(removed.status === 200 && JSON.stringify(await removed.json()) === JSON.stringify({ pinSet: false }) && calls.at(-1)?.parameters.p_pin === null && calls.at(-1)?.parameters.p_current_pin === '1234', 'the PIN is removed with the current one');
    const sent = calls.length;
    for (const body of [{ token: linkToken, pin: '12', currentPin: null }, { token: linkToken, pin: '12ab', currentPin: null }, { token: linkToken, pin: 1234, currentPin: null },
      { token: linkToken, pin: '1234', currentPin: 'abcd' }, { token: linkToken, pin: '1234', currentPin: '12345' }, { token: linkToken, pin: '1234' }, { token: linkToken, pin: '1234', currentPin: null, extra: 1 }]) {
      const invalid = await app.request('/api/v1/participant_pin', open(body));
      assert(invalid.status === 400 && (await invalid.json()).code === 'invalid_request' && calls.length === sent, 'a PIN that is not four digits never reaches the database');
    }
    const malformed = await app.request('/api/v1/participant_pin', open({ token: 'short', pin: '1234', currentPin: null }));
    assert(malformed.status === 404 && (await malformed.json()).code === 'link_unknown' && calls.length === sent, 'a malformed token never reaches the database');
    assert((await app.request('/api/v1/participant_pin?token=' + linkToken, { method: 'GET' })).status === 401 && calls.length === sent, 'only POST skips the session');
    const answers: [unknown, number, string][] = [
      [{ error: 'pin_required' }, 401, 'pin_required'], [{ error: 'pin_wrong', attemptsLeft: 2 }, 401, 'pin_wrong'], [{ error: 'pin_locked', retryAt: '2026-10-15T12:15:00.000Z' }, 429, 'pin_locked'],
      [{ error: 'pin_invalid' }, 400, 'invalid_request'], [{ error: 'link_unknown' }, 404, 'link_unknown'], [{ error: 'link_revoked' }, 410, 'link_revoked'],
      [{ pinSet: false }, 503, 'invalid_backend_response'], [{ pinSet: 'yes' }, 503, 'invalid_backend_response'], [{}, 503, 'invalid_backend_response'], [null, 503, 'invalid_backend_response'],
    ];
    for (const [answer, status, code] of answers) {
      reply = answer;
      const response = await app.request('/api/v1/participant_pin', open({ token: linkToken, pin: '1234', currentPin: '0000' }));
      const body = await response.json();
      assert(response.status === status && body.code === code, `PIN route maps ${JSON.stringify(answer)} to ${status} ${code}`);
      if (code === 'pin_required') assert(body.message === 'Digite o PIN atual.', 'the PIN route asks for the current PIN');
      if (code === 'pin_wrong') assert(body.attemptsLeft === 2, 'the PIN route reports the tries left');
      if (code === 'pin_locked') assert(body.retryAt === '2026-10-15T12:15:00.000Z', 'the PIN route reports the retry moment');
    }
    failing = true;
    assert((await app.request('/api/v1/participant_pin', open({ token: linkToken, pin: '1234', currentPin: null }))).status === 503, 'database failure on the PIN route is 503');
  } finally { globalThis.fetch = originalFetch; }
});
Deno.test('person phones: organizer lists, sets and clears; invalid phones and ids never reach the database; no session 401; non-organizer 403', async () => {
  // The mocked transport checks wiring; the SQL suite proves RLS, validation and that the card never carries a phone.
  const token = `fixture.${btoa(JSON.stringify({ sub: id, role: 'authenticated', session_id: id, app_metadata: {}, is_anonymous: false }))}.fixture`;
  const personId = '33333333-3333-4333-8333-333333333333';
  const phones = new Map<string, string>();
  const calls: { name: string; authorization: string | null; parameters: Record<string, string> }[] = [];
  let organizer = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/v1/user') return Response.json({ id, app_metadata: {}, is_anonymous: false });
    const name = path.replace('/rest/v1/rpc/', '');
    const parameters = await request.json();
    calls.push({ name, authorization: request.headers.get('Authorization'), parameters });
    if (!organizer) return Response.json({ code: '42501', details: null, hint: null, message: 'group_access_denied' }, { status: 403 });
    if (name === 'person_phone_set') { phones.set(parameters.p_person_id, parameters.p_phone); return Response.json({ personId: parameters.p_person_id, phone: parameters.p_phone }); }
    if (name === 'person_phone_clear') { phones.delete(parameters.p_person_id); return Response.json({ personId: parameters.p_person_id }); }
    if (name === 'person_phones_pull') return Response.json({ phones: [...phones].map(([key, phone]) => ({ personId: key, phone })) });
    throw new Error(`Unexpected mocked RPC: ${name}`);
  };
  try {
    const app = createApi({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'test-public-key', allowedOrigins: ['https://app.example'] });
    const headers = { Authorization: `Bearer ${token}`, Origin: 'https://app.example', 'Content-Type': 'application/json' };
    const one = `/api/v1/groups/${id}/persons/${personId}/phone`;
    const put = (phone: unknown) => app.request(one, { method: 'PUT', headers, body: JSON.stringify({ phone }) });
    assert(JSON.stringify(await (await app.request(`/api/v1/groups/${id}/phones`, { headers })).json()) === JSON.stringify({ phones: [] }), 'no phones at first');
    const saved = await put('5511987654321');
    assert(saved.status === 200 && JSON.stringify(await saved.json()) === JSON.stringify({ personId, phone: '5511987654321' }), 'phone saved and echoed');
    const sent = calls.at(-1);
    assert(sent?.name === 'person_phone_set' && sent.authorization === `Bearer ${token}`
      && JSON.stringify(sent.parameters) === JSON.stringify({ p_group_id: id, p_person_id: personId, p_phone: '5511987654321' }), 'organizer session sends group, person and digits');
    const listed = await app.request(`/api/v1/groups/${id}/phones`, { headers });
    assert(listed.status === 200 && JSON.stringify(await listed.json()) === JSON.stringify({ phones: [{ personId, phone: '5511987654321' }] })
      && JSON.stringify(calls.at(-1)?.parameters) === JSON.stringify({ p_group_id: id }) && listed.headers.get('Cache-Control') === 'no-store', 'phones listed and never cached');
    const cleared = await app.request(one, { method: 'DELETE', headers });
    assert(cleared.status === 204 && (await cleared.text()) === '' && phones.size === 0 && calls.at(-1)?.name === 'person_phone_clear', 'phone cleared with no content');
    const count = calls.length;
    for (const bad of ['+5511987654321', '11 98765-4321', '123456789', '1234567890123456', '0511987654321', '', 5511987654321, null]) {
      const refused = await put(bad);
      const body = await refused.json();
      assert(refused.status === 400 && body.code === 'invalid_phone' && body.message === 'Telefone inválido: use só números, com DDI e DDD.', `invalid phone refused: ${String(bad)}`);
    }
    assert((await app.request(one, { method: 'PUT', headers, body: JSON.stringify({}) })).status === 400
      && (await app.request(one, { method: 'PUT', headers, body: JSON.stringify({ phone: '5511987654321', extra: 1 }) })).status === 400
      && (await app.request(one, { method: 'PUT', headers, body: 'not json' })).status === 400, 'missing, extra or malformed body refused');
    assert((await app.request(`/api/v1/groups/not-a-uuid/persons/${personId}/phone`, { method: 'PUT', headers, body: JSON.stringify({ phone: '5511987654321' }) })).status === 400
      && (await app.request(`/api/v1/groups/${id}/persons/not-a-uuid/phone`, { method: 'DELETE', headers })).status === 400
      && (await app.request('/api/v1/groups/not-a-uuid/phones', { headers })).status === 400, 'malformed ids refused');
    assert(calls.length === count, 'refused requests never reach the database');
    const bare = { 'Content-Type': 'application/json' };
    assert((await app.request(`/api/v1/groups/${id}/phones`, { headers: bare })).status === 401
      && (await app.request(one, { method: 'PUT', headers: bare, body: JSON.stringify({ phone: '5511987654321' }) })).status === 401
      && (await app.request(one, { method: 'DELETE', headers: bare })).status === 401 && calls.length === count, 'phones need a session');
    const preflight = await app.request(one, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'PUT' } });
    assert(preflight.status === 204 && /PUT/.test(preflight.headers.get('Access-Control-Allow-Methods') ?? '') && /DELETE/.test(preflight.headers.get('Access-Control-Allow-Methods') ?? ''), 'browser may PUT and DELETE');
    organizer = false;
    for (const refused of [await app.request(`/api/v1/groups/${id}/phones`, { headers }), await put('5511987654321'), await app.request(one, { method: 'DELETE', headers })]) {
      assert(refused.status === 403 && (await refused.json()).code === 'access_denied', 'non-organizer refused');
    }
  } finally { globalThis.fetch = originalFetch; }
});
