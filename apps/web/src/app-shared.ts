import { readCaixaExtras } from "@bolao/core";
import type {
  CurrentResultView,
  EntityDataMap,
  EntityKind,
  LocalRecord,
  LotteryId,
} from "@bolao/core";
import {
  getFinancialSnapshot,
  getPlanningSnapshot,
  getSyncSummary,
  listRecords,
} from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";

export const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const supportedTimeZones = Array.from(
  new Set([browserTimeZone, "UTC", ...Intl.supportedValuesOf("timeZone")]),
).sort();

export type Screen = "inicio" | "boloes" | "revisao" | "historico" | "dados";
export const POOL_STEPS = [
  "montar",
  "arrecadar",
  "jogar",
  "registrar",
  "sorteio",
  "dividir",
] as const;
export type PoolStep = typeof POOL_STEPS[number];
export type FormKind =
  | "group"
  | "edit-group"
  | "pool"
  | "edit-pool"
  | "person"
  | "quota"
  | "payment"
  | "bet"
  | "generate";
export interface GenerationRun {
  poolId: string;
  lotteryId: LotteryId;
  count: number;
  numberCount: number;
  seed: string;
  existing: number[][];
}

export interface Route {
  screen: Screen;
  poolId: string | null;
  step?: PoolStep | null;
  navigate: (screen: Screen, poolId?: string, step?: PoolStep) => void;
}
export type Notice = { text: string; error?: boolean };
export type SaveRecord = <K extends EntityKind>(
  kind: K,
  data: EntityDataMap[K],
  id?: string,
) => Promise<LocalRecord<K>>;
export const formatDate = (value: string | null, timeZone?: string) =>
  value
    ? new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(value))
    : "Prazo a definir";
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível salvar. Tente novamente.";

/**
 * O concurso acumulou: só o resultado oficial da CAIXA, já sorteado e sem conflito, diz isso; com o
 * resultado informado à mão, ou se a turma acertou a faixa principal, nada muda. O Sorteio e a
 * chamada do bolão seguinte leem daqui. O número é o do próximo concurso que a CAIXA publicou.
 */
export function rolloverOf(
  current: CurrentResultView | null,
  jackpot: boolean,
): { nextContestNumber: number; nextEstimatedPrizeCents: string | null } | null {
  const result = current?.status === "conflict" ? null : current?.result;
  if (jackpot || result?.source !== "caixa" || !result.drawnNumbers) return null;
  const caixa = readCaixaExtras(result.rawText);
  return caixa.accumulated === true
    ? {
      nextContestNumber: caixa.nextContestNumber ?? result.contestNumber + 1,
      nextEstimatedPrizeCents: caixa.nextEstimatedPrizeCents,
    }
    : null;
}

export async function readSnapshot(db: BolaoDatabase, groupId: string | null) {
  const [
    groups,
    persons,
    pools,
    quotas,
    bets,
    proposals,
    confirmed,
    summary,
    records,
    finances,
    planning,
    registrations,
    decisions,
  ] = await Promise.all([
    listRecords(db, "group"),
    listRecords(db, "person", groupId ?? undefined),
    listRecords(db, "pool", groupId ?? undefined),
    listRecords(db, "quota", groupId ?? undefined),
    listRecords(db, "bet", groupId ?? undefined),
    listRecords(db, "payment-proposal", groupId ?? undefined),
    db.confirmedPayments.toArray(),
    getSyncSummary(db),
    db.records.toArray(),
    groupId ? getFinancialSnapshot(db, groupId) : Promise.resolve(null),
    groupId ? getPlanningSnapshot(db, groupId) : Promise.resolve(null),
    groupId
      ? db.registrationReports.where("groupId").equals(groupId).toArray()
      : Promise.resolve([]),
    groupId
      ? Promise.all([
        db.financialCommands.where("groupId").equals(groupId).toArray(),
        db.planningCommands.where("groupId").equals(groupId).toArray(),
        db.registrationCommands.where("groupId").equals(groupId).toArray(),
        db.resultCommands.where("groupId").equals(groupId).toArray(),
      ]).then((families) => families.flat())
      : Promise.resolve([]),
  ]);
  return {
    accountId: db.accountId,
    groupId,
    groups,
    persons,
    pools,
    quotas,
    bets,
    proposals,
    confirmed: confirmed.filter((p) => p.groupId === groupId),
    summary,
    records,
    finances,
    planning,
    registrations,
    decisions,
  };
}
export type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
