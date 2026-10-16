import { describe, expect, it } from 'vitest';
import type { LeftoverPolicy, OfficialPrizeEntitlement, PoolSettlementBalance, SettlementAction, SettlementRecord, SettlementSnapshot } from './index';
import { buildSettlementFact, canonicalManifest, computeSettlement,createRedemptionDeadline, createSettlementView, keptPrize, redemptionAlerts, redemptionCountdown, settlementStatement, sha256Hex, validateRedemptionDeadline, validateSettlementActionContext, validateSettlementCommand, validateSettlementReceipt, validateSettlementSnapshot } from './index';
import { fixtureId, manualResult, REG_GROUP, REG_POOL, registrationManifest, registrationSnapshot, resultSnapshot } from './registration.test-fixtures';

type Act<T extends SettlementAction['type']> = Extract<SettlementAction, { type: T }>;
const A = fixtureId(20), B = fixtureId(21), REPORT = fixtureId(4000), RESULT = fixtureId(5001), EVIDENCE = [fixtureId(3000)], START = 20;
const FAMILY = { expense_confirm: 'expenses', prize_confirm: 'prizes', redemption_record: 'redemptions', redemption_reverse: 'redemptions', distribution_record: 'distributions', distribution_reverse: 'distributions', pool_settle: 'closures', pool_reopen: 'closures' } as const;
const time = (revision: number): string => `2026-10-08T16:${revision.toString().padStart(2, '0')}:00.000Z`;
const next = (s: SettlementSnapshot): string => time(s.groupRevision + 1);
const pool = (s: SettlementSnapshot) => createSettlementView(s).pool(REG_POOL)!;
const person = (s: SettlementSnapshot, id: string) => pool(s).persons.find((p) => p.personId === id)!;

