import { ChevronRight, MessageCircle, Plus } from "lucide-react";
import { formatBRL, LOTTERIES } from "@bolao/core";
import type { FinancialView, LocalRecord } from "@bolao/core";
import type { BolaoDatabase } from "@bolao/local";
import type { FormKind, Route, Snapshot } from "../app-shared";
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
import { joinNames, STEP_LABEL, usePoolViews } from "./bolao-etapas";
import type { PoolView } from "./bolao-etapas";

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
  },
) {
  const views = usePoolViews({ db, snapshot, financialView, isDemo });

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
                        onClick={() =>
                          route.navigate("boloes", hero.pool.id, "arrecadar")}
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
