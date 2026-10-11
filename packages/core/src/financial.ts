import type {
  ConfirmedQuota, FinancialAction, FinancialCommand, FinancialMovement, FinancialReceipt,
  FinancialSnapshot, PaymentAllocation, QuotaRevocation, ReceivedPayment, StatuteAcceptance, StatuteVersion,
} from './financial-types';
import { centsValue } from './money';
import { DomainValidationError, MAX_OPERATIONAL_CENTS, MAX_QUOTA_UNITS } from './validation';

export const MAX_PAYMENT_ALLOCATIONS = 100;
export interface FinanceTotals {
  cashCents: string;
  allocatedCents: string;
  unallocatedCents: string;
  pools: Record<string, { allocatedCents: string }>;
}

export interface FinancialView {
  finance: FinanceTotals;
  statute: StatuteVersion | null;
  personPoolFunding(poolId: string, personId: string): string;
  isQuotaActive(quotaId: string): boolean;
}

/** One immutable derived view per input version: validates once and indexes repeated UI selectors. */
export function createFinancialView(input: FinancialSnapshot): FinancialView {
  const snapshot = validateFinancialSnapshot(input);
  const funded = new Map<string, bigint>();
  for (const movement of snapshot.movements) {
    if (movement.kind === 'payment-allocated' || movement.kind === 'allocation-reversed') {
      const key = `${movement.poolId}:${movement.personId}`;
      funded.set(key, (funded.get(key) ?? 0n) + centsValue(movement.amountCents));
    }
  }
  const revoked = new Set(snapshot.revocations.map((revocation) => revocation.quotaId));
  const active = new Set(snapshot.quotas.filter((quota) => !revoked.has(quota.id)
    && (funded.get(`${quota.poolId}:${quota.personId}`) ?? 0n) >= centsValue(quota.dueCents)).map((quota) => quota.id));
  return {
    finance: totals(snapshot),
    statute: snapshot.statutes.reduce<StatuteVersion | null>((current, candidate) => !current || candidate.version > current.version ? candidate : current, null),
    personPoolFunding(poolId, personId) {
      return (funded.get(`${uid(poolId, 'poolId')}:${uid(personId, 'personId')}`) ?? 0n).toString();
    },
    isQuotaActive(quotaId) { return active.has(uid(quotaId, 'quotaId')); },
  };
}