/** Expanded Mega game (7 numbers, 2 × 2100 contributed) whose calculated prize against 1..6 is 106000; the frozen plan's leftover goes to the group unless a policy is given. A limit string freezes groupPrizeLimitCents; null removes the key, as in a plan locked before it existed. */
function base(mode: 'internal' | 'official' = 'internal', expanded = true, leftoverPolicy?: LeftoverPolicy, groupPrizeLimitCents?: string | null): SettlementSnapshot {
  const manifest = registrationManifest(mode, expanded), cut = { groupRevision: START };
  if (leftoverPolicy || groupPrizeLimitCents !== undefined) { if (leftoverPolicy) manifest.content.plan.leftoverPolicy = leftoverPolicy; if (typeof groupPrizeLimitCents === 'string') manifest.content.plan.groupPrizeLimitCents = groupPrizeLimitCents; else if (groupPrizeLimitCents === null) delete manifest.content.plan.groupPrizeLimitCents; manifest.canonical = canonicalManifest(manifest.content); manifest.sha256 = sha256Hex(manifest.canonical); }
  return { groupId: REG_GROUP, groupRevision: START, financial: { ...structuredClone(manifest.content.financial), ...cut }, registration: { ...registrationSnapshot(manifest), ...cut }, results: { ...resultSnapshot(), ...cut }, expenses: [], prizes: [], redemptions: [], distributions: [], closures: [] };
}
function fact(s: SettlementSnapshot, action: SettlementAction, expectedRevision = s.groupRevision): SettlementRecord {
  const revision = s.groupRevision + 1;
  return buildSettlementFact(s, { apiVersion: 'v1', idempotencyKey: fixtureId(7000 + revision), groupId: REG_GROUP, expectedRevision, action }, { id: fixtureId(8000 + revision), receiptId: fixtureId(8100 + revision), confirmedAt: time(revision), groupRevision: revision });
}
function apply(s: SettlementSnapshot, action: SettlementAction): SettlementSnapshot {
  const record = fact(s, action), revision = record.groupRevision;
  const out: SettlementSnapshot = { ...s, groupRevision: revision, financial: { ...s.financial, groupRevision: revision }, registration: { ...s.registration, groupRevision: revision }, results: { ...s.results, groupRevision: revision }, expenses: [...s.expenses], prizes: [...s.prizes], redemptions: [...s.redemptions], distributions: [...s.distributions], closures: [...s.closures] };
  (out[FAMILY[action.type]] as SettlementRecord[]).push(record);
  return out;
}
const expense = (s: SettlementSnapshot, over: Partial<Act<'expense_confirm'>> = {}): Act<'expense_confirm'> => ({ type: 'expense_confirm', poolId: REG_POOL, poolVersion: s.groupRevision, registrationReportId: REPORT, supersedesId: null, betCostCents: '4200', feeCents: '0', evidenceIds: EVIDENCE, sourceReference: 'Comprovante sintético', reason: '', ...over });
const prize = (s: SettlementSnapshot, amountCents = '106000', officialEntitlements: OfficialPrizeEntitlement[] = []): Act<'prize_confirm'> => ({ type: 'prize_confirm', poolId: REG_POOL, poolVersion: s.groupRevision, registrationReportId: REPORT, resultId: RESULT, supersedesId: null, amountCents, officialEntitlements, evidenceIds: EVIDENCE, sourceReference: 'Conferência sintética', reason: 'Conferido pelo organizador.', redemptionDeadline: createRedemptionDeadline('mega-sena', '2026-10-08') });
const redeem = (s: SettlementSnapshot, amountCents: string, personId = A): Act<'redemption_record'> => ({ type: 'redemption_record', poolId: REG_POOL, poolVersion: s.groupRevision, prizeConfirmationId: s.prizes.at(-1)!.id, personId, amountCents, evidenceIds: EVIDENCE, sourceReference: 'Extrato sintético', eventAt: next(s), reason: '' });
const unredeem = (s: SettlementSnapshot, redemptionId: string): Act<'redemption_reverse'> => ({ type: 'redemption_reverse', poolId: REG_POOL, poolVersion: s.groupRevision, redemptionId, evidenceIds: EVIDENCE, sourceReference: 'Estorno sintético', eventAt: next(s), reason: 'Lançado em duplicidade.' });
const pay = (s: SettlementSnapshot, personId: string, amountCents: string, kind: 'prize-payment' | 'contribution-refund' = 'prize-payment'): Act<'distribution_record'> => ({ type: 'distribution_record', poolId: REG_POOL, poolVersion: s.groupRevision, personId, kind, amountCents, evidenceIds: EVIDENCE, sourceReference: 'Pix sintético', eventAt: next(s), reason: 'Pagamento combinado.' });
const unpay = (s: SettlementSnapshot, distributionId: string): Act<'distribution_reverse'> => ({ type: 'distribution_reverse', poolId: REG_POOL, poolVersion: s.groupRevision, distributionId, evidenceIds: EVIDENCE, sourceReference: 'Devolução sintética', eventAt: next(s), reason: 'Pix devolvido.' });
const settle = (s: SettlementSnapshot, pendingExplanation = ''): Act<'pool_settle'> => ({ type: 'pool_settle', poolId: REG_POOL, poolVersion: s.groupRevision, registrationReportId: REPORT, prizeConfirmationId: s.prizes.at(-1)?.id ?? null, expenseConfirmationId: s.expenses.at(-1)?.id ?? null, leftoverDisposition: 'group-reserve', pendingExplanation, reason: 'Fechamento sintético.' });
function entitlements(s: SettlementSnapshot, amounts = ['60000', '46000']): OfficialPrizeEntitlement[] {
  const item = s.registration.reports[0]!.items[0]!;
  return item.observed!.officialAssignments!.map((a, i) => ({ plannedTicketKey: item.plannedTicketKey, quotaId: a.quotaId, personId: a.personId, officialQuotas: a.officialQuotas, amountCents: amounts[i]!, evidenceIds: EVIDENCE }));
}
const withPrize = (amountCents = '106000'): SettlementSnapshot => apply(base(), prize(base(), amountCents));
const redeemed = (amountCents = '106000'): SettlementSnapshot => { const s = withPrize(amountCents); return apply(s, redeem(s, amountCents)); };

describe('settlement commands', () => {
  it('accepts a canonical command and rejects non-canonical cents or unknown actions', () => {
    const command = { apiVersion: 'v1', idempotencyKey: fixtureId(7000), groupId: REG_GROUP, expectedRevision: START, action: expense(base()) };
    expect(validateSettlementCommand(command).action).toEqual(expense(base()));
    expect(() => validateSettlementCommand({ ...command, action: expense(base(), { feeCents: '1.50' }) })).toThrow('Centavos devem ser uma string inteira canônica.');
    expect(() => validateSettlementCommand({ ...command, action: { ...expense(base()), type: 'prize_delete' } })).toThrow('Ação de apuração ou encerramento não suportada.');
  });
});

