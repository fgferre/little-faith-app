import { describe, expect, it } from 'vitest';
import type { EvidenceUploadMetadata, ResultAction } from './index';
import { assessRegisteredPrizes, compareRegistration, currentResult, hashEvidenceBytes, manualResultRaw, MAX_EVIDENCE_BYTES, registrationHandoff, sha256Hex, validateEvidenceBytes, validateEvidenceMetadata, validateEvidenceUploadMetadata, validateObservedTicket, validateRegistrationCommand, validateRegistrationReceipt, validateRegistrationSnapshot } from './index';
import { fixtureId, manualResult, REG_GROUP, REG_POOL, REG_REVIEWED, registrationCalendar, registrationEvidence, registrationItems, registrationManifest, registrationReport, registrationSnapshot, resultSnapshot } from './registration.test-fixtures';

describe('private, immutable original evidence', () => {
  it('verifies exact bytes, size and MIME signature without transforming the original', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\r\nsynthetic original\r\n');
    const original = bytes.slice();
    const metadata: EvidenceUploadMetadata = { id: fixtureId(3000), groupId: REG_GROUP, poolId: REG_POOL, sha256: await hashEvidenceBytes(bytes), mimeType: 'application/pdf', byteSize: bytes.length, originalName: 'Original São João.pdf' };
    expect(await validateEvidenceBytes(bytes, metadata)).toEqual(metadata); expect(bytes).toEqual(original);
    await expect(validateEvidenceBytes(bytes, { ...metadata, sha256: '00'.repeat(32) })).rejects.toThrow('hash');
    await expect(validateEvidenceBytes(bytes, { ...metadata, mimeType: 'image/png' })).rejects.toThrow('Assinatura');
    await expect(validateEvidenceBytes(bytes, { ...metadata, byteSize: bytes.length + 1 })).rejects.toThrow('Tamanho');
  });
  it('checks private object identity, operational limits and opaque basename-only names', () => {
    const stored = registrationEvidence(); expect(validateEvidenceMetadata(stored)).toEqual(stored);
    const { storagePath: _path, uploadedByUserId: _user, uploadedAt: _time, ...metadata } = stored;
    expect(validateEvidenceUploadMetadata(metadata)).toEqual(metadata);
    expect(() => validateEvidenceMetadata({ ...stored, storagePath: `${fixtureId(9)}/${stored.id}.pdf` })).toThrow('grupo');
    expect(() => validateEvidenceUploadMetadata({ ...metadata, byteSize: MAX_EVIDENCE_BYTES + 1 })).toThrow('limite');
    expect(() => validateEvidenceUploadMetadata({ ...metadata, mimeType: 'image/svg+xml' })).toThrow('suportada');
    expect(() => validateEvidenceUploadMetadata({ ...metadata, originalName: '../original.pdf' })).toThrow('simples');
    expect(() => validateEvidenceUploadMetadata({ ...metadata, approvedBy: fixtureId(99) })).toThrow('Campo');
  });
});

