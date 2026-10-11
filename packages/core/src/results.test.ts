import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContestCalendarVersion, ContestResultVersion, LotteryId, ResultAction } from './index';
import { brasiliaDateTimeToUTC, createResultView, currentResult, decimalBRLTokenToCents, manualResultRaw, parseCaixaCalendar, parseCaixaResult, RESULT_SOURCE_URLS, sha256Hex, validateCalendarVersion, validateResultCommand, validateResultReceipt, validateResultSnapshot, validateResultVersion } from './index';
import { fixtureId, manualResult, REG_GROUP, REG_POOL, registrationCalendar, resultSnapshot } from './registration.test-fixtures';

const COLLECTED = '2026-10-08T15:10:00.000Z';
const raw = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MEGA_RAW = raw('caixa-megasena-3000.json');
function official(rawText = MEGA_RAW, version = 1): ContestResultVersion {
  const parsed = parseCaixaResult({ lotteryId: 'mega-sena', contestNumber: 3000, sourceUrl: `${RESULT_SOURCE_URLS['mega-sena']}/3000`, collectedAt: COLLECTED, rawText });
  return { id: fixtureId(7000 + version), groupId: REG_GROUP, poolId: REG_POOL, version, lotteryId: parsed.lotteryId, contestNumber: parsed.contestNumber, drawDate: parsed.drawDate, drawnNumbers: parsed.drawnNumbers, payouts: parsed.payouts, source: 'caixa', sourceUrl: parsed.sourceUrl, sourceReference: parsed.sourceUrl, rawText, sha256: parsed.sha256, collectedAt: parsed.collectedAt, status: parsed.status, receiptId: null };
}
function editedRaw(edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(MEGA_RAW) as Record<string, unknown>; edit(value); return JSON.stringify(value);
}