describe('calculated, confirmed, redeemed, right, paid and pending are distinct facts', () => {
  it('a calculated prize creates no money until it is confirmed, redeemed and paid', () => {
    let s = base();
    expect(pool(s)).toMatchObject({ calculatedPrizeCents: '106000', confirmedPrizeCents: null, redeemedCents: '0', organizerCashCents: '4200', unredeemedPrizeCents: null });
    expect(person(s, A).prizeRightCents).toBeNull();
    s = apply(s, prize(s));
    expect(pool(s)).toMatchObject({ confirmedPrizeCents: '106000', redeemedCents: '0', organizerCashCents: '4200', unredeemedPrizeCents: '106000', unpaidPrizeCents: '106000' });
    expect(person(s, A)).toMatchObject({ prizeRightCents: '53000', prizeReceivedCents: '0', prizePendingCents: '53000' });
    s = apply(s, redeem(s, '106000'));
    expect(pool(s)).toMatchObject({ organizerRedeemedCents: '106000', organizerCashCents: '110200', unredeemedPrizeCents: '0', unpaidPrizeCents: '106000' });
    s = apply(s, pay(s, A, '20000'));
    expect(person(s, A)).toMatchObject({ prizeRightCents: '53000', prizeReceivedCents: '20000', prizePendingCents: '33000' });
    expect(pool(s)).toMatchObject({ prizePaidCents: '20000', unpaidPrizeCents: '86000', organizerCashCents: '90200' });
  });
});

describe('internal split', () => {
  it('uses largest remainder with the tie broken by frozen personId, never losing or creating a cent', () => {
    // 106001 / 2: rounding each half up gives 106002, truncating gives 106000.
    const record = withPrize('106001').prizes[0]!;
    expect(record.rights.map((r) => [r.personId, r.amountCents])).toEqual([[A, '53001'], [B, '53000']]);
    expect(record.rights.reduce((sum, r) => sum + BigInt(r.amountCents), 0n)).toBe(106001n);
    expect(record.calculatedPrizeCents).toBe('106000');
  });
  it('breaks the tie by personId, not by the order of the frozen rights', () => {
    const manifest = registrationManifest('internal', true); manifest.content.plan.rights.reverse();
    manifest.canonical = canonicalManifest(manifest.content); manifest.sha256 = sha256Hex(manifest.canonical);
    const s = { ...base(), registration: { ...registrationSnapshot(manifest), groupRevision: START } };
    const record = fact(s, prize(s, '106001'));
    expect('rights' in record && record.rights.find((r) => r.personId === A)!.amountCents).toBe('53001');
  });
  it('rejects official entitlements invented by an internal agreement', () => {
    const invented: OfficialPrizeEntitlement[] = [{ plannedTicketKey: 'ticket-1', quotaId: fixtureId(1000), personId: A, officialQuotas: 1, amountCents: '106000', evidenceIds: EVIDENCE }];
    expect(() => fact(base(), prize(base(), '106000', invented))).toThrow('Acordo interno não inventa recibos oficiais.');
  });
});

describe('official mode', () => {
  it('takes rights and amounts from the observed receipts, not from a proportional split', () => {
    const s = base('official'), record = fact(s, prize(s, '106000', entitlements(s)));
    expect('rights' in record && record.rights.map((r) => [r.personId, r.amountCents])).toEqual([[A, '60000'], [B, '46000']]);
  });
  it('requires an exact match with the receipts and their sum', () => {
    const s = base('official'), wrong = entitlements(s); wrong[1] = { ...wrong[1]!, officialQuotas: 2 };
    expect(() => fact(s, prize(s, '106000', wrong))).toThrow('Valores oficiais exigem correspondência completa e exata com os recibos observados.');
    expect(() => fact(s, prize(s, '106000', entitlements(s).slice(0, 1)))).toThrow('Valores oficiais exigem correspondência completa e exata com os recibos observados.');
    expect(() => fact(s, prize(s, '106001', entitlements(s)))).toThrow('Prêmio oficial deve somar exatamente os valores dos recibos individuais.');
  });
});

