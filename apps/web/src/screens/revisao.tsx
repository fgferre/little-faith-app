import { lazy, Suspense, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AnimatePresence } from "motion/react";
import type { EntityKind, LocalRecord } from "@bolao/core";
import { resolveConflict } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { FinancialPending, FinancialReview } from "../finance";
import type { FinancialRequest } from "../finance";
import { PlanningPending } from "../planning-decision";
import type { PlanningRequest } from "../planning-decision";
import type { RecordRequest } from "../record-decision";
import { errorMessage, formatDate } from "../app-shared";
import type { Notice, SaveRecord, Snapshot } from "../app-shared";
import {
  Button,
  Card,
  Chip,
  Disclosure,
  PageHead,
  ReviewItem,
} from "../ui";
import { DivisaoDecisao } from "./bolao-dividir-decisao";
import type { PedidoDivisao } from "./bolao-dividir-decisao";

const RecordPending = lazy(() =>
  import("../record-decision").then((module) => ({
    default: module.RecordPending,
  }))
);

/** Pendências de cada família: as que esperam conferência ou as que não deram certo. */
export type PendingShow = "open" | "failed";

const KIND_LABEL: Record<EntityKind, string> = {
  group: "Grupo",
  person: "Pessoa",
  pool: "Bolão",
  quota: "Cota",
  "payment-proposal": "Pagamento",
  bet: "Jogo",
};

const DIVISAO_LABEL: Record<string, string> = {
  expense_confirm: "Custo das apostas",
  prize_confirm: "Prêmio",
  redemption_record: "Resgate do prêmio",
  redemption_reverse: "Desfazer resgate",
  distribution_record: "Pagamento do prêmio",
  distribution_reverse: "Desfazer pagamento",
  pool_settle: "Encerrar o bolão",
  pool_reopen: "Reabrir o bolão",
};

const aberto = (item: { status: string }) =>
  ["prepared", "sending", "unknown"].includes(item.status);

