import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { createSimulationCheckpoint, runSimulationBatch } from '@bolao/core';
import type { FinancialCommand, PlanningCommand, SimulationInput } from '@bolao/core';
import { createLocalStore, getFinancialSnapshot, getPlanningSnapshot, resumePlanningAnalysis } from '../src';
import type { BolaoDatabase, PersistentFinancialCommand, PersistentPlanningAnalysis, PersistentPlanningCommand, QueuedOperation } from '../src';
import { candidate, financialSnapshot, GROUP, id, lockedSnapshot, PERSON, POOL, TIME } from './planning-fixtures';

const stores: Dexie[] = [];
afterEach(async () => {
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

it('migrates v3 without losing attempted drafts, unknown decisions, frozen facts or simulation progress', async () => {
  const db: BolaoDatabase = createLocalStore({ accountId: id(200), installationId: crypto.randomUUID() });
  stores.push(db);
  const legacy = new Dexie(db.name);
  stores.push(legacy);
  legacy.version(3).stores({
    records: '&id, groupId, kind, state, [kind+groupId]', operations: '&idempotencyKey, entityId, groupId, sequence, status, dependsOn',
    receipts: '&idempotencyKey, entityId, status', cursors: '&groupId', confirmedPayments: '&id, groupId, poolId, personId, receiptId', metadata: '&key', serverRecords: '&id, groupId, kind',
    statutes: '&id, groupId, version, receiptId, [groupId+version]', statuteAcceptances: '&id, groupId, statuteId, personId, receiptId, [statuteId+personId]',
    receivedPayments: '&id, groupId, personId, sourceProposalId, receiptId', paymentAllocations: '&id, groupId, paymentId, personId, poolId, receiptId',
    financialMovements: '&id, groupId, paymentId, personId, poolId, allocationId, kind, receiptId', confirmedQuotas: '&id, groupId, poolId, personId, sourceQuotaId, statuteId, receiptId',
    quotaRevocations: '&id, groupId, quotaId, receiptId', financialSnapshots: '&groupId, groupRevision', financialCommands: '&idempotencyKey, groupId, status, createdAt', financialReceipts: '&idempotencyKey, groupId, status',
    planningCandidates: '&id, groupId, poolId, [groupId+poolId]', planningAnalyses: '&id, groupId, poolId, candidateId, status, [groupId+poolId]',
    simulationCheckpoints: '&analysisId, groupId, poolId, [groupId+poolId]', appliedPlans: '&id, groupId, poolId, receiptId, [groupId+poolId]',
    poolManifests: '&id, groupId, poolId, version, appliedPlanId, receiptId, [groupId+poolId]', planningSnapshots: '&groupId, groupRevision',
    planningCommands: '&idempotencyKey, groupId, status, createdAt', planningReceipts: '&idempotencyKey, groupId, status',
  });
  const draft = { id: PERSON, groupId: GROUP, kind: 'person', data: { name: 'Nome proposto', nickname: '', adultDeclared: true }, localVersion: 2, serverVersion: 1, state: 'queued', createdAt: TIME, updatedAt: TIME };
  const operation: QueuedOperation = { apiVersion: 'v1', idempotencyKey: id(310), groupId: GROUP, entityId: PERSON, kind: 'person', expectedVersion: 1, data: draft.data, createdAt: TIME, localVersion: 2, sequence: 2, status: 'in-flight', dependsOn: null, attempts: 1, lastAttemptAt: TIME, message: null };
  const financialCommand: FinancialCommand = { apiVersion: 'v1', idempotencyKey: id(311), groupId: GROUP, expectedRevision: 7, action: { type: 'payment_reverse', paymentId: id(12), reason: 'Revisão ainda sem retorno.' } };
  const financialStored: PersistentFinancialCommand = { idempotencyKey: financialCommand.idempotencyKey, groupId: GROUP, command: financialCommand, status: 'unknown', createdAt: TIME, updatedAt: TIME };
  const plan = candidate();
  const planningCommand: PlanningCommand = { apiVersion: 'v1', idempotencyKey: id(312), groupId: GROUP, expectedRevision: 5, action: { type: 'plan_apply', plan } };
  const planningStored: PersistentPlanningCommand = { idempotencyKey: planningCommand.idempotencyKey, groupId: GROUP, command: planningCommand, status: 'unknown', createdAt: TIME, updatedAt: TIME };
  const input: SimulationInput = { lotteryId: plan.lotteryId, bets: plan.bets.map(bet => bet.numbers), seed: plan.seed, targetSamples: 200_000 };
  const checkpoint = runSimulationBatch(input, createSimulationCheckpoint(input), 200);
  const analysis: PersistentPlanningAnalysis = { id: id(313), groupId: GROUP, poolId: POOL, candidateId: plan.id, input, checkpoint, result: null, status: 'paused', progressVersion: 4, createdAt: TIME, updatedAt: TIME };
  const finance = financialSnapshot();
  const planning = lockedSnapshot();
  await legacy.table('records').put(draft);
  await legacy.table('operations').put(operation);
  await legacy.table('cursors').put({ groupId: GROUP, cursor: 7 });
  await legacy.table('metadata').put({ key: `registration-draft:${GROUP}:${POOL}`, value: { text: 'rascunho privado existente' } });
  await legacy.table('financialCommands').put(financialStored);
  await legacy.table('planningCommands').put(planningStored);
  await legacy.table('planningCandidates').put({ id: plan.id, groupId: GROUP, poolId: POOL, candidate: plan, createdAt: TIME });
  await legacy.table('planningAnalyses').put(analysis);
  await legacy.table('simulationCheckpoints').put({ analysisId: analysis.id, groupId: GROUP, poolId: POOL, checkpoint, progressVersion: 4, updatedAt: TIME });
  for (const [table, rows] of [['statutes', finance.statutes], ['statuteAcceptances', finance.acceptances], ['receivedPayments', finance.payments], ['paymentAllocations', finance.allocations], ['financialMovements', finance.movements], ['confirmedQuotas', finance.quotas]] as const) await legacy.table(table).bulkPut(rows);
  await legacy.table('financialSnapshots').put({ groupId: GROUP, groupRevision: finance.groupRevision, updatedAt: TIME });
  await legacy.table('appliedPlans').bulkPut(planning.appliedPlans);
  await legacy.table('poolManifests').bulkPut(planning.manifests);
  await legacy.table('planningSnapshots').put({ groupId: GROUP, groupRevision: planning.groupRevision, updatedAt: TIME });
  legacy.close();

  expect(await db.records.get(PERSON)).toEqual(draft);
  expect(await db.operations.get(operation.idempotencyKey)).toEqual(operation);
  expect(await db.financialCommands.get(financialStored.idempotencyKey)).toEqual(financialStored);
  expect(await db.planningCommands.get(planningStored.idempotencyKey)).toEqual(planningStored);
  expect(await getFinancialSnapshot(db, GROUP)).toEqual(finance);
  expect(await getPlanningSnapshot(db, GROUP)).toEqual(planning);
  expect(await db.metadata.get(`registration-draft:${GROUP}:${POOL}`)).toMatchObject({ value: { text: 'rascunho privado existente' } });
  expect(await db.cursors.get(GROUP)).toEqual({ groupId: GROUP, cursor: 7 });
  const resumed = await resumePlanningAnalysis(db, analysis.id);
  expect(resumed.checkpoint).toEqual(checkpoint);
  expect(resumed.progressVersion).toBe(5);
  for (const table of [db.evidenceUploads, db.confirmedEvidence, db.registrationReports, db.registrationCommands, db.contestResults, db.resultSelections, db.resultCommands]) expect(await table.count()).toBe(0);
  expect(db.verno).toBe(4);
});
