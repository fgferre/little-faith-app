import type { CurrentResultView, RegisteredPrize, RegistrationPrizeAssessment } from './result-types';
import type { RegistrationReport } from './registration-types';
import { prizeMultiplicities } from './lotteries';
import { validateRegistrationItems } from './registration';
import { validateResultVersion } from './results';
import { planningInvalid, planningOption, planningUid } from './prepared-plans';

/** Applies result tiers to human-reviewed, legible actual games; the plan is never a substitute receipt. */
export function assessRegisteredPrizes(report: RegistrationReport, view: CurrentResultView): RegistrationPrizeAssessment {
  const groupId = planningUid(report.groupId, 'groupId'), poolId = planningUid(report.poolId, 'poolId');
  const items = validateRegistrationItems(report.items);
  const status = planningOption(view.status, ['waiting', 'numbers-only', 'complete', 'manual', 'conflict'], 'status');
  if (status === 'conflict') return { status: 'conflict', games: [], skippedTicketKeys: items.map((i) => i.plannedTicketKey), calculatedPrizeCents: null };
  const result = view.result === null ? null : validateResultVersion(view.result);
  if (result && (result.groupId !== groupId || result.poolId !== poolId)) planningInvalid('result', 'Apuração exige resultado deste grupo e bolão.');
  if (!result?.drawnNumbers) return { status: 'waiting', games: [], skippedTicketKeys: items.map((i) => i.plannedTicketKey), calculatedPrizeCents: null };
  const payouts = new Map(result.payouts?.map((p) => [p.hits, p.prizeCents]));
  // Unknown published tiers keep monetary totals unavailable, including after zero observed wins.
  const allPayoutsKnown = result.payouts !== null && result.payouts.every((p) => p.prizeCents !== null);
  const drawn = new Set(result.drawnNumbers), games: RegisteredPrize[] = [], skippedTicketKeys: string[] = [];
  for (const item of items) {
    const actual = item.observed;
    if (!item.evidenceIds.length || !actual?.betNumbers || actual.lotteryId !== result.lotteryId || actual.contestNumber !== result.contestNumber) { skippedTicketKeys.push(item.plannedTicketKey); continue; }
    actual.betNumbers.forEach((numbers, observedBetIndex) => {
      const tiers = prizeMultiplicities(result.lotteryId, numbers, result.drawnNumbers!).map((tier) => {
        const prizeCents = payouts.get(tier.hits) ?? null;
        return { ...tier, prizeCents, totalCents: prizeCents === null ? null : (BigInt(tier.combinations) * BigInt(prizeCents)).toString() };
      });
      games.push({ plannedTicketKey: item.plannedTicketKey, observedBetIndex, numbers, hits: numbers.filter((n) => drawn.has(n)).length, tiers, calculatedPrizeCents: allPayoutsKnown ? tiers.reduce((sum, tier) => sum + BigInt(tier.totalCents!), 0n).toString() : null });
    });
  }
  const calculatedPrizeCents = games.length && !skippedTicketKeys.length && allPayoutsKnown ? games.reduce((sum, game) => sum + BigInt(game.calculatedPrizeCents!), 0n).toString() : null;
  return { status: skippedTicketKeys.length || !allPayoutsKnown || report.comparison.status !== 'complete' ? 'partial' : 'calculated', games, skippedTicketKeys, calculatedPrizeCents };
}
