import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CalendarClock, Download, RefreshCw, ShieldCheck } from "lucide-react";
import {
  assessRegisteredPrizes,
  brasiliaDateTimeToUTC,
  createResultView,
  formatBRL,
  LOTTERIES,
  parseBRL,
} from "@bolao/core";
import type { LocalRecord, ResultAction } from "@bolao/core";
import {
  collectResults,
  getRegistrationSnapshot,
  getResultSnapshot,
} from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { createAccountTransport } from "./auth";
import { Numbers, SectionTitle } from "./components";
import { downloadText } from "./registration-handoff";
import type { RecordRequest } from "./record-decision";

const prizeHits = {
  "mega-sena": [6, 5, 4],
  lotofacil: [15, 14, 13, 12, 11],
  quina: [5, 4, 3, 2],
} as const;
const resultLabels = {
  waiting: "Aguardando números",
  "numbers-only": "Números disponíveis · rateio pendente",
  complete: "Resultado completo",
  manual: "Resultado informado manualmente",
  conflict: "Diferenças entre versões precisam de revisão",
};
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível consultar o resultado.";
export function formatInstant(value: string | null, timeZone: string) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value))
    : "A definir";
}

export default function Results(
  { db, groupId, pool, enabled, availability, timeZone, open }: {
    db: BolaoDatabase;
    groupId: string;
    pool: LocalRecord<"pool">;
    enabled: boolean;
    availability: string;
    timeZone: string;
    open: (request: RecordRequest) => void;
  },
) {
  const scope = `${db.name}:${groupId}:${pool.id}`;
  const raw = useLiveQuery(async () => ({
    scope,
    results: await getResultSnapshot(db, groupId),
    registrations: await getRegistrationSnapshot(db, groupId),
    attempts: await db.resultCollectionAttempts.where("[groupId+poolId]")
      .equals([groupId, pool.id]).toArray(),
  }), [db, groupId, pool.id]);
  const local = raw?.scope === scope ? raw : undefined;
  const indexed = useMemo(
    () => local?.results ? createResultView(local.results) : null,
    [local?.results],
  );
  const view = indexed?.currentResult(pool.id) ?? null;
  const calendar = indexed?.currentCalendar(pool.id) ?? null;
  const report = local?.registrations?.reports.filter((item) =>
    item.poolId === pool.id
  ).sort((a, b) => b.version - a.version)[0];
  const assessment = report && view
    ? assessRegisteredPrizes(report, view)
    : null;
  const versions =
    local?.results?.results.filter((item) => item.poolId === pool.id).sort((
      a,
      b,
    ) => b.version - a.version) ?? [];
  const lastAttempt = local?.attempts.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [reason, setReason] = useState("");
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function collect() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      await collectResults(
        db,
        createAccountTransport(db.accountId),
        groupId,
        pool.id,
      );
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="planning-sections">
      <section className="panel" aria-label="Resultado do concurso">
        <SectionTitle
          title={`Resultado · ${LOTTERIES[pool.data.lotteryId].label}`}
          subtitle={pool.data.contestNumber
            ? `Concurso ${pool.data.contestNumber}. Fontes e versões ficam preservadas para conferência.`
            : "Defina o concurso do bolão para consultar os números e rateios."}
        />
        <p
          className={`simple-pill ${
            view?.status === "complete" ? "green" : "amber"
          }`}
        >
          {resultLabels[view?.status ?? "waiting"]}
        </p>
        {view?.result?.drawnNumbers && (
          <Numbers
            lotteryId={pool.data.lotteryId}
            numbers={view.result.drawnNumbers}
          />
        )}
        {view?.result && (
          <p className="muted">
            Versão {view.result.version} · {view.result.source === "caixa"
              ? "Fonte CAIXA"
              : `Fonte informada: ${view.result.sourceReference}`}{" "}
            · consultada em {formatInstant(view.result.collectedAt, timeZone)}
            {" "}
            ({timeZone})
          </p>
        )}
        <div className="planning-actions">
          <button
            className="button secondary"
            disabled={!enabled || busy || !pool.data.contestNumber}
            onClick={() => void collect()}
          >
            <RefreshCw size={17} className={busy ? "spin" : ""} />Consultar
            resultado da CAIXA
          </button>
        </div>
        {!enabled && (
          <p className="inline-note">
            {availability}{" "}
            O último resultado disponível permanece neste aparelho.
          </p>
        )}
        {(error || lastAttempt?.status === "failed") && (
          <p className="form-error" role="alert">
            {error ?? lastAttempt?.message}{" "}
            O último resultado válido foi preservado.
          </p>
        )}
        {view?.result?.payouts && (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Faixa</th>
                  <th>Ganhadores</th>
                  <th>Prêmio por combinação</th>
                </tr>
              </thead>
              <tbody>
                {view.result.payouts.map((tier) => (
                  <tr key={tier.hits}>
                    <td>{tier.hits} acertos</td>
                    <td>{tier.winnerCount ?? "Ainda não informado"}</td>
                    <td>
                      {tier.prizeCents === null
                        ? "Rateio pendente"
                        : formatBRL(tier.prizeCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view?.status === "conflict" && (
          <div className="result-conflict">
            <p>
              Compare as versões abaixo antes de escolher a fonte para apuração.
            </p>
            <label>
              Versão para usar<select
                value={chosen}
                onChange={(event) => setChosen(event.target.value)}
              >
                <option value="">Selecione a versão</option>
                {versions.filter((item) => item.drawnNumbers).map((item) => (
                  <option key={item.id} value={item.id}>
                    Versão {item.version} ·{" "}
                    {item.source === "caixa" ? "CAIXA" : "manual"} ·{" "}
                    {item.drawnNumbers?.join(" ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Motivo da escolha<textarea
                value={reason}
                rows={2}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={!enabled || !chosen || !reason.trim()}
              onClick={() =>
                open({
                  family: "result",
                  action: {
                    type: "result_resolve",
                    poolId: pool.id,
                    poolVersion: pool.serverVersion,
                    resultId: chosen,
                    observedResultIds: versions.map((item) => item.id).sort(),
                    reason: reason.trim(),
                  },
                })}
            >
              <ShieldCheck size={17} />Revisar escolha do resultado
            </button>
          </div>
        )}
        {!!versions.length && (
          <details className="planning-details">
            <summary>Comparar fontes e versões preservadas</summary>
            {versions.map((item) => (
              <div className="result-version" key={item.id}>
                <strong>
                  Versão {item.version} ·{" "}
                  {item.source === "caixa" ? "CAIXA" : "manual"}
                </strong>
                <p>
                  {item.sourceReference} ·{" "}
                  {formatInstant(item.collectedAt, timeZone)}
                </p>
                {item.drawnNumbers
                  ? (
                    <Numbers
                      numbers={item.drawnNumbers}
                      lotteryId={item.lotteryId}
                      small
                    />
                  )
                  : <p>Números ainda não publicados.</p>}
                {item.payouts?.map((tier) => (
                  <p key={tier.hits}>
                    {tier.hits} acertos: {tier.prizeCents === null
                      ? "rateio pendente"
                      : formatBRL(tier.prizeCents)} ·{" "}
                    {tier.winnerCount ?? "quantidade de ganhadores pendente"}
                  </p>
                ))}
                <code>{item.sha256}</code>
                <button
                  className="button secondary"
                  onClick={() =>
                    downloadText(
                      item.rawText,
                      `fonte-resultado-${item.contestNumber}-v${item.version}.json`,
                      "application/json",
                    )}
                >
                  <Download size={16} />Baixar fonte preservada
                </button>
              </div>
            ))}
          </details>
        )}
      </section>
      <section className="panel" aria-label="Apuração dos jogos registrados">
        <SectionTitle
          title="Conferência dos jogos registrados"
          subtitle="A apuração usa as dezenas lidas nos comprovantes e conta os múltiplos prêmios das apostas ampliadas."
        />
        {!report
          ? (
            <p className="inline-note">
              Confira os comprovantes na seção Registro para apurar os jogos
              efetivamente registrados.
            </p>
          )
          : !assessment || assessment.status === "waiting"
          ? (
            <p className="inline-note">
              Aguardando números do concurso. Ausência de resultado permanece
              pendente.
            </p>
          )
          : assessment.status === "conflict"
          ? (
            <p className="inline-note">
              Resolva as diferenças entre resultados antes de apurar valores.
            </p>
          )
          : (
            <>
              <div className="planner-overview">
                <div>
                  <span>Prêmio calculado</span>
                  <strong>
                    {assessment.calculatedPrizeCents === null
                      ? "Total ainda incompleto"
                      : formatBRL(assessment.calculatedPrizeCents)}
                  </strong>
                </div>
                <div>
                  <span>Jogos conferidos</span>
                  <strong>{assessment.games.length}</strong>
                </div>
                <div>
                  <span>Cartelas sem apuração</span>
                  <strong>{assessment.skippedTicketKeys.length}</strong>
                </div>
              </div>
              <p className="inline-note">
                Este é o prêmio calculado. Resgate e distribuição precisam de
                confirmações próprias.
              </p>
              <div className="registered-games">
                {assessment.games.map((game) => (
                  <div
                    className="receipt-planned"
                    key={`${game.plannedTicketKey}:${game.observedBetIndex}`}
                  >
                    <Numbers
                      lotteryId={pool.data.lotteryId}
                      numbers={game.numbers}
                      small
                    />
                    <strong>
                      {game.hits} acertos · {game.calculatedPrizeCents === null
                        ? "valor pendente"
                        : formatBRL(game.calculatedPrizeCents)}
                    </strong>
                    {game.tiers.filter((tier) => tier.combinations !== "0").map(
                      (tier) => (
                        <small key={tier.hits}>
                          {tier.combinations} combinação(ões) de {tier.hits}
                          {" "}
                          acertos · {tier.totalCents === null
                            ? "rateio pendente"
                            : formatBRL(tier.totalCents)}
                        </small>
                      ),
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
      </section>
      <section className="panel">
        <SectionTitle
          title="Horários do concurso"
          subtitle="Brasília e seu fuso aparecem juntos. O prazo interno do grupo continua separado do encerramento do canal."
        />
        <dl className="planning-values">
          <div>
            <dt>Prazo interno · Brasília</dt>
            <dd>{formatInstant(pool.data.deadlineAt, "America/Sao_Paulo")}</dd>
          </div>
          <div>
            <dt>Prazo interno · {timeZone}</dt>
            <dd>{formatInstant(pool.data.deadlineAt, timeZone)}</dd>
          </div>
          <div>
            <dt>Encerramento do canal · Brasília</dt>
            <dd>
              {formatInstant(
                calendar?.registrationClosesAt ?? null,
                "America/Sao_Paulo",
              )}
            </dd>
          </div>
          <div>
            <dt>Encerramento do canal · {timeZone}</dt>
            <dd>
              {formatInstant(calendar?.registrationClosesAt ?? null, timeZone)}
            </dd>
          </div>
          <div>
            <dt>Sorteio previsto · Brasília</dt>
            <dd>
              {formatInstant(
                calendar?.expectedDrawAt ?? null,
                "America/Sao_Paulo",
              )}
            </dd>
          </div>
          <div>
            <dt>Sorteio previsto · {timeZone}</dt>
            <dd>{formatInstant(calendar?.expectedDrawAt ?? null, timeZone)}</dd>
          </div>
        </dl>
        {calendar && (
          <p className="muted">
            Versão {calendar.version} · {calendar.sourceReference}
          </p>
        )}
        <ResultForms
          key={scope}
          db={db}
          pool={pool}
          enabled={enabled}
          open={open}
        />
      </section>
    </div>
  );
}

interface ResultDraft {
  numbers: string;
  date: string;
  source: string;
  reason: string;
  payouts: Record<string, { amount: string; winners: string }>;
  calendarDate: string;
  drawAt: string;
  closesAt: string;
  calendarSource: string;
  calendarReason: string;
}
const initialDraft: ResultDraft = {
  numbers: "",
  date: "",
  source: "",
  reason: "",
  payouts: {},
  calendarDate: "",
  drawAt: "",
  closesAt: "",
  calendarSource: "",
  calendarReason: "",
};
function ResultForms(
  { db, pool, enabled, open }: {
    db: BolaoDatabase;
    pool: LocalRecord<"pool">;
    enabled: boolean;
    open: (request: RecordRequest) => void;
  },
) {
  const key = `result-draft:${pool.groupId}:${pool.id}`;
  const [draft, setDraft] = useState<ResultDraft>(initialDraft);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    void db.metadata.get(key).then((item) => {
      if (active) {
        if (item) setDraft(item.value as ResultDraft);
        setLoaded(true);
      }
    }).catch((failure) => {
      if (active) setError(errorMessage(failure));
    });
    return () => {
      active = false;
    };
  }, [db, key]);
  function update(fields: Partial<ResultDraft>) {
    const next = { ...draft, ...fields };
    setDraft(next);
    setError(null);
    writes.current = writes.current.then(async () => {
      await db.metadata.put({ key, value: structuredClone(next) });
    }).catch((failure) => setError(errorMessage(failure)));
  }
  async function review(kind: "result" | "calendar") {
    try {
      await writes.current;
      if (!pool.data.contestNumber) {
        throw new Error(
          "Defina o concurso do bolão antes de preparar a conferência.",
        );
      }
      let action: ResultAction;
      if (kind === "result") {
        if (!draft.source.trim() || !draft.reason.trim()) {
          throw new Error("Informe a fonte e o motivo do resultado manual.");
        }
        action = {
          type: "result_manual",
          poolId: pool.id,
          poolVersion: pool.serverVersion,
          sourceReference: draft.source.trim(),
          reason: draft.reason.trim(),
          data: {
            lotteryId: pool.data.lotteryId,
            contestNumber: pool.data.contestNumber,
            drawDate: draft.date || null,
            drawnNumbers: draft.numbers.trim()
              ? draft.numbers.trim().split(/[\s,;]+/).map(Number)
              : null,
            payouts: Object.values(draft.payouts).some((tier) =>
                tier.amount.trim() || tier.winners.trim()
              )
              ? prizeHits[pool.data.lotteryId].map((hits) => ({
                hits,
                prizeCents: draft.payouts[hits]?.amount.trim()
                  ? parseBRL(draft.payouts[hits]!.amount)
                  : null,
                winnerCount: draft.payouts[hits]?.winners.trim() || null,
              }))
              : null,
          },
        };
      } else {
        if (!draft.calendarSource.trim() || !draft.calendarReason.trim()) {
          throw new Error(
            "Informe a fonte e o motivo dos horários do concurso.",
          );
        }
        action = {
          type: "calendar_confirm",
          poolId: pool.id,
          poolVersion: pool.serverVersion,
          lotteryId: pool.data.lotteryId,
          contestNumber: pool.data.contestNumber,
          drawDate: draft.calendarDate || null,
          expectedDrawAt: draft.drawAt
            ? brasiliaDateTimeToUTC(draft.drawAt)
            : null,
          registrationClosesAt: draft.closesAt
            ? brasiliaDateTimeToUTC(draft.closesAt)
            : null,
          sourceReference: draft.calendarSource.trim(),
          reason: draft.calendarReason.trim(),
        };
      }
      open({ family: "result", action });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <>
      <details className="planning-details result-form">
        <summary>Informar ou revisar horários com fonte</summary>
        <label>
          Data do concurso em Brasília<input
            type="date"
            value={draft.calendarDate}
            onChange={(event) => update({ calendarDate: event.target.value })}
          />
        </label>
        <label>
          Sorteio previsto (Brasília)<input
            type="datetime-local"
            value={draft.drawAt}
            onChange={(event) => update({ drawAt: event.target.value })}
          />
        </label>
        <label>
          Encerramento do canal (Brasília)<input
            type="datetime-local"
            value={draft.closesAt}
            onChange={(event) => update({ closesAt: event.target.value })}
          />
        </label>
        <label>
          Fonte dos horários<input
            value={draft.calendarSource}
            onChange={(event) => update({ calendarSource: event.target.value })}
          />
        </label>
        <label>
          Motivo da definição ou correção<textarea
            rows={2}
            value={draft.calendarReason}
            onChange={(event) => update({ calendarReason: event.target.value })}
          />
        </label>
        <button
          className="button primary"
          disabled={!enabled || !loaded || !pool.data.contestNumber}
          onClick={() => void review("calendar")}
        >
          <CalendarClock size={17} />Revisar horários do concurso
        </button>
      </details>
      <details className="planning-details result-form">
        <summary>Informar resultado manual com fonte</summary>
        <p>
          Use os dados publicados na fonte. Valores que ainda não foram
          publicados ficam vazios e pendentes.
        </p>
        <label>
          Data do sorteio em Brasília<input
            type="date"
            value={draft.date}
            onChange={(event) => update({ date: event.target.value })}
          />
        </label>
        <label>
          Dezenas sorteadas<textarea
            rows={2}
            value={draft.numbers}
            onChange={(event) => update({ numbers: event.target.value })}
          />
        </label>
        <div className="manual-payouts">
          {prizeHits[pool.data.lotteryId].map((hits) => (
            <div className="form-columns" key={hits}>
              <label>
                Prêmio de {hits} acertos (R$)<input
                  inputMode="decimal"
                  value={draft.payouts[hits]?.amount ?? ""}
                  onChange={(event) =>
                    update({
                      payouts: {
                        ...draft.payouts,
                        [hits]: {
                          winners: draft.payouts[hits]?.winners ?? "",
                          amount: event.target.value,
                        },
                      },
                    })}
                />
              </label>
              <label>
                Ganhadores de {hits} acertos<input
                  inputMode="numeric"
                  value={draft.payouts[hits]?.winners ?? ""}
                  onChange={(event) =>
                    update({
                      payouts: {
                        ...draft.payouts,
                        [hits]: {
                          amount: draft.payouts[hits]?.amount ?? "",
                          winners: event.target.value,
                        },
                      },
                    })}
                />
              </label>
            </div>
          ))}
        </div>
        <label>
          Fonte do resultado<input
            value={draft.source}
            onChange={(event) => update({ source: event.target.value })}
          />
        </label>
        <label>
          Motivo do resultado manual<textarea
            rows={2}
            value={draft.reason}
            onChange={(event) => update({ reason: event.target.value })}
          />
        </label>
        <button
          className="button primary"
          disabled={!enabled || !loaded || !pool.data.contestNumber}
          onClick={() => void review("result")}
        >
          <ShieldCheck size={17} />Revisar resultado informado
        </button>
      </details>
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}
