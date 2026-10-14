import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AnimatePresence } from "motion/react";
import {
  computeSettlement,
  createResultView,
  formatBRL,
  formatQuotaUnits,
} from "@bolao/core";
import type {
  LocalRecord,
  PoolManifest,
  PoolSettlement,
  PoolSettlementBalance,
  SettlementPersonBalance,
  SettlementSnapshot,
} from "@bolao/core";
import { getSettlementSnapshot } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import type { Notice, PoolStep } from "../app-shared";
import {
  Button,
  Card,
  Chip,
  diaMes,
  Disclosure,
  Eyebrow,
  formatInstant,
  Money,
  ProblemBox,
} from "../ui";
import { hoje, prazoResgate } from "../ui/texto";
import { DivisaoDecisao } from "./bolao-dividir-decisao";
import type { Intencao, PedidoDivisao } from "./bolao-dividir-decisao";

const latest = <T extends { poolId: string; version: number }>(
  facts: T[],
  poolId: string,
) =>
  facts.filter((fact) => fact.poolId === poolId).sort((a, b) =>
    b.version - a.version
  )[0];
const positive = (cents: string | null) => cents !== null && BigInt(cents) > 0n;
/** O mesmo critério do núcleo: qualquer conta aberta precisa ficar explicada no encerramento. */
const pendente = (balance: PoolSettlementBalance) =>
  balance.expenseConfirmationPending || balance.confirmedPrizeCents === null ||
  balance.resultConflict || balance.registrationIncomplete ||
  [
    balance.cashDeficitCents,
    balance.unredeemedPrizeCents,
    balance.unpaidPrizeCents,
    balance.refundPendingCents,
  ].some((cents) => cents !== null && BigInt(cents) !== 0n);

/** A divisão confirmada do grupo, lida do aparelho; o cálculo nunca vira dinheiro sozinho. */
export function useSettlement(db: BolaoDatabase, groupId: string | null) {
  const scope = `${db.name}:${groupId}`;
  const raw = useLiveQuery(async () => ({
    scope,
    snapshot: groupId ? await getSettlementSnapshot(db, groupId) : null,
  }), [db, groupId]);
  const snapshot = raw?.scope === scope ? raw.snapshot : null;
  const finance = useMemo(() => {
    if (!snapshot) return null;
    try {
      return computeSettlement(snapshot);
    } catch {
      return null;
    }
  }, [snapshot]);
  return { snapshot, finance };
}
export type Settlement = ReturnType<typeof useSettlement>;

/** Houve algum movimento da divisão (custo, prêmio, resgate ou pagamento) neste escopo. */
export function hasSettlementFacts(
  snapshot: SettlementSnapshot | null,
  poolId?: string,
) {
  return !!snapshot &&
    [
      ...snapshot.expenses,
      ...snapshot.prizes,
      ...snapshot.redemptions,
      ...snapshot.distributions,
    ].some((fact) => !poolId || fact.poolId === poolId);
}

/** A conta do caixa em uma linha: contribuições + resgates − custos − pagamentos. */
export function CashFormula(
  { cash, contributed, redeemed, expenses, paid }: {
    cash: string;
    contributed: string;
    redeemed: string;
    expenses: string;
    paid: string;
  },
) {
  return (
    <p className="split-formula">
      Caixa do organizador: <b>{formatBRL(cash)}</b> = contribuições{" "}
      {formatBRL(contributed)} + resgates {formatBRL(redeemed)} − custos{" "}
      {formatBRL(expenses)} − pagamentos {formatBRL(paid)}
    </p>
  );
}

const name = (manifest: PoolManifest | undefined, personId: string) =>
  manifest?.content.persons.find((person) => person.id === personId)?.data
    .name ?? "Participante";
const cotas = (units: number | undefined) =>
  units === undefined
    ? ""
    : `${formatQuotaUnits(units)} ${units < 200 ? "cota" : "cotas"}`;

