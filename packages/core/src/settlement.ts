import type { LotteryId } from './types';
import type { PoolManifest } from './planning-types';
import type { RegistrationReport } from './registration-types';
import type { ResultSnapshot } from './result-types';
import type { ExpenseConfirmation, OfficialPrizeEntitlement, PoolSettlement, PoolSettlementBalance, PrizeConfirmation, PrizeRedemption, RedemptionAlert, RedemptionDeadline, SettlementAction, SettlementCommand, SettlementDistribution, SettlementFact, SettlementFinance, SettlementPersonBalance, SettlementReceipt, SettlementRight, SettlementSnapshot, SettlementStatement } from './settlement-types';
import { canonicalJSON } from './canonical';
import { createFinancialView, validateFinancialSnapshot } from './financial';
import { LOTTERIES } from './lotteries';
import { distributeCents } from './money';
import { validatePlanFunding } from './planning';
import { validateRegistrationSnapshot } from './registration';
import { assessRegisteredPrizes } from './registered-prizes';
import { createResultView, currentResult, validateResultSnapshot } from './results';
import { planningInt, planningInvalid, planningList, planningMoney, planningOption, planningRecord, planningShape, planningText, planningUid } from './prepared-plans';
import { sourceDate, sourceTime } from './source-validation';

export const MAX_SETTLEMENT_COMMAND_BYTES = 1_048_576;
export const REDEMPTION_RULE_VERSION = 'caixa-redemption-90-days-2026-10-08-v1';
const BASE = ['id', 'groupId', 'poolId', 'version', 'groupRevision', 'poolVersion', 'confirmedAt', 'receiptId'] as const;
const NULL_ID = (value: unknown, field: string): string | null => value === null ? null : planningUid(value, field);
const max0 = (value: bigint): bigint => value > 0n ? value : 0n;
function unique<T>(values: T[], getId: (value: T) => string, field: string): T[] {
  if (new Set(values.map(getId)).size !== values.length) planningInvalid(field, 'Identificador repetido.');
  return values;
}
function ids(value: unknown, field: string, max = 100): string[] { return unique(planningList(value, field, max).map((id) => planningUid(id, field)), (id) => id, field); }
function opaque(value: unknown, field: string, required = true): string { return planningText(value, field, 2_000, required); }
function addDays(date: string, days: number): string {
  const instant = new Date(`${sourceDate(date, 'date')}T00:00:00.000Z`); instant.setUTCDate(instant.getUTCDate() + days);
  return sourceDate(instant.toISOString().slice(0, 10), 'date');
}
export function createRedemptionDeadline(lotteryId: LotteryId, drawDate: string, exception: RedemptionDeadline['exception'] = null): RedemptionDeadline {
  const rule = LOTTERIES[planningOption<LotteryId>(lotteryId, ['mega-sena', 'lotofacil', 'quina'], 'lotteryId')];
  const date = sourceDate(drawDate, 'drawDate');
  let validated: RedemptionDeadline['exception'] = null;
  if (exception !== null) {
    const value = planningRecord(exception, 'exception'); planningShape(value, ['deadlineDate', 'sourceReference', 'reason'], 'exception');
    validated = { deadlineDate: sourceDate(value.deadlineDate, 'deadlineDate'), sourceReference: opaque(value.sourceReference, 'sourceReference'), reason: opaque(value.reason, 'reason') };
    if (validated.deadlineDate < date) planningInvalid('deadlineDate', 'Prazo documentado não pode preceder o sorteio.');
  }
  return { ruleVersion: REDEMPTION_RULE_VERSION, sourceUrl: rule.sourceUrl, verifiedAt: '2026-10-08', drawDate: date, deadlineDate: validated?.deadlineDate ?? addDays(date, 90), exception: validated };
}
export function validateRedemptionDeadline(input: unknown): RedemptionDeadline {
  const source = planningRecord(input, 'redemptionDeadline'); planningShape(source, ['ruleVersion', 'sourceUrl', 'verifiedAt', 'drawDate', 'deadlineDate', 'exception'], 'redemptionDeadline');
  const lotteryId = (Object.keys(LOTTERIES) as LotteryId[]).find((id) => LOTTERIES[id].sourceUrl === source.sourceUrl);
  if (!lotteryId || source.ruleVersion !== REDEMPTION_RULE_VERSION || source.verifiedAt !== '2026-10-08') return planningInvalid('redemptionDeadline', 'Regra e fonte de prazo não suportadas.');
  const expected = createRedemptionDeadline(lotteryId, sourceDate(source.drawDate, 'drawDate'), source.exception as RedemptionDeadline['exception']);
  if (source.deadlineDate !== expected.deadlineDate) planningInvalid('deadlineDate', 'Prazo deve ser noventa dias ou a exceção documentada.');
  return expected;
}
/** Prepared local calendar alerts only. No messages, timers, or hidden current clock. */
export function redemptionAlerts(input: RedemptionDeadline, todayBrasiliaDate: string): RedemptionAlert[] {
  const rule = validateRedemptionDeadline(input), today = sourceDate(todayBrasiliaDate, 'todayBrasiliaDate');
  return ([30, 15, 7, 1] as const).map((daysBefore) => { const alertDate = addDays(rule.deadlineDate, -daysBefore); return { daysBefore, alertDate, status: today < alertDate ? 'upcoming' : today === alertDate ? 'due' : 'overdue' }; });
}
function officialEntitlements(input: unknown): OfficialPrizeEntitlement[] {
  return unique(planningList(input, 'officialEntitlements', 100_000).map((value) => {
    const row = planningRecord(value, 'entitlement'); planningShape(row, ['plannedTicketKey', 'quotaId', 'personId', 'officialQuotas', 'amountCents', 'evidenceIds'], 'entitlement');
    if (typeof row.plannedTicketKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(row.plannedTicketKey)) planningInvalid('plannedTicketKey', 'Chave inválida.');
    return { plannedTicketKey: row.plannedTicketKey, quotaId: planningUid(row.quotaId, 'quotaId'), personId: planningUid(row.personId, 'personId'), officialQuotas: planningInt(row.officialQuotas, 'officialQuotas', 1, 1_000_000), amountCents: planningMoney(row.amountCents, 'amountCents'), evidenceIds: ids(row.evidenceIds, 'evidenceIds') };
  }), (e) => `${e.plannedTicketKey}:${e.quotaId}`, 'officialEntitlements');
}
function action(input: unknown): SettlementAction {
  const value = planningRecord(input, 'action'), poolId = planningUid(value.poolId, 'poolId'), poolVersion = planningInt(value.poolVersion, 'poolVersion', 1);
  const common = ['type', 'poolId', 'poolVersion'];
  const evidence = (): string[] => ids(value.evidenceIds, 'evidenceIds');
  const reference = (): string => opaque(value.sourceReference, 'sourceReference');
  const eventAt = (): string => sourceTime(value.eventAt, 'eventAt');
  const reason = (required = true): string => opaque(value.reason, 'reason', required);
  if (value.type === 'expense_confirm') {
    planningShape(value, [...common, 'registrationReportId', 'supersedesId', 'betCostCents', 'feeCents', 'evidenceIds', 'sourceReference', 'reason'], 'action');
    const betCostCents = planningMoney(value.betCostCents, 'betCostCents'), feeCents = planningMoney(value.feeCents, 'feeCents');
    planningMoney((BigInt(betCostCents) + BigInt(feeCents)).toString(), 'totalCostCents');
    return { type: 'expense_confirm', poolId, poolVersion, registrationReportId: planningUid(value.registrationReportId, 'registrationReportId'), supersedesId: NULL_ID(value.supersedesId, 'supersedesId'), betCostCents, feeCents, evidenceIds: evidence(), sourceReference: reference(), reason: reason(false) };
  }
  if (value.type === 'prize_confirm') {
    planningShape(value, [...common, 'registrationReportId', 'resultId', 'supersedesId', 'amountCents', 'officialEntitlements', 'evidenceIds', 'sourceReference', 'reason', 'redemptionDeadline'], 'action');
    return { type: 'prize_confirm', poolId, poolVersion, registrationReportId: planningUid(value.registrationReportId, 'registrationReportId'), resultId: planningUid(value.resultId, 'resultId'), supersedesId: NULL_ID(value.supersedesId, 'supersedesId'), amountCents: planningMoney(value.amountCents, 'amountCents'), officialEntitlements: officialEntitlements(value.officialEntitlements), evidenceIds: evidence(), sourceReference: reference(), reason: reason(false), redemptionDeadline: value.redemptionDeadline === null ? null : validateRedemptionDeadline(value.redemptionDeadline) };
  }
  if (value.type === 'redemption_record') {
    planningShape(value, [...common, 'prizeConfirmationId', 'personId', 'amountCents', 'evidenceIds', 'sourceReference', 'eventAt', 'reason'], 'action');
    return { type: 'redemption_record', poolId, poolVersion, prizeConfirmationId: planningUid(value.prizeConfirmationId, 'prizeConfirmationId'), personId: planningUid(value.personId, 'personId'), amountCents: planningMoney(value.amountCents, 'amountCents', true), evidenceIds: evidence(), sourceReference: reference(), eventAt: eventAt(), reason: reason(false) };
  }
  if (value.type === 'redemption_reverse') {
    planningShape(value, [...common, 'redemptionId', 'evidenceIds', 'sourceReference', 'eventAt', 'reason'], 'action');
    return { type: 'redemption_reverse', poolId, poolVersion, redemptionId: planningUid(value.redemptionId, 'redemptionId'), evidenceIds: evidence(), sourceReference: reference(), eventAt: eventAt(), reason: reason() };
  }
  if (value.type === 'distribution_record') {
    planningShape(value, [...common, 'personId', 'kind', 'amountCents', 'evidenceIds', 'sourceReference', 'eventAt', 'reason'], 'action');
    return { type: 'distribution_record', poolId, poolVersion, personId: planningUid(value.personId, 'personId'), kind: planningOption(value.kind, ['prize-payment', 'contribution-refund'], 'kind'), amountCents: planningMoney(value.amountCents, 'amountCents', true), evidenceIds: evidence(), sourceReference: reference(), eventAt: eventAt(), reason: reason() };
  }
  if (value.type === 'distribution_reverse') {
    planningShape(value, [...common, 'distributionId', 'evidenceIds', 'sourceReference', 'eventAt', 'reason'], 'action');
    return { type: 'distribution_reverse', poolId, poolVersion, distributionId: planningUid(value.distributionId, 'distributionId'), evidenceIds: evidence(), sourceReference: reference(), eventAt: eventAt(), reason: reason() };
  }
  if (value.type === 'pool_settle') {
    planningShape(value, [...common, 'registrationReportId', 'prizeConfirmationId', 'expenseConfirmationId', 'leftoverDisposition', 'pendingExplanation', 'reason'], 'action');
    return { type: 'pool_settle', poolId, poolVersion, registrationReportId: planningUid(value.registrationReportId, 'registrationReportId'), prizeConfirmationId: NULL_ID(value.prizeConfirmationId, 'prizeConfirmationId'), expenseConfirmationId: NULL_ID(value.expenseConfirmationId, 'expenseConfirmationId'), leftoverDisposition: planningOption(value.leftoverDisposition, ['group-reserve', 'pending-refund'], 'leftoverDisposition'), pendingExplanation: opaque(value.pendingExplanation, 'pendingExplanation', false), reason: reason() };
  }
  if (value.type === 'pool_reopen') {
    planningShape(value, [...common, 'closureId', 'reason'], 'action');
    return { type: 'pool_reopen', poolId, poolVersion, closureId: planningUid(value.closureId, 'closureId'), reason: reason() };
  }
  return planningInvalid('type', 'Ação de apuração ou encerramento não suportada.');
}
export function validateSettlementCommand(input: unknown): SettlementCommand {
  const source = planningRecord(input, 'command'); planningShape(source, ['apiVersion', 'idempotencyKey', 'groupId', 'expectedRevision', 'action'], 'command');
  if (source.apiVersion !== 'v1') planningInvalid('apiVersion', 'Versão da API não suportada.');
  const command: SettlementCommand = { apiVersion: 'v1', idempotencyKey: planningUid(source.idempotencyKey, 'idempotencyKey'), groupId: planningUid(source.groupId, 'groupId'), expectedRevision: planningInt(source.expectedRevision, 'expectedRevision'), action: action(source.action) };
  if (new TextEncoder().encode(JSON.stringify(command)).length > MAX_SETTLEMENT_COMMAND_BYTES) planningInvalid('command', 'Comando de apuração excede 1 MiB.');
  return command;
}

