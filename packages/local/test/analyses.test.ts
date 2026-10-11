import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSimulationCheckpoint, runSimulationBatch, simulationResult } from '@bolao/core';
import type { SimulationCheckpoint, SimulationInput } from '@bolao/core';
import {
  createLocalStore, createPlanningAnalysis, exportEmergencySnapshot, listPlanningAnalyses,
  listPlanningCandidates, pausePlanningAnalysis, refinePlanningAnalysis, resumePlanningAnalysis,
  saveAnalysisProgress, savePlanningCandidates,
} from '../src';
import type { BolaoDatabase, PersistentPlanningAnalysis } from '../src';
import { candidate, GROUP, id, OTHER_GROUP, OTHER_POOL, POOL, SEED } from './planning-fixtures';

const stores: BolaoDatabase[] = [];
function store(accountId = 'account-a', installationId: string = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}

async function preparedAnalysis(db: BolaoDatabase, analysisId = crypto.randomUUID()): Promise<PersistentPlanningAnalysis> {
  const plan = candidate();
  await savePlanningCandidates(db, { groupId: GROUP, poolId: POOL, candidates: [plan] });
  return createPlanningAnalysis(db, {
    id: analysisId, groupId: GROUP, poolId: POOL, candidateId: plan.id,
    input: { lotteryId: plan.lotteryId, bets: plan.bets.map(bet => bet.numbers), seed: SEED, targetSamples: 200_000 },
  });
}

