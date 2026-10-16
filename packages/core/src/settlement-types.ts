import type { FinancialSnapshot } from './financial-types';
import type { RegistrationSnapshot } from './registration-types';
import type { ResultSnapshot } from './result-types';

export interface RedemptionDeadline {
  ruleVersion: 'caixa-redemption-90-days-2026-10-08-v1';
  sourceUrl: string;
  verifiedAt: '2026-10-08';
  drawDate: string;
  /** Civil date in Brasília; this does not invent an hour or a channel's business hours. */
  deadlineDate: string;
  exception: { deadlineDate: string; sourceReference: string; reason: string } | null;
}
export interface RedemptionAlert {
  daysBefore: 30 | 15 | 7 | 1;
  alertDate: string;
  status: 'upcoming' | 'due' | 'overdue';
}
export interface RedemptionCountdown {
  deadlineDate: string;
  /** Whole Brasília civil days until the deadline: 0 on the last day, negative once it has passed. */
  daysLeft: number;
  /** 'alert' from the day the first prepared alert (30 days before) is due. */
  tone: 'normal' | 'alert' | 'overdue';
}
export interface SettlementFact {
  id: string;
  groupId: string;
  poolId: string;
  /** Sequence within this fact family and pool. */
  version: number;
  /** Committed group revision gives an unambiguous order even when timestamps coincide. */
  groupRevision: number;
  /** Observed entity version from the approved command. */
  poolVersion: number;
  confirmedAt: string;
  receiptId: string;
}
/** A human-confirmed total of actual expenses, independent of plan reservation or receipt extraction. */
export interface ExpenseConfirmation extends SettlementFact {
  manifestId: string;
  registrationReportId: string;
  supersedesId: string | null;
  betCostCents: string;
  feeCents: string;
  totalCostCents: string;
  evidenceIds: string[];
  sourceReference: string;
  reason: string;
}
/** Explicit face value and owner from each actual official quota receipt, never inferred rounding. */
export interface OfficialPrizeEntitlement {
  plannedTicketKey: string;
  quotaId: string;
  personId: string;
  officialQuotas: number;
  amountCents: string;
  evidenceIds: string[];
}
export interface SettlementRight {
  personId: string;
  quotaId: string;
  amountCents: string;
}
export interface PrizeConfirmation extends SettlementFact {
  manifestId: string;
  registrationReportId: string;
  resultId: string;
  observedResultIds: string[];
  resultSelectionId: string | null;
  supersedesId: string | null;
  calculatedPrizeCents: string | null;
  amountCents: string;
  officialEntitlements: OfficialPrizeEntitlement[];
  rights: SettlementRight[];
  evidenceIds: string[];
  sourceReference: string;
  reason: string;
  redemptionDeadline: RedemptionDeadline | null;
}
export interface PrizeRedemption extends SettlementFact {
  prizeConfirmationId: string;
  personId: string;
  ownership: 'organizer' | 'individual';
  direction: 'received' | 'reversed';
  reversesId: string | null;
  /** Negative only for an explicit full compensation referencing its positive original. */
  amountCents: string;
  evidenceIds: string[];
  sourceReference: string;
  eventAt: string;
  reason: string;
}
export interface SettlementDistribution extends SettlementFact {
  personId: string;
  kind: 'prize-payment' | 'contribution-refund';
  direction: 'paid' | 'returned';
  reversesId: string | null;
  /** Returned funds fully compensate the referenced payment without deleting it. */
  amountCents: string;
  evidenceIds: string[];
  sourceReference: string;
  eventAt: string;
  reason: string;
}
export interface SettlementPersonBalance {
  personId: string;
  quotaId: string | null;
  contributedCents: string;
  prizeRightCents: string | null;
  prizeReceivedCents: string;
  prizePendingCents: string | null;
  refundRightCents: string | null;
  refundedCents: string;
  refundPendingCents: string | null;
}
export interface PoolSettlementBalance {
  poolId: string;
  participationMode: 'internal' | 'official';
  manifestId: string;
  registrationReportId: string | null;
  expenseConfirmationId: string | null;
  prizeConfirmationId: string | null;
  calculatedPrizeCents: string | null;
  confirmedPrizeCents: string | null;
  contributedCents: string;
  confirmedExpenseCents: string | null;
  expenseConfirmationPending: boolean;
  redeemedCents: string;
  organizerRedeemedCents: string;
  individualRedeemedCents: string;
  prizePaidCents: string;
  refundedCents: string;
  /** Signed projected cash; a negative value exposes a reconciliation deficit. */
  organizerCashCents: string;
  cashDeficitCents: string;
  contributionSurplusCents: string | null;
  /** Frozen budget minus confirmed expenses kept as the group's reserve; '0' unless the plan's leftoverPolicy is group-credit. */
  groupReserveCents: string | null;
  unredeemedPrizeCents: string | null;
  unpaidPrizeCents: string | null;
  refundPendingCents: string | null;
  resultConflict: boolean;
  registrationIncomplete: boolean;
  closed: boolean;
  persons: SettlementPersonBalance[];
}
export interface PoolSettlement extends SettlementFact {
  direction: 'closed' | 'reopened';
  previousClosureId: string | null;
  registrationReportId: string;
  prizeConfirmationId: string | null;
  expenseConfirmationId: string | null;
  observedResultIds: string[];
  resultSelectionId: string | null;
  /** Reserve is an identified balance, not a new wallet credit or payment. */
  leftoverDisposition: 'group-reserve' | 'pending-refund';
  reconciliation: PoolSettlementBalance;
  pendingExplanation: string;
  reason: string;
}
export interface SettlementSnapshot {
  groupId: string;
  groupRevision: number;
  /** All three source families are captured at this same current group revision. */
  financial: FinancialSnapshot;
  registration: RegistrationSnapshot;
  results: ResultSnapshot;
  expenses: ExpenseConfirmation[];
  prizes: PrizeConfirmation[];
  redemptions: PrizeRedemption[];
  distributions: SettlementDistribution[];
  closures: PoolSettlement[];
}
export type SettlementAction =
  | { type: 'expense_confirm'; poolId: string; poolVersion: number; registrationReportId: string; supersedesId: string | null; betCostCents: string; feeCents: string; evidenceIds: string[]; sourceReference: string; reason: string }
  | { type: 'prize_confirm'; poolId: string; poolVersion: number; registrationReportId: string; resultId: string; supersedesId: string | null; amountCents: string; officialEntitlements: OfficialPrizeEntitlement[]; evidenceIds: string[]; sourceReference: string; reason: string; redemptionDeadline: RedemptionDeadline | null }
  | { type: 'redemption_record'; poolId: string; poolVersion: number; prizeConfirmationId: string; personId: string; amountCents: string; evidenceIds: string[]; sourceReference: string; eventAt: string; reason: string }
  | { type: 'redemption_reverse'; poolId: string; poolVersion: number; redemptionId: string; evidenceIds: string[]; sourceReference: string; eventAt: string; reason: string }
  | { type: 'distribution_record'; poolId: string; poolVersion: number; personId: string; kind: 'prize-payment' | 'contribution-refund'; amountCents: string; evidenceIds: string[]; sourceReference: string; eventAt: string; reason: string }
  | { type: 'distribution_reverse'; poolId: string; poolVersion: number; distributionId: string; evidenceIds: string[]; sourceReference: string; eventAt: string; reason: string }
  | { type: 'pool_settle'; poolId: string; poolVersion: number; registrationReportId: string; prizeConfirmationId: string | null; expenseConfirmationId: string | null; leftoverDisposition: 'group-reserve' | 'pending-refund'; pendingExplanation: string; reason: string }
  | { type: 'pool_reopen'; poolId: string; poolVersion: number; closureId: string; reason: string };
