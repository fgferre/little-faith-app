import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  brasiliaDateTimeToUTC,
  computeSettlement,
  createRedemptionDeadline,
  createResultView,
  formatBRL,
  parseBRL,
  validateSettlementActionContext,
  validateSettlementCommand,
} from "@bolao/core";
import type {
  LocalRecord,
  OfficialPrizeEntitlement,
  PoolManifest,
  PoolSettlement,
  PoolSettlementBalance,
  SettlementAction,
  SettlementCommand,
  SettlementReceipt,
  SettlementSnapshot,
} from "@bolao/core";
import {
  applySettlementSnapshot,
  executeSettlementCommand,
  prepareSettlementCommand,
  recoverSettlementCommand,
  sync,
} from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { createAccountTransport } from "../auth";
import { Modal, SectionTitle } from "../components";
import { readReviewSnapshot } from "../review-snapshot";
import { Button, Chip, Disclosure, formatInstant, ProblemBox } from "../ui";
import { hoje } from "../ui/texto";
import type { Notice } from "../app-shared";

/** O que a pessoa quer fazer; a janela monta o pedido com os dados atuais do servidor. */
export type Intencao =
  | { type: "expense_confirm"; poolId: string }
  | { type: "prize_confirm"; poolId: string; contestNumber: number }
  | { type: "redemption_record"; poolId: string; personId: string }
  | { type: "redemption_reverse"; poolId: string; redemptionId: string }
  | {
    type: "distribution_record";
    poolId: string;
    personId: string;
    kind: "prize-payment" | "contribution-refund";
  }
  | { type: "distribution_reverse"; poolId: string; distributionId: string }
  | {
    type: "pool_settle";
    poolId: string;
    leftoverDisposition: PoolSettlement["leftoverDisposition"];
    pendingExplanation: string;
  }
  | { type: "pool_reopen"; poolId: string; closureId: string };
export type PedidoDivisao = { intent: Intencao } | { idempotencyKey: string };

interface Resumo {
  title: string;
  lines: string[];
}
interface Contexto {
  snapshot: SettlementSnapshot;
  pool: LocalRecord<"pool">;
  manifest: PoolManifest;
  balance: PoolSettlementBalance;
  /** Agora, nunca antes do último horário confirmado pelo servidor neste bolão. */
  now: string;
}
interface Campos {
  amount: string;
  cost: string;
  fee: string;
  date: string;
  evidenceIds: string[];
  reference: string;
  reason: string;
  official: Record<string, string>;
}

const aberto = (item: { status: string }) =>
  ["prepared", "sending", "unknown"].includes(item.status);
const texto = (value: unknown, fallback: string) =>
  value instanceof Error ? value.message : fallback;
/** Centavos para o campo de valor: "1.000,00". */
const campo = (cents: string | null) =>
  cents === null ? "" : formatBRL(cents).slice(3);
const depois = (a: string, b: string) => a > b ? a : b;
const latest = <T extends { poolId: string; version: number }>(
  facts: T[],
  poolId: string,
) =>
  facts.filter((fact) => fact.poolId === poolId).sort((a, b) =>
    b.version - a.version
  )[0];
const nome = (manifest: PoolManifest, personId: string) =>
  manifest.content.persons.find((person) => person.id === personId)?.data
    .name ?? "Participante";

function oficiais(snapshot: SettlementSnapshot, poolId: string) {
  const report = latest(snapshot.registration.reports, poolId);
  return (report?.items ?? []).flatMap((item) =>
    (item.observed?.officialAssignments ?? []).map((assignment) => ({
      ...assignment,
      plannedTicketKey: item.plannedTicketKey,
    }))
  );
}
const chaveOficial = (row: { plannedTicketKey: string; quotaId: string }) =>
  `${row.plannedTicketKey}:${row.quotaId}`;

/** Encerrar e reabrir não movem dinheiro: sem comprovante, referência ou data. */
const fechamento = (intent: Intencao) =>
  intent.type === "pool_settle" || intent.type === "pool_reopen";
function evidenciaObrigatoria(intent: Intencao, campos: Campos) {
  if (fechamento(intent)) return false;
  if (intent.type !== "prize_confirm") return true;
  try {
    return BigInt(parseBRL(campos.amount)) > 0n;
  } catch {
    return true;
  }
}
const motivoObrigatorio = (intent: Intencao) =>
  intent.type === "distribution_record" ||
  intent.type === "redemption_reverse" ||
  intent.type === "distribution_reverse" || fechamento(intent);

