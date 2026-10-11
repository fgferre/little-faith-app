import {
  createSimulationCheckpoint, simulationResult, validatePreparedPlan,
  validateSimulationCheckpoint, validateSimulationInput,
} from '@bolao/core';
import type { PreparedPlan, SimulationCheckpoint, SimulationInput, SimulationResult } from '@bolao/core';
import type {
  AnalysisStatus, BolaoDatabase, PersistentPlanningAnalysis, PersistentPlanningCandidate,
} from './database';
import { canonical } from './integrity';

export interface SavePlanningCandidatesInput { groupId: string; poolId: string; candidates: PreparedPlan[] }
export interface CreatePlanningAnalysisInput {
  id?: string;
  groupId: string;
  poolId: string;
  candidateId: string;
  input: SimulationInput;
}
export interface SaveAnalysisProgressInput {
  checkpoint: SimulationCheckpoint;
  status: Exclude<AnalysisStatus, 'prepared'>;
  /** A pause/resume invalidates in-flight Worker callbacks carrying the old version. */
  expectedProgressVersion: number;
  result?: SimulationResult | null;
}

function identifier(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`O identificador de ${name} é inválido.`);
  }
  return normalized;
}

/** Candidate inputs, seed and deterministic identity are immutable once saved. */
export async function savePlanningCandidates(
  db: BolaoDatabase,
  input: SavePlanningCandidatesInput,
): Promise<PersistentPlanningCandidate[]> {
  const groupId = identifier(input.groupId, 'grupo');
  const poolId = identifier(input.poolId, 'bolão');
  const candidates = await Promise.all(input.candidates.map(candidate => validatePreparedPlan(candidate)));
  if (candidates.some(candidate => candidate.groupId !== groupId || candidate.poolId !== poolId)) {
    throw new Error('Um candidato pertence a outro grupo ou bolão.');
  }
  return db.transaction('rw', db.planningCandidates, async () => {
    const saved: PersistentPlanningCandidate[] = [];
    for (const candidate of candidates) {
      const existing = await db.planningCandidates.get(candidate.id);
      if (existing) {
        if (existing.groupId !== groupId || existing.poolId !== poolId || canonical(existing.candidate) !== canonical(candidate)) {
          throw new Error('O identificador determinístico já pertence a outro candidato.');
        }
        saved.push(existing);
      } else {
        const record: PersistentPlanningCandidate = { id: candidate.id, groupId, poolId, candidate, createdAt: new Date().toISOString() };
        await db.planningCandidates.add(record);
        saved.push(record);
      }
    }
    return saved;
  });
}

export function listPlanningCandidates(db: BolaoDatabase, groupId: string, poolId: string): Promise<PersistentPlanningCandidate[]> {
  return db.planningCandidates.where('[groupId+poolId]')
    .equals([identifier(groupId, 'grupo'), identifier(poolId, 'bolão')]).toArray();
}

/** Persist initial inputs/checkpoint atomically. This helper performs no simulation. */
export async function createPlanningAnalysis(
  db: BolaoDatabase,
  input: CreatePlanningAnalysisInput,
): Promise<PersistentPlanningAnalysis> {
  const id = identifier(input.id ?? crypto.randomUUID(), 'análise');
  const groupId = identifier(input.groupId, 'grupo');
  const poolId = identifier(input.poolId, 'bolão');
  const candidateId = identifier(input.candidateId, 'candidato');
  const simulationInput = validateSimulationInput(input.input);
  const checkpoint = createSimulationCheckpoint(simulationInput);
  return db.transaction('rw', db.planningCandidates, db.planningAnalyses, db.simulationCheckpoints, async () => {
    const candidate = await db.planningCandidates.get(candidateId);
    if (!candidate || candidate.groupId !== groupId || candidate.poolId !== poolId) {
      throw new Error('O candidato não está salvo neste grupo e bolão.');
    }
    if (simulationInput.lotteryId !== candidate.candidate.lotteryId
      || canonical(simulationInput.bets) !== canonical(candidate.candidate.bets.map(bet => bet.numbers))) {
      throw new Error('As entradas da simulação não correspondem aos jogos do candidato.');
    }
    const existing = await db.planningAnalyses.get(id);
    if (existing) {
      if (existing.groupId !== groupId || existing.poolId !== poolId || existing.candidateId !== candidateId
        || canonical(existing.input) !== canonical(simulationInput)) {
        throw new Error('Esta análise já possui outras entradas, grupo ou semente.');
      }
      return existing;
    }
    const now = new Date().toISOString();
    const analysis: PersistentPlanningAnalysis = {
      id, groupId, poolId, candidateId, input: simulationInput, checkpoint, result: null,
      status: 'prepared', progressVersion: 0, createdAt: now, updatedAt: now,
    };
    await db.planningAnalyses.add(analysis);
    await db.simulationCheckpoints.add({ analysisId: id, groupId, poolId, checkpoint, progressVersion: 0, updatedAt: now });
    return analysis;
  });
}

