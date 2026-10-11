import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, ShieldCheck, Undo2 } from "lucide-react";
import {
  brasiliaDateTimeToUTC,
  computeSettlement,
  createRedemptionDeadline,
  createResultView,
  formatBRL,
  parseBRL,
  redemptionAlerts,
  settlementStatement,
} from "@bolao/core";
import type {
  LocalRecord,
  OfficialPrizeEntitlement,
  PoolManifest,
  SettlementAction,
  SettlementSnapshot,
} from "@bolao/core";
import { getSettlementSnapshot } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { EmptyState, SectionTitle } from "./components";
import { downloadText } from "./registration-handoff";
import type { SettlementRequest } from "./settlement-decision";
import { formatInstant } from "./results";

const errorText = (value: unknown) =>
  value instanceof Error
    ? value.message
    : "Não foi possível preparar a conferência.";
const money = (value: string | null) =>
  value === null ? "Pendente" : formatBRL(value);
const names = (manifest: PoolManifest | undefined, personId: string) =>
  manifest?.content.persons.find((person) => person.id === personId)?.data
    .name ?? "Participante";
const newest = <T extends { poolId: string; version: number }>(
  facts: T[],
  poolId: string,
) =>
  facts.filter((fact) => fact.poolId === poolId).sort((a, b) =>
    b.version - a.version
  )[0];

