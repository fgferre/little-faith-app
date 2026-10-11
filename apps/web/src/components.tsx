import { useEffect, useId, useRef } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  CloudOff,
  Ticket,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LocalRecord, LocalState, LotteryId } from "@bolao/core";
import { betCost, formatBRL, LOTTERIES, sumCents } from "@bolao/core";

export function Clover(
  { className = "", decorative = true }: {
    className?: string;
    decorative?: boolean;
  },
) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden={decorative}
    >
      <path
        d="M24 24C7 19 8 4 18 9c3-12 19-7 12 6 14-8 22 6 11 12 9 9-3 20-13 10-9 13-24 2-15-9C1 29 2 13 17 19z"
        fill="currentColor"
      />
      <path
        d="M24 23c-2 9 0 14 6 20"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LotteryBadge({ lotteryId }: { lotteryId: LotteryId }) {
  return (
    <span className={`lottery-badge ${lotteryId}`}>
      <span className="lottery-dot" />
      {LOTTERIES[lotteryId].label}
    </span>
  );
}

export function StateBadge({ state }: { state: LocalState }) {
  const labels = {
    local: "Salvo neste aparelho",
    queued: "Aguardando sincronização",
    synced: "Sincronizado",
    conflict: "Precisa de revisão",
  };
  const icons = {
    local: <CloudOff size={13} />,
    queued: <Clock3 size={13} />,
    synced: <Check size={13} />,
    conflict: <AlertTriangle size={13} />,
  };
  return (
    <span className={`state-badge ${state}`}>
      {icons[state]}
      {labels[state]}
    </span>
  );
}

export function Numbers(
  { numbers, lotteryId, small = false }: {
    numbers: number[];
    lotteryId: LotteryId;
    small?: boolean;
  },
) {
  return (
    <div
      className={`number-row ${lotteryId} ${small ? "small" : ""}`}
      aria-label={`Dezenas: ${numbers.join(", ")}`}
    >
      {numbers.map((n) => (
        <span className="number-ball" key={n}>
          {String(n).padStart(2, "0")}
        </span>
      ))}
    </div>
  );
}

export function Avatar(
  { name, index = 0, small = false }: {
    name: string;
    index?: number;
    small?: boolean;
  },
) {
  const initials = name.split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2)
    .join("");
  return (
    <span
      className={`avatar color-${index % 5} ${small ? "small" : ""}`}
      aria-label={name}
    >
      {initials}
    </span>
  );
}

export function EmptyState(
  { icon, title, description, action }: {
    icon: ReactNode;
    title: string;
    description: string;
    action?: ReactNode;
  },
) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function SectionTitle(
  { title, subtitle, action }: {
    title: string;
    subtitle?: string;
    action?: ReactNode;
  },
) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function TextLink(
  { children, onClick }: { children: ReactNode; onClick: () => void },
) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}

export function Modal(
  { title, description, children, onClose }: {
    title: string;
    description?: string;
    children: ReactNode;
    onClose: () => void;
  },
) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(
      'input:not([type="checkbox"]), textarea, select',
    )?.focus();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <span className="eyebrow">VAMOS ORGANIZAR</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button className="icon-button" aria-label="Fechar" onClick={onClose}>
          <X size={21} />
        </button>
      </div>
      {description && <p className="modal-description">{description}</p>}
      {children}
    </dialog>
  );
}

export function Stat(
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

export function Step(
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

export function PoolCard(
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
