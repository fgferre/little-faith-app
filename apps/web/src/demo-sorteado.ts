import {
  brasiliaDateTimeToUTC,
  buildSettlementFact,
  canonicalJSON,
  compareRegistration,
  createRedemptionDeadline,
  LOTTERIES,
  manualResultRaw,
  PLANNING_CATALOG,
  quotaCost,
  sha256Hex,
  suggestPlans,
  validateEvidenceMetadata,
  validateFinancialSnapshot,
  validateManifestContent,
  validatePlanningSnapshot,
  validatePoolManifest,
  validateResultVersion,
  validateSettlementSnapshot,
} from "@bolao/core";
import type {
  AppliedPlan,
  ContestCalendarVersion,
  PoolData,
  RegistrationItem,
  RegistrationReport,
  ResultAction,
  SettlementAction,
  SettlementSnapshot,
} from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
// Só funções usam o que vem de demo.ts: a importação circular é resolvida antes de qualquer chamada.
import {
  civilDay,
  DEMO_GROUP_ID,
  DEMO_SEED,
  id,
  people,
  personData,
  record,
  STATUTE,
} from "./demo";

// Bolão já sorteado, com prêmio confirmado, resgatado e parcialmente repassado.
const DRAWN_POOL = 13;
const DRAWN_CONTEST = 2999;
const DRAWN_NUMBERS = [7, 18, 26, 33, 49, 54];
/** Uma aposta simples por pessoa, na ordem de `people`: só a de Lucas faz quadra; as outras acertam no máximo 3. */
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
const QUADRA_CENTS = "128720";
/** Repasses feitos ontem; as duas últimas pessoas ainda vão receber. */
const PAID_PEOPLE = 6;
const EVIDENCE_TEXT =
  "Demonstração: foto do bilhete da Mega-Sena, concurso 2999.";
/** Revisão do grupo quando o dinheiro foi congelado na trava; cada fato seguinte avança uma. */
const LOCK_REVISION = 25;

