import type { LotteryId } from './types';
import type { OfficialQuotaAssignment, PoolManifest } from './planning-types';
import type { ContestCalendarVersion } from './result-types';

export type EvidenceMimeType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
export interface EvidenceUploadMetadata {
  id: string;
  groupId: string;
  poolId: string;
  sha256: string;
  mimeType: EvidenceMimeType;
  byteSize: number;
  originalName: string;
}
/** Server-verified original bytes in private Storage; an upload does not confirm a registration. */
export interface EvidenceMetadata extends EvidenceUploadMetadata {
  storagePath: string;
  uploadedByUserId: string;
  uploadedAt: string;
}
export type ConfirmedEvidence = EvidenceMetadata;
export interface EvidenceTransport {
  evidenceUpload(metadata: EvidenceUploadMetadata, original: Blob): Promise<EvidenceMetadata>;
  evidenceStatus(id: string): Promise<EvidenceMetadata | null>;
}
/** Null means unreadable/unknown, never an inferred copy of the planned value. */
export interface ObservedTicket {
  lotteryId: LotteryId | null;
  contestNumber: number | null;
  betNumbers: number[][] | null;
  betCostCents: string | null;
  feeCents: string | null;
  officialQuotaCount: number | null;
  officialAssignments: OfficialQuotaAssignment[] | null;
  /** Receipt event time, distinct from upload/confirmation time and the pool's internal deadline. */
  registeredAt: string | null;
}
export interface RegistrationItem {
  plannedTicketKey: string;
  evidenceIds: string[];
  observed: ObservedTicket | null;
  reason: string;
}
export type RegistrationIssueCode =
  | 'missing-receipt' | 'unreadable-receipt' | 'missing-field' | 'lottery-mismatch'
  | 'contest-mismatch' | 'numbers-mismatch' | 'bet-cost-mismatch' | 'fee-mismatch'
  | 'official-quota-mismatch' | 'official-assignment-mismatch' | 'official-rule-mismatch'
  | 'registered-before-lock' | 'registration-after-channel-close' | 'evidence-after-internal-deadline';
export interface RegistrationIssue {
  plannedTicketKey: string | null;
  code: RegistrationIssueCode;
  severity: 'incomplete' | 'divergence' | 'notice';
  message: string;
}
export interface RegistrationComparison {
  status: 'partial' | 'divergent' | 'complete';
  observedTicketCount: number;
  missingTicketCount: number;
  /** Null when some receipts/costs are missing. These are observed expenses, not ledger entries. */
  observedBetCostCents: string | null;
  observedFeeCents: string | null;
  issues: RegistrationIssue[];
}
export interface RegistrationReport {
  id: string;
  groupId: string;
  poolId: string;
  version: number;
  poolVersion: number;
  manifestId: string;
  /** Calendar used at review time; later schedule corrections do not rewrite this comparison. */
  calendar: ContestCalendarVersion | null;
  items: RegistrationItem[];
  reason: string;
  comparison: RegistrationComparison;
  confirmedAt: string;
  receiptId: string;
}
export interface RegistrationSnapshot {
  groupId: string;
  groupRevision: number;
  /** All visible manifests, including pools without reports, make the first review self-contained. */
  manifests: PoolManifest[];
  evidence: EvidenceMetadata[];
  reports: RegistrationReport[];
}
export interface RegistrationCommand {
  apiVersion: 'v1';
  idempotencyKey: string;
  groupId: string;
  expectedRevision: number;
  action: {
    type: 'registration_confirm';
    poolId: string;
    poolVersion: number;
    manifestId: string;
    /** The exact complete checklist, including explicit missing items. */
    items: RegistrationItem[];
    reason: string;
  };
}
export interface RegistrationReceipt {
  apiVersion: 'v1';
  idempotencyKey: string;
  receiptId: string | null;
  groupId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  groupRevision: number;
  message: string | null;
  confirmedAt: string | null;
  snapshot: RegistrationSnapshot | null;
}
export interface RegistrationTransport {
  registrationPull(groupId: string): Promise<RegistrationSnapshot>;
  registrationDecide(command: RegistrationCommand): Promise<RegistrationReceipt>;
  registrationCommandStatus(idempotencyKey: string): Promise<RegistrationReceipt | null>;
}
