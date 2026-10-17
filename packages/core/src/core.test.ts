import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION, DomainValidationError, GENERATION_ALGORITHM_VERSION, LOTTERIES,
  betCost, betSignature, choose, distributeCents, formatBRL, formatQuotaUnits,
  generateBets, jackpotProbability, parseBRL, prizeMultiplicities, quotaCost,
  quotaUnits, sumCents, validateBet, validateDraftOperation, validateEntityData,
} from './index';
import type { DraftOperation, LotteryId } from './types';

describe('exact integer cents', () => {
  it.each([
    ['R$ 1.234,56', '123456'], ['25,5', '2550'], ['25.50', '2550'], ['6', '600'],
    ['1.234', '123400'], ['-R$ 2,25', '-225'], ['R$ -2,25', '-225'], ['-0,00', '0'],
    ['90071992547409,92', '9007199254740992'],
  ])('parses %s without floating-point rounding', (input, expected) => {
    expect(parseBRL(input)).toBe(expected);
  });

  it.each(['', '1,001', '1.0010', '12.34,56', 'NaN', 'Infinity', '1e6', '--2', '+3', '1,2,3'])('rejects %s', (input) => {
    expect(() => parseBRL(input)).toThrow();
  });

  it('formats and adds values beyond the safe JavaScript integer range', () => {
    expect(formatBRL('9007199254740992')).toBe('R$ 90.071.992.547.409,92');
    expect(formatBRL('-123456')).toBe('-R$ 1.234,56');
    expect(sumCents(['9007199254740992', '7', '-2'])).toBe('9007199254740997');
    expect(sumCents([])).toBe('0');
    expect(() => sumCents(['1.5'])).toThrow();
    expect(() => formatBRL('001')).toThrow();
  });
});

describe('internal fractional quotas', () => {
  it('represents hundredths of a quota as integer units', () => {
    expect(quotaUnits('1,25')).toBe(125);
    expect(quotaUnits('0.01')).toBe(1);
    expect(formatQuotaUnits(125)).toBe('1,25');
    expect(formatQuotaUnits(150)).toBe('1,5');
    expect(formatQuotaUnits(100)).toBe('1');
    expect(quotaCost('2500', 125)).toBe('3125');
  });

  it('rejects overprecision, unsafe units, and fractional cents', () => {
    expect(() => quotaUnits('1,005')).toThrow();
    expect(() => quotaUnits('-1')).toThrow();
    expect(() => quotaUnits('9007199254740992')).toThrow();
    expect(() => formatQuotaUnits(0.5)).toThrow();
    expect(() => quotaCost('350', 1)).toThrow('fração de centavo');
  });
});

describe('largest remainder distribution', () => {
  it('conserves every cent and breaks ties by frozen ID', () => {
    const rights = [{ id: 'c', units: 100 }, { id: 'a', units: 100 }, { id: 'b', units: 100 }];
    expect(distributeCents('100', rights)).toEqual([
      { id: 'a', units: 100, amountCents: '34' },
      { id: 'b', units: 100, amountCents: '33' },
      { id: 'c', units: 100, amountCents: '33' },
    ]);
    expect(distributeCents('100', [...rights].reverse())).toEqual(distributeCents('100', rights));
  });

  it('keeps exact proportional rights for enormous prizes and zero-share recipients', () => {
    const shares = distributeCents('9007199254740992001', [{ id: 'b', units: 3 }, { id: 'a', units: 1 }, { id: 'c', units: 0 }]);
    expect(sumCents(shares.map((share) => share.amountCents))).toBe('9007199254740992001');
    expect(shares.find((share) => share.id === 'c')!.amountCents).toBe('0');
    expect(shares.find((share) => share.id === 'b')!.amountCents).toBe('6755399441055744001');
  });

  it('rejects missing rights, duplicate recipients and negative totals', () => {
    expect(() => distributeCents('1', [])).toThrow();
    expect(() => distributeCents('1', [{ id: 'a', units: 0 }])).toThrow();
    expect(() => distributeCents('1', [{ id: 'a', units: 1 }, { id: 'a', units: 2 }])).toThrow();
    expect(() => distributeCents('-1', [{ id: 'a', units: 1 }])).toThrow();
    expect(distributeCents('0', [])).toEqual([]);
  });
});

