import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronRight, MessageCircle, Plus } from "lucide-react";
import { createResultView, formatBRL, LOTTERIES, sumCents } from "@bolao/core";
import type { FinancialView, LocalRecord } from "@bolao/core";
import { getResultSnapshot } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { draftQuotaCost } from "../quota-display";
import { latestManifest } from "../planning";
import type { FormKind, Route, Snapshot, Tab } from "../app-shared";
import {
  Avatars,
  Button,
  calendarDaysUntil,
  Card,
  Chip,
  Countdown,
  Eyebrow,
  formatWhen,
  Money,
} from "../ui";

type StepKey =
  | "montar"
  | "arrecadar"
  | "jogar"
  | "registrar"
  | "sorteio"
  | "dividir";
const STEP_LABEL: Record<StepKey, string> = {
  montar: "Montar",
  arrecadar: "Arrecadar",
  jogar: "Jogar",
  registrar: "Registrar",
  sorteio: "Sorteio",
  dividir: "Dividir",
};

interface PoolView {
  pool: LocalRecord<"pool">;
  step: StepKey;
  drawAt: string | null;
  collectedCents: string;
  expectedCents: string | null;
  hasQuotas: boolean;
  owing: { id: string; name: string }[];
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > 3) {
    return `${names.slice(0, 3).join(", ")} e mais ${names.length - 3}`;
  }
  return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

