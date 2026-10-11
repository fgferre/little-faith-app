import {
  validatePlanningCommand, validatePlanningReceipt, validatePlanningSnapshot,
} from '@bolao/core';
import type { PlanningCommand, PlanningReceipt, PlanningSnapshot, PlanningTransport } from '@bolao/core';
import type { BolaoDatabase, PersistentPlanningCommand } from './database';
import { assertApprovalOnline, receiptNotFound, withExplicitDecisionLock } from './explicit-decisions';
import { appendImmutableSnapshot } from './immutable-snapshots';
import type { FactCollection } from './immutable-snapshots';
import { canonical } from './integrity';

const planningTableNames = new Set(['appliedPlans', 'poolManifests', 'planningSnapshots']);

function planningTables(db: BolaoDatabase) {
  return db.tables.filter(table => planningTableNames.has(table.name));
}

async function applySnapshotInTransaction(db: BolaoDatabase, snapshot: PlanningSnapshot): Promise<void> {
  const collections = [
    { table: db.appliedPlans, rows: snapshot.appliedPlans },
    { table: db.poolManifests, rows: snapshot.manifests },
  ] as FactCollection[];
  await appendImmutableSnapshot(db.planningSnapshots, snapshot, collections, {
    wrongGroup: 'Um fato de planejamento pertence a outro grupo.',
    changedFact: 'O servidor tentou alterar um plano aplicado ou manifesto confirmado.',
    incomplete: 'A cópia de planejamento está incompleta; fatos confirmados não podem ser removidos.',
    unchangedRevision: 'A revisão de planejamento não avançou para os novos fatos.',
  });
}

export async function applyPlanningSnapshot(db: BolaoDatabase, input: PlanningSnapshot): Promise<void> {
  const snapshot = validatePlanningSnapshot(input);
  await db.transaction('rw', planningTables(db), () => applySnapshotInTransaction(db, snapshot));
}

export async function getPlanningSnapshot(db: BolaoDatabase, groupId: string): Promise<PlanningSnapshot | null> {
  return db.transaction('r', planningTables(db), async () => {
    const metadata = await db.planningSnapshots.get(groupId);
    if (!metadata) return null;
    const [appliedPlans, manifests] = await Promise.all([
      db.appliedPlans.where('groupId').equals(groupId).toArray(),
      db.poolManifests.where('groupId').equals(groupId).toArray(),
    ]);
    return { groupId, groupRevision: metadata.groupRevision, appliedPlans, manifests };
  });
}

