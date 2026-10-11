import type { SupabaseClient } from '@supabase/supabase-js';
import type { LotteryId } from '../../../packages/core/src/types.ts';
import { parseCaixaResult, RESULT_SOURCE_URLS } from '../../../packages/core/src/caixa-results.ts';
import { MAX_SOURCE_BYTES } from '../../../packages/core/src/source-validation.ts';
import { isObject, isUuid } from './contract.ts';

export interface CollectionContext { groupId: string; poolId: string; lotteryId: LotteryId; contestNumber: number }
export class ResultCollectionFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function readSourceBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SOURCE_BYTES) { await reader.cancel(); throw new ResultCollectionFailure('source_too_large', 'A fonte oficial excedeu o limite de 1 MiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Only exact configured official endpoints; credentials are never forwarded to the public source. */
export async function collectOfficialResult(server: SupabaseClient, actorId: string, context: CollectionContext): Promise<unknown> {
  if (!isObject(context) || !isUuid(actorId) || !isUuid(context.groupId) || !isUuid(context.poolId)
    || !['mega-sena', 'lotofacil', 'quina'].includes(context.lotteryId)
    || !Number.isSafeInteger(context.contestNumber) || context.contestNumber < 1 || context.contestNumber > 999999) {
    throw new ResultCollectionFailure('invalid_collection_context', 'O servidor não retornou um concurso válido para a coleta.');
  }
  const sourceUrl = `${RESULT_SOURCE_URLS[context.lotteryId]}/${context.contestNumber}`;
  let outcome: 'success' | 'http-error' | 'invalid-source' | 'unavailable' = 'unavailable';
  let errorCode = ''; let rawText: string | null = null;
  let snapshot: unknown; let failure: ResultCollectionFailure | null = null;
  try {
    const response = await fetch(sourceUrl, { headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
    const bytes = await readSourceBytes(response);
    rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!response.ok) { outcome = 'http-error'; errorCode = `http_${response.status}`; throw new ResultCollectionFailure(errorCode, 'A fonte oficial está indisponível; o último resultado válido foi preservado.'); }
    outcome = 'invalid-source';
    const parsed = parseCaixaResult({ lotteryId: context.lotteryId, contestNumber: context.contestNumber, rawText,
      sourceUrl, collectedAt: new Date().toISOString() });
    const sealed = await server.rpc('result_collect_seal', { p_group_id: context.groupId, p_pool_id: context.poolId, p_actor_id: actorId, p_parsed: parsed });
    if (sealed.error) throw new ResultCollectionFailure('collection_seal_failed', 'A coleta não pôde ser registrada; o último resultado válido foi preservado.');
    outcome = 'success';
    snapshot = sealed.data;
  } catch (error) {
    errorCode ||= error instanceof ResultCollectionFailure ? error.code : outcome === 'invalid-source' ? 'invalid_source_format' : 'source_unavailable';
    failure = error instanceof ResultCollectionFailure ? error : new ResultCollectionFailure(errorCode, 'Não foi possível verificar a fonte oficial; o último resultado válido foi preservado.');
  }
  // Attempt history is technical and does not produce an accepted human receipt or a prize.
  const attempted = await server.rpc('result_collection_attempt', { p_group_id: context.groupId, p_pool_id: context.poolId, p_outcome: outcome,
    p_error_code: errorCode, p_source_url: sourceUrl, p_raw_text: rawText });
  if (attempted.error) throw new ResultCollectionFailure('collection_audit_unavailable', 'A tentativa não pôde ser auditada; repita a coleta para reconciliar seu estado.');
  if (failure) throw failure;
  return snapshot;
}
