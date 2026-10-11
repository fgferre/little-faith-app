import type {
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
export type Tab =
  | "resumo"
  | "pessoas"
  | "jogos"
  | "planejar"
  | "registro"
  | "resultado";
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
  navigate: (screen: Screen, poolId?: string) => void;
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
