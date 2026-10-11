import { Plus, Sparkles } from "lucide-react";
import { formatBRL } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import { Planner } from "../planning";
import type { latestApplied, latestManifest } from "../planning";
import type { PlanningRequest } from "../planning-decision";
import type { FormKind, Notice, Snapshot } from "../app-shared";
import { Balls, Button, Card, Disclosure, Eyebrow, reais } from "../ui";

const SHOWN = 6;

export function BolaoJogar(
  {
    db,
    snapshot,
    group,
    pool,
    poolBets,
    poolQuotas,
    draftGamesCost,
    manifest,
    appliedPlan,
    isDemo,
    financeEnabled,
    financeAvailability,
    openForm,
    setPlanningRequest,
    setNotice,
  }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    pool: LocalRecord<"pool">;
    poolBets: LocalRecord<"bet">[];
    poolQuotas: LocalRecord<"quota">[];
    draftGamesCost: string;
    manifest: ReturnType<typeof latestManifest>;
    appliedPlan: ReturnType<typeof latestApplied>;
    isDemo: boolean;
    financeEnabled: boolean;
    financeAvailability: string;
    openForm: (kind: FormKind) => void;
    setPlanningRequest: (request: PlanningRequest) => void;
    setNotice: (notice: Notice) => void;
  },
) {
  const locked = !!manifest || pool.data.status !== "draft";
  const sizes = [...new Set(poolBets.map((b) => b.data.numbers.length))].sort((
    a,
    b,
  ) => a - b);
  const author = (bet: LocalRecord<"bet">, index: number) => {
    const person = snapshot.persons.find((p) => p.id === bet.data.authorIds[0]);
    return person
      ? (person.data.nickname || person.data.name).split(" ")[0]!
      : `Jogo ${index + 1}`;
  };
  const game = (bet: LocalRecord<"bet">, index: number) => (
    <li className="pool-game" key={bet.id}>
      <Balls numbers={bet.data.numbers} name={author(bet, index)} />
    </li>
  );

  return (
    <div className="pool-cols pool-play">
      <Card className="pool-card" label="Nossos jogos">
        <Eyebrow>Nossos jogos</Eyebrow>
        {poolBets.length
          ? (
            <>
              <p className="ui-sec">
                {poolBets.length} {poolBets.length === 1 ? "jogo" : "jogos"} ·
                {" "}
                {reais(draftGamesCost)} · {sizes.length === 1
                  ? `${poolBets.length === 1 ? "de" : "todos de"} ${
                    sizes[0]
                  } números`
                  : `de ${sizes[0]} a ${sizes.at(-1)} números`}
              </p>
              <ul className="pool-games">
                {poolBets.slice(0, SHOWN).map(game)}
              </ul>
              {poolBets.length > SHOWN && (
                <Disclosure
                  summary={`Ver mais ${poolBets.length - SHOWN} ${
                    poolBets.length - SHOWN === 1 ? "jogo" : "jogos"
                  }`}
                >
                  <ul className="pool-games">
                    {poolBets.slice(SHOWN).map((bet, index) =>
                      game(bet, index + SHOWN)
                    )}
                  </ul>
                </Disclosure>
              )}
            </>
          )
          : (
            <p className="ui-sec pool-empty">
              Nenhum jogo ainda. Anote as dezenas da turma ou deixe o aparelho
              gerar jogos de forma verificável.
            </p>
          )}
        {appliedPlan && (
          <p className="ui-sec">
            Plano confirmado: {appliedPlan.plan.bets.length} jogos ·{" "}
            {formatBRL(appliedPlan.plan.betCostCents)}. Os jogos gerados
            pertencem ao plano.
          </p>
        )}
        <div className="pool-actions">
          <Button
            variant="ghost"
            icon={<Plus aria-hidden="true" />}
            disabled={locked}
            onClick={() => openForm("bet")}
          >
            Adicionar dezenas
          </Button>
          <Button
            icon={<Sparkles aria-hidden="true" />}
            disabled={locked}
            onClick={() => openForm("generate")}
          >
            Gerar jogos
          </Button>
        </div>
      </Card>
      {group && (
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
    </div>
  );
}
