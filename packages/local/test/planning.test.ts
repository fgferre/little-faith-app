import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON } from '@bolao/core';
import type { FinancialCommand, LocalRecord, PlanningCommand, PlanningReceipt, PlanningTransport } from '@bolao/core';
import {
  applyFinancialSnapshot, applyPlanningSnapshot, createLocalStore, executePlanningCommand,
  exportEmergencySnapshot, getFinancialSnapshot, getPlanningSnapshot, preparePlanningCommand,
  recoverPlanningCommand, saveDraft, sync,
} from '../src';
import type { BolaoDatabase, LocalSyncTransport, PersistentFinancialCommand, QueuedOperation } from '../src';
import {
  appliedPlan, appliedSnapshot, candidate, emptyPlanningSnapshot, financialSnapshot, GROUP,
  id, LATER, lockedSnapshot, manifest, OTHER_GROUP, PERSON, POOL, PROPOSAL, TIME,
} from './planning-fixtures';

const stores: Dexie[] = [];
function store(accountId = 'account-a', installationId: string = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}
function command(key: string = crypto.randomUUID(), expectedRevision = 5): PlanningCommand {
  return { apiVersion: 'v1', idempotencyKey: key, groupId: GROUP, expectedRevision, action: { type: 'plan_apply', plan: candidate() } };
}
function lockCommand(appliedPlanId: string, key: string = crypto.randomUUID(), expectedRevision = 6): PlanningCommand {
  return { apiVersion: 'v1', idempotencyKey: key, groupId: GROUP, expectedRevision, action: { type: 'pool_lock', poolId: POOL, poolVersion: 1, appliedPlanId, responsible: { registrarPersonId: PERSON, ticketHolderPersonId: PERSON } } };
}

