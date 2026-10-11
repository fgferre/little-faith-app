import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { motion, MotionConfig } from "motion/react";
import type { Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock3,
  Cloud,
  CloudOff,
  Dices,
  Download,
  FolderHeart,
  Heart,
  History,
  Home,
  ListChecks,
  LoaderCircle,
  LogIn,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Ticket,
  Users,
  Wallet,
  WifiOff,
  X,
} from "lucide-react";
import {
  betCost,
  betSignature,
  createFinancialView,
  formatBRL,
  formatQuotaUnits,
  GENERATION_ALGORITHM_VERSION,
  LOTTERIES,
  parseBRL,
  quotaCost,
  quotaUnits,
  sumCents,
  validateBet,
} from "@bolao/core";
import type {
  EntityDataMap,
  EntityKind,
  LocalRecord,
  LotteryId,
} from "@bolao/core";
import {
  createLocalStore,
  getFinancialSnapshot,
  getPlanningSnapshot,
  getSyncSummary,
  listRecords,
  resolveConflict,
  saveDraft,
  sync,
} from "@bolao/local";
import {
  Avatar,
  Clover,
  EmptyState,
  LotteryBadge,
  Modal,
  Numbers,
  SectionTitle,
  StateBadge,
  TextLink,
} from "./components";
import { createAccountTransport, loginWithGoogle, supabase } from "./auth";
import { seedDemo } from "./demo";
import { createSeed, generateInWorker } from "./generation";
import { saveLocalDraft } from "./repository";
import {
  FinancialDialog,
  FinancialHistory,
  FinancialPending,
  FinancialReview,
} from "./finance";
import type { FinancialRequest } from "./finance";
import { draftQuotaCost } from "./quota-display";
import {
  latestApplied,
  latestManifest,
  PlanDetails,
  Planner,
} from "./planning";
import { PlanningDialog, PlanningPending } from "./planning-decision";
import type { PlanningRequest } from "./planning-decision";
import type { RecordRequest } from "./record-decision";

const Registration = lazy(() => import("./registration"));
const Results = lazy(() => import("./results"));
const RecordPending = lazy(() =>
  import("./record-decision").then((module) => ({
    default: module.RecordPending,
  }))
);
const RecordDialog = lazy(() =>
  import("./record-decision").then((module) => ({
    default: module.RecordDialog,
  }))
);
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const supportedTimeZones = Array.from(
  new Set([browserTimeZone, "UTC", ...Intl.supportedValuesOf("timeZone")]),
).sort();

type Screen = "inicio" | "boloes" | "revisao" | "historico" | "dados";
type Tab =
  | "resumo"
  | "pessoas"
  | "jogos"
  | "planejar"
  | "registro"
  | "resultado";
type FormKind =
  | "group"
  | "edit-group"
  | "pool"
  | "edit-pool"
  | "person"
  | "quota"
  | "payment"
  | "bet"
  | "generate";
interface GenerationRun {
  poolId: string;
  lotteryId: LotteryId;
  count: number;
  numberCount: number;
  seed: string;
  existing: number[][];
}
const navigation: { id: Screen; label: string; icon: typeof Home }[] = [
  { id: "inicio", label: "Início", icon: Home },
  { id: "boloes", label: "Bolões", icon: Ticket },
  { id: "revisao", label: "Revisão", icon: ListChecks },
  { id: "historico", label: "Histórico", icon: History },
];
const formatDate = (value: string | null, timeZone?: string) =>
  value
    ? new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(value))
    : "Prazo a definir";
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível salvar. Tente novamente.";
const localDateInput = (value: string | null) => {
  if (!value) return "";
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
};

function installationId() {
  const existing = localStorage.getItem("little-faith:installation");
  if (existing) return existing;
  const value = crypto.randomUUID();
  localStorage.setItem("little-faith:installation", value);
  return value;
}

