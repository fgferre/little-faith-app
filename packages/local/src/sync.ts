import type {
  DraftOperation, EntityKind, FinancialSnapshot, LocalRecord, PlanningSnapshot, PullResponse, PushReceipt, SyncTransport,
  RegistrationSnapshot, ResultSnapshot, SettlementSnapshot,
} from '@bolao/core';
import { nextSequence, trackGroup } from './database';
import type { BolaoDatabase, QueuedOperation } from './database';
import { applyFinancialSnapshot } from './finance';
import { applyPlanningSnapshot } from './planning';
import { applyRegistrationSnapshot } from './registration';
import { applyResultSnapshot } from './results';
import { applySettlementSnapshot } from './settlement';

export interface LocalSyncTransport extends SyncTransport {
  /** Bootstrap a new device with the groups allowed to the authenticated account. */
  listGroupIds?(): Promise<string[]>;
  /** Recover the immutable receipt after losing a push response. */
  commandStatus?(idempotencyKey: string): Promise<PushReceipt | null>;
  /** Read confirmed facts after draft changes; never execute stored approvals. */
  financialPull?(groupId: string): Promise<FinancialSnapshot>;
  /** Read immutable plans and manifests. Stored decisions are never sent by sync. */
  planningPull?(groupId: string): Promise<PlanningSnapshot>;
  /** Read reports and evidence metadata; never upload files or confirm checklists here. */
  registrationPull?(groupId: string): Promise<RegistrationSnapshot>;
  /** Read collected versions and human selections; never send manual decisions here. */
  resultsPull?(groupId: string): Promise<ResultSnapshot>;
  /** Read confirmed settlement facts and their source cut; never send prize decisions here. */
  settlementPull?(groupId: string): Promise<SettlementSnapshot>;
}

export interface SyncResult { accepted: number; conflicts: number; rejected: number }
export interface SyncSummary { pending: number; conflicts: number; lastSyncAt: string | null }
export interface ResolveConflictInput {
  entityId: string;
  resolution: 'keep-local' | 'use-server';
}

const kinds = new Set<EntityKind>(['group', 'person', 'pool', 'quota', 'bet', 'payment-proposal']);
const runningSyncs = new Map<string, Promise<SyncResult>>();
const BATCH_SIZE = 100;
const MAX_PUSH_ROUNDS = 100;

function assertServerRecord(record: LocalRecord, groupId: string): void {
  if (!record || !record.id || record.groupId !== groupId || !kinds.has(record.kind)
    || !Number.isSafeInteger(record.serverVersion) || record.serverVersion < 0) {
    throw new Error('O servidor devolveu um registro de sincronização inválido.');
  }
  if (record.kind === 'payment-proposal') {
    const data = record.data as { status?: string };
    if (!data || !['pending', 'needs-review', 'rejected'].includes(data.status ?? '')) {
      throw new Error('Uma proposta sincronizada não pode confirmar um pagamento.');
    }
  }
}

function assertReceipt(receipt: PushReceipt, operation: QueuedOperation): void {
  if (receipt.idempotencyKey !== operation.idempotencyKey || receipt.entityId !== operation.entityId
    || !['accepted', 'conflict', 'rejected'].includes(receipt.status)
    || !Number.isSafeInteger(receipt.serverVersion) || receipt.serverVersion < 0
    || !Number.isSafeInteger(receipt.groupRevision) || receipt.groupRevision < 0) {
    throw new Error('O servidor devolveu um recibo de sincronização inválido.');
  }
  if (receipt.status === 'accepted' && receipt.serverVersion <= operation.expectedVersion) {
    throw new Error('O recibo aceito não avançou a versão do registro.');
  }
  if (receipt.record) {
    assertServerRecord(receipt.record, operation.groupId);
    if (receipt.record.id !== operation.entityId || receipt.record.kind !== operation.kind
      || receipt.record.serverVersion !== receipt.serverVersion) {
      throw new Error('O recibo não corresponde ao registro enviado.');
    }
  }
}

/** Strip queue metadata so a retried command has exactly the same wire payload. */
function wireOperation(operation: QueuedOperation): DraftOperation {
  return {
    apiVersion: operation.apiVersion,
    idempotencyKey: operation.idempotencyKey,
    groupId: operation.groupId,
    entityId: operation.entityId,
    kind: operation.kind,
    expectedVersion: operation.expectedVersion,
    data: structuredClone(operation.data),
    createdAt: operation.createdAt,
  };
}

async function rememberServerRecord(db: BolaoDatabase, record: LocalRecord): Promise<void> {
  const previous = await db.serverRecords.get(record.id);
  if (!previous || previous.serverVersion < record.serverVersion) {
    await db.serverRecords.put({ ...record, state: 'synced' });
  }
}

