import laco120 from "../assets/laco-3d-120.png";
import laco240 from "../assets/laco-3d-240.png";

type Stops = readonly (readonly [number, string])[];

/**
 * O laço da turma (public/laco.svg), numa caixa de 100: quatro pétalas em 45°, 135°, 225° e 315° em
 * volta de (50, 50) e o nó de ouro no centro. O cartão (cartao.ts) desenha o mesmo laço daqui.
 */
export const LACO = {
  petal: "M50 54 C44 46 33 39 33 25 A17 17 0 1 1 67 25 C67 39 56 46 50 54 Z",
  shine: "M46 24 C44 17 50 11 56 13 C52 14 48 18 46 24 Z",
  rim: "#f6dfa9",
  /** No sentido do relógio a partir da primeira pétala; o degradê vai do canto de cima à esquerda ao de baixo à direita. */
  petals: [
    { name: "ouro", shine: .55, stops: [[0, "#fff3cf"], [.45, "#e9c47c"], [1, "#9d6f2a"]] },
    { name: "lav", shine: .55, stops: [[0, "#f4eeff"], [.5, "#c9b7f2"], [1, "#8369cf"]] },
    { name: "ame", shine: .45, stops: [[0, "#cfa3ff"], [.5, "#7f3bd1"], [1, "#36126a"]] },
    { name: "lav2", shine: .55, stops: [[0, "#e6dbff"], [.5, "#b39ce8"], [1, "#6a51ba"]] },
  ] as readonly { name: string; shine: number; stops: Stops }[],
  /** O nó: raio 5,5 no centro, degradê radial de ouro com o brilho em cima à esquerda. */
  knot: [[0, "#fff6dc"], [.4, "#eac77e"], [1, "#8f6425"]] as Stops,
};

/** A marca do app: o laço da turma em 3D (o vetor LACO segue no favicon, nos ícones e no cartão). O tamanho vem do font-size do contêiner. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={["ui-brandmark", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <img
        src={laco120}
        srcSet={`${laco120} 1x, ${laco240} 2x`}
        width={40}
        height={40}
        alt=""
        decoding="async"
      />
    </span>
  );
}
