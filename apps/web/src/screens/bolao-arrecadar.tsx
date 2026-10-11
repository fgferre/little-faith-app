import { MessageCircle, UserPlus } from "lucide-react";
import { formatBRL, formatQuotaUnits, LOTTERIES, sumCents } from "@bolao/core";
import type { FormKind, Notice, Snapshot } from "../app-shared";
import {
  Avatars,
  Bar,
  Button,
  Card,
  Chip,
  copiar,
  Eyebrow,
  formatWhen,
  Money,
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
const cotas = (units: number) =>
  `${formatQuotaUnits(units)} ${units < 200 ? "cota" : "cotas"}`;

/** Mensagem curta para o grupo: quem ainda deve, quanto e até quando. */
function chargeText(view: PoolView) {
  const { pool } = view;
  const lines = view.owing.map((person) => {
    const missing = missingCents(person);
    return `• ${person.name}${missing ? ` — ${formatBRL(missing)}` : ""}`;
  });
  return [
    `${pool.data.title} (${LOTTERIES[pool.data.lotteryId].label})`,
    "Falta pagar a cota:",
    ...lines,
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

export function BolaoArrecadar(
  { snapshot, view, openForm, openReview, goPlay, setNotice }: {
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
  const outside = snapshot.persons.filter((person) =>
    !people.some((p) => p.id === person.id)
  );
  const states = new Map(people.map((p) => [p.id, personState(p)]));
  const ordered = [...people].sort((a, b) =>
    Number(states.get(a.id) !== "paid") - Number(states.get(b.id) !== "paid")
  );

  async function charge() {
    const copied = await copiar(chargeText(view));
    setNotice(
      copied
        ? { text: "Mensagem copiada. Cole no grupo do WhatsApp." }
        : { text: "Não deu para copiar a mensagem. Tente de novo.", error: true },
    );
  }

  const stateView = (
    person: PoolPerson,
    state: Exclude<PersonState, "paid">,
  ) => {
    if (state === "review") {
      return <Chip status="pending">Pagamento em conferência</Chip>;
    }
    if (state === "owe") return <Chip status="pending">Ainda não pagou</Chip>;
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
                  <Button
                    icon={<MessageCircle aria-hidden="true" />}
                    onClick={() => void charge()}
                  >
                    Cobrar no WhatsApp
                  </Button>
                )
                : <Button onClick={goPlay}>Escolher os jogos</Button>}
            </>
          )
          : (
            <p className="ui-sec pool-empty">
              Ninguém com cota ainda. Adicione as pessoas e prepare a cota de
              cada uma.
            </p>
          )}
      </Card>
      <Card className="pool-card" label="Pessoas">
        <Eyebrow>Pessoas</Eyebrow>
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
  );
}
