import Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
  AppliedPlan, ConfirmedPayment, ConfirmedQuota, DraftOperation, FinancialCommand, FinancialMovement,
  FinancialReceipt, LocalRecord, PaymentAllocation, PushReceipt, QuotaRevocation,
  PlanningAnalysis, PlanningCommand, PlanningReceipt, PoolManifest, PreparedPlan,
  ReceivedPayment, SimulationCheckpoint, StatuteAcceptance, StatuteVersion,
  EvidenceMetadata, EvidenceUploadMetadata,
  ContestCalendarVersion, ContestResultVersion, RegistrationCommand, RegistrationReceipt,
  RegistrationReport, ResultCommand, ResultReceipt, ResultSelection,
  ExpenseConfirmation, FinancialSnapshot, PoolSettlement, PrizeConfirmation, PrizeRedemption,
  RegistrationSnapshot, ResultSnapshot, SettlementCommand, SettlementDistribution, SettlementReceipt,
} from '@bolao/core';

export interface LocalStoreOptions {
  installationId: string;
  /** Use a distinct accountId such as "demo" for demonstration data. */
  accountId: string;
}

export type OperationStatus = 'queued' | 'in-flight' | 'conflict' | 'rejected';

export interface QueuedOperation extends DraftOperation {
  localVersion: number;
  sequence: number;
  status: OperationStatus;
  /** A later edit waits for the receipt of its preceding edit to this entity. */
  dependsOn: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  message: string | null;
}