describe('redemption', () => {
  it('internal redemption belongs to the frozen holder, enters the organizer cash and may be partial', () => {
    let s = withPrize();
    expect(() => fact(s, redeem(s, '50000', B))).toThrow('Resgate interno pertence ao titular congelado.');
    s = apply(s, redeem(s, '50000'));
    expect(s.redemptions[0]).toMatchObject({ ownership: 'organizer', direction: 'received', amountCents: '50000' });
    expect(pool(s)).toMatchObject({ organizerRedeemedCents: '50000', individualRedeemedCents: '0', unredeemedPrizeCents: '56000', organizerCashCents: '54200' });
  });
  it('official individual redemption stays out of the organizer cash', () => {
    let s = base('official');
    s = apply(s, prize(s, '106000', entitlements(s)));
    s = apply(s, redeem(s, '46000', B));
    expect(s.redemptions[0]!.ownership).toBe('individual');
    expect(pool(s)).toMatchObject({ organizerRedeemedCents: '0', individualRedeemedCents: '46000', organizerCashCents: '4200', unredeemedPrizeCents: '60000', unpaidPrizeCents: '60000' });
    expect(person(s, B)).toMatchObject({ prizeRightCents: '46000', prizeReceivedCents: '46000', prizePendingCents: '0' });
    expect(computeSettlement(s)).toMatchObject({ organizerRedeemedCents: '0', individualRedeemedCents: '46000', organizerCashCents: '4200' });
  });
  it('rejects a redemption above the confirmed prize', () => {
    const s = withPrize();
    expect(() => fact(s, redeem(s, '106001'))).toThrow('Recebimentos/pagamentos não reconciliam com o prêmio confirmado e resgate.');
  });
  it('a reversal references the original, keeps it and cannot be repeated', () => {
    let s = withPrize();
    s = apply(s, redeem(s, '50000'));
    s = apply(s, unredeem(s, s.redemptions[0]!.id));
    expect(s.redemptions).toHaveLength(2);
    expect(s.redemptions[1]).toMatchObject({ direction: 'reversed', reversesId: s.redemptions[0]!.id, amountCents: '-50000', ownership: 'organizer' });
    expect(pool(s)).toMatchObject({ redeemedCents: '0', unredeemedPrizeCents: '106000', organizerCashCents: '4200' });
    expect(() => fact(s, unredeem(s, s.redemptions[0]!.id))).toThrow('Compensação exige recebimento positivo anterior ainda não compensado.');
  });
});

describe('distribution', () => {
  it('cannot exceed the internally redeemed cash available (preview and build agree)', () => {
    const s = redeemed('106000'), partial = withPrize(), partialRedeemed = apply(partial, redeem(partial, '10000'));
    expect(() => validateSettlementActionContext(partialRedeemed, pay(partialRedeemed, A, '10001'), next(partialRedeemed))).toThrow('Pagamento não pode exceder direito e resgate interno disponíveis.');
    expect(() => fact(partialRedeemed, pay(partialRedeemed, A, '10001'))).toThrow('Pagamento não pode exceder direito e resgate interno disponíveis.');
    expect(() => validateSettlementActionContext(s, pay(s, A, '10001'), next(s))).not.toThrow();
  });
  it("cannot exceed the person's right", () => {
    const s = redeemed('106000');
    expect(() => fact(s, pay(s, A, '53001'))).toThrow('Pagamento não pode exceder direito e resgate interno disponíveis.');
    expect(() => fact(s, pay(s, A, '53000'))).not.toThrow();
  });
  it('a returned payment compensates the original without deleting it', () => {
    let s = redeemed('106000');
    s = apply(s, pay(s, A, '20000'));
    s = apply(s, unpay(s, s.distributions[0]!.id));
    expect(s.distributions.map((d) => [d.direction, d.amountCents, d.reversesId])).toEqual([['paid', '20000', null], ['returned', '-20000', s.distributions[0]!.id]]);
    expect(person(s, A)).toMatchObject({ prizeReceivedCents: '0', prizePendingCents: '53000' });
    expect(pool(s).prizePaidCents).toBe('0');
    expect(() => fact(s, unpay(s, s.distributions[0]!.id))).toThrow('Retorno exige pagamento positivo anterior ainda não compensado.');
  });
});

describe('expense confirmation', () => {
  it('confirms bet cost plus fee as the total and asks a reason when it differs from the receipt', () => {
    const s = base();
    expect(() => fact(s, expense(s, { feeCents: '150' }))).toThrow('Correção ou custo diferente/desconhecido no comprovante exige razão humana.');
    const record = fact(s, expense(s, { feeCents: '150', reason: 'Tarifa cobrada na lotérica.' }));
    expect(record).toMatchObject({ betCostCents: '4200', feeCents: '150', totalCostCents: '4350', version: 1, supersedesId: null });
  });
  it('requires the current registration report', () => {
    const s = base();
    expect(() => fact(s, expense(s, { registrationReportId: fixtureId(4001) }))).toThrow('Despesa exige relatório atual e revisão explícita da última confirmação.');
  });
  it('superseding a previous expense is explicit and needs a reason', () => {
    let s = apply(base(), expense(base()));
    const first = s.expenses[0]!.id;
    expect(() => fact(s, expense(s))).toThrow('Despesa exige relatório atual e revisão explícita da última confirmação.');
    expect(() => fact(s, expense(s, { supersedesId: first }))).toThrow('Correção ou custo diferente/desconhecido no comprovante exige razão humana.');
    s = apply(s, expense(s, { supersedesId: first, betCostCents: '4000', reason: 'Recibo corrigido.' }));
    expect(s.expenses.map((e) => e.version)).toEqual([1, 2]);
    expect(pool(s)).toMatchObject({ expenseConfirmationId: s.expenses[1]!.id, confirmedExpenseCents: '4000', expenseConfirmationPending: false });
  });
});

