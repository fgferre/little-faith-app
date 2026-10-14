import { ChevronRight } from "lucide-react";
import { formatBRL, LOTTERIES } from "@bolao/core";
import { STEP_LABEL } from "../screens/bolao-etapas";
import type { PoolView } from "../screens/bolao-etapas";
import { Card, Chip } from "./basics";
import { formatWhen } from "./Countdown";

/**
 * O cartão de um bolão, o mesmo na Início e em Bolões: a bola da modalidade (quantas dezenas leva
 * um jogo simples), nome, linha, modalidade, etapa (ou "Encerrado") e a seta.
 */
export function PoolRow(
  { view, ended, timeZone, onClick }: {
    view: PoolView;
    ended: boolean;
    timeZone: string;
    onClick: () => void;
  },
) {
  const now = Date.now();
  const { pool } = view;
  const lottery = LOTTERIES[pool.data.lotteryId];
  const when = view.drawAt
    ? (
      <span className="ui-nb">
        {formatWhen(Date.parse(view.drawAt), now, timeZone)}
      </span>
    )
    : pool.data.deadlineAt &&
        (view.step === "montar" || view.step === "arrecadar")
    ? (
      <>
        pagar até{" "}
        <span className="ui-nb">
          {formatWhen(Date.parse(pool.data.deadlineAt), now, timeZone)}
        </span>
      </>
    )
    : null;
  return (
    <Card className="home-pool" onClick={onClick}>
      <span
        className={`home-num mod-${pool.data.lotteryId}`}
        aria-hidden="true"
      >
        {String(lottery.minNumbers).padStart(2, "0")}
      </span>
      <span className="home-pool-main">
        <b>{pool.data.title}</b>
        <span className="ui-sec">
          {view.hasQuotas
            ? (
              <>
                <span className="ui-nb">{formatBRL(view.collectedCents)}</span>
                {view.expectedCents !== null && (
                  <>
                    {" de "}
                    <span className="ui-nb">
                      {formatBRL(view.expectedCents)}
                    </span>
                  </>
                )}
              </>
            )
            : "Nenhuma cota ainda"}
          {when && <>{" · "}{when}</>}
        </span>
        <span className="home-pool-chips">
          <Chip modality={pool.data.lotteryId}>{lottery.label}</Chip>
          {ended
            ? <Chip status="confirmed">Encerrado</Chip>
            : (
              <Chip modality={pool.data.lotteryId} step>
                {STEP_LABEL[view.step]}
              </Chip>
            )}
        </span>
      </span>
      <ChevronRight aria-hidden="true" />
    </Card>
  );
}
