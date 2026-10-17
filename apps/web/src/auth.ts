import { createClient } from "@supabase/supabase-js";
import type {
  DraftOperation,
  EvidenceMetadata,
  EvidenceTransport,
  EvidenceUploadMetadata,
  FinancialCommand,
  FinancialReceipt,
  FinancialSnapshot,
  FinancialTransport,
  PlanningCommand,
  PlanningReceipt,
  PlanningSnapshot,
  PlanningTransport,
  PullResponse,
  PushReceipt,
  RegistrationCommand,
  RegistrationReceipt,
  RegistrationSnapshot,
  RegistrationTransport,
  ResultCommand,
  ResultReceipt,
  ResultSnapshot,
  ResultTransport,
  SettlementCommand,
  SettlementReceipt,
  SettlementSnapshot,
  SettlementTransport,
} from "@bolao/core";
import type { LocalSyncTransport } from "@bolao/local";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;
export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
    auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true },
  })
  : null;

export async function loginWithGoogle() {
  if (!supabase) {
    throw new Error("A conexão compartilhada ainda não foi configurada.");
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });
  if (error) throw error;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function apiResponse(
  accountId: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!supabase) {
    throw new Error("Configure a conexão compartilhada para sincronizar.");
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Entre na sua conta para sincronizar.");
  // A request always belongs to the account whose IndexedDB store initiated it.
  if (session.user.id !== accountId) {
    throw new Error(
      "A conta mudou. As pendências da conta anterior foram preservadas.",
    );
  }
  const response = await fetch(`${supabaseUrl}/functions/v1/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: supabaseKey!,
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      result?.message ?? result?.error ??
        `A sincronização não foi concluída (${response.status}). Suas pendências continuam salvas.`,
      response.status,
    );
  }
  return response;
}

async function api<T>(
  accountId: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await apiResponse(accountId, path, body)).json() as Promise<T>;
}

export async function downloadEvidenceOriginal(
  accountId: string,
  metadata: EvidenceMetadata,
): Promise<Blob> {
  const response = await apiResponse(
    accountId,
    `evidence_download?id=${encodeURIComponent(metadata.id)}`,
  );
  const original = await response.blob();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await original.arrayBuffer(),
  );
  const hash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (
    original.size !== metadata.byteSize ||
    original.type !== metadata.mimeType || hash !== metadata.sha256
  ) {
    throw new Error(
      "O original recebido não corresponde à evidência confirmada. Sincronize antes de baixar.",
    );
  }
  return original;
}

export function createAccountTransport(
  accountId: string,
):
  & LocalSyncTransport
  & FinancialTransport
  & PlanningTransport
  & RegistrationTransport
  & ResultTransport
  & SettlementTransport
  & EvidenceTransport {
  return {
    registrationPull(groupId: string) {
      return api<RegistrationSnapshot>(accountId, "registration_pull", {
        groupId,
      });
    },
    registrationDecide(command: RegistrationCommand) {
      return api<RegistrationReceipt>(accountId, "review_decide", { command });
    },
    async registrationCommandStatus(idempotencyKey: string) {
      try {
        return await api<RegistrationReceipt>(
          accountId,
          `registration_command_status?idempotencyKey=${
            encodeURIComponent(idempotencyKey)
          }`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    resultsPull(groupId: string) {
      return api<ResultSnapshot>(accountId, "results_pull", { groupId });
    },
    resultsCollect(groupId: string, poolId: string, contestNumber?: number) {
      // A API recusa chaves que não conhece: o concurso só vai quando foi pedido.
      return api<ResultSnapshot>(accountId, "results_collect", {
        groupId,
        poolId,
        ...(contestNumber === undefined ? {} : { contestNumber }),
      });
    },
    resultDecide(command: ResultCommand) {
      return api<ResultReceipt>(accountId, "review_decide", { command });
    },
    async resultCommandStatus(idempotencyKey: string) {
      try {
        return await api<ResultReceipt>(
          accountId,
          `result_command_status?idempotencyKey=${
            encodeURIComponent(idempotencyKey)
          }`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    evidenceUpload(metadata: EvidenceUploadMetadata, original: Blob) {
      const body = new FormData();
      body.append("metadata", JSON.stringify(metadata));
      body.append("original", original, metadata.originalName);
      return api<EvidenceMetadata>(accountId, "evidence_upload", body);
    },
    async evidenceStatus(id: string) {
      try {
        return await api<EvidenceMetadata>(
          accountId,
          `evidence_status?id=${encodeURIComponent(id)}`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    async push(operations: DraftOperation[]) {
      return (await api<{ receipts: PushReceipt[] }>(accountId, "sync_push", {
        operations,
      })).receipts;
    },
    pull(groupId: string, cursor: number) {
      return api<PullResponse>(accountId, "sync_pull", { groupId, cursor });
    },
    async listGroupIds() {
      const result = await api<
        {
          groups: {
            id: string;
            name: string;
            role: string;
            groupRevision: number;
          }[];
        }
      >(accountId, "groups");
      return result.groups.map((group) => group.id);
    },
    async commandStatus(idempotencyKey: string) {
      try {
        return await api<PushReceipt>(
          accountId,
          `command_status?idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    financialPull(groupId: string) {
      return api<FinancialSnapshot>(accountId, "finance_pull", { groupId });
    },
    reviewDecide(command: FinancialCommand) {
      return api<FinancialReceipt>(accountId, "review_decide", { command });
    },
    async financialCommandStatus(idempotencyKey: string) {
      try {
        return await api<FinancialReceipt>(
          accountId,
          `finance_command_status?idempotencyKey=${
            encodeURIComponent(idempotencyKey)
          }`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    planningPull(groupId: string) {
      return api<PlanningSnapshot>(accountId, "plan_pull", { groupId });
    },
    planningDecide(command: PlanningCommand) {
      return api<PlanningReceipt>(accountId, "review_decide", { command });
    },
    async planningCommandStatus(idempotencyKey: string) {
      try {
        return await api<PlanningReceipt>(
          accountId,
          `plan_command_status?idempotencyKey=${
            encodeURIComponent(idempotencyKey)
          }`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    settlementPull(groupId: string) {
      return api<SettlementSnapshot>(accountId, "settlement_pull", { groupId });
    },
    settlementDecide(command: SettlementCommand) {
      return api<SettlementReceipt>(accountId, "review_decide", { command });
    },
    async settlementCommandStatus(idempotencyKey: string) {
      try {
        return await api<SettlementReceipt>(
          accountId,
          `settlement_command_status?idempotencyKey=${
            encodeURIComponent(idempotencyKey)
          }`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
