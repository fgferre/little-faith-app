import { validateEvidenceBytes, validateEvidenceMetadata, validateEvidenceUploadMetadata } from '@bolao/core';
import type { EvidenceMetadata, EvidenceTransport, EvidenceUploadMetadata } from '@bolao/core';
import type { BolaoDatabase, PersistentEvidenceUpload } from './database';
import { sha256Bytes } from './binary';
import { assertApprovalOnline, receiptNotFound, withExplicitDecisionLock } from './explicit-decisions';
import { canonical } from './integrity';

export interface PrepareEvidenceUploadInput {
  id?: string;
  groupId: string;
  poolId: string;
  original: Blob;
  originalName?: string;
}

function uploadMetadata(upload: EvidenceUploadMetadata): EvidenceUploadMetadata {
  return validateEvidenceUploadMetadata({
    id: upload.id, groupId: upload.groupId, poolId: upload.poolId, sha256: upload.sha256,
    mimeType: upload.mimeType, byteSize: upload.byteSize, originalName: upload.originalName,
  });
}

function matchesOriginal(metadata: EvidenceMetadata, upload: EvidenceUploadMetadata): boolean {
  return canonical(uploadMetadata(metadata)) === canonical(uploadMetadata(upload));
}

function assertStoredUpload(db: BolaoDatabase, upload: PersistentEvidenceUpload): EvidenceUploadMetadata {
  if (upload.accountId !== db.accountId || !(upload.original instanceof Blob)) {
    throw new Error('O original desta evidência não pertence à conta selecionada ou está ausente.');
  }
  const metadata = uploadMetadata(upload);
  if (upload.original.size !== metadata.byteSize || upload.original.type !== metadata.mimeType) {
    throw new Error('O tamanho ou tipo do original não corresponde à evidência preparada.');
  }
  return metadata;
}

/** Save the exact original and its digest before any network request or success indicator. */
export async function prepareEvidenceUpload(
  db: BolaoDatabase,
  input: PrepareEvidenceUploadInput,
): Promise<PersistentEvidenceUpload> {
  if (!(input.original instanceof Blob)) throw new Error('Selecione o arquivo original da evidência.');
  const suppliedName = 'name' in input.original && typeof input.original.name === 'string' ? input.original.name : 'evidencia';
  const metadata = validateEvidenceUploadMetadata({
    id: input.id ?? crypto.randomUUID(), groupId: input.groupId, poolId: input.poolId,
    sha256: '0'.repeat(64), mimeType: input.original.type, byteSize: input.original.size,
    originalName: input.originalName ?? suppliedName,
  });
  const original = input.original.slice(0, input.original.size, input.original.type);
  const bytes = await original.arrayBuffer();
  metadata.sha256 = await sha256Bytes(bytes);
  await validateEvidenceBytes(new Uint8Array(bytes), metadata);
  return db.transaction('rw', db.evidenceUploads, db.confirmedEvidence, async () => {
    const existing = await db.evidenceUploads.get(metadata.id);
    if (existing) {
      assertStoredUpload(db, existing);
      if (existing.accountId !== db.accountId || canonical(uploadMetadata(existing)) !== canonical(metadata)) {
        throw new Error('Este identificador já pertence a outro original de evidência.');
      }
      return existing;
    }
    const confirmed = await db.confirmedEvidence.get(metadata.id);
    if (confirmed && (!matchesOriginal(confirmed, metadata) || confirmed.uploadedByUserId !== db.accountId)) {
      throw new Error('Este identificador já pertence a uma evidência confirmada de outra conta ou original.');
    }
    const now = new Date().toISOString();
    const prepared: PersistentEvidenceUpload = {
      ...metadata, accountId: db.accountId, original, status: confirmed ? 'uploaded' : 'prepared',
      ...(confirmed ? { confirmedMetadata: confirmed } : {}),
      attempts: 0, lastError: null, createdAt: now, updatedAt: now,
    };
    await db.evidenceUploads.add(prepared);
    return prepared;
  });
}

/** Caller includes confirmedEvidence and evidenceUploads in the transaction. */
export async function rememberEvidenceMetadataInTransaction(
  db: BolaoDatabase,
  metadata: EvidenceMetadata,
): Promise<void> {
  const existing = await db.confirmedEvidence.get(metadata.id);
  if (existing && canonical(existing) !== canonical(metadata)) {
    throw new Error('O servidor tentou alterar metadados imutáveis de uma evidência.');
  }
  const upload = await db.evidenceUploads.get(metadata.id);
  if (upload) {
    assertStoredUpload(db, upload);
    if (!matchesOriginal(metadata, upload) || metadata.uploadedByUserId !== db.accountId) {
      throw new Error('O retorno de upload não corresponde ao original, grupo, bolão ou conta.');
    }
    if (upload.confirmedMetadata && canonical(upload.confirmedMetadata) !== canonical(metadata)) {
      throw new Error('O servidor tentou alterar a confirmação imutável do upload.');
    }
    await db.evidenceUploads.update(upload.id, {
      status: 'uploaded', confirmedMetadata: metadata, lastError: null, updatedAt: new Date().toISOString(),
    });
  }
  if (!existing) await db.confirmedEvidence.add(metadata);
}

