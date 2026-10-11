/** Public v1 domain vocabulary. Monetary API values are decimal strings of integer cents. */
export type LotteryId = "mega-sena" | "lotofacil" | "quina";
export type EntityKind =
  | "group"
  | "person"
  | "pool"
  | "quota"
  | "bet"
  | "payment-proposal";
export type LocalState = "local" | "queued" | "synced" | "conflict";

export interface GroupData {
  name: string;
  statute: string;
}
export interface PersonData {
  name: string;
  nickname: string;
  adultDeclared: boolean;
}
export interface PoolData {
  title: string;
  lotteryId: LotteryId;
  contestNumber: number | null;
  deadlineAt: string | null;
  quotaPriceCents: string;
  participationMode: "undecided" | "internal" | "official";
  status: "draft" | "locked" | "registered" | "settled";
}
export interface QuotaData {
  poolId: string;
  personId: string;
  units: number;
}
export interface BetData {
  poolId: string;
  lotteryId: LotteryId;
  numbers: number[];
  authorIds: string[];
  catalogVersion: string;
  seed: string | null;
  generationAlgorithmVersion: string | null;
}
export interface PaymentProposalData {
  poolId: string;
  personId: string;
  amountCents: string;
  note: string;
  status: "pending" | "needs-review" | "rejected";
}
export interface EntityDataMap {
  group: GroupData;
  person: PersonData;
  pool: PoolData;
  quota: QuotaData;
  bet: BetData;
  "payment-proposal": PaymentProposalData;
}

export interface LocalRecord<K extends EntityKind = EntityKind> {
  id: string;
  groupId: string;
  kind: K;
  data: EntityDataMap[K];
  localVersion: number;
  serverVersion: number;
  state: LocalState;
  createdAt: string;
  updatedAt: string;
}

export interface DraftOperation {
  apiVersion: "v1";
  idempotencyKey: string;
  groupId: string;
  entityId: string;
  kind: EntityKind;
  expectedVersion: number;
  data: EntityDataMap[EntityKind];
  createdAt: string;
}

export interface ConfirmedPayment {
  id: string;
  groupId: string;
  poolId: string;
  personId: string;
  amountCents: string;
  confirmedAt: string;
  receiptId: string;
}

export interface PushReceipt {
  idempotencyKey: string;
  status: "accepted" | "conflict" | "rejected";
  entityId: string;
  serverVersion: number;
  groupRevision: number;
  message: string | null;
  record: LocalRecord | null;
}
export interface SyncChange {
  groupRevision: number;
  record: LocalRecord;
}
export interface PullResponse {
  groupId: string;
  changes: SyncChange[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SyncTransport {
  push(operations: DraftOperation[]): Promise<PushReceipt[]>;
  pull(groupId: string, cursor: number): Promise<PullResponse>;
}
