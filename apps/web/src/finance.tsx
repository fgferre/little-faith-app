import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen,
  Check,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import {
  brasiliaDateTimeToUTC,
  computeFinance,
  createFinancialView,
  formatBRL,
  formatQuotaUnits,
  parseBRL,
  quotaCost,
} from "@bolao/core";
import type {
  FinancialAction,
  FinancialSnapshot,
  LocalRecord,
} from "@bolao/core";
import {
  applyFinancialSnapshot,
  executeFinancialCommand,
  prepareFinancialCommand,
  recoverFinancialCommand,
  sync,
} from "@bolao/local";
import type { BolaoDatabase, PersistentFinancialCommand } from "@bolao/local";
import { createAccountTransport } from "./auth";
import { Modal } from "./components";
import {
  Button,
  Card,
  Chip,
  Eyebrow,
  formatInstant,
  MoneyInput,
  ReviewItem,
} from "./ui";
import { draftQuotaCost } from "./quota-display";
import { readReviewSnapshot } from "./review-snapshot";

export type FinancialRequest =
  | { type: "statute_publish" }
  | { type: "statute_accept"; personId: string }
  | { type: "payment_confirm"; proposalId: string }
  | { type: "payment_allocate"; paymentId: string }
  | { type: "payment_reverse"; paymentId: string }
  | { type: "quota_confirm"; quotaId: string }
  | { type: "recover"; idempotencyKey: string };

const titles: Record<FinancialRequest["type"], string> = {
  statute_publish: "Publicar os combinados do grupo",
  statute_accept: "Registrar aceite dos combinados",
  payment_confirm: "Conferir recebimento",
  payment_allocate: "Destinar dinheiro a um bolão",
  payment_reverse: "Estornar um recebimento",
  quota_confirm: "Confirmar participação",
  recover: "Conferir uma decisão enviada",
};
const date = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" })
    .format(new Date(value));
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível consultar o servidor.";
const unresolved = (command: { status: string }) =>
  ["prepared", "sending", "unknown"].includes(command.status);
const readableAmount = (cents: string) =>
  `${BigInt(cents) / 100n},${
    (BigInt(cents) % 100n).toString().padStart(2, "0")
  }`;

export function FinancialCash(
  { snapshot }: { snapshot: FinancialSnapshot | null },
) {
  const totals = snapshot
    ? computeFinance(snapshot)
    : { cashCents: "0", allocatedCents: "0", unallocatedCents: "0" };
  return (
    <Card className="finance-card" label="Caixa do grupo">
      <Eyebrow>Caixa do grupo</Eyebrow>
      <p className="ui-sec">
        Pagamentos conferidos do grupo inteiro, já sem os estornos. Destinar a
        um bolão não conta o dinheiro duas vezes.
      </p>
      <dl className="finance-totals">
        <div>
          <dt>Recebido</dt>
          <dd>{formatBRL(totals.cashCents)}</dd>
        </div>
        <div>
          <dt>Destinado aos bolões</dt>
          <dd>{formatBRL(totals.allocatedCents)}</dd>
        </div>
        <div>
          <dt>Ainda sem destino</dt>
          <dd>{formatBRL(totals.unallocatedCents)}</dd>
        </div>
      </dl>
      {!snapshot && (
        <p className="ui-sec">
          Os pagamentos conferidos aparecem aqui depois de entrar na conta e
          sincronizar o grupo.
        </p>
      )}
    </Card>
  );
}

interface ReviewProps {
  snapshot: FinancialSnapshot | null;
  group: LocalRecord<"group">;
  persons: LocalRecord<"person">[];
  pools: LocalRecord<"pool">[];
  quotas: LocalRecord<"quota">[];
  enabled: boolean;
  /** Por que as conferências estão desligadas; null quando a tela já explicou. */
  availability: string | null;
  open: (request: FinancialRequest) => void;
}