function useRoute() {
  const read = () => {
    const [, screen = "inicio", poolId] = window.location.hash.split("/");
    return {
      screen: navigation.some((n) => n.id === screen) || screen === "dados"
        ? screen as Screen
        : "inicio" as Screen,
      poolId: poolId ?? null,
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
    navigate: (screen: Screen, poolId?: string) => {
      window.location.hash = `/${screen}${poolId ? `/${poolId}` : ""}`;
    },
  };
}

export function App() {
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
  const [tab, setTab] = useState<Tab>("resumo");
  const [notice, setNotice] = useState<
    { text: string; error?: boolean } | null
  >(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [dark, setDark] = useState(() =>
    localStorage.getItem("little-faith:theme") === "dark"
  );
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
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("little-faith:theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    localStorage.setItem("little-faith:timeZone", timeZone);
  }, [timeZone]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const rawSnapshot = useLiveQuery(async () => {
    const [
      groups,
      persons,
      pools,
      quotas,
      bets,
      proposals,
      confirmed,
      summary,
      records,
      finances,
      planning,
      registrations,
      decisions,
    ] = await Promise.all([
      listRecords(db, "group"),
      listRecords(db, "person", groupId ?? undefined),
      listRecords(db, "pool", groupId ?? undefined),
      listRecords(db, "quota", groupId ?? undefined),
      listRecords(db, "bet", groupId ?? undefined),
      listRecords(db, "payment-proposal", groupId ?? undefined),
      db.confirmedPayments.toArray(),
      getSyncSummary(db),
      db.records.toArray(),
      groupId ? getFinancialSnapshot(db, groupId) : Promise.resolve(null),
      groupId ? getPlanningSnapshot(db, groupId) : Promise.resolve(null),
      groupId
        ? db.registrationReports.where("groupId").equals(groupId).toArray()
        : Promise.resolve([]),
      groupId
        ? Promise.all([
          db.financialCommands.where("groupId").equals(groupId).toArray(),
          db.planningCommands.where("groupId").equals(groupId).toArray(),
          db.registrationCommands.where("groupId").equals(groupId).toArray(),
          db.resultCommands.where("groupId").equals(groupId).toArray(),
        ]).then((families) => families.flat())
        : Promise.resolve([]),
    ]);
    return {
      accountId: db.accountId,
      groupId,
      groups,
      persons,
      pools,
      quotas,
      bets,
      proposals,
      confirmed: confirmed.filter((p) => p.groupId === groupId),
      summary,
      records,
      finances,
      planning,
      registrations,
      decisions,
    };
  }, [db, groupId]);
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
    ? "Você está offline. Prepare propostas neste aparelho e conecte-se para confirmar recebimentos e participações."
    : !supabase
    ? "A conexão Supabase ainda não foi configurada. As propostas ficam salvas; confirmações reais precisam do servidor."
    : "Entre na conta e sincronize o grupo para confirmar recebimentos e participações.";
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
    ).length ?? 0) + (snapshot?.summary.conflicts ?? 0);

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

  function openForm(kind: FormKind) {
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
    <button
      className="button primary"
      onClick={() => openForm(group ? "pool" : "group")}
    >
      <Plus size={18} />
      {group ? "Novo bolão" : "Criar grupo"}
    </button>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <aside className="sidebar">
          <a
            className="brand"
            href="#/inicio"
            aria-label="Little Faith — início"
          >
            <span className="brand-icon">
              <Clover />
            </span>
            <span>
              little faith<span className="brand-sub">
                Seu bolão em boa companhia
              </span>
            </span>
          </a>
          <div className="sidebar-group">
            <span className="sidebar-label">SEU GRUPO</span>
            {group
              ? (
                <>
                  <div className="group-avatar">
                    <Users size={20} />
                  </div>
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
                  <ChevronDown size={14} />
                </>
              )
              : (
                <button
                  className="group-create"
                  onClick={() => openForm("group")}
                >
                  <Plus size={17} />Criar um grupo
                </button>
              )}
          </div>
          <nav aria-label="Navegação principal">
            {navigation.map(({ id, label, icon: Icon }) => (
              <a
                href={`#/${id}`}
                className={`nav-item ${route.screen === id ? "active" : ""}`}
                key={id}
                aria-current={route.screen === id ? "page" : undefined}
              >
                <Icon size={21} />
                <span>{label}</span>
                {id === "revisao" && reviewCount > 0 && (
                  <span className="nav-count">{reviewCount}</span>
                )}
                {route.screen === id && <span className="nav-active-dot" />}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <Sparkles size={20} />
              <strong>Sorte boa é compartilhada.</strong>
              <p>O cuidado com o grupo começa por aqui.</p>
              {isDemo && (
                <button
                  onClick={() => {
                    switchMode("local");
                    setForm("group");
                  }}
                >
                  Começar meu grupo <ArrowRight size={15} />
                </button>
              )}
            </div>
            <a
              className={`nav-item ${route.screen === "dados" ? "active" : ""}`}
              href="#/dados"
            >
              <Settings2 size={20} />Dados e integrações
            </a>
            <div className="profile">
              <Avatar
                name={isDemo
                  ? "Organizador exemplo"
                  : session?.user.user_metadata.name as string || "Meu grupo"}
              />
              <div>
                <strong>
                  {isDemo
                    ? "Organizador exemplo"
                    : session?.user.user_metadata.name as string ||
                      "Seu espaço"}
                </strong>
                <span>
                  {isDemo
                    ? "Modo demonstração"
                    : session
                    ? "Conta conectada"
                    : "Rascunhos locais"}
                </span>
              </div>
              <Heart size={15} />
            </div>
          </div>
        </aside>

        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <span className="mobile-brand">
                <Clover />little faith
              </span>
              <span className="desktop-crumb">
                Seu espaço <ChevronRight size={14} />
                <strong>
                  {route.screen === "dados"
                    ? "Dados e integrações"
                    : navigation.find((n) => n.id === route.screen)?.label}
                </strong>
              </span>
            </div>
            <div className="topbar-actions">
              <button
                className={`connection-pill ${!online ? "offline" : ""}`}
                onClick={() => route.navigate("dados")}
              >
                {!online
                  ? <WifiOff size={15} />
                  : isDemo || mode === "local"
                  ? <CloudOff size={15} />
                  : <Cloud size={15} />}
                <span>
                  {!online
                    ? "Você está offline"
                    : isDemo
                    ? "Demonstração local"
                    : mode === "local"
                    ? "Salvo no aparelho"
                    : syncing
                    ? "Sincronizando…"
                    : "Conectado"}
                </span>
                <span className="status-dot" />
              </button>
              <button
                className="icon-button notification"
                aria-label="Ver pendências de revisão"
                onClick={() => route.navigate("revisao")}
              >
                <Bell size={19} />
                {reviewCount > 0 && <i />}
              </button>
            </div>
          </header>
          {isDemo && (
            <div className="demo-banner">
              <Sparkles size={14} />
              <span>Um gostinho do app: estes são dados de exemplo.</span>
              <button
                onClick={() => {
                  switchMode("local");
                  setForm("group");
                }}
              >
                Criar meu grupo <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {group && (
            <div className="mobile-context">
              <Users size={15} />
              <span>Grupo:</span>
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
            </div>
          )}
          {!online && (
            <div className="offline-banner">
              <WifiOff size={16} />Você pode preparar jogos e rascunhos.
              Confirmações precisam de conexão.
            </div>
          )}
          <main id="main-content" className="content">
            {!snapshot
              ? (
                <div className="loading">
                  <LoaderCircle className="spin" />Abrindo seus dados locais…
                </div>
              )
              : (
                <>
                  {route.screen === "inicio" && (
                    <>
                      <div className="page-heading">
                        <div>
                          <span className="eyebrow">SEU CANTINHO DA SORTE</span>
                          <h1>
                            Faça sua fezinha,<br />
                            <span>
                              organize suas apostas<br />e boa sorte!
                            </span>
                          </h1>
                          <p>Seus bolões, sua turma e cada detalhe no lugar.</p>
                        </div>
                        {primaryAction}
                      </div>
                      {!group
                        ? (
                          <EmptyState
                            icon={<FolderHeart size={30} />}
                            title="Sua próxima boa história começa aqui"
                            description="Crie um grupo e prepare seu primeiro bolão. Participantes não precisam criar conta."
                            action={
                              <button
                                className="button primary"
                                onClick={() => setForm("group")}
                              >
                                <Plus size={18} />Criar meu primeiro grupo
                              </button>
                            }
                          />
                        )
                        : (
                          <>
                            <div className="dashboard-grid">
                              <motion.section
                                className="hero-card"
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.3 }}
                              >
                                <div className="hero-copy">
                                  <span className="hero-eyebrow">
                                    <span />JUNTOS NO PRÓXIMO SORTEIO
                                  </span>
                                  <h2>
                                    {pool?.data.title ??
                                      "Vamos fazer um bolão?"}
                                  </h2>
                                  <p>
                                    {pool
                                      ? "A sorte é uma surpresa. A organização não precisa ser."
                                      : "Reúna a turma e comece pelos detalhes."}
                                  </p>
                                  {pool && (
                                    <div className="hero-meta">
                                      <LotteryBadge
                                        lotteryId={pool.data.lotteryId}
                                      />
                                      <span>
                                        <Clock3 size={14} />
                                        {formatDate(
                                          pool.data.deadlineAt,
                                          "America/Sao_Paulo",
                                        )} · Brasília
                                      </span>
                                    </div>
                                  )}
                                  <button
                                    className="hero-button"
                                    onClick={() =>
                                      pool
                                        ? route.navigate("boloes", pool.id)
                                        : openForm("pool")}
                                  >
                                    {pool
                                      ? "Cuidar deste bolão"
                                      : "Preparar primeiro bolão"}
                                    <ArrowRight size={18} />
                                  </button>
                                </div>
                                <div className="hero-art" aria-hidden="true">
                                  <div className="orbit orbit-one" />
                                  <div className="orbit orbit-two" />
                                  <Clover className="hero-clover" />
                                  <span className="floating-ball ball-one">
                                    07
                                  </span>
                                  <span className="floating-ball ball-two">
                                    24
                                  </span>
                                  <span className="floating-ball ball-three">
                                    38
                                  </span>
                                  <span className="star star-one">✦</span>
                                  <span className="star star-two">✧</span>
                                  <span className="art-caption">
                                    VAI QUE É A NOSSA VEZ :)
                                  </span>
                                </div>
                              </motion.section>
                              <section className="attention-card">
                                <div className="card-heading">
                                  <span className="icon-tile amber">
                                    <ClipboardList size={20} />
                                  </span>
                                  <span className="eyebrow">
                                    UM OLHAR COM CARINHO
                                  </span>
                                </div>
                                <h2>O que pede atenção</h2>
                                {reviewCount
                                  ? (
                                    <button
                                      className="attention-line"
                                      onClick={() => route.navigate("revisao")}
                                    >
                                      <span className="attention-count">
                                        {reviewCount}
                                      </span>
                                      <span>
                                        <strong>pendências para revisar</strong>
                                        <small>
                                          Confira antes de confirmar
                                        </small>
                                      </span>
                                      <ChevronRight size={17} />
                                    </button>
                                  )
                                  : (
                                    <div className="all-good">
                                      <CheckCheck size={24} />
                                      <strong>Nenhuma proposta pendente</strong>
                                      <span>
                                        Um bom momento para preparar os jogos.
                                      </span>
                                    </div>
                                  )}
                                <div className="attention-footer">
                                  <ShieldCheck size={16} />
                                  <span>
                                    Confirmar é conferir o recebimento.
                                  </span>
                                </div>
                              </section>
                            </div>
                            {pool && (
                              <>
                                <div className="context-line">
                                  <span>
                                    UM RETRATO DE{" "}
                                    <strong>{pool.data.title}</strong>
                                  </span>
                                  <span>
                                    <span className="tiny-dot" />
                                    {isDemo
                                      ? "Valores demonstrativos"
                                      : "Somente este bolão"}
                                  </span>
                                </div>
                                <div className="stats-grid">
                                  <Stat
                                    icon={<Wallet size={19} />}
                                    color="green"
                                    label="Caixa confirmado"
                                    value={formatBRL(confirmedCents)}
                                    note={isDemo
                                      ? "Recebimentos de exemplo"
                                      : "Apenas recebimentos confirmados"}
                                  />
                                  <Stat
                                    icon={<Clock3 size={19} />}
                                    color="amber"
                                    label="Em revisão"
                                    value={formatBRL(proposedCents)}
                                    note="Separado do dinheiro disponível"
                                  />
                                  <Stat
                                    icon={<Ticket size={19} />}
                                    color="purple"
                                    label="Jogos preparados"
                                    value={String(poolBets.length).padStart(
                                      2,
                                      "0",
                                    )}
                                    note={`${
                                      formatBRL(gamesCost)
                                    } em apostas planejadas`}
                                  />
                                  <Stat
                                    icon={<Users size={19} />}
                                    color="blue"
                                    label="Pessoas com cotas"
                                    value={String(
                                      new Set(
                                        poolQuotas.map((q) => q.data.personId),
                                      ).size,
                                    ).padStart(2, "0")}
                                    note="Direitos ainda em preparação"
                                  />
                                </div>
                              </>
                            )}
                            <div className="lower-grid">
                              <section className="panel pools-panel">
                                <SectionTitle
                                  title="Nossos bolões"
                                  subtitle="Cada concurso, uma nova história."
                                  action={
                                    <TextLink
                                      onClick={() => route.navigate("boloes")}
                                    >
                                      Ver todos
                                    </TextLink>
                                  }
                                />
                                <div className="compact-pools">
                                  {snapshot.pools.slice(0, 3).map((p) => (
                                    <button
                                      className="compact-pool"
                                      key={p.id}
                                      onClick={() =>
                                        route.navigate("boloes", p.id)}
                                    >
                                      <span
                                        className={`pool-icon ${p.data.lotteryId}`}
                                      >
                                        <Clover />
                                      </span>
                                      <span>
                                        <strong>{p.data.title}</strong>
                                        <small>
                                          {LOTTERIES[p.data.lotteryId].label} ·
                                          {" "}
                                          {p.data.contestNumber
                                            ? `Concurso ${p.data.contestNumber}`
                                            : "Concurso a definir"}
                                        </small>
                                      </span>
                                      <span className="draft-pill">
                                        Em preparação
                                      </span>
                                      <ChevronRight size={17} />
                                    </button>
                                  ))}
                                  {!snapshot.pools.length && (
                                    <p className="muted">
                                      Seu grupo está pronto. Agora é só criar um
                                      bolão.
                                    </p>
                                  )}
                                </div>
                              </section>
                              <section className="panel people-panel">
                                <SectionTitle
                                  title="A sorte tem companhia"
                                  subtitle={group.data.name}
                                />
                                <div className="avatar-stack">
                                  {snapshot.persons.slice(0, 6).map((p, i) => (
                                    <Avatar
                                      name={p.data.name}
                                      index={i}
                                      key={p.id}
                                    />
                                  ))}
                                  {snapshot.persons.length > 6 && (
                                    <span className="avatar avatar-extra">
                                      +{snapshot.persons.length - 6}
                                    </span>
                                  )}
                                </div>
                                <p>
                                  {snapshot.persons.length
                                    ? (
                                      <>
                                        <strong>
                                          {snapshot.persons.length} pessoas
                                        </strong>{" "}
                                        já fazem parte da turma.<br />Cada uma
                                        com seu lugar, tudo bem cuidado.
                                      </>
                                    )
                                    : "Adicione as pessoas do grupo. Uma conta no app é opcional."}
                                </p>
                                <TextLink
                                  onClick={() => {
                                    if (pool) {
                                      setTab("pessoas");
                                      route.navigate("boloes", pool.id);
                                    } else openForm("person");
                                  }}
                                >
                                  {snapshot.persons.length
                                    ? "Ver a turma"
                                    : "Adicionar pessoa"}
                                </TextLink>
                              </section>
                            </div>
                          </>
                        )}
                    </>
                  )}

                  {route.screen === "boloes" && (
                    <>
                      <div className="page-heading compact">
                        <div>
                          <span className="eyebrow">SORTE EM GRUPO</span>
                          <h1>
                            {route.poolId && pool
                              ? pool.data.title
                              : "Nossos bolões"}
                          </h1>
                          <p>
                            {route.poolId
                              ? "Da primeira ideia ao último detalhe."
                              : "Organize cada concurso, sem misturar o caixa dos grupos."}
                          </p>
                        </div>
                        {primaryAction}
                      </div>
                      {!route.poolId
                        ? (
                          <div className="pool-grid">
                            {snapshot.pools.map((p) => (
                              <PoolCard
                                key={p.id}
                                pool={p}
                                bets={snapshot.bets.filter((b) =>
                                  b.data.poolId === p.id
                                )}
                                onClick={() => {
                                  setTab("resumo");
                                  route.navigate("boloes", p.id);
                                }}
                              />
                            ))}
                            {!snapshot.pools.length && (
                              <EmptyState
                                icon={<Ticket size={30} />}
                                title="O primeiro bolão da turma"
                                description="Escolha Mega-Sena, Lotofácil ou Quina e comece a preparar."
                                action={primaryAction}
                              />
                            )}
                          </div>
                        )
                        : pool
                        ? (
                          <>
                            <div className="pool-toolbar">
                              <LotteryBadge lotteryId={pool.data.lotteryId} />
                              <span>
                                {pool.data.contestNumber
                                  ? `Concurso ${pool.data.contestNumber}`
                                  : "Concurso a definir"}
                              </span>
                              <StateBadge state={pool.state} />
                              {manifest && (
                                <span className="simple-pill green">
                                  Travado · versão {manifest.version}
                                </span>
                              )}
                              {registration && (
                                <span
                                  className={`simple-pill ${
                                    registration.comparison.status ===
                                        "complete"
                                      ? "green"
                                      : "amber"
                                  }`}
                                >
                                  {registration.comparison.status === "complete"
                                    ? "Registro conferido"
                                    : registration.comparison.status ===
                                        "partial"
                                    ? "Registro parcial"
                                    : "Registro com divergências"}
                                </span>
                              )}
                              <button
                                className="text-link back-link"
                                onClick={() => route.navigate("boloes")}
                              >
                                Todos os bolões <ArrowUpRight size={15} />
                              </button>
                            </div>
                            <div
                              className="tabs"
                              role="tablist"
                              aria-label="Seções do bolão"
                            >
                              {([
                                "resumo",
                                "pessoas",
                                "jogos",
                                "planejar",
                                "registro",
                                "resultado",
                              ] as const).map((t) => (
                                <button
                                  key={t}
                                  role="tab"
                                  aria-selected={tab === t}
                                  className={tab === t ? "selected" : ""}
                                  onClick={() => setTab(t)}
                                >
                                  {({
                                    resumo: "Resumo",
                                    pessoas: "Pessoas e cotas",
                                    jogos: "Jogos",
                                    planejar: "Planejador",
                                    registro: "Registro",
                                    resultado: "Resultado",
                                  })[t]}
                                </button>
                              ))}
                            </div>
                            {tab === "resumo" && (
                              <>
                                <div className="stats-grid">
                                  <Stat
                                    icon={<Wallet size={19} />}
                                    color="green"
                                    label="Confirmado"
                                    value={formatBRL(confirmedCents)}
                                    note="Recebimentos no caixa"
                                  />
                                  <Stat
                                    icon={<Users size={19} />}
                                    color="blue"
                                    label="Cotas preparadas"
                                    value={expectedCents === null
                                      ? "Revisar cotas"
                                      : formatBRL(expectedCents)}
                                    note="Valor devido, sem confirmação"
                                  />
                                  <Stat
                                    icon={<Ticket size={19} />}
                                    color="purple"
                                    label="Custo dos jogos"
                                    value={formatBRL(gamesCost)}
                                    note="Jogos preparados, não registrados"
                                  />
                                  <Stat
                                    icon={<Clock3 size={19} />}
                                    color="amber"
                                    label="Em revisão"
                                    value={formatBRL(proposedCents)}
                                    note="Não aumenta o saldo"
                                  />
                                </div>
                                <div className="lower-grid">
                                  <section className="panel">
                                    <SectionTitle
                                      title="Próximos passos"
                                      subtitle="Uma coisa de cada vez, com cuidado."
                                    />
                                    <div className="steps">
                                      <Step
                                        n="1"
                                        title="Reunir as pessoas"
                                        description={`${snapshot.persons.length} pessoas cadastradas no grupo`}
                                        done={snapshot.persons.length > 0}
                                        action={() => setTab("pessoas")}
                                      />
                                      <Step
                                        n="2"
                                        title="Preparar cotas e pagamentos"
                                        description="Direitos ficam em rascunho até confirmação online"
                                        done={poolQuotas.length > 0}
                                        action={() => openForm("quota")}
                                      />
                                      <Step
                                        n="3"
                                        title="Preparar os jogos"
                                        description={`${
                                          appliedPlan?.plan.bets.length ??
                                            poolBets.length
                                        } jogos · ${formatBRL(gamesCost)}`}
                                        done={!!appliedPlan ||
                                          poolBets.length > 0}
                                        action={() => setTab("jogos")}
                                      />
                                      <Step
                                        n="4"
                                        title="Conferir e travar online"
                                        description={manifest
                                          ? `Manifesto confirmado · versão ${manifest.version}`
                                          : appliedPlan
                                          ? "Plano aplicado; confira os responsáveis e trave o bolão"
                                          : "Compare alternativas e aplique um plano antes da trava"}
                                        done={!!manifest &&
                                          manifest.appliedPlanId ===
                                            appliedPlan?.id}
                                        action={() => setTab("planejar")}
                                      />
                                    </div>
                                  </section>
                                  <section className="panel detail-panel">
                                    <SectionTitle
                                      title="Combinados da turma"
                                      action={
                                        <button
                                          className="button secondary"
                                          disabled={pool.data.status !==
                                            "draft"}
                                          onClick={() => openForm("edit-pool")}
                                        >
                                          Editar bolão
                                        </button>
                                      }
                                    />
                                    <span className="detail-label">
                                      PRAZO INTERNO
                                    </span>
                                    <strong>
                                      {formatDate(
                                        pool.data.deadlineAt,
                                        "America/Sao_Paulo",
                                      )} · Brasília
                                    </strong>
                                    <small>
                                      {formatDate(pool.data.deadlineAt)}{" "}
                                      · seu fuso ({Intl.DateTimeFormat()
                                        .resolvedOptions().timeZone})
                                    </small>
                                    <span className="detail-label">
                                      COTA DE REFERÊNCIA
                                    </span>
                                    <strong>
                                      {formatBRL(pool.data.quotaPriceCents)}
                                    </strong>
                                    <span className="detail-label">
                                      TIPO DE PARTICIPAÇÃO
                                    </span>
                                    <p>
                                      {pool.data.participationMode ===
                                          "undecided"
                                        ? "A definir antes do fechamento"
                                        : pool.data.participationMode ===
                                            "official"
                                        ? appliedPlan
                                          ? "Correspondência de cotas oficiais no plano confirmado"
                                          : "Confira a correspondência de cotas oficiais no planejador"
                                        : "Acordo interno do grupo"}
                                    </p>
                                    <div className="inline-note">
                                      <BookOpen size={17} />
                                      <span>
                                        {group?.data.statute ||
                                          "Nenhum estatuto informado."}
                                      </span>
                                    </div>
                                  </section>
                                </div>
                              </>
                            )}
                            {tab === "pessoas" && (
                              <section className="panel">
                                <SectionTitle
                                  title="Quem faz parte"
                                  subtitle="Autoria dos números e direito ao prêmio são coisas distintas."
                                  action={
                                    <button
                                      className="button primary"
                                      onClick={() => openForm("person")}
                                    >
                                      <Plus size={17} />Adicionar pessoa
                                    </button>
                                  }
                                />
                                <div className="panel-actions">
                                  <button
                                    className="button secondary"
                                    onClick={() => openForm("quota")}
                                  >
                                    Preparar cota
                                  </button>
                                  <button
                                    className="button secondary"
                                    onClick={() => openForm("payment")}
                                  >
                                    Preparar pagamento
                                  </button>
                                </div>
                                {!snapshot.persons.length
                                  ? (
                                    <EmptyState
                                      icon={<Users size={28} />}
                                      title="Vamos reunir a turma"
                                      description="Basta um nome e a declaração de maioridade. Nenhuma conta é necessária."
                                    />
                                  )
                                  : (
                                    <div className="table-wrapper">
                                      <table>
                                        <thead>
                                          <tr>
                                            <th>Pessoa</th>
                                            <th>Cotas preparadas</th>
                                            <th>Valor devido</th>
                                            <th>Recebimento confirmado</th>
                                            <th>Estado</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {snapshot.persons.map((person, i) => {
                                            const units = poolQuotas.filter((
                                              q,
                                            ) => q.data.personId === person.id)
                                              .reduce(
                                                (n, q) => n + q.data.units,
                                                0,
                                              );
                                            const paid = !isDemo
                                              ? financialView
                                                ?.personPoolFunding(
                                                  pool.id,
                                                  person.id,
                                                ) ?? "0"
                                              : sumCents(
                                                payments.filter((p) =>
                                                  p.personId === person.id
                                                ).map((p) => p.amountCents),
                                              );
                                            return (
                                              <tr key={person.id}>
                                                <td>
                                                  <span className="person-cell">
                                                    <Avatar
                                                      name={person.data.name}
                                                      index={i}
                                                      small
                                                    />
                                                    <span>
                                                      <strong>
                                                        {person.data.name}
                                                      </strong>
                                                      <small>
                                                        {person.data
                                                            .adultDeclared
                                                          ? "Maioridade declarada"
                                                          : "Maioridade pendente"}
                                                      </small>
                                                    </span>
                                                  </span>
                                                </td>
                                                <td>
                                                  {formatQuotaUnits(units)}
                                                </td>
                                                <td>
                                                  {draftQuotaCost(
                                                      pool.data.quotaPriceCents,
                                                      units,
                                                    ) === null
                                                    ? "Revisar cota"
                                                    : formatBRL(
                                                      quotaCost(
                                                        pool.data
                                                          .quotaPriceCents,
                                                        units,
                                                      ),
                                                    )}
                                                </td>
                                                <td>{formatBRL(paid)}</td>
                                                <td>
                                                  <span
                                                    className={`simple-pill ${
                                                      BigInt(paid) > 0n
                                                        ? "green"
                                                        : "amber"
                                                    }`}
                                                  >
                                                    {BigInt(paid) > 0n
                                                      ? isDemo
                                                        ? "Exemplo confirmado"
                                                        : "Recebido"
                                                      : "Em preparação"}
                                                  </span>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                              </section>
                            )}
                            {tab === "jogos" && (
                              <section className="panel">
                                <SectionTitle
                                  title="Nossos números"
                                  subtitle={`${poolBets.length} jogos preparados · ${
                                    formatBRL(draftGamesCost)
                                  } em apostas`}
                                  action={
                                    <button
                                      className="button primary"
                                      disabled={!!manifest ||
                                        pool.data.status !== "draft"}
                                      onClick={() => openForm("generate")}
                                    >
                                      <Sparkles size={17} />Gerar jogos
                                    </button>
                                  }
                                />
                                <div className="panel-actions">
                                  <button
                                    className="button secondary"
                                    disabled={!!manifest ||
                                      pool.data.status !== "draft"}
                                    onClick={() => openForm("bet")}
                                  >
                                    <Plus size={16} />Adicionar dezenas
                                  </button>
                                  <span className="muted">
                                    Duplicatas são bloqueadas. Os jogos ainda
                                    não foram registrados.
                                  </span>
                                </div>
                                {appliedPlan && (
                                  <div className="inline-note">
                                    <span>
                                      Plano confirmado:{" "}
                                      {appliedPlan.plan.bets.length} jogos ·
                                      {" "}
                                      {formatBRL(
                                        appliedPlan.plan.betCostCents,
                                      )}. Os jogos adicionais pertencem ao
                                      plano.
                                    </span>
                                  </div>
                                )}
                                {appliedPlan && (
                                  <PlanDetails plan={appliedPlan.plan} />
                                )}
                                {poolBets.length
                                  ? (
                                    <div className="bets-list">
                                      {poolBets.map((b, i) => (
                                        <div className="bet-row" key={b.id}>
                                          <span className="bet-index">
                                            {String(i + 1).padStart(2, "0")}
                                          </span>
                                          <div>
                                            <Numbers
                                              numbers={b.data.numbers}
                                              lotteryId={b.data.lotteryId}
                                              small
                                            />
                                            <small>
                                              {b.data.authorIds.length
                                                ? b.data.authorIds.map((id) =>
                                                  snapshot.persons.find((p) =>
                                                    p.id === id
                                                  )?.data.name.split(" ")[0] ??
                                                    "Pessoa do grupo"
                                                ).join(", ")
                                                : "Gerado para o grupo"}
                                            </small>
                                          </div>
                                          <span className="bet-price">
                                            {formatBRL(
                                              betCost(
                                                b.data.lotteryId,
                                                b.data.numbers,
                                              ),
                                            )}
                                          </span>
                                          <StateBadge state={b.state} />
                                        </div>
                                      ))}
                                    </div>
                                  )
                                  : (
                                    <EmptyState
                                      icon={<Dices size={30} />}
                                      title="Cada jogo começa com uma ideia"
                                      description="Adicione as dezenas da turma ou gere jogos reproduzíveis neste aparelho."
                                    />
                                  )}
                              </section>
                            )}
                            {tab === "planejar" && group && (
                              <Planner
                                key={`${db.name}:${group.id}:${pool.id}`}
                                db={db}
                                group={group}
                                pool={pool}
                                bets={poolBets}
                                quotas={poolQuotas}
                                finances={snapshot.finances}
                                demoPayments={snapshot.confirmed}
                                isDemo={isDemo}
                                enabled={financeEnabled}
                                availability={financeAvailability}
                                open={setPlanningRequest}
                                editPool={() => openForm("edit-pool")}
                                onNotice={setNotice}
                              />
                            )}
                            {tab === "registro" && groupId && (
                              <Suspense
                                fallback={
                                  <p className="inline-note">
                                    Carregando conferência do registro…
                                  </p>
                                }
                              >
                                <Registration
                                  key={`${db.name}:${groupId}:${pool.id}`}
                                  db={db}
                                  groupId={groupId}
                                  pool={pool}
                                  manifest={manifest}
                                  enabled={financeEnabled}
                                  availability={financeAvailability}
                                  open={setRecordRequest}
                                  onNotice={setNotice}
                                  goPlanning={() => setTab("planejar")}
                                />
                              </Suspense>
                            )}
                            {tab === "resultado" && groupId && (
                              <Suspense
                                fallback={
                                  <p className="inline-note">
                                    Carregando conferência do resultado…
                                  </p>
                                }
                              >
                                <Results
                                  key={`${db.name}:${groupId}:${pool.id}`}
                                  db={db}
                                  groupId={groupId}
                                  pool={pool}
                                  enabled={financeEnabled}
                                  availability={financeAvailability}
                                  timeZone={timeZone}
                                  open={setRecordRequest}
                                />
                              </Suspense>
                            )}
                          </>
                        )
                        : (
                          <EmptyState
                            icon={<Ticket size={30} />}
                            title="Bolão não encontrado neste aparelho"
                            description="Sincronize sua conta ou volte à lista de bolões."
                            action={
                              <button
                                className="button primary"
                                onClick={() => route.navigate("boloes")}
                              >
                                Ver bolões
                              </button>
                            }
                          />
                        )}
                    </>
                  )}

                  {route.screen === "revisao" && (
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
                              Seu rascunho foi preservado junto da versão
                              recebida. Escolha qual conteúdo usar como base;
                              reenviar continua sendo uma proposta.
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
                                      text:
                                        "Rascunho preservado para nova sincronização.",
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
                                    {snapshot.pools.find((p) =>
                                      p.id === proposal.data.poolId
                                    )?.data.title} ·{" "}
                                    {formatDate(proposal.createdAt)}
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
                              Nenhum recebimento aguardando revisão. Confira os
                              combinados e participações abaixo.
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
                  )}

                  {route.screen === "historico" && (
                    <>
                      <div className="page-heading compact">
                        <div>
                          <span className="eyebrow">
                            CADA HISTÓRIA BEM GUARDADA
                          </span>
                          <h1>Histórico da turma</h1>
                          <p>
                            Recebimentos confirmados, sempre separados das
                            estimativas.
                          </p>
                        </div>
                      </div>
                      {!isDemo
                        ? (
                          <FinancialHistory
                            snapshot={snapshot.finances}
                            persons={snapshot.persons}
                            pools={snapshot.pools}
                          />
                        )
                        : snapshot.confirmed.length
                        ? (
                          <section className="panel">
                            <SectionTitle
                              title={isDemo
                                ? "Recebimentos demonstrativos"
                                : "Recebimentos confirmados"}
                              subtitle={group?.data.name ?? "Seu grupo"}
                            />
                            <div className="table-wrapper">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Pessoa</th>
                                    <th>Bolão</th>
                                    <th>Recebido</th>
                                    <th>Data</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {snapshot.confirmed.map((p) => (
                                    <tr key={p.id}>
                                      <td>
                                        {snapshot.persons.find((person) =>
                                          person.id === p.personId
                                        )?.data.name}
                                      </td>
                                      <td>
                                        {snapshot.pools.find((pool) =>
                                          pool.id === p.poolId
                                        )?.data.title}
                                      </td>
                                      <td>{formatBRL(p.amountCents)}</td>
                                      <td>{formatDate(p.confirmedAt)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <p className="muted">
                              Resgates, distribuições e relatórios reconciliados
                              entram na etapa de distribuição.
                            </p>
                          </section>
                        )
                        : (
                          <EmptyState
                            icon={<History size={30} />}
                            title="As boas histórias vão ficar aqui"
                            description="Seus rascunhos estão salvos. O histórico financeiro começa com registros confirmados no servidor."
                          />
                        )}
                    </>
                  )}

                  {route.screen === "dados" && (
                    <>
                      <div className="page-heading compact">
                        <div>
                          <span className="eyebrow">
                            SEU TRABALHO BEM CUIDADO
                          </span>
                          <h1>Dados e integrações</h1>
                          <p>
                            Saiba o que está salvo e o que ainda precisa de
                            conexão.
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
                              <ShieldCheck size={15} />Armazenamento persistente
                              autorizado
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
                              ? `Conta conectada: ${
                                session.user.email ?? "organizador"
                              }.`
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
                              Rascunhos locais e demonstração são espaços
                              separados da sua conta. Trocar de espaço preserva
                              o trabalho.
                            </span>
                          </div>
                        </section>
                        <section className="panel">
                          <SectionTitle title="Do seu jeito" />
                          <label className="theme-toggle">
                            <span>
                              <strong>Aparência escura</strong>
                              <small>Uma opção mais suave à noite.</small>
                            </span>
                            <input
                              type="checkbox"
                              checked={dark}
                              onChange={(e) => setDark(e.target.checked)}
                              role="switch"
                            />
                            <span className="switch-track" />
                          </label>
                          <label className="timezone-setting">
                            Fuso para conferir concursos<select
                              value={timeZone}
                              onChange={(event) =>
                                setTimeZone(event.target.value)}
                            >
                              {supportedTimeZones.map((zone) => (
                                <option value={zone} key={zone}>{zone}</option>
                              ))}
                            </select>
                            <small>
                              Os horários dos concursos mostram Brasília e este
                              fuso, com as regras de horário de verão
                              aplicáveis.
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
                              Backup protegido e restauração completa serão
                              implementados na etapa de recuperação. O
                              armazenamento do navegador ainda é a única cópia
                              dos rascunhos locais.
                            </span>
                          </div>
                          <p className="muted">
                            Rascunhos, cálculos, pessoas, jogos e conferência
                            financeira online, planejamento, registro e
                            resultados. Resgate, distribuição, acesso por agente
                            e recuperação completa são as próximas etapas.
                          </p>
                          <div className="build-badge">
                            EM CONSTRUÇÃO · v0.1.0
                          </div>
                        </section>
                      </div>
                    </>
                  )}
                  <footer className="page-footer">
                    <span>
                      <Clover />Um pouco de fé. Um cuidado de cada vez.
                    </span>
                    <span>Feito para compartilhar bons momentos.</span>
                  </footer>
                </>
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
              <Icon size={21} />
              <span>{label}</span>
              {id === "revisao" && reviewCount > 0 && <i />}
            </a>
          ))}
        </nav>
        {notice && (
          <div
            className={`toast ${notice.error ? "error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            {notice.error ? <AlertTriangle size={18} /> : <Check size={18} />}
            <span>{notice.text}</span>
            <button
              aria-label="Dispensar aviso"
              onClick={() => setNotice(null)}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {form && (
          <DraftForm
            kind={form}
            group={group}
            pool={pool}
            persons={snapshot?.persons ?? []}
            quotas={poolQuotas}
            bets={poolBets}
            onClose={() => setForm(null)}
            financeEnabled={financeEnabled}
            onReviewPayment={(id) =>
              setFinancialRequest({ type: "payment_confirm", proposalId: id })}
            save={save}
            saveGenerated={saveGenerated}
            onPoolCreated={(id) => {
              setTab("resumo");
              route.navigate("boloes", id);
            }}
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

function Stat(
  { icon, color, label, value, note }: {
    icon: ReactNode;
    color: string;
    label: string;
    value: string;
    note: string;
  },
) {
  return (
    <section className="stat-card">
      <span className={`icon-tile ${color}`}>{icon}</span>
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </section>
  );
}

function Step(
  { n, title, description, done, action }: {
    n: string;
    title: string;
    description: string;
    done: boolean;
    action?: () => void;
  },
) {
  const content = (
    <>
      <span className={`step-number ${done ? "done" : ""}`}>
        {done ? <Check size={15} /> : n}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {action && <ChevronRight size={16} />}
    </>
  );
  return action
    ? <button className="step" onClick={action}>{content}</button>
    : <div className="step">{content}</div>;
}

function PoolCard(
  { pool, bets, onClick }: {
    pool: LocalRecord<"pool">;
    bets: LocalRecord<"bet">[];
    onClick: () => void;
  },
) {
  return (
    <button className={`pool-card ${pool.data.lotteryId}`} onClick={onClick}>
      <div className="pool-card-top">
        <span className={`pool-icon ${pool.data.lotteryId}`}>
          <Clover />
        </span>
        <span className="draft-pill">Em preparação</span>
      </div>
      <LotteryBadge lotteryId={pool.data.lotteryId} />
      <h2>{pool.data.title}</h2>
      <p>
        {pool.data.contestNumber
          ? `Concurso ${pool.data.contestNumber}`
          : "Concurso a definir"}
      </p>
      <div className="pool-card-stats">
        <span>
          <Ticket size={16} />
          {bets.length} jogos
        </span>
        <strong>
          {formatBRL(
            sumCents(
              bets.map((b) =>
                betCost(b.data.lotteryId, b.data.numbers)
              ),
            ),
          )}
        </strong>
      </div>
      <div className="pool-card-footer">
        <StateBadge state={pool.state} />
        <ArrowRight size={19} />
      </div>
    </button>
  );
}

function DraftForm(
  {
    kind,
    group,
    pool,
    persons,
    quotas,
    bets,
    onClose,
    save,
    saveGenerated,
    onPoolCreated,
    financeEnabled,
    onReviewPayment,
  }: {
    kind: FormKind;
    group: LocalRecord<"group"> | undefined;
    pool: LocalRecord<"pool"> | undefined;
    persons: LocalRecord<"person">[];
    quotas: LocalRecord<"quota">[];
    bets: LocalRecord<"bet">[];
    onClose: () => void;
    onPoolCreated: (id: string) => void;
    financeEnabled: boolean;
    onReviewPayment: (id: string) => void;
    save: <K extends EntityKind>(
      kind: K,
      data: EntityDataMap[K],
      id?: string,
    ) => Promise<LocalRecord<K>>;
    saveGenerated: (run: GenerationRun, generated: number[][]) => Promise<void>;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lotteryId, setLotteryId] = useState<LotteryId>(
    pool?.data.lotteryId ?? "mega-sena",
  );
  const [selected, setSelected] = useState<number[]>([]);
  const [personId, setPersonId] = useState(persons[0]?.id ?? "");
  const entityFormKind = kind === "edit-group"
    ? "group"
    : kind === "edit-pool"
    ? "pool"
    : kind;
  const editing = kind === "edit-group" || kind === "edit-pool";
  const rule = LOTTERIES[lotteryId];
  const titles = {
    group: "Um grupo para chamar de nosso",
    "edit-group": "Editar grupo e combinados",
    pool: "Preparar um novo bolão",
    "edit-pool": "Editar dados do bolão",
    person: "Mais uma pessoa na turma",
    quota: "Preparar participação",
    payment: "Preparar pagamento para revisão",
    bet: "Os números da turma",
    generate: "Deixe os números com a gente",
  };
  const descriptions = {
    group:
      "Os dados serão salvos neste aparelho. Cada grupo tem seu próprio caixa.",
    "edit-group":
      "Alterar o texto salva um rascunho. Publique uma nova versão na revisão para registrar novos aceites.",
    pool: "Defina os detalhes iniciais. O bolão começa como rascunho.",
    "edit-pool":
      "Preço, prazo, modalidade e concurso ficam protegidos quando há participações confirmadas.",
    person:
      "Cadastrar uma pessoa não cria uma conta nem um direito financeiro.",
    quota:
      "Até duas casas decimais. A participação precisa ser confirmada online antes de valer.",
    payment: "Informar um valor não confirma recebimento e não altera o caixa.",
    bet: "Jogos preparados ficam locais. O registro é feito externamente.",
    generate:
      "Geração local, com semente criptográfica e reprodução determinística. Sem promessa de melhorar a chance de um jogo.",
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const fields = new FormData(event.currentTarget);
    const text = (name: string) => String(fields.get(name) ?? "").trim();
    try {
      if (entityFormKind === "group") {
        if (!text("name")) throw new Error("Dê um nome ao grupo.");
        await save(
          "group",
          { name: text("name"), statute: text("statute") },
          editing ? group?.id : undefined,
        );
      } else if (entityFormKind === "pool") {
        const contest = text("contest") ? Number(text("contest")) : null;
        if (
          contest !== null && (!Number.isSafeInteger(contest) || contest < 1)
        ) throw new Error("Informe um concurso inteiro positivo.");
        const deadlineAt = editing &&
            text("deadline") === localDateInput(pool?.data.deadlineAt ?? null)
          ? pool?.data.deadlineAt ?? null
          : text("deadline")
          ? new Date(text("deadline")).toISOString()
          : null;
        const created = await save("pool", {
          title: text("name"),
          lotteryId,
          contestNumber: contest,
          deadlineAt,
          quotaPriceCents: parseBRL(text("price")),
          participationMode: text("mode") as
            | "undecided"
            | "internal"
            | "official",
          status: "draft",
        }, editing ? pool?.id : undefined);
        onPoolCreated(created.id);
      } else if (kind === "person") {
        await save("person", {
          name: text("name"),
          nickname: text("nickname"),
          adultDeclared: fields.get("adult") === "on",
        });
      } else {
        if (!pool) throw new Error("Crie ou selecione um bolão primeiro.");
        if (kind === "quota") {
          if (!personId) throw new Error("Adicione uma pessoa primeiro.");
          const person = persons.find((p) => p.id === personId);
          if (!person?.data.adultDeclared) {
            throw new Error(
              "Registre a declaração de maioridade antes de preparar uma cota.",
            );
          }
          const existing = quotas.find((q) => q.data.personId === personId);
          const units = quotaUnits(text("units"));
          // A draft must never leave the UI with a due amount that cannot be expressed in cents.
          quotaCost(pool.data.quotaPriceCents, units);
          if (!existing && quotas.length >= 200) {
            throw new Error("Este bolão já tem 200 participantes.");
          }
          await save(
            "quota",
            { poolId: pool.id, personId, units },
            existing?.id,
          );
        } else if (kind === "payment") {
          if (!personId) throw new Error("Adicione uma pessoa primeiro.");
          const amountCents = parseBRL(text("amount"));
          if (BigInt(amountCents) <= 0n) {
            throw new Error("O pagamento deve ter valor maior que zero.");
          }
          const proposal = await save("payment-proposal", {
            poolId: pool.id,
            personId,
            amountCents,
            note: text("note"),
            status: "pending",
          });
          if (fields.get("reviewNow") === "on") onReviewPayment(proposal.id);
        } else if (kind === "bet") {
          const numbers = validateBet(lotteryId, selected);
          if (
            bets.some((b) =>
              betSignature(b.data.lotteryId, b.data.numbers) ===
                betSignature(lotteryId, numbers)
            )
          ) {
            throw new Error(
              "Este jogo já está no bolão. A duplicata não foi adicionada.",
            );
          }
          await save("bet", {
            poolId: pool.id,
            lotteryId,
            numbers,
            authorIds: text("author") ? [text("author")] : [],
            catalogVersion: rule.catalogVersion,
            seed: null,
            generationAlgorithmVersion: null,
          });
        } else if (kind === "generate") {
          const count = Number(text("count"));
          const numberCount = Number(text("numberCount"));
          if (
            !Number.isInteger(count) || count < 1 || count + bets.length > 1_000
          ) {
            throw new Error(
              "Prepare entre 1 e 1.000 jogos, respeitando o total do bolão.",
            );
          }
          const seed = createSeed();
          const run = {
            poolId: pool.id,
            lotteryId,
            count,
            numberCount,
            seed,
            existing: bets.map((b) => b.data.numbers),
          };
          const generated = await generateInWorker(run);
          await saveGenerated(run, generated);
        }
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={titles[kind]}
      description={descriptions[kind]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {(entityFormKind === "group" || entityFormKind === "pool" ||
          kind === "person") && (
          <label>
            Nome{entityFormKind === "group"
              ? " do grupo"
              : entityFormKind === "pool"
              ? " do bolão"
              : ""}
            <input
              name="name"
              required
              autoFocus
              maxLength={120}
              defaultValue={editing
                ? entityFormKind === "group"
                  ? group?.data.name
                  : pool?.data.title
                : ""}
              placeholder={entityFormKind === "group"
                ? "Ex.: Amigos de longa data"
                : entityFormKind === "pool"
                ? "Ex.: Mega de sábado"
                : "Como a pessoa se chama?"}
            />
          </label>
        )}
        {entityFormKind === "group" && (
          <label>
            Combinados do grupo<textarea
              name="statute"
              rows={4}
              maxLength={10_000}
              defaultValue={editing
                ? group?.data.statute
                : "Participação válida após pagamento integral confirmado no prazo. Autoria dos números não altera o direito ao prêmio. Sobras permanecem identificadas até destino autorizado."}
            />
          </label>
        )}
        {kind === "person" && (
          <>
            <label>
              Apelido <span className="muted">(opcional)</span>
              <input
                name="nickname"
                maxLength={80}
                placeholder="Como a turma conhece essa pessoa"
              />
            </label>
            <label className="checkbox-label">
              <input name="adult" type="checkbox" required />
              <span>
                Registrei a declaração de que esta pessoa tem 18 anos ou mais.
              </span>
            </label>
          </>
        )}
        {entityFormKind === "pool" && (
          <>
            <label>
              Modalidade<select
                name="lottery"
                value={lotteryId}
                onChange={(e) => setLotteryId(e.target.value as LotteryId)}
              >
                {Object.values(LOTTERIES).map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </label>
            <div className="form-columns">
              <label>
                Concurso <span className="muted">(opcional)</span>
                <input
                  name="contest"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="A definir"
                  defaultValue={editing ? pool?.data.contestNumber ?? "" : ""}
                />
              </label>
              <label>
                Valor por cota (R$)<input
                  name="price"
                  required
                  inputMode="decimal"
                  defaultValue={editing && pool
                    ? formatBRL(pool.data.quotaPriceCents).replace("R$", "")
                      .trim()
                    : "30,00"}
                />
              </label>
            </div>
            <label>
              Prazo interno <span className="muted">(seu fuso local)</span>
              <input
                name="deadline"
                type="datetime-local"
                defaultValue={editing
                  ? localDateInput(pool?.data.deadlineAt ?? null)
                  : ""}
              />
            </label>
            <label>
              Forma de participação<select
                name="mode"
                defaultValue={editing
                  ? pool?.data.participationMode
                  : "undecided"}
              >
                <option value="undecided">Definir antes do fechamento</option>
                <option value="internal">Acordo interno do grupo</option>
                <option value="official">
                  Cotas oficiais — verificar compatibilidade
                </option>
              </select>
            </label>
            <div className="inline-note">
              <Clock3 size={16} />
              <span>
                Este prazo é do grupo. O encerramento das apostas e o sorteio
                precisam de informação oficial por concurso.
              </span>
            </div>
          </>
        )}
        {(kind === "quota" || kind === "payment") && (
          <label>
            Pessoa<select
              name="person"
              required
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              {!persons.length && (
                <option value="">Adicione uma pessoa primeiro</option>
              )}
              {persons.map((p) => (
                <option key={p.id} value={p.id}>{p.data.name}</option>
              ))}
            </select>
          </label>
        )}
        {kind === "quota" && (
          <>
            <label>
              Quantidade de cotas<input
                name="units"
                inputMode="decimal"
                required
                defaultValue={formatQuotaUnits(
                  quotas.find((q) => q.data.personId === personId)?.data
                    .units ?? 100,
                )}
              />
              <small>
                1 cota = 100 unidades. Preparar novamente substitui o rascunho
                desta pessoa.
              </small>
            </label>
            <div className="inline-note">
              <Users size={17} />
              <span>
                Frações internas não são cotas oficiais fracionadas. Pagamento
                parcial não reduz automaticamente a participação.
              </span>
            </div>
          </>
        )}
        {kind === "payment" && (
          <>
            <label>
              Valor informado (R$)<input
                name="amount"
                required
                inputMode="decimal"
                placeholder="0,00"
              />
            </label>
            <label>
              Origem e observações<textarea
                name="note"
                rows={3}
                maxLength={2_000}
                placeholder="Ex.: valor informado na conversa. Ainda falta conferir o recebimento."
              />
            </label>
            <div className="inline-note">
              <ShieldCheck size={17} />
              <span>
                Um comprovante é evidência para conferir. Este valor permanecerá
                fora do saldo confirmado.
              </span>
            </div>
            <label className="checkbox-label">
              <input
                name="reviewNow"
                type="checkbox"
                disabled={!financeEnabled}
              />
              <span>
                Conferir recebimento agora, após sincronizar esta proposta.
              </span>
            </label>
          </>
        )}
        {kind === "bet" && (
          <>
            <div className="number-picker-heading">
              <LotteryBadge lotteryId={lotteryId} />
              <strong>
                {selected.length} de {rule.minNumbers}–{rule.maxNumbers} dezenas
              </strong>
            </div>
            <div className={`number-picker ${lotteryId}`}>
              {Array.from({ length: rule.universeSize }, (_, i) => i + 1).map((
                n,
              ) => (
                <button
                  type="button"
                  aria-pressed={selected.includes(n)}
                  aria-label={`Dezena ${n}`}
                  className={selected.includes(n) ? "chosen" : ""}
                  key={n}
                  onClick={() =>
                    setSelected((values) =>
                      values.includes(n)
                        ? values.filter((v) => v !== n)
                        : values.length < rule.maxNumbers
                        ? [...values, n]
                        : values
                    )}
                >
                  {String(n).padStart(2, "0")}
                </button>
              ))}
            </div>
            <label>
              Autoria{" "}
              <span className="muted">(não altera o direito ao prêmio)</span>
              <select name="author">
                <option value="">Jogo do grupo</option>
                {persons.map((p) => (
                  <option value={p.id} key={p.id}>{p.data.name}</option>
                ))}
              </select>
            </label>
            <div className="cost-preview">
              Custo deste jogo<strong>
                {selected.length >= rule.minNumbers
                  ? formatBRL(betCost(lotteryId, selected))
                  : "Selecione as dezenas"}
              </strong>
            </div>
          </>
        )}
        {kind === "generate" && (
          <>
            <div className="generator-heading">
              <span className={`pool-icon ${lotteryId}`}>
                <Dices size={25} />
              </span>
              <div>
                <strong>{rule.label}</strong>
                <small>Geração determinística em segundo plano</small>
              </div>
            </div>
            <div className="form-columns">
              <label>
                Quantidade de jogos<input
                  name="count"
                  type="number"
                  min="1"
                  max={1_000 - bets.length}
                  defaultValue="5"
                  required
                />
              </label>
              <label>
                Dezenas por jogo<select name="numberCount">
                  {Array.from(
                    { length: rule.maxNumbers - rule.minNumbers + 1 },
                    (_, i) => i + rule.minNumbers,
                  ).map((n) => <option value={n} key={n}>{n} dezenas</option>)}
                </select>
              </label>
            </div>
            <div className="inline-note">
              <Sparkles size={17} />
              <span>
                A semente de 256 bits será guardada com os jogos. Dezenas
                existentes são preservadas e duplicatas são evitadas.
              </span>
            </div>
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy ||
              ((kind === "payment" || kind === "quota") && !persons.length)}
          >
            {busy
              ? <LoaderCircle size={17} className="spin" />
              : <Check size={17} />}
            {busy
              ? "Salvando…"
              : kind === "generate"
              ? "Gerar e salvar jogos"
              : kind === "payment"
              ? "Salvar para revisão"
              : "Salvar rascunho"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