const range = (count: number, start = 1) => Array.from({ length: count }, (_, index) => start + index);

describe('lottery rules and combinatorics', () => {
  it.each<[LotteryId, number, string, string]>([
    ['mega-sena', 6, '600', '50063860'], ['lotofacil', 15, '350', '3268760'], ['quina', 5, '300', '24040016'],
  ])('matches the simple price and known principal probability for %s', (modality, size, price, denominator) => {
    expect(betCost(modality, range(size))).toBe(price);
    expect(jackpotProbability(modality, range(size))).toEqual({ numerator: '1', denominator, probability: 1 / Number(denominator) });
    expect(LOTTERIES[modality].catalogVersion).toBe(CATALOG_VERSION);
  });

  it('computes enlarged bets exactly without conflating a portfolio with one bet', () => {
    expect(choose(60, 6)).toBe(50_063_860n);
    expect(choose(100, 50)).toBe(100_891_344_545_564_193_334_812_497_256n);
    expect(choose(5, 6)).toBe(0n);
    expect(choose(0, 0)).toBe(1n);
    expect(() => choose(5, -1)).toThrow();
    expect(betCost('mega-sena', range(7))).toBe('4200');
    expect(betCost('lotofacil', range(16))).toBe('5600');
    expect(betCost('quina', range(6))).toBe('1800');
    expect(jackpotProbability('mega-sena', range(7)).numerator).toBe('7');
  });

  it('sorts without mutating the source and detects duplicates independent of order', () => {
    const numbers = [6, 3, 2, 1, 5, 4];
    expect(validateBet('mega-sena', numbers)).toEqual(range(6));
    expect(numbers).toEqual([6, 3, 2, 1, 5, 4]);
    expect(betSignature('mega-sena', numbers)).toBe(betSignature('mega-sena', range(6)));
    expect(() => validateBet('mega-sena', [1, 2, 3, 4, 5, 5])).toThrow();
    expect(() => validateBet('mega-sena', [1, 2, 3, 4, 5, 61])).toThrow();
    expect(() => validateBet('mega-sena', [1, 2, 3, 4, 5, 5.5])).toThrow();
    expect(() => validateBet('lotofacil', range(14))).toThrow();
    expect(() => validateBet('quina', range(16))).toThrow();
  });

  it('counts multiple awards produced by enlarged bets', () => {
    expect(prizeMultiplicities('mega-sena', range(8), range(6))).toEqual([
      { hits: 6, combinations: '1' }, { hits: 5, combinations: '12' }, { hits: 4, combinations: '15' },
    ]);
    expect(prizeMultiplicities('lotofacil', range(16), range(15))).toEqual([
      { hits: 15, combinations: '1' }, { hits: 14, combinations: '15' }, { hits: 13, combinations: '0' },
      { hits: 12, combinations: '0' }, { hits: 11, combinations: '0' },
    ]);
    expect(prizeMultiplicities('quina', range(6), range(5))).toEqual([
      { hits: 5, combinations: '1' }, { hits: 4, combinations: '5' }, { hits: 3, combinations: '0' }, { hits: 2, combinations: '0' },
    ]);
    expect(() => prizeMultiplicities('mega-sena', range(6), range(5))).toThrow();
    expect(() => prizeMultiplicities('mega-sena', range(6), [1, 1, 3, 4, 5, 6])).toThrow();
  });
});

