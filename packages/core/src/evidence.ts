import type { EvidenceMetadata, EvidenceMimeType, EvidenceUploadMetadata } from './registration-types';
import { planningInt, planningInvalid, planningOption, planningRecord, planningShape, planningText, planningUid } from './prepared-plans';
import { sourceHash, sourceTime } from './source-validation';

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MIME_TYPES: readonly EvidenceMimeType[] = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
export const EVIDENCE_EXTENSIONS: Readonly<Record<EvidenceMimeType, string>> = Object.freeze({
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
});
const metadataFields = ['id', 'groupId', 'poolId', 'sha256', 'mimeType', 'byteSize', 'originalName'];
function metadata(value: Record<string, unknown>): EvidenceUploadMetadata {
  const originalName = planningText(value.originalName, 'originalName', 200, true);
  if ([...originalName].some((character) => character === '/' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || originalName === '.' || originalName === '..') {
    return planningInvalid('originalName', 'Nome original deve ser um nome de arquivo simples.');
  }
  return {
    id: planningUid(value.id, 'id'), groupId: planningUid(value.groupId, 'groupId'), poolId: planningUid(value.poolId, 'poolId'),
    sha256: sourceHash(value.sha256, 'sha256'), mimeType: planningOption(value.mimeType, EVIDENCE_MIME_TYPES, 'mimeType'),
    byteSize: planningInt(value.byteSize, 'byteSize', 1, MAX_EVIDENCE_BYTES), originalName,
  };
}
export function validateEvidenceUploadMetadata(input: unknown): EvidenceUploadMetadata {
  const value = planningRecord(input, 'evidence'); planningShape(value, metadataFields, 'evidence');
  return metadata(value);
}
export function validateEvidenceMetadata(input: unknown): EvidenceMetadata {
  const value = planningRecord(input, 'evidence');
  planningShape(value, [...metadataFields, 'storagePath', 'uploadedByUserId', 'uploadedAt'], 'evidence');
  const normalized = metadata(value);
  const expectedPath = `${normalized.groupId}/${normalized.id}.${EVIDENCE_EXTENSIONS[normalized.mimeType]}`;
  if (value.storagePath !== expectedPath) return planningInvalid('storagePath', 'Objeto privado deve pertencer ao grupo e identificador da evidência.');
  return { ...normalized, storagePath: expectedPath, uploadedByUserId: planningUid(value.uploadedByUserId, 'uploadedByUserId'), uploadedAt: sourceTime(value.uploadedAt, 'uploadedAt') };
}
export const validateConfirmedEvidence = validateEvidenceMetadata;
export async function hashEvidenceBytes(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_EVIDENCE_BYTES) return planningInvalid('bytes', 'Arquivo vazio ou maior que 10 MiB.');
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Signature and bytes are checked without modifying, decoding or executing the original. */
export async function validateEvidenceBytes(bytes: Uint8Array, candidate: EvidenceUploadMetadata): Promise<EvidenceUploadMetadata> {
  const normalized = validateEvidenceUploadMetadata(candidate);
  if (bytes.byteLength !== normalized.byteSize || await hashEvidenceBytes(bytes) !== normalized.sha256) return planningInvalid('bytes', 'Tamanho ou hash não corresponde ao original.');
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
  const valid = normalized.mimeType === 'application/pdf' ? ascii(0, 5) === '%PDF-'
    : normalized.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : normalized.mimeType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
    : ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (!valid) return planningInvalid('mimeType', 'Assinatura do arquivo não corresponde ao tipo declarado.');
  return normalized;
}
