import {
  exactPortfolioProbability,
  runSimulationBatch,
  simulationResult,
  suggestPlans,
} from "@bolao/core";
import type {
  SimulationCheckpoint,
  SimulationInput,
  SuggestPlansInput,
} from "@bolao/core";

type Request =
  | { type: "suggest"; input: SuggestPlansInput }
  | { type: "batch"; input: SimulationInput; checkpoint: SimulationCheckpoint };

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const request = event.data;
    if (request.type === "suggest") {
      const result = suggestPlans(request.input);
      const coverage = result.plans.map((plan) => ({
        candidateId: plan.id,
        result: exactPortfolioProbability(
          plan.lotteryId,
          plan.bets.map((bet) => bet.numbers),
        ),
      }));
      self.postMessage({ type: "suggestion", result, coverage });
    } else {
      const checkpoint = runSimulationBatch(
        request.input,
        request.checkpoint,
        2_000,
      );
      self.postMessage({
        type: "progress",
        checkpoint,
        result: simulationResult(request.input, checkpoint),
      });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error
        ? error.message
        : "Não foi possível concluir o cálculo.",
    });
  }
};
