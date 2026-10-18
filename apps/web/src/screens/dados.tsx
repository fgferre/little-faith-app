import type { Session } from "@supabase/supabase-js";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, LogIn, Plus, RefreshCw } from "lucide-react";
import type { LocalRecord } from "@bolao/core";
import {
  collectBackup,
  exportEmergencySnapshot,
  restoreBackup,
  summarizeBackup,
} from "@bolao/local";
import type { BackupBundle, BackupSummary, BolaoDatabase } from "@bolao/local";
import { loginWithGoogle, supabase } from "../auth";
import { MIN_BACKUP_PASSWORD, readBackupZip, writeBackupZip } from "../backup-zip";
import { downloadBlob, downloadText } from "../registration-handoff";
import {
  Button,
  Card,
  Chip,
  Disclosure,
  Eyebrow,
  formatInstant,
  PageHead,
  ProblemBox,
} from "../ui";
import { DoacaoCard } from "../doacao";
import { errorMessage, formatDate, supportedTimeZones } from "../app-shared";
import type { FormKind, Notice, Snapshot } from "../app-shared";

/** Quando o último backup com senha foi baixado neste aparelho (linha de `metadata`, valor ISO). */
const LAST_BACKUP_KEY = "backup:last-export";

const contagem = (n: number, um: string, varios: string) =>
  `${n} ${n === 1 ? um : varios}`;

