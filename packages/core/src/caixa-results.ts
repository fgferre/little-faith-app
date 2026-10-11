import type { LotteryId } from './types';
import type { CaixaResultInput, ParsedCaixaResult, ResultPayout } from './result-types';
import { lotteryRule } from './lotteries';
import { planningInvalid, planningInt, planningOption, planningRecord, planningShape } from './prepared-plans';
import { decimalBRLTokenToCents, decimalTokenToInteger, JsonNumber, parseLosslessJSON } from './lossless-json';
import type { LosslessJson } from './lossless-json';
import { sourceDate, sourceRaw, sourceTime } from './source-validation';
import { sha256Hex } from './canonical';

export const RESULT_SOURCE_VERSION = 'caixa-servicebus-2026-10-08-v1';
export const RESULT_SOURCE_VERIFIED_AT = '2026-10-08';
export const RESULT_SOURCE_URLS: Readonly<Record<LotteryId, string>> = Object.freeze({
  'mega-sena': 'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena',
  lotofacil: 'https://servicebus2.caixa.gov.br/portaldeloterias/api/lotofacil',
  quina: 'https://servicebus2.caixa.gov.br/portaldeloterias/api/quina',
});
export const RESULT_PRIZE_TIERS: Readonly<Record<LotteryId, readonly number[]>> = Object.freeze({
  'mega-sena': Object.freeze([6, 5, 4]), lotofacil: Object.freeze([15, 14, 13, 12, 11]), quina: Object.freeze([5, 4, 3, 2]),
});
const GAME_TYPES: Readonly<Record<LotteryId, string>> = { 'mega-sena': 'MEGA_SENA', lotofacil: 'LOTOFACIL', quina: 'QUINA' };

export function officialResultUrl(value: unknown, lotteryId: LotteryId, contestNumber?: number): string {
  if (typeof value !== 'string') return planningInvalid('sourceUrl', 'URL oficial obrigatória.');
  let url: URL;
  try { url = new URL(value); } catch { return planningInvalid('sourceUrl', 'URL oficial inválida.'); }
  const base = new URL(RESULT_SOURCE_URLS[lotteryId]);
  if (url.protocol !== 'https:' || url.hostname !== base.hostname || url.port || url.username || url.password || url.search || url.hash) return planningInvalid('sourceUrl', 'Fonte deve ser o serviço oficial CAIXA.');
  const path = url.pathname.replace(/\/$/, '');
  const suffix = path.slice(base.pathname.length);
  if (!path.startsWith(base.pathname) || (suffix !== '' && !/^\/[1-9]\d{0,5}$/.test(suffix))) return planningInvalid('sourceUrl', 'Endpoint incompatível com a modalidade.');
  if (contestNumber !== undefined && suffix && Number(suffix.slice(1)) !== contestNumber) return planningInvalid('sourceUrl', 'URL corresponde a outro concurso.');
  return value;
}
function object(value: LosslessJson | undefined, field: string): Record<string, LosslessJson> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof JsonNumber) return planningInvalid(field, 'Objeto JSON obrigatório.');
  return value as Record<string, LosslessJson>;
}
function integer(value: LosslessJson | undefined, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!(value instanceof JsonNumber)) return planningInvalid(field, 'Inteiro JSON obrigatório.');
  const exact = decimalTokenToInteger(value.token, 0, field);
  if (exact.length > 16) return planningInvalid(field, 'Inteiro fora do limite.');
  return planningInt(Number(exact), field, min, max);
}
function optionalInteger(value: LosslessJson | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof JsonNumber)) return planningInvalid(field, 'Quantidade JSON inválida.');
  return decimalTokenToInteger(value.token, 0, field);
}
function optionalPrize(value: LosslessJson | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof JsonNumber)) return planningInvalid('valorPremio', 'Valor monetário JSON inválido.');
  return decimalBRLTokenToCents(value.token);
}
function caixaDate(value: LosslessJson | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return planningInvalid(field, 'Data CAIXA inválida.');
  return sourceDate(`${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`, field);
}
function rawNumbers(value: LosslessJson | undefined, lotteryId: LotteryId): number[] | null {
  if (value === undefined || value === null || (Array.isArray(value) && !value.length)) return null;
  const rule = lotteryRule(lotteryId);
  if (!Array.isArray(value) || value.length !== rule.drawSize) return planningInvalid('listaDezenas', 'Quantidade de dezenas sorteadas incompatível.');
  const numbers = value.map((number) => {
    if (typeof number !== 'string' || !/^\d{1,2}$/.test(number)) return planningInvalid('listaDezenas', 'Dezena CAIXA inválida.');
    return planningInt(Number(number), 'listaDezenas', 1, rule.universeSize);
  }).sort((a, b) => a - b);
  if (new Set(numbers).size !== numbers.length) return planningInvalid('listaDezenas', 'Resultado contém dezenas repetidas.');
  return numbers;
}
function rawPayouts(value: LosslessJson | undefined, lotteryId: LotteryId): ResultPayout[] | null {
  if (value === undefined || value === null || (Array.isArray(value) && !value.length)) return null;
  const tiers = RESULT_PRIZE_TIERS[lotteryId];
  if (!Array.isArray(value) || value.length > tiers.length) return planningInvalid('listaRateioPremio', 'Rateio incompatível com a modalidade.');
  const payouts = new Map<number, ResultPayout>();
  for (const row of value) {
    const source = object(row, 'listaRateioPremio');
    const faixa = integer(source.faixa, 'faixa', 1, tiers.length);
    const hits = tiers[faixa - 1]!;
    if (payouts.has(hits)) return planningInvalid('faixa', 'Faixa de prêmio repetida.');
    if (source.descricaoFaixa !== undefined && (typeof source.descricaoFaixa !== 'string' || source.descricaoFaixa.trim().toLowerCase() !== `${hits} acertos`)) return planningInvalid('descricaoFaixa', 'Descrição de faixa incompatível.');
    payouts.set(hits, { hits, winnerCount: optionalInteger(source.numeroDeGanhadores, 'numeroDeGanhadores'), prizeCents: optionalPrize(source.valorPremio) });
  }
  return tiers.map((hits) => payouts.get(hits) ?? { hits, winnerCount: null, prizeCents: null });
}

