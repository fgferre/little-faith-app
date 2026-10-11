import { compareRegistration, sha256Hex } from '@bolao/core';
import type { EvidenceMetadata, ObservedTicket, RegistrationCommand, RegistrationItem, RegistrationReport, RegistrationSnapshot } from '@bolao/core';
import { GROUP, id, lockedSnapshot, POOL } from './planning-fixtures';

export const ACCOUNT = id(200);
export const UPLOADED_AT = '2026-10-08T12:02:00.000Z';
export const REGISTERED_AT = '2026-10-08T12:01:30.000Z';
export const CONFIRMED_AT = '2026-10-08T12:03:00.000Z';
export const EVIDENCE_TEXT = '%PDF-1.7\nrecibo de teste privado';
export const EVIDENCE_ID = id(400);
export function evidence(groupId = GROUP): EvidenceMetadata {
  return {
    id: EVIDENCE_ID, groupId, poolId: POOL, sha256: sha256Hex(EVIDENCE_TEXT), mimeType: 'application/pdf',
    byteSize: new TextEncoder().encode(EVIDENCE_TEXT).length, originalName: 'recibo.pdf',
    storagePath: `${groupId}/${EVIDENCE_ID}.pdf`, uploadedByUserId: ACCOUNT, uploadedAt: UPLOADED_AT,
  };
}
export function registrationItems(missing = false): RegistrationItem[] {
  const frozen = lockedSnapshot().manifests[0]!;
  const plan = frozen.content.plan;
  return plan.tickets.map(ticket => {
    const observed: ObservedTicket = {
      lotteryId: plan.lotteryId, contestNumber: plan.contestNumber,
      betNumbers: ticket.betKeys.map(key => plan.bets.find(bet => bet.key === key)!.numbers),
      betCostCents: ticket.betCostCents, feeCents: '0', officialQuotaCount: null, officialAssignments: null,
      registeredAt: REGISTERED_AT,
    };
    return { plannedTicketKey: ticket.key, evidenceIds: [EVIDENCE_ID], observed: missing ? { ...observed, betNumbers: null } : observed, reason: missing ? 'Dezenas ainda ilegíveis no original recebido.' : '' };
  });
}
export function registrationCommand(key: string = crypto.randomUUID(), expectedRevision = 8, missing = false): RegistrationCommand {
  const frozen = lockedSnapshot().manifests[0]!;
  return {
    apiVersion: 'v1', idempotencyKey: key, groupId: GROUP, expectedRevision,
    action: { type: 'registration_confirm', poolId: POOL, poolVersion: 2, manifestId: frozen.id, items: registrationItems(missing), reason: 'Conferência humana dos originais.' },
  };
}
export function report(command = registrationCommand(), version = 1, receiptId = id(401)): RegistrationReport {
  const frozen = lockedSnapshot().manifests[0]!;
  return {
    id: id(410 + version), groupId: command.groupId, poolId: command.action.poolId, version,
    poolVersion: command.action.poolVersion, manifestId: command.action.manifestId, items: command.action.items,
    reason: command.action.reason, calendar: null,
    comparison: compareRegistration(frozen, command.action.items, [evidence()], null), confirmedAt: CONFIRMED_AT, receiptId,
  };
}
export function registrationSnapshot(groupRevision = 8): RegistrationSnapshot {
  return { groupId: GROUP, groupRevision, manifests: lockedSnapshot().manifests, evidence: [evidence()], reports: [] };
}
export function reportedSnapshot(command = registrationCommand(), version = 1, receiptId = id(401)): RegistrationSnapshot {
  return { ...registrationSnapshot(command.expectedRevision + 1), reports: [report(command, version, receiptId)] };
}