export function FinancialReview(
  { snapshot, group, persons, pools, quotas, enabled, availability, open }:
    ReviewProps,
) {
  const view = useMemo(() => snapshot ? createFinancialView(snapshot) : null, [
    snapshot,
  ]);
  const statute = view?.statute;
  return (
    <div className="finance-sections">
      <FinancialCash snapshot={snapshot} />
      {!enabled && availability && (
        <p className="ui-sec finance-why">{availability}</p>
      )}
      <Card className="finance-card" label="Combinados e aceites">
        <div className="finance-head">
          <div>
            <Eyebrow>Combinados e aceites</Eyebrow>
            <p className="ui-sec">
              {statute
                ? `Versão ${statute.version} publicada em ${
                  date(statute.publishedAt)
                }`
                : "Publique os combinados antes de confirmar as cotas."}
            </p>
          </div>
          <Button
            variant="ghost"
            small
            icon={<BookOpen aria-hidden="true" />}
            disabled={!enabled || !group.data.statute.trim() ||
              statute?.sourceGroupVersion === group.serverVersion}
            onClick={() => open({ type: "statute_publish" })}
          >
            {statute ? "Publicar nova versão" : "Publicar combinados"}
          </Button>
        </div>
        <p className="statute-text">
          {statute?.text ??
            (group.data.statute || "Nenhum combinado informado.")}
        </p>
        {statute && (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Aceite da versão {statute.version}</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                {persons.map((person) => {
                  const acceptance = snapshot?.acceptances.find((a) =>
                    a.personId === person.id && a.statuteId === statute.id
                  );
                  return (
                    <tr key={person.id}>
                      <td>{person.data.name}</td>
                      <td>
                        {acceptance ? date(acceptance.acceptedAt) : "Pendente"}
                      </td>
                      <td>
                        {acceptance
                          ? (
                            <Chip status="confirmed">Aceite registrado</Chip>
                          )
                          : (
                            <Button
                              variant="ghost"
                              small
                              disabled={!enabled}
                              onClick={() =>
                                open({
                                  type: "statute_accept",
                                  personId: person.id,
                                })}
                            >
                              Registrar aceite
                            </Button>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {quotas.length > 0 && (
        <Card className="finance-card" label="Cotas para conferir">
          <Eyebrow>Cotas para conferir</Eyebrow>
          <p className="ui-sec">
            A cota vale quando a pessoa pagou tudo, é maior de idade e aceitou os
            combinados. Depois do prazo combinado ela ainda entra, até o bolão
            travar. Receber dinheiro sozinho não confirma a cota.
          </p>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Pessoa e bolão</th>
                  <th>Cotas</th>
                  <th>Devido</th>
                  <th>Destinado</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {quotas.map((quota) => {
                  const pool = pools.find((p) => p.id === quota.data.poolId);
                  const person = persons.find((p) =>
                    p.id === quota.data.personId
                  );
                  const confirmed = snapshot?.quotas.find((q) =>
                    q.sourceQuotaId === quota.id && view?.isQuotaActive(q.id)
                  );
                  const due = confirmed?.dueCents ??
                    draftQuotaCost(
                      pool?.data.quotaPriceCents ?? "0",
                      quota.data.units,
                    );
                  const funding = view?.personPoolFunding(
                    quota.data.poolId,
                    quota.data.personId,
                  ) ?? "0";
                  const accepted = statute &&
                    snapshot?.acceptances.some((a) =>
                      a.statuteId === statute.id && a.personId === person?.id
                    );
                  const eligible = !confirmed && due !== null && !!accepted &&
                    person?.data.adultDeclared && !!pool?.data.deadlineAt &&
                    BigInt(funding) >= BigInt(due);
                  const reason = confirmed
                    ? "Confirmada"
                    : due === null
                    ? "Ajustar preço ou cota"
                    : !person?.data.adultDeclared
                    ? "Maioridade pendente"
                    : !statute
                    ? "Combinados pendentes"
                    : !accepted
                    ? "Aceite pendente"
                    : !pool?.data.deadlineAt
                    ? "Prazo a definir"
                    : BigInt(funding) < BigInt(due)
                    ? "Pagamento integral pendente"
                    : "Pronta para conferir";
                  return (
                    <tr key={quota.id}>
                      <td>
                        {person?.data.name}
                        <small className="cell-note">{pool?.data.title}</small>
                      </td>
                      <td>
                        {formatQuotaUnits(confirmed?.units ?? quota.data.units)}
                        {confirmed &&
                          (confirmed.units !== quota.data.units ||
                            confirmed.sourceQuotaVersion !==
                              quota.serverVersion) &&
                          (
                            <small className="cell-note">
                              A cota mudou depois da confirmação
                            </small>
                          )}
                      </td>
                      <td>
                        {due === null
                          ? "Ajustar preço ou cota"
                          : formatBRL(due)}
                      </td>
                      <td>{formatBRL(funding)}</td>
                      <td>
                        {confirmed
                          ? (
                            <Chip status="confirmed">Confirmada</Chip>
                          )
                          : (
                            <>
                              <span className="cell-note">{reason}</span>
                              <Button
                                variant="ghost"
                                small
                                disabled={!enabled || !eligible}
                                onClick={() =>
                                  open({
                                    type: "quota_confirm",
                                    quotaId: quota.id,
                                  })}
                              >
                                Conferir participação
                              </Button>
                            </>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {!!snapshot?.payments.length && (
        <Card className="finance-card" label="Pagamentos recebidos">
          <Eyebrow>Pagamentos recebidos</Eyebrow>
          <p className="ui-sec">
            Um pagamento pode cobrir vários bolões. O que ainda não tem destino
            continua no nome da pessoa.
          </p>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Valor recebido</th>
                  <th>Sem destino</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.payments.map((payment) => {
                  const reversed = snapshot.movements.some((m) =>
                    m.paymentId === payment.id && m.kind === "payment-reversed"
                  );
                  const assigned = snapshot.movements.filter((m) =>
                    m.paymentId === payment.id &&
                    ["payment-allocated", "allocation-reversed"].includes(
                      m.kind,
                    )
                  ).reduce((sum, m) => sum + BigInt(m.amountCents), 0n);
                  const remaining = reversed
                    ? 0n
                    : BigInt(payment.amountCents) - assigned;
                  return (
                    <tr key={payment.id}>
                      <td>
                        {persons.find((p) => p.id === payment.personId)?.data
                          .name}
                        <small className="cell-note">
                          {payment.bankReference ??
                            "Sem referência do banco"}
                        </small>
                      </td>
                      <td>
                        {formatBRL(payment.amountCents)}
                        <small className="cell-note">
                          {date(payment.confirmedAt)}
                        </small>
                      </td>
                      <td>{formatBRL(remaining.toString())}</td>
                      <td>
                        {reversed
                          ? <Chip status="pending">Estornado</Chip>
                          : (
                            <div className="finance-row-actions">
                              <Button
                                variant="ghost"
                                small
                                disabled={!enabled || remaining <= 0n}
                                onClick={() =>
                                  open({
                                    type: "payment_allocate",
                                    paymentId: payment.id,
                                  })}
                              >
                                Destinar saldo
                              </Button>
                              <Button
                                variant="ghost"
                                small
                                disabled={!enabled}
                                onClick={() =>
                                  open({
                                    type: "payment_reverse",
                                    paymentId: payment.id,
                                  })}
                              >
                                Estornar
                              </Button>
                            </div>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Decisões de pagamento que ficaram sem resposta ("open") ou não deram certo ("failed"), em cartões da Revisão. */
export function FinancialPending(
  { db, groupId, show, open }: {
    db: BolaoDatabase;
    groupId: string;
    show: "open" | "failed";
    open: (request: FinancialRequest) => void;
  },
) {
  const commands = useLiveQuery(
    () => db.financialCommands.where("groupId").equals(groupId).toArray(),
    [db, groupId],
  );
  if (show === "open") {
    return commands?.filter(unresolved).map((command) => (
      <ReviewItem
        key={command.idempotencyKey}
        family="Pagamento"
        title={titles[command.command.action.type]}
        state="A conferir"
        line={`Enviada em ${
          date(command.createdAt)
        }. A resposta não chegou a este aparelho. Confira antes de decidir de novo; reconectar não envia outra vez.`}
      >
        <Button
          aria-label="Conferir decisão"
          onClick={() =>
            open({ type: "recover", idempotencyKey: command.idempotencyKey })}
        >
          Conferir
        </Button>
      </ReviewItem>
    ));
  }
  return commands?.filter((command) =>
    command.status === "conflict" || command.status === "rejected"
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10).map((
    command,
  ) => (
    <ReviewItem
      key={command.idempotencyKey}
      family="Pagamento"
      title={titles[command.command.action.type]}
      status="problem"
      state="Não confirmada"
      line={
        <>
          {date(command.createdAt)}
          <span className="ui-review-note">
            {command.receipt?.message ?? (command.status === "conflict"
              ? "Os dados mudaram durante a conferência."
              : "A decisão foi recusada.")}
          </span>
        </>
      }
    />
  ));
}

interface Preview {
  snapshot: FinancialSnapshot;
  records: LocalRecord[];
  persistent: PersistentFinancialCommand | null;
}
interface DecisionReview {
  title: string;
  lines: string[];
}

export function FinancialDialog(
  { request, db, groupId, enabled, availability, onClose, onNotice }: {
    request: FinancialRequest;
    db: BolaoDatabase;
    groupId: string;
    enabled: boolean;
    availability: string;
    onClose: () => void;
    onNotice: (notice: { text: string; error?: boolean }) => void;
  },
) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(
    request.type === "recover" ? request.idempotencyKey : null,
  );
  const approvedKey = useRef(lastKey);
  const sending = useRef(false);
  const mounted = useRef(true);
  const [decisionReview, setDecisionReview] = useState<DecisionReview | null>(
    null,
  );
  const [poolId, setPoolId] = useState("");
  const [amount, setAmount] = useState("");
  const [allocate, setAllocate] = useState(true);
  const [bankReference, setBankReference] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!enabled || !navigator.onLine) {
      if (!sending.current) setBusy(false);
      return;
    }
    setBusy(true);
    if (!approvedKey.current) setReviewed(false);
    const load = async () => {
      const transport = createAccountTransport(db.accountId);
      await sync(db, transport);
      const snapshot = await transport.financialPull(groupId);
      await applyFinancialSnapshot(db, snapshot);
      const { records, localRecords, financialCommands, planningCommands, registrationCommands, resultCommands } =
        await readReviewSnapshot(
          db,
          groupId,
          approvedKey.current ? null : snapshot.groupRevision,
        );
      const sourceId = request.type === "payment_confirm"
        ? request.proposalId
        : request.type === "quota_confirm"
        ? request.quotaId
        : request.type === "statute_publish"
        ? groupId
        : null;
      if (
        !approvedKey.current && sourceId &&
        localRecords.find((record) => record.id === sourceId)?.state !==
          "synced"
      ) {
        throw new Error(
          "Este rascunho precisa estar sincronizado e sem conflito. Resolva a revisão antes de confirmar.",
        );
      }
      const pending = [...financialCommands, ...planningCommands, ...registrationCommands, ...resultCommands].filter(unresolved);
      const key = approvedKey.current;
      const persistent = key
        ? await db.financialCommands.get(key) ?? null
        : null;
      if (key && !persistent) {
        throw new Error("Esta decisão não foi encontrada neste aparelho.");
      }
      if (pending.some((command) => command.idempotencyKey !== key)) {
        throw new Error(
          "Verifique a decisão pendente deste grupo antes de confirmar outra operação.",
        );
      }
      const savedReview = key
        ? await db.metadata.get(`financial-review:${key}`)
        : undefined;
      if (!active) return;
      setPreview({ snapshot, records, persistent });
      if (key) {
        setDecisionReview(savedReview?.value as DecisionReview | null ?? null);
        return;
      }
      const proposal = request.type === "payment_confirm"
        ? records.find((r) =>
          r.id === request.proposalId && r.kind === "payment-proposal"
        ) as LocalRecord<"payment-proposal"> | undefined
        : undefined;
      const firstPool = records.find((r) =>
        r.kind === "pool" && (r as LocalRecord<"pool">).data.status === "draft"
      );
      setPoolId(proposal?.data.poolId ?? firstPool?.id ?? "");
      setAmount(proposal ? readableAmount(proposal.data.amountCents) : "");
    };
    void load().catch((failure) => {
      if (active) setError(message(failure));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [db, groupId, request, enabled]);

  const records = preview?.records ?? [];
  const persons = records.filter((r) => r.kind === "person") as LocalRecord<
    "person"
  >[];
  const pools = records.filter((r) => r.kind === "pool") as LocalRecord<
    "pool"
  >[];
  const group = records.find((r) => r.kind === "group") as
    | LocalRecord<"group">
    | undefined;
  const view = useMemo(
    () => preview ? createFinancialView(preview.snapshot) : null,
    [preview],
  );
  const statute = view?.statute;
  const proposal = request.type === "payment_confirm"
    ? records.find((r) =>
      r.id === request.proposalId && r.kind === "payment-proposal"
    ) as LocalRecord<"payment-proposal"> | undefined
    : undefined;
  const quota = request.type === "quota_confirm"
    ? records.find((r) => r.id === request.quotaId && r.kind === "quota") as
      | LocalRecord<"quota">
      | undefined
    : undefined;
  const paymentId =
    request.type === "payment_allocate" || request.type === "payment_reverse"
      ? request.paymentId
      : null;
  const payment = preview?.snapshot.payments.find((p) => p.id === paymentId);
  const personId = proposal?.data.personId ?? quota?.data.personId ??
    payment?.personId ??
    (request.type === "statute_accept" ? request.personId : null);
  const person = persons.find((p) => p.id === personId);
  const selectedPool = pools.find((p) =>
    p.id === (quota?.data.poolId ?? poolId)
  );
  const afterDeadline = (() => {
    const deadlineAt = selectedPool?.data.deadlineAt;
    if (
      request.type !== "payment_confirm" || !allocate || !deadlineAt ||
      !receivedAt
    ) return null;
    try {
      const received = Date.parse(brasiliaDateTimeToUTC(receivedAt));
      return received >= Date.parse(deadlineAt)
        ? formatInstant(deadlineAt, "America/Sao_Paulo")
        : null;
    } catch {
      return null;
    }
  })();
  const paymentAssigned =
    preview?.snapshot.movements.filter((m) =>
      m.paymentId === payment?.id &&
      ["payment-allocated", "allocation-reversed"].includes(m.kind)
    ).reduce((total, m) => total + BigInt(m.amountCents), 0n) ?? 0n;
  const remaining = payment
    ? BigInt(payment.amountCents) - paymentAssigned
    : 0n;
  const frozen = busy || !!lastKey;

  function revise<T>(setValue: (value: T) => void, value: T) {
    setValue(value);
    setReviewed(false);
  }

  function synced(record: LocalRecord | undefined) {
    if (!record || record.state !== "synced" || record.serverVersion < 1) {
      throw new Error(
        "O rascunho precisa estar sincronizado e sem conflito antes da confirmação.",
      );
    }
    return record;
  }

  function action(): FinancialAction {
    if (!preview) {
      throw new Error(
        "Consulte os dados atuais do servidor antes de confirmar.",
      );
    }
    switch (request.type) {
      case "statute_publish":
        return {
          type: request.type,
          groupVersion: synced(group).serverVersion,
        };
      case "statute_accept":
        if (!statute) {
          throw new Error(
            "Publique os combinados antes de registrar um aceite.",
          );
        }
        return {
          type: request.type,
          statuteId: statute.id,
          personId: request.personId,
          evidence: evidence.trim(),
        };
      case "payment_confirm": {
        synced(proposal);
        if (!proposal) throw new Error("Proposta não encontrada.");
        const amountCents = allocate ? parseBRL(amount) : "0";
        if (
          allocate &&
          (BigInt(amountCents) <= 0n ||
            BigInt(amountCents) > BigInt(proposal.data.amountCents))
        ) {
          throw new Error(
            "A destinação deve ser positiva e não pode superar o recebimento.",
          );
        }
        return {
          type: request.type,
          proposalId: proposal.id,
          proposalVersion: proposal.serverVersion,
          bankReference: bankReference.trim() || null,
          declaredReceivedAt: receivedAt
            ? brasiliaDateTimeToUTC(receivedAt)
            : null,
          allocations: allocate ? [{ poolId, amountCents }] : [],
        };
      }
      case "payment_allocate": {
        if (!payment) throw new Error("Recebimento não encontrado.");
        const amountCents = parseBRL(amount);
        if (BigInt(amountCents) <= 0n || BigInt(amountCents) > remaining) {
          throw new Error(
            "A destinação deve ser positiva e não pode superar o saldo deste recebimento.",
          );
        }
        return {
          type: request.type,
          paymentId: payment.id,
          poolId,
          amountCents,
        };
      }
      case "payment_reverse":
        if (!payment) throw new Error("Recebimento não encontrado.");
        return {
          type: request.type,
          paymentId: payment.id,
          reason: reason.trim(),
        };
      case "quota_confirm":
        synced(quota);
        if (!quota || !statute) {
          throw new Error("Confira a cota e os combinados vigentes.");
        }
        return {
          type: request.type,
          quotaId: quota.id,
          quotaVersion: quota.serverVersion,
          statuteId: statute.id,
        };
      case "recover":
        if (!preview.persistent) throw new Error("Decisão não encontrada.");
        return preview.persistent.command.action;
    }
  }

  function reviewOf(decision: FinancialAction): DecisionReview {
    const lines = [`Grupo: ${group?.data.name ?? groupId}.`];
    if (person) lines.push(`Pessoa: ${person.data.name}.`);
    switch (decision.type) {
      case "statute_publish":
        lines.push(
          `Publicar versão ${(statute?.version ?? 0) + 1}.`,
          group?.data.statute ?? "",
        );
        break;
      case "statute_accept":
        lines.push(
          `Combinados da versão ${statute?.version}: ${statute?.text}`,
          `Evidência: ${decision.evidence}`,
        );
        break;
      case "payment_confirm":
        lines.push(
          `Recebimento: ${formatBRL(proposal!.data.amountCents)}.`,
          `Referência bancária: ${decision.bankReference ?? "Não informada"}.`,
          `Data declarada: ${
            decision.declaredReceivedAt
              ? date(decision.declaredReceivedAt)
              : "Não informada"
          }.`,
        );
        decision.allocations.forEach((allocation) =>
          lines.push(
            `Destinação: ${formatBRL(allocation.amountCents)} para ${
              pools.find((p) => p.id === allocation.poolId)?.data.title ??
                "bolão do grupo"
            }.`,
          )
        );
        lines.push(
          `Sem destino: ${
            formatBRL(
              (BigInt(proposal!.data.amountCents) -
                decision.allocations.reduce(
                  (total, allocation) => total + BigInt(allocation.amountCents),
                  0n,
                )).toString(),
            )
          }. A participação não é confirmada por este recebimento.`,
        );
        break;
      case "payment_allocate":
        lines.push(
          `Destinar ${
            formatBRL(decision.amountCents)
          } para ${selectedPool?.data.title}. O caixa do grupo não aumenta.`,
        );
        break;
      case "payment_reverse":
        lines.push(
          `Estornar integralmente ${
            formatBRL(payment!.amountCents)
          }, compensar suas destinações e revogar direitos que perderem o pagamento integral.`,
          `Motivo: ${decision.reason}`,
        );
        break;
      case "quota_confirm":
        lines.push(
          `Confirmar ${
            formatQuotaUnits(quota!.data.units)
          } cota(s) de ${selectedPool?.data.title} por ${
            formatBRL(
              quotaCost(selectedPool!.data.quotaPriceCents, quota!.data.units),
            )
          }.`,
          `Combinados da versão ${statute?.version}. Prazo: ${
            selectedPool?.data.deadlineAt
              ? date(selectedPool.data.deadlineAt)
              : "A definir"
          }.`,
        );
        break;
    }
    return { title: titles[decision.type], lines };
  }

  async function checkReceipt() {
    if (!lastKey || !enabled || !navigator.onLine) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await recoverFinancialCommand(
        db,
        createAccountTransport(db.accountId),
        lastKey,
      );
      if (!mounted.current) return;
      if (receipt) {
        onNotice({
          text: receipt.status === "accepted"
            ? "Decisão confirmada pelo servidor. O registro foi recuperado."
            : receipt.message ??
              "A decisão não foi aceita. Atualize os dados e faça uma nova revisão.",
          error: receipt.status !== "accepted",
        });
        onClose();
      } else {
        setRecoveryChecked(true);
        setError(
          "O servidor ainda não retornou um recibo. Você pode verificar novamente ou reenviar explicitamente a mesma decisão; ela mantém a chave original.",
        );
      }
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || !navigator.onLine) {
      setError(availability);
      return;
    }
    if (!reviewed) {
      setError("Confira os dados e marque a confirmação humana.");
      return;
    }
    setBusy(true);
    sending.current = true;
    setError(null);
    try {
      let key = lastKey;
      if (!key) {
        if (!preview) {
          throw new Error("Os dados atuais ainda não foram consultados.");
        }
        const command = {
          apiVersion: "v1" as const,
          idempotencyKey: crypto.randomUUID(),
          groupId,
          expectedRevision: preview.snapshot.groupRevision,
          action: action(),
        };
        const review = reviewOf(command.action);
        await db.transaction(
          "rw",
          db.financialCommands,
          db.metadata,
          async () => {
            await prepareFinancialCommand(db, command);
            await db.metadata.put({
              key: `financial-review:${command.idempotencyKey}`,
              value: review,
            });
          },
        );
        key = command.idempotencyKey;
        approvedKey.current = key;
        setDecisionReview(review);
        setLastKey(key);
      } else if (!recoveryChecked) {
        throw new Error("Consulte o recibo antes de reenviar a mesma decisão.");
      }
      setRecoveryChecked(false);
      setReviewed(false);
      const receipt = await executeFinancialCommand(
        db,
        createAccountTransport(db.accountId),
        key,
      );
      if (!mounted.current) return;
      if (receipt.status === "accepted") {
        onNotice({ text: "Decisão registrada no servidor." });
        onClose();
      } else {
        onNotice({
          text: receipt.message ??
            "A decisão não foi aceita. Sincronize e confira os dados novamente.",
          error: true,
        });
        onClose();
      }
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Modal
      title={titles[request.type]}
      description="Confira os dados antes de decidir. Vale o que está nesta tela; se algo mudar no grupo enquanto isso, você confere de novo."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!enabled
        ? (
          <p className="modal-why">{availability}</p>
        )
        : (
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            {busy && !preview && (
              <p className="muted">
                <LoaderCircle className="spin" size={18} />{" "}
                Consultando os dados atuais…
              </p>
            )}
            {preview && (
              <>
                {lastKey && (
                  <section
                    className="statute-text"
                    aria-label="Decisão original"
                  >
                    <strong>
                      {decisionReview?.title ?? "Decisão registrada"}
                    </strong>
                    {decisionReview?.lines.map((line, index) => (
                      <p key={index}>{line}</p>
                    )) ?? (
                      <p>
                        O resumo desta decisão não está disponível. Consulte o
                        recibo do servidor.
                      </p>
                    )}
                  </section>
                )}
                {!lastKey && (
                  <>
                    {person && (
                      <p className="finance-subject">
                        {person.data.name}
                        <small>
                          {selectedPool?.data.title ?? group?.data.name}
                        </small>
                      </p>
                    )}
                    {request.type === "statute_publish" && (
                      <>
                        <p>
                          Será publicada a versão{" "}
                          {(statute?.version ?? 0) + 1}. Os aceites anteriores
                          continuam registrados.
                        </p>
                        <p className="statute-text">{group?.data.statute}</p>
                      </>
                    )}
                    {request.type === "statute_accept" && (
                      <>
                        <p className="statute-text">
                          Versão {statute?.version}: {statute?.text}
                        </p>
                        <label>
                          Evidência do aceite<textarea
                            required
                            minLength={3}
                            maxLength={2000}
                            value={evidence}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setEvidence, event.target.value)}
                            placeholder="Ex.: mensagem da pessoa em 07/10, concordando com esta versão."
                          />
                        </label>
                      </>
                    )}
                    {request.type === "payment_confirm" && proposal && (
                      <>
                        <div className="cost-preview">
                          Recebimento a confirmar<strong>
                            {formatBRL(proposal.data.amountCents)}
                          </strong>
                        </div>
                        <p className="muted">
                          {proposal.data.note || "Sem observações."}{" "}
                          A cota continuará aguardando conferência própria.
                        </p>
                        <label>
                          Referência bancária{" "}
                          <span className="muted">(opcional)</span>
                          <input
                            value={bankReference}
                            maxLength={200}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setBankReference, event.target.value)}
                            placeholder="Identificador da transferência"
                          />
                          <small>
                            Uma referência repetida no mesmo grupo será
                            recusada.
                          </small>
                        </label>
                        <label>
                          Data do recebimento{" "}
                          <span className="muted">(horário de Brasília, opcional)</span>
                          <input
                            type="datetime-local"
                            value={receivedAt}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setReceivedAt, event.target.value)}
                          />
                        </label>
                        {afterDeadline && (
                          <p className="modal-why" role="status">
                            Depois do prazo combinado ({afterDeadline}). Confira
                            a hora; se estiver certa, pode salvar: a cota ainda
                            entra até o bolão travar.
                          </p>
                        )}
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={allocate}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setAllocate, event.target.checked)}
                          />
                          <span>
                            Destinar parte ou todo o valor a um bolão agora.
                          </span>
                        </label>
                      </>
                    )}
                    {(request.type === "payment_allocate" ||
                      request.type === "payment_confirm" && allocate) && (
                      <>
                        {request.type === "payment_allocate" && (
                          <div className="cost-preview">
                            Disponível neste recebimento<strong>
                              {formatBRL(remaining.toString())}
                            </strong>
                          </div>
                        )}
                        <label>
                          Bolão de destino<select
                            required
                            value={poolId}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setPoolId, event.target.value)}
                          >
                            {pools.filter((p) => p.data.status === "draft").map(
                              (p) => (
                                <option key={p.id} value={p.id}>
                                  {p.data.title}
                                </option>
                              ),
                            )}
                          </select>
                        </label>
                        <label>
                          Valor a destinar<MoneyInput
                            required
                            value={amount}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setAmount, event.target.value)}
                          />
                        </label>
                        <p className="muted">
                          O restante continua no caixa do grupo, identificado
                          por pessoa, até você escolher outro destino.
                        </p>
                      </>
                    )}
                    {request.type === "payment_reverse" && payment && (
                      <>
                        <div className="cost-preview">
                          Estorno integral<strong>
                            {formatBRL(payment.amountCents)}
                          </strong>
                        </div>
                        <p>
                          As destinações deste recebimento também serão
                          compensadas. Participações que perderem o pagamento
                          integral serão revogadas. O servidor recusará o
                          estorno se houver bolão já fechado.
                        </p>
                        <label>
                          Motivo do estorno<textarea
                            required
                            minLength={3}
                            maxLength={2000}
                            value={reason}
                            disabled={frozen}
                            onChange={(event) =>
                              revise(setReason, event.target.value)}
                          />
                        </label>
                      </>
                    )}
                    {request.type === "quota_confirm" && quota &&
                      selectedPool && (
                      <>
                        <div className="cost-preview">
                          {formatQuotaUnits(quota.data.units)} cota(s)<strong>
                            {draftQuotaCost(
                                selectedPool.data.quotaPriceCents,
                                quota.data.units,
                              ) === null
                              ? "Ajustar preço ou cota"
                              : formatBRL(
                                quotaCost(
                                  selectedPool.data.quotaPriceCents,
                                  quota.data.units,
                                ),
                              )}
                          </strong>
                        </div>
                        <p>
                          Destinado para esta pessoa e bolão:{" "}
                          <strong>
                            {formatBRL(
                              view?.personPoolFunding(
                                selectedPool.id,
                                quota.data.personId,
                              ) ?? "0",
                            )}
                          </strong>.
                        </p>
                        <p>
                          Combinados: versão {statute?.version}. Prazo
                          combinado:{" "}
                          {selectedPool.data.deadlineAt
                            ? date(selectedPool.data.deadlineAt)
                            : "A definir"}. Depois dele a cota ainda entra, até
                          o bolão travar.
                        </p>
                      </>
                    )}
                    {request.type === "recover" && preview.persistent && (
                      <>
                        <p>
                          Decisão:{" "}
                          <strong>
                            {titles[preview.persistent.command.action.type]}
                          </strong>.
                        </p>
                        <p>
                          Enviada em{" "}
                          {date(preview.persistent.createdAt)}. Consulte o
                          recibo. Se reenviar, será preservada exatamente a
                          decisão original, incluindo sua versão.
                        </p>
                      </>
                    )}
                  </>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    required
                    checked={reviewed}
                    disabled={busy}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  <span>
                    {lastKey
                      ? "Conferi esta decisão e autorizo reenviar o mesmo comando se ainda não houver recibo."
                      : request.type === "payment_confirm"
                      ? "Conferi o recebimento e confirmo os valores e o destino acima."
                      : request.type === "statute_accept"
                      ? "Conferi a evidência de que a pessoa aceitou esta versão."
                      : "Conferi os dados e confirmo esta decisão."}
                  </span>
                </label>
              </>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={onClose}
              >
                Fechar revisão
              </button>
              {lastKey && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !enabled}
                  onClick={() => {
                    void checkReceipt();
                  }}
                >
                  <RefreshCw size={16} />Consultar recibo
                </button>
              )}
              <button
                className="button primary"
                type="submit"
                disabled={busy || !preview || !reviewed ||
                  !!lastKey && (!recoveryChecked || !decisionReview)}
              >
                {busy
                  ? <LoaderCircle className="spin" size={16} />
                  : <Check size={16} />}
                {lastKey ? "Reenviar mesma decisão" : "Confirmar no servidor"}
              </button>
            </div>
          </form>
        )}
    </Modal>
  );
}
