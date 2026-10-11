import { generateBets } from "@bolao/core";
import type { LotteryId } from "@bolao/core";

self.onmessage = (
  event: MessageEvent<
    {
      lotteryId: LotteryId;
      count: number;
      numberCount: number;
      seed: string;
      existing: number[][];
    }
  >,
) => {
  try {
    self.postMessage({ numbers: generateBets(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error
        ? error.message
        : "Não foi possível gerar os jogos.",
    });
  }
};
