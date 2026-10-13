import { useLayoutEffect, useState } from "react";

/**
 * Faz um marcador deslizar até o item ativo de um menu (a faixa do menu lateral, a pílula da barra do celular).
 * Devolve o ref do contêiner; dentro dele ficam o marcador (`indicator`, posicionado em absoluto) e os itens.
 * O marcador recebe top/bottom/left/right em px e `data-dir` com o sentido da viagem: o CSS atrasa a borda
 * de trás e a faixa estica no caminho e volta ao tamanho ao chegar. Sem item ativo ou com o menu escondido
 * (`display: none`), o marcador fica sem `data-ready` e invisível.
 */
export function useSlidingIndicator(
  indicator: string,
  target: string,
  activeKey: string,
) {
  const [box, setBox] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const mark = box?.querySelector<HTMLElement>(indicator);
    if (!box || !mark) return;
    const place = () => {
      const item = box.querySelector<HTMLElement>(target);
      if (!item || box.clientHeight === 0) {
        delete mark.dataset.ready;
        return;
      }
      const outer = box.getBoundingClientRect();
      const inner = item.getBoundingClientRect();
      const top = inner.top - outer.top - box.clientTop + box.scrollTop;
      const left = inner.left - outer.left - box.clientLeft + box.scrollLeft;
      if (mark.dataset.ready) {
        const dy = top - parseFloat(mark.style.top);
        const dx = left - parseFloat(mark.style.left);
        // Abaixo de 1px é ruído de arredondamento (o estilo guarda três casas), não viagem.
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
          mark.dataset.dir = Math.abs(dy) >= Math.abs(dx)
            ? (dy > 0 ? "down" : "up")
            : (dx > 0 ? "right" : "left");
        }
      }
      mark.style.top = `${top}px`;
      mark.style.bottom = `${box.clientHeight - top - inner.height}px`;
      mark.style.left = `${left}px`;
      mark.style.right = `${box.clientWidth - left - inner.width}px`;
      mark.dataset.ready = "1";
    };
    place();
    // O menu muda de tamanho com a tela e quando a letra termina de carregar.
    const observer = new ResizeObserver(place);
    observer.observe(box);
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) place();
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [box, indicator, target, activeKey]);
  return setBox;
}
