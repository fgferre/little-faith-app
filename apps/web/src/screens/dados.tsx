import type { Session } from "@supabase/supabase-js";
import {
  Cloud,
  CloudOff,
  Download,
  LogIn,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { LocalRecord } from "@bolao/core";
import { SectionTitle } from "../components";
import { loginWithGoogle, supabase } from "../auth";
import { errorMessage, formatDate, supportedTimeZones } from "../app-shared";
import type { FormKind, Notice, Snapshot } from "../app-shared";

export function DadosScreen(
  {
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
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">
            SEU TRABALHO BEM CUIDADO
          </span>
          <h1>Dados e integrações</h1>
          <p>
            Saiba o que está salvo e o que ainda precisa de conexão.
          </p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <SectionTitle
            title="Este aparelho"
            subtitle={isDemo
              ? "Espaço exclusivo da demonstração"
              : session && mode === "account"
              ? "Espaço privado da sua conta"
              : "Seus rascunhos locais"}
          />
          <div className="settings-row">
            <span>Conexão</span>
            <strong>{online ? "Online" : "Offline"}</strong>
          </div>
          <div className="settings-row">
            <span>Alterações na fila</span>
            <strong>{snapshot.summary.pending}</strong>
          </div>
          <div className="settings-row">
            <span>Conflitos</span>
            <strong>{snapshot.summary.conflicts}</strong>
          </div>
          <div className="settings-row">
            <span>Última sincronização</span>
            <strong>
              {snapshot.summary.lastSyncAt
                ? formatDate(snapshot.summary.lastSyncAt)
                : "Ainda não realizada"}
            </strong>
          </div>
          <div className="settings-row">
            <span>Armazenamento</span>
            <strong>
              {storageUsage ?? "Consultar uso abaixo"}
            </strong>
          </div>
          <div className="panel-actions">
            {group && (
              <button
                className="button secondary"
                onClick={() => openForm("edit-group")}
              >
                Editar grupo e combinados
              </button>
            )}
            <button
              className="button primary"
              disabled={syncing}
              onClick={() => {
                void synchronize(true);
              }}
            >
              <RefreshCw
                size={16}
                className={syncing ? "spin" : ""}
              />Sincronizar agora
            </button>
            <button
              className="button secondary"
              onClick={() => {
                void (async () => {
                  try {
                    const estimate = await navigator.storage
                      ?.estimate();
                    setStorageUsage(
                      estimate?.usage !== undefined
                        ? `${
                          (estimate.usage / 1_048_576).toFixed(
                            1,
                          )
                        } MB usados`
                        : "Consulta indisponível",
                    );
                    const granted = await navigator.storage
                      ?.persist?.();
                    setPersistent(granted ?? false);
                    setNotice({
                      text: granted
                        ? "Armazenamento persistente autorizado neste navegador."
                        : "Uso consultado. O navegador ainda pode liberar espaço; mantenha cópias de segurança.",
                    });
                  } catch (e) {
                    setNotice({
                      text: errorMessage(e),
                      error: true,
                    });
                  }
                })();
              }}
            >
              Consultar e proteger
            </button>
          </div>
          {persistent && (
            <p className="positive">
              <ShieldCheck size={15} />Armazenamento persistente autorizado
            </p>
          )}
          {syncError && (
            <p role="alert" className="form-error">
              {syncError}
            </p>
          )}
        </section>
        <section className="panel">
          <SectionTitle
            title="Sua conta, seus aparelhos"
            subtitle="Participantes podem continuar pelo WhatsApp."
          />
          <div className="account-illustration">
            <Cloud size={35} />
            <span>+</span>
            <ShieldCheck size={35} />
          </div>
          <p className="settings-copy">
            {session
              ? `Conta conectada: ${session.user.email ?? "organizador"}.`
              : supabase
              ? "Entre com Google para sincronizar rascunhos entre aparelhos."
              : "A conexão compartilhada ainda não foi configurada. Você já pode preparar tudo neste aparelho."}
          </p>
          {!session && (
            <button
              className="button primary"
              disabled={!supabase || !online}
              onClick={() => {
                void loginWithGoogle().catch((e) =>
                  setNotice({
                    text: errorMessage(e),
                    error: true,
                  })
                );
              }}
            >
              <LogIn size={17} />Entrar com Google
            </button>
          )}
          {session && (
            <div className="panel-actions">
              <button
                className="button primary"
                onClick={() => switchMode("account")}
              >
                Usar minha conta
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  void (async () => {
                    const { error } = await supabase!.auth
                      .signOut();
                    if (error) throw error;
                    setSession(null);
                    switchMode("local");
                    setNotice({
                      text:
                        "Você saiu da conta. Os rascunhos dessa conta foram preservados neste aparelho.",
                    });
                  })().catch((e) =>
                    setNotice({
                      text: errorMessage(e),
                      error: true,
                    })
                  );
                }}
              >
                Sair e preservar dados
              </button>
            </div>
          )}
          <div className="inline-note">
            <CloudOff size={17} />
            <span>
              Rascunhos locais e demonstração são espaços separados da sua
              conta. Trocar de espaço preserva o trabalho.
            </span>
          </div>
        </section>
        <section className="panel">
          <SectionTitle title="Do seu jeito" />
          <label className="timezone-setting">
            Fuso para conferir concursos<select
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            >
              {supportedTimeZones.map((zone) => (
                <option value={zone} key={zone}>{zone}</option>
              ))}
            </select>
            <small>
              Os horários dos concursos mostram Brasília e este fuso, com as
              regras de horário de verão aplicáveis.
            </small>
          </label>
          <div className="panel-actions">
            <button
              className="button secondary"
              onClick={() => switchMode("local")}
            >
              Usar rascunhos locais
            </button>
            <button
              className="button secondary"
              onClick={() => switchMode("demo")}
            >
              Explorar demonstração
            </button>
          </div>
          <button
            className="text-link"
            onClick={() => setForm("group")}
          >
            <Plus size={16} />Adicionar outro grupo
          </button>
        </section>
        <section className="panel">
          <SectionTitle title="Recuperação e próximos passos" />
          <div className="inline-note">
            <Download size={19} />
            <span>
              Backup protegido e restauração completa serão implementados na
              etapa de recuperação. O armazenamento do navegador ainda é a única
              cópia dos rascunhos locais.
            </span>
          </div>
          <p className="muted">
            Rascunhos, cálculos, pessoas, jogos e conferência financeira online,
            planejamento, registro e resultados. Resgate, distribuição, acesso
            por agente e recuperação completa são as próximas etapas.
          </p>
          <div className="build-badge">
            EM CONSTRUÇÃO · v0.1.0
          </div>
        </section>
      </div>
    </>
  );
}
