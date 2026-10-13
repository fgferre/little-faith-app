import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link2, QrCode, UserPlus } from "lucide-react";
import {
  createResultView,
  formatBRL,
  formatQuotaUnits,
  LOTTERIES,
  sumCents,
} from "@bolao/core";
import type { PixReceiver } from "@bolao/core";
import { getResultSnapshot } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { browserTimeZone, errorMessage, rolloverOf } from "../app-shared";
import { Modal } from "../components";
import type { FormKind, Notice, Snapshot } from "../app-shared";
import { latestManifest } from "../planning";
import { saveLocalDraft } from "../repository";
import {
  createParticipantLink,
  ParticipantApiError,
  pullParticipantLinks,
  revokeParticipantLink,
} from "../participant-client";
import type { ParticipantLink } from "../participant-client";
import {
  Avatars,
  Bar,
  Button,
  Card,
  Chip,
  codigoPix,
  copiar,
  diaMes,
  EnviarWhatsApp,
  Eyebrow,
  formatWhen,
  Money,
  PixCode,
  ProblemBox,
  reais,
} from "../ui";
import type { AvatarStatus } from "../ui";
import { joinNames } from "./bolao-etapas";
import type { PoolPerson, PoolView } from "./bolao-etapas";

type PersonState = "paid" | "owe" | "review" | "mismatch" | "fix";

/** Pago, devendo, pagamento em conferência, pagamento que não bate com o que falta, ou cota a corrigir. */
function personState(person: PoolPerson): PersonState {
  if (person.dueCents === null) return "fix";
  if (!person.owes) return "paid";
  if (!person.pending.length) return "owe";
  const missing = BigInt(person.dueCents) - BigInt(person.paidCents);
  const sent = BigInt(sumCents(person.pending.map((p) => p.amountCents)));
  return sent === missing ? "review" : "mismatch";
}
const AVATAR: Record<PersonState, AvatarStatus> = {
  paid: "paid",
  owe: "owe",
  review: "owe",
  mismatch: "problem",
  fix: "problem",
};
const missingCents = (person: PoolPerson) =>
  person.dueCents === null
    ? null
    : (BigInt(person.dueCents) - BigInt(person.paidCents)).toString();
export const cotas = (units: number) =>
  `${formatQuotaUnits(units)} ${units < 200 ? "cota" : "cotas"}`;

/**
 * Mensagem curta para o grupo: quem ainda deve, quanto e até quando. Com chave Pix no grupo, o código
 * copia e cola de cada pessoa vai sozinho na linha de baixo do nome, para dar para copiar só ele.
 */
function chargeText(view: PoolView, pix: PixReceiver | null) {
  const { pool } = view;
  const lines = view.owing.flatMap((person) => {
    const missing = missingCents(person);
    const code = codigoPix(pix, missing);
    return [
      `• ${person.name}${missing ? ` — ${formatBRL(missing)}` : ""}`,
      ...(code ? [code] : []),
    ];
  });
  const coded = lines.length > view.owing.length;
  return [
    `${pool.data.title} (${LOTTERIES[pool.data.lotteryId].label})`,
    "Falta pagar a cota:",
    ...lines,
    ...(coded && pix
      ? [
        `Pix para ${pix.name}: copie o código abaixo do seu nome e cole no app do banco, em Pix copia e cola.`,
      ]
      : []),
    ...(pool.data.deadlineAt
      ? [
        `Pagar até ${
          formatWhen(
            Date.parse(pool.data.deadlineAt),
            Date.now(),
            "America/Sao_Paulo",
          )
        } (Brasília).`,
      ]
      : []),
  ].join("\n");
}

/**
 * O convite da chamada: quem continua no bolão novo responde no grupo. Se o concurso do bolão passado
 * acumulou, vai junto o prêmio estimado do concurso seguinte que a CAIXA publicou.
 */
function callText(view: PoolView, rollover?: ReturnType<typeof rolloverOf>) {
  const { title, contestNumber, quotaPriceCents, deadlineAt } = view.pool.data;
  const contest = contestNumber === null
    ? "o próximo concurso"
    : `o concurso ${contestNumber}`;
  const until = deadlineAt
    ? `, pagar até ${diaMes(deadlineAt, "America/Sao_Paulo")}`
    : "";
  const call = `${title} para ${contest}! Quem continua? Cota ${
    formatBRL(quotaPriceCents)
  }${until}. Responde aqui: dentro ou fora.`;
  if (!rollover) return call;
  const { nextContestNumber, nextEstimatedPrizeCents } = rollover;
  return `${call}\n${
    nextEstimatedPrizeCents === null
      ? "Acumulou!"
      : `Acumulou! Prêmio estimado para o concurso ${nextContestNumber}: ${
        formatBRL(nextEstimatedPrizeCents)
      }.`
  }`;
}

