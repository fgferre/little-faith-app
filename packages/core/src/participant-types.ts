import type { LotteryId, PixReceiver } from './types';

/**
 * Personal card opened from the participant link (`POST /v1/participant_card`), assembled by the server at every opening.
 * Only this person's values: games carry no owner, and no phone, document or file path is ever included. The one Pix key
 * is the group's receiver (owner's decision of 2026-10-12), so the person can pay; the code is built on the device.
 * Money is a string of cents; share values mirror the person's row of computeSettlement for that pool.
 */
export interface ParticipantCard {
  version: 1;
  generatedAt: string;
  /** pix is null while the group has no receiver registered. */
  group: { name: string; pix: PixReceiver | null };
  person: { id: string; name: string };
  /**
   * Pools of the group where this person has a quota, plus the open draft pools they can still answer (quota null), newest
   * first (owner's decision of 2026-10-16: the person answers from the card).
   */
  pools: ParticipantCardPool[];
  /** Whether the person protected the card with a PIN (owner's decision of 2026-10-15). Absent in cards served before it. */
  pinSet?: boolean;
}

export interface ParticipantCardPool {
  id: string;
  title: string;
  modality: LotteryId;
  contest: number | null;
  /** Expected draw instant (ISO UTC) or draw date (YYYY-MM-DD) when only the date is known. */
  drawAt: string | null;
  status: 'draft' | 'locked' | 'registered' | 'settled';
  participationMode: 'undecided' | 'internal' | 'official';
  /** units in hundredths of a quota, like QuotaData.units; dueCents and paid stay null until the quota is confirmed. Null while the person has no quota in the pool (an invitation). */
  quota: { units: number; dueCents: string | null; paidCents: string; paid: boolean | null } | null;
  /** Whether the person can still answer: the pool is a draft and its draw has not passed. Absent in cards served before it: treat as false. */
  responseOpen?: boolean;
  /** The person's latest answer for this pool, null without one; proofSent says a proof went with "paid". Absent in cards served before it. */
  response?: ParticipantAnswer | null;
  /**
   * registered is true for numbers read from a confirmed receipt (the games the prize is calculated on) and false for planned
   * or draft games not yet checked against a receipt. Absent in cards served before it: treat as false.
   */
  games: { numbers: number[]; registered?: boolean }[];
  /** Null until the pool is locked; 'planned' while no registration was confirmed. */
  registration: { status: 'planned' | 'registered' | 'partial' | 'divergent'; ticketHolderName: string | null } | null;
  /**
   * redemptionDeadlineDate is the confirmed prize's official deadline (Brasília civil date, YYYY-MM-DD), null without one;
   * prizeRedeemed is true once nothing is left to redeem, as unredeemedPrizeCents in Dividir. Absent in cards served before them.
   */
  result: {
    drawnNumbers: number[];
    prizeCalculatedCents: string | null;
    prizeConfirmedCents: string | null;
    redemptionDeadlineDate?: string | null;
    prizeRedeemed?: boolean;
  } | null;
  /** Null until the pool is locked with this person in its settlement; paidByName is the ticket holder in the internal agreement. */
  share: {
    rightCents: string | null;
    receivedCents: string;
    pendingCents: string | null;
    paidByName: string | null;
    refundRightCents: string | null;
    refundedCents: string;
  } | null;
  /** The pool's groupReserveCents: the leftover kept by a group-credit plan plus a prize kept under groupPrizeLimitCents; null before expenses are confirmed. Absent in cards served before it. */
  groupReserveCents?: string | null;
  /** Frozen plan's limit under which a confirmed prize stays in the group cash (internal agreement); null when none. Absent in cards served before it. */
  groupPrizeLimitCents?: string | null;
  closed: boolean;
}

export type ParticipantAnswerKind = 'in' | 'out' | 'paid';
/** The answer as the card shows it back: what was said, how much (with 'paid'), whether a proof went along, and when (ISO UTC). */
export interface ParticipantAnswer {
  kind: ParticipantAnswerKind;
  amountCents: string | null;
  proofSent: boolean;
  at: string;
}

/**
 * One recorded answer (`POST /v1/participant_respond` or `/v1/participant_proof`): append-only on the server, tied to the
 * link it came through; the latest per person and pool stands. It never creates a quota nor moves money.
 */
export interface ParticipantResponse {
  id: string;
  poolId: string;
  personId: string;
  linkId: string;
  kind: ParticipantAnswerKind;
  amountCents: string | null;
  proofId: string | null;
  createdAt: string;
}

/** The organizer's read (`POST /v1/participant_responses_pull`): the whole history of the group, oldest first, with the proof summary. */
export interface ParticipantResponsesPull {
  responses: (ParticipantResponse & { proof: { id: string; sha256: string; mimeType: string; byteSize: number } | null })[];
  reminders: { id: string; poolId: string; personId: string; remindedAt: string }[];
}
