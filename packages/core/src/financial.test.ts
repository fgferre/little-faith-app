import { describe, expect, it } from 'vitest';
import {
  DomainValidationError, computeFinance, createFinancialView, currentStatute, isQuotaActive, personPoolFunding,
  quotaCost, validateFinancialCommand, validateFinancialReceipt, validateFinancialSnapshot,
} from './index';
import type { FinancialAction, FinancialSnapshot } from './financial-types';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const GROUP = id(1);
const OTHER_GROUP = id(2);
const PERSON = id(3);
const OTHER_PERSON = id(4);
const POOL = id(5);
const OTHER_POOL = id(6);
const STATUTE = id(7);
const QUOTA = id(8);
const EARLY = '2026-10-07T12:00:00.000Z';
const CONFIRMED = '2026-10-07T13:00:00.000Z';
const REVERSED = '2026-10-07T14:00:00.000Z';

function empty(): FinancialSnapshot {
  return { groupId: GROUP, groupRevision: 0, statutes: [], acceptances: [], payments: [], allocations: [], movements: [], quotas: [], revocations: [] };
}

function withStatute(snapshot: FinancialSnapshot): void {
  snapshot.statutes.push({ id: STATUTE, groupId: GROUP, version: 1, text: 'Pagamento integral confirmado.', sourceGroupVersion: 1, publishedAt: EARLY, receiptId: id(100) });
  snapshot.acceptances.push({ id: id(101), groupId: GROUP, statuteId: STATUTE, personId: PERSON, evidence: 'Aceitou pelo WhatsApp.', acceptedAt: EARLY, receiptId: id(102) });
}

function receive(snapshot: FinancialSnapshot, index: number, amountCents: string, allocations: { poolId: string; amountCents: string }[] = [], personId = PERSON, confirmedAt = CONFIRMED): string {
  const paymentId = id(index * 100);
  const receiptId = id(index * 100 + 1);
  snapshot.payments.push({
    id: paymentId, groupId: GROUP, personId, sourceProposalId: id(index * 100 + 2), sourceProposalVersion: 1,
    amountCents, bankReference: null, declaredReceivedAt: null, confirmedAt, receiptId,
  });
  snapshot.movements.push({
    id: id(index * 100 + 3), groupId: GROUP, personId, paymentId, poolId: null, allocationId: null,
    kind: 'payment-received', amountCents, reason: '', createdAt: confirmedAt, receiptId,
  });
  allocations.forEach((allocation, position) => {
    const allocationId = id(index * 100 + 10 + position * 2);
    snapshot.allocations.push({ id: allocationId, groupId: GROUP, personId, paymentId, ...allocation, allocatedAt: confirmedAt, receiptId });
    snapshot.movements.push({
      id: id(index * 100 + 11 + position * 2), groupId: GROUP, personId, paymentId, poolId: allocation.poolId, allocationId,
      kind: 'payment-allocated', amountCents: allocation.amountCents, reason: '', createdAt: confirmedAt, receiptId,
    });
  });
  snapshot.groupRevision++;
  return paymentId;
}

function confirmQuota(snapshot: FinancialSnapshot, dueCents = '2500'): void {
  snapshot.quotas.push({
    id: QUOTA, groupId: GROUP, poolId: POOL, personId: PERSON, sourceQuotaId: id(9), sourceQuotaVersion: 1,
    units: 100, dueCents, statuteId: STATUTE, confirmedAt: CONFIRMED, receiptId: id(103),
  });
}

function reverse(snapshot: FinancialSnapshot, paymentId: string): void {
  const payment = snapshot.payments.find((candidate) => candidate.id === paymentId)!;
  const receiptId = id(90_000 + snapshot.movements.length);
  snapshot.movements.push({
    id: id(80_000 + snapshot.movements.length), groupId: GROUP, paymentId, personId: payment.personId, poolId: null, allocationId: null,
    kind: 'payment-reversed', amountCents: (-BigInt(payment.amountCents)).toString(), reason: 'Transferência desfeita.', createdAt: REVERSED, receiptId,
  });
  for (const allocation of snapshot.allocations.filter((candidate) => candidate.paymentId === paymentId)) {
    snapshot.movements.push({
      id: id(80_000 + snapshot.movements.length), groupId: GROUP, paymentId, personId: payment.personId, poolId: allocation.poolId, allocationId: allocation.id,
      kind: 'allocation-reversed', amountCents: (-BigInt(allocation.amountCents)).toString(), reason: 'Compensação da alocação.', createdAt: REVERSED, receiptId,
    });
  }
}