/**
 * A chamada: quem estava na rodada passada (o bolão mais recente do grupo, na mesma modalidade, já
 * travado) e ainda não tem cota neste rascunho, com a cota que tinha.
 */
function rollCall(snapshot: Snapshot, view: PoolView) {
  const { pool } = view;
  if (pool.data.status !== "draft") return { previous: undefined, call: [] };
  const previous = snapshot.pools.filter((other) =>
    other.id !== pool.id && other.data.lotteryId === pool.data.lotteryId &&
    (other.data.status !== "draft" ||
      !!latestManifest(snapshot.planning, other.id))
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const units = new Map<string, number>();
  for (const quota of snapshot.quotas) {
    if (quota.data.poolId !== previous?.id) continue;
    const { personId } = quota.data;
    units.set(personId, (units.get(personId) ?? 0) + quota.data.units);
  }
  const call = snapshot.persons.flatMap((person) =>
    units.has(person.id) && !view.people.some((p) => p.id === person.id)
      ? [{
        id: person.id,
        name: person.data.nickname || person.data.name,
        units: units.get(person.id)!,
      }]
      : []
  ).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { previous, call };
}

/** A mensagem com o link pessoal; o token só existe agora, na criação. */
function linkText(name: string, group: string, token: string) {
  const url = `${location.origin}${location.pathname}#/p/${token}`;
  return `Oi ${name}! Seu cartão do bolão ${group}: ${url}. Nele você vê suas cotas, os jogos, o resultado e a sua parte.`;
}

/**
 * Os links pessoais do grupo: carregados do servidor ao abrir, quando há conexão e conta. `ready` só depois
 * de carregar; antes disso (ou offline) as ações ficam desligadas com o motivo em `problem`; sem conta
 * (demonstração, só no aparelho) elas nem aparecem (`hidden`).
 */
function useParticipantLinks(groupId: string | null) {
  const [online, setOnline] = useState(navigator.onLine);
  const [links, setLinks] = useState<ParticipantLink[] | null>(null);
  const [failed, setFailed] = useState<
    { text: string; noAccount: boolean } | null
  >(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!online || !groupId) return;
    let active = true;
    pullParticipantLinks(groupId).then(
      (pulled) => {
        if (!active) return;
        setLinks(pulled);
        setFailed(null);
      },
      (error) =>
        active && setFailed({
          text: errorMessage(error),
          noAccount: error instanceof ParticipantApiError && error.status === 0,
        }),
    );
    return () => {
      active = false;
    };
  }, [online, groupId]);
  const problem = !online || !groupId
    ? "Os links pessoais precisam de conexão."
    : failed?.text ?? null;
  return {
    links,
    setLinks,
    ready: !problem && links !== null,
    hidden: online && !!failed?.noAccount,
    problem,
  };
}

