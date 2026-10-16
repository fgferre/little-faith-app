import {
  brasiliaDateTimeToUTC,
  createRedemptionDeadline,
  generateBets,
  LOTTERIES,
} from "@bolao/core";
import type { LotteryId, ParticipantCard } from "@bolao/core";
import { civilDay, DEMO_SEED, id, people } from "./demo";

const DAY = 86_400_000;
const DRAWN_NUMBERS = [7, 18, 26, 33, 49, 54];
const DRAWN_BETS = [
  [2, 9, 15, 28, 44, 51],
  [5, 13, 22, 37, 46, 59],
  [3, 18, 27, 39, 49, 56],
  [7, 18, 26, 33, 41, 58],
  [10, 21, 33, 40, 52, 60],
  [1, 7, 26, 31, 45, 54],
  [6, 17, 24, 36, 43, 55],
  [8, 19, 29, 34, 47, 57],
];

const seeded = (lotteryId: LotteryId, count: number) =>
  generateBets({
    lotteryId,
    count,
    numberCount: LOTTERIES[lotteryId].minNumbers,
    seed: DEMO_SEED,
  }).map((numbers) => ({ numbers }));

export function demoParticipantCard(now = new Date()): ParticipantCard {
  const day = (offset: number) =>
    civilDay(new Date(now.getTime() + offset * DAY));
  const saturday = Array.from({ length: 15 }, (_, offset) => offset).find((
    offset,
  ) =>
    new Date(`${day(offset)}T00:00:00Z`).getUTCDay() === 6 &&
    Date.parse(brasiliaDateTimeToUTC(`${day(offset - 2)}T15:00`)) >
      now.getTime()
  )!;
  const drawDay = day(-3);
  const holder = people[0]!;
  return {
    version: 1,
    generatedAt: now.toISOString(),
    group: {
      name: "Turma da sorte",
      pix: {
        key: "camila@exemplo.com",
        keyType: "email",
        name: holder,
        city: "Sao Paulo",
      },
    },
    person: { id: id(106), name: people[6]! },
    pools: [
      {
        id: id(10),
        title: "Mega entre amigos",
        modality: "mega-sena",
        contest: 3000,
        drawAt: brasiliaDateTimeToUTC(`${day(saturday)}T20:00`),
        status: "draft",
        participationMode: "undecided",
        quota: { units: 100, dueCents: "6000", paidCents: "0", paid: false },
        games: seeded("mega-sena", 24),
        registration: null,
        result: null,
        share: null,
        closed: false,
      },
      {
        id: id(13),
        title: "Mega da sexta",
        modality: "mega-sena",
        contest: 2999,
        drawAt: drawDay,
        status: "registered",
        participationMode: "internal",
        quota: { units: 100, dueCents: "600", paidCents: "600", paid: true },
        games: DRAWN_BETS.map((numbers) => ({ numbers, registered: true })),
        registration: { status: "registered", ticketHolderName: holder },
        result: {
          drawnNumbers: DRAWN_NUMBERS,
          prizeCalculatedCents: "128720",
          prizeConfirmedCents: "128720",
          redemptionDeadlineDate:
            createRedemptionDeadline("mega-sena", drawDay).deadlineDate,
          prizeRedeemed: true,
        },
        share: {
          rightCents: "16090",
          receivedCents: "0",
          pendingCents: "16090",
          paidByName: holder,
          refundRightCents: "0",
          refundedCents: "0",
        },
        closed: false,
      },
      {
        id: id(11),
        title: "Uma sexta de sorte",
        modality: "lotofacil",
        contest: null,
        drawAt: null,
        status: "draft",
        participationMode: "undecided",
        quota: { units: 100, dueCents: "3500", paidCents: "0", paid: false },
        games: seeded("lotofacil", 4),
        registration: null,
        result: null,
        share: null,
        closed: false,
      },
    ],
  };
}