describe('reproducible generated bets', () => {
  const seed = 'a1'.repeat(32);
  const options = { lotteryId: 'mega-sena' as const, count: 100, numberCount: 6, seed };

  it('matches an independent OpenSSL ChaCha20 and combinatorial-unranking vector', () => {
    expect(generateBets({ ...options, count: 3, seed: '00'.repeat(32) })).toEqual([
      [9, 22, 26, 38, 51, 57], [1, 18, 20, 29, 36, 56], [6, 23, 25, 45, 47, 60],
    ]);
  });

  it('is deterministic, versioned, sorted and uses the entire seed', () => {
    const generated = generateBets(options);
    expect(GENERATION_ALGORITHM_VERSION).toBe('chacha20-lexicographic-rank-v1');
    expect(generateBets(options)).toEqual(generated);
    expect(generateBets({ ...options, seed: seed.toUpperCase() })).toEqual(generated);
    expect(generateBets({ ...options, seed: seed.slice(0, 62) + 'a2' })).not.toEqual(generated);
    for (const numbers of generated) expect(validateBet('mega-sena', numbers)).toEqual(numbers);
    expect(new Set(generated.map((numbers) => numbers.join(','))).size).toBe(100);
  });

  it('excludes canonical existing bets, even when the seed is reused', () => {
    const existing = generateBets(options).map((numbers) => [...numbers].reverse());
    const generated = generateBets({ ...options, existing });
    const known = new Set(existing.map((numbers) => betSignature('mega-sena', numbers)));
    expect(generated.every((numbers) => !known.has(betSignature('mega-sena', numbers)))).toBe(true);
    expect(new Set(generated.map((numbers) => numbers.join(','))).size).toBe(100);
    expect(existing[0]![0]).toBeGreaterThan(existing[0]![5]!);
  });

  it.each<LotteryId>(['mega-sena', 'lotofacil', 'quina'])('generates 1,000 valid distinct maximum-sized bets for %s', (modality) => {
    const generated = generateBets({ lotteryId: modality, count: 1_000, numberCount: LOTTERIES[modality].maxNumbers, seed });
    expect(new Set(generated.map((numbers) => numbers.join(','))).size).toBe(1_000);
    for (const numbers of generated) expect(validateBet(modality, numbers)).toEqual(numbers);
  });

  it('rejects invalid requests before generating', () => {
    expect(() => generateBets({ ...options, seed: 'guess' })).toThrow();
    expect(() => generateBets({ ...options, count: 1_001 })).toThrow();
    expect(() => generateBets({ ...options, count: -1 })).toThrow();
    expect(() => generateBets({ ...options, numberCount: 5 })).toThrow();
    expect(generateBets({ ...options, count: 0 })).toEqual([]);
  });
});

const groupId = '10000000-0000-4000-8000-000000000001';
const entityId = '20000000-0000-4000-8000-000000000001';
const operation: DraftOperation = {
  apiVersion: 'v1', idempotencyKey: '30000000-0000-4000-8000-000000000001', groupId, entityId,
  kind: 'pool', expectedVersion: 0, createdAt: '2026-10-07T12:00:00.000Z',
  data: {
    title: 'Concurso da turma', lotteryId: 'mega-sena', contestNumber: null, deadlineAt: null,
    quotaPriceCents: '2500', participationMode: 'internal', status: 'draft',
  },
};

