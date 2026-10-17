import type { LotteryId } from './types';
import type { OfficialQuotaAssignment, PoolManifest } from './planning-types';
import type { ContestCalendarVersion } from './result-types';
import type { EvidenceMetadata, ObservedTicket, RegistrationCommand, RegistrationComparison, RegistrationIssue, RegistrationItem, RegistrationReceipt, RegistrationReport, RegistrationSnapshot } from './registration-types';
import { canonicalJSON } from './canonical';
import { betCost, validateBet } from './lotteries';
import { officialPoolRule } from './planning-catalog';
import { validatePoolManifest } from './planning';
import { validateEvidenceMetadata } from './evidence';
import { validateCalendarVersion } from './results';
import { planningInt, planningInvalid, planningList, planningMoney, planningOption, planningRecord, planningShape, planningText, planningUid } from './prepared-plans';
import { sourceTime } from './source-validation';

export const MAX_REGISTRATION_COMMAND_BYTES = 1_048_576;
const LOTTERY_IDS: readonly LotteryId[] = ['mega-sena', 'lotofacil', 'quina'];
const ISSUE_CODES: readonly RegistrationIssue['code'][] = ['missing-receipt', 'unreadable-receipt', 'missing-field', 'lottery-mismatch', 'contest-mismatch', 'contest-count-mismatch', 'numbers-mismatch', 'bet-cost-mismatch', 'fee-mismatch', 'official-quota-mismatch', 'official-assignment-mismatch', 'official-rule-mismatch', 'registered-before-lock', 'registration-after-channel-close', 'evidence-after-internal-deadline'];
function ticketKey(value: unknown, field = 'plannedTicketKey'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return planningInvalid(field, 'Chave de cartela inválida.');
  return value;
}
function unique<T>(values: T[], project: (value: T) => string, field: string): T[] {
  if (new Set(values.map(project)).size !== values.length) planningInvalid(field, 'Identificador repetido.');
  return values;
}
function assignments(input: unknown): OfficialQuotaAssignment[] {
  const values = planningList(input, 'officialAssignments', 200).map((inputAssignment) => {
    const assignment = planningRecord(inputAssignment, 'assignment'); planningShape(assignment, ['quotaId', 'personId', 'officialQuotas'], 'assignment');
    return { quotaId: planningUid(assignment.quotaId, 'quotaId'), personId: planningUid(assignment.personId, 'personId'), officialQuotas: planningInt(assignment.officialQuotas, 'officialQuotas', 1, 1_000_000) };
  });
  unique(values, (v) => v.quotaId, 'officialAssignments');
  unique(values, (v) => v.personId, 'officialAssignments');
  return values;
}
export function validateObservedTicket(input: unknown): ObservedTicket {
  const source = planningRecord(input, 'observed'), hasContestCount = Object.hasOwn(source, 'contestCount');
  planningShape(source, [...(hasContestCount ? ['contestCount'] : []), 'lotteryId', 'contestNumber', 'betNumbers', 'betCostCents', 'feeCents', 'officialQuotaCount', 'officialAssignments', 'registeredAt'], 'observed');
  const lotteryId = source.lotteryId === null ? null : planningOption<LotteryId>(source.lotteryId, LOTTERY_IDS, 'lotteryId');
  let betNumbers: number[][] | null = null;
  if (source.betNumbers !== null) {
    betNumbers = planningList(source.betNumbers, 'betNumbers', 10).map((inputNumbers) => {
      const raw = planningList(inputNumbers, 'numbers', 20).map((n) => planningInt(n, 'numbers', 1, 80));
      if (lotteryId) return validateBet(lotteryId, raw);
      if (raw.length < 5 || new Set(raw).size !== raw.length) planningInvalid('numbers', 'Jogo parcialmente identificado exige dezenas legíveis, completas e sem repetição.');
      return raw.sort((a, b) => a - b);
    });
    if (!betNumbers.length) planningInvalid('betNumbers', 'Use null para jogos ainda ilegíveis.');
  }
  return { lotteryId, contestNumber: source.contestNumber === null ? null : planningInt(source.contestNumber, 'contestNumber', 1, 999_999), contestCount: !hasContestCount ? 1 : source.contestCount === null ? null : planningInt(source.contestCount, 'contestCount', 1, 12), betNumbers, betCostCents: source.betCostCents === null ? null : planningMoney(source.betCostCents, 'betCostCents'), feeCents: source.feeCents === null ? null : planningMoney(source.feeCents, 'feeCents'), officialQuotaCount: source.officialQuotaCount === null ? null : planningInt(source.officialQuotaCount, 'officialQuotaCount', 0, 1_000_000), officialAssignments: source.officialAssignments === null ? null : assignments(source.officialAssignments), registeredAt: source.registeredAt === null ? null : sourceTime(source.registeredAt, 'registeredAt') };
}
export function validateRegistrationItems(input: unknown): RegistrationItem[] {
  return unique(planningList(input, 'items').map((inputItem): RegistrationItem => {
    const item = planningRecord(inputItem, 'item'); planningShape(item, ['plannedTicketKey', 'evidenceIds', 'observed', 'reason'], 'item');
    const evidenceIds = unique(planningList(item.evidenceIds, 'evidenceIds', 100).map((id) => planningUid(id, 'evidenceId')), (id) => id, 'evidenceIds');
    return { plannedTicketKey: ticketKey(item.plannedTicketKey), evidenceIds, observed: item.observed === null ? null : validateObservedTicket(item.observed), reason: planningText(item.reason, 'reason', 2_000) };
  }), (v) => v.plannedTicketKey, 'items');
}
function hasProof(items: RegistrationItem[]): void {
  if (!items.some((item) => item.observed !== null)) planningInvalid('items', 'Confirmação exige ao menos um registro efetivamente observado.');
  if (items.some((item) => item.observed !== null && !item.evidenceIds.length)) planningInvalid('evidenceIds', 'Dados observados exigem comprovante original enviado.');
}
export function validateRegistrationCommand(input: unknown): RegistrationCommand {
  const source = planningRecord(input, 'command'); planningShape(source, ['apiVersion', 'idempotencyKey', 'groupId', 'expectedRevision', 'action'], 'command');
  if (source.apiVersion !== 'v1') planningInvalid('apiVersion', 'Versão da API não suportada.');
  const action = planningRecord(source.action, 'action'); planningShape(action, ['type', 'poolId', 'poolVersion', 'manifestId', 'items', 'reason'], 'action');
  if (action.type !== 'registration_confirm') planningInvalid('type', 'Ação de registro não suportada.');
  const items = validateRegistrationItems(action.items); hasProof(items);
  const command: RegistrationCommand = { apiVersion: 'v1', idempotencyKey: planningUid(source.idempotencyKey, 'idempotencyKey'), groupId: planningUid(source.groupId, 'groupId'), expectedRevision: planningInt(source.expectedRevision, 'expectedRevision'), action: { type: 'registration_confirm', poolId: planningUid(action.poolId, 'poolId'), poolVersion: planningInt(action.poolVersion, 'poolVersion', 1), manifestId: planningUid(action.manifestId, 'manifestId'), items, reason: planningText(action.reason, 'reason', 2_000) } };
  if (new TextEncoder().encode(JSON.stringify(command)).length > MAX_REGISTRATION_COMMAND_BYTES) planningInvalid('command', 'Checklist de registro excede 1 MiB.');
  return command;
}
function sameNumbers(a: number[][], b: number[][]): boolean {
  return a.map((n) => n.join(',')).sort().join('|') === b.map((n) => n.join(',')).sort().join('|');
}
function sameAssignments(a: OfficialQuotaAssignment[], b: OfficialQuotaAssignment[]): boolean {
  const order = (values: OfficialQuotaAssignment[]): string => values.map((v) => `${v.quotaId}:${v.personId}:${v.officialQuotas}`).sort().join('|');
  return order(a) === order(b);
}
function observedOfficialRule(lotteryId: LotteryId, ticket: ObservedTicket): boolean {
  if (!ticket.betNumbers || !ticket.betCostCents || ticket.officialQuotaCount === null) return true;
  const first = ticket.betNumbers[0]!;
  if (ticket.betNumbers.some((numbers) => numbers.length !== first.length)) return false;
  const rule = officialPoolRule(lotteryId, first.length);
  const cost = BigInt(ticket.betCostCents), count = BigInt(ticket.officialQuotaCount);
  if (count < BigInt(rule.minQuotas) || count > BigInt(rule.maxQuotas) || ticket.betNumbers.length > rule.maxGamesPerReceipt || cost < BigInt(rule.minPoolCents) || cost > BigInt(rule.maxPoolCents)) return false;
  if (cost % count !== 0n || cost / count < BigInt(rule.minQuotaCents)) return false;
  if (ticket.feeCents !== null && BigInt(ticket.feeCents) * 100n > cost * 35n) return false;
  return true;
}