async function applyReceipt(
  db: BolaoDatabase,
  receipt: PushReceipt,
  attempted: QueuedOperation,
): Promise<boolean> {
  assertReceipt(receipt, attempted);
  return db.transaction('rw', db.records, db.operations, db.receipts, db.serverRecords, async () => {
    const operation = await db.operations.get(receipt.idempotencyKey);
    const previousReceipt = await db.receipts.get(receipt.idempotencyKey);
    if (previousReceipt && previousReceipt.status !== receipt.status) {
      throw new Error('O servidor alterou o resultado de uma chave de idempotência.');
    }
    // Another tab may already have applied the same immutable receipt.
    if (!operation) return false;
    await db.receipts.put(receipt);
    const current = await db.records.get(operation.entityId);

    if (receipt.record) await rememberServerRecord(db, receipt.record);
    if (receipt.status !== 'accepted') {
      const firstReview = operation.status !== 'conflict' && operation.status !== 'rejected';
      await db.operations.update(operation.idempotencyKey, {
        status: receipt.status,
        message: receipt.message,
      });
      if (current) await db.records.update(current.id, { state: 'conflict' });
      return firstReview;
    }

    const canonical: LocalRecord = receipt.record ?? {
      id: operation.entityId,
      groupId: operation.groupId,
      kind: operation.kind,
      data: operation.data,
      localVersion: operation.localVersion,
      serverVersion: receipt.serverVersion,
      state: 'synced',
      createdAt: current?.createdAt ?? operation.createdAt,
      updatedAt: operation.createdAt,
    };
    await rememberServerRecord(db, canonical);
    await db.operations.delete(operation.idempotencyKey);

    const dependents = await db.operations.where('dependsOn').equals(operation.idempotencyKey).toArray();
    for (const dependent of dependents) {
      if (dependent.attempts !== 0) {
        throw new Error('Uma edição dependente foi enviada antes do recibo anterior.');
      }
      // A key is rebased only before its first attempt. Once sent, its payload is immutable.
      await db.operations.update(dependent.idempotencyKey, {
        expectedVersion: receipt.serverVersion,
        dependsOn: null,
      });
    }

    const remaining = await db.operations.where('entityId').equals(operation.entityId).toArray();
    if (current && (current.localVersion > operation.localVersion || remaining.length > 0)) {
      await db.records.update(current.id, {
        serverVersion: Math.max(current.serverVersion, receipt.serverVersion),
        state: remaining.some(item => item.status === 'conflict' || item.status === 'rejected')
          ? 'conflict' : 'queued',
      });
    } else {
      await db.records.put({
        ...canonical,
        localVersion: current?.localVersion ?? operation.localVersion,
        state: 'synced',
      });
    }
    return true;
  });
}

async function prepareBatch(db: BolaoDatabase, attemptedKeys: Set<string>): Promise<QueuedOperation[]> {
  return db.transaction('rw', db.operations, async () => {
    const operations = await db.operations.orderBy('sequence').toArray();
    const entities = new Set<string>();
    const selected: QueuedOperation[] = [];
    for (const operation of operations) {
      // A conflict blocks this entity's successors, while unrelated entities continue.
      if (entities.has(operation.entityId)) continue;
      entities.add(operation.entityId);
      if (attemptedKeys.has(operation.idempotencyKey) || operation.dependsOn !== null
        || operation.status === 'conflict' || operation.status === 'rejected') continue;
      const prepared: QueuedOperation = {
        ...operation,
        status: 'in-flight',
        attempts: operation.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
      };
      await db.operations.put(prepared);
      selected.push(prepared);
      if (selected.length === BATCH_SIZE) break;
    }
    return selected;
  });
}

function countReceipt(result: SyncResult, receipt: PushReceipt): void {
  if (receipt.status === 'accepted') result.accepted += 1;
  else if (receipt.status === 'conflict') result.conflicts += 1;
  else result.rejected += 1;
}

