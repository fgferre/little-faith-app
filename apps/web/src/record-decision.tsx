import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  compareRegistration,
  currentCalendar,
  formatBRL,
  LOTTERIES,
  validateRegistrationCommand,
  validateResultCommand,
} from "@bolao/core";
import type {
  LocalRecord,
  RegistrationCommand,
  RegistrationReceipt,
  ResultCommand,
  ResultReceipt,
} from "@bolao/core";
import {
  applyRegistrationSnapshot,
  applyResultSnapshot,
  executeRegistrationCommand,
  executeResultCommand,
  prepareRegistrationCommand,
  prepareResultCommand,
  recoverRegistrationCommand,
  recoverResultCommand,
  sync,
} from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { createAccountTransport } from "./auth";
import { Modal } from "./components";
import { Button, ReviewItem } from "./ui";
import { formatInstant } from "./ui/texto";
import { readReviewSnapshot } from "./review-snapshot";

export type RecordRequest =
  | { family: "registration"; action: RegistrationCommand["action"] }
  | { family: "result"; action: ResultCommand["action"] }
  | { family: "registration" | "result"; idempotencyKey: string };
interface Review {
  title: string;
  lines: string[];
}
type Command = RegistrationCommand | ResultCommand;
type Receipt = RegistrationReceipt | ResultReceipt;
const unresolved = (value: { status: string }) =>
  ["prepared", "sending", "unknown"].includes(value.status);
const message = (value: unknown) =>
  value instanceof Error
    ? value.message
    : "Não foi possível concluir a conferência.";

/** Conferências de registro e resultado sem resposta ("open") ou que não deram certo ("failed"). */
export function RecordPending(
  { db, groupId, show, open }: {
    db: BolaoDatabase;
    groupId: string;
    show: "open" | "failed";
    open: (request: RecordRequest) => void;
  },
) {
  const scope = `${db.name}:${groupId}`;
  const raw = useLiveQuery(async () => ({
    scope,
    registration: await db.registrationCommands.where("groupId").equals(groupId)
      .toArray(),
    result: await db.resultCommands.where("groupId").equals(groupId).toArray(),
  }), [db, groupId]);
  if (raw?.scope !== scope) return null;
  return (["registration", "result"] as const).flatMap((family) => {
    const name = family === "registration" ? "Registro" : "Resultado";
    return raw[family].map((saved) =>
      show === "open" && unresolved(saved)
        ? (
          <ReviewItem
            key={`${family}:${saved.idempotencyKey}`}
            family={name}
            title={family === "registration"
              ? "Conferência do registro"
              : "Conferência do resultado"}
            state="A conferir"
            line="A decisão ficou guardada neste aparelho, mas a resposta não chegou. Confira antes de repetir."
          >
            <Button
              aria-label={`Conferir ${
                family === "registration" ? "o registro" : "o resultado"
              }`}
              onClick={() =>
                open({ family, idempotencyKey: saved.idempotencyKey })}
            >
              Conferir
            </Button>
          </ReviewItem>
        )
        : show === "failed" && ["rejected", "conflict"].includes(saved.status)
        ? (
          <ReviewItem
            key={`${family}:${saved.idempotencyKey}`}
            family={name}
            title={family === "registration"
              ? "Conferência do registro"
              : "Conferência do resultado"}
            status="problem"
            state="Não confirmada"
            line={
              <span className="ui-review-note">
                {saved.receipt?.message ??
                  "Revise os dados e prepare uma nova decisão."}
              </span>
            }
          />
        )
        : null
    );
  });
}

