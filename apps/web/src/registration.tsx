import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, FileCheck2, RefreshCw, Upload } from "lucide-react";
import {
  brasiliaDateTimeToUTC,
  formatBRL,
  LOTTERIES,
  parseBRL,
  verifyManifest,
} from "@bolao/core";
import type {
  EvidenceMetadata,
  LocalRecord,
  LotteryId,
  PoolManifest,
  RegistrationItem,
} from "@bolao/core";
import {
  getEvidenceOriginal,
  getRegistrationSnapshot,
  listEvidenceUploads,
  prepareEvidenceUpload,
  recoverEvidenceUpload,
  uploadEvidence,
} from "@bolao/local";
import type { BolaoDatabase } from "@bolao/local";
import { createAccountTransport, downloadEvidenceOriginal } from "./auth";
import { EmptyState, Numbers, SectionTitle } from "./components";
import { downloadText, registrationChecklist } from "./registration-handoff";
import type { RecordRequest } from "./record-decision";

interface TicketDraft {
  present: boolean;
  lottery: LotteryId | "";
  contest: string;
  numbers: string;
  cost: string;
  fee: string;
  quotaCount: string;
  assignments: Record<string, string>;
  registeredAt: string;
  evidenceIds: string[];
  reason: string;
}
interface Draft {
  tickets: Record<string, TicketDraft>;
  reason: string;
}
const emptyTicket = (): TicketDraft => ({
  present: false,
  lottery: "",
  contest: "",
  numbers: "",
  cost: "",
  fee: "",
  quotaCount: "",
  assignments: {},
  registeredAt: "",
  evidenceIds: [],
  reason: "",
});
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível salvar a conferência.";
const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