function latest<T extends { poolId: string; version: number }>(values: T[], poolId: string): T | null { return values.filter((v) => v.poolId === poolId).reduce<T | null>((current, next) => !current || next.version > current.version ? next : current, null); }
function manifest(snapshot: SettlementSnapshot, poolId: string): PoolManifest {
  const value = latest(snapshot.registration.manifests, poolId);
  if (!value) return planningInvalid('poolId', 'Apuração exige manifesto confirmado.');
  return value;
}
function poolRights(prize: PrizeConfirmation | null): Map<string, bigint> {
  const byPerson = new Map<string, bigint>();
  for (const right of prize?.rights ?? []) byPerson.set(right.personId, (byPerson.get(right.personId) ?? 0n) + BigInt(right.amountCents));
  return byPerson;
}
function sum(values: { amountCents: string }[]): bigint { return values.reduce((total, value) => total + BigInt(value.amountCents), 0n); }
function projectPool(snapshot: SettlementSnapshot, poolId: string, reviewResults: ResultSnapshot = snapshot.results): PoolSettlementBalance {
  const frozen = manifest(snapshot, poolId), plan = frozen.content.plan, finance = createFinancialView(snapshot.financial);
  const report = latest(snapshot.registration.reports, poolId), expense = latest(snapshot.expenses, poolId), prize = latest(snapshot.prizes, poolId), closure = latest(snapshot.closures, poolId);
  const result = createResultView(reviewResults).currentResult(poolId);
  const calculated = report ? assessRegisteredPrizes(report, result).calculatedPrizeCents : null;
  const contributed = BigInt(finance.finance.pools[poolId]?.allocatedCents ?? '0');
  const expenses = expense === null ? null : BigInt(expense.totalCostCents);
  const redemptions = snapshot.redemptions.filter((r) => r.poolId === poolId), distributions = snapshot.distributions.filter((d) => d.poolId === poolId);
  const organizer = sum(redemptions.filter((r) => r.ownership === 'organizer')), individual = sum(redemptions.filter((r) => r.ownership === 'individual'));
  const prizePaid = sum(distributions.filter((d) => d.kind === 'prize-payment')), refunded = sum(distributions.filter((d) => d.kind === 'contribution-refund'));
  const cash = contributed + organizer - (expenses ?? 0n) - prizePaid - refunded;
  const entitled = new Map(plan.rights.map((r) => [r.personId, r]));
  const refundShares = expenses === null ? null : new Map(distributeCents(max0(BigInt(plan.budgetCents) - expenses).toString(), plan.rights.map((r) => ({ id: r.personId, units: r.units }))).map((r) => [r.id, BigInt(r.amountCents)]));
  const rights = poolRights(prize);
  const personIds = new Set([...snapshot.financial.allocations.filter((a) => a.poolId === poolId).map((a) => a.personId), ...plan.rights.map((r) => r.personId), ...rights.keys()]);
  const persons: SettlementPersonBalance[] = [...personIds].sort().map((personId) => {
    const funding = BigInt(finance.personPoolFunding(poolId, personId)), own = entitled.get(personId);
    const refundRight = expenses === null ? null : max0(funding - BigInt(own?.dueCents ?? '0')) + (refundShares!.get(personId) ?? 0n);
    const received = plan.participationMode === 'official' ? sum(redemptions.filter((r) => r.personId === personId)) : sum(distributions.filter((d) => d.personId === personId && d.kind === 'prize-payment'));
    const returned = sum(distributions.filter((d) => d.personId === personId && d.kind === 'contribution-refund'));
    const prizeRight = prize === null ? null : rights.get(personId) ?? 0n;
    const quotas = new Set(prize?.rights.filter((r) => r.personId === personId).map((r) => r.quotaId));
    return { personId, quotaId: own?.quotaId ?? (quotas.size === 1 ? [...quotas][0]! : null), contributedCents: funding.toString(), prizeRightCents: prizeRight?.toString() ?? null, prizeReceivedCents: received.toString(), prizePendingCents: prizeRight === null ? null : (prizeRight - received).toString(), refundRightCents: refundRight?.toString() ?? null, refundedCents: returned.toString(), refundPendingCents: refundRight === null ? null : (refundRight - returned).toString() };
  });
  const amount = prize === null ? null : BigInt(prize.amountCents);
  return { poolId, participationMode: plan.participationMode, manifestId: frozen.id, registrationReportId: report?.id ?? null, expenseConfirmationId: expense?.id ?? null, prizeConfirmationId: prize?.id ?? null, calculatedPrizeCents: calculated, confirmedPrizeCents: prize?.amountCents ?? null, contributedCents: contributed.toString(), confirmedExpenseCents: expenses?.toString() ?? null, expenseConfirmationPending: expense === null || expense.registrationReportId !== report?.id, redeemedCents: (organizer + individual).toString(), organizerRedeemedCents: organizer.toString(), individualRedeemedCents: individual.toString(), prizePaidCents: prizePaid.toString(), refundedCents: refunded.toString(), organizerCashCents: cash.toString(), cashDeficitCents: max0(-cash).toString(), contributionSurplusCents: expenses === null ? null : max0(contributed - expenses).toString(), unredeemedPrizeCents: amount === null ? null : (amount - organizer - individual).toString(), unpaidPrizeCents: amount === null ? null : (amount - (plan.participationMode === 'official' ? individual : prizePaid)).toString(), refundPendingCents: expenses === null ? null : persons.reduce((total, person) => total + BigInt(person.refundPendingCents!), 0n).toString(), resultConflict: result.status === 'conflict', registrationIncomplete: !report || report.comparison.status !== 'complete', closed: closure?.direction === 'closed', persons };
}
function financeProjection(snapshot: SettlementSnapshot): SettlementFinance {
  const finance = createFinancialView(snapshot.financial).finance;
  const pools = Object.fromEntries([...new Set(snapshot.registration.manifests.map((m) => m.poolId))].map((poolId) => [poolId, projectPool(snapshot, poolId)]));
  const balances = Object.values(pools);
  const organizer = balances.reduce((s, p) => s + BigInt(p.organizerRedeemedCents), 0n), individual = balances.reduce((s, p) => s + BigInt(p.individualRedeemedCents), 0n), expenses = balances.reduce((s, p) => s + BigInt(p.confirmedExpenseCents ?? '0'), 0n), paid = balances.reduce((s, p) => s + BigInt(p.prizePaidCents), 0n), refunded = balances.reduce((s, p) => s + BigInt(p.refundedCents), 0n);
  return { contributionCashCents: finance.cashCents, organizerRedeemedCents: organizer.toString(), individualRedeemedCents: individual.toString(), confirmedExpenseCents: expenses.toString(), prizePaidCents: paid.toString(), refundedCents: refunded.toString(), organizerCashCents: (BigInt(finance.cashCents) + organizer - expenses - paid - refunded).toString(), unallocatedContributionCents: finance.unallocatedCents, pools };
}
function proof(snapshot: SettlementSnapshot, poolId: string, evidenceIds: string[], at: string, required = true): void {
  if (required && !evidenceIds.length) planningInvalid('evidenceIds', 'Movimento confirmado exige original privado enviado.');
  for (const id of evidenceIds) {
    const evidence = snapshot.registration.evidence.find((e) => e.id === id);
    if (!evidence || evidence.poolId !== poolId || evidence.groupId !== snapshot.groupId || evidence.uploadedAt > at) planningInvalid('evidenceIds', 'Evidência precisa pertencer ao bolão e existir antes da confirmação.');
  }
}
function confirmedRights(frozen: PoolManifest, report: RegistrationReport, amountCents: string, official: OfficialPrizeEntitlement[]): SettlementRight[] {
  if (frozen.content.plan.participationMode === 'internal') {
    if (official.length) planningInvalid('officialEntitlements', 'Acordo interno não inventa recibos oficiais.');
    const byPerson = new Map(frozen.content.plan.rights.map((r) => [r.personId, r.quotaId]));
    return distributeCents(amountCents, frozen.content.plan.rights.map((r) => ({ id: r.personId, units: r.units }))).map((r) => ({ personId: r.id, quotaId: byPerson.get(r.id)!, amountCents: r.amountCents }));
  }
  const expected = report.items.flatMap((item) => {
    if (!item.observed?.officialAssignments?.length || item.observed.officialQuotaCount === null) return planningInvalid('officialEntitlements', 'Prêmio oficial exige titulares e cotas efetivamente conferidos em todas as cartelas.');
    return item.observed.officialAssignments.map((assignment) => ({ key: item.plannedTicketKey, ...assignment }));
  });
  if (expected.length !== official.length || expected.some((e) => !official.some((o) => o.plannedTicketKey === e.key && o.quotaId === e.quotaId && o.personId === e.personId && o.officialQuotas === e.officialQuotas))) planningInvalid('officialEntitlements', 'Valores oficiais exigem correspondência completa e exata com os recibos observados.');
  if (sum(official) !== BigInt(amountCents)) planningInvalid('amountCents', 'Prêmio oficial deve somar exatamente os valores dos recibos individuais.');
  const byRight = new Map<string, SettlementRight>();
  for (const row of official) {
    const key = `${row.personId}:${row.quotaId}`, current = byRight.get(key);
    byRight.set(key, { personId: row.personId, quotaId: row.quotaId, amountCents: (BigInt(current?.amountCents ?? '0') + BigInt(row.amountCents)).toString() });
  }
  return [...byRight.values()].sort((a, b) => a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : a.quotaId < b.quotaId ? -1 : a.quotaId > b.quotaId ? 1 : 0);
}
function pending(pool: PoolSettlementBalance): boolean {
  return pool.expenseConfirmationPending || pool.confirmedPrizeCents === null || pool.resultConflict || pool.registrationIncomplete || [pool.cashDeficitCents, pool.unredeemedPrizeCents, pool.unpaidPrizeCents, pool.refundPendingCents].some((c) => c !== null && BigInt(c) !== 0n);
}
function checkAction(snapshot: SettlementSnapshot, input: SettlementAction, confirmedAt: string): void {
  const value = action(input), at = sourceTime(confirmedAt, 'confirmedAt'), frozen = manifest(snapshot, value.poolId), pool = projectPool(snapshot, value.poolId);
  const report = latest(snapshot.registration.reports, value.poolId), prize = latest(snapshot.prizes, value.poolId), expense = latest(snapshot.expenses, value.poolId), closure = latest(snapshot.closures, value.poolId);
  if (!report || report.confirmedAt > at || report.poolVersion >= value.poolVersion) planningInvalid('registrationReportId', 'Apuração exige registro humano já confirmado e versão atual observada do bolão.');
  const previousVersions = [...snapshot.expenses, ...snapshot.prizes, ...snapshot.redemptions, ...snapshot.distributions, ...snapshot.closures].filter((f) => f.poolId === value.poolId);
  if (previousVersions.some((f) => f.poolVersion >= value.poolVersion || f.confirmedAt > at)) planningInvalid('poolVersion', 'Versão observada precisa avançar decisões anteriores deste bolão.');
  if (pool.closed && value.type !== 'pool_reopen') planningInvalid('poolId', 'Bolão encerrado exige reabertura humana antes de nova alteração financeira.');
  if (value.type === 'pool_reopen') {
    if (!pool.closed || !closure || closure.id !== value.closureId) planningInvalid('closureId', 'Reabertura exige o encerramento ativo observado.');
    return;
  }
  if ('eventAt' in value && value.eventAt > at) planningInvalid('eventAt', 'Evento não pode ser futuro à confirmação.');
  if ('evidenceIds' in value) proof(snapshot, value.poolId, value.evidenceIds, at, value.type !== 'prize_confirm' || BigInt(value.amountCents) > 0n);
  if (value.type === 'expense_confirm') {
    if (value.registrationReportId !== report.id || value.supersedesId !== (expense?.id ?? null)) planningInvalid('supersedesId', 'Despesa exige relatório atual e revisão explícita da última confirmação.');
    if ((expense || value.betCostCents !== report.comparison.observedBetCostCents || value.feeCents !== report.comparison.observedFeeCents) && !value.reason.trim()) planningInvalid('reason', 'Correção ou custo diferente/desconhecido no comprovante exige razão humana.');
  } else if (value.type === 'prize_confirm') {
    const result = currentResult(snapshot.results, value.poolId);
    if (value.registrationReportId !== report.id || value.supersedesId !== (prize?.id ?? null) || !result.result?.drawnNumbers || result.status === 'conflict' || result.result.id !== value.resultId || result.result.collectedAt > at) planningInvalid('resultId', 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.');
    const calculated = assessRegisteredPrizes(report, result).calculatedPrizeCents;
    if ((prize || calculated !== value.amountCents) && !value.reason.trim()) planningInvalid('reason', 'Correção ou prêmio diferente/indisponível no cálculo exige razão humana.');
    confirmedRights(frozen, report, value.amountCents, value.officialEntitlements);
    for (const row of value.officialEntitlements) proof(snapshot, value.poolId, row.evidenceIds, at, BigInt(row.amountCents) > 0n);
    if (value.redemptionDeadline && (value.redemptionDeadline.sourceUrl !== LOTTERIES[frozen.content.plan.lotteryId].sourceUrl || value.redemptionDeadline.drawDate !== result.result.drawDate)) planningInvalid('redemptionDeadline', 'Prazo precisa referenciar modalidade e data do resultado aprovado.');
  } else if (value.type === 'redemption_record') {
    if (!prize || value.prizeConfirmationId !== prize.id || pool.resultConflict || prize.registrationReportId !== report.id) planningInvalid('prizeConfirmationId', 'Resgate exige prêmio atual confirmado e fontes conferidas sem conflito.');
    if (frozen.content.plan.participationMode === 'internal' && value.personId !== frozen.content.responsible.ticketHolderPersonId) planningInvalid('personId', 'Resgate interno pertence ao titular congelado.');
    if (frozen.content.plan.participationMode === 'official' && !prize.rights.some((r) => r.personId === value.personId)) planningInvalid('personId', 'Resgate individual exige direito oficial observado.');
    if (value.eventAt < prize.confirmedAt) planningInvalid('eventAt', 'Confirme o prêmio antes do evento de resgate registrado.');
  } else if (value.type === 'redemption_reverse') {
    const original = snapshot.redemptions.find((r) => r.id === value.redemptionId && r.poolId === value.poolId && r.direction === 'received');
    if (!original || snapshot.redemptions.some((r) => r.reversesId === original.id) || value.eventAt < original.eventAt) planningInvalid('redemptionId', 'Compensação exige recebimento positivo anterior ainda não compensado.');
  } else if (value.type === 'distribution_record') {
    if (pool.resultConflict && value.kind === 'prize-payment') planningInvalid('resultId', 'Conflito de resultado exige revisão antes de distribuir prêmio.');
    const person = pool.persons.find((p) => p.personId === value.personId), amount = BigInt(value.amountCents);
    if (!person) planningInvalid('personId', 'Pagamento exige pessoa com direito ou contribuição identificada.');
    if (value.kind === 'prize-payment') {
      if (frozen.content.plan.participationMode === 'official' || !prize || prize.registrationReportId !== report.id || person.prizePendingCents === null || amount > BigInt(person.prizePendingCents) || amount > BigInt(pool.organizerRedeemedCents) - BigInt(pool.prizePaidCents)) planningInvalid('amountCents', 'Pagamento não pode exceder direito e resgate interno disponíveis.');
    } else if (pool.expenseConfirmationPending || person.refundPendingCents === null || amount > BigInt(person.refundPendingCents) || amount > BigInt(pool.contributionSurplusCents!) - BigInt(pool.refundedCents)) planningInvalid('amountCents', 'Devolução exige despesa atual confirmada e sobra própria disponível.');
    if (amount > BigInt(pool.organizerCashCents) || amount > BigInt(financeProjection(snapshot).organizerCashCents)) planningInvalid('amountCents', 'Pagamento não pode consumir caixa inexistente ou dinheiro de outro bolão.');
  } else if (value.type === 'distribution_reverse') {
    const original = snapshot.distributions.find((d) => d.id === value.distributionId && d.poolId === value.poolId && d.direction === 'paid');
    if (!original || snapshot.distributions.some((d) => d.reversesId === original.id) || value.eventAt < original.eventAt) planningInvalid('distributionId', 'Retorno exige pagamento positivo anterior ainda não compensado.');
  } else if (value.type === 'pool_settle') {
    if (value.registrationReportId !== report.id || value.prizeConfirmationId !== (prize?.id ?? null) || value.expenseConfirmationId !== (expense?.id ?? null)) planningInvalid('poolId', 'Encerramento exige as versões atuais de registro, despesas e prêmio.');
    if (pending(pool) && !value.pendingExplanation.trim()) planningInvalid('pendingExplanation', 'Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.');
  }
}

export type SettlementRecord = ExpenseConfirmation | PrizeConfirmation | PrizeRedemption | SettlementDistribution | PoolSettlement;
export interface SettlementFactStamp { id: string; receiptId: string; confirmedAt: string; groupRevision: number }
function reviewContext(snapshot: SettlementSnapshot, poolId: string): { observedResultIds: string[]; resultSelectionId: string | null } {
  return { observedResultIds: snapshot.results.results.filter((r) => r.poolId === poolId).sort((a, b) => a.version - b.version).map((r) => r.id), resultSelectionId: latest(snapshot.results.selections, poolId)?.id ?? null };
}
function buildFact(snapshot: SettlementSnapshot, value: SettlementAction, stamp: SettlementFactStamp): SettlementRecord {
  const frozen = manifest(snapshot, value.poolId), report = latest(snapshot.registration.reports, value.poolId)!;
  const list: Array<{ poolId: string; version: number }> = value.type === 'expense_confirm' ? snapshot.expenses : value.type === 'prize_confirm' ? snapshot.prizes : value.type.startsWith('redemption_') ? snapshot.redemptions : value.type.startsWith('distribution_') ? snapshot.distributions : snapshot.closures;
  const base: SettlementFact = { id: stamp.id, receiptId: stamp.receiptId, confirmedAt: stamp.confirmedAt, groupRevision: stamp.groupRevision, groupId: snapshot.groupId, poolId: value.poolId, poolVersion: value.poolVersion, version: (latest(list, value.poolId)?.version ?? 0) + 1 };
  if (value.type === 'expense_confirm') return { ...base, manifestId: frozen.id, registrationReportId: value.registrationReportId, supersedesId: value.supersedesId, betCostCents: value.betCostCents, feeCents: value.feeCents, totalCostCents: (BigInt(value.betCostCents) + BigInt(value.feeCents)).toString(), evidenceIds: value.evidenceIds, sourceReference: value.sourceReference, reason: value.reason };
  if (value.type === 'prize_confirm') return { ...base, manifestId: frozen.id, registrationReportId: value.registrationReportId, resultId: value.resultId, ...reviewContext(snapshot, value.poolId), supersedesId: value.supersedesId, calculatedPrizeCents: assessRegisteredPrizes(report, currentResult(snapshot.results, value.poolId)).calculatedPrizeCents, amountCents: value.amountCents, officialEntitlements: value.officialEntitlements, rights: confirmedRights(frozen, report, value.amountCents, value.officialEntitlements), evidenceIds: value.evidenceIds, sourceReference: value.sourceReference, reason: value.reason, redemptionDeadline: value.redemptionDeadline };
  if (value.type === 'redemption_record') return { ...base, prizeConfirmationId: value.prizeConfirmationId, personId: value.personId, ownership: frozen.content.plan.participationMode === 'internal' ? 'organizer' : 'individual', direction: 'received', reversesId: null, amountCents: value.amountCents, evidenceIds: value.evidenceIds, sourceReference: value.sourceReference, eventAt: value.eventAt, reason: value.reason };
  if (value.type === 'redemption_reverse') {
    const original = snapshot.redemptions.find((r) => r.id === value.redemptionId)!;
    return { ...base, prizeConfirmationId: original.prizeConfirmationId, personId: original.personId, ownership: original.ownership, direction: 'reversed', reversesId: original.id, amountCents: `-${original.amountCents}`, evidenceIds: value.evidenceIds, sourceReference: value.sourceReference, eventAt: value.eventAt, reason: value.reason };
  }
  if (value.type === 'distribution_record') return { ...base, personId: value.personId, kind: value.kind, direction: 'paid', reversesId: null, amountCents: value.amountCents, evidenceIds: value.evidenceIds, sourceReference: value.sourceReference, eventAt: value.eventAt, reason: value.reason };
  if (value.type === 'distribution_reverse') {
    const original = snapshot.distributions.find((d) => d.id === value.distributionId)!;
    return { ...base, personId: original.personId, kind: original.kind, direction: 'returned', reversesId: original.id, amountCents: `-${original.amountCents}`, evidenceIds: value.evidenceIds, sourceReference: value.sourceReference, eventAt: value.eventAt, reason: value.reason };
  }
  const previous = latest(snapshot.closures, value.poolId), prize = latest(snapshot.prizes, value.poolId), expense = latest(snapshot.expenses, value.poolId);
  return { ...base, direction: value.type === 'pool_settle' ? 'closed' : 'reopened', previousClosureId: previous?.id ?? null, registrationReportId: report.id, prizeConfirmationId: prize?.id ?? null, expenseConfirmationId: expense?.id ?? null, ...reviewContext(snapshot, value.poolId), leftoverDisposition: value.type === 'pool_settle' ? value.leftoverDisposition : previous!.leftoverDisposition, reconciliation: projectPool(snapshot, value.poolId), pendingExplanation: value.type === 'pool_settle' ? value.pendingExplanation : previous!.pendingExplanation, reason: value.reason };
}
function append(snapshot: SettlementSnapshot, fact: SettlementRecord): void {
  if ('betCostCents' in fact) snapshot.expenses.push(fact);
  else if ('rights' in fact) snapshot.prizes.push(fact);
  else if ('ownership' in fact) snapshot.redemptions.push(fact);
  else if ('kind' in fact) snapshot.distributions.push(fact);
  else snapshot.closures.push(fact);
}
function checkBalances(snapshot: SettlementSnapshot, poolId: string): void {
  const pool = projectPool(snapshot, poolId);
  if (BigInt(pool.redeemedCents) < 0n || BigInt(pool.prizePaidCents) < 0n || BigInt(pool.refundedCents) < 0n || (pool.confirmedPrizeCents !== null && BigInt(pool.redeemedCents) > BigInt(pool.confirmedPrizeCents)) || BigInt(pool.prizePaidCents) > BigInt(pool.organizerRedeemedCents)) planningInvalid('amountCents', 'Recebimentos/pagamentos não reconciliam com o prêmio confirmado e resgate.');
  for (const person of pool.persons) if (BigInt(person.prizeReceivedCents) < 0n || BigInt(person.refundedCents) < 0n || (person.prizePendingCents !== null && BigInt(person.prizePendingCents) < 0n) || (person.refundPendingCents !== null && BigInt(person.refundPendingCents) < 0n)) planningInvalid('rights', 'Correção não pode deixar pagamentos acima do direito da pessoa.');
  if (pool.contributionSurplusCents !== null && BigInt(pool.refundedCents) > BigInt(pool.contributionSurplusCents)) planningInvalid('amountCents', 'Devoluções ultrapassam a sobra real de contribuições.');
  if (BigInt(pool.cashDeficitCents) > 0n && (BigInt(pool.prizePaidCents) > 0n || BigInt(pool.refundedCents) > 0n)) planningInvalid('amountCents', 'Correção não pode consumir caixa já pago ou devolvido.');
}

/** Domain preview only: authentication, transaction, real entity version and final clock remain server duties. */
export function validateSettlementActionContext(input: SettlementSnapshot, value: SettlementAction, confirmedAt: string): void {
  const snapshot = validateSettlementSnapshot(input), validated = action(value), at = sourceTime(confirmedAt, 'confirmedAt');
  checkAction(snapshot, validated, at);
  const next = { ...snapshot, expenses: snapshot.expenses.slice(), prizes: snapshot.prizes.slice(), redemptions: snapshot.redemptions.slice(), distributions: snapshot.distributions.slice(), closures: snapshot.closures.slice() };
  append(next, buildFact(snapshot, validated, { id: '00000000-0000-4000-8000-fffffffffff0', receiptId: '00000000-0000-4000-8000-fffffffffff1', confirmedAt: at, groupRevision: snapshot.groupRevision + 1 }));
  checkBalances(next, validated.poolId);
}
/** Constructs a fact from a supplied server stamp; it performs no I/O and grants no authority. */
export function buildSettlementFact(input: SettlementSnapshot, commandInput: SettlementCommand, stamp: SettlementFactStamp): SettlementRecord {
  const snapshot = validateSettlementSnapshot(input), command = validateSettlementCommand(commandInput), at = sourceTime(stamp.confirmedAt, 'confirmedAt');
  if (command.groupId !== snapshot.groupId || command.expectedRevision !== snapshot.groupRevision || stamp.groupRevision !== snapshot.groupRevision + 1) planningInvalid('groupRevision', 'Fato exige revisão observada e avanço único do grupo.');
  const validatedStamp = { id: planningUid(stamp.id, 'id'), receiptId: planningUid(stamp.receiptId, 'receiptId'), confirmedAt: at, groupRevision: planningInt(stamp.groupRevision, 'groupRevision', 1) };
  checkAction(snapshot, command.action, at);
  const fact = buildFact(snapshot, command.action, validatedStamp), next = { ...snapshot, expenses: snapshot.expenses.slice(), prizes: snapshot.prizes.slice(), redemptions: snapshot.redemptions.slice(), distributions: snapshot.distributions.slice(), closures: snapshot.closures.slice() };
  append(next, fact); checkBalances(next, command.action.poolId);
  return fact;
}

function base(source: Record<string, unknown>): SettlementFact {
  return { id: planningUid(source.id, 'id'), groupId: planningUid(source.groupId, 'groupId'), poolId: planningUid(source.poolId, 'poolId'), version: planningInt(source.version, 'version', 1), groupRevision: planningInt(source.groupRevision, 'groupRevision', 1), poolVersion: planningInt(source.poolVersion, 'poolVersion', 1), confirmedAt: sourceTime(source.confirmedAt, 'confirmedAt'), receiptId: planningUid(source.receiptId, 'receiptId') };
}
function validateFact(value: unknown, family: 'expenses' | 'prizes' | 'redemptions' | 'distributions' | 'closures'): SettlementRecord {
  const source = planningRecord(value, family);
  const b = base(source), reference = (): string => opaque(source.sourceReference, 'sourceReference'), evidence = (): string[] => ids(source.evidenceIds, 'evidenceIds'), reason = (required = false): string => opaque(source.reason, 'reason', required);
  if (family === 'expenses') {
    planningShape(source, [...BASE, 'manifestId', 'registrationReportId', 'supersedesId', 'betCostCents', 'feeCents', 'totalCostCents', 'evidenceIds', 'sourceReference', 'reason'], family);
    return { ...b, manifestId: planningUid(source.manifestId, 'manifestId'), registrationReportId: planningUid(source.registrationReportId, 'registrationReportId'), supersedesId: NULL_ID(source.supersedesId, 'supersedesId'), betCostCents: planningMoney(source.betCostCents, 'betCostCents'), feeCents: planningMoney(source.feeCents, 'feeCents'), totalCostCents: planningMoney(source.totalCostCents, 'totalCostCents'), evidenceIds: evidence(), sourceReference: reference(), reason: reason() };
  }
  if (family === 'prizes') {
    planningShape(source, [...BASE, 'manifestId', 'registrationReportId', 'resultId', 'observedResultIds', 'resultSelectionId', 'supersedesId', 'calculatedPrizeCents', 'amountCents', 'officialEntitlements', 'rights', 'evidenceIds', 'sourceReference', 'reason', 'redemptionDeadline'], family);
    const rights = unique(planningList(source.rights, 'rights', 100_000).map((inputRight) => { const right = planningRecord(inputRight, 'right'); planningShape(right, ['personId', 'quotaId', 'amountCents'], 'right'); return { personId: planningUid(right.personId, 'personId'), quotaId: planningUid(right.quotaId, 'quotaId'), amountCents: planningMoney(right.amountCents, 'amountCents') }; }), (r) => `${r.personId}:${r.quotaId}`, 'rights');
    const calculated = source.calculatedPrizeCents;
    if (calculated !== null && (typeof calculated !== 'string' || !/^(0|[1-9]\d{0,99})$/.test(calculated))) planningInvalid('calculatedPrizeCents', 'Cálculo exige string canônica de centavos.');
    return { ...b, manifestId: planningUid(source.manifestId, 'manifestId'), registrationReportId: planningUid(source.registrationReportId, 'registrationReportId'), resultId: planningUid(source.resultId, 'resultId'), observedResultIds: ids(source.observedResultIds, 'observedResultIds', 10_000), resultSelectionId: NULL_ID(source.resultSelectionId, 'resultSelectionId'), supersedesId: NULL_ID(source.supersedesId, 'supersedesId'), calculatedPrizeCents: calculated as string | null, amountCents: planningMoney(source.amountCents, 'amountCents'), officialEntitlements: officialEntitlements(source.officialEntitlements), rights, evidenceIds: evidence(), sourceReference: reference(), reason: reason(), redemptionDeadline: source.redemptionDeadline === null ? null : validateRedemptionDeadline(source.redemptionDeadline) };
  }
  if (family === 'redemptions' || family === 'distributions') {
    planningShape(source, [...BASE, ...(family === 'redemptions' ? ['prizeConfirmationId', 'ownership'] : ['kind']), 'personId', 'direction', 'reversesId', 'amountCents', 'evidenceIds', 'sourceReference', 'eventAt', 'reason'], family);
    const direction = planningOption(source.direction, family === 'redemptions' ? ['received', 'reversed'] : ['paid', 'returned'], 'direction');
    const negative = direction === 'reversed' || direction === 'returned';
    if (typeof source.amountCents !== 'string' || (negative && !source.amountCents.startsWith('-'))) planningInvalid('amountCents', 'Compensação exige centavos negativos.');
    planningMoney(negative ? source.amountCents.slice(1) : source.amountCents, 'amountCents', true);
    const common = { ...b, personId: planningUid(source.personId, 'personId'), reversesId: NULL_ID(source.reversesId, 'reversesId'), amountCents: source.amountCents, evidenceIds: evidence(), sourceReference: reference(), eventAt: sourceTime(source.eventAt, 'eventAt'), reason: reason(negative || family === 'distributions') };
    return family === 'redemptions' ? { ...common, prizeConfirmationId: planningUid(source.prizeConfirmationId, 'prizeConfirmationId'), ownership: planningOption(source.ownership, ['organizer', 'individual'], 'ownership'), direction: direction as PrizeRedemption['direction'] } : { ...common, kind: planningOption(source.kind, ['prize-payment', 'contribution-refund'], 'kind'), direction: direction as SettlementDistribution['direction'] };
  }
  planningShape(source, [...BASE, 'direction', 'previousClosureId', 'registrationReportId', 'prizeConfirmationId', 'expenseConfirmationId', 'observedResultIds', 'resultSelectionId', 'leftoverDisposition', 'reconciliation', 'pendingExplanation', 'reason'], family);
  // The reconciliation is checked against independently rebuilt history below; unknown fields cannot survive.
  const reconciliation = planningRecord(source.reconciliation, 'reconciliation') as unknown as PoolSettlementBalance;
  return { ...b, direction: planningOption(source.direction, ['closed', 'reopened'], 'direction'), previousClosureId: NULL_ID(source.previousClosureId, 'previousClosureId'), registrationReportId: planningUid(source.registrationReportId, 'registrationReportId'), prizeConfirmationId: NULL_ID(source.prizeConfirmationId, 'prizeConfirmationId'), expenseConfirmationId: NULL_ID(source.expenseConfirmationId, 'expenseConfirmationId'), observedResultIds: ids(source.observedResultIds, 'observedResultIds', 10_000), resultSelectionId: NULL_ID(source.resultSelectionId, 'resultSelectionId'), leftoverDisposition: planningOption(source.leftoverDisposition, ['group-reserve', 'pending-refund'], 'leftoverDisposition'), reconciliation, pendingExplanation: opaque(source.pendingExplanation, 'pendingExplanation', false), reason: reason(true) };
}
function asAction(fact: SettlementRecord): SettlementAction {
  const common = { poolId: fact.poolId, poolVersion: fact.poolVersion };
  if ('betCostCents' in fact) return { ...common, type: 'expense_confirm', registrationReportId: fact.registrationReportId, supersedesId: fact.supersedesId, betCostCents: fact.betCostCents, feeCents: fact.feeCents, evidenceIds: fact.evidenceIds, sourceReference: fact.sourceReference, reason: fact.reason };
  if ('rights' in fact) return { ...common, type: 'prize_confirm', registrationReportId: fact.registrationReportId, resultId: fact.resultId, supersedesId: fact.supersedesId, amountCents: fact.amountCents, officialEntitlements: fact.officialEntitlements, evidenceIds: fact.evidenceIds, sourceReference: fact.sourceReference, reason: fact.reason, redemptionDeadline: fact.redemptionDeadline };
  if ('ownership' in fact) return fact.direction === 'received' ? { ...common, type: 'redemption_record', prizeConfirmationId: fact.prizeConfirmationId, personId: fact.personId, amountCents: fact.amountCents, evidenceIds: fact.evidenceIds, sourceReference: fact.sourceReference, eventAt: fact.eventAt, reason: fact.reason } : { ...common, type: 'redemption_reverse', redemptionId: fact.reversesId!, evidenceIds: fact.evidenceIds, sourceReference: fact.sourceReference, eventAt: fact.eventAt, reason: fact.reason };
  if ('kind' in fact) return fact.direction === 'paid' ? { ...common, type: 'distribution_record', personId: fact.personId, kind: fact.kind, amountCents: fact.amountCents, evidenceIds: fact.evidenceIds, sourceReference: fact.sourceReference, eventAt: fact.eventAt, reason: fact.reason } : { ...common, type: 'distribution_reverse', distributionId: fact.reversesId!, evidenceIds: fact.evidenceIds, sourceReference: fact.sourceReference, eventAt: fact.eventAt, reason: fact.reason };
  return fact.direction === 'closed' ? { ...common, type: 'pool_settle', registrationReportId: fact.registrationReportId, prizeConfirmationId: fact.prizeConfirmationId, expenseConfirmationId: fact.expenseConfirmationId, leftoverDisposition: fact.leftoverDisposition, pendingExplanation: fact.pendingExplanation, reason: fact.reason } : { ...common, type: 'pool_reopen', closureId: fact.previousClosureId!, reason: fact.reason };
}
function resultHistory(snapshot: SettlementSnapshot, poolId: string, observed: string[], selectionId: string | null): ResultSnapshot {
  const known = snapshot.results.results.filter((r) => r.poolId === poolId && observed.includes(r.id));
  const highest = Math.max(0, ...known.map((r) => r.version));
  if (known.length !== observed.length || snapshot.results.results.some((r) => r.poolId === poolId && r.version <= highest && !observed.includes(r.id))) planningInvalid('observedResultIds', 'Contexto histórico não pode omitir versões anteriores do resultado.');
  const selection = selectionId === null ? null : snapshot.results.selections.find((s) => s.id === selectionId && s.poolId === poolId);
  if (selectionId !== null && !selection) planningInvalid('resultSelectionId', 'Escolha histórica precisa existir neste bolão.');
  return { ...snapshot.results, results: known, selections: selection ? snapshot.results.selections.filter((s) => s.poolId === poolId && s.version <= selection.version) : [], calendarVersions: [] };
}
export function validateSettlementSnapshot(input: unknown): SettlementSnapshot {
  const source = planningRecord(input, 'snapshot'); planningShape(source, ['groupId', 'groupRevision', 'financial', 'registration', 'results', 'expenses', 'prizes', 'redemptions', 'distributions', 'closures'], 'snapshot');
  const groupId = planningUid(source.groupId, 'groupId'), groupRevision = planningInt(source.groupRevision, 'groupRevision');
  const financial = validateFinancialSnapshot(source.financial), registration = validateRegistrationSnapshot(source.registration), results = validateResultSnapshot(source.results);
  if ([financial, registration, results].some((s) => s.groupId !== groupId || s.groupRevision !== groupRevision)) planningInvalid('snapshot', 'Fontes autossuficientes precisam ter o mesmo grupo e corte da revisão corrente.');
  const snapshot: SettlementSnapshot = { groupId, groupRevision, financial, registration, results, expenses: [], prizes: [], redemptions: [], distributions: [], closures: [] };
  const facts: SettlementRecord[] = [];
  for (const family of ['expenses', 'prizes', 'redemptions', 'distributions', 'closures'] as const) facts.push(...planningList(source[family], family, 10_000).map((v) => validateFact(v, family)));
  unique(facts, (f) => f.id, 'facts'); unique(facts, (f) => f.receiptId, 'receiptId'); unique(facts, (f) => f.groupRevision.toString(), 'groupRevision');
  facts.sort((a, b) => a.groupRevision - b.groupRevision);
  const frozenByPool = new Map<string, PoolManifest>();
  for (const m of registration.manifests) { const previous = frozenByPool.get(m.poolId); if (!previous || m.version > previous.version) frozenByPool.set(m.poolId, m); }
  const currentFinance = createFinancialView(financial);
  for (const m of frozenByPool.values()) {
    validatePlanFunding(m.content.plan, financial);
    const historical = createFinancialView(m.content.financial);
    const people = new Set([...financial.allocations.filter((a) => a.poolId === m.poolId).map((a) => a.personId), ...m.content.financial.allocations.filter((a) => a.poolId === m.poolId).map((a) => a.personId)]);
    for (const person of people) if (currentFinance.personPoolFunding(m.poolId, person) !== historical.personPoolFunding(m.poolId, person)) planningInvalid('financial', 'Dinheiro destinado ao bolão registrado deve preservar o financiamento congelado.');
  }
  for (const fact of facts) {
    if (fact.groupId !== groupId || fact.groupRevision > groupRevision || !frozenByPool.has(fact.poolId)) planningInvalid('groupRevision', 'Fato financeiro exige grupo, bolão e revisão confirmada existentes.');
    // Registration facts predate this approved entity version, independently of tied timestamps.
    const reports = registration.reports.filter((r) => r.poolId !== fact.poolId || (r.poolVersion < fact.poolVersion && r.confirmedAt <= fact.confirmedAt));
    let history: SettlementSnapshot = { ...snapshot, registration: { ...registration, reports } };
    // Facts without their own context are rebuilt against the results observed by the latest earlier prize (snapshot.prizes holds only earlier ones here).
    const observed = 'observedResultIds' in fact ? fact : latest(snapshot.prizes, fact.poolId);
    if (observed) history = { ...history, results: resultHistory(snapshot, fact.poolId, observed.observedResultIds, observed.resultSelectionId) };
    const value = asAction(fact); checkAction(history, value, fact.confirmedAt);
    const expected = buildFact(history, value, { id: fact.id, receiptId: fact.receiptId, confirmedAt: fact.confirmedAt, groupRevision: fact.groupRevision });
    if (canonicalJSON(expected) !== canonicalJSON(fact)) planningInvalid('facts', 'Fato, direito, compensação ou reconciliação diverge da reconstrução independente.');
    append(snapshot, fact); checkBalances(historyWithFacts(history, snapshot), fact.poolId);
  }
  return snapshot;
}
function historyWithFacts(history: SettlementSnapshot, snapshot: SettlementSnapshot): SettlementSnapshot { return { ...history, expenses: snapshot.expenses, prizes: snapshot.prizes, redemptions: snapshot.redemptions, distributions: snapshot.distributions, closures: snapshot.closures }; }
export function validateSettlementReceipt(input: unknown): SettlementReceipt {
  const source = planningRecord(input, 'receipt'); planningShape(source, ['apiVersion', 'idempotencyKey', 'receiptId', 'groupId', 'status', 'groupRevision', 'message', 'confirmedAt', 'snapshot'], 'receipt');
  if (source.apiVersion !== 'v1') planningInvalid('apiVersion', 'Versão da API não suportada.');
  const groupId = planningUid(source.groupId, 'groupId'), groupRevision = planningInt(source.groupRevision, 'groupRevision'), status = planningOption(source.status, ['accepted', 'conflict', 'rejected'], 'status');
  const receiptId = NULL_ID(source.receiptId, 'receiptId'), confirmedAt = source.confirmedAt === null ? null : sourceTime(source.confirmedAt, 'confirmedAt'), snapshot = source.snapshot === null ? null : validateSettlementSnapshot(source.snapshot);
  if (snapshot && (snapshot.groupId !== groupId || snapshot.groupRevision !== groupRevision)) planningInvalid('snapshot', 'Recibo e retrato devem ter mesmo grupo e revisão.');
  if (status === 'accepted' && (!receiptId || !confirmedAt || !snapshot)) planningInvalid('status', 'Aceite exige fato, retrato, recibo e horário do servidor.');
  if (status !== 'accepted' && (receiptId !== null || confirmedAt !== null)) planningInvalid('status', 'Rejeição ou conflito não possui confirmação.');
  if (snapshot && confirmedAt) {
    const facts = [...snapshot.expenses, ...snapshot.prizes, ...snapshot.redemptions, ...snapshot.distributions, ...snapshot.closures];
    if (facts.some((f) => f.confirmedAt > confirmedAt)) planningInvalid('confirmedAt', 'Recibo contém fatos futuros à confirmação.');
    if (status === 'accepted' && facts.filter((f) => f.receiptId === receiptId && f.confirmedAt === confirmedAt && f.groupRevision === groupRevision).length !== 1) planningInvalid('receiptId', 'Aceite deve referenciar exatamente um fato da revisão confirmada.');
  }
  return { apiVersion: 'v1', idempotencyKey: planningUid(source.idempotencyKey, 'idempotencyKey'), receiptId, groupId, groupRevision, status, message: source.message === null ? null : opaque(source.message, 'message', false), confirmedAt, snapshot };
}
export interface SettlementView {
  snapshot: SettlementSnapshot;
  finance: SettlementFinance;
  pool(poolId: string): PoolSettlementBalance | null;
  statement(poolId: string): SettlementStatement;
}
export function createSettlementView(input: SettlementSnapshot): SettlementView {
  const snapshot = validateSettlementSnapshot(input), finance = financeProjection(snapshot);
  const statement = (poolId: string): SettlementStatement => {
    const pool = finance.pools[poolId]; if (!pool) return planningInvalid('poolId', 'Bolão sem manifesto para demonstrativo.');
    return { label: 'Demonstrativo do grupo', groupId: snapshot.groupId, groupRevision: snapshot.groupRevision, pool, closure: latest(snapshot.closures, poolId) };
  };
  return { snapshot, finance, pool: (poolId) => finance.pools[poolId] ?? null, statement };
}
export function computeSettlement(snapshot: SettlementSnapshot): SettlementFinance { return createSettlementView(snapshot).finance; }
export function settlementStatement(snapshot: SettlementSnapshot, poolId: string): SettlementStatement { return createSettlementView(snapshot).statement(poolId); }