async function persistEvidenceMetadata(
  db: BolaoDatabase,
  upload: PersistentEvidenceUpload,
  input: EvidenceMetadata,
): Promise<EvidenceMetadata> {
  const metadata = validateEvidenceMetadata(input);
  if (!matchesOriginal(metadata, upload) || metadata.uploadedByUserId !== db.accountId) {
    throw new Error('O retorno de upload não corresponde ao original, grupo, bolão ou conta.');
  }
  await db.transaction('rw', db.evidenceUploads, db.confirmedEvidence, async () => {
    const current = await db.evidenceUploads.get(upload.id);
    if (!current || canonical(uploadMetadata(current)) !== canonical(uploadMetadata(upload))) {
      throw new Error('O original local não corresponde ao upload confirmado.');
    }
    await rememberEvidenceMetadataInTransaction(db, metadata);
  });
  return metadata;
}

async function markUploadUnknown(db: BolaoDatabase, id: string, error: unknown): Promise<void> {
  await db.transaction('rw', db.evidenceUploads, async () => {
    const current = await db.evidenceUploads.get(id);
    if (current && current.status !== 'uploaded') {
      await db.evidenceUploads.update(id, {
        status: 'unknown', lastError: error instanceof Error ? error.message : null,
        updatedAt: new Date().toISOString(),
      });
    }
  });
}

async function uploadPreparedEvidence(db: BolaoDatabase, transport: EvidenceTransport, id: string): Promise<EvidenceMetadata> {
  const prepared = await db.evidenceUploads.get(id);
  if (!prepared) throw new Error('O original da evidência não está salvo nesta conta.');
  const metadata = assertStoredUpload(db, prepared);
  if (prepared.status === 'uploaded') {
    if (!prepared.confirmedMetadata) throw new Error('Consulte o servidor para recuperar os metadados do upload.');
    return validateEvidenceMetadata(prepared.confirmedMetadata);
  }
  assertApprovalOnline('o envio da evidência');
  const bytes = await prepared.original.arrayBuffer();
  if (await sha256Bytes(bytes) !== metadata.sha256) {
    throw new Error('O SHA-256 do original não corresponde à evidência preparada; o arquivo não foi enviado.');
  }
  await validateEvidenceBytes(new Uint8Array(bytes), metadata);
  await db.transaction('rw', db.evidenceUploads, async () => {
    const current = await db.evidenceUploads.get(id);
    if (!current || current.status === 'uploading') throw new Error('Esta evidência já está em envio. Consulte o upload antes de repetir.');
    if (current.status !== 'prepared' && current.status !== 'unknown') throw new Error('Este upload já foi concluído.');
    if (canonical(uploadMetadata(current)) !== canonical(metadata)) throw new Error('A evidência preparada foi alterada.');
    await db.evidenceUploads.update(id, {
      status: 'uploading', attempts: current.attempts + 1, lastError: null, updatedAt: new Date().toISOString(),
    });
  });
  try {
    const confirmed = await transport.evidenceUpload(structuredClone(metadata), prepared.original);
    return await persistEvidenceMetadata(db, prepared, confirmed);
  } catch (error) {
    await markUploadUnknown(db, id, error);
    throw error;
  }
}

/** Technical upload only: it never sends registration, financial or planning decisions. */
export function uploadEvidence(db: BolaoDatabase, transport: EvidenceTransport, id: string): Promise<EvidenceMetadata> {
  return withExplicitDecisionLock('evidence-upload', db.name, id, () => uploadPreparedEvidence(db, transport, id));
}

/** GET only; null/404 preserves the original and permits a technical retry with the same id/hash. */
export async function recoverEvidenceUpload(
  db: BolaoDatabase,
  transport: EvidenceTransport,
  id: string,
): Promise<EvidenceMetadata | null> {
  const prepared = await db.evidenceUploads.get(id);
  if (!prepared) throw new Error('O original da evidência não está salvo nesta conta.');
  assertStoredUpload(db, prepared);
  if (prepared.status === 'uploaded') return prepared.confirmedMetadata ?? null;
  assertApprovalOnline('a consulta do upload da evidência');
  try {
    const metadata = await transport.evidenceStatus(id);
    if (!metadata) { await markUploadUnknown(db, id, null); return null; }
    return await persistEvidenceMetadata(db, prepared, metadata);
  } catch (error) {
    await markUploadUnknown(db, id, error);
    if (receiptNotFound(error)) return null;
    throw error;
  }
}

export function listEvidenceUploads(db: BolaoDatabase, groupId: string, poolId: string): Promise<PersistentEvidenceUpload[]> {
  return db.evidenceUploads.where('[groupId+poolId]').equals([groupId, poolId]).toArray();
}

/** Return the original only after checking the stored bytes against the pre-upload digest. */
export async function getEvidenceOriginal(db: BolaoDatabase, id: string): Promise<Blob | null> {
  const upload = await db.evidenceUploads.get(id);
  if (!upload) return null;
  const metadata = assertStoredUpload(db, upload);
  if (await sha256Bytes(await upload.original.arrayBuffer()) !== metadata.sha256) {
    throw new Error('O SHA-256 do original local não corresponde à evidência.');
  }
  return upload.original;
}
