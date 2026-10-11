import { lazy, Suspense } from "react";
import { ArrowUpRight } from "lucide-react";
import type { FinancialView, LocalRecord } from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import { LotteryBadge, StateBadge } from "../components";
import { Planner } from "../planning";
import type { latestApplied, latestManifest } from "../planning";
import type { PlanningRequest } from "../planning-decision";
import type { RecordRequest } from "../record-decision";
import type { FormKind, Notice, Route, Snapshot, Tab } from "../app-shared";
import { BolaoJogos } from "./bolao-jogos";
import { BolaoPessoas } from "./bolao-pessoas";
import { BolaoResumo } from "./bolao-resumo";

const Registration = lazy(() => import("../registration"));
const Results = lazy(() => import("../results"));

export function BolaoScreen(
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
    pool: LocalRecord<"pool">;
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
    openForm: (kind: FormKind) => void;
    setTab: (tab: Tab) => void;
    setPlanningRequest: (request: PlanningRequest) => void;
    setRecordRequest: (request: RecordRequest) => void;
    setNotice: (notice: Notice) => void;
  },
) {
  return (
    <>
      <div className="pool-toolbar">
        <LotteryBadge lotteryId={pool.data.lotteryId} />
        <span>
          {pool.data.contestNumber
            ? `Concurso ${pool.data.contestNumber}`
            : "Concurso a definir"}
        </span>
        <StateBadge state={pool.state} />
        {manifest && (
          <span className="simple-pill green">
            Travado · versão {manifest.version}
          </span>
        )}
        {registration && (
          <span
            className={`simple-pill ${
              registration.comparison.status ===
                  "complete"
                ? "green"
                : "amber"
            }`}
          >
            {registration.comparison.status === "complete"
              ? "Registro conferido"
              : registration.comparison.status ===
                  "partial"
              ? "Registro parcial"
              : "Registro com divergências"}
          </span>
        )}
        <button
          className="text-link back-link"
          onClick={() => route.navigate("boloes")}
        >
          Todos os bolões <ArrowUpRight size={15} />
        </button>
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label="Seções do bolão"
      >
        {([
          "resumo",
          "pessoas",
          "jogos",
          "planejar",
          "registro",
          "resultado",
        ] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {({
              resumo: "Resumo",
              pessoas: "Pessoas e cotas",
              jogos: "Jogos",
              planejar: "Planejador",
              registro: "Registro",
              resultado: "Resultado",
            })[t]}
          </button>
        ))}
      </div>
      {tab === "resumo" && (
        <BolaoResumo
          snapshot={snapshot}
          group={group}
          pool={pool}
          poolBets={poolBets}
          poolQuotas={poolQuotas}
          manifest={manifest}
          appliedPlan={appliedPlan}
          confirmedCents={confirmedCents}
          expectedCents={expectedCents}
          gamesCost={gamesCost}
          proposedCents={proposedCents}
          openForm={openForm}
          setTab={setTab}
        />
      )}
      {tab === "pessoas" && (
        <BolaoPessoas
          snapshot={snapshot}
          pool={pool}
          poolQuotas={poolQuotas}
          payments={payments}
          financialView={financialView}
          isDemo={isDemo}
          openForm={openForm}
        />
      )}
      {tab === "jogos" && (
        <BolaoJogos
          snapshot={snapshot}
          pool={pool}
          poolBets={poolBets}
          draftGamesCost={draftGamesCost}
          manifest={manifest}
          appliedPlan={appliedPlan}
          openForm={openForm}
        />
      )}
      {tab === "planejar" && group && (
        <Planner
          key={`${db.name}:${group.id}:${pool.id}`}
          db={db}
          group={group}
          pool={pool}
          bets={poolBets}
          quotas={poolQuotas}
          finances={snapshot.finances}
          demoPayments={snapshot.confirmed}
          isDemo={isDemo}
          enabled={financeEnabled}
          availability={financeAvailability}
          open={setPlanningRequest}
          editPool={() => openForm("edit-pool")}
          onNotice={setNotice}
        />
      )}
      {tab === "registro" && groupId && (
        <Suspense
          fallback={
            <p className="inline-note">
              Carregando conferência do registro…
            </p>
          }
        >
          <Registration
            key={`${db.name}:${groupId}:${pool.id}`}
            db={db}
            groupId={groupId}
            pool={pool}
            manifest={manifest}
            enabled={financeEnabled}
            availability={financeAvailability}
            open={setRecordRequest}
            onNotice={setNotice}
            goPlanning={() => setTab("planejar")}
          />
        </Suspense>
      )}
      {tab === "resultado" && groupId && (
        <Suspense
          fallback={
            <p className="inline-note">
              Carregando conferência do resultado…
            </p>
          }
        >
          <Results
            key={`${db.name}:${groupId}:${pool.id}`}
            db={db}
            groupId={groupId}
            pool={pool}
            enabled={financeEnabled}
            availability={financeAvailability}
            timeZone={timeZone}
            open={setRecordRequest}
          />
        </Suspense>
      )}
    </>
  );
}
