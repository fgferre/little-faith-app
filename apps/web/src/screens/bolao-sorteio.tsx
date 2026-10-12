import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CalendarClock,
  Copy,
  Download,
  MessageCircle,
  RefreshCw,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  assessRegisteredPrizes,
  brasiliaDateTimeToUTC,
  createResultView,
  formatBRL,
  LOTTERIES,
  parseBRL,
  readCaixaExtras,
} from "@bolao/core";
import type {
  ContestResultVersion,
  LocalRecord,
  LotteryId,
  PoolManifest,
  RegisteredPrize,
  ResultAction,
} from "@bolao/core";
import {
  collectResults,
  getRegistrationSnapshot,
  getResultSnapshot,
} from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { createAccountTransport } from "../auth";
import { downloadText } from "../registration-handoff";
import type { RecordRequest } from "../record-decision";
import type { Notice, PoolStep, Snapshot } from "../app-shared";
import {
  ampliado,
  autores,
  AUTORIA,
  Balls,
  Button,
  Card,
  Chip,
  copiar,
  Countdown,
  Disclosure,
  Eyebrow,
  formatWhen,
  GameGroups,
  Money,
  porAutor,
  ProblemBox,
  reais,
  renderShareCard,
  shareCardFileName,
  shareCardImage,
} from "../ui";
import type { ShareCardData } from "../ui";
const BRASILIA = "America/Sao_Paulo";
const prizeHits = {
  "mega-sena": [6, 5, 4],
  lotofacil: [15, 14, 13, 12, 11],
  quina: [5, 4, 3, 2],
} as const;
const TIER: Record<LotteryId, (hits: number) => string> = {
  "mega-sena": (h) => ({ 4: "quadra", 5: "quina", 6: "sena" })[h] ?? "",
  quina: (h) => ({ 2: "duque", 3: "terno", 4: "quadra", 5: "quina" })[h] ?? "",
  lotofacil: (h) => `${h} pontos`,
};
/** "Acertamos a quadra!" · "Acertamos o terno!" · "Acertamos 13 pontos!" */
function winTitle(lotteryId: LotteryId, hits: number) {
  const tier = TIER[lotteryId](hits);
  if (lotteryId === "lotofacil") return `Acertamos ${tier}!`;
  return `Acertamos ${tier === "duque" || tier === "terno" ? "o" : "a"} ${tier}!`;
}
/** Selo do jogo premiado: "Quadra!" · "Terno!" · "13 acertos!" */
function winTag(lotteryId: LotteryId, hits: number) {
  if (lotteryId === "lotofacil") return `${hits} acertos!`;
  const tier = TIER[lotteryId](hits);
  return `${tier[0]!.toUpperCase()}${tier.slice(1)}!`;
}
const bestTier = (game: RegisteredPrize) =>
  Math.max(
    0,
    ...game.tiers.filter((tier) => tier.combinations !== "0").map((tier) =>
      tier.hits
    ),
  );
const acertos = (n: number) => `${n} ${n === 1 ? "acerto" : "acertos"}`;
const pad = (n: number) => String(n).padStart(2, "0");
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível consultar o resultado.";
const short = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));

/** "sáb 20h" no fuso pedido. */
function dayHour(instant: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  return {
    day: parts.weekday!.replace(".", ""),
    hour: `${+parts.hour!}h${parts.minute === "00" ? "" : parts.minute}`,
  };
}
/** "sáb 20h Brasília · 18h aqui" (sem o "aqui" quando o fuso é o mesmo horário). */
function drawLine(instant: string, timeZone: string) {
  const br = dayHour(instant, BRASILIA);
  const here = dayHour(instant, timeZone);
  const text = `${br.day} ${br.hour} Brasília`;
  if (here.day === br.day && here.hour === br.hour) return text;
  return `${text} · ${
    here.day === br.day ? here.hour : `${here.day} ${here.hour}`
  } aqui`;
}
const sourceLine = (result: ContestResultVersion, timeZone: string) =>
  result.source === "caixa"
    ? `CAIXA · coletado em ${short(result.collectedAt, timeZone)}`
    : `Informado manualmente · fonte: ${result.sourceReference}`;

/** Resultados que já apareceram nesta sessão não caem nem contam de novo ao voltar à etapa. */
const revealed = new Set<string>();
function useFirstReveal(id: string | undefined) {
  const [first, setFirst] = useState(() =>
    id && !revealed.has(id) ? id : null
  );
  if (id && id !== first && !revealed.has(id)) setFirst(id);
  useEffect(() => {
    if (id) revealed.add(id);
  }, [id]);
  return !!id && first === id;
}

interface Game {
  key: string;
  name: string;
  authorIds: readonly string[];
  numbers: number[];
  prize?: RegisteredPrize;
}