/** Shape validation only; approval, references to drafts, deadlines and balances require SQL. */
export function validateFinancialCommand(input: unknown): FinancialCommand {
  const command = record(input, 'command');
  shape(command, ['apiVersion', 'idempotencyKey', 'groupId', 'expectedRevision', 'action'], 'command');
  if (command.apiVersion !== 'v1') invalid('apiVersion', 'Versão da API não suportada.');
  const action = record(command.action, 'action');
  let validated: FinancialAction;
  switch (action.type) {
    case 'statute_publish':
      shape(action, ['type', 'groupVersion'], 'action');
      validated = { type: 'statute_publish', groupVersion: integer(action.groupVersion, 'groupVersion', 1) };
      break;
    case 'statute_accept':
      shape(action, ['type', 'statuteId', 'personId', 'evidence'], 'action');
      validated = {
        type: 'statute_accept', statuteId: uid(action.statuteId, 'statuteId'),
        personId: uid(action.personId, 'personId'), evidence: plainText(action.evidence, 'evidence', 2_000, true),
      };
      break;
    case 'payment_confirm': {
      shape(action, ['type', 'proposalId', 'proposalVersion', 'bankReference', 'declaredReceivedAt', 'allocations'], 'action');
      const allocations = list(action.allocations, 'allocations');
      if (allocations.length > MAX_PAYMENT_ALLOCATIONS) invalid('allocations', 'Uma transferência pode ser alocada a no máximo 100 bolões por confirmação.');
      const pools = new Set<string>();
      const validatedAllocations = allocations.map((inputAllocation, index) => {
        const path = `allocations.${index}`;
        const allocation = record(inputAllocation, path);
        shape(allocation, ['poolId', 'amountCents'], path);
        const poolId = uid(allocation.poolId, `${path}.poolId`);
        if (pools.has(poolId)) invalid(path, 'Um bolão não pode aparecer duas vezes na mesma confirmação.');
        pools.add(poolId);
        return { poolId, amountCents: amount(allocation.amountCents, `${path}.amountCents`) };
      });
      const total = validatedAllocations.reduce((sum, allocation) => sum + centsValue(allocation.amountCents), 0n);
      if (total > BigInt(MAX_OPERATIONAL_CENTS)) invalid('allocations', 'O total alocado excede o limite operacional.');
      validated = {
        type: 'payment_confirm', proposalId: uid(action.proposalId, 'proposalId'),
        proposalVersion: integer(action.proposalVersion, 'proposalVersion', 1),
        bankReference: bankReference(action.bankReference, 'bankReference'),
        declaredReceivedAt: nullableTime(action.declaredReceivedAt, 'declaredReceivedAt'), allocations: validatedAllocations,
      };
      break;
    }
    case 'payment_allocate':
      shape(action, ['type', 'paymentId', 'poolId', 'amountCents'], 'action');
      validated = {
        type: 'payment_allocate', paymentId: uid(action.paymentId, 'paymentId'),
        poolId: uid(action.poolId, 'poolId'), amountCents: amount(action.amountCents, 'amountCents'),
      };
      break;
    case 'payment_reverse':
      shape(action, ['type', 'paymentId', 'reason'], 'action');
      validated = { type: 'payment_reverse', paymentId: uid(action.paymentId, 'paymentId'), reason: plainText(action.reason, 'reason', 2_000, true) };
      break;
    case 'quota_confirm':
      shape(action, ['type', 'quotaId', 'quotaVersion', 'statuteId'], 'action');
      validated = {
        type: 'quota_confirm', quotaId: uid(action.quotaId, 'quotaId'), quotaVersion: integer(action.quotaVersion, 'quotaVersion', 1),
        statuteId: uid(action.statuteId, 'statuteId'),
      };
      break;
    default:
      return invalid('action.type', 'Ação financeira não suportada.');
  }
  return {
    apiVersion: 'v1', idempotencyKey: uid(command.idempotencyKey, 'idempotencyKey'), groupId: uid(command.groupId, 'groupId'),
    expectedRevision: integer(command.expectedRevision, 'expectedRevision', 0), action: validated,
  };
}

/** A complete group snapshot: missing facts, orphan ledger rows or unjustified negatives are errors. */
export function validateFinancialSnapshot(input: unknown): FinancialSnapshot {
  const source = record(input, 'snapshot');
  shape(source, ['groupId', 'groupRevision', 'statutes', 'acceptances', 'payments', 'allocations', 'movements', 'quotas', 'revocations'], 'snapshot');
  const groupId = uid(source.groupId, 'groupId');
  const snapshot: FinancialSnapshot = {
    groupId, groupRevision: integer(source.groupRevision, 'groupRevision', 0),
    statutes: entities(source.statutes, 'statutes', groupId, validateStatute),
    acceptances: entities(source.acceptances, 'acceptances', groupId, validateAcceptance),
    payments: entities(source.payments, 'payments', groupId, validatePayment),
    allocations: entities(source.allocations, 'allocations', groupId, validateAllocation),
    movements: entities(source.movements, 'movements', groupId, validateMovement),
    quotas: entities(source.quotas, 'quotas', groupId, validateQuota),
    revocations: entities(source.revocations, 'revocations', groupId, validateRevocation),
  };
  checkReferences(snapshot);
  return snapshot;
}

export function validateFinancialReceipt(input: unknown): FinancialReceipt {
  const source = record(input, 'receipt');
  shape(source, ['apiVersion', 'idempotencyKey', 'groupId', 'status', 'groupRevision', 'message', 'confirmedAt', 'snapshot'], 'receipt');
  if (source.apiVersion !== 'v1') invalid('apiVersion', 'Versão da API não suportada.');
  const status = option(source.status, ['accepted', 'conflict', 'rejected'], 'status');
  const groupId = uid(source.groupId, 'groupId');
  const groupRevision = integer(source.groupRevision, 'groupRevision', 0);
  const confirmedAt = nullableTime(source.confirmedAt, 'confirmedAt');
  const snapshot = source.snapshot === null ? null : validateFinancialSnapshot(source.snapshot);
  if (snapshot && (snapshot.groupId !== groupId || snapshot.groupRevision !== groupRevision)) {
    invalid('snapshot', 'O recibo e o retrato financeiro devem pertencer ao mesmo grupo e revisão.');
  }
  if (status === 'accepted' && (!snapshot || confirmedAt === null)) invalid('status', 'Uma confirmação aceita exige retrato financeiro e horário do servidor.');
  if (status !== 'accepted' && confirmedAt !== null) invalid('confirmedAt', 'Uma operação rejeitada ou em conflito não possui horário de confirmação.');
  return {
    apiVersion: 'v1', idempotencyKey: uid(source.idempotencyKey, 'idempotencyKey'), groupId, status, groupRevision,
    message: source.message === null ? null : plainText(source.message, 'message', 2_000), confirmedAt, snapshot,
  };
}