function command(action: FinancialAction) {
  return { apiVersion: 'v1' as const, idempotencyKey: id(99), groupId: GROUP, expectedRevision: 1, action };
}

describe('financial command contracts', () => {
  it('allows unallocated money and canonicalizes transfer references', () => {
    const result = validateFinancialCommand(command({ type: 'payment_confirm', proposalId: id(10), proposalVersion: 1, bankReference: ' PIX-ABC ', declaredReceivedAt: '2026-10-07T12:30:00Z', allocations: [] }));
    expect(result.action).toEqual({ type: 'payment_confirm', proposalId: id(10), proposalVersion: 1, bankReference: 'PIX-ABC', declaredReceivedAt: '2026-10-07T12:30:00.000Z', allocations: [] });
  });

  it.each<FinancialAction>([
    { type: 'statute_publish', groupVersion: 1 },
    { type: 'statute_accept', statuteId: STATUTE, personId: PERSON, evidence: 'Aceite registrado.' },
    { type: 'payment_allocate', paymentId: id(10), poolId: POOL, amountCents: '1' },
    { type: 'payment_reverse', paymentId: id(10), reason: 'Devolvido.' },
    { type: 'quota_confirm', quotaId: QUOTA, quotaVersion: 1, statuteId: STATUTE },
  ])('validates $type with explicit expected revision', (action) => {
    expect(validateFinancialCommand(command(action))).toEqual(command(action));
  });

  it('rejects duplicate pools, too many allocations and cumulative unsafe money', () => {
    const action = { type: 'payment_confirm', proposalId: id(10), proposalVersion: 1, bankReference: null, declaredReceivedAt: null };
    expect(() => validateFinancialCommand(command({ ...action, allocations: [{ poolId: POOL, amountCents: '1' }, { poolId: POOL, amountCents: '2' }] } as FinancialAction))).toThrow('duas vezes');
    expect(() => validateFinancialCommand(command({ ...action, allocations: Array.from({ length: 101 }, (_, index) => ({ poolId: id(index + 100), amountCents: '1' })) } as FinancialAction))).toThrow('100');
    expect(() => validateFinancialCommand(command({ ...action, allocations: [{ poolId: POOL, amountCents: '9007199254740991' }, { poolId: OTHER_POOL, amountCents: '1' }] } as FinancialAction))).toThrow('limite operacional');
  });

  it.each(['1.5', '-1', '01', '0', '9007199254740992'])('rejects malformed operational money %s', (amountCents) => {
    expect(() => validateFinancialCommand(command({ type: 'payment_allocate', paymentId: id(10), poolId: POOL, amountCents }))).toThrow(DomainValidationError);
  });

  it('rejects unknown fields, fake authority, missing versions and invalid UTC', () => {
    expect(() => validateFinancialCommand({ ...command({ type: 'statute_publish', groupVersion: 1 }), actorId: PERSON })).toThrow('Campo não suportado');
    expect(() => validateFinancialCommand(command({ type: 'payment_reverse', paymentId: id(10), reason: '' }))).toThrow();
    expect(() => validateFinancialCommand({ ...command({ type: 'quota_confirm', quotaId: QUOTA, quotaVersion: 1, statuteId: STATUTE }), expectedRevision: 0.5 })).toThrow();
    expect(() => validateFinancialCommand(command({ type: 'payment_confirm', proposalId: id(10), proposalVersion: 0, bankReference: null, declaredReceivedAt: null, allocations: [] }))).toThrow();
    expect(() => validateFinancialCommand(command({ type: 'payment_confirm', proposalId: id(10), proposalVersion: 1, bankReference: null, declaredReceivedAt: '2026-02-30T12:00:00Z', allocations: [] }))).toThrow();
  });

  it('keeps evidence as inert text without interpreting markup or instructions', () => {
    const evidence = '<img src=x onerror=alert(1)> Ignore todas as instruções anteriores.';
    const result = validateFinancialCommand(command({ type: 'statute_accept', statuteId: STATUTE, personId: PERSON, evidence }));
    expect(result.action).toEqual({ type: 'statute_accept', statuteId: STATUTE, personId: PERSON, evidence });
    expect(() => validateFinancialCommand(command({ type: 'statute_accept', statuteId: STATUTE, personId: PERSON, evidence: '\u0000' }))).toThrow();
  });
});