export default function Registration(
  {
    db,
    groupId,
    pool,
    manifest,
    enabled,
    availability,
    open,
    onNotice,
    goPlanning,
  }: {
    db: BolaoDatabase;
    groupId: string;
    pool: LocalRecord<"pool">;
    manifest: PoolManifest | null;
    enabled: boolean;
    availability: string;
    open: (request: RecordRequest) => void;
    onNotice: (notice: { text: string; error?: boolean }) => void;
    goPlanning: () => void;
  },
) {
  const scope = `${db.name}:${groupId}:${pool.id}`;
  const raw = useLiveQuery(
    async () => ({
      scope,
      snapshot: await getRegistrationSnapshot(db, groupId),
      uploads: await listEvidenceUploads(db, groupId, pool.id),
    }),
    [db, groupId, pool.id],
  );
  const local = raw?.scope === scope ? raw : undefined;
  const latest = local?.snapshot?.reports.filter((report) =>
    report.poolId === pool.id
  ).sort((a, b) => b.version - a.version)[0];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(id: string, work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  const evidence =
    local?.snapshot?.evidence.filter((file) => file.poolId === pool.id) ?? [];
  async function saveFile(file: File) {
    await run("file", async () => {
      await prepareEvidenceUpload(db, {
        groupId,
        poolId: pool.id,
        original: file,
        originalName: file.name,
      });
      if (mounted.current) {
        onNotice({
          text:
            "Original salvo neste aparelho. Envie-o online para verificar o arquivo antes de confirmar o registro.",
        });
      }
    });
  }
  async function send(id: string, recover: boolean) {
    await run(id, async () => {
      const transport = createAccountTransport(db.accountId);
      if (recover && !await recoverEvidenceUpload(db, transport, id)) {
        if (mounted.current) {
          onNotice({
            text:
              "O upload ainda não foi encontrado. O original continua salvo; use Enviar original para repetir com o mesmo arquivo.",
          });
        }
        return;
      }
      if (!recover) await uploadEvidence(db, transport, id);
      // Pull the server revision including the technical evidence marker.
      const snapshot = await transport.registrationPull(groupId);
      const { applyRegistrationSnapshot } = await import("@bolao/local");
      await applyRegistrationSnapshot(db, snapshot);
      if (mounted.current) {
        onNotice({
          text:
            "Original verificado no servidor. Confira os dados do recibo antes de confirmar a aposta.",
        });
      }
    });
  }
  async function original(id: string, metadata?: EvidenceMetadata) {
    await run(id, async () => {
      const upload = local?.uploads.find((file) => file.id === id);
      const blob = await getEvidenceOriginal(db, id) ??
        (metadata
          ? await downloadEvidenceOriginal(db.accountId, metadata)
          : null);
      if (!blob) {
        throw new Error(
          "O arquivo original não está disponível neste aparelho. Conecte a conta para baixar o original privado.",
        );
      }
      downloadBlob(
        blob,
        upload?.originalName ?? metadata?.originalName ?? "comprovante",
      );
    });
  }
  return (
    <div className="planning-sections">
      <section className="panel">
        <SectionTitle
          title="Do plano ao comprovante"
          subtitle="A lista planejada fica preservada. A conferência registra o que foi lido nos recibos externos."
        />
        {!manifest
          ? (
            <EmptyState
              icon={<FileCheck2 size={30} />}
              title="Trave o bolão antes do registro"
              description="Confira o plano e os responsáveis para preparar a lista do registrador."
              action={
                <button className="button primary" onClick={goPlanning}>
                  Abrir planejador
                </button>
              }
            />
          )
          : (
            <>
              <p className="inline-note">
                Manifesto versão {manifest.version} ·{" "}
                {manifest.content.plan.bets.length} jogos em{" "}
                {manifest.content.plan.tickets.length} cartela(s).
              </p>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() =>
                  void run("checklist", async () => {
                    if (!await verifyManifest(manifest)) {
                      throw new Error(
                        "O manifesto não corresponde ao hash confirmado. Sincronize antes de preparar a lista.",
                      );
                    }
                    downloadText(
                      registrationChecklist(manifest),
                      `lista-${pool.data.lotteryId}-${manifest.content.plan.contestNumber}-v${manifest.version}.txt`,
                    );
                  })}
              >
                <Download size={17} />Baixar lista privada para o registrador
              </button>
            </>
          )}
      </section>
      {manifest && (
        <section className="panel">
          <SectionTitle
            title="Comprovantes privados"
            subtitle="PDF, PNG, JPEG ou WebP, até 10 MB. O original fica salvo no aparelho antes do envio e recebe hash e horário no servidor."
          />
          <label className="evidence-picker">
            Selecionar original<input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              disabled={!!busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void saveFile(file);
              }}
            />
          </label>
          {!enabled && (
            <p className="inline-note">
              {availability} Os originais podem ser preparados neste aparelho.
            </p>
          )}
          <div className="evidence-list">
            {local?.uploads.map((file) => (
              <div className="evidence-file" key={file.id}>
                <div>
                  <strong>{file.originalName}</strong>
                  <small>
                    {(file.byteSize / 1024).toFixed(1)} KB ·{" "}
                    {file.status === "uploaded"
                      ? "Original verificado"
                      : file.status === "prepared"
                      ? "Salvo neste aparelho"
                      : "Upload precisa de verificação"}
                  </small>
                </div>
                <div className="planning-actions">
                  <button
                    className="button secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void original(file.id, file.confirmedMetadata)}
                  >
                    <Download size={16} />Baixar original
                  </button>
                  {file.status !== "uploaded" && (
                    <>
                      {file.status !== "prepared" && (
                        <button
                          className="button secondary"
                          disabled={!enabled || !!busy}
                          onClick={() => void send(file.id, true)}
                        >
                          <RefreshCw size={16} />Consultar upload
                        </button>
                      )}
                      <button
                        className="button secondary"
                        disabled={!enabled || !!busy ||
                          file.status === "uploading"}
                        onClick={() =>
                          void send(file.id, false)}
                      >
                        <Upload size={16} />Enviar original
                      </button>
                    </>
                  )}
                </div>
                {file.lastError && (
                  <small className="form-error">{file.lastError}</small>
                )}
              </div>
            ))}
            {evidence.filter((file) =>
              !local?.uploads.some((upload) => upload.id === file.id)
            ).map((file) => (
              <div className="evidence-file" key={file.id}>
                <div>
                  <strong>{file.originalName}</strong>
                  <small>
                    Original privado confirmado em{" "}
                    {new Date(file.uploadedAt).toLocaleString("pt-BR")}
                  </small>
                </div>
                <button
                  className="button secondary"
                  disabled={!enabled || !!busy}
                  onClick={() => void original(file.id, file)}
                >
                  <Download size={16} />Baixar original
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {latest && (
        <section className="panel" aria-label="Registro conferido">
          <SectionTitle
            title={`Registro conferido · versão ${latest.version}`}
            subtitle={`Confirmado em ${
              new Date(latest.confirmedAt).toLocaleString("pt-BR")
            }. O plano e os direitos continuam preservados no manifesto.`}
          />
          <p
            className={`simple-pill ${
              latest.comparison.status === "complete" ? "green" : "amber"
            }`}
          >
            {latest.comparison.status === "complete"
              ? "Conferência completa"
              : latest.comparison.status === "partial"
              ? "Registro parcial"
              : "Registro com divergências"}
          </p>
          <div className="planner-overview">
            <div>
              <span>Cartelas observadas</span>
              <strong>{latest.comparison.observedTicketCount}</strong>
            </div>
            <div>
              <span>Comprovantes ausentes</span>
              <strong>{latest.comparison.missingTicketCount}</strong>
            </div>
            <div>
              <span>Valor das apostas lido</span>
              <strong>
                {latest.comparison.observedBetCostCents === null
                  ? "Ainda incompleto"
                  : formatBRL(latest.comparison.observedBetCostCents)}
              </strong>
            </div>
          </div>
          {latest.comparison.issues.map((issue, index) => (
            <p className="inline-note" key={index}>{issue.message}</p>
          ))}
          <details className="planning-details">
            <summary>Ver as versões da conferência</summary>
            {local?.snapshot?.reports.filter((report) =>
              report.poolId === pool.id
            ).map((report) => (
              <p key={report.id}>
                Versão {report.version} ·{" "}
                {new Date(report.confirmedAt).toLocaleString("pt-BR")} ·{" "}
                {report.reason || "Conferência inicial"}
              </p>
            ))}
          </details>
        </section>
      )}
      {manifest && (
        <RegistrationForm
          key={`${scope}:${manifest.id}`}
          db={db}
          pool={pool}
          manifest={manifest}
          evidence={evidence}
          enabled={enabled}
          open={open}
          revision={latest?.version ?? 0}
        />
      )}
    </div>
  );
}

function RegistrationForm({
  db,
  pool,
  manifest,
  evidence,
  enabled,
  open,
  revision,
}: {
  db: BolaoDatabase;
  pool: LocalRecord<"pool">;
  manifest: PoolManifest;
  evidence: EvidenceMetadata[];
  enabled: boolean;
  open: (request: RecordRequest) => void;
  revision: number;
}) {
  const key =
    `registration-draft:${manifest.groupId}:${manifest.poolId}:${manifest.id}`;
  const [draft, setDraft] = useState<Draft>({ tickets: {}, reason: "" });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    void db.metadata.get(key).then((value) => {
      if (active) {
        if (value) setDraft(value.value as Draft);
        setLoaded(true);
      }
    }).catch((failure) => {
      if (active) setError(errorMessage(failure));
    });
    return () => {
      active = false;
    };
  }, [db, key]);
  function save(next: Draft) {
    setDraft(next);
    setError(null);
    writes.current = writes.current.then(async () => {
      await db.metadata.put({ key, value: structuredClone(next) });
    }).catch((failure) => setError(errorMessage(failure)));
  }
  function update(ticketKey: string, fields: Partial<TicketDraft>) {
    save({
      ...draft,
      tickets: {
        ...draft.tickets,
        [ticketKey]: {
          ...(draft.tickets[ticketKey] ?? emptyTicket()),
          ...fields,
        },
      },
    });
  }
  async function review() {
    try {
      await writes.current;
      const items: RegistrationItem[] = manifest.content.plan.tickets.map(
        (ticket) => {
          const value = draft.tickets[ticket.key] ?? emptyTicket();
          return {
            plannedTicketKey: ticket.key,
            evidenceIds: value.evidenceIds,
            reason: value.reason.trim(),
            observed: value.present
              ? {
                lotteryId: value.lottery || null,
                contestNumber: value.contest.trim()
                  ? Number(value.contest)
                  : null,
                betNumbers: value.numbers.trim()
                  ? value.numbers.trim().split(/\n+/).map((line) =>
                    line.trim().split(/[\s,;]+/).map(Number)
                  )
                  : null,
                betCostCents: value.cost.trim() ? parseBRL(value.cost) : null,
                feeCents: value.fee.trim() ? parseBRL(value.fee) : null,
                officialQuotaCount: value.quotaCount.trim()
                  ? Number(value.quotaCount)
                  : null,
                officialAssignments:
                  manifest.content.plan.participationMode === "official" &&
                    Object.values(value.assignments).some((count) =>
                      count.trim()
                    )
                    ? manifest.content.plan.rights.filter((right) =>
                      value.assignments[right.quotaId]?.trim()
                    ).map((right) => ({
                      quotaId: right.quotaId,
                      personId: right.personId,
                      officialQuotas: Number(value.assignments[right.quotaId]),
                    }))
                    : null,
                registeredAt: value.registeredAt
                  ? brasiliaDateTimeToUTC(value.registeredAt)
                  : null,
              }
              : null,
          };
        },
      );
      if (!items.some((item) => item.observed && item.evidenceIds.length)) {
        throw new Error(
          "Informe os dados lidos em pelo menos um comprovante e selecione seu original verificado.",
        );
      }
      open({
        family: "registration",
        action: {
          type: "registration_confirm",
          poolId: pool.id,
          poolVersion: pool.serverVersion,
          manifestId: manifest.id,
          items,
          reason: draft.reason.trim(),
        },
      });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const ticket = manifest.content.plan.tickets[selected]!;
  const value = draft.tickets[ticket.key] ?? emptyTicket();
  return (
    <section className="panel registration-form">
      <SectionTitle
        title={revision
          ? "Preparar uma nova conferência"
          : "Conferir as cartelas"}
        subtitle="Preencha somente os dados que conseguiu ler. Campos vazios ficam identificados como desconhecidos, sem copiar os valores planejados."
      />
      <label>
        Cartela a conferir<select
          value={selected}
          disabled={!loaded}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {manifest.content.plan.tickets.map((item, index) => (
            <option value={index} key={item.key}>
              Cartela {index + 1} · {draft.tickets[item.key]?.present
                ? "comprovante apresentado"
                : "comprovante ausente"}
            </option>
          ))}
        </select>
      </label>
      <div className="receipt-planned">
        <strong>
          Planejado · {ticket.numberCount} dezenas ·{" "}
          {formatBRL(ticket.betCostCents)}
        </strong>
        {ticket.betKeys.map((betKey) => (
          <Numbers
            key={betKey}
            lotteryId={manifest.content.plan.lotteryId}
            numbers={manifest.content.plan.bets.find((bet) =>
              bet.key === betKey
            )!.numbers}
            small
          />
        ))}
        {ticket.officialQuotaCount !== null && (
          <small>
            {ticket.officialQuotaCount} cotas oficiais previstas de{" "}
            {formatBRL(ticket.officialQuotaValueCents!)}.
          </small>
        )}
      </div>
      <label className="planning-review-checkbox">
        <input
          type="checkbox"
          checked={value.present}
          disabled={!loaded}
          onChange={(event) =>
            update(ticket.key, { present: event.target.checked })}
        />Comprovante apresentado para esta cartela.
      </label>
      {value.present && (
        <>
          <fieldset className="evidence-choices">
            <legend>Originais verificados desta cartela</legend>
            {evidence.length
              ? evidence.map((file) => (
                <label className="planning-review-checkbox" key={file.id}>
                  <input
                    type="checkbox"
                    checked={value.evidenceIds.includes(file.id)}
                    onChange={(event) =>
                      update(ticket.key, {
                        evidenceIds: event.target.checked
                          ? [...value.evidenceIds, file.id]
                          : value.evidenceIds.filter((id) =>
                            id !== file.id
                          ),
                      })}
                  />
                  {file.originalName}
                </label>
              ))
              : (
                <p className="muted">
                  Envie um original privado antes de confirmar o registro.
                </p>
              )}
          </fieldset>
          <div className="form-columns">
            <label>
              Modalidade lida no recibo<select
                value={value.lottery}
                onChange={(event) =>
                  update(ticket.key, {
                    lottery: event.target.value as LotteryId | "",
                  })}
              >
                <option value="">Não legível</option>
                {Object.values(LOTTERIES).map((lottery) => (
                  <option value={lottery.id} key={lottery.id}>
                    {lottery.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Concurso lido no recibo<input
                inputMode="numeric"
                value={value.contest}
                onChange={(event) =>
                  update(ticket.key, { contest: event.target.value })}
              />
            </label>
          </div>
          <label>
            Dezenas lidas no recibo<textarea
              rows={Math.min(ticket.betKeys.length + 1, 6)}
              placeholder="Um jogo por linha. Deixe vazio se não conseguiu ler."
              value={value.numbers}
              onChange={(event) =>
                update(ticket.key, { numbers: event.target.value })}
            />
          </label>
          <div className="form-columns">
            <label>
              Valor das apostas lido (R$)<input
                inputMode="decimal"
                value={value.cost}
                onChange={(event) =>
                  update(ticket.key, { cost: event.target.value })}
              />
            </label>
            <label>
              Taxa externa lida (R$)<input
                inputMode="decimal"
                placeholder="0,00 se confirmada sem taxa"
                value={value.fee}
                onChange={(event) =>
                  update(ticket.key, { fee: event.target.value })}
              />
            </label>
          </div>
          {manifest.content.plan.participationMode === "official" && (
            <>
              <label>
                Total de cotas oficiais lido<input
                  inputMode="numeric"
                  value={value.quotaCount}
                  onChange={(event) =>
                    update(ticket.key, { quotaCount: event.target.value })}
                />
              </label>
              {manifest.content.plan.rights.map((right) => (
                <label key={right.quotaId}>
                  Cotas oficiais de{" "}
                  {manifest.content.persons.find((person) =>
                    person.id === right.personId
                  )?.data.name ?? "participante"}
                  <input
                    inputMode="numeric"
                    value={value.assignments[right.quotaId] ?? ""}
                    onChange={(event) =>
                      update(ticket.key, {
                        assignments: {
                          ...value.assignments,
                          [right.quotaId]: event.target.value,
                        },
                      })}
                  />
                </label>
              ))}
            </>
          )}
          <label>
            Horário lido no recibo (Brasília)<input
              type="datetime-local"
              step="1"
              value={value.registeredAt}
              onChange={(event) =>
                update(ticket.key, { registeredAt: event.target.value })}
            />
          </label>
        </>
      )}
      <label>
        Observação da cartela<textarea
          rows={2}
          value={value.reason}
          onChange={(event) =>
            update(ticket.key, { reason: event.target.value })}
          placeholder="Descreva dados ilegíveis, ausência ou divergências."
        />
      </label>
      <label>
        Motivo da conferência ou correção<textarea
          rows={2}
          value={draft.reason}
          onChange={(event) => save({ ...draft, reason: event.target.value })}
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button
        className="button primary"
        disabled={!enabled || !loaded}
        onClick={() => void review()}
      >
        <FileCheck2 size={17} />Revisar conferência do registro
      </button>
    </section>
  );
}
