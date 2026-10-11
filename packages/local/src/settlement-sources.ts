import { validateFinancialSnapshot, validateRegistrationSnapshot, validateResultSnapshot } from '@bolao/core';
import type { SettlementSnapshot } from '@bolao/core';
import type { Table } from 'dexie';
import type { BolaoDatabase, SettlementSnapshotMetadata, SettlementSourceReferences } from './database';
import { applyFinancialSnapshotInTransaction } from './finance';
import { applyRegistrationSnapshotInTransaction } from './registration';
import { applyResultSnapshotInTransaction } from './results';

type Sources = Pick<SettlementSnapshot, 'financial' | 'registration' | 'results'>;
const names = new Set([
  'statutes', 'statuteAcceptances', 'receivedPayments', 'paymentAllocations', 'financialMovements',
  'confirmedQuotas', 'quotaRevocations', 'financialSnapshots',
  'registrationManifests', 'registrationReports', 'registrationSnapshots', 'confirmedEvidence', 'evidenceUploads', 'poolManifests',
  'contestResults', 'resultSelections', 'contestCalendars', 'resultSnapshots',
]);
export function settlementSourceTables(db: BolaoDatabase) { return db.tables.filter(table => names.has(table.name)); }

export function settlementSourceReferences(source: Sources): SettlementSourceReferences {
  const { financial, registration, results } = source;
  return {
    financial: {
      statutes: financial.statutes.map(row => row.id), acceptances: financial.acceptances.map(row => row.id),
      payments: financial.payments.map(row => row.id), allocations: financial.allocations.map(row => row.id),
      movements: financial.movements.map(row => row.id), quotas: financial.quotas.map(row => row.id), revocations: financial.revocations.map(row => row.id),
    },
    registration: {
      manifests: registration.manifests.map(row => row.id), evidence: registration.evidence.map(row => row.id), reports: registration.reports.map(row => row.id),
    },
    results: {
      results: results.results.map(row => row.id), selections: results.selections.map(row => row.id), calendarVersions: results.calendarVersions.map(row => row.id),
    },
  };
}

/** Also preserve source history if another family has already pulled a later cut. */
export function assertSettlementSourceHistory(
  previous: SettlementSnapshotMetadata | undefined,
  groupRevision: number,
  incoming: SettlementSourceReferences,
): void {
  if (!previous || groupRevision < previous.groupRevision) return;
  const pairs = [
    [previous.sources.financial, incoming.financial],
    [previous.sources.registration, incoming.registration],
    [previous.sources.results, incoming.results],
  ] as const;
  for (const [earlier, later] of pairs) {
    const prior = earlier as Record<string, string[]>;
    const next = later as Record<string, string[]>;
    for (const [kind, ids] of Object.entries(prior)) {
      const received = next[kind];
      const receivedIds = new Set(received);
      if (!received || ids.some(id => !receivedIds.has(id))) throw new Error('O retrato de liquidação não pode remover fontes históricas confirmadas.');
      if (groupRevision === previous.groupRevision && ids.length !== received.length) {
        throw new Error('A revisão de liquidação não avançou para as novas fontes.');
      }
    }
  }
}

/**
 * Caller includes every source table in its transaction. These APIs never execute commands.
 * Uses the in-transaction variants, so no family opens a sub-transaction inside the caller's one.
 */
export async function applySettlementSources(db: BolaoDatabase, source: Sources): Promise<void> {
  await applyFinancialSnapshotInTransaction(db, validateFinancialSnapshot(source.financial));
  await applyRegistrationSnapshotInTransaction(db, validateRegistrationSnapshot(source.registration));
  await applyResultSnapshotInTransaction(db, validateResultSnapshot(source.results));
}

async function rows<T extends { id: string; groupId: string }>(table: Table<T, string>, ids: string[], groupId: string): Promise<T[]> {
  const values = await table.bulkGet(ids);
  if (values.some(row => !row || row.groupId !== groupId)) throw new Error('Uma fonte histórica da liquidação está ausente ou pertence a outro grupo.');
  return values.filter(row => row !== undefined);
}

/** ID references reconstruct this exact cut instead of borrowing a later family's metadata. */
export async function readSettlementSources(db: BolaoDatabase, metadata: SettlementSnapshotMetadata): Promise<Sources> {
  const { groupId, groupRevision, sources } = metadata;
  const [statutes, acceptances, payments, allocations, movements, quotas, revocations,
    manifests, evidence, reports, results, selections, calendarVersions] = await Promise.all([
    rows(db.statutes, sources.financial.statutes, groupId), rows(db.statuteAcceptances, sources.financial.acceptances, groupId),
    rows(db.receivedPayments, sources.financial.payments, groupId), rows(db.paymentAllocations, sources.financial.allocations, groupId),
    rows(db.financialMovements, sources.financial.movements, groupId), rows(db.confirmedQuotas, sources.financial.quotas, groupId), rows(db.quotaRevocations, sources.financial.revocations, groupId),
    rows(db.registrationManifests, sources.registration.manifests, groupId), rows(db.confirmedEvidence, sources.registration.evidence, groupId), rows(db.registrationReports, sources.registration.reports, groupId),
    rows(db.contestResults, sources.results.results, groupId), rows(db.resultSelections, sources.results.selections, groupId), rows(db.contestCalendars, sources.results.calendarVersions, groupId),
  ]);
  return {
    financial: { groupId, groupRevision, statutes, acceptances, payments, allocations, movements, quotas, revocations },
    registration: { groupId, groupRevision, manifests, evidence, reports },
    results: { groupId, groupRevision, results, selections, calendarVersions },
  };
}
