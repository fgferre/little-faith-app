import type { EntityDataMap, EntityKind, LocalRecord } from '@bolao/core';
import { validateDraftOperation } from '@bolao/core';
import { nextSequence } from './database';
import type { BolaoDatabase, QueuedOperation } from './database';

export interface SaveDraftInput<K extends EntityKind> {
  id?: string;
  groupId: string;
  kind: K;
  data: EntityDataMap[K];
}

function validateProposal<K extends EntityKind>(input: SaveDraftInput<K>): void {
  if (!input.groupId.trim()) throw new Error('O rascunho precisa pertencer a um grupo.');
  if (input.kind === 'payment-proposal') {
    const data = input.data as EntityDataMap['payment-proposal'];
    if (!['pending', 'needs-review', 'rejected'].includes(data.status)) {
      throw new Error('Um rascunho de pagamento não pode confirmar dinheiro.');
    }
  }
}

export async function saveDraft<K extends EntityKind>(
  db: BolaoDatabase,
  input: SaveDraftInput<K>,
): Promise<LocalRecord<K>> {
  validateProposal(input);
  const prepared = validateDraftOperation({
    apiVersion: 'v1',
    idempotencyKey: crypto.randomUUID(),
    groupId: input.groupId,
    entityId: input.id ?? (input.kind === 'group' ? input.groupId : crypto.randomUUID()),
    kind: input.kind,
    expectedVersion: 0,
    data: input.data,
    createdAt: new Date().toISOString(),
  });
  const id = prepared.entityId;
  const groupId = prepared.groupId;
  const data = prepared.data as EntityDataMap[K];

  return db.transaction('rw', db.records, db.operations, db.metadata, async () => {
    const previous = await db.records.get(id);
    if (previous && (previous.kind !== input.kind || previous.groupId !== groupId)) {
      throw new Error('O identificador já pertence a outro registro ou grupo.');
    }
    const pending = await db.operations.where('entityId').equals(id).sortBy('sequence');
    const predecessor = pending.at(-1);
    const now = prepared.createdAt;
    const localVersion = (previous?.localVersion ?? 0) + 1;
    const record: LocalRecord<K> = {
      id,
      groupId,
      kind: input.kind,
      data,
      localVersion,
      serverVersion: previous?.serverVersion ?? 0,
      state: previous?.state === 'conflict' ? 'conflict' : 'queued',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const operation: QueuedOperation = {
      apiVersion: 'v1',
      idempotencyKey: prepared.idempotencyKey,
      groupId,
      entityId: id,
      kind: input.kind,
      expectedVersion: record.serverVersion,
      data: structuredClone(data),
      createdAt: now,
      localVersion,
      sequence: await nextSequence(db),
      status: 'queued',
      dependsOn: predecessor?.idempotencyKey ?? null,
      attempts: 0,
      lastAttemptAt: null,
      message: null,
    };
    await db.records.put(record);
    await db.operations.add(operation);
    return record;
  });
}

export async function listRecords<K extends EntityKind>(
  db: BolaoDatabase,
  kind: K,
  groupId?: string,
): Promise<LocalRecord<K>[]> {
  const collection = groupId === undefined
    ? db.records.where('kind').equals(kind)
    : db.records.where('[kind+groupId]').equals([kind, groupId]);
  return await collection.toArray() as LocalRecord<K>[];
}
