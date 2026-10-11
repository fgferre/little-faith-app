import { createFinancialView, quotaCost, sumCents } from "@bolao/core";
import type {
  ConfirmedPayment,
  FinancialSnapshot,
  LocalRecord,
  PlanRight,
  PreparedPlan,
} from "@bolao/core";

export function planningRights(
  financial: FinancialSnapshot,
  poolId: string,
): PlanRight[] {
  const view = createFinancialView(financial);
  return financial.quotas.filter((quota) =>
    quota.poolId === poolId && view.isQuotaActive(quota.id)
  ).map((quota) => ({
    quotaId: quota.id,
    sourceQuotaId: quota.sourceQuotaId,
    sourceQuotaVersion: quota.sourceQuotaVersion,
    personId: quota.personId,
    units: quota.units,
    dueCents: quota.dueCents,
    statuteId: quota.statuteId,
  }));
}

export function assertCurrentPlan(
  plan: PreparedPlan,
  records: LocalRecord[],
  financial: FinancialSnapshot,
  applying: boolean,
) {
  const pool = records.find((record) =>
    record.id === plan.poolId && record.kind === "pool"
  ) as LocalRecord<"pool"> | undefined;
  if (
    !pool || pool.groupId !== plan.groupId || financial.groupId !== plan.groupId
  ) {
    throw new Error("O plano não pertence ao grupo e bolão selecionados.");
  }
  if (
    applying &&
    (pool.serverVersion !== plan.poolVersion ||
      financial.groupRevision !== plan.groupRevision)
  ) {
    throw new Error(
      "Os dados mudaram desde o planejamento. Gere novas alternativas antes de aplicar.",
    );
  }
  if (
    pool.data.contestNumber !== plan.contestNumber ||
    pool.data.lotteryId !== plan.lotteryId ||
    pool.data.participationMode !== plan.participationMode
  ) {
    throw new Error(
      "Concurso, modalidade ou participação mudaram. Atualize o planejamento.",
    );
  }
  const current = records.filter((record) =>
    record.kind === "bet" &&
    (record as LocalRecord<"bet">).data.poolId === plan.poolId
  ) as LocalRecord<"bet">[];
  if (
    current.length !== plan.sourceBets.length ||
    current.some((bet) =>
      !plan.sourceBets.some((source) =>
        source.id === bet.id && source.version === bet.serverVersion
      )
    )
  ) {
    throw new Error(
      "Os jogos preparados mudaram. Gere novas alternativas para preservá-los.",
    );
  }
  const rights = planningRights(financial, plan.poolId);
  if (
    rights.length !== plan.rights.length || rights.some((right) => {
      const previous = plan.rights.find((item) =>
        item.quotaId === right.quotaId
      );
      return !previous ||
        Object.keys(right).some((key) =>
          previous[key as keyof PlanRight] !== right[key as keyof PlanRight]
        );
    })
  ) {
    throw new Error(
      "As participações confirmadas mudaram. Atualize o planejamento.",
    );
  }
  if (sumCents(rights.map((right) => right.dueCents)) !== plan.budgetCents) {
    throw new Error("O orçamento mudou. Atualize o planejamento.");
  }
  const funding =
    createFinancialView(financial).finance.pools[plan.poolId]?.allocatedCents ??
      "0";
  if (BigInt(funding) < BigInt(plan.budgetCents)) {
    throw new Error(
      "O dinheiro destinado ao bolão não cobre o orçamento dos direitos confirmados.",
    );
  }
}

const demoId = (value: number) =>
  `d1000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

/** Synthetic calculator input only; never persisted as a financial fact or sent to the server. */
export function demoPlanningFinancial(
  group: LocalRecord<"group">,
  pool: LocalRecord<"pool">,
  quotas: LocalRecord<"quota">[],
  payments: ConfirmedPayment[],
): FinancialSnapshot {
  const at = "2026-10-07T15:00:00.000Z";
  const statuteId = demoId(1);
  const snapshot: FinancialSnapshot = {
    groupId: group.id,
    groupRevision: 1,
    statutes: [{
      id: statuteId,
      groupId: group.id,
      version: 1,
      text: group.data.statute,
      sourceGroupVersion: 1,
      publishedAt: at,
      receiptId: demoId(2),
    }],
    acceptances: [],
    payments: [],
    allocations: [],
    movements: [],
    quotas: [],
    revocations: [],
  };
  for (const [index, quota] of quotas.entries()) {
    const payment = payments.find((entry) =>
      entry.poolId === pool.id && entry.personId === quota.data.personId
    );
    const due = quotaCost(pool.data.quotaPriceCents, quota.data.units);
    if (!payment || BigInt(payment.amountCents) < BigInt(due)) continue;
    const base = 100 + index * 20;
    const paymentId = demoId(base);
    const allocationId = demoId(base + 1);
    const receiptId = demoId(base + 2);
    snapshot.acceptances.push({
      id: demoId(base + 3),
      groupId: group.id,
      statuteId,
      personId: quota.data.personId,
      evidence: "Aceite sintético para a demonstração do planejador.",
      acceptedAt: at,
      receiptId: demoId(base + 4),
    });
    snapshot.payments.push({
      id: paymentId,
      groupId: group.id,
      personId: quota.data.personId,
      sourceProposalId: demoId(base + 5),
      sourceProposalVersion: 1,
      amountCents: payment.amountCents,
      bankReference: null,
      declaredReceivedAt: null,
      confirmedAt: at,
      receiptId,
    });
    snapshot.allocations.push({
      id: allocationId,
      groupId: group.id,
      paymentId,
      personId: quota.data.personId,
      poolId: pool.id,
      amountCents: payment.amountCents,
      allocatedAt: at,
      receiptId,
    });
    snapshot.movements.push(
      {
        id: demoId(base + 6),
        groupId: group.id,
        paymentId,
        personId: quota.data.personId,
        poolId: null,
        allocationId: null,
        kind: "payment-received",
        amountCents: payment.amountCents,
        reason: "Recebimento sintético de exemplo.",
        createdAt: at,
        receiptId,
      },
      {
        id: demoId(base + 7),
        groupId: group.id,
        paymentId,
        personId: quota.data.personId,
        poolId: pool.id,
        allocationId,
        kind: "payment-allocated",
        amountCents: payment.amountCents,
        reason: "Destinação sintética de exemplo.",
        createdAt: at,
        receiptId,
      },
    );
    snapshot.quotas.push({
      id: demoId(base + 8),
      groupId: group.id,
      poolId: pool.id,
      personId: quota.data.personId,
      sourceQuotaId: quota.id,
      sourceQuotaVersion: 1,
      units: quota.data.units,
      dueCents: due,
      statuteId,
      confirmedAt: at,
      receiptId: demoId(base + 9),
    });
  }
  return snapshot;
}