export interface SettlementCommand {
  apiVersion: 'v1';
  idempotencyKey: string;
  groupId: string;
  expectedRevision: number;
  action: SettlementAction;
}
export interface SettlementReceipt {
  apiVersion: 'v1';
  idempotencyKey: string;
  receiptId: string | null;
  groupId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  groupRevision: number;
  message: string | null;
  confirmedAt: string | null;
  snapshot: SettlementSnapshot | null;
}
export interface SettlementTransport {
  settlementPull(groupId: string): Promise<SettlementSnapshot>;
  settlementDecide(command: SettlementCommand): Promise<SettlementReceipt>;
  settlementCommandStatus(idempotencyKey: string): Promise<SettlementReceipt | null>;
}
export interface SettlementFinance {
  contributionCashCents: string;
  organizerRedeemedCents: string;
  individualRedeemedCents: string;
  confirmedExpenseCents: string;
  prizePaidCents: string;
  refundedCents: string;
  organizerCashCents: string;
  unallocatedContributionCents: string;
  pools: Record<string, PoolSettlementBalance>;
}
/** A group statement, never a CAIXA receipt or an official fiscal document. */
export interface SettlementStatement {
  label: 'Demonstrativo do grupo';
  groupId: string;
  groupRevision: number;
  pool: PoolSettlementBalance;
  closure: PoolSettlement | null;
}
