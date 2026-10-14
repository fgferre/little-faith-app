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
import { Numbers } from "./components";
import type { PlanningRequest } from "./planning-decision";
import { Button, Card, Chip, Disclosure, Eyebrow, umEm } from "./ui";

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
    const coverages = meta
      ? await db.metadata.bulkGet(
        meta.ids.map((id) => `planning-coverage:${id}`),
      )
      : [];
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
      coverage: new Map(
        (meta?.ids ?? []).map((id, index) => [
          id,
          coverages[index]?.value as ExactPortfolioProbability | undefined,
        ]),
      ),
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
    <div className="planning-sections planner">
      <Card className="planner-card" label="Um plano para a turma">
        <Eyebrow>Um plano para a turma</Eyebrow>
        <p className="ui-sec">
          Compare jogos, custo e chance com o dinheiro das cotas confirmadas.
        </p>
        <dl className="pool-facts">
          <div>
            <dt>{isDemo ? "Orçamento do exemplo" : "Orçamento"}</dt>
            <dd>{formatBRL(budget)}</dd>
          </div>
          <div>
            <dt>Jogos que ficam</dt>
            <dd>{bets.length}</dd>
          </div>
          <div>
            <dt>Cotas confirmadas</dt>
            <dd>{rights.length}</dd>
          </div>
        </dl>
        {isDemo && (
          <p className="planner-note">
            Este cálculo usa pagamentos de exemplo e um concurso de exemplo.
            Aplicar e travar de verdade pede a sua conta.
          </p>
        )}
        {setupMissing && (
          <div className="planner-note">
            <span>
              Defina o concurso e escolha cotas oficiais ou acordo interno antes
              de planejar.
            </span>
            <Button variant="ghost" small onClick={editPool}>
              Completar bolão
            </Button>
          </div>
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
        </div>
        <div className="pool-actions">
          <Button
            icon={generating
              ? <LoaderCircle className="spin" aria-hidden="true" />
              : <Sparkles aria-hidden="true" />}
            disabled={busy || setupMissing || budget === "0" ||
              pool.data.status === "registered" ||
              pool.data.status === "settled"}
            onClick={() => void generate()}
          >
            Comparar alternativas
          </Button>
        </div>
        {budget === "0" && (
          <p className="planner-note">
            Confirme os pagamentos na Revisão para formar o orçamento deste
            bolão.
          </p>
        )}
        <p className="ui-sec planner-after">
          As alternativas mantêm os jogos fixos. A taxa e o destino da sobra
          ficam para aprovação.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </Card>
      {!!local?.candidates.length && (
        <div className="plan-grid" aria-label="Alternativas de plano">
          {local.candidates.map((saved) => {
            if (!saved) return null;
            const plan = saved.candidate;
            const chosen = selected?.id === saved.id;
            const coverage = local.coverage.get(saved.id);
            return (
              <Card
                key={saved.id}
                className={`plan-card ${chosen ? "selected" : ""}`}
                label={`Plano ${strategies[plan.strategy]}`}
              >
                <Eyebrow>Alternativa</Eyebrow>
                <h3 className="planner-h">{strategies[plan.strategy]}</h3>
                <p className="ui-sec">{plan.explanation}</p>
                <p className="plan-chance">
                  <strong>
                    {coverage?.probability != null
                      ? umEm(coverage.probability)
                      : "Chance a calcular"}
                  </strong>
                  <span className="ui-sec">chance do prêmio principal</span>
                </p>
                <dl className="pool-facts">
                  <div>
                    <dt>Custo</dt>
                    <dd>{formatBRL(plan.totalCostCents)}</dd>
                  </div>
                  <div>
                    <dt>Sobra</dt>
                    <dd>{formatBRL(plan.leftoverCents)}</dd>
                  </div>
                  <div>
                    <dt>Jogos</dt>
                    <dd>{plan.bets.length}</dd>
                  </div>
                </dl>
                <Disclosure summary="Ver cálculo">
                  <p>
                    {coverage?.status === "exact"
                      ? `Chance exata: ${
                        BigInt(coverage.distinctCombinations!).toLocaleString(
                          "pt-BR",
                        )
                      } em ${
                        BigInt(coverage.denominator).toLocaleString("pt-BR")
                      } combinações possíveis (${
                        (BigInt(coverage.elementaryCombinations) -
                          BigInt(coverage.distinctCombinations!))
                          .toLocaleString("pt-BR")
                      } repetidas entre os jogos).`
                      : coverage?.reason ??
                        "A chance exata ainda precisa ser calculada para este plano."}
                  </p>
                  <PlanValues plan={plan} />
                </Disclosure>
                {chosen
                  ? <Chip status="confirmed">Plano escolhido</Chip>
                  : (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void db.metadata.put({
                          key: selectionKey,
                          value: { ...local.meta!, selectedId: saved.id },
                        })}
                    >
                      Escolher este plano
                    </Button>
                  )}
              </Card>
            );
          })}
        </div>
      )}
      {!!local?.meta?.unavailable.length && (
        <Card className="planner-card" label="Restrições das alternativas">
          <Eyebrow>Restrições das alternativas</Eyebrow>
          {local.meta.unavailable.map((item) => (
            <p className="ui-sec" key={item.strategy}>
              <strong>{strategies[item.strategy]}:</strong> {item.reason}
            </p>
          ))}
        </Card>
      )}
      {selected && local && (
        <Card className="planner-card" label="Plano escolhido">
          <Eyebrow>Plano escolhido</Eyebrow>
          <h3 className="planner-h">{strategies[selected.strategy]}</h3>
          <p className="ui-sec">
            {selected.bets.length} jogos em {selected.tickets.length}{" "}
            {selected.tickets.length === 1 ? "cartela" : "cartelas"}.{" "}
            {selected.participationMode === "official"
              ? "As cotas oficiais conferem com o catálogo da CAIXA."
              : "Participação por acordo interno do grupo."}
          </p>
          <p className="planner-note">
            <ShieldCheck aria-hidden="true" />
            <span>
              Aplicar escolhe o plano e reserva o custo. Travar congela as cotas
              e os jogos antes do registro na lotérica.
            </span>
          </p>
          {!enabled && <p className="planner-note">{availability}</p>}
          <Button
            icon={<ShieldCheck aria-hidden="true" />}
            disabled={!enabled || busy || registered}
            onClick={() => open({ type: "plan_apply", plan: selected })}
          >
            Revisar aplicação do plano
          </Button>
          {registered && (
            <p className="planner-note">
              O registro na lotérica já foi conferido. O plano registrado e as
              cotas estão congelados.
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
        </Card>
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
    <Disclosure className="planning-details" summary="Ver jogos e cartelas">
      <p>
        Concurso {plan.contestNumber} · {LOTTERIES[plan.lotteryId].label}
      </p>
      <p>
        Os jogos são gerados de forma verificável. A autoria dos números fica
        separada do direito ao prêmio. Cartelas e cotas são sugestões do grupo;
        os recibos oficiais são conferidos depois do registro na lotérica.
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
      <Disclosure summary="Detalhes técnicos">
        <p>Catálogo {plan.catalogVersion}</p>
        <p>
          Código da geração: <code>{plan.seed}</code>
        </p>
      </Disclosure>
    </Disclosure>
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
  const events = result
    ? [
      ["Algum prêmio", result.anyPrize] as const,
      ...Object.entries(result.tiers).sort(([a], [b]) => Number(b) - Number(a))
        .map(([tier, estimate]) => [`${tier} acertos`, estimate] as const),
    ]
    : [];
  return (
    <section className="planner-sim" aria-label="Simulação da carteira">
      <h4>Chance de ganhar algum prêmio</h4>
      <p className="ui-sec">
        O aparelho sorteia 200 mil vezes para estimar a chance da carteira,
        contando os jogos que se repetem em parte. Depois dá para refinar para 1
        milhão de sorteios.
      </p>
      {analysis && (
        <div className="planner-progress">
          <p className="planner-progress-line" aria-live="polite">
            {analysis.checkpoint.processedSamples.toLocaleString("pt-BR")} de
            {" "}
            {analysis.input.targetSamples.toLocaleString("pt-BR")} sorteios ·
            {" "}
            {analysis.status === "complete"
              ? "Concluída"
              : running
              ? "Calculando"
              : analysis.status === "paused"
              ? "Pausada"
              : "Pode ser retomada"}
          </p>
          <progress
            aria-label="Progresso da simulação"
            max={analysis.input.targetSamples}
            value={analysis.checkpoint.processedSamples}
          />
        </div>
      )}
      {running
        ? (
          <Button
            variant="ghost"
            icon={<Pause aria-hidden="true" />}
            onClick={pause}
          >
            Pausar simulação
          </Button>
        )
        : (!analysis || analysis.status !== "complete") && (
          <Button
            variant="ghost"
            icon={<Play aria-hidden="true" />}
            disabled={disabled}
            onClick={start}
          >
            {analysis ? "Retomar simulação" : "Simular carteira"}
          </Button>
        )}
      {analysis?.status === "complete" &&
        analysis.input.targetSamples < 1_000_000 && (
        <Button variant="ghost" disabled={disabled} onClick={refine}>
          Refinar para 1 milhão
        </Button>
      )}
      {result && (
        <>
          <div className="planner-table">
            <table>
              <colgroup>
                <col className="planner-col-event" />
                <col className="planner-col-chance" />
                <col className="planner-col-range" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Evento</th>
                  <th scope="col">Chance</th>
                  <th scope="col">Faixa provável</th>
                </tr>
              </thead>
              <tbody>
                {events.map(([label, estimate]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>
                      {estimate.hits === 0
                        ? "Não observado"
                        : umEm(estimate.probability)}
                    </td>
                    <td>
                      {umEm(estimate.lower95)} a {umEm(estimate.upper95)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ui-sec">
            Zero ocorrências nesta amostra não significa chance zero. A faixa
            provável cobre 95% dos casos.
          </p>
          <Disclosure summary="Detalhes técnicos">
            <p>
              {result.algorithmVersion} ·{" "}
              {result.samples.toLocaleString("pt-BR")} sorteios independentes
            </p>
            <p>
              Código da simulação: <code>{result.seed}</code>
            </p>
          </Disclosure>
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
        "O registro da trava não bate com o código de verificação confirmado. Sincronize antes de baixar.",
      );
    }
    download(
      manifest.canonical,
      `registro-da-trava-${manifest.poolId}-v${manifest.version}.json`,
      "application/json",
    );
  };
  return (
    <Card className="planner-card" label="Plano confirmado">
      <h3 className="planner-h">Plano confirmado · versão {plan.version}</h3>
      <p className="ui-sec">
        Aplicado no servidor em {date(plan.appliedAt)}. Os jogos gerados
        pertencem a este plano; os jogos fixos continuam.
      </p>
      <PlanValues plan={plan.plan} />
      <p className="planner-note">
        {same
          ? `Bolão travado · registro da trava versão ${manifest.version}.`
          : manifest
          ? "Há um plano novo. A trava anterior continua valendo até confirmar a nova versão."
          : "O plano está aplicado. Confira os responsáveis e trave o bolão antes do registro na lotérica."}
      </p>
      <div className="planning-actions">
        <Button
          icon={<ShieldCheck aria-hidden="true" />}
          disabled={!enabled || !!same || frozen}
          onClick={() =>
            open({
              type: "pool_lock",
              poolId: plan.poolId,
              appliedPlanId: plan.id,
            })}
        >
          {manifest ? "Revisar nova trava" : "Revisar trava do bolão"}
        </Button>
        {manifest && (
          <Button
            variant="ghost"
            icon={<Download aria-hidden="true" />}
            onClick={() =>
              void downloadManifest().catch((error) =>
                onNotice({ text: errorMessage(error), error: true })
              )}
          >
            Baixar registro da trava
          </Button>
        )}
      </div>
      {manifest && (
        <Disclosure summary="Detalhes técnicos">
          <p>
            Versão {manifest.version} · confirmada em {date(manifest.lockedAt)}
            {" "}
            · {manifest.lockedAt} (UTC)
          </p>
          <p>
            Participantes, cotas, responsáveis, pagamentos, regras, preços e
            jogos ficam guardados nesta versão. O arquivo é privado e contém o
            dinheiro do grupo.
          </p>
          <p className="manifest-hash">
            Código de verificação: {manifest.sha256}
          </p>
          <p>
            O código identifica o conteúdo do arquivo. O horário e a auditoria
            do servidor não são prova absoluta contra mudanças feitas por quem
            administra a infraestrutura.
          </p>
          <PlanDetails plan={manifest.content.plan} />
        </Disclosure>
      )}
      <PlanDetails plan={plan.plan} />
    </Card>
  );
}