function finish(input: SimulationInput, initial = createSimulationCheckpoint(input)): SimulationCheckpoint {
  let checkpoint = initial;
  while (checkpoint.processedSamples < input.targetSamples) checkpoint = runSimulationBatch(input, checkpoint, 10_000);
  return checkpoint;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

describe('deterministic local candidates and Worker checkpoint persistence', () => {
  it('persists deterministic candidates idempotently and rejects mixed scopes atomically', async () => {
    const db = store();
    const first = candidate();
    const [saved] = await savePlanningCandidates(db, { groupId: GROUP, poolId: POOL, candidates: [first] });
    expect((await savePlanningCandidates(db, { groupId: GROUP, poolId: POOL, candidates: [candidate()] }))[0]).toEqual(saved);
    expect(await listPlanningCandidates(db, GROUP, POOL)).toHaveLength(1);
    const next = candidate(GROUP, 'cd'.repeat(32));
    await expect(savePlanningCandidates(db, { groupId: GROUP, poolId: POOL, candidates: [next, candidate(OTHER_GROUP)] })).rejects.toThrow('outro grupo ou bolão');
    expect(await db.planningCandidates.get(next.id)).toBeUndefined();
    expect(await listPlanningCandidates(db, GROUP, OTHER_POOL)).toEqual([]);
    expect(await listPlanningCandidates(db, OTHER_GROUP, POOL)).toEqual([]);
    expect(await db.operations.count()).toBe(0);
    expect(await db.appliedPlans.count()).toBe(0);
  });

  it('prepares offline without starting work, preserving seed/input when reopened', async () => {
    const db = store();
    vi.stubGlobal('navigator', { onLine: false });
    const analysis = await preparedAnalysis(db);
    expect(analysis).toMatchObject({ status: 'prepared', progressVersion: 0, result: null, checkpoint: { processedSamples: 0 } });
    expect(analysis.input.seed).toBe(SEED);
    db.close();
    const reopened = store(db.accountId, db.installationId);
    expect(await listPlanningAnalyses(reopened, GROUP, POOL)).toEqual([analysis]);
    expect((await reopened.simulationCheckpoints.get(analysis.id))?.checkpoint).toEqual(analysis.checkpoint);
    expect(await reopened.planningCommands.count()).toBe(0);
    expect(await reopened.operations.count()).toBe(0);
  });

  it('does not repurpose analysis IDs, reset progressed analyses or substitute another portfolio', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const checkpoint = runSimulationBatch(initial.input, initial.checkpoint, 100);
    const updated = await saveAnalysisProgress(db, initial.id, { checkpoint, status: 'running', expectedProgressVersion: 0 });
    const same = await createPlanningAnalysis(db, { id: initial.id, groupId: GROUP, poolId: POOL, candidateId: initial.candidateId, input: initial.input });
    expect(same).toEqual(updated);
    await expect(createPlanningAnalysis(db, { id: initial.id, groupId: GROUP, poolId: POOL, candidateId: initial.candidateId, input: { ...initial.input, seed: 'cd'.repeat(32) } })).rejects.toThrow('outras entradas');
    await expect(createPlanningAnalysis(db, { groupId: GROUP, poolId: POOL, candidateId: initial.candidateId, input: { ...initial.input, bets: [[1, 2, 3, 4, 5, 6]] } })).rejects.toThrow('não correspondem');
    await expect(createPlanningAnalysis(db, { groupId: OTHER_GROUP, poolId: POOL, candidateId: initial.candidateId, input: initial.input })).rejects.toThrow('neste grupo e bolão');
    expect(await db.planningAnalyses.count()).toBe(1);
    expect((await db.planningAnalyses.get(initial.id))?.input).toEqual(initial.input);
  });

  it('isolates accounts, demo and selected pool for candidate/analysis reads', async () => {
    const db = store();
    const other = store('account-b', db.installationId);
    const demo = store('demo', db.installationId);
    const analysis = await preparedAnalysis(db);
    expect(await listPlanningAnalyses(db, GROUP, OTHER_POOL)).toEqual([]);
    expect(await listPlanningCandidates(other, GROUP, POOL)).toEqual([]);
    expect(await listPlanningAnalyses(other, GROUP, POOL)).toEqual([]);
    expect(await listPlanningAnalyses(demo, GROUP, POOL)).toEqual([]);
    await expect(saveAnalysisProgress(other, analysis.id, { checkpoint: analysis.checkpoint, status: 'running', expectedProgressVersion: 0 })).rejects.toThrow('nesta conta');
  });

  it('persists pause and resumes the same random stream while rejecting late Worker callbacks', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const running = await resumePlanningAnalysis(db, initial.id);
    const checkpoint = runSimulationBatch(running.input, running.checkpoint, 150);
    const progress = await saveAnalysisProgress(db, running.id, { checkpoint, status: 'running', expectedProgressVersion: running.progressVersion });
    const paused = await pausePlanningAnalysis(db, running.id);
    const late = runSimulationBatch(running.input, checkpoint, 200);
    await expect(saveAnalysisProgress(db, running.id, { checkpoint: late, status: 'running', expectedProgressVersion: progress.progressVersion })).rejects.toThrow('execução anterior');
    expect((await db.planningAnalyses.get(running.id))?.status).toBe('paused');
    db.close();
    const reopened = store(db.accountId, db.installationId);
    const resumed = await resumePlanningAnalysis(reopened, running.id);
    expect(resumed.checkpoint).toEqual(paused.checkpoint);
    expect(resumed.input).toEqual(initial.input);
    const continued = runSimulationBatch(resumed.input, resumed.checkpoint, 200);
    expect(continued).toEqual(runSimulationBatch(initial.input, initial.checkpoint, 350));
    const saved = await saveAnalysisProgress(reopened, running.id, { checkpoint: continued, status: 'paused', expectedProgressVersion: resumed.progressVersion });
    expect((await reopened.simulationCheckpoints.get(saved.id))?.checkpoint).toEqual(saved.checkpoint);
    expect(saved.result?.complete).toBe(false);
    expect(saved.result?.zeroHitsMeaning).toBe('not-proof-of-zero-probability');
  });

  it('rolls back analysis and checkpoint together if checkpoint persistence fails', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const before = await db.simulationCheckpoints.get(initial.id);
    const checkpoint = runSimulationBatch(initial.input, initial.checkpoint, 200);
    vi.spyOn(db.simulationCheckpoints, 'put').mockRejectedValueOnce(new Error('Checkpoint storage unavailable.'));
    await expect(saveAnalysisProgress(db, initial.id, { checkpoint, status: 'running', expectedProgressVersion: 0 })).rejects.toThrow('storage unavailable');
    expect(await db.planningAnalyses.get(initial.id)).toEqual(initial);
    expect(await db.simulationCheckpoints.get(initial.id)).toEqual(before);
  });

  it('does not let an obsolete cleanup pause a newer execution from another tab', async () => {
    const db = store();
    const otherTab = store(db.accountId, db.installationId);
    const initial = await preparedAnalysis(db);
    const first = await resumePlanningAnalysis(db, initial.id);
    const second = await resumePlanningAnalysis(otherTab, initial.id);
    expect(await pausePlanningAnalysis(db, initial.id, first.progressVersion)).toEqual(second);
    expect(await otherTab.planningAnalyses.get(initial.id)).toEqual(second);
    const checkpoint = runSimulationBatch(second.input, second.checkpoint, 100);
    const progress = await saveAnalysisProgress(otherTab, initial.id, { checkpoint, status: 'running', expectedProgressVersion: second.progressVersion });
    expect(await pausePlanningAnalysis(db, initial.id, first.progressVersion)).toEqual(progress);
    const paused = await pausePlanningAnalysis(otherTab, initial.id, progress.progressVersion);
    expect(paused.status).toBe('paused');
    expect(paused.checkpoint).toEqual(progress.checkpoint);
    expect(paused.progressVersion).toBe(progress.progressVersion + 1);
  });

  it('rejects old progress, changed seeds, decreasing counters and mismatched results', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const checkpoint = runSimulationBatch(initial.input, initial.checkpoint, 10_000);
    expect(checkpoint.anyPrizeHits).toBeGreaterThan(0);
    const progress = await saveAnalysisProgress(db, initial.id, { checkpoint, status: 'running', expectedProgressVersion: 0 });
    await expect(saveAnalysisProgress(db, initial.id, { checkpoint: initial.checkpoint, status: 'running', expectedProgressVersion: progress.progressVersion })).rejects.toThrow('checkpoint anterior');
    const differentSeed = createSimulationCheckpoint({ ...initial.input, seed: 'cd'.repeat(32) });
    await expect(saveAnalysisProgress(db, initial.id, { checkpoint: differentSeed, status: 'paused', expectedProgressVersion: progress.progressVersion })).rejects.toThrow('semente');
    const fewerHits = { ...checkpoint, processedSamples: checkpoint.processedSamples + 1, randomWordOffset: checkpoint.randomWordOffset + 6, anyPrizeHits: checkpoint.anyPrizeHits - 1, hitsByTier: Object.fromEntries(Object.entries(checkpoint.hitsByTier).map(([tier, hits]) => [tier, Math.max(0, hits - 1)])) };
    await expect(saveAnalysisProgress(db, initial.id, { checkpoint: fewerHits, status: 'running', expectedProgressVersion: progress.progressVersion })).rejects.toThrow();
    const later = runSimulationBatch(initial.input, checkpoint, 100);
    const wrongResult = simulationResult(initial.input, checkpoint);
    await expect(saveAnalysisProgress(db, initial.id, { checkpoint: later, status: 'running', expectedProgressVersion: progress.progressVersion, result: wrongResult })).rejects.toThrow('resultado não corresponde');
    expect(await db.planningAnalyses.get(initial.id)).toEqual(progress);
  });

  it('requires complete sample counts before marking an analysis complete', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const partial = runSimulationBatch(initial.input, initial.checkpoint, 100);
    await expect(saveAnalysisProgress(db, initial.id, { checkpoint: partial, status: 'complete', expectedProgressVersion: 0 })).rejects.toThrow('quantidade de amostras');
    expect(await db.planningAnalyses.get(initial.id)).toEqual(initial);
  });

  it('refines 200k to 1m with the preserved stream and immutable original result', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const firstCheckpoint = finish(initial.input);
    const original = await saveAnalysisProgress(db, initial.id, { checkpoint: firstCheckpoint, status: 'complete', expectedProgressVersion: 0 });
    const refined = await refinePlanningAnalysis(db, original.id, 1_000_000);
    expect(refined.id).not.toBe(original.id);
    expect(refined).toMatchObject({ status: 'paused', progressVersion: 0, refinedFromId: original.id, input: { seed: original.input.seed, bets: original.input.bets, targetSamples: 1_000_000 } });
    expect(refined.checkpoint).toMatchObject({ processedSamples: 200_000, randomWordOffset: original.checkpoint.randomWordOffset, anyPrizeHits: original.checkpoint.anyPrizeHits, hitsByTier: original.checkpoint.hitsByTier });
    expect(refined.checkpoint.inputSignature).not.toBe(original.checkpoint.inputSignature);
    const continued = finish(refined.input, refined.checkpoint);
    const uninterrupted = finish(refined.input);
    expect(continued).toEqual(uninterrupted);
    const result = await saveAnalysisProgress(db, refined.id, { checkpoint: continued, status: 'complete', expectedProgressVersion: 0 });
    expect(result.result).toEqual(simulationResult(refined.input, uninterrupted));
    expect(await db.planningAnalyses.get(original.id)).toEqual(original);
    expect(await pausePlanningAnalysis(db, original.id)).toEqual(original);
    await expect(refinePlanningAnalysis(db, original.id, 200_000)).rejects.toThrow('aumentar');
    await expect(saveAnalysisProgress(db, original.id, { checkpoint: original.checkpoint, status: 'paused', expectedProgressVersion: original.progressVersion })).rejects.toThrow('concluída');
    vi.spyOn(db.simulationCheckpoints, 'add').mockRejectedValueOnce(new Error('Refinement checkpoint unavailable.'));
    await expect(refinePlanningAnalysis(db, original.id, 500_000)).rejects.toThrow('Refinement checkpoint unavailable');
    expect(await db.planningAnalyses.count()).toBe(2);
    expect(await db.simulationCheckpoints.count()).toBe(2);
    expect(await db.planningAnalyses.get(original.id)).toEqual(original);
  }, 30_000);

  it('keeps analysis creation atomic and requires completion before refinement', async () => {
    const db = store();
    const plan = candidate();
    await savePlanningCandidates(db, { groupId: GROUP, poolId: POOL, candidates: [plan] });
    vi.spyOn(db.simulationCheckpoints, 'add').mockRejectedValueOnce(new Error('No space.'));
    await expect(createPlanningAnalysis(db, { id: id(90), groupId: GROUP, poolId: POOL, candidateId: plan.id, input: { lotteryId: plan.lotteryId, bets: plan.bets.map(bet => bet.numbers), seed: SEED, targetSamples: 200_000 } })).rejects.toThrow('No space');
    expect(await db.planningAnalyses.count()).toBe(0);
    expect(await db.simulationCheckpoints.count()).toBe(0);
    const initial = await preparedAnalysis(db);
    await expect(refinePlanningAnalysis(db, initial.id, 1_000_000)).rejects.toThrow('Conclua');
  });

  it('includes candidates, paused analysis and exact checkpoints in the emergency export', async () => {
    const db = store();
    const initial = await preparedAnalysis(db);
    const checkpoint = runSimulationBatch(initial.input, initial.checkpoint, 200);
    const paused = await saveAnalysisProgress(db, initial.id, { checkpoint, status: 'paused', expectedProgressVersion: 0 });
    const exported = JSON.parse(await exportEmergencySnapshot(db));
    expect(exported.format).toBe('bolao-emergency-v5');
    expect(exported.planningCandidates).toHaveLength(1);
    expect(exported.planningAnalyses).toEqual([paused]);
    expect(exported.simulationCheckpoints[0]).toMatchObject({ analysisId: paused.id, checkpoint: paused.checkpoint, progressVersion: paused.progressVersion });
    expect(exported.planningCommands).toEqual([]);
  });
});