/** Cash counts receipt/reversal once. Allocating the same transfer never increases group cash. */
export function computeFinance(input: FinancialSnapshot): FinanceTotals {
  return totals(validateFinancialSnapshot(input));
}

/** Net funding belongs to the payer in one pool; another person's money cannot activate their quota. */
export function personPoolFunding(input: FinancialSnapshot, poolId: string, personId: string): string {
  const pool = uid(poolId, 'poolId');
  const person = uid(personId, 'personId');
  return funding(validateFinancialSnapshot(input), pool, person).toString();
}

/** Full funding, accepted frozen statute, and no revocation. Partial payments do not create quotas. */
export function isQuotaActive(input: FinancialSnapshot, quotaId: string): boolean {
  const snapshot = validateFinancialSnapshot(input);
  const id = uid(quotaId, 'quotaId');
  const quota = snapshot.quotas.find((candidate) => candidate.id === id);
  if (!quota || snapshot.revocations.some((revocation) => revocation.quotaId === quota.id)) return false;
  return snapshot.acceptances.some((acceptance) => acceptance.statuteId === quota.statuteId && acceptance.personId === quota.personId)
    && funding(snapshot, quota.poolId, quota.personId) >= centsValue(quota.dueCents);
}

export function currentStatute(input: FinancialSnapshot): StatuteVersion | null {
  const snapshot = validateFinancialSnapshot(input);
  return snapshot.statutes.reduce<StatuteVersion | null>((current, candidate) => !current || candidate.version > current.version ? candidate : current, null);
}

function totals(snapshot: FinancialSnapshot): FinanceTotals {
  let cash = 0n;
  let allocated = 0n;
  const pools = new Map<string, bigint>();
  for (const quota of snapshot.quotas) pools.set(quota.poolId, 0n);
  for (const movement of snapshot.movements) {
    const value = centsValue(movement.amountCents);
    if (movement.kind === 'payment-received' || movement.kind === 'payment-reversed') cash += value;
    else {
      allocated += value;
      pools.set(movement.poolId!, (pools.get(movement.poolId!) ?? 0n) + value);
    }
  }
  return {
    cashCents: cash.toString(), allocatedCents: allocated.toString(), unallocatedCents: (cash - allocated).toString(),
    pools: Object.fromEntries([...pools].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([id, value]) => [id, { allocatedCents: value.toString() }])),
  };
}

function funding(snapshot: FinancialSnapshot, poolId: string, personId: string): bigint {
  return snapshot.movements.reduce((sum, movement) => movement.personId === personId && movement.poolId === poolId
    && (movement.kind === 'payment-allocated' || movement.kind === 'allocation-reversed') ? sum + centsValue(movement.amountCents) : sum, 0n);
}

