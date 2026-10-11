import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, CircleAlert, Clock3 } from "lucide-react";
import { formatBRL } from "@bolao/core";
import type { LotteryId } from "@bolao/core";

/** Principal chapado (#5b43d6) ou secundário só com borda; sempre com 44 px ou mais. */
export function Button(
  { variant = "primary", small = false, icon, className, children, ...rest }:
    & ButtonHTMLAttributes<HTMLButtonElement>
    & { variant?: "primary" | "ghost"; small?: boolean; icon?: ReactNode },
) {
  return (
    <button
      type="button"
      {...rest}
      className={[
        "ui-btn",
        variant === "ghost" && "ghost",
        small && "sm",
        className,
      ].filter(Boolean).join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}

/** Cartão: branco a 6 % com borda a 10 %; tocável (borda a 14 %) quando recebe onClick. */
export function Card(
  { onClick, label, className, children }: {
    onClick?: () => void;
    label?: string;
    className?: string;
    children: ReactNode;
  },
) {
  const classes = ["ui-card", onClick && "interactive", className].filter(
    Boolean,
  ).join(" ");
  return onClick
    ? (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </button>
    )
    : <section className={classes} aria-label={label}>{children}</section>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="ui-eyebrow">{children}</span>;
}

export type ChipStatus = "confirmed" | "pending" | "problem";

/**
 * Selo de modalidade (com ponto), da etapa atual (`step`, sem ponto) ou de estado:
 * confirmado = ✓ menta só texto; pendência = âmbar tracejado com relógio; problema = vermelho.
 */
export function Chip(
  { modality, step = false, status, children }: {
    modality?: LotteryId;
    step?: boolean;
    status?: ChipStatus;
    children: ReactNode;
  },
) {
  if (status) {
    const Icon = status === "confirmed"
      ? Check
      : status === "pending"
      ? Clock3
      : CircleAlert;
    return (
      <span className={`ui-chip ${status}`}>
        <Icon aria-hidden="true" />
        {children}
      </span>
    );
  }
  return (
    <span
      className={`ui-chip ${step ? "" : "dot"} ${
        modality ? `mod-${modality}` : ""
      }`}
    >
      {children}
    </span>
  );
}

/** Caixa tingida de vermelho com alerta, para o que precisa de correção. */
export function ProblemBox(
  { title, children }: { title: string; children?: ReactNode },
) {
  return (
    <div className="ui-problem" role="note">
      <CircleAlert aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

/** Dinheiro grande (44, tabular) ou prêmio (48, ouro com brilho, o único efeito herói da tela). */
export function Money(
  { cents, prize = false, suffix, children }: {
    cents?: string;
    prize?: boolean;
    suffix?: ReactNode;
    children?: ReactNode;
  },
) {
  return (
    <span className={`ui-money ${prize ? "prize" : ""}`}>
      {cents !== undefined ? formatBRL(cents) : children}
      {suffix && <small>{suffix}</small>}
    </span>
  );
}

export type AvatarStatus = "neutral" | "paid" | "owe" | "problem";

export function initials(name: string) {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.slice(0, 2).toUpperCase() || "?";
}

/** Iniciais em fila; quem deve tem anel âmbar tracejado, problema anel vermelho, pago fundo menta. */
export function Avatars(
  { people, max = 5 }: {
    people: { id: string; name: string; status?: AvatarStatus }[];
    max?: number;
  },
) {
  const shown = people.length > max ? people.slice(0, max - 1) : people;
  const extra = people.length - shown.length;
  return (
    <span className="ui-avatars">
      {shown.map((person) => (
        <span
          key={person.id}
          className={`ui-av ${person.status ?? "neutral"}`}
          title={person.name}
          aria-hidden="true"
        >
          {initials(person.name)}
        </span>
      ))}
      {extra > 0 && (
        <span className="ui-av more" aria-hidden="true">+{extra}</span>
      )}
    </span>
  );
}