export function BolaoArrecadar(
  { db, snapshot, view, openForm, openReview, goPlay, setNotice }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    view: PoolView;
    openForm: (kind: FormKind) => void;
    openReview: () => void;
    goPlay: () => void;
    setNotice: (notice: Notice) => void;
  },
) {
  const { people, owing, expectedCents, collectedCents } = view;
  const pendingCents = sumCents(
    people.flatMap((p) => p.pending.map((item) => item.amountCents)),
  );
  const total = expectedCents === null ? 0 : Number(expectedCents);
  const { previous, call } = rollCall(snapshot, view);
  const outside = snapshot.persons.filter((person) =>
    !people.some((p) => p.id === person.id) &&
    !call.some((p) => p.id === person.id)
  );
  const states = new Map(people.map((p) => [p.id, personState(p)]));
  const ordered = [...people].sort((a, b) =>
    Number(states.get(a.id) !== "paid") - Number(states.get(b.id) !== "paid")
  );

  const groupId = snapshot.groupId;
  const group = snapshot.groups.find((group) => group.id === groupId);
  const groupName = group?.data.name ?? "";
  // Se o concurso do bolão passado acumulou, a chamada diz, pela mesma leitura do Sorteio. Sem a
  // conferência dos jogos aqui: quando a CAIXA diz que acumulou, ninguém acertou a faixa principal.
  const previousId = previous?.id;
  const results = useLiveQuery(
    async () =>
      previousId && groupId ? await getResultSnapshot(db, groupId) : null,
    [db, groupId, previousId],
  );
  const rollover = useMemo(
    () =>
      results && previousId
        ? rolloverOf(createResultView(results).currentResult(previousId), false)
        : null,
    [results, previousId],
  );
  const pix = group?.data.pix ?? null;
  // Quem está no painel "Cobrar por Pix"; o código é montado com o que falta agora.
  const [pixId, setPixId] = useState<string | null>(null);
  const pixPerson = people.find((person) => person.id === pixId) ?? null;
  const pixMissing = pixPerson && missingCents(pixPerson);
  const pixPayload = codigoPix(pix, pixMissing);
  const { links, setLinks, ready, hidden, problem } = useParticipantLinks(
    groupId,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // Mensagem de cada link criado nesta visita, para o WhatsApp e o Copiar (o token não volta do
  // servidor depois); some ao sair da tela ou ao cancelar o link.
  const [messages, setMessages] = useState<Record<string, string>>({});
  const activeLinks = (personId: string) =>
    (links ?? []).filter((link) => link.personId === personId && !link.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  async function copyLink(person: PoolPerson, text: string) {
    const copied = await copiar(text);
    setNotice(
      copied
        ? { text: `Mensagem copiada. Cole na conversa com ${person.name}.` }
        : {
          text: "O link foi criado. Toque em Enviar no WhatsApp ou em Copiar.",
          error: true,
        },
    );
  }

  async function sendLink(person: PoolPerson) {
    if (!groupId) return;
    setBusy(person.id);
    try {
      const created = await createParticipantLink(groupId, person.id);
      setLinks((list) => [...(list ?? []), {
        id: created.id,
        personId: created.personId,
        createdAt: created.createdAt,
        revokedAt: null,
      }]);
      const text = linkText(person.name, groupName, created.token);
      setMessages((list) => ({ ...list, [person.id]: text }));
      await copyLink(person, text);
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function cancelLink(person: PoolPerson) {
    if (!groupId) return;
    setBusy(person.id);
    try {
      for (const link of activeLinks(person.id)) {
        const revoked = await revokeParticipantLink(groupId, link.id);
        setLinks((list) =>
          (list ?? []).map((item) =>
            item.id === revoked.id
              ? { ...item, revokedAt: revoked.revokedAt }
              : item
          )
        );
      }
      setMessages(({ [person.id]: _, ...rest }) => rest);
      setNotice({ text: `Link de ${person.name} cancelado. Ele não abre mais.` });
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy(null);
    }
  }

  const linkRow = (person: PoolPerson) => {
    const active = activeLinks(person.id)[0];
    const text = messages[person.id];
    const off = !ready || busy !== null;
    return (
      <div className="pool-person-link">
        {active && (
          <span className="ui-sec">
            Link enviado em {diaMes(active.createdAt, browserTimeZone)}
          </span>
        )}
        {active
          ? (
            <Button
              variant="ghost"
              small
              disabled={off}
              onClick={() => void cancelLink(person)}
            >
              Cancelar link
            </Button>
          )
          : !text && (
            <Button
              variant="ghost"
              small
              icon={<Link2 aria-hidden="true" />}
              disabled={off}
              onClick={() => void sendLink(person)}
            >
              Enviar link pessoal
            </Button>
          )}
        {text && (
          <div className="ui-pair">
            <EnviarWhatsApp small text={text} />
            <Button
              variant="ghost"
              small
              disabled={busy !== null}
              onClick={() => void copyLink(person, text)}
            >
              Copiar
            </Button>
          </div>
        )}
      </div>
    );
  };

  async function charge() {
    const copied = await copiar(chargeText(view, pix));
    setNotice(
      copied
        ? { text: "Mensagem copiada. Cole no grupo do WhatsApp." }
        : { text: "Não deu para copiar a mensagem. Tente de novo.", error: true },
    );
  }

  async function callMessage() {
    const copied = await copiar(callText(view, rollover));
    setNotice(
      copied
        ? { text: "Mensagem copiada. Cole no grupo do WhatsApp." }
        : { text: "Não deu para copiar a mensagem. Tente de novo.", error: true },
    );
  }

  // Cada cota é uma transação própria: uma falha não desfaz as outras.
  async function join(entries: typeof call) {
    if (!groupId) return;
    setJoining(true);
    const failed: string[] = [];
    let reason = "";
    for (const entry of entries) {
      try {
        await saveLocalDraft(db, {
          id: crypto.randomUUID(),
          groupId,
          kind: "quota",
          data: {
            poolId: view.pool.id,
            personId: entry.id,
            units: entry.units,
          },
        });
      } catch (error) {
        failed.push(entry.name);
        reason ||= errorMessage(error);
      }
    }
    setJoining(false);
    setNotice(
      failed.length
        ? {
          text: `Não deu para incluir ${joinNames(failed)}. ${reason}`,
          error: true,
        }
        : entries.length === 1
        ? { text: `${entries[0]!.name} entrou com ${cotas(entries[0]!.units)}.` }
        : { text: `Entraram ${entries.length} pessoas.` },
    );
  }

  const stateView = (
    person: PoolPerson,
    state: Exclude<PersonState, "paid">,
  ) => {
    if (state === "review") {
      return <Chip status="pending">Pagamento em conferência</Chip>;
    }
    if (state === "owe") {
      return (
        <div className="pix-owe">
          <Chip status="pending">Ainda não pagou</Chip>
          {pix
            ? (
              <Button
                variant="ghost"
                small
                icon={<QrCode aria-hidden="true" />}
                onClick={() => setPixId(person.id)}
              >
                Cobrar por Pix
              </Button>
            )
            : (
              <button
                type="button"
                className="pool-link"
                onClick={() => openForm("edit-group")}
              >
                Cadastrar chave Pix do grupo
              </button>
            )}
        </div>
      );
    }
    if (state === "fix") {
      return (
        <ProblemBox title="A cota precisa de ajuste">
          Esta fração de cota dá um valor com fração de centavo.
        </ProblemBox>
      );
    }
    const sent = sumCents(person.pending.map((p) => p.amountCents));
    return (
      <>
        <ProblemBox title="Comprovante não bate com o valor">
          {person.name} enviou <span className="ui-nb">{formatBRL(sent)}</span>
          {" "}
          · falta <span className="ui-nb">
            {formatBRL(missingCents(person)!)}
          </span>
        </ProblemBox>
        <Button variant="ghost" small onClick={openReview}>
          Ver comprovante
        </Button>
      </>
    );
  };

  return (
    <div className="pool-cols">
      <Card className="pool-card" label="Arrecadação">
        <Eyebrow>Arrecadação</Eyebrow>
        <Money
          suffix={expectedCents !== null && <>de {reais(expectedCents)}</>}
        >
          {reais(collectedCents)}
        </Money>
        {total > 0 && (
          <>
            <Bar
              done={Number(collectedCents) / total}
              pending={Number(pendingCents) / total}
              label={`${reais(collectedCents)} confirmados de ${
                reais(expectedCents!)
              }; ${reais(pendingCents)} em conferência`}
            />
            <p className="ui-legend">
              <span>
                <i />
                {reais(collectedCents)} confirmados
              </span>
              {pendingCents !== "0" && (
                <span>
                  <i className="pend" />
                  {reais(pendingCents)} em conferência
                </span>
              )}
            </p>
          </>
        )}
        {people.length
          ? (
            <>
              <Avatars
                people={ordered.map((p) => ({
                  id: p.id,
                  name: p.name,
                  status: AVATAR[states.get(p.id)!],
                }))}
                max={8}
              />
              {owing.length
                ? (
                  <p className="pool-owe">
                    <span className="pool-amber">Faltam {owing.length}:</span>
                    {" "}
                    {joinNames(owing.map((p) => p.name))}
                  </p>
                )
                : (
                  <p className="pool-owe">
                    <Chip status="confirmed">Todo mundo pagou</Chip>
                  </p>
                )}
              {owing.length
                ? (
                  <div className="pool-actions">
                    <div className="ui-pair">
                      <EnviarWhatsApp text={chargeText(view, pix)} />
                      <Button variant="ghost" onClick={() => void charge()}>
                        Copiar
                      </Button>
                    </div>
                  </div>
                )
                : <Button onClick={goPlay}>Escolher os jogos</Button>}
            </>
          )
          : (
            <p className="ui-sec pool-empty">
              {call.length
                ? "Ninguém com cota ainda. Marque quem entrou na chamada abaixo."
                : "Ninguém com cota ainda. Adicione as pessoas e prepare a cota de cada uma."}
            </p>
          )}
      </Card>
      <div className="pool-stack">
        {!!call.length && (
          <Card className="pool-card" label="Chamada">
            <Eyebrow>Chamada</Eyebrow>
            <p className="ui-sec pool-call-from">
              {previous?.data.contestNumber
                ? `Estavam no concurso ${previous.data.contestNumber}.`
                : "Estavam na rodada passada."}
            </p>
            <div className="pool-call-action">
              <div className="ui-pair">
                <EnviarWhatsApp small text={callText(view, rollover)} />
                <Button
                  variant="ghost"
                  small
                  onClick={() => void callMessage()}
                >
                  Copiar
                </Button>
              </div>
            </div>
            <ul className="pool-people">
              {call.map((entry) => (
                <li className="pool-call-person" key={entry.id}>
                  <span className="pool-person-name">{entry.name}</span>
                  <span className="ui-sec">{cotas(entry.units)}</span>
                  <Button
                    small
                    disabled={joining}
                    aria-label={`${entry.name} entrou`}
                    onClick={() => void join([entry])}
                  >
                    Entrou
                  </Button>
                </li>
              ))}
            </ul>
            <p className="ui-sec pool-call-left">
              {call.length === 1
                ? "1 ainda não respondeu"
                : `${call.length} ainda não responderam`}
            </p>
            <div className="pool-call-action">
              <Button
                variant="ghost"
                small
                disabled={joining}
                onClick={() => void join(call)}
              >
                Todos entraram
              </Button>
            </div>
          </Card>
        )}
        <Card className="pool-card" label="Pessoas">
          <Eyebrow>Pessoas</Eyebrow>
          {!!people.length && problem && (
            <p className="ui-sec pool-sub">{problem}</p>
          )}
          {!!people.length && (
            <ul className="pool-people">
              {people.map((person) => {
                const state = states.get(person.id)!;
                return (
                  <li className="pool-person" key={person.id}>
                    <span className="pool-person-name">{person.name}</span>
                    <span className="pool-person-due">
                      {person.dueCents === null
                        ? "Revisar cota"
                        : formatBRL(person.dueCents)}
                    </span>
                    <span className="ui-sec pool-person-sub">
                      {cotas(person.units)} · pagou {formatBRL(person.paidCents)}
                    </span>
                    {state === "paid"
                      ? <Chip status="confirmed">Pago</Chip>
                      : (
                        <div className="pool-person-state">
                          {stateView(person, state)}
                        </div>
                      )}
                    {!hidden && linkRow(person)}
                  </li>
                );
              })}
            </ul>
          )}
          {!!outside.length && (
            <p className="ui-sec pool-outside">
              Sem cota neste bolão: {joinNames(
                outside.map((p) => p.data.nickname || p.data.name),
              )}
            </p>
          )}
          {!snapshot.persons.length && (
            <p className="ui-sec pool-empty">
              Basta um nome e a declaração de maioridade. Ninguém precisa criar
              conta.
            </p>
          )}
          {pixPerson && pix && pixMissing && pixPayload && (
            <Modal title="Cobrar por Pix" onClose={() => setPixId(null)}>
              <p className="pix-who">
                <span>{pixPerson.name}</span>
                <b>{formatBRL(pixMissing)}</b>
              </p>
              <PixCode payload={pixPayload} />
              <p className="ui-sec pix-foot">
                Mostre o QR ou mande o código. Para {pix.name} ({pix.key}).
                Quem paga ainda precisa pagar no banco; você marca que recebeu.
              </p>
            </Modal>
          )}
          <div className="pool-actions">
            <Button
              variant={snapshot.persons.length ? "ghost" : "primary"}
              small
              icon={<UserPlus aria-hidden="true" />}
              onClick={() => openForm("person")}
            >
              Adicionar pessoa
            </Button>
            <Button variant="ghost" small onClick={() => openForm("quota")}>
              Preparar cota
            </Button>
            <Button variant="ghost" small onClick={() => openForm("payment")}>
              Registrar pagamento
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
