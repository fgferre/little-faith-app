import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Download,
  FileCheck2,
  Paperclip,
  RefreshCw,
  Upload,
} from "lucide-react";
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
  RegistrationReport,
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
import { createAccountTransport, downloadEvidenceOriginal } from "../auth";
import { downloadText, registrationChecklist } from "../registration-handoff";
import type { RecordRequest } from "../record-decision";
import type { Notice } from "../app-shared";
import {
  ampliado,
  Balls,
  Button,
  Card,
  Chip,
  copiar,
  Disclosure,
  EnviarWhatsApp,
  Eyebrow,
  GameGroups,
  porAutor,
  ProblemBox,
  reais,
} from "../ui";

interface TicketDraft {
  present: boolean;
  lottery: LotteryId | "";
  contest: string;
  contestCount: string;
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
  contestCount: "1",
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
const dateTime = (value: string) =>
  new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** Primeiro nome de quem fez o jogo, pelas pessoas congeladas na trava. */
function personName(manifest: PoolManifest, personId: string | undefined) {
  const person = manifest.content.persons.find((p) => p.id === personId);
  return person
    ? (person.data.nickname || person.data.name).split(" ")[0]!
    : null;
}

/** Texto curto para mandar a quem vai registrar: jogos por cartela e o total, sem dados financeiros. */
function handoffText(manifest: PoolManifest) {
  const { plan, pool } = manifest.content;
  const deadline = pool.data.deadlineAt
    ? new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    }).format(new Date(pool.data.deadlineAt))
    : null;
  return [
    `${pool.data.title} · ${
      LOTTERIES[plan.lotteryId].label
    } · concurso ${plan.contestNumber}`,
    ...(deadline ? [`Registrar até ${deadline} (Brasília).`] : []),
    "",
    ...plan.tickets.flatMap((ticket, index) => [
      `Cartela ${index + 1} · ${ticket.numberCount} números · ${
        formatBRL(ticket.betCostCents)
      }`,
      ...ticket.betKeys.map((key) =>
        plan.bets.find((bet) => bet.key === key)!.numbers.map(pad).join(" · ")
      ),
      "",
    ]),
    `Total das apostas: ${formatBRL(plan.betCostCents)}`,
    "Guarde o comprovante e mande uma foto para a conferência.",
  ].join("\n");
}

