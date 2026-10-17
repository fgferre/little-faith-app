import type { LotteryId } from './types';

export interface ResultPayout {
  hits: number;
  winnerCount: string | null;
  /** Exact integer cents from the decimal source token, or null when not published. */
  prizeCents: string | null;
}
export interface ContestResultData {
  lotteryId: LotteryId;
  contestNumber: number;
  /** Calendar date in Brasília; the source JSON does not establish a draw time. */
  drawDate: string | null;
  drawnNumbers: number[] | null;
  payouts: ResultPayout[] | null;
}
export interface ContestResultVersion extends ContestResultData {
  id: string;
  groupId: string;
  poolId: string;
  version: number;
  source: 'caixa' | 'manual';
  sourceUrl: string | null;
  sourceReference: string;
  rawText: string;
  sha256: string;
  collectedAt: string;
  status: 'waiting' | 'numbers-only' | 'complete' | 'manual';
  /** Official collection is technical; manual entry identifies its human receipt. */
  receiptId: string | null;
}
export interface ResultSelection {
  id: string;
  groupId: string;
  poolId: string;
  version: number;
  resultId: string;
  /** Complete versions seen during review; a later incompatible version opens a new conflict. */
  observedResultIds: string[];
  reason: string;
  selectedAt: string;
  receiptId: string;
}
export interface ContestCalendarVersion {
  id: string;
  groupId: string;
  poolId: string;
  version: number;
  lotteryId: LotteryId;
  contestNumber: number;
  source: 'caixa' | 'manual';
  sourceUrl: string | null;
  sourceReference: string;
  rawText: string;
  sha256: string;
  collectedAt: string;
  timeZone: 'America/Sao_Paulo';
  drawDate: string | null;
  expectedDrawAt: string | null;
  registrationClosesAt: string | null;
  receiptId: string | null;
}
export interface ResultSnapshot {
  groupId: string;
  groupRevision: number;
  results: ContestResultVersion[];
  selections: ResultSelection[];
  calendarVersions: ContestCalendarVersion[];
}
export type ResultAction =
  | { type: 'result_manual'; poolId: string; poolVersion: number; data: ContestResultData; sourceReference: string; reason: string }
  | { type: 'result_resolve'; poolId: string; poolVersion: number; resultId: string; observedResultIds: string[]; reason: string }
  | { type: 'calendar_confirm'; poolId: string; poolVersion: number; lotteryId: LotteryId; contestNumber: number; drawDate: string | null; expectedDrawAt: string | null; registrationClosesAt: string | null; sourceReference: string; reason: string };
export interface ResultCommand {
  apiVersion: 'v1';
  idempotencyKey: string;
  groupId: string;
  expectedRevision: number;
  action: ResultAction;
}
export interface ResultReceipt {
  apiVersion: 'v1';
  idempotencyKey: string;
  receiptId: string | null;
  groupId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  groupRevision: number;
  message: string | null;
  confirmedAt: string | null;
  snapshot: ResultSnapshot | null;
}
export interface ResultTransport {
  resultsPull(groupId: string): Promise<ResultSnapshot>;
  /** Fetch only from the configured official service; this is not approval of a manual result. contestNumber: which contest of a teimosinha (default its first). */
  resultsCollect(groupId: string, poolId: string, contestNumber?: number): Promise<ResultSnapshot>;
  resultDecide(command: ResultCommand): Promise<ResultReceipt>;
  resultCommandStatus(idempotencyKey: string): Promise<ResultReceipt | null>;
}
export interface CaixaResultInput {
  lotteryId: LotteryId;
  contestNumber: number;
  rawText: string;
  sourceUrl: string;
  collectedAt: string;
}
export interface ParsedCaixaResult extends ContestResultData {
  status: 'waiting' | 'numbers-only' | 'complete';
  sourceUrl: string;
  rawText: string;
  sha256: string;
  collectedAt: string;
  nextContest: { contestNumber: number; drawDate: string } | null;
}
export interface CurrentResultView {
  status: 'waiting' | 'numbers-only' | 'complete' | 'manual' | 'conflict';
  result: ContestResultVersion | null;
  conflictingResultIds: string[];
  selectedResultId: string | null;
}
export interface RegisteredPrize {
  plannedTicketKey: string;
  observedBetIndex: number;
  numbers: number[];
  hits: number;
  tiers: { hits: number; combinations: string; prizeCents: string | null; totalCents: string | null }[];
  calculatedPrizeCents: string | null;
}
export interface RegistrationPrizeAssessment {
  status: 'waiting' | 'conflict' | 'partial' | 'calculated';
  games: RegisteredPrize[];
  skippedTicketKeys: string[];
  /** Calculated amount only, never confirmed/rescued money or a distribution. */
  calculatedPrizeCents: string | null;
}
