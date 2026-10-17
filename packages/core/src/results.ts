import type { LotteryId } from './types';
import type { ContestCalendarVersion, ContestResultData, ContestResultVersion, CurrentResultView, ResultAction, ResultCommand, ResultPayout, ResultReceipt, ResultSelection, ResultSnapshot } from './result-types';
import { canonicalJSON } from './canonical';
import { lotteryRule } from './lotteries';
import { officialResultUrl, parseCaixaCalendar, parseCaixaResult, RESULT_PRIZE_TIERS } from './caixa-results';
import { planningInt, planningInvalid, planningList, planningOption, planningRecord, planningShape, planningText, planningUid } from './prepared-plans';
import { sourceDate, sourceRaw, sourceTime, verifySourceHash } from './source-validation';
import { decimalTokenToInteger, JsonNumber, parseLosslessJSON } from './lossless-json';
import type { LosslessJson } from './lossless-json';

export const MAX_RESULT_COMMAND_BYTES = 1_048_576;
export const BRASILIA_TIME_ZONE = 'America/Sao_Paulo';
export const OFFICIAL_CALENDAR_URL = 'https://loterias.caixa.gov.br/Paginas/regras-sorteios.aspx';
const LOTTERY_IDS: readonly LotteryId[] = ['mega-sena', 'lotofacil', 'quina'];
const DATA_KEYS = ['lotteryId', 'contestNumber', 'drawDate', 'drawnNumbers', 'payouts'] as const;
const CALENDAR_KEYS = ['lotteryId', 'contestNumber', 'drawDate', 'expectedDrawAt', 'registrationClosesAt'] as const;

function naturalString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,99})$/.test(value)) return planningInvalid(field, 'Inteiro canônico não negativo exige até 100 dígitos.');
  return value;
}
function nullableDate(value: unknown, field: string): string | null { return value === null ? null : sourceDate(value, field); }
function nullableTime(value: unknown, field: string): string | null { return value === null ? null : sourceTime(value, field); }
function uniqueIds<T extends { id: string }>(values: T[], field: string): T[] {
  if (new Set(values.map((v) => v.id)).size !== values.length) planningInvalid(field, 'Fato imutável repetido.');
  return values;
}
function uuidList(value: unknown, field: string): string[] {
  const values = planningList(value, field, 10_000).map((id) => planningUid(id, field));
  if (new Set(values).size !== values.length) planningInvalid(field, 'Identificador repetido.');
  return values;
}

export function validateResultData(input: unknown): ContestResultData {
  const data = planningRecord(input, 'data'); planningShape(data, DATA_KEYS, 'data');
  const lotteryId = planningOption<LotteryId>(data.lotteryId, LOTTERY_IDS, 'lotteryId');
  const rule = lotteryRule(lotteryId);
  let drawnNumbers: number[] | null = null;
  if (data.drawnNumbers !== null) {
    drawnNumbers = planningList(data.drawnNumbers, 'drawnNumbers', rule.drawSize).map((n) => planningInt(n, 'drawnNumbers', 1, rule.universeSize)).sort((a, b) => a - b);
    if (drawnNumbers.length !== rule.drawSize || new Set(drawnNumbers).size !== drawnNumbers.length) planningInvalid('drawnNumbers', 'Resultado exige todas as dezenas sorteadas, sem repetição.');
  }
  let payouts: ResultPayout[] | null = null;
  if (data.payouts !== null) {
    const tiers = RESULT_PRIZE_TIERS[lotteryId];
    const byHits = new Map<number, ResultPayout>();
    for (const inputPayout of planningList(data.payouts, 'payouts', tiers.length)) {
      const row = planningRecord(inputPayout, 'payout'); planningShape(row, ['hits', 'winnerCount', 'prizeCents'], 'payout');
      const hits = planningInt(row.hits, 'hits', 1, rule.drawSize);
      if (!tiers.includes(hits) || byHits.has(hits)) planningInvalid('hits', 'Faixa de prêmio inválida ou repetida.');
      byHits.set(hits, { hits, winnerCount: row.winnerCount === null ? null : naturalString(row.winnerCount, 'winnerCount'), prizeCents: row.prizeCents === null ? null : naturalString(row.prizeCents, 'prizeCents') });
    }
    payouts = tiers.map((hits) => byHits.get(hits) ?? { hits, winnerCount: null, prizeCents: null });
  }
  return { lotteryId, contestNumber: planningInt(data.contestNumber, 'contestNumber', 1, 999_999), drawDate: nullableDate(data.drawDate, 'drawDate'), drawnNumbers, payouts };
}