function checkReferences(snapshot: FinancialSnapshot): void {
  const statutes = new Map(snapshot.statutes.map((statute) => [statute.id, statute]));
  const statutesByVersion = new Map(snapshot.statutes.map((statute) => [statute.version, statute]));
  const versions = new Set<number>();
  for (const statute of snapshot.statutes) {
    if (versions.has(statute.version)) invalid('statutes', 'Duas versões do estatuto não podem ter o mesmo número.');
    versions.add(statute.version);
  }
  for (let version = 1; version <= versions.size; version++) {
    if (!versions.has(version)) invalid('statutes', 'O histórico do estatuto possui uma versão ausente.');
    if (version > 1) {
      const previous = statutesByVersion.get(version - 1)!;
      const current = statutesByVersion.get(version)!;
      if (current.publishedAt < previous.publishedAt || current.sourceGroupVersion < previous.sourceGroupVersion) {
        invalid('statutes', 'Uma nova versão do estatuto não pode regredir o horário ou a versão do grupo.');
      }
    }
  }
  const acceptances = new Map<string, StatuteAcceptance>();
  for (const acceptance of snapshot.acceptances) {
    const statute = statutes.get(acceptance.statuteId);
    if (!statute) invalid('acceptances', 'O aceite aponta para um estatuto ausente.');
    if (acceptance.acceptedAt < statute.publishedAt) invalid('acceptances', 'O aceite não pode anteceder a publicação do estatuto.');
    const key = `${acceptance.statuteId}:${acceptance.personId}`;
    if (acceptances.has(key)) invalid('acceptances', 'O aceite de uma pessoa nessa versão do estatuto está duplicado.');
    acceptances.set(key, acceptance);
  }
  const payments = new Map(snapshot.payments.map((payment) => [payment.id, payment]));
  const proposals = new Set<string>();
  const bankReferences = new Set<string>();
  for (const payment of snapshot.payments) {
    if (proposals.has(payment.sourceProposalId)) invalid('payments', 'Uma proposta de pagamento não pode ser confirmada duas vezes.');
    proposals.add(payment.sourceProposalId);
    if (payment.bankReference !== null) {
      if (bankReferences.has(payment.bankReference)) invalid('payments', 'A referência bancária já foi confirmada neste grupo.');
      bankReferences.add(payment.bankReference);
    }
  }
  const allocations = new Map(snapshot.allocations.map((allocation) => [allocation.id, allocation]));
  const allocatedByPayment = new Map<string, bigint>();
  for (const allocation of snapshot.allocations) {
    const payment = payments.get(allocation.paymentId);
    if (!payment || allocation.personId !== payment.personId) invalid('allocations', 'A alocação deve apontar para o pagamento da mesma pessoa e grupo.');
    if (allocation.allocatedAt < payment.confirmedAt) invalid('allocations', 'A alocação não pode anteceder a confirmação do pagamento.');
    allocatedByPayment.set(payment.id, (allocatedByPayment.get(payment.id) ?? 0n) + centsValue(allocation.amountCents));
  }
  for (const payment of snapshot.payments) {
    if ((allocatedByPayment.get(payment.id) ?? 0n) > centsValue(payment.amountCents)) invalid('allocations', 'As alocações excedem o dinheiro recebido nessa transferência.');
  }
  const received = new Set<string>();
  const allocated = new Set<string>();
  const paymentReversals = new Map<string, FinancialMovement>();
  const allocationReversals = new Map<string, FinancialMovement>();
  for (const movement of snapshot.movements) {
    const payment = payments.get(movement.paymentId);
    if (!payment || movement.personId !== payment.personId) invalid('movements', 'O movimento deve pertencer ao pagamento da mesma pessoa e grupo.');
    if (movement.createdAt < payment.confirmedAt) invalid('movements', 'O movimento não pode anteceder o recebimento confirmado.');
    if (movement.kind === 'payment-received' || movement.kind === 'payment-reversed') {
      if (movement.poolId !== null || movement.allocationId !== null) invalid('movements', 'Recebimentos e estornos do caixa não apontam para um bolão ou alocação.');
      if (movement.kind === 'payment-received') {
        if (received.has(payment.id)) invalid('movements', 'Um pagamento só pode aumentar o caixa uma vez.');
        if (movement.amountCents !== payment.amountCents || movement.receiptId !== payment.receiptId || movement.createdAt !== payment.confirmedAt) {
          invalid('movements', 'O movimento de recebimento deve corresponder ao fato confirmado.');
        }
        received.add(payment.id);
      } else {
        if (paymentReversals.has(payment.id)) invalid('movements', 'Um pagamento não pode ser estornado duas vezes.');
        if (centsValue(movement.amountCents) !== -centsValue(payment.amountCents)) invalid('movements', 'O estorno deve compensar integralmente o pagamento original.');
        paymentReversals.set(payment.id, movement);
      }
    } else {
      const allocation = allocations.get(movement.allocationId!);
      if (!allocation || allocation.paymentId !== payment.id || allocation.personId !== movement.personId || allocation.poolId !== movement.poolId) {
        invalid('movements', 'O movimento de alocação deve corresponder à mesma transferência, pessoa e bolão.');
      }
      if (movement.kind === 'payment-allocated') {
        if (allocated.has(allocation.id)) invalid('movements', 'Uma alocação não pode ser lançada duas vezes no histórico.');
        if (movement.amountCents !== allocation.amountCents || movement.receiptId !== allocation.receiptId || movement.createdAt !== allocation.allocatedAt) {
          invalid('movements', 'O movimento de alocação deve corresponder ao fato confirmado.');
        }
        allocated.add(allocation.id);
      } else {
        if (allocationReversals.has(allocation.id)) invalid('movements', 'Uma alocação não pode ser estornada duas vezes.');
        if (centsValue(movement.amountCents) !== -centsValue(allocation.amountCents)) invalid('movements', 'O estorno da alocação deve compensar integralmente o valor original.');
        if (movement.createdAt < allocation.allocatedAt) invalid('movements', 'O estorno não pode anteceder a alocação original.');
        allocationReversals.set(allocation.id, movement);
      }
    }
  }
  for (const payment of snapshot.payments) {
    if (!received.has(payment.id)) invalid('movements', 'O histórico está sem o movimento de recebimento de um pagamento.');
  }
  for (const allocation of snapshot.allocations) {
    if (!allocated.has(allocation.id)) invalid('movements', 'O histórico está sem o movimento de uma alocação.');
    const reversal = paymentReversals.get(allocation.paymentId);
    const compensation = allocationReversals.get(allocation.id);
    if (reversal) {
      if (!compensation || compensation.receiptId !== reversal.receiptId || compensation.createdAt !== reversal.createdAt) {
        invalid('movements', 'Estornar a transferência exige compensar todas as alocações no mesmo recibo e horário.');
      }
      if (allocation.allocatedAt > reversal.createdAt) invalid('allocations', 'Uma transferência estornada não pode receber novas alocações.');
    } else if (compensation) invalid('movements', 'O estorno da alocação exige o estorno da transferência original.');
  }
  const quotas = new Map(snapshot.quotas.map((quota) => [quota.id, quota]));
  const revoked = new Set<string>();
  for (const revocation of snapshot.revocations) {
    const quota = quotas.get(revocation.quotaId);
    if (!quota) invalid('revocations', 'A revogação aponta para uma cota ausente.');
    if (revoked.has(quota.id)) invalid('revocations', 'Uma cota não pode ser revogada duas vezes.');
    if (revocation.revokedAt < quota.confirmedAt) invalid('revocations', 'A revogação não pode anteceder a cota confirmada.');
    revoked.add(quota.id);
  }
  const activeRights = new Set<string>();
  const fundedRights = new Map<string, bigint>();
  for (const movement of snapshot.movements) {
    if (movement.kind === 'payment-allocated' || movement.kind === 'allocation-reversed') {
      const key = `${movement.poolId}:${movement.personId}`;
      fundedRights.set(key, (fundedRights.get(key) ?? 0n) + centsValue(movement.amountCents));
    }
  }
  for (const quota of snapshot.quotas) {
    const statute = statutes.get(quota.statuteId);
    const acceptance = acceptances.get(`${quota.statuteId}:${quota.personId}`);
    if (!statute || !acceptance || quota.confirmedAt < acceptance.acceptedAt) invalid('quotas', 'A cota exige uma versão publicada do estatuto e aceite anterior da mesma pessoa.');
    if (!revoked.has(quota.id)) {
      const key = `${quota.poolId}:${quota.personId}`;
      if (activeRights.has(key)) invalid('quotas', 'Uma pessoa só pode ter uma cota confirmada sem revogação por bolão.');
      if ((fundedRights.get(key) ?? 0n) < centsValue(quota.dueCents)) {
        invalid('quotas', 'Uma cota confirmada sem financiamento integral precisa de revogação explícita.');
      }
      activeRights.add(key);
    }
  }
  const balance = totals(snapshot);
  if (centsValue(balance.cashCents) < 0n || centsValue(balance.allocatedCents) < 0n || centsValue(balance.unallocatedCents) < 0n) {
    invalid('movements', 'O histórico financeiro não pode produzir saldo negativo sem justificativa.');
  }
}