export function RecordDialog(
  { db, groupId, request, enabled, availability, timeZone, onClose, onNotice }:
    {
      db: BolaoDatabase;
      groupId: string;
      request: RecordRequest;
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
  const [command, setCommand] = useState<Command | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [missingReason, setMissingReason] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setReviewed(false);
    const load = async () => {
      if (originalKey.current) {
        const saved = request.family === "registration"
          ? await db.registrationCommands.get(originalKey.current)
          : await db.resultCommands.get(originalKey.current);
        if (!saved || saved.groupId !== groupId) {
          throw new Error(
            "A decisão original não está salva nesta conta e grupo.",
          );
        }
        const summary =
          (await db.metadata.get(`record-review:${originalKey.current}`))
            ?.value as Review | undefined;
        if (active) {
          setCommand(saved.command);
          setReview(summary ?? null);
        }
        return;
      }
      if (!enabled || !navigator.onLine || !("action" in request)) return;
      setBusy(true);
      setReview(null);
      setError(null);
      setMissingReason([]);
      const transport = createAccountTransport(db.accountId);
      await sync(db, transport);
      const [snapshot, calendarSnapshot] = request.family === "registration"
        ? await Promise.all([
          transport.registrationPull(groupId),
          transport.resultsPull(groupId),
        ])
        : [await transport.resultsPull(groupId), null];
      if (
        calendarSnapshot &&
        calendarSnapshot.groupRevision !== snapshot.groupRevision
      ) {
        throw new Error(
          "O calendário mudou durante a consulta. Atualize a revisão antes de confirmar.",
        );
      }
      if (request.family === "registration") {
        await applyRegistrationSnapshot(
          db,
          snapshot as Awaited<ReturnType<typeof transport.registrationPull>>,
        );
      } else {await applyResultSnapshot(
          db,
          snapshot as Awaited<ReturnType<typeof transport.resultsPull>>,
        );}
      if (calendarSnapshot) await applyResultSnapshot(db, calendarSnapshot);
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
        ].some(unresolved)
      ) {
        throw new Error(
          "Verifique a decisão pendente na Revisão antes de preparar outra conferência.",
        );
      }
      const pool = read.records.find((record) =>
        record.id === request.action.poolId && record.kind === "pool"
      ) as LocalRecord<"pool"> | undefined;
      if (!pool || pool.serverVersion !== request.action.poolVersion) {
        throw new Error(
          "Os dados do bolão mudaram. Feche a revisão e confira a versão atual antes de preparar a decisão.",
        );
      }
      if (
        read.localRecords.some((record) =>
          record.id === pool.id && record.state !== "synced"
        )
      ) {
        throw new Error(
          "Sincronize os dados do bolão e resolva o conflito antes de confirmar.",
        );
      }
      let shown: Review;
      let withoutReason: number[] = [];
      if (request.family === "registration") {
        const registration = snapshot as Awaited<
          ReturnType<typeof transport.registrationPull>
        >;
        const manifest = registration.manifests.filter((item) =>
          item.poolId === pool.id
        ).sort((a, b) => b.version - a.version)[0];
        if (!manifest || manifest.id !== request.action.manifestId) {
          throw new Error(
            "O manifesto mudou. Reabra o registro e confira a nova lista.",
          );
        }
        const comparison = compareRegistration(
          manifest,
          request.action.items,
          registration.evidence,
          calendarSnapshot ? currentCalendar(calendarSnapshot, pool.id) : null,
        );
        withoutReason = request.action.items.flatMap((item, index) =>
          !item.reason.trim() && comparison.issues.some((issue) =>
              issue.severity === "divergence" &&
              issue.plannedTicketKey === item.plannedTicketKey
            )
            ? [index + 1]
            : []
        );
        shown = {
          title: "Conferir registro externo",
          lines: [
            `${pool.data.title} · ${
              LOTTERIES[manifest.content.plan.lotteryId].label
            } · concurso ${manifest.content.plan.contestNumber} · manifesto versão ${manifest.version}.`,
            "Esta conferência preserva o plano e os direitos e registra os dados lidos nos comprovantes. O original enviado sozinho não confirma a aposta.",
            ...request.action.items.flatMap((item, index) => [
              `Cartela ${index + 1}: ${
                item.observed
                  ? "comprovante apresentado"
                  : "comprovante ausente"
              }.`,
              ...(item.observed
                ? [
                  `Concurso lido: ${
                    item.observed.contestNumber ?? "ilegível"
                  }; modalidade: ${
                    item.observed.lotteryId
                      ? LOTTERIES[item.observed.lotteryId].label
                      : "ilegível"
                  }.`,
                  `Dezenas lidas: ${
                    item.observed.betNumbers?.map((numbers) =>
                      numbers.map((number) =>
                        String(number).padStart(2, "0")
                      ).join(" ")
                    ).join(" / ") ?? "ilegíveis"
                  }.`,
                  `Apostas: ${
                    item.observed.betCostCents === null
                      ? "valor desconhecido"
                      : formatBRL(item.observed.betCostCents)
                  }; taxa: ${
                    item.observed.feeCents === null
                      ? "valor desconhecido"
                      : formatBRL(item.observed.feeCents)
                  }.`,
                  ...(item.observed.officialQuotaCount !== null
                    ? [
                      `Cotas oficiais lidas: ${item.observed.officialQuotaCount}.`,
                      ...(item.observed.officialAssignments ?? []).map((
                        assignment,
                      ) =>
                        `${
                          manifest.content.persons.find((person) =>
                            person.id === assignment.personId
                          )?.data.name ?? "Participante"
                        }: ${assignment.officialQuotas} cotas oficiais.`
                      ),
                    ]
                    : []),
                  `Horário lido no recibo: ${
                    item.observed.registeredAt
                      ? `${
                        formatInstant(
                          item.observed.registeredAt,
                          "America/Sao_Paulo",
                        )
                      } (Brasília)`
                      : "não informado"
                  }.`,
                ]
                : []),
              ...item.evidenceIds.map((id) => {
                const evidence = registration.evidence.find((file) =>
                  file.id === id
                );
                return `Original: ${
                  evidence?.originalName ?? "não encontrado"
                } · SHA-256 ${evidence?.sha256 ?? "não verificado"}.`;
              }),
              ...(item.reason ? [`Observação: ${item.reason}`] : []),
            ]),
            ...comparison.issues.map((issue) => issue.message),
            `Situação conferida: ${
              comparison.status === "complete"
                ? "completa"
                : comparison.status === "partial"
                ? "parcial"
                : "com divergências"
            }.`,
            "A primeira conferência com aposta observada congela o plano para registro. Correções posteriores preservam esta versão.",
            ...(request.action.reason
              ? [`Motivo da conferência: ${request.action.reason}`]
              : []),
          ],
        };
      } else if (request.action.type === "result_manual") {
        shown = {
          title: "Confirmar resultado informado",
          lines: [
            `${pool.data.title} · concurso ${request.action.data.contestNumber} · fonte informada: ${request.action.sourceReference}.`,
            `Dezenas: ${
              request.action.data.drawnNumbers?.map((number) =>
                String(number).padStart(2, "0")
              ).join(" ") ?? "ainda não disponíveis"
            }.`,
            ...request.action.data.payouts?.map((tier) =>
              `${tier.hits} acertos: ${
                tier.prizeCents === null
                  ? "rateio pendente"
                  : formatBRL(tier.prizeCents)
              } por combinação; ganhadores: ${
                tier.winnerCount ?? "não informado"
              }.`
            ) ?? [],
            `Motivo: ${request.action.reason}.`,
            "Este resultado fica identificado como informado manualmente. Uma resposta incompatível da CAIXA abrirá revisão.",
          ],
        };
      } else if (request.action.type === "calendar_confirm") {
        shown = {
          title: "Conferir horários do concurso",
          lines: [
            `${pool.data.title} · concurso ${request.action.contestNumber} · fonte: ${request.action.sourceReference}.`,
            `Data em Brasília: ${request.action.drawDate ?? "não definida"}.`,
            ...[["Sorteio previsto", request.action.expectedDrawAt], [
              "Encerramento do canal",
              request.action.registrationClosesAt,
            ]].map(([label, instant]) =>
              instant
                ? `${label}: ${
                  new Intl.DateTimeFormat("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                    timeZone: "America/Sao_Paulo",
                  }).format(new Date(instant))
                } (Brasília); ${
                  new Intl.DateTimeFormat("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                    timeZone,
                  }).format(new Date(instant))
                } (${timeZone}); ${instant} (UTC).`
                : `${label}: não definido.`
            ),
            `Motivo: ${request.action.reason}.`,
            "Estes horários são do concurso. O prazo interno do grupo permanece registrado separadamente.",
          ],
        };
      } else {
        const action = request.action;
        const results = snapshot as Awaited<
          ReturnType<typeof transport.resultsPull>
        >;
        const observed = results.results.filter((item) =>
          item.poolId === pool.id
        );
        if (
          observed.length !== action.observedResultIds.length ||
          observed.some((item) => !action.observedResultIds.includes(item.id))
        ) {
          throw new Error(
            "Há outra versão de resultado para conferir. Feche esta revisão e compare todas as fontes atuais.",
          );
        }
        const chosen = observed.find((item) => item.id === action.resultId);
        if (!chosen) {
          throw new Error("Escolha uma versão disponível do resultado.");
        }
        shown = {
          title: "Resolver diferenças de resultado",
          lines: [
            `${pool.data.title} · concurso ${chosen.contestNumber}.`,
            ...observed.flatMap((item) => [
              `Versão ${item.version}: ${
                item.source === "caixa" ? "CAIXA" : "manual"
              } · ${
                item.drawnNumbers?.join(" ") ?? "números pendentes"
              } · data ${
                item.drawDate ?? "pendente"
              } · SHA-256 ${item.sha256}.`,
              ...(item.payouts?.map((tier) =>
                `${tier.hits} acertos: ${
                  tier.prizeCents === null
                    ? "rateio pendente"
                    : formatBRL(tier.prizeCents)
                } por combinação; ganhadores: ${
                  tier.winnerCount ?? "não informado"
                }.`
              ) ?? ["Rateios ainda não disponíveis."]),
            ]),
            `Usar versão ${chosen.version} · motivo: ${request.action.reason}.`,
            "Todas as fontes e a decisão ficam preservadas. Uma nova fonte incompatível reabrirá a revisão.",
          ],
        };
      }
      const prepared = {
        apiVersion: "v1" as const,
        idempotencyKey: crypto.randomUUID(),
        groupId,
        expectedRevision: snapshot.groupRevision,
        action: structuredClone(request.action),
      };
      if (active) {
        setCommand(
          request.family === "registration"
            ? validateRegistrationCommand(prepared)
            : validateResultCommand(prepared),
        );
        setReview(shown);
        setMissingReason(withoutReason);
      }
    };
    void load().catch((failure) => {
      if (active) setError(message(failure));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [db, groupId, request, enabled, reload, timeZone]);

  async function finish(receipt: Receipt) {
    if (!mounted.current) return;
    if (receipt.status !== "accepted") {
      setError(receipt.message ?? "A conferência precisa ser revisada.");
      setRefused(true);
      return;
    }
    onNotice({ text: "Conferência confirmada no servidor." });
    onClose();
    void sync(db, createAccountTransport(db.accountId)).catch(() =>
      undefined
    );
  }
  async function confirm() {
    if (
      !command || !review || !reviewed || !enabled || sending.current ||
      originalKey.current && !recoveryChecked
    ) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!originalKey.current) {
        await db.transaction("rw", [
          db.registrationCommands,
          db.resultCommands,
          db.metadata,
        ], async () => {
          if (request.family === "registration") {
            await prepareRegistrationCommand(
              db,
              command as RegistrationCommand,
            );
          } else await prepareResultCommand(db, command as ResultCommand);
          await db.metadata.put({
            key: `record-review:${command.idempotencyKey}`,
            value: structuredClone(review),
          });
        });
        originalKey.current = command.idempotencyKey;
        if (mounted.current) setKey(command.idempotencyKey);
      }
      setReviewed(false);
      setRecoveryChecked(false);
      const transport = createAccountTransport(db.accountId);
      const receipt = request.family === "registration"
        ? await executeRegistrationCommand(db, transport, originalKey.current)
        : await executeResultCommand(db, transport, originalKey.current);
      await finish(receipt);
    } catch (failure) {
      if (mounted.current) {
        setError(
          originalKey.current
            ? "Leve a decisão à Revisão para consultar o recibo. O resultado desta conferência precisa ser verificado antes de repetir."
            : message(failure),
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
      const transport = createAccountTransport(db.accountId);
      const receipt = request.family === "registration"
        ? await recoverRegistrationCommand(db, transport, originalKey.current)
        : await recoverResultCommand(db, transport, originalKey.current);
      if (receipt) await finish(receipt);
      else if (mounted.current) {
        setRecoveryChecked(true);
        setError(
          "Nenhum recibo foi encontrado. Revise o conteúdo original para autorizar um reenvio explícito com a mesma chave.",
        );
      }
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const missingReasonLine = missingReason.length === 0
    ? null
    : missingReason.length === 1
    ? `Cartela ${missingReason[0]} não bate com o planejado: explique o motivo em Observação da cartela antes de confirmar.`
    : `Cartelas ${
      new Intl.ListFormat("pt-BR").format(missingReason.map(String))
    } não batem com o planejado: explique o motivo em Observação da cartela de cada uma antes de confirmar.`;
  return (
    <Modal
      title={review?.title ?? "Revisar conferência"}
      description="Confira o conteúdo apresentado e confirme online sobre a versão do servidor."
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
      {missingReasonLine && <p className="form-error">{missingReasonLine}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!refused && (key
        ? (
          <button
            className="button secondary"
            disabled={!enabled || busy}
            onClick={() => void recover()}
          >
            <RefreshCw size={17} />Consultar recibo da conferência
          </button>
        )
        : (
          <button
            className="button secondary"
            disabled={!enabled || busy}
            onClick={() => {
              setReviewed(false);
              setReload((value) => value + 1);
            }}
          >
            Atualizar revisão
          </button>
        ))}
      {!refused && (!key || recoveryChecked) && (
        <label className="planning-review-checkbox">
          <input
            type="checkbox"
            checked={reviewed}
            disabled={!enabled || busy || !review || !!error && !key}
            onChange={(event) => setReviewed(event.target.checked)}
          />Revisei os dados e autorizo esta conferência online.
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
        {!refused && (
          <button
            className="button primary"
            disabled={!enabled || busy || !reviewed || !review ||
              missingReason.length > 0 || !!key && !recoveryChecked}
            onClick={() => void confirm()}
          >
            <ShieldCheck size={17} />
            {key
              ? "Reenviar conferência original"
              : "Confirmar conferência no servidor"}
          </button>
        )}
      </div>
    </Modal>
  );
}