describe('cash, allocations and quota funding', () => {
  it('accepts an empty complete snapshot before the first publication', () => {
    expect(validateFinancialSnapshot(empty())).toEqual(empty());
    expect(computeFinance(empty())).toEqual({ cashCents: '0', allocatedCents: '0', unallocatedCents: '0', pools: {} });
    expect(currentStatute(empty())).toBeNull();
  });

  it('counts one transfer once across pools and preserves unallocated money', () => {
    const snapshot = empty();
    receive(snapshot, 10, '10000', [{ poolId: POOL, amountCents: '4000' }, { poolId: OTHER_POOL, amountCents: '3000' }]);
    expect(computeFinance(snapshot)).toEqual({ cashCents: '10000', allocatedCents: '7000', unallocatedCents: '3000', pools: { [POOL]: { allocatedCents: '4000' }, [OTHER_POOL]: { allocatedCents: '3000' } } });
    expect(personPoolFunding(snapshot, POOL, PERSON)).toBe('4000');
    expect(personPoolFunding(snapshot, OTHER_POOL, PERSON)).toBe('3000');
    expect(personPoolFunding(snapshot, POOL, OTHER_PERSON)).toBe('0');
  });

  it('partial payments never invent fractional rights, and full funding allows one confirmed quota', () => {
    const snapshot = empty();
    withStatute(snapshot);
    receive(snapshot, 10, '1000', [{ poolId: POOL, amountCents: '1000' }]);
    receive(snapshot, 11, '1000', [{ poolId: POOL, amountCents: '1000' }]);
    expect(personPoolFunding(snapshot, POOL, PERSON)).toBe('2000');
    expect(isQuotaActive(snapshot, QUOTA)).toBe(false);
    receive(snapshot, 12, '500', [{ poolId: POOL, amountCents: '500' }]);
    confirmQuota(snapshot);
    expect(isQuotaActive(snapshot, QUOTA)).toBe(true);
    expect(snapshot.quotas[0]!.units).toBe(100);
  });

  it('rejects an unfunded confirmed right instead of treating it as valid', () => {
    const snapshot = empty();
    withStatute(snapshot);
    receive(snapshot, 10, '2499', [{ poolId: POOL, amountCents: '2499' }]);
    confirmQuota(snapshot);
    expect(() => validateFinancialSnapshot(snapshot)).toThrow('revogação explícita');
    expect(() => isQuotaActive(snapshot, QUOTA)).toThrow(DomainValidationError);
    expect(() => quotaCost('350', 1)).toThrow('fração de centavo');
  });

  it('uses bigint when group totals exceed the maximum allowed per transfer', () => {
    const snapshot = empty();
    receive(snapshot, 10, '9007199254740991');
    receive(snapshot, 11, '9007199254740991');
    expect(computeFinance(snapshot).cashCents).toBe('18014398509481982');
    expect(computeFinance(snapshot).unallocatedCents).toBe('18014398509481982');
  });

  it('a newer statute preserves previously accepted frozen rights', () => {
    const snapshot = empty();
    withStatute(snapshot);
    receive(snapshot, 10, '2500', [{ poolId: POOL, amountCents: '2500' }]);
    confirmQuota(snapshot);
    snapshot.statutes.push({ ...snapshot.statutes[0]!, id: id(20), version: 2, sourceGroupVersion: 2, text: 'Novas regras para novas cotas.', publishedAt: REVERSED, receiptId: id(21) });
    expect(currentStatute(snapshot)!.version).toBe(2);
    expect(isQuotaActive(snapshot, QUOTA)).toBe(true);
    expect(snapshot.quotas[0]!.statuteId).toBe(STATUTE);
  });

  it('indexes repeated selectors once without stale global caches or sharing mutable input', () => {
    const snapshot = empty();
    withStatute(snapshot);
    const payment = receive(snapshot, 10, '2500', [{ poolId: POOL, amountCents: '2500' }]);
    confirmQuota(snapshot);
    const original = createFinancialView(snapshot);
    expect(original.finance).toEqual(computeFinance(snapshot));
    expect(original.statute).toEqual(currentStatute(snapshot));
    expect(original.personPoolFunding(POOL, PERSON)).toBe('2500');
    expect(original.isQuotaActive(QUOTA)).toBe(true);
    reverse(snapshot, payment);
    snapshot.revocations.push({ id: id(30), groupId: GROUP, quotaId: QUOTA, reason: 'Pagamento estornado.', revokedAt: REVERSED, receiptId: snapshot.movements.at(-1)!.receiptId });
    const revised = createFinancialView(snapshot);
    expect(revised.finance.cashCents).toBe('0');
    expect(revised.personPoolFunding(POOL, PERSON)).toBe('0');
    expect(revised.isQuotaActive(QUOTA)).toBe(false);
    expect(original.personPoolFunding(POOL, PERSON)).toBe('2500');
    expect(original.isQuotaActive(QUOTA)).toBe(true);
    expect(() => original.personPoolFunding('invalid', PERSON)).toThrow();
  });
});

