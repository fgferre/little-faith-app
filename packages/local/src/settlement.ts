import { validateSettlementCommand, validateSettlementReceipt, validateSettlementSnapshot } from '@bolao/core';
import type { SettlementCommand, SettlementFact, SettlementReceipt, SettlementSnapshot, SettlementTransport } from '@bolao/core';
import type { BolaoDatabase, PersistentSettlementCommand } from './database';
import { appendImmutableSnapshot } from './immutable-snapshots';
import type { FactCollection } from './immutable-snapshots';
import { canonical } from './integrity';
import { createDecisionFamily } from './persistent-decisions';
import {
  applySettlementSources, assertSettlementSourceHistory, readSettlementSources, settlementSourceReferences, settlementSourceTables,
} from './settlement-sources';

const tableNames = new Set(['expenseConfirmations', 'prizeConfirmations', 'prizeRedemptions', 'settlementDistributions', 'poolSettlements', 'settlementSnapshots']);
function settlementTables(db: BolaoDatabase) {
  return [...db.tables.filter(table => tableNames.has(table.name)), ...settlementSourceTables(db)];
}

async function applySnapshotInTransaction(db: BolaoDatabase, snapshot: SettlementSnapshot): Promise<void> {
  const previous = await db.settlementSnapshots.get(snapshot.groupId);
  const sources = settlementSourceReferences(snapshot);
  assertSettlementSourceHistory(previous, snapshot.groupRevision, sources);
  // A coherent snapshot includes source families; all their facts remain immutable.
  await applySettlementSources(db, snapshot);
  await appendImmutableSnapshot(db.settlementSnapshots, snapshot, [
    { table: db.expenseConfirmations, rows: snapshot.expenses },
    { table: db.prizeConfirmations, rows: snapshot.prizes },
    { table: db.prizeRedemptions, rows: snapshot.redemptions },
    { table: db.settlementDistributions, rows: snapshot.distributions },
    { table: db.poolSettlements, rows: snapshot.closures },
  ] as FactCollection[], {
    wrongGroup: 'Um fato de liquidação pertence a outro grupo.',
    changedFact: 'O servidor tentou alterar uma despesa, prêmio, resgate, distribuição ou encerramento confirmado.',
    incomplete: 'A cópia de liquidação está incompleta; fatos históricos não podem ser removidos.',
    unchangedRevision: 'A revisão de liquidação não avançou para os novos fatos.',
  });
  if (previous && snapshot.groupRevision <= previous.groupRevision) return;
  await db.settlementSnapshots.update(snapshot.groupId, { sources });
}

/**
 * Confirmed facts and their coherent source cut are persisted together; calculation is never cash.
 * The scope must be an async function: Dexie only keeps the transaction zone across this deep chain of
 * native awaits when it sees an async scope; otherwise the transaction auto-commits too early.
 */
export async function applySettlementSnapshot(db: BolaoDatabase, input: SettlementSnapshot): Promise<void> {
  const snapshot = validateSettlementSnapshot(input);
  await db.transaction('rw', settlementTables(db), async () => { await applySnapshotInTransaction(db, snapshot); });
}

export async function getSettlementSnapshot(db: BolaoDatabase, groupId: string): Promise<SettlementSnapshot | null> {
  return db.transaction('r', settlementTables(db), async () => {
    const metadata = await db.settlementSnapshots.get(groupId);
    if (!metadata) return null;
    const [source, expenses, prizes, redemptions, distributions, closures] = await Promise.all([
      readSettlementSources(db, metadata),
      db.expenseConfirmations.where('groupId').equals(groupId).toArray(), db.prizeConfirmations.where('groupId').equals(groupId).toArray(),
      db.prizeRedemptions.where('groupId').equals(groupId).toArray(), db.settlementDistributions.where('groupId').equals(groupId).toArray(), db.poolSettlements.where('groupId').equals(groupId).toArray(),
    ]);
    return { groupId, groupRevision: metadata.groupRevision, ...source, expenses, prizes, redemptions, distributions, closures };
  });
}

function matchingFact(fact: SettlementFact, command: SettlementCommand, receipt: SettlementReceipt): boolean {
  return fact.groupId === command.groupId && fact.poolId === command.action.poolId && fact.poolVersion === command.action.poolVersion
    && fact.receiptId === receipt.receiptId && fact.groupRevision === receipt.groupRevision && fact.confirmedAt === receipt.confirmedAt;
}