export function BolaoSorteio(
  {
    db,
    groupId,
    snapshot,
    pool,
    poolBets,
    manifest,
    enabled,
    availability,
    timeZone,
    open,
    setNotice,
    go,
    repeat,
  }: {
    db: BolaoDatabase;
    groupId: string;
    snapshot: Snapshot;
    pool: LocalRecord<"pool">;
    poolBets: LocalRecord<"bet">[];
    manifest: PoolManifest | null;
    enabled: boolean;
    availability: string;
    timeZone: string;
    open: (request: RecordRequest) => void;
    setNotice: (notice: Notice) => void;
    go: (step: PoolStep) => void;
    repeat: () => void;
  },
) {
  const scope = `${db.name}:${groupId}:${pool.id}`;
  const raw = useLiveQuery(async () => ({
    scope,
    results: await getResultSnapshot(db, groupId),
    registrations: await getRegistrationSnapshot(db, groupId),
    attempts: await db.resultCollectionAttempts.where("[groupId+poolId]")
      .equals([groupId, pool.id]).toArray(),
  }), [db, groupId, pool.id]);
  const local = raw?.scope === scope ? raw : undefined;
  const indexed = useMemo(
    () => local?.results ? createResultView(local.results) : null,
    [local?.results],
  );
  const view = indexed?.currentResult(pool.id) ?? null;
  const calendar = indexed?.currentCalendar(pool.id) ?? null;
  const report = local?.registrations?.reports.filter((item) =>
    item.poolId === pool.id
  ).sort((a, b) => b.version - a.version)[0];
  const assessment = report && view
    ? assessRegisteredPrizes(report, view)
    : null;
  const versions =
    local?.results?.results.filter((item) => item.poolId === pool.id).sort((
      a,
      b,
    ) => b.version - a.version) ?? [];
  const lastAttempt = local?.attempts.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [reason, setReason] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function collect() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      await collectResults(
        db,
        createAccountTransport(db.accountId),
        groupId,
        pool.id,
      );
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const lotteryId = pool.data.lotteryId;
  const rule = LOTTERIES[lotteryId];
  const conflict = view?.status === "conflict";
  const result = view?.result ?? null;
  const drawn = !conflict ? result?.drawnNumbers ?? null : null;
  const hits = drawn ? new Set(drawn) : undefined;
  const plan = (local?.registrations?.manifests.find((item) =>
    item.id === report?.manifestId
  ) ?? manifest)?.content;

  // Quem fez cada jogo: pela trava, senão pelos jogos do bolão.
  const sameNumbers = (a: number[], b: number[]) =>
    a.length === b.length && a.every((n, i) => n === b[i]);
  const nameOf = (personId: string) => {
    const person = plan?.persons.find((p) => p.id === personId) ??
      snapshot.persons.find((p) => p.id === personId);
    return person
      ? (person.data.nickname || person.data.name).split(" ")[0]!
      : null;
  };
  const authorIdsOf = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const planned = plan?.plan.bets.find((bet) =>
      sameNumbers([...bet.numbers].sort((a, b) => a - b), sorted)
    );
    const bet = poolBets.find((item) =>
      sameNumbers([...item.data.numbers].sort((a, b) => a - b), sorted)
    );
    return planned?.authorIds ?? bet?.data.authorIds ?? [];
  };
  const toGame = (key: string, numbers: number[], prize?: RegisteredPrize) => {
    const authorIds = authorIdsOf(numbers);
    return {
      key,
      name: autores(authorIds, nameOf) ?? "Jogo da turma",
      authorIds,
      numbers,
      ...(prize ? { prize } : {}),
    };
  };
  const assessed = assessment && !conflict && assessment.status !== "waiting";
  const games: Game[] = assessed
    ? assessment.games.map((prize) =>
      toGame(
        `${prize.plannedTicketKey}:${prize.observedBetIndex}`,
        prize.numbers,
        prize,
      )
    )
    : (plan?.plan.bets.map((bet) => bet.numbers) ??
      poolBets.map((bet) => bet.data.numbers)).map((numbers, index) =>
        toGame(String(index), numbers)
      );
  const wins = (game: Game) => !!game.prize && bestTier(game.prize) > 0;
  const winners = games.filter(wins);
  const ordered = [...winners, ...games.filter((game) => !wins(game))];
  // Por quem escolheu, os sem autor no fim; o grupo com jogo premiado vem antes dos outros.
  const groups = porAutor(ordered, (game) => game.authorIds, nameOf)
    .map((group, index) => ({ group, index, win: group.games.some(wins) }))
    .sort((a, b) => Number(b.win) - Number(a.win) || a.index - b.index)
    .map(({ group }) => group);
  const best = [...games].sort((a, b) =>
    (b.prize?.hits ?? 0) - (a.prize?.hits ?? 0)
  )[0];
  const top = Math.max(0, ...winners.map((game) => bestTier(game.prize!)));
  const prizeCents = assessed ? assessment.calculatedPrizeCents : null;

  const drawAt = calendar?.contestNumber === pool.data.contestNumber
    ? calendar?.expectedDrawAt ?? null
    : null;
  const next = local?.results?.calendarVersions.filter((item) =>
    item.lotteryId === lotteryId && item.expectedDrawAt &&
    item.contestNumber > (pool.data.contestNumber ?? Infinity) &&
    Date.parse(item.expectedDrawAt) > Date.now()
  ).sort((a, b) => a.expectedDrawAt!.localeCompare(b.expectedDrawAt!))[0];
  // Só o resultado oficial diz se acumulou; com o resultado informado à mão nada muda.
  const caixa = useMemo(
    () => result?.source === "caixa" ? readCaixaExtras(result.rawText) : null,
    [result],
  );
  const rolled = !!drawn && caixa?.accumulated === true &&
    top < prizeHits[lotteryId][0];
  const nextNumber = caixa?.nextContestNumber ?? (result?.contestNumber ?? 0) + 1;

  // Divisão igual só no acordo interno, com as mesmas cotas para todos e centavos exatos.
  const split = (() => {
    if (!plan || prizeCents === null || plan.plan.participationMode !== "internal") {
      return null;
    }
    const units = new Map<string, number>();
    for (const right of plan.plan.rights) {
      units.set(right.personId, (units.get(right.personId) ?? 0) + right.units);
    }
    const values = [...units.values()];
    const people = BigInt(values.length);
    if (!people || values.some((n) => n !== values[0])) return null;
    if (BigInt(prizeCents) % people !== 0n) return null;
    return { each: (BigInt(prizeCents) / people).toString(), people: values.length };
  })();

  const firstReveal = useFirstReveal(drawn ? result?.id : undefined);

  // Mensagem de texto para o grupo: antes do sorteio, os jogos; depois, o resultado.
  function message() {
    const head = `${pool.data.title} · ${rule.label}${
      pool.data.contestNumber ? ` · concurso ${pool.data.contestNumber}` : ""
    }`;
    if (!drawn) {
      return [
        head,
        drawAt
          ? `Sorteio: ${drawLine(drawAt, BRASILIA)}`
          : "Sorteio a definir.",
        `${games.length} ${games.length === 1 ? "jogo" : "jogos"} no bolão.`,
      ].join("\n");
    }
    const lines = [
      head,
      `Números sorteados: ${drawn.map(pad).join(" ")}`,
      "",
      ...(winners.length
        ? [
          winTitle(lotteryId, top),
          ...winners.slice(0, 3).map((game) =>
            `• ${game.name}: ${acertos(game.prize!.hits)} (${
              winTag(lotteryId, bestTier(game.prize!))
            })`
          ),
          ...(prizeCents !== null
            ? [
              `Prêmio calculado: ${formatBRL(prizeCents)}${
                split
                  ? ` · ${formatBRL(split.each)} para cada um`
                  : ""
              }. Ainda não é dinheiro recebido.`,
            ]
            : ["O valor do prêmio ainda não foi publicado."]),
        ]
        : [
          "Não foi dessa vez.",
          ...(best?.prize
            ? [`Melhor jogo: ${best.name}, ${acertos(best.prize.hits)}.`]
            : []),
        ]),
    ];
    return lines.join("\n");
  }

  // O cartão leva só apelidos e jogos: nada de pagamento. Ele vai para a turma no Brasil, então
  // datas e horas saem no horário de Brasília (a tela continua mostrando Brasília e o horário daqui).
  function shareCard(): ShareCardData {
    const date = drawAt
      ? new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: BRASILIA,
      }).format(new Date(drawAt))
      : /^\d{4}-\d{2}-\d{2}$/.test(result?.drawDate ?? "")
      ? result!.drawDate!.slice(5).split("-").reverse().join("/")
      : pool.data.contestNumber
      ? `concurso ${pool.data.contestNumber}`
      : null;
    const count = `${games.length} ${games.length === 1 ? "jogo" : "jogos"}`;
    return {
      title: pool.data.title,
      modality: lotteryId,
      chip: date ? `${rule.label} · ${date}` : rule.label,
      drawn,
      groups: groups.map((group) => ({
        label: group.label,
        games: group.games.map((game) => {
          const tier = game.prize ? bestTier(game.prize) : 0;
          return {
            numbers: game.numbers,
            tag: hits && tier > 0 ? winTag(lotteryId, tier) : undefined,
            hits: hits && tier === 0
              ? acertos(game.numbers.filter((n) => hits.has(n)).length)
              : undefined,
            size: game.numbers.length > rule.minNumbers
              ? `${game.numbers.length} dezenas`
              : undefined,
          };
        }),
      })),
      result: !drawn
        ? {
          title: drawAt
            ? `Sorteio ${formatWhen(Date.parse(drawAt), Date.now(), BRASILIA)}`
            : "Sorteio a definir",
          detail: count,
        }
        : winners.length
        ? {
          title: winTitle(lotteryId, top),
          value: prizeCents !== null ? formatBRL(prizeCents) : "Valor a confirmar",
        }
        : {
          title: "Não foi dessa vez.",
          detail: best?.prize
            ? `Melhor jogo: ${best.name}, ${acertos(best.prize.hits)}`
            : count,
        },
    };
  }
  const [share, setShare] = useState<
    { card: ShareCardData; text: string } | null
  >(null);
  const openShare = () => setShare({ card: shareCard(), text: message() });
  const sheet = share && (
    <ShareSheet
      card={share.card}
      text={share.text}
      setNotice={setNotice}
      onClose={() => setShare(null)}
    />
  );
  const tellButton = (
    <Button
      variant="ghost"
      icon={<MessageCircle aria-hidden="true" />}
      onClick={openShare}
    >
      Avisar a turma
    </Button>
  );

  const gameRow = (game: Game) => {
    const tier = game.prize ? bestTier(game.prize) : 0;
    return (
      <li className="pool-game" key={game.key}>
        <Balls
          numbers={game.numbers}
          detail={ampliado(lotteryId, game.numbers.length)}
          hits={hits}
          winner={tier > 0}
          note={!hits ? undefined : tier > 0
            ? <span className="ui-tag">{winTag(lotteryId, tier)}</span>
            : (
              <span className="ui-hits">
                {acertos(game.numbers.filter((n) => hits.has(n)).length)}
              </span>
            )}
        />
      </li>
    );
  };

  const failed = error ?? (lastAttempt?.status === "failed"
    ? lastAttempt.message ?? ""
    : null);
  const failure = failed !== null && (
    <div className="pool-fail" role="alert">
      <Chip status="pending">Última consulta falhou</Chip>
      <p className="ui-sec">
        {failed} {result
          ? "O último resultado válido continua valendo."
          : "Tente de novo mais tarde."}
      </p>
    </div>
  );
  const actions = (small: boolean) => (
    <div className="pool-actions">
      <Button
        variant={small ? "ghost" : "primary"}
        small={small}
        icon={
          <RefreshCw aria-hidden="true" className={busy ? "spin" : undefined} />
        }
        disabled={!enabled || busy || !pool.data.contestNumber}
        onClick={() => void collect()}
      >
        Consultar resultado da CAIXA
      </Button>
      <Button
        variant="ghost"
        small={small}
        aria-expanded={manualOpen}
        onClick={() => setManualOpen((value) => !value)}
      >
        Informar resultado
      </Button>
    </div>
  );
  const offline = !enabled && (
    <p className="ui-sec pool-note">
      {availability} O último resultado guardado continua neste aparelho.
    </p>
  );
  const extras = (
    <>
      <Disclosure summary="Horários do concurso">
        <dl className="pool-facts">
          {[
            ["Prazo do grupo", pool.data.deadlineAt],
            ["Fim das apostas na CAIXA", calendar?.registrationClosesAt ?? null],
            ["Sorteio", calendar?.expectedDrawAt ?? null],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {value
                  ? (
                    <>
                      {short(value, BRASILIA)} Brasília
                      {timeZone !== BRASILIA && (
                        <>
                          <br />
                          {short(value, timeZone)} {timeZone === "UTC"
                            ? "UTC"
                            : `aqui (${timeZone})`}
                        </>
                      )}
                    </>
                  )
                  : "A definir"}
              </dd>
            </div>
          ))}
        </dl>
        {calendar && <p>Fonte dos horários: {calendar.sourceReference}</p>}
        <CalendarForm
          key={scope}
          db={db}
          pool={pool}
          enabled={enabled}
          open={open}
        />
      </Disclosure>
      {!!versions.length && (
        <Disclosure summary="Detalhes técnicos">
          {versions.map((item) => (
            <div className="pool-version" key={item.id}>
              <strong>
                Versão {item.version} ·{" "}
                {item.source === "caixa" ? "CAIXA" : "informada"} ·{" "}
                {short(item.collectedAt, timeZone)}
              </strong>
              <p>{item.sourceReference}</p>
              {item.drawnNumbers
                ? (
                  <Balls
                    numbers={item.drawnNumbers}
                    hits={new Set(item.drawnNumbers)}
                    winner
                    size="sm"
                  />
                )
                : <p>Números ainda não publicados.</p>}
              {item.payouts?.map((tier) => (
                <p key={tier.hits}>
                  {acertos(tier.hits)}: {tier.prizeCents === null
                    ? "valor ainda não publicado"
                    : formatBRL(tier.prizeCents)} ·{" "}
                  {tier.winnerCount === null
                    ? "ganhadores ainda não publicados"
                    : `${tier.winnerCount} ganhador(es)`}
                </p>
              ))}
              <p className="manifest-hash">
                Código de verificação: {item.sha256}
              </p>
              <Button
                variant="ghost"
                small
                icon={<Download aria-hidden="true" />}
                onClick={() =>
                  downloadText(
                    item.rawText,
                    `fonte-resultado-${item.contestNumber}-v${item.version}.json`,
                    "application/json",
                  )}
              >
                Baixar fonte guardada
              </Button>
            </div>
          ))}
        </Disclosure>
      )}
    </>
  );
  const manualCard = manualOpen && (
    <Card className="pool-card" label="Informar resultado">
      <Eyebrow>Informar resultado</Eyebrow>
      <ManualForm
        key={scope}
        db={db}
        pool={pool}
        enabled={enabled}
        open={open}
      />
    </Card>
  );
  const gamesList = <GameGroups groups={groups} row={gameRow} />;
  const stageHead = (
    <>
      <p className="sorteio-eyebrow">A torcida é de todo mundo.</p>
      <p className="sorteio-frase">Uma pequena dose de fé.</p>
    </>
  );

  if (!drawn && !conflict) {
    const future = drawAt !== null && Date.parse(drawAt) > Date.now();
    return (
      <div className="pool-cols">
        <Card className="pool-card sorteio-palco" label="Sorteio">
          {stageHead}
          <p className="sorteio-sub">Vamos conferir a sorte da turma?</p>
          <Eyebrow>{future ? "Sorteio em" : "Sorteio"}</Eyebrow>
          {future && drawAt
            ? <Countdown target={drawAt} timeZone={timeZone} />
            : (
              <h2 className="pool-card-title">
                {drawAt ? "Esperando o resultado" : "Sorteio a definir"}
              </h2>
            )}
          {drawAt && <p className="ui-sec">{drawLine(drawAt, timeZone)}</p>}
          {!pool.data.contestNumber && (
            <p className="ui-sec pool-note">
              Defina o concurso do bolão para consultar o resultado.
            </p>
          )}
          <div className="sorteio-detalhes">
            {!!games.length && (
              <>
                <p className="ui-sec pool-sub">
                  {games.length} {games.length === 1 ? "jogo" : "jogos"}
                  {plan && ` · ${reais(plan.plan.betCostCents)}`}
                </p>
                {gamesList}
                <div className="pool-actions">{tellButton}</div>
              </>
            )}
            {actions(false)}
            {failure}
            {offline}
            {extras}
          </div>
        </Card>
        {manualCard}
        {sheet}
      </div>
    );
  }

  const holderId = plan?.responsible.ticketHolderPersonId ?? null;
  const redeemLine = plan?.plan.participationMode === "official"
    ? "Cada pessoa resgata com o próprio recibo."
    : plan?.plan.participationMode === "internal"
    ? holderId
      ? `Quem resgata: ${
        nameOf(holderId) ?? "Participante"
      }, titular dos bilhetes. É quem leva o bilhete original à Caixa.`
      : "O bolão foi travado sem titular dos bilhetes."
    : null;
  // Espaço sem quebra no valor: "R$" não fica numa linha e o número na outra.
  const rollover = rolled && (
    <h2 className="pool-card-title sorteio-titulo">
      {caixa!.nextEstimatedPrizeCents !== null
        ? `Acumulou! Próximo prêmio estimado ${
          formatBRL(caixa!.nextEstimatedPrizeCents).replace(" ", "\u00a0")
        }`
        : "Acumulou!"}
    </h2>
  );
  const nextLine = next?.expectedDrawAt && (
    <p className="ui-sec">
      Próximo sorteio: {drawLine(next.expectedDrawAt, timeZone)}
    </p>
  );
  const prizeView = (
    <>
      {prizeCents !== null
        ? (
          <Money
            prize
            countUp={firstReveal}
            delay={drawn!.length * 70 + 250}
            cents={prizeCents}
          />
        )
        : <p className="pool-prize-pending">Valor a confirmar</p>}
      <p className="ui-sec">
        {prizeCents !== null ? "prêmio calculado" : assessment!.skippedTicketKeys.length
          ? "Há cartelas sem conferência; o valor sai quando todas forem conferidas."
          : "O valor de cada faixa ainda não foi publicado."}
      </p>
      {redeemLine && <p className="ui-sec">{redeemLine}</p>}
      {split
        ? (
          <p className="ui-sec">
            {formatBRL(split.each)} para cada um · {split.people} pessoas
          </p>
        )
        : prizeCents !== null && (
          <button
            type="button"
            className="pool-link"
            onClick={() => go("dividir")}
          >
            ver divisão
          </button>
        )}
    </>
  );
  const resultCard = (
    <Card className="pool-card pool-result" label="Resultado">
      <Eyebrow>Resultado</Eyebrow>
      {conflict
        ? (
          <>
            <h2 className="ui-title sorteio-titulo">Falta escolher o resultado</h2>
            <p className="ui-sec">
              O prêmio só é calculado depois que você escolher qual resultado
              vale.
            </p>
          </>
        )
        : !assessed
        ? (
          <>
            <h2 className="ui-title sorteio-titulo">Falta conferir o registro</h2>
            <p className="ui-sec">
              O prêmio é calculado só com os jogos que foram registrados de
              verdade.
            </p>
            <Button onClick={() => go("registrar")}>Ir para Registrar</Button>
          </>
        )
        : winners.length
        ? (
          <>
            <h2 className="ui-title sorteio-titulo">{winTitle(lotteryId, top)}</h2>
            {prizeView}
            {rollover}
            {rolled && nextLine}
            <div className="pool-actions">
              <Button onClick={() => go("dividir")}>Dividir o prêmio</Button>
              {tellButton}
            </div>
            <Disclosure summary="Ver cálculo">
              {winners.map((game) => (
                <p key={game.key}>
                  {game.name}: {game.prize!.tiers.filter((tier) =>
                    tier.combinations !== "0"
                  ).map((tier) =>
                    `${tier.combinations} × ${acertos(tier.hits)}`
                  ).join(" + ")} ·{" "}
                  {game.prize!.calculatedPrizeCents === null
                    ? "valor a confirmar"
                    : formatBRL(game.prize!.calculatedPrizeCents)}
                </p>
              ))}
              {!!assessment.skippedTicketKeys.length && (
                <p>
                  {assessment.skippedTicketKeys.length} cartela(s) sem
                  conferência ficam fora da conta.
                </p>
              )}
              <p>
                Prêmio calculado não é dinheiro recebido: o resgate e a divisão
                têm confirmações próprias.
              </p>
            </Disclosure>
          </>
        )
        : (
          <>
            <h2 className="ui-title sorteio-titulo">Não foi dessa vez.</h2>
            {best?.prize && (
              <p className="pool-best">
                Melhor jogo: <b>{best.name}</b>, {acertos(best.prize.hits)}
              </p>
            )}
            {!!assessment.skippedTicketKeys.length && (
              <p className="ui-sec">
                {assessment.skippedTicketKeys.length}{" "}
                cartela(s) sem conferência ficam fora da conta.
              </p>
            )}
            {rollover}
            {nextLine}
            <div className="pool-actions">
              <Button onClick={repeat}>
                {rolled
                  ? `Chamar a turma: concurso ${nextNumber}`
                  : "Repetir com a mesma turma"}
              </Button>
              {tellButton}
            </div>
          </>
        )}
    </Card>
  );

  return (
    <div className="pool-draw">
      <div className="pool-stack pool-draw-main">
        <Card className="pool-card sorteio-palco" label="Números sorteados">
          {stageHead}
          <Eyebrow>Números sorteados</Eyebrow>
          {drawn && (
            <>
              {lotteryId === "lotofacil" && (
                <p className="ui-sec pool-sub">
                  {rule.drawSize} de {rule.universeSize} · ganha quem acerta
                  {" "}
                  {prizeHits[lotteryId].at(-1)} ou mais
                </p>
              )}
              <div className="pool-drawn">
                <Balls
                  key={result!.id}
                  numbers={drawn}
                  hits={hits}
                  winner
                  reveal={firstReveal ? "drop" : undefined}
                />
              </div>
              <p className="ui-sec">{sourceLine(result!, timeZone)}</p>
            </>
          )}
          <div className="sorteio-detalhes">
            {conflict && (
              <>
                <ProblemBox title="Dois resultados não batem">
                  Escolha qual vale. O prêmio só é calculado depois disso.
                </ProblemBox>
                <fieldset className="pool-fieldset pool-form">
                  <legend>Qual resultado vale</legend>
                  {versions.filter((item) => item.drawnNumbers).map((item) => (
                    <label className="pool-choice" key={item.id}>
                      <input
                        type="radio"
                        name={`resultado-${pool.id}`}
                        value={item.id}
                        checked={chosen === item.id}
                        onChange={() => setChosen(item.id)}
                      />
                      <span>
                        <span className="ui-sec">{sourceLine(item, timeZone)}</span>
                        <Balls
                          numbers={item.drawnNumbers!}
                          hits={new Set(item.drawnNumbers)}
                          winner
                          size="sm"
                        />
                      </span>
                    </label>
                  ))}
                  <label>
                    Motivo da escolha<textarea
                      value={reason}
                      rows={2}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <Button
                    icon={<ShieldCheck aria-hidden="true" />}
                    disabled={!enabled || !chosen || !reason.trim()}
                    onClick={() =>
                      open({
                        family: "result",
                        action: {
                          type: "result_resolve",
                          poolId: pool.id,
                          poolVersion: pool.serverVersion,
                          resultId: chosen,
                          observedResultIds: versions.map((item) => item.id)
                            .sort(),
                          reason: reason.trim(),
                        },
                      })}
                  >
                    Revisar
                  </Button>
                </fieldset>
              </>
            )}
            {failure}
            <Disclosure summary="Atualizar o resultado">
              {actions(true)}
              {offline}
            </Disclosure>
            {extras}
          </div>
        </Card>
        {manualCard}
      </div>
      <div className="pool-draw-result">{resultCard}</div>
      <Card className="pool-card pool-draw-games" label="Nossos jogos">
        <Eyebrow>Nossos jogos</Eyebrow>
        <p className="ui-sec pool-sub">
          {games.length} {games.length === 1 ? "jogo" : "jogos"}
          {assessed
            ? ` · ${
              winners.length
                ? `${winners.length} ${
                  winners.length === 1 ? "premiado" : "premiados"
                }`
                : "nenhum premiado"
            }`
            : conflict
            ? ""
            : " · ainda sem a conferência do registro"}
        </p>
        <p className="ui-sec ui-authorship">{AUTORIA}</p>
        {gamesList}
      </Card>
      {sheet}
    </div>
  );
}