export function listPlanningAnalyses(db: BolaoDatabase, groupId: string, poolId: string): Promise<PersistentPlanningAnalysis[]> {
  return db.planningAnalyses.where('[groupId+poolId]')
    .equals([identifier(groupId, 'grupo'), identifier(poolId, 'bolão')]).toArray();
}

/** Save one Worker batch with its status; stale callbacks cannot undo a pause or newer batch. */
export async function saveAnalysisProgress(
  db: BolaoDatabase,
  id: string,
  input: SaveAnalysisProgressInput,
): Promise<PersistentPlanningAnalysis> {
  const analysisId = identifier(id, 'análise');
  if (!Number.isSafeInteger(input.expectedProgressVersion) || input.expectedProgressVersion < 0) {
    throw new Error('A versão do progresso da análise é inválida.');
  }
  if (!['running', 'paused', 'complete', 'failed'].includes(input.status)) throw new Error('O estado da análise é inválido.');
  return db.transaction('rw', db.planningAnalyses, db.simulationCheckpoints, async () => {
    const existing = await db.planningAnalyses.get(analysisId);
    if (!existing) throw new Error('A análise não está salva nesta conta.');
    if (existing.progressVersion !== input.expectedProgressVersion) {
      throw new Error('O progresso mudou; este lote pertence a uma execução anterior.');
    }
    const checkpoint = validateSimulationCheckpoint(existing.input, input.checkpoint);
    if (checkpoint.processedSamples < existing.checkpoint.processedSamples) {
      throw new Error('Um checkpoint anterior não pode substituir o progresso salvo.');
    }
    if (checkpoint.randomWordOffset < existing.checkpoint.randomWordOffset
      || checkpoint.anyPrizeHits < existing.checkpoint.anyPrizeHits
      || Object.entries(existing.checkpoint.hitsByTier).some(([tier, hits]) => (checkpoint.hitsByTier[tier] ?? -1) < hits)) {
      throw new Error('Um checkpoint não pode perder contagens ou a posição da semente.');
    }
    if (checkpoint.processedSamples === existing.checkpoint.processedSamples
      && canonical(checkpoint) !== canonical(existing.checkpoint)) {
      throw new Error('Um checkpoint não pode mudar contagens sem novas amostras.');
    }
    if (existing.status === 'complete' && (input.status !== 'complete' || canonical(checkpoint) !== canonical(existing.checkpoint))) {
      throw new Error('Uma análise concluída não pode perder seu resultado.');
    }
    if (checkpoint.processedSamples === existing.input.targetSamples && input.status !== 'complete'
      || input.status === 'complete' && checkpoint.processedSamples !== existing.input.targetSamples) {
      throw new Error('O estado da análise não corresponde à quantidade de amostras.');
    }
    const result = checkpoint.processedSamples > 0 ? simulationResult(existing.input, checkpoint) : null;
    if (input.result !== undefined && canonical(input.result) !== canonical(result)) {
      throw new Error('O resultado não corresponde ao checkpoint salvo.');
    }
    const progressVersion = existing.progressVersion + 1;
    if (!Number.isSafeInteger(progressVersion)) throw new Error('A versão do progresso excedeu o limite local.');
    const now = new Date().toISOString();
    const updated: PersistentPlanningAnalysis = { ...existing, checkpoint, result, status: input.status, progressVersion, updatedAt: now };
    await db.planningAnalyses.put(updated);
    await db.simulationCheckpoints.put({ analysisId, groupId: existing.groupId, poolId: existing.poolId, checkpoint, progressVersion, updatedAt: now });
    return updated;
  });
}

