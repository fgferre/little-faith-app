import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { createResultView, sumCents } from "@bolao/core";
import type { FinancialView, LocalRecord } from "@bolao/core";
import { getResultSnapshot } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { draftQuotaCost } from "../quota-display";
import { latestManifest } from "../planning";
import type { PoolStep, Snapshot } from "../app-shared";

export const STEP_LABEL: Record<PoolStep, string> = {
  montar: "Montar",
  arrecadar: "Arrecadar",
  jogar: "Jogar",
  registrar: "Registrar",
  sorteio: "Sorteio",
  dividir: "Dividir",
};

export interface PoolPerson {
  id: string;
  name: string;
  units: number;
  dueCents: string | null;
  paidCents: string;
  owes: boolean;
  /** Pagamentos informados que ainda esperam a conferência humana. */
  pending: { id: string; amountCents: string }[];
}

export interface PoolView {
  pool: LocalRecord<"pool">;
  step: PoolStep;
  drawAt: string | null;
  collectedCents: string;
  expectedCents: string | null;
  hasQuotas: boolean;
  people: PoolPerson[];
  owing: PoolPerson[];
}

/** "Ana" · "Ana e Bia" · "Ana, Bia e Caio" · "Ana, Bia, Caio e mais 2". */
export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > 3) {
    return `${names.slice(0, 3).join(", ")} e mais ${names.length - 3}`;
  }
  return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

/** Em que etapa cada bolão está e quem ainda deve; a mesma conta no Início e na tela do bolão. */
export function usePoolViews(
  { db, snapshot, financialView, isDemo }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    financialView: FinancialView | null;
    isDemo: boolean;
  },
): PoolView[] {
  const groupId = snapshot.groupId;
  const results = useLiveQuery(
    async () => groupId ? await getResultSnapshot(db, groupId) : null,
    [db, groupId],
  );
  const resultView = useMemo(
    () => results ? createResultView(results) : null,
    [results],
  );

  return snapshot.pools.map((pool) => {
    const quotas = snapshot.quotas.filter((q) => q.data.poolId === pool.id);
    const personIds = [...new Set(quotas.map((q) => q.data.personId))];
    const confirmed = snapshot.confirmed.filter((p) => p.poolId === pool.id);
    const proposals = snapshot.proposals.filter((p) =>
      p.data.poolId === pool.id && p.data.status !== "rejected" &&
      !snapshot.finances?.payments.some((payment) =>
        payment.sourceProposalId === p.id
      )
    );
    const people = personIds.map((personId) => {
      const units = quotas.filter((q) => q.data.personId === personId)
        .reduce((n, q) => n + q.data.units, 0);
      const due = draftQuotaCost(pool.data.quotaPriceCents, units);
      const paid = isDemo
        ? sumCents(
          confirmed.filter((p) => p.personId === personId).map((p) =>
            p.amountCents
          ),
        )
        : financialView?.personPoolFunding(pool.id, personId) ?? "0";
      const person = snapshot.persons.find((p) => p.id === personId);
      return {
        id: personId,
        name: person?.data.nickname || person?.data.name || "Sem nome",
        units,
        dueCents: due,
        paidCents: paid,
        owes: due === null || BigInt(paid) < BigInt(due),
        pending: proposals.filter((p) => p.data.personId === personId).map((
          p,
        ) => ({ id: p.id, amountCents: p.data.amountCents })),
      };
    });
    const dues = people.map((p) => p.dueCents);
    const funded = people.length > 0 && people.every((p) => !p.owes);
    const result = resultView?.currentResult(pool.id).result;
    const registered = ["registered", "settled"].includes(pool.data.status) ||
      snapshot.registrations.some((r) => r.poolId === pool.id);
    const locked = pool.data.status === "locked" ||
      !!latestManifest(snapshot.planning, pool.id);
    const calendar = resultView?.currentCalendar(pool.id);
    return {
      pool,
      step: result?.drawnNumbers
        ? "dividir"
        : registered
        ? "sorteio"
        : locked
        ? "registrar"
        : !quotas.length
        ? "montar"
        : funded
        ? "jogar"
        : "arrecadar",
      drawAt: pool.data.contestNumber !== null &&
          calendar?.contestNumber === pool.data.contestNumber
        ? calendar.expectedDrawAt
        : null,
      collectedCents: isDemo
        ? sumCents(confirmed.map((p) => p.amountCents))
        : financialView?.finance.pools[pool.id]?.allocatedCents ?? "0",
      expectedCents: dues.some((due) => due === null)
        ? null
        : sumCents(dues as string[]),
      hasQuotas: quotas.length > 0,
      people,
      owing: people.filter((p) => p.owes),
    };
  });
}