/**
 * "Avisar a turma": gaveta com a prévia do cartão (PNG 4:5) e duas saídas. No celular, a imagem vai
 * pelo compartilhar do sistema (WhatsApp aparece lá); no computador, ela é baixada.
 */
function ShareSheet(
  { card, text, setNotice, onClose }: {
    card: ShareCardData;
    text: string;
    setNotice: (notice: Notice) => void;
    onClose: () => void;
  },
) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let url = "";
    renderShareCard(card).then((blob) => {
      if (!alive) return;
      url = URL.createObjectURL(blob);
      setImage({ blob, url });
    }, () => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [card]);

  // Fecha a gaveta antes de copiar ou baixar: o aviso aparece por cima da tela, não atrás da gaveta.
  const leave = () => {
    ref.current?.close();
    onClose();
  };
  async function shareImage() {
    if (!image) return;
    const outcome = await shareCardImage(
      image.blob,
      shareCardFileName(card.title),
      card.title,
    );
    if (outcome === "cancelled") return;
    leave();
    if (outcome === "downloaded") {
      setNotice({ text: "Imagem baixada. Envie no grupo do WhatsApp." });
    }
  }
  async function copyText() {
    leave();
    const copied = await copiar(text);
    setNotice(
      copied
        ? { text: "Mensagem copiada. Cole no grupo do WhatsApp." }
        : { text: "Não deu para copiar a mensagem. Tente de novo.", error: true },
    );
  }

  const alt = `Cartão: ${card.title}, ${card.result.title}${
    card.result.value ? ` ${card.result.value}` : ""
  }`;
  return (
    <dialog
      ref={ref}
      className="ui-sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="ui-sheet-body">
        <div className="ui-sheet-handle" aria-hidden="true" />
        <header className="ui-sheet-head">
          <h2 id={titleId}>Avisar a turma</h2>
          <button
            type="button"
            className="ui-sheet-x"
            aria-label="Fechar"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <p className="ui-sec">Este cartão vai como imagem para o grupo.</p>
        {image
          ? (
            <img
              className="ui-sheet-card"
              src={image.url}
              width={1080}
              height={1350}
              alt={alt}
            />
          )
          : (
            <div className="ui-sheet-card wait" role="status">
              <span className="ui-hidden">
                {failed ? "Não deu para montar a imagem." : "Montando a imagem…"}
              </span>
            </div>
          )}
        {failed && (
          <p className="ui-sec" role="alert">
            Não deu para montar a imagem. Copie a mensagem de texto.
          </p>
        )}
        <div className="ui-sheet-actions">
          <Button
            icon={<Share2 aria-hidden="true" />}
            disabled={!image}
            onClick={() => void shareImage()}
          >
            Compartilhar imagem
          </Button>
          <Button
            variant="ghost"
            icon={<Copy aria-hidden="true" />}
            onClick={() => void copyText()}
          >
            Copiar mensagem
          </Button>
        </div>
        <p className="ui-sec ui-sheet-note">
          Ninguém vê dados de pagamento na imagem.
        </p>
      </div>
    </dialog>
  );
}