describe('complete registration checklist and historical comparison', () => {
  it('admits manifests before the first report and distinguishes explicit missing originals', () => {
    const manifest = registrationManifest();
    expect(validateRegistrationSnapshot({ groupId: REG_GROUP, groupRevision: 12, manifests: [manifest], evidence: [], reports: [] }).reports).toEqual([]);
    expect(validateRegistrationSnapshot({ groupId: REG_GROUP, groupRevision: 0, manifests: [], evidence: [], reports: [] }).groupRevision).toBe(0);
    const missing = registrationItems(manifest).map((item) => ({ ...item, evidenceIds: [], observed: null }));
    expect(compareRegistration(manifest, missing, [])).toMatchObject({ status: 'partial', observedTicketCount: 0, missingTicketCount: manifest.content.plan.tickets.length, observedBetCostCents: null, observedFeeCents: null });
    expect(() => validateRegistrationCommand({ apiVersion: 'v1', idempotencyKey: fixtureId(9000), groupId: REG_GROUP, expectedRevision: 12, action: { type: 'registration_confirm', poolId: REG_POOL, poolVersion: 2, manifestId: manifest.id, items: missing, reason: '' } })).toThrow('efetivamente observado');
  });
  it('accepts one partial human report with the rest of the fixed checklist explicitly missing', () => {
    const manifest = registrationManifest(), items = registrationItems(manifest);
    for (const item of items.slice(1)) { item.observed = null; item.evidenceIds = []; }
    const report = registrationReport(manifest, items);
    expect(report.comparison).toMatchObject({ status: 'partial', observedTicketCount: 1, missingTicketCount: items.length - 1 });
    const snapshot = { ...registrationSnapshot(manifest), reports: [report] };
    expect(validateRegistrationSnapshot(snapshot).reports[0]!.comparison.status).toBe('partial');
    expect(() => compareRegistration(manifest, items.slice(1), [registrationEvidence()])).toThrow('exatamente todas');
  });
  it('does not certify unknown fields or silently fill them from planned bets', () => {
    const manifest = registrationManifest('official'), items = registrationItems(manifest);
    items[0]!.observed!.officialAssignments = null; items[0]!.observed!.feeCents = null;
    const report = registrationReport(manifest, items);
    expect(report.comparison.status).toBe('partial'); expect(report.comparison.observedFeeCents).toBeNull();
    expect(report.items[0]!.observed!.officialAssignments).toBeNull();
    expect(report.comparison.issues).toContainEqual(expect.objectContaining({ code: 'missing-field', severity: 'incomplete' }));
    expect(validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [report] }).reports[0]!.items).toEqual(items);
  });
  it('requires a human reason for a wrong game and preserves planned numbers and rights', () => {
    const manifest = registrationManifest('internal', true), items = registrationItems(manifest);
    const initial = structuredClone(manifest);
    items[0]!.observed!.betNumbers = [[8, 9, 10, 11, 12, 13, 14]];
    const report = registrationReport(manifest, items);
    expect(report.comparison.status).toBe('divergent');
    expect(() => validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [report] })).toThrow('justificativa');
    items[0]!.reason = 'O humano observou números diferentes no original sintético.';
    expect(validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [registrationReport(manifest, items)] }).reports[0]!.items).toEqual(items);
    expect(manifest).toEqual(initial);
  });
  it('compares complete official quota assignment, not just its total', () => {
    const manifest = registrationManifest('official'), items = registrationItems(manifest);
    items[0]!.observed!.officialAssignments![0]!.officialQuotas++;
    items[0]!.reason = 'Correspondência divergente conferida pelo humano.';
    const report = registrationReport(manifest, items);
    expect(report.comparison.issues).toContainEqual(expect.objectContaining({ code: 'official-assignment-mismatch', severity: 'divergence' }));
    expect(validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [report] }).reports[0]!.comparison.status).toBe('divergent');
    items[0]!.observed!.officialQuotaCount = 1;
    expect(compareRegistration(manifest, items, [registrationEvidence()]).issues).toContainEqual(expect.objectContaining({ code: 'official-rule-mismatch' }));
  });
  it('distinguishes a late presented original from an actual registration after external closing', () => {
    const manifest = registrationManifest(), items = registrationItems(manifest), lateProof = registrationEvidence('2026-10-08T17:00:00.000Z');
    const comparison = compareRegistration(manifest, items, [lateProof]);
    expect(comparison.status).toBe('complete'); expect(comparison.issues.every((i) => i.code === 'evidence-after-internal-deadline' && i.severity === 'notice')).toBe(true);
    const report = { ...registrationReport(manifest, items, [lateProof]), confirmedAt: '2026-10-08T17:05:00.000Z' };
    expect(validateRegistrationSnapshot({ ...registrationSnapshot(manifest), evidence: [lateProof], reports: [report] }).reports[0]!.comparison.status).toBe('complete');
    const calendar = registrationCalendar();
    const action: Extract<ResultAction, { type: 'calendar_confirm' }> = { type: 'calendar_confirm', poolId: REG_POOL, poolVersion: 2, lotteryId: 'mega-sena', contestNumber: 3000, drawDate: '2026-10-08', expectedDrawAt: '2026-10-08T15:00:00.000Z', registrationClosesAt: '2026-10-08T14:15:00.000Z', sourceReference: calendar.sourceReference, reason: 'Janela sintética por concurso.' };
    const rawText = manualResultRaw(action);
    const earlyClose = { ...calendar, expectedDrawAt: action.expectedDrawAt, registrationClosesAt: action.registrationClosesAt, rawText, sha256: sha256Hex(rawText) };
    expect(compareRegistration(manifest, items, [registrationEvidence()], earlyClose).issues).toContainEqual(expect.objectContaining({ code: 'registration-after-channel-close', severity: 'divergence' }));
  });
  it('prices a teimosinha receipt once per contest it covers and reads an old receipt as one contest', () => {
    const manifest = registrationManifest('internal', false, 2), items = registrationItems(manifest), evidence = [registrationEvidence()];
    expect(manifest.content.plan.contestCount).toBe(2);
    expect(compareRegistration(manifest, items, evidence)).toMatchObject({ status: 'complete', observedBetCostCents: manifest.content.plan.betCostCents, issues: [] });
    items[0]!.observed!.contestCount = 1;
    expect(compareRegistration(manifest, items, evidence).issues.map((i) => i.code)).toEqual(['contest-count-mismatch', 'bet-cost-mismatch']);
    items[0]!.observed!.contestCount = null;
    expect(compareRegistration(manifest, items, evidence)).toMatchObject({ status: 'partial', issues: [expect.objectContaining({ code: 'missing-field', message: expect.stringContaining('contestCount') })] });
    const { contestCount: _absent, ...legacy } = items[0]!.observed!;
    expect(validateObservedTicket(legacy).contestCount).toBe(1);
    expect(() => validateObservedTicket({ ...legacy, contestCount: 13 })).toThrow('fora do limite');
  });
  it('rejects future events and proofs from another pool, and requires revision reasons', () => {
    const manifest = registrationManifest(), items = registrationItems(manifest);
    items[0]!.observed!.registeredAt = '2026-10-08T18:00:00.000Z';
    expect(() => validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [registrationReport(manifest, items)] })).toThrow('futuro');
    expect(() => compareRegistration(manifest, registrationItems(manifest), [{ ...registrationEvidence(), poolId: fixtureId(9) }])).toThrow('neste grupo e bolão');
    const first = registrationReport(manifest), next = { ...first, id: fixtureId(4001), receiptId: fixtureId(4101), version: 2, poolVersion: 3, confirmedAt: '2026-10-08T15:06:00.000Z' };
    expect(() => validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [first, next] })).toThrow('Revisão');
    next.reason = 'Nova conferência humana do original.';
    expect(validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [first, next] }).reports).toHaveLength(2);
  });
  it('requires a global reason for total fee divergence and checks comparison independently of messages', () => {
    const manifest = registrationManifest(), items = registrationItems(manifest);
    items[0]!.observed!.feeCents = '1';
    const report = registrationReport(manifest, items);
    expect(report.comparison.issues).toContainEqual(expect.objectContaining({ plannedTicketKey: null, code: 'fee-mismatch' }));
    expect(() => validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [report] })).toThrow('global');
    report.reason = '<script>Texto opaco do humano, sem execução.</script>';
    report.comparison.issues = report.comparison.issues.reverse().map((issue) => ({ ...issue, message: 'Descrição equivalente do servidor.' }));
    expect(validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [report] }).reports[0]!.reason).toBe(report.reason);
    expect(() => validateRegistrationSnapshot({ ...registrationSnapshot(manifest), reports: [{ ...report, comparison: { ...report.comparison, observedFeeCents: '0' } }] })).toThrow('Conferência');
  });
  it('binds accepted reports to server receipts and exports only private registrar execution details', () => {
    const snapshot = registrationSnapshot(), report = snapshot.reports[0]!;
    const receipt = { apiVersion: 'v1', idempotencyKey: fixtureId(9000), receiptId: report.receiptId, groupId: REG_GROUP, status: 'accepted', groupRevision: snapshot.groupRevision, message: null, confirmedAt: REG_REVIEWED, snapshot };
    expect(validateRegistrationReceipt(receipt).receiptId).toBe(report.receiptId);
    expect(() => validateRegistrationReceipt({ ...receipt, receiptId: receipt.idempotencyKey })).toThrow('exatamente');
    const handoff = registrationHandoff(snapshot.manifests[0]!);
    expect(handoff).toContain('concurso 3000'); expect(handoff).toContain('Cartela');
    expect(handoff).not.toContain('Pessoa sintética'); expect(handoff).not.toContain('payments'); expect(handoff).not.toContain('Estatuto');
  });
});