describe('shared draft validation', () => {
  it('returns independently validated data with canonical UTC timestamps', () => {
    expect(validateDraftOperation(operation)).toEqual(operation);
    expect(validateDraftOperation({ ...operation, createdAt: '2026-10-07T12:00:00Z' }).createdAt).toBe('2026-10-07T12:00:00.000Z');
    const data = validateEntityData('bet', {
      poolId: entityId, lotteryId: 'mega-sena', numbers: [6, 5, 4, 3, 2, 1], authorIds: [], catalogVersion: CATALOG_VERSION, seed: null, generationAlgorithmVersion: null,
    });
    expect(data.numbers).toEqual(range(6));
  });

  it('cannot mark a pool locked or a payment confirmed through draft synchronization', () => {
    expect(() => validateDraftOperation({ ...operation, data: { ...operation.data, status: 'locked' } })).toThrow('comando confirmado');
    expect(() => validateEntityData('payment-proposal', {
      poolId: entityId, personId: entityId, amountCents: '100', note: '', status: 'confirmed',
    })).toThrow(DomainValidationError);
  });

  it('keeps a pool contest count from 1 to 12 and caps the contest number', () => {
    const pool: object = operation.data;
    expect(validateEntityData('pool', { ...pool, contestCount: 4 })).toEqual({ ...pool, contestCount: 4 });
    expect('contestCount' in validateEntityData('pool', pool)).toBe(false);
    for (const bad of [13, 0, '4']) expect(() => validateEntityData('pool', { ...pool, contestCount: bad })).toThrow();
    expect(validateEntityData('pool', { ...pool, contestNumber: 999_999 })).toMatchObject({ contestNumber: 999_999 });
    expect(() => validateEntityData('pool', { ...pool, contestNumber: 1_000_000 })).toThrow();
  });

  it('rejects invalid identity, old catalogs, malformed dates and unsupported author rights', () => {
    expect(() => validateDraftOperation({ ...operation, kind: 'group', data: { name: 'Turma', statute: '' } })).toThrow('identificador do grupo');
    expect(() => validateDraftOperation({ ...operation, expectedVersion: -1 })).toThrow();
    expect(() => validateDraftOperation({ ...operation, createdAt: '2026-02-30T12:00:00Z' })).toThrow();
    expect(() => validateDraftOperation({ ...operation, createdAt: '2026-10-07T12:00:00-03:00' })).toThrow();
    expect(() => validateEntityData('quota', { poolId: entityId, personId: entityId, units: 0 })).toThrow();
    expect(() => validateEntityData('quota', { poolId: entityId, personId: entityId, units: 1.5 })).toThrow();
    expect(() => validateEntityData('payment-proposal', { poolId: entityId, personId: entityId, amountCents: '9007199254740992', note: '', status: 'pending' })).toThrow();
    expect(() => validateEntityData('bet', { poolId: entityId, lotteryId: 'mega-sena', numbers: range(6), authorIds: [entityId, entityId], catalogVersion: CATALOG_VERSION, seed: null, generationAlgorithmVersion: null })).toThrow();
    expect(() => validateEntityData('bet', { poolId: entityId, lotteryId: 'mega-sena', numbers: range(6), authorIds: [], catalogVersion: 'old', seed: null, generationAlgorithmVersion: null })).toThrow('catálogo mudou');
    expect(() => validateEntityData('bet', { poolId: entityId, lotteryId: 'mega-sena', numbers: range(6), authorIds: [], catalogVersion: CATALOG_VERSION, seed: null, generationAlgorithmVersion: null, prizeRight: 100 })).toThrow('Campo não suportado');
  });

  it('binds a generated bet to the supported algorithm and a canonical seed', () => {
    const data = validateEntityData('bet', {
      poolId: entityId, lotteryId: 'mega-sena', numbers: range(6), authorIds: [],
      catalogVersion: CATALOG_VERSION, seed: 'AB'.repeat(32), generationAlgorithmVersion: GENERATION_ALGORITHM_VERSION,
    });
    expect(data.seed).toBe('ab'.repeat(32));
    expect(data.generationAlgorithmVersion).toBe(GENERATION_ALGORITHM_VERSION);
  });

  it.each([
    [null, GENERATION_ALGORITHM_VERSION], ['ab'.repeat(32), null], ['ab'.repeat(32), 'unknown-v2'],
  ])('rejects incompatible generation metadata (%s, %s)', (seed, generationAlgorithmVersion) => {
    expect(() => validateEntityData('bet', {
      poolId: entityId, lotteryId: 'mega-sena', numbers: range(6), authorIds: [],
      catalogVersion: CATALOG_VERSION, seed, generationAlgorithmVersion,
    })).toThrow(DomainValidationError);
  });

  it('requires explicit generation metadata, including null for a manual bet', () => {
    expect(() => validateEntityData('bet', {
      poolId: entityId, lotteryId: 'mega-sena', numbers: range(6), authorIds: [], catalogVersion: CATALOG_VERSION, seed: null,
    })).toThrow('Campo obrigatório ausente: generationAlgorithmVersion');
  });
});
