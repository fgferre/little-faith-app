import { useEffect, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  MouseEvent,
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
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="ui-title">{title}</h1>
      {action}
      {line && <p className="ui-sec">{line}</p>}
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

/**
 * Centavos contando depois da espera, em bigint (o último quadro é o valor exato): `countUp` sobe de zero
 * até o valor em 0,8 s; `follow` aparece direto e, quando o valor muda, conta do último mostrado até o novo em 0,6 s.
 */
function useCountUp(
  cents: string | undefined,
  countUp: boolean,
  follow: boolean,
  delay: number,
) {
  const reduced = useReducedMotion();
  const animate = (countUp || follow) && !reduced && cents !== undefined;
  const [shown, setShown] = useState(countUp && animate ? "0" : cents);
  const last = useRef(cents);
  useEffect(() => {
    if (cents === undefined) return;
    if (!animate) {
      last.current = cents;
      return;
    }
    const from = countUp ? 0n : BigInt(last.current ?? cents);
    const target = BigInt(cents);
    const span = from === target ? 0 : countUp ? 800 : 600;
    const start = performance.now() + delay;
    let frame = 0;
    const tick = (now: number) => {
      const t = span ? Math.min(1, Math.max(0, (now - start) / span)) : 1;
      const eased = BigInt(Math.round((1 - (1 - t) ** 3) * 1000));
      last.current = t >= 1 ? cents : (from + (target - from) * eased / 1000n).toString();
      setShown(last.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cents, animate, countUp, delay]);
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
    follow = false,
    delay = 0,
    format = formatBRL,
    suffix,
    children,
  }: {
    cents?: string;
    prize?: boolean;
    /** Valor de uma linha (20 px), como o de cada pendência. */
    small?: boolean;
    countUp?: boolean;
    /** Quando `cents` muda com a tela aberta, conta do valor anterior até o novo. */
    follow?: boolean;
    /** Espera antes de contar, em ms (as bolas sorteadas caem primeiro). */
    delay?: number;
    /** Como escrever os centavos (`reais` tira o ",00"). */
    format?: (cents: string) => string;
    suffix?: ReactNode;
    children?: ReactNode;
  },
) {
  const shown = useCountUp(cents, countUp, follow, delay);
  return (
    <span
      className={[
        "ui-money",
        prize && "prize",
        small && "sm",
        prize && countUp && "ui-money-celebra",
      ].filter(Boolean).join(" ")}
      style={prize && countUp
        ? { "--celebra-delay": `${delay + 800}ms` } as CSSProperties
        : undefined}
    >
      {shown !== undefined ? format(shown) : children}
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

/** Altura, respiros, margens e opacidade do corpo agora (no meio de uma animação, o quadro em curso). */
function bodyFrame(el: HTMLElement): Keyframe {
  const style = getComputedStyle(el);
  return {
    height: style.height,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    opacity: style.opacity,
  };
}
const SHUT: Keyframe = {
  height: "0px",
  paddingTop: "0px",
  paddingBottom: "0px",
  marginTop: "0px",
  marginBottom: "0px",
  opacity: 0,
};

/**
 * `onClick` do `summary` de um `<details>`: o corpo (o elemento logo depois do summary) desdobra ao abrir
 * e recolhe ao fechar; com movimento reduzido, abre e fecha seco. O atributo `open` nativo continua mandando.
 */
export function unfoldDetails(event: MouseEvent<HTMLElement>) {
  const details = event.currentTarget.parentElement;
  const content = event.currentTarget.nextElementSibling;
  if (
    !(details instanceof HTMLDetailsElement) || !(content instanceof HTMLElement)
    || matchMedia("(prefers-reduced-motion: reduce)").matches
  ) return;
  event.preventDefault();
  // clicar no meio da animação inverte o rumo a partir do quadro em curso
  const running = content.getAnimations().find((a) => a.id === "abrir" || a.id === "fechar");
  const open = running ? running.id === "fechar" : !details.open;
  content.style.overflow = "hidden";
  const from = details.open ? bodyFrame(content) : SHUT;
  running?.cancel();
  details.open = true;
  const to = open ? bodyFrame(content) : SHUT;
  const animation = content.animate(
    [from, to],
    open
      ? { id: "abrir", duration: 220, easing: "cubic-bezier(.2, .8, .2, 1)" }
      : { id: "fechar", duration: 180, easing: "ease-in" },
  );
  animation.onfinish = () => {
    content.style.overflow = "";
    if (!open) details.open = false;
  };
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
      <summary onClick={unfoldDetails}>
        {summary}
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="ui-more-body">{children}</div>
    </details>
  );
}
