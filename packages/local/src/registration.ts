import { validateRegistrationCommand, validateRegistrationReceipt, validateRegistrationSnapshot } from '@bolao/core';
import type { RegistrationCommand, RegistrationReceipt, RegistrationSnapshot, RegistrationTransport } from '@bolao/core';
import type { BolaoDatabase, PersistentRegistrationCommand } from './database';
import { rememberEvidenceMetadataInTransaction } from './evidence';
import { appendImmutableSnapshot } from './immutable-snapshots';
import type { FactCollection } from './immutable-snapshots';
import { canonical } from './integrity';
import { createDecisionFamily } from './persistent-decisions';

const tableNames = new Set(['registrationManifests', 'registrationReports', 'registrationSnapshots', 'confirmedEvidence', 'evidenceUploads', 'poolManifests']);
function registrationTables(db: BolaoDatabase) { return db.tables.filter(table => tableNames.has(table.name)); }

async function applySnapshotInTransaction(db: BolaoDatabase, snapshot: RegistrationSnapshot): Promise<void> {
  const previous = await db.registrationSnapshots.get(snapshot.groupId);
  const older = previous !== undefined && snapshot.groupRevision < previous.groupRevision;
  const unchanged = previous !== undefined && snapshot.groupRevision === previous.groupRevision;
  const ids = snapshot.evidence.map(row => row.id);
  const incomingIds = new Set(ids);
  const existing = await db.confirmedEvidence.bulkGet(ids);
  for (let index = 0; index < snapshot.evidence.length; index += 1) {
    const evidence = snapshot.evidence[index]!;
    if (existing[index] && canonical(existing[index]) !== canonical(evidence)) {
      throw new Error('O servidor tentou alterar metadados imutáveis de uma evidência.');
    }
  }
  if (previous && !older) {
    if (previous.evidenceIds.some(id => !incomingIds.has(id))) throw new Error('A cópia de registro não pode remover evidências confirmadas.');
    if (unchanged && previous.evidenceIds.length !== ids.length) throw new Error('A revisão de registro não avançou para as novas evidências.');
  }
  for (const manifest of snapshot.manifests) {
    const planningCopy = await db.poolManifests.get(manifest.id);
    if (planningCopy && canonical(planningCopy) !== canonical(manifest)) {
      throw new Error('O manifesto referenciado no registro difere do planejamento congelado.');
    }
  }
  await appendImmutableSnapshot(db.registrationSnapshots, snapshot, [
    { table: db.registrationManifests, rows: snapshot.manifests },
    { table: db.registrationReports, rows: snapshot.reports },
  ] as FactCollection[], {
    wrongGroup: 'Um fato de registro pertence a outro grupo.',
    changedFact: 'O servidor tentou alterar um relatório ou manifesto de registro confirmado.',
    incomplete: 'A cópia de registro está incompleta; relatórios e manifestos anteriores não podem ser removidos.',
    unchangedRevision: 'A revisão de registro não avançou para os novos fatos.',
  });
  if (older || unchanged) return;
  for (const evidence of snapshot.evidence) await rememberEvidenceMetadataInTransaction(db, evidence);
  await db.registrationSnapshots.update(snapshot.groupId, { evidenceIds: ids });
}
export { applySnapshotInTransaction as applyRegistrationSnapshotInTransaction };

/** Keep a complete immutable registration history without overwriting drafts or planning facts. */
export async function applyRegistrationSnapshot(db: BolaoDatabase, input: RegistrationSnapshot): Promise<void> {
  const snapshot = validateRegistrationSnapshot(input);
  await db.transaction('rw', registrationTables(db), () => applySnapshotInTransaction(db, snapshot));
}

export async function getRegistrationSnapshot(db: BolaoDatabase, groupId: string): Promise<RegistrationSnapshot | null> {
  return db.transaction('r', registrationTables(db), async () => {
    const metadata = await db.registrationSnapshots.get(groupId);
    if (!metadata) return null;
    const [manifests, reports, evidence] = await Promise.all([
      db.registrationManifests.where('groupId').equals(groupId).toArray(),
      db.registrationReports.where('groupId').equals(groupId).toArray(),
      db.confirmedEvidence.bulkGet(metadata.evidenceIds),
    ]);
    if (evidence.some(row => !row || row.groupId !== groupId)) throw new Error('A evidência desta cópia de registro está incompleta no aparelho.');
    return { groupId, groupRevision: metadata.groupRevision, manifests, reports, evidence: evidence.filter(row => row !== undefined) };
  });
}

const family = createDecisionFamily<RegistrationCommand, RegistrationReceipt, RegistrationSnapshot>({
  namespace: 'registration', label: 'registro',
  commandTable: db => db.registrationCommands, receiptTable: db => db.registrationReceipts,
  snapshotTables: registrationTables,
  validateCommand: validateRegistrationCommand, validateReceipt: validateRegistrationReceipt,
  applySnapshotInTransaction,
  matchAcceptedReceipt(command, receipt) {
    const action = command.action;
    return receipt.snapshot?.reports.some(report => report.receiptId === receipt.receiptId
      && report.poolId === action.poolId && report.poolVersion === action.poolVersion && report.manifestId === action.manifestId
      && canonical(report.items) === canonical(action.items) && report.reason === action.reason) ?? false;
  },
  async beforeSend(db, command) {
    await db.transaction('r', db.poolManifests, db.registrationManifests, db.confirmedEvidence, async () => {
      const action = command.action;
      const manifest = await db.poolManifests.get(action.manifestId) ?? await db.registrationManifests.get(action.manifestId);
      if (!manifest || manifest.groupId !== command.groupId || manifest.poolId !== action.poolId) {
        throw new Error('Sincronize o manifesto congelado deste grupo e bolão antes de confirmar o registro.');
      }
      const keys = new Set(manifest.content.plan.tickets.map(ticket => ticket.key));
      if (action.items.length !== keys.size || action.items.some(item => !keys.has(item.plannedTicketKey))) {
        throw new Error('O checklist não corresponde a todas as cartelas do manifesto congelado.');
      }
      const evidenceIds = [...new Set(action.items.flatMap(item => item.evidenceIds))];
      const evidence = await db.confirmedEvidence.bulkGet(evidenceIds);
      if (evidence.some(row => !row || row.groupId !== command.groupId || row.poolId !== action.poolId)) {
        throw new Error('Envie e confirme os arquivos de evidência deste grupo e bolão antes da decisão de registro.');
      }
    });
  },
});

export function prepareRegistrationCommand(db: BolaoDatabase, command: RegistrationCommand): Promise<PersistentRegistrationCommand> {
  return family.prepare(db, command);
}
/** Only an explicit human action online may confirm or deliberately resend a registration. */
export function executeRegistrationCommand(db: BolaoDatabase, transport: RegistrationTransport, key: string): Promise<RegistrationReceipt> {
  return family.execute(db, key, command => transport.registrationDecide(command));
}
/** GET status only; absence does not authorize a new human decision or an automatic resend. */
export function recoverRegistrationCommand(db: BolaoDatabase, transport: RegistrationTransport, key: string): Promise<RegistrationReceipt | null> {
  return family.recover(db, key, idempotencyKey => transport.registrationCommandStatus(idempotencyKey));
}
export const recoveryRegistrationCommand = recoverRegistrationCommand;