function inicial(intent: Intencao, ctx: Contexto): Campos {
  const { snapshot, balance, manifest } = ctx;
  const base: Campos = {
    amount: "",
    cost: "",
    fee: "",
    date: hoje(),
    evidenceIds: [],
    reference: "",
    reason: "",
    official: {},
  };
  const person = "personId" in intent
    ? balance.persons.find((p) => p.personId === intent.personId)
    : undefined;
  switch (intent.type) {
    case "expense_confirm": {
      const report = latest(snapshot.registration.reports, intent.poolId);
      return {
        ...base,
        cost: campo(report?.comparison.observedBetCostCents ?? null),
        fee: campo(report?.comparison.observedFeeCents ?? null),
        reference: "Comprovante das apostas",
      };
    }
    case "prize_confirm":
      return {
        ...base,
        amount: campo(
          balance.contests.find((c) => c.contestNumber === intent.contestNumber)
            ?.calculatedPrizeCents ?? null,
        ),
        reference: "Resultado do concurso",
      };
    case "redemption_record": {
      const amount = balance.participationMode === "official"
        ? (BigInt(person?.prizeRightCents ?? "0") -
          BigInt(person?.prizeReceivedCents ?? "0")).toString()
        : balance.unredeemedPrizeCents;
      return { ...base, amount: campo(amount), reference: "Resgate do prêmio" };
    }
    case "distribution_record": {
      const who = nome(manifest, intent.personId);
      if (intent.kind === "contribution-refund") {
        return {
          ...base,
          amount: campo(person?.refundPendingCents ?? null),
          reference: `Devolução a ${who}`,
          reason: manifest.content.plan.leftoverPolicy === "group-credit"
            ? `Devolução do que ${who} pagou a mais.`
            : `Devolução da sobra das cotas para ${who}.`,
        };
      }
      const pending = BigInt(person?.prizePendingCents ?? "0");
      const available = BigInt(balance.organizerRedeemedCents) -
        BigInt(balance.prizePaidCents);
      return {
        ...base,
        amount: campo(
          (pending < available ? pending : available > 0n ? available : pending)
            .toString(),
        ),
        reference: `Pagamento a ${who}`,
        reason: `Parte do prêmio de ${who}.`,
      };
    }
    case "redemption_reverse":
      return { ...base, reference: "Correção do resgate" };
    case "distribution_reverse":
      return { ...base, reference: "Correção do pagamento" };
    case "pool_settle":
      return { ...base, reason: "Conta do bolão conferida." };
    case "pool_reopen":
      return { ...base, reason: "Reabrir para corrigir a conta." };
  }
}

