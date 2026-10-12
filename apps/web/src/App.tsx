import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { MotionConfig } from "motion/react";
import type { Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  History,
  Home,
  ListChecks,
  LoaderCircle,
  Plus,
  Settings2,
  Sparkles,
  Ticket,
  WifiOff,
  X,
} from "lucide-react";
import {
  betCost,
  betSignature,
  createFinancialView,
  GENERATION_ALGORITHM_VERSION,
  LOTTERIES,
  sumCents,
} from "@bolao/core";
import type { EntityDataMap, EntityKind } from "@bolao/core";
import { createLocalStore, listRecords, saveDraft, sync } from "@bolao/local";
import { BrandMark, Button, initials } from "./ui";
import { createAccountTransport, supabase } from "./auth";
import { seedDemo } from "./demo";
import { saveLocalDraft } from "./repository";
import { FinancialDialog } from "./finance";
import type { FinancialRequest } from "./finance";
import { draftQuotaCost } from "./quota-display";
import { latestApplied, latestManifest } from "./planning";
import { PlanningDialog } from "./planning-decision";
import type { PlanningRequest } from "./planning-decision";
import type { RecordRequest } from "./record-decision";
import { DraftForm } from "./forms/draft-form";
import { BoloesScreen } from "./screens/boloes";
import { DadosScreen } from "./screens/dados";
import { HistoricoScreen } from "./screens/historico";
import { InicioScreen } from "./screens/inicio";
import { ParticipanteScreen } from "./screens/participante";
import { RevisaoScreen } from "./screens/revisao";
import {
  browserTimeZone,
  errorMessage,
  POOL_STEPS,
  readSnapshot,
  supportedTimeZones,
} from "./app-shared";
import type {
  FormKind,
  GenerationRun,
  PoolStep,
  Screen,
} from "./app-shared";

const RecordDialog = lazy(() =>
  import("./record-decision").then((module) => ({
    default: module.RecordDialog,
  }))
);

const navigation: { id: Screen; label: string; icon: typeof Home }[] = [
  { id: "inicio", label: "Início", icon: Home },
  { id: "boloes", label: "Bolões", icon: Ticket },
  { id: "revisao", label: "Revisão", icon: ListChecks },
  { id: "historico", label: "Histórico", icon: History },
];

function installationId() {
  const existing = localStorage.getItem("little-faith:installation");
  if (existing) return existing;
  const value = crypto.randomUUID();
  localStorage.setItem("little-faith:installation", value);
  return value;
}

