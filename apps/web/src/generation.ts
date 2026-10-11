import type { LotteryId } from "@bolao/core";

export function createSeed() {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function generateInWorker(
  input: {
    lotteryId: LotteryId;
    count: number;
    numberCount: number;
    seed: string;
    existing: number[][];
  },
): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./generation.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (
      event: MessageEvent<{ numbers?: number[][]; error?: string }>,
    ) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.numbers!);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("Não foi possível iniciar o gerador. Tente novamente."));
    };
    worker.postMessage(input);
  });
}
