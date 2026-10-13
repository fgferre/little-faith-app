import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, CloudOff, X } from "lucide-react";
import { usePresence } from "motion/react";
import type { ReactNode, RefObject } from "react";
import type { LocalState, LotteryId } from "@bolao/core";
import { Button } from "./ui";

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

/**
 * Saída com movimento das gavetas (`dialog.ui-sheet`): dentro de um AnimatePresence, põe `data-closing`
 * na janela (ui.css a faz descer ou sumir) e só deixa o React tirá-la da tela quando a animação termina.
 * Devolve se a janela ainda está presente; fora de um AnimatePresence, sempre true.
 */
export function useSheetPresence(ref: RefObject<HTMLDialogElement | null>) {
  const [isPresent, safeToRemove] = usePresence();
  useEffect(() => {
    if (isPresent) return;
    const dialog = ref.current;
    // Já fechada ou com movimento reduzido, não há animação a esperar.
    if (!dialog?.open || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      safeToRemove?.();
      return;
    }
    dialog.dataset.closing = "";
    const stop = new AbortController();
    const finish = () => {
      stop.abort();
      safeToRemove?.();
    };
    // Plano B: se a animação não rodar, a janela sai do mesmo jeito.
    const timer = setTimeout(finish, 300);
    dialog.addEventListener("animationend", (event) => {
      // Só a saída da própria janela; o fundo escuro e os filhos também disparam o evento.
      if (event.target !== dialog || event.pseudoElement) return;
      clearTimeout(timer);
      finish();
    }, { signal: stop.signal });
    return () => {
      clearTimeout(timer);
      stop.abort();
      delete dialog.dataset.closing;
    };
  }, [ref, isPresent, safeToRemove]);
  return isPresent;
}

/**
 * Gaveta de baixo no celular e janela no meio no computador, como o formulário da direção visual.
 * Esc ou um toque fora perguntam "Sair sem salvar?" quando algo já foi preenchido.
 */
export function Modal(
  { title, description, dirty = false, children, onClose }: {
    title: string;
    description?: string;
    /** Algo foi escolhido fora dos campos (dezenas, modalidade) e ainda não foi salvo. */
    dirty?: boolean;
    children: ReactNode;
    onClose: () => void;
  },
) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState(false);
  const [asking, setAsking] = useState(false);
  const isPresent = useSheetPresence(ref);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
    )?.focus();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  const leave = () => {
    if (!isPresent) return;
    if (asking) setAsking(false);
    else if (dirty || typed) setAsking(true);
    else onClose();
  };
  return (
    <dialog
      ref={ref}
      className="ui-sheet modal"
      aria-labelledby={titleId}
      onChange={() => setTyped(true)}
      onCancel={(event) => {
        event.preventDefault();
        leave();
      }}
      onClick={(event) => {
        if (event.target === ref.current) leave();
      }}
    >
      <div className="ui-sheet-body">
        <div className="ui-sheet-handle" aria-hidden="true" />
        <header className="ui-sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="ui-sheet-x"
            aria-label="Fechar"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {description && <p className="ui-sec modal-description">{description}</p>}
        {children}
        {asking && (
          <div className="modal-leave" role="group" aria-label="Sair sem salvar?">
            <strong>Sair sem salvar?</strong>
            <p className="ui-sec">O que você preencheu aqui será perdido.</p>
            <Button onClick={onClose}>Sair sem salvar</Button>
            <Button variant="ghost" autoFocus onClick={() => setAsking(false)}>
              Continuar preenchendo
            </Button>
          </div>
        )}
      </div>
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