export function BolaoDividir(
  {
    db,
    groupId,
    pool,
    settlement,
    enabled,
    availability,
    timeZone,
    setNotice,
    go,
    repeat,
  }: {
    db: BolaoDatabase;
    groupId: string;
    pool: LocalRecord<"pool">;
    settlement: Settlement;
    enabled: boolean;
    availability: string;
    timeZone: string;
    setNotice: (notice: Notice) => void;
    go: (step: PoolStep) => void;
    repeat: () => void;
  },
) {
  const { snapshot, finance } = settlement;
  const [request, setRequest] = useState<PedidoDivisao | null>(null);
  const [leftoverChoice, setLeftoverChoice] = useState<
    PoolSettlement["leftoverDisposition"] | null
  >(null);
  const [pendingText, setPendingText] = useState("");
  const balance = finance?.pools[pool.id] ?? null;
  const report = snapshot
    ? latest(snapshot.registration.reports, pool.id)
    : undefined;
  const manifest = snapshot?.registration.manifests.find((item) =>
    item.id === balance?.manifestId
  );
  const result = useMemo(
    () =>
      snapshot
        ? createResultView(snapshot.results).currentResult(pool.id)
        : null,
    [snapshot, pool.id],
  );
  const prize = snapshot ? latest(snapshot.prizes, pool.id) : undefined;
  const expense = snapshot ? latest(snapshot.expenses, pool.id) : undefined;
  const closure = snapshot ? latest(snapshot.closures, pool.id) : undefined;
  const ask = (intent: Intencao) => setRequest({ intent });
  const day = (iso: string) => diaMes(iso, timeZone);

  const redemptions = snapshot?.redemptions.filter((item) =>
    item.poolId === pool.id && item.direction === "received" &&
    !snapshot.redemptions.some((other) => other.reversesId === item.id)
  ) ?? [];
  const payments = snapshot?.distributions.filter((item) =>
    item.poolId === pool.id && item.direction === "paid" &&
    !snapshot.distributions.some((other) => other.reversesId === item.id)
  ) ?? [];
  const lastPayment = (
    personId: string,
    kind: "prize-payment" | "contribution-refund",
  ) =>
    payments.filter((item) => item.personId === personId && item.kind === kind)
      .sort((a, b) => b.version - a.version)[0];
  const units = (personId: string) =>
    manifest?.content.plan.rights.find((right) => right.personId === personId)
      ?.units;

  const goRegistrar = (
    <div className="pool-actions">
      <Button variant="ghost" small onClick={() => go("registrar")}>
        Ir para o Registrar
      </Button>
    </div>
  );

  function prizeCard() {
    if (!balance || !report) {
      return (
        <>
          <h2 className="pool-card-title">Falta conferir o registro</h2>
          <p className="ui-sec">
            O prêmio é confirmado depois que os comprovantes das apostas forem
            conferidos.
          </p>
          {goRegistrar}
        </>
      );
    }
    if (balance.resultConflict) {
      return (
        <>
          <ProblemBox title="Os resultados não batem">
            Escolha no Sorteio qual resultado vale antes de confirmar o prêmio.
          </ProblemBox>
          <Button onClick={() => go("sorteio")}>Ir para o Sorteio</Button>
        </>
      );
    }
    if (!result?.result?.drawnNumbers) {
      return (
        <>
          <h2 className="pool-card-title">Falta o resultado</h2>
          <p className="ui-sec">
            Com os números sorteados, o app calcula o prêmio do grupo.
          </p>
          <Button onClick={() => go("sorteio")}>Ir para o Sorteio</Button>
        </>
      );
    }
    if (prize) {
      const stale = prize.registrationReportId !== report.id ||
        prize.resultId !== result.result.id;
      return (
        <>
          <p className="ui-sec">Prêmio confirmado</p>
          <Money cents={prize.amountCents} prize />
          <p className="split-chips">
            <Chip status="confirmed">Confirmado em {day(prize.confirmedAt)}</Chip>
          </p>
          {stale && (
            <ProblemBox title="O registro ou o resultado mudou">
              Corrija o prêmio para que ele siga os dados atuais.
            </ProblemBox>
          )}
          <div className="pool-actions">
            <Button
              variant={stale ? "primary" : "ghost"}
              small={!stale}
              disabled={!enabled}
              onClick={() => ask({ type: "prize_confirm", poolId: pool.id })}
            >
              Corrigir prêmio
            </Button>
          </div>
        </>
      );
    }
    const calculated = balance.calculatedPrizeCents;
    return (
      <>
        <p className="ui-sec">Prêmio calculado</p>
        {calculated === null
          ? <h2 className="pool-card-title">Valor a confirmar</h2>
          : calculated === "0"
          ? <h2 className="pool-card-title">Sem prêmio neste concurso</h2>
          : <Money cents={calculated} prize />}
        <p className="ui-sec pool-note">
          {calculated === null
            ? "O cálculo não fechou com o registro. Informe o valor do comprovante."
            : "Calculado pelos acertos. Ainda não é dinheiro recebido."}
        </p>
        <Button
          disabled={!enabled}
          onClick={() => ask({ type: "prize_confirm", poolId: pool.id })}
        >
          {calculated === "0" ? "Confirmar sem prêmio" : "Confirmar prêmio"}
        </Button>
      </>
    );
  }

  function costCard() {
    if (!balance || !report) {
      return (
        <>
          <p className="ui-sec pool-empty">
            O custo vem do comprovante conferido no registro.
          </p>
          {goRegistrar}
        </>
      );
    }
    if (expense && !balance.expenseConfirmationPending) {
      return (
        <>
          <h2 className="pool-card-title">
            {formatBRL(expense.totalCostCents)}
          </h2>
          <p className="split-chips">
            <Chip status="confirmed">
              Custo confirmado em {day(expense.confirmedAt)}
            </Chip>
          </p>
          <div className="pool-actions">
            <Button
              variant="ghost"
              small
              disabled={!enabled}
              onClick={() => ask({ type: "expense_confirm", poolId: pool.id })}
            >
              Corrigir custo
            </Button>
          </div>
        </>
      );
    }
    const bet = report.comparison.observedBetCostCents;
    const fee = report.comparison.observedFeeCents;
    const total = bet === null || fee === null
      ? null
      : (BigInt(bet) + BigInt(fee)).toString();
    return (
      <>
        {expense && (
          <ProblemBox title="O registro mudou depois do custo confirmado">
            Confirme o custo de novo com o comprovante atual.
          </ProblemBox>
        )}
        <h2 className="pool-card-title">
          {total === null ? "Valor a informar" : formatBRL(total)}
        </h2>
        <p className="ui-sec">
          {total === null
            ? "O comprovante conferido não mostra o valor completo."
            : `Apostas ${formatBRL(bet!)} + taxa ${
              formatBRL(fee!)
            }, lidos no comprovante.`}
        </p>
        <Button
          disabled={!enabled}
          onClick={() => ask({ type: "expense_confirm", poolId: pool.id })}
        >
          {total === null ? "Informar custo" : `Confirmar custo ${formatBRL(total)}`}
        </Button>
      </>
    );
  }

  function redemptionCard(balance: PoolSettlementBalance) {
    if (!prize) {
      return <p className="ui-sec pool-empty">Depois de confirmar o prêmio.</p>;
    }
    if (prize.amountCents === "0") {
      return <p className="ui-sec pool-empty">Sem prêmio para resgatar.</p>;
    }
    const deadline = prize.redemptionDeadline &&
        positive(balance.unredeemedPrizeCents)
      ? prazoResgate(prize.redemptionDeadline.deadlineDate, hoje())
      : null;
    const deadlineLine = deadline && (deadline.tone === "overdue"
      ? <ProblemBox title={deadline.text} />
      : (
        <p
          className={deadline.tone === "alert"
            ? "split-wait pool-note"
            : "ui-sec pool-note"}
        >
          {deadline.text}
        </p>
      ));
    if (balance.participationMode === "official") {
      const rights = balance.persons.filter((person) =>
        positive(person.prizeRightCents)
      );
      return (
        <>
          <p className="ui-sec">Cada pessoa resgata as próprias cotas.</p>
          <ul className="pool-people">
            {rights.map((person) => {
              const done = person.prizePendingCents === "0";
              const last = redemptions.filter((item) =>
                item.personId === person.personId
              ).sort((a, b) => b.version - a.version)[0];
              return (
                <li className="pool-person" key={person.personId}>
                  <span className="pool-person-name">
                    {name(manifest, person.personId)}
                  </span>
                  <span className="pool-person-due">
                    {formatBRL(person.prizeRightCents!)}
                  </span>
                  <span className="ui-sec pool-person-sub">
                    recebeu {formatBRL(person.prizeReceivedCents)}
                  </span>
                  {done && <Chip status="confirmed">Recebeu</Chip>}
                  <div className="pool-person-state split-row-actions">
                    {!done && (
                      <Button
                        small
                        disabled={!enabled}
                        onClick={() =>
                          ask({
                            type: "redemption_record",
                            poolId: pool.id,
                            personId: person.personId,
                          })}
                      >
                        Recebeu
                      </Button>
                    )}
                    {last && (
                      <Button
                        variant="ghost"
                        small
                        disabled={!enabled}
                        onClick={() =>
                          ask({
                            type: "redemption_reverse",
                            poolId: pool.id,
                            redemptionId: last.id,
                          })}
                      >
                        Desfazer
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {deadlineLine}
        </>
      );
    }
    const holder = manifest?.content.responsible.ticketHolderPersonId ?? null;
    const missing = balance.unredeemedPrizeCents ?? "0";
    return (
      <>
        {!!redemptions.length && (
          <ul className="pool-people">
            {redemptions.map((item) => (
              <li className="pool-person" key={item.id}>
                <span className="pool-person-name">
                  Resgatado {formatBRL(item.amountCents)}
                </span>
                <Button
                  variant="ghost"
                  small
                  disabled={!enabled}
                  onClick={() =>
                    ask({
                      type: "redemption_reverse",
                      poolId: pool.id,
                      redemptionId: item.id,
                    })}
                >
                  Desfazer
                </Button>
                <span className="ui-sec pool-person-sub">
                  {day(item.eventAt)} · por {name(manifest, item.personId)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {positive(missing)
          ? (
            <>
              <h2 className="pool-card-title">
                {redemptions.length ? "Falta resgatar" : "A resgatar"}{" "}
                {formatBRL(missing)}
              </h2>
              <p className="ui-sec">
                {holder
                  ? `Quem resgata: ${name(manifest, holder)}, titular dos bilhetes.`
                  : "O bolão foi travado sem titular dos bilhetes."}
              </p>
              {deadlineLine}
              <Button
                disabled={!enabled || !holder}
                onClick={() =>
                  holder && ask({
                    type: "redemption_record",
                    poolId: pool.id,
                    personId: holder,
                  })}
              >
                {redemptions.length ? "Recebi o restante" : "Recebi o prêmio"}
              </Button>
            </>
          )
          : (
            <p className="split-chips">
              <Chip status="confirmed">Prêmio todo resgatado</Chip>
            </p>
          )}
        <p className="ui-sec">
          {holder
            ? `O prêmio cai no nome de ${name(manifest, holder)} e ${
              name(manifest, holder)
            } repassa a cada pessoa. Imposto e repasse entre pessoas pedem um contador; o app não dá orientação fiscal.`
            : "O prêmio cai no nome de quem resgatar e essa pessoa repassa a cada um. Imposto e repasse entre pessoas pedem um contador; o app não dá orientação fiscal."}
        </p>
      </>
    );
  }

  function personRow(
    person: SettlementPersonBalance,
    kind: "prize-payment" | "contribution-refund",
    canPay: boolean,
    blocked: string | null,
  ) {
    const prizeRow = kind === "prize-payment";
    const right = (prizeRow ? person.prizeRightCents : person.refundRightCents)!;
    const paid = prizeRow ? person.prizeReceivedCents : person.refundedCents;
    const pending = (prizeRow
      ? person.prizePendingCents
      : person.refundPendingCents) ?? "0";
    const last = lastPayment(person.personId, kind);
    const done = !positive(pending);
    return (
      <li className="pool-person" key={`${kind}:${person.personId}`}>
        <span className="pool-person-name">
          {name(manifest, person.personId)}
        </span>
        <span className="pool-person-due">{formatBRL(right)}</span>
        <span className="ui-sec pool-person-sub">
          {[
            prizeRow ? cotas(units(person.personId)) : "",
            `${prizeRow ? "pago" : "devolvido"} ${formatBRL(paid)}`,
            done ? "" : `falta ${formatBRL(pending)}`,
          ].filter(Boolean).join(" · ")}
        </span>
        {done
          ? (
            <Chip status="confirmed">
              {prizeRow ? "Pago" : "Devolvido"}
            </Chip>
          )
          : (
            <Chip status="pending">
              {prizeRow ? "A pagar" : "A devolver"}
            </Chip>
          )}
        {(canPay && !done || last) && (
          <div className="pool-person-state split-row-actions">
            {canPay && !done && (
              <Button
                small
                disabled={!enabled || !!blocked}
                onClick={() =>
                  ask({
                    type: "distribution_record",
                    poolId: pool.id,
                    personId: person.personId,
                    kind,
                  })}
              >
                {prizeRow ? "Já paguei" : "Devolver"}
              </Button>
            )}
            {last && (
              <Button
                variant="ghost"
                small
                disabled={!enabled}
                onClick={() =>
                  ask({
                    type: "distribution_reverse",
                    poolId: pool.id,
                    distributionId: last.id,
                  })}
              >
                Desfazer
              </Button>
            )}
            {canPay && !done && blocked && (
              <span className="ui-sec">{blocked}</span>
            )}
          </div>
        )}
      </li>
    );
  }

  function divisionCard(balance: PoolSettlementBalance) {
    if (!prize) {
      return (
        <p className="ui-sec pool-empty">
          Depois de confirmar o prêmio, a parte de cada pessoa aparece aqui.
        </p>
      );
    }
    const people = balance.persons.filter((person) =>
      positive(person.prizeRightCents) || positive(person.prizeReceivedCents)
    );
    if (!people.length) {
      return <p className="ui-sec pool-empty">Sem prêmio para dividir.</p>;
    }
    const official = balance.participationMode === "official";
    const available = BigInt(balance.organizerRedeemedCents) -
      BigInt(balance.prizePaidCents);
    const blocked = available > 0n
      ? null
      : positive(balance.unredeemedPrizeCents)
      ? "Resgate o prêmio antes de pagar."
      : "Não há dinheiro resgatado disponível.";
    const total = people.reduce(
      (sum, person) => sum + BigInt(person.prizeRightCents ?? "0"),
      0n,
    );
    const paid = people.reduce(
      (sum, person) => sum + BigInt(person.prizeReceivedCents),
      0n,
    );
    return (
      <>
        {official && (
          <p className="ui-sec">
            Cada pessoa recebe direto na CAIXA; o que entra aqui vem do resgate.
          </p>
        )}
        <ul className="pool-people">
          {people.map((person) =>
            personRow(person, "prize-payment", !official, blocked)
          )}
        </ul>
        <dl className="pool-facts split-totals" aria-label="Totais da divisão">
          <div>
            <dt>Total do prêmio</dt>
            <dd>{formatBRL(total.toString())}</dd>
          </div>
          <div>
            <dt>Já pago</dt>
            <dd>{formatBRL(paid.toString())}</dd>
          </div>
          <div>
            <dt>A pagar</dt>
            <dd>{formatBRL((total - paid).toString())}</dd>
          </div>
        </dl>
      </>
    );
  }

  function leftoverCard(balance: PoolSettlementBalance) {
    const formula = (
      <Disclosure summary="Ver conta">
        <CashFormula
          cash={balance.organizerCashCents}
          contributed={balance.contributedCents}
          redeemed={balance.organizerRedeemedCents}
          expenses={balance.confirmedExpenseCents ?? "0"}
          paid={(BigInt(balance.prizePaidCents) +
            BigInt(balance.refundedCents)).toString()}
        />
        {balance.cashDeficitCents !== "0" && (
          <p>
            Faltam {formatBRL(balance.cashDeficitCents)} para fechar a conta.
          </p>
        )}
      </Disclosure>
    );
    if (balance.confirmedExpenseCents === null) {
      return (
        <>
          <p className="ui-sec pool-empty">
            Depois de confirmar o custo das apostas.
          </p>
          {formula}
        </>
      );
    }
    const refunds = balance.persons.filter((person) =>
      positive(person.refundRightCents) || positive(person.refundedCents)
    );
    return (
      <>
        <h2 className="pool-card-title">
          {positive(balance.contributionSurplusCents)
            ? `Sobrou ${formatBRL(balance.contributionSurplusCents!)}`
            : "Não sobrou dinheiro das cotas"}
        </h2>
        <p className="ui-sec">Contribuições menos o custo confirmado.</p>
        {!!refunds.length && (
          <ul className="pool-people">
            {refunds.map((person) =>
              personRow(person, "contribution-refund", true, null)
            )}
          </ul>
        )}
        {formula}
      </>
    );
  }

  function closingCard(balance: PoolSettlementBalance) {
    if (balance.closed && closure) {
      return (
        <>
          <h2 className="pool-card-title">
            Bolão encerrado em {day(closure.confirmedAt)}
          </h2>
          <dl className="pool-facts">
            <div>
              <dt>Sobra das cotas</dt>
              <dd>
                {closure.leftoverDisposition === "group-reserve"
                  ? "Fica no caixa do grupo"
                  : "Volta para as pessoas"}
              </dd>
            </div>
          </dl>
          {closure.pendingExplanation.trim() && (
            <p className="ui-sec">
              Ficou pendente: {closure.pendingExplanation}
            </p>
          )}
          <div className="pool-actions">
            <Button
              variant="ghost"
              small
              disabled={!enabled}
              onClick={() =>
                ask({
                  type: "pool_reopen",
                  poolId: pool.id,
                  closureId: closure.id,
                })}
            >
              Reabrir o bolão
            </Button>
          </div>
        </>
      );
    }
    const leftover = leftoverChoice ??
      (manifest?.content.plan.leftoverPolicy === "refund-pro-rata"
        ? "pending-refund"
        : "group-reserve");
    const missing = pendente(balance) && !pendingText.trim();
    const amount = (cents: string | null) =>
      cents === null ? "a confirmar" : formatBRL(cents);
    return (
      <div className="pool-form">
        <dl className="pool-facts">
          <div>
            <dt>Sobra das cotas</dt>
            <dd>{amount(balance.contributionSurplusCents)}</dd>
          </div>
          <div>
            <dt>Prêmio a pagar</dt>
            <dd>{amount(balance.unpaidPrizeCents)}</dd>
          </div>
          <div>
            <dt>Devoluções pendentes</dt>
            <dd>{amount(balance.refundPendingCents)}</dd>
          </div>
          <div>
            <dt>Prêmio não resgatado</dt>
            <dd>{amount(balance.unredeemedPrizeCents)}</dd>
          </div>
        </dl>
        <fieldset className="pool-fieldset">
          <legend>O que fazer com a sobra</legend>
          <label className="pool-choice">
            <input
              type="radio"
              name={`sobra-${pool.id}`}
              checked={leftover === "group-reserve"}
              onChange={() => setLeftoverChoice("group-reserve")}
            />
            <span>Fica no caixa do grupo</span>
          </label>
          <label className="pool-choice">
            <input
              type="radio"
              name={`sobra-${pool.id}`}
              checked={leftover === "pending-refund"}
              onChange={() => setLeftoverChoice("pending-refund")}
            />
            <span>Devolver às pessoas</span>
          </label>
        </fieldset>
        <label>
          O que fica pendente
          <textarea
            rows={2}
            value={pendingText}
            onChange={(event) => setPendingText(event.target.value)}
          />
        </label>
        {missing && (
          <p className="split-wait">
            Ainda há conta aberta: explique o que fica pendente.
          </p>
        )}
        <Button
          disabled={!enabled || missing}
          onClick={() =>
            ask({
              type: "pool_settle",
              poolId: pool.id,
              leftoverDisposition: leftover,
              pendingExplanation: pendingText.trim(),
            })}
        >
          Encerrar o bolão
        </Button>
      </div>
    );
  }
  const released = !!balance && !!report && !balance.registrationIncomplete &&
    !!result?.result?.drawnNumbers;

  const facts = snapshot
    ? [
      ...snapshot.expenses.map((fact) => ({
        fact,
        label: `Custo ${formatBRL(fact.totalCostCents)}`,
      })),
      ...snapshot.prizes.map((fact) => ({
        fact,
        label: `Prêmio ${formatBRL(fact.amountCents)}`,
      })),
      ...snapshot.redemptions.map((fact) => ({
        fact,
        label: `${fact.direction === "received" ? "Resgate" : "Resgate desfeito"} ${
          formatBRL(fact.amountCents)
        }`,
      })),
      ...snapshot.distributions.map((fact) => ({
        fact,
        label: `${
          fact.direction === "returned"
            ? "Pagamento desfeito"
            : fact.kind === "prize-payment"
            ? "Pagamento"
            : "Devolução"
        } ${formatBRL(fact.amountCents)} · ${name(manifest, fact.personId)}`,
      })),
      ...snapshot.closures.map((fact) => ({
        fact,
        label: fact.direction === "closed" ? "Encerramento" : "Reabertura",
      })),
    ].filter((item) => item.fact.poolId === pool.id).sort((a, b) =>
      b.fact.groupRevision - a.fact.groupRevision
    )
    : [];

  return (
    <>
      <div className="pool-cols">
        <div className="pool-stack">
          <Card className="pool-card" label="Prêmio">
            <Eyebrow>Prêmio</Eyebrow>
            {prizeCard()}
          </Card>
          <Card className="pool-card" label="Custo das apostas">
            <Eyebrow>Custo das apostas</Eyebrow>
            {costCard()}
          </Card>
          <Card className="pool-card" label="Resgate">
            <Eyebrow>Resgate</Eyebrow>
            {balance
              ? redemptionCard(balance)
              : <p className="ui-sec pool-empty">Depois de confirmar o prêmio.</p>}
          </Card>
        </div>
        <div className="pool-stack">
          <Card className="pool-card" label="Como fica a divisão">
            <Eyebrow>Como fica a divisão</Eyebrow>
            {balance
              ? divisionCard(balance)
              : (
                <p className="ui-sec pool-empty">
                  Depois de confirmar o prêmio, a parte de cada pessoa aparece
                  aqui.
                </p>
              )}
          </Card>
          <Card className="pool-card" label="Sobra e devoluções">
            <Eyebrow>Sobra e devoluções</Eyebrow>
            {balance
              ? leftoverCard(balance)
              : (
                <p className="ui-sec pool-empty">
                  Depois de confirmar o custo das apostas.
                </p>
              )}
          </Card>
          {balance && (balance.closed || released) && (
            <Card
              className="pool-card"
              label={balance.closed ? "Encerramento" : "Encerrar o bolão"}
            >
              <Eyebrow>
                {balance.closed ? "Encerramento" : "Encerrar o bolão"}
              </Eyebrow>
              {closingCard(balance)}
            </Card>
          )}
          {!!facts.length && (
            <Disclosure summary="Detalhes técnicos" className="split-tech">
              {facts.map(({ fact, label }) => (
                <p key={fact.id}>
                  {label} · {formatInstant(fact.confirmedAt, timeZone)} · recibo
                  {" "}
                  {fact.receiptId}
                </p>
              ))}
            </Disclosure>
          )}
        </div>
      </div>
      {!enabled && balance && (
        <p className="ui-sec split-later">{availability}</p>
      )}
      <div className="pool-actions split-repeat">
        <Button onClick={repeat}>Repetir com a mesma turma</Button>
      </div>
      {/* Um pedido novo só abre depois que a janela anterior terminou de sair. */}
      <AnimatePresence mode="wait">
        {request && (
          <DivisaoDecisao
            key={"intent" in request ? JSON.stringify(request.intent) : request.idempotencyKey}
            db={db}
            groupId={groupId}
            request={request}
            enabled={enabled}
            availability={availability}
            timeZone={timeZone}
            onClose={() => setRequest(null)}
            onNotice={setNotice}
            goRegistrar={() => {
              setRequest(null);
              go("registrar");
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