export function InicioScreen(
  {
    db,
    snapshot,
    group,
    financialView,
    route,
    isDemo,
    reviewCount,
    timeZone,
    openForm,
    setForm,
    setTab,
  }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    financialView: FinancialView | null;
    route: Route;
    isDemo: boolean;
    reviewCount: number;
    timeZone: string;
    openForm: (kind: FormKind) => void;
    setForm: (kind: FormKind) => void;
    setTab: (tab: Tab) => void;
  },
) {
  const groupId = group?.id ?? null;
  const results = useLiveQuery(
    async () => groupId ? await getResultSnapshot(db, groupId) : null,
    [db, groupId],
  );
  const resultView = useMemo(
    () => results ? createResultView(results) : null,
    [results],
  );

  const views: PoolView[] = snapshot.pools.map((pool) => {
    const quotas = snapshot.quotas.filter((q) => q.data.poolId === pool.id);
    const personIds = [...new Set(quotas.map((q) => q.data.personId))];
    const confirmed = snapshot.confirmed.filter((p) => p.poolId === pool.id);
    const people = personIds.map((personId) => {
      const units = quotas.filter((q) => q.data.personId === personId)
        .reduce((n, q) => n + q.data.units, 0);
      const due = draftQuotaCost(pool.data.quotaPriceCents, units);
      const paid = isDemo
        ? sumCents(
          confirmed.filter((p) => p.personId === personId).map((p) =>
            p.amountCents
          ),
        )
        : financialView?.personPoolFunding(pool.id, personId) ?? "0";
      const person = snapshot.persons.find((p) => p.id === personId);
      return {
        id: personId,
        name: person?.data.nickname || person?.data.name || "Sem nome",
        due,
        owes: due === null || BigInt(paid) < BigInt(due),
      };
    });
    const dues = people.map((p) => p.due);
    const funded = people.length > 0 && people.every((p) => !p.owes);
    const result = resultView?.currentResult(pool.id).result;
    const registered = ["registered", "settled"].includes(pool.data.status) ||
      snapshot.registrations.some((r) => r.poolId === pool.id);
    const locked = pool.data.status === "locked" ||
      !!latestManifest(snapshot.planning, pool.id);
    const calendar = resultView?.currentCalendar(pool.id);
    return {
      pool,
      step: result?.drawnNumbers
        ? "dividir"
        : registered
        ? "sorteio"
        : locked
        ? "registrar"
        : !quotas.length
        ? "montar"
        : funded
        ? "jogar"
        : "arrecadar",
      drawAt: pool.data.contestNumber !== null &&
          calendar?.contestNumber === pool.data.contestNumber
        ? calendar.expectedDrawAt
        : null,
      collectedCents: isDemo
        ? sumCents(confirmed.map((p) => p.amountCents))
        : financialView?.finance.pools[pool.id]?.allocatedCents ?? "0",
      expectedCents: dues.some((due) => due === null)
        ? null
        : sumCents(dues as string[]),
      hasQuotas: quotas.length > 0,
      owing: people.filter((p) => p.owes),
    };
  });

  // Alvo da contagem: o próximo sorteio conhecido; senão o prazo de pagamento mais próximo.
  const now = Date.now();
  const upcoming = (iso: string | null): iso is string =>
    iso !== null &&
    (Date.parse(iso) >= now ||
      calendarDaysUntil(Date.parse(iso), now, timeZone) === 0);
  const earliest = (list: PoolView[], at: (v: PoolView) => string | null) =>
    list.filter((v) => upcoming(at(v))).sort((a, b) =>
      Date.parse(at(a)!) - Date.parse(at(b)!)
    )[0];
  const draw = earliest(
    views.filter((v) => v.step !== "dividir"),
    (v) => v.drawAt,
  );
  const deadline = draw ? undefined : earliest(
    views.filter((v) => v.step === "montar" || v.step === "arrecadar"),
    (v) => v.pool.data.deadlineAt,
  );
  const hero = draw ?? deadline ?? views.find((v) => v.step !== "dividir") ??
    views[0];
  const target = draw?.drawAt ?? deadline?.pool.data.deadlineAt ?? null;

  const when = (v: PoolView) => {
    if (v.drawAt) return formatWhen(Date.parse(v.drawAt), now, timeZone);
    if (v.pool.data.deadlineAt && (v.step === "montar" || v.step === "arrecadar")) {
      return `pagar até ${
        formatWhen(Date.parse(v.pool.data.deadlineAt), now, timeZone)
      }`;
    }
    return null;
  };

  return (
    <div className="home">
      <h1 className="home-tagline">
        Faça sua fezinha, organize suas apostas e boa sorte!
      </h1>

      {!group
        ? (
          <Card className="home-hero">
            <Eyebrow>Primeiro passo</Eyebrow>
            <h2 className="ui-title">Sua próxima boa história começa aqui</h2>
            <p className="ui-sec">
              Crie um grupo e prepare seu primeiro bolão. Participantes não
              precisam criar conta.
            </p>
            <Button
              icon={<Plus aria-hidden="true" />}
              onClick={() => setForm("group")}
            >
              Criar meu primeiro grupo
            </Button>
          </Card>
        )
        : (
          <>
            {hero
              ? (
                <Card className="home-hero">
                  {target
                    ? (
                      <>
                        <Eyebrow>{draw ? "Sorteio em" : "Pagar até"}</Eyebrow>
                        <Countdown target={target} timeZone={timeZone} />
                        <p className="ui-sec">
                          {hero.pool.data.title} ·{" "}
                          {formatWhen(Date.parse(target), now, timeZone)}
                        </p>
                      </>
                    )
                    : (
                      <>
                        <h2 className="ui-title">Sorteio a definir</h2>
                        <p className="ui-sec">{hero.pool.data.title}</p>
                      </>
                    )}
                  {hero.owing.length > 0 && (
                    <>
                      <div className="home-due">
                        <Avatars
                          people={hero.owing.map((p) => ({
                            ...p,
                            status: "owe",
                          }))}
                          max={4}
                        />
                        <p>
                          <span className="home-amber">Falta pagar:</span>{" "}
                          {joinNames(hero.owing.map((p) => p.name))}
                        </p>
                      </div>
                      <Button
                        icon={<MessageCircle aria-hidden="true" />}
                        onClick={() => {
                          setTab("pessoas");
                          route.navigate("boloes", hero.pool.id);
                        }}
                      >
                        Cobrar no WhatsApp
                      </Button>
                    </>
                  )}
                </Card>
              )
              : (
                <Card className="home-hero">
                  <Eyebrow>Primeiro bolão</Eyebrow>
                  <h2 className="ui-title">Seu grupo está pronto</h2>
                  <p className="ui-sec">
                    Agora é só preparar o primeiro bolão.
                  </p>
                  <Button
                    icon={<Plus aria-hidden="true" />}
                    onClick={() => openForm("pool")}
                  >
                    Preparar primeiro bolão
                  </Button>
                </Card>
              )}
            {reviewCount > 0 && (
              <Card
                className="home-attention"
                onClick={() => route.navigate("revisao")}
              >
                <span className="home-attention-main">
                  <Eyebrow>Pede atenção</Eyebrow>
                  <Money>{reviewCount}</Money>
                  <span className="ui-sec">
                    {reviewCount === 1 ? "pendência" : "pendências"}{" "}
                    para revisar · Conferir antes de confirmar
                  </span>
                </span>
                <ChevronRight aria-hidden="true" />
              </Card>
            )}
            <section className="home-pools" aria-label="Seus bolões">
              <div className="home-pools-head">
                <Eyebrow>Seus bolões</Eyebrow>
                <Button
                  variant="ghost"
                  small
                  icon={<Plus aria-hidden="true" />}
                  onClick={() => openForm("pool")}
                >
                  Novo bolão
                </Button>
              </div>
              {views.map((v) => {
                const line = when(v);
                return (
                  <Card
                    key={v.pool.id}
                    className="home-pool"
                    onClick={() => route.navigate("boloes", v.pool.id)}
                  >
                    <span className="home-pool-main">
                      <b>{v.pool.data.title}</b>
                      <span className="ui-sec">
                        {v.hasQuotas
                          ? (
                            <>
                              <span className="ui-nb">
                                {formatBRL(v.collectedCents)}
                              </span>
                              {v.expectedCents !== null && (
                                <>
                                  {" de "}
                                  <span className="ui-nb">
                                    {formatBRL(v.expectedCents)}
                                  </span>
                                </>
                              )}
                            </>
                          )
                          : "Nenhuma cota ainda"}
                        {line && <>{" · "}{line}</>}
                      </span>
                      <span className="home-pool-chips">
                        <Chip modality={v.pool.data.lotteryId}>
                          {LOTTERIES[v.pool.data.lotteryId].label}
                        </Chip>
                        <Chip modality={v.pool.data.lotteryId} step>
                          {STEP_LABEL[v.step]}
                        </Chip>
                      </span>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </Card>
                );
              })}
            </section>
          </>
        )}
    </div>
  );
}