describe('official CAIXA raw result parser', () => {
  it('matches captured real public responses from all supported modalities, including published zero', () => {
    const fixtures: [LotteryId, number, string, string[]][] = [
      ['mega-sena', 3000, 'caixa-megasena-3000.json', ['0', '6462776', '131767']],
      ['lotofacil', 3600, 'caixa-lotofacil-3600.json', ['499538367', '207931', '3500', '1400', '700']],
      ['quina', 7000, 'caixa-quina-7000.json', ['0', '1696350', '16010', '548']],
    ];
    for (const [lotteryId, contestNumber, file, prices] of fixtures) {
      const parsed = parseCaixaResult({ lotteryId, contestNumber, rawText: raw(file), sourceUrl: `${RESULT_SOURCE_URLS[lotteryId]}/${contestNumber}`, collectedAt: COLLECTED });
      expect(parsed.status).toBe('complete'); expect(parsed.payouts!.map((p) => p.prizeCents)).toEqual(prices);
      expect(parsed.sha256).toBe(createHash('sha256').update(raw(file), 'utf8').digest('hex'));
      expect(parsed.drawDate).toMatch(/^2026-\d{2}-\d{2}$/); expect(parsed.nextContest).not.toBeNull();
    }
  });
  it('retains CRLF, outer whitespace and every raw UTF-8 byte in the hash', () => {
    const original = ` \r\n${MEGA_RAW}\r\n\t`;
    const parsed = parseCaixaResult({ lotteryId: 'mega-sena', contestNumber: 3000, rawText: original, sourceUrl: RESULT_SOURCE_URLS['mega-sena'], collectedAt: COLLECTED });
    expect(parsed.rawText).toBe(original); expect(parsed.sha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(parsed.sha256).not.toBe(sha256Hex(MEGA_RAW));
  });
  it('preserves decimal lexemes beyond Number precision and exact exponent representations', () => {
    const original = MEGA_RAW.replace('"valorPremio": 0.0', '"valorPremio": 9007199254740993.01');
    expect(official(original).payouts![0]!.prizeCents).toBe('900719925474099301');
    expect(decimalBRLTokenToCents('16963.5')).toBe('1696350');
    expect(decimalBRLTokenToCents('1.25e3')).toBe('125000');
    expect(decimalBRLTokenToCents('100e-4')).toBe('1');
    expect(decimalBRLTokenToCents('0.000000')).toBe('0');
    expect(() => decimalBRLTokenToCents('0.001')).toThrow('fração');
    expect(() => decimalBRLTokenToCents('1.0000000000000000000001')).toThrow('fração');
    expect(() => decimalBRLTokenToCents('1e999999999')).toThrow('Expoente');
  });
  it('distinguishes waiting, numbers only and missing individual payout fields', () => {
    const waiting = official(editedRaw((value) => { value.listaDezenas = null; value.listaRateioPremio = null; }));
    expect(waiting.status).toBe('waiting'); expect(waiting.drawnNumbers).toBeNull(); expect(waiting.payouts).toBeNull();
    const pending = official(editedRaw((value) => { value.listaRateioPremio = null; }));
    expect(pending.status).toBe('numbers-only'); expect(pending.payouts).toBeNull();
    const partial = official(editedRaw((value) => { value.listaRateioPremio = [{ faixa: 3, descricaoFaixa: '4 acertos', numeroDeGanhadores: 5255, valorPremio: 1317.67 }]; }));
    expect(partial.status).toBe('numbers-only'); expect(partial.payouts!.map((p) => p.prizeCents)).toEqual([null, null, '131767']);
  });
  it('rejects wrong context, ambiguous JSON keys, fractional cents and malformed draws', () => {
    expect(() => official(MEGA_RAW.replace('"numero": 3000', '"numero": 3001'))).toThrow('outro concurso');
    expect(() => official(MEGA_RAW.replace('"tipoJogo": "MEGA_SENA"', '"tipoJogo": "QUINA"'))).toThrow('outra modalidade');
    expect(() => official(MEGA_RAW.replace('"valorPremio": 0.0', '"valorPremio": 0.001'))).toThrow('fração');
    expect(() => official(MEGA_RAW.replace('"numero": 3000', '"numero": 3000, "numero": 3000'))).toThrow('repetida');
    expect(() => official(editedRaw((value) => { value.listaDezenas = ['22', '22', '36', '40', '52', '60']; }))).toThrow('repetidas');
    expect(() => parseCaixaResult({ lotteryId: 'mega-sena', contestNumber: 3000, rawText: MEGA_RAW, sourceUrl: 'https://example.com/portaldeloterias/api/megasena/3000', collectedAt: COLLECTED })).toThrow('oficial');
    expect(() => parseCaixaResult({ lotteryId: 'mega-sena', contestNumber: 3000, rawText: MEGA_RAW, sourceUrl: `${RESULT_SOURCE_URLS['mega-sena']}/3001`, collectedAt: COLLECTED })).toThrow('outro concurso');
  });
  it('checks stored data against the exact raw source and requires manual provenance', () => {
    const result = official(); expect(validateResultVersion(result)).toEqual(result);
    expect(() => validateResultVersion({ ...result, drawnNumbers: [1, 2, 3, 4, 5, 6] })).toThrow('fonte original');
    expect(() => validateResultVersion({ ...result, sha256: '00'.repeat(32) })).toThrow('Hash');
    expect(() => validateResultVersion({ ...result, receiptId: fixtureId(99) })).toThrow('sem recibo');
    const manual = manualResult(); expect(validateResultVersion(manual)).toEqual(manual);
    expect(() => validateResultVersion({ ...manual, rawText: manual.rawText.replace('"contestNumber":3000', '"contestNumber":3000.000000000000001'), sha256: sha256Hex(manual.rawText.replace('"contestNumber":3000', '"contestNumber":3000.000000000000001')) })).toThrow('fração');
    expect(() => validateResultVersion({ ...manual, sourceReference: 'Outra referência' })).toThrow('correspondentes');
  });
});

describe('append-only result versions and explicit conflict review', () => {
  it('keeps the last complete result when a later collection still has no numbers', () => {
    const complete = official(), waiting = official(editedRaw((value) => { value.listaDezenas = null; value.listaRateioPremio = null; value.dataApuracao = null; }), 2);
    const view = currentResult(resultSnapshot([complete, waiting]), REG_POOL);
    expect(view.status).toBe('complete'); expect(view.result?.id).toBe(complete.id);
    expect(currentResult(resultSnapshot([]), REG_POOL)).toMatchObject({ status: 'waiting', result: null });
  });
  it('reopens conflict when a new official response disagrees with a reviewed manual choice', () => {
    const manual = manualResult(), caixa = official(MEGA_RAW, 2);
    const snapshot = resultSnapshot([manual, caixa]);
    expect(currentResult(snapshot, REG_POOL).status).toBe('conflict');
    snapshot.selections.push({ id: fixtureId(8000), groupId: REG_GROUP, poolId: REG_POOL, version: 1, resultId: manual.id, observedResultIds: [manual.id, caixa.id], reason: 'Conferência humana sintética.', selectedAt: '2026-10-08T15:20:00.000Z', receiptId: fixtureId(8100) });
    expect(currentResult(snapshot, REG_POOL)).toMatchObject({ status: 'manual', result: { id: manual.id }, selectedResultId: manual.id });
    snapshot.results.push(official(MEGA_RAW, 3));
    const reopened = currentResult(snapshot, REG_POOL);
    expect(reopened.status).toBe('conflict'); expect(reopened.conflictingResultIds).toContain(manual.id); expect(reopened.conflictingResultIds).toContain(fixtureId(7003));
  });
  it('prefers a compatible, more complete official result without inventing merged facts', () => {
    const caixa = official(MEGA_RAW, 2);
    const manual = manualResult({ lotteryId: caixa.lotteryId, contestNumber: caixa.contestNumber, drawDate: caixa.drawDate, drawnNumbers: caixa.drawnNumbers, payouts: null });
    const view = createResultView(resultSnapshot([manual, caixa]));
    expect(view.currentResult(REG_POOL)).toMatchObject({ status: 'complete', result: { id: caixa.id } });
    expect(view.currentCalendar(REG_POOL)).toBeNull();
  });
  it('rejects omitted history, cross-pool selections and forged approvals', () => {
    const manual = manualResult(), caixa = official(MEGA_RAW, 2), snapshot = resultSnapshot([manual, caixa]);
    expect(() => validateResultSnapshot(resultSnapshot([caixa]))).toThrow('contínuas');
    const selection = { id: fixtureId(8000), groupId: REG_GROUP, poolId: REG_POOL, version: 1, resultId: caixa.id, observedResultIds: [caixa.id], reason: 'Escolha sintética.', selectedAt: '2026-10-08T15:20:00.000Z', receiptId: fixtureId(8100) };
    expect(() => validateResultSnapshot({ ...snapshot, selections: [selection] })).toThrow('omitir');
    expect(() => validateResultSnapshot({ ...snapshot, selections: [{ ...selection, observedResultIds: [manual.id, caixa.id], poolId: fixtureId(9) }] })).toThrow('deste bolão');
    expect(() => validateResultCommand({ apiVersion: 'v1', idempotencyKey: fixtureId(9000), groupId: REG_GROUP, expectedRevision: 13, actorId: fixtureId(99), action: { type: 'result_resolve', poolId: REG_POOL, poolVersion: 3, resultId: manual.id, observedResultIds: [manual.id], reason: 'Teste.' } })).toThrow('Campo');
  });
  it('ties an accepted receipt to exactly one human fact, not the caller idempotency key', () => {
    const manual = manualResult();
    const receipt = { apiVersion: 'v1', idempotencyKey: fixtureId(9000), receiptId: manual.receiptId, groupId: REG_GROUP, status: 'accepted', groupRevision: 14, confirmedAt: COLLECTED, message: null, snapshot: resultSnapshot([manual]) };
    expect(validateResultReceipt(receipt).receiptId).toBe(manual.receiptId);
    expect(() => validateResultReceipt({ ...receipt, receiptId: receipt.idempotencyKey })).toThrow('exatamente');
    expect(() => validateResultReceipt({ ...receipt, status: 'rejected' })).toThrow('não contém');
  });
});

describe('per-contest calendars and IANA time zones', () => {
  it('uses official current/next dates without inferring a midnight draw or channel closing hour', () => {
    const input = { lotteryId: 'mega-sena' as const, contestNumber: 3001, rawText: MEGA_RAW, sourceUrl: `${RESULT_SOURCE_URLS['mega-sena']}/3000`, collectedAt: COLLECTED };
    expect(parseCaixaCalendar(input)).toEqual({ drawDate: '2026-04-28', expectedDrawAt: null, registrationClosesAt: null });
    const calendar: ContestCalendarVersion = { id: fixtureId(9200), groupId: REG_GROUP, poolId: REG_POOL, version: 1, lotteryId: 'mega-sena', contestNumber: 3001, source: 'caixa', sourceUrl: input.sourceUrl, sourceReference: input.sourceUrl, rawText: MEGA_RAW, sha256: sha256Hex(MEGA_RAW), collectedAt: COLLECTED, timeZone: 'America/Sao_Paulo', drawDate: '2026-04-28', expectedDrawAt: null, registrationClosesAt: null, receiptId: null };
    expect(validateCalendarVersion(calendar)).toEqual(calendar);
    expect(() => validateCalendarVersion({ ...calendar, expectedDrawAt: '2026-04-28T00:00:00.000Z' })).toThrow();
  });
  it('freezes human calendar fields and validates the Brasília date separately from UTC', () => {
    const calendar = registrationCalendar(); expect(validateCalendarVersion(calendar)).toEqual(calendar);
    expect(calendar.expectedDrawAt!.slice(0, 10)).not.toBe(calendar.drawDate);
    expect(() => validateCalendarVersion({ ...calendar, drawDate: '2026-10-09' })).toThrow('Brasília');
    const action: Extract<ResultAction, { type: 'calendar_confirm' }> = { type: 'calendar_confirm', poolId: REG_POOL, poolVersion: 3, lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-08', expectedDrawAt: '2026-10-09T00:00:00.000Z', registrationClosesAt: '2026-10-09T00:30:00.000Z', sourceReference: 'Fonte sintética.', reason: 'Teste.' };
    expect(() => manualResultRaw(action)).toThrow('posterior');
  });
  it('converts historical daylight saving and rejects nonexistent or ambiguous Brasília hours', () => {
    expect(brasiliaDateTimeToUTC('2026-10-08T21:00')).toBe('2026-10-09T00:00:00.000Z');
    expect(brasiliaDateTimeToUTC('2018-01-15T12:00')).toBe('2018-01-15T14:00:00.000Z');
    expect(() => brasiliaDateTimeToUTC('2018-11-04T00:30')).toThrow('inexistente');
    expect(() => brasiliaDateTimeToUTC('2019-02-16T23:30')).toThrow('ambígua');
    expect(() => brasiliaDateTimeToUTC('2026-02-30T21:00')).toThrow('inválido');
  });
});