export interface SyncCursor { groupId: string; cursor: number }
export interface LocalMetadata { key: string; value: unknown }
export type FinancialCommandStatus = 'prepared' | 'sending' | 'unknown' | 'accepted' | 'conflict' | 'rejected';
export interface PersistentFinancialCommand {
  idempotencyKey: string;
  groupId: string;
  command: FinancialCommand;
  status: FinancialCommandStatus;
  receipt?: FinancialReceipt;
  createdAt: string;
  updatedAt: string;
}
export interface FinancialSnapshotMetadata { groupId: string; groupRevision: number; updatedAt: string }
export type PlanningCommandStatus = FinancialCommandStatus;
export interface PersistentPlanningCommand {
  idempotencyKey: string;
  groupId: string;
  command: PlanningCommand;
  status: PlanningCommandStatus;
  receipt?: PlanningReceipt;
  createdAt: string;
  updatedAt: string;
}
export interface PlanningSnapshotMetadata { groupId: string; groupRevision: number; updatedAt: string }
export interface PersistentPlanningCandidate {
  id: string;
  groupId: string;
  poolId: string;
  candidate: PreparedPlan;
  createdAt: string;
}
export type AnalysisStatus = 'prepared' | 'running' | 'paused' | 'complete' | 'failed';
export interface PersistentPlanningAnalysis extends PlanningAnalysis {
  status: AnalysisStatus;
  /** Compare-and-swap token for Worker callbacks racing with pause or resume. */
  progressVersion: number;
  createdAt: string;
  updatedAt: string;
  refinedFromId?: string;
}
export interface PersistentSimulationCheckpoint {
  analysisId: string;
  groupId: string;
  poolId: string;
  checkpoint: SimulationCheckpoint;
  progressVersion: number;
  updatedAt: string;
}
export type EvidenceUploadStatus = 'prepared' | 'uploading' | 'unknown' | 'uploaded';
export interface PersistentEvidenceUpload extends EvidenceUploadMetadata {
  /** Provenance is checked before sending a private file from this database. */
  accountId: string;
  original: Blob;
  status: EvidenceUploadStatus;
  confirmedMetadata?: EvidenceMetadata;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export type RegistrationCommandStatus = FinancialCommandStatus;
export interface PersistentRegistrationCommand {
  idempotencyKey: string;
  groupId: string;
  command: RegistrationCommand;
  status: RegistrationCommandStatus;
  receipt?: RegistrationReceipt;
  createdAt: string;
  updatedAt: string;
}
export interface RegistrationSnapshotMetadata {
  groupId: string;
  groupRevision: number;
  updatedAt: string;
  /** Technical uploads may be known before this complete registration revision. */
  evidenceIds: string[];
}
export type ResultCommandStatus = FinancialCommandStatus;
export interface PersistentResultCommand {
  idempotencyKey: string;
  groupId: string;
  command: ResultCommand;
  status: ResultCommandStatus;
  receipt?: ResultReceipt;
  createdAt: string;
  updatedAt: string;
}
export interface ResultSnapshotMetadata { groupId: string; groupRevision: number; updatedAt: string }
export interface PersistentResultCollectionAttempt {
  id: string;
  groupId: string;
  poolId: string;
  status: 'collecting' | 'succeeded' | 'failed';
  snapshotRevision: number | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}
type SnapshotReferences<T> = { [K in Exclude<keyof T, 'groupId' | 'groupRevision'>]: string[] };
export interface SettlementSourceReferences {
  financial: SnapshotReferences<FinancialSnapshot>;
  registration: SnapshotReferences<RegistrationSnapshot>;
  results: SnapshotReferences<ResultSnapshot>;
}
export type SettlementCommandStatus = FinancialCommandStatus;
export interface PersistentSettlementCommand {
  idempotencyKey: string;
  groupId: string;
  command: SettlementCommand;
  status: SettlementCommandStatus;
  receipt?: SettlementReceipt;
  createdAt: string;
  updatedAt: string;
}
export interface SettlementSnapshotMetadata {
  groupId: string;
  groupRevision: number;
  updatedAt: string;
  /** Exact immutable source rows in this cut; later pulls never change its meaning. */
  sources: SettlementSourceReferences;
}

export class BolaoDatabase extends Dexie {
  readonly installationId: string;
  readonly accountId: string;
  records!: Table<LocalRecord, string>;
  operations!: Table<QueuedOperation, string>;
  receipts!: Table<PushReceipt, string>;
  cursors!: Table<SyncCursor, string>;
  confirmedPayments!: Table<ConfirmedPayment, string>;
  metadata!: Table<LocalMetadata, string>;
  /** The remote copy never replaces a pending local proposal. */
  serverRecords!: Table<LocalRecord, string>;
  statutes!: Table<StatuteVersion, string>;
  statuteAcceptances!: Table<StatuteAcceptance, string>;
  receivedPayments!: Table<ReceivedPayment, string>;
  paymentAllocations!: Table<PaymentAllocation, string>;
  financialMovements!: Table<FinancialMovement, string>;
  confirmedQuotas!: Table<ConfirmedQuota, string>;
  quotaRevocations!: Table<QuotaRevocation, string>;
  financialSnapshots!: Table<FinancialSnapshotMetadata, string>;
  financialCommands!: Table<PersistentFinancialCommand, string>;
  financialReceipts!: Table<FinancialReceipt, string>;
  planningCandidates!: Table<PersistentPlanningCandidate, string>;
  planningAnalyses!: Table<PersistentPlanningAnalysis, string>;
  simulationCheckpoints!: Table<PersistentSimulationCheckpoint, string>;
  appliedPlans!: Table<AppliedPlan, string>;
  poolManifests!: Table<PoolManifest, string>;
  planningSnapshots!: Table<PlanningSnapshotMetadata, string>;
  planningCommands!: Table<PersistentPlanningCommand, string>;
  planningReceipts!: Table<PlanningReceipt, string>;
  evidenceUploads!: Table<PersistentEvidenceUpload, string>;
  confirmedEvidence!: Table<EvidenceMetadata, string>;
  registrationManifests!: Table<PoolManifest, string>;
  registrationReports!: Table<RegistrationReport, string>;
  registrationSnapshots!: Table<RegistrationSnapshotMetadata, string>;
  registrationCommands!: Table<PersistentRegistrationCommand, string>;
  registrationReceipts!: Table<RegistrationReceipt, string>;
  contestResults!: Table<ContestResultVersion, string>;
  resultSelections!: Table<ResultSelection, string>;
  contestCalendars!: Table<ContestCalendarVersion, string>;
  resultSnapshots!: Table<ResultSnapshotMetadata, string>;
  resultCommands!: Table<PersistentResultCommand, string>;
  resultReceipts!: Table<ResultReceipt, string>;
  resultCollectionAttempts!: Table<PersistentResultCollectionAttempt, string>;
  expenseConfirmations!: Table<ExpenseConfirmation, string>;
  prizeConfirmations!: Table<PrizeConfirmation, string>;
  prizeRedemptions!: Table<PrizeRedemption, string>;
  settlementDistributions!: Table<SettlementDistribution, string>;
  poolSettlements!: Table<PoolSettlement, string>;
  settlementSnapshots!: Table<SettlementSnapshotMetadata, string>;
  settlementCommands!: Table<PersistentSettlementCommand, string>;
  settlementReceipts!: Table<SettlementReceipt, string>;

