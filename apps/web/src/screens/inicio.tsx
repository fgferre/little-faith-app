import { motion } from "motion/react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Clock3,
  FolderHeart,
  Plus,
  ShieldCheck,
  Ticket,
  Users,
  Wallet,
} from "lucide-react";
import { formatBRL, LOTTERIES } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import {
  Avatar,
  Clover,
  EmptyState,
  LotteryBadge,
  SectionTitle,
  Stat,
  TextLink,
} from "../components";
import { formatDate } from "../app-shared";
import type { FormKind, Route, Snapshot, Tab } from "../app-shared";

export function InicioScreen(
  {
    snapshot,
    group,
    pool,
    poolBets,
    poolQuotas,
    route,
    isDemo,
    reviewCount,
    confirmedCents,
    proposedCents,
    gamesCost,
    primaryAction,
    openForm,
    setForm,
    setTab,
  }: {
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    pool: LocalRecord<"pool"> | undefined;
    poolBets: LocalRecord<"bet">[];
    poolQuotas: LocalRecord<"quota">[];
    route: Route;
    isDemo: boolean;
    reviewCount: number;
    confirmedCents: string;
    proposedCents: string;
    gamesCost: string;
    primaryAction: ReactNode;
    openForm: (kind: FormKind) => void;
    setForm: (kind: FormKind) => void;
    setTab: (tab: Tab) => void;
  },
) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SEU CANTINHO DA SORTE</span>
          <h1>
            Faça sua fezinha,<br />
            <span>
              organize suas apostas<br />e boa sorte!
            </span>
          </h1>
          <p>Seus bolões, sua turma e cada detalhe no lugar.</p>
        </div>
        {primaryAction}
      </div>
      {!group
        ? (
          <EmptyState
            icon={<FolderHeart size={30} />}
            title="Sua próxima boa história começa aqui"
            description="Crie um grupo e prepare seu primeiro bolão. Participantes não precisam criar conta."
            action={
              <button
                className="button primary"
                onClick={() => setForm("group")}
              >
                <Plus size={18} />Criar meu primeiro grupo
              </button>
            }
          />
        )
        : (
          <>
            <div className="dashboard-grid">
              <motion.section
                className="hero-card"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="hero-copy">
                  <span className="hero-eyebrow">
                    <span />JUNTOS NO PRÓXIMO SORTEIO
                  </span>
                  <h2>
                    {pool?.data.title ??
                      "Vamos fazer um bolão?"}
                  </h2>
                  <p>
                    {pool
                      ? "A sorte é uma surpresa. A organização não precisa ser."
                      : "Reúna a turma e comece pelos detalhes."}
                  </p>
                  {pool && (
                    <div className="hero-meta">
                      <LotteryBadge
                        lotteryId={pool.data.lotteryId}
                      />
                      <span>
                        <Clock3 size={14} />
                        {formatDate(
                          pool.data.deadlineAt,
                          "America/Sao_Paulo",
                        )} · Brasília
                      </span>
                    </div>
                  )}
                  <button
                    className="hero-button"
                    onClick={() =>
                      pool
                        ? route.navigate("boloes", pool.id)
                        : openForm("pool")}
                  >
                    {pool ? "Cuidar deste bolão" : "Preparar primeiro bolão"}
                    <ArrowRight size={18} />
                  </button>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <Clover className="hero-clover" />
                  <span className="floating-ball ball-one">
                    07
                  </span>
                  <span className="floating-ball ball-two">
                    24
                  </span>
                  <span className="floating-ball ball-three">
                    38
                  </span>
                  <span className="star star-one">✦</span>
                  <span className="star star-two">✧</span>
                  <span className="art-caption">
                    VAI QUE É A NOSSA VEZ :)
                  </span>
                </div>
              </motion.section>
              <section className="attention-card">
                <div className="card-heading">
                  <span className="icon-tile amber">
                    <ClipboardList size={20} />
                  </span>
                  <span className="eyebrow">
                    UM OLHAR COM CARINHO
                  </span>
                </div>
                <h2>O que pede atenção</h2>
                {reviewCount
                  ? (
                    <button
                      className="attention-line"
                      onClick={() => route.navigate("revisao")}
                    >
                      <span className="attention-count">
                        {reviewCount}
                      </span>
                      <span>
                        <strong>pendências para revisar</strong>
                        <small>
                          Confira antes de confirmar
                        </small>
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  )
                  : (
                    <div className="all-good">
                      <CheckCheck size={24} />
                      <strong>Nenhuma proposta pendente</strong>
                      <span>
                        Um bom momento para preparar os jogos.
                      </span>
                    </div>
                  )}
                <div className="attention-footer">
                  <ShieldCheck size={16} />
                  <span>
                    Confirmar é conferir o recebimento.
                  </span>
                </div>
              </section>
            </div>
            {pool && (
              <>
                <div className="context-line">
                  <span>
                    UM RETRATO DE <strong>{pool.data.title}</strong>
                  </span>
                  <span>
                    <span className="tiny-dot" />
                    {isDemo ? "Valores demonstrativos" : "Somente este bolão"}
                  </span>
                </div>
                <div className="stats-grid">
                  <Stat
                    icon={<Wallet size={19} />}
                    color="green"
                    label="Caixa confirmado"
                    value={formatBRL(confirmedCents)}
                    note={isDemo
                      ? "Recebimentos de exemplo"
                      : "Apenas recebimentos confirmados"}
                  />
                  <Stat
                    icon={<Clock3 size={19} />}
                    color="amber"
                    label="Em revisão"
                    value={formatBRL(proposedCents)}
                    note="Separado do dinheiro disponível"
                  />
                  <Stat
                    icon={<Ticket size={19} />}
                    color="purple"
                    label="Jogos preparados"
                    value={String(poolBets.length).padStart(
                      2,
                      "0",
                    )}
                    note={`${formatBRL(gamesCost)} em apostas planejadas`}
                  />
                  <Stat
                    icon={<Users size={19} />}
                    color="blue"
                    label="Pessoas com cotas"
                    value={String(
                      new Set(
                        poolQuotas.map((q) => q.data.personId),
                      ).size,
                    ).padStart(2, "0")}
                    note="Direitos ainda em preparação"
                  />
                </div>
              </>
            )}
            <div className="lower-grid">
              <section className="panel pools-panel">
                <SectionTitle
                  title="Nossos bolões"
                  subtitle="Cada concurso, uma nova história."
                  action={
                    <TextLink
                      onClick={() => route.navigate("boloes")}
                    >
                      Ver todos
                    </TextLink>
                  }
                />
                <div className="compact-pools">
                  {snapshot.pools.slice(0, 3).map((p) => (
                    <button
                      className="compact-pool"
                      key={p.id}
                      onClick={() => route.navigate("boloes", p.id)}
                    >
                      <span
                        className={`pool-icon ${p.data.lotteryId}`}
                      >
                        <Clover />
                      </span>
                      <span>
                        <strong>{p.data.title}</strong>
                        <small>
                          {LOTTERIES[p.data.lotteryId].label} ·{" "}
                          {p.data.contestNumber
                            ? `Concurso ${p.data.contestNumber}`
                            : "Concurso a definir"}
                        </small>
                      </span>
                      <span className="draft-pill">
                        Em preparação
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                  {!snapshot.pools.length && (
                    <p className="muted">
                      Seu grupo está pronto. Agora é só criar um bolão.
                    </p>
                  )}
                </div>
              </section>
              <section className="panel people-panel">
                <SectionTitle
                  title="A sorte tem companhia"
                  subtitle={group.data.name}
                />
                <div className="avatar-stack">
                  {snapshot.persons.slice(0, 6).map((p, i) => (
                    <Avatar
                      name={p.data.name}
                      index={i}
                      key={p.id}
                    />
                  ))}
                  {snapshot.persons.length > 6 && (
                    <span className="avatar avatar-extra">
                      +{snapshot.persons.length - 6}
                    </span>
                  )}
                </div>
                <p>
                  {snapshot.persons.length
                    ? (
                      <>
                        <strong>
                          {snapshot.persons.length} pessoas
                        </strong>{" "}
                        já fazem parte da turma.<br />Cada uma com seu lugar,
                        tudo bem cuidado.
                      </>
                    )
                    : "Adicione as pessoas do grupo. Uma conta no app é opcional."}
                </p>
                <TextLink
                  onClick={() => {
                    if (pool) {
                      setTab("pessoas");
                      route.navigate("boloes", pool.id);
                    } else openForm("person");
                  }}
                >
                  {snapshot.persons.length ? "Ver a turma" : "Adicionar pessoa"}
                </TextLink>
              </section>
            </div>
          </>
        )}
    </>
  );
}
