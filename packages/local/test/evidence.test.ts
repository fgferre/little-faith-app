import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON } from '@bolao/core';
import type { EvidenceMetadata, EvidenceTransport, EvidenceUploadMetadata } from '@bolao/core';
import {
  createLocalStore, exportEmergencySnapshot, getEvidenceOriginal, listEvidenceUploads,
  prepareEvidenceUpload, recoverEvidenceUpload, saveDraft, uploadEvidence,
} from '../src';
import type { BolaoDatabase } from '../src';
import { GROUP, id, OTHER_GROUP, OTHER_POOL, POOL, TIME } from './planning-fixtures';

const ACCOUNT = id(200);
const OTHER_ACCOUNT = id(201);
const stores: Dexie[] = [];
function store(accountId = ACCOUNT, installationId: string = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}
function original(text = 'original privado'): Blob { return new Blob([`%PDF-1.7\n${text}`], { type: 'application/pdf' }); }
async function hash(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}
function confirmed(input: EvidenceUploadMetadata, uploadedByUserId = ACCOUNT): EvidenceMetadata {
  return { ...input, storagePath: `${input.groupId}/${input.id}.pdf`, uploadedByUserId, uploadedAt: TIME };
}

class EvidenceServer implements EvidenceTransport {
  readonly payloads = new Map<string, string>();
  readonly files = new Map<string, EvidenceMetadata>();
  readonly requests: EvidenceUploadMetadata[] = [];
  statusCalls = 0;
  loseAfterUpload = false;
  loseBeforeUpload = false;
  return404 = false;
  changeResponse: ((metadata: EvidenceMetadata) => EvidenceMetadata) | null = null;
  async evidenceUpload(metadata: EvidenceUploadMetadata, body: Blob): Promise<EvidenceMetadata> {
    this.requests.push(structuredClone(metadata));
    expect(await hash(body)).toBe(metadata.sha256);
    expect(body.size).toBe(metadata.byteSize);
    const payload = canonicalJSON(metadata);
    const previous = this.payloads.get(metadata.id);
    if (previous && previous !== payload) throw new Error('Identificador de upload reutilizado com outro original.');
    this.payloads.set(metadata.id, payload);
    if (this.loseBeforeUpload) { this.loseBeforeUpload = false; throw new Error('Resposta perdida antes do upload.'); }
    const accepted = this.files.get(metadata.id) ?? confirmed(metadata);
    this.files.set(metadata.id, accepted);
    if (this.loseAfterUpload) { this.loseAfterUpload = false; throw new Error('Resposta perdida depois do upload.'); }
    return this.changeResponse ? this.changeResponse(structuredClone(accepted)) : structuredClone(accepted);
  }
  async evidenceStatus(id: string): Promise<EvidenceMetadata | null> {
    this.statusCalls += 1;
    if (this.return404) throw Object.assign(new Error('Upload ausente.'), { status: 404 });
    return structuredClone(this.files.get(id) ?? null);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

describe('private original evidence persistence', () => {
  it('hashes the original binary bytes before saving and survives reopening', async () => {
    const db = store();
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 1, 13, 10, 200]);
    const blob = new Blob([bytes], { type: 'image/png' });
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: blob, originalName: 'original.png' });
    expect(saved.sha256).toBe(await hash(blob));
    expect(saved).toMatchObject({ accountId: ACCOUNT, status: 'prepared', byteSize: bytes.length, attempts: 0 });
    db.close();
    const reopened = store(db.accountId, db.installationId);
    expect(Array.from(new Uint8Array(await (await getEvidenceOriginal(reopened, saved.id))!.arrayBuffer()))).toEqual(Array.from(bytes));
    expect((await reopened.evidenceUploads.get(saved.id))?.sha256).toBe(saved.sha256);
    expect(await reopened.confirmedEvidence.count()).toBe(0);
    expect(await reopened.operations.count()).toBe(0);
  });

  it('keeps originals isolated by account, group, pool and demonstration bank', async () => {
    const db = store();
    const other = store(OTHER_ACCOUNT, db.installationId);
    const demo = store('demo', db.installationId);
    const one = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    await prepareEvidenceUpload(db, { groupId: OTHER_GROUP, poolId: OTHER_POOL, original: original('Outro grupo') });
    expect((await listEvidenceUploads(db, GROUP, POOL)).map(row => row.id)).toEqual([one.id]);
    expect(await getEvidenceOriginal(other, one.id)).toBeNull();
    expect(await getEvidenceOriginal(demo, one.id)).toBeNull();
    expect(await listEvidenceUploads(db, GROUP, OTHER_POOL)).toEqual([]);
    await expect(uploadEvidence(other, new EvidenceServer(), one.id)).rejects.toThrow('nesta conta');
  });

  it('rejects unsupported, empty and excessive originals before recording success', async () => {
    const db = store();
    for (const blob of [new Blob(['a'], { type: 'text/plain' }), new Blob(['a'], { type: 'image/png' }), new Blob([], { type: 'application/pdf' }), new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'application/pdf' })]) {
      await expect(prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: blob })).rejects.toThrow();
    }
    expect(await db.evidenceUploads.count()).toBe(0);
  });

  it('preserves the same id/hash while refusing a changed file, scope or name', async () => {
    const db = store();
    const input = { id: id(210), groupId: GROUP, poolId: POOL, original: original(), originalName: 'recibo.pdf' };
    const saved = await prepareEvidenceUpload(db, input);
    expect({ ...await prepareEvidenceUpload(db, input), original: null }).toEqual({ ...saved, original: null });
    for (const altered of [{ ...input, original: original('alterado') }, { ...input, groupId: OTHER_GROUP }, { ...input, originalName: 'outro.pdf' }]) {
      await expect(prepareEvidenceUpload(db, altered)).rejects.toThrow('outro original');
    }
    expect(await db.evidenceUploads.count()).toBe(1);
    expect(await (await getEvidenceOriginal(db, saved.id))!.text()).toBe(await input.original.text());
  });

  it('does not declare saved when original persistence fails', async () => {
    const db = store();
    vi.spyOn(db.evidenceUploads, 'add').mockRejectedValueOnce(new Error('Armazenamento insuficiente.'));
    await expect(prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() })).rejects.toThrow('insuficiente');
    expect(await db.evidenceUploads.count()).toBe(0);
  });
});

