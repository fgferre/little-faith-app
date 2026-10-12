import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { formatBRL, LOTTERIES } from "@bolao/core";
import type {
  FinancialView,
  LocalRecord,
  PoolSettlementBalance,
} from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import type { latestApplied, latestManifest } from "../planning";
import type { PlanningRequest } from "../planning-decision";
import type { RecordRequest } from "../record-decision";
import type { FormKind, Notice, Route, Snapshot } from "../app-shared";
import { Button, Card, Chip, formatWhen, PageHead } from "../ui";
import { BolaoScreen } from "./bolao";
import { useSettlement } from "./bolao-dividir";
import { STEP_LABEL, usePoolViews } from "./bolao-etapas";
import type { PoolView } from "./bolao-etapas";

/**
 * Encerrado = fechado na divisão, ou sorteado sem nada a pagar: ninguém deve cota e não há prêmio
 * nem devolução esperando pagamento. A mesma regra na lista de bolões e no Histórico.
 */
export function poolSituation(
  view: PoolView,
  balance: PoolSettlementBalance | undefined,
) {
  const due = (cents: string | null | undefined) =>
    !!cents && BigInt(cents) > 0n;
  const prizeDue = due(balance?.unpaidPrizeCents) ||
    due(balance?.refundPendingCents);
  const closed = view.pool.data.status === "settled" || !!balance?.closed;
  return {
    closed,
    prizeDue,
    ended: closed ||
      (view.step === "dividir" && !view.owing.length && !prizeDue),
  };
}

/** O cartão de um bolão, igual ao do Início: nome, linha, modalidade, etapa e a seta. */
function PoolRow(
  { view, ended, timeZone, onClick }: {
    view: PoolView;
    ended: boolean;
    timeZone: string;
    onClick: () => void;
  },
) {
  const now = Date.now();
  const { pool } = view;
  const when = view.drawAt
    ? formatWhen(Date.parse(view.drawAt), now, timeZone)
    : pool.data.deadlineAt &&
        (view.step === "montar" || view.step === "arrecadar")
    ? `pagar até ${formatWhen(Date.parse(pool.data.deadlineAt), now, timeZone)}`
    : null;
  return (
    <Card className="home-pool" onClick={onClick}>
      <span className="home-pool-main">
        <b>{pool.data.title}</b>
        <span className="ui-sec">
          {view.hasQuotas
            ? (
              <>
                <span className="ui-nb">{formatBRL(view.collectedCents)}</span>
                {view.expectedCents !== null && (
                  <>
                    {" de "}
                    <span className="ui-nb">
                      {formatBRL(view.expectedCents)}
                    </span>
                  </>
                )}
              </>
            )
            : "Nenhuma cota ainda"}
          {when && <>{" · "}{when}</>}
        </span>
        <span className="home-pool-chips">
          <Chip modality={pool.data.lotteryId}>
            {LOTTERIES[pool.data.lotteryId].label}
          </Chip>
          {ended
            ? <Chip status="confirmed">Encerrado</Chip>
            : (
              <Chip modality={pool.data.lotteryId} step>
                {STEP_LABEL[view.step]}
              </Chip>
            )}
        </span>
      </span>
      <ChevronRight aria-hidden="true" />
    </Card>
  );
}