export function BolaoRegistrar(
  {
    db,
    groupId,
    pool,
    manifest,
    enabled,
    availability,
    open,
    onNotice,
    goPlay,
    goDraw,
  }: {
    db: BolaoDatabase;
    groupId: string;
    pool: LocalRecord<"pool">;
    manifest: PoolManifest | null;
    enabled: boolean;
    availability: string;
    open: (request: RecordRequest) => void;
    onNotice: (notice: Notice) => void;
    goPlay: () => void;
    goDraw: () => void;
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
  const reports = local?.snapshot?.reports.filter((report) =>
    report.poolId === pool.id
  ).sort((a, b) => b.version - a.version) ?? [];
  const latest = reports[0];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // O WhatsApp abre por link, sem esperar o toque: a lista é conferida antes, como no Copiar.
  const [handoff, setHandoff] = useState<{ id: string; text: string } | null>(
    null,
  );
  useEffect(() => {
    if (!manifest) return;
    let alive = true;
    void verifyManifest(manifest).then((ok) => {
      if (alive) {
        setHandoff(ok ? { id: manifest.id, text: handoffText(manifest) } : null);
      }
    });
    return () => {
      alive = false;
    };
  }, [manifest]);
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
  const verified = evidence.length > 0 ||
    !!local?.uploads.some((file) => file.status === "uploaded");
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
            "Comprovante guardado neste aparelho. Envie o original quando estiver online para conferir o arquivo.",
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
              "O envio ainda não apareceu no servidor. O original continua guardado; use Enviar original para repetir com o mesmo arquivo.",
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
            "Original conferido no servidor. Agora confira os dados do recibo.",
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
          "O arquivo original não está neste aparelho. Entre na conta para baixar o original.",
        );
      }
      downloadBlob(
        blob,
        upload?.originalName ?? metadata?.originalName ?? "comprovante",
      );
    });
  }
  async function checked(list: PoolManifest) {
    if (!await verifyManifest(list)) {
      throw new Error(
        "A lista não bate com a versão travada. Sincronize antes de mandar ao registrador.",
      );
    }
  }
  const copyList = (list: PoolManifest) =>
    run("copy", async () => {
      await checked(list);
      const copied = await copiar(handoffText(list));
      if (mounted.current) {
        onNotice(
          copied
            ? { text: "Lista copiada. Cole na conversa com quem vai registrar." }
            : { text: "Não deu para copiar a lista. Tente de novo.", error: true },
        );
      }
    });
  const downloadList = (list: PoolManifest) =>
    run("checklist", async () => {
      await checked(list);
      downloadText(
        registrationChecklist(list),
        `lista-${pool.data.lotteryId}-${list.content.plan.contestNumber}-v${list.version}.txt`,
      );
    });

  if (!manifest && !latest) {
    return (
      <Card className="pool-card" label="Registro">
        <Eyebrow>Registro</Eyebrow>
        <h2 className="pool-card-title">Falta travar o bolão</h2>
        <p className="ui-sec">
          Quando os jogos e as cotas estiverem travados, a lista para quem vai
          registrar aparece aqui.
        </p>
        <div className="pool-actions">
          <Button onClick={goPlay}>Ir para Jogar</Button>
        </div>
      </Card>
    );
  }

  const files = (
    <Card className="pool-card" label="Comprovantes">
      <Eyebrow>Comprovantes</Eyebrow>
      <p className="ui-sec">
        Foto ou PDF do recibo, até 10 MB. O original fica guardado neste
        aparelho e é conferido no servidor.
      </p>
      {!enabled && (
        <p className="ui-sec pool-note">
          {availability} Dá para anexar agora e enviar depois.
        </p>
      )}
      {!!(local?.uploads.length || evidence.length) && (
        <ul className="pool-files">
          {local?.uploads.map((file) => (
            <li className="pool-file" key={file.id}>
              <span className="pool-file-name">{file.originalName}</span>
              <span className="ui-sec">
                {(file.byteSize / 1024).toFixed(1)} KB
              </span>
              {file.status === "uploaded"
                ? <Chip status="confirmed">Original verificado</Chip>
                : file.status === "prepared"
                ? <Chip status="pending">Salvo neste aparelho</Chip>
                : <Chip status="problem">Envio precisa ser conferido</Chip>}
              <div className="pool-actions">
                <Button
                  variant="ghost"
                  small
                  icon={<Download aria-hidden="true" />}
                  disabled={!!busy}
                  onClick={() => void original(file.id, file.confirmedMetadata)}
                >
                  Baixar original
                </Button>
                {file.status !== "uploaded" && file.status !== "prepared" && (
                  <Button
                    variant="ghost"
                    small
                    icon={<RefreshCw aria-hidden="true" />}
                    disabled={!enabled || !!busy}
                    onClick={() => void send(file.id, true)}
                  >
                    Consultar envio
                  </Button>
                )}
                {file.status !== "uploaded" && (
                  <Button
                    variant="ghost"
                    small
                    icon={<Upload aria-hidden="true" />}
                    disabled={!enabled || !!busy ||
                      file.status === "uploading"}
                    onClick={() => void send(file.id, false)}
                  >
                    Enviar original
                  </Button>
                )}
              </div>
              {file.lastError && (
                <ProblemBox title="O envio falhou">{file.lastError}</ProblemBox>
              )}
            </li>
          ))}
          {evidence.filter((file) =>
            !local?.uploads.some((upload) => upload.id === file.id)
          ).map((file) => (
            <li className="pool-file" key={file.id}>
              <span className="pool-file-name">{file.originalName}</span>
              <span className="ui-sec">
                enviado em {dateTime(file.uploadedAt)}
              </span>
              <Chip status="confirmed">Original verificado</Chip>
              <div className="pool-actions">
                <Button
                  variant="ghost"
                  small
                  icon={<Download aria-hidden="true" />}
                  disabled={!enabled || !!busy}
                  onClick={() => void original(file.id, file)}
                >
                  Baixar original
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <label
        className={`ui-btn ghost pool-attach ${busy ? "disabled" : ""}`}
      >
        <Paperclip aria-hidden="true" />Anexar comprovante
        <input
          className="ui-hidden"
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
    </Card>
  );

  const failure = error && <p className="form-error" role="alert">{error}</p>;

  if (latest) {
    const listed = local?.snapshot?.manifests.find((item) =>
      item.id === latest.manifestId
    ) ?? (manifest?.id === latest.manifestId ? manifest : null);
    return (
      <div className="pool-cols">
        <Report
          report={latest}
          reports={reports}
          manifest={listed}
          goDraw={goDraw}
        >
          {manifest && (
            <Disclosure summary="Fazer uma nova conferência">
              <RegistrationForm
                key={`${scope}:${manifest.id}`}
                db={db}
                pool={pool}
                manifest={manifest}
                evidence={evidence}
                enabled={enabled}
                open={open}
                revision={latest.version}
              />
            </Disclosure>
          )}
          <Disclosure summary="Detalhes técnicos">
            {listed && (
              <>
                <p>
                  Lista versão {listed.version} · travada em{" "}
                  {dateTime(listed.lockedAt)}
                </p>
                <p className="manifest-hash">
                  Código de verificação da lista: {listed.sha256}
                </p>
              </>
            )}
            {reports.map((report) => (
              <p key={report.id}>
                Conferência {report.version} · {dateTime(report.confirmedAt)}
                {" "}
                · {report.reason || "Conferência inicial"}
              </p>
            ))}
            {manifest && (
              <Button
                variant="ghost"
                small
                icon={<Download aria-hidden="true" />}
                disabled={!!busy}
                onClick={() => void downloadList(manifest)}
              >
                Baixar lista
              </Button>
            )}
          </Disclosure>
        </Report>
        <div className="pool-stack">
          {files}
          {failure}
        </div>
      </div>
    );
  }

  const list = manifest!;
  const plan = list.content.plan;
  const registrar = personName(list, list.content.responsible.registrarPersonId);
  const game = (bet: (typeof plan.bets)[number]) => (
    <li className="pool-game" key={bet.key}>
      <Balls
        numbers={bet.numbers}
        detail={ampliado(plan.lotteryId, bet.numbers.length)}
      />
    </li>
  );
  return (
    <div className="pool-cols">
      <Card className="pool-card" label="Lista para o registrador">
        <Eyebrow>Lista para o registrador</Eyebrow>
        <p className="ui-sec">
          {plural(plan.bets.length, "jogo", "jogos")} em{" "}
          {plural(plan.tickets.length, "cartela", "cartelas")} ·{" "}
          {reais(plan.betCostCents)}
          {registrar && ` · registra: ${registrar}`}
        </p>
        <GameGroups
          groups={porAutor(
            plan.bets,
            (bet) => bet.authorIds,
            (id) => personName(list, id),
          )}
          row={game}
        />
        <div className="pool-actions">
          <div className="ui-pair">
            {handoff?.id === list.id && (
              <EnviarWhatsApp
                variant={verified ? "ghost" : "primary"}
                text={handoff.text}
              />
            )}
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() => void copyList(list)}
            >
              Copiar
            </Button>
          </div>
          <Button
            variant="ghost"
            icon={<Download aria-hidden="true" />}
            disabled={!!busy}
            onClick={() => void downloadList(list)}
          >
            Baixar lista
          </Button>
        </div>
      </Card>
      <div className="pool-stack">
        {files}
        {failure}
        <Card className="pool-card" label="Conferir o registro">
          <Eyebrow>Conferir o registro</Eyebrow>
          <RegistrationForm
            key={`${scope}:${list.id}`}
            db={db}
            pool={pool}
            manifest={list}
            evidence={evidence}
            enabled={enabled}
            open={open}
            revision={0}
            primary={verified}
          />
        </Card>
      </div>
    </div>
  );
}

/** Planejado × registrado por cartela; o que diverge ganha anel vermelho e a contagem em vermelho. */
function Report(
  { report, reports, manifest, goDraw, children }: {
    report: RegistrationReport;
    reports: RegistrationReport[];
    manifest: PoolManifest | null;
    goDraw: () => void;
    children: ReactNode;
  },
) {
  const { comparison } = report;
  const divergences = comparison.issues.filter((issue) =>
    issue.severity === "divergence"
  );
  const others = comparison.issues.filter((issue) =>
    issue.severity !== "divergence"
  );
  const divergenceCounts = new Map<string, number>();
  for (const issue of divergences) {
    divergenceCounts.set(
      issue.message,
      (divergenceCounts.get(issue.message) ?? 0) + 1,
    );
  }
  const plan = manifest?.content.plan;
  const holderId = manifest?.content.responsible.ticketHolderPersonId ?? null;
  const holderLine = !manifest || !plan
    ? null
    : plan.participationMode === "official"
    ? "Bolão oficial: cada pessoa recebe o próprio recibo da Caixa."
    : plan.participationMode === "internal"
    ? holderId
      ? `O bilhete original fica com ${
        personName(manifest, holderId) ?? "Participante"
      }. Sem ele ninguém recebe o prêmio.`
      : "O bolão foi travado sem titular dos bilhetes."
    : null;
  return (
    <Card className="pool-card" label="O que foi registrado">
      <div className="pool-card-head">
        <Eyebrow>O que foi registrado</Eyebrow>
        {comparison.status === "complete" && (
          <Chip status="confirmed">Registro completo</Chip>
        )}
        {comparison.status === "partial" && (
          <Chip status="pending">Registro parcial</Chip>
        )}
      </div>
      {comparison.status === "divergent" && (
        <ProblemBox title="Divergência">
          {[...divergenceCounts].map(([message, count]) =>
            count > 1 ? `${message} (${count} cartelas)` : message
          ).join(" ") || "O comprovante não bate com o planejado."}
        </ProblemBox>
      )}
      <p className="ui-sec">
        {comparison.observedTicketCount} de{" "}
        {comparison.observedTicketCount + comparison.missingTicketCount}{" "}
        cartelas com comprovante · valor lido{" "}
        {comparison.observedBetCostCents === null
          ? "ainda incompleto"
          : formatBRL(comparison.observedBetCostCents)}
        {reports.length > 1 && ` · conferência ${report.version}`}
      </p>
      {holderLine && <p className="ui-sec">{holderLine}</p>}
      {plan && (
        <ul className="pool-games">
          {plan.tickets.map((ticket, index) => {
            const item = report.items.find((entry) =>
              entry.plannedTicketKey === ticket.key
            );
            const planned = ticket.betKeys.map((key) =>
              plan.bets.find((bet) => bet.key === key)!.numbers
            );
            const observed = item?.observed?.betNumbers ?? null;
            return (
              <li className="pool-game pool-ticket" key={ticket.key}>
                <span className="pool-ticket-title">
                  Cartela {index + 1} · {ticket.numberCount} números
                  {!item?.observed && (
                    <Chip status="pending">Sem comprovante</Chip>
                  )}
                  {item?.observed && !observed && (
                    <Chip status="pending">Números não lidos</Chip>
                  )}
                </span>
                {observed
                  ? observed.map((numbers, bet) => {
                    const target = planned.reduce((best, candidate) =>
                      overlap(candidate, numbers) > overlap(best, numbers)
                        ? candidate
                        : best
                    , planned[bet] ?? planned[0]!);
                    const wrong = new Set(
                      numbers.filter((n) => !target.includes(n)),
                    );
                    return wrong.size || numbers.length !== target.length
                      ? (
                        <div className="pool-compare" key={bet}>
                          <Balls numbers={target} name="Planejado" size="sm" />
                          <Balls
                            numbers={numbers}
                            wrong={wrong}
                            size="sm"
                            name="Registrado"
                            note={
                              <span className="ui-hits wrong">
                                {plural(
                                  wrong.size,
                                  "número diferente",
                                  "números diferentes",
                                )}
                              </span>
                            }
                          />
                        </div>
                      )
                      : (
                        <Balls
                          key={bet}
                          numbers={numbers}
                          size="sm"
                          name="Registrado"
                          note={<span className="ui-hits">igual ao planejado</span>}
                        />
                      );
                  })
                  : planned.map((numbers, bet) => (
                    <Balls
                      key={bet}
                      numbers={numbers}
                      size="sm"
                      name="Planejado"
                    />
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {others.map((issue, index) => (
        <p className="ui-sec pool-note" key={index}>{issue.message}</p>
      ))}
      <Button onClick={goDraw}>Ir para o Sorteio</Button>
      {children}
    </Card>
  );
}
const overlap = (a: number[], b: number[]) =>
  a.filter((n) => b.includes(n)).length;

function RegistrationForm({
  db,
  pool,
  manifest,
  evidence,
  enabled,
  open,
  revision,
  primary = true,
}: {
  db: BolaoDatabase;
  pool: LocalRecord<"pool">;
  manifest: PoolManifest;
  evidence: EvidenceMetadata[];
  enabled: boolean;
  open: (request: RecordRequest) => void;
  revision: number;
  primary?: boolean;
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
                contestCount: value.contestCount.trim()
                  ? Number(value.contestCount)
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
          "Informe os dados lidos em pelo menos um comprovante e marque o original verificado.",
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
  const teimosinha = (manifest.content.plan.contestCount ?? 1) > 1;
  const contestField = (
    <label>
      Concurso lido no recibo<input
        inputMode="numeric"
        value={value.contest}
        onChange={(event) => update(ticket.key, { contest: event.target.value })}
      />
    </label>
  );
  return (
    <div className="pool-form">
      <p className="ui-sec">
        {revision
          ? "Uma nova conferência guarda a anterior. "
          : ""}Preencha só o que deu para ler no recibo. O que ficar vazio
        conta como não lido, nunca como igual ao planejado.
      </p>
      <label>
        Cartela a conferir<select
          value={selected}
          disabled={!loaded}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {manifest.content.plan.tickets.map((item, index) => (
            <option value={index} key={item.key}>
              Cartela {index + 1} · {draft.tickets[item.key]?.present
                ? "com comprovante"
                : "sem comprovante"}
            </option>
          ))}
        </select>
      </label>
      <div className="pool-planned">
        <span className="ui-sec">
          Planejado · {ticket.numberCount} números ·{" "}
          {formatBRL(ticket.betCostCents)}
        </span>
        {ticket.betKeys.map((betKey) => (
          <Balls
            key={betKey}
            numbers={manifest.content.plan.bets.find((bet) =>
              bet.key === betKey
            )!.numbers}
            size="sm"
          />
        ))}
        {ticket.officialQuotaCount !== null && (
          <span className="ui-sec">
            {ticket.officialQuotaCount} cotas oficiais previstas de{" "}
            {formatBRL(ticket.officialQuotaValueCents!)}.
          </span>
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
          <fieldset className="pool-fieldset">
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
                <p className="ui-sec">
                  Envie o original do comprovante antes de conferir.
                </p>
              )}
          </fieldset>
          {/* Só a teimosinha pergunta quantos concursos o recibo cobre (decisão do dono em 17/10); um recibo comum cobre um. */}
          <div className={teimosinha ? undefined : "form-columns"}>
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
            {!teimosinha && contestField}
          </div>
          {teimosinha && (
            <div className="form-columns">
              {contestField}
              <label>
                Concursos cobertos<input
                  inputMode="numeric"
                  value={value.contestCount}
                  onChange={(event) =>
                    update(ticket.key, { contestCount: event.target.value })}
                />
              </label>
            </div>
          )}
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
                placeholder="0,00 se não teve taxa"
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
          placeholder="Conte o que não deu para ler, o que faltou ou o que veio diferente."
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
      <Button
        variant={primary ? "primary" : "ghost"}
        icon={<FileCheck2 aria-hidden="true" />}
        disabled={!enabled || !loaded}
        onClick={() => void review()}
      >
        Revisar conferência do registro
      </Button>
    </div>
  );
}