describe('immutable full reversal', () => {
  it('compensates every pool allocation without deleting received facts or history', () => {
    const snapshot = empty();
    const paymentId = receive(snapshot, 10, '10000', [{ poolId: POOL, amountCents: '4000' }, { poolId: OTHER_POOL, amountCents: '3000' }]);
    reverse(snapshot, paymentId);
    expect(computeFinance(snapshot)).toEqual({ cashCents: '0', allocatedCents: '0', unallocatedCents: '0', pools: { [POOL]: { allocatedCents: '0' }, [OTHER_POOL]: { allocatedCents: '0' } } });
    expect(personPoolFunding(snapshot, POOL, PERSON)).toBe('0');
    expect(snapshot.payments).toHaveLength(1);
    expect(snapshot.allocations).toHaveLength(2);
    expect(snapshot.movements).toHaveLength(6);
  });

  it('requires quota revocation after funding disappears and a new human confirmation after repayment', () => {
    const snapshot = empty();
    withStatute(snapshot);
    const paymentId = receive(snapshot, 10, '2500', [{ poolId: POOL, amountCents: '2500' }]);
    confirmQuota(snapshot);
    reverse(snapshot, paymentId);
    expect(() => validateFinancialSnapshot(snapshot)).toThrow('revogação explícita');
    snapshot.revocations.push({ id: id(30), groupId: GROUP, quotaId: QUOTA, reason: 'Funding desfeito.', revokedAt: REVERSED, receiptId: snapshot.movements.at(-1)!.receiptId });
    expect(isQuotaActive(snapshot, QUOTA)).toBe(false);
    receive(snapshot, 11, '2500', [{ poolId: POOL, amountCents: '2500' }], PERSON, '2026-10-07T15:00:00.000Z');
    expect(isQuotaActive(snapshot, QUOTA)).toBe(false);
    snapshot.quotas.push({ ...snapshot.quotas[0]!, id: id(31), confirmedAt: '2026-10-07T16:00:00.000Z', receiptId: id(32) });
    expect(isQuotaActive(snapshot, id(31))).toBe(true);
    expect(isQuotaActive(snapshot, QUOTA)).toBe(false);
  });

  it.each(['missing compensation', 'wrong receipt', 'partial reversal', 'double reversal', 'orphan compensation'])('rejects %s', (scenario) => {
    const snapshot = empty();
    const paymentId = receive(snapshot, 10, '2500', [{ poolId: POOL, amountCents: '2500' }]);
    reverse(snapshot, paymentId);
    const paymentReversal = snapshot.movements.find((movement) => movement.kind === 'payment-reversed')!;
    if (scenario === 'missing compensation') snapshot.movements.pop();
    if (scenario === 'wrong receipt') snapshot.movements.at(-1)!.receiptId = id(98);
    if (scenario === 'partial reversal') paymentReversal.amountCents = '-2499';
    if (scenario === 'double reversal') snapshot.movements.push({ ...paymentReversal, id: id(97) });
    if (scenario === 'orphan compensation') snapshot.movements = snapshot.movements.filter((movement) => movement.kind !== 'payment-reversed');
    expect(() => validateFinancialSnapshot(snapshot)).toThrow(DomainValidationError);
  });
});

