import type { ReactNode } from "react";
import { Ticket } from "lucide-react";
import type { FinancialView, LocalRecord } from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import { EmptyState, PoolCard } from "../components";
import type { latestApplied, latestManifest } from "../planning";
import type { PlanningRequest } from "../planning-decision";
import type { RecordRequest } from "../record-decision";
import type { FormKind, Notice, Route, Snapshot, Tab } from "../app-shared";
import { BolaoScreen } from "./bolao";

export function BoloesScreen(
  {
    db,
    snapshot,
    group,
    groupId,
    pool,
    poolBets,
    poolQuotas,
    payments,
    financialView,
    manifest,
    registration,
    appliedPlan,
    tab,
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
    setTab,
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
    payments: Snapshot["confirmed"];
    financialView: FinancialView | null;
    manifest: ReturnType<typeof latestManifest>;
    registration: Snapshot["registrations"][number] | undefined;
    appliedPlan: ReturnType<typeof latestApplied>;
    tab: Tab;
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
    setTab: (tab: Tab) => void;
    setPlanningRequest: (request: PlanningRequest) => void;
    setRecordRequest: (request: RecordRequest) => void;
    setNotice: (notice: Notice) => void;
  },
) {
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">SORTE EM GRUPO</span>
          <h1>
            {route.poolId && pool ? pool.data.title : "Nossos bolões"}
          </h1>
          <p>
            {route.poolId
              ? "Da primeira ideia ao último detalhe."
              : "Organize cada concurso, sem misturar o caixa dos grupos."}
          </p>
        </div>
        {primaryAction}
      </div>
      {!route.poolId
        ? (
          <div className="pool-grid">
            {snapshot.pools.map((p) => (
              <PoolCard
                key={p.id}
                pool={p}
                bets={snapshot.bets.filter((b) => b.data.poolId === p.id)}
                onClick={() => {
                  setTab("resumo");
                  route.navigate("boloes", p.id);
                }}
              />
            ))}
            {!snapshot.pools.length && (
              <EmptyState
                icon={<Ticket size={30} />}
                title="O primeiro bolão da turma"
                description="Escolha Mega-Sena, Lotofácil ou Quina e comece a preparar."
                action={primaryAction}
              />
            )}
          </div>
        )
        : pool
        ? (
          <BolaoScreen
            db={db}
            snapshot={snapshot}
            group={group}
            groupId={groupId}
            pool={pool}
            poolBets={poolBets}
            poolQuotas={poolQuotas}
            payments={payments}
            financialView={financialView}
            manifest={manifest}
            registration={registration}
            appliedPlan={appliedPlan}
            tab={tab}
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
            setTab={setTab}
            setPlanningRequest={setPlanningRequest}
            setRecordRequest={setRecordRequest}
            setNotice={setNotice}
          />
        )
        : (
          <EmptyState
            icon={<Ticket size={30} />}
            title="Bolão não encontrado neste aparelho"
            description="Sincronize sua conta ou volte à lista de bolões."
            action={
              <button
                className="button primary"
                onClick={() => route.navigate("boloes")}
              >
                Ver bolões
              </button>
            }
          />
        )}
    </>
  );
}
