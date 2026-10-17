import { Clock3, Ticket, Users, Wallet } from "lucide-react";
import { formatBRL, LOTTERIES } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import { Stat, StateBadge } from "../components";
import type { FormKind } from "../app-shared";
import type { latestApplied } from "../planning";
import { Button, Card, Disclosure, Eyebrow, formatWhen } from "../ui";
import { concursos } from "../ui/texto";

const BRASILIA = "America/Sao_Paulo";

/** "sábado, 20h Brasília · 18h aqui"; só Brasília quando o fuso do aparelho é o mesmo. */
function deadlineText(iso: string | null, timeZone: string) {
  if (!iso) return "A definir";
  const at = Date.parse(iso);
  const now = Date.now();
  const there = formatWhen(at, now, BRASILIA);
  const here = formatWhen(at, now, timeZone);
  if (here === there) return `${there} (horário de Brasília)`;
  const [thereDay] = there.split(", ");
  const [hereDay, hereHour] = here.split(", ");
  return `${there} Brasília · ${hereDay === thereDay ? hereHour : here} aqui`;
}

export function BolaoMontar(
  {
    group,
    pool,
    appliedPlan,
    timeZone,
    confirmedCents,
    reconciledCents,
    expectedCents,
    gamesCost,
    proposedCents,
    openForm,
  }: {
    group: LocalRecord<"group"> | undefined;
    pool: LocalRecord<"pool">;
    appliedPlan: ReturnType<typeof latestApplied>;
    timeZone: string;
    confirmedCents: string;
    /** Caixa conciliado do bolão quando a divisão já tem movimentos; senão vale o confirmado. */
    reconciledCents: string | null;
    expectedCents: string | null;
    gamesCost: string;
    proposedCents: string;
    openForm: (kind: FormKind) => void;
  },
) {
  const mode = pool.data.participationMode;
  return (
    <div className="pool-cols">
      <Card className="pool-card" label="O bolão">
        <div className="pool-card-head">
          <Eyebrow>O bolão</Eyebrow>
          <StateBadge state={pool.state} />
        </div>
        <dl className="pool-facts">
          <div>
            <dt>Nome</dt>
            <dd>{pool.data.title}</dd>
          </div>
          <div>
            <dt>Modalidade</dt>
            <dd>{LOTTERIES[pool.data.lotteryId].label}</dd>
          </div>
          <div>
            <dt>{(pool.data.contestCount ?? 1) > 1 ? "Concursos" : "Concurso"}</dt>
            <dd>{concursos(pool.data, true)}</dd>
          </div>
          <div>
            <dt>Preço da cota</dt>
            <dd>{formatBRL(pool.data.quotaPriceCents)}</dd>
          </div>
          <div>
            <dt>Pagar até</dt>
            <dd>{deadlineText(pool.data.deadlineAt, timeZone)}</dd>
          </div>
          <div>
            <dt>Participação</dt>
            <dd>
              {mode === "undecided"
                ? "A definir antes de fechar"
                : mode === "official"
                ? appliedPlan
                  ? "Cotas oficiais da CAIXA, conferidas no plano"
                  : "Cotas oficiais da CAIXA"
                : "Acordo interno do grupo"}
            </dd>
          </div>
        </dl>
        <Disclosure summary="Ver combinados">
          <p>{group?.data.statute || "Nenhum combinado escrito ainda."}</p>
        </Disclosure>
        <div className="pool-actions">
          <Button
            disabled={pool.data.status !== "draft"}
            onClick={() => openForm("edit-pool")}
          >
            Editar bolão
          </Button>
        </div>
      </Card>
      <Card className="pool-card pool-numbers" label="Números do bolão">
        <Eyebrow>Números do bolão</Eyebrow>
        <div className="stats-grid">
          <Stat
            icon={<Wallet size={19} />}
            color="green"
            label={reconciledCents === null ? "Confirmado" : "Caixa conciliado"}
            value={formatBRL(reconciledCents ?? confirmedCents)}
            note={reconciledCents === null
              ? "Recebimentos no caixa"
              : "Contribuições + resgates − custos − pagamentos"}
          />
          <Stat
            icon={<Users size={19} />}
            color="blue"
            label="Valor das cotas"
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
            label="Em conferência"
            value={formatBRL(proposedCents)}
            note="Não aumenta o saldo"
          />
        </div>
      </Card>
    </div>
  );
}