class PlanningServer implements PlanningTransport, LocalSyncTransport {
  snapshot = emptyPlanningSnapshot();
  readonly receipts = new Map<string, PlanningReceipt>();
  readonly payloads = new Map<string, string>();
  readonly requests: PlanningCommand[] = [];
  statusCalls = 0;
  loseAfterAccepting = false;
  loseBeforeAccepting = false;
  return404 = false;
  rejectNext = false;
  async listGroupIds() { return [GROUP]; }
  async push() { return []; }
  async pull(groupId: string, cursor: number) { return { groupId, changes: [], nextCursor: cursor, hasMore: false }; }
  async planningPull() { return structuredClone(this.snapshot); }
  async planningCommandStatus(key: string) {
    this.statusCalls += 1;
    if (this.return404) throw Object.assign(new Error('Receipt not found.'), { status: 404 });
    return structuredClone(this.receipts.get(key) ?? null);
  }
  async planningDecide(input: PlanningCommand): Promise<PlanningReceipt> {
    this.requests.push(structuredClone(input));
    const payload = canonicalJSON(input);
    const previous = this.payloads.get(input.idempotencyKey);
    if (previous && previous !== payload) throw new Error('A decisão idempotente mudou.');
    this.payloads.set(input.idempotencyKey, payload);
    if (this.loseBeforeAccepting) { this.loseBeforeAccepting = false; throw new Error('Lost before processing.'); }
    const existing = this.receipts.get(input.idempotencyKey);
    if (existing) return structuredClone(existing);
    let receipt: PlanningReceipt;
    if (this.rejectNext) {
      this.rejectNext = false;
      receipt = { apiVersion: 'v1', idempotencyKey: input.idempotencyKey, receiptId: null, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'rejected', message: 'Confira os responsáveis.', confirmedAt: null, snapshot: null };
    } else if (input.expectedRevision !== this.snapshot.groupRevision) {
      receipt = { apiVersion: 'v1', idempotencyKey: input.idempotencyKey, receiptId: null, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'conflict', message: 'O grupo mudou desde a revisão.', confirmedAt: null, snapshot: structuredClone(this.snapshot) };
    } else {
      const receiptId = crypto.randomUUID();
      this.snapshot.groupRevision += 1;
      if (input.action.type === 'plan_apply') {
        const action = input.action;
        const version = 1 + Math.max(0, ...this.snapshot.appliedPlans.filter(row => row.poolId === action.plan.poolId).map(row => row.version));
        this.snapshot.appliedPlans.push(appliedPlan(action.plan, version, receiptId));
      } else {
        const action = input.action;
        const applied = this.snapshot.appliedPlans.find(row => row.id === action.appliedPlanId);
        if (!applied) throw new Error('Applied plan not found.');
        const version = 1 + Math.max(0, ...this.snapshot.manifests.filter(row => row.poolId === action.poolId).map(row => row.version));
        this.snapshot.manifests.push(manifest(applied, version, receiptId));
      }
      receipt = { apiVersion: 'v1', idempotencyKey: input.idempotencyKey, receiptId, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'accepted', message: null, confirmedAt: input.action.type === 'pool_lock' ? LATER : TIME, snapshot: structuredClone(this.snapshot) };
    }
    this.receipts.set(input.idempotencyKey, structuredClone(receipt));
    if (this.loseAfterAccepting) { this.loseAfterAccepting = false; throw new Error('Lost after accepting.'); }
    return receipt;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

describe('v3 migration and immutable planning facts', () => {
  it('preserves v2 drafts, attempted outbox, financial facts and unknown financial commands', async () => {
    const db = store();
    const legacy = new Dexie(db.name);
    stores.push(legacy);
    legacy.version(2).stores({
      records: '&id, groupId, kind, state, [kind+groupId]', operations: '&idempotencyKey, entityId, groupId, sequence, status, dependsOn',
      receipts: '&idempotencyKey, entityId, status', cursors: '&groupId', confirmedPayments: '&id, groupId, poolId, personId, receiptId', metadata: '&key', serverRecords: '&id, groupId, kind',
      statutes: '&id, groupId, version, receiptId, [groupId+version]', statuteAcceptances: '&id, groupId, statuteId, personId, receiptId, [statuteId+personId]',
      receivedPayments: '&id, groupId, personId, sourceProposalId, receiptId', paymentAllocations: '&id, groupId, paymentId, personId, poolId, receiptId',
      financialMovements: '&id, groupId, paymentId, personId, poolId, allocationId, kind, receiptId', confirmedQuotas: '&id, groupId, poolId, personId, sourceQuotaId, statuteId, receiptId',
      quotaRevocations: '&id, groupId, quotaId, receiptId', financialSnapshots: '&groupId, groupRevision', financialCommands: '&idempotencyKey, groupId, status, createdAt', financialReceipts: '&idempotencyKey, groupId, status',
    });
    const record: LocalRecord<'person'> = { id: PERSON, groupId: GROUP, kind: 'person', data: { name: 'Ana', nickname: '', adultDeclared: true }, localVersion: 1, serverVersion: 0, state: 'queued', createdAt: TIME, updatedAt: TIME };
    const operation: QueuedOperation = { apiVersion: 'v1', idempotencyKey: id(80), entityId: PERSON, groupId: GROUP, kind: 'person', expectedVersion: 0, data: record.data, createdAt: TIME, localVersion: 1, sequence: 1, status: 'in-flight', dependsOn: null, attempts: 1, lastAttemptAt: TIME, message: null };
    const financeCommand: FinancialCommand = { apiVersion: 'v1', idempotencyKey: id(81), groupId: GROUP, expectedRevision: 5, action: { type: 'payment_reverse', paymentId: id(12), reason: 'Revisão humana original.' } };
    const persistent: PersistentFinancialCommand = { idempotencyKey: financeCommand.idempotencyKey, groupId: GROUP, command: financeCommand, status: 'unknown', createdAt: TIME, updatedAt: TIME };
    const finance = financialSnapshot();
    await legacy.table('records').put(record);
    await legacy.table('operations').put(operation);
    await legacy.table('cursors').put({ groupId: GROUP, cursor: 5 });
    await legacy.table('metadata').put({ key: 'outboxSequence', value: 1 });
    await legacy.table('financialCommands').put(persistent);
    for (const [table, rows] of [['statutes', finance.statutes], ['statuteAcceptances', finance.acceptances], ['receivedPayments', finance.payments], ['paymentAllocations', finance.allocations], ['financialMovements', finance.movements], ['confirmedQuotas', finance.quotas]] as const) {
      await legacy.table(table).bulkPut(rows);
    }
    await legacy.table('financialSnapshots').put({ groupId: GROUP, groupRevision: 5, updatedAt: TIME });
    legacy.close();
    expect(await db.records.get(PERSON)).toEqual(record);
    expect(await db.operations.get(operation.idempotencyKey)).toEqual(operation);
    expect(await db.financialCommands.get(financeCommand.idempotencyKey)).toEqual(persistent);
    expect(await getFinancialSnapshot(db, GROUP)).toEqual(finance);
    expect(await db.cursors.get(GROUP)).toEqual({ groupId: GROUP, cursor: 5 });
    expect(await db.metadata.get('outboxSequence')).toEqual({ key: 'outboxSequence', value: 1 });
    expect(await db.planningCommands.count()).toBe(0);
    expect(await db.planningAnalyses.count()).toBe(0);
    expect(db.verno).toBe(4);
  });

  it('stores applied plans and hashed manifests independently of drafts and finance', async () => {
    const db = store();
    const draft = await saveDraft(db, { groupId: GROUP, kind: 'person', data: { name: 'Proposta local', nickname: '', adultDeclared: true } });
    await applyFinancialSnapshot(db, financialSnapshot());
    const snapshot = lockedSnapshot();
    await applyPlanningSnapshot(db, snapshot);
    expect(await getPlanningSnapshot(db, GROUP)).toEqual(snapshot);
    expect(await db.records.get(draft.id)).toEqual(draft);
    expect(await db.operations.count()).toBe(1);
    expect(await getFinancialSnapshot(db, GROUP)).toEqual(financialSnapshot());
  });

  it('ignores old receipts and snapshots without removing later manifests or versions', async () => {
    const db = store();
    await applyPlanningSnapshot(db, lockedSnapshot());
    await applyPlanningSnapshot(db, appliedSnapshot());
    expect(await getPlanningSnapshot(db, GROUP)).toEqual(lockedSnapshot());
    expect(await db.poolManifests.count()).toBe(1);
  });

  it('appends explicit plan versions even when identifiers and timestamps cannot determine order', async () => {
    const db = store();
    const first = appliedSnapshot();
    await applyPlanningSnapshot(db, first);
    const second = appliedPlan(candidate(GROUP, 'cd'.repeat(32), 6), 2, id(42));
    second.id = id(20);
    const later = { groupId: GROUP, groupRevision: 7, appliedPlans: [first.appliedPlans[0]!, second], manifests: [] };
    await applyPlanningSnapshot(db, later);
    await applyPlanningSnapshot(db, first);
    const persisted = await getPlanningSnapshot(db, GROUP);
    expect(persisted?.appliedPlans).toHaveLength(2);
    expect(persisted?.appliedPlans.find(plan => plan.version === 2)?.id).toBe(second.id);
    expect(persisted?.groupRevision).toBe(7);
  });

  it('validates manifest hashes before persisting any otherwise-valid plan facts', async () => {
    const db = store();
    const invalid = lockedSnapshot();
    invalid.manifests[0]!.sha256 = '0'.repeat(64);
    await expect(applyPlanningSnapshot(db, invalid)).rejects.toThrow('SHA-256');
    expect(await db.appliedPlans.count()).toBe(0);
    expect(await db.poolManifests.count()).toBe(0);
    expect(await getPlanningSnapshot(db, GROUP)).toBeNull();
  });

  it('rejects immutable edits, missing history and new facts without a newer revision atomically', async () => {
    const db = store();
    const original = appliedSnapshot();
    await applyPlanningSnapshot(db, original);
    const changed = structuredClone(original);
    changed.groupRevision += 1;
    changed.appliedPlans[0]!.appliedAt = LATER;
    await expect(applyPlanningSnapshot(db, changed)).rejects.toThrow('alterar um plano');
    await expect(applyPlanningSnapshot(db, emptyPlanningSnapshot(GROUP, 7))).rejects.toThrow('não podem ser removidos');
    const sameRevision = lockedSnapshot(6);
    await expect(applyPlanningSnapshot(db, sameRevision)).rejects.toThrow('revisão de planejamento não avançou');
    expect(await getPlanningSnapshot(db, GROUP)).toEqual(original);
    expect(await db.poolManifests.count()).toBe(0);
  });

  it('rejects cross-group IDs and keeps account/demo facts isolated', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const other = store('account-b', installationId);
    const demo = store('demo', installationId);
    await applyPlanningSnapshot(db, appliedSnapshot());
    const foreign = { ...emptyPlanningSnapshot(OTHER_GROUP, 6), appliedPlans: [appliedPlan(candidate(OTHER_GROUP))] };
    await expect(applyPlanningSnapshot(db, foreign)).rejects.toThrow('alterar um plano');
    expect(await getPlanningSnapshot(db, OTHER_GROUP)).toBeNull();
    expect(await getPlanningSnapshot(other, GROUP)).toBeNull();
    expect(await getPlanningSnapshot(demo, GROUP)).toBeNull();
  });
});

describe('explicit plan application and pool locks', () => {
  it('prepares offline with immutable key/payload and no confirmed effects', async () => {
    const db = store();
    vi.stubGlobal('navigator', { onLine: false });
    const input = command();
    const prepared = await preparePlanningCommand(db, input);
    expect(prepared).toMatchObject({ command: input, status: 'prepared' });
    expect(await preparePlanningCommand(db, structuredClone(input))).toEqual(prepared);
    const different = { ...input, action: { type: 'plan_apply' as const, plan: candidate(GROUP, 'cd'.repeat(32)) } };
    await expect(preparePlanningCommand(db, different)).rejects.toThrow('outra decisão de planejamento');
    expect(await db.appliedPlans.count()).toBe(0);
    expect(await db.poolManifests.count()).toBe(0);
    expect(await db.operations.count()).toBe(0);
  });

  it('prohibits offline approval without sending or changing prepared state', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    vi.stubGlobal('navigator', { onLine: false });
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow('internet');
    expect(server.requests).toHaveLength(0);
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('prepared');
  });

  it('recovers a lost accepted response after reopen using GET only', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    server.loseAfterAccepting = true;
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow('Lost after');
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect(await db.appliedPlans.count()).toBe(0);
    db.close();
    const reopened = store(db.accountId, db.installationId);
    const receipt = await recoverPlanningCommand(reopened, server, input.idempotencyKey);
    expect(receipt?.status).toBe('accepted');
    expect(await reopened.appliedPlans.count()).toBe(1);
    expect((await reopened.appliedPlans.toArray())[0]!.receiptId).not.toBe(input.idempotencyKey);
    expect(server.requests).toHaveLength(1);
    expect(server.statusCalls).toBe(1);
    expect(await executePlanningCommand(reopened, server, input.idempotencyKey)).toEqual(receipt);
    expect(server.requests).toHaveLength(1);
  });