/** A divisão do prêmio que ficou sem resposta (ou foi recusada), em cartões da Revisão. */
function DivisaoPendente(
  { db, groupId, show, poolName, open }: {
    db: BolaoDatabase;
    groupId: string;
    show: PendingShow;
    poolName: (id: string) => string;
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
  return raw.commands.map((saved) => {
    const action = saved.command.action;
    const title = DIVISAO_LABEL[action.type] ?? "Divisão do prêmio";
    const cents = "amountCents" in action ? action.amountCents : undefined;
    if (show === "open" && aberto(saved)) {
      return (
        <ReviewItem
          key={saved.idempotencyKey}
          family="Divisão do prêmio"
          title={title}
          cents={cents}
          state="A conferir"
          line={`${poolName(action.poolId)} · enviado em ${
            formatDate(saved.createdAt)
          }. A resposta não chegou a este aparelho; confira antes de repetir.`}
        >
          <Button onClick={() => open({ idempotencyKey: saved.idempotencyKey })}>
            Conferir
          </Button>
        </ReviewItem>
      );
    }
    if (show === "failed" && ["rejected", "conflict"].includes(saved.status)) {
      return (
        <ReviewItem
          key={saved.idempotencyKey}
          family="Divisão do prêmio"
          title={title}
          cents={cents}
          status="problem"
          state="Não confirmada"
          line={`${poolName(action.poolId)} · ${
            saved.status === "conflict"
              ? "alguém mudou o grupo antes da confirmação."
              : saved.receipt?.message ?? "confira os dados e faça de novo."
          }`}
        />
      );
    }
    return null;
  });
}

export function RevisaoScreen(
  {
    db,
    snapshot,
    group,
    groupId,
    isDemo,
    reviewCount,
    pendingReview,
    financeEnabled,
    financeAvailability,
    timeZone,
    save,
    setFinancialRequest,
    setPlanningRequest,
    setRecordRequest,
    setNotice,
  }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    groupId: string | null;
    isDemo: boolean;
    reviewCount: number;
    pendingReview: Snapshot["proposals"];
    financeEnabled: boolean;
    financeAvailability: string;
    timeZone: string;
    save: SaveRecord;
    setFinancialRequest: (request: FinancialRequest) => void;
    setPlanningRequest: (request: PlanningRequest) => void;
    setRecordRequest: (request: RecordRequest) => void;
    setNotice: (notice: Notice) => void;
  },
) {
  const [divisao, setDivisao] = useState<PedidoDivisao | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const poolName = (id: string) =>
    snapshot.pools.find((p) => p.id === id)?.data.title ?? "Bolão";
  const conflicts = snapshot.records.filter((r) =>
    r.groupId === groupId && r.state === "conflict"
  );
  const families = (show: PendingShow) =>
    groupId && !isDemo && (
      <>
        <FinancialPending
          key={`finance:${show}:${db.name}:${groupId}`}
          db={db}
          groupId={groupId}
          show={show}
          open={setFinancialRequest}
        />
        <Suspense fallback={null}>
          <RecordPending
            key={`records:${show}:${db.name}:${groupId}`}
            db={db}
            groupId={groupId}
            show={show}
            open={setRecordRequest}
          />
        </Suspense>
        <PlanningPending
          key={`plans:${show}:${db.name}:${groupId}`}
          db={db}
          groupId={groupId}
          show={show}
          open={setPlanningRequest}
        />
        <DivisaoPendente
          key={`divisao:${show}:${db.name}:${groupId}`}
          db={db}
          groupId={groupId}
          show={show}
          poolName={poolName}
          open={setDivisao}
        />
      </>
    );

  const resolve = (
    record: (typeof conflicts)[number],
    resolution: "keep-local" | "use-server",
  ) => {
    void resolveConflict(db, { entityId: record.id, resolution }).then(() =>
      setNotice({
        text: resolution === "keep-local"
          ? "Sua versão ficou valendo e vai ser enviada de novo."
          : "A versão que chegou ficou valendo. A sua ficou guardada.",
      })
    ).catch((e) => setNotice({ text: errorMessage(e), error: true }));
  };

  return (
    <>
      <PageHead
        eyebrow="Pede atenção"
        title="Uma pausa para revisar."
        line={reviewCount
          ? `${reviewCount} ${
            reviewCount === 1 ? "pendência" : "pendências"
          } · nada vale antes de você conferir`
          : "Tudo o que foi anotado já foi conferido."}
      />
      <div className="review-list">
        {conflicts.map((record) => (
          <Card
            className="ui-review"
            key={record.id}
            label={`${KIND_LABEL[record.kind]}: duas versões`}
          >
            <div className="ui-review-head">
              <Chip family>{KIND_LABEL[record.kind]}</Chip>
              <Chip status="problem">Duas versões</Chip>
            </div>
            <div className="ui-review-main">
              <b>Esta informação mudou em outro aparelho</b>
            </div>
            <p className="ui-sec">
              A sua versão ficou guardada junto com a que chegou. Escolha qual
              vale; a escolhida ainda passa pela conferência.
            </p>
            <div className="ui-review-actions">
              <Button onClick={() => resolve(record, "keep-local")}>
                Manter a minha
              </Button>
              <Button variant="ghost" onClick={() => resolve(record, "use-server")}>
                Usar a que chegou
              </Button>
            </div>
            <Disclosure summary="Detalhes técnicos">
              <pre className="review-tech">
                {JSON.stringify(record.data, null, 2)}
              </pre>
            </Disclosure>
          </Card>
        ))}
        {pendingReview.map((proposal) => {
          const person = snapshot.persons.find((p) =>
            p.id === proposal.data.personId
          );
          return (
            <ReviewItem
              key={proposal.id}
              family="Pagamento"
              title={person?.data.name ?? "Pessoa do grupo"}
              cents={proposal.data.amountCents}
              state="A conferir"
              line={
                <>
                  {poolName(proposal.data.poolId)} ·{" "}
                  {formatDate(proposal.createdAt, timeZone)}
                  <span className="ui-review-note">
                    {proposal.data.note || "Valor anotado à mão."}
                  </span>
                </>
              }
            >
              {discarding === proposal.id
                ? (
                  <>
                    <p className="ui-sec" role="alert">
                      Descartar esta proposta?
                    </p>
                    <Button
                      onClick={() => {
                        setDiscarding(null);
                        void save("payment-proposal", {
                          ...proposal.data,
                          status: "rejected",
                        }, proposal.id).catch((e) =>
                          setNotice({ text: errorMessage(e), error: true })
                        );
                      }}
                    >
                      Confirmar
                    </Button>
                    <Button variant="ghost" onClick={() => setDiscarding(null)}>
                      Cancelar
                    </Button>
                  </>
                )
                : (
                  <>
                    <Button
                      disabled={!financeEnabled}
                      onClick={() =>
                        setFinancialRequest({
                          type: "payment_confirm",
                          proposalId: proposal.id,
                        })}
                    >
                      Conferir
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setDiscarding(proposal.id)}
                    >
                      Descartar
                    </Button>
                  </>
                )}
            </ReviewItem>
          );
        })}
        {families("open")}
        {!reviewCount && (
          <Card className="review-empty" label="Nada para revisar">
            <b>Nada para revisar</b>
            <Chip status="confirmed">
              Pagamentos, planos e resultados estão em dia
            </Chip>
          </Card>
        )}
      </div>
      {pendingReview.length > 0 && !financeEnabled && (
        <p className="ui-sec review-why">{financeAvailability}</p>
      )}
      {groupId && !isDemo && (
        <section className="review-failed" aria-label="Não deram certo">
          <h2 className="ui-eyebrow">Não deram certo</h2>
          <div className="review-list">{families("failed")}</div>
        </section>
      )}
      <AnimatePresence>
        {divisao && groupId && (
          <DivisaoDecisao
            key={`divisao:${db.name}:${groupId}`}
            db={db}
            groupId={groupId}
            request={divisao}
            enabled={financeEnabled}
            availability={financeAvailability}
            timeZone={timeZone}
            onClose={() => setDivisao(null)}
            onNotice={setNotice}
          />
        )}
      </AnimatePresence>
      {group && !isDemo && (
        <FinancialReview
          snapshot={snapshot.finances}
          group={group}
          persons={snapshot.persons}
          pools={snapshot.pools}
          quotas={snapshot.quotas}
          enabled={financeEnabled}
          availability={pendingReview.length ? null : financeAvailability}
          open={setFinancialRequest}
        />
      )}
    </>
  );
}
