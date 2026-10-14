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
    const place = (settle: boolean) => {
      const item = box.querySelector<HTMLElement>(target);
      if (!item || box.clientHeight === 0) {
        delete mark.dataset.ready;
        return;
      }
      const outer = box.getBoundingClientRect();
      const inner = item.getBoundingClientRect();
      const top = inner.top - outer.top - box.clientTop + box.scrollTop;
      const left = inner.left - outer.left - box.clientLeft + box.scrollLeft;
      const bottom = box.clientHeight - top - inner.height;
      const right = box.clientWidth - left - inner.width;
      let moved = false;
      if (mark.dataset.ready) {
        const dy = top - parseFloat(mark.style.top);
        const dx = left - parseFloat(mark.style.left);
        // Abaixo de 1px é ruído de arredondamento (o estilo guarda três casas), não viagem.
        moved = [dy, dx, bottom - parseFloat(mark.style.bottom), right - parseFloat(mark.style.right)]
          .some((d) => Math.abs(d) >= 1);
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
          mark.dataset.dir = Math.abs(dy) >= Math.abs(dx)
            ? (dy > 0 ? "down" : "up")
            : (dx > 0 ? "right" : "left");
        }
      }
      const snap = settle && moved;
      if (snap) mark.style.transition = "none";
      mark.style.top = `${top}px`;
      mark.style.bottom = `${bottom}px`;
      mark.style.left = `${left}px`;
      mark.style.right = `${right}px`;
      mark.dataset.ready = "1";
      if (snap) {
        void mark.offsetHeight;
        mark.style.transition = "";
      }
    };
    place(false);
    // O item ativo sai do lugar quando o menu muda de tamanho com a tela, quando a letra termina de carregar
    // e quando algo acima dele muda de altura ou entra e sai (o cartão do grupo chega depois dos dados).
    const resized = new ResizeObserver(() => place(true));
    const watch = () => {
      resized.disconnect();
      resized.observe(box);
      for (const child of box.children) {
        if (child !== mark) resized.observe(child);
      }
    };
    watch();
    const swapped = new MutationObserver(watch);
    swapped.observe(box, { childList: true });
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) place(true);
    });
    return () => {
      alive = false;
      resized.disconnect();
      swapped.disconnect();
    };
  }, [box, indicator, target, activeKey]);
  return setBox;
}