  it('keeps 404 unknown and retries only when explicitly asked with the same payload', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    server.loseBeforeAccepting = true;
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow('Lost before');
    server.return404 = true;
    expect(await recoverPlanningCommand(db, server, input.idempotencyKey)).toBeNull();
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect(server.requests).toHaveLength(1);
    expect(await db.appliedPlans.count()).toBe(0);
    server.return404 = false;
    const receipt = await executePlanningCommand(db, server, input.idempotencyKey);
    expect(receipt.status).toBe('accepted');
    expect(server.requests).toEqual([input, input]);
    expect(await db.appliedPlans.count()).toBe(1);
  });

  it('requires receipt lookup for a sending command left by an interrupted app', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    await db.planningCommands.update(input.idempotencyKey, { status: 'sending' });
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow('já está em envio');
    expect(server.requests).toHaveLength(0);
    expect(await recoverPlanningCommand(db, server, input.idempotencyKey)).toBeNull();
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect((await executePlanningCommand(db, server, input.idempotencyKey)).status).toBe('accepted');
    expect(server.requests).toHaveLength(1);
  });

  it('recovers a lost pool_lock without inventing a local lock or rewriting finance', async () => {
    const db = store();
    const server = new PlanningServer();
    await applyFinancialSnapshot(db, financialSnapshot());
    const apply = command();
    await preparePlanningCommand(db, apply);
    await executePlanningCommand(db, server, apply.idempotencyKey);
    const lock = lockCommand(server.snapshot.appliedPlans[0]!.id);
    await preparePlanningCommand(db, lock);
    server.loseAfterAccepting = true;
    await expect(executePlanningCommand(db, server, lock.idempotencyKey)).rejects.toThrow('Lost after');
    expect(await db.poolManifests.count()).toBe(0);
    expect((await db.planningCommands.get(lock.idempotencyKey))?.status).toBe('unknown');
    await recoverPlanningCommand(db, server, lock.idempotencyKey);
    expect(await db.poolManifests.count()).toBe(1);
    expect(await db.appliedPlans.count()).toBe(1);
    expect(await getFinancialSnapshot(db, GROUP)).toEqual(financialSnapshot());
    expect(server.requests).toHaveLength(2);
  });

  it.each(['conflict', 'rejected'] as const)('retains drafts and financial facts after %s', async status => {
    const db = store();
    const server = new PlanningServer();
    const draft = await saveDraft(db, { id: PROPOSAL, groupId: GROUP, kind: 'payment-proposal', data: { poolId: POOL, personId: PERSON, amountCents: '900', note: 'Outro recebimento.', status: 'pending' } });
    await applyFinancialSnapshot(db, financialSnapshot());
    const input = command();
    await preparePlanningCommand(db, input);
    if (status === 'conflict') server.snapshot.groupRevision += 1;
    else server.rejectNext = true;
    expect((await executePlanningCommand(db, server, input.idempotencyKey)).status).toBe(status);
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe(status);
    expect(await db.records.get(draft.id)).toEqual(draft);
    expect(await db.operations.count()).toBe(1);
    expect(await getFinancialSnapshot(db, GROUP)).toEqual(financialSnapshot());
    expect(await db.appliedPlans.count()).toBe(0);
  });

  it('does not regress later facts when recovering an older accepted receipt', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    server.loseAfterAccepting = true;
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow();
    server.snapshot.groupRevision = 7;
    server.snapshot.manifests.push(manifest(server.snapshot.appliedPlans[0]!));
    await applyPlanningSnapshot(db, server.snapshot);
    await recoverPlanningCommand(db, server, input.idempotencyKey);
    expect((await getPlanningSnapshot(db, GROUP))?.groupRevision).toBe(7);
    expect(await db.poolManifests.count()).toBe(1);
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('accepted');
  });

  it('rolls back facts, revision and receipt together if receipt storage fails', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    vi.spyOn(db.planningReceipts, 'put').mockRejectedValueOnce(new Error('Storage unavailable.'));
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow('Storage unavailable');
    expect(await getPlanningSnapshot(db, GROUP)).toBeNull();
    expect(await db.appliedPlans.count()).toBe(0);
    expect(await db.planningReceipts.count()).toBe(0);
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect((await recoverPlanningCommand(db, server, input.idempotencyKey))?.status).toBe('accepted');
    expect(await db.appliedPlans.count()).toBe(1);
    expect(server.requests).toHaveLength(1);
  });

  it('deduplicates simultaneous explicit invocations of the same key', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const decide = server.planningDecide.bind(server);
    const send = vi.spyOn(server, 'planningDecide').mockImplementation(async value => { await blocked; return decide(value); });
    const first = executePlanningCommand(db, server, input.idempotencyKey);
    const second = executePlanningCommand(db, server, input.idempotencyKey);
    release();
    expect(await first).toEqual(await second);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.appliedPlans.count()).toBe(1);
  });

  it('rejects receipts for another group and account without persisting facts', async () => {
    const db = store();
    const other = store('account-b', db.installationId);
    const input = command();
    await preparePlanningCommand(db, input);
    const wrong = new PlanningServer();
    vi.spyOn(wrong, 'planningDecide').mockResolvedValue({ apiVersion: 'v1', idempotencyKey: input.idempotencyKey, receiptId: null, groupId: OTHER_GROUP, groupRevision: 6, status: 'conflict', message: 'Other group.', confirmedAt: null, snapshot: emptyPlanningSnapshot(OTHER_GROUP, 6) });
    await expect(executePlanningCommand(db, wrong, input.idempotencyKey)).rejects.toThrow('grupo');
    await expect(recoverPlanningCommand(other, wrong, input.idempotencyKey)).rejects.toThrow('nesta conta');
    expect(await getPlanningSnapshot(db, OTHER_GROUP)).toBeNull();
    expect(await db.planningReceipts.count()).toBe(0);
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('unknown');
  });

  it('rejects an accepted receipt for a different candidate even with the right key and receipt UUID', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    const original = server.planningDecide.bind(server);
    vi.spyOn(server, 'planningDecide').mockImplementation(async request => {
      const receipt = await original(request);
      receipt.snapshot!.appliedPlans[0]!.plan = candidate(GROUP, 'cd'.repeat(32));
      return receipt;
    });
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow('exatamente o plano');
    expect(await db.appliedPlans.count()).toBe(0);
    expect(await db.planningReceipts.count()).toBe(0);
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('unknown');
  });

  it('pulls planning after finance and never automatically sends stored decisions', async () => {
    const db = store();
    const input = command();
    await preparePlanningCommand(db, input);
    const order: string[] = [];
    const server = new PlanningServer();
    const automaticSend = vi.spyOn(server, 'planningDecide');
    const transport: LocalSyncTransport = {
      listGroupIds: () => server.listGroupIds(), push: () => server.push(),
      pull: async (groupId, cursor) => { order.push('draft'); return server.pull(groupId, cursor); },
      financialPull: async () => { order.push('finance'); return financialSnapshot(); },
      planningPull: async () => { order.push('planning'); return server.planningPull(); },
    };
    await sync(db, transport);
    expect(order).toEqual(['draft', 'finance', 'planning']);
    expect(automaticSend).not.toHaveBeenCalled();
    expect((await db.planningCommands.get(input.idempotencyKey))?.status).toBe('prepared');
    expect((await getPlanningSnapshot(db, GROUP))?.groupRevision).toBe(5);
    expect(await getFinancialSnapshot(db, GROUP)).toEqual(financialSnapshot());
  });

  it('does not apply a planning pull returned for a different group', async () => {
    const db = store();
    const server = new PlanningServer();
    server.snapshot = emptyPlanningSnapshot(OTHER_GROUP);
    await expect(sync(db, server)).rejects.toThrow('outro grupo');
    expect(await getPlanningSnapshot(db, GROUP)).toBeNull();
    expect(await getPlanningSnapshot(db, OTHER_GROUP)).toBeNull();
  });

  it('exports immutable facts and an unknown approval with the exact original payload', async () => {
    const db = store();
    const server = new PlanningServer();
    const input = command();
    await preparePlanningCommand(db, input);
    server.loseBeforeAccepting = true;
    await expect(executePlanningCommand(db, server, input.idempotencyKey)).rejects.toThrow();
    await applyPlanningSnapshot(db, lockedSnapshot());
    const exported = JSON.parse(await exportEmergencySnapshot(db));
    expect(exported).toMatchObject({ format: 'bolao-emergency-v4', encrypted: false, accountId: db.accountId });
    expect(exported.appliedPlans).toHaveLength(1);
    expect(exported.poolManifests).toHaveLength(1);
    expect(exported.planningCommands[0]).toMatchObject({ command: input, status: 'unknown' });
    expect(exported.warning).toContain('não está criptografada');
  });
});