  constructor(options: LocalStoreOptions) {
    if (!options.installationId.trim() || !options.accountId.trim()) {
      throw new Error('A instalação e a conta são necessárias para abrir os dados locais.');
    }
    super(`bolao:${encodeURIComponent(options.installationId)}:${encodeURIComponent(options.accountId)}`);
    this.installationId = options.installationId;
    this.accountId = options.accountId;
    // Keep the database name stable; future migrations must preserve the outbox.
    this.version(1).stores({
      records: '&id, groupId, kind, state, [kind+groupId]',
      operations: '&idempotencyKey, entityId, groupId, sequence, status, dependsOn',
      receipts: '&idempotencyKey, entityId, status',
      cursors: '&groupId',
      confirmedPayments: '&id, groupId, poolId, personId, receiptId',
      metadata: '&key',
      serverRecords: '&id, groupId, kind',
    });
    // Add immutable financial facts without moving or clearing legacy data/outbox.
    this.version(2).stores({
      statutes: '&id, groupId, version, receiptId, [groupId+version]',
      statuteAcceptances: '&id, groupId, statuteId, personId, receiptId, [statuteId+personId]',
      receivedPayments: '&id, groupId, personId, sourceProposalId, receiptId',
      paymentAllocations: '&id, groupId, paymentId, personId, poolId, receiptId',
      financialMovements: '&id, groupId, paymentId, personId, poolId, allocationId, kind, receiptId',
      confirmedQuotas: '&id, groupId, poolId, personId, sourceQuotaId, statuteId, receiptId',
      quotaRevocations: '&id, groupId, quotaId, receiptId',
      financialSnapshots: '&groupId, groupRevision',
      financialCommands: '&idempotencyKey, groupId, status, createdAt',
      financialReceipts: '&idempotencyKey, groupId, status',
    });
    // Local analyses and confirmed plans remain independent from draft/financial queues.
    this.version(3).stores({
      planningCandidates: '&id, groupId, poolId, [groupId+poolId]',
      planningAnalyses: '&id, groupId, poolId, candidateId, status, [groupId+poolId]',
      simulationCheckpoints: '&analysisId, groupId, poolId, [groupId+poolId]',
      appliedPlans: '&id, groupId, poolId, receiptId, [groupId+poolId]',
      poolManifests: '&id, groupId, poolId, version, appliedPlanId, receiptId, [groupId+poolId]',
      planningSnapshots: '&groupId, groupRevision',
      planningCommands: '&idempotencyKey, groupId, status, createdAt',
      planningReceipts: '&idempotencyKey, groupId, status',
    });
    // Originals remain local; confirming a technical upload never confirms registration.
    this.version(4).stores({
      evidenceUploads: '&id, groupId, poolId, status, [groupId+poolId]',
      confirmedEvidence: '&id, groupId, poolId, sha256, [groupId+poolId]',
      registrationManifests: '&id, groupId, poolId, version, [groupId+poolId]',
      registrationReports: '&id, groupId, poolId, manifestId, version, receiptId, [groupId+poolId]',
      registrationSnapshots: '&groupId, groupRevision',
      registrationCommands: '&idempotencyKey, groupId, status, createdAt',
      registrationReceipts: '&idempotencyKey, groupId, status',
      contestResults: '&id, groupId, poolId, version, source, sha256, [groupId+poolId]',
      resultSelections: '&id, groupId, poolId, version, resultId, receiptId, [groupId+poolId]',
      contestCalendars: '&id, groupId, poolId, version, receiptId, [groupId+poolId]',
      resultSnapshots: '&groupId, groupRevision',
      resultCommands: '&idempotencyKey, groupId, status, createdAt',
      resultReceipts: '&idempotencyKey, groupId, status',
      resultCollectionAttempts: '&id, groupId, poolId, status, createdAt, [groupId+poolId]',
    });
    // Settlement facts are explicit human decisions, separate from calculations and drafts.
    this.version(5).stores({
      expenseConfirmations: '&id, groupId, poolId, version, groupRevision, registrationReportId, supersedesId, receiptId, [groupId+poolId]',
      prizeConfirmations: '&id, groupId, poolId, version, groupRevision, registrationReportId, resultId, supersedesId, receiptId, [groupId+poolId]',
      prizeRedemptions: '&id, groupId, poolId, version, groupRevision, prizeConfirmationId, personId, direction, reversesId, receiptId, [groupId+poolId]',
      settlementDistributions: '&id, groupId, poolId, version, groupRevision, personId, kind, direction, reversesId, receiptId, [groupId+poolId]',
      poolSettlements: '&id, groupId, poolId, version, groupRevision, direction, previousClosureId, receiptId, [groupId+poolId]',
      settlementSnapshots: '&groupId, groupRevision',
      settlementCommands: '&idempotencyKey, groupId, status, createdAt',
      settlementReceipts: '&idempotencyKey, groupId, status',
    });
  }
}

export function createLocalStore(options: LocalStoreOptions): BolaoDatabase {
  return new BolaoDatabase(options);
}

/** Discovering a group registers its cursor without removing any local work. */
export async function trackGroup(db: BolaoDatabase, groupId: string): Promise<void> {
  if (!groupId.trim()) throw new Error('O grupo é necessário para sincronizar.');
  await db.transaction('rw', db.cursors, async () => {
    if (!await db.cursors.get(groupId)) await db.cursors.add({ groupId, cursor: 0 });
  });
}

/** Recover from an expired server cursor by loading again, preserving drafts. */
export async function resetSyncCursor(db: BolaoDatabase, groupId: string): Promise<void> {
  if (!groupId.trim()) throw new Error('O grupo é necessário para sincronizar.');
  await db.cursors.put({ groupId, cursor: 0 });
}

export async function nextSequence(db: BolaoDatabase): Promise<number> {
  const previous = (await db.metadata.get('outboxSequence'))?.value;
  if (previous !== undefined && (typeof previous !== 'number' || !Number.isSafeInteger(previous) || previous < 1)) {
    throw new Error('A sequência local é inválida.');
  }
  const sequence = typeof previous === 'number' ? previous + 1 : 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('A sequência local é inválida.');
  await db.metadata.put({ key: 'outboxSequence', value: sequence });
  return sequence;
}
