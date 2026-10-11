import type { Table } from 'dexie';
import { canonical } from './integrity';

export interface ImmutableFact { id: string; groupId: string }
export interface SnapshotRevision { groupId: string; groupRevision: number; updatedAt: string }
export interface FactCollection { table: Table<ImmutableFact, string>; rows: ImmutableFact[] }

/** The caller validates the domain contract and includes every table in one transaction. */
export async function appendImmutableSnapshot(
  metadata: Table<SnapshotRevision, string>,
  snapshot: { groupId: string; groupRevision: number },
  collections: FactCollection[],
  messages: { wrongGroup: string; changedFact: string; incomplete: string; unchangedRevision: string },
): Promise<void> {
  const previous = await metadata.get(snapshot.groupId);
  const older = previous !== undefined && snapshot.groupRevision < previous.groupRevision;
  const unchangedRevision = previous !== undefined && snapshot.groupRevision === previous.groupRevision;
  for (const { table, rows } of collections) {
    const incoming = new Map(rows.map(row => [row.id, row]));
    const existingById = await table.bulkGet(rows.map(row => row.id));
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const existing = existingById[index];
      if (!row || row.groupId !== snapshot.groupId) throw new Error(messages.wrongGroup);
      if (existing && (existing.groupId !== snapshot.groupId || canonical(existing) !== canonical(row))) {
        throw new Error(messages.changedFact);
      }
    }
    // Old complete snapshots may be present in immutable receipts delivered late.
    if (older) continue;
    const existingGroup = await table.where('groupId').equals(snapshot.groupId).toArray();
    if (existingGroup.some(row => !incoming.has(row.id))) throw new Error(messages.incomplete);
    if (unchangedRevision && rows.length !== existingGroup.length) throw new Error(messages.unchangedRevision);
  }
  if (older || unchangedRevision) return;
  for (const { table, rows } of collections) {
    if (rows.length > 0) await table.bulkPut(rows);
  }
  await metadata.put({
    groupId: snapshot.groupId,
    groupRevision: snapshot.groupRevision,
    updatedAt: new Date().toISOString(),
  });
}