describe('versioning and closed pools', () => {
  it('counts version per kind per pool and orders facts by group revision', () => {
    let s = apply(base(), expense(base()));
    s = apply(s, prize(s));
    s = apply(s, expense(s, { supersedesId: s.expenses[0]!.id, reason: 'Revisão.' }));
    expect(s.expenses.map((e) => [e.version, e.groupRevision])).toEqual([[1, 21], [2, 23]]);
    expect(s.prizes.map((p) => [p.version, p.groupRevision])).toEqual([[1, 22]]);
  });
  it('the observed poolVersion must advance past the report and every previous decision', () => {
    const s = apply(base(), expense(base()));
    expect(() => fact(s, { ...prize(s), poolVersion: START })).toThrow('Versão observada precisa avançar decisões anteriores deste bolão.');
    expect(() => fact(base(), { ...expense(base()), poolVersion: 2 })).toThrow('Apuração exige registro humano já confirmado e versão atual observada do bolão.');
  });
  it('rejects a command observed on a stale group revision', () => {
    const s = apply(base(), expense(base()));
    expect(() => fact(s, prize(s), s.groupRevision - 1)).toThrow('Fato exige revisão observada e avanço único do grupo.');
  });
  it('a closed pool rejects money changes until a human reopens it', () => {
    let s = apply(base(), expense(base()));
    s = apply(s, settle(s, 'Prêmio calculado ainda não confirmado.'));
    expect(pool(s).closed).toBe(true);
    expect(() => fact(s, prize(s))).toThrow('Bolão encerrado exige reabertura humana antes de nova alteração financeira.');
    s = apply(s, { type: 'pool_reopen', poolId: REG_POOL, poolVersion: s.groupRevision, closureId: s.closures[0]!.id, reason: 'Prêmio conferido depois.' });
    expect(s.closures[1]).toMatchObject({ direction: 'reopened', previousClosureId: s.closures[0]!.id });
    expect(pool(apply(s, prize(s))).confirmedPrizeCents).toBe('106000');
  });
});

