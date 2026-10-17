import type { ContestCalendarVersion, ContestResultData, ContestResultVersion, EvidenceMetadata, FinancialSnapshot, ManifestContent, PoolManifest, RegistrationItem, RegistrationReport, RegistrationSnapshot, ResultAction, ResultSnapshot, SuggestPlansInput } from './index';
import { canonicalManifest, compareRegistration, manualResultRaw, PLANNING_CATALOG, sha256Hex, suggestPlans } from './index';

export const fixtureId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const REG_GROUP = fixtureId(1), REG_POOL = fixtureId(2);
export const REG_EARLY = '2026-10-08T12:00:00.000Z', REG_LOCKED = '2026-10-08T14:00:00.000Z', REG_UPLOADED = '2026-10-08T15:00:00.000Z', REG_REVIEWED = '2026-10-08T15:05:00.000Z';

export function registrationManifest(mode: 'internal' | 'official' = 'internal', expanded = false, contestCount = 1): PoolManifest {
  const amount = expanded ? '2100' : '1500', statuteId = fixtureId(3);
  const financial: FinancialSnapshot = { groupId: REG_GROUP, groupRevision: 10, statutes: [{ id: statuteId, groupId: REG_GROUP, version: 1, text: 'Estatuto sintético.', sourceGroupVersion: 1, publishedAt: REG_EARLY, receiptId: fixtureId(100) }], acceptances: [], payments: [], allocations: [], movements: [], quotas: [], revocations: [] };
  for (let i = 0; i < 2; i++) {
    const personId = fixtureId(20 + i), paymentId = fixtureId(200 + i), allocationId = fixtureId(300 + i), receiptId = fixtureId(400 + i);
    financial.acceptances.push({ id: fixtureId(500 + i), groupId: REG_GROUP, personId, statuteId, evidence: 'Aceite sintético.', acceptedAt: REG_EARLY, receiptId: fixtureId(600 + i) });
    financial.payments.push({ id: paymentId, groupId: REG_GROUP, personId, sourceProposalId: fixtureId(700 + i), sourceProposalVersion: 1, amountCents: amount, bankReference: null, declaredReceivedAt: null, confirmedAt: REG_EARLY, receiptId });
    financial.allocations.push({ id: allocationId, groupId: REG_GROUP, personId, paymentId, poolId: REG_POOL, amountCents: amount, allocatedAt: REG_EARLY, receiptId });
    financial.movements.push({ id: fixtureId(800 + i), groupId: REG_GROUP, personId, paymentId, poolId: null, allocationId: null, kind: 'payment-received', amountCents: amount, reason: '', createdAt: REG_EARLY, receiptId }, { id: fixtureId(900 + i), groupId: REG_GROUP, personId, paymentId, poolId: REG_POOL, allocationId, kind: 'payment-allocated', amountCents: amount, reason: '', createdAt: REG_EARLY, receiptId });
    financial.quotas.push({ id: fixtureId(1000 + i), groupId: REG_GROUP, personId, poolId: REG_POOL, sourceQuotaId: fixtureId(1100 + i), sourceQuotaVersion: 1, units: 100, dueCents: amount, statuteId, confirmedAt: REG_EARLY, receiptId: fixtureId(1200 + i) });
  }
  const input: SuggestPlansInput = { groupId: REG_GROUP, groupRevision: 10, pool: { id: REG_POOL, groupId: REG_GROUP, kind: 'pool', serverVersion: 1, localVersion: 1, state: 'synced', createdAt: REG_EARLY, updatedAt: REG_EARLY, data: { title: 'Exclusivamente sintético', lotteryId: 'mega-sena', contestNumber: 3000, participationMode: mode, status: 'draft', deadlineAt: '2026-10-08T16:00:00.000Z', quotaPriceCents: amount, ...(contestCount > 1 ? { contestCount } : {}) } }, sourceBets: [], financial, seed: '00'.repeat(32), feeCents: '0', feeLabel: '', leftoverPolicy: 'group-credit' };
  if (expanded) input.sourceBets.push({ id: fixtureId(50), groupId: REG_GROUP, kind: 'bet', serverVersion: 1, localVersion: 1, state: 'synced', createdAt: REG_EARLY, updatedAt: REG_EARLY, data: { poolId: REG_POOL, lotteryId: 'mega-sena', numbers: [1, 2, 3, 4, 5, 6, 7], authorIds: [], seed: null, generationAlgorithmVersion: null, catalogVersion: 'caixa-basic-2026-10-07-v1' } });
  const plan = suggestPlans(input).plans[0]!;
  const content: ManifestContent = { schemaVersion: 'pool-manifest-v1', catalog: PLANNING_CATALOG[plan.lotteryId], responsible: { organizerUserId: fixtureId(999), registrarPersonId: fixtureId(20), ticketHolderPersonId: mode === 'internal' ? fixtureId(20) : null }, pool: { id: REG_POOL, version: 2, data: { ...input.pool.data, status: 'locked' } }, plan, financial, persons: [{ id: fixtureId(20), version: 1, data: { name: 'Pessoa sintética A', nickname: 'A', adultDeclared: true } }, { id: fixtureId(21), version: 1, data: { name: 'Pessoa sintética B', nickname: 'B', adultDeclared: true } }] };
  const canonical = canonicalManifest(content);
  return { id: fixtureId(2000), groupId: REG_GROUP, poolId: REG_POOL, version: 1, appliedPlanId: fixtureId(2100), content, canonical, sha256: sha256Hex(canonical), lockedAt: REG_LOCKED, receiptId: fixtureId(2200) };
}
export function registrationEvidence(uploadedAt = REG_UPLOADED): EvidenceMetadata {
  return { id: fixtureId(3000), groupId: REG_GROUP, poolId: REG_POOL, sha256: 'ab'.repeat(32), mimeType: 'application/pdf', byteSize: 15, originalName: 'recibo sintético.pdf', storagePath: `${REG_GROUP}/${fixtureId(3000)}.pdf`, uploadedByUserId: fixtureId(999), uploadedAt };
}
export function registrationItems(manifest: PoolManifest): RegistrationItem[] {
  return manifest.content.plan.tickets.map((ticket) => ({ plannedTicketKey: ticket.key, evidenceIds: [fixtureId(3000)], observed: { lotteryId: manifest.content.plan.lotteryId, contestNumber: manifest.content.plan.contestNumber, contestCount: manifest.content.plan.contestCount ?? 1, betNumbers: ticket.betKeys.map((key) => manifest.content.plan.bets.find((b) => b.key === key)!.numbers.slice()), betCostCents: ticket.betCostCents, feeCents: '0', officialQuotaCount: ticket.officialQuotaCount, officialAssignments: ticket.officialQuotaCount === null ? null : structuredClone(ticket.assignments), registeredAt: '2026-10-08T14:30:00.000Z' }, reason: '' }));
}
export function registrationReport(manifest = registrationManifest(), items = registrationItems(manifest), evidence = [registrationEvidence()], calendar: ContestCalendarVersion | null = null): RegistrationReport {
  return { id: fixtureId(4000), groupId: REG_GROUP, poolId: REG_POOL, version: 1, poolVersion: 2, manifestId: manifest.id, calendar, items, reason: '', comparison: compareRegistration(manifest, items, evidence, calendar), confirmedAt: REG_REVIEWED, receiptId: fixtureId(4100) };
}
export function registrationSnapshot(manifest = registrationManifest()): RegistrationSnapshot {
  return { groupId: REG_GROUP, groupRevision: 13, manifests: [manifest], evidence: [registrationEvidence()], reports: [registrationReport(manifest)] };
}
export function manualResult(data: ContestResultData = { lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-08', drawnNumbers: [1, 2, 3, 4, 5, 6], payouts: [{ hits: 6, winnerCount: '1', prizeCents: '100000' }, { hits: 5, winnerCount: '10', prizeCents: '1000' }, { hits: 4, winnerCount: '100', prizeCents: '100' }] }, version = 1): ContestResultVersion {
  const action: Extract<ResultAction, { type: 'result_manual' }> = { type: 'result_manual', poolId: REG_POOL, poolVersion: 3, data, sourceReference: 'Fonte sintética informada pelo humano', reason: 'Teste sintético, nenhuma aposta real.' };
  const rawText = manualResultRaw(action);
  return { id: fixtureId(5000 + version), groupId: REG_GROUP, poolId: REG_POOL, version, ...data, source: 'manual', sourceUrl: null, sourceReference: action.sourceReference, rawText, sha256: sha256Hex(rawText), collectedAt: '2026-10-08T15:10:00.000Z', status: 'manual', receiptId: fixtureId(5100 + version) };
}
export function resultSnapshot(results: ContestResultVersion[] = [manualResult()]): ResultSnapshot { return { groupId: REG_GROUP, groupRevision: 14, results, selections: [], calendarVersions: [] }; }
export function registrationCalendar(): ContestCalendarVersion {
  const action: Extract<ResultAction, { type: 'calendar_confirm' }> = { type: 'calendar_confirm', poolId: REG_POOL, poolVersion: 2, lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-08', expectedDrawAt: '2026-10-09T00:00:00.000Z', registrationClosesAt: '2026-10-08T23:30:00.000Z', sourceReference: 'Configuração sintética por concurso', reason: 'Fixture sintética.' };
  const rawText = manualResultRaw(action);
  return { id: fixtureId(6000), groupId: REG_GROUP, poolId: REG_POOL, version: 1, lotteryId: action.lotteryId, contestNumber: action.contestNumber, source: 'manual', sourceUrl: null, sourceReference: action.sourceReference, rawText, sha256: sha256Hex(rawText), collectedAt: REG_LOCKED, timeZone: 'America/Sao_Paulo', drawDate: action.drawDate, expectedDrawAt: action.expectedDrawAt, registrationClosesAt: action.registrationClosesAt, receiptId: fixtureId(6100) };
}
