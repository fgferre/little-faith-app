import { useEffect, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { MotionConfig } from "motion/react";
import { formatBRL, LOTTERIES, prizeMultiplicities } from "@bolao/core";
import type {
  LotteryId,
  ParticipantCard,
  ParticipantCardPool as Pool,
} from "@bolao/core";
import {
  fetchParticipantCard,
  LINKS_UNAVAILABLE,
  ParticipantApiError,
} from "../participant-client";
import {
  ampliado,
  Balls,
  BrandMark,
  Button,
  Card,
  Chip,
  Eyebrow,
  formatWhen,
  Money,
} from "../ui";
import type { ChipStatus } from "../ui";
import { cotas } from "./bolao-arrecadar";

type Share = NonNullable<Pool["share"]>;

const acertos = (n: number) => `${n} ${n === 1 ? "acerto" : "acertos"}`;
const positive = (cents: string | null) =>
  cents !== null && BigInt(cents) > 0n;

/** Acertos de um jogo e se ele ganha alguma faixa, pela mesma conta do núcleo que a tela Sorteio usa. */
function gameHits(lotteryId: LotteryId, numbers: number[], drawn: number[]) {
  const set = new Set(drawn);
  const hits = numbers.filter((n) => set.has(n)).length;
  try {
    return {
      hits,
      wins: prizeMultiplicities(lotteryId, numbers, drawn).some((tier) =>
        tier.combinations !== "0"
      ),
    };
  } catch {
    return { hits, wins: false };
  }
}

const REGISTRO: Record<
  NonNullable<Pool["registration"]>["status"],
  { status: ChipStatus; label: string; line: string }
> = {
  planned: {
    status: "pending",
    label: "Ainda não registrado",
    line: "Os jogos ainda vão ser registrados.",
  },
  registered: {
    status: "confirmed",
    label: "Registrado",
    line: "Os jogos foram registrados e têm comprovante.",
  },
  partial: {
    status: "pending",
    label: "Registro parcial",
    line: "Parte dos jogos já tem comprovante; o resto ainda falta.",
  },
  divergent: {
    status: "problem",
    label: "Registro com diferença",
    line: "O comprovante não bate com o combinado. O organizador está conferindo.",
  },
};

/** "sábado, 20h" quando há horário; só "11/10" quando o servidor sabe apenas a data (AAAA-MM-DD). */
function drawWhen(drawAt: string) {
  return drawAt.length === 10
    ? `${drawAt.slice(8, 10)}/${drawAt.slice(5, 7)}`
    : formatWhen(Date.parse(drawAt), Date.now());
}

function PoolHead(
  { pool, as: Title = "h2" }: { pool: Pool; as?: "h1" | "h2" },
) {
  const label = LOTTERIES[pool.modality].label;
  return (
    <>
      <Title className="ui-title pool-title">{pool.title}</Title>
      <p className="pool-meta">
        <Chip modality={pool.modality}>
          {pool.drawAt ? `${label} · ${drawWhen(pool.drawAt)}` : label}
        </Chip>
        <span className="ui-sec">
          {pool.contest ? `Concurso ${pool.contest}` : "Concurso a definir"}
        </span>
        {pool.closed && <Chip family>Encerrado</Chip>}
      </p>
    </>
  );
}

function QuotaCard({ quota }: { quota: Pool["quota"] }) {
  const missing = quota.dueCents === null
    ? null
    : BigInt(quota.dueCents) - BigInt(quota.paidCents);
  return (
    <Card className="pool-card" label="Suas cotas">
      <div className="pool-card-head">
        <Eyebrow>Suas cotas</Eyebrow>
        {quota.paid === true && <Chip status="confirmed">Pago</Chip>}
        {quota.paid !== true && missing !== null && missing > 0n && (
          <Chip status="pending">
            Falta pagar {formatBRL(missing.toString())}
          </Chip>
        )}
      </div>
      <dl className="pool-facts">
        <div>
          <dt>Cotas</dt>
          <dd>{cotas(quota.units)}</dd>
        </div>
        <div>
          <dt>Valor</dt>
          <dd>
            {quota.dueCents === null ? "A definir" : formatBRL(quota.dueCents)}
          </dd>
        </div>
        <div>
          <dt>Já pago</dt>
          <dd>{formatBRL(quota.paidCents)}</dd>
        </div>
      </dl>
    </Card>
  );
}

function GamesCard({ pool }: { pool: Pool }) {
  const drawn = pool.result?.drawnNumbers ?? null;
  const hits = drawn ? new Set(drawn) : undefined;
  const count = pool.games.length;
  return (
    <Card className="pool-card" label="Jogos">
      <Eyebrow>Jogos</Eyebrow>
      {count
        ? (
          <>
            <p className="ui-sec">
              {count} {count === 1 ? "jogo" : "jogos"} do bolão
            </p>
            <ul className="pool-games">
              {pool.games.map((game, index) => {
                const result = drawn
                  ? gameHits(pool.modality, game.numbers, drawn)
                  : null;
                return (
                  <li className="pool-game" key={index}>
                    <Balls
                      numbers={game.numbers}
                      hits={hits}
                      winner={!!result?.wins}
                      detail={ampliado(pool.modality, game.numbers.length)}
                      note={!result ? undefined : result.wins
                        ? <span className="ui-tag">{acertos(result.hits)}</span>
                        : <span className="ui-hits">{acertos(result.hits)}</span>}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )
        : <p className="ui-sec">Os jogos ainda não foram escolhidos.</p>}
    </Card>
  );
}

function RegistrationCard({ pool }: { pool: Pool }) {
  const registro = REGISTRO[pool.registration?.status ?? "planned"];
  const holder = pool.registration?.ticketHolderName ?? null;
  return (
    <Card className="pool-card" label="Registro">
      <div className="pool-card-head">
        <Eyebrow>Registro</Eyebrow>
        <Chip status={registro.status}>{registro.label}</Chip>
      </div>
      <p className="card-line">{registro.line}</p>
      {pool.participationMode === "internal" && holder && (
        <p className="card-line">O bilhete original fica com {holder}.</p>
      )}
      {pool.participationMode === "official" && (
        <p className="card-line">Cada pessoa tem o próprio recibo.</p>
      )}
    </Card>
  );
}

function ResultCard({ pool }: { pool: Pool }) {
  const { result } = pool;
  if (!result) {
    return (
      <Card className="pool-card" label="Resultado">
        <Eyebrow>Resultado</Eyebrow>
        <p className="card-line">
          O resultado aparece aqui depois do sorteio.
        </p>
      </Card>
    );
  }
  const games = pool.games.map((game) =>
    gameHits(pool.modality, game.numbers, result.drawnNumbers)
  );
  const winners = games.filter((game) => game.wins).length;
  const best = Math.max(0, ...games.map((game) => game.hits));
  const confirmed = positive(result.prizeConfirmedCents);
  return (
    <Card className="pool-card" label="Resultado">
      <Eyebrow>Resultado</Eyebrow>
      <div className="pool-drawn">
        <Balls
          numbers={result.drawnNumbers}
          hits={new Set(result.drawnNumbers)}
          winner
          reveal="drop"
        />
      </div>
      <h2 className="pool-card-title">
        {winners
          ? `${winners} ${winners === 1 ? "jogo premiado" : "jogos premiados"}`
          : "Não foi dessa vez."}
      </h2>
      {!!games.length && (
        <p className="ui-sec">Melhor jogo: {acertos(best)}</p>
      )}
      {confirmed
        ? (
          <div className="card-prize">
            <Money
              prize
              cents={result.prizeConfirmedCents!}
              countUp
              delay={1200}
            />
            <span className="ui-sec">prêmio confirmado</span>
          </div>
        )
        : winners > 0 && (
          <p className="card-chip">
            <Chip status="pending">Prêmio a confirmar</Chip>
          </p>
        )}
    </Card>
  );
}

function ShareCard(
  { share, internal }: { share: Share; internal: boolean },
) {
  const pending = positive(share.pendingCents);
  const refund = positive(share.refundRightCents);
  return (
    <Card className="pool-card" label="Sua parte">
      <div className="pool-card-head">
        <Eyebrow>Sua parte</Eyebrow>
        {share.rightCents !== null && share.pendingCents === "0" &&
          positive(share.rightCents) && (
          <Chip status="confirmed">Recebido</Chip>
        )}
      </div>
      {share.rightCents === null
        ? <p className="card-line">Sua parte ainda vai ser calculada.</p>
        : <Money cents={share.rightCents} />}
      <dl className="pool-facts">
        <div>
          <dt>Recebido</dt>
          <dd>{formatBRL(share.receivedCents)}</dd>
        </div>
        <div>
          <dt>Falta receber</dt>
          <dd className={pending ? "pool-amber" : undefined}>
            {share.pendingCents === null
              ? "A calcular"
              : formatBRL(share.pendingCents)}
          </dd>
        </div>
        {refund && (
          <div>
            <dt>Devolução</dt>
            <dd>
              {formatBRL(share.refundedCents)} de{" "}
              {formatBRL(share.refundRightCents!)}
            </dd>
          </div>
        )}
      </dl>
      {internal && share.paidByName && (
        <p className="ui-sec pool-sub">
          {pending
            ? `${share.paidByName} repassa a sua parte.`
            : `Repassado por ${share.paidByName}.`}
        </p>
      )}
    </Card>
  );
}

function PoolCards({ pool }: { pool: Pool }) {
  return (
    <div className="card-grid">
      <QuotaCard quota={pool.quota} />
      <GamesCard pool={pool} />
      <RegistrationCard pool={pool} />
      <ResultCard pool={pool} />
      {pool.share && (
        <ShareCard
          share={pool.share}
          internal={pool.participationMode === "internal"}
        />
      )}
    </div>
  );
}

/** O cartão da pessoa: os bolões do grupo em que ela tem cota, o mais novo aberto e os outros recolhidos. */
export function CartaoParticipante({ card }: { card: ParticipantCard }) {
  const [first, ...others] = card.pools;
  const you = (
    <p className="card-you">
      Você: <b>{card.person.name}</b>
    </p>
  );
  return (
    <>
      <Eyebrow>{card.group.name}</Eyebrow>
      {first
        ? (
          <section className="card-pool" aria-label={first.title}>
            <div>
              <PoolHead pool={first} as="h1" />
              {you}
            </div>
            <PoolCards pool={first} />
          </section>
        )
        : (
          <p className="card-line card-empty">
            Você ainda não tem cota em nenhum bolão deste grupo.
          </p>
        )}
      {!!others.length && (
        <div className="card-others">
          <Eyebrow>Outros bolões</Eyebrow>
          {others.map((pool) => (
            <details className="card-more" key={pool.id}>
              <summary className="ui-card interactive">
                <span>
                  <PoolHead pool={pool} />
                </span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <div className="card-pool">
                {you}
                <PoolCards pool={pool} />
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

type Load =
  | { state: "loading" }
  | { state: "ready"; card: ParticipantCard }
  | { state: "failed"; title: string; line?: string; retry?: boolean };

const OFFLINE: Load = {
  state: "failed",
  title: "Este cartão precisa de conexão.",
  line: "Conecte-se à internet e tente de novo.",
  retry: true,
};

function failure(error: unknown): Load {
  if (!navigator.onLine || error instanceof TypeError) return OFFLINE;
  const status = error instanceof ParticipantApiError ? error.status : -1;
  if (status === 404) {
    return {
      state: "failed",
      title: "Este link não existe.",
      line: "Confira se ele foi copiado inteiro ou peça um novo ao organizador.",
    };
  }
  if (status === 410) {
    return {
      state: "failed",
      title: "Este link foi cancelado pelo organizador.",
      line: "Peça um link novo ao organizador do bolão.",
    };
  }
  if (status === 503 || status === 0) {
    return { state: "failed", title: LINKS_UNAVAILABLE, retry: true };
  }
  return {
    state: "failed",
    title: "Não deu para abrir o cartão agora.",
    line: "Tente de novo daqui a pouco.",
    retry: true,
  };
}

/** A página aberta pelo link pessoal (`#/p/<token>`): sem conta, sem menu e sem seletor de grupo. */
export function ParticipanteScreen({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    if (!token) {
      setLoad(failure(new ParticipantApiError("", 404)));
    } else if (!navigator.onLine) {
      setLoad(OFFLINE);
    } else {
      fetchParticipantCard(token).then(
        (card) => active && setLoad({ state: "ready", card }),
        (error) => active && setLoad(failure(error)),
      );
    }
    return () => {
      active = false;
    };
  }, [token, attempt]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="card-page">
        <header className="card-top">
          <BrandMark />little faith
        </header>
        <main className="card-main">
          {load.state === "loading" && (
            <div className="loading">
              <LoaderCircle className="spin" aria-hidden="true" />Abrindo seu
              cartão…
            </div>
          )}
          {load.state === "ready" && <CartaoParticipante card={load.card} />}
          {load.state === "failed" && (
            <div className="card-state" role="alert">
              <h1 className="pool-card-title">{load.title}</h1>
              {load.line && <p className="ui-sec">{load.line}</p>}
              {load.retry && (
                <Button
                  variant="ghost"
                  small
                  onClick={() => {
                    setLoad({ state: "loading" });
                    setAttempt((n) => n + 1);
                  }}
                >
                  Tentar de novo
                </Button>
              )}
            </div>
          )}
        </main>
        <footer className="card-foot">
          <p className="ui-sec">Documento do grupo, não é recibo da Caixa.</p>
          <p className="ui-sec">
            Este link é seu. Se vazar, peça ao organizador para cancelar.
          </p>
        </footer>
      </div>
    </MotionConfig>
  );
}