function montar(intent: Intencao, ctx: Contexto, f: Campos): SettlementAction {
  const { snapshot, manifest } = ctx;
  const base = { poolId: intent.poolId, poolVersion: ctx.pool.serverVersion };
  const fonte = {
    evidenceIds: f.evidenceIds,
    sourceReference: f.reference.trim(),
    reason: f.reason.trim(),
  };
  if (f.date > hoje()) throw new Error("A data não pode ser depois de hoje.");
  const eventAt = f.date === hoje()
    ? ctx.now
    : brasiliaDateTimeToUTC(`${f.date}T12:00`);
  const report = latest(snapshot.registration.reports, intent.poolId);
  switch (intent.type) {
    case "expense_confirm":
      if (!report) throw new Error("Falta conferir o registro.");
      return {
        ...base,
        ...fonte,
        type: "expense_confirm",
        registrationReportId: report.id,
        supersedesId: latest(snapshot.expenses, intent.poolId)?.id ?? null,
        betCostCents: parseBRL(f.cost),
        feeCents: parseBRL(f.fee || "0"),
      };
    case "prize_confirm": {
      const result = createResultView(snapshot.results).currentResult(
        intent.poolId,
        intent.contestNumber,
      );
      const contest = ctx.balance.contests.find((c) =>
        c.contestNumber === intent.contestNumber
      );
      if (!report) throw new Error("Falta conferir o registro.");
      if (!result.result || result.status === "conflict") {
        throw new Error("Escolha o resultado que vale no Sorteio.");
      }
      const official: OfficialPrizeEntitlement[] =
        manifest.content.plan.participationMode === "official"
          ? oficiais(snapshot, intent.poolId).map((row) => ({
            ...row,
            amountCents: parseBRL(f.official[chaveOficial(row)] ?? ""),
            evidenceIds: f.evidenceIds,
          }))
          : [];
      return {
        ...base,
        ...fonte,
        type: "prize_confirm",
        registrationReportId: report.id,
        resultId: result.result.id,
        supersedesId: contest?.prizeConfirmationId ?? null,
        amountCents: official.length
          ? official.reduce((sum, row) => sum + BigInt(row.amountCents), 0n)
            .toString()
          : parseBRL(f.amount),
        officialEntitlements: official,
        redemptionDeadline: result.result.drawDate
          ? createRedemptionDeadline(
            manifest.content.plan.lotteryId,
            result.result.drawDate,
          )
          : null,
      };
    }
    case "redemption_record": {
      const prize = latest(snapshot.prizes, intent.poolId);
      if (!prize) throw new Error("Confirme o prêmio antes do resgate.");
      return {
        ...base,
        ...fonte,
        type: "redemption_record",
        prizeConfirmationId: prize.id,
        personId: intent.personId,
        amountCents: parseBRL(f.amount),
        eventAt,
      };
    }
    case "redemption_reverse":
      return {
        ...base,
        ...fonte,
        type: "redemption_reverse",
        redemptionId: intent.redemptionId,
        eventAt,
      };
    case "distribution_record":
      return {
        ...base,
        ...fonte,
        type: "distribution_record",
        personId: intent.personId,
        kind: intent.kind,
        amountCents: parseBRL(f.amount),
        eventAt,
      };
    case "distribution_reverse":
      return {
        ...base,
        ...fonte,
        type: "distribution_reverse",
        distributionId: intent.distributionId,
        eventAt,
      };
    case "pool_settle":
      if (!report) throw new Error("Falta conferir o registro.");
      return {
        ...base,
        type: "pool_settle",
        registrationReportId: report.id,
        prizeConfirmationId: latest(snapshot.prizes, intent.poolId)?.id ?? null,
        expenseConfirmationId: latest(snapshot.expenses, intent.poolId)?.id ??
          null,
        leftoverDisposition: intent.leftoverDisposition,
        pendingExplanation: intent.pendingExplanation,
        reason: fonte.reason,
      };
    case "pool_reopen":
      return {
        ...base,
        type: "pool_reopen",
        closureId: intent.closureId,
        reason: fonte.reason,
      };
  }
}

function titulo(action: SettlementAction, manifest: PoolManifest | null) {
  const who = (id: string) => manifest ? nome(manifest, id) : "a pessoa";
  switch (action.type) {
    case "expense_confirm":
      return action.supersedesId ? "Corrigir o custo" : "Confirmar o custo";
    case "prize_confirm":
      return action.supersedesId ? "Corrigir o prêmio" : "Confirmar o prêmio";
    case "redemption_record":
      return "Recebi o prêmio";
    case "redemption_reverse":
      return "Desfazer o resgate";
    case "distribution_record":
      return action.kind === "prize-payment"
        ? `Já paguei ${who(action.personId)}`
        : `Devolver para ${who(action.personId)}`;
    case "distribution_reverse":
      return "Desfazer o pagamento";
    case "pool_settle":
      return "Encerrar o bolão";
    case "pool_reopen":
      return "Reabrir o bolão";
  }
}
const FEITO: Record<SettlementAction["type"], string> = {
  expense_confirm: "Custo confirmado.",
  prize_confirm: "Prêmio confirmado.",
  redemption_record: "Resgate registrado.",
  redemption_reverse: "Resgate desfeito.",
  distribution_record: "Pagamento registrado.",
  distribution_reverse: "Pagamento desfeito.",
  pool_settle: "Bolão encerrado.",
  pool_reopen: "Bolão reaberto.",
};