function brasiliaDate(utc: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BRASILIA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(utc));
  const part = (kind: string): string => parts.find((p) => p.type === kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function calendarData(input: Record<string, unknown>): Pick<ContestCalendarVersion, typeof CALENDAR_KEYS[number]> {
  const lotteryId = planningOption<LotteryId>(input.lotteryId, LOTTERY_IDS, 'lotteryId');
  const contestNumber = planningInt(input.contestNumber, 'contestNumber', 1, 999_999);
  const drawDate = nullableDate(input.drawDate, 'drawDate');
  const expectedDrawAt = nullableTime(input.expectedDrawAt, 'expectedDrawAt');
  const registrationClosesAt = nullableTime(input.registrationClosesAt, 'registrationClosesAt');
  if (drawDate && expectedDrawAt && brasiliaDate(expectedDrawAt) !== drawDate) planningInvalid('expectedDrawAt', 'Horário previsto não pertence à data do sorteio em Brasília.');
  if (registrationClosesAt && expectedDrawAt && registrationClosesAt > expectedDrawAt) planningInvalid('registrationClosesAt', 'Encerramento do canal não pode ser posterior ao sorteio previsto.');
  return { lotteryId, contestNumber, drawDate, expectedDrawAt, registrationClosesAt };
}

function validateResultAction(input: unknown): ResultAction {
  const action = planningRecord(input, 'action');
  const common = ['type', 'poolId', 'poolVersion'];
  const poolId = planningUid(action.poolId, 'poolId');
  const poolVersion = planningInt(action.poolVersion, 'poolVersion', 1);
  if (action.type === 'result_manual') {
    planningShape(action, [...common, 'data', 'sourceReference', 'reason'], 'action');
    const data = validateResultData(action.data);
    if (!data.drawnNumbers) planningInvalid('drawnNumbers', 'Entrada manual exige números efetivamente informados.');
    return { type: 'result_manual', poolId, poolVersion, data, sourceReference: planningText(action.sourceReference, 'sourceReference', 2_000, true), reason: planningText(action.reason, 'reason', 2_000, true) };
  }
  if (action.type === 'result_resolve') {
    planningShape(action, [...common, 'resultId', 'observedResultIds', 'reason'], 'action');
    const resultId = planningUid(action.resultId, 'resultId');
    const observedResultIds = uuidList(action.observedResultIds, 'observedResultIds');
    if (!observedResultIds.includes(resultId)) planningInvalid('resultId', 'Escolha deve constar nas versões efetivamente revisadas.');
    return { type: 'result_resolve', poolId, poolVersion, resultId, observedResultIds, reason: planningText(action.reason, 'reason', 2_000, true) };
  }
  if (action.type === 'calendar_confirm') {
    planningShape(action, [...common, ...CALENDAR_KEYS, 'sourceReference', 'reason'], 'action');
    return { type: 'calendar_confirm', poolId, poolVersion, ...calendarData(action), sourceReference: planningText(action.sourceReference, 'sourceReference', 2_000, true), reason: planningText(action.reason, 'reason', 2_000, true) };
  }
  return planningInvalid('type', 'Ação de resultado ou calendário não suportada.');
}
export function validateResultCommand(input: unknown): ResultCommand {
  const source = planningRecord(input, 'command'); planningShape(source, ['apiVersion', 'idempotencyKey', 'groupId', 'expectedRevision', 'action'], 'command');
  if (source.apiVersion !== 'v1') planningInvalid('apiVersion', 'Versão da API não suportada.');
  const command: ResultCommand = { apiVersion: 'v1', idempotencyKey: planningUid(source.idempotencyKey, 'idempotencyKey'), groupId: planningUid(source.groupId, 'groupId'), expectedRevision: planningInt(source.expectedRevision, 'expectedRevision'), action: validateResultAction(source.action) };
  if (new TextEncoder().encode(JSON.stringify(command)).length > MAX_RESULT_COMMAND_BYTES) planningInvalid('command', 'Comando de resultados excede 1 MiB.');
  return command;
}
export function manualResultRaw(action: Extract<ResultAction, { type: 'result_manual' | 'calendar_confirm' }>): string {
  return canonicalJSON(validateResultAction(action));
}
function manualSource(rawText: string): ResultAction {
  const plain = (value: LosslessJson): unknown => {
    if (value instanceof JsonNumber) {
      const integer = decimalTokenToInteger(value.token, 0, 'rawText');
      if (integer.length > 16) return planningInvalid('rawText', 'Fonte manual contém inteiro fora do limite.');
      return planningInt(Number(integer), 'rawText');
    }
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
    return value;
  };
  return validateResultAction(plain(parseLosslessJSON(rawText)));
}

export function validateResultVersion(input: unknown): ContestResultVersion {
  const source = planningRecord(input, 'result');
  planningShape(source, ['id', 'groupId', 'poolId', 'version', ...DATA_KEYS, 'source', 'sourceUrl', 'sourceReference', 'rawText', 'sha256', 'collectedAt', 'status', 'receiptId'], 'result');
  const data = validateResultData(Object.fromEntries(DATA_KEYS.map((key) => [key, source[key]])));
  const poolId = planningUid(source.poolId, 'poolId');
  const origin = planningOption(source.source, ['caixa', 'manual'], 'source');
  const rawText = sourceRaw(source.rawText);
  const sha256 = verifySourceHash(rawText, source.sha256);
  const collectedAt = sourceTime(source.collectedAt, 'collectedAt');
  const sourceReference = planningText(source.sourceReference, 'sourceReference', 2_000, true);
  const receiptId = source.receiptId === null ? null : planningUid(source.receiptId, 'receiptId');
  let sourceUrl: string | null = null;
  let status: ContestResultVersion['status'];
  if (origin === 'caixa') {
    sourceUrl = officialResultUrl(source.sourceUrl, data.lotteryId, data.contestNumber);
    const parsed = parseCaixaResult({ lotteryId: data.lotteryId, contestNumber: data.contestNumber, sourceUrl, rawText, collectedAt });
    const parsedData = Object.fromEntries(DATA_KEYS.map((key) => [key, parsed[key]]));
    if (canonicalJSON(parsedData) !== canonicalJSON(data) || source.status !== parsed.status || receiptId !== null) planningInvalid('result', 'Resultado oficial deve corresponder exatamente à fonte original, sem recibo humano.');
    status = parsed.status;
  } else {
    const action = manualSource(rawText);
    if (source.sourceUrl !== null || !receiptId || source.status !== 'manual' || action.type !== 'result_manual' || action.poolId !== poolId || action.sourceReference !== sourceReference || canonicalJSON(action.data) !== canonicalJSON(data)) planningInvalid('result', 'Resultado manual exige ação original, fonte e confirmação humana correspondentes.');
    status = 'manual';
  }
  return { id: planningUid(source.id, 'id'), groupId: planningUid(source.groupId, 'groupId'), poolId, version: planningInt(source.version, 'version', 1), ...data, source: origin, sourceUrl, sourceReference, rawText, sha256, collectedAt, status, receiptId };
}

export function validateCalendarVersion(input: unknown): ContestCalendarVersion {
  const source = planningRecord(input, 'calendar');
  planningShape(source, ['id', 'groupId', 'poolId', 'version', ...CALENDAR_KEYS, 'source', 'sourceUrl', 'sourceReference', 'rawText', 'sha256', 'collectedAt', 'timeZone', 'receiptId'], 'calendar');
  const data = calendarData(source);
  const poolId = planningUid(source.poolId, 'poolId');
  const origin = planningOption(source.source, ['caixa', 'manual'], 'source');
  const rawText = sourceRaw(source.rawText), sha256 = verifySourceHash(rawText, source.sha256);
  const collectedAt = sourceTime(source.collectedAt, 'collectedAt');
  const sourceReference = planningText(source.sourceReference, 'sourceReference', 2_000, true);
  const receiptId = source.receiptId === null ? null : planningUid(source.receiptId, 'receiptId');
  if (source.timeZone !== BRASILIA_TIME_ZONE) planningInvalid('timeZone', 'Calendário usa o fuso IANA de Brasília.');
  let sourceUrl: string | null = null;
  if (origin === 'caixa') {
    sourceUrl = officialResultUrl(source.sourceUrl, data.lotteryId);
    const parsed = parseCaixaCalendar({ lotteryId: data.lotteryId, contestNumber: data.contestNumber, sourceUrl, rawText, collectedAt });
    if (parsed.drawDate !== data.drawDate || data.expectedDrawAt !== null || data.registrationClosesAt !== null || receiptId !== null) planningInvalid('calendar', 'Calendário JSON oficial informa apenas a data correspondente, sem horário inferido.');
  } else {
    const action = manualSource(rawText);
    if (source.sourceUrl !== null || !receiptId || action.type !== 'calendar_confirm' || action.poolId !== poolId || action.sourceReference !== sourceReference || CALENDAR_KEYS.some((key) => action[key] !== data[key])) planningInvalid('calendar', 'Calendário manual exige ação original e confirmação humana correspondentes.');
  }
  return { id: planningUid(source.id, 'id'), groupId: planningUid(source.groupId, 'groupId'), poolId, version: planningInt(source.version, 'version', 1), ...data, source: origin, sourceUrl, sourceReference, rawText, sha256, collectedAt, timeZone: BRASILIA_TIME_ZONE, receiptId };
}

function versions<T extends { poolId: string; version: number }>(facts: T[], field: string): Map<string, T[]> {
  const byPool = new Map<string, T[]>();
  for (const fact of facts) { const values = byPool.get(fact.poolId) ?? []; values.push(fact); byPool.set(fact.poolId, values); }
  for (const values of byPool.values()) {
    values.sort((a, b) => a.version - b.version);
    values.forEach((v, i) => { if (v.version !== i + 1) planningInvalid(field, 'Versões precisam ser contínuas e únicas por bolão.'); });
  }
  return byPool;
}
export function validateResultSnapshot(input: unknown): ResultSnapshot {
  const source = planningRecord(input, 'snapshot'); planningShape(source, ['groupId', 'groupRevision', 'results', 'selections', 'calendarVersions'], 'snapshot');
  const groupId = planningUid(source.groupId, 'groupId'), groupRevision = planningInt(source.groupRevision, 'groupRevision');
  const results = uniqueIds(planningList(source.results, 'results', 10_000).map(validateResultVersion), 'results');
  const calendarVersions = uniqueIds(planningList(source.calendarVersions, 'calendarVersions', 10_000).map(validateCalendarVersion), 'calendarVersions');
  const selections = uniqueIds(planningList(source.selections, 'selections', 10_000).map((inputSelection): ResultSelection => {
    const selection = planningRecord(inputSelection, 'selection'); planningShape(selection, ['id', 'groupId', 'poolId', 'version', 'resultId', 'observedResultIds', 'reason', 'selectedAt', 'receiptId'], 'selection');
    return { id: planningUid(selection.id, 'id'), groupId: planningUid(selection.groupId, 'groupId'), poolId: planningUid(selection.poolId, 'poolId'), version: planningInt(selection.version, 'version', 1), resultId: planningUid(selection.resultId, 'resultId'), observedResultIds: uuidList(selection.observedResultIds, 'observedResultIds'), reason: planningText(selection.reason, 'reason', 2_000, true), selectedAt: sourceTime(selection.selectedAt, 'selectedAt'), receiptId: planningUid(selection.receiptId, 'receiptId') };
  }), 'selections');
  const all = [...results, ...calendarVersions, ...selections];
  if (all.some((fact) => fact.groupId !== groupId) || (all.length && groupRevision === 0)) planningInvalid('groupId', 'Fatos de resultados exigem grupo e revisão confirmados.');
  uniqueIds(all, 'facts');
  const byResult = new Map(results.map((r) => [r.id, r]));
  const resultsByPool = versions(results, 'results');
  versions(calendarVersions, 'calendarVersions');
  const selectionsByPool = versions(selections, 'selections');
  // A teimosinha holds one pool's results for several consecutive contests (the range is checked where facts are written);
  // every version of a pool still belongs to one lottery.
  const context = new Map<string, string>();
  for (const fact of [...results, ...calendarVersions]) {
    if (context.has(fact.poolId) && context.get(fact.poolId) !== fact.lotteryId) planningInvalid('poolId', 'Versões de um bolão precisam tratar a mesma modalidade.');
    context.set(fact.poolId, fact.lotteryId);
  }
  for (const [poolId, poolSelections] of selectionsByPool) for (let i = 0; i < poolSelections.length; i++) {
    const selection = poolSelections[i]!;
    const picked = byResult.get(selection.resultId);
    const observed = selection.observedResultIds.map((id) => byResult.get(id));
    if (!picked || picked.poolId !== poolId || !selection.observedResultIds.includes(picked.id) || observed.some((r) => !r || r.poolId !== poolId || r.collectedAt > selection.selectedAt)) planningInvalid('selections', 'Escolha exige versões existentes, deste bolão e vistas antes da revisão.');
    if (observed.some((r) => r!.contestNumber !== picked.contestNumber)) planningInvalid('observedResultIds', 'Uma revisão resolve as versões de um concurso só.');
    const highest = Math.max(...observed.map((r) => r!.version));
    const prefix = resultsByPool.get(poolId)!.filter((r) => r.contestNumber === picked.contestNumber && r.version <= highest);
    if (prefix.length !== observed.length || prefix.some((r) => !selection.observedResultIds.includes(r.id))) planningInvalid('observedResultIds', 'Revisão não pode omitir uma versão anterior ao conjunto observado.');
    const previous = poolSelections.slice(0, i).reverse().find((s) => byResult.get(s.resultId)?.contestNumber === picked.contestNumber);
    if (previous && (selection.selectedAt < previous.selectedAt || previous.observedResultIds.some((id) => !selection.observedResultIds.includes(id)))) planningInvalid('selections', 'Revisões devem preservar o histórico observado e a ordem de aprovação.');
  }
  const receipts = all.map((f) => f.receiptId).filter((id) => id !== null);
  if (new Set(receipts).size !== receipts.length) planningInvalid('receiptId', 'Uma decisão humana de resultado cria exatamente um fato.');
  return { groupId, groupRevision, results, selections, calendarVersions };
}

export function validateResultReceipt(input: unknown): ResultReceipt {
  const source = planningRecord(input, 'receipt'); planningShape(source, ['apiVersion', 'idempotencyKey', 'receiptId', 'groupId', 'status', 'groupRevision', 'message', 'confirmedAt', 'snapshot'], 'receipt');
  if (source.apiVersion !== 'v1') planningInvalid('apiVersion', 'Versão da API não suportada.');
  const groupId = planningUid(source.groupId, 'groupId'), groupRevision = planningInt(source.groupRevision, 'groupRevision');
  const status = planningOption(source.status, ['accepted', 'conflict', 'rejected'], 'status');
  const receiptId = source.receiptId === null ? null : planningUid(source.receiptId, 'receiptId');
  const confirmedAt = source.confirmedAt === null ? null : sourceTime(source.confirmedAt, 'confirmedAt');
  const snapshot = source.snapshot === null ? null : validateResultSnapshot(source.snapshot);
  if (snapshot && (snapshot.groupId !== groupId || snapshot.groupRevision !== groupRevision)) planningInvalid('snapshot', 'Recibo e retrato de resultados devem ter mesmo grupo e revisão.');
  if (status === 'accepted' && (!snapshot || !confirmedAt || !receiptId)) planningInvalid('status', 'Aceite exige recibo, retrato e horário do servidor.');
  if (status !== 'accepted' && (confirmedAt !== null || receiptId !== null)) planningInvalid('status', 'Rejeição ou conflito não contém confirmação.');
  if (snapshot && confirmedAt) {
    if (snapshot.results.some((r) => r.collectedAt > confirmedAt) || snapshot.selections.some((r) => r.selectedAt > confirmedAt) || snapshot.calendarVersions.some((r) => r.collectedAt > confirmedAt)) planningInvalid('confirmedAt', 'Recibo contém fatos posteriores à confirmação.');
    const matching = snapshot.results.filter((r) => r.receiptId === receiptId && r.collectedAt === confirmedAt).length + snapshot.selections.filter((r) => r.receiptId === receiptId && r.selectedAt === confirmedAt).length + snapshot.calendarVersions.filter((r) => r.receiptId === receiptId && r.collectedAt === confirmedAt).length;
    if (status === 'accepted' && matching !== 1) planningInvalid('receiptId', 'Aceite deve identificar exatamente um novo fato humano.');
  }
  return { apiVersion: 'v1', idempotencyKey: planningUid(source.idempotencyKey, 'idempotencyKey'), receiptId, groupId, groupRevision, status, message: source.message === null ? null : planningText(source.message, 'message', 2_000), confirmedAt, snapshot };
}

function incompatible(a: ContestResultVersion, b: ContestResultVersion): boolean {
  if (a.drawDate && b.drawDate && a.drawDate !== b.drawDate) return true;
  if (a.drawnNumbers && b.drawnNumbers && a.drawnNumbers.join(',') !== b.drawnNumbers.join(',')) return true;
  for (const one of a.payouts ?? []) {
    const other = b.payouts?.find((r) => r.hits === one.hits);
    if (other && ((one.prizeCents !== null && other.prizeCents !== null && one.prizeCents !== other.prizeCents) || (one.winnerCount !== null && other.winnerCount !== null && one.winnerCount !== other.winnerCount))) return true;
  }
  return false;
}
function information(result: ContestResultVersion): number {
  return (result.drawnNumbers ? 1_000 : 0) + (result.drawDate ? 1 : 0) + (result.payouts ?? []).reduce((sum, p) => sum + (p.prizeCents !== null ? 10 : 0) + (p.winnerCount !== null ? 1 : 0), 0);
}
function selectCurrent(results: ContestResultVersion[], selections: ResultSelection[]): CurrentResultView {
  const selection = selections.reduce<ResultSelection | null>((current, next) => !current || next.version > current.version ? next : current, null);
  const selected = selection ? results.find((r) => r.id === selection.resultId)! : null;
  const unreviewed = selection ? results.filter((r) => !selection.observedResultIds.includes(r.id)) : results;
  const eligible = selected ? [selected, ...unreviewed] : unreviewed;
  const conflicting = new Set<string>();
  for (let a = 0; a < eligible.length; a++) for (let b = a + 1; b < eligible.length; b++) if (incompatible(eligible[a]!, eligible[b]!)) { conflicting.add(eligible[a]!.id); conflicting.add(eligible[b]!.id); }
  const result = eligible.slice().sort((a, b) => information(b) - information(a) || (a.source === b.source ? 0 : a.source === 'caixa' ? -1 : 1) || b.version - a.version)[0] ?? null;
  return { status: conflicting.size ? 'conflict' : result?.status ?? 'waiting', result, conflictingResultIds: [...conflicting].sort(), selectedResultId: selected?.id ?? null };
}
export interface ResultView {
  snapshot: ResultSnapshot;
  /** The contests this pool has results or calendars for, ascending (a teimosinha has several). */
  contestsOf(poolId: string): number[];
  /** Without a contest: the pool's first (lowest) contest with facts, which is the only one of a normal pool. */
  currentResult(poolId: string, contestNumber?: number): CurrentResultView;
  currentCalendar(poolId: string, contestNumber?: number): ContestCalendarVersion | null;
}
const NO_RESULT: CurrentResultView = { status: 'waiting', result: null, conflictingResultIds: [], selectedResultId: null };
/** Validates once; repeated UI reads do not reparse immutable raw sources. */
export function createResultView(input: ResultSnapshot): ResultView {
  const snapshot = validateResultSnapshot(input);
  const byResult = new Map(snapshot.results.map((r) => [r.id, r]));
  const resultMap = new Map<string, CurrentResultView>(), calendarMap = new Map<string, ContestCalendarVersion>(), contests = new Map<string, Set<number>>();
  const note = (poolId: string, contestNumber: number) => { if (!contests.has(poolId)) contests.set(poolId, new Set()); contests.get(poolId)!.add(contestNumber); };
  const keys = new Set(snapshot.results.map((r) => `${r.poolId}:${r.contestNumber}`));
  for (const key of keys) {
    const [poolId, contest] = key.split(':') as [string, string];
    const contestNumber = Number(contest);
    note(poolId, contestNumber);
    resultMap.set(key, selectCurrent(snapshot.results.filter((r) => r.poolId === poolId && r.contestNumber === contestNumber),
      snapshot.selections.filter((s) => s.poolId === poolId && byResult.get(s.resultId)?.contestNumber === contestNumber)));
  }
  for (const calendar of snapshot.calendarVersions) {
    const key = `${calendar.poolId}:${calendar.contestNumber}`;
    note(calendar.poolId, calendar.contestNumber);
    if (calendar.version > (calendarMap.get(key)?.version ?? 0)) calendarMap.set(key, calendar);
  }
  const contestsOf = (poolId: string) => [...(contests.get(poolId) ?? [])].sort((a, b) => a - b);
  const first = (poolId: string, contestNumber?: number) => contestNumber ?? contestsOf(poolId)[0];
  return {
    snapshot, contestsOf,
    currentResult: (poolId, contestNumber) => resultMap.get(`${poolId}:${first(poolId, contestNumber)}`) ?? NO_RESULT,
    currentCalendar: (poolId, contestNumber) => calendarMap.get(`${poolId}:${first(poolId, contestNumber)}`) ?? null,
  };
}
export function currentResult(snapshot: ResultSnapshot, poolId: string, contestNumber?: number): CurrentResultView { return createResultView(snapshot).currentResult(poolId, contestNumber); }
export function currentCalendar(snapshot: ResultSnapshot, poolId: string, contestNumber?: number): ContestCalendarVersion | null { return createResultView(snapshot).currentCalendar(poolId, contestNumber); }

/** IANA conversion, including historical DST. A missing/ambiguous civil hour needs explicit correction. */
export function brasiliaDateTimeToUTC(localDateTime: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(localDateTime)) return planningInvalid('localDateTime', 'Use data e hora civil YYYY-MM-DDTHH:mm[:ss].');
  const civil = localDateTime.length === 16 ? `${localDateTime}:00` : localDateTime;
  const naive = sourceTime(`${civil}.000Z`, 'localDateTime');
  const nominal = new Date(naive).getTime();
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: BRASILIA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const local = (instant: number): string => {
    const parts = format.formatToParts(new Date(instant));
    const part = (type: string): string => parts.find((p) => p.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  };
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = nominal + hours * 3_600_000;
    const displayed = new Date(`${local(instant)}.000Z`).getTime();
    offsets.add(displayed - instant);
  }
  const matches = [...offsets].map((offset) => nominal - offset).filter((instant) => local(instant) === civil);
  if (matches.length !== 1) planningInvalid('localDateTime', 'Hora civil inexistente ou ambígua no fuso de Brasília.');
  return new Date(matches[0]!).toISOString();
}
