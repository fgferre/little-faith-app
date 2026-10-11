import type { Table } from 'dexie';
import {
  validateFinancialCommand, validateFinancialReceipt, validateFinancialSnapshot,
} from '@bolao/core';
import type {
  ConfirmedQuota, FinancialCommand, FinancialMovement, FinancialReceipt,
  FinancialSnapshot, FinancialTransport, PaymentAllocation, QuotaRevocation,
  ReceivedPayment, StatuteAcceptance, StatuteVersion,
} from '@bolao/core';
import type { BolaoDatabase, PersistentFinancialCommand } from './database';
import { canonical } from './integrity';
import { assertApprovalOnline, receiptNotFound, withExplicitDecisionLock } from './explicit-decisions';
import { appendImmutableSnapshot } from './immutable-snapshots';
import type { FactCollection } from './immutable-snapshots';

type FinancialFact = StatuteVersion | StatuteAcceptance | ReceivedPayment | PaymentAllocation
  | FinancialMovement | ConfirmedQuota | QuotaRevocation;

const financialTableNames = new Set([
  'statutes', 'statuteAcceptances', 'receivedPayments', 'paymentAllocations',
  'financialMovements', 'confirmedQuotas', 'quotaRevocations', 'financialSnapshots',
]);

function financialTables(db: BolaoDatabase) {
  return db.tables.filter(table => financialTableNames.has(table.name));
}

function factCollections(db: BolaoDatabase, snapshot: FinancialSnapshot): {
  table: Table<FinancialFact, string>; rows: FinancialFact[];
}[] {
  return [
    { table: db.statutes, rows: snapshot.statutes },
    { table: db.statuteAcceptances, rows: snapshot.acceptances },
    { table: db.receivedPayments, rows: snapshot.payments },
    { table: db.paymentAllocations, rows: snapshot.allocations },
    { table: db.financialMovements, rows: snapshot.movements },
    { table: db.confirmedQuotas, rows: snapshot.quotas },
    { table: db.quotaRevocations, rows: snapshot.revocations },
  ] as { table: Table<FinancialFact, string>; rows: FinancialFact[] }[];
}

/** Call only inside a transaction containing all financial tables. */
async function applySnapshotInTransaction(db: BolaoDatabase, snapshot: FinancialSnapshot): Promise<void> {
  await appendImmutableSnapshot(db.financialSnapshots, snapshot, factCollections(db, snapshot) as FactCollection[], {
    wrongGroup: 'Um fato financeiro pertence a outro grupo.',
    changedFact: 'O servidor tentou alterar um fato financeiro confirmado.',
    incomplete: 'A cópia financeira está incompleta; fatos confirmados não podem ser removidos.',
    unchangedRevision: 'A revisão financeira não avançou para os novos fatos.',
  });
}
export { applySnapshotInTransaction as applyFinancialSnapshotInTransaction };

export async function applyFinancialSnapshot(db: BolaoDatabase, input: FinancialSnapshot): Promise<void> {
  const snapshot = validateFinancialSnapshot(input);
  await db.transaction('rw', financialTables(db), () => applySnapshotInTransaction(db, snapshot));
}

export async function getFinancialSnapshot(db: BolaoDatabase, groupId: string): Promise<FinancialSnapshot | null> {
  return db.transaction('r', financialTables(db), async () => {
    const metadata = await db.financialSnapshots.get(groupId);
    if (!metadata) return null;
    const [statutes, acceptances, payments, allocations, movements, quotas, revocations] = await Promise.all([
      db.statutes.where('groupId').equals(groupId).toArray(),
      db.statuteAcceptances.where('groupId').equals(groupId).toArray(),
      db.receivedPayments.where('groupId').equals(groupId).toArray(),
      db.paymentAllocations.where('groupId').equals(groupId).toArray(),
      db.financialMovements.where('groupId').equals(groupId).toArray(),
      db.confirmedQuotas.where('groupId').equals(groupId).toArray(),
      db.quotaRevocations.where('groupId').equals(groupId).toArray(),
    ]);
    return {
      groupId, groupRevision: metadata.groupRevision,
      statutes, acceptances, payments, allocations, movements, quotas, revocations,
    };
  });
}