export function DadosScreen(
  {
    db,
    snapshot,
    group,
    session,
    mode,
    online,
    isDemo,
    syncing,
    syncError,
    storageUsage,
    persistent,
    timeZone,
    synchronize,
    switchMode,
    openForm,
    setForm,
    setNotice,
    setStorageUsage,
    setPersistent,
    setSession,
    setTimeZone,
  }: {
    db: BolaoDatabase;
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    session: Session | null;
    mode: "demo" | "local" | "account";
    online: boolean;
    isDemo: boolean;
    syncing: boolean;
    syncError: string | null;
    storageUsage: string | null;
    persistent: boolean;
    timeZone: string;
    synchronize: (manual?: boolean) => Promise<void>;
    switchMode: (next: "demo" | "local" | "account") => void;
    openForm: (kind: FormKind) => void;
    setForm: (kind: FormKind) => void;
    setNotice: (notice: Notice) => void;
    setStorageUsage: (usage: string | null) => void;
    setPersistent: (persistent: boolean) => void;
    setSession: (session: Session | null) => void;
    setTimeZone: (timeZone: string) => void;
  },
) {
  const [exporting, setExporting] = useState(false);
  const lastBackup = useLiveQuery(
    async () => (await db.metadata.get(LAST_BACKUP_KEY))?.value,
    [db],
  );
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [checked, setChecked] = useState<
    { bundle: BackupBundle; summary: BackupSummary; empty: boolean } | null
  >(null);
  const backupOff = mode === "demo";
  const connection = !online
    ? <Chip status="pending">Sem internet</Chip>
    : isDemo
    ? <Chip family>Demonstração</Chip>
    : session && mode === "account"
    ? <Chip status="confirmed">Conectado à sua conta</Chip>
    : <Chip family>Só neste aparelho</Chip>;
  const facts: [string, string | number][] = [
    ["Esperando para enviar", snapshot.summary.pending],
    ["Duas versões para escolher", snapshot.summary.conflicts],
    [
      "Última sincronização",
      snapshot.summary.lastSyncAt
        ? formatDate(snapshot.summary.lastSyncAt, timeZone)
        : "Ainda não aconteceu",
    ],
    ["Espaço usado", storageUsage ?? "Toque em Consultar e proteger"],
  ];

  async function protect() {
    try {
      const estimate = await navigator.storage?.estimate();
      setStorageUsage(
        estimate?.usage !== undefined
          ? `${(estimate.usage / 1_048_576).toFixed(1)} MB`
          : "Consulta indisponível",
      );
      const granted = await navigator.storage?.persist?.();
      setPersistent(granted ?? false);
      setNotice({
        text: granted
          ? "Este navegador vai guardar seus dados de forma permanente."
          : "Espaço consultado. O navegador ainda pode apagar dados se faltar espaço; baixe um backup com senha de vez em quando.",
      });
    } catch (e) {
      setNotice({ text: errorMessage(e), error: true });
    }
  }

  async function exportCopy() {
    setExporting(true);
    try {
      const text = await exportEmergencySnapshot(db);
      downloadText(
        text,
        `little-faith-copia-de-emergencia-${
          new Date().toISOString().slice(0, 10)
        }.json`,
        "application/json",
      );
      setNotice({
        text: "Cópia baixada. Guarde o arquivo em lugar seguro: ele não tem senha.",
      });
    } catch (e) {
      setNotice({ text: errorMessage(e), error: true });
    } finally {
      setExporting(false);
    }
  }

  async function exportBackup() {
    setBackupBusy(true);
    try {
      const zip = await writeBackupZip(await collectBackup(db), backupPassword);
      downloadBlob(
        zip,
        `little-faith-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      await db.metadata.put({
        key: LAST_BACKUP_KEY,
        value: new Date().toISOString(),
      });
      setBackupPassword("");
      setNotice({
        text:
          "Backup baixado. Guarde o arquivo e a senha: sem a senha ele não abre.",
      });
    } catch (e) {
      setNotice({ text: errorMessage(e), error: true });
    } finally {
      setBackupBusy(false);
    }
  }

  async function checkBackup() {
    if (!restoreFile) return;
    setBackupBusy(true);
    setChecked(null);
    try {
      const bundle = await readBackupZip(restoreFile, restorePassword);
      const summary = summarizeBackup(bundle.manifest);
      const empty = (await db.records.count()) === 0 &&
        (await db.serverRecords.count()) === 0;
      setChecked({ bundle, summary, empty });
    } catch (e) {
      setNotice({ text: errorMessage(e), error: true });
    } finally {
      setBackupBusy(false);
    }
  }

  async function restore() {
    if (!checked) return;
    setBackupBusy(true);
    try {
      const summary = await restoreBackup(db, checked.bundle);
      setNotice({
        text: `Backup restaurado: ${
          contagem(summary.pools, "bolão", "bolões")
        }, ${contagem(summary.persons, "pessoa", "pessoas")}, ${
          contagem(summary.files, "comprovante", "comprovantes")
        }. Recarregando…`,
      });
      // continua ocupado até recarregar: o aparelho já não está vazio
      setTimeout(() => window.location.reload(), 1_500);
    } catch (e) {
      setNotice({ text: errorMessage(e), error: true });
      setBackupBusy(false);
    }
  }

  async function signOut() {
    try {
      const { error } = await supabase!.auth.signOut();
      if (error) throw error;
      setSession(null);
      switchMode("local");
      setNotice({
        text:
          "Você saiu da conta. O que estava neste aparelho continua guardado.",
      });
    } catch (e) {
      setNotice({ text: errorMessage(e), error: true });
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Onde tudo fica guardado"
        title="Dados e integrações"
        line="O que está salvo neste aparelho e o que precisa de internet."
      />
      <div className="settings-grid">
        <Card className="finance-card" label="Este aparelho">
          <div className="finance-head">
            <Eyebrow>Este aparelho</Eyebrow>
            {connection}
          </div>
          <dl className="history-lines">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {persistent && (
            <Chip status="confirmed">Guardado de forma permanente</Chip>
          )}
          {syncError && (
            <div role="alert">
              <ProblemBox title="A sincronização não terminou">
                {syncError}
              </ProblemBox>
            </div>
          )}
          <div className="settings-actions">
            <Button
              disabled={syncing}
              icon={
                <RefreshCw
                  aria-hidden="true"
                  className={syncing ? "spin" : ""}
                />
              }
              onClick={() => void synchronize(true)}
            >
              Sincronizar agora
            </Button>
            <Button variant="ghost" onClick={() => void protect()}>
              Consultar e proteger
            </Button>
          </div>
        </Card>
        <Card className="finance-card" label="Sua conta">
          <Eyebrow>Sua conta</Eyebrow>
          <p className="settings-copy">
            {session
              ? `Conta conectada: ${session.user.email ?? "organizador"}.`
              : supabase
              ? "Entre com Google para ter os mesmos bolões em todos os seus aparelhos. Quem participa continua pelo WhatsApp, sem conta."
              : "A conta compartilhada ainda não foi ligada neste app. Você já pode preparar tudo neste aparelho."}
          </p>
          <div className="settings-actions">
            {session
              ? (
                <>
                  <Button onClick={() => switchMode("account")}>
                    Usar minha conta
                  </Button>
                  <Button variant="ghost" onClick={() => void signOut()}>
                    Sair e guardar os dados
                  </Button>
                </>
              )
              : (
                <Button
                  icon={<LogIn aria-hidden="true" />}
                  disabled={!supabase || !online}
                  onClick={() => {
                    void loginWithGoogle().catch((e) =>
                      setNotice({ text: errorMessage(e), error: true })
                    );
                  }}
                >
                  Entrar com Google
                </Button>
              )}
          </div>
          <p className="ui-sec">
            O que fica só neste aparelho e a demonstração são espaços separados
            da sua conta. Trocar de espaço não apaga nada.
          </p>
        </Card>
        <Card className="finance-card" label="Seu grupo">
          <Eyebrow>Seu grupo</Eyebrow>
          <label className="timezone-setting">
            Fuso para os horários dos sorteios<select
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            >
              {supportedTimeZones.map((zone) => (
                <option value={zone} key={zone}>{zone}</option>
              ))}
            </select>
            <small className="ui-sec">
              Os horários aparecem no de Brasília e neste fuso, com horário de
              verão quando houver.
            </small>
          </label>
          <div className="settings-actions">
            {group && (
              <Button variant="ghost" onClick={() => openForm("edit-group")}>
                Editar grupo e combinados
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<Plus aria-hidden="true" />}
              onClick={() => setForm("group")}
            >
              Adicionar outro grupo
            </Button>
          </div>
        </Card>
        <Card className="finance-card" label="Backup">
          <Eyebrow>Backup</Eyebrow>
          <p className="settings-copy">
            Um arquivo com tudo deste aparelho, trancado com uma senha que só
            você sabe. Sem a senha ninguém abre, nem o app. Guarde o arquivo e
            a senha fora do aparelho.
          </p>
          <p className="ui-sec">
            {typeof lastBackup === "string"
              ? `Último backup: ${formatInstant(lastBackup, timeZone)}`
              : "Nenhum backup baixado ainda."}
          </p>
          <div className="pool-form">
            <label>
              Senha do backup<input
                type="password"
                autoComplete="new-password"
                value={backupPassword}
                onChange={(event) => setBackupPassword(event.target.value)}
              />
              <small className="ui-sec">Pelo menos 8 caracteres.</small>
            </label>
          </div>
          <div className="settings-actions">
            <Button
              disabled={backupBusy ||
                backupPassword.length < MIN_BACKUP_PASSWORD || backupOff}
              icon={<Download aria-hidden="true" />}
              onClick={() => void exportBackup()}
            >
              Baixar backup com senha
            </Button>
          </div>
          {backupOff && (
            <p className="ui-sec">Na demonstração o backup fica desligado.</p>
          )}
          <Eyebrow>Restaurar um backup</Eyebrow>
          <div className="pool-form">
            <label>
              Arquivo do backup<input
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  setRestoreFile(event.target.files?.[0] ?? null);
                  setChecked(null);
                }}
              />
            </label>
            <label>
              Senha do backup<input
                type="password"
                autoComplete="current-password"
                value={restorePassword}
                onChange={(event) => {
                  setRestorePassword(event.target.value);
                  setChecked(null);
                }}
              />
            </label>
          </div>
          <div className="settings-actions">
            <Button
              variant="ghost"
              disabled={backupBusy || !restoreFile || !restorePassword ||
                backupOff}
              onClick={() => void checkBackup()}
            >
              Conferir o arquivo
            </Button>
          </div>
          {checked && (
            <>
              <p className="settings-copy" role="status">
                {[
                  `Backup de ${
                    formatInstant(checked.summary.createdAt, timeZone)
                  }`,
                  contagem(checked.summary.groups, "grupo", "grupos"),
                  contagem(checked.summary.pools, "bolão", "bolões"),
                  contagem(checked.summary.persons, "pessoa", "pessoas"),
                  contagem(
                    checked.summary.files,
                    "comprovante",
                    "comprovantes",
                  ),
                ].join(" · ")}
              </p>
              {checked.empty
                ? (
                  <div className="settings-actions">
                    <Button
                      disabled={backupBusy || backupOff}
                      onClick={() => void restore()}
                    >
                      Restaurar neste aparelho
                    </Button>
                  </div>
                )
                : (
                  <ProblemBox title="Este aparelho já tem dados">
                    Restaure num aparelho vazio, ou apague os dados deste
                    aparelho antes.
                  </ProblemBox>
                )}
            </>
          )}
          <Disclosure summary="Cópia de emergência, sem senha">
            <div className="pool-form">
              <ProblemBox title="Não é a cópia completa">
                Não traz o que está só no servidor e não tem senha: quem tiver o
                arquivo vê os dados do grupo.
              </ProblemBox>
              <div className="settings-actions">
                <Button
                  variant="ghost"
                  disabled={exporting}
                  icon={<Download aria-hidden="true" />}
                  onClick={() => void exportCopy()}
                >
                  Baixar cópia de emergência
                </Button>
              </div>
            </div>
          </Disclosure>
        </Card>
        <Card className="finance-card" label="Demonstração">
          <Eyebrow>Demonstração</Eyebrow>
          <p className="settings-copy">
            {isDemo
              ? "Você está vendo dados de exemplo. Nada daqui se mistura com o seu grupo."
              : "Veja um grupo de exemplo a qualquer momento; o seu continua guardado."}
          </p>
          <div className="settings-actions">
            {!isDemo && (
              <Button variant="ghost" onClick={() => switchMode("demo")}>
                Ver a demonstração
              </Button>
            )}
            {mode !== "local" && (
              <Button variant="ghost" onClick={() => switchMode("local")}>
                Usar só este aparelho
              </Button>
            )}
            {session && mode !== "account" && (
              <Button variant="ghost" onClick={() => switchMode("account")}>
                Voltar para minha conta
              </Button>
            )}
          </div>
        </Card>
        <DoacaoCard />
      </div>
    </>
  );
}