describe('technical evidence uploads and lost responses', () => {
  it('prohibits offline upload without changing the prepared state', async () => {
    const db = store();
    const server = new EvidenceServer();
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    vi.stubGlobal('navigator', { onLine: false });
    await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow('internet');
    expect(server.requests).toHaveLength(0);
    expect((await db.evidenceUploads.get(saved.id))?.status).toBe('prepared');
  });

  it('recovers a lost uploaded response by GET after reopening and never confirms a registration', async () => {
    const db = store();
    const server = new EvidenceServer();
    const draft = await saveDraft(db, { groupId: GROUP, kind: 'person', data: { name: 'Proposta', nickname: '', adultDeclared: true } });
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    server.loseAfterUpload = true;
    await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow('depois');
    expect((await db.evidenceUploads.get(saved.id))?.status).toBe('unknown');
    expect(await db.confirmedEvidence.count()).toBe(0);
    db.close();
    const reopened = store(db.accountId, db.installationId);
    const metadata = await recoverEvidenceUpload(reopened, server, saved.id);
    expect(metadata?.sha256).toBe(saved.sha256);
    expect((await reopened.evidenceUploads.get(saved.id))?.status).toBe('uploaded');
    expect(await reopened.confirmedEvidence.get(saved.id)).toEqual(metadata);
    expect(server.requests).toHaveLength(1);
    expect(server.statusCalls).toBe(1);
    expect(await reopened.records.get(draft.id)).toEqual(draft);
    expect(await reopened.operations.count()).toBe(1);
    expect(await reopened.registrationReports.count()).toBe(0);
  });

  it('preserves an absent upload and retries technically with the exact same id/hash', async () => {
    const db = store();
    const server = new EvidenceServer();
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    server.loseBeforeUpload = true;
    await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow('antes');
    server.return404 = true;
    expect(await recoverEvidenceUpload(db, server, saved.id)).toBeNull();
    expect((await db.evidenceUploads.get(saved.id))?.status).toBe('unknown');
    server.return404 = false;
    const metadata = await uploadEvidence(db, server, saved.id);
    expect(metadata.id).toBe(saved.id);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toEqual(server.requests[1]);
    expect(await getEvidenceOriginal(db, saved.id)).not.toBeNull();
  });

  it('requires a status lookup after an interrupted uploading state', async () => {
    const db = store();
    const server = new EvidenceServer();
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    await db.evidenceUploads.update(saved.id, { status: 'uploading' });
    await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow('já está em envio');
    expect(server.requests).toHaveLength(0);
    expect(await recoverEvidenceUpload(db, server, saved.id)).toBeNull();
    await uploadEvidence(db, server, saved.id);
    expect(server.requests).toHaveLength(1);
  });

  it('deduplicates concurrent technical uploads and returns the cached metadata offline', async () => {
    const db = store();
    const second = store(db.accountId, db.installationId);
    const server = new EvidenceServer();
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    const [one, two] = await Promise.all([uploadEvidence(db, server, saved.id), uploadEvidence(second, server, saved.id)]);
    expect(one).toEqual(two);
    expect(server.requests).toHaveLength(1);
    vi.stubGlobal('navigator', { onLine: false });
    expect(await uploadEvidence(db, server, saved.id)).toEqual(one);
    expect(await recoverEvidenceUpload(db, server, saved.id)).toEqual(one);
  });

  it('rejects a mismatched original or account without persisting any confirmation', async () => {
    for (const alter of [(data: EvidenceMetadata) => ({ ...data, sha256: '1'.repeat(64) }), (data: EvidenceMetadata) => ({ ...data, uploadedByUserId: OTHER_ACCOUNT }), (data: EvidenceMetadata) => ({ ...data, poolId: OTHER_POOL })]) {
      const db = store();
      const server = new EvidenceServer();
      const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
      server.changeResponse = alter;
      await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow();
      expect(await db.confirmedEvidence.count()).toBe(0);
      expect((await db.evidenceUploads.get(saved.id))?.status).toBe('unknown');
      expect(await getEvidenceOriginal(db, saved.id)).not.toBeNull();
    }
  });

  it('rolls back upload confirmation atomically if storing metadata fails and recovers by GET', async () => {
    const db = store();
    const server = new EvidenceServer();
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    vi.spyOn(db.confirmedEvidence, 'add').mockRejectedValueOnce(new Error('Falha ao persistir confirmação.'));
    await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow('persistir');
    expect((await db.evidenceUploads.get(saved.id))?.status).toBe('unknown');
    expect((await db.evidenceUploads.get(saved.id))?.confirmedMetadata).toBeUndefined();
    expect(await db.confirmedEvidence.count()).toBe(0);
    expect((await recoverEvidenceUpload(db, server, saved.id))?.id).toBe(saved.id);
    expect(server.requests).toHaveLength(1);
  });

  it('detects altered local bytes before upload, preview or emergency export', async () => {
    const db = store();
    const server = new EvidenceServer();
    const saved = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original('AAAA') });
    await db.evidenceUploads.update(saved.id, { original: original('BBBB') });
    await expect(uploadEvidence(db, server, saved.id)).rejects.toThrow('SHA-256');
    await expect(getEvidenceOriginal(db, saved.id)).rejects.toThrow('SHA-256');
    await expect(exportEmergencySnapshot(db)).rejects.toThrow('SHA-256');
    expect(server.requests).toHaveLength(0);
    expect((await db.evidenceUploads.get(saved.id))?.status).toBe('prepared');
  });
});

