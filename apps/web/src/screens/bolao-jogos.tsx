import { Dices, Plus, Sparkles } from "lucide-react";
import { betCost, formatBRL } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import { EmptyState, Numbers, SectionTitle, StateBadge } from "../components";
import { PlanDetails } from "../planning";
import type { latestApplied, latestManifest } from "../planning";
import type { FormKind, Snapshot } from "../app-shared";

export function BolaoJogos(
  {
    snapshot,
    pool,
    poolBets,
    draftGamesCost,
    manifest,
    appliedPlan,
    openForm,
  }: {
    snapshot: Snapshot;
    pool: LocalRecord<"pool">;
    poolBets: LocalRecord<"bet">[];
    draftGamesCost: string;
    manifest: ReturnType<typeof latestManifest>;
    appliedPlan: ReturnType<typeof latestApplied>;
    openForm: (kind: FormKind) => void;
  },
) {
  return (
    <section className="panel">
      <SectionTitle
        title="Nossos números"
        subtitle={`${poolBets.length} jogos preparados · ${
          formatBRL(draftGamesCost)
        } em apostas`}
        action={
          <button
            className="button primary"
            disabled={!!manifest ||
              pool.data.status !== "draft"}
            onClick={() => openForm("generate")}
          >
            <Sparkles size={17} />Gerar jogos
          </button>
        }
      />
      <div className="panel-actions">
        <button
          className="button secondary"
          disabled={!!manifest ||
            pool.data.status !== "draft"}
          onClick={() => openForm("bet")}
        >
          <Plus size={16} />Adicionar dezenas
        </button>
        <span className="muted">
          Duplicatas são bloqueadas. Os jogos ainda não foram registrados.
        </span>
      </div>
      {appliedPlan && (
        <div className="inline-note">
          <span>
            Plano confirmado: {appliedPlan.plan.bets.length} jogos · {formatBRL(
              appliedPlan.plan.betCostCents,
            )}. Os jogos adicionais pertencem ao plano.
          </span>
        </div>
      )}
      {appliedPlan && <PlanDetails plan={appliedPlan.plan} />}
      {poolBets.length
        ? (
          <div className="bets-list">
            {poolBets.map((b, i) => (
              <div className="bet-row" key={b.id}>
                <span className="bet-index">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <Numbers
                    numbers={b.data.numbers}
                    lotteryId={b.data.lotteryId}
                    small
                  />
                  <small>
                    {b.data.authorIds.length
                      ? b.data.authorIds.map((id) =>
                        snapshot.persons.find((p) => p.id === id)?.data.name
                          .split(" ")[0] ??
                          "Pessoa do grupo"
                      ).join(", ")
                      : "Gerado para o grupo"}
                  </small>
                </div>
                <span className="bet-price">
                  {formatBRL(
                    betCost(
                      b.data.lotteryId,
                      b.data.numbers,
                    ),
                  )}
                </span>
                <StateBadge state={b.state} />
              </div>
            ))}
          </div>
        )
        : (
          <EmptyState
            icon={<Dices size={30} />}
            title="Cada jogo começa com uma ideia"
            description="Adicione as dezenas da turma ou gere jogos reproduzíveis neste aparelho."
          />
        )}
    </section>
  );
}