interface ResultDraft {
  numbers: string;
  date: string;
  source: string;
  reason: string;
  payouts: Record<string, { amount: string; winners: string }>;
  calendarDate: string;
  drawAt: string;
  closesAt: string;
  calendarSource: string;
  calendarReason: string;
}
const initialDraft: ResultDraft = {
  numbers: "",
  date: "",
  source: "",
  reason: "",
  payouts: {},
  calendarDate: "",
  drawAt: "",
  closesAt: "",
  calendarSource: "",
  calendarReason: "",
};

/** O que a pessoa digitou fica guardado no aparelho até a revisão; resultado e horários dividem o mesmo registro. */
function useResultDraft(db: BolaoDatabase, pool: LocalRecord<"pool">) {
  const key = `result-draft:${pool.groupId}:${pool.id}`;
  const [draft, setDraft] = useState<ResultDraft>(initialDraft);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    void db.metadata.get(key).then((item) => {
      if (active) {
        if (item) setDraft({ ...initialDraft, ...item.value as ResultDraft });
        setLoaded(true);
      }
    }).catch((failure) => {
      if (active) setError(errorMessage(failure));
    });
    return () => {
      active = false;
    };
  }, [db, key]);
  function update(fields: Partial<ResultDraft>) {
    setDraft((current) => ({ ...current, ...fields }));
    setError(null);
    // Os dois formulários gravam no mesmo registro: cada um mexe só nos seus campos.
    writes.current = writes.current.then(async () => {
      const saved = (await db.metadata.get(key))?.value as
        | ResultDraft
        | undefined;
      await db.metadata.put({
        key,
        value: structuredClone({ ...initialDraft, ...saved, ...fields }),
      });
    }).catch((failure) => setError(errorMessage(failure)));
  }
  return { draft, loaded, error, setError, update, writes };
}

