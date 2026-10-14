import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import type { LotteryId } from "@bolao/core";
import { useSlidingIndicator } from "./useSlidingIndicator";

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
  // A primeira centralização é seca (a faixa já abre no lugar); as seguintes deslizam.
  const centered = useRef(false);
  // O fundo da etapa atual é uma peça só que desliza até a etapa escolhida, como no menu.
  // A chave inclui as etapas feitas: o ✓ alarga o chip no celular e a peça precisa acompanhar.
  const setBox = useSlidingIndicator(
    ".nav-indicator",
    '.ui-step[aria-current="step"]',
    `${current}|${steps.filter((step) => done.has(step.key)).map((step) => step.key).join()}`,
  );

  useEffect(() => {
    const ol = list.current;
    if (!ol) return;
    // Esmaecer só do lado em que ainda há etapas escondidas.
    // A faixa tem nas pontas a folga da margem da página (ui.css): enquanto só a folga está escondida,
    // nenhuma etapa está cortada e não há esmaecido.
    const fades = () => {
      const max = ol.scrollWidth - ol.clientWidth;
      const edge = Number.parseFloat(getComputedStyle(ol).paddingLeft) || 0;
      ol.style.setProperty(
        "--fl",
        ol.scrollLeft > edge + 2 ? "40px" : "0px",
      );
      ol.style.setProperty(
        "--fr",
        ol.scrollLeft < max - edge - 2 ? "40px" : "0px",
      );
    };
    // A etapa atual fica no meio da faixa quando ela rola; se todas cabem, nada rola.
    // Rola só a faixa, nunca a página; o marcador vai junto sozinho.
    const align = () => {
      const now = ol.querySelector<HTMLElement>(".now")?.parentElement;
      const max = ol.scrollWidth - ol.clientWidth;
      if (now && max > 0) {
        const slide = centered.current
          && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        ol.scrollTo({
          left: Math.max(
            0,
            Math.min(now.offsetLeft + (now.offsetWidth - ol.clientWidth) / 2, max),
          ),
          behavior: slide ? "smooth" : "auto",
        });
        centered.current = true;
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
      <ol
        ref={(el) => {
          list.current = el;
          setBox(el);
        }}
      >
        <li className="nav-indicator" aria-hidden="true" />
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
