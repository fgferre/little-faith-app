import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EvidenceFailure, evidenceMime, hashBytes, MAX_ORIGINAL_BYTES, uploadOriginal } from './evidence.ts';
import { collectOfficialResult, ResultCollectionFailure, type CollectionContext } from './results.ts';
import { validateEvidenceMetadata, validateEvidenceUploadMetadata } from '../../../packages/core/src/evidence.ts';
import {
  exactKeys, isCursor, isFinancialReceipt, isFinancialSnapshot, isHumanSession, isObject,
  isPlanningReceipt, isPlanningSnapshot, isPushReceipt, isRegistrationReceipt, isRegistrationSnapshot, isResultReceipt, isResultSnapshot, isUuid,
  parseFinancialReview, parsePlanningReview, parsePush, parseRegistrationReview, parseResultReview, readVerifiedTokenClaims,
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
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'authorization, apikey, x-client-info, content-type');
      c.header('Access-Control-Max-Age', '600');
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });
  app.use('*', (c, next) => bodyLimit({ maxSize: c.req.path === '/api/v1/evidence_upload' ? MAX_ORIGINAL_BYTES + 65536 : 1024 * 1024,
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
  app.notFound(c => c.json({ code: 'not_found', message: 'Operação não disponível nesta versão.' }, 404));
  app.onError((error, c) => {
    console.error('api_request_failed', error.name);
    return c.json({ code: 'backend_unavailable', message: 'Falha temporária; preserve as pendências e as chaves de idempotência.' }, 503);
  });
  return app;
}
