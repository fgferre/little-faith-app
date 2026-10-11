import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftOperation, LocalRecord, PushReceipt, SyncChange } from '@bolao/core';
import {
  createLocalStore, exportEmergencySnapshot, getSyncSummary, listRecords,
  resetSyncCursor, resolveConflict, saveDraft, sync,
} from '../src';
import type { BolaoDatabase, LocalSyncTransport } from '../src';

const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const PERSON_1 = '33333333-3333-4333-8333-333333333333';
const PERSON_2 = '44444444-4444-4444-8444-444444444444';
const PERSON_3 = '55555555-5555-4555-8555-555555555555';
const POOL_A = '66666666-6666-4666-8666-666666666666';

const stores: BolaoDatabase[] = [];
function store(accountId = 'account-a', installationId = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const person = (name: string) => ({ name, nickname: '', adultDeclared: true });

class MemoryServer implements LocalSyncTransport {
  readonly records = new Map<string, LocalRecord>();
  readonly receipts = new Map<string, PushReceipt>();
  readonly changes = new Map<string, SyncChange[]>();
  readonly requests: DraftOperation[] = [];
  readonly payloads = new Map<string, string>();
  readonly pullCursors: number[] = [];
  loseResponse = false;
  pageSize = 2;
  beforePush: (() => Promise<void>) | null = null;
  beforePull: (() => Promise<void>) | null = null;

  seed(record: LocalRecord): void {
    const changes = this.changes.get(record.groupId) ?? [];
    const groupRevision = (changes.at(-1)?.groupRevision ?? 0) + 1;
    this.records.set(record.id, structuredClone(record));
    changes.push({ groupRevision, record: structuredClone(record) });
    this.changes.set(record.groupId, changes);
  }

  async listGroupIds(): Promise<string[]> { return [...this.changes.keys()]; }
  async commandStatus(key: string): Promise<PushReceipt | null> { return this.receipts.get(key) ?? null; }

  async push(operations: DraftOperation[]): Promise<PushReceipt[]> {
    if (this.beforePush) await this.beforePush();
    const result: PushReceipt[] = [];
    for (const operation of operations) {
      this.requests.push(structuredClone(operation));
      const payload = JSON.stringify(operation);
      const originalPayload = this.payloads.get(operation.idempotencyKey);
      if (originalPayload && originalPayload !== payload) throw new Error('idempotency payload changed');
      this.payloads.set(operation.idempotencyKey, payload);
      const existingReceipt = this.receipts.get(operation.idempotencyKey);
      if (existingReceipt) { result.push(structuredClone(existingReceipt)); continue; }
      const current = this.records.get(operation.entityId);
      const version = current?.serverVersion ?? 0;
      let receipt: PushReceipt;
      if (operation.expectedVersion !== version) {
        receipt = {
          idempotencyKey: operation.idempotencyKey, status: 'conflict', entityId: operation.entityId,
          serverVersion: version, groupRevision: this.changes.get(operation.groupId)?.at(-1)?.groupRevision ?? 0,
          message: 'O registro foi alterado em outro aparelho.', record: current ?? null,
        };
      } else {
        const record: LocalRecord = {
          id: operation.entityId, groupId: operation.groupId, kind: operation.kind, data: structuredClone(operation.data),
          localVersion: 0, serverVersion: version + 1, state: 'synced',
          createdAt: current?.createdAt ?? operation.createdAt, updatedAt: new Date().toISOString(),
        };
        this.seed(record);
        receipt = {
          idempotencyKey: operation.idempotencyKey, status: 'accepted', entityId: operation.entityId,
          serverVersion: record.serverVersion, groupRevision: this.changes.get(operation.groupId)?.at(-1)?.groupRevision ?? 0,
          message: null, record,
        };
      }
      this.receipts.set(operation.idempotencyKey, structuredClone(receipt));
      result.push(receipt);
    }
    if (this.loseResponse) { this.loseResponse = false; throw new Error('A conexão caiu depois de aceitar.'); }
    return structuredClone(result);
  }

  async pull(groupId: string, cursor: number) {
    this.pullCursors.push(cursor);
    if (this.beforePull) await this.beforePull();
    const changes = (this.changes.get(groupId) ?? []).filter(change => change.groupRevision > cursor);
    const page = changes.slice(0, this.pageSize);
    return {
      groupId, changes: structuredClone(page), nextCursor: page.at(-1)?.groupRevision ?? cursor,
      hasMore: changes.length > page.length,
    };
  }
}

function remotePerson(id: string, groupId: string, name: string, serverVersion = 1): LocalRecord<'person'> {
  return {
    id, groupId, kind: 'person', data: person(name), serverVersion, localVersion: 0, state: 'synced',
    createdAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

describe('persistent local drafts', () => {
  it('recovers the record and exact operation after closing and reopening', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    const operation = (await db.operations.toArray())[0];
    db.close();
    const reopened = store('account-a', installationId);
    expect(await listRecords(reopened, 'person', GROUP_A)).toEqual([draft]);
    expect(await reopened.operations.toArray()).toEqual([operation]);
    expect(await getSyncSummary(reopened)).toEqual({ pending: 1, conflicts: 0, lastSyncAt: null });
  });

  it('rolls back the record and sequence when saving its outbox entry fails', async () => {
    const db = store();
    db.operations.hook('creating', () => { throw new Error('Armazenamento cheio.'); });
    await expect(saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') }))
      .rejects.toThrow('Armazenamento cheio.');
    expect(await db.records.count()).toBe(0);
    expect(await db.operations.count()).toBe(0);
    expect(await db.metadata.get('outboxSequence')).toBeUndefined();
  });

  it('isolates accounts, the demo, installations and encoded database names', async () => {
    const installationId = crypto.randomUUID();
    const real = store('account-a', installationId);
    const other = store('account-b', installationId);
    const demo = store('demo', installationId);
    const secondInstallation = store('account-a');
    await saveDraft(real, { groupId: GROUP_A, kind: 'person', data: person('Privada') });
    expect(await other.records.count()).toBe(0);
    expect(await demo.records.count()).toBe(0);
    expect(await secondInstallation.records.count()).toBe(0);
    expect(store('c', `${installationId}:b`).name).not.toBe(store('b:c', installationId).name);
  });

  it('prevents moving an entity across groups', async () => {
    const db = store();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    await expect(saveDraft(db, { id: draft.id, groupId: GROUP_B, kind: 'person', data: person('Ana') }))
      .rejects.toThrow('outro registro ou grupo');
    expect(await db.operations.count()).toBe(1);
  });
});

describe('durable sync and idempotency', () => {
  it('recovers a lost response by command status after reopening without resending', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const server = new MemoryServer();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    const key = (await db.operations.toArray())[0]?.idempotencyKey;
    server.loseResponse = true;
    await expect(sync(db, server)).rejects.toThrow('A conexão caiu');
    expect(await db.operations.get(key ?? '')).toMatchObject({ status: 'in-flight', attempts: 1 });
    expect((await db.records.get(draft.id))?.state).toBe('queued');
    db.close();
    const reopened = store('account-a', installationId);
    expect(await sync(reopened, server)).toEqual({ accepted: 1, conflicts: 0, rejected: 0 });
    expect(server.requests).toHaveLength(1);
    expect(server.receipts.size).toBe(1);
    expect(await reopened.operations.count()).toBe(0);
    expect((await reopened.records.get(draft.id))?.state).toBe('synced');
    expect((await getSyncSummary(reopened)).lastSyncAt).toMatch(/^202\d-/);
  });

  it('replays the identical payload safely when command status is unavailable', async () => {
    const db = store();
    const server = new MemoryServer();
    const transport = { push: server.push.bind(server), pull: server.pull.bind(server) };
    await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    server.loseResponse = true;
    await expect(sync(db, transport)).rejects.toThrow();
    await sync(db, transport);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toEqual(server.requests[1]);
    expect(server.records.size).toBe(1);
    expect(server.records.values().next().value?.serverVersion).toBe(1);
    expect(await db.operations.count()).toBe(0);
  });

  it('retains a later edit while replaying the original lost command unchanged', async () => {
    const db = store();
    const server = new MemoryServer();
    const transport = { push: server.push.bind(server), pull: server.pull.bind(server) };
    const first = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Original') });
    server.loseResponse = true;
    await expect(sync(db, transport)).rejects.toThrow();
    await saveDraft(db, { id: first.id, groupId: GROUP_A, kind: 'person', data: person('Edição após queda') });
    expect(await sync(db, transport)).toEqual({ accepted: 2, conflicts: 0, rejected: 0 });
    expect(server.requests[0]).toEqual(server.requests[1]);
    expect(server.requests.map(operation => operation.expectedVersion)).toEqual([0, 0, 1]);
    expect(await db.records.get(first.id)).toMatchObject({ data: person('Edição após queda'), state: 'synced' });
  });

  it('uses the account-specific Web Lock when the browser supports it', async () => {
    const db = store();
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    await sync(db, new MemoryServer());
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(`bolao-sync:${db.name}`);
  });

  it('rebases subsequent edits while retaining the newest edit during an active push', async () => {
    const db = store();
    const server = new MemoryServer();
    const entered = deferred();
    const release = deferred();
    server.beforePush = async () => { entered.resolve(); await release.promise; };
    const first = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    const syncing = sync(db, server);
    await entered.promise;
    await saveDraft(db, { id: first.id, groupId: GROUP_A, kind: 'person', data: person('Ana atualizada') });
    expect((await db.records.get(first.id))?.localVersion).toBe(2);
    release.resolve();
    expect(await syncing).toEqual({ accepted: 2, conflicts: 0, rejected: 0 });
    expect(server.requests.map(operation => operation.expectedVersion)).toEqual([0, 1]);
    expect(server.records.get(first.id)?.data).toEqual(person('Ana atualizada'));
    expect(await db.records.get(first.id)).toMatchObject({ data: person('Ana atualizada'), localVersion: 2, serverVersion: 2, state: 'synced' });
    expect(await db.operations.count()).toBe(0);
  });

  it('sends a saved edit chain sequentially using each acknowledged server version', async () => {
    const db = store();
    const server = new MemoryServer();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Versão 1') });
    for (const name of ['Versão 2', 'Versão 3']) {
      await saveDraft(db, { id: draft.id, groupId: GROUP_A, kind: 'person', data: person(name) });
    }
    expect(await sync(db, server)).toEqual({ accepted: 3, conflicts: 0, rejected: 0 });
    expect(server.requests.map(operation => operation.expectedVersion)).toEqual([0, 1, 2]);
    expect(await db.records.get(draft.id)).toMatchObject({ data: person('Versão 3'), state: 'synced', serverVersion: 3 });
  });

  it('deduplicates overlapping sync requests from two database instances', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const otherTab = store('account-a', installationId);
    const server = new MemoryServer();
    const entered = deferred();
    const release = deferred();
    server.beforePush = async () => { entered.resolve(); await release.promise; };
    await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    const first = sync(db, server);
    await entered.promise;
    const second = sync(otherTab, server);
    expect(first).toBe(second);
    release.resolve();
    await Promise.all([first, second]);
    expect(server.requests).toHaveLength(1);
    expect(await otherTab.operations.count()).toBe(0);
  });

  it('preserves unacknowledged operations when a push returns no receipts', async () => {
    const db = store();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    const server = new MemoryServer();
    server.seed(remotePerson(draft.id, draft.groupId, 'Versão remota', 4));
    const transport: LocalSyncTransport = {
      push: async () => [], pull: server.pull.bind(server),
    };
    await sync(db, transport);
    expect(await db.operations.count()).toBe(1);
    expect(await db.records.get(draft.id)).toMatchObject({ data: person('Ana'), serverVersion: 0, state: 'queued' });
    expect(await db.serverRecords.get(draft.id)).toMatchObject({ data: person('Versão remota'), serverVersion: 4 });
  });
});

describe('conflict review', () => {
  it('preserves rejected proposals for review without blocking independent entities', async () => {
    const db = store();
    const server = new MemoryServer();
    const rejected = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Precisa de revisão') });
    await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Permitida') });
    const transport: LocalSyncTransport = {
      push: async operations => {
        const receipts: PushReceipt[] = [];
        for (const operation of operations) {
          if (operation.entityId === rejected.id) receipts.push({
            idempotencyKey: operation.idempotencyKey, entityId: operation.entityId, status: 'rejected',
            serverVersion: 0, groupRevision: 0, record: null, message: 'Revise os dados antes de reenviar.',
          });
          else receipts.push(...await server.push([operation]));
        }
        return receipts;
      },
      pull: server.pull.bind(server),
    };
    expect(await sync(db, transport)).toEqual({ accepted: 1, conflicts: 0, rejected: 1 });
    expect(await db.records.get(rejected.id)).toMatchObject({ data: person('Precisa de revisão'), state: 'conflict' });
    expect((await db.operations.toArray())[0]).toMatchObject({ status: 'rejected', message: 'Revise os dados antes de reenviar.' });
    expect(await getSyncSummary(db)).toMatchObject({ pending: 0, conflicts: 1 });
  });

  it('preserves a conflicting draft and syncs independent entities', async () => {
    const db = store();
    const server = new MemoryServer();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Minha proposta') });
    await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Outra pessoa') });
    server.seed(remotePerson(draft.id, draft.groupId, 'Servidor', 3));
    expect(await sync(db, server)).toEqual({ accepted: 1, conflicts: 1, rejected: 0 });
    expect(await db.records.get(draft.id)).toMatchObject({ data: person('Minha proposta'), state: 'conflict' });
    expect(await db.serverRecords.get(draft.id)).toMatchObject({ data: person('Servidor'), serverVersion: 3 });
    expect(await getSyncSummary(db)).toMatchObject({ pending: 0, conflicts: 1 });
    expect((await db.operations.toArray())[0]?.status).toBe('conflict');
    expect(await sync(db, server)).toEqual({ accepted: 0, conflicts: 0, rejected: 0 });
  });

  it('archives both versions and retries a human-selected local proposal with a new key', async () => {
    const db = store();
    const server = new MemoryServer();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Minha proposta') });
    server.seed(remotePerson(draft.id, draft.groupId, 'Servidor', 3));
    await sync(db, server);
    const conflictedKey = (await db.operations.toArray())[0]?.idempotencyKey;
    await saveDraft(db, { id: draft.id, groupId: draft.groupId, kind: 'person', data: person('Revisada por mim') });
    const resolved = await resolveConflict(db, { entityId: draft.id, resolution: 'keep-local' });
    expect(resolved).toMatchObject({ state: 'queued', serverVersion: 3, data: person('Revisada por mim') });
    const operation = (await db.operations.toArray())[0];
    expect(operation?.idempotencyKey).not.toBe(conflictedKey);
    expect(operation).toMatchObject({ expectedVersion: 3, dependsOn: null, attempts: 0 });
    const history = (await db.metadata.toArray()).filter(item => item.key.startsWith('conflictResolution:'));
    expect(history).toHaveLength(1);
    expect(history[0]?.value).toMatchObject({ local: { data: person('Revisada por mim') }, server: { data: person('Servidor') } });
    await sync(db, server);
    expect(await db.records.get(draft.id)).toMatchObject({ data: person('Revisada por mim'), state: 'synced', serverVersion: 4 });
    expect((await db.receipts.get(conflictedKey ?? ''))?.status).toBe('conflict');
  });

  it('archives the proposal before adopting the server version', async () => {
    const db = store();
    const server = new MemoryServer();
    const draft = await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Minha proposta') });
    server.seed(remotePerson(draft.id, draft.groupId, 'Servidor', 3));
    await sync(db, server);
    const resolved = await resolveConflict(db, { entityId: draft.id, resolution: 'use-server' });
    expect(resolved).toMatchObject({ state: 'synced', data: person('Servidor') });
    expect(await db.operations.count()).toBe(0);
    expect((await db.metadata.toArray()).some(item => item.key.startsWith('conflictResolution:'))).toBe(true);
    expect(await getSyncSummary(db)).toMatchObject({ pending: 0, conflicts: 0 });
  });
});

describe('pulls, finance and emergency recovery', () => {
  it('discovers groups on an empty device and persists paginated pull cursors', async () => {
    const db = store();
    const server = new MemoryServer();
    for (const id of [PERSON_1, PERSON_2, PERSON_3]) server.seed(remotePerson(id, GROUP_A, id));
    await sync(db, server);
    expect(await db.records.count()).toBe(3);
    expect(server.pullCursors).toEqual([0, 2]);
    expect(await db.cursors.get(GROUP_A)).toEqual({ groupId: GROUP_A, cursor: 3 });
    server.pullCursors.length = 0;
    await sync(db, server);
    expect(server.pullCursors).toEqual([3]);
  });

  it('keeps edits saved while a pull is in progress and preserves them on cursor reset', async () => {
    const db = store();
    const server = new MemoryServer();
    server.seed(remotePerson(PERSON_1, GROUP_A, 'Original'));
    await sync(db, server);
    server.seed(remotePerson(PERSON_1, GROUP_A, 'Mudança remota', 2));
    const entered = deferred();
    const release = deferred();
    server.beforePull = async () => { entered.resolve(); await release.promise; };
    const syncing = sync(db, server);
    await entered.promise;
    await saveDraft(db, { id: PERSON_1, groupId: GROUP_A, kind: 'person', data: person('Nova edição local') });
    release.resolve();
    await syncing;
    expect(await db.records.get(PERSON_1)).toMatchObject({ data: person('Nova edição local'), state: 'queued', serverVersion: 1 });
    expect(await db.serverRecords.get(PERSON_1)).toMatchObject({ data: person('Mudança remota'), serverVersion: 2 });
    await resetSyncCursor(db, GROUP_A);
    const transport = { push: async () => [], pull: server.pull.bind(server) };
    await sync(db, transport);
    expect(await db.operations.count()).toBe(1);
    expect((await db.records.get(PERSON_1))?.data).toEqual(person('Nova edição local'));
  });

  it('never puts a synced payment proposal into confirmed cash', async () => {
    const db = store();
    const server = new MemoryServer();
    const data = { poolId: POOL_A, personId: PERSON_1, amountCents: '15000', note: 'Comprovante para revisão', status: 'pending' as const };
    await saveDraft(db, { groupId: GROUP_A, kind: 'payment-proposal', data });
    await sync(db, server);
    expect(await db.confirmedPayments.count()).toBe(0);
    expect((await listRecords(db, 'payment-proposal'))[0]).toMatchObject({ state: 'synced', data });
    await expect(saveDraft(db, {
      groupId: GROUP_A, kind: 'payment-proposal',
      data: { ...data, status: 'confirmed' as 'pending' },
    })).rejects.toThrow('não pode confirmar dinheiro');
  });

  it('exports the durable pending operation, cursors and an explicit plaintext warning', async () => {
    const db = store();
    await saveDraft(db, { groupId: GROUP_A, kind: 'person', data: person('Ana') });
    await db.cursors.put({ groupId: GROUP_A, cursor: 8 });
    const exported = JSON.parse(await exportEmergencySnapshot(db)) as {
      format: string; encrypted: boolean; warning: string; records: LocalRecord[];
      operations: DraftOperation[]; cursors: { groupId: string; cursor: number }[];
    };
    expect(exported.format).toBe('bolao-emergency-v4');
    expect(exported.encrypted).toBe(false);
    expect(exported.warning).toContain('não está criptografada');
    expect(exported.records).toHaveLength(1);
    expect(exported.operations).toHaveLength(1);
    expect(exported.operations[0]?.idempotencyKey).toBe((await db.operations.toArray())[0]?.idempotencyKey);
    expect(exported.cursors).toEqual([{ groupId: GROUP_A, cursor: 8 }]);
  });
});
