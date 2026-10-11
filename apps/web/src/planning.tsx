import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Download,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  formatBRL,
  LOTTERIES,
  parseBRL,
  sumCents,
  verifyManifest,
} from "@bolao/core";
import type {
  AppliedPlan,
  ConfirmedPayment,
  ExactPortfolioProbability,
  FinancialSnapshot,
  LeftoverPolicy,
  LocalRecord,
  PlanningSnapshot,
  PlanStrategy,
  PlanSuggestionResult,
  PoolManifest,
  PreparedPlan,
  SimulationCheckpoint,
  SimulationResult,
  SuggestPlansInput,
} from "@bolao/core";
import {
  createPlanningAnalysis,
  getPlanningSnapshot,
  listPlanningAnalyses,
  pausePlanningAnalysis,
  refinePlanningAnalysis,
  resumePlanningAnalysis,
  saveAnalysisProgress,
  savePlanningCandidates,
} from "@bolao/local";
import type { BolaoDatabase, PersistentPlanningAnalysis } from "@bolao/local";
import { createSeed } from "./generation";
import { demoPlanningFinancial, planningRights } from "./planning-preview";
import { Numbers, SectionTitle } from "./components";
import type { PlanningRequest } from "./planning-decision";

const strategies: Record<PlanStrategy, string> = {
  spread: "Espalhada",
  balanced: "Equilibrada",
  concentrated: "Concentrada",
};
const leftoverLabels: Record<LeftoverPolicy, string> = {
  unassigned: "Definir depois",
  "refund-pro-rata": "Devolução proporcional pendente",
  "group-credit": "Reserva identificada no grupo",
};
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível concluir o planejamento.";
const percent = (value: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "percent",
    maximumSignificantDigits: 4,
  }).format(value);
const date = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" })
    .format(new Date(value));

export function latestApplied(
  snapshot: PlanningSnapshot | null | undefined,
  poolId: string,
) {
  return snapshot?.appliedPlans.filter((plan) => plan.poolId === poolId).sort((
    a,
    b,
  ) => b.version - a.version)[0] ?? null;
}
export function latestManifest(
  snapshot: PlanningSnapshot | null | undefined,
  poolId: string,
) {
  return snapshot?.manifests.filter((manifest) => manifest.poolId === poolId)
    .sort((a, b) => b.version - a.version)[0] ?? null;
}

interface Selection {
  ids: string[];
  selectedId: string;
  unavailable: PlanSuggestionResult["unavailable"];
}
interface SuggestionMessage {
  type: "suggestion";
  result: PlanSuggestionResult;
  coverage: { candidateId: string; result: ExactPortfolioProbability }[];
}
interface ProgressMessage {
  type: "progress";
  checkpoint: SimulationCheckpoint;
  result: SimulationResult;
}
interface ErrorMessage {
  type: "error";
  message: string;
}
const newWorker = () =>
  new Worker(new URL("./planning.worker.ts", import.meta.url), {
    type: "module",
  });

