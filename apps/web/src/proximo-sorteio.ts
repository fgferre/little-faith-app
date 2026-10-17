import { useEffect, useState } from "react";
import { readCaixaExtras, RESULT_SOURCE_URLS } from "@bolao/core";
import type { CaixaExtras, LotteryId } from "@bolao/core";

/**
 * O próximo sorteio de uma modalidade (concurso, data, prêmio estimado, se acumulou e os valores guardados à parte), lido
 * da API oficial da CAIXA pelo próprio aparelho (o servidor é barrado, 403) e guardado aqui com a hora da coleta. Uma
 * consulta só para o Início, a barra lateral, o convite e o cartão: vale por algumas horas; se a busca falha, o último
 * dado fica, dizendo de quando é; sem dado nenhum, "estimativa indisponível". Uma estimativa ausente nunca vira zero.
 * Decisões do dono em 16/10 (PLAN-cartao.md, 10 a 13).
 */
export interface ProximoSorteio {
  lotteryId: LotteryId;
  /** Quando a CAIXA respondeu (ISO); é o "atualizado às" mostrado. */
  fetchedAt: string;
  extras: CaixaExtras;
}
export type ProximoSorteioStatus =
  | "loading"
  | "fresh"
  | "stale"
  | "unavailable";

const KEY = (lotteryId: LotteryId) => `little-faith:proximo-sorteio:${lotteryId}`;
/** Vale por 3 h; depois de uma falha espera 15 min antes de tentar de novo (espera que cresce a cada falha seguida). */
export const FRESH_MS = 3 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const failures = new Map<LotteryId, { count: number; at: number }>();
const inflight = new Map<LotteryId, Promise<ProximoSorteio | null>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function readStored(lotteryId: LotteryId): ProximoSorteio | null {
  try {
    const text = localStorage.getItem(KEY(lotteryId));
    if (!text) return null;
    const value = JSON.parse(text) as ProximoSorteio;
    return value.lotteryId === lotteryId && typeof value.fetchedAt === "string" &&
        value.extras && typeof value.extras === "object"
      ? value
      : null;
  } catch {
    return null;
  }
}

function store(value: ProximoSorteio) {
  try {
    localStorage.setItem(KEY(value.lotteryId), JSON.stringify(value));
  } catch {
    // Sem armazenamento (navegação privada), o dado vive só nesta visita.
  }
}

export const isFresh = (value: ProximoSorteio | null, now = Date.now()) =>
  value !== null && now - Date.parse(value.fetchedAt) < FRESH_MS;

/** Depois de falhas seguidas, a próxima tentativa espera 15 min, 30 min, 1 h… (até 6 h). */
export function retryAfter(count: number) {
  return Math.min(RETRY_MS * 2 ** Math.max(count - 1, 0), 6 * 60 * 60 * 1000);
}

function waiting(lotteryId: LotteryId, now = Date.now()) {
  const failed = failures.get(lotteryId);
  return !!failed && now - failed.at < retryAfter(failed.count);
}

/** A resposta da CAIXA para a modalidade pedida, com o próximo concurso; qualquer outra coisa é falha. */
export function parseProximoSorteio(
  lotteryId: LotteryId,
  rawText: string,
  fetchedAt: string,
): ProximoSorteio | null {
  const extras = readCaixaExtras(rawText);
  return extras.lotteryId === lotteryId && extras.nextContestNumber !== null
    ? { lotteryId, fetchedAt, extras }
    : null;
}

/** Busca na CAIXA se o dado guardado venceu (ou `force`), respeitando a espera depois de falhas; devolve o que valer. */
export function fetchProximoSorteio(
  lotteryId: LotteryId,
  force = false,
): Promise<ProximoSorteio | null> {
  const stored = readStored(lotteryId);
  if (!force && (isFresh(stored) || waiting(lotteryId))) {
    return Promise.resolve(stored);
  }
  const pending = inflight.get(lotteryId);
  if (pending) return pending;
  const run = (async () => {
    try {
      const response = await fetch(RESULT_SOURCE_URLS[lotteryId], {
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const value = parseProximoSorteio(
        lotteryId,
        await response.text(),
        new Date().toISOString(),
      );
      if (!value) throw new Error("caixa_unexpected");
      failures.delete(lotteryId);
      store(value);
      return value;
    } catch {
      const failed = failures.get(lotteryId);
      failures.set(lotteryId, { count: (failed?.count ?? 0) + 1, at: Date.now() });
      return stored;
    } finally {
      inflight.delete(lotteryId);
      notify();
    }
  })();
  inflight.set(lotteryId, run);
  return run;
}

/** O próximo sorteio para a tela: o dado (fresco ou velho, com a hora) e o estado; `null` de modalidade não consulta. */
export function useProximoSorteio(lotteryId: LotteryId | null) {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!lotteryId || !navigator.onLine) return;
    void fetchProximoSorteio(lotteryId);
  }, [lotteryId]);
  const data = lotteryId ? readStored(lotteryId) : null;
  const status: ProximoSorteioStatus = !lotteryId
    ? "unavailable"
    : isFresh(data)
    ? "fresh"
    : data
    ? "stale"
    : inflight.has(lotteryId)
    ? "loading"
    : "unavailable";
  return { data, status };
}
