import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EvidenceFailure, evidenceMime, hashBytes, MAX_ORIGINAL_BYTES, uploadOriginal } from './evidence.ts';
import { collectOfficialResult, ResultCollectionFailure, type CollectionContext } from './results.ts';
import {
  createParticipantToken, isAnswerCents, isAnswerKind, isParticipantCard, isParticipantLink, isParticipantProofStatus, isParticipantReminder, isParticipantResponse,
  isParticipantResponsesPull, isPersonPhone, isPhone, isPin, participantTokenHash,
} from './participant.ts';
import { validateEvidenceMetadata, validateEvidenceUploadMetadata } from '../../../packages/core/src/evidence.ts';
import type { ParticipantResponse } from '../../../packages/core/src/participant-types.ts';
import {
  exactKeys, isCursor, isFinancialReceipt, isFinancialSnapshot, isHumanSession, isObject,
  isPlanningReceipt, isPlanningSnapshot, isPushReceipt, isRegistrationReceipt, isRegistrationSnapshot, isResultReceipt, isResultSnapshot,
  isSettlementReceipt, isSettlementSnapshot, isUuid, parseFinancialReview, parsePlanningReview, parsePush, parseRegistrationReview, parseResultReview,
  parseSettlementReview, readVerifiedTokenClaims, SETTLEMENT_ACTION_TYPES,
} from './contract.ts';

export interface ApiConfig {
  supabaseUrl: string;
  publishableKey: string;
  allowedOrigins: string[];
  /** Server-only capability for byte attestations and official collection. Never sent to the client. */
  serviceRoleKey?: string;
  resultsJobSecret?: string;
}

type ApiEnvironment = { Variables: { supabase: SupabaseClient; actorId: string } };

type ParticipantFailure = { status: 401 | 404 | 410 | 429; body: Record<string, unknown> };

/** The answers the card and PIN routes share for a bad link or a wrong or locked PIN; null for anything else. */
function participantFailure(data: unknown): ParticipantFailure | null {
  if (!isObject(data)) return null;
  if (data.error === 'link_unknown') return { status: 404, body: { code: 'link_unknown', message: 'Este link não existe. Peça um novo ao organizador.' } };
  if (data.error === 'link_revoked') return { status: 410, body: { code: 'link_revoked', message: 'Este link foi cancelado pelo organizador.' } };
  if (data.error === 'pin_wrong' && typeof data.attemptsLeft === 'number') return { status: 401, body: { code: 'pin_wrong', message: 'PIN errado.', attemptsLeft: data.attemptsLeft } };
  if (data.error === 'pin_locked' && typeof data.retryAt === 'string') {
    return { status: 429, body: { code: 'pin_locked', message: 'Muitas tentativas erradas. Tente de novo mais tarde.', retryAt: data.retryAt } };
  }
  return null;
}

/** Answers to participant_respond and participant_proof_context that refuse the answer: the card's link and PIN refusals plus the pool ones. */
function answerFailure(data: unknown): { status: 401 | 404 | 409 | 410 | 429; body: Record<string, unknown> } | null {
  const failure = participantFailure(data);
  if (failure || !isObject(data)) return failure;
  if (data.error === 'pin_required') return { status: 401, body: { code: 'pin_required', message: 'Este cartão tem PIN.' } };
  if (data.error === 'pool_unknown') return { status: 404, body: { code: 'pool_unknown', message: 'Este bolão não está mais no cartão.' } };
  if (data.error === 'pool_closed') return { status: 409, body: { code: 'pool_closed', message: 'Este bolão não aceita mais respostas.' } };
  return null;
}

/** The same extension per type as the registration evidence and the database's storage_path check. */
const PROOF_EXTENSION = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

type Answer = { token: unknown; pin: string | null; poolId: string; kind: 'in' | 'out' | 'paid'; amountCents: string | null; idempotencyKey: string };

/**
 * The answer body both participant routes accept (the proof route has no kind: it is always 'paid'); null for a missing or extra
 * field or one out of shape. The token is checked apart, so a malformed one answers like an unknown link.
 */
function parseAnswer(value: unknown, withKind: boolean): Answer | null {
  if (!isObject(value)) return null;
  const kind = withKind ? value.kind : 'paid';
  if (!isAnswerKind(kind)) return null;
  const keys = ['token', 'poolId', 'idempotencyKey', ...(withKind ? ['kind'] : []), ...(kind === 'paid' ? ['amountCents'] : []), ...(Object.hasOwn(value, 'pin') ? ['pin'] : [])];
  if (!exactKeys(value, keys) || (Object.hasOwn(value, 'pin') && !isPin(value.pin)) || !isUuid(value.poolId) || !isUuid(value.idempotencyKey)) return null;
  if (kind === 'paid' && !isAnswerCents(value.amountCents)) return null;
  return { token: value.token, pin: isPin(value.pin) ? value.pin : null, poolId: value.poolId, kind, amountCents: isAnswerCents(value.amountCents) ? value.amountCents : null, idempotencyKey: value.idempotencyKey };
}

