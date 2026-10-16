import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { formatBRL, formatQuotaUnits } from "@bolao/core";
import type {
  AppliedPlan,
  LocalRecord,
  PlanningCommand,
  PlanningReceipt,
  PoolManifest,
  PreparedPlan,
} from "@bolao/core";
import {
  applyFinancialSnapshot,
  applyPlanningSnapshot,
  executePlanningCommand,
  preparePlanningCommand,
  recoverPlanningCommand,
  sync,
} from "@bolao/local";
import type { BolaoDatabase, PersistentPlanningCommand } from "@bolao/local";
import { createAccountTransport } from "./auth";
import { Modal } from "./components";
import { Button, ReviewItem } from "./ui";
import { formatInstant } from "./ui/texto";
import { assertCurrentPlan } from "./planning-preview";
import { readReviewSnapshot } from "./review-snapshot";
import {
  latestApplied,
  latestManifest,
  PlanDetails,
  PlanValues,
} from "./planning";

export type PlanningRequest =
  | { type: "plan_apply"; plan: PreparedPlan }
  | { type: "pool_lock"; poolId: string; appliedPlanId: string }
  | { type: "recover"; idempotencyKey: string };

const unresolved = (command: { status: string }) =>
  ["prepared", "sending", "unknown"].includes(command.status);
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível concluir a decisão.";
interface DecisionSummary {
  title: string;
  lines: string[];
  plan: PreparedPlan;
}
interface Preview {
  revision: number;
  pool: LocalRecord<"pool">;
  persons: LocalRecord<"person">[];
  plan: PreparedPlan;
  applied: AppliedPlan | null;
  manifest: PoolManifest | null;
}

/** Decisões de plano sem resposta ("open") ou que não deram certo ("failed"), em cartões da Revisão. */
export function PlanningPending(
  { db, groupId, show, open }: {
    db: BolaoDatabase;
    groupId: string;
    show: "open" | "failed";
    open: (request: PlanningRequest) => void;
  },
) {
  const raw = useLiveQuery(
    async () => ({
      scope: `${db.name}:${groupId}`,
      commands: await db.planningCommands.where("groupId").equals(groupId)
        .toArray(),
    }),
    [db, groupId],
  );
  const commands = raw?.scope === `${db.name}:${groupId}` ? raw.commands : [];
  const title = (command: (typeof commands)[number]) =>
    command.command.action.type === "plan_apply"
      ? "Aplicar o plano"
      : "Travar o bolão";
  if (show === "open") {
    return commands.filter(unresolved).map((command) => (
      <ReviewItem
        key={command.idempotencyKey}
        family="Plano"
        title={title(command)}
        state="A conferir"
        line="A decisão ficou guardada neste aparelho, mas a resposta não chegou. Confira antes de repetir."
      >
        <Button
          aria-label="Conferir decisão do plano"
          onClick={() =>
            open({ type: "recover", idempotencyKey: command.idempotencyKey })}
        >
          Conferir
        </Button>
      </ReviewItem>
    ));
  }
  return commands.filter((command) =>
    command.status === "conflict" || command.status === "rejected"
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10).map((
    command,
  ) => (
    <ReviewItem
      key={command.idempotencyKey}
      family="Plano"
      title={title(command)}
      status="problem"
      state="Não confirmada"
      line={
        <span className="ui-review-note">
          {command.receipt?.message ??
            "Revise os dados e prepare uma nova decisão."}
        </span>
      }
    />
  ));
}

