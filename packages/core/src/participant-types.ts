import type { LotteryId, PixReceiver } from './types';

/**
 * Personal card opened from the participant link (`GET /v1/participant_card`), assembled by the server at every opening.
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
  /** Pools of the group where this person has a quota, newest first. */
  pools: ParticipantCardPool[];
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
  /** units in hundredths of a quota, like QuotaData.units; dueCents and paid stay null until the quota is confirmed. */
  quota: { units: number; dueCents: string | null; paidCents: string; paid: boolean | null };
  games: { numbers: number[] }[];
  /** Null until the pool is locked; 'planned' while no registration was confirmed. */
  registration: { status: 'planned' | 'registered' | 'partial' | 'divergent'; ticketHolderName: string | null } | null;
  result: { drawnNumbers: number[]; prizeCalculatedCents: string | null; prizeConfirmedCents: string | null } | null;
  /** Null until the pool is locked with this person in its settlement; paidByName is the ticket holder in the internal agreement. */
  share: {
    rightCents: string | null;
    receivedCents: string;
    pendingCents: string | null;
    paidByName: string | null;
    refundRightCents: string | null;
    refundedCents: string;
  } | null;
  closed: boolean;
}
