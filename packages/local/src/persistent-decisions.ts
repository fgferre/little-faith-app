import type { Table } from 'dexie';
import type { BolaoDatabase, FinancialCommandStatus } from './database';
import { assertApprovalOnline, receiptNotFound, withExplicitDecisionLock } from './explicit-decisions';
import { canonical } from './integrity';

interface CommandBase { idempotencyKey: string; groupId: string; expectedRevision: number }
interface SnapshotBase { groupId: string; groupRevision: number }
interface ReceiptBase<S extends SnapshotBase> {
  idempotencyKey: string;
  groupId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  groupRevision: number;
  snapshot: S | null;
}
interface StoredDecision<C, R> {
  idempotencyKey: string;
  groupId: string;
  command: C;
  status: FinancialCommandStatus;
  receipt?: R;
  createdAt: string;
  updatedAt: string;
}
interface Family<C extends CommandBase, R extends ReceiptBase<S>, S extends SnapshotBase> {
  namespace: string;
  label: string;
  commandTable(db: BolaoDatabase): Table<StoredDecision<C, R>, string>;
  receiptTable(db: BolaoDatabase): Table<R, string>;
  snapshotTables(db: BolaoDatabase): Table[];
  validateCommand(input: unknown): C;
  validateReceipt(input: unknown): R;
  matchAcceptedReceipt(command: C, receipt: R): boolean;
  applySnapshotInTransaction(db: BolaoDatabase, snapshot: S): Promise<void>;
  beforeSend?(db: BolaoDatabase, command: C): Promise<void>;
}

/** New review families share persistence, locks and uncertainty; their effects stay domain-specific. */
export function createDecisionFamily<C extends CommandBase, R extends ReceiptBase<S>, S extends SnapshotBase>(
  family: Family<C, R, S>,
) {
  const terminal = (status: FinancialCommandStatus) => status === 'accepted' || status === 'conflict' || status === 'rejected';

  async function markUnknown(db: BolaoDatabase, key: string): Promise<void> {
    const table = family.commandTable(db);
    await db.transaction('rw', table, async () => {
      const current = await table.get(key);
      if (current && !terminal(current.status)) await table.put({ ...current, status: 'unknown', updatedAt: new Date().toISOString() });
    });
  }

  async function persistReceipt(db: BolaoDatabase, command: C, input: R): Promise<R> {
    const receipt = family.validateReceipt(input);
    if (receipt.idempotencyKey !== command.idempotencyKey || receipt.groupId !== command.groupId
      || (receipt.snapshot && receipt.snapshot.groupId !== command.groupId)) {
      throw new Error(`O recibo de ${family.label} não corresponde à decisão ou ao grupo aprovados.`);
    }
    if (receipt.status === 'accepted' && (!receipt.snapshot || receipt.groupRevision <= command.expectedRevision
      || !family.matchAcceptedReceipt(command, receipt))) {
      throw new Error(`O recibo aceito não confirma exatamente a decisão de ${family.label} aprovada.`);
    }
    const commands = family.commandTable(db);
    const receipts = family.receiptTable(db);
    await db.transaction('rw', [...family.snapshotTables(db), commands, receipts], async () => {
      const current = await commands.get(command.idempotencyKey);
      if (!current || canonical(current.command) !== canonical(command)) throw new Error(`A decisão local de ${family.label} foi alterada.`);
      const existing = await receipts.get(command.idempotencyKey);
      if (existing && canonical(existing) !== canonical(receipt)) throw new Error(`O servidor alterou um recibo imutável de ${family.label}.`);
      if (receipt.snapshot) await family.applySnapshotInTransaction(db, receipt.snapshot);
      await receipts.put(receipt);
      await commands.put({ ...current, status: receipt.status, receipt, updatedAt: new Date().toISOString() });
    });
    return receipt;
  }

  async function prepare(db: BolaoDatabase, input: C): Promise<StoredDecision<C, R>> {
    const command = family.validateCommand(input);
    const table = family.commandTable(db);
    return db.transaction('rw', table, async () => {
      const existing = await table.get(command.idempotencyKey);
      if (existing) {
        if (canonical(existing.command) !== canonical(command)) throw new Error(`A chave de idempotência já pertence a outra decisão de ${family.label}.`);
        return existing;
      }
      const now = new Date().toISOString();
      const stored: StoredDecision<C, R> = { idempotencyKey: command.idempotencyKey, groupId: command.groupId, command, status: 'prepared', createdAt: now, updatedAt: now };
      await table.add(stored);
      return stored;
    });
  }

  function execute(db: BolaoDatabase, key: string, decide: (command: C) => Promise<R>): Promise<R> {
    return withExplicitDecisionLock(family.namespace, db.name, key, async () => {
      const table = family.commandTable(db);
      const prepared = await table.get(key);
      if (!prepared) throw new Error(`Prepare a decisão de ${family.label} nesta conta antes de confirmá-la.`);
      assertApprovalOnline(`a decisão de ${family.label}`);
      if (terminal(prepared.status)) {
        if (!prepared.receipt) throw new Error('Consulte o servidor para recuperar o recibo desta decisão.');
        return prepared.receipt;
      }
      await family.beforeSend?.(db, prepared.command);
      await db.transaction('rw', table, async () => {
        const current = await table.get(key);
        if (!current || current.status === 'sending') throw new Error('Esta decisão já está em envio. Consulte o resultado antes de repetir.');
        if (current.status !== 'prepared' && current.status !== 'unknown') throw new Error('Esta decisão já foi concluída.');
        if (canonical(current.command) !== canonical(prepared.command)) throw new Error('A decisão preparada foi alterada.');
        await table.put({ ...current, status: 'sending', updatedAt: new Date().toISOString() });
      });
      try { return await persistReceipt(db, prepared.command, await decide(structuredClone(prepared.command))); }
      catch (error) { await markUnknown(db, key); throw error; }
    });
  }

  async function recover(db: BolaoDatabase, key: string, getStatus: (key: string) => Promise<R | null>): Promise<R | null> {
    const prepared = await family.commandTable(db).get(key);
    if (!prepared) throw new Error(`A decisão de ${family.label} não está salva nesta conta.`);
    if (terminal(prepared.status)) return prepared.receipt ?? null;
    assertApprovalOnline(`a consulta da decisão de ${family.label}`);
    try {
      const receipt = await getStatus(key);
      if (!receipt) { await markUnknown(db, key); return null; }
      return await persistReceipt(db, prepared.command, receipt);
    } catch (error) {
      await markUnknown(db, key);
      if (receiptNotFound(error)) return null;
      throw error;
    }
  }

  return { prepare, execute, recover };
}
