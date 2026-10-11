import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import type { LotteryId } from "@bolao/core";

export interface StepItem<K extends string> {
  key: K;
  label: string;
}

/** Etapas do bolão como chips tocáveis; a atual na cor da modalidade, as feitas com ✓ apagado. */
export function StepStrip<K extends string>(
  { steps, current, done, modality, onSelect, label = "Etapas do bolão" }: {
    steps: StepItem<K>[];
    current: K;
    done: Set<K>;
    modality: LotteryId;
    onSelect: (key: K) => void;
    label?: string;
  },
) {
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const ol = list.current;
    if (!ol) return;
    // Esmaecer só do lado em que ainda há etapas escondidas.
    // A faixa tem folga de 16 px nas pontas (ui.css): enquanto só a folga está escondida, nenhuma
    // etapa está cortada e não há esmaecido.
    const fades = () => {
      const max = ol.scrollWidth - ol.clientWidth;
      const edge = Number.parseFloat(getComputedStyle(ol).paddingLeft) || 0;
      ol.style.setProperty(
        "--fl",
        ol.scrollLeft > edge + 2 ? "44px" : "0px",
      );
      ol.style.setProperty(
        "--fr",
        ol.scrollLeft < max - edge - 2 ? "44px" : "0px",
      );
    };
    // A etapa atual fica inteira à vista, com folga para o esmaecido.
    const align = () => {
      const now = ol.querySelector<HTMLElement>(".now")?.parentElement;
      if (now) {
        const want = now.offsetLeft + now.offsetWidth + 52 - ol.clientWidth;
        ol.scrollLeft = Math.max(
          0,
          Math.min(want, ol.scrollWidth - ol.clientWidth),
        );
      }
      fades();
    };
    align();
    ol.addEventListener("scroll", fades, { passive: true });
    // A largura muda quando a tela muda e quando a letra Sora termina de carregar.
    const observer = new ResizeObserver(align);
    observer.observe(ol);
    const now = ol.querySelector(".now");
    if (now) observer.observe(now);
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) align();
    });
    return () => {
      alive = false;
      ol.removeEventListener("scroll", fades);
      observer.disconnect();
    };
  }, [current]);

  return (
    <nav className={`ui-steps mod-${modality}`} aria-label={label}>
      <ol ref={list}>
        {steps.map((step) => {
          const isNow = step.key === current;
          const isDone = !isNow && done.has(step.key);
          return (
            <li key={step.key}>
              <button
                type="button"
                className={`ui-step ${isNow ? "now" : isDone ? "done" : ""}`}
                aria-current={isNow ? "step" : undefined}
                onClick={() => onSelect(step.key)}
              >
                {isDone && <Check aria-hidden="true" />}
                {step.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