function BoloesList(
  { db, snapshot, groupId, financialView, route, isDemo, timeZone, action }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    groupId: string | null;
    financialView: FinancialView | null;
    route: Route;
    isDemo: boolean;
    timeZone: string;
    action: ReactNode;
  },
) {
  const views = usePoolViews({ db, snapshot, financialView, isDemo });
  const settlement = useSettlement(db, groupId);
  const rows = views.map((view) => ({
    view,
    ended: poolSituation(view, settlement.finance?.pools[view.pool.id]).ended,
  }));
  const group = (title: string, list: typeof rows) =>
    list.length > 0 && (
      <section className="boloes-group" aria-label={title}>
        <h2 className="ui-eyebrow">{title}</h2>
        <div className="boloes-list">
          {list.map(({ view, ended }) => (
            <PoolRow
              key={view.pool.id}
              view={view}
              ended={ended}
              timeZone={timeZone}
              onClick={() => route.navigate("boloes", view.pool.id)}
            />
          ))}
        </div>
      </section>
    );
  return (
    <>
      <PageHead
        eyebrow="Sorte em grupo"
        title="Nossos bolões"
        line="Cada concurso no seu lugar, sem misturar o caixa dos grupos."
        action={views.length > 0 && action}
      />
      {views.length
        ? (
          <>
            {group("Em andamento", rows.filter((row) => !row.ended))}
            {group("Encerrados", rows.filter((row) => row.ended))}
          </>
        )
        : (
          <Card className="boloes-empty">
            <h2 className="ui-title">O primeiro bolão da turma</h2>
            <p className="ui-sec">
              Escolha Mega-Sena, Lotofácil ou Quina e comece a preparar.
            </p>
            {action}
          </Card>
        )}
    </>
  );
}

export function BoloesScreen(
  {
    db,
    snapshot,
    group,
    groupId,
    pool,
    poolBets,
    poolQuotas,
    financialView,
    manifest,
    appliedPlan,
    route,
    isDemo,
    financeEnabled,
    financeAvailability,
    timeZone,
    confirmedCents,
    expectedCents,
    gamesCost,
    draftGamesCost,
    proposedCents,
    primaryAction,
    openForm,
    setPlanningRequest,
    setRecordRequest,
    setNotice,
  }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    groupId: string | null;
    pool: LocalRecord<"pool"> | undefined;
    poolBets: LocalRecord<"bet">[];
    poolQuotas: LocalRecord<"quota">[];
    financialView: FinancialView | null;
    manifest: ReturnType<typeof latestManifest>;
    appliedPlan: ReturnType<typeof latestApplied>;
    route: Route;
    isDemo: boolean;
    financeEnabled: boolean;
    financeAvailability: string;
    timeZone: string;
    confirmedCents: string;
    expectedCents: string | null;
    gamesCost: string;
    draftGamesCost: string;
    proposedCents: string;
    primaryAction: ReactNode;
    openForm: (kind: FormKind) => void;
    setPlanningRequest: (request: PlanningRequest) => void;
    setRecordRequest: (request: RecordRequest) => void;
    setNotice: (notice: Notice) => void;
  },
) {
  if (!route.poolId) {
    return (
      <BoloesList
        db={db}
        snapshot={snapshot}
        groupId={groupId}
        financialView={financialView}
        route={route}
        isDemo={isDemo}
        timeZone={timeZone}
        action={primaryAction}
      />
    );
  }
  return pool
    ? (
      <BolaoScreen
        db={db}
        snapshot={snapshot}
        group={group}
        groupId={groupId}
        pool={pool}
        poolBets={poolBets}
        poolQuotas={poolQuotas}
        financialView={financialView}
        manifest={manifest}
        appliedPlan={appliedPlan}
        route={route}
        isDemo={isDemo}
        financeEnabled={financeEnabled}
        financeAvailability={financeAvailability}
        timeZone={timeZone}
        confirmedCents={confirmedCents}
        expectedCents={expectedCents}
        gamesCost={gamesCost}
        draftGamesCost={draftGamesCost}
        proposedCents={proposedCents}
        openForm={openForm}
        setPlanningRequest={setPlanningRequest}
        setRecordRequest={setRecordRequest}
        setNotice={setNotice}
      />
    )
    : (
      <Card className="boloes-empty">
        <h2 className="ui-title">Bolão não encontrado neste aparelho</h2>
        <p className="ui-sec">
          Sincronize sua conta ou volte à lista de bolões.
        </p>
        <Button small onClick={() => route.navigate("boloes")}>
          Ver bolões
        </Button>
      </Card>
    );
}
