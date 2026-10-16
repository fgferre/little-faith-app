import type { ParticipantCard } from "@bolao/core";
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
}

/** Falha de uma chamada de link pessoal; `status` 0 quando nem chegou ao servidor (sem conta ou sem configuração). */
export class ParticipantApiError extends Error {
  constructor(message: string, readonly status: number) {
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
  const response = await fetch(`${supabaseUrl}/functions/v1/api/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseKey,
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as {
      error?: string;
      message?: string;
    } | null;
    throw new ParticipantApiError(
      response.status === 503
        ? LINKS_UNAVAILABLE
        : result?.message ?? result?.error ??
          `O servidor não respondeu como esperado (${response.status}).`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Pedido do organizador: vai com a sessão da conta, como as outras chamadas da API. */
async function organizer<T>(
  path: string,
  body?: unknown,
  method?: "GET" | "POST" | "PUT" | "DELETE",
): Promise<T> {
  if (!supabase) {
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
  return call<T>(
    path,
    { Authorization: `Bearer ${session.access_token}` },
    body,
    method,
  );
}

/** O cartão aberto pelo link: sem conta e sem Authorization; o token é a única chave. */
export function fetchParticipantCard(token: string) {
  return call<ParticipantCard>("participant_card", {}, { token });
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
