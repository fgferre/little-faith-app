/** Financial facts are immutable server records; draft sync cannot create them. */
export interface StatuteVersion {
  id: string;
  groupId: string;
  version: number;
  text: string;
  sourceGroupVersion: number;
  publishedAt: string;
  receiptId: string;
}

export interface StatuteAcceptance {
  id: string;
  groupId: string;
  statuteId: string;
  personId: string;
  evidence: string;
  acceptedAt: string;
  receiptId: string;
}

export interface ReceivedPayment {
  id: string;
  groupId: string;
  personId: string;
  sourceProposalId: string;
  sourceProposalVersion: number;
  amountCents: string;
  bankReference: string | null;
  declaredReceivedAt: string | null;
  confirmedAt: string;
  receiptId: string;
}

export interface PaymentAllocation {
  id: string;
  groupId: string;
  paymentId: string;
  personId: string;
  poolId: string;
  amountCents: string;
  allocatedAt: string;
  receiptId: string;
}

export interface FinancialMovement {
  id: string;
  groupId: string;
  paymentId: string;
  personId: string;
  poolId: string | null;
  allocationId: string | null;
  kind: 'payment-received' | 'payment-allocated' | 'payment-reversed' | 'allocation-reversed';
  /** Reversals use negative integer cents. */
  amountCents: string;
  reason: string;
  createdAt: string;
  receiptId: string;
}

export interface ConfirmedQuota {
  id: string;
  groupId: string;
  poolId: string;
  personId: string;
  sourceQuotaId: string;
  sourceQuotaVersion: number;
  units: number;
  dueCents: string;
  statuteId: string;
  confirmedAt: string;
  receiptId: string;
}

export interface QuotaRevocation {
  id: string;
  groupId: string;
  quotaId: string;
  reason: string;
  revokedAt: string;
  receiptId: string;
}

export interface FinancialSnapshot {
  groupId: string;
  groupRevision: number;
  statutes: StatuteVersion[];
  acceptances: StatuteAcceptance[];
  payments: ReceivedPayment[];
  allocations: PaymentAllocation[];
  movements: FinancialMovement[];
  quotas: ConfirmedQuota[];
  revocations: QuotaRevocation[];
}

export type FinancialAction =
  | { type: 'statute_publish'; groupVersion: number }
  | { type: 'statute_accept'; statuteId: string; personId: string; evidence: string }
  | {
    type: 'payment_confirm';
    proposalId: string;
    proposalVersion: number;
    bankReference: string | null;
    declaredReceivedAt: string | null;
    /** May leave some money unallocated or distribute it among this group's pools. */
    allocations: { poolId: string; amountCents: string }[];
  }
  | { type: 'payment_allocate'; paymentId: string; poolId: string; amountCents: string }
  | { type: 'payment_reverse'; paymentId: string; reason: string }
  | { type: 'quota_confirm'; quotaId: string; quotaVersion: number; statuteId: string };

export interface FinancialCommand {
  apiVersion: 'v1';
  idempotencyKey: string;
  groupId: string;
  /** Includes draft changes: the human approves the complete current group revision. */
  expectedRevision: number;
  action: FinancialAction;
}

export interface FinancialReceipt {
  apiVersion: 'v1';
  idempotencyKey: string;
  groupId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  groupRevision: number;
  message: string | null;
  confirmedAt: string | null;
  snapshot: FinancialSnapshot | null;
}

export interface FinancialTransport {
  financialPull(groupId: string): Promise<FinancialSnapshot>;
  reviewDecide(command: FinancialCommand): Promise<FinancialReceipt>;
  financialCommandStatus(idempotencyKey: string): Promise<FinancialReceipt | null>;
}