/** Full checklist; evidence upload, internal participation deadline and external event time are separate. */
export function compareRegistration(inputManifest: PoolManifest, inputItems: RegistrationItem[], inputEvidence: EvidenceMetadata[], inputCalendar: ContestCalendarVersion | null = null): RegistrationComparison {
  const manifest = validatePoolManifest(inputManifest);
  const items = validateRegistrationItems(inputItems);
  const evidence = unique(inputEvidence.map(validateEvidenceMetadata), (v) => v.id, 'evidence');
  const calendar = inputCalendar === null ? null : validateCalendarVersion(inputCalendar);
  return compareValidated(manifest, items, evidence, calendar);
}
function compareValidated(manifest: PoolManifest, items: RegistrationItem[], evidence: EvidenceMetadata[], calendar: ContestCalendarVersion | null): RegistrationComparison {
  const plan = manifest.content.plan;
  if (calendar && (calendar.groupId !== manifest.groupId || calendar.poolId !== manifest.poolId || calendar.lotteryId !== plan.lotteryId || calendar.contestNumber !== plan.contestNumber)) planningInvalid('calendar', 'Calendário congelado precisa corresponder ao grupo, bolão, modalidade e concurso.');
  const byTicket = new Map(plan.tickets.map((t) => [t.key, t]));
  if (items.length !== byTicket.size || items.some((item) => !byTicket.has(item.plannedTicketKey))) planningInvalid('items', 'Checklist deve conter exatamente todas as cartelas do manifesto, inclusive as ausentes.');
  const byEvidence = new Map(evidence.map((e) => [e.id, e]));
  const issues: RegistrationIssue[] = [];
  const issue = (plannedTicketKey: string | null, code: RegistrationIssue['code'], severity: RegistrationIssue['severity'], message: string): void => { issues.push({ plannedTicketKey, code, severity, message }); };
  let totalCost: bigint | null = 0n, totalFees: bigint | null = 0n, observedTicketCount = 0;
  for (const item of items) {
    const key = item.plannedTicketKey, planned = byTicket.get(key)!;
    const sources = item.evidenceIds.map((id) => {
      const proof = byEvidence.get(id);
      if (!proof || proof.groupId !== manifest.groupId || proof.poolId !== manifest.poolId) return planningInvalid('evidenceIds', 'Comprovante precisa existir neste grupo e bolão.');
      return proof;
    });
    const internalDeadline = manifest.content.pool.data.deadlineAt;
    if (internalDeadline && sources.some((e) => e.uploadedAt >= internalDeadline)) issue(key, 'evidence-after-internal-deadline', 'notice', 'Original apresentado após o prazo interno de participação.');
    const actual = item.observed;
    if (!actual) {
      issue(key, sources.length ? 'unreadable-receipt' : 'missing-receipt', 'incomplete', sources.length ? 'Original enviado, mas seus dados ainda não foram conferidos.' : 'Comprovante ainda ausente.');
      totalCost = null; totalFees = null; continue;
    }
    observedTicketCount++;
    if (!sources.length) issue(key, 'missing-receipt', 'incomplete', 'Dados informados ainda não têm original enviado.');
    const missing: string[] = [];
    for (const field of ['lotteryId', 'contestNumber', 'contestCount', 'betNumbers', 'betCostCents', 'feeCents', 'registeredAt'] as const) if (actual[field] === null) missing.push(field);
    if (plan.participationMode === 'official') for (const field of ['officialQuotaCount', 'officialAssignments'] as const) if (actual[field] === null) missing.push(field);
    if (missing.length) issue(key, 'missing-field', 'incomplete', `Campos do comprovante ainda desconhecidos: ${missing.join(', ')}.`);
    if (actual.lotteryId !== null && actual.lotteryId !== plan.lotteryId) issue(key, 'lottery-mismatch', 'divergence', 'Modalidade registrada diverge do plano.');
    if (actual.contestNumber !== null && actual.contestNumber !== plan.contestNumber) issue(key, 'contest-mismatch', 'divergence', 'Concurso registrado diverge do plano.');
    if (actual.contestCount !== null && actual.contestCount !== (plan.contestCount ?? 1)) issue(key, 'contest-count-mismatch', 'divergence', 'Quantidade de concursos registrada diverge do plano.');
    const plannedNumbers = planned.betKeys.map((betKey) => plan.bets.find((bet) => bet.key === betKey)!.numbers);
    if (actual.betNumbers !== null && !sameNumbers(actual.betNumbers, plannedNumbers)) issue(key, 'numbers-mismatch', 'divergence', 'Jogos registrados divergem dos jogos planejados.');
    // A teimosinha receipt bills every legible game once per contest it covers.
    const actualPrice = actual.lotteryId && actual.betNumbers && actual.contestCount !== null ? actual.betNumbers.reduce((sum, numbers) => sum + BigInt(betCost(actual.lotteryId!, numbers)), 0n) * BigInt(actual.contestCount) : null;
    if (actual.betCostCents !== null && (actual.betCostCents !== planned.betCostCents || (actualPrice !== null && BigInt(actual.betCostCents) !== actualPrice))) issue(key, 'bet-cost-mismatch', 'divergence', 'Custo observado diverge da cartela ou do preço oficial dos jogos legíveis.');
    if (actual.betCostCents === null) totalCost = null; else if (totalCost !== null) totalCost += BigInt(actual.betCostCents);
    if (actual.feeCents === null) totalFees = null; else if (totalFees !== null) totalFees += BigInt(actual.feeCents);
    if (plan.participationMode === 'official') {
      if (actual.officialQuotaCount !== null && actual.officialQuotaCount !== planned.officialQuotaCount) issue(key, 'official-quota-mismatch', 'divergence', 'Quantidade de cotas oficiais diverge do plano.');
      if (actual.officialAssignments !== null && !sameAssignments(actual.officialAssignments, planned.assignments)) issue(key, 'official-assignment-mismatch', 'divergence', 'Recibos de cotas oficiais não correspondem aos direitos congelados.');
      if (actual.lotteryId && !observedOfficialRule(actual.lotteryId, actual)) issue(key, 'official-rule-mismatch', 'divergence', 'Dados observados não atendem às regras oficiais da cartela e suas cotas.');
    } else {
      if (actual.officialQuotaCount !== null) issue(key, 'official-quota-mismatch', 'divergence', 'Acordo interno planejado não tinha cotas oficiais.');
      if (actual.officialAssignments !== null) issue(key, 'official-assignment-mismatch', 'divergence', 'Correspondência oficial observada não existia no acordo interno.');
    }
    if (actual.registeredAt && actual.registeredAt < manifest.lockedAt) issue(key, 'registered-before-lock', 'divergence', 'Registro externo anterior ao manifesto congelado.');
    if (actual.registeredAt && calendar?.registrationClosesAt && actual.registeredAt >= calendar.registrationClosesAt) issue(key, 'registration-after-channel-close', 'divergence', 'Horário observado posterior ao encerramento configurado do canal.');
  }
  if (totalFees !== null && totalFees !== BigInt(plan.feeCents)) issue(null, 'fee-mismatch', 'divergence', 'Soma das taxas observadas diverge da taxa autorizada no plano.');
  return { status: issues.some((i) => i.severity === 'divergence') ? 'divergent' : issues.some((i) => i.severity === 'incomplete') ? 'partial' : 'complete', observedTicketCount, missingTicketCount: items.length - observedTicketCount, observedBetCostCents: totalCost === null ? null : totalCost.toString(), observedFeeCents: totalFees === null ? null : totalFees.toString(), issues };
}
function comparisonSemantic(comparison: RegistrationComparison): string {
  return canonicalJSON({ ...comparison, issues: comparison.issues.map(({ plannedTicketKey, code, severity }) => ({ plannedTicketKey, code, severity })).sort((a, b) => `${a.plannedTicketKey ?? ''}:${a.code}:${a.severity}`.localeCompare(`${b.plannedTicketKey ?? ''}:${b.code}:${b.severity}`, 'en')) });
}
function validateComparison(input: unknown): RegistrationComparison {
  const source = planningRecord(input, 'comparison'); planningShape(source, ['status', 'observedTicketCount', 'missingTicketCount', 'observedBetCostCents', 'observedFeeCents', 'issues'], 'comparison');
  const issues = unique(planningList(source.issues, 'issues', 20_000).map((inputIssue): RegistrationIssue => {
    const item = planningRecord(inputIssue, 'issue'); planningShape(item, ['plannedTicketKey', 'code', 'severity', 'message'], 'issue');
    return { plannedTicketKey: item.plannedTicketKey === null ? null : ticketKey(item.plannedTicketKey), code: planningOption(item.code, ISSUE_CODES, 'code'), severity: planningOption(item.severity, ['incomplete', 'divergence', 'notice'], 'severity'), message: planningText(item.message, 'message', 500, true) };
  }), (i) => `${i.plannedTicketKey}:${i.code}`, 'issues');
  const total = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,99})$/.test(value)) return planningInvalid(field, 'Total exige centavos inteiros canônicos.');
    return value;
  };
  return { status: planningOption(source.status, ['partial', 'divergent', 'complete'], 'status'), observedTicketCount: planningInt(source.observedTicketCount, 'observedTicketCount', 0, 1_000), missingTicketCount: planningInt(source.missingTicketCount, 'missingTicketCount', 0, 1_000), observedBetCostCents: total(source.observedBetCostCents, 'observedBetCostCents'), observedFeeCents: total(source.observedFeeCents, 'observedFeeCents'), issues };
}
function validateReport(input: unknown, manifests: Map<string, PoolManifest>, evidence: EvidenceMetadata[]): RegistrationReport {
  const source = planningRecord(input, 'report'); planningShape(source, ['id', 'groupId', 'poolId', 'version', 'poolVersion', 'manifestId', 'calendar', 'items', 'reason', 'comparison', 'confirmedAt', 'receiptId'], 'report');
  const groupId = planningUid(source.groupId, 'groupId'), poolId = planningUid(source.poolId, 'poolId');
  const manifestId = planningUid(source.manifestId, 'manifestId'), manifest = manifests.get(manifestId);
  if (!manifest || manifest.groupId !== groupId || manifest.poolId !== poolId) planningInvalid('manifestId', 'Relatório exige manifesto deste grupo e bolão.');
  const version = planningInt(source.version, 'version', 1), poolVersion = planningInt(source.poolVersion, 'poolVersion', 1);
  const confirmedAt = sourceTime(source.confirmedAt, 'confirmedAt');
  const calendar = source.calendar === null ? null : validateCalendarVersion(source.calendar);
  const items = validateRegistrationItems(source.items); hasProof(items);
  const reason = planningText(source.reason, 'reason', 2_000);
  const comparison = validateComparison(source.comparison), computed = compareValidated(manifest, items, evidence, calendar);
  if (comparisonSemantic(comparison) !== comparisonSemantic(computed)) planningInvalid('comparison', 'Conferência armazenada diverge dos dados observados e do manifesto.');
  if ((version > 1 || computed.issues.some((i) => i.severity === 'divergence' && i.plannedTicketKey === null)) && !reason.trim()) planningInvalid('reason', 'Revisão ou divergência global exige justificativa humana.');
  for (const item of items) if (computed.issues.some((i) => i.severity === 'divergence' && i.plannedTicketKey === item.plannedTicketKey) && !item.reason.trim()) planningInvalid('reason', 'Divergência do comprovante exige justificativa humana.');
  if (poolVersion < manifest.content.pool.version || confirmedAt < manifest.lockedAt || (calendar && calendar.collectedAt > confirmedAt)) planningInvalid('confirmedAt', 'Relatório precisa revisar manifesto e calendário já existentes, com versão observada válida.');
  const byEvidence = new Map(evidence.map((e) => [e.id, e]));
  if (items.some((item) => item.evidenceIds.some((id) => byEvidence.get(id)!.uploadedAt > confirmedAt) || (item.observed?.registeredAt && item.observed.registeredAt > confirmedAt))) planningInvalid('confirmedAt', 'Relatório não pode conter comprovante ou evento futuro à revisão humana.');
  return { id: planningUid(source.id, 'id'), groupId, poolId, version, poolVersion, manifestId, calendar, items, reason, comparison, confirmedAt, receiptId: planningUid(source.receiptId, 'receiptId') };
}
export function validateRegistrationSnapshot(input: unknown): RegistrationSnapshot {
  const source = planningRecord(input, 'snapshot'); planningShape(source, ['groupId', 'groupRevision', 'manifests', 'evidence', 'reports'], 'snapshot');
  const groupId = planningUid(source.groupId, 'groupId'), groupRevision = planningInt(source.groupRevision, 'groupRevision');
  const manifests = unique(planningList(source.manifests, 'manifests', 10_000).map(validatePoolManifest), (v) => v.id, 'manifests');
  const evidence = unique(planningList(source.evidence, 'evidence', 10_000).map(validateEvidenceMetadata), (v) => v.id, 'evidence');
  const byManifest = new Map(manifests.map((m) => [m.id, m]));
  const reports = unique(planningList(source.reports, 'reports', 10_000).map((r) => validateReport(r, byManifest, evidence)), (v) => v.id, 'reports');
  if ([...manifests, ...evidence, ...reports].some((fact) => fact.groupId !== groupId) || ((manifests.length || reports.length) && groupRevision === 0)) planningInvalid('groupId', 'Fatos de registro pertencem ao grupo confirmado.');
  unique([...manifests, ...evidence, ...reports], (v) => v.id, 'facts');
  unique(reports, (r) => r.receiptId, 'receiptId');
  const manifestsByPool = new Map<string, PoolManifest[]>();
  for (const manifest of manifests) {
    if (manifest.content.plan.groupRevision >= groupRevision || manifest.content.financial.groupRevision >= groupRevision) planningInvalid('groupRevision', 'Manifesto exige financiamento e planejamento históricos.');
    const values = manifestsByPool.get(manifest.poolId) ?? []; values.push(manifest); manifestsByPool.set(manifest.poolId, values);
  }
  for (const values of manifestsByPool.values()) {
    values.sort((a, b) => a.version - b.version);
    values.forEach((manifest, index) => {
      const previous = values[index - 1];
      if (manifest.version !== index + 1 || (previous && (manifest.lockedAt < previous.lockedAt || manifest.content.pool.version <= previous.content.pool.version))) planningInvalid('manifests', 'Histórico de manifestos deve ser contínuo e cronológico.');
      if (previous && (canonicalJSON(previous.content.financial) !== canonicalJSON(manifest.content.financial) || canonicalJSON(previous.content.persons) !== canonicalJSON(manifest.content.persons) || canonicalJSON(previous.content.responsible) !== canonicalJSON(manifest.content.responsible))) planningInvalid('manifests', 'Revisão deve preservar financiamento, pessoas e responsáveis congelados.');
    });
  }
  const byPool = new Map<string, RegistrationReport[]>();
  for (const report of reports) { const values = byPool.get(report.poolId) ?? []; values.push(report); byPool.set(report.poolId, values); }
  for (const [poolId, values] of byPool) {
    values.sort((a, b) => a.version - b.version);
    const first = values[0]!;
    const poolManifests = manifests.filter((m) => m.poolId === poolId);
    const latestManifest = poolManifests.reduce((a, b) => b.version > a.version ? b : a);
    if (latestManifest.id !== first.manifestId || poolManifests.some((m) => m.lockedAt > first.confirmedAt)) planningInvalid('manifests', 'Registro externo sela o último manifesto e impede novo planejamento.');
    values.forEach((report, index) => {
      const previous = values[index - 1];
      if (report.version !== index + 1 || report.manifestId !== first.manifestId || (previous && (report.poolVersion <= previous.poolVersion || report.confirmedAt < previous.confirmedAt))) planningInvalid('reports', 'Revisões de registro são contínuas, avançam versão do bolão e preservam o manifesto selado.');
    });
  }
  return { groupId, groupRevision, manifests, evidence, reports };
}
export function validateRegistrationReceipt(input: unknown): RegistrationReceipt {
  const source = planningRecord(input, 'receipt'); planningShape(source, ['apiVersion', 'idempotencyKey', 'receiptId', 'groupId', 'status', 'groupRevision', 'message', 'confirmedAt', 'snapshot'], 'receipt');
  if (source.apiVersion !== 'v1') planningInvalid('apiVersion', 'Versão da API não suportada.');
  const groupId = planningUid(source.groupId, 'groupId'), groupRevision = planningInt(source.groupRevision, 'groupRevision');
  const status = planningOption(source.status, ['accepted', 'conflict', 'rejected'], 'status');
  const receiptId = source.receiptId === null ? null : planningUid(source.receiptId, 'receiptId');
  const confirmedAt = source.confirmedAt === null ? null : sourceTime(source.confirmedAt, 'confirmedAt');
  const snapshot = source.snapshot === null ? null : validateRegistrationSnapshot(source.snapshot);
  if (snapshot && (snapshot.groupId !== groupId || snapshot.groupRevision !== groupRevision)) planningInvalid('snapshot', 'Recibo e retrato de registro devem ter mesmo grupo e revisão.');
  if (status === 'accepted' && (!snapshot || !confirmedAt || !receiptId)) planningInvalid('status', 'Aceite exige retrato, recibo e horário do servidor.');
  if (status !== 'accepted' && (confirmedAt !== null || receiptId !== null)) planningInvalid('status', 'Rejeição ou conflito não tem confirmação.');
  if (snapshot && confirmedAt) {
    if (snapshot.reports.some((r) => r.confirmedAt > confirmedAt) || snapshot.evidence.some((e) => e.uploadedAt > confirmedAt) || snapshot.manifests.some((m) => m.lockedAt > confirmedAt)) planningInvalid('confirmedAt', 'Recibo contém fatos posteriores à confirmação.');
    if (status === 'accepted' && snapshot.reports.filter((r) => r.receiptId === receiptId && r.confirmedAt === confirmedAt).length !== 1) planningInvalid('receiptId', 'Aceite precisa identificar exatamente um relatório humano novo.');
  }
  return { apiVersion: 'v1', idempotencyKey: planningUid(source.idempotencyKey, 'idempotencyKey'), receiptId, groupId, groupRevision, status, message: source.message === null ? null : planningText(source.message, 'message', 2_000), confirmedAt, snapshot };
}
/** Private registrar handoff: only execution/checklist information, without the financial snapshot. */
export function registrationHandoff(input: PoolManifest): string {
  const manifest = validatePoolManifest(input), plan = manifest.content.plan;
  const lines = [`Manifesto ${manifest.id}`, `SHA-256 ${manifest.sha256}`, `Modalidade ${plan.lotteryId}; concurso ${plan.contestNumber}`, `Participação ${plan.participationMode === 'official' ? 'bolão oficial' : 'acordo interno'}`, `Custo dos jogos: ${plan.betCostCents} centavos; taxa autorizada: ${plan.feeCents} centavos.`];
  for (const ticket of plan.tickets) {
    lines.push('', `[ ] Cartela ${ticket.key}; custo ${ticket.betCostCents} centavos${ticket.officialQuotaCount === null ? '' : `; ${ticket.officialQuotaCount} cotas oficiais`}`);
    for (const key of ticket.betKeys) lines.push(`  ${plan.bets.find((bet) => bet.key === key)!.numbers.map((n) => n.toString().padStart(2, '0')).join(' ')}`);
    if (ticket.officialQuotaCount !== null) for (const assignment of ticket.assignments) lines.push(`  Cota de referência ${assignment.quotaId}: ${assignment.officialQuotas} recibo(s) oficial(is).`);
  }
  lines.push('', 'Guardar os originais privados e conferir modalidade, concurso, jogos, custos, taxas, horário e cotas.');
  return lines.join('\n');
}
