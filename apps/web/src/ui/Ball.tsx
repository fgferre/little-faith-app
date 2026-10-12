import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Disclosure } from "./basics";
import type { GrupoDeJogos } from "./texto";

export type BallFinish = "silver" | "gold" | "ring" | "wrong";
export type BallSize = "md" | "sm";

/**
 * Uma bola de metal: prata nos jogos, ouro nos sorteados e acertos premiados, anel de ouro nos acertos
 * sem prêmio e anel vermelho no número que diverge do planejado.
 */
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
        delay: index * (reveal === "drop" ? .07 : .05),
        type: "spring",
        stiffness: 420,
        damping: reveal === "drop" ? 18 : 14,
      }}
    >
      {label}
    </motion.span>
  );
}

/**
 * Uma fileira de bolas (até 6; de 7 a 12 em duas linhas; de 13 a 20 em linhas de 5, e 15 vira 5×3),
 * com o nome acima quando não cabe ao lado e, embaixo do nome, um selo ou a contagem de acertos.
 * Sem nome, o selo fica ao lado das bolas. `detail` é uma linha apagada embaixo (o jogo ampliado).
 */
export function Balls(
  { numbers, hits, winner = false, wrong, size = "md", name, note, detail, reveal }: {
    numbers: number[];
    hits?: Set<number> | undefined;
    winner?: boolean;
    /** Números que não batem com o planejado: anel vermelho. */
    wrong?: Set<number>;
    size?: BallSize;
    name?: string;
    note?: ReactNode;
    detail?: string | null | undefined;
    reveal?: "drop" | "pop" | undefined;
  },
) {
  const cols = numbers.length <= 6
    ? numbers.length
    : numbers.length <= 12
    ? Math.ceil(numbers.length / 2)
    : 5;
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
            finish={hit
              ? winner ? "gold" : "ring"
              : wrong?.has(n)
              ? "wrong"
              : "silver"}
            reveal={reveal === "pop" && !hit ? undefined : reveal}
            index={i}
          />
        );
      })}
    </span>
  );
  const below = detail && <span className="ui-game-detail">{detail}</span>;
  if (!name) {
    if (!note && !below) return row;
    return (
      <div className="ui-game">
        {row}
        {note && <span className="ui-game-side">{note}</span>}
        {below}
      </div>
    );
  }
  return (
    <div className="ui-game">
      <span className="ui-game-name">
        {name}
        {note && <span className="ui-game-note">{note}</span>}
      </span>
      {row}
      {below}
    </div>
  );
}

/**
 * Jogos agrupados por quem escolheu: o cabeçalho ("Rafael · 4 jogos") e as fileiras de cada um.
 * Passados de `shown` jogos, o resto fica em "Ver mais"; o grupo que continua lá repete o cabeçalho.
 */
export function GameGroups<T>(
  { groups, row, shown = 6 }: {
    groups: GrupoDeJogos<T>[];
    /** A fileira de um jogo: um <li className="pool-game"> com a chave do jogo. */
    row: (game: T) => ReactNode;
    shown?: number;
  },
) {
  const flat = groups.flatMap((group, index) =>
    group.games.map((game) => ({ game, index, label: group.label }))
  );
  const list = (items: typeof flat) =>
    items.map((item, i) => (
      <Fragment key={i}>
        {item.index !== items[i - 1]?.index && (
          <li className="ui-game-head">{item.label}</li>
        )}
        {row(item.game)}
      </Fragment>
    ));
  const rest = flat.length - shown;
  return (
    <>
      <ul className="pool-games">{list(flat.slice(0, shown))}</ul>
      {rest > 0 && (
        <Disclosure summary={`Ver mais ${rest} ${rest === 1 ? "jogo" : "jogos"}`}>
          <ul className="pool-games">{list(flat.slice(shown))}</ul>
        </Disclosure>
      )}
    </>
  );
}