describe('emergency originals', () => {
  it('exports pending and uploaded originals as verified base64 without losing binary bytes', async () => {
    const db = store();
    const server = new EvidenceServer();
    const bytes = Uint8Array.from({ length: 70_003 }, (_, index) => index % 256);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const pending = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: new Blob([bytes], { type: 'image/png' }) });
    const uploaded = await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: original() });
    await uploadEvidence(db, server, uploaded.id);
    const snapshot = JSON.parse(await exportEmergencySnapshot(db));
    expect(snapshot).toMatchObject({ format: 'bolao-emergency-v5', encrypted: false, accountId: ACCOUNT });
    expect(snapshot.warning).toContain('base64');
    const encoded = snapshot.evidenceUploads.find((row: { id: string }) => row.id === pending.id);
    expect(encoded.status).toBe('prepared');
    expect(encoded.original).toMatchObject({ encoding: 'base64', sha256: pending.sha256, byteSize: bytes.length });
    expect(Uint8Array.from(atob(encoded.original.data), character => character.charCodeAt(0))).toEqual(bytes);
    expect(snapshot.evidenceUploads.find((row: { id: string }) => row.id === uploaded.id).status).toBe('uploaded');
    expect(snapshot.confirmedEvidence).toHaveLength(1);
  });
});