async function changeAnalysisStatus(
  db: BolaoDatabase,
  id: string,
  status: 'running' | 'paused',
  expectedProgressVersion?: number,
): Promise<PersistentPlanningAnalysis> {
  const analysisId = identifier(id, 'análise');
  if (expectedProgressVersion !== undefined && (!Number.isSafeInteger(expectedProgressVersion) || expectedProgressVersion < 0)) {
    throw new Error('A versão do progresso da análise é inválida.');
  }
  return db.transaction('rw', db.planningAnalyses, db.simulationCheckpoints, async () => {
    const analysis = await db.planningAnalyses.get(analysisId);
    if (!analysis) throw new Error('A análise não está salva nesta conta.');
    // An obsolete Worker/unmount must not pause the analysis resumed by another owner.
    if (expectedProgressVersion !== undefined && analysis.progressVersion !== expectedProgressVersion) return analysis;
    if (analysis.status === 'complete') return analysis;
    return saveAnalysisProgress(db, analysisId, { checkpoint: analysis.checkpoint, status, expectedProgressVersion: analysis.progressVersion });
  });
}

/** Starting/resuming is explicit. The returned version must accompany the next Worker batch. */
export function resumePlanningAnalysis(db: BolaoDatabase, id: string): Promise<PersistentPlanningAnalysis> {
  return changeAnalysisStatus(db, id, 'running');
}

/** Invalidate callbacks already in flight, retaining the last completed batch for resumption. */
export function pausePlanningAnalysis(
  db: BolaoDatabase,
  id: string,
  expectedProgressVersion?: number,
): Promise<PersistentPlanningAnalysis> {
  return changeAnalysisStatus(db, id, 'paused', expectedProgressVersion);
}

/** Refinement is a new analysis; its completed source and original target remain immutable. */
export async function refinePlanningAnalysis(
  db: BolaoDatabase,
  id: string,
  targetSamples: number,
): Promise<PersistentPlanningAnalysis> {
  const sourceId = identifier(id, 'análise');
  return db.transaction('rw', db.planningAnalyses, db.simulationCheckpoints, async () => {
    const source = await db.planningAnalyses.get(sourceId);
    if (!source) throw new Error('A análise não está salva nesta conta.');
    if (source.status !== 'complete') throw new Error('Conclua esta análise antes de refinar as amostras.');
    if (targetSamples <= source.input.targetSamples) throw new Error('O refinamento precisa aumentar a quantidade de amostras.');
    const input = validateSimulationInput({ ...source.input, targetSamples });
    const initial = createSimulationCheckpoint(input);
    const checkpoint = validateSimulationCheckpoint(input, { ...source.checkpoint, inputSignature: initial.inputSignature });
    const now = new Date().toISOString();
    const refined: PersistentPlanningAnalysis = {
      id: crypto.randomUUID(), groupId: source.groupId, poolId: source.poolId, candidateId: source.candidateId,
      input, checkpoint, result: simulationResult(input, checkpoint), status: 'paused', progressVersion: 0,
      createdAt: now, updatedAt: now, refinedFromId: source.id,
    };
    await db.planningAnalyses.add(refined);
    await db.simulationCheckpoints.add({
      analysisId: refined.id, groupId: refined.groupId, poolId: refined.poolId,
      checkpoint, progressVersion: 0, updatedAt: now,
    });
    return refined;
  });
}

export const saveSimulationCheckpoint = saveAnalysisProgress;
