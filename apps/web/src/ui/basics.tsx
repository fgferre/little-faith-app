import { useEffect, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { useReducedMotion } from "motion/react";
import { Check, ChevronDown, CircleAlert, Clock3 } from "lucide-react";
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

/** Topo de uma tela: rótulo pequeno, título de 28, uma linha opcional e a ação principal ao lado. */
export function PageHead(
  { eyebrow, title, line, action }: {
    eyebrow: string;
    title: string;
    line?: ReactNode;
    action?: ReactNode;
  },
) {
  return (
    <div className="ui-page-head">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="ui-title">{title}</h1>
        {line && <p className="ui-sec">{line}</p>}
      </div>
      {action}
    </div>
  );
}

/** Campo de dinheiro com "R$" na frente; o rótulo continua sendo o <label> em volta. */
export function MoneyInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="ui-input">
      <span className="ui-input-pre" aria-hidden="true">R$</span>
      <input inputMode="decimal" {...props} />
    </span>
  );
}

/**
 * Uma pendência da Revisão: a família (Pagamento, Plano…), de quem ou de qual bolão, o valor,
 * o estado (âmbar "A conferir" ou vermelho) e as ações, com "Conferir" como a principal.
 */
export function ReviewItem(
  { family, title, line, cents, status = "pending", state, children }: {
    family: string;
    title: string;
    line?: ReactNode;
    cents?: string | undefined;
    status?: "pending" | "problem";
    state: string;
    children?: ReactNode;
  },
) {
  return (
    <Card className="ui-review" label={`${family}: ${title}`}>
      <div className="ui-review-head">
        <Chip family>{family}</Chip>
        <Chip status={status}>{state}</Chip>
      </div>
      <div className="ui-review-main">
        <b>{title}</b>
        {cents !== undefined && <Money small cents={cents} />}
      </div>
      {line && <p className="ui-sec">{line}</p>}
      {children && <div className="ui-review-actions">{children}</div>}
    </Card>
  );
}

export type ChipStatus = "confirmed" | "pending" | "problem";

/**
 * Selo de modalidade (com ponto), da etapa atual (`step`, sem ponto), de família (`family`, neutro) ou de
 * estado: confirmado = ✓ menta só texto; pendência = âmbar tracejado com relógio; problema = vermelho.
 */
export function Chip(
  { modality, step = false, family = false, status, children }: {
    modality?: LotteryId;
    step?: boolean;
    family?: boolean;
    status?: ChipStatus;
    children: ReactNode;
  },
) {
  if (family) return <span className="ui-chip family">{children}</span>;
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

/** Centavos subindo de zero até o valor em 1,2 s, depois da espera (conta em bigint; o último quadro é o valor exato). */
function useCountUp(cents: string | undefined, enabled: boolean, delay: number) {
  const reduced = useReducedMotion();
  const animate = enabled && !reduced && cents !== undefined;
  const [shown, setShown] = useState(animate ? "0" : cents);
  useEffect(() => {
    if (!animate || cents === undefined) return;
    const target = BigInt(cents);
    const start = performance.now() + delay;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / 1200));
      const eased = BigInt(Math.round((1 - (1 - t) ** 3) * 1000));
      setShown(t >= 1 ? cents : (target * eased / 1000n).toString());
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cents, animate, delay]);
  return animate ? shown : cents;
}

/**
 * Dinheiro grande (44, tabular) ou prêmio (48, ouro com brilho, o único efeito herói da tela);
 * `countUp` faz o valor contar até o total quando aparece (desligado com movimento reduzido).
 */
export function Money(
  {
    cents,
    prize = false,
    small = false,
    countUp = false,
    delay = 0,
    suffix,
    children,
  }: {
    cents?: string;
    prize?: boolean;
    /** Valor de uma linha (20 px), como o de cada pendência. */
    small?: boolean;
    countUp?: boolean;
    /** Espera antes de contar, em ms (as bolas sorteadas caem primeiro). */
    delay?: number;
    suffix?: ReactNode;
    children?: ReactNode;
  },
) {
  const shown = useCountUp(cents, countUp, delay);
  return (
    <span
      className={["ui-money", prize && "prize", small && "sm"].filter(Boolean)
        .join(" ")}
    >
      {shown !== undefined ? formatBRL(shown) : children}
      {suffix && <small>{suffix}</small>}
    </span>
  );
}

export type AvatarStatus = "neutral" | "paid" | "owe" | "problem";

export function initials(name: string) {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.slice(0, 2).toUpperCase() || "?";
}

/**
 * Iniciais em fila; quem deve tem anel âmbar tracejado, problema anel vermelho, pago fundo menta.
 * Quando não cabem, os tranquilos viram "+N" e quem deve continua à vista.
 */
export function Avatars(
  { people, max = 5 }: {
    people: { id: string; name: string; status?: AvatarStatus }[];
    max?: number;
  },
) {
  const urgent = people.filter((p) =>
    p.status === "owe" || p.status === "problem"
  );
  const calm = people.filter((p) => !urgent.includes(p));
  const keep = max - 1 - urgent.length;
  const [before, after] = people.length <= max
    ? [people, []]
    : keep >= 0
    ? [calm.slice(0, keep), urgent]
    : [people.slice(0, max - 1), []];
  const extra = people.length - before.length - after.length;
  const face = (person: (typeof people)[number]) => (
    <span
      key={person.id}
      className={`ui-av ${person.status ?? "neutral"}`}
      title={person.name}
      aria-hidden="true"
    >
      {initials(person.name)}
    </span>
  );
  return (
    <span className="ui-avatars">
      {before.map(face)}
      {extra > 0 && (
        <span className="ui-av more" aria-hidden="true">+{extra}</span>
      )}
      {after.map(face)}
    </span>
  );
}

/** Barra de arrecadação: menta chapada no confirmado e âmbar listrado no que está em conferência. */
export function Bar(
  { done, pending = 0, label }: {
    /** Frações de 0 a 1. */
    done: number;
    pending?: number;
    label: string;
  },
) {
  const pct = (value: number) => `${Math.max(0, Math.min(1, value)) * 100}%`;
  return (
    <div className="ui-bar" role="img" aria-label={label}>
      <i style={{ width: pct(done) }} />
      {pending > 0 && <s style={{ width: pct(Math.min(pending, 1 - done)) }} />}
    </div>
  );
}

/** Algo que fica guardado até a pessoa pedir: "Ver combinados", "Ver cálculo", "Detalhes técnicos". */
export function Disclosure(
  { summary, className, children }: {
    summary: ReactNode;
    className?: string;
    children: ReactNode;
  },
) {
  return (
    <details className={["ui-more", className].filter(Boolean).join(" ")}>
      <summary>
        {summary}
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="ui-more-body">{children}</div>
    </details>
  );
}
