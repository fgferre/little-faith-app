import { useId } from "react";

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

/** A marca do app: o laço da turma. O tamanho vem do font-size do contêiner. */
export function BrandMark({ className }: { className?: string }) {
  // um id por cópia: a marca aparece duas vezes (barra lateral e topo do celular) e uma delas fica
  // escondida; um degradê definido dentro da cópia escondida não pinta a outra
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <span
      className={["ui-brandmark", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          {LACO.petals.map((petal) => (
            <linearGradient key={petal.name} id={`${id}-${petal.name}`} x1="0" y1="0" x2="1" y2="1">
              {petal.stops.map(([offset, color]) => (
                <stop key={offset} offset={offset} stopColor={color} />
              ))}
            </linearGradient>
          ))}
          <radialGradient id={`${id}-no`} cx=".35" cy=".3" r=".8">
            {LACO.knot.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </radialGradient>
        </defs>
        <g transform="rotate(45 50 50)">
          {LACO.petals.map((petal, i) => (
            <g key={petal.name} transform={`rotate(${i * 90} 50 50)`}>
              <path
                d={LACO.petal}
                fill={`url(#${id}-${petal.name})`}
                stroke={LACO.rim}
                strokeOpacity=".55"
                strokeWidth="1.2"
              />
              <path d={LACO.shine} fill="#fff" fillOpacity={petal.shine} />
            </g>
          ))}
        </g>
        <circle cx="50" cy="50" r="5.5" fill={`url(#${id}-no)`} />
      </svg>
    </span>
  );
}