describe('actual registered games and multiple winning combinations', () => {
  it('counts an expanded actual Mega game as one sena plus six quinas', () => {
    const manifest = registrationManifest('internal', true), report = registrationReport(manifest);
    const assessment = assessRegisteredPrizes(report, currentResult(resultSnapshot(), REG_POOL));
    expect(assessment.status).toBe('calculated'); expect(assessment.calculatedPrizeCents).toBe('106000');
    expect(assessment.games[0]!.tiers.map((tier) => tier.combinations)).toEqual(['1', '6', '0']);
  });
  it('uses divergent actual numbers rather than a winning planned bet, and counts duplicate paid games separately', () => {
    const manifest = registrationManifest('internal', true), items = registrationItems(manifest);
    items[0]!.observed!.betNumbers = [[8, 9, 10, 11, 12, 13, 14]]; items[0]!.reason = 'Número divergente real conferido.';
    expect(assessRegisteredPrizes(registrationReport(manifest, items), currentResult(resultSnapshot(), REG_POOL)).calculatedPrizeCents).toBe('0');
    items[0]!.observed!.betNumbers = [[1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]]; items[0]!.observed!.betCostCents = '8400';
    const assessment = assessRegisteredPrizes(registrationReport(manifest, items), currentResult(resultSnapshot(), REG_POOL));
    expect(assessment.games).toHaveLength(2); expect(assessment.calculatedPrizeCents).toBe('212000');
  });
  it('keeps missing receipts, unknown rateio and source conflicts unavailable instead of zero', () => {
    const manifest = registrationManifest(), items = registrationItems(manifest);
    items[1]!.observed = null; items[1]!.evidenceIds = [];
    const report = registrationReport(manifest, items);
    const incomplete = assessRegisteredPrizes(report, currentResult(resultSnapshot(), REG_POOL));
    expect(incomplete.calculatedPrizeCents).toBeNull(); expect(incomplete.skippedTicketKeys).toContain(items[1]!.plannedTicketKey);
    const base = manualResult();
    const noPayout = manualResult({ lotteryId: base.lotteryId, contestNumber: base.contestNumber, drawDate: base.drawDate, drawnNumbers: base.drawnNumbers, payouts: null });
    const pending = assessRegisteredPrizes(registrationReport(manifest), currentResult(resultSnapshot([noPayout]), REG_POOL));
    expect(pending.calculatedPrizeCents).toBeNull(); expect(pending.games.every((g) => g.calculatedPrizeCents === null)).toBe(true);
    expect(assessRegisteredPrizes(report, { status: 'conflict', result: base, conflictingResultIds: [base.id], selectedResultId: null })).toMatchObject({ status: 'conflict', calculatedPrizeCents: null, games: [] });
  });
});
