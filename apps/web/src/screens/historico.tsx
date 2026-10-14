import { formatBRL, LOTTERIES, sumCents } from "@bolao/core";
import type { FinancialView, LocalRecord } from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import { FinancialCash } from "../finance";
import { formatDate } from "../app-shared";
import type { Snapshot } from "../app-shared";
import { Card, Chip, Disclosure, Eyebrow, Money, PageHead } from "../ui";
import {
  CashFormula,
  hasSettlementFacts,
  useSettlement,
} from "./bolao-dividir";
import { STEP_LABEL, usePoolViews } from "./bolao-etapas";
import { poolSituation } from "./boloes";

const MOVEMENT = {
  "payment-received": "Pagamento recebido",
  "payment-allocated": "Destinado ao bolão",
  "payment-reversed": "Estorno do recebimento",
  "allocation-reversed": "Estorno da destinação",
};

interface Row {
  id: string;
  name: string;
  pool: string;
  cents: string;
  at: string;
  kind?: string;
  reason?: string;
}

/** Recebimentos em linhas (nome, bolão, valor, data); passando de 8, ficam guardados em "Ver recebimentos". */
function Rows({ rows }: { rows: Row[] }) {
  const list = (
    <ul className="pool-people">
      {rows.map((row) => (
        <li className="pool-person" key={row.id}>
          <span className="pool-person-name">{row.name}</span>
          <span
            className={`pool-person-due ${
              BigInt(row.cents) < 0n ? "history-out" : ""
            }`}
          >
            {formatBRL(row.cents)}
          </span>
          <span className="ui-sec pool-person-sub">
            {row.kind && <span>{row.kind} · </span>}
            {row.pool} · {formatDate(row.at)}
            {row.reason && <span className="history-reason">{row.reason}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
  return rows.length > 8
    ? <Disclosure summary={`Ver recebimentos (${rows.length})`}>{list}</Disclosure>
    : list;
}

export function HistoricoScreen(
  {
    db,
    groupId,
    snapshot,
    group,
    financialView,
    isDemo,
  }: {
    db: BolaoDatabase;
    groupId: string | null;
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    financialView: FinancialView | null;
    isDemo: boolean;
  },
) {
  const settlement = useSettlement(db, groupId);
  const views = usePoolViews({ db, snapshot, financialView, isDemo });
  const cash = hasSettlementFacts(settlement.snapshot)
    ? settlement.finance
    : null;
  const personName = (id: string | null) =>
    snapshot.persons.find((p) => p.id === id)?.data.name ?? "Pessoa do grupo";
  const poolName = (id: string | null) =>
    snapshot.pools.find((p) => p.id === id)?.data.title ?? "Caixa do grupo";
  const finances = snapshot.finances;
  const rows: Row[] = isDemo
    ? snapshot.confirmed.map((p) => ({
      id: p.id,
      name: personName(p.personId),
      pool: poolName(p.poolId),
      cents: p.amountCents,
      at: p.confirmedAt,
    }))
    : [...finances?.movements ?? []].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    ).map((m) => ({
      id: m.id,
      name: personName(m.personId),
      pool: poolName(m.poolId),
      cents: m.amountCents,
      at: m.createdAt,
      kind: MOVEMENT[m.kind],
      reason: m.reason || undefined,
    }));

  return (
    <>
      <PageHead
        eyebrow="Histórico da turma"
        title={group?.data.name ?? "Sua turma"}
        line="Só o que já foi conferido. Estimativas ficam de fora."
      />
      <div className="history">
        <div className="history-col">
          {isDemo
            ? (
              <Card className="finance-card" label="Caixa do grupo">
                <Eyebrow>Caixa do grupo</Eyebrow>
                <dl className="finance-totals">
                  <div>
                    <dt>Recebido</dt>
                    <dd>
                      {formatBRL(
                        sumCents(snapshot.confirmed.map((p) => p.amountCents)),
                      )}
                    </dd>
                  </div>
                </dl>
              </Card>
            )
            : <FinancialCash snapshot={finances} />}
          {cash && (
            <Card className="finance-card" label="Caixa conciliado">
              <Eyebrow>Caixa conciliado</Eyebrow>
              <Money cents={cash.organizerCashCents} />
              <Disclosure summary="Ver conta">
                <CashFormula
                  cash={cash.organizerCashCents}
                  contributed={cash.contributionCashCents}
                  redeemed={cash.organizerRedeemedCents}
                  expenses={cash.confirmedExpenseCents}
                  paid={(BigInt(cash.prizePaidCents) +
                    BigInt(cash.refundedCents)).toString()}
                />
              </Disclosure>
            </Card>
          )}
          <Card className="finance-card" label="Recebimentos">
            <Eyebrow>Recebimentos</Eyebrow>
            {rows.length
              ? <Rows rows={rows} />
              : (
                <p className="ui-sec">
                  O histórico começa com o primeiro pagamento conferido. Os
                  pagamentos anotados esperam na Revisão.
                </p>
              )}
            {finances?.revocations.map((revocation) => {
              const quota = finances.quotas.find((q) =>
                q.id === revocation.quotaId
              );
              return (
                <p className="ui-sec history-reason" key={revocation.id}>
                  A cota de {personName(quota?.personId ?? null)} em{" "}
                  {poolName(quota?.poolId ?? null)} foi cancelada em{" "}
                  {formatDate(revocation.revokedAt)}: {revocation.reason}
                </p>
              );
            })}
          </Card>
        </div>
        <div className="history-col">
          {views.map((view) => {
            const balance = settlement.finance?.pools[view.pool.id];
            const { closed, prizeDue } = poolSituation(view, balance);
            const lines: [string, string | null | undefined][] = [
              ["Arrecadado", view.collectedCents],
              ["Custo das apostas", balance?.confirmedExpenseCents],
              ["Prêmio confirmado", balance?.confirmedPrizeCents],
              [
                "Prêmio pago",
                balance?.confirmedPrizeCents ? balance.prizePaidCents : null,
              ],
              [
                "Caixa conciliado",
                hasSettlementFacts(settlement.snapshot, view.pool.id)
                  ? balance?.organizerCashCents
                  : null,
              ],
            ];
            return (
              <Card
                className="finance-card"
                key={view.pool.id}
                label={view.pool.data.title}
              >
                <div className="history-pool-head">
                  <b>{view.pool.data.title}</b>
                  <span className="home-pool-chips">
                    <Chip modality={view.pool.data.lotteryId}>
                      {LOTTERIES[view.pool.data.lotteryId].label}
                    </Chip>
                    {closed
                      ? <Chip status="confirmed">Encerrado</Chip>
                      : prizeDue
                      ? <Chip status="pending">Prêmio a pagar</Chip>
                      : view.step === "dividir"
                      ? <Chip status="confirmed">Sorteado</Chip>
                      : (
                        <Chip modality={view.pool.data.lotteryId} step>
                          {STEP_LABEL[view.step]}
                        </Chip>
                      )}
                  </span>
                </div>
                <dl className="history-lines">
                  {lines.filter(([, cents]) => cents != null).map((
                    [label, cents],
                  ) => (
                    <div
                      key={label}
                      className={label === "Caixa conciliado"
                        ? "history-line-total"
                        : undefined}
                    >
                      <dt>{label}</dt>
                      <dd>{formatBRL(cents!)}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            );
          })}
        </div>
      </div>
    </>
  );
}
