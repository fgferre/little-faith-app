import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { createSimulationCheckpoint, runSimulationBatch } from '@bolao/core';
import type { FinancialCommand, PlanningCommand } from '@bolao/core';
import {
  createLocalStore, exportEmergencySnapshot, getEvidenceOriginal, getFinancialSnapshot, getPlanningSnapshot,
  getRegistrationSnapshot, getResultSnapshot, getSettlementSnapshot, resumePlanningAnalysis,
} from '../src';
import type { BolaoDatabase, PersistentEvidenceUpload, PersistentPlanningAnalysis, QueuedOperation } from '../src';
import { candidate, financialSnapshot, GROUP, id, lockedSnapshot, PERSON, POOL, TIME } from './planning-fixtures';
import { ACCOUNT, evidence, EVIDENCE_TEXT, registrationCommand, reportedSnapshot } from './registration-fixtures';
import { emptyResultSnapshot, manualCommand, officialResult } from './result-fixtures';

const stores: Dexie[] = [];
afterEach(async () => {
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

// These public v4 table names are independent from the new settlement schema.
const v4Names = new Set([
  'records', 'operations', 'receipts', 'cursors', 'confirmedPayments', 'metadata', 'serverRecords',
  'statutes', 'statuteAcceptances', 'receivedPayments', 'paymentAllocations', 'financialMovements',
  'confirmedQuotas', 'quotaRevocations', 'financialSnapshots', 'financialCommands', 'financialReceipts',
  'planningCandidates', 'planningAnalyses', 'simulationCheckpoints', 'appliedPlans', 'poolManifests',
  'planningSnapshots', 'planningCommands', 'planningReceipts', 'evidenceUploads', 'confirmedEvidence',
  'registrationManifests', 'registrationReports', 'registrationSnapshots', 'registrationCommands', 'registrationReceipts',
  'contestResults', 'resultSelections', 'contestCalendars', 'resultSnapshots', 'resultCommands', 'resultReceipts', 'resultCollectionAttempts',
]);

it('migrates v4 preserving private originals, all prior facts, unknown decisions, dependent edits and worker checkpoints', async () => {
  const db: BolaoDatabase = createLocalStore({ accountId: ACCOUNT, installationId: crypto.randomUUID() });
  stores.push(db);
  const legacy = new Dexie(db.name);
  stores.push(legacy);
  const tables = db.tables.filter(table => v4Names.has(table.name));
  expect(tables).toHaveLength(39);
  legacy.version(4).stores(Object.fromEntries(tables.map(table => [table.name, [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(', ')])));

  const draft = { id: PERSON, groupId: GROUP, kind: 'person', data: { name: 'Edição mais recente', nickname: '', adultDeclared: true }, localVersion: 2, serverVersion: 1, state: 'queued', createdAt: TIME, updatedAt: TIME };
  const first: QueuedOperation = { apiVersion: 'v1', idempotencyKey: id(900), groupId: GROUP, entityId: PERSON, kind: 'person', expectedVersion: 1, data: { ...draft.data, name: 'Primeira edição enviada' }, createdAt: TIME, localVersion: 1, sequence: 1, status: 'in-flight', dependsOn: null, attempts: 1, lastAttemptAt: TIME, message: null };
  const successor: QueuedOperation = { ...first, idempotencyKey: id(901), data: draft.data, localVersion: 2, sequence: 2, status: 'queued', dependsOn: first.idempotencyKey, attempts: 0, lastAttemptAt: null };
  const financialCommand: FinancialCommand = { apiVersion: 'v1', idempotencyKey: id(902), groupId: GROUP, expectedRevision: 14, action: { type: 'payment_reverse', paymentId: id(12), reason: 'Aguardando consulta da decisão original.' } };
  const plan = candidate();
  const planningCommand: PlanningCommand = { apiVersion: 'v1', idempotencyKey: id(903), groupId: GROUP, expectedRevision: 5, action: { type: 'plan_apply', plan } };
  const registration = registrationCommand(id(904));
  const result = manualCommand(id(905), 14);
  for (const [table, command] of [['financialCommands', financialCommand], ['planningCommands', planningCommand], ['registrationCommands', registration], ['resultCommands', result]] as const) {
    await legacy.table(table).put({ idempotencyKey: command.idempotencyKey, groupId: GROUP, command, status: 'unknown', createdAt: TIME, updatedAt: TIME });
  }
  const input = { lotteryId: plan.lotteryId, bets: plan.bets.map(bet => bet.numbers), seed: plan.seed, targetSamples: 200_000 };
  const checkpoint = runSimulationBatch(input, createSimulationCheckpoint(input), 240);
  const analysis: PersistentPlanningAnalysis = { id: id(906), groupId: GROUP, poolId: POOL, candidateId: plan.id, input, checkpoint, result: null, status: 'paused', progressVersion: 7, createdAt: TIME, updatedAt: TIME };
  const finance = { ...financialSnapshot(), groupRevision: 14 };
  const planning = { ...lockedSnapshot(), groupRevision: 14 };
  const registered = { ...reportedSnapshot(registration), groupRevision: 14 };
  const results = { ...emptyResultSnapshot(14), results: [officialResult()] };
  const confirmed = evidence();
  const original = new Blob([EVIDENCE_TEXT], { type: confirmed.mimeType });
  const upload: PersistentEvidenceUpload = {
    id: confirmed.id, groupId: GROUP, poolId: POOL, sha256: confirmed.sha256, mimeType: confirmed.mimeType,
    byteSize: confirmed.byteSize, originalName: confirmed.originalName, accountId: ACCOUNT, original,
    status: 'uploaded', confirmedMetadata: confirmed, attempts: 1, lastError: null, createdAt: TIME, updatedAt: TIME,
  };
  const pending: PersistentEvidenceUpload = { ...upload, id: id(907), originalName: 'pendente.pdf', status: 'unknown' };
  delete pending.confirmedMetadata;
  const review = { groupId: GROUP, poolId: POOL, names: ['Nome congelado na revisão'], amountCents: '123', reason: 'Texto original aprovado.' };
  await legacy.table('records').put(draft);
  await legacy.table('operations').bulkPut([first, successor]);
  await legacy.table('cursors').put({ groupId: GROUP, cursor: 14 });
  await legacy.table('metadata').bulkPut([{ key: 'outboxSequence', value: 2 }, { key: `result-review:${result.idempotencyKey}`, value: review }]);
  await legacy.table('planningCandidates').put({ id: plan.id, groupId: GROUP, poolId: POOL, candidate: plan, createdAt: TIME });
  await legacy.table('planningAnalyses').put(analysis);
  await legacy.table('simulationCheckpoints').put({ analysisId: analysis.id, groupId: GROUP, poolId: POOL, checkpoint, progressVersion: 7, updatedAt: TIME });
  for (const [table, rows] of [['statutes', finance.statutes], ['statuteAcceptances', finance.acceptances], ['receivedPayments', finance.payments], ['paymentAllocations', finance.allocations], ['financialMovements', finance.movements], ['confirmedQuotas', finance.quotas]] as const) await legacy.table(table).bulkPut(rows);
  await legacy.table('financialSnapshots').put({ groupId: GROUP, groupRevision: 14, updatedAt: TIME });
  await legacy.table('appliedPlans').bulkPut(planning.appliedPlans);
  await legacy.table('poolManifests').bulkPut(planning.manifests);
  await legacy.table('planningSnapshots').put({ groupId: GROUP, groupRevision: 14, updatedAt: TIME });
  await legacy.table('evidenceUploads').bulkPut([upload, pending]);
  await legacy.table('confirmedEvidence').put(confirmed);
  await legacy.table('registrationManifests').bulkPut(registered.manifests);
  await legacy.table('registrationReports').bulkPut(registered.reports);
  await legacy.table('registrationSnapshots').put({ groupId: GROUP, groupRevision: 14, updatedAt: TIME, evidenceIds: [confirmed.id] });
  await legacy.table('contestResults').bulkPut(results.results);
  await legacy.table('resultSnapshots').put({ groupId: GROUP, groupRevision: 14, updatedAt: TIME });
  const failedCollection = { id: id(908), groupId: GROUP, poolId: POOL, status: 'failed', snapshotRevision: null, message: 'Fonte indisponível.', createdAt: TIME, updatedAt: TIME };
  await legacy.table('resultCollectionAttempts').put(failedCollection);
  legacy.close();

  expect(await db.records.get(PERSON)).toEqual(draft);
  expect(await db.operations.get(first.idempotencyKey)).toEqual(first);
  expect(await db.operations.get(successor.idempotencyKey)).toEqual(successor);
  for (const [table, command] of [[db.financialCommands, financialCommand], [db.planningCommands, planningCommand], [db.registrationCommands, registration], [db.resultCommands, result]] as const) expect(await table.get(command.idempotencyKey)).toMatchObject({ command, status: 'unknown' });
  expect(await getFinancialSnapshot(db, GROUP)).toEqual(finance);
  expect(await getPlanningSnapshot(db, GROUP)).toEqual(planning);
  expect(await getRegistrationSnapshot(db, GROUP)).toEqual(registered);
  expect(await getResultSnapshot(db, GROUP)).toEqual(results);
  expect(await (await getEvidenceOriginal(db, upload.id))!.text()).toBe(EVIDENCE_TEXT);
  expect(await (await getEvidenceOriginal(db, pending.id))!.text()).toBe(EVIDENCE_TEXT);
  expect((await db.evidenceUploads.get(pending.id))?.status).toBe('unknown');
  expect(await db.resultCollectionAttempts.get(failedCollection.id)).toEqual(failedCollection);
  expect(await db.metadata.get(`result-review:${result.idempotencyKey}`)).toEqual({ key: `result-review:${result.idempotencyKey}`, value: review });
  const resumed = await resumePlanningAnalysis(db, analysis.id);
  expect(resumed.checkpoint).toEqual(checkpoint);
  expect(resumed.progressVersion).toBe(8);
  expect(await getSettlementSnapshot(db, GROUP)).toBeNull();
  expect(await db.settlementCommands.count()).toBe(0);
  const exported = JSON.parse(await exportEmergencySnapshot(db));
  expect(exported.format).toBe('bolao-emergency-v5');
  expect(exported.evidenceUploads).toHaveLength(2);
  expect(exported.resultCommands[0]).toMatchObject({ status: 'unknown', command: result });
  expect(exported.settlementCommands).toEqual([]);
  expect(db.verno).toBe(5);
});
