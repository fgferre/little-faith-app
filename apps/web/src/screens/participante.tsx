import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronDown, LoaderCircle, Paperclip, X } from "lucide-react";
import { MotionConfig } from "motion/react";
import {
  formatBRL,
  keptPrize,
  LOTTERIES,
  parseBRL,
  prizeMultiplicities,
} from "@bolao/core";
import type {
  LotteryId,
  ParticipantAnswer,
  ParticipantAnswerKind,
  ParticipantCard,
  ParticipantCardPool as Pool,
  ParticipantResponse,
  PixReceiver,
} from "@bolao/core";
import {
  fetchParticipantCard,
  LINKS_UNAVAILABLE,
  ParticipantApiError,
  sendParticipantAnswer,
  sendParticipantProof,
  setParticipantPin,
} from "../participant-client";
import { Modal } from "../components";
import { id } from "../demo";
import { demoParticipantCard } from "../demo-participante";
import {
  ampliado,
  Balls,
  BrandMark,
  Button,
  Card,
  Chip,
  codigoPix,
  Eyebrow,
  formatWhen,
  Money,
  MoneyInput,
  PixCode,
  ProblemBox,
  unfoldDetails,
} from "../ui";
import type { ChipStatus } from "../ui";
import { diaSemana, hoje, prazoResgate, quando, reaisGrandes } from "../ui/texto";
import { useProximoSorteio } from "../proximo-sorteio";
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
  // Antes do sorteio, o prêmio estimado e o dia vêm da CAIXA pelo aparelho, quando o concurso é o próximo dela.
  const { data } = useProximoSorteio(
    pool.status === "draft" && !pool.result ? pool.modality : null,
  );
  const next = data &&
      (pool.contest === null || pool.contest === data.extras.nextContestNumber)
    ? data.extras
    : null;
  const when = pool.drawAt
    ? drawWhen(pool.drawAt)
    : next?.nextDrawDate
    ? diaSemana(next.nextDrawDate)
    : null;
  return (
    <>
      <Title className="ui-title pool-title">{pool.title}</Title>
      <p className="pool-meta">
        <Chip modality={pool.modality}>
          {when ? `${label} · ${when}` : label}
        </Chip>
        <span className="ui-sec">
          {pool.contest
            ? `Concurso ${pool.contest}`
            : next?.nextContestNumber
            ? `Concurso ${next.nextContestNumber}`
            : "Concurso a definir"}
        </span>
        {pool.closed && <Chip family>Encerrado</Chip>}
        {next?.nextEstimatedPrizeCents && (
          <span className="pool-next">
            <b>{reaisGrandes(next.nextEstimatedPrizeCents, true)}</b>
            {next.accumulated ? " estimado · acumulou" : " estimado"}
          </span>
        )}
      </p>
    </>
  );
}