function validateStatute(source: Record<string, unknown>, path: string): StatuteVersion {
  shape(source, ['id', 'groupId', 'version', 'text', 'sourceGroupVersion', 'publishedAt', 'receiptId'], path);
  return {
    ...identity(source, path), version: integer(source.version, `${path}.version`, 1), text: plainText(source.text, `${path}.text`, 12_000, true),
    sourceGroupVersion: integer(source.sourceGroupVersion, `${path}.sourceGroupVersion`, 1),
    publishedAt: time(source.publishedAt, `${path}.publishedAt`), receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function validateAcceptance(source: Record<string, unknown>, path: string): StatuteAcceptance {
  shape(source, ['id', 'groupId', 'statuteId', 'personId', 'evidence', 'acceptedAt', 'receiptId'], path);
  return {
    ...identity(source, path), statuteId: uid(source.statuteId, `${path}.statuteId`), personId: uid(source.personId, `${path}.personId`),
    evidence: plainText(source.evidence, `${path}.evidence`, 2_000, true), acceptedAt: time(source.acceptedAt, `${path}.acceptedAt`),
    receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function validatePayment(source: Record<string, unknown>, path: string): ReceivedPayment {
  shape(source, ['id', 'groupId', 'personId', 'sourceProposalId', 'sourceProposalVersion', 'amountCents', 'bankReference', 'declaredReceivedAt', 'confirmedAt', 'receiptId'], path);
  return {
    ...identity(source, path), personId: uid(source.personId, `${path}.personId`), sourceProposalId: uid(source.sourceProposalId, `${path}.sourceProposalId`),
    sourceProposalVersion: integer(source.sourceProposalVersion, `${path}.sourceProposalVersion`, 1), amountCents: amount(source.amountCents, `${path}.amountCents`),
    bankReference: bankReference(source.bankReference, `${path}.bankReference`), declaredReceivedAt: nullableTime(source.declaredReceivedAt, `${path}.declaredReceivedAt`),
    confirmedAt: time(source.confirmedAt, `${path}.confirmedAt`), receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function validateAllocation(source: Record<string, unknown>, path: string): PaymentAllocation {
  shape(source, ['id', 'groupId', 'paymentId', 'personId', 'poolId', 'amountCents', 'allocatedAt', 'receiptId'], path);
  return {
    ...identity(source, path), paymentId: uid(source.paymentId, `${path}.paymentId`), personId: uid(source.personId, `${path}.personId`),
    poolId: uid(source.poolId, `${path}.poolId`), amountCents: amount(source.amountCents, `${path}.amountCents`),
    allocatedAt: time(source.allocatedAt, `${path}.allocatedAt`), receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function validateMovement(source: Record<string, unknown>, path: string): FinancialMovement {
  shape(source, ['id', 'groupId', 'paymentId', 'personId', 'poolId', 'allocationId', 'kind', 'amountCents', 'reason', 'createdAt', 'receiptId'], path);
  const kind = option(source.kind, ['payment-received', 'payment-allocated', 'payment-reversed', 'allocation-reversed'], `${path}.kind`);
  const reversal = kind === 'payment-reversed' || kind === 'allocation-reversed';
  return {
    ...identity(source, path), paymentId: uid(source.paymentId, `${path}.paymentId`), personId: uid(source.personId, `${path}.personId`),
    poolId: nullableUid(source.poolId, `${path}.poolId`), allocationId: nullableUid(source.allocationId, `${path}.allocationId`), kind,
    amountCents: amount(source.amountCents, `${path}.amountCents`, reversal), reason: plainText(source.reason, `${path}.reason`, 2_000, reversal),
    createdAt: time(source.createdAt, `${path}.createdAt`), receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function validateQuota(source: Record<string, unknown>, path: string): ConfirmedQuota {
  shape(source, ['id', 'groupId', 'poolId', 'personId', 'sourceQuotaId', 'sourceQuotaVersion', 'units', 'dueCents', 'statuteId', 'confirmedAt', 'receiptId'], path);
  return {
    ...identity(source, path), poolId: uid(source.poolId, `${path}.poolId`), personId: uid(source.personId, `${path}.personId`),
    sourceQuotaId: uid(source.sourceQuotaId, `${path}.sourceQuotaId`), sourceQuotaVersion: integer(source.sourceQuotaVersion, `${path}.sourceQuotaVersion`, 1),
    units: integer(source.units, `${path}.units`, 1, MAX_QUOTA_UNITS), dueCents: amount(source.dueCents, `${path}.dueCents`),
    statuteId: uid(source.statuteId, `${path}.statuteId`), confirmedAt: time(source.confirmedAt, `${path}.confirmedAt`), receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function validateRevocation(source: Record<string, unknown>, path: string): QuotaRevocation {
  shape(source, ['id', 'groupId', 'quotaId', 'reason', 'revokedAt', 'receiptId'], path);
  return {
    ...identity(source, path), quotaId: uid(source.quotaId, `${path}.quotaId`), reason: plainText(source.reason, `${path}.reason`, 2_000, true),
    revokedAt: time(source.revokedAt, `${path}.revokedAt`), receiptId: uid(source.receiptId, `${path}.receiptId`),
  };
}

function entities<T extends { id: string; groupId: string }>(value: unknown, path: string, groupId: string, validate: (source: Record<string, unknown>, path: string) => T): T[] {
  const ids = new Set<string>();
  return list(value, path).map((source, index) => {
    const entityPath = `${path}.${index}`;
    const entity = validate(record(source, entityPath), entityPath);
    if (entity.groupId !== groupId) invalid(entityPath, 'O retrato financeiro não pode misturar dados de grupos diferentes.');
    if (ids.has(entity.id)) invalid(entityPath, 'Um fato financeiro está duplicado no retrato do grupo.');
    ids.add(entity.id);
    return entity;
  });
}

function identity(source: Record<string, unknown>, path: string): { id: string; groupId: string } {
  return { id: uid(source.id, `${path}.id`), groupId: uid(source.groupId, `${path}.groupId`) };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(path, 'Informe um objeto de dados válido.');
  return value as Record<string, unknown>;
}

function shape(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  const expected = new Set(fields);
  for (const field of Object.keys(value)) if (!expected.has(field)) invalid(`${path}.${field}`, `Campo não suportado: ${field}.`);
  for (const field of fields) if (!Object.hasOwn(value, field)) invalid(`${path}.${field}`, `Campo obrigatório ausente: ${field}.`);
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'Informe uma lista de dados.');
  return value;
}

function uid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid(path, 'Informe um identificador UUID.');
  return value.toLowerCase();
}

function nullableUid(value: unknown, path: string): string | null { return value === null ? null : uid(value, path); }

function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(path, `Informe um inteiro entre ${minimum} e ${maximum}.`);
  return value;
}

function amount(value: unknown, path: string, reversal = false): string {
  if (typeof value !== 'string' || value.length > MAX_OPERATIONAL_CENTS.length + (reversal ? 1 : 0)) invalid(path, 'Informe centavos inteiros em formato canônico.');
  let cents: bigint;
  try { cents = centsValue(value); } catch { return invalid(path, 'Informe centavos inteiros em formato canônico.'); }
  const absolute = reversal ? -cents : cents;
  if (absolute <= 0n || absolute > BigInt(MAX_OPERATIONAL_CENTS)) invalid(path, reversal ? 'Um estorno exige centavos negativos dentro do limite operacional.' : 'Informe centavos positivos dentro do limite operacional.');
  return cents.toString();
}

/** Text is opaque evidence. It is never executed, interpreted as instructions, or rendered as HTML here. */
function plainText(value: unknown, path: string, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) || value.includes('\u0000')) invalid(path, `Informe texto ${required ? 'não vazio ' : ''}com até ${maximum} caracteres.`);
  return value;
}

function bankReference(value: unknown, path: string): string | null {
  return value === null ? null : plainText(value, path, 200, true).trim();
}

function time(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) invalid(path, 'Informe data e horário UTC em formato ISO.');
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 19) !== value.slice(0, 19)) invalid(path, 'Informe uma data e horário válidos.');
  return timestamp.toISOString();
}

function nullableTime(value: unknown, path: string): string | null { return value === null ? null : time(value, path); }

function option<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(path, 'Valor não suportado.');
  return value as T;
}

function invalid(field: string, message: string): never { throw new DomainValidationError(field, message); }