function resumir(
  action: SettlementAction,
  ctx: Contexto,
  timeZone: string,
): Resumo {
  const { snapshot, manifest } = ctx;
  const lines: string[] = [];
  if (action.type === "expense_confirm") {
    lines.push(
      `Custo: ${
        formatBRL(
          (BigInt(action.betCostCents) + BigInt(action.feeCents)).toString(),
        )
      } (apostas ${formatBRL(action.betCostCents)} + taxa ${
        formatBRL(action.feeCents)
      }).`,
    );
  } else if (action.type === "prize_confirm") {
    lines.push(`Prêmio: ${formatBRL(action.amountCents)}.`);
    for (const row of action.officialEntitlements) {
      lines.push(
        `${nome(manifest, row.personId)}: ${formatBRL(row.amountCents)}.`,
      );
    }
  } else if (action.type === "redemption_record") {
    lines.push(
      `Resgate: ${formatBRL(action.amountCents)} recebidos por ${
        nome(manifest, action.personId)
      }.`,
    );
  } else if (action.type === "redemption_reverse") {
    const original = snapshot.redemptions.find((item) =>
      item.id === action.redemptionId
    );
    lines.push(
      `Desfazer o resgate de ${
        original ? formatBRL(original.amountCents) : "valor anterior"
      }. O registro original continua guardado.`,
    );
  } else if (action.type === "distribution_record") {
    lines.push(
      `${action.kind === "prize-payment" ? "Pagamento" : "Devolução"}: ${
        formatBRL(action.amountCents)
      } para ${nome(manifest, action.personId)}.`,
    );
  } else if (action.type === "distribution_reverse") {
    const original = snapshot.distributions.find((item) =>
      item.id === action.distributionId
    );
    lines.push(
      `Desfazer o pagamento de ${
        original ? formatBRL(original.amountCents) : "valor anterior"
      }${
        original ? ` para ${nome(manifest, original.personId)}` : ""
      }. O registro original continua guardado.`,
    );
  } else if (action.type === "pool_settle") {
    const { balance } = ctx;
    const valor = (cents: string | null) =>
      cents === null ? "a confirmar" : formatBRL(cents);
    lines.push(
      `Encerrar a conta do bolão. Prêmio a pagar: ${
        valor(balance.unpaidPrizeCents)
      }; devoluções pendentes: ${valor(balance.refundPendingCents)}.`,
      `Sobra das cotas: ${valor(balance.contributionSurplusCents)}, ${
        action.leftoverDisposition === "group-reserve"
          ? "fica no caixa do grupo"
          : "volta para as pessoas"
      }.`,
      action.pendingExplanation.trim()
        ? `Fica pendente: ${action.pendingExplanation}`
        : "Nada fica pendente.",
      "Depois de encerrado, nenhum valor muda até alguém reabrir o bolão.",
    );
  } else if (action.type === "pool_reopen") {
    lines.push(
      "Reabrir o bolão para corrigir a conta. O encerramento anterior continua guardado.",
    );
  }
  if ("eventAt" in action) {
    lines.push(`Data: ${formatInstant(action.eventAt, timeZone)}.`);
  }
  if ("evidenceIds" in action) {
    const files = action.evidenceIds.map((id) =>
      snapshot.registration.evidence.find((item) => item.id === id)
        ?.originalName ?? "arquivo"
    );
    lines.push(
      files.length ? `Comprovante: ${files.join(", ")}.` : "Sem comprovante.",
    );
    lines.push(`Referência: ${action.sourceReference}.`);
  }
  if (action.reason) lines.push(`Motivo: ${action.reason}`);
  return { title: titulo(action, manifest), lines };
}

/** Pedidos da divisão que ficaram sem resposta, na mesma lista das outras conferências da Revisão. */
export function DivisaoPendente(
  { db, groupId, open }: {
    db: BolaoDatabase;
    groupId: string;
    open: (request: PedidoDivisao) => void;
  },
) {
  const scope = `${db.name}:${groupId}`;
  const raw = useLiveQuery(async () => ({
    scope,
    commands: await db.settlementCommands.where("groupId").equals(groupId)
      .toArray(),
  }), [db, groupId]);
  if (raw?.scope !== scope) return null;
  return (
    <>
      {raw.commands.map((saved) =>
        aberto(saved)
          ? (
            <section
              className="panel finance-pending"
              key={saved.idempotencyKey}
            >
              <SectionTitle
                title="Divisão do prêmio aguardando verificação"
                subtitle="O pedido original ficou salvo. Consulte se ele foi aceito antes de repetir."
              />
              <button
                className="button secondary"
                onClick={() => open({ idempotencyKey: saved.idempotencyKey })}
              >
                <RefreshCw size={17} />Verificar a divisão do prêmio
              </button>
            </section>
          )
          : ["rejected", "conflict"].includes(saved.status)
          ? (
            <p className="inline-note" key={saved.idempotencyKey}>
              <span>
                <strong>Divisão do prêmio não confirmada:</strong>{" "}
                {saved.status === "conflict"
                  ? "alguém mudou o grupo antes da confirmação."
                  : saved.receipt?.message ??
                    "confira os dados e faça um novo pedido."}
              </span>
            </p>
          )
          : null
      )}
    </>
  );
}