/** Public source parser; missing values remain null and original UTF-8 text remains untouched. */
export function parseCaixaResult(input: CaixaResultInput): ParsedCaixaResult {
  const supplied = planningRecord(input, 'resultSource');
  planningShape(supplied, ['lotteryId', 'contestNumber', 'rawText', 'sourceUrl', 'collectedAt'], 'resultSource');
  const lotteryId = planningOption<LotteryId>(input.lotteryId, ['mega-sena', 'lotofacil', 'quina'], 'lotteryId');
  const contestNumber = planningInt(input.contestNumber, 'contestNumber', 1, 999_999);
  const sourceUrl = officialResultUrl(input.sourceUrl, lotteryId, contestNumber);
  const rawText = sourceRaw(input.rawText);
  const collectedAt = sourceTime(input.collectedAt, 'collectedAt');
  const source = object(parseLosslessJSON(rawText), 'rawText');
  if (integer(source.numero, 'numero', 1, 999_999) !== contestNumber) return planningInvalid('numero', 'Resposta CAIXA corresponde a outro concurso.');
  if (source.tipoJogo !== GAME_TYPES[lotteryId]) return planningInvalid('tipoJogo', 'Resposta CAIXA corresponde a outra modalidade.');
  const drawnNumbers = rawNumbers(source.listaDezenas, lotteryId);
  const payouts = rawPayouts(source.listaRateioPremio, lotteryId);
  const drawDate = caixaDate(source.dataApuracao, 'dataApuracao');
  const nextNumber = source.numeroConcursoProximo === undefined || source.numeroConcursoProximo === null ? 0 : integer(source.numeroConcursoProximo, 'numeroConcursoProximo', 0, 999_999);
  const nextDate = caixaDate(source.dataProximoConcurso, 'dataProximoConcurso');
  const nextContest = nextNumber > 0 && nextDate !== null ? { contestNumber: nextNumber, drawDate: nextDate } : null;
  return { lotteryId, contestNumber, drawDate, drawnNumbers, payouts, status: drawnNumbers === null ? 'waiting' : payouts?.every((p) => p.prizeCents !== null) ? 'complete' : 'numbers-only', sourceUrl, rawText, sha256: sha256Hex(rawText), collectedAt, nextContest };
}

/** Dates only: the public result JSON does not establish hours or channel closing times. */
export function parseCaixaCalendar(input: CaixaResultInput): { drawDate: string | null; expectedDrawAt: null; registrationClosesAt: null } {
  const lotteryId = planningOption<LotteryId>(input.lotteryId, ['mega-sena', 'lotofacil', 'quina'], 'lotteryId');
  const source = object(parseLosslessJSON(sourceRaw(input.rawText)), 'rawText');
  const currentNumber = integer(source.numero, 'numero', 1, 999_999);
  const parsed = parseCaixaResult({ ...input, contestNumber: currentNumber });
  const target = planningInt(input.contestNumber, 'contestNumber', 1, 999_999);
  const drawDate = target === currentNumber ? parsed.drawDate : parsed.nextContest?.contestNumber === target ? parsed.nextContest.drawDate : planningInvalid('contestNumber', 'Calendário CAIXA não referencia este concurso.');
  if (parsed.lotteryId !== lotteryId) planningInvalid('lotteryId', 'Calendário incompatível.');
  return { drawDate, expectedDrawAt: null, registrationClosesAt: null };
}
