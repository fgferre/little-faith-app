import { manualResultRaw, parseCaixaResult, sha256Hex, validateResultCommand } from '@bolao/core';
import type { ContestCalendarVersion, ContestResultVersion, ResultCommand, ResultSnapshot } from '@bolao/core';
import { GROUP, id, POOL } from './planning-fixtures';

export const COLLECTED_AT = '2026-10-10T00:00:00.000Z';
export const DECIDED_AT = '2026-10-10T00:01:00.000Z';
export function emptyResultSnapshot(groupRevision = 10, groupId = GROUP): ResultSnapshot {
  return { groupId, groupRevision, results: [], selections: [], calendarVersions: [] };
}
export function officialResult(version = 1, drawnNumbers: number[] | null = [1, 2, 3, 4, 5, 6], complete = false): ContestResultVersion {
  const rawText = JSON.stringify({
    numero: 3000, tipoJogo: 'MEGA_SENA', dataApuracao: '09/10/2026', listaDezenas: drawnNumbers?.map(number => number.toString().padStart(2, '0')) ?? [],
    listaRateioPremio: complete ? [6, 5, 4].map((hits, index) => ({ faixa: index + 1, descricaoFaixa: `${hits} acertos`, numeroDeGanhadores: index + 1, valorPremio: 1200.21 - index * 100 })) : [],
  });
  const parsed = parseCaixaResult({ lotteryId: 'mega-sena', contestNumber: 3000, rawText, sourceUrl: 'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena/3000', collectedAt: COLLECTED_AT });
  return {
    id: id(500 + version), groupId: GROUP, poolId: POOL, version, source: 'caixa', sourceReference: 'Serviço oficial de resultados.',
    lotteryId: parsed.lotteryId, contestNumber: parsed.contestNumber, drawDate: parsed.drawDate,
    drawnNumbers: parsed.drawnNumbers, payouts: parsed.payouts, sourceUrl: parsed.sourceUrl, rawText: parsed.rawText,
    sha256: parsed.sha256, collectedAt: parsed.collectedAt, status: parsed.status, receiptId: null,
  };
}
export function manualCommand(key: string = crypto.randomUUID(), expectedRevision = 10, numbers = [7, 8, 9, 10, 11, 12]): ResultCommand {
  return validateResultCommand({
    apiVersion: 'v1', idempotencyKey: key, groupId: GROUP, expectedRevision,
    action: {
      type: 'result_manual', poolId: POOL, poolVersion: 3,
      data: { lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-09', drawnNumbers: numbers, payouts: null },
      sourceReference: 'Conferência manual da fonte informada.', reason: 'Números revisados pelo organizador.',
    },
  });
}
export function calendarCommand(key: string = crypto.randomUUID(), expectedRevision = 10): ResultCommand {
  return validateResultCommand({
    apiVersion: 'v1', idempotencyKey: key, groupId: GROUP, expectedRevision,
    action: { type: 'calendar_confirm', poolId: POOL, poolVersion: 3, lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-09', expectedDrawAt: '2026-10-09T23:00:00.000Z', registrationClosesAt: '2026-10-09T22:00:00.000Z', sourceReference: 'Horário conferido na página oficial.', reason: 'Horário explicitamente revisado.' },
  });
}
export function manualResult(command = manualCommand(), version = 1, receiptId = id(601)): ContestResultVersion {
  if (command.action.type !== 'result_manual') throw new Error('Fixture espera resultado manual.');
  const rawText = manualResultRaw(command.action);
  return {
    id: id(600 + version), groupId: command.groupId, poolId: command.action.poolId, version, ...command.action.data,
    source: 'manual', sourceUrl: null, sourceReference: command.action.sourceReference, rawText, sha256: sha256Hex(rawText),
    collectedAt: DECIDED_AT, status: 'manual', receiptId,
  };
}
export function manualCalendar(command = calendarCommand(), version = 1, receiptId = id(701)): ContestCalendarVersion {
  if (command.action.type !== 'calendar_confirm') throw new Error('Fixture espera calendário.');
  const action = command.action;
  const rawText = manualResultRaw(action);
  return {
    id: id(700 + version), groupId: command.groupId, poolId: action.poolId, version, lotteryId: action.lotteryId, contestNumber: action.contestNumber,
    drawDate: action.drawDate, expectedDrawAt: action.expectedDrawAt, registrationClosesAt: action.registrationClosesAt,
    source: 'manual', sourceUrl: null, sourceReference: action.sourceReference, rawText, sha256: sha256Hex(rawText),
    collectedAt: DECIDED_AT, timeZone: 'America/Sao_Paulo', receiptId,
  };
}