async function pushPending(db: BolaoDatabase, transport: LocalSyncTransport, result: SyncResult): Promise<void> {
  const attemptedKeys = new Set<string>();
  for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
    const batch = await prepareBatch(db, attemptedKeys);
    if (batch.length === 0) break;
    const toSend: QueuedOperation[] = [];
    for (const operation of batch) {
      attemptedKeys.add(operation.idempotencyKey);
      let recovered: PushReceipt | null = null;
      if (operation.attempts > 1 && transport.commandStatus) {
        // Status lookup is optional; retrying the same push is also idempotent.
        try { recovered = await transport.commandStatus(operation.idempotencyKey); }
        catch { recovered = null; }
      }
      if (recovered) {
        if (await applyReceipt(db, recovered, operation)) countReceipt(result, recovered);
      } else toSend.push(operation);
    }
    if (toSend.length === 0) continue;

    // Network requests run outside IndexedDB transactions. A lost response leaves every key intact.
    const receipts = await transport.push(toSend.map(wireOperation));
    if (!Array.isArray(receipts)) throw new Error('A resposta de sincronização não contém recibos.');
    const operationsByKey = new Map(toSend.map(operation => [operation.idempotencyKey, operation]));
    const receivedKeys = new Set<string>();
    for (const receipt of receipts) {
      const operation = operationsByKey.get(receipt.idempotencyKey);
      if (!operation || receivedKeys.has(receipt.idempotencyKey)) {
        throw new Error('A resposta de sincronização contém um recibo inesperado.');
      }
      assertReceipt(receipt, operation);
      receivedKeys.add(receipt.idempotencyKey);
    }
    for (const receipt of receipts) {
      const operation = operationsByKey.get(receipt.idempotencyKey);
      if (operation && await applyReceipt(db, receipt, operation)) countReceipt(result, receipt);
    }
    // Missing receipts remain in-flight and will be recovered or replayed on the next sync.
  }
}

function assertPullResponse(response: PullResponse, groupId: string, cursor: number): void {
  if (response.groupId !== groupId || !Number.isSafeInteger(response.nextCursor)
    || response.nextCursor < cursor || (response.hasMore && response.nextCursor <= cursor)
    || !Array.isArray(response.changes)) {
    throw new Error('O cursor de sincronização é inválido ou expirou; recarregue o grupo preservando os rascunhos.');
  }
  for (const change of response.changes) {
    if (!Number.isSafeInteger(change.groupRevision) || change.groupRevision < 0
      || change.groupRevision > response.nextCursor) {
      throw new Error('O servidor devolveu uma revisão de grupo inválida.');
    }
    assertServerRecord(change.record, groupId);
  }
}

async function applyPull(db: BolaoDatabase, response: PullResponse): Promise<void> {
  await db.transaction('rw', db.records, db.operations, db.cursors, db.serverRecords, async () => {
    const changes = [...response.changes].sort((a, b) => a.groupRevision - b.groupRevision);
    for (const { record: remote } of changes) {
      const current = await db.records.get(remote.id);
      if (current && (current.groupId !== remote.groupId || current.kind !== remote.kind)) {
        throw new Error('Um registro sincronizado tentou substituir dados de outro grupo.');
      }
      await rememberServerRecord(db, remote);
      const pending = await db.operations.where('entityId').equals(remote.id).count();
      // A pull never overwrites an unacknowledged edit, even during full cursor recovery.
      if (pending > 0 || (current && current.serverVersion >= remote.serverVersion)) continue;
      await db.records.put({
        ...remote,
        localVersion: current?.localVersion ?? 1,
        state: 'synced',
      });
    }
    const existingCursor = await db.cursors.get(response.groupId);
    await db.cursors.put({
      groupId: response.groupId,
      cursor: Math.max(existingCursor?.cursor ?? 0, response.nextCursor),
    });
  });
}

async function runSync(db: BolaoDatabase, transport: LocalSyncTransport): Promise<SyncResult> {
  const result: SyncResult = { accepted: 0, conflicts: 0, rejected: 0 };
  if (transport.listGroupIds) {
    const groupIds = await transport.listGroupIds();
    for (const groupId of new Set(groupIds)) await trackGroup(db, groupId);
  }
  await pushPending(db, transport, result);
  const [records, operations, cursors] = await Promise.all([
    db.records.toArray(), db.operations.toArray(), db.cursors.toArray(),
  ]);
  const groupIds = new Set([
    ...records.map(record => record.groupId),
    ...operations.map(operation => operation.groupId),
    ...cursors.map(cursor => cursor.groupId),
  ]);
  for (const groupId of groupIds) {
    let cursor = (await db.cursors.get(groupId))?.cursor ?? 0;
    let hasMore = true;
    while (hasMore) {
      const response = await transport.pull(groupId, cursor);
      assertPullResponse(response, groupId, cursor);
      await applyPull(db, response);
      cursor = response.nextCursor;
      hasMore = response.hasMore;
    }
    if (transport.financialPull) {
      const snapshot = await transport.financialPull(groupId);
      if (snapshot.groupId !== groupId) throw new Error('A cópia financeira pertence a outro grupo.');
      await applyFinancialSnapshot(db, snapshot);
    }
    if (transport.planningPull) {
      const snapshot = await transport.planningPull(groupId);
      if (snapshot.groupId !== groupId) throw new Error('A cópia de planejamento pertence a outro grupo.');
      await applyPlanningSnapshot(db, snapshot);
    }
    if (transport.registrationPull) {
      const snapshot = await transport.registrationPull(groupId);
      if (snapshot.groupId !== groupId) throw new Error('A cópia de registro pertence a outro grupo.');
      await applyRegistrationSnapshot(db, snapshot);
    }
    if (transport.resultsPull) {
      const snapshot = await transport.resultsPull(groupId);
      if (snapshot.groupId !== groupId) throw new Error('A cópia de resultados pertence a outro grupo.');
      await applyResultSnapshot(db, snapshot);
    }
    if (transport.settlementPull) {
      const snapshot = await transport.settlementPull(groupId);
      if (snapshot.groupId !== groupId) throw new Error('A cópia de liquidação pertence a outro grupo.');
      await applySettlementSnapshot(db, snapshot);
    }
  }
  await db.metadata.put({ key: 'lastSyncAt', value: new Date().toISOString() });
  return result;
}