type Fim =
  | { status: "accepted"; receipt: SettlementReceipt; done: string }
  | { status: "conflict" }
  | { status: "rejected"; message: string };

/** Uma janela para cada ação da divisão: confere online, guarda o pedido, envia e mostra o recibo. */
export function DivisaoDecisao(
  {
    db,
    groupId,
    request,
    enabled,
    availability,
    timeZone,
    onClose,
    onNotice,
    goRegistrar,
  }: {
    db: BolaoDatabase;
    groupId: string;
    request: PedidoDivisao;
    enabled: boolean;
    availability: string;
    timeZone: string;
    onClose: () => void;
    onNotice: (notice: Notice) => void;
    /** Anexar outro comprovante fica no Registrar. */
    goRegistrar?: () => void;
  },
) {
  const intent = "intent" in request ? request.intent : null;
  const savedKey = useRef(
    "idempotencyKey" in request ? request.idempotencyKey : null,
  );
  const [key, setKey] = useState(savedKey.current);
  const [ctx, setCtx] = useState<Contexto | null>(null);
  const [fields, setFields] = useState<Campos | null>(null);
  const [saved, setSaved] = useState<Resumo | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [end, setEnd] = useState<Fim | null>(null);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true), sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    setReviewed(false);
    async function load() {
      if (savedKey.current) {
        const stored = await db.settlementCommands.get(savedKey.current);
        const shown = await db.metadata.get(
          `settlement-review:${savedKey.current}`,
        );
        if (!stored || stored.groupId !== groupId || !shown?.value) {
          throw new Error(
            "O pedido original não está guardado nesta conta e grupo. Confira o bolão antes de repetir.",
          );
        }
        if (active) setSaved(shown.value as Resumo);
        return;
      }
      if (!intent || !enabled) return;
      const transport = createAccountTransport(db.accountId);
      await sync(db, transport);
      const snapshot = await transport.settlementPull(groupId);
      await applySettlementSnapshot(db, snapshot);
      const read = await readReviewSnapshot(
        db,
        groupId,
        snapshot.groupRevision,
      );
      if (
        [
          ...read.financialCommands,
          ...read.planningCommands,
          ...read.registrationCommands,
          ...read.resultCommands,
          ...read.settlementCommands,
        ].some(aberto)
      ) {
        throw new Error(
          "Há um pedido esperando verificação na Revisão. Confira esse pedido antes de fazer outro.",
        );
      }
      const pool = read.records.find((item) =>
        item.id === intent.poolId && item.kind === "pool"
      ) as LocalRecord<"pool"> | undefined;
      if (
        !pool ||
        read.localRecords.some((item) =>
          item.id === intent.poolId && item.state !== "synced"
        )
      ) {
        throw new Error(
          "O bolão tem mudanças ainda não enviadas. Sincronize e tente de novo.",
        );
      }
      const balance = computeSettlement(snapshot).pools[intent.poolId];
      const manifest = snapshot.registration.manifests.find((item) =>
        item.id === balance?.manifestId
      );
      if (!balance || !manifest) {
        throw new Error("O bolão ainda não foi travado e registrado.");
      }
      const times = [
        ...snapshot.registration.reports,
        ...snapshot.expenses,
        ...snapshot.prizes,
        ...snapshot.redemptions,
        ...snapshot.distributions,
        ...snapshot.closures,
      ].filter((fact) => fact.poolId === intent.poolId).map((fact) =>
        fact.confirmedAt
      );
      const next: Contexto = {
        snapshot,
        pool,
        manifest,
        balance,
        now: times.reduce(depois, new Date().toISOString()),
      };
      if (active) {
        setCtx(next);
        setFields(inicial(intent, next));
      }
    }
    void load().catch((failure) => {
      if (active) {
        setError(texto(failure, "Não foi possível consultar o servidor."));
      }
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
    // The intent is fixed for this dialog; `reload` asks for a fresh check.
  }, [db, groupId, enabled, reload]);

  const preview = useMemo(() => {
    if (!intent || !ctx || !fields) return null;
    if (evidenciaObrigatoria(intent, fields) && !fields.evidenceIds.length) {
      return { hint: "Marque o comprovante." };
    }
    if (!fechamento(intent) && !fields.reference.trim()) {
      return { hint: "Escreva a referência." };
    }
    if (motivoObrigatorio(intent) && !fields.reason.trim()) {
      return { hint: "Escreva o motivo." };
    }
    try {
      const action = montar(intent, ctx, fields);
      validateSettlementActionContext(
        ctx.snapshot,
        action,
        depois(new Date().toISOString(), ctx.now),
      );
      return { action };
    } catch (failure) {
      return { problem: texto(failure, "Confira os valores.") };
    }
  }, [intent, ctx, fields]);

  function update(change: Partial<Campos>) {
    setReviewed(false);
    setFields((current) => current ? { ...current, ...change } : current);
  }

  function finish(receipt: SettlementReceipt, done: string) {
    if (!mounted.current) return;
    if (receipt.status === "accepted") {
      setEnd({ status: "accepted", receipt, done });
      onNotice({ text: done });
      void sync(db, createAccountTransport(db.accountId)).catch(() =>
        undefined
      );
    } else if (receipt.status === "conflict") setEnd({ status: "conflict" });
    else {
      setEnd({
        status: "rejected",
        message: receipt.message ?? "O pedido não foi aceito.",
      });
    }
  }

  async function confirm() {
    if (
      !enabled || !intent || !ctx || !preview?.action || !reviewed ||
      sending.current
    ) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const action = preview.action;
    try {
      const command: SettlementCommand = validateSettlementCommand({
        apiVersion: "v1",
        idempotencyKey: crypto.randomUUID(),
        groupId,
        expectedRevision: ctx.snapshot.groupRevision,
        action,
      });
      const shown = resumir(action, ctx, timeZone);
      await db.transaction(
        "rw",
        [db.settlementCommands, db.metadata],
        async () => {
          await prepareSettlementCommand(db, command);
          await db.metadata.put({
            key: `settlement-review:${command.idempotencyKey}`,
            value: structuredClone(shown),
          });
        },
      );
      savedKey.current = command.idempotencyKey;
      if (mounted.current) {
        setKey(command.idempotencyKey);
        setSaved(shown);
      }
      finish(
        await executeSettlementCommand(
          db,
          createAccountTransport(db.accountId),
          command.idempotencyKey,
        ),
        FEITO[action.type],
      );
    } catch (failure) {
      if (mounted.current) {
        setError(
          savedKey.current
            ? "A resposta não chegou. O pedido ficou guardado: consulte se ele foi aceito antes de tentar de novo."
            : texto(failure, "Não foi possível guardar o pedido."),
        );
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function recover() {
    if (!savedKey.current || !enabled || sending.current) return;
    sending.current = true;
    setBusy(true);
    setReviewed(false);
    setError(null);
    try {
      const stored = await db.settlementCommands.get(savedKey.current);
      const receipt = await recoverSettlementCommand(
        db,
        createAccountTransport(db.accountId),
        savedKey.current,
      );
      if (receipt) {
        finish(
          receipt,
          stored ? FEITO[stored.command.action.type] : "Pedido confirmado.",
        );
      } else if (mounted.current) {
        setRecoveryChecked(true);
        setError(
          "O servidor não encontrou este pedido. Se quiser, reenvie exatamente o mesmo pedido.",
        );
      }
    } catch (failure) {
      if (mounted.current) {
        setError(texto(failure, "Não foi possível consultar o servidor."));
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function resend() {
    if (!savedKey.current || !enabled || !reviewed || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const stored = await db.settlementCommands.get(savedKey.current);
      finish(
        await executeSettlementCommand(
          db,
          createAccountTransport(db.accountId),
          savedKey.current,
        ),
        stored ? FEITO[stored.command.action.type] : "Pedido confirmado.",
      );
    } catch {
      if (mounted.current) {
        setRecoveryChecked(false);
        setError(
          "A resposta não chegou de novo. O pedido continua guardado: consulte antes de repetir.",
        );
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function again() {
    savedKey.current = null;
    setKey(null);
    setSaved(null);
    setEnd(null);
    setCtx(null);
    setFields(null);
    setRecoveryChecked(false);
    setReload((value) => value + 1);
  }

  const close = () => {
    if (!sending.current) onClose();
  };
  const title = saved?.title ??
    (preview?.action
      ? titulo(preview.action, ctx?.manifest ?? null)
      : intent?.type === "distribution_record"
      ? intent.kind === "prize-payment" ? "Já paguei" : "Devolver"
      : "Divisão do prêmio");
  const evidence = ctx?.snapshot.registration.evidence.filter((item) =>
    item.poolId === intent?.poolId
  ) ?? [];
  const official = ctx && intent?.type === "prize_confirm" &&
      ctx.balance.participationMode === "official"
    ? oficiais(ctx.snapshot, intent.poolId)
    : [];
  const withAmount = intent?.type === "prize_confirm" ? !official.length
  : intent?.type === "redemption_record" ||
    intent?.type === "distribution_record";
  const closing = !!intent && fechamento(intent);
  const withDate = !!intent && !closing &&
    !["expense_confirm", "prize_confirm"].includes(intent.type);

  if (end) {
    return (
      <Modal title={saved?.title ?? title} onClose={close}>
        <div className="split-dialog">
          {end.status === "accepted"
            ? (
              <>
                <p className="split-done">
                  <Chip status="confirmed">{end.done}</Chip>
                </p>
                {saved && (
                  <div className="split-lines">
                    {saved.lines.map((line, index) => (
                      <p key={index}>{line}</p>
                    ))}
                  </div>
                )}
                <Disclosure summary="Detalhes técnicos">
                  <p>Recibo {end.receipt.receiptId}</p>
                  <p>
                    Confirmado em{" "}
                    {formatInstant(end.receipt.confirmedAt, timeZone)} · versão
                    {" "}
                    {end.receipt.groupRevision} do grupo
                  </p>
                </Disclosure>
              </>
            )
            : end.status === "conflict"
            ? (
              <ProblemBox title="Alguém mudou o grupo; atualize e confira de novo">
                Nada foi registrado. Os valores podem ter mudado.
              </ProblemBox>
            )
            : <ProblemBox title="Não foi aceito">{end.message}</ProblemBox>}
        </div>
        <div className="modal-actions">
          {end.status === "conflict" && intent
            ? (
              <>
                <Button variant="ghost" onClick={close}>Fechar</Button>
                <Button
                  icon={<RefreshCw aria-hidden="true" />}
                  disabled={!enabled}
                  onClick={again}
                >
                  Atualizar e conferir
                </Button>
              </>
            )
            : (
              <Button onClick={close}>
                {end.status === "accepted" ? "Pronto" : "Fechar"}
              </Button>
            )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={close}>
      <div className="split-dialog pool-form">
        {busy && (
          <p className="ui-sec split-busy">
            <LoaderCircle className="spin" size={17} aria-hidden="true" />
            Consultando o servidor…
          </p>
        )}
        {!enabled && <p className="ui-sec">{availability}</p>}
        {key && saved
          ? (
            <>
              <div className="split-lines">
                {saved.lines.map((line, index) => <p key={index}>{line}</p>)}
              </div>
              {error && <p className="split-wait" role="alert">{error}</p>}
              {recoveryChecked && (
                <label className="planning-review-checkbox">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={!enabled || busy}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  Conferi e quero reenviar exatamente este pedido.
                </label>
              )}
            </>
          )
          : ctx && fields && intent
          ? (
            <>
              {withAmount && (
                <label>
                  {intent.type === "prize_confirm"
                    ? "Valor do prêmio (R$)"
                    : intent.type === "redemption_record"
                    ? "Valor recebido (R$)"
                    : "Valor pago (R$)"}
                  <input
                    inputMode="decimal"
                    value={fields.amount}
                    onChange={(event) => update({ amount: event.target.value })}
                  />
                </label>
              )}
              {intent.type === "expense_confirm" && (
                <div className="form-columns">
                  <label>
                    Apostas (R$)<input
                      inputMode="decimal"
                      value={fields.cost}
                      onChange={(event) => update({ cost: event.target.value })}
                    />
                  </label>
                  <label>
                    Taxa (R$)<input
                      inputMode="decimal"
                      value={fields.fee}
                      onChange={(event) => update({ fee: event.target.value })}
                    />
                  </label>
                </div>
              )}
              {official.map((row) => (
                <label key={chaveOficial(row)}>
                  {nome(ctx.manifest, row.personId)} · {row.officialQuotas}{" "}
                  {row.officialQuotas === 1 ? "cota" : "cotas"} (R$)
                  <input
                    inputMode="decimal"
                    value={fields.official[chaveOficial(row)] ?? ""}
                    onChange={(event) =>
                      update({
                        official: {
                          ...fields.official,
                          [chaveOficial(row)]: event.target.value,
                        },
                      })}
                  />
                </label>
              ))}
              {withDate && (
                <label>
                  Data<input
                    type="date"
                    max={hoje()}
                    value={fields.date}
                    onChange={(event) => update({ date: event.target.value })}
                  />
                </label>
              )}
              {closing
                ? (
                  <div className="split-lines">
                    {preview?.action &&
                      resumir(preview.action, ctx, timeZone).lines
                        .filter((line) => !line.startsWith("Motivo: "))
                        .map((line, index) => <p key={index}>{line}</p>)}
                  </div>
                )
                : (
                  <>
                  <fieldset className="pool-fieldset">
                    <legend>Comprovante</legend>
                    {evidence.length
                      ? evidence.map((file) => (
                        <label className="pool-choice" key={file.id}>
                          <input
                            type="checkbox"
                            checked={fields.evidenceIds.includes(file.id)}
                            onChange={(event) =>
                              update({
                                evidenceIds: event.target.checked
                                  ? [...fields.evidenceIds, file.id]
                                  : fields.evidenceIds.filter((id) =>
                                    id !== file.id
                                  ),
                              })}
                          />
                          <span>{file.originalName}</span>
                        </label>
                      ))
                      : (
                        <p className="ui-sec">
                          Nenhum comprovante enviado neste bolão.
                        </p>
                      )}
                    {goRegistrar && (
                      <button
                        type="button"
                        className="pool-link"
                        onClick={goRegistrar}
                      >
                        Anexar outro comprovante no Registrar
                      </button>
                    )}
                  </fieldset>
                  <label>
                    Referência (Pix, extrato ou lotérica)<input
                      value={fields.reference}
                      onChange={(event) =>
                        update({ reference: event.target.value })}
                    />
                  </label>
                  </>
                )}
              <label>
                {motivoObrigatorio(intent) ? "Motivo" : "Motivo (se mudou algo)"}
                <textarea
                  rows={2}
                  value={fields.reason}
                  onChange={(event) => update({ reason: event.target.value })}
                />
              </label>
              {preview?.hint && <p className="split-wait">{preview.hint}</p>}
              {preview?.problem && (
                <ProblemBox title="Assim não dá para confirmar">
                  {preview.problem}
                </ProblemBox>
              )}
              {error && (
                <ProblemBox title="Não deu para guardar">{error}</ProblemBox>
              )}
              <label className="planning-review-checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={!enabled || busy || !preview?.action}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                {closing
                  ? "Conferi a conta do bolão."
                  : "Conferi o valor e o comprovante."}
              </label>
              <Disclosure summary="Detalhes técnicos">
                <p>
                  Versão {ctx.snapshot.groupRevision} do grupo · versão{" "}
                  {ctx.pool.serverVersion} do bolão
                </p>
              </Disclosure>
            </>
          )
          : error
          ? <ProblemBox title="Não deu para conferir agora">{error}</ProblemBox>
          : null}
      </div>
      <div className="modal-actions">
        <Button variant="ghost" disabled={busy && sending.current} onClick={close}>
          Cancelar
        </Button>
        {key
          ? recoveryChecked
            ? (
              <Button
                icon={<ShieldCheck aria-hidden="true" />}
                disabled={!enabled || busy || !reviewed}
                onClick={() => void resend()}
              >
                Reenviar o mesmo pedido
              </Button>
            )
            : (
              <Button
                icon={<RefreshCw aria-hidden="true" />}
                disabled={!enabled || busy}
                onClick={() => void recover()}
              >
                Consultar se foi aceito
              </Button>
            )
          : ctx
          ? (
            <Button
              icon={<ShieldCheck aria-hidden="true" />}
              disabled={!enabled || busy || !reviewed || !preview?.action}
              onClick={() => void confirm()}
            >
              Confirmar
            </Button>
          )
          : (
            <Button
              icon={<RefreshCw aria-hidden="true" />}
              disabled={!enabled || busy}
              onClick={again}
            >
              Tentar de novo
            </Button>
          )}
      </div>
    </Modal>
  );
}
