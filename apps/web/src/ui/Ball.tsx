import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";

export type BallFinish = "silver" | "gold" | "ring";
export type BallSize = "md" | "sm";

/** Uma bola de metal: prata nos jogos, ouro nos sorteados e acertos premiados, anel nos acertos sem prêmio. */
export function Ball(
  { number, size = "md", finish = "silver", reveal, index = 0 }: {
    number: number;
    size?: BallSize;
    finish?: BallFinish;
    /** "drop" para os sorteados caindo um a um; "pop" para acertos dos jogos. */
    reveal?: "drop" | "pop" | undefined;
    index?: number;
  },
) {
  const reduced = useReducedMotion();
  const className = `ui-ball ${size === "sm" ? "sm" : ""} ${
    finish === "silver" ? "" : finish
  }`.replace(/\s+/g, " ").trim();
  const label = String(number).padStart(2, "0");
  if (!reveal || reduced) return <span className={className}>{label}</span>;
  return (
    <motion.span
      className={className}
      initial={reveal === "drop" ? { y: -24, opacity: 0 } : { scale: .6 }}
      animate={reveal === "drop" ? { y: 0, opacity: 1 } : { scale: 1 }}
      transition={{
        delay: index * (reveal === "drop" ? .18 : .06),
        type: "spring",
        stiffness: 420,
        damping: reveal === "drop" ? 18 : 14,
      }}
    >
      {label}
    </motion.span>
  );
}

/** Uma fileira de bolas (5–6 por linha; 15 números viram 5×3), com o nome acima quando não cabe ao lado. */
export function Balls(
  { numbers, hits, winner = false, size = "md", name, reveal }: {
    numbers: number[];
    hits?: Set<number>;
    winner?: boolean;
    size?: BallSize;
    name?: string;
    reveal?: "drop" | "pop";
  },
) {
  const cols = numbers.length <= 6
    ? numbers.length
    : numbers.length % 5 === 0
    ? 5
    : 6;
  const row = (
    <span
      className={`ui-balls ${numbers.length > 6 ? "grid" : ""} ${
        size === "sm" ? "sm" : ""
      }`}
      style={numbers.length > 6
        ? { "--cols": cols } as CSSProperties
        : undefined}
    >
      {numbers.map((n, i) => {
        const hit = hits?.has(n) ?? false;
        return (
          <Ball
            key={n}
            number={n}
            size={size}
            finish={hit ? winner ? "gold" : "ring" : "silver"}
            reveal={reveal === "pop" && !hit ? undefined : reveal}
            index={i}
          />
        );
      })}
    </span>
  );
  if (!name) return row;
  return (
    <div className="ui-game">
      <span className="ui-game-name">{name}</span>
      {row}
    </div>
  );
}
