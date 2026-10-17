import type { BetData, LocalRecord, LotteryId, PersonData, PoolData } from './types';
import type { FinancialSnapshot } from './financial-types';
import type { PlanningLotteryCatalog } from './planning-catalog';

export type PlanStrategy = 'spread' | 'balanced' | 'concentrated';
/** Records an authorized destination; it does not execute a refund or create wallet credit. */
export type LeftoverPolicy = 'unassigned' | 'refund-pro-rata' | 'group-credit';
export type PlanParticipationMode = Exclude<PoolData['participationMode'], 'undecided'>;

export interface PlanRight {
  quotaId: string;
  sourceQuotaId: string;
  sourceQuotaVersion: number;
  personId: string;
  units: number;
  dueCents: string;
  statuteId: string;
}
export interface PlanBet {
  key: string;
  /** Both source fields are null for a generated bet retained only in the applied plan. */
  sourceBetId: string | null;
  sourceBetVersion: number | null;
  numbers: number[];
  authorIds: string[];
  seed: string | null;
  generationAlgorithmVersion: string | null;
}
export interface OfficialQuotaAssignment {
  quotaId: string;
  personId: string;
  officialQuotas: number;
}
export interface PlanTicket {
  key: string;
  numberCount: number;
  betKeys: string[];
  betCostCents: string;
  /** An internal agreement has no official quota count or quota receipt. */
  officialQuotaCount: number | null;
  officialQuotaValueCents: string | null;
  assignments: OfficialQuotaAssignment[];
}
export interface PreparedPlan {
  id: string;
  groupId: string;
  poolId: string;
  poolVersion: number;
  groupRevision: number;
  lotteryId: LotteryId;
  contestNumber: number;
  /** Teimosinha: consecutive contests the games are played for; every bet and ticket cost is multiplied by it. Absent in plans made before it: 1. */
  contestCount?: number;
  participationMode: PlanParticipationMode;
  strategy: PlanStrategy;
  seed: string;
  catalogVersion: string;
  /** Every observed draft bet; version zero is local-only and cannot be confirmed online. */
  sourceBets: { id: string; version: number }[];
  rights: PlanRight[];
  budgetCents: string;
  betCostCents: string;
  feeCents: string;
  feeLabel: string;
  totalCostCents: string;
  leftoverCents: string;
  leftoverPolicy: LeftoverPolicy;
  /** Confirmed prizes up to this amount are not split: they stay in the group cash (internal agreement only). Absent (or null) = no limit: plans without one keep the shape and hash they had before the field existed. */
  groupPrizeLimitCents?: string | null;
  bets: PlanBet[];
  tickets: PlanTicket[];
  explanation: string;
}
export interface SuggestPlansInput {
  groupId: string;
  groupRevision: number;
  pool: LocalRecord<'pool'>;
  sourceBets: LocalRecord<'bet'>[];
  financial: FinancialSnapshot;
  seed: string;
  feeCents: string;
  feeLabel: string;
  leftoverPolicy: LeftoverPolicy;
  /** Null or absent = no limit; see PreparedPlan.groupPrizeLimitCents. */
  groupPrizeLimitCents?: string | null;
}
export interface PlanSuggestionResult {
  plans: PreparedPlan[];
  unavailable: { strategy: PlanStrategy; reason: string }[];
}
export interface AppliedPlan {
  id: string;
  groupId: string;
  poolId: string;
  version: number;
  plan: PreparedPlan;
  appliedAt: string;
  receiptId: string;
}
/** Stable ASCII-key JSON; integers are safe, cents are strings, arrays retain their defined order. */
export interface ManifestContent {
  schemaVersion: 'pool-manifest-v1';
  catalog: PlanningLotteryCatalog;
  responsible: { organizerUserId: string; registrarPersonId: string; ticketHolderPersonId: string | null };
  pool: { id: string; version: number; data: PoolData };
  plan: PreparedPlan;
  persons: { id: string; version: number; data: PersonData }[];
  /** Complete coherent immutable facts as seen at this lock; no inferred payments. */
  financial: FinancialSnapshot;
}
export interface PoolManifest {
  id: string;
  groupId: string;
  poolId: string;
  version: number;
  appliedPlanId: string;
  content: ManifestContent;
  canonical: string;
  sha256: string;
  lockedAt: string;
  receiptId: string;
}
export interface PlanningSnapshot {
  groupId: string;
  groupRevision: number;
  appliedPlans: AppliedPlan[];
  manifests: PoolManifest[];
}
export type PlanningAction =
  | { type: 'plan_apply'; plan: PreparedPlan }
  | { type: 'pool_lock'; poolId: string; poolVersion: number; appliedPlanId: string; responsible: { registrarPersonId: string; ticketHolderPersonId: string | null } };
export interface PlanningCommand {
  apiVersion: 'v1';
  idempotencyKey: string;
  groupId: string;
  expectedRevision: number;
  action: PlanningAction;
}
export interface PlanningReceipt {
  apiVersion: 'v1';
  idempotencyKey: string;
  /** Server receipt UUID, distinct from the caller's idempotency namespace. */
  receiptId: string | null;
  groupId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  groupRevision: number;
  message: string | null;
  confirmedAt: string | null;
  snapshot: PlanningSnapshot | null;
}
export interface PlanningTransport {
  planningPull(groupId: string): Promise<PlanningSnapshot>;
  planningDecide(command: PlanningCommand): Promise<PlanningReceipt>;
  planningCommandStatus(idempotencyKey: string): Promise<PlanningReceipt | null>;
}

export interface ExactPortfolioProbability {
  status: 'exact' | 'unavailable';
  method: 'distinct-combination-union';
  enumerationLimit: number;
  elementaryCombinations: string;
  distinctCombinations: string | null;
  denominator: string;
  probability: number | null;
  reason: string | null;
}
export interface SimulationInput {
  lotteryId: LotteryId;
  bets: number[][];
  seed: string;
  /** The supported production range is 200,000 through 1,000,000 independent draws. */
  targetSamples: number;
}
export interface SimulationCheckpoint {
  algorithmVersion: string;
  inputSignature: string;
  processedSamples: number;
  randomWordOffset: number;
  anyPrizeHits: number;
  /** Number of draws with at least one elementary winning combination in each tier. */
  hitsByTier: Record<string, number>;
}
export interface SimulationEstimate {
  hits: number;
  probability: number;
  lower95: number;
  upper95: number;
}
export interface SimulationResult {
  algorithmVersion: string;
  seed: string;
  samples: number;
  complete: boolean;
  anyPrize: SimulationEstimate;
  tiers: Record<string, SimulationEstimate>;
  /** A zero count is an observation, never proof of zero probability. */
  zeroHitsMeaning: 'not-proof-of-zero-probability';
}
export interface PlanningAnalysis {
  id: string;
  groupId: string;
  poolId: string;
  candidateId: string;
  input: SimulationInput;
  checkpoint: SimulationCheckpoint;
  result: SimulationResult | null;
}
/** Source data helper for callers that do not store LocalRecord. */
export type FixedPlanBet = Pick<BetData, 'numbers' | 'authorIds' | 'seed' | 'generationAlgorithmVersion'> & { id: string; version: number };
