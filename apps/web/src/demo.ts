import {
  brasiliaDateTimeToUTC,
  generateBets,
  GENERATION_ALGORITHM_VERSION,
  LOTTERIES,
  manualResultRaw,
  sha256Hex,
  validateResultSnapshot,
} from "@bolao/core";
import type {
  BetData,
  EntityDataMap,
  EntityKind,
  LocalRecord,
  LotteryId,
} from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import { seedDrawnPool } from "./demo-sorteado";

export const DEMO_GROUP_ID = "d0000000-0000-4000-8000-000000000001";
export const DEMO_SEED =
  "a43ce33f4532278e2fbed411130521d9c6a8b84b364492f716988510971f964e";
export const STATUTE =
  "Participação válida após pagamento integral confirmado. Autoria dos números não altera direitos. Sobras serão devolvidas. Exemplo de estatuto, sem validade para um grupo real.";
export const people = [
  "Camila Almeida",
  "Rafael Costa",
  "Bianca Santos",
  "Lucas Oliveira",
  "Marina Lima",
  "João Pereira",
  "Isabela Rocha",
  "Pedro Silva",
];
export const personData = (name: string) => ({
  name,
  nickname: name.split(" ")[0]!,
  adultDeclared: true,
});
export const id = (n: number) =>
  `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function record<K extends EntityKind>(
  kind: K,
  n: number,
  data: EntityDataMap[K],
  stamp: Partial<
    Pick<LocalRecord<K>, "serverVersion" | "state" | "createdAt" | "updatedAt">
  > = {},
): LocalRecord<K> {
  return {
    id: id(n),
    kind,
    groupId: DEMO_GROUP_ID,
    data,
    localVersion: 1,
    serverVersion: 0,
    state: "local",
    createdAt: "2026-10-07T15:00:00.000Z",
    updatedAt: "2026-10-07T15:00:00.000Z",
    ...stamp,
  };
}

const ZONE = "America/Sao_Paulo";
const MEGA_CONTEST = 3000;
export const civilDay = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString()
    .slice(0, 10);

/** A próxima ocorrência futura do dia da semana (0 = domingo) às hh:mm de Brasília. */
function nextAt(
  now: Date,
  weekday: number,
  time: string,
  accept: (day: string) => boolean = () => true,
) {
  for (let ahead = 0; ahead < 15; ahead++) {
    const day = addDays(civilDay(now), ahead);
    if (new Date(`${day}T00:00:00Z`).getUTCDay() !== weekday) continue;
    const instant = brasiliaDateTimeToUTC(`${day}T${time}`);
    if (Date.parse(instant) > now.getTime() && accept(day)) {
      return { day, instant };
    }
  }
  throw new Error("Não achei a próxima data da demonstração.");
}

export async function seedDemo(db: BolaoDatabase) {
  // No fixtures enter authenticated stores, the server, or production backups.
  const tables = [
    db.records,
    db.confirmedPayments,
    db.contestCalendars,
    db.resultSnapshots,
  ];
  await db.transaction("rw", tables, async () => {
    if (await db.records.get(DEMO_GROUP_ID)) return;
    // Datas relativas a agora: sorteio no próximo sábado às 20h, prazo interno dois dias antes.
    const now = new Date();
    const at15 = (day: string) => brasiliaDateTimeToUTC(`${day}T15:00`);
    const draw = nextAt(
      now,
      6,
      "20:00",
      (day) => Date.parse(at15(addDays(day, -2))) > now.getTime(),
    );
    const megaDeadline = at15(addDays(draw.day, -2));
    const fridayDeadline = nextAt(now, 5, "15:00").instant;
    const wednesdayDeadline = nextAt(now, 3, "15:00").instant;
    const group = record("group", 1, {
      name: "Turma da sorte",
      statute: STATUTE,
    });
    const persons = people.map((name, index) =>
      record("person", 100 + index, personData(name))
    );
    const pools = [
      record("pool", 10, {
        title: "Mega entre amigos",
        lotteryId: "mega-sena",
        contestNumber: MEGA_CONTEST,
        deadlineAt: megaDeadline,
        quotaPriceCents: "6000",
        participationMode: "undecided",
        status: "draft",
      }),
      record("pool", 11, {
        title: "Uma sexta de sorte",
        lotteryId: "lotofacil",
        contestNumber: null,
        deadlineAt: fridayDeadline,
        quotaPriceCents: "3500",
        participationMode: "undecided",
        status: "draft",
      }),
      record("pool", 12, {
        title: "Quina da turma",
        lotteryId: "quina",
        contestNumber: null,
        contestCount: 3,
        deadlineAt: wednesdayDeadline,
        quotaPriceCents: "3000",
        participationMode: "undecided",
        status: "draft",
      }),
    ];
    const quotas = persons.map((person, index) =>
      record("quota", 200 + index, {
        poolId: id(10),
        personId: person.id,
        units: 100,
      })
    );
    const bets: LocalRecord<"bet">[] = [];
    pools.forEach((pool, index) => {
      const lotteryId = pool.data.lotteryId as LotteryId;
      generateBets({
        lotteryId,
        count: index === 0 ? 24 : 4,
        numberCount: LOTTERIES[lotteryId].minNumbers,
        seed: DEMO_SEED,
      }).forEach((numbers, betIndex) => {
        const data: BetData = {
          poolId: pool.id,
          lotteryId,
          numbers,
          authorIds: [persons[betIndex % people.length]!.id],
          catalogVersion: LOTTERIES[lotteryId].catalogVersion,
          seed: DEMO_SEED,
          generationAlgorithmVersion: GENERATION_ALGORITHM_VERSION,
        };
        bets.push(record("bet", 1_000 + index * 100 + betIndex, data));
      });
    });
    const proposals = [
      record("payment-proposal", 300, {
        poolId: id(10),
        personId: persons[6]!.id,
        amountCents: "6000",
        note: "Valor informado no grupo. Falta conferir o recebimento.",
        status: "pending",
      }),
      record("payment-proposal", 301, {
        poolId: id(10),
        personId: persons[7]!.id,
        amountCents: "3000",
        note:
          "Pagamento parcial informado. Não cria participação menor automaticamente.",
        status: "pending",
      }),
    ];
    await db.records.bulkPut([
      group,
      ...persons,
      ...pools,
      ...quotas,
      ...bets,
      ...proposals,
    ]);
    await db.confirmedPayments.bulkPut(
      persons.slice(0, 6).map((person, index) => ({
        id: id(400 + index),
        groupId: DEMO_GROUP_ID,
        poolId: id(10),
        personId: person.id,
        amountCents: "6000",
        confirmedAt: "2026-10-07T15:00:00.000Z",
        receiptId: `demo-only-${index}`,
      })),
    );
    // O calendário do concurso diz à tela inicial quando é o sorteio.
    const action = {
      type: "calendar_confirm",
      poolId: id(10),
      poolVersion: 1,
      lotteryId: "mega-sena",
      contestNumber: MEGA_CONTEST,
      drawDate: draw.day,
      expectedDrawAt: draw.instant,
      registrationClosesAt: null,
      sourceReference: "Exemplo da demonstração",
      reason: "Dado de exemplo, sem validade.",
    } as const;
    const rawText = manualResultRaw(action);
    const snapshot = validateResultSnapshot({
      groupId: DEMO_GROUP_ID,
      groupRevision: 1,
      results: [],
      selections: [],
      calendarVersions: [{
        id: id(500),
        groupId: DEMO_GROUP_ID,
        poolId: id(10),
        version: 1,
        lotteryId: action.lotteryId,
        contestNumber: action.contestNumber,
        source: "manual",
        sourceUrl: null,
        sourceReference: action.sourceReference,
        rawText,
        sha256: sha256Hex(rawText),
        collectedAt: now.toISOString(),
        timeZone: ZONE,
        drawDate: action.drawDate,
        expectedDrawAt: action.expectedDrawAt,
        registrationClosesAt: null,
        receiptId: id(501),
      }],
    });
    await db.contestCalendars.bulkPut(snapshot.calendarVersions);
    await db.resultSnapshots.put({
      groupId: DEMO_GROUP_ID,
      groupRevision: snapshot.groupRevision,
      updatedAt: now.toISOString(),
    });
  });
  // Semeia o que falta: quem já tinha a demonstração recebe só o bolão sorteado; o resto fica intacto.
  await seedDrawnPool(db);
}