/** Monta o bolão com os construtores do núcleo, que validam cada fato como o servidor faria. */
function drawnPool(now: Date, calendars: ContestCalendarVersion[]) {
  const groupId = DEMO_GROUP_ID;
  const poolId = id(DRAWN_POOL);
  const organizer = id(13_990);
  const mega = LOTTERIES["mega-sena"];
  const due = quotaCost(mega.simplePriceCents, 100);
  const at = (days: number, minutes = 0) =>
    new Date(now.getTime() - days * 86_400_000 + minutes * 60_000)
      .toISOString();
  const drawDay = civilDay(new Date(now.getTime() - 3 * 86_400_000));
  const synced = {
    serverVersion: 1,
    state: "synced" as const,
    createdAt: at(7),
    updatedAt: at(7),
  };
  const poolData: PoolData = {
    title: "Mega da sexta",
    lotteryId: "mega-sena",
    contestNumber: DRAWN_CONTEST,
    deadlineAt: brasiliaDateTimeToUTC(`${drawDay}T15:00`),
    quotaPriceCents: mega.simplePriceCents,
    participationMode: "internal",
    status: "draft",
  };
  const personId = (index: number) => id(100 + index);
  const quotas = people.map((_, index) =>
    record("quota", 13_100 + index, {
      poolId,
      personId: personId(index),
      units: 100,
    }, synced)
  );
  const bets = DRAWN_BETS.map((numbers, index) =>
    record("bet", 13_200 + index, {
      poolId,
      lotteryId: "mega-sena",
      numbers,
      authorIds: [personId(index)],
      catalogVersion: mega.catalogVersion,
      seed: null,
      generationAlgorithmVersion: null,
    }, synced)
  );

  // Estatuto aceito, um Pix por pessoa (6 e 5 dias atrás) destinado ao bolão e a cota confirmada.
  const paidAt = (index: number, minutes = 0) =>
    at(index < 4 ? 6 : 5, (index % 4) * 9 + minutes);
  const statute = {
    id: id(13_400),
    groupId,
    version: 1,
    text: STATUTE,
    sourceGroupVersion: 1,
    publishedAt: at(6, -60),
    receiptId: id(13_401),
  };
  const payments = people.map((_, index) => ({
    id: id(13_430 + index),
    groupId,
    personId: personId(index),
    sourceProposalId: id(13_450 + index),
    sourceProposalVersion: 1,
    amountCents: due,
    bankReference: null,
    declaredReceivedAt: null,
    confirmedAt: paidAt(index),
    receiptId: id(13_440 + index),
  }));
  const allocations = payments.map((payment, index) => ({
    id: id(13_460 + index),
    groupId,
    paymentId: payment.id,
    personId: payment.personId,
    poolId,
    amountCents: due,
    allocatedAt: payment.confirmedAt,
    receiptId: payment.receiptId,
  }));
  const movement = (index: number, allocated: boolean) => ({
    id: id((allocated ? 13_490 : 13_480) + index),
    groupId,
    paymentId: payments[index]!.id,
    personId: personId(index),
    poolId: allocated ? poolId : null,
    allocationId: allocated ? allocations[index]!.id : null,
    kind: allocated ? "payment-allocated" : "payment-received",
    amountCents: due,
    reason: "",
    createdAt: payments[index]!.confirmedAt,
    receiptId: payments[index]!.receiptId,
  });
  const financial = validateFinancialSnapshot({
    groupId,
    groupRevision: LOCK_REVISION,
    statutes: [statute],
    acceptances: people.map((_, index) => ({
      id: id(13_410 + index),
      groupId,
      statuteId: statute.id,
      personId: personId(index),
      evidence: "Aceite combinado no grupo da turma.",
      acceptedAt: at(6, -50),
      receiptId: id(13_420 + index),
    })),
    payments,
    allocations,
    movements: people.flatMap((_, index) => [
      movement(index, false),
      movement(index, true),
    ]),
    quotas: quotas.map((quota, index) => ({
      id: id(13_500 + index),
      groupId,
      poolId,
      personId: quota.data.personId,
      sourceQuotaId: quota.id,
      sourceQuotaVersion: 1,
      units: quota.data.units,
      dueCents: due,
      statuteId: statute.id,
      confirmedAt: paidAt(index, 1),
      receiptId: id(13_510 + index),
    })),
    revocations: [],
  });

  // Plano com as 8 apostas da turma, aplicado e travado 4 dias atrás.
  const plans = suggestPlans({
    groupId,
    groupRevision: LOCK_REVISION,
    pool: record("pool", DRAWN_POOL, poolData, synced),
    sourceBets: bets,
    financial,
    seed: DEMO_SEED,
    feeCents: "0",
    feeLabel: "",
    leftoverPolicy: "group-credit",
  }).plans;
  const plan = plans.find((p) => p.strategy === "spread") ?? plans[0];
  if (!plan) throw new Error("A demonstração não montou o bolão sorteado.");
  const applied: AppliedPlan = {
    id: id(13_600),
    groupId,
    poolId,
    version: 1,
    plan,
    appliedAt: at(4, -10),
    receiptId: id(13_601),
  };
  const content = validateManifestContent({
    schemaVersion: "pool-manifest-v1",
    catalog: PLANNING_CATALOG["mega-sena"],
    responsible: {
      organizerUserId: organizer,
      registrarPersonId: personId(0),
      ticketHolderPersonId: personId(0),
    },
    pool: {
      id: poolId,
      version: plan.poolVersion + 1,
      data: { ...poolData, status: "locked" },
    },
    plan,
    persons: people.map((name, index) => ({
      id: personId(index),
      version: 1,
      data: personData(name),
    })),
    financial,
  });
  const canonical = canonicalJSON(content);
  const manifest = validatePoolManifest({
    id: id(13_602),
    groupId,
    poolId,
    version: 1,
    appliedPlanId: applied.id,
    content,
    canonical,
    sha256: sha256Hex(canonical),
    lockedAt: at(4),
    receiptId: id(13_603),
  });

  // Registro completo com um comprovante (sem o original neste aparelho).
  const evidence = validateEvidenceMetadata({
    id: id(13_610),
    groupId,
    poolId,
    sha256: sha256Hex(EVIDENCE_TEXT),
    mimeType: "image/jpeg",
    byteSize: new TextEncoder().encode(EVIDENCE_TEXT).length,
    originalName: "bilhete-2999.jpg",
    storagePath: `${groupId}/${id(13_610)}.jpg`,
    uploadedByUserId: organizer,
    uploadedAt: at(4, 20),
  });
  const items: RegistrationItem[] = plan.tickets.map((ticket) => ({
    plannedTicketKey: ticket.key,
    evidenceIds: [evidence.id],
    observed: {
      lotteryId: plan.lotteryId,
      contestNumber: plan.contestNumber,
      betNumbers: ticket.betKeys.map((key) =>
        plan.bets.find((bet) => bet.key === key)!.numbers
      ),
      betCostCents: ticket.betCostCents,
      feeCents: "0",
      officialQuotaCount: null,
      officialAssignments: null,
      registeredAt: at(4, 10),
    },
    reason: "",
  }));
  const report: RegistrationReport = {
    id: id(13_620),
    groupId,
    poolId,
    version: 1,
    poolVersion: manifest.content.pool.version,
    manifestId: manifest.id,
    calendar: null,
    items,
    reason: "Bilhete conferido com os jogos travados.",
    comparison: compareRegistration(manifest, items, [evidence]),
    confirmedAt: at(4, 30),
    receiptId: id(13_621),
  };

  // Resultado 3 dias atrás: a quadra paga R$ 1.287,20; sena acumulou.
  const resultAction: Extract<ResultAction, { type: "result_manual" }> = {
    type: "result_manual",
    poolId,
    poolVersion: report.poolVersion + 1,
    data: {
      lotteryId: "mega-sena",
      contestNumber: DRAWN_CONTEST,
      drawDate: drawDay,
      drawnNumbers: DRAWN_NUMBERS,
      payouts: [
        { hits: 6, winnerCount: "0", prizeCents: "0" },
        { hits: 5, winnerCount: "52", prizeCents: "4187416" },
        { hits: 4, winnerCount: "3741", prizeCents: QUADRA_CENTS },
      ],
    },
    sourceReference: "Exemplo da demonstração",
    reason: "Dado de exemplo, sem validade.",
  };
  const rawText = manualResultRaw(resultAction);
  const result = validateResultVersion({
    id: id(13_630),
    groupId,
    poolId,
    version: 1,
    ...resultAction.data,
    source: "manual",
    sourceUrl: null,
    sourceReference: resultAction.sourceReference,
    rawText,
    sha256: sha256Hex(rawText),
    collectedAt: brasiliaDateTimeToUTC(`${drawDay}T21:30`),
    status: "manual",
    receiptId: id(13_631),
  });

  // Divisão: cada fato é construído pelo núcleo sobre o corte anterior, como no servidor.
  const sources = (groupRevision: number) => ({
    financial: { ...financial, groupRevision },
    registration: {
      groupId,
      groupRevision,
      manifests: [manifest],
      evidence: [evidence],
      reports: [report],
    },
    results: {
      groupId,
      groupRevision,
      results: [result],
      selections: [],
      calendarVersions: calendars,
    },
  });
  // Depois da trava: plano aplicado, manifesto, registro e resultado.
  const settlement: SettlementSnapshot = {
    groupId,
    groupRevision: LOCK_REVISION + 4,
    ...sources(LOCK_REVISION + 4),
    expenses: [],
    prizes: [],
    redemptions: [],
    distributions: [],
    closures: [],
  };
  // Cada fato observa a versão atual do bolão e o servidor a avança.
  let poolVersion = resultAction.poolVersion;
  let step = 0;
  const confirm = (action: SettlementAction, confirmedAt: string) => {
    const groupRevision = settlement.groupRevision + 1;
    const fact = buildSettlementFact(settlement, {
      apiVersion: "v1",
      idempotencyKey: id(13_900 + step),
      groupId,
      expectedRevision: settlement.groupRevision,
      action,
    }, {
      id: id(13_700 + step),
      receiptId: id(13_800 + step),
      confirmedAt,
      groupRevision,
    });
    step++;
    poolVersion++;
    Object.assign(settlement, { groupRevision, ...sources(groupRevision) });
    if ("betCostCents" in fact) settlement.expenses.push(fact);
    else if ("rights" in fact) settlement.prizes.push(fact);
    else if ("ownership" in fact) settlement.redemptions.push(fact);
    else if ("kind" in fact) settlement.distributions.push(fact);
    return fact;
  };
  const evidenceIds = [evidence.id];
  confirm({
    type: "expense_confirm",
    poolId,
    poolVersion,
    registrationReportId: report.id,
    supersedesId: null,
    betCostCents: plan.betCostCents,
    feeCents: plan.feeCents,
    evidenceIds,
    sourceReference: "Bilhete pago na lotérica.",
    reason: "",
  }, at(4, 40));
  const prize = confirm({
    type: "prize_confirm",
    poolId,
    poolVersion,
    registrationReportId: report.id,
    resultId: result.id,
    supersedesId: null,
    amountCents: QUADRA_CENTS,
    officialEntitlements: [],
    evidenceIds,
    sourceReference: "Resultado conferido com o bilhete.",
    reason: "",
    redemptionDeadline: createRedemptionDeadline("mega-sena", drawDay),
  }, at(2));
  confirm({
    type: "redemption_record",
    poolId,
    poolVersion,
    prizeConfirmationId: prize.id,
    personId: personId(0),
    amountCents: QUADRA_CENTS,
    evidenceIds,
    sourceReference: "Prêmio resgatado na lotérica pela titular.",
    eventAt: at(2, 30),
    reason: "",
  }, at(2, 45));
  const rights = "rights" in prize ? prize.rights : [];
  for (let index = 0; index < PAID_PEOPLE; index++) {
    const right = rights.find((r) => r.personId === personId(index));
    if (!right) throw new Error("A demonstração perdeu um direito ao prêmio.");
    confirm({
      type: "distribution_record",
      poolId,
      poolVersion,
      personId: right.personId,
      kind: "prize-payment",
      amountCents: right.amountCents,
      evidenceIds,
      sourceReference: "Pix enviado pela titular.",
      eventAt: at(1, index * 10),
      reason: "Parte da quadra repassada.",
    }, at(1, index * 10 + 5));
  }

  const revision = settlement.groupRevision;
  return {
    revision,
    records: [
      record("pool", DRAWN_POOL, { ...poolData, status: "registered" }, {
        ...synced,
        serverVersion: poolVersion,
        updatedAt: at(1, PAID_PEOPLE * 10),
      }),
      ...quotas,
      ...bets,
    ],
    // O caixa da demonstração vem destes pagamentos de exemplo.
    confirmedPayments: payments.map((payment, index) => ({
      id: id(13_300 + index),
      groupId,
      poolId,
      personId: payment.personId,
      amountCents: payment.amountCents,
      confirmedAt: payment.confirmedAt,
      receiptId: `demo-only-13-${index}`,
    })),
    planning: validatePlanningSnapshot({
      groupId,
      groupRevision: revision,
      appliedPlans: [applied],
      manifests: [manifest],
    }),
    // Reconstrói cada fato do zero: o que a tela Dividir vai recalcular.
    settlement: validateSettlementSnapshot(settlement),
  };
}

