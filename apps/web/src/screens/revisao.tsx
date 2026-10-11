import { lazy, Suspense, useState } from "react";
import { AlertTriangle, CheckCheck, ShieldCheck, Wallet } from "lucide-react";
import { formatBRL } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import { resolveConflict } from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { EmptyState, StateBadge } from "../components";
import { FinancialPending, FinancialReview } from "../finance";
import type { FinancialRequest } from "../finance";
import { PlanningPending } from "../planning-decision";
import type { PlanningRequest } from "../planning-decision";
import type { RecordRequest } from "../record-decision";
import { errorMessage, formatDate } from "../app-shared";
import type { Notice, SaveRecord, Snapshot } from "../app-shared";
import { DivisaoDecisao, DivisaoPendente } from "./bolao-dividir-decisao";
import type { PedidoDivisao } from "./bolao-dividir-decisao";

const RecordPending = lazy(() =>
  import("../record-decision").then((module) => ({
    default: module.RecordPending,
  }))
);

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
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">CONFERIR É CUIDAR</span>
          <h1>Uma pausa para revisar.</h1>
          <p>
            Propostas ficam separadas dos registros confirmados.
          </p>
        </div>
        <span className="count-bubble">
          {reviewCount} pendentes
        </span>
      </div>
      {groupId && !isDemo && (
        <FinancialPending
          key={`${db.name}:${groupId}`}
          db={db}
          groupId={groupId}
          open={setFinancialRequest}
        />
      )}
      {groupId && !isDemo && (
        <Suspense fallback={null}>
          <RecordPending
            key={`records:${db.name}:${groupId}`}
            db={db}
            groupId={groupId}
            open={setRecordRequest}
          />
        </Suspense>
      )}
      {groupId && !isDemo && (
        <PlanningPending
          key={`plans:${db.name}:${groupId}`}
          db={db}
          groupId={groupId}
          open={setPlanningRequest}
        />
      )}
      {groupId && !isDemo && (
        <DivisaoPendente
          key={`divisao:${db.name}:${groupId}`}
          db={db}
          groupId={groupId}
          open={setDivisao}
        />
      )}
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
      {snapshot.records.filter((r) =>
        r.groupId === groupId && r.state === "conflict"
      ).map((record) => (
        <section
          className="panel conflict-panel"
          key={record.id}
        >
          <AlertTriangle size={20} />
          <div>
            <h3>Uma alteração precisa de revisão</h3>
            <p>
              Seu rascunho foi preservado junto da versão recebida. Escolha qual
              conteúdo usar como base; reenviar continua sendo uma proposta.
            </p>
            <pre>{JSON.stringify(record.data, null, 2)}</pre>
            <div className="panel-actions">
              <button
                className="button secondary"
                onClick={() => {
                  void resolveConflict(db, {
                    entityId: record.id,
                    resolution: "keep-local",
                  }).then(() =>
                    setNotice({
                      text: "Rascunho preservado para nova sincronização.",
                    })
                  ).catch((e) =>
                    setNotice({
                      text: errorMessage(e),
                      error: true,
                    })
                  );
                }}
              >
                Manter meu rascunho
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  void resolveConflict(db, {
                    entityId: record.id,
                    resolution: "use-server",
                  }).then(() =>
                    setNotice({
                      text:
                        "Versão recebida adotada. A cópia anterior foi preservada.",
                    })
                  ).catch((e) =>
                    setNotice({
                      text: errorMessage(e),
                      error: true,
                    })
                  );
                }}
              >
                Usar versão recebida
              </button>
            </div>
          </div>
        </section>
      ))}
      {pendingReview.length
        ? (
          <div className="review-list">
            {pendingReview.map((proposal) => (
              <section
                className="panel review-card"
                key={proposal.id}
              >
                <div className="review-icon">
                  <Wallet size={24} />
                </div>
                <div className="review-copy">
                  <span className="simple-pill amber">
                    Pagamento proposto
                  </span>
                  <h2>
                    {snapshot.persons.find((p) =>
                      p.id === proposal.data.personId
                    )?.data.name ?? "Pessoa do grupo"}
                  </h2>
                  <p>
                    {proposal.data.note ||
                      "Recebimento informado manualmente."}
                  </p>
                  <small>
                    {snapshot.pools.find((p) => p.id === proposal.data.poolId)
                      ?.data.title} · {formatDate(proposal.createdAt)}
                  </small>
                  <StateBadge state={proposal.state} />
                </div>
                <div className="review-value">
                  <strong>
                    {formatBRL(proposal.data.amountCents)}
                  </strong>
                  <small>Fora do caixa confirmado</small>
                  <button
                    className="button primary"
                    disabled={!financeEnabled}
                    onClick={() =>
                      setFinancialRequest({
                        type: "payment_confirm",
                        proposalId: proposal.id,
                      })}
                  >
                    Conferir recebimento
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      void save("payment-proposal", {
                        ...proposal.data,
                        status: "rejected",
                      }, proposal.id).catch((e) =>
                        setNotice({
                          text: errorMessage(e),
                          error: true,
                        })
                      );
                    }}
                  >
                    Descartar proposta
                  </button>
                </div>
              </section>
            ))}
            <div className="inline-note">
              <ShieldCheck size={19} />
              <span>
                {financeEnabled
                  ? "Conferir o recebimento é uma decisão humana online. Salvar ou sincronizar a proposta não confirma pagamento nem participação."
                  : financeAvailability}
              </span>
            </div>
          </div>
        )
        : isDemo
        ? (
          <EmptyState
            icon={<CheckCheck size={30} />}
            title="Tudo tranquilo por aqui"
            description="Novos pagamentos preparados aparecerão para revisão e não alterarão o caixa."
          />
        )
        : (
          <p className="inline-note">
            <CheckCheck size={18} />
            <span>
              Nenhum recebimento aguardando revisão. Confira os combinados e
              participações abaixo.
            </span>
          </p>
        )}
      {group && !isDemo && (
        <FinancialReview
          snapshot={snapshot.finances}
          group={group}
          persons={snapshot.persons}
          pools={snapshot.pools}
          quotas={snapshot.quotas}
          enabled={financeEnabled}
          availability={financeAvailability}
          open={setFinancialRequest}
        />
      )}
    </>
  );
}