function QuotaCard({ quota }: { quota: NonNullable<Pool["quota"]> }) {
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

/** O Pix do que falta, enquanto o bolão ainda arrecada e o grupo tem chave cadastrada. */
function PayCard({ pool, pix }: { pool: Pool; pix: PixReceiver | null }) {
  const missing = !pool.quota || pool.quota.dueCents === null ||
      pool.quota.paid === true
    ? null
    : (BigInt(pool.quota.dueCents) - BigInt(pool.quota.paidCents)).toString();
  const payload = pool.status === "draft" && !pool.closed
    ? codigoPix(pix, missing)
    : null;
  if (!payload || !pix || !missing) return null;
  return (
    <Card className="pool-card" label="Pagar sua cota">
      <Eyebrow>Pagar sua cota</Eyebrow>
      <Money cents={missing} />
      <p className="ui-sec pix-to">Pix para {pix.name}</p>
      <PixCode payload={payload} />
      <p className="ui-sec pix-foot">
        Pague no seu banco; o organizador confirma quando o dinheiro cair.
      </p>
    </Card>
  );
}

/** Depois do sorteio, a lista começa com este tanto de jogos; o resto abre no botão. */
const VISIBLE_GAMES = 6;

function GamesCard({ pool }: { pool: Pool }) {
  const [all, setAll] = useState(false);
  const drawn = pool.result?.drawnNumbers ?? null;
  const hits = drawn ? new Set(drawn) : undefined;
  const count = pool.games.length;
  // Acerto só se conta em jogo lido do bilhete registrado; o do plano ainda pode não ser o que a lotérica registrou.
  const rows = pool.games.map((game, index) => ({
    game,
    index,
    result: drawn && game.registered
      ? gameHits(pool.modality, game.numbers, drawn)
      : null,
  }));
  // Depois do sorteio, quem mais acertou vem primeiro e os não conferidos por último; o sort é estável, então o empate fica na
  // ordem do plano.
  if (drawn) {
    rows.sort((a, b) => (b.result?.hits ?? -1) - (a.result?.hits ?? -1));
  }
  const folded = !!drawn && count > VISIBLE_GAMES;
  const shown = folded && !all ? rows.slice(0, VISIBLE_GAMES) : rows;
  return (
    <Card className="pool-card card-games" label="Jogos">
      <Eyebrow>Jogos</Eyebrow>
      {count
        ? (
          <>
            <p className="ui-sec">
              {count} {count === 1 ? "jogo" : "jogos"} do bolão
            </p>
            <ul className="pool-games">
              {shown.map(({ game, index, result }) => (
                <li className="pool-game" key={index}>
                  <Balls
                    numbers={game.numbers}
                    hits={result ? hits : undefined}
                    winner={!!result?.wins}
                    detail={ampliado(pool.modality, game.numbers.length)}
                    note={!drawn ? undefined : !result
                      ? <span className="ui-hits">Ainda não conferido</span>
                      : result.wins
                      ? <span className="ui-tag">{acertos(result.hits)}</span>
                      : <span className="ui-hits">{acertos(result.hits)}</span>}
                  />
                </li>
              ))}
            </ul>
            {folded && (
              <Button
                variant="ghost"
                small
                aria-expanded={all}
                onClick={() => setAll(!all)}
              >
                {all ? "Mostrar menos" : `Ver os ${count} jogos`}
              </Button>
            )}
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
  // Só os jogos lidos do bilhete registrado entram na conta, os mesmos da divisão do prêmio.
  const games = pool.games.filter((game) => game.registered).map((game) =>
    gameHits(pool.modality, game.numbers, result.drawnNumbers)
  );
  const unchecked = pool.games.length - games.length;
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
          : games.length
          ? "Não foi dessa vez."
          : "O resultado saiu."}
      </h2>
      {!!games.length && (
        <p className="ui-sec">Melhor jogo: {acertos(best)}</p>
      )}
      {!!unchecked && (
        <p className="ui-sec">
          {games.length
            ? `${unchecked} ${
              unchecked === 1 ? "jogo ainda não foi conferido" : "jogos ainda não foram conferidos"
            } com o bilhete.`
            : "Os jogos ainda não foram conferidos com o bilhete registrado."}
        </p>
      )}
      {confirmed
        ? (
          <div className="card-prize">
            <Money
              prize
              cents={result.prizeConfirmedCents!}
              countUp
              delay={700}
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
  { share, internal, result, groupReserve, groupPrizeLimit }: {
    share: Share;
    internal: boolean;
    result: Pool["result"];
    groupReserve: string | null;
    groupPrizeLimit: string | null;
  },
) {
  const pending = positive(share.pendingCents);
  // Prêmio até o limite combinado fica no caixa do grupo: ninguém tem parte dele para receber.
  const keptCents = keptPrize({
    participationMode: internal ? "internal" : "",
    groupPrizeLimitCents: groupPrizeLimit,
  }, result?.prizeConfirmedCents ?? null);
  const kept = keptCents > 0n;
  // A reserva do grupo inclui o prêmio que ficou no caixa; a sobra das cotas é o resto.
  const leftover = groupReserve === null
    ? null
    : (BigInt(groupReserve) - keptCents).toString();
  const refund = positive(share.refundRightCents);
  const deadline = result && positive(result.prizeConfirmedCents) &&
      result.redemptionDeadlineDate && result.prizeRedeemed !== true
    ? prazoResgate(result.redemptionDeadlineDate, hoje())
    : null;
  return (
    <Card className="pool-card" label="Sua parte">
      <div className="pool-card-head">
        <Eyebrow>Sua parte</Eyebrow>
        {share.rightCents !== null && share.pendingCents === "0" &&
          positive(share.rightCents) && (
          <Chip status="confirmed">Recebido</Chip>
        )}
      </div>
      {kept ? null : share.rightCents === null
        ? <p className="card-line">Sua parte ainda vai ser calculada.</p>
        : <Money cents={share.rightCents} />}
      <dl className="pool-facts">
        {kept
          ? (
            <div>
              <dt>Prêmio</dt>
              <dd>
                {formatBRL(result!.prizeConfirmedCents!)} · fica no caixa do
                grupo, como combinado
              </dd>
            </div>
          )
          : (
            <>
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
            </>
          )}
        {refund && (
          <div>
            <dt>Devolução</dt>
            <dd>
              {formatBRL(share.refundedCents)} de{" "}
              {formatBRL(share.refundRightCents!)}
            </dd>
          </div>
        )}
        {positive(leftover) && (
          <div>
            <dt>Sobra do bolão</dt>
            <dd>{formatBRL(leftover!)} · fica no caixa do grupo</dd>
          </div>
        )}
      </dl>
      {groupPrizeLimit !== null && !kept && (
        <p className="ui-sec pool-sub">
          Combinado: prêmio até {formatBRL(groupPrizeLimit)}{" "}
          fica no caixa do grupo.
        </p>
      )}
      {internal && share.paidByName && !kept && (
        <p className="ui-sec pool-sub">
          {pending
            ? `${share.paidByName} repassa a sua parte.`
            : `Repassado por ${share.paidByName}.`}
        </p>
      )}
      {deadline && (deadline.tone === "overdue"
        ? <ProblemBox title={deadline.text} />
        : (
          <p
            className={deadline.tone === "alert"
              ? "split-wait pool-note"
              : "ui-sec pool-note"}
          >
            {deadline.text}
          </p>
        ))}
    </Card>
  );
}

const toAnswer = (response: ParticipantResponse): ParticipantAnswer => ({
  kind: response.kind,
  amountCents: response.amountCents,
  proofSent: response.proofId !== null,
  at: response.createdAt,
});

/** Por que a resposta não chegou: o servidor diz o que recusou; sem resposta dele, foi a conexão, e nada foi registrado. */
function sendProblem(failure: unknown) {
  if (failure instanceof ParticipantApiError) {
    if (failure.code === "pool_closed") {
      return "Este bolão não aceita mais respostas.";
    }
    return pinProblem(failure) ?? failure.message;
  }
  return "Sem conexão. Sua resposta não foi enviada.";
}

const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const PROOF_TYPES = "application/pdf,image/png,image/jpeg,image/webp";

/** "Já paguei": o valor pago e, se quiser, o comprovante; o tesoureiro confere e confirma, nada vira dinheiro sozinho. */
function PaidDialog(
  { pool, token, idempotencyKey, onDone, onClose }: {
    pool: Pool;
    token: string | undefined;
    idempotencyKey: string;
    onDone: (answer: ParticipantAnswer) => void;
    onClose: () => void;
  },
) {
  const missing = pool.quota && pool.quota.dueCents !== null
    ? BigInt(pool.quota.dueCents) - BigInt(pool.quota.paidCents)
    : null;
  const [amount, setAmount] = useState(
    missing !== null && missing > 0n
      ? formatBRL(missing.toString()).replace(/^R\$\s?/, "")
      : "",
  );
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    let cents: string;
    try {
      cents = parseBRL(amount);
    } catch {
      cents = "0";
    }
    if (BigInt(cents) <= 0n) {
      setError("Digite o valor que você pagou.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!token) {
        onDone({
          kind: "paid",
          amountCents: cents,
          proofSent: !!file,
          at: new Date().toISOString(),
        });
        return;
      }
      const pin = rememberedPin(token);
      const sent = { poolId: pool.id, amountCents: cents, idempotencyKey };
      const { response } = file
        ? await sendParticipantProof(token, pin, sent, file)
        : await sendParticipantAnswer(token, pin, { ...sent, kind: "paid" });
      onDone(toAnswer(response));
    } catch (failure) {
      setError(sendProblem(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Já paguei"
      description="O tesoureiro confere e confirma. O comprovante fica só com ele."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void run();
        }}
      >
        <label>
          Valor pago<MoneyInput
            required
            value={amount}
            disabled={busy}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className={`ui-btn ghost pool-attach ${busy ? "disabled" : ""}`}>
          <Paperclip aria-hidden="true" />
          {file ? file.name : "Anexar comprovante"}
          <input
            className="ui-hidden"
            type="file"
            accept={PROOF_TYPES}
            disabled={busy}
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              event.target.value = "";
              if (chosen && chosen.size > MAX_PROOF_BYTES) {
                setError("O comprovante passa de 10 MB.");
                return;
              }
              setError("");
              setFile(chosen);
            }}
          />
        </label>
        {!file && (
          <p className="ui-sec">O comprovante é opcional: foto ou PDF.</p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <Button
            type="submit"
            disabled={busy}
            icon={busy
              ? <LoaderCircle aria-hidden="true" className="spin" />
              : <Check aria-hidden="true" />}
          >
            {busy ? "Enviando…" : "Avisar que paguei"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A resposta da pessoa nesta rodada: "Estou dentro", "Desta vez estou fora" ou "Já paguei" (com o valor e, se quiser, o
 * comprovante). Vale a última; nunca cria cota nem move dinheiro: o tesoureiro confirma. Sem servidor (cartão de exemplo),
 * a resposta fica só neste aparelho.
 */
function AnswerCard(
  { pool, token, onAnswer }: {
    pool: Pool;
    token: string | undefined;
    onAnswer: (poolId: string, answer: ParticipantAnswer) => void;
  },
) {
  const current = pool.response ?? null;
  const [choosing, setChoosing] = useState(false);
  const [sending, setSending] = useState<ParticipantAnswerKind | null>(null);
  const [problem, setProblem] = useState<
    { text: string; retry: () => void } | null
  >(null);
  const [paying, setPaying] = useState(false);
  // A chave de idempotência é deste aparelho: a nova tentativa repete a mesma e o servidor não registra duas vezes.
  const [key, setKey] = useState(() => crypto.randomUUID());
  // Cota já paga e conferida: não há o que responder, só a resposta antiga, se houver.
  const answerable = pool.responseOpen === true && pool.quota?.paid !== true;
  if (!current && !answerable) return null;
  const inside = current ? current.kind !== "out" : !!pool.quota;

  function done(answer: ParticipantAnswer) {
    setKey(crypto.randomUUID());
    setChoosing(false);
    setPaying(false);
    setProblem(null);
    onAnswer(pool.id, answer);
  }
  async function send(kind: "in" | "out") {
    setSending(kind);
    setProblem(null);
    try {
      if (!token) {
        done({
          kind,
          amountCents: null,
          proofSent: false,
          at: new Date().toISOString(),
        });
        return;
      }
      const { response } = await sendParticipantAnswer(
        token,
        rememberedPin(token),
        { poolId: pool.id, kind, amountCents: null, idempotencyKey: key },
      );
      done(toAnswer(response));
    } catch (failure) {
      setProblem({
        text: sendProblem(failure),
        retry: () => void send(kind),
      });
    } finally {
      setSending(null);
    }
  }
  const spinner = <LoaderCircle aria-hidden="true" className="spin" />;
  const choices = (
    <div className="answer-actions">
      {!inside && (
        <Button
          disabled={!!sending}
          icon={sending === "in" ? spinner : <Check aria-hidden="true" />}
          onClick={() => void send("in")}
        >
          Estou dentro
        </Button>
      )}
      {inside && (
        <Button
          disabled={!!sending}
          icon={<Check aria-hidden="true" />}
          onClick={() => setPaying(true)}
        >
          Já paguei
        </Button>
      )}
      {current?.kind !== "out" && (
        <Button
          variant="ghost"
          disabled={!!sending}
          icon={sending === "out" ? spinner : <X aria-hidden="true" />}
          onClick={() => void send("out")}
        >
          Desta vez estou fora
        </Button>
      )}
    </div>
  );
  return (
    <Card className="pool-card" label="Sua resposta">
      <div className="pool-card-head">
        <Eyebrow>Sua resposta</Eyebrow>
        {current?.kind === "in" && <Chip status="confirmed">Dentro</Chip>}
        {current?.kind === "paid" && <Chip status="pending">Pix avisado</Chip>}
        {current?.kind === "out" && <Chip family>Fora</Chip>}
      </div>
      {current && (
        <p className="answer-line">
          {current.kind === "in" && "Você disse que está dentro"}
          {current.kind === "out" && "Você disse que desta vez está fora"}
          {current.kind === "paid" && (
            <>
              Você avisou um Pix de{" "}
              <b>{formatBRL(current.amountCents ?? "0")}</b>
              {current.proofSent && ", com comprovante"}
            </>
          )}
          <span className="ui-sec">{` · ${quando(current.at)}`}</span>
        </p>
      )}
      {current?.kind === "paid" && (
        <p className="ui-sec">O tesoureiro confirma quando o dinheiro cair.</p>
      )}
      {!current && answerable && (
        <p className="answer-ask">
          {inside ? "Já pagou? Avise por aqui." : "Vai entrar nesta rodada?"}
        </p>
      )}
      {answerable && (choosing || !current) && choices}
      {answerable && current && !choosing && (
        <div className="answer-actions">
          {current.kind === "in" && (
            <Button
              icon={<Check aria-hidden="true" />}
              onClick={() => setPaying(true)}
            >
              Já paguei
            </Button>
          )}
          <Button variant="ghost" small onClick={() => setChoosing(true)}>
            Mudar resposta
          </Button>
        </div>
      )}
      {problem && (
        <>
          <ProblemBox title={problem.text} />
          <Button variant="ghost" small onClick={problem.retry}>
            Tentar de novo
          </Button>
        </>
      )}
      {paying && (
        <PaidDialog
          pool={pool}
          token={token}
          idempotencyKey={key}
          onDone={done}
          onClose={() => setPaying(false)}
        />
      )}
    </Card>
  );
}

function PoolCards(
  { pool, pix, token, onAnswer }: {
    pool: Pool;
    pix: PixReceiver | null;
    token: string | undefined;
    onAnswer: (poolId: string, answer: ParticipantAnswer) => void;
  },
) {
  // Depois do sorteio o que importa vem primeiro: o resultado e a parte da pessoa.
  const drawn = !!pool.result?.drawnNumbers.length;
  const outcome = (
    <>
      <ResultCard pool={pool} />
      {pool.share && (
        <ShareCard
          share={pool.share}
          internal={pool.participationMode === "internal"}
          result={pool.result}
          groupReserve={pool.groupReserveCents ?? null}
          groupPrizeLimit={pool.groupPrizeLimitCents ?? null}
        />
      )}
    </>
  );
  return (
    <div className="card-grid">
      {drawn && outcome}
      <AnswerCard pool={pool} token={token} onAnswer={onAnswer} />
      {pool.quota && <QuotaCard quota={pool.quota} />}
      <PayCard pool={pool} pix={pix} />
      <GamesCard pool={pool} />
      <RegistrationCard pool={pool} />
      {!drawn && outcome}
    </div>
  );
}

/** O aviso de boas-vindas fecha por pessoa neste aparelho; sem armazenamento, ele só some nesta visita. */
function Welcome({ personId }: { personId: string }) {
  const key = `little-faith:cartao-aviso:${personId}`;
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  if (closed) return null;
  return (
    <aside className="card-aviso" aria-label="Boas-vindas">
      <p className="card-aviso-titulo">Seu cartão do bolão</p>
      <button
        type="button"
        className="icon-button"
        aria-label="Fechar aviso"
        onClick={() => {
          setClosed(true);
          try {
            localStorage.setItem(key, "1");
          } catch {
            // Sem armazenamento o aviso volta na próxima visita; o cartão segue igual.
          }
        }}
      >
        <X aria-hidden="true" />
      </button>
      <p className="card-line">
        Aqui ficam sua cota, os jogos, o resultado e sua parte no prêmio, se
        houver. Guarde este link.
      </p>
    </aside>
  );
}

const PIN = /^\d{4}$/;
const pinKey = (token: string) => `little-faith:pin:${token}`;

/** O PIN fica neste aparelho para o cartão abrir sozinho; sem armazenamento, ele é pedido a cada visita. */
function rememberedPin(token: string) {
  try {
    return localStorage.getItem(pinKey(token));
  } catch {
    return null;
  }
}

function rememberPin(token: string, pin: string | null) {
  try {
    if (pin) localStorage.setItem(pinKey(token), pin);
    else localStorage.removeItem(pinKey(token));
  } catch {
    // Sem armazenamento o PIN é pedido de novo na próxima visita; o cartão segue igual.
  }
}

const isPinError = (error: unknown): error is ParticipantApiError =>
  error instanceof ParticipantApiError &&
  (error.code === "pin_required" || error.code === "pin_wrong" ||
    error.code === "pin_locked");

/** O texto de um PIN recusado (errado ou bloqueado), o mesmo no portão e nas janelas; sem texto para os outros erros. */
function pinProblem(error: ParticipantApiError) {
  if (error.code === "pin_wrong") {
    const left = error.attemptsLeft;
    if (left === undefined) return "PIN errado.";
    return left === 1
      ? "PIN errado. Resta 1 tentativa."
      : `PIN errado. Restam ${left} tentativas.`;
  }
  if (error.code === "pin_locked") {
    const at = error.retryAt ? new Date(error.retryAt) : null;
    if (!at || Number.isNaN(at.getTime())) {
      return "Muitas tentativas erradas. Tente de novo mais tarde.";
    }
    const time = new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
    return `Muitas tentativas erradas. Tente de novo depois das ${time}.`;
  }
  return null;
}

function PinInput(
  { label, value, onChange }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
  },
) {
  return (
    <label>
      {label}
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        pattern="[0-9]{4}"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      />
    </label>
  );
}

/** O portão do cartão com PIN: pede os 4 números e só então o cartão abre. */
function PinGate(
  { message, onOpen }: {
    message: string | null;
    onOpen: (pin: string) => Promise<void>;
  },
) {
  const [value, setValue] = useState("");
  const [short, setShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = short ? "O PIN tem 4 números." : message;
  return (
    <form
      className="card-state card-pin"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setShort(!PIN.test(value));
        if (!PIN.test(value)) return;
        setBusy(true);
        void onOpen(value).finally(() => {
          setBusy(false);
          setValue("");
        });
      }}
    >
      <h1 className="pool-card-title">Este cartão tem PIN</h1>
      <PinInput label="PIN de 4 números" value={value} onChange={setValue} />
      {problem && <p className="form-error" role="alert">{problem}</p>}
      <Button type="submit" disabled={busy}>Abrir</Button>
      <p className="ui-sec">
        Esqueceu? Peça um link novo para quem organiza o bolão.
      </p>
    </form>
  );
}

/** Criar, trocar ou tirar o PIN do cartão; para trocar ou tirar, o PIN de agora é pedido. */
function PinDialog(
  { token, mode, pinSet, onDone, onClose }: {
    token: string;
    mode: "set" | "remove";
    pinSet: boolean;
    onDone: (pinSet: boolean) => void;
    onClose: () => void;
  },
) {
  // O PIN de agora é sempre pedido para trocar ou tirar, mesmo no aparelho que o guarda para abrir o cartão.
  const [asksCurrent, setAsksCurrent] = useState(pinSet);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const removing = mode === "remove";

  async function run() {
    if (asksCurrent && !PIN.test(current)) {
      setError("Digite o PIN atual, com 4 números.");
      return;
    }
    if (!removing && !PIN.test(next)) {
      setError("O novo PIN precisa ter 4 números.");
      return;
    }
    if (!removing && next !== again) {
      setError("Os dois PINs não são iguais.");
      return;
    }
    const pin = removing ? null : next;
    setBusy(true);
    setError("");
    try {
      const result = await setParticipantPin(
        token,
        pin,
        asksCurrent ? current : null,
      );
      rememberPin(token, pin);
      onDone(result.pinSet);
    } catch (failure) {
      if (failure instanceof ParticipantApiError && failure.code === "pin_required") {
        // Outro aparelho criou um PIN enquanto este cartão estava aberto: a janela passa a pedir o atual.
        setAsksCurrent(true);
      }
      setError(
        failure instanceof ParticipantApiError
          ? pinProblem(failure) ?? failure.message
          : "Sem conexão. Tente de novo.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={removing ? "Tirar o PIN" : pinSet ? "Trocar PIN" : "Criar PIN"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void run();
        }}
      >
        {removing && (
          <p className="ui-sec">
            Sem o PIN, quem abrir este link vê o cartão.
          </p>
        )}
        {asksCurrent && (
          <PinInput label="PIN atual" value={current} onChange={setCurrent} />
        )}
        {!removing && (
          <>
            <PinInput label="Novo PIN" value={next} onChange={setNext} />
            <PinInput label="Repita o PIN" value={again} onChange={setAgain} />
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <Button
            type="submit"
            disabled={busy}
            icon={busy
              ? <LoaderCircle aria-hidden="true" className="spin" />
              : <Check aria-hidden="true" />}
          >
            {busy ? "Salvando…" : removing ? "Tirar o PIN" : "Salvar PIN"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** O fim do cartão: a pessoa cria, troca ou tira o PIN que protege este link. */
function PinCard({ token, initial }: { token: string; initial: boolean }) {
  const [pinSet, setPinSet] = useState(initial);
  const [dialog, setDialog] = useState<"set" | "remove" | null>(null);
  return (
    <>
      <Card className="pool-card card-protect" label="Proteger meu cartão">
        <Eyebrow>Proteger meu cartão</Eyebrow>
        {pinSet
          ? (
            <>
              <p className="card-line">Seu cartão está protegido com PIN.</p>
              <div className="ui-pair">
                <Button variant="ghost" small onClick={() => setDialog("set")}>
                  Trocar PIN
                </Button>
                <Button
                  variant="ghost"
                  small
                  onClick={() => setDialog("remove")}
                >
                  Tirar o PIN
                </Button>
              </div>
            </>
          )
          : (
            <>
              <p className="card-line">
                Crie um PIN de 4 números. Quem abrir este link em outro celular
                vai precisar dele.
              </p>
              <Button variant="ghost" small onClick={() => setDialog("set")}>
                Criar PIN
              </Button>
            </>
          )}
      </Card>
      {dialog && (
        <PinDialog
          token={token}
          mode={dialog}
          pinSet={pinSet}
          onDone={(value) => {
            setPinSet(value);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

/** O cartão da pessoa: os bolões do grupo em que ela tem cota, o mais novo aberto e os outros recolhidos. */
export function CartaoParticipante(
  { card, token, onAnswer = () => {} }: {
    card: ParticipantCard;
    token?: string | undefined;
    onAnswer?: (poolId: string, answer: ParticipantAnswer) => void;
  },
) {
  const [first, ...others] = card.pools;
  // Servidor anterior à chave Pix no cartão: sem o campo, sem o cartão de pagar.
  const pix = card.group.pix ?? null;
  const you = (
    <p className="card-you">
      Você: <b>{card.person.name}</b>
    </p>
  );
  return (
    <>
      <Welcome personId={card.person.id} />
      <Eyebrow>{card.group.name}</Eyebrow>
      {first
        ? (
          <section className="card-pool" aria-label={first.title}>
            <div>
              <PoolHead pool={first} as="h1" />
              {you}
            </div>
            <PoolCards
              pool={first}
              pix={pix}
              token={token}
              onAnswer={onAnswer}
            />
          </section>
        )
        : (
          <p className="card-line card-empty">
            Nenhum bolão aberto para você neste grupo por enquanto.
          </p>
        )}
      {!!others.length && (
        <div className="card-others">
          <Eyebrow>Outros bolões</Eyebrow>
          {others.map((pool) => (
            <details className="card-more" key={pool.id}>
              <summary className="ui-card interactive" onClick={unfoldDetails}>
                <span>
                  <PoolHead pool={pool} />
                </span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <div className="card-pool">
                {you}
                <PoolCards
                  pool={pool}
                  pix={pix}
                  token={token}
                  onAnswer={onAnswer}
                />
              </div>
            </details>
          ))}
        </div>
      )}
      {token && typeof card.pinSet === "boolean" && (
        <PinCard token={token} initial={card.pinSet} />
      )}
    </>
  );
}

type Load =
  | { state: "loading" }
  | { state: "ready"; card: ParticipantCard }
  | { state: "pin"; message: string | null }
  | { state: "failed"; title: string; line?: string; retry?: boolean };

const OFFLINE: Load = {
  state: "failed",
  title: "Este cartão precisa de conexão.",
  line: "Conecte-se à internet e tente de novo.",
  retry: true,
};

function failure(error: unknown): Load {
  if (!navigator.onLine || error instanceof TypeError) return OFFLINE;
  if (isPinError(error)) {
    return { state: "pin", message: pinProblem(error) };
  }
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
  // A resposta registrada entra no cartão aberto, sem buscar tudo de novo.
  const answered = (poolId: string, answer: ParticipantAnswer) =>
    setLoad((previous) =>
      previous.state === "ready"
        ? {
          state: "ready",
          card: {
            ...previous.card,
            pools: previous.card.pools.map((pool) =>
              pool.id === poolId ? { ...pool, response: answer } : pool
            ),
          },
        }
        : previous
    );
  const open = (pin: string) =>
    fetchParticipantCard(token, pin).then(
      (card) => {
        rememberPin(token, pin);
        setLoad({ state: "ready", card });
      },
      (error) => setLoad(failure(error)),
    );
  useEffect(() => {
    let active = true;
    if (!token) {
      setLoad(failure(new ParticipantApiError("", 404)));
    } else if (token === "demo") {
      setLoad({ state: "ready", card: demoParticipantCard() });
    } else if (!navigator.onLine) {
      setLoad(OFFLINE);
    } else {
      const saved = rememberedPin(token);
      fetchParticipantCard(token, saved ?? undefined).then(
        (card) => active && setLoad({ state: "ready", card }),
        (error) => {
          if (!active) return;
          if (saved && isPinError(error) && error.code === "pin_wrong") {
            // O PIN guardado já não vale (foi trocado em outro aparelho): esquece e pede de novo, sem culpar quem não digitou.
            rememberPin(token, null);
            setLoad({ state: "pin", message: null });
          } else setLoad(failure(error));
        },
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
          <BrandMark />
          <span>
            little <em>faith</em>
          </span>
        </header>
        <main className="card-main">
          {token === "demo" && (
            <p className="ui-sec pool-sub">
              Cartão de exemplo ·{" "}
              <a className="pool-link" href={`#/boloes/${id(10)}/arrecadar`}>
                voltar ao bolão
              </a>
            </p>
          )}
          {load.state === "loading" && (
            <div className="loading">
              <LoaderCircle className="spin" aria-hidden="true" />Abrindo seu
              cartão…
            </div>
          )}
          {load.state === "ready" && (
            <CartaoParticipante
              card={load.card}
              token={token === "demo" ? undefined : token}
              onAnswer={answered}
            />
          )}
          {load.state === "pin" && (
            <PinGate message={load.message} onOpen={open} />
          )}
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