/** Preparing is safe offline. It never changes cash, quota rights or the draft outbox. */
export async function prepareFinancialCommand(
  db: BolaoDatabase,
  input: FinancialCommand,
): Promise<PersistentFinancialCommand> {
  const command = validateFinancialCommand(input);
  return db.transaction('rw', db.financialCommands, async () => {
    const existing = await db.financialCommands.get(command.idempotencyKey);
    if (existing) {
      if (canonical(existing.command) !== canonical(command)) {
        throw new Error('A chave de idempotência já pertence a outra decisão financeira.');
      }
      return existing;
    }
    const now = new Date().toISOString();
    const prepared: PersistentFinancialCommand = {
      idempotencyKey: command.idempotencyKey,
      groupId: command.groupId,
      command,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    await db.financialCommands.add(prepared);
    return prepared;
  });
}

function assertOnline(): void {
  assertApprovalOnline('uma decisão financeira');
}

async function markUnknown(db: BolaoDatabase, key: string): Promise<void> {
  await db.transaction('rw', db.financialCommands, async () => {
    const current = await db.financialCommands.get(key);
    if (current && (current.status === 'prepared' || current.status === 'sending' || current.status === 'unknown')) {
      await db.financialCommands.update(key, { status: 'unknown', updatedAt: new Date().toISOString() });
    }
  });
}

function matchingReceipt(input: FinancialReceipt, command: FinancialCommand): FinancialReceipt {
  const receipt = validateFinancialReceipt(input);
  if (receipt.idempotencyKey !== command.idempotencyKey || receipt.groupId !== command.groupId
    || (receipt.snapshot && receipt.snapshot.groupId !== command.groupId)) {
    throw new Error('O recibo financeiro não corresponde à decisão aprovada ou ao grupo.');
  }
  if (receipt.status === 'accepted' && (!receipt.snapshot || receipt.groupRevision <= command.expectedRevision)) {
    throw new Error('O recibo financeiro aceito não contém uma nova revisão confirmada.');
  }
  return receipt;
}

async function persistFinancialReceipt(
  db: BolaoDatabase,
  command: FinancialCommand,
  input: FinancialReceipt,
): Promise<FinancialReceipt> {
  const receipt = matchingReceipt(input, command);
  await db.transaction('rw', [...financialTables(db), db.financialCommands, db.financialReceipts], async () => {
    const current = await db.financialCommands.get(command.idempotencyKey);
    if (!current || canonical(current.command) !== canonical(command)) {
      throw new Error('A decisão financeira local não corresponde ao recibo.');
    }
    const existing = await db.financialReceipts.get(command.idempotencyKey);
    if (existing && canonical(existing) !== canonical(receipt)) {
      throw new Error('O servidor alterou um recibo financeiro imutável.');
    }
    if (receipt.snapshot) await applySnapshotInTransaction(db, receipt.snapshot);
    await db.financialReceipts.put(receipt);
    await db.financialCommands.update(command.idempotencyKey, {
      status: receipt.status,
      receipt,
      updatedAt: new Date().toISOString(),
    });
  });
  return receipt;
}

async function executePreparedCommand(
  db: BolaoDatabase,
  transport: FinancialTransport,
  key: string,
): Promise<FinancialReceipt> {
  const prepared = await db.financialCommands.get(key);
  if (!prepared) throw new Error('Prepare a decisão financeira antes de confirmá-la.');
  assertOnline();
  if (prepared.status === 'accepted' || prepared.status === 'conflict' || prepared.status === 'rejected') {
    if (!prepared.receipt) throw new Error('Consulte o servidor para recuperar o recibo desta decisão.');
    return prepared.receipt;
  }
  await db.transaction('rw', db.financialCommands, async () => {
    const current = await db.financialCommands.get(key);
    if (!current || current.status === 'sending') {
      throw new Error('Esta decisão já está em envio. Consulte o resultado antes de repetir.');
    }
    if (current.status !== 'prepared' && current.status !== 'unknown') {
      throw new Error('Esta decisão financeira já foi concluída.');
    }
    await db.financialCommands.update(key, { status: 'sending', updatedAt: new Date().toISOString() });
  });
  try {
    // Only this explicit API sends an approval. No reconnect or draft sync calls it.
    const receipt = await transport.reviewDecide(structuredClone(prepared.command));
    return await persistFinancialReceipt(db, prepared.command, receipt);
  } catch (error) {
    await markUnknown(db, key);
    throw error;
  }
}

/** Invoke from an explicit human action online, including a deliberate retry. */
export function executeFinancialCommand(
  db: BolaoDatabase,
  transport: FinancialTransport,
  key: string,
): Promise<FinancialReceipt> {
  return withExplicitDecisionLock('financial', db.name, key, () => executePreparedCommand(db, transport, key));
}

/** Status lookup only: a null/404 response never authorizes resending a command. */
export async function recoverFinancialCommand(
  db: BolaoDatabase,
  transport: FinancialTransport,
  key: string,
): Promise<FinancialReceipt | null> {
  const prepared = await db.financialCommands.get(key);
  if (!prepared) throw new Error('A decisão financeira não está salva nesta conta.');
  if (prepared.status === 'accepted' || prepared.status === 'conflict' || prepared.status === 'rejected') {
    return prepared.receipt ?? null;
  }
  assertOnline();
  try {
    const receipt = await transport.financialCommandStatus(key);
    if (!receipt) { await markUnknown(db, key); return null; }
    return await persistFinancialReceipt(db, prepared.command, receipt);
  } catch (error) {
    await markUnknown(db, key);
    if (receiptNotFound(error)) return null;
    throw error;
  }
}

export const recoveryFinancialCommand = recoverFinancialCommand;