/** A prepared plan decision is a local proposal; it never applies a plan or locks a pool. */
export async function preparePlanningCommand(
  db: BolaoDatabase,
  input: PlanningCommand,
): Promise<PersistentPlanningCommand> {
  const command = validatePlanningCommand(input);
  return db.transaction('rw', db.planningCommands, async () => {
    const existing = await db.planningCommands.get(command.idempotencyKey);
    if (existing) {
      if (canonical(existing.command) !== canonical(command)) {
        throw new Error('A chave de idempotência já pertence a outra decisão de planejamento.');
      }
      return existing;
    }
    const now = new Date().toISOString();
    const prepared: PersistentPlanningCommand = {
      idempotencyKey: command.idempotencyKey,
      groupId: command.groupId,
      command,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    await db.planningCommands.add(prepared);
    return prepared;
  });
}

async function markUnknown(db: BolaoDatabase, key: string): Promise<void> {
  await db.transaction('rw', db.planningCommands, async () => {
    const current = await db.planningCommands.get(key);
    if (current && ['prepared', 'sending', 'unknown'].includes(current.status)) {
      await db.planningCommands.update(key, { status: 'unknown', updatedAt: new Date().toISOString() });
    }
  });
}

function matchingReceipt(input: PlanningReceipt, command: PlanningCommand): PlanningReceipt {
  const receipt = validatePlanningReceipt(input);
  if (receipt.idempotencyKey !== command.idempotencyKey || receipt.groupId !== command.groupId
    || (receipt.snapshot && receipt.snapshot.groupId !== command.groupId)) {
    throw new Error('O recibo de planejamento não corresponde à decisão aprovada ou ao grupo.');
  }
  if (receipt.status === 'accepted' && (!receipt.snapshot || receipt.groupRevision <= command.expectedRevision)) {
    throw new Error('O recibo de planejamento aceito não contém uma nova revisão confirmada.');
  }
  if (receipt.status === 'accepted' && receipt.snapshot) {
    const action = command.action;
    const corresponding = action.type === 'plan_apply'
      ? receipt.snapshot.appliedPlans.some(applied => applied.receiptId === receipt.receiptId && applied.poolId === action.plan.poolId
        && canonical(applied.plan) === canonical(action.plan))
      : receipt.snapshot.manifests.some(manifest => manifest.receiptId === receipt.receiptId
        && manifest.poolId === action.poolId && manifest.appliedPlanId === action.appliedPlanId
        && manifest.content.responsible.registrarPersonId === action.responsible.registrarPersonId
        && manifest.content.responsible.ticketHolderPersonId === action.responsible.ticketHolderPersonId);
    if (!corresponding) throw new Error('O recibo aceito não confirma exatamente o plano ou a trava aprovados.');
  }
  return receipt;
}

async function persistPlanningReceipt(
  db: BolaoDatabase,
  command: PlanningCommand,
  input: PlanningReceipt,
): Promise<PlanningReceipt> {
  const receipt = matchingReceipt(input, command);
  await db.transaction('rw', [...planningTables(db), db.planningCommands, db.planningReceipts], async () => {
    const current = await db.planningCommands.get(command.idempotencyKey);
    if (!current || canonical(current.command) !== canonical(command)) {
      throw new Error('A decisão de planejamento local não corresponde ao recibo.');
    }
    const existing = await db.planningReceipts.get(command.idempotencyKey);
    if (existing && canonical(existing) !== canonical(receipt)) {
      throw new Error('O servidor alterou um recibo de planejamento imutável.');
    }
    if (receipt.snapshot) await applySnapshotInTransaction(db, receipt.snapshot);
    await db.planningReceipts.put(receipt);
    await db.planningCommands.update(command.idempotencyKey, {
      status: receipt.status,
      receipt,
      updatedAt: new Date().toISOString(),
    });
  });
  return receipt;
}

async function executePreparedCommand(
  db: BolaoDatabase,
  transport: PlanningTransport,
  key: string,
): Promise<PlanningReceipt> {
  const prepared = await db.planningCommands.get(key);
  if (!prepared) throw new Error('Prepare a decisão de planejamento antes de confirmá-la.');
  assertApprovalOnline('a aplicação do plano ou a trava do bolão');
  if (prepared.status === 'accepted' || prepared.status === 'conflict' || prepared.status === 'rejected') {
    if (!prepared.receipt) throw new Error('Consulte o servidor para recuperar o recibo desta decisão.');
    return prepared.receipt;
  }
  await db.transaction('rw', db.planningCommands, async () => {
    const current = await db.planningCommands.get(key);
    if (!current || current.status === 'sending') {
      throw new Error('Esta decisão já está em envio. Consulte o resultado antes de repetir.');
    }
    if (current.status !== 'prepared' && current.status !== 'unknown') {
      throw new Error('Esta decisão de planejamento já foi concluída.');
    }
    await db.planningCommands.update(key, { status: 'sending', updatedAt: new Date().toISOString() });
  });
  try {
    const receipt = await transport.planningDecide(structuredClone(prepared.command));
    return await persistPlanningReceipt(db, prepared.command, receipt);
  } catch (error) {
    await markUnknown(db, key);
    throw error;
  }
}

/** Only an explicit human action online may send or deliberately resend this decision. */
export function executePlanningCommand(
  db: BolaoDatabase,
  transport: PlanningTransport,
  key: string,
): Promise<PlanningReceipt> {
  return withExplicitDecisionLock('planning', db.name, key, () => executePreparedCommand(db, transport, key));
}

/** GET status only. Missing receipts preserve uncertainty and never trigger a resend. */
export async function recoverPlanningCommand(
  db: BolaoDatabase,
  transport: PlanningTransport,
  key: string,
): Promise<PlanningReceipt | null> {
  const prepared = await db.planningCommands.get(key);
  if (!prepared) throw new Error('A decisão de planejamento não está salva nesta conta.');
  if (prepared.status === 'accepted' || prepared.status === 'conflict' || prepared.status === 'rejected') {
    return prepared.receipt ?? null;
  }
  assertApprovalOnline('a consulta da decisão de planejamento');
  try {
    const receipt = await transport.planningCommandStatus(key);
    if (!receipt) { await markUnknown(db, key); return null; }
    return await persistPlanningReceipt(db, prepared.command, receipt);
  } catch (error) {
    await markUnknown(db, key);
    if (receiptNotFound(error)) return null;
    throw error;
  }
}

export const recoveryPlanningCommand = recoverPlanningCommand;
