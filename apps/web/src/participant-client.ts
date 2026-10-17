import type {
  ParticipantAnswerKind,
  ParticipantCard,
  ParticipantResponse,
  ParticipantResponsesPull,
} from "@bolao/core";
import { supabase } from "./auth";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

export interface ParticipantLink {
  id: string;
  personId: string;
  createdAt: string;
  revokedAt: string | null;
  /** A pessoa protegeu o cartão deste link com PIN; ausente em respostas de antes do PIN. */
  hasPin?: boolean;
}

/**
 * Falha de uma chamada de link pessoal; `status` 0 quando nem chegou ao servidor (sem conta ou sem configuração).
 * `code`, `attemptsLeft` e `retryAt` vêm do corpo da resposta quando o servidor os manda (os do PIN).
 */
export class ParticipantApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly attemptsLeft?: number,
    readonly retryAt?: string,
  ) {
    super(message);
  }
}

export const LINKS_UNAVAILABLE = "O servidor ainda não está preparado para links.";

async function call<T>(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method: "GET" | "POST" | "PUT" | "DELETE" = body === undefined ? "GET" : "POST",
): Promise<T> {
  if (!supabaseUrl || !supabaseKey) {
    throw new ParticipantApiError(
      "A conexão compartilhada ainda não foi configurada.",
      0,
    );
  }
  // Um FormData (comprovante) vai como está: o navegador põe o tipo com a fronteira das partes.
  const json = body !== undefined && !(body instanceof FormData);
  const response = await fetch(`${supabaseUrl}/functions/v1/api/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseKey,
      ...headers,
      ...(json ? { "Content-Type": "application/json" } : {}),
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
      code?: string;
      attemptsLeft?: number;
      retryAt?: string;
    } | null;
    throw new ParticipantApiError(
      response.status === 503
        ? LINKS_UNAVAILABLE
        : result?.message ?? result?.error ??
          `O servidor não respondeu como esperado (${response.status}).`,
      response.status,
      result?.code,
      result?.attemptsLeft,
      result?.retryAt,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** A sessão da conta de quem organiza; sem ela, nenhum pedido do organizador sai. */
async function currentSession() {
  if (!supabase || !supabaseUrl || !supabaseKey) {
    throw new ParticipantApiError(
      "A conexão compartilhada ainda não foi configurada.",
      0,
    );
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new ParticipantApiError(
      "Entre na sua conta para enviar links pessoais.",
      0,
    );
  }
  return { session, url: supabaseUrl, key: supabaseKey };
}

/** Pedido do organizador: vai com a sessão da conta, como as outras chamadas da API. */
async function organizer<T>(
  path: string,
  body?: unknown,
  method?: "GET" | "POST" | "PUT" | "DELETE",
): Promise<T> {
  const { session } = await currentSession();
  return call<T>(
    path,
    { Authorization: `Bearer ${session.access_token}` },
    body,
    method,
  );
}

/** O cartão aberto pelo link: sem conta e sem Authorization; o token é a única chave, mais o PIN quando o cartão tem um. */
export function fetchParticipantCard(token: string, pin?: string) {
  return call<ParticipantCard>(
    "participant_card",
    {},
    pin ? { token, pin } : { token },
  );
}

/** Cria, troca (`pin`) ou tira (`pin` nulo) o PIN do cartão; `currentPin` é o PIN de agora, nulo quando o cartão ainda não tem um. */
export function setParticipantPin(
  token: string,
  pin: string | null,
  currentPin: string | null,
) {
  return call<{ pinSet: boolean }>("participant_pin", {}, {
    token,
    pin,
    currentPin,
  });
}

/**
 * A resposta da pessoa nesta rodada ("Estou dentro", "Desta vez estou fora" ou "Já paguei" com o valor), pelo link e o PIN
 * guardado. A chave de idempotência é do aparelho: a nova tentativa repete a mesma e o servidor não registra duas vezes.
 */
export function sendParticipantAnswer(
  token: string,
  pin: string | null,
  answer: {
    poolId: string;
    kind: ParticipantAnswerKind;
    amountCents: string | null;
    idempotencyKey: string;
  },
) {
  return call<{ response: ParticipantResponse }>("participant_respond", {}, {
    token,
    ...(pin ? { pin } : {}),
    poolId: answer.poolId,
    kind: answer.kind,
    ...(answer.amountCents === null ? {} : { amountCents: answer.amountCents }),
    idempotencyKey: answer.idempotencyKey,
  });
}

/** "Já paguei" com o comprovante (foto ou PDF, até 10 MiB): o arquivo e o valor vão juntos, e a resposta vira "paid". */
export function sendParticipantProof(
  token: string,
  pin: string | null,
  answer: { poolId: string; amountCents: string; idempotencyKey: string },
  file: Blob,
) {
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({ token, ...(pin ? { pin } : {}), ...answer }),
  );
  form.append("original", file);
  return call<{ response: ParticipantResponse }>("participant_proof", {}, form);
}

/** Cria o link de uma pessoa; o token só existe nesta resposta. */
export function createParticipantLink(groupId: string, personId: string) {
  return organizer<Omit<ParticipantLink, "revokedAt"> & { token: string }>(
    "participant_link",
    { groupId, personId },
  );
}

export function revokeParticipantLink(groupId: string, id: string) {
  return organizer<{ id: string; revokedAt: string }>(
    "participant_link_revoke",
    { groupId, id },
  );
}

export async function pullParticipantLinks(groupId: string) {
  return (await organizer<{ links: ParticipantLink[] }>(
    "participant_links_pull",
    { groupId },
  )).links;
}

/** As respostas dadas pelos cartões do grupo (toda a história, da mais antiga à mais nova) e os lembretes marcados. */
export function pullParticipantResponses(groupId: string) {
  return organizer<ParticipantResponsesPull>("participant_responses_pull", {
    groupId,
  });
}

/** Marca que o tesoureiro lembrou a pessoa agora; vale em qualquer aparelho dele ("lembrado ontem"). */
export function markParticipantReminder(
  groupId: string,
  poolId: string,
  personId: string,
) {
  return organizer<ParticipantResponsesPull["reminders"][number]>(
    "participant_reminder",
    { groupId, poolId, personId },
  );
}

/** O comprovante que a pessoa mandou pelo cartão, como arquivo; só o organizador do grupo consegue. */
export async function fetchParticipantProof(id: string): Promise<Blob> {
  const { session, url, key } = await currentSession();
  const response = await fetch(
    `${url}/functions/v1/api/v1/participant_proof_download?id=${id}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${session.access_token}`,
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new ParticipantApiError(
      "Não deu para abrir o comprovante agora.",
      response.status,
    );
  }
  return response.blob();
}

/** Telefones de WhatsApp por pessoa: só o organizador lê e grava; nunca vão no link nem no cartão. */
export interface PersonPhone {
  personId: string;
  phone: string;
}

export async function pullPersonPhones(groupId: string) {
  return (await organizer<{ phones: PersonPhone[] }>(
    `groups/${groupId}/phones`,
  )).phones;
}

/** `phone` só com dígitos, DDI primeiro (10 a 15). */
export function setPersonPhone(
  groupId: string,
  personId: string,
  phone: string,
) {
  return organizer<PersonPhone>(
    `groups/${groupId}/persons/${personId}/phone`,
    { phone },
    "PUT",
  );
}

export async function clearPersonPhone(groupId: string, personId: string) {
  await organizer<void>(
    `groups/${groupId}/persons/${personId}/phone`,
    undefined,
    "DELETE",
  );
}
