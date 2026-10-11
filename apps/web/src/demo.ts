import {
  generateBets,
  GENERATION_ALGORITHM_VERSION,
  LOTTERIES,
} from "@bolao/core";
import type {
  BetData,
  EntityDataMap,
  EntityKind,
  LocalRecord,
  LotteryId,
} from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";

export const DEMO_GROUP_ID = "d0000000-0000-4000-8000-000000000001";
const DEMO_SEED =
  "a43ce33f4532278e2fbed411130521d9c6a8b84b364492f716988510971f964e";
const people = [
  "Camila Almeida",
  "Rafael Costa",
  "Bianca Santos",
  "Lucas Oliveira",
  "Marina Lima",
  "João Pereira",
  "Isabela Rocha",
  "Pedro Silva",
];
const id = (n: number) =>
  `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function record<K extends EntityKind>(
  kind: K,
  n: number,
  data: EntityDataMap[K],
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
  };
}

export async function seedDemo(db: BolaoDatabase) {
  // No fixtures enter authenticated stores, the server, or production backups.
  await db.transaction("rw", db.records, db.confirmedPayments, async () => {
    if (await db.records.get(DEMO_GROUP_ID)) return;
    const group = record("group", 1, {
      name: "Turma da sorte",
      statute:
        "Participação válida após pagamento integral confirmado. Autoria dos números não altera direitos. Sobras serão devolvidas. Exemplo de estatuto, sem validade para um grupo real.",
    });
    const persons = people.map((name, index) =>
      record("person", 100 + index, {
        name,
        nickname: name.split(" ")[0]!,
        adultDeclared: true,
      })
    );
    const pools = [
      record("pool", 10, {
        title: "Mega entre amigos",
        lotteryId: "mega-sena",
        contestNumber: null,
        deadlineAt: "2026-10-10T20:00:00.000Z",
        quotaPriceCents: "6000",
        participationMode: "undecided",
        status: "draft",
      }),
      record("pool", 11, {
        title: "Uma sexta de sorte",
        lotteryId: "lotofacil",
        contestNumber: null,
        deadlineAt: "2026-10-09T20:00:00.000Z",
        quotaPriceCents: "3500",
        participationMode: "undecided",
        status: "draft",
      }),
      record("pool", 12, {
        title: "Quina da turma",
        lotteryId: "quina",
        contestNumber: null,
        deadlineAt: null,
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
  });
}