export async function seedDrawnPool(db: BolaoDatabase) {
  const tables = [
    db.records,
    db.confirmedPayments,
    db.statutes,
    db.statuteAcceptances,
    db.receivedPayments,
    db.paymentAllocations,
    db.financialMovements,
    db.confirmedQuotas,
    db.appliedPlans,
    db.poolManifests,
    db.planningSnapshots,
    db.confirmedEvidence,
    db.registrationManifests,
    db.registrationReports,
    db.registrationSnapshots,
    db.contestResults,
    db.contestCalendars,
    db.resultSnapshots,
    db.expenseConfirmations,
    db.prizeConfirmations,
    db.prizeRedemptions,
    db.settlementDistributions,
    db.settlementSnapshots,
  ];
  await db.transaction("rw", tables, async () => {
    if (await db.records.get(id(DRAWN_POOL))) return;
    const now = new Date();
    const calendars = await db.contestCalendars.where("groupId").equals(
      DEMO_GROUP_ID,
    ).toArray();
    const drawn = drawnPool(now, calendars);
    const { financial, registration, results } = drawn.settlement;
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    const groupId = DEMO_GROUP_ID;
    const groupRevision = drawn.revision;
    const updatedAt = now.toISOString();
    await db.records.bulkPut(drawn.records);
    await db.confirmedPayments.bulkPut(drawn.confirmedPayments);
    // Fatos financeiros só como fonte da divisão: sem retrato financeiro próprio, o resto da demonstração não muda.
    await db.statutes.bulkPut(financial.statutes);
    await db.statuteAcceptances.bulkPut(financial.acceptances);
    await db.receivedPayments.bulkPut(financial.payments);
    await db.paymentAllocations.bulkPut(financial.allocations);
    await db.financialMovements.bulkPut(financial.movements);
    await db.confirmedQuotas.bulkPut(financial.quotas);
    await db.appliedPlans.bulkPut(drawn.planning.appliedPlans);
    await db.poolManifests.bulkPut(drawn.planning.manifests);
    await db.planningSnapshots.put({ groupId, groupRevision, updatedAt });
    await db.confirmedEvidence.bulkPut(registration.evidence);
    await db.registrationManifests.bulkPut(registration.manifests);
    await db.registrationReports.bulkPut(registration.reports);
    await db.registrationSnapshots.put({
      groupId,
      groupRevision,
      updatedAt,
      evidenceIds: ids(registration.evidence),
    });
    await db.contestResults.bulkPut(results.results);
    await db.resultSnapshots.put({ groupId, groupRevision, updatedAt });
    await db.expenseConfirmations.bulkPut(drawn.settlement.expenses);
    await db.prizeConfirmations.bulkPut(drawn.settlement.prizes);
    await db.prizeRedemptions.bulkPut(drawn.settlement.redemptions);
    await db.settlementDistributions.bulkPut(drawn.settlement.distributions);
    await db.settlementSnapshots.put({
      groupId,
      groupRevision,
      updatedAt,
      sources: {
        financial: {
          statutes: ids(financial.statutes),
          acceptances: ids(financial.acceptances),
          payments: ids(financial.payments),
          allocations: ids(financial.allocations),
          movements: ids(financial.movements),
          quotas: ids(financial.quotas),
          revocations: ids(financial.revocations),
        },
        registration: {
          manifests: ids(registration.manifests),
          evidence: ids(registration.evidence),
          reports: ids(registration.reports),
        },
        results: {
          results: ids(results.results),
          selections: ids(results.selections),
          calendarVersions: ids(results.calendarVersions),
        },
      },
    });
  });
}