export function PlanningDialog(
  { db, groupId, request, enabled, availability, onClose, onNotice }: {
    db: BolaoDatabase;
    groupId: string;
    request: PlanningRequest;
    enabled: boolean;
    availability: string;
    onClose: () => void;
    onNotice: (notice: { text: string; error?: boolean }) => void;
  },
) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<DecisionSummary | null>(null);
  const [persistent, setPersistent] = useState<
    PersistentPlanningCommand | null
  >(null);
  const [key, setKey] = useState<string | null>(
    request.type === "recover" ? request.idempotencyKey : null,
  );
  const originalKey = useRef(key);
  const [registrar, setRegistrar] = useState("");
  const [holder, setHolder] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    const readOriginal = async () => {
      const id = originalKey.current;
      if (!id) return;
      const [command, saved] = await Promise.all([
        db.planningCommands.get(id),
        db.metadata.get(`planning-review:${id}`),
      ]);
      if (!command || command.groupId !== groupId) {
        throw new Error(
          "Esta decisão não está salva na conta e grupo selecionados.",
        );
      }
      if (active) {
        setPersistent(command);
        setSummary(saved?.value as DecisionSummary ?? null);
      }
    };
    void readOriginal().catch((failure) => {
      if (active) setError(message(failure));
    });
    if (!enabled || !navigator.onLine) {
      if (!sending.current) setBusy(false);
      return () => {
        active = false;
      };
    }
    if (originalKey.current) {
      return () => {
        active = false;
      };
    }
    setReviewed(false);
    setBusy(true);
    setError(null);
    const readFresh = async () => {
      const transport = createAccountTransport(db.accountId);
      await sync(db, transport);
      const financial = await transport.financialPull(groupId);
      const planning = await transport.planningPull(groupId);
      if (financial.groupRevision !== planning.groupRevision) {
        throw new Error(
          "Os dados mudaram durante a consulta. Atualize a revisão antes de confirmar.",
        );
      }
      await applyFinancialSnapshot(db, financial);
      await applyPlanningSnapshot(db, planning);
      const { records, localRecords, financialCommands, planningCommands, registrationCommands, resultCommands } =
        await readReviewSnapshot(db, groupId, financial.groupRevision);
      if ([...financialCommands, ...planningCommands, ...registrationCommands, ...resultCommands].some(unresolved)) {
        throw new Error(
          "Verifique a decisão pendente na Revisão antes de confirmar outra operação neste grupo.",
        );
      }
      if (request.type === "recover") return;
      const poolId = request.type === "plan_apply"
        ? request.plan.poolId
        : request.poolId;
      const pool = records.find((record) =>
        record.id === poolId && record.kind === "pool"
      ) as LocalRecord<"pool"> | undefined;
      if (!pool || pool.groupId !== groupId) {
        throw new Error("O bolão não está disponível nesta conta.");
      }
      const applied = latestApplied(planning, poolId);
      const plan = request.type === "plan_apply" ? request.plan : applied?.plan;
      if (
        !plan ||
        request.type === "pool_lock" && applied?.id !== request.appliedPlanId
      ) {
        throw new Error(
          "O plano aplicado mudou. Abra novamente o planejador para conferir a versão atual.",
        );
      }
      if (
        localRecords.some((record) =>
          record.state !== "synced" &&
          (record.id === groupId || record.id === poolId ||
            record.kind === "bet" &&
              (record as LocalRecord<"bet">).data.poolId === poolId ||
            record.kind === "quota" &&
              (record as LocalRecord<"quota">).data.poolId === poolId ||
            record.kind === "person" &&
              plan.rights.some((right) => right.personId === record.id))
        )
      ) {
        throw new Error(
          "Há mudanças salvas só neste aparelho ou conflitos em jogos, pessoas ou cotas deste bolão. Sincronize e resolva a revisão primeiro.",
        );
      }
      assertCurrentPlan(
        plan,
        records,
        financial,
        request.type === "plan_apply",
      );
      const manifest = latestManifest(planning, poolId);
      const persons = records.filter((record) =>
        record.kind === "person" &&
        (record as LocalRecord<"person">).data.adultDeclared
      ) as LocalRecord<"person">[];
      if (active) {
        setPreview({
          revision: financial.groupRevision,
          pool,
          plan,
          applied,
          manifest,
          persons,
        });
        if (manifest) {
          setRegistrar(manifest.content.responsible.registrarPersonId);
          setHolder(manifest.content.responsible.ticketHolderPersonId ?? "");
        }
      }
    };
    void readFresh().catch((failure) => {
      if (active) setError(message(failure));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [db, groupId, request, enabled, reload]);

  function decisionSummary(current: Preview): DecisionSummary {
    const lines = [
      `${current.pool.data.title} · concurso ${current.plan.contestNumber}.`,
      `${current.plan.bets.length} jogos em ${current.plan.tickets.length} cartela(s), preservando ${current.plan.sourceBets.length} jogos fixos.`,
      `Apostas: ${formatBRL(current.plan.betCostCents)}. Taxa prevista: ${
        formatBRL(current.plan.feeCents)
      }${
        current.plan.feeLabel ? ` (${current.plan.feeLabel})` : ""
      }. Custo reservado: ${formatBRL(current.plan.totalCostCents)}.`,
      `Sobra identificada: ${
        formatBRL(current.plan.leftoverCents)
      }. Destino autorizado: ${
        current.plan.leftoverPolicy === "refund-pro-rata"
          ? "devolução proporcional pendente"
          : current.plan.leftoverPolicy === "group-credit"
          ? "reserva identificada no grupo"
          : "ainda não definido"
      }.`,
      ...current.plan.rights.map((right) =>
        `${
          current.persons.find((person) => person.id === right.personId)?.data
            .name ?? right.personId
        }: ${formatQuotaUnits(right.units)} cota(s), ${
          formatBRL(right.dueCents)
        } confirmado(s).`
      ),
    ];
    if (request.type === "pool_lock") {
      lines.push(
        `Registrador: ${
          current.persons.find((person) => person.id === registrar)?.data
            .name ?? registrar
        }.`,
      );
      if (current.plan.participationMode === "internal") {
        lines.push(
          `Titular dos bilhetes no acordo interno: ${
            current.persons.find((person) => person.id === holder)?.data.name ??
              holder
          }.`,
        );
      }
      lines.push(
        `Prazo interno: ${
          current.pool.data.deadlineAt
            ? `${
              formatInstant(current.pool.data.deadlineAt, "America/Sao_Paulo")
            } (Brasília)`
            : "não definido"
        }. A confirmação do servidor congela esta versão; o registro da aposta continua externo.`,
      );
    }
    return {
      title: request.type === "pool_lock"
        ? "Travar o bolão"
        : "Aplicar o plano",
      lines,
      plan: current.plan,
    };
  }

  function command(current: Preview): PlanningCommand {
    if (request.type === "recover") {
      throw new Error("Esta decisão já possui conteúdo original.");
    }
    if (request.type === "pool_lock") {
      if (!current.applied) throw new Error("Aplique o plano antes de travar.");
      if (!current.persons.some((person) => person.id === registrar)) {
        throw new Error("Escolha a pessoa responsável pelo registro externo.");
      }
      if (
        current.plan.participationMode === "internal" &&
        !current.persons.some((person) => person.id === holder)
      ) throw new Error("Escolha o titular dos bilhetes no acordo interno.");
      if (
        current.plan.leftoverCents !== "0" &&
        current.plan.leftoverPolicy === "unassigned"
      ) {
        throw new Error(
          "Defina o destino da sobra e aplique um novo plano antes de travar.",
        );
      }
    }
    return {
      apiVersion: "v1",
      idempotencyKey: crypto.randomUUID(),
      groupId,
      expectedRevision: current.revision,
      action: request.type === "plan_apply"
        ? { type: "plan_apply", plan: current.plan }
        : {
          type: "pool_lock",
          poolId: current.pool.id,
          poolVersion: current.pool.serverVersion,
          appliedPlanId: current.applied!.id,
          responsible: {
            registrarPersonId: registrar,
            ticketHolderPersonId: current.plan.participationMode === "internal"
              ? holder
              : null,
          },
        },
    };
  }

  async function finish(receipt: PlanningReceipt) {
    if (!mounted.current) return;
    if (receipt.status === "accepted") {
      onNotice({ text: "Decisão de plano registrada no servidor." });
      onClose();
      void sync(db, createAccountTransport(db.accountId)).catch(() =>
        undefined
      );
    } else {
      onNotice({
        text: receipt.message ?? "Revise os dados e prepare uma nova decisão.",
        error: true,
      });
      onClose();
    }
  }

  async function confirm() {
    if (!enabled || !navigator.onLine || !reviewed || sending.current) return;
    setError(null);
    setBusy(true);
    sending.current = true;
    try {
      let id = originalKey.current;
      if (id && !recoveryChecked) {
        throw new Error(
          "Consulte o recibo original antes de repetir a decisão.",
        );
      }
      if (!id) {
        if (!preview) {
          throw new Error("Consulte os dados atuais antes de confirmar.");
        }
        const prepared = command(preview);
        const review = decisionSummary(preview);
        await db.transaction(
          "rw",
          db.planningCommands,
          db.metadata,
          async () => {
            await preparePlanningCommand(db, prepared);
            await db.metadata.put({
              key: `planning-review:${prepared.idempotencyKey}`,
              value: review,
            });
          },
        );
        id = prepared.idempotencyKey;
        originalKey.current = id;
        if (mounted.current) {
          setKey(id);
          setSummary(review);
        }
      }
      if (mounted.current) {
        setReviewed(false);
        setRecoveryChecked(false);
      }
      const receipt = await executePlanningCommand(
        db,
        createAccountTransport(db.accountId),
        id,
      );
      await finish(receipt);
    } catch (failure) {
      if (mounted.current) {
        setError(
          originalKey.current
            ? "O resultado precisa ser verificado. A decisão original ficou salva; consulte o recibo antes de repetir."
            : message(failure),
        );
        if (originalKey.current) {
          setPersistent(
            await db.planningCommands.get(originalKey.current) ?? null,
          );
        }
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function recover() {
    if (!originalKey.current || !enabled || sending.current) return;
    setBusy(true);
    setError(null);
    setReviewed(false);
    sending.current = true;
    try {
      const receipt = await recoverPlanningCommand(
        db,
        createAccountTransport(db.accountId),
        originalKey.current,
      );
      if (receipt) await finish(receipt);
      else if (mounted.current) {
        setRecoveryChecked(true);
        setError(
          "Nenhum recibo foi encontrado. Você pode aprovar o reenvio explícito do mesmo conteúdo e chave.",
        );
      }
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const shown = summary ?? (preview ? decisionSummary(preview) : null);
  const first = !key;
  const canClose = !sending.current;
  return (
    <Modal
      title={shown?.title ?? "Revisar decisão do plano"}
      description="Confira com a internet ligada. Aplicar o plano e travar o bolão só acontecem quando você confirma."
      onClose={() => {
        if (canClose) onClose();
      }}
    >
      {busy && (
        <p className="inline-note">
          <LoaderCircle className="spin" size={17} />Buscando os dados atuais…
        </p>
      )}
      {!enabled && <p className="inline-note">{availability}</p>}
      {shown && (
        <>
          <div className="planning-review-text">
            {shown.lines.map((line, index) => <p key={index}>{line}</p>)}
          </div>
          <PlanValues plan={shown.plan} />
          <PlanDetails plan={shown.plan} />
        </>
      )}
      {first && request.type === "pool_lock" && preview && (
        <div className="planning-settings">
          <label>
            Responsável pelo registro externo<select
              value={registrar}
              disabled={busy || !!preview.manifest}
              onChange={(event) => {
                setRegistrar(event.target.value);
                setReviewed(false);
                setError(null);
              }}
            >
              <option value="">Selecione a pessoa</option>
              {preview.persons.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.data.name}
                </option>
              ))}
            </select>
          </label>
          {preview.plan.participationMode === "internal" && (
            <label>
              Titular dos bilhetes<select
                value={holder}
                disabled={busy || !!preview.manifest}
                onChange={(event) => {
                  setHolder(event.target.value);
                  setReviewed(false);
                  setError(null);
                }}
              >
                <option value="">Selecione a pessoa</option>
                {preview.persons.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.data.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {key && (
        <p className="inline-note">
          A decisão original está guardada. Consultar o recibo mostra se ela
          valeu; reenviar usa os mesmos jogos, valores e responsáveis.
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {key && (
        <div className="planning-actions">
          <button
            className="button secondary"
            disabled={!enabled || busy}
            onClick={() => void recover()}
          >
            <RefreshCw size={17} />Consultar recibo do plano
          </button>
        </div>
      )}
      {first && (
        <button
          className="button secondary"
          disabled={!enabled || busy}
          onClick={() => {
            setPreview(null);
            setReviewed(false);
            setReload((value) => value + 1);
          }}
        >
          Atualizar revisão
        </button>
      )}
      {(first || recoveryChecked) && (
        <label className="planning-review-checkbox">
          <input
            type="checkbox"
            checked={reviewed}
            disabled={!enabled || busy || !shown || !!error && first}
            onChange={(event) => setReviewed(event.target.checked)}
          />Revisei o plano e autorizo esta decisão online.
        </label>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={!canClose}
          onClick={onClose}
        >
          Fechar revisão
        </button>
        <button
          className="button primary"
          disabled={!enabled || busy || !reviewed || !shown ||
            !!key && !recoveryChecked ||
            !!persistent && !unresolved(persistent)}
          onClick={() => void confirm()}
        >
          <ShieldCheck size={17} />
          {key ? "Reenviar decisão original" : "Confirmar plano no servidor"}
        </button>
      </div>
    </Modal>
  );
}
