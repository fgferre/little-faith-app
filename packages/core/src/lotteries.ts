import type { LotteryId } from './types';

export interface LotteryRule {
  readonly id: LotteryId;
  readonly label: string;
  readonly color: string;
  readonly minNumbers: number;
  readonly maxNumbers: number;
  readonly universeSize: number;
  readonly drawSize: number;
  readonly simplePriceCents: string;
  readonly catalogVersion: string;
  readonly sourceUrl: string;
  readonly verifiedAt: string;
}

/** This basic catalog validates bets and prices, not official pool quotas, tickets, or fees. */
export const CATALOG_VERSION = 'caixa-basic-2026-10-07-v1';
export const LOTTERIES: Readonly<Record<LotteryId, LotteryRule>> = Object.freeze({
  'mega-sena': Object.freeze({
    id: 'mega-sena', label: 'Mega-Sena', color: '#168A62',
    minNumbers: 6, maxNumbers: 20, universeSize: 60, drawSize: 6,
    simplePriceCents: '600', catalogVersion: CATALOG_VERSION,
    sourceUrl: 'https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx', verifiedAt: '2026-10-07',
  }),
  lotofacil: Object.freeze({
    id: 'lotofacil', label: 'Lotofácil', color: '#930089',
    minNumbers: 15, maxNumbers: 20, universeSize: 25, drawSize: 15,
    simplePriceCents: '350', catalogVersion: CATALOG_VERSION,
    sourceUrl: 'https://loterias.caixa.gov.br/Paginas/Lotofacil.aspx', verifiedAt: '2026-10-07',
  }),
  quina: Object.freeze({
    id: 'quina', label: 'Quina', color: '#3154AC',
    minNumbers: 5, maxNumbers: 15, universeSize: 80, drawSize: 5,
    simplePriceCents: '300', catalogVersion: CATALOG_VERSION,
    sourceUrl: 'https://loterias.caixa.gov.br/Paginas/Quina.aspx', verifiedAt: '2026-10-07',
  }),
});

export function lotteryRule(lotteryId: LotteryId): LotteryRule {
  if (!Object.hasOwn(LOTTERIES, lotteryId)) throw new Error('Modalidade não suportada.');
  return LOTTERIES[lotteryId];
}

export function choose(n: number, k: number): bigint {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0) {
    throw new Error('Combinações exigem quantidades inteiras não negativas.');
  }
  if (k > n) return 0n;
  const count = Math.min(k, n - k);
  let result = 1n;
  for (let index = 1; index <= count; index++) {
    result = result * BigInt(n - count + index) / BigInt(index);
  }
  return result;
}

export function validateBet(lotteryId: LotteryId, numbers: readonly number[]): number[] {
  const rule = lotteryRule(lotteryId);
  if (!Array.isArray(numbers) || numbers.length < rule.minNumbers || numbers.length > rule.maxNumbers) {
    throw new Error(`${rule.label} exige de ${rule.minNumbers} a ${rule.maxNumbers} dezenas.`);
  }
  return validateNumbers(numbers, rule.universeSize);
}

function validateNumbers(numbers: readonly number[], universeSize: number): number[] {
  const unique = new Set<number>();
  for (const number of numbers) {
    if (!Number.isInteger(number) || number < 1 || number > universeSize) {
      throw new Error(`As dezenas precisam ser inteiras entre 1 e ${universeSize}.`);
    }
    if (unique.has(number)) throw new Error('Uma dezena não pode aparecer duas vezes no mesmo jogo.');
    unique.add(number);
  }
  return [...numbers].sort((left, right) => left - right);
}

export function betSignature(lotteryId: LotteryId, numbers: readonly number[]): string {
  return `${lotteryId}:${validateBet(lotteryId, numbers).join(',')}`;
}

export function betCost(lotteryId: LotteryId, numbers: readonly number[]): string {
  const rule = lotteryRule(lotteryId);
  const validated = validateBet(lotteryId, numbers);
  return (choose(validated.length, rule.drawSize) * BigInt(rule.simplePriceCents)).toString();
}

export interface ExactProbability { numerator: string; denominator: string; probability: number }

/** A single bet's principal-prize chance. This must not be summed for overlapping portfolios. */
export function jackpotProbability(lotteryId: LotteryId, numbers: readonly number[]): ExactProbability {
  const rule = lotteryRule(lotteryId);
  const validated = validateBet(lotteryId, numbers);
  const numerator = choose(validated.length, rule.drawSize);
  const denominator = choose(rule.universeSize, rule.drawSize);
  return { numerator: numerator.toString(), denominator: denominator.toString(), probability: Number(numerator) / Number(denominator) };
}

const PRIZE_TIERS: Readonly<Record<LotteryId, readonly number[]>> = {
  'mega-sena': [6, 5, 4], lotofacil: [15, 14, 13, 12, 11], quina: [5, 4, 3, 2],
};
export interface PrizeMultiplicity { hits: number; combinations: string }

/** Counts elementary winning bets inside an expanded bet; it does not confirm a monetary prize. */
export function prizeMultiplicities(lotteryId: LotteryId, numbers: readonly number[], drawnNumbers: readonly number[]): PrizeMultiplicity[] {
  const rule = lotteryRule(lotteryId);
  const validated = validateBet(lotteryId, numbers);
  if (!Array.isArray(drawnNumbers) || drawnNumbers.length !== rule.drawSize) {
    throw new Error(`O resultado de ${rule.label} precisa ter ${rule.drawSize} dezenas.`);
  }
  const drawn = new Set(validateNumbers(drawnNumbers, rule.universeSize));
  const hits = validated.filter((number) => drawn.has(number)).length;
  const misses = validated.length - hits;
  return PRIZE_TIERS[lotteryId].map((tier) => ({
    hits: tier,
    combinations: (choose(hits, tier) * choose(misses, rule.drawSize - tier)).toString(),
  }));
}