export function Planner(
  {
    db,
    group,
    pool,
    bets,
    quotas,
    finances,
    demoPayments,
    isDemo,
    enabled,
    availability,
    open,
    editPool,
    onNotice,
  }: {
    db: BolaoDatabase;
    group: LocalRecord<"group">;
    pool: LocalRecord<"pool">;
    bets: LocalRecord<"bet">[];
    quotas: LocalRecord<"quota">[];
    finances: FinancialSnapshot | null;
    demoPayments: ConfirmedPayment[];
    isDemo: boolean;
    enabled: boolean;
    availability: string;
    open: (request: PlanningRequest) => void;
    editPool: () => void;
    onNotice: (notice: { text: string; error?: boolean }) => void;
  },
) {
  const selectionKey = `planning-selection:${pool.id}`;
  const scope = `${db.name}:${group.id}:${pool.id}`;
  const [fee, setFee] = useState("0,00");
  const [feeLabel, setFeeLabel] = useState("");
  const [leftoverPolicy, setLeftoverPolicy] = useState<LeftoverPolicy>(
    "unassigned",
  );
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const activeWorker = useRef<Worker | null>(null);
  const activeAnalysis = useRef<{ id: string; progressVersion: number } | null>(
    null,
  );
  const operationStarting = useRef(false);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const raw = useLiveQuery(async () => {
    const meta = (await db.metadata.get(selectionKey))?.value as
      | Selection
      | undefined;
    const candidates = meta
      ? await db.planningCandidates.bulkGet(meta.ids)
      : [];
    const selected = meta?.selectedId ?? candidates[0]?.id;
    const coverage = selected
      ? (await db.metadata.get(`planning-coverage:${selected}`))?.value as
        | ExactPortfolioProbability
        | undefined
      : undefined;
    const [analyses, planning, reports] = await Promise.all([
      listPlanningAnalyses(db, group.id, pool.id),
      getPlanningSnapshot(db, group.id),
      db.registrationReports.where("groupId").equals(group.id).toArray(),
    ]);
    return {
      scope,
      meta,
      candidates: candidates.filter((candidate) =>
        !!candidate && candidate.groupId === group.id &&
        candidate.poolId === pool.id
      ),
      coverage,
      analyses,
      planning,
      reports: reports.filter((report) => report.poolId === pool.id),
    };
  }, [db, group.id, pool.id]);
  const local = raw?.scope === scope ? raw : undefined;
  const selected =
    local?.candidates.find((candidate) =>
      candidate?.id === local.meta?.selectedId
    )?.candidate ?? local?.candidates[0]?.candidate;
  const analysis = local?.analyses.filter((item) =>
    item.candidateId === selected?.id
  ).sort((a, b) =>
    b.input.targetSamples - a.input.targetSamples ||
    b.createdAt.localeCompare(a.createdAt)
  )[0];
  const report = local?.reports.sort((a, b) => b.version - a.version)[0];
  const manifest = report
    ? local?.planning?.manifests.find((item) =>
      item.id === report.manifestId
    ) ?? null
    : latestManifest(local?.planning, pool.id);
  const applied = report
    ? local?.planning?.appliedPlans.find((item) =>
      item.id === manifest?.appliedPlanId
    ) ?? null
    : latestApplied(local?.planning, pool.id);
  const registered = !!report ||
    ["registered", "settled"].includes(pool.data.status);
  const calculationFinance = isDemo
    ? demoPlanningFinancial(group, pool, quotas, demoPayments)
    : finances;
  const rights = calculationFinance
    ? planningRights(calculationFinance, pool.id)
    : [];
  const budget = sumCents(rights.map((right) => right.dueCents));
  const setupMissing = !isDemo &&
    (!pool.data.contestNumber || pool.data.participationMode === "undecided");
  const busy = generating || starting || !!runningId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeWorker.current?.terminate();
      activeWorker.current = null;
      const owned = activeAnalysis.current;
      activeAnalysis.current = null;
      if (owned) {
        void saves.current.then(() =>
          pausePlanningAnalysis(db, owned.id, owned.progressVersion)
        ).catch(() => undefined);
      }
    };
  }, [db]);

  async function generate() {
    if (!calculationFinance || busy || operationStarting.current) return;
    operationStarting.current = true;
    setError(null);
    setGenerating(true);
    const worker = newWorker();
    activeWorker.current = worker;
    try {
      const input: SuggestPlansInput = {
        groupId: group.id,
        groupRevision: calculationFinance.groupRevision,
        pool: isDemo
          ? {
            ...pool,
            serverVersion: 1,
            state: "synced",
            data: {
              ...pool.data,
              contestNumber: pool.data.contestNumber ?? 1,
              participationMode: "internal",
            },
          }
          : pool,
        sourceBets: isDemo
          ? bets.map((bet) => ({ ...bet, serverVersion: 1, state: "synced" }))
          : bets,
        financial: calculationFinance,
        seed: createSeed(),
        feeCents: parseBRL(fee),
        feeLabel: feeLabel.trim(),
        leftoverPolicy,
      };
      const result = await new Promise<SuggestionMessage>((resolve, reject) => {
        worker.onmessage = (
          event: MessageEvent<SuggestionMessage | ErrorMessage>,
        ) =>
          event.data.type === "error"
            ? reject(new Error(event.data.message))
            : resolve(event.data);
        worker.onerror = () =>
          reject(
            new Error("Não foi possível iniciar o planejador neste aparelho."),
          );
        worker.postMessage({ type: "suggest", input });
      });
      if (!mounted.current || activeWorker.current !== worker) return;
      await db.transaction(
        "rw",
        db.planningCandidates,
        db.metadata,
        async () => {
          await savePlanningCandidates(db, {
            groupId: group.id,
            poolId: pool.id,
            candidates: result.result.plans,
          });
          for (const item of result.coverage) {
            await db.metadata.put({
              key: `planning-coverage:${item.candidateId}`,
              value: item.result,
            });
          }
          await db.metadata.put({
            key: selectionKey,
            value: {
              ids: result.result.plans.map((plan) => plan.id),
              selectedId: result.result.plans[0]?.id ?? "",
              unavailable: result.result.unavailable,
            } satisfies Selection,
          });
        },
      );
      if (mounted.current) {
        onNotice({
          text:
            `${result.result.plans.length} alternativa(s) salva(s) neste aparelho para comparar.`,
        });
      }
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      operationStarting.current = false;
      worker.terminate();
      if (activeWorker.current === worker) activeWorker.current = null;
      if (mounted.current) setGenerating(false);
    }
  }

  async function startSimulation(
    previous?: PersistentPlanningAnalysis,
    refine = false,
  ) {
    if (!selected || busy || operationStarting.current) return;
    operationStarting.current = true;
    setStarting(true);
    setError(null);
    let owned: { id: string; progressVersion: number } | null = null;
    try {
      let progress = refine && previous
        ? await refinePlanningAnalysis(db, previous.id, 1_000_000)
        : previous ?? await createPlanningAnalysis(db, {
          groupId: group.id,
          poolId: pool.id,
          candidateId: selected.id,
          input: {
            lotteryId: selected.lotteryId,
            bets: selected.bets.map((bet) => bet.numbers),
            seed: createSeed(),
            targetSamples: 200_000,
          },
        });
      progress = await resumePlanningAnalysis(db, progress.id);
      if (!mounted.current) {
        await pausePlanningAnalysis(db, progress.id, progress.progressVersion);
        return;
      }
      owned = { id: progress.id, progressVersion: progress.progressVersion };
      const ownership = owned;
      setRunningId(progress.id);
      activeAnalysis.current = ownership;
      const worker = newWorker();
      activeWorker.current = worker;
      const fail = (failure: unknown) => {
        worker.terminate();
        if (activeWorker.current !== worker) return;
        activeWorker.current = null;
        activeAnalysis.current = null;
        void pausePlanningAnalysis(db, ownership.id, ownership.progressVersion)
          .catch(() => undefined);
        if (mounted.current) {
          setError(errorMessage(failure));
          setRunningId(null);
        }
      };
      worker.onerror = () =>
        fail(
          new Error(
            "O cálculo foi interrompido. As amostras já salvas podem ser retomadas.",
          ),
        );
      worker.onmessage = (
        event: MessageEvent<ProgressMessage | ErrorMessage>,
      ) => {
        if (event.data.type === "error") {
          fail(new Error(event.data.message));
          return;
        }
        const update = event.data;
        saves.current = saves.current.then(async () => {
          if (activeWorker.current !== worker) return;
          progress = await saveAnalysisProgress(db, progress.id, {
            checkpoint: update.checkpoint,
            result: update.result,
            status: update.result.complete ? "complete" : "running",
            expectedProgressVersion: progress.progressVersion,
          });
          ownership.progressVersion = progress.progressVersion;
          if (activeWorker.current !== worker || !mounted.current) return;
          if (update.result.complete) {
            worker.terminate();
            activeWorker.current = null;
            activeAnalysis.current = null;
            setRunningId(null);
          } else {worker.postMessage({
              type: "batch",
              input: progress.input,
              checkpoint: progress.checkpoint,
            });}
        }).catch(fail);
      };
      worker.postMessage({
        type: "batch",
        input: progress.input,
        checkpoint: progress.checkpoint,
      });
    } catch (failure) {
      if (owned) {
        await pausePlanningAnalysis(db, owned.id, owned.progressVersion).catch(
          () => undefined,
        );
      }
      if (mounted.current) {
        setError(errorMessage(failure));
        setRunningId(null);
      }
    } finally {
      operationStarting.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  async function pause() {
    const owned = activeAnalysis.current;
    activeWorker.current?.terminate();
    activeWorker.current = null;
    activeAnalysis.current = null;
    await saves.current;
    if (owned) await pausePlanningAnalysis(db, owned.id, owned.progressVersion);
    if (mounted.current) setRunningId(null);
  }

  return (
    <div className="planning-sections">
      <section className="panel planner">
        <SectionTitle
          title="Um plano para a turma"
          subtitle="Compare jogos, custos e chances com o orçamento das participações confirmadas."
        />
        <div className="planner-overview">
          <div>
            <span>
              {isDemo ? "Orçamento do exemplo" : "Orçamento das participações"}
            </span>
            <strong>{formatBRL(budget)}</strong>
          </div>
          <div>
            <span>Jogos fixos preservados</span>
            <strong>{bets.length}</strong>
          </div>
          <div>
            <span>Participações consideradas</span>
            <strong>{rights.length}</strong>
          </div>
        </div>
        {isDemo && (
          <p className="inline-note">
            Este cálculo usa recebimentos sintéticos e concurso de exemplo.
            Aplicação e trava reais precisam da sua conta.
          </p>
        )}
        {setupMissing && (
          <div className="inline-note">
            <span>
              Defina o concurso e escolha cotas oficiais ou acordo interno antes
              de planejar.
            </span>
            <button className="button secondary" onClick={editPool}>
              Completar bolão
            </button>
          </div>
        )}
        {budget === "0" && (
          <p className="inline-note">
            Confirme as participações na Revisão para formar o orçamento deste
            bolão.
          </p>
        )}
        <div className="planning-settings">
          <label>
            Taxa externa prevista (R$)<input
              inputMode="decimal"
              value={fee}
              disabled={busy}
              onChange={(event) => setFee(event.target.value)}
            />
          </label>
          <label>
            Descrição da taxa<input
              value={feeLabel}
              maxLength={200}
              disabled={busy}
              placeholder="Ex.: serviço do registrador"
              onChange={(event) => setFeeLabel(event.target.value)}
            />
          </label>
          <label>
            Destino de eventual sobra<select
              value={leftoverPolicy}
              disabled={busy}
              onChange={(event) =>
                setLeftoverPolicy(event.target.value as LeftoverPolicy)}
            >
              <option value="unassigned">Escolher depois</option>
              <option value="refund-pro-rata">
                Devolução proporcional pendente
              </option>
              <option value="group-credit">
                Reserva identificada no grupo
              </option>
            </select>
          </label>
          <button
            className="button primary"
            disabled={busy || setupMissing || budget === "0" ||
              pool.data.status === "registered" ||
              pool.data.status === "settled"}
            onClick={() => void generate()}
          >
            {generating
              ? <LoaderCircle className="spin" size={17} />
              : <Sparkles size={17} />}Comparar alternativas
          </button>
        </div>
        <p className="muted">
          As alternativas preservam os jogos fixos. Taxas e destino de sobras
          ficam preparados para aprovação; a busca compara candidatos dentro do
          orçamento.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
      {!!local?.candidates.length && (
        <div className="plan-grid" aria-label="Alternativas de plano">
          {local.candidates.map((saved) =>
            saved && (
              <article
                className={`plan-card ${
                  selected?.id === saved.id ? "selected" : ""
                }`}
                aria-label={`Plano ${strategies[saved.candidate.strategy]}`}
                key={saved.id}
              >
                <span className="eyebrow">PROPOSTA LOCAL</span>
                <h3>{strategies[saved.candidate.strategy]}</h3>
                <p>{saved.candidate.explanation}</p>
                <PlanValues plan={saved.candidate} />
                <button
                  className={`button ${
                    selected?.id === saved.id ? "primary" : "secondary"
                  }`}
                  disabled={busy}
                  onClick={() =>
                    void db.metadata.put({
                      key: selectionKey,
                      value: { ...local.meta!, selectedId: saved.id },
                    })}
                >
                  {selected?.id === saved.id
                    ? "Selecionada"
                    : `Comparar ${
                      strategies[saved.candidate.strategy].toLowerCase()
                    }`}
                </button>
              </article>
            )
          )}
        </div>
      )}
      {!!local?.meta?.unavailable.length && (
        <section className="panel">
          <SectionTitle title="Restrições das alternativas" />
          {local.meta.unavailable.map((item) => (
            <p className="inline-note" key={item.strategy}>
              <span>
                <strong>{strategies[item.strategy]}:</strong> {item.reason}
              </span>
            </p>
          ))}
        </section>
      )}
      {selected && local && (
        <section className="panel">
          <SectionTitle
            title={`A proposta ${strategies[selected.strategy].toLowerCase()}`}
            subtitle={`${selected.bets.length} jogos em ${selected.tickets.length} cartela(s). ${
              selected.participationMode === "official"
                ? "Correspondência com cotas oficiais verificada pelo catálogo."
                : "Participação por acordo interno do grupo."
            }`}
          />
          {local.coverage?.status === "exact"
            ? (
              <div className="planner-overview">
                <div>
                  <span>Combinações distintas</span>
                  <strong>
                    {Number(local.coverage.distinctCombinations).toLocaleString(
                      "pt-BR",
                    )}
                  </strong>
                </div>
                <div>
                  <span>Combinações repetidas</span>
                  <strong>
                    {(BigInt(local.coverage.elementaryCombinations) -
                      BigInt(local.coverage.distinctCombinations!))
                      .toLocaleString("pt-BR")}
                  </strong>
                </div>
                <div>
                  <span>Chance do prêmio principal</span>
                  <strong>{percent(local.coverage.probability!)}</strong>
                </div>
              </div>
            )
            : (
              <p className="inline-note">
                {local?.coverage?.reason ??
                  "A cobertura exata ainda precisa ser calculada para esta proposta."}
              </p>
            )}
          <p className="inline-note">
            <ShieldCheck size={18} />
            <span>
              Aplicar escolhe o plano e reserva seu custo. Travar congela os
              direitos e os jogos antes do registro externo.
            </span>
          </p>
          {!enabled && <p className="inline-note">{availability}</p>}
          <div className="planning-actions">
            <button
              className="button primary"
              disabled={!enabled || busy || registered}
              onClick={() => open({ type: "plan_apply", plan: selected })}
            >
              <ShieldCheck size={17} />Revisar aplicação do plano
            </button>
          </div>
          {registered && (
            <p className="inline-note">
              O registro externo já foi conferido. O plano registrado e seus
              direitos estão congelados.
            </p>
          )}
          <SimulationView
            analysis={analysis}
            running={!!runningId}
            start={() => void startSimulation(analysis)}
            pause={() =>
              void pause().catch((failure) => setError(errorMessage(failure)))}
            refine={() => void startSimulation(analysis, true)}
            disabled={generating || starting ||
              !!runningId && runningId !== analysis?.id}
          />
          <PlanDetails plan={selected} />
          <a
            className="source-link"
            href={LOTTERIES[selected.lotteryId].sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Regras e cartelas · fonte CAIXA
          </a>
        </section>
      )}
      {applied && (
        <AppliedPlanView
          plan={applied}
          manifest={manifest}
          enabled={enabled}
          frozen={registered}
          open={open}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}

export function PlanValues({ plan }: { plan: PreparedPlan }) {
  return (
    <dl className="plan-values">
      <div>
        <dt>Jogos</dt>
        <dd>{plan.bets.length}</dd>
      </div>
      <div>
        <dt>Apostas</dt>
        <dd>{formatBRL(plan.betCostCents)}</dd>
      </div>
      <div>
        <dt>Taxa prevista</dt>
        <dd>{formatBRL(plan.feeCents)}</dd>
      </div>
      <div className="plan-total">
        <dt>Custo reservado</dt>
        <dd>{formatBRL(plan.totalCostCents)}</dd>
      </div>
      <div>
        <dt>Sobra identificada</dt>
        <dd>{formatBRL(plan.leftoverCents)}</dd>
      </div>
      <div>
        <dt>Destino da sobra</dt>
        <dd>{leftoverLabels[plan.leftoverPolicy]}</dd>
      </div>
    </dl>
  );
}

export function PlanDetails({ plan }: { plan: PreparedPlan }) {
  return (
    <details className="planning-details">
      <summary>Ver jogos, cartelas e reprodução do cálculo</summary>
      <p>
        Concurso {plan.contestNumber} · {LOTTERIES[plan.lotteryId].label} ·{" "}
        {plan.catalogVersion}
      </p>
      <p>
        Semente da geração: <code>{plan.seed}</code>
      </p>
      <p>
        A autoria dos números fica registrada separadamente dos direitos.
        Cartelas e correspondências são propostas do grupo; os recibos oficiais
        serão conferidos após o registro externo.
      </p>
      <div className="planning-games">
        {plan.tickets.map((ticket, index) => (
          <div className="planning-game" key={ticket.key}>
            <strong>
              Cartela {index + 1} · {ticket.numberCount} dezenas ·{" "}
              {formatBRL(ticket.betCostCents)}
            </strong>
            <small>
              {ticket.officialQuotaCount === null
                ? "Acordo interno: esta cartela não representa um recibo oficial de cota."
                : `${ticket.officialQuotaCount} cotas oficiais previstas de ${
                  formatBRL(ticket.officialQuotaValueCents!)
                }.`}
            </small>
            {ticket.betKeys.map((key) => {
              const bet = plan.bets.find((item) =>
                item.key === key
              )!;
              return (
                <div className="planning-game" key={key}>
                  <Numbers
                    numbers={bet.numbers}
                    lotteryId={plan.lotteryId}
                    small
                  />
                  <small>
                    {bet.sourceBetId
                      ? "Jogo fixo preservado"
                      : "Jogo preparado pelo planejador"}
                  </small>
                </div>
              );
            })}
            {!!ticket.assignments.length && (
              <p>
                {ticket.assignments.map((assignment) =>
                  `${assignment.officialQuotas} cota(s) para a participação ${
                    assignment.quotaId.slice(0, 8)
                  }`
                ).join("; ")}
              </p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function SimulationView({
  analysis,
  running,
  start,
  pause,
  refine,
  disabled,
}: {
  analysis: PersistentPlanningAnalysis | undefined;
  running: boolean;
  start: () => void;
  pause: () => void;
  refine: () => void;
  disabled: boolean;
}) {
  const result = analysis?.result;
  return (
    <section className="simulation-result" aria-label="Simulação da carteira">
      <h3>Chance de ao menos um prêmio</h3>
      <p>
        Monte Carlo considera sobreposições entre os jogos. A simulação começa
        com 200 mil sorteios e pode ser refinada para 1 milhão, com intervalo de
        confiança de 95%.
      </p>
      {analysis && (
        <div className="simulation-progress">
          <span>
            {analysis.checkpoint.processedSamples.toLocaleString("pt-BR")} de
            {" "}
            {analysis.input.targetSamples.toLocaleString("pt-BR")} sorteios ·
            {" "}
            {running
              ? "Calculando"
              : analysis.status === "complete"
              ? "Concluída"
              : "Pode ser retomada"}
          </span>
          <progress
            aria-label="Progresso da simulação"
            max={analysis.input.targetSamples}
            value={analysis.checkpoint.processedSamples}
          />
        </div>
      )}
      <div className="planning-actions">
        {running
          ? (
            <button className="button secondary" onClick={pause}>
              <Pause size={17} />Pausar simulação
            </button>
          )
          : (!analysis || analysis.status !== "complete") && (
            <button
              className="button secondary"
              disabled={disabled}
              onClick={start}
            >
              <Play size={17} />
              {analysis ? "Retomar simulação" : "Simular carteira"}
            </button>
          )}
        {analysis?.status === "complete" &&
          analysis.input.targetSamples < 1_000_000 && (
          <button
            className="button secondary"
            disabled={disabled}
            onClick={refine}
          >
            Refinar para 1 milhão
          </button>
        )}
      </div>
      {result && (
        <>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Evento na carteira</th>
                  <th>Estimativa</th>
                  <th>Intervalo de 95%</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Ao menos um prêmio", result.anyPrize],
                  ...Object.entries(result.tiers).sort(([a], [b]) =>
                    Number(b) - Number(a)
                  ).map(([tier, estimate]) =>
                    [`Ao menos um de ${tier} acertos`, estimate] as const
                  ),
                ].map(([label, estimate]) => (
                  <tr key={String(label)}>
                    <td>{String(label)}</td>
                    <td>
                      {typeof estimate === "string"
                        ? estimate
                        : estimate.hits === 0
                        ? "Não observado"
                        : percent(estimate.probability)}
                    </td>
                    <td>
                      {typeof estimate === "string"
                        ? ""
                        : `${percent(estimate.lower95)} a ${
                          percent(estimate.upper95)
                        }`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Zero ocorrências nesta amostra não significa chance zero. A chance
            exata do prêmio principal aparece acima quando a união pôde ser
            calculada.
          </p>
          <details className="planning-details">
            <summary>Reproduzir a simulação</summary>
            <p>
              {result.algorithmVersion} ·{" "}
              {result.samples.toLocaleString("pt-BR")} amostras independentes
            </p>
            <code>{result.seed}</code>
          </details>
        </>
      )}
    </section>
  );
}

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function AppliedPlanView({
  plan,
  manifest,
  enabled,
  frozen = false,
  open,
  onNotice,
}: {
  plan: AppliedPlan;
  manifest: PoolManifest | null;
  enabled: boolean;
  frozen?: boolean;
  open: (request: PlanningRequest) => void;
  onNotice: (notice: { text: string; error?: boolean }) => void;
}) {
  const same = manifest?.appliedPlanId === plan.id;
  const downloadManifest = async () => {
    if (!manifest) return;
    if (!await verifyManifest(manifest)) {
      throw new Error(
        "O manifesto não corresponde ao hash confirmado. Sincronize antes de baixar.",
      );
    }
    download(
      manifest.canonical,
      `manifesto-${manifest.poolId}-v${manifest.version}.json`,
      "application/json",
    );
  };
  return (
    <section className="panel" aria-label="Plano confirmado">
      <SectionTitle
        title={`Plano confirmado · versão ${plan.version}`}
        subtitle={`Aplicado no servidor em ${
          date(plan.appliedAt)
        }. Jogos gerados pertencem a este plano; seus rascunhos fixos são preservados.`}
      />
      <PlanValues plan={plan.plan} />
      <p className="inline-note">
        {same
          ? `Bolão travado · manifesto versão ${manifest.version}.`
          : manifest
          ? "Há um plano novo. A trava anterior continua preservada até confirmar a nova versão."
          : "O plano está aplicado. Confira os responsáveis e trave o bolão antes do registro externo."}
      </p>
      <div className="planning-actions">
        <button
          className="button primary"
          disabled={!enabled || !!same || frozen}
          onClick={() =>
            open({
              type: "pool_lock",
              poolId: plan.poolId,
              appliedPlanId: plan.id,
            })}
        >
          <ShieldCheck size={17} />
          {manifest ? "Revisar nova trava" : "Revisar trava do bolão"}
        </button>
        {manifest && (
          <button
            className="button secondary"
            onClick={() =>
              void downloadManifest().catch((error) =>
                onNotice({ text: errorMessage(error), error: true })
              )}
          >
            <Download size={17} />Baixar manifesto privado
          </button>
        )}
      </div>
      {manifest && (
        <details className="planning-details">
          <summary>Ver o que ficou congelado</summary>
          <p>
            Versão {manifest.version} · confirmada em {date(manifest.lockedAt)}
            {" "}
            · {manifest.lockedAt} (UTC)
          </p>
          <p>
            Participantes, direitos, responsáveis, recebimentos, alocações,
            regras, preços e jogos ficam registrados nesta versão. O documento é
            privado e contém fatos financeiros do grupo.
          </p>
          <p className="manifest-hash">SHA-256: {manifest.sha256}</p>
          <p>
            O hash identifica o conteúdo deste arquivo. A auditoria e o horário
            do servidor não constituem prova absoluta contra alterações por quem
            administra a infraestrutura.
          </p>
          <PlanDetails plan={manifest.content.plan} />
        </details>
      )}
      <PlanDetails plan={plan.plan} />
    </section>
  );
}
