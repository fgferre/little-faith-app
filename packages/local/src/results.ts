import { validateResultCommand, validateResultReceipt, validateResultSnapshot } from '@bolao/core';
import type { ContestResultData, ResultCommand, ResultReceipt, ResultSnapshot, ResultTransport } from '@bolao/core';
import type { BolaoDatabase, PersistentResultCollectionAttempt, PersistentResultCommand } from './database';
import { assertApprovalOnline, withExplicitDecisionLock } from './explicit-decisions';
import { appendImmutableSnapshot } from './immutable-snapshots';
import type { FactCollection } from './immutable-snapshots';
import { canonical } from './integrity';
import { createDecisionFamily } from './persistent-decisions';

const tableNames = new Set(['contestResults', 'resultSelections', 'contestCalendars', 'resultSnapshots']);
function resultTables(db: BolaoDatabase) { return db.tables.filter(table => tableNames.has(table.name)); }

async function applySnapshotInTransaction(db: BolaoDatabase, snapshot: ResultSnapshot): Promise<void> {
  await appendImmutableSnapshot(db.resultSnapshots, snapshot, [
    { table: db.contestResults, rows: snapshot.results },
    { table: db.resultSelections, rows: snapshot.selections },
    { table: db.contestCalendars, rows: snapshot.calendarVersions },
  ] as FactCollection[], {
    wrongGroup: 'Um fato de resultado pertence a outro grupo.',
    changedFact: 'O servidor tentou alterar um resultado, calendário ou escolha confirmada.',
    incomplete: 'A cópia de resultados está incompleta; versões anteriores não podem ser removidas.',
    unchangedRevision: 'A revisão de resultados não avançou para as novas versões.',
  });
}

/** A malformed response never overwrites a prior valid collection or resolves a conflict. */
export async function applyResultSnapshot(db: BolaoDatabase, input: ResultSnapshot): Promise<void> {
  const snapshot = validateResultSnapshot(input);
  await db.transaction('rw', resultTables(db), () => applySnapshotInTransaction(db, snapshot));
}

export async function getResultSnapshot(db: BolaoDatabase, groupId: string): Promise<ResultSnapshot | null> {
  return db.transaction('r', resultTables(db), async () => {
    const metadata = await db.resultSnapshots.get(groupId);
    if (!metadata) return null;
    const [results, selections, calendarVersions] = await Promise.all([
      db.contestResults.where('groupId').equals(groupId).toArray(),
      db.resultSelections.where('groupId').equals(groupId).toArray(),
      db.contestCalendars.where('groupId').equals(groupId).toArray(),
    ]);
    return { groupId, groupRevision: metadata.groupRevision, results, selections, calendarVersions };
  });
}

function resultData(result: ContestResultData): ContestResultData {
  return { lotteryId: result.lotteryId, contestNumber: result.contestNumber, drawDate: result.drawDate, drawnNumbers: result.drawnNumbers, payouts: result.payouts };
}

const family = createDecisionFamily<ResultCommand, ResultReceipt, ResultSnapshot>({
  namespace: 'result', label: 'resultado ou calendário',
  commandTable: db => db.resultCommands, receiptTable: db => db.resultReceipts,
  snapshotTables: resultTables,
  validateCommand: validateResultCommand, validateReceipt: validateResultReceipt,
  applySnapshotInTransaction,
  matchAcceptedReceipt(command, receipt) {
    if (!receipt.snapshot) return false;
    const action = command.action;
    switch (action.type) {
      case 'result_manual':
        return receipt.snapshot.results.some(result => result.receiptId === receipt.receiptId && result.source === 'manual'
          && result.poolId === action.poolId && result.sourceReference === action.sourceReference
          && canonical(resultData(result)) === canonical(action.data) && canonical(JSON.parse(result.rawText)) === canonical(action));
      case 'result_resolve':
        return receipt.snapshot.selections.some(selection => selection.receiptId === receipt.receiptId
          && selection.poolId === action.poolId && selection.resultId === action.resultId
          && canonical(selection.observedResultIds) === canonical(action.observedResultIds) && selection.reason === action.reason);
      case 'calendar_confirm':
        return receipt.snapshot.calendarVersions.some(calendar => calendar.receiptId === receipt.receiptId
          && calendar.poolId === action.poolId && calendar.source === 'manual' && calendar.lotteryId === action.lotteryId
          && calendar.contestNumber === action.contestNumber && calendar.drawDate === action.drawDate
          && calendar.expectedDrawAt === action.expectedDrawAt && calendar.registrationClosesAt === action.registrationClosesAt
          && calendar.sourceReference === action.sourceReference && canonical(JSON.parse(calendar.rawText)) === canonical(action));
    }
  },
});

export function prepareResultCommand(db: BolaoDatabase, command: ResultCommand): Promise<PersistentResultCommand> {
  return family.prepare(db, command);
}
/** Manual results, conflict choices and schedules are explicit human decisions online. */
export function executeResultCommand(db: BolaoDatabase, transport: ResultTransport, key: string): Promise<ResultReceipt> {
  return family.execute(db, key, command => transport.resultDecide(command));
}
export function recoverResultCommand(db: BolaoDatabase, transport: ResultTransport, key: string): Promise<ResultReceipt | null> {
  return family.recover(db, key, idempotencyKey => transport.resultCommandStatus(idempotencyKey));
}
export const recoveryResultCommand = recoverResultCommand;

function identifier(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('O grupo e o bolão da consulta precisam de identificadores UUID.');
  return value.toLowerCase();
}

/** Official collection is technical work. It never confirms or resends a manual decision. */
export function collectResults(
  db: BolaoDatabase,
  transport: ResultTransport,
  selectedGroupId: string,
  selectedPoolId: string,
): Promise<ResultSnapshot> {
  const groupId = identifier(selectedGroupId);
  const poolId = identifier(selectedPoolId);
  return withExplicitDecisionLock('result-collection', db.name, `${groupId}:${poolId}`, async () => {
    assertApprovalOnline('a consulta dos resultados oficiais');
    const now = new Date().toISOString();
    const attempt: PersistentResultCollectionAttempt = {
      id: crypto.randomUUID(), groupId, poolId, status: 'collecting', snapshotRevision: null,
      message: null, createdAt: now, updatedAt: now,
    };
    await db.resultCollectionAttempts.add(attempt);
    try {
      const input = await transport.resultsCollect(groupId, poolId);
      if (input.groupId !== groupId) throw new Error('A consulta devolveu resultados de outro grupo.');
      const snapshot = validateResultSnapshot(input);
      await db.transaction('rw', [...resultTables(db), db.resultCollectionAttempts], async () => {
        await applySnapshotInTransaction(db, snapshot);
        await db.resultCollectionAttempts.update(attempt.id, { status: 'succeeded', snapshotRevision: snapshot.groupRevision, updatedAt: new Date().toISOString() });
      });
      const current = await getResultSnapshot(db, groupId);
      if (!current) throw new Error('A consulta válida não ficou disponível neste aparelho.');
      return current;
    } catch (error) {
      await db.resultCollectionAttempts.update(attempt.id, {
        status: 'failed', message: error instanceof Error ? error.message : 'Não foi possível consultar o resultado.', updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  });
}