function ManualForm(
  { db, pool, enabled, open }: {
    db: BolaoDatabase;
    pool: LocalRecord<"pool">;
    enabled: boolean;
    open: (request: RecordRequest) => void;
  },
) {
  const { draft, loaded, error, setError, update, writes } = useResultDraft(
    db,
    pool,
  );
  async function review() {
    try {
      await writes.current;
      if (!pool.data.contestNumber) {
        throw new Error("Defina o concurso do bolão antes de informar.");
      }
      if (!draft.source.trim() || !draft.reason.trim()) {
        throw new Error("Informe a fonte e o motivo do resultado.");
      }
      const action: ResultAction = {
        type: "result_manual",
        poolId: pool.id,
        poolVersion: pool.serverVersion,
        sourceReference: draft.source.trim(),
        reason: draft.reason.trim(),
        data: {
          lotteryId: pool.data.lotteryId,
          contestNumber: pool.data.contestNumber,
          drawDate: draft.date || null,
          drawnNumbers: draft.numbers.trim()
            ? draft.numbers.trim().split(/[\s,;]+/).map(Number)
            : null,
          payouts: Object.values(draft.payouts).some((tier) =>
              tier.amount.trim() || tier.winners.trim()
            )
            ? prizeHits[pool.data.lotteryId].map((hits) => ({
              hits,
              prizeCents: draft.payouts[hits]?.amount.trim()
                ? parseBRL(draft.payouts[hits]!.amount)
                : null,
              winnerCount: draft.payouts[hits]?.winners.trim() || null,
            }))
            : null,
        },
      };
      open({ family: "result", action });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <div className="pool-form">
      <p className="ui-sec">
        Copie da fonte publicada. O que ainda não saiu fica vazio e pendente.
      </p>
      <label>
        Data do sorteio em Brasília<input
          type="date"
          value={draft.date}
          onChange={(event) => update({ date: event.target.value })}
        />
      </label>
      <label>
        Dezenas sorteadas<textarea
          rows={2}
          value={draft.numbers}
          onChange={(event) => update({ numbers: event.target.value })}
        />
      </label>
      {prizeHits[pool.data.lotteryId].map((hits) => (
        <div className="form-columns" key={hits}>
          <label>
            Prêmio de {hits} acertos (R$)<input
              inputMode="decimal"
              value={draft.payouts[hits]?.amount ?? ""}
              onChange={(event) =>
                update({
                  payouts: {
                    ...draft.payouts,
                    [hits]: {
                      winners: draft.payouts[hits]?.winners ?? "",
                      amount: event.target.value,
                    },
                  },
                })}
            />
          </label>
          <label>
            Ganhadores de {hits} acertos<input
              inputMode="numeric"
              value={draft.payouts[hits]?.winners ?? ""}
              onChange={(event) =>
                update({
                  payouts: {
                    ...draft.payouts,
                    [hits]: {
                      amount: draft.payouts[hits]?.amount ?? "",
                      winners: event.target.value,
                    },
                  },
                })}
            />
          </label>
        </div>
      ))}
      <label>
        Fonte do resultado<input
          value={draft.source}
          onChange={(event) => update({ source: event.target.value })}
        />
      </label>
      <label>
        Motivo do resultado manual<textarea
          rows={2}
          value={draft.reason}
          onChange={(event) => update({ reason: event.target.value })}
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button
        icon={<ShieldCheck aria-hidden="true" />}
        disabled={!enabled || !loaded || !pool.data.contestNumber}
        onClick={() => void review()}
      >
        Revisar resultado informado
      </Button>
    </div>
  );
}

function CalendarForm(
  { db, pool, enabled, open }: {
    db: BolaoDatabase;
    pool: LocalRecord<"pool">;
    enabled: boolean;
    open: (request: RecordRequest) => void;
  },
) {
  const { draft, loaded, error, setError, update, writes } = useResultDraft(
    db,
    pool,
  );
  async function review() {
    try {
      await writes.current;
      if (!pool.data.contestNumber) {
        throw new Error("Defina o concurso do bolão antes de informar.");
      }
      if (!draft.calendarSource.trim() || !draft.calendarReason.trim()) {
        throw new Error("Informe a fonte e o motivo dos horários.");
      }
      open({
        family: "result",
        action: {
          type: "calendar_confirm",
          poolId: pool.id,
          poolVersion: pool.serverVersion,
          lotteryId: pool.data.lotteryId,
          contestNumber: pool.data.contestNumber,
          drawDate: draft.calendarDate || null,
          expectedDrawAt: draft.drawAt
            ? brasiliaDateTimeToUTC(draft.drawAt)
            : null,
          registrationClosesAt: draft.closesAt
            ? brasiliaDateTimeToUTC(draft.closesAt)
            : null,
          sourceReference: draft.calendarSource.trim(),
          reason: draft.calendarReason.trim(),
        },
      });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <div className="pool-form">
      <label>
        Data do concurso em Brasília<input
          type="date"
          value={draft.calendarDate}
          onChange={(event) => update({ calendarDate: event.target.value })}
        />
      </label>
      <label>
        Sorteio previsto (Brasília)<input
          type="datetime-local"
          value={draft.drawAt}
          onChange={(event) => update({ drawAt: event.target.value })}
        />
      </label>
      <label>
        Encerramento do canal (Brasília)<input
          type="datetime-local"
          value={draft.closesAt}
          onChange={(event) => update({ closesAt: event.target.value })}
        />
      </label>
      <label>
        Fonte dos horários<input
          value={draft.calendarSource}
          onChange={(event) => update({ calendarSource: event.target.value })}
        />
      </label>
      <label>
        Motivo da definição ou correção<textarea
          rows={2}
          value={draft.calendarReason}
          onChange={(event) => update({ calendarReason: event.target.value })}
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button
        variant="ghost"
        icon={<CalendarClock aria-hidden="true" />}
        disabled={!enabled || !loaded || !pool.data.contestNumber}
        onClick={() => void review()}
      >
        Revisar horários do concurso
      </Button>
    </div>
  );
}
