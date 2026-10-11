import { createApi } from './app.ts';
import { createResultsCollector } from './collector.ts';
import { evidenceMime, hashBytes, uploadOriginal, EvidenceFailure } from './evidence.ts';
import { collectOfficialResult, ResultCollectionFailure } from './results.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFinancialReceipt, isFinancialSnapshot, isHumanSession, isPlanningReceipt, isPlanningSnapshot, parseFinancialReview, parsePlanningReview, parsePush } from './contract.ts';

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