export default function Settlement(
  { db, groupId, pool, enabled, availability, timeZone, open, goRegistration }:
    {
      db: BolaoDatabase;
      groupId: string;
      pool: LocalRecord<"pool">;
      enabled: boolean;
      availability: string;
      timeZone: string;
      open: (request: SettlementRequest) => void;
      goRegistration: () => void;
    },
) {
  const scope = `${db.name}:${groupId}:${pool.id}`;
  const raw = useLiveQuery(
    async () => ({ scope, snapshot: await getSettlementSnapshot(db, groupId) }),
    [db, groupId, pool.id],
  );
  const snapshot = raw?.scope === scope ? raw.snapshot : null;
  const finance = useMemo(() => snapshot ? computeSettlement(snapshot) : null, [
    snapshot,
  ]);
  const balance = finance?.pools[pool.id];
  const report = snapshot
    ? newest(snapshot.registration.reports, pool.id)
    : undefined;
  const manifest = snapshot?.registration.manifests.find((item) =>
    item.id === (report?.manifestId ?? balance?.manifestId)
  );
  const prize = snapshot ? newest(snapshot.prizes, pool.id) : undefined;
  const closure = snapshot ? newest(snapshot.closures, pool.id) : undefined;
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<
    Extract<
      SettlementAction,
      { type: "redemption_reverse" | "distribution_reverse" }
    > | null
  >(null);
  async function download() {
    if (!snapshot || !balance) return;
    try {
      const statement = settlementStatement(snapshot, pool.id);
      const lines = [
        "DEMONSTRATIVO DO GRUPO",
        pool.data.title,
        "Documento do grupo. Não é recibo da CAIXA nem documento fiscal oficial.",
        `Revisão confirmada: ${snapshot.groupRevision}. Emitido em ${
          new Date().toISOString()
        } (UTC).`,
        `Investimento confirmado: ${
          money(balance.contributedCents)
        }. Despesas confirmadas: ${money(balance.confirmedExpenseCents)}.`,
        `Prêmio calculado: ${
          money(balance.calculatedPrizeCents)
        }. Prêmio confirmado: ${money(balance.confirmedPrizeCents)}.`,
        `Resgatado no caixa do organizador: ${
          money(balance.organizerRedeemedCents)
        }. Recebido individualmente: ${
          money(balance.individualRedeemedCents)
        }.`,
        `Prêmios pagos: ${money(balance.prizePaidCents)}. Devoluções: ${
          money(balance.refundedCents)
        }.`,
        `Caixa do organizador neste bolão: ${
          money(balance.organizerCashCents)
        }. Sobra das contribuições: ${
          money(balance.contributionSurplusCents)
        }.`,
        `Prêmio a resgatar: ${
          money(balance.unredeemedPrizeCents)
        }. Prêmio a entregar: ${
          money(balance.unpaidPrizeCents)
        }. Devoluções pendentes: ${money(balance.refundPendingCents)}.`,
        balance.expenseConfirmationPending
          ? "As despesas ainda precisam de confirmação humana."
          : "Despesas conferidas.",
        ...balance.persons.map((person) =>
          `${names(manifest, person.personId)}: investimento ${
            money(person.contributedCents)
          }; direito ao prêmio ${money(person.prizeRightCents)}; recebido ${
            money(person.prizeReceivedCents)
          }; prêmio pendente ${money(person.prizePendingCents)}; devolvido ${
            money(person.refundedCents)
          }; devolução pendente ${money(person.refundPendingCents)}.`
        ),
        closure
          ? `Último encerramento: ${
            closure.direction === "closed" ? "encerrado" : "reaberto"
          }. Motivo: ${closure.reason}. Pendências explicadas: ${
            closure.pendingExplanation || "nenhuma"
          }.`
          : "Encerramento ainda não confirmado.",
        "",
        "Dados do demonstrativo:",
        JSON.stringify(statement, null, 2),
      ];
      downloadText(
        lines.join("\n"),
        `demonstrativo-${pool.data.lotteryId}-${
          pool.data.contestNumber ?? "rascunho"
        }.txt`,
      );
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const alerts =
    prize?.redemptionDeadline && balance?.unredeemedPrizeCents !== "0"
      ? redemptionAlerts(prize.redemptionDeadline, today)
      : [];
  return (
    <div className="planning-layout">
      <section className="panel" aria-label="Resgate e rateio">
        <SectionTitle
          title="Do prêmio ao recebimento"
          subtitle="Prêmio calculado, confirmação, resgate e pagamento aos participantes são acompanhados separadamente."
        />
        {!balance
          ? (
            <EmptyState
              icon={<ShieldCheck size={30} />}
              title="Prepare e trave o bolão"
              description="Os direitos congelados e os comprovantes conferidos permitem acompanhar o resgate e o rateio."
              action={
                <button className="button primary" onClick={goRegistration}>
                  Abrir registro
                </button>
              }
            />
          )
          : (
            <>
              <dl className="plan-values">
                <div>
                  <dt>Prêmio calculado</dt>
                  <dd>{money(balance.calculatedPrizeCents)}</dd>
                </div>
                <div>
                  <dt>Prêmio confirmado</dt>
                  <dd>{money(balance.confirmedPrizeCents)}</dd>
                </div>
                <div>
                  <dt>Resgatado pelo organizador</dt>
                  <dd>{money(balance.organizerRedeemedCents)}</dd>
                </div>
                <div>
                  <dt>Recebido individualmente</dt>
                  <dd>{money(balance.individualRedeemedCents)}</dd>
                </div>
                <div>
                  <dt>Prêmio distribuído</dt>
                  <dd>{money(balance.prizePaidCents)}</dd>
                </div>
                <div>
                  <dt>Prêmio ainda a entregar</dt>
                  <dd>{money(balance.unpaidPrizeCents)}</dd>
                </div>
              </dl>
              <p className="inline-note">
                {balance.participationMode === "official"
                  ? "Cada participante resgata suas cotas oficiais. O recebimento individual fica fora do caixa do organizador."
                  : "O titular recebe o prêmio e o organizador acompanha a distribuição proporcional aos direitos congelados."}
              </p>
              <div className="planning-actions">
                <button
                  className="button secondary"
                  onClick={() => void download()}
                >
                  <Download size={17} />Baixar demonstrativo privado do grupo
                </button>
              </div>
              {!!alerts.length && (
                <div className="redemption-alerts">
                  <p>
                    Prazo de resgate em Brasília:{" "}
                    {prize!.redemptionDeadline!.exception?.deadlineDate ??
                      prize!.redemptionDeadline!.deadlineDate}.{" "}
                    <a
                      href={prize!.redemptionDeadline!.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Fonte do prazo
                    </a>
                  </p>
                  {alerts.map((alert) => (
                    <p key={alert.daysBefore}>
                      {alert.daysBefore} dias antes: {alert.alertDate} ·{" "}
                      {alert.status === "upcoming"
                        ? "programado"
                        : alert.status === "due"
                        ? "conferir hoje"
                        : "data de alerta já passou"}.
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
      </section>
      {balance && snapshot && (
        <>
          <section className="panel" aria-label="Conciliação do bolão">
            <SectionTitle
              title="Dinheiro e pendências"
              subtitle="Reservas do plano não são saídas de dinheiro. As despesas e devoluções precisam ser conferidas."
            />
            <dl className="plan-values">
              <div>
                <dt>Contribuições confirmadas</dt>
                <dd>{money(balance.contributedCents)}</dd>
              </div>
              <div>
                <dt>Despesas confirmadas</dt>
                <dd>{money(balance.confirmedExpenseCents)}</dd>
              </div>
              <div>
                <dt>Devolvido aos participantes</dt>
                <dd>{money(balance.refundedCents)}</dd>
              </div>
              <div>
                <dt>Caixa do organizador</dt>
                <dd>{money(balance.organizerCashCents)}</dd>
              </div>
              <div>
                <dt>Sobra das contribuições</dt>
                <dd>{money(balance.contributionSurplusCents)}</dd>
              </div>
              <div>
                <dt>Devolução pendente</dt>
                <dd>{money(balance.refundPendingCents)}</dd>
              </div>
            </dl>
            {balance.expenseConfirmationPending && (
              <p className="inline-note">
                Os custos das apostas e taxas ainda precisam ser confirmados
                como despesas.
              </p>
            )}
            {balance.cashDeficitCents !== "0" && (
              <p className="form-error" role="alert">
                Há {money(balance.cashDeficitCents)} para reconciliar no caixa.
              </p>
            )}
            {balance.resultConflict && (
              <p className="form-error">
                As fontes do resultado divergem. Resolva a revisão antes de
                confirmar o prêmio.
              </p>
            )}
            {balance.registrationIncomplete && (
              <p className="inline-note">
                A conferência do registro possui dados incompletos ou
                divergentes.
              </p>
            )}
            <p className={`simple-pill ${balance.closed ? "green" : "amber"}`}>
              {balance.closed
                ? "Encerramento confirmado · confira as pendências explicadas"
                : "Conciliação em andamento"}
            </p>
            {closure && (
              <p className="inline-note">
                {closure.reason}
                {closure.pendingExplanation &&
                  ` · Pendências: ${closure.pendingExplanation}`}
              </p>
            )}
          </section>
          <section className="panel" aria-label="Direitos e recebimentos">
            <SectionTitle
              title="Cada pessoa, cada direito"
              subtitle="Os centavos do rateio interno usam os maiores restos. As cotas oficiais usam os valores confirmados de seus recibos."
            />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pessoa</th>
                    <th>Investimento</th>
                    <th>Direito ao prêmio</th>
                    <th>Recebido</th>
                    <th>Prêmio pendente</th>
                    <th>Devolução pendente</th>
                  </tr>
                </thead>
                <tbody>
                  {balance.persons.map((person) => (
                    <tr key={person.personId}>
                      <td>{names(manifest, person.personId)}</td>
                      <td>{money(person.contributedCents)}</td>
                      <td>{money(person.prizeRightCents)}</td>
                      <td>{money(person.prizeReceivedCents)}</td>
                      <td>{money(person.prizePendingCents)}</td>
                      <td>{money(person.refundPendingCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {report && manifest && (
            <SettlementForm
              key={`${db.name}:${pool.id}`}
              db={db}
              pool={pool}
              snapshot={snapshot}
              manifest={manifest}
              enabled={enabled}
              availability={availability}
              open={open}
              correction={correcting}
              clearCorrection={() => setCorrecting(null)}
              goRegistration={goRegistration}
            />
          )}
          <section className="panel" aria-label="Histórico da distribuição">
            <SectionTitle
              title="Histórico do resgate e rateio"
              subtitle="Confirmações e correções permanecem registradas, com fonte e horário."
            />
            {[
              ...snapshot.expenses,
              ...snapshot.prizes,
              ...snapshot.redemptions,
              ...snapshot.distributions,
              ...snapshot.closures,
            ].filter((fact) => fact.poolId === pool.id).sort((a, b) =>
              b.groupRevision - a.groupRevision
            ).map((fact) => (
              <details className="planning-details" key={fact.id}>
                <summary>
                  {"direction" in fact && fact.direction === "closed"
                    ? "Encerramento"
                    : "direction" in fact && fact.direction === "reopened"
                    ? "Reabertura"
                    : "totalCostCents" in fact
                    ? "Despesas confirmadas"
                    : "rights" in fact
                    ? "Prêmio confirmado"
                    : "kind" in fact
                    ? fact.kind === "prize-payment"
                      ? "Pagamento de prêmio"
                      : "Devolução da contribuição"
                    : "Resgate"} · versão {fact.version} ·{" "}
                  {formatInstant(fact.confirmedAt, timeZone)}
                </summary>
                {"amountCents" in fact && (
                  <p>
                    {money(fact.amountCents)} {"personId" in fact &&
                      `· ${names(manifest, fact.personId)}`}
                  </p>
                )}
                {"totalCostCents" in fact && (
                  <p>{money(fact.totalCostCents)}</p>
                )}
                <p>{fact.reason}</p>
                {"sourceReference" in fact && (
                  <p>Fonte: {fact.sourceReference}</p>
                )}
                <p className="manifest-hash">
                  Recibo da confirmação: {fact.receiptId} · revisão{" "}
                  {fact.groupRevision}
                </p>
                {!balance.closed && "prizeConfirmationId" in fact &&
                  "ownership" in fact && fact.direction === "received" &&
                  !snapshot.redemptions.some((item) =>
                    item.reversesId === fact.id
                  ) && (
                  <button
                    className="button secondary"
                    disabled={!enabled}
                    onClick={() =>
                      setCorrecting({
                        type: "redemption_reverse",
                        poolId: pool.id,
                        poolVersion: pool.serverVersion,
                        redemptionId: fact.id,
                        evidenceIds: [],
                        sourceReference: "",
                        eventAt: "",
                        reason: "",
                      })}
                  >
                    <Undo2 size={17} />Conferir correção do resgate
                  </button>
                )}
                {!balance.closed && "kind" in fact &&
                  fact.direction === "paid" &&
                  !snapshot.distributions.some((item) =>
                    item.reversesId === fact.id
                  ) && (
                  <button
                    className="button secondary"
                    disabled={!enabled}
                    onClick={() =>
                      setCorrecting({
                        type: "distribution_reverse",
                        poolId: pool.id,
                        poolVersion: pool.serverVersion,
                        distributionId: fact.id,
                        evidenceIds: [],
                        sourceReference: "",
                        eventAt: "",
                        reason: "",
                      })}
                  >
                    <Undo2 size={17} />Conferir retorno do pagamento
                  </button>
                )}
              </details>
            ))}
            {!snapshot.prizes.some((fact) => fact.poolId === pool.id) && (
              <p className="muted">
                O prêmio ainda não foi confirmado. A apuração calculada
                permanece disponível em Resultado.
              </p>
            )}
          </section>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

interface Draft {
  kind: "expense" | "prize" | "redemption" | "distribution" | "settle";
  amount: string;
  cost: string;
  fee: string;
  personId: string;
  distributionKind: "prize-payment" | "contribution-refund";
  evidenceIds: string[];
  source: string;
  reason: string;
  eventAt: string;
  officialAmounts: Record<string, string>;
  disposition: "group-reserve" | "pending-refund";
  pendingExplanation: string;
  exceptionDate: string;
  exceptionSource: string;
  exceptionReason: string;
}
const emptyDraft: Draft = {
  kind: "expense",
  amount: "",
  cost: "",
  fee: "",
  personId: "",
  distributionKind: "prize-payment",
  evidenceIds: [],
  source: "",
  reason: "",
  eventAt: "",
  officialAmounts: {},
  disposition: "pending-refund",
  pendingExplanation: "",
  exceptionDate: "",
  exceptionSource: "",
  exceptionReason: "",
};
function SettlementForm(
  {
    db,
    pool,
    snapshot,
    manifest,
    enabled,
    availability,
    open,
    correction,
    clearCorrection,
    goRegistration,
  }: {
    db: BolaoDatabase;
    pool: LocalRecord<"pool">;
    snapshot: SettlementSnapshot;
    manifest: PoolManifest;
    enabled: boolean;
    availability: string;
    open: (request: SettlementRequest) => void;
    correction:
      | Extract<
        SettlementAction,
        { type: "redemption_reverse" | "distribution_reverse" }
      >
      | null;
    clearCorrection: () => void;
    goRegistration: () => void;
  },
) {
  const key = `settlement-draft:${pool.id}`;
  const [draft, setDraft] = useState<Draft>(structuredClone(emptyDraft));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void db.metadata.get(key).then((saved) => {
      if (active) {
        if (saved?.value) setDraft(saved.value as Draft);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [db, key]);
  function update(change: Partial<Draft>) {
    const next = { ...draft, ...change };
    setDraft(next);
    writes.current = writes.current.then(async () => {
      await db.metadata.put({ key, value: next });
    }).catch((failure) => {
      if (mounted.current) setError(errorText(failure));
    });
  }
  const report = newest(snapshot.registration.reports, pool.id)!;
  const expense = newest(snapshot.expenses, pool.id);
  const prize = newest(snapshot.prizes, pool.id);
  const closure = newest(snapshot.closures, pool.id);
  const balance = useMemo(() => computeSettlement(snapshot).pools[pool.id], [
    snapshot,
    pool.id,
  ]);
  const result = useMemo(
    () => createResultView(snapshot.results).currentResult(pool.id),
    [snapshot.results, pool.id],
  );
  const evidence = snapshot.registration.evidence.filter((item) =>
    item.poolId === pool.id
  );
  const official = report.items.flatMap((item) =>
    (item.observed?.officialAssignments ?? []).map((assignment) => ({
      ...assignment,
      plannedTicketKey: item.plannedTicketKey,
      personId: manifest.content.plan.rights.find((right) =>
        right.quotaId === assignment.quotaId
      )!.personId,
    }))
  );
  async function review() {
    setError(null);
    try {
      await writes.current;
      const base = { poolId: pool.id, poolVersion: pool.serverVersion };
      const source = {
        evidenceIds: draft.evidenceIds,
        sourceReference: draft.source.trim(),
        reason: draft.reason.trim(),
      };
      let action: SettlementAction;
      if (balance.closed) {
        if (!closure) {
          throw new Error("Sincronize o encerramento antes de reabrir.");
        }
        action = {
          ...base,
          type: "pool_reopen",
          closureId: closure.id,
          reason: draft.reason.trim(),
        };
      } else if (correction) {
        action = {
          ...correction,
          ...base,
          ...source,
          eventAt: brasiliaDateTimeToUTC(draft.eventAt),
        };
      } else if (draft.kind === "expense") {
        action = {
          ...base,
          ...source,
          type: "expense_confirm",
          registrationReportId: report.id,
          supersedesId: expense?.id ?? null,
          betCostCents: parseBRL(draft.cost),
          feeCents: parseBRL(draft.fee),
        };
      } else if (draft.kind === "prize") {
        if (!result.result || result.status === "conflict") {
          throw new Error(
            "Confira e resolva as fontes do resultado antes de confirmar o prêmio.",
          );
        }
        const officialEntitlements: OfficialPrizeEntitlement[] =
          manifest.content.plan.participationMode === "official"
            ? official.map((item) => ({
              ...item,
              amountCents: parseBRL(
                draft
                  .officialAmounts[
                    `${item.plannedTicketKey}:${item.quotaId}`
                  ] ?? "",
              ),
              evidenceIds: draft.evidenceIds,
            }))
            : [];
        action = {
          ...base,
          ...source,
          type: "prize_confirm",
          registrationReportId: report.id,
          resultId: result.result.id,
          supersedesId: prize?.id ?? null,
          amountCents: parseBRL(draft.amount),
          officialEntitlements,
          redemptionDeadline: result.result.drawDate
            ? createRedemptionDeadline(
              pool.data.lotteryId,
              result.result.drawDate,
              draft.exceptionDate
                ? {
                  deadlineDate: draft.exceptionDate,
                  sourceReference: draft.exceptionSource.trim(),
                  reason: draft.exceptionReason.trim(),
                }
                : null,
            )
            : null,
        };
      } else if (draft.kind === "redemption") {
        if (!prize) {
          throw new Error("Confirme o prêmio antes de registrar o resgate.");
        }
        action = {
          ...base,
          ...source,
          type: "redemption_record",
          prizeConfirmationId: prize.id,
          personId: draft.personId,
          amountCents: parseBRL(draft.amount),
          eventAt: brasiliaDateTimeToUTC(draft.eventAt),
        };
      } else if (draft.kind === "distribution") {
        action = {
          ...base,
          ...source,
          type: "distribution_record",
          personId: draft.personId,
          kind: draft.distributionKind,
          amountCents: parseBRL(draft.amount),
          eventAt: brasiliaDateTimeToUTC(draft.eventAt),
        };
      } else {action = {
          ...base,
          type: "pool_settle",
          registrationReportId: report.id,
          prizeConfirmationId: prize?.id ?? null,
          expenseConfirmationId: expense?.id ?? null,
          leftoverDisposition: draft.disposition,
          pendingExplanation: draft.pendingExplanation.trim(),
          reason: draft.reason.trim(),
        };}
      open({ action });
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  return (
    <section className="panel" aria-label="Preparar resgate e distribuição">
      <SectionTitle
        title={balance.closed
          ? "Reabrir para corrigir"
          : correction
          ? "Conferir uma compensação"
          : "Conferir os próximos movimentos"}
        subtitle="O rascunho fica salvo neste aparelho. A confirmação exige revisão online sobre a versão atual."
      />
      {!enabled && <p className="inline-note">{availability}</p>}
      {!balance.closed && !correction && (
        <label>
          O que deseja conferir<select
            value={draft.kind}
            disabled={!loaded}
            onChange={(event) =>
              update({ kind: event.target.value as Draft["kind"] })}
          >
            <option value="expense">Despesas de apostas e taxas</option>
            <option value="prize">Prêmio confirmado</option>
            <option value="redemption">Resgate recebido</option>
            <option value="distribution">Pagamento ou devolução</option>
            <option value="settle">Encerramento do bolão</option>
          </select>
        </label>
      )}
      {correction && !balance.closed && (
        <p className="inline-note">
          Esta compensação registra a devolução integral do movimento original.
          Use o comprovante do retorno; o movimento anterior será preservado.
          {" "}
          <button className="text-button" onClick={clearCorrection}>
            Cancelar correção
          </button>
        </p>
      )}
      {!balance.closed && !correction && draft.kind === "expense" && (
        <div className="form-columns">
          <label>
            Despesas das apostas (R$)<input
              inputMode="decimal"
              value={draft.cost}
              onChange={(event) =>
                update({ cost: event.target.value })}
            />
          </label>
          <label>
            Taxas efetivamente pagas (R$)<input
              inputMode="decimal"
              value={draft.fee}
              onChange={(event) => update({ fee: event.target.value })}
            />
          </label>
        </div>
      )}
      {!balance.closed && !correction &&
        ["prize", "redemption", "distribution"].includes(draft.kind) && (
        <label>
          {draft.kind === "prize"
            ? "Valor do prêmio confirmado (R$)"
            : draft.kind === "redemption"
            ? "Valor efetivamente recebido (R$)"
            : "Valor efetivamente entregue (R$)"}
          <input
            inputMode="decimal"
            value={draft.amount}
            onChange={(event) => update({ amount: event.target.value })}
          />
        </label>
      )}
      {!balance.closed && !correction &&
        ["redemption", "distribution"].includes(draft.kind) && (
        <label>
          Pessoa que recebeu<select
            value={draft.personId}
            onChange={(event) => update({ personId: event.target.value })}
          >
            <option value="">Selecione a pessoa</option>
            {manifest.content.persons.map((person) => (
              <option key={person.id} value={person.id}>
                {person.data.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!balance.closed && !correction && draft.kind === "distribution" && (
        <label>
          Tipo de entrega<select
            value={draft.distributionKind}
            onChange={(event) =>
              update({
                distributionKind: event.target
                  .value as Draft["distributionKind"],
              })}
          >
            <option value="prize-payment">Pagamento do prêmio</option>
            <option value="contribution-refund">
              Devolução da sobra da contribuição
            </option>
          </select>
        </label>
      )}
      {!balance.closed &&
        (correction || ["redemption", "distribution"].includes(draft.kind)) && (
        <label>
          Data do recebimento ou entrega (Brasília)<input
            type="datetime-local"
            step="1"
            value={draft.eventAt}
            onChange={(event) => update({ eventAt: event.target.value })}
          />
        </label>
      )}
      {!balance.closed && !correction && draft.kind === "prize" && (
        <>
          <p className="inline-note">
            Prêmio calculado:{" "}
            {money(balance.calculatedPrizeCents)}. Confira o valor confirmado na
            fonte; divergências precisam ser explicadas.
          </p>
          {manifest.content.plan.participationMode === "official" && (
            <fieldset>
              <legend>Valores de cada recibo de cota oficial</legend>
              {official.length
                ? official.map((item, index) => (
                  <label key={`${item.plannedTicketKey}:${item.quotaId}`}>
                    Recibo {index + 1} · {names(manifest, item.personId)} ·{" "}
                    {item.officialQuotas} cotas (R$)<input
                      inputMode="decimal"
                      value={draft
                        .officialAmounts[
                          `${item.plannedTicketKey}:${item.quotaId}`
                        ] ?? ""}
                      onChange={(event) =>
                        update({
                          officialAmounts: {
                            ...draft.officialAmounts,
                            [`${item.plannedTicketKey}:${item.quotaId}`]:
                              event.target.value,
                          },
                        })}
                    />
                  </label>
                ))
                : (
                  <p className="form-error">
                    Confira os recibos e as cotas oficiais em Registro antes de
                    confirmar o prêmio.
                  </p>
                )}
            </fieldset>
          )}
          <details className="planning-details">
            <summary>Exceção documentada ao prazo de resgate</summary>
            <label>
              Prazo excepcional em Brasília<input
                type="date"
                value={draft.exceptionDate}
                onChange={(event) =>
                  update({ exceptionDate: event.target.value })}
              />
            </label>
            <label>
              Fonte da exceção<input
                value={draft.exceptionSource}
                onChange={(event) =>
                  update({ exceptionSource: event.target.value })}
              />
            </label>
            <label>
              Motivo da exceção<textarea
                rows={2}
                value={draft.exceptionReason}
                onChange={(event) =>
                  update({ exceptionReason: event.target.value })}
              />
            </label>
          </details>
        </>
      )}
      {!balance.closed && !correction && draft.kind === "settle"
        ? (
          <>
            <label>
              Destino identificado da sobra<select
                value={draft.disposition}
                onChange={(event) =>
                  update({
                    disposition: event.target.value as Draft["disposition"],
                  })}
              >
                <option value="pending-refund">
                  Devolução aos participantes ainda pendente
                </option>
                <option value="group-reserve">
                  Reserva identificada no grupo
                </option>
              </select>
            </label>
            <label>
              Explicação das pendências restantes<textarea
                rows={3}
                value={draft.pendingExplanation}
                onChange={(event) =>
                  update({ pendingExplanation: event.target.value })}
                placeholder="Explique prêmios, resgates, devoluções, custos e valores que continuam pendentes."
              />
            </label>
          </>
        )
        : !balance.closed && (
          <>
            <fieldset className="evidence-choices">
              <legend>Comprovantes privados da conferência</legend>
              {evidence.map((file) => (
                <label className="planning-review-checkbox" key={file.id}>
                  <input
                    type="checkbox"
                    checked={draft.evidenceIds.includes(file.id)}
                    onChange={(event) =>
                      update({
                        evidenceIds: event.target.checked
                          ? [...draft.evidenceIds, file.id]
                          : draft.evidenceIds.filter((id) =>
                            id !== file.id
                          ),
                      })}
                  />
                  {file.originalName}
                </label>
              ))}
              <button className="text-button" onClick={goRegistration}>
                Adicionar comprovante em Registro
              </button>
            </fieldset>
            <label>
              Fonte do movimento<input
                value={draft.source}
                onChange={(event) => update({ source: event.target.value })}
              />
            </label>
          </>
        )}
      <label>
        Motivo da conferência<textarea
          rows={2}
          value={draft.reason}
          onChange={(event) => update({ reason: event.target.value })}
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button
        className="button primary"
        disabled={!enabled || !loaded}
        onClick={() => void review()}
      >
        <ShieldCheck size={17} />
        {balance.closed
          ? "Revisar reabertura"
          : "Revisar movimento no servidor"}
      </button>
    </section>
  );
}
