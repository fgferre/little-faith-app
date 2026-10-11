import type { SupabaseClient } from '@supabase/supabase-js';
import type { EvidenceMetadata, EvidenceMimeType, EvidenceUploadMetadata } from '../../../packages/core/src/registration-types.ts';
import { validateEvidenceMetadata } from '../../../packages/core/src/evidence.ts';

export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

/** Signature detection only: the server does not execute or parse uploaded documents. */
export function evidenceMime(bytes: Uint8Array): EvidenceMimeType | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export class EvidenceFailure extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 409 | 503, message: string) { super(message); }
}

function boundEvidence(value: unknown, expected: EvidenceUploadMetadata, actorId: string): EvidenceMetadata {
  try {
    const evidence = validateEvidenceMetadata(value);
    if (evidence.id !== expected.id || evidence.groupId !== expected.groupId || evidence.poolId !== expected.poolId
      || evidence.sha256 !== expected.sha256 || evidence.mimeType !== expected.mimeType || evidence.byteSize !== expected.byteSize
      || evidence.originalName !== expected.originalName || evidence.uploadedByUserId !== actorId) throw new Error('Unbound original.');
    return evidence;
  } catch { throw new EvidenceFailure('invalid_backend_response', 503, 'O selo retornado não corresponde ao original desta conta.'); }
}

export async function uploadOriginal(
  human: SupabaseClient, server: SupabaseClient, actorId: string,
  metadata: EvidenceUploadMetadata, original: Blob,
): Promise<EvidenceMetadata> {
  if (original.size !== metadata.byteSize || original.size < 1 || original.size > MAX_ORIGINAL_BYTES) {
    throw new EvidenceFailure('original_size_mismatch', 400, 'O tamanho do original não corresponde aos metadados ou excede 10 MiB.');
  }
  const bytes = new Uint8Array(await original.arrayBuffer());
  if (evidenceMime(bytes) !== metadata.mimeType) throw new EvidenceFailure('original_type_mismatch', 400, 'A assinatura do original não corresponde ao tipo informado.');
  if (await hashBytes(bytes) !== metadata.sha256) throw new EvidenceFailure('original_hash_mismatch', 400, 'O hash do original não corresponde ao arquivo enviado.');
  const context = await human.rpc('evidence_upload_context', { p_metadata: metadata });
  if (context.error) throw new EvidenceFailure('evidence_scope_denied', context.error.code === '42501' ? 403 : 409, 'O grupo, bolão ou identificador do original não permite este upload.');
  if (!context.data || typeof context.data.storagePath !== 'string') throw new EvidenceFailure('invalid_backend_response', 503, 'Não foi possível verificar o destino privado do original.');
  if (context.data.evidence) return boundEvidence(context.data.evidence, metadata, actorId);
  const path = context.data.storagePath as string;
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[metadata.mimeType];
  if (path !== `${metadata.groupId}/${metadata.id}.${extension}`) throw new EvidenceFailure('invalid_backend_response', 503, 'O destino privado não corresponde ao original.');
  const uploaded = await human.storage.from('evidence').upload(path, bytes, { contentType: metadata.mimeType, upsert: false });
  if (uploaded.error && !(uploaded.error.statusCode === '409'
    || (uploaded.error.statusCode === '400' && /already exists|duplicate/i.test(uploaded.error.message)))) {
    throw new EvidenceFailure('original_upload_unavailable', 503, 'O original não foi selado; repita com o mesmo identificador e arquivo.');
  }
  // Read the immutable stored original, including recovery after an interrupted upload.
  const downloaded = await human.storage.from('evidence').download(path);
  if (downloaded.error || !downloaded.data) throw new EvidenceFailure('original_verification_unavailable', 503, 'O original privado precisa de nova verificação; preserve o arquivo local.');
  const stored = new Uint8Array(await downloaded.data.arrayBuffer());
  if (stored.length !== metadata.byteSize || evidenceMime(stored) !== metadata.mimeType || await hashBytes(stored) !== metadata.sha256) {
    throw new EvidenceFailure('stored_original_mismatch', 409, 'Esse identificador já contém outro original; ele não será substituído.');
  }
  const sealed = await server.rpc('evidence_seal', { p_metadata: metadata, p_actor_id: actorId });
  if (sealed.error) throw new EvidenceFailure('original_seal_unavailable', sealed.error.code === '42501' ? 403 : 503, 'O original foi enviado, mas seu selo não foi confirmado; repita com os mesmos dados.');
  return boundEvidence(sealed.data, metadata, actorId);
}
