import { lazy, Suspense } from "react";
import { ChevronLeft } from "lucide-react";
import { LOTTERIES } from "@bolao/core";
import type { FinancialView, LocalRecord } from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import type { latestApplied, latestManifest } from "../planning";
import type { PlanningRequest } from "../planning-decision";
import type { RecordRequest } from "../record-decision";
import { POOL_STEPS } from "../app-shared";
import type { FormKind, Notice, PoolStep, Route, Snapshot } from "../app-shared";
import { Card, Chip, Eyebrow, formatWhen, StepStrip } from "../ui";
import { BolaoArrecadar } from "./bolao-arrecadar";
import { STEP_LABEL, usePoolViews } from "./bolao-etapas";
import { BolaoJogar } from "./bolao-jogar";
import { BolaoMontar } from "./bolao-montar";

const BolaoRegistrar = lazy(() =>
  import("./bolao-registrar").then((m) => ({ default: m.BolaoRegistrar }))
);
const BolaoSorteio = lazy(() =>
  import("./bolao-sorteio").then((m) => ({ default: m.BolaoSorteio }))
);

const STEPS = POOL_STEPS.map((key) => ({ key, label: STEP_LABEL[key] }));

export function BolaoScreen(
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
    openForm,
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
    /** `repeat` abre o novo bolão com nome, modalidade e preço deste. */
    openForm: (kind: FormKind, repeat?: boolean) => void;
    setPlanningRequest: (request: PlanningRequest) => void;
    setRecordRequest: (request: RecordRequest) => void;
    setNotice: (notice: Notice) => void;
  },
) {
  const view = usePoolViews({ db, snapshot, financialView, isDemo }).find((
    v,
  ) => v.pool.id === pool.id);
  const current = view?.step ?? "montar";
  const step = route.step ?? current;
  const done = new Set(POOL_STEPS.slice(0, POOL_STEPS.indexOf(current)));
  const go = (next: PoolStep) => route.navigate("boloes", pool.id, next);
  const lottery = LOTTERIES[pool.data.lotteryId].label;

  return (
    <div className="pool">
      <div className="pool-top">
        <button
          type="button"
          className="pool-back"
          onClick={() => route.navigate("boloes")}
        >
          <ChevronLeft aria-hidden="true" />Bolões
        </button>
        {group && <span className="pool-group">{group.data.name}</span>}
      </div>
      <h1 className="ui-title pool-title">{pool.data.title}</h1>
      <p className="pool-meta">
        <Chip modality={pool.data.lotteryId}>
          {view?.drawAt
            ? `${lottery} · ${
              formatWhen(Date.parse(view.drawAt), Date.now(), timeZone)
            }`
            : lottery}
        </Chip>
        <span className="ui-sec">
          {pool.data.contestNumber
            ? `Concurso ${pool.data.contestNumber}`
            : "Concurso a definir"}
        </span>
      </p>
      <StepStrip
        steps={STEPS}
        current={step}
        done={done}
        modality={pool.data.lotteryId}
        onSelect={go}
      />
      <div className="pool-body">
        {step === "montar" && (
          <BolaoMontar
            group={group}
            pool={pool}
            appliedPlan={appliedPlan}
            timeZone={timeZone}
            confirmedCents={confirmedCents}
            expectedCents={expectedCents}
            gamesCost={gamesCost}
            proposedCents={proposedCents}
            openForm={openForm}
          />
        )}
        {step === "arrecadar" && view && (
          <BolaoArrecadar
            snapshot={snapshot}
            view={view}
            openForm={openForm}
            openReview={() => route.navigate("revisao")}
            goPlay={() => go("jogar")}
            setNotice={setNotice}
          />
        )}
        {step === "jogar" && (
          <BolaoJogar
            db={db}
            snapshot={snapshot}
            group={group}
            pool={pool}
            poolBets={poolBets}
            poolQuotas={poolQuotas}
            draftGamesCost={draftGamesCost}
            manifest={manifest}
            appliedPlan={appliedPlan}
            isDemo={isDemo}
            financeEnabled={financeEnabled}
            financeAvailability={financeAvailability}
            openForm={openForm}
            setPlanningRequest={setPlanningRequest}
            setNotice={setNotice}
          />
        )}
        {step === "registrar" && groupId && (
          <Suspense fallback={<p className="ui-sec">Abrindo o registro…</p>}>
            <BolaoRegistrar
              key={`${db.name}:${groupId}:${pool.id}`}
              db={db}
              groupId={groupId}
              pool={pool}
              manifest={manifest}
              enabled={financeEnabled}
              availability={financeAvailability}
              open={setRecordRequest}
              onNotice={setNotice}
              goPlay={() => go("jogar")}
              goDraw={() => go("sorteio")}
            />
          </Suspense>
        )}
        {step === "sorteio" && groupId && (
          <Suspense fallback={<p className="ui-sec">Abrindo o sorteio…</p>}>
            <BolaoSorteio
              key={`${db.name}:${groupId}:${pool.id}`}
              db={db}
              groupId={groupId}
              snapshot={snapshot}
              pool={pool}
              poolBets={poolBets}
              manifest={manifest}
              enabled={financeEnabled}
              availability={financeAvailability}
              timeZone={timeZone}
              open={setRecordRequest}
              setNotice={setNotice}
              go={go}
              repeat={() => openForm("pool", true)}
            />
          </Suspense>
        )}
        {step === "dividir" && (
          <Card className="pool-card" label="Dividir">
            <Eyebrow>Dividir</Eyebrow>
            <p className="pool-soon">A divisão entra na próxima rodada.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