function matchAcceptedReceipt(command: SettlementCommand, receipt: SettlementReceipt): boolean {
  const snapshot = receipt.snapshot;
  if (!snapshot) return false;
  const action = command.action;
  switch (action.type) {
    case 'expense_confirm':
      return snapshot.expenses.some(fact => matchingFact(fact, command, receipt)
        && fact.registrationReportId === action.registrationReportId && fact.supersedesId === action.supersedesId
        && fact.betCostCents === action.betCostCents && fact.feeCents === action.feeCents
        && canonical(fact.evidenceIds) === canonical(action.evidenceIds) && fact.sourceReference === action.sourceReference && fact.reason === action.reason);
    case 'prize_confirm':
      return snapshot.prizes.some(fact => matchingFact(fact, command, receipt)
        && fact.registrationReportId === action.registrationReportId && fact.resultId === action.resultId && fact.supersedesId === action.supersedesId
        && fact.amountCents === action.amountCents && canonical(fact.officialEntitlements) === canonical(action.officialEntitlements)
        && canonical(fact.redemptionDeadline) === canonical(action.redemptionDeadline)
        && canonical(fact.evidenceIds) === canonical(action.evidenceIds) && fact.sourceReference === action.sourceReference && fact.reason === action.reason);
    case 'redemption_record':
      return snapshot.redemptions.some(fact => matchingFact(fact, command, receipt) && fact.direction === 'received' && fact.reversesId === null
        && fact.prizeConfirmationId === action.prizeConfirmationId && fact.personId === action.personId && fact.amountCents === action.amountCents
        && canonical(fact.evidenceIds) === canonical(action.evidenceIds) && fact.sourceReference === action.sourceReference && fact.eventAt === action.eventAt && fact.reason === action.reason);
    case 'redemption_reverse':
      return snapshot.redemptions.some(fact => matchingFact(fact, command, receipt) && fact.direction === 'reversed' && fact.reversesId === action.redemptionId
        && canonical(fact.evidenceIds) === canonical(action.evidenceIds) && fact.sourceReference === action.sourceReference && fact.eventAt === action.eventAt && fact.reason === action.reason);
    case 'distribution_record':
      return snapshot.distributions.some(fact => matchingFact(fact, command, receipt) && fact.direction === 'paid' && fact.reversesId === null
        && fact.personId === action.personId && fact.kind === action.kind && fact.amountCents === action.amountCents
        && canonical(fact.evidenceIds) === canonical(action.evidenceIds) && fact.sourceReference === action.sourceReference && fact.eventAt === action.eventAt && fact.reason === action.reason);
    case 'distribution_reverse':
      return snapshot.distributions.some(fact => matchingFact(fact, command, receipt) && fact.direction === 'returned' && fact.reversesId === action.distributionId
        && canonical(fact.evidenceIds) === canonical(action.evidenceIds) && fact.sourceReference === action.sourceReference && fact.eventAt === action.eventAt && fact.reason === action.reason);
    case 'pool_settle':
      return snapshot.closures.some(fact => matchingFact(fact, command, receipt) && fact.direction === 'closed'
        && fact.registrationReportId === action.registrationReportId && fact.prizeConfirmationId === action.prizeConfirmationId
        && fact.expenseConfirmationId === action.expenseConfirmationId && fact.leftoverDisposition === action.leftoverDisposition
        && fact.pendingExplanation === action.pendingExplanation && fact.reason === action.reason);
    case 'pool_reopen':
      return snapshot.closures.some(fact => matchingFact(fact, command, receipt) && fact.direction === 'reopened'
        && fact.previousClosureId === action.closureId && fact.reason === action.reason);
  }
}

const family = createDecisionFamily<SettlementCommand, SettlementReceipt, SettlementSnapshot>({
  namespace: 'settlement', label: 'resgate, distribuição ou encerramento',
  commandTable: db => db.settlementCommands, receiptTable: db => db.settlementReceipts,
  snapshotTables: settlementTables, validateCommand: validateSettlementCommand, validateReceipt: validateSettlementReceipt,
  matchAcceptedReceipt, applySnapshotInTransaction,
});

export function prepareSettlementCommand(db: BolaoDatabase, command: SettlementCommand): Promise<PersistentSettlementCommand> {
  return family.prepare(db, command);
}
/** This API is only for an explicit human action online, never synchronization or reconnect. */
export function executeSettlementCommand(db: BolaoDatabase, transport: SettlementTransport, key: string): Promise<SettlementReceipt> {
  return family.execute(db, key, command => transport.settlementDecide(command));
}
/** GET status only; an absent result preserves uncertainty and never authorizes a resend. */
export function recoverSettlementCommand(db: BolaoDatabase, transport: SettlementTransport, key: string): Promise<SettlementReceipt | null> {
  return family.recover(db, key, idempotencyKey => transport.settlementCommandStatus(idempotencyKey));
}
export const recoverySettlementCommand = recoverSettlementCommand;