/**
 * Use one sync per account across tabs when Web Locks exist. The fallback keeps
 * commands immutable and uses server idempotency, so duplicate sends are safe.
 */
export function sync(db: BolaoDatabase, transport: LocalSyncTransport): Promise<SyncResult> {
  const running = runningSyncs.get(db.name);
  if (running) return running;
  const task = (async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(`bolao-sync:${db.name}`, () => runSync(db, transport));
    }
    return runSync(db, transport);
  })();
  const tracked = task.finally(() => {
    if (runningSyncs.get(db.name) === tracked) runningSyncs.delete(db.name);
  });
  runningSyncs.set(db.name, tracked);
  return tracked;
}

export async function getSyncSummary(db: BolaoDatabase): Promise<SyncSummary> {
  return db.transaction('r', db.records, db.operations, db.metadata, async () => {
    const pending = await db.operations.where('status').anyOf('queued', 'in-flight').count();
    const conflicts = await db.records.where('state').equals('conflict').count();
    const lastSyncAt = (await db.metadata.get('lastSyncAt'))?.value;
    return { pending, conflicts, lastSyncAt: typeof lastSyncAt === 'string' ? lastSyncAt : null };
  });
}

/** Only a human review should invoke this choice; both versions are archived. */
export async function resolveConflict(db: BolaoDatabase, input: ResolveConflictInput): Promise<LocalRecord> {
  if (input.resolution !== 'keep-local' && input.resolution !== 'use-server') {
    throw new Error('Escolha uma resolução válida para o conflito.');
  }
  const resolutionId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  return db.transaction('rw', db.records, db.operations, db.receipts, db.serverRecords, db.metadata, async () => {
    const local = await db.records.get(input.entityId);
    if (!local || local.state !== 'conflict') throw new Error('Este registro não tem um conflito para revisar.');
    const operations = await db.operations.where('entityId').equals(input.entityId).toArray();
    const server = await db.serverRecords.get(input.entityId);
    const receipts = await db.receipts.where('entityId').equals(input.entityId).toArray();
    const serverVersion = Math.max(local.serverVersion, server?.serverVersion ?? 0, ...receipts.map(receipt => receipt.serverVersion));
    if (input.resolution === 'use-server' && (!server || server.serverVersion < serverVersion)) {
      throw new Error('Sincronize a cópia atual do servidor antes de adotá-la.');
    }
    const now = new Date().toISOString();
    await db.metadata.add({
      key: `conflictResolution:${resolutionId}`,
      value: { entityId: local.id, resolution: input.resolution, resolvedAt: now, local, server: server ?? null, operations },
    });
    await db.operations.bulkDelete(operations.map(operation => operation.idempotencyKey));
    if (input.resolution === 'use-server' && server) {
      const resolved: LocalRecord = { ...server, localVersion: local.localVersion + 1, state: 'synced' };
      await db.records.put(resolved);
      return resolved;
    }
    const resolved: LocalRecord = {
      ...local,
      localVersion: local.localVersion + 1,
      serverVersion,
      state: 'queued',
      updatedAt: now,
    };
    const operation: QueuedOperation = {
      apiVersion: 'v1', idempotencyKey, entityId: local.id, groupId: local.groupId,
      kind: local.kind, expectedVersion: serverVersion, data: structuredClone(local.data), createdAt: now,
      localVersion: resolved.localVersion, sequence: await nextSequence(db), status: 'queued',
      dependsOn: null, attempts: 0, lastAttemptAt: null, message: null,
    };
    await db.records.put(resolved);
    await db.operations.add(operation);
    return resolved;
  });
}