function useRoute() {
  const read = () => {
    const [, screen = "inicio", poolId, step] = window.location.hash.split(
      "/",
    );
    return {
      screen: navigation.some((n) => n.id === screen) || screen === "dados"
        ? screen as Screen
        : "inicio" as Screen,
      poolId: poolId ?? null,
      step: POOL_STEPS.find((key) => key === step) ?? null,
    };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const handler = () => setRoute(read());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return {
    ...route,
    navigate: (screen: Screen, poolId?: string, step?: PoolStep) => {
      window.location.hash = `/${screen}${poolId ? `/${poolId}` : ""}${
        poolId && step ? `/${step}` : ""
      }`;
    },
  };
}

/** O token do link pessoal (`#/p/<token>`); só letras, números, - e _, então pontuação colada ao link fica de fora. */
function participantToken() {
  const match = /^#\/p\/([A-Za-z0-9_-]*)/.exec(window.location.hash);
  return match ? match[1]! : null;
}

/** O cartão do participante abre antes de tudo, sem conta e sem a casca; o resto é o app do organizador. */
export function App() {
  const [token, setToken] = useState(participantToken);
  useEffect(() => {
    const handler = () => setToken(participantToken());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return token === null
    ? <OrganizerApp />
    : <ParticipanteScreen key={token} token={token} />;
}

function OrganizerApp() {
  const route = useRoute();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [route.screen, route.poolId]);
  const [mode, setMode] = useState<"demo" | "local" | "account">(() =>
    localStorage.getItem("little-faith:mode") === "local" ? "local" : "demo"
  );
  const [session, setSession] = useState<Session | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [form, setForm] = useState<FormKind | null>(null);
  const [repeatPool, setRepeatPool] = useState(false);
  const [financialRequest, setFinancialRequest] = useState<
    FinancialRequest | null
  >(null);
  const [planningRequest, setPlanningRequest] = useState<
    PlanningRequest | null
  >(null);
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(
    null,
  );
  const [timeZone, setTimeZone] = useState(() => {
    const saved = localStorage.getItem("little-faith:timeZone");
    return saved && supportedTimeZones.includes(saved)
      ? saved
      : browserTimeZone;
  });
  const [notice, setNotice] = useState<
    { text: string; error?: boolean } | null
  >(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);
  const accountId = mode === "account" && session
    ? session.user.id
    : mode === "demo"
    ? "demo"
    : "local-organizer";
  const db = useMemo(
    () => createLocalStore({ installationId: installationId(), accountId }),
    [accountId],
  );
  const isDemo = mode === "demo";

  useEffect(() => {
    let active = true;
    if (isDemo) {
      void seedDemo(db).catch((error) => {
        if (active) setNotice({ text: errorMessage(error), error: true });
      });
    }
    return () => {
      active = false;
    };
  }, [db, isDemo]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) setMode("account");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        setSession(next);
        if (next) setMode("account");
      },
    );
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("little-faith:timeZone", timeZone);
  }, [timeZone]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Dexie only keeps the live-query scope across native awaits when the
  // querier itself is an async function.
  const rawSnapshot = useLiveQuery(
    async () => await readSnapshot(db, groupId),
    [db, groupId],
  );
  // Reactive queries retain their previous value briefly while dependencies change.
  // Render it only in the account/group scope for which it was read.
  const snapshot =
    rawSnapshot?.accountId === accountId && rawSnapshot.groupId === groupId
      ? rawSnapshot
      : undefined;
  const financialView = useMemo(
    () => snapshot?.finances ? createFinancialView(snapshot.finances) : null,
    [snapshot?.finances],
  );
  // Pedidos da divisão do prêmio sem resposta também pedem revisão.
  const settlementPending = useLiveQuery(
    async () =>
      groupId
        ? await db.settlementCommands.where("groupId").equals(groupId)
          .filter((command) =>
            ["prepared", "sending", "unknown"].includes(command.status)
          ).count()
        : 0,
    [db, groupId],
  ) ?? 0;

  useEffect(() => {
    if (!snapshot) return;
    if (!snapshot.groups.some((g) => g.id === groupId)) {
      setGroupId(snapshot.groups[0]?.id ?? null);
    }
  }, [snapshot, groupId]);

  const synchronize = useCallback(async (manual = false) => {
    if (isDemo || !session || mode !== "account") {
      if (manual) {
        setNotice({
          text: isDemo
            ? "A demonstração fica somente neste aparelho. Crie seu grupo para começar."
            : "Entre na sua conta para conectar seus aparelhos.",
        });
      }
      return;
    }
    if (!navigator.onLine) {
      if (manual) {
        setNotice({
          text: "Você está offline. Seu trabalho está salvo neste aparelho.",
        });
      }
      return;
    }
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await sync(db, createAccountTransport(db.accountId));
      if (manual) {
        setNotice({
          text: result.conflicts || result.rejected
            ? "Algumas alterações precisam de revisão. Seus rascunhos foram preservados."
            : "Sincronização concluída. Propostas continuam aguardando confirmação.",
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      setSyncError(message);
      if (manual) setNotice({ text: message, error: true });
    } finally {
      setSyncing(false);
    }
  }, [db, isDemo, session, mode]);

  useEffect(() => {
    if (mode !== "account" || !online || !session) return;
    const timeout = setTimeout(() => {
      void synchronize();
    }, 1_200);
    return () => clearTimeout(timeout);
  }, [mode, online, session, db, snapshot?.summary.pending, synchronize]);

  useEffect(() => {
    if (mode !== "account") return;
    const resume = () => {
      if (document.visibilityState === "visible") void synchronize();
    };
    document.addEventListener("visibilitychange", resume);
    const timer = setInterval(resume, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      clearInterval(timer);
    };
  }, [mode, synchronize]);

  const group = snapshot?.groups.find((g) => g.id === groupId);
  const financeEnabled = mode === "account" && !!session && !!supabase &&
    online;
  const financeAvailability = isDemo
    ? "Os recebimentos de exemplo ficam na demonstração. Crie seu grupo e entre na conta para confirmar pagamentos reais."
    : !online
    ? "Você está offline. Anote os pagamentos neste aparelho e conecte-se para confirmá-los."
    : !supabase
    ? "A conta compartilhada ainda não foi ligada neste app. O que você anota fica salvo aqui; confirmar de verdade precisa dela."
    : "Entre na sua conta e sincronize o grupo para confirmar pagamentos e cotas.";
  const pool = snapshot?.pools.find((p) => p.id === route.poolId) ??
    snapshot?.pools[0];
  const poolBets = snapshot?.bets.filter((b) => b.data.poolId === pool?.id) ??
    [];
  const poolQuotas =
    snapshot?.quotas.filter((q) => q.data.poolId === pool?.id) ?? [];
  const poolProposals =
    snapshot?.proposals.filter((p) =>
      p.data.poolId === pool?.id && p.data.status !== "rejected" &&
      !snapshot.finances?.payments.some((payment) =>
        payment.sourceProposalId === p.id
      )
    ) ?? [];
  const payments = snapshot?.confirmed.filter((p) => p.poolId === pool?.id) ??
    [];
  const financeTotals = financialView?.finance;
  const confirmedCents = isDemo
    ? sumCents(payments.map((p) => p.amountCents))
    : financeTotals?.pools[pool?.id ?? ""]?.allocatedCents ?? "0";
  const proposedCents = sumCents(poolProposals.map((p) => p.data.amountCents));
  const manifest = latestManifest(snapshot?.planning, pool?.id ?? "");
  const registration = snapshot?.registrations.filter((item) =>
    item.poolId === pool?.id
  ).sort((a, b) => b.version - a.version)[0];
  const registeredManifest = registration
    ? snapshot?.planning?.manifests.find((item) =>
      item.id === registration.manifestId
    )
    : null;
  const appliedPlan = registration
    ? snapshot?.planning?.appliedPlans.find((item) =>
      item.id === registeredManifest?.appliedPlanId
    ) ?? null
    : latestApplied(snapshot?.planning, pool?.id ?? "");
  const draftGamesCost = sumCents(
    poolBets.map((b) => betCost(b.data.lotteryId, b.data.numbers)),
  );
  const gamesCost = registeredManifest?.content.plan.betCostCents ??
    appliedPlan?.plan.betCostCents ?? draftGamesCost;
  const dueAmounts = poolQuotas.map((q) =>
    draftQuotaCost(pool?.data.quotaPriceCents ?? "0", q.data.units)
  );
  const expectedCents = dueAmounts.some((due) => due === null)
    ? null
    : sumCents(dueAmounts as string[]);
  const pendingReview =
    snapshot?.proposals.filter((p) =>
      p.data.status !== "rejected" &&
      !snapshot.finances?.payments.some((payment) =>
        payment.sourceProposalId === p.id
      )
    ) ?? [];
  const reviewCount = pendingReview.length +
    (snapshot?.decisions.filter((decision) =>
      ["prepared", "sending", "unknown"].includes(decision.status)
    ).length ?? 0) + (snapshot?.summary.conflicts ?? 0) + settlementPending;

  function switchMode(next: "demo" | "local" | "account") {
    setMode(next);
    if (next !== "account") localStorage.setItem("little-faith:mode", next);
    setGroupId(null);
    setFinancialRequest(null);
    setPlanningRequest(null);
    setRecordRequest(null);
    setSyncError(null);
    route.navigate("inicio");
  }

  useEffect(() => {
    setFinancialRequest(null);
    setPlanningRequest(null);
    setRecordRequest(null);
  }, [db, groupId]);

  function openForm(kind: FormKind, repeat = false) {
    setRepeatPool(repeat && kind === "pool");
    if (!group && kind !== "group") {
      setForm("group");
      return;
    }
    setForm(kind);
  }

  async function save<K extends EntityKind>(
    kind: K,
    data: EntityDataMap[K],
    id?: string,
  ) {
    const nextId = id ?? crypto.randomUUID();
    const nextGroup = kind === "group" ? nextId : groupId;
    if (!nextGroup) throw new Error("Crie ou selecione um grupo primeiro.");
    const record = await saveLocalDraft(db, {
      id: nextId,
      groupId: nextGroup,
      kind,
      data,
    });
    if (kind === "group") setGroupId(nextGroup);
    setNotice({
      text: "Salvo neste aparelho. Você pode continuar mesmo offline.",
    });
    return record;
  }

  async function saveGenerated(run: GenerationRun, generated: number[][]) {
    if (!groupId) throw new Error("Selecione um grupo primeiro.");
    await db.transaction(
      "rw",
      db.records,
      db.operations,
      db.metadata,
      db.poolManifests,
      async () => {
        if (await db.poolManifests.where("poolId").equals(run.poolId).count()) {
          throw new Error(
            "Este bolão foi travado e não aceita novos jogos em rascunho.",
          );
        }
        const sourcePool = await db.records.get(run.poolId);
        if (
          !sourcePool || sourcePool.kind !== "pool" ||
          (sourcePool.data as EntityDataMap["pool"]).status !== "draft"
        ) throw new Error("Este bolão não aceita novos jogos em rascunho.");
        const current = (await listRecords(db, "bet", groupId)).filter((bet) =>
          bet.data.poolId === run.poolId
        );
        const signatures = new Set(
          current.map((bet) =>
            betSignature(bet.data.lotteryId, bet.data.numbers)
          ),
        );
        if (current.length + generated.length > 1_000) {
          throw new Error(
            "O limite de 1.000 jogos foi atingido. Revise o lote.",
          );
        }
        for (const numbers of generated) {
          const signature = betSignature(run.lotteryId, numbers);
          if (signatures.has(signature)) {
            throw new Error(
              "Outro jogo foi adicionado durante a geração. Gere novamente para evitar duplicatas.",
            );
          }
          signatures.add(signature);
          await saveDraft(db, {
            groupId,
            kind: "bet",
            data: {
              poolId: run.poolId,
              lotteryId: run.lotteryId,
              numbers,
              authorIds: [],
              catalogVersion: LOTTERIES[run.lotteryId].catalogVersion,
              seed: run.seed,
              generationAlgorithmVersion: GENERATION_ALGORITHM_VERSION,
            },
          });
        }
        await db.metadata.put({
          key: `generation:${crypto.randomUUID()}`,
          value: {
            ...run,
            numbers: generated,
            algorithmVersion: GENERATION_ALGORITHM_VERSION,
            catalogVersion: LOTTERIES[run.lotteryId].catalogVersion,
            createdAt: new Date().toISOString(),
          },
        });
      },
    );
    setNotice({
      text:
        `${generated.length} jogos salvos neste aparelho. Semente e parâmetros de reprodução preservados.`,
    });
  }

  const primaryAction = (
    <Button
      small
      icon={<Plus aria-hidden="true" />}
      onClick={() => openForm(group ? "pool" : "group")}
    >
      {group ? "Novo bolão" : "Criar grupo"}
    </Button>
  );
  const pendingLabel = `${reviewCount} ${
    reviewCount === 1 ? "pendência" : "pendências"
  }`;
  const peopleCount = snapshot?.persons.length ?? 0;
  const peopleLine = `${peopleCount} ${
    peopleCount === 1 ? "pessoa" : "pessoas"
  }`;
  const profileName = isDemo
    ? "Organizador exemplo"
    : session?.user.user_metadata.name as string || "Seu espaço";

  return (
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <aside className="sidebar">
          <a
            className="brand"
            href="#/inicio"
            aria-label="Little Faith — início"
          >
            <BrandMark />
            <span>
              little <em>faith</em>
            </span>
            <span className="brand-sub">Seu bolão em boa companhia</span>
          </a>
          {group
            ? (
              <label className="group-switch">
                <span className="group-switch-av" aria-hidden="true">
                  {initials(group.data.name)}
                </span>
                <span className="group-switch-name">
                  <b>{group.data.name}</b>
                  <small>{peopleLine}</small>
                </span>
                <ChevronDown aria-hidden="true" />
                <select
                  aria-label="Grupo atual"
                  value={group.id}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    route.navigate("inicio");
                  }}
                >
                  {snapshot?.groups.map((g) => (
                    <option value={g.id} key={g.id}>{g.data.name}</option>
                  ))}
                </select>
              </label>
            )
            : (
              <Button
                variant="ghost"
                small
                icon={<Plus aria-hidden="true" />}
                onClick={() => openForm("group")}
              >
                Criar um grupo
              </Button>
            )}
          <nav aria-label="Navegação principal">
            {navigation.map(({ id, label, icon: Icon }) => (
              <a
                href={`#/${id}`}
                className={`nav-item ${route.screen === id ? "active" : ""}`}
                key={id}
                aria-current={route.screen === id ? "page" : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
                {id === "revisao" && reviewCount > 0 && (
                  <span className="nav-badge" aria-label={pendingLabel}>
                    {reviewCount}
                  </span>
                )}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <Sparkles aria-hidden="true" />
              <strong>Um pouco de fé.</strong>
              <p>Um cuidado de cada vez.</p>
              {isDemo && (
                <Button
                  variant="ghost"
                  small
                  onClick={() => {
                    switchMode("local");
                    setForm("group");
                  }}
                >
                  Começar meu grupo
                </Button>
              )}
            </div>
            <a
              className={`nav-item ${route.screen === "dados" ? "active" : ""}`}
              href="#/dados"
              aria-current={route.screen === "dados" ? "page" : undefined}
            >
              <Settings2 aria-hidden="true" />Dados e integrações
            </a>
            <div className="profile">
              <span className="ui-av" aria-hidden="true">
                {initials(profileName)}
              </span>
              <div>
                <strong>{profileName}</strong>
                <span>
                  {isDemo
                    ? "Modo demonstração"
                    : session
                    ? "Conta conectada"
                    : "Salvo neste aparelho"}
                </span>
              </div>
            </div>
          </div>
        </aside>

        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <span className="mobile-brand">
                <BrandMark />
                <span>
                  little <em>faith</em>
                </span>
              </span>
              <span className="desktop-crumb">
                {group?.data.name ?? "Seu espaço"}{" "}
                <ChevronRight aria-hidden="true" />
                <strong>
                  {route.screen === "dados"
                    ? "Dados e integrações"
                    : navigation.find((n) => n.id === route.screen)?.label}
                </strong>
              </span>
            </div>
            <div className="topbar-actions">
              <button
                type="button"
                className={`connection-pill ${
                  !online ? "offline" : isDemo || mode === "local" ? "local" : ""
                }`}
                onClick={() => route.navigate("dados")}
              >
                {!online
                  ? <WifiOff aria-hidden="true" />
                  : isDemo || mode === "local"
                  ? <CloudOff aria-hidden="true" />
                  : <Cloud aria-hidden="true" />}
                <span>
                  {!online
                    ? "Você está offline"
                    : isDemo
                    ? "Demonstração"
                    : mode === "local"
                    ? "Salvo no aparelho"
                    : syncing
                    ? "Sincronizando…"
                    : "Conectado"}
                </span>
              </button>
              <button
                type="button"
                className="icon-button notification"
                aria-label={reviewCount > 0
                  ? `Ver pendências de revisão: ${pendingLabel}`
                  : "Ver pendências de revisão"}
                onClick={() => route.navigate("revisao")}
              >
                <Bell aria-hidden="true" />
                {reviewCount > 0 && <i aria-hidden="true" />}
              </button>
            </div>
          </header>
          {group && (
            <div className="mobile-context">
              <label className="group-switch">
                <span className="group-switch-av" aria-hidden="true">
                  {initials(group.data.name)}
                </span>
                <span className="group-switch-name">
                  <b>{group.data.name}</b>
                </span>
                <ChevronDown aria-hidden="true" />
                <select
                  aria-label="Grupo atual no celular"
                  value={group.id}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    route.navigate("inicio");
                  }}
                >
                  {snapshot?.groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.data.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {!online && (
            <div className="offline-banner" role="status">
              <WifiOff aria-hidden="true" />
              <span>
                Você pode preparar jogos, que ficam salvos neste aparelho.
                Confirmações precisam de conexão.
              </span>
            </div>
          )}
          <main id="main-content" className="content">
            {!snapshot
              ? (
                <div className="loading">
                  <LoaderCircle className="spin" aria-hidden="true" />Abrindo seus dados…
                </div>
              )
              : (
                <>
                  {route.screen === "inicio" && (
                    <InicioScreen
                      db={db}
                      snapshot={snapshot}
                      group={group}
                      financialView={financialView}
                      route={route}
                      isDemo={isDemo}
                      reviewCount={reviewCount}
                      timeZone={timeZone}
                      openForm={openForm}
                      setForm={setForm}
                    />
                  )}

                  {route.screen === "boloes" && (
                    <BoloesScreen
                      db={db}
                      snapshot={snapshot}
                      group={group}
                      groupId={groupId}
                      pool={pool}
                      poolBets={poolBets}
                      poolQuotas={poolQuotas}
                      financialView={financialView}
                      manifest={manifest}
                      appliedPlan={appliedPlan}
                      route={route}
                      isDemo={isDemo}
                      financeEnabled={financeEnabled}
                      financeAvailability={financeAvailability}
                      timeZone={timeZone}
                      confirmedCents={confirmedCents}
                      expectedCents={expectedCents}
                      gamesCost={gamesCost}
                      draftGamesCost={draftGamesCost}
                      proposedCents={proposedCents}
                      primaryAction={primaryAction}
                      openForm={openForm}
                      setPlanningRequest={setPlanningRequest}
                      setRecordRequest={setRecordRequest}
                      setNotice={setNotice}
                    />
                  )}

                  {route.screen === "revisao" && (
                    <RevisaoScreen
                      db={db}
                      snapshot={snapshot}
                      group={group}
                      groupId={groupId}
                      isDemo={isDemo}
                      reviewCount={reviewCount}
                      pendingReview={pendingReview}
                      financeEnabled={financeEnabled}
                      financeAvailability={financeAvailability}
                      timeZone={timeZone}
                      save={save}
                      setFinancialRequest={setFinancialRequest}
                      setPlanningRequest={setPlanningRequest}
                      setRecordRequest={setRecordRequest}
                      setNotice={setNotice}
                    />
                  )}

                  {route.screen === "historico" && (
                    <HistoricoScreen
                      db={db}
                      groupId={groupId}
                      snapshot={snapshot}
                      group={group}
                      financialView={financialView}
                      isDemo={isDemo}
                    />
                  )}

                  {route.screen === "dados" && (
                    <DadosScreen
                      db={db}
                      snapshot={snapshot}
                      group={group}
                      session={session}
                      mode={mode}
                      online={online}
                      isDemo={isDemo}
                      syncing={syncing}
                      syncError={syncError}
                      storageUsage={storageUsage}
                      persistent={persistent}
                      timeZone={timeZone}
                      synchronize={synchronize}
                      switchMode={switchMode}
                      openForm={openForm}
                      setForm={setForm}
                      setNotice={setNotice}
                      setStorageUsage={setStorageUsage}
                      setPersistent={setPersistent}
                      setSession={setSession}
                      setTimeZone={setTimeZone}
                    />
                  )}
                </>
              )}
            {isDemo && (
              <div className="demo-banner">
                <Sparkles aria-hidden="true" />
                <span>Um gostinho do app: estes são dados de exemplo.</span>
                <Button
                  variant="ghost"
                  small
                  onClick={() => {
                    switchMode("local");
                    setForm("group");
                  }}
                >
                  Criar meu grupo
                </Button>
              </div>
            )}
          </main>
        </div>

        <nav className="bottom-nav" aria-label="Navegação no celular">
          {navigation.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#/${id}`}
              className={route.screen === id ? "active" : ""}
              aria-current={route.screen === id ? "page" : undefined}
            >
              <span className="bottom-nav-icon">
                <Icon aria-hidden="true" />
                {id === "revisao" && reviewCount > 0 && (
                  <span className="nav-badge" aria-label={pendingLabel}>
                    {reviewCount}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </a>
          ))}
        </nav>
        {notice && (
          <div
            className={`toast ${notice.error ? "error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            {notice.error
              ? <AlertTriangle aria-hidden="true" />
              : <Check aria-hidden="true" />}
            <span>{notice.text}</span>
            <button
              type="button"
              aria-label="Dispensar aviso"
              onClick={() => setNotice(null)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}
        {form && (
          <DraftForm
            kind={form}
            group={group}
            pool={pool}
            repeatOf={form === "pool" && repeatPool ? pool : undefined}
            persons={snapshot?.persons ?? []}
            quotas={poolQuotas}
            bets={poolBets}
            onClose={() => {
              setForm(null);
              setRepeatPool(false);
            }}
            financeEnabled={financeEnabled}
            onReviewPayment={(id) =>
              setFinancialRequest({ type: "payment_confirm", proposalId: id })}
            save={save}
            saveGenerated={saveGenerated}
            onPoolCreated={(id) => route.navigate("boloes", id, "montar")}
          />
        )}
        {financialRequest && groupId && (
          <FinancialDialog
            key={`${db.name}:${groupId}`}
            request={financialRequest}
            db={db}
            groupId={groupId}
            enabled={financeEnabled}
            availability={financeAvailability}
            onClose={() => setFinancialRequest(null)}
            onNotice={setNotice}
          />
        )}
        {planningRequest && groupId && (
          <PlanningDialog
            key={`planning:${db.name}:${groupId}`}
            request={planningRequest}
            db={db}
            groupId={groupId}
            enabled={financeEnabled}
            availability={financeAvailability}
            onClose={() => setPlanningRequest(null)}
            onNotice={setNotice}
          />
        )}
        {recordRequest && groupId && (
          <Suspense fallback={<p className="inline-note">Abrindo revisão…</p>}>
            <RecordDialog
              key={`records:${db.name}:${groupId}`}
              db={db}
              groupId={groupId}
              request={recordRequest}
              timeZone={timeZone}
              enabled={financeEnabled}
              availability={financeAvailability}
              onClose={() =>
                setRecordRequest(null)}
              onNotice={setNotice}
            />
          </Suspense>
        )}
      </div>
    </MotionConfig>
  );
}
