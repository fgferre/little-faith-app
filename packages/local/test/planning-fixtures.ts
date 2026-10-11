import { canonicalJSON, PLANNING_CATALOG, sha256Hex, suggestPlans } from '@bolao/core';
import type { AppliedPlan, FinancialSnapshot, LocalRecord, PlanningSnapshot, PoolManifest, PreparedPlan } from '@bolao/core';

export const id = (value: number) => `${value.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
export const GROUP = id(1);
export const OTHER_GROUP = id(2);
export const PERSON = id(3);
export const POOL = id(4);
export const OTHER_POOL = id(5);
export const QUOTA_DRAFT = id(6);
export const PROPOSAL = id(7);
export const TIME = '2026-10-08T12:00:00.000Z';
export const LATER = '2026-10-08T12:01:00.000Z';
export const SEED = 'ab'.repeat(32);

export function financialSnapshot(groupId = GROUP): FinancialSnapshot {
  const receiptId = id(30);
  const allocationReceipt = id(31);
  return {
    groupId, groupRevision: 5,
    statutes: [{ id: id(10), groupId, version: 1, sourceGroupVersion: 1, text: 'Participações integrais com aceite.', publishedAt: TIME, receiptId: id(32) }],
    acceptances: [{ id: id(11), groupId, statuteId: id(10), personId: PERSON, evidence: 'Aceite escrito da pessoa.', acceptedAt: TIME, receiptId: id(33) }],
    payments: [{ id: id(12), groupId, personId: PERSON, sourceProposalId: PROPOSAL, sourceProposalVersion: 1, amountCents: '2000', bankReference: null, declaredReceivedAt: null, confirmedAt: TIME, receiptId }],
    allocations: [{ id: id(13), groupId, paymentId: id(12), personId: PERSON, poolId: POOL, amountCents: '2000', allocatedAt: TIME, receiptId: allocationReceipt }],
    movements: [
      { id: id(14), groupId, paymentId: id(12), personId: PERSON, poolId: null, allocationId: null, kind: 'payment-received', amountCents: '2000', reason: '', createdAt: TIME, receiptId },
      { id: id(15), groupId, paymentId: id(12), personId: PERSON, poolId: POOL, allocationId: id(13), kind: 'payment-allocated', amountCents: '2000', reason: '', createdAt: TIME, receiptId: allocationReceipt },
    ],
    quotas: [{ id: id(16), groupId, poolId: POOL, personId: PERSON, sourceQuotaId: QUOTA_DRAFT, sourceQuotaVersion: 1, units: 100, dueCents: '2000', statuteId: id(10), confirmedAt: TIME, receiptId: id(34) }],
    revocations: [],
  };
}

export function poolRecord(groupId = GROUP): LocalRecord<'pool'> {
  return {
    id: POOL, groupId, kind: 'pool', localVersion: 1, serverVersion: 1, state: 'synced', createdAt: TIME, updatedAt: TIME,
    data: { title: 'Mega de amigos', lotteryId: 'mega-sena', contestNumber: 3000, deadlineAt: '2026-10-09T18:00:00.000Z', quotaPriceCents: '2000', participationMode: 'internal', status: 'draft' },
  };
}

export function candidate(groupId = GROUP, seed = SEED, groupRevision = 5): PreparedPlan {
  const suggestions = suggestPlans({
    groupId, groupRevision, pool: poolRecord(groupId), sourceBets: [], financial: { ...financialSnapshot(groupId), groupRevision },
    seed, feeCents: '0', feeLabel: '', leftoverPolicy: 'group-credit',
  });
  if (!suggestions.plans[0]) throw new Error('A fixture precisa de um candidato viável.');
  return suggestions.plans[0];
}

export function appliedPlan(plan = candidate(), version = 1, receiptId = id(40)): AppliedPlan {
  return { id: id(50 + version), groupId: plan.groupId, poolId: plan.poolId, version, plan, appliedAt: TIME, receiptId };
}

export function manifest(applied: AppliedPlan, version = 1, receiptId = id(41)): PoolManifest {
  const pool = poolRecord(applied.groupId);
  const content = {
    schemaVersion: 'pool-manifest-v1' as const,
    responsible: { organizerUserId: id(100), registrarPersonId: PERSON, ticketHolderPersonId: PERSON },
    catalog: PLANNING_CATALOG[applied.plan.lotteryId],
    pool: { id: pool.id, version: pool.serverVersion + 1, data: { ...pool.data, status: 'locked' as const } },
    plan: applied.plan,
    persons: [{ id: PERSON, version: 1, data: { name: 'Ana', nickname: '', adultDeclared: true } }],
    financial: financialSnapshot(applied.groupId),
  };
  const canonical = canonicalJSON(content);
  return {
    id: id(60 + version), groupId: applied.groupId, poolId: applied.poolId, version, appliedPlanId: applied.id,
    content, canonical, sha256: sha256Hex(canonical), lockedAt: LATER, receiptId,
  };
}

export function emptyPlanningSnapshot(groupId = GROUP, groupRevision = 5): PlanningSnapshot {
  return { groupId, groupRevision, appliedPlans: [], manifests: [] };
}

export function appliedSnapshot(groupRevision = 6): PlanningSnapshot {
  return { groupId: GROUP, groupRevision, appliedPlans: [appliedPlan()], manifests: [] };
}

export function lockedSnapshot(groupRevision = 7): PlanningSnapshot {
  const applied = appliedPlan();
  return { groupId: GROUP, groupRevision, appliedPlans: [applied], manifests: [manifest(applied)] };
}