/** A recorded answer bound to what was sent: the database refuses a replayed key with another pool, kind or amount. */
function isAnswerOf(response: unknown, answer: Answer): response is ParticipantResponse {
  return isParticipantResponse(response) && response.poolId === answer.poolId && response.kind === answer.kind && response.amountCents === answer.amountCents;
}

function rpcError(code: string): { status: 400 | 403 | 409 | 503; code: string; message: string } {
  if (code === '42501') return { status: 403, code: 'access_denied', message: 'Esta conta não tem acesso ao grupo ou à operação.' };
  if (code === '22023' || code === '22P02') return { status: 400, code: 'invalid_request', message: 'Operação ou cursor inválido.' };
  if (code === 'P0001') return { status: 409, code: 'cursor_expired', message: 'O cursor precisa de uma nova carga; preserve suas pendências locais.' };
  return { status: 503, code: 'backend_unavailable', message: 'Não foi possível concluir; repita com as mesmas chaves de idempotência.' };
}

export function createApi(config: ApiConfig): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>().basePath('/api');
  const allowedOrigins = new Set(config.allowedOrigins);
  const server = config.serviceRoleKey ? createClient(config.supabaseUrl, config.serviceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null;
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin && !allowedOrigins.has(origin)) return c.json({ code: 'origin_denied', message: 'Origem não autorizada.' }, 403);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Vary', 'Origin');
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'authorization, apikey, x-client-info, content-type');
      c.header('Access-Control-Max-Age', '600');
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });
  app.use('*', (c, next) => bodyLimit({ maxSize: c.req.path === '/api/v1/evidence_upload' || c.req.path === '/api/v1/participant_proof' ? MAX_ORIGINAL_BYTES + 65536 : 1024 * 1024,
    onError: context => context.json({ code: 'request_too_large', message: 'O corpo enviado excede o limite desta operação.' }, 413) })(c, next));
  app.use('*', async (c, next) => {
    const authorization = c.req.header('Authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const token = match?.[1];
    if (c.req.path === '/api/v1/jobs/results_collect_due') {
      if (!server || !config.resultsJobSecret || config.resultsJobSecret.length < 32) return c.json({ code: 'results_job_unconfigured', message: 'A capacidade privada de coleta agendada ainda não está configurada.' }, 503);
      const supplied = await hashBytes(new TextEncoder().encode(token ?? ''));
      const configured = await hashBytes(new TextEncoder().encode(config.resultsJobSecret));
      let mismatch = 0; for (let i = 0; i < configured.length; i++) mismatch |= configured.charCodeAt(i) ^ supplied.charCodeAt(i);
      if (mismatch !== 0) return c.json({ code: 'job_access_denied', message: 'Capacidade de coleta não autorizada.' }, 403);
      await next(); return;
    }
    // The participant card, its PIN and the answers sent through it are reached by the link token alone; any session sent along is ignored.
    if (c.req.method === 'POST' && ['/api/v1/participant_card', '/api/v1/participant_pin', '/api/v1/participant_respond', '/api/v1/participant_proof'].includes(c.req.path)) {
      await next(); return;
    }
    if (!token) return c.json({ code: 'authentication_required', message: 'Entre na sua conta antes de sincronizar.' }, 401);
    const supabase = createClient(config.supabaseUrl, config.publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return c.json({ code: 'invalid_session', message: 'Sua sessão precisa ser renovada.' }, 401);
    if (!isHumanSession(readVerifiedTokenClaims(token), data.user)) {
      return c.json({ code: 'human_session_required', message: 'Esta versão aceita apenas a sessão humana do organizador.' }, 403);
    }
    c.set('supabase', supabase);
    c.set('actorId', data.user.id);
    await next();
  });
  app.post('/v1/evidence_upload', async c => {
    if (!server) return c.json({ code: 'evidence_server_unconfigured', message: 'O servidor ainda não possui a capacidade privada para verificar originais.' }, 503);
    const form = await c.req.raw.formData().catch(() => null);
    if (!form || [...form.keys()].length !== 2 || !form.has('metadata') || !form.has('original')) return c.json({ code: 'invalid_request', message: 'Envie os metadados e o arquivo original.' }, 400);
    const metadataText = form.get('metadata'); const original = form.get('original');
    if (typeof metadataText !== 'string' || !(original instanceof Blob)) return c.json({ code: 'invalid_request', message: 'Metadados ou original inválidos.' }, 400);
    try {
      const metadata = validateEvidenceUploadMetadata(JSON.parse(metadataText));
      const evidence = await uploadOriginal(c.get('supabase'), server, c.get('actorId'), metadata, original);
      return c.json(evidence);
    } catch (error) {
      if (error instanceof EvidenceFailure) return c.json({ code: error.code, message: error.message }, error.status);
      return c.json({ code: 'invalid_original', message: 'Não foi possível validar os metadados ou o selo do original.' }, 400);
    }
  });
  app.get('/v1/evidence_status', async c => {
    const id = c.req.query('id');
    if (!isUuid(id)) return c.json({ code: 'invalid_request', message: 'Identificador de original inválido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('evidence_status', { p_id: id });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!data) return c.json({ code: 'evidence_not_found', message: 'Original ainda não selado ou não disponível para esta conta.' }, 404);
    try { return c.json(validateEvidenceMetadata(data)); } catch { return c.json({ code: 'invalid_backend_response', message: 'Os metadados do original não puderam ser verificados.' }, 503); }
  });
  app.get('/v1/evidence_download', async c => {
    const id = c.req.query('id');
    if (!isUuid(id)) return c.json({ code: 'invalid_request', message: 'Identificador de original inválido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('evidence_status', { p_id: id });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!data) return c.json({ code: 'evidence_not_found', message: 'Original indisponível para esta conta.' }, 404);
    let evidence;
    try { evidence = validateEvidenceMetadata(data); } catch { return c.json({ code: 'invalid_backend_response', message: 'O selo do original não pôde ser verificado.' }, 503); }
    const original = await c.get('supabase').storage.from('evidence').download(evidence.storagePath);
    if (original.error || !original.data) return c.json({ code: 'original_unavailable', message: 'Não foi possível recuperar o original privado.' }, 503);
    const bytes = new Uint8Array(await original.data.arrayBuffer());
    if (bytes.length !== evidence.byteSize || evidenceMime(bytes) !== evidence.mimeType || await hashBytes(bytes) !== evidence.sha256) {
      return c.json({ code: 'original_integrity_mismatch', message: 'O original recuperado não corresponde ao selo preservado.' }, 503);
    }
    c.header('Content-Type', evidence.mimeType);
    c.header('Content-Disposition', `attachment; filename="original"; filename*=UTF-8''${encodeURIComponent(evidence.originalName).replace(/'/g, '%27')}`);
    c.header('Content-Length', String(evidence.byteSize));
    return c.body(bytes);
  });
  app.post('/v1/sync_push', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    const operations = parsePush(value);
    if (!operations) return c.json({ code: 'invalid_request', message: 'Informe de 1 a 100 operações v1 com identificadores válidos.' }, 400);
    const receipts = [];
    // Each command is its own transaction. A lost batch response is recovered by retrying unchanged operations.
    for (const operation of operations) {
      const { data, error } = await c.get('supabase').rpc('sync_push', { p_operation: operation });
      if (error) {
        const failure = rpcError(error.code);
        return c.json({ code: failure.code, message: failure.message }, failure.status);
      }
      if (!isPushReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'Resposta inesperada; consulte o estado do comando antes de repetir.' }, 503);
      receipts.push(data);
    }
    return c.json({ receipts });
  });
  app.post('/v1/sync_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId', 'cursor']) || !isUuid(value.groupId) || !isCursor(value.cursor)) {
      return c.json({ code: 'invalid_request', message: 'Informe o grupo e um cursor inteiro não negativo.' }, 400);
    }
    const { data, error } = await c.get('supabase').rpc('sync_pull', { p_group_id: value.groupId, p_cursor: value.cursor });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    return c.json(data);
  });
  app.get('/v1/command_status', async c => {
    const key = c.req.query('idempotencyKey');
    if (!isUuid(key)) return c.json({ code: 'invalid_request', message: 'Chave de idempotência inválida.' }, 400);
    const { data, error } = await c.get('supabase').rpc('command_status', { p_idempotency_key: key });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (data === null) return c.json({ code: 'command_not_found', message: 'Comando ainda não recebido para esta conta.' }, 404);
    if (!isPushReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'Resposta inesperada do servidor.' }, 503);
    return c.json(data);
  });
  app.get('/v1/groups', async c => {
    const { data, error } = await c.get('supabase').rpc('sync_groups');
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    return c.json(data);
  });
  app.post('/v1/review_decide', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (isObject(value) && isObject(value.command) && isObject(value.command.action) && value.command.action.type === 'registration_confirm') {
      const command = parseRegistrationReview(value);
      if (!command) return c.json({ code: 'invalid_request', message: 'Informe um checklist observado válido para revisão humana.' }, 400);
      const { data, error } = await c.get('supabase').rpc('registration_decide', { p_command: command });
      if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
      if (!isRegistrationReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'A conferência do registro não pôde ser verificada; consulte o comando.' }, 503);
      return c.json(data);
    }
    if (isObject(value) && isObject(value.command) && isObject(value.command.action)
      && ['result_manual', 'result_resolve', 'calendar_confirm'].includes(String(value.command.action.type))) {
      const command = parseResultReview(value);
      if (!command) return c.json({ code: 'invalid_request', message: 'Informe um resultado ou calendário válido para revisão humana.' }, 400);
      const { data, error } = await c.get('supabase').rpc('result_decide', { p_command: command });
      if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
      if (!isResultReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'A decisão de resultado não pôde ser verificada; consulte o comando.' }, 503);
      return c.json(data);
    }
    if (isObject(value) && isObject(value.command) && isObject(value.command.action)
      && SETTLEMENT_ACTION_TYPES.includes(String(value.command.action.type))) {
      const command = parseSettlementReview(value);
      if (!command) return c.json({ code: 'invalid_request', message: 'Informe uma apuração válida para revisão humana.' }, 400);
      const { data, error } = await c.get('supabase').rpc('settlement_decide', { p_command: command });
      if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
      if (!isSettlementReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'A decisão de apuração não pôde ser verificada; consulte o comando.' }, 503);
      return c.json(data);
    }
    if (isObject(value) && isObject(value.command) && isObject(value.command.action)
      && ['plan_apply', 'pool_lock'].includes(String(value.command.action.type))) {
      const command = parsePlanningReview(value);
      if (!command) return c.json({ code: 'invalid_request', message: 'Informe um plano ou trava válido para revisão humana.' }, 400);
      const { data, error } = await c.get('supabase').rpc('planning_decide', { p_command: command });
      if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
      if (!isPlanningReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'Não foi possível verificar a decisão de planejamento; consulte o estado do comando.' }, 503);
      return c.json(data);
    }
    const command = parseFinancialReview(value);
    if (!command) return c.json({ code: 'invalid_request', message: 'Informe um comando financeiro v1 válido para revisão humana.' }, 400);
    const { data, error } = await c.get('supabase').rpc('review_decide', { p_command: command });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isFinancialReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'Não foi possível verificar a resposta financeira; consulte o estado do comando.' }, 503);
    return c.json(data);
  });
  app.post('/v1/finance_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) {
      return c.json({ code: 'invalid_request', message: 'Informe um grupo válido para consultar as finanças.' }, 400);
    }
    const { data, error } = await c.get('supabase').rpc('finance_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isFinancialSnapshot(data)) return c.json({ code: 'invalid_backend_response', message: 'O retrato financeiro não pôde ser verificado; preserve os dados locais.' }, 503);
    return c.json(data);
  });
  app.get('/v1/finance_command_status', async c => {
    const key = c.req.query('idempotencyKey');
    if (!isUuid(key)) return c.json({ code: 'invalid_request', message: 'Chave de idempotência inválida.' }, 400);
    const { data, error } = await c.get('supabase').rpc('finance_command_status', { p_idempotency_key: key });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (data === null) return c.json({ code: 'command_not_found', message: 'Comando financeiro ainda não recebido para esta conta.' }, 404);
    if (!isFinancialReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'Não foi possível verificar o recibo financeiro.' }, 503);
    return c.json(data);
  });
  app.post('/v1/plan_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) {
      return c.json({ code: 'invalid_request', message: 'Informe um grupo válido para consultar planos e manifestos.' }, 400);
    }
    const { data, error } = await c.get('supabase').rpc('plan_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isPlanningSnapshot(data)) return c.json({ code: 'invalid_backend_response', message: 'O retrato de planos não pôde ser verificado; preserve os dados locais.' }, 503);
    return c.json(data);
  });
  app.get('/v1/plan_command_status', async c => {
    const key = c.req.query('idempotencyKey');
    if (!isUuid(key)) return c.json({ code: 'invalid_request', message: 'Chave de idempotência inválida.' }, 400);
    const { data, error } = await c.get('supabase').rpc('plan_command_status', { p_idempotency_key: key });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (data === null) return c.json({ code: 'command_not_found', message: 'Comando de planejamento ainda não recebido para esta conta.' }, 404);
    if (!isPlanningReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'Não foi possível verificar o recibo de planejamento.' }, 503);
    return c.json(data);
  });
  app.post('/v1/settlement_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) return c.json({ code: 'invalid_request', message: 'Informe um grupo válido para consultar a apuração.' }, 400);
    const { data, error } = await c.get('supabase').rpc('settlement_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isSettlementSnapshot(data)) return c.json({ code: 'invalid_backend_response', message: 'O retrato da apuração não pôde ser verificado; preserve os dados locais.' }, 503);
    return c.json(data);
  });
  app.get('/v1/settlement_command_status', async c => {
    const key = c.req.query('idempotencyKey');
    if (!isUuid(key)) return c.json({ code: 'invalid_request', message: 'Chave de idempotência inválida.' }, 400);
    const { data, error } = await c.get('supabase').rpc('settlement_command_status', { p_idempotency_key: key });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (data === null) return c.json({ code: 'command_not_found', message: 'Decisão de apuração ainda não recebida para esta conta.' }, 404);
    if (!isSettlementReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'O recibo da apuração não pôde ser verificado.' }, 503);
    return c.json(data);
  });
  app.post('/v1/results_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) return c.json({ code: 'invalid_request', message: 'Informe um grupo válido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('results_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isResultSnapshot(data)) return c.json({ code: 'invalid_backend_response', message: 'A fonte de resultados não pôde ser verificada; preserve a última versão válida.' }, 503);
    return c.json(data);
  });
  app.post('/v1/registration_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) return c.json({ code: 'invalid_request', message: 'Informe um grupo válido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('registration_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isRegistrationSnapshot(data)) return c.json({ code: 'invalid_backend_response', message: 'O histórico de registro não pôde ser verificado; preserve os dados locais.' }, 503);
    return c.json(data);
  });
  app.get('/v1/registration_command_status', async c => {
    const key = c.req.query('idempotencyKey');
    if (!isUuid(key)) return c.json({ code: 'invalid_request', message: 'Chave de idempotência inválida.' }, 400);
    const { data, error } = await c.get('supabase').rpc('registration_command_status', { p_idempotency_key: key });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!data) return c.json({ code: 'command_not_found', message: 'Conferência ainda não recebida para esta conta.' }, 404);
    if (!isRegistrationReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'O recibo da conferência não pôde ser verificado.' }, 503);
    return c.json(data);
  });
  app.get('/v1/result_command_status', async c => {
    const key = c.req.query('idempotencyKey');
    if (!isUuid(key)) return c.json({ code: 'invalid_request', message: 'Chave de idempotência inválida.' }, 400);
    const { data, error } = await c.get('supabase').rpc('result_command_status', { p_idempotency_key: key });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!data) return c.json({ code: 'command_not_found', message: 'Decisão de resultado ainda não recebida para esta conta.' }, 404);
    if (!isResultReceipt(data)) return c.json({ code: 'invalid_backend_response', message: 'O recibo de resultado não pôde ser verificado.' }, 503);
    return c.json(data);
  });
  app.post('/v1/results_collect', async c => {
    if (!server) return c.json({ code: 'results_server_unconfigured', message: 'A capacidade privada de coleta oficial ainda não está configurada.' }, 503);
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId', 'poolId']) || !isUuid(value.groupId) || !isUuid(value.poolId)) return c.json({ code: 'invalid_request', message: 'Informe grupo e bolão válidos.' }, 400);
    const context = await c.get('supabase').rpc('result_collection_context', { p_group_id: value.groupId, p_pool_id: value.poolId });
    if (context.error) { const failure = rpcError(context.error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    try {
      const snapshot = await collectOfficialResult(server, c.get('actorId'), context.data as CollectionContext);
      if (!isResultSnapshot(snapshot)) return c.json({ code: 'invalid_backend_response', message: 'A coleta não pôde ser verificada; preserve a última versão válida.' }, 503);
      return c.json(snapshot);
    } catch (error) {
      if (error instanceof ResultCollectionFailure) return c.json({ code: error.code, message: error.message }, 503);
      throw error;
    }
  });
  app.post('/v1/jobs/results_collect_due', async c => {
    if (!server) return c.json({ code: 'results_job_unconfigured', message: 'Coleta agendada não configurada.' }, 503);
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['limit']) || !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 20) return c.json({ code: 'invalid_request', message: 'Informe um limite entre 1 e 20 concursos.' }, 400);
    const due = await server.rpc('result_jobs_due', { p_limit: value.limit });
    if (due.error || !Array.isArray(due.data)) return c.json({ code: 'jobs_unavailable', message: 'Não foi possível consultar os concursos devidos.' }, 503);
    const outcomes = await Promise.all(due.data.map(async job => {
      try {
        const snapshot = await collectOfficialResult(server, job.actorId, job as CollectionContext);
        return { poolId: job.poolId, status: isResultSnapshot(snapshot) ? 'collected' : 'invalid-backend' };
      } catch (error) { return { poolId: job.poolId, status: error instanceof ResultCollectionFailure ? error.code : 'unavailable' }; }
    }));
    return c.json({ outcomes });
  });
  app.post('/v1/participant_link', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId', 'personId']) || !isUuid(value.groupId) || !isUuid(value.personId)) {
      return c.json({ code: 'invalid_request', message: 'Informe o grupo e a pessoa do link.' }, 400);
    }
    const { token, tokenHash } = await createParticipantToken();
    const { data, error } = await c.get('supabase').rpc('participant_link_create', { p_group_id: value.groupId, p_person_id: value.personId, p_token_hash: tokenHash });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isObject(data) || !isUuid(data.id) || data.personId !== value.personId || typeof data.createdAt !== 'string') return c.json({ code: 'invalid_backend_response', message: 'O link não pôde ser confirmado; crie outro.' }, 503);
    return c.json({ id: data.id, personId: data.personId, createdAt: data.createdAt, token }, 201);
  });
  app.post('/v1/participant_link_revoke', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId', 'id']) || !isUuid(value.groupId) || !isUuid(value.id)) {
      return c.json({ code: 'invalid_request', message: 'Informe o grupo e o link a cancelar.' }, 400);
    }
    const { data, error } = await c.get('supabase').rpc('participant_link_revoke', { p_group_id: value.groupId, p_id: value.id });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isObject(data) || data.id !== value.id || typeof data.revokedAt !== 'string') return c.json({ code: 'invalid_backend_response', message: 'O cancelamento não pôde ser confirmado; repita.' }, 503);
    return c.json({ id: data.id, revokedAt: data.revokedAt });
  });
  app.post('/v1/participant_links_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) return c.json({ code: 'invalid_request', message: 'Informe um grupo válido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('participant_links_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isObject(data) || !Array.isArray(data.links) || !data.links.every(isParticipantLink)) return c.json({ code: 'invalid_backend_response', message: 'Os links não puderam ser verificados.' }, 503);
    return c.json({ links: data.links });
  });
  // Phones are organizer-only: never part of a link, the participant card, a manifest or an export.
  app.get('/v1/groups/:groupId/phones', async c => {
    const groupId = c.req.param('groupId');
    if (!isUuid(groupId)) return c.json({ code: 'invalid_request', message: 'Informe um grupo válido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('person_phones_pull', { p_group_id: groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isObject(data) || !Array.isArray(data.phones) || !data.phones.every(isPersonPhone)) return c.json({ code: 'invalid_backend_response', message: 'Os telefones não puderam ser verificados.' }, 503);
    return c.json({ phones: data.phones });
  });
  app.put('/v1/groups/:groupId/persons/:personId/phone', async c => {
    const groupId = c.req.param('groupId'); const personId = c.req.param('personId');
    if (!isUuid(groupId) || !isUuid(personId)) return c.json({ code: 'invalid_request', message: 'Informe o grupo e a pessoa do telefone.' }, 400);
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['phone']) || !isPhone(value.phone)) return c.json({ code: 'invalid_phone', message: 'Telefone inválido: use só números, com DDI e DDD.' }, 400);
    const { data, error } = await c.get('supabase').rpc('person_phone_set', { p_group_id: groupId, p_person_id: personId, p_phone: value.phone });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isPersonPhone(data) || data.personId !== personId || data.phone !== value.phone) return c.json({ code: 'invalid_backend_response', message: 'O telefone não pôde ser confirmado; repita.' }, 503);
    return c.json({ personId: data.personId, phone: data.phone });
  });
  app.delete('/v1/groups/:groupId/persons/:personId/phone', async c => {
    const groupId = c.req.param('groupId'); const personId = c.req.param('personId');
    if (!isUuid(groupId) || !isUuid(personId)) return c.json({ code: 'invalid_request', message: 'Informe o grupo e a pessoa do telefone.' }, 400);
    const { data, error } = await c.get('supabase').rpc('person_phone_clear', { p_group_id: groupId, p_person_id: personId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isObject(data) || data.personId !== personId) return c.json({ code: 'invalid_backend_response', message: 'A remoção não pôde ser confirmada; repita.' }, 503);
    return c.body(null, 204);
  });
  // The token travels in the body, never in the URL, so gateway logs never see it.
  app.post('/v1/participant_card', async c => {
    if (!server) return c.json({ code: 'participant_card_unconfigured', message: 'O cartão do participante ainda não está configurado no servidor.' }, 503);
    const value: unknown = await c.req.json().catch(() => null);
    // The PIN is optional; any other shape of the body is treated like an unknown link, before the database.
    const valid = isObject(value) && (exactKeys(value, ['token']) || (exactKeys(value, ['token', 'pin']) && typeof value.pin === 'string'));
    const tokenHash = valid ? await participantTokenHash(value.token) : null;
    if (!valid || !tokenHash) return c.json({ code: 'link_unknown', message: 'Este link não existe. Peça um novo ao organizador.' }, 404);
    const { data, error } = await server.rpc('participant_card_open', { p_token_hash: tokenHash, p_pin: typeof value.pin === 'string' ? value.pin : null });
    if (error) return c.json({ code: 'backend_unavailable', message: 'Não foi possível abrir o cartão agora; tente de novo.' }, 503);
    const failure = participantFailure(data);
    if (failure) return c.json(failure.body, failure.status);
    if (isObject(data) && data.error === 'pin_required') return c.json({ code: 'pin_required', message: 'Este cartão tem PIN.' }, 401);
    if (!isParticipantCard(data)) return c.json({ code: 'invalid_backend_response', message: 'O cartão não pôde ser verificado; tente de novo.' }, 503);
    return c.json(data);
  });
  // Sets, changes or removes (pin null) the card PIN. The current PIN is needed once one exists; the token and PINs travel in the body only.
  app.post('/v1/participant_pin', async c => {
    if (!server) return c.json({ code: 'participant_card_unconfigured', message: 'O cartão do participante ainda não está configurado no servidor.' }, 503);
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['token', 'pin', 'currentPin'])) return c.json({ code: 'invalid_request', message: 'Use um PIN de 4 números.' }, 400);
    const tokenHash = await participantTokenHash(value.token);
    if (!tokenHash) return c.json({ code: 'link_unknown', message: 'Este link não existe. Peça um novo ao organizador.' }, 404);
    if (!(value.pin === null || isPin(value.pin)) || !(value.currentPin === null || isPin(value.currentPin))) {
      return c.json({ code: 'invalid_request', message: 'Use um PIN de 4 números.' }, 400);
    }
    const { data, error } = await server.rpc('participant_pin_set', { p_token_hash: tokenHash, p_pin: value.pin, p_current_pin: value.currentPin });
    if (error) return c.json({ code: 'backend_unavailable', message: 'Não foi possível salvar o PIN agora; tente de novo.' }, 503);
    const failure = participantFailure(data);
    if (failure) return c.json(failure.body, failure.status);
    if (isObject(data) && data.error === 'pin_invalid') return c.json({ code: 'invalid_request', message: 'Use um PIN de 4 números.' }, 400);
    if (isObject(data) && data.error === 'pin_required') return c.json({ code: 'pin_required', message: 'Digite o PIN atual.' }, 401);
    if (!isObject(data) || !exactKeys(data, ['pinSet']) || typeof data.pinSet !== 'boolean' || data.pinSet !== (value.pin !== null)) {
      return c.json({ code: 'invalid_backend_response', message: 'O PIN não pôde ser confirmado; tente de novo.' }, 503);
    }
    return c.json({ pinSet: data.pinSet });
  });
  // An answer through the card (in, out, or paid with the amount), without a proof. A replayed idempotency key returns the first answer.
  app.post('/v1/participant_respond', async c => {
    if (!server) return c.json({ code: 'participant_card_unconfigured', message: 'O cartão do participante ainda não está configurado no servidor.' }, 503);
    const answer = parseAnswer(await c.req.json().catch(() => null), true);
    if (!answer) return c.json({ code: 'invalid_request', message: 'Resposta inválida.' }, 400);
    const tokenHash = await participantTokenHash(answer.token);
    if (!tokenHash) return c.json({ code: 'link_unknown', message: 'Este link não existe. Peça um novo ao organizador.' }, 404);
    const { data, error } = await server.rpc('participant_respond', { p_token_hash: tokenHash, p_pin: answer.pin, p_pool_id: answer.poolId, p_kind: answer.kind,
      p_amount_cents: answer.amountCents, p_proof: null, p_idempotency_key: answer.idempotencyKey });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    const failure = answerFailure(data);
    if (failure) return c.json(failure.body, failure.status);
    if (!isObject(data) || typeof data.repeated !== 'boolean' || !isAnswerOf(data.response, answer)) return c.json({ code: 'invalid_backend_response', message: 'A resposta não pôde ser confirmada; tente de novo.' }, 503);
    return c.json({ response: data.response });
  });
  // 'paid' with the proof file: the link, PIN and pool are checked before the file is stored under the group, then the answer and the proof are recorded together.
  app.post('/v1/participant_proof', async c => {
    if (!server) return c.json({ code: 'participant_card_unconfigured', message: 'O cartão do participante ainda não está configurado no servidor.' }, 503);
    const form = await c.req.raw.formData().catch(() => null);
    if (!form || [...form.keys()].length !== 2 || !form.has('metadata') || !form.has('original')) return c.json({ code: 'invalid_request', message: 'Envie os dados da resposta e o comprovante.' }, 400);
    const metadataText = form.get('metadata'); const original = form.get('original');
    if (typeof metadataText !== 'string' || !(original instanceof Blob)) return c.json({ code: 'invalid_request', message: 'Dados da resposta ou comprovante inválidos.' }, 400);
    let metadata: unknown = null;
    try { metadata = JSON.parse(metadataText); } catch { /* answered below as an invalid request */ }
    const answer = parseAnswer(metadata, false);
    if (!answer) return c.json({ code: 'invalid_request', message: 'Resposta inválida.' }, 400);
    const tokenHash = await participantTokenHash(answer.token);
    if (!tokenHash) return c.json({ code: 'link_unknown', message: 'Este link não existe. Peça um novo ao organizador.' }, 404);
    if (original.size < 1 || original.size > MAX_ORIGINAL_BYTES) return c.json({ code: 'original_size_mismatch', message: 'O comprovante está vazio ou passa de 10 MiB.' }, 400);
    const bytes = new Uint8Array(await original.arrayBuffer());
    const mimeType = evidenceMime(bytes);
    if (!mimeType) return c.json({ code: 'original_type_mismatch', message: 'Envie o comprovante em PDF, JPG, PNG ou WEBP.' }, 400);
    const sha256 = await hashBytes(bytes);
    const context = await server.rpc('participant_proof_context', { p_token_hash: tokenHash, p_pin: answer.pin, p_pool_id: answer.poolId, p_idempotency_key: answer.idempotencyKey });
    if (context.error) { const failure = rpcError(context.error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    const refused = answerFailure(context.data);
    if (refused) return c.json(refused.body, refused.status);
    // Already answered with this key: nothing is uploaded again; the same key with another pool or amount is refused like the database does.
    if (isObject(context.data) && context.data.repeated === true) {
      if (!isParticipantResponse(context.data.response)) return c.json({ code: 'invalid_backend_response', message: 'A resposta não pôde ser confirmada; tente de novo.' }, 503);
      if (!isAnswerOf(context.data.response, answer)) return c.json({ code: 'invalid_request', message: 'Esta resposta já foi enviada com outros dados.' }, 400);
      return c.json({ response: context.data.response });
    }
    if (!isObject(context.data) || !isUuid(context.data.groupId)) return c.json({ code: 'invalid_backend_response', message: 'O destino do comprovante não pôde ser verificado.' }, 503);
    const proofId = crypto.randomUUID();
    const storagePath = `${context.data.groupId}/${proofId}.${PROOF_EXTENSION[mimeType]}`;
    const uploaded = await server.storage.from('participant-proofs').upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (uploaded.error) return c.json({ code: 'original_upload_unavailable', message: 'O comprovante não foi enviado; tente de novo.' }, 503);
    const { data, error } = await server.rpc('participant_respond', { p_token_hash: tokenHash, p_pin: answer.pin, p_pool_id: answer.poolId, p_kind: 'paid',
      p_amount_cents: answer.amountCents, p_proof: { id: proofId, sha256, mimeType, byteSize: bytes.length, storagePath }, p_idempotency_key: answer.idempotencyKey });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    const failure = answerFailure(data);
    if (failure) return c.json(failure.body, failure.status);
    // A repeated answer (the same key arrived twice at once) keeps the first proof; a new one must name this proof.
    if (!isObject(data) || typeof data.repeated !== 'boolean' || !isAnswerOf(data.response, answer) || (!data.repeated && data.response.proofId !== proofId)) {
      return c.json({ code: 'invalid_backend_response', message: 'A resposta não pôde ser confirmada; tente de novo.' }, 503);
    }
    return c.json({ response: data.response });
  });
  app.get('/v1/participant_proof_download', async c => {
    const id = c.req.query('id');
    if (!isUuid(id)) return c.json({ code: 'invalid_request', message: 'Identificador de comprovante inválido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('participant_proof_status', { p_id: id });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!data) return c.json({ code: 'proof_not_found', message: 'Comprovante indisponível para esta conta.' }, 404);
    if (!isParticipantProofStatus(data) || data.id !== id) return c.json({ code: 'invalid_backend_response', message: 'O comprovante não pôde ser verificado.' }, 503);
    const original = await c.get('supabase').storage.from('participant-proofs').download(data.storagePath);
    if (original.error || !original.data) return c.json({ code: 'original_unavailable', message: 'Não foi possível recuperar o comprovante privado.' }, 503);
    const bytes = new Uint8Array(await original.data.arrayBuffer());
    if (bytes.length !== data.byteSize || evidenceMime(bytes) !== data.mimeType || await hashBytes(bytes) !== data.sha256) {
      return c.json({ code: 'original_integrity_mismatch', message: 'O comprovante recuperado não corresponde ao que foi enviado.' }, 503);
    }
    c.header('Content-Type', data.mimeType);
    c.header('Content-Disposition', `attachment; filename="comprovante.${PROOF_EXTENSION[data.mimeType]}"`);
    c.header('Content-Length', String(data.byteSize));
    return c.body(bytes);
  });
  app.post('/v1/participant_responses_pull', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId']) || !isUuid(value.groupId)) return c.json({ code: 'invalid_request', message: 'Informe um grupo válido.' }, 400);
    const { data, error } = await c.get('supabase').rpc('participant_responses_pull', { p_group_id: value.groupId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isParticipantResponsesPull(data)) return c.json({ code: 'invalid_backend_response', message: 'As respostas não puderam ser verificadas.' }, 503);
    return c.json({ responses: data.responses, reminders: data.reminders });
  });
  app.post('/v1/participant_reminder', async c => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!isObject(value) || !exactKeys(value, ['groupId', 'poolId', 'personId']) || !isUuid(value.groupId) || !isUuid(value.poolId) || !isUuid(value.personId)) {
      return c.json({ code: 'invalid_request', message: 'Informe o grupo, o bolão e a pessoa do lembrete.' }, 400);
    }
    const { data, error } = await c.get('supabase').rpc('participant_reminder_mark', { p_group_id: value.groupId, p_pool_id: value.poolId, p_person_id: value.personId });
    if (error) { const failure = rpcError(error.code); return c.json({ code: failure.code, message: failure.message }, failure.status); }
    if (!isParticipantReminder(data) || data.poolId !== value.poolId || data.personId !== value.personId) return c.json({ code: 'invalid_backend_response', message: 'O lembrete não pôde ser confirmado; repita.' }, 503);
    return c.json({ id: data.id, poolId: data.poolId, personId: data.personId, remindedAt: data.remindedAt });
  });
  app.notFound(c => c.json({ code: 'not_found', message: 'Operação não disponível nesta versão.' }, 404));
  app.onError((error, c) => {
    console.error('api_request_failed', error.name);
    return c.json({ code: 'backend_unavailable', message: 'Falha temporária; preserve as pendências e as chaves de idempotência.' }, 503);
  });
  return app;
}
