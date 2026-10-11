import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  computeSettlement,
  formatBRL,
  validateSettlementActionContext,
  validateSettlementCommand,
} from "@bolao/core";
import type {
  LocalRecord,
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
import { createAccountTransport } from "./auth";
import { Modal, SectionTitle } from "./components";
import { readReviewSnapshot } from "./review-snapshot";
import { formatInstant } from "./results";

export type SettlementRequest = { action: SettlementAction } | {
  idempotencyKey: string;
};
interface Review {
  title: string;
  lines: string[];
}
const pending = (item: { status: string }) =>
  ["prepared", "sending", "unknown"].includes(item.status);
const money = (value: string | null) =>
  value === null ? "pendente" : formatBRL(value);
const titles: Record<SettlementAction["type"], string> = {
  expense_confirm: "Confirmar despesas das apostas",
  prize_confirm: "Confirmar o prêmio",
  redemption_record: "Confirmar recebimento do resgate",
  redemption_reverse: "Confirmar correção do resgate",
  distribution_record: "Confirmar entrega ao participante",
  distribution_reverse: "Confirmar retorno do pagamento",
  pool_settle: "Conferir encerramento do bolão",
  pool_reopen: "Conferir reabertura do bolão",
};
function reviewSummary(
  snapshot: SettlementSnapshot,
  action: SettlementAction,
  pool: LocalRecord<"pool">,
  timeZone: string,
): Review {
  const balance = computeSettlement(snapshot).pools[pool.id];
  if (!balance) {
    throw new Error("Sincronize os direitos congelados deste bolão.");
  }
  const manifest = snapshot.registration.manifests.find((item) =>
    item.id === balance.manifestId
  );
  const personName = (id: string) =>
    manifest?.content.persons.find((person) => person.id === id)?.data.name ??
      "Participante";
  const lines = [
    `${pool.data.title} · concurso ${pool.data.contestNumber} · manifesto versão ${
      manifest?.version ?? "pendente"
    }.`,
    `Caixa do organizador: ${
      money(balance.organizerCashCents)
    }; contribuições: ${money(balance.contributedCents)}; despesas: ${
      money(balance.confirmedExpenseCents)
    }.`,
    `Prêmio calculado: ${money(balance.calculatedPrizeCents)}; confirmado: ${
      money(balance.confirmedPrizeCents)
    }; resgatado: ${money(balance.redeemedCents)}; entregue: ${
      money(balance.prizePaidCents)
    }.`,
  ];
  if (action.type === "expense_confirm") {
    lines.push(
      `Apostas efetivamente pagas: ${
        money(action.betCostCents)
      }; taxas efetivamente pagas: ${money(action.feeCents)}; total: ${
        money(
          (BigInt(action.betCostCents) + BigInt(action.feeCents)).toString(),
        )
      }.`,
      action.supersedesId
        ? "Esta versão corrige a despesa anterior. O total anterior será preservado e a diferença afetará o caixa."
        : "Esta confirmação registra uma saída real de caixa, separada da reserva do plano.",
    );
  } else if (action.type === "prize_confirm") {
    const result = snapshot.results.results.find((item) =>
      item.id === action.resultId
    );
    lines.push(
      `Prêmio a confirmar: ${money(action.amountCents)}. Fonte do resultado: ${
        result?.source === "caixa" ? "CAIXA" : "manual"
      }; versão ${result?.version}.`,
      `Dezenas: ${result?.drawnNumbers?.join(" ") ?? "pendentes"}.`,
      "Confirmar o prêmio estabelece o direito; o dinheiro só entra após confirmar o resgate.",
    );
    lines.push(
      ...action.officialEntitlements.map((item) =>
        `${
          personName(item.personId)
        } · ${item.officialQuotas} cotas oficiais na cartela ${
          (manifest?.content.plan.tickets.findIndex((ticket) =>
            ticket.key === item.plannedTicketKey
          ) ?? NaN) + 1
        }: direito observado ${money(item.amountCents)}.`
      ),
    );
    if (!action.officialEntitlements.length) {
      lines.push(
        "O rateio usará os direitos congelados, com maiores restos e desempate estável pelo participante.",
      );
    }
    if (action.redemptionDeadline) {
      lines.push(
        `Prazo de resgate em Brasília: ${
          action.redemptionDeadline.exception?.deadlineDate ??
            action.redemptionDeadline.deadlineDate
        }. Fonte: ${action.redemptionDeadline.sourceUrl}.`,
        ...(action.redemptionDeadline.exception
          ? [
            `Exceção: ${action.redemptionDeadline.exception.sourceReference} · ${action.redemptionDeadline.exception.reason}.`,
          ]
          : []),
      );
    }
  } else if (action.type === "redemption_record") {
    lines.push(
      `Recebido por ${personName(action.personId)}: ${
        money(action.amountCents)
      }.`,
      balance.participationMode === "official"
        ? "Recebimento individual de cotas oficiais. Este valor fica fora do caixa do organizador."
        : "Resgate recebido pelo titular. Este valor passa a compor o caixa do organizador para distribuição.",
    );
  } else if (action.type === "distribution_record") {
    lines.push(
      `Entregue a ${personName(action.personId)}: ${
        money(action.amountCents)
      }. Tipo: ${
        action.kind === "prize-payment"
          ? "pagamento do prêmio"
          : "devolução da contribuição"
      }.`,
      "A confirmação acompanha dinheiro já entregue. O app não realiza a transferência bancária.",
    );
  } else if (action.type === "redemption_reverse") {
    const original = snapshot.redemptions.find((item) =>
      item.id === action.redemptionId
    );
    if (!original) throw new Error("O resgate original não está disponível.");
    lines.push(
      `Compensar integralmente o resgate de ${personName(original.personId)}: ${
        money(original.amountCents)
      }.`,
      "O registro original continuará preservado. Esta confirmação acompanha a devolução do dinheiro e recalcula as pendências.",
    );
  } else if (action.type === "distribution_reverse") {
    const original = snapshot.distributions.find((item) =>
      item.id === action.distributionId
    );
    if (!original) throw new Error("O pagamento original não está disponível.");
    lines.push(
      `Registrar retorno integral do pagamento de ${
        personName(original.personId)
      }: ${money(original.amountCents)}.`,
      "O pagamento anterior continuará preservado. O retorno reabre o valor pendente e recompõe o caixa.",
    );
  } else if (action.type === "pool_settle") {
    lines.push(
      `Prêmio a resgatar: ${
        money(balance.unredeemedPrizeCents)
      }; prêmio a entregar: ${
        money(balance.unpaidPrizeCents)
      }; sobra das contribuições: ${
        money(balance.contributionSurplusCents)
      }; devolvido: ${money(balance.refundedCents)}; devolução pendente: ${
        money(balance.refundPendingCents)
      }.`,
      `Destino da sobra: ${
        action.leftoverDisposition === "group-reserve"
          ? "reserva identificada no grupo"
          : "devolução aos participantes ainda pendente"
      }.`,
      `Pendências explicadas: ${action.pendingExplanation || "nenhuma"}.`,
      "O encerramento preserva os valores ainda pendentes e seus motivos. Uma correção posterior exige reabertura explícita.",
    );
  } else {lines.push(
      "Esta decisão reabre o bolão para corrigir seus fatos. O encerramento anterior e sua conciliação permanecerão preservados.",
    );}
  if ("eventAt" in action) {
    lines.push(
      `Horário informado: ${
        formatInstant(action.eventAt, "America/Sao_Paulo")
      } (Brasília); ${
        formatInstant(action.eventAt, timeZone)
      } (${timeZone}); ${action.eventAt} (UTC).`,
    );
  }
  if ("sourceReference" in action) {
    lines.push(`Fonte: ${action.sourceReference}.`);
  }
  if ("evidenceIds" in action) {
    for (const id of action.evidenceIds) {
      const file = snapshot.registration.evidence.find((item) =>
        item.id === id
      );
      lines.push(
        `Original: ${file?.originalName ?? "não encontrado"} · SHA-256 ${
          file?.sha256 ?? "pendente"
        }.`,
      );
    }
  }
  lines.push(
    `Motivo: ${action.reason}.`,
    ...balance.persons.map((person) =>
      `${personName(person.personId)}: direito ao prêmio ${
        money(person.prizeRightCents)
      }; recebido ${money(person.prizeReceivedCents)}; pendente ${
        money(person.prizePendingCents)
      }; devolução pendente ${money(person.refundPendingCents)}.`
    ),
  );
  return { title: titles[action.type], lines };
}

export function SettlementPending(
  { db, groupId, open }: {
    db: BolaoDatabase;
    groupId: string;
    open: (request: SettlementRequest) => void;
  },
) {
  const scope = `${db.name}:${groupId}`;
  const raw = useLiveQuery(
    async () => ({
      scope,
      commands: await db.settlementCommands.where("groupId").equals(groupId)
        .toArray(),
    }),
    [db, groupId],
  );
  if (raw?.scope !== scope) return null;
  return (
    <>
      {raw.commands.map((saved) =>
        pending(saved)
          ? (
            <section
              className="panel finance-pending"
              key={saved.idempotencyKey}
            >
              <SectionTitle
                title="Resgate ou distribuição aguardando verificação"
                subtitle="A decisão original ficou salva. Consulte o recibo antes de repetir."
              />
              <button
                className="button secondary"
                onClick={() => open({ idempotencyKey: saved.idempotencyKey })}
              >
                <RefreshCw size={17} />Verificar movimento do rateio
              </button>
            </section>
          )
          : ["conflict", "rejected"].includes(saved.status)
          ? (
            <p className="inline-note" key={saved.idempotencyKey}>
              {saved.receipt?.message ??
                "O movimento precisa ser revisado e preparado novamente."}
            </p>
          )
          : null
      )}
    </>
  );
}

export function SettlementDialog(
  { db, groupId, request, enabled, availability, timeZone, onClose, onNotice }:
    {
      db: BolaoDatabase;
      groupId: string;
      request: SettlementRequest;
      enabled: boolean;
      availability: string;
      timeZone: string;
      onClose: () => void;
      onNotice: (notice: { text: string; error?: boolean }) => void;
    },
) {
  const originalKey = useRef(
    "idempotencyKey" in request ? request.idempotencyKey : null,
  );
  const [key, setKey] = useState(originalKey.current);
  const [command, setCommand] = useState<SettlementCommand | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setReviewed(false);
    setBusy(true);
    setError(null);
    async function load() {
      if (originalKey.current) {
        const saved = await db.settlementCommands.get(originalKey.current);
        const shown = await db.metadata.get(
          `settlement-review:${originalKey.current}`,
        );
        if (!saved || saved.groupId !== groupId || !shown?.value) {
          throw new Error(
            "A decisão original não está disponível nesta conta e grupo. Consulte o histórico antes de repetir.",
          );
        }
        if (active) {
          setCommand(saved.command);
          setReview(shown.value as Review);
        }
        return;
      }
      if (!("action" in request) || !enabled) return;
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
        ].some(pending)
      ) {
        throw new Error(
          "Verifique a decisão pendente na Revisão antes de preparar outro movimento.",
        );
      }
      const pool = read.records.find((item) =>
        item.id === request.action.poolId && item.kind === "pool"
      ) as LocalRecord<"pool"> | undefined;
      if (
        !pool || pool.serverVersion !== request.action.poolVersion ||
        read.localRecords.some((item) =>
          item.id === pool.id && item.state !== "synced"
        )
      ) {
        throw new Error(
          "O bolão mudou. Feche a revisão, sincronize e confira os dados atuais antes de preparar outra decisão.",
        );
      }
      const proposed = validateSettlementCommand({
        apiVersion: "v1",
        idempotencyKey: crypto.randomUUID(),
        groupId,
        expectedRevision: snapshot.groupRevision,
        action: structuredClone(request.action),
      });
      validateSettlementActionContext(
        snapshot,
        proposed.action,
        new Date().toISOString(),
      );
      const shown = reviewSummary(snapshot, proposed.action, pool, timeZone);
      if (active) {
        setCommand(proposed);
        setReview(shown);
      }
    }
    void load().catch((failure) => {
      if (active) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Não foi possível preparar a conferência.",
        );
      }
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [db, groupId, request, enabled, reload, timeZone]);
  async function finish(receipt: SettlementReceipt) {
    if (!mounted.current) return;
    onNotice({
      text: receipt.status === "accepted"
        ? "Movimento confirmado no servidor."
        : receipt.message ?? "Revise o movimento antes de tentar novamente.",
      error: receipt.status !== "accepted",
    });
    onClose();
    if (receipt.status === "accepted") {
      void sync(db, createAccountTransport(db.accountId)).catch(() =>
        undefined
      );
    }
  }
  async function confirm() {
    if (
      !enabled || !command || !review || !reviewed || sending.current ||
      key && !recoveryChecked
    ) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!originalKey.current) {
        await db.transaction(
          "rw",
          [db.settlementCommands, db.metadata],
          async () => {
            await prepareSettlementCommand(db, command);
            await db.metadata.put({
              key: `settlement-review:${command.idempotencyKey}`,
              value: structuredClone(review),
            });
          },
        );
        originalKey.current = command.idempotencyKey;
        if (mounted.current) setKey(command.idempotencyKey);
      }
      setReviewed(false);
      setRecoveryChecked(false);
      await finish(
        await executeSettlementCommand(
          db,
          createAccountTransport(db.accountId),
          originalKey.current,
        ),
      );
    } catch (failure) {
      if (mounted.current) {
        setError(
          originalKey.current
            ? "O resultado deste movimento precisa ser verificado na Revisão. Consulte o recibo antes de repetir."
            : failure instanceof Error
            ? failure.message
            : "Não foi possível salvar a decisão.",
        );
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function recover() {
    if (!originalKey.current || !enabled || sending.current) return;
    sending.current = true;
    setBusy(true);
    setReviewed(false);
    setError(null);
    try {
      const receipt = await recoverSettlementCommand(
        db,
        createAccountTransport(db.accountId),
        originalKey.current,
      );
      if (receipt) await finish(receipt);
      else if (mounted.current) {
        setRecoveryChecked(true);
        setError(
          "Nenhum recibo foi encontrado. Revise o movimento original para autorizar um reenvio explícito com a mesma chave.",
        );
      }
    } catch (failure) {
      if (mounted.current) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Não foi possível consultar o recibo.",
        );
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={review?.title ?? "Revisar resgate e distribuição"}
      description="Confira valores, direitos e comprovantes. A confirmação usa a versão atual do servidor."
      onClose={() => {
        if (!sending.current) onClose();
      }}
    >
      {busy && (
        <p className="inline-note">
          <LoaderCircle className="spin" size={17} />Consultando o servidor…
        </p>
      )}
      {!enabled && <p className="inline-note">{availability}</p>}
      {review && (
        <div className="planning-review-text">
          {review.lines.map((line, index) => <p key={index}>{line}</p>)}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {key
        ? (
          <button
            className="button secondary"
            disabled={!enabled || busy}
            onClick={() => void recover()}
          >
            <RefreshCw size={17} />Consultar recibo do movimento
          </button>
        )
        : (
          <button
            className="button secondary"
            disabled={!enabled || busy}
            onClick={() => setReload((value) => value + 1)}
          >
            Atualizar revisão
          </button>
        )}
      {(!key || recoveryChecked) && (
        <label className="planning-review-checkbox">
          <input
            type="checkbox"
            checked={reviewed}
            disabled={!enabled || busy || !review || !!error && !key}
            onChange={(event) => setReviewed(event.target.checked)}
          />Revisei valores, direitos e originais e autorizo este movimento
          online.
        </label>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={busy && sending.current}
          onClick={onClose}
        >
          Fechar revisão
        </button>
        <button
          className="button primary"
          disabled={!enabled || busy || !reviewed || !review ||
            !!key && !recoveryChecked}
          onClick={() => void confirm()}
        >
          <ShieldCheck size={17} />
          {key
            ? "Reenviar movimento original"
            : "Confirmar movimento no servidor"}
        </button>
      </div>
    </Modal>
  );
}