describe('snapshot integrity (SQL and core parity guard)', () => {
  function history(): SettlementSnapshot {
    let s = apply(base(), expense(base()));
    s = apply(s, prize(s, '106001'));
    s = apply(s, redeem(s, '106001'));
    s = apply(s, pay(s, A, '53001'));
    return apply(s, settle(s, 'Parte de B ainda não paga.'));
  }
  it('accepts a consistent history rebuilt fact by fact', () => {
    const s = history();
    expect(validateSettlementSnapshot(s).closures[0]!.reconciliation.organizerCashCents).toBe('53000');
  });
  it('rejects one cent of drift in any derived field', () => {
    const drifts: Array<(s: SettlementSnapshot) => void> = [
      (s) => { s.prizes[0]!.rights[0]!.amountCents = '53000'; s.prizes[0]!.rights[1]!.amountCents = '53001'; },
      (s) => { s.expenses[0]!.totalCostCents = '4201'; },
      (s) => { s.closures[0]!.reconciliation.organizerCashCents = '53001'; },
    ];
    for (const drift of drifts) {
      const s = structuredClone(history()); drift(s);
      expect(() => validateSettlementSnapshot(s)).toThrow('Fato, direito, compensação ou reconciliação diverge da reconstrução independente.');
    }
  });
  it('a closure recorded before groupReserveCents existed is rebuilt under the old leftover rule', () => {
    // Budget 4200, expense 4000: leftover 200. Old rule: split 100/100 over A and B (100 units each) as refund rights, so 0 + 100 each and 100 + 100 = 200 pending.
    let s = base('internal', true, 'group-credit');
    s = apply(s, expense(s, { betCostCents: '4000', reason: 'Uma aposta saiu mais barata.' }));
    s = apply(s, settle(s, 'Prêmio ainda aberto.'));
    const legacy = (change: (reconciliation: Partial<PoolSettlementBalance>) => void): SettlementSnapshot => {
      const old = structuredClone(s), reconciliation = old.closures[0]!.reconciliation as Partial<PoolSettlementBalance>;
      delete reconciliation.groupReserveCents; reconciliation.refundPendingCents = '200';
      for (const p of reconciliation.persons!) { p.refundRightCents = '100'; p.refundPendingCents = '100'; }
      change(reconciliation);
      return old;
    };
    expect(validateSettlementSnapshot(s).closures[0]!.reconciliation).toMatchObject({ groupReserveCents: '200', refundPendingCents: '0' });
    expect(validateSettlementSnapshot(legacy(() => {})).closures).toHaveLength(1);
    const message = 'Fato, direito, compensação ou reconciliação diverge da reconstrução independente.';
    expect(() => validateSettlementSnapshot(legacy((r) => { r.persons![0]!.refundRightCents = '101'; }))).toThrow(message);
    expect(() => validateSettlementSnapshot(legacy((r) => { r.groupReserveCents = '200'; }))).toThrow(message);
  });
  it('an accepted receipt must reference exactly one fact of its group revision', () => {
    const s = history(), last = s.closures[0]!, first = s.expenses[0]!;
    const receipt = { apiVersion: 'v1', idempotencyKey: fixtureId(7999), receiptId: last.receiptId, groupId: REG_GROUP, status: 'accepted', groupRevision: s.groupRevision, message: null, confirmedAt: last.confirmedAt, snapshot: s };
    expect(validateSettlementReceipt(receipt).receiptId).toBe(last.receiptId);
    expect(() => validateSettlementReceipt({ ...receipt, receiptId: first.receiptId })).toThrow('Aceite deve referenciar exatamente um fato da revisão confirmada.');
  });
  it('a conflicting result version arriving after a redemption and a payment does not invalidate the history', () => {
    let s = withPrize(); s = apply(s, redeem(s, '60000')); s = apply(s, pay(s, A, '30000'));
    const revision = s.groupRevision + 1, late = manualResult({ lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-08', drawnNumbers: [1, 2, 3, 4, 5, 7], payouts: null }, 2);
    const c: SettlementSnapshot = { ...s, groupRevision: revision, financial: { ...s.financial, groupRevision: revision }, registration: { ...s.registration, groupRevision: revision }, results: { ...s.results, groupRevision: revision, results: [...s.results.results, late] } };
    expect(validateSettlementSnapshot(c).distributions).toHaveLength(1);
    expect(pool(c)).toMatchObject({ resultConflict: true, organizerRedeemedCents: '60000', prizePaidCents: '30000' });
    expect(() => validateSettlementActionContext(c, redeem(c, '1000'), next(c))).toThrow('Resgate exige prêmio atual confirmado e fontes conferidas sem conflito.');
  });
});

describe('prize kept in the group cash (internal agreement limit)', () => {
  // Budget 4200 (A and B hold 100 of 200 units each); confirmed expenses 4000 leave a group-credit leftover of 4200 - 4000 = 200.
  const kept = (limit: string | null, amountCents: string, expenses = true): SettlementSnapshot => {
    let s = base('internal', true, 'group-credit', limit);
    if (expenses) s = apply(s, expense(s, { betCostCents: '4000', reason: 'Uma aposta saiu mais barata.' }));
    return apply(s, prize(s, amountCents));
  };
  it('a confirmed prize under the limit is split among no one and joins the group reserve', () => {
    // Limit 110000, prize 106000 <= 110000: rights 0 + 0; reserve = leftover 200 + kept prize 106000 = 106200.
    // Owed to no one: unpaid = 106000 - 0 paid - 106000 kept = 0; still to redeem from CAIXA: 106000 - 0 = 106000.
    const s = kept('110000', '106000');
    expect(s.prizes[0]!.rights.map((r) => [r.personId, r.amountCents])).toEqual([[A, '0'], [B, '0']]);
    expect([person(s, A).prizeRightCents, person(s, B).prizeRightCents, person(s, A).prizePendingCents]).toEqual(['0', '0', '0']);
    expect(pool(s)).toMatchObject({ confirmedPrizeCents: '106000', groupReserveCents: '106200', unpaidPrizeCents: '0', unredeemedPrizeCents: '106000' });
    expect(() => validateSettlementSnapshot(s)).not.toThrow();
    // Until it is redeemed the closing still needs an explanation; after redeeming 106000 (106000 - 106000 = 0 left) nothing is open.
    expect(() => fact(s, settle(s))).toThrow('Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.');
    const cash = apply(s, redeem(s, '106000'));
    expect(pool(cash)).toMatchObject({ unpaidPrizeCents: '0', unredeemedPrizeCents: '0' });
    expect(() => fact(cash, settle(cash))).not.toThrow();
    expect(() => fact(cash, pay(cash, A, '1'))).toThrow('Pagamento não pode exceder direito e resgate interno disponíveis.');
    // While expenses are unconfirmed the reserve stays unknown (null), kept prize or not.
    expect(pool(kept('110000', '106000', false))).toMatchObject({ groupReserveCents: null });
  });
  it('a prize exactly at the limit is kept (inclusive)', () => {
    // Limit 106000, prize 106000 <= 106000: rights 0 + 0; reserve = 200 + 106000 = 106200.
    const s = kept('106000', '106000');
    expect([person(s, A).prizeRightCents, person(s, B).prizeRightCents]).toEqual(['0', '0']);
    expect(pool(s)).toMatchObject({ groupReserveCents: '106200' });
  });
  it('a prize above the limit is split as usual and the reserve stays the leftover', () => {
    // Limit 105999, prize 106000 > 105999: 106000 / 200 units = 530 per unit, so 53000 each; reserve stays 200; unpaid = 106000 - 0 paid = 106000.
    const s = kept('105999', '106000');
    expect([person(s, A).prizeRightCents, person(s, B).prizeRightCents]).toEqual(['53000', '53000']);
    expect(pool(s)).toMatchObject({ groupReserveCents: '200', unpaidPrizeCents: '106000' });
  });
  it('a plan without the key keeps the old split and reserve', () => {
    const s = kept(null, '106000');
    expect('groupPrizeLimitCents' in s.registration.manifests[0]!.content.plan).toBe(false);
    expect([person(s, A).prizeRightCents, person(s, B).prizeRightCents]).toEqual(['53000', '53000']);
    expect(pool(s)).toMatchObject({ groupReserveCents: '200' });
  });
  it('only an internal plan with a string limit and a prize above zero keeps anything', () => {
    expect(keptPrize({ participationMode: 'internal', groupPrizeLimitCents: '110000' }, '106000')).toBe(106000n);
    expect(keptPrize({ participationMode: 'official', groupPrizeLimitCents: '110000' }, '106000')).toBe(0n);
    expect(keptPrize({ participationMode: 'internal', groupPrizeLimitCents: null }, '106000')).toBe(0n);
    expect(keptPrize({ participationMode: 'internal' }, '106000')).toBe(0n);
    expect(keptPrize({ participationMode: 'internal', groupPrizeLimitCents: '110000' }, '0')).toBe(0n);
    expect(keptPrize({ participationMode: 'internal', groupPrizeLimitCents: '110000' }, null)).toBe(0n);
  });
});
describe('organizer cash and statement', () => {
  it('organizer cash = net contributions + internal redemptions − confirmed expenses − net payments and refunds', () => {
    let s = apply(base('internal', true, 'refund-pro-rata'), expense(base(), { betCostCents: '4000', reason: 'Uma aposta saiu mais barata.' }));
    s = apply(s, prize(s, '106001'));
    s = apply(s, redeem(s, '106001'));
    s = apply(s, pay(s, A, '53001'));
    s = apply(s, pay(s, B, '20000'));
    s = apply(s, unpay(s, s.distributions[1]!.id));
    s = apply(s, pay(s, A, '100', 'contribution-refund'));
    const finance = computeSettlement(s);
    expect(finance).toMatchObject({ contributionCashCents: '4200', organizerRedeemedCents: '106001', confirmedExpenseCents: '4000', prizePaidCents: '53001', refundedCents: '100', organizerCashCents: '53100' });
    expect(finance.pools[REG_POOL]!).toMatchObject({ organizerCashCents: '53100', contributionSurplusCents: '200', groupReserveCents: '0', refundPendingCents: '100', unpaidPrizeCents: '53000' });
  });
  it('a planned reserve is not a confirmed expense', () => {
    const s = base();
    expect(s.registration.manifests[0]!.content.plan.totalCostCents).toBe('4200');
    expect(pool(s)).toMatchObject({ confirmedExpenseCents: null, expenseConfirmationPending: true, organizerCashCents: '4200', contributionSurplusCents: null, groupReserveCents: null, refundPendingCents: null });
  });
  it('a group-credit leftover becomes the group reserve, not refund rights; refund-pro-rata still splits it', () => {
    // Budget 4200, confirmed expenses 4000: the leftover is 4200 - 4000 = 200, and each of A and B holds 100 of 200 units.
    const confirmed = (policy: LeftoverPolicy) => { const s = base('internal', true, policy); return apply(s, expense(s, { betCostCents: '4000', reason: 'Uma aposta saiu mais barata.' })); };
    const split = confirmed('refund-pro-rata');
    expect(pool(split)).toMatchObject({ contributionSurplusCents: '200', groupReserveCents: '0', refundPendingCents: '200' });
    expect([person(split, A).refundRightCents, person(split, B).refundRightCents]).toEqual(['100', '100']);
    // group-credit: no share (0 + 0 = 0 of refund rights); the whole 200 is the reserve. Overpayment refunds are untouched.
    const credit = confirmed('group-credit');
    expect(pool(credit)).toMatchObject({ contributionSurplusCents: '200', groupReserveCents: '200', refundPendingCents: '0' });
    expect([person(credit, A).refundRightCents, person(credit, B).refundRightCents]).toEqual(['0', '0']);
    expect(() => fact(credit, pay(credit, A, '100', 'contribution-refund'))).toThrow('Devolução exige despesa atual confirmada e sobra própria disponível.');
    expect(pool(base('internal', true, 'group-credit'))).toMatchObject({ groupReserveCents: null, refundPendingCents: null });
  });
  it('a pool with no prize still closes with an explained, coherent group statement', () => {
    let s = base('internal', false);
    s = apply(s, expense(s, { betCostCents: '3000' }));
    expect(() => fact(s, settle(s))).toThrow('Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.');
    s = apply(s, settle(s, 'Nenhum acerto neste concurso.'));
    const statement = settlementStatement(s, REG_POOL);
    expect(statement.label).toBe('Demonstrativo do grupo');
    expect(statement.pool).toMatchObject({ calculatedPrizeCents: '0', confirmedPrizeCents: null, contributedCents: '3000', confirmedExpenseCents: '3000', organizerCashCents: '0', cashDeficitCents: '0', contributionSurplusCents: '0', groupReserveCents: '0', refundPendingCents: '0', closed: true });
    expect(statement.closure).toMatchObject({ direction: 'closed', leftoverDisposition: 'group-reserve', pendingExplanation: 'Nenhum acerto neste concurso.' });
  });
});

describe('redemption deadline and alerts', () => {
  it('defaults to 90 days and keeps a documented exception with source and reason', () => {
    const rule = createRedemptionDeadline('mega-sena', '2026-10-08');
    expect(rule).toMatchObject({ drawDate: '2026-10-08', deadlineDate: '2027-01-06', exception: null, verifiedAt: '2026-10-08' });
    const exception = { deadlineDate: '2027-02-01', sourceReference: 'Comunicado sintético', reason: 'Prorrogação documentada.' };
    expect(createRedemptionDeadline('mega-sena', '2026-10-08', exception)).toMatchObject({ deadlineDate: '2027-02-01', exception });
    expect(() => createRedemptionDeadline('mega-sena', '2026-10-08', { ...exception, deadlineDate: '2026-10-07' })).toThrow('Prazo documentado não pode preceder o sorteio.');
    expect(() => createRedemptionDeadline('mega-sena', '2026-10-08', { ...exception, reason: '' })).toThrow();
    expect(() => validateRedemptionDeadline({ ...rule, deadlineDate: '2027-01-07' })).toThrow('Prazo deve ser noventa dias ou a exceção documentada.');
  });
  it('prepares 30/15/7/1-day alerts on Brasília civil dates', () => {
    const alerts = redemptionAlerts(createRedemptionDeadline('mega-sena', '2026-10-08'), '2026-12-22');
    expect(alerts).toEqual([
      { daysBefore: 30, alertDate: '2026-12-07', status: 'overdue' },
      { daysBefore: 15, alertDate: '2026-12-22', status: 'due' },
      { daysBefore: 7, alertDate: '2026-12-30', status: 'upcoming' },
      { daysBefore: 1, alertDate: '2027-01-05', status: 'upcoming' },
    ]);
    expect(() => redemptionAlerts(createRedemptionDeadline('mega-sena', '2026-10-08'), '2026-12-22T02:00:00.000Z')).toThrow();
  });
  it('counts whole civil days to the deadline and alerts from the 30-day alert on', () => {
    const { deadlineDate } = createRedemptionDeadline('mega-sena', '2026-10-08');
    expect(redemptionCountdown(deadlineDate, '2026-10-14')).toEqual({ deadlineDate: '2027-01-06', daysLeft: 84, tone: 'normal' });
    expect([redemptionCountdown(deadlineDate, '2026-12-06').tone, redemptionCountdown(deadlineDate, '2026-12-07').tone]).toEqual(['normal', 'alert']);
    expect(redemptionCountdown(deadlineDate, '2026-12-30')).toEqual({ deadlineDate: '2027-01-06', daysLeft: 7, tone: 'alert' });
    expect(redemptionCountdown(deadlineDate, '2027-01-06')).toEqual({ deadlineDate: '2027-01-06', daysLeft: 0, tone: 'alert' });
    expect(redemptionCountdown(deadlineDate, '2027-01-08')).toEqual({ deadlineDate: '2027-01-06', daysLeft: -2, tone: 'overdue' });
    expect(() => redemptionCountdown(deadlineDate, '2026-12-22T02:00:00.000Z')).toThrow();
  });
});
