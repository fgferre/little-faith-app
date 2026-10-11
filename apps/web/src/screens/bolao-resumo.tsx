import { BookOpen, Clock3, Ticket, Users, Wallet } from "lucide-react";
import { formatBRL } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import { SectionTitle, Stat, Step } from "../components";
import { formatDate } from "../app-shared";
import type { FormKind, Snapshot, Tab } from "../app-shared";
import type { latestApplied, latestManifest } from "../planning";

export function BolaoResumo(
  {
    snapshot,
    group,
    pool,
    poolBets,
    poolQuotas,
    manifest,
    appliedPlan,
    confirmedCents,
    expectedCents,
    gamesCost,
    proposedCents,
    openForm,
    setTab,
  }: {
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    pool: LocalRecord<"pool">;
    poolBets: LocalRecord<"bet">[];
    poolQuotas: LocalRecord<"quota">[];
    manifest: ReturnType<typeof latestManifest>;
    appliedPlan: ReturnType<typeof latestApplied>;
    confirmedCents: string;
    expectedCents: string | null;
    gamesCost: string;
    proposedCents: string;
    openForm: (kind: FormKind) => void;
    setTab: (tab: Tab) => void;
  },
) {
  return (
    <>
      <div className="stats-grid">
        <Stat
          icon={<Wallet size={19} />}
          color="green"
          label="Confirmado"
          value={formatBRL(confirmedCents)}
          note="Recebimentos no caixa"
        />
        <Stat
          icon={<Users size={19} />}
          color="blue"
          label="Cotas preparadas"
          value={expectedCents === null
            ? "Revisar cotas"
            : formatBRL(expectedCents)}
          note="Valor devido, sem confirmação"
        />
        <Stat
          icon={<Ticket size={19} />}
          color="purple"
          label="Custo dos jogos"
          value={formatBRL(gamesCost)}
          note="Jogos preparados, não registrados"
        />
        <Stat
          icon={<Clock3 size={19} />}
          color="amber"
          label="Em revisão"
          value={formatBRL(proposedCents)}
          note="Não aumenta o saldo"
        />
      </div>
      <div className="lower-grid">
        <section className="panel">
          <SectionTitle
            title="Próximos passos"
            subtitle="Uma coisa de cada vez, com cuidado."
          />
          <div className="steps">
            <Step
              n="1"
              title="Reunir as pessoas"
              description={`${snapshot.persons.length} pessoas cadastradas no grupo`}
              done={snapshot.persons.length > 0}
              action={() => setTab("pessoas")}
            />
            <Step
              n="2"
              title="Preparar cotas e pagamentos"
              description="Direitos ficam em rascunho até confirmação online"
              done={poolQuotas.length > 0}
              action={() => openForm("quota")}
            />
            <Step
              n="3"
              title="Preparar os jogos"
              description={`${
                appliedPlan?.plan.bets.length ??
                  poolBets.length
              } jogos · ${formatBRL(gamesCost)}`}
              done={!!appliedPlan ||
                poolBets.length > 0}
              action={() => setTab("jogos")}
            />
            <Step
              n="4"
              title="Conferir e travar online"
              description={manifest
                ? `Manifesto confirmado · versão ${manifest.version}`
                : appliedPlan
                ? "Plano aplicado; confira os responsáveis e trave o bolão"
                : "Compare alternativas e aplique um plano antes da trava"}
              done={!!manifest &&
                manifest.appliedPlanId ===
                  appliedPlan?.id}
              action={() => setTab("planejar")}
            />
          </div>
        </section>
        <section className="panel detail-panel">
          <SectionTitle
            title="Combinados da turma"
            action={
              <button
                className="button secondary"
                disabled={pool.data.status !==
                  "draft"}
                onClick={() => openForm("edit-pool")}
              >
                Editar bolão
              </button>
            }
          />
          <span className="detail-label">
            PRAZO INTERNO
          </span>
          <strong>
            {formatDate(
              pool.data.deadlineAt,
              "America/Sao_Paulo",
            )} · Brasília
          </strong>
          <small>
            {formatDate(pool.data.deadlineAt)}{" "}
            · seu fuso ({Intl.DateTimeFormat()
              .resolvedOptions().timeZone})
          </small>
          <span className="detail-label">
            COTA DE REFERÊNCIA
          </span>
          <strong>
            {formatBRL(pool.data.quotaPriceCents)}
          </strong>
          <span className="detail-label">
            TIPO DE PARTICIPAÇÃO
          </span>
          <p>
            {pool.data.participationMode ===
                "undecided"
              ? "A definir antes do fechamento"
              : pool.data.participationMode ===
                  "official"
              ? appliedPlan
                ? "Correspondência de cotas oficiais no plano confirmado"
                : "Confira a correspondência de cotas oficiais no planejador"
              : "Acordo interno do grupo"}
          </p>
          <div className="inline-note">
            <BookOpen size={17} />
            <span>
              {group?.data.statute ||
                "Nenhum estatuto informado."}
            </span>
          </div>
        </section>
      </div>
    </>
  );
}