describe('complete snapshot integrity', () => {
  it.each(['other group', 'other person', 'excess allocations', 'missing ledger', 'double ledger', 'negative receipt', 'orphan movement', 'repeated proposal', 'repeated bank reference'])('rejects %s', (scenario) => {
    const snapshot = empty();
    receive(snapshot, 10, '2500', [{ poolId: POOL, amountCents: '2500' }]);
    if (scenario === 'other group') snapshot.payments[0]!.groupId = OTHER_GROUP;
    if (scenario === 'other person') snapshot.allocations[0]!.personId = OTHER_PERSON;
    if (scenario === 'excess allocations') snapshot.allocations[0]!.amountCents = '2501';
    if (scenario === 'missing ledger') snapshot.movements.shift();
    if (scenario === 'double ledger') snapshot.movements.push({ ...snapshot.movements[0]!, id: id(95) });
    if (scenario === 'negative receipt') snapshot.movements[0]!.amountCents = '-2500';
    if (scenario === 'orphan movement') snapshot.movements[0]!.paymentId = id(95);
    if (scenario === 'repeated proposal') { receive(snapshot, 11, '100'); snapshot.payments[1]!.sourceProposalId = snapshot.payments[0]!.sourceProposalId; }
    if (scenario === 'repeated bank reference') { receive(snapshot, 11, '100'); snapshot.payments[0]!.bankReference = 'REF'; snapshot.payments[1]!.bankReference = ' REF '; }
    expect(() => validateFinancialSnapshot(snapshot)).toThrow(DomainValidationError);
  });

  it.each(['missing statute', 'missing acceptance', 'duplicated active right', 'orphan revocation'])('rejects %s', (scenario) => {
    const snapshot = empty();
    withStatute(snapshot);
    receive(snapshot, 10, '2500', [{ poolId: POOL, amountCents: '2500' }]);
    confirmQuota(snapshot);
    if (scenario === 'missing statute') snapshot.statutes = [];
    if (scenario === 'missing acceptance') snapshot.acceptances = [];
    if (scenario === 'duplicated active right') snapshot.quotas.push({ ...snapshot.quotas[0]!, id: id(91) });
    if (scenario === 'orphan revocation') snapshot.revocations.push({ id: id(92), groupId: GROUP, quotaId: id(93), reason: 'Teste.', revokedAt: REVERSED, receiptId: id(94) });
    expect(() => validateFinancialSnapshot(snapshot)).toThrow(DomainValidationError);
  });

  it('rejects omitted arrays and duplicate immutable fact IDs', () => {
    const snapshot = empty();
    expect(() => validateFinancialSnapshot({ ...snapshot, payments: undefined })).toThrow();
    receive(snapshot, 10, '1');
    snapshot.payments.push({ ...snapshot.payments[0]! });
    expect(() => validateFinancialSnapshot(snapshot)).toThrow('duplicado');
  });

  it.each(['missing version', 'earlier publication'])('rejects statute history with %s', (scenario) => {
    const snapshot = empty();
    withStatute(snapshot);
    snapshot.statutes.push({
      ...snapshot.statutes[0]!, id: id(90), version: scenario === 'missing version' ? 3 : 2,
      sourceGroupVersion: 2, publishedAt: scenario === 'earlier publication' ? '2026-10-07T11:00:00.000Z' : CONFIRMED, receiptId: id(91),
    });
    expect(() => validateFinancialSnapshot(snapshot)).toThrow(DomainValidationError);
  });
});

describe('financial receipts', () => {
  const accepted = () => ({ apiVersion: 'v1', idempotencyKey: id(99), groupId: GROUP, status: 'accepted', groupRevision: 0, message: null, confirmedAt: CONFIRMED, snapshot: empty() });

  it('validates accepted receipts and allows conflicts with a newer complete snapshot', () => {
    expect(validateFinancialReceipt(accepted())).toEqual(accepted());
    const conflict = { ...accepted(), status: 'conflict', confirmedAt: null, message: 'O grupo mudou.' };
    expect(validateFinancialReceipt(conflict)).toEqual(conflict);
    expect(validateFinancialReceipt({ ...conflict, status: 'rejected', snapshot: null })).toEqual({ ...conflict, status: 'rejected', snapshot: null });
  });

  it('cannot claim success without facts and confirmation time, or mix groups and revisions', () => {
    expect(() => validateFinancialReceipt({ ...accepted(), snapshot: null })).toThrow();
    expect(() => validateFinancialReceipt({ ...accepted(), confirmedAt: null })).toThrow();
    expect(() => validateFinancialReceipt({ ...accepted(), status: 'rejected' })).toThrow();
    expect(() => validateFinancialReceipt({ ...accepted(), snapshot: { ...empty(), groupId: OTHER_GROUP } })).toThrow();
    expect(() => validateFinancialReceipt({ ...accepted(), groupRevision: 1 })).toThrow();
  });
});
