import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeFinance } from '@bolao/core';
import type { FinancialCommand, FinancialReceipt, FinancialSnapshot, FinancialTransport, LocalRecord } from '@bolao/core';
import {
  applyFinancialSnapshot, createLocalStore, executeFinancialCommand, exportEmergencySnapshot,
  getFinancialSnapshot, prepareFinancialCommand, recoverFinancialCommand, saveDraft, sync,
} from '../src';
import type { BolaoDatabase, LocalSyncTransport, PersistentFinancialCommand, QueuedOperation } from '../src';

const id = (value: number) => `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const GROUP = id(1);
const OTHER_GROUP = id(2);
const PERSON = id(3);
const POOL = id(4);
const PROPOSAL = id(5);
const PAYMENT = id(6);
const RECEIVED_MOVEMENT = id(7);
const STATUTE = id(8);
const ACCEPTANCE = id(9);
const ALLOCATION = id(10);
const ALLOCATED_MOVEMENT = id(11);
const QUOTA = id(12);
const QUOTA_DRAFT = id(13);
const TIME = '2026-10-07T12:00:00.000Z';
const LATER = '2026-10-07T12:01:00.000Z';
const stores: Dexie[] = [];

function store(accountId = 'account-a', installationId = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}

function emptySnapshot(groupId = GROUP, groupRevision = 0): FinancialSnapshot {
  return { groupId, groupRevision, statutes: [], acceptances: [], payments: [], allocations: [], movements: [], quotas: [], revocations: [] };
}

function paymentSnapshot(groupRevision = 1, receiptId = id(100)): FinancialSnapshot {
  return {
    ...emptySnapshot(GROUP, groupRevision),
    payments: [{
      id: PAYMENT, groupId: GROUP, personId: PERSON, sourceProposalId: PROPOSAL,
      sourceProposalVersion: 1, amountCents: '2000', bankReference: 'bank-reference',
      declaredReceivedAt: null, confirmedAt: TIME, receiptId,
    }],
    movements: [{
      id: RECEIVED_MOVEMENT, groupId: GROUP, paymentId: PAYMENT, personId: PERSON, poolId: null,
      allocationId: null, kind: 'payment-received', amountCents: '2000', reason: '', createdAt: TIME, receiptId,
    }],
  };
}

function fullSnapshot(): FinancialSnapshot {
  const snapshot = paymentSnapshot(5);
  snapshot.statutes.push({ id: STATUTE, groupId: GROUP, version: 1, text: 'Direitos pagos integralmente.', sourceGroupVersion: 1, publishedAt: TIME, receiptId: id(101) });
  snapshot.acceptances.push({ id: ACCEPTANCE, groupId: GROUP, statuteId: STATUTE, personId: PERSON, evidence: 'Aceite informado pelo organizador.', acceptedAt: TIME, receiptId: id(102) });
  snapshot.allocations.push({ id: ALLOCATION, groupId: GROUP, paymentId: PAYMENT, personId: PERSON, poolId: POOL, amountCents: '1000', allocatedAt: TIME, receiptId: id(103) });
  snapshot.movements.push({ id: ALLOCATED_MOVEMENT, groupId: GROUP, paymentId: PAYMENT, personId: PERSON, poolId: POOL, allocationId: ALLOCATION, kind: 'payment-allocated', amountCents: '1000', reason: '', createdAt: TIME, receiptId: id(103) });
  snapshot.quotas.push({ id: QUOTA, groupId: GROUP, poolId: POOL, personId: PERSON, sourceQuotaId: QUOTA_DRAFT, sourceQuotaVersion: 1, units: 100, dueCents: '1000', statuteId: STATUTE, confirmedAt: TIME, receiptId: id(104) });
  return snapshot;
}

function reverseSnapshot(original: FinancialSnapshot): FinancialSnapshot {
  const snapshot = structuredClone(original);
  snapshot.groupRevision += 1;
  snapshot.movements.push({ id: id(20), groupId: GROUP, paymentId: PAYMENT, personId: PERSON, poolId: null, allocationId: null, kind: 'payment-reversed', amountCents: '-2000', reason: 'Pagamento duplicado.', createdAt: LATER, receiptId: id(105) });
  for (const allocation of snapshot.allocations) {
    snapshot.movements.push({ id: id(21), groupId: GROUP, paymentId: PAYMENT, personId: PERSON, poolId: allocation.poolId, allocationId: allocation.id, kind: 'allocation-reversed', amountCents: `-${allocation.amountCents}`, reason: 'Pagamento duplicado.', createdAt: LATER, receiptId: id(105) });
  }
  for (const quota of snapshot.quotas) {
    snapshot.revocations.push({ id: id(22), groupId: GROUP, quotaId: quota.id, reason: 'Pagamento estornado.', revokedAt: LATER, receiptId: id(105) });
  }
  return snapshot;
}

function command(key = crypto.randomUUID(), expectedRevision = 0): FinancialCommand {
  return {
    apiVersion: 'v1', idempotencyKey: key, groupId: GROUP, expectedRevision,
    action: { type: 'payment_confirm', proposalId: PROPOSAL, proposalVersion: 1, bankReference: 'bank-reference', declaredReceivedAt: null, allocations: [] },
  };
}

class FinancialServer implements FinancialTransport, LocalSyncTransport {
  snapshot = emptySnapshot();
  readonly receipts = new Map<string, FinancialReceipt>();
  readonly requests: FinancialCommand[] = [];
  readonly draftRequests: unknown[] = [];
  readonly payloads = new Map<string, string>();
  statusCalls = 0;
  loseAfterAccepting = false;
  loseBeforeAccepting = false;
  rejectNext = false;
  return404 = false;

  async listGroupIds() { return [GROUP]; }
  async push(operations: unknown[]) { this.draftRequests.push(...operations); return []; }
  async pull(groupId: string, cursor: number) { return { groupId, changes: [], nextCursor: cursor, hasMore: false }; }
  async financialPull() { return structuredClone(this.snapshot); }
  async financialCommandStatus(key: string) {
    this.statusCalls += 1;
    if (this.return404) throw Object.assign(new Error('Receipt not found.'), { status: 404 });
    return structuredClone(this.receipts.get(key) ?? null);
  }
  async reviewDecide(input: FinancialCommand): Promise<FinancialReceipt> {
    this.requests.push(structuredClone(input));
    const payload = JSON.stringify(input);
    const previous = this.payloads.get(input.idempotencyKey);
    if (previous && previous !== payload) throw new Error('The idempotent decision payload changed.');
    this.payloads.set(input.idempotencyKey, payload);
    if (this.loseBeforeAccepting) { this.loseBeforeAccepting = false; throw new Error('Lost before processing.'); }
    const existing = this.receipts.get(input.idempotencyKey);
    if (existing) return structuredClone(existing);
    let receipt: FinancialReceipt;
    if (this.rejectNext) {
      this.rejectNext = false;
      receipt = { apiVersion: 'v1', idempotencyKey: input.idempotencyKey, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'rejected', message: 'Revise a origem do pagamento.', confirmedAt: null, snapshot: null };
    } else if (input.expectedRevision !== this.snapshot.groupRevision) {
      receipt = { apiVersion: 'v1', idempotencyKey: input.idempotencyKey, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'conflict', message: 'O grupo mudou desde a aprovação.', confirmedAt: null, snapshot: structuredClone(this.snapshot) };
    } else {
      this.snapshot = paymentSnapshot(this.snapshot.groupRevision + 1, input.idempotencyKey);
      receipt = { apiVersion: 'v1', idempotencyKey: input.idempotencyKey, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'accepted', message: null, confirmedAt: TIME, snapshot: structuredClone(this.snapshot) };
    }
    this.receipts.set(input.idempotencyKey, structuredClone(receipt));
    if (this.loseAfterAccepting) { this.loseAfterAccepting = false; throw new Error('Lost after accepting.'); }
    return receipt;
  }
}

async function pendingProposal(db: BolaoDatabase) {
  return saveDraft(db, { id: PROPOSAL, groupId: GROUP, kind: 'payment-proposal', data: { poolId: POOL, personId: PERSON, amountCents: '2000', note: 'Para confirmar online.', status: 'pending' } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

describe('v2 migration and immutable financial snapshots', () => {
  it('adds financial tables without changing a v1 draft, outbox, cursor or legacy cash', async () => {
    const db = store();
    const legacy = new Dexie(db.name);
    stores.push(legacy);
    legacy.version(1).stores({
      records: '&id, groupId, kind, state, [kind+groupId]', operations: '&idempotencyKey, entityId, groupId, sequence, status, dependsOn',
      receipts: '&idempotencyKey, entityId, status', cursors: '&groupId', confirmedPayments: '&id, groupId, poolId, personId, receiptId', metadata: '&key', serverRecords: '&id, groupId, kind',
    });
    const record: LocalRecord<'person'> = { id: PERSON, groupId: GROUP, kind: 'person', data: { name: 'Ana', nickname: '', adultDeclared: true }, localVersion: 1, serverVersion: 0, state: 'queued', createdAt: TIME, updatedAt: TIME };
    const operation: QueuedOperation = { apiVersion: 'v1', idempotencyKey: id(30), entityId: PERSON, groupId: GROUP, kind: 'person', expectedVersion: 0, data: record.data, createdAt: TIME, localVersion: 1, sequence: 1, status: 'in-flight', dependsOn: null, attempts: 1, lastAttemptAt: TIME, message: null };
    await legacy.table('records').add(record);
    await legacy.table('operations').add(operation);
    await legacy.table('cursors').put({ groupId: GROUP, cursor: 7 });
    await legacy.table('metadata').put({ key: 'outboxSequence', value: 1 });
    await legacy.table('confirmedPayments').put({ id: id(31), groupId: GROUP, poolId: POOL, personId: PERSON, amountCents: '1200', confirmedAt: TIME, receiptId: id(32) });
    legacy.close();
    expect(await db.records.get(PERSON)).toEqual(record);
    expect(await db.operations.get(id(30))).toEqual(operation);
    expect(await db.cursors.get(GROUP)).toEqual({ groupId: GROUP, cursor: 7 });
    expect(await db.metadata.get('outboxSequence')).toEqual({ key: 'outboxSequence', value: 1 });
    expect(await db.confirmedPayments.count()).toBe(1);
    expect(await db.receivedPayments.count()).toBe(0);
    expect(await db.financialCommands.count()).toBe(0);
    expect(db.verno).toBe(4);
  });

  it('stores the complete immutable ledger including quota revocations and preserves drafts', async () => {
    const db = store();
    const draft = await pendingProposal(db);
    const snapshot = reverseSnapshot(fullSnapshot());
    await applyFinancialSnapshot(db, snapshot);
    const restored = await getFinancialSnapshot(db, GROUP);
    expect(restored).toMatchObject({ groupRevision: 6, payments: snapshot.payments, quotas: snapshot.quotas, revocations: snapshot.revocations });
    expect(restored?.movements).toHaveLength(4);
    expect(computeFinance(restored!)).toMatchObject({ cashCents: '0', allocatedCents: '0', unallocatedCents: '0' });
    expect(await db.records.get(PROPOSAL)).toEqual(draft);
    expect(await db.operations.count()).toBe(1);
    expect(await db.confirmedPayments.count()).toBe(0);
  });

  it('ignores an older complete snapshot without losing later reversal facts or revision', async () => {
    const db = store();
    const first = fullSnapshot();
    const latest = reverseSnapshot(first);
    await applyFinancialSnapshot(db, latest);
    await applyFinancialSnapshot(db, first);
    expect((await getFinancialSnapshot(db, GROUP))?.groupRevision).toBe(6);
    expect(await db.financialMovements.count()).toBe(4);
    expect(await db.quotaRevocations.count()).toBe(1);
  });

  it('rejects changed immutable facts and incomplete newer snapshots atomically', async () => {
    const db = store();
    const original = fullSnapshot();
    await applyFinancialSnapshot(db, original);
    const changed = structuredClone(original);
    changed.groupRevision += 1;
    changed.statutes[0]!.text = 'Estatuto alterado silenciosamente.';
    await expect(applyFinancialSnapshot(db, changed)).rejects.toThrow('fato financeiro confirmado');
    await expect(applyFinancialSnapshot(db, emptySnapshot(GROUP, 6))).rejects.toThrow('não podem ser removidos');
    expect(await db.statutes.get(STATUTE)).toEqual(original.statutes[0]);
    expect((await getFinancialSnapshot(db, GROUP))?.groupRevision).toBe(5);
  });

  it('rejects malicious cross-group rows and globally reused fact IDs', async () => {
    const db = store();
    const original = fullSnapshot();
    await applyFinancialSnapshot(db, original);
    const mixed = structuredClone(original);
    mixed.groupRevision += 1;
    mixed.payments[0]!.groupId = OTHER_GROUP;
    await expect(applyFinancialSnapshot(db, mixed)).rejects.toThrow('grupos diferentes');
    const reused = structuredClone(original);
    reused.groupId = OTHER_GROUP;
    for (const rows of [reused.statutes, reused.acceptances, reused.payments, reused.allocations, reused.movements, reused.quotas, reused.revocations]) {
      for (const row of rows) row.groupId = OTHER_GROUP;
    }
    await expect(applyFinancialSnapshot(db, reused)).rejects.toThrow('fato financeiro confirmado');
    expect(await getFinancialSnapshot(db, OTHER_GROUP)).toBeNull();
    expect((await getFinancialSnapshot(db, GROUP))?.groupRevision).toBe(5);
  });

  it('requires a new complete revision for new facts and isolates accounts', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const other = store('account-b', installationId);
    const demo = store('demo', installationId);
    await applyFinancialSnapshot(db, emptySnapshot(GROUP, 1));
    await expect(applyFinancialSnapshot(db, paymentSnapshot(1))).rejects.toThrow('revisão financeira não avançou');
    expect(await getFinancialSnapshot(other, GROUP)).toBeNull();
    expect(await getFinancialSnapshot(demo, GROUP)).toBeNull();
    expect(await db.receivedPayments.count()).toBe(0);
  });
});

describe('explicit human financial decisions', () => {
  it('prepares offline idempotently without granting cash or quota rights', async () => {
    const db = store();
    vi.stubGlobal('navigator', { onLine: false });
    const input = command();
    const prepared = await prepareFinancialCommand(db, input);
    expect(prepared).toMatchObject({ idempotencyKey: input.idempotencyKey, command: input, status: 'prepared' });
    expect(await prepareFinancialCommand(db, structuredClone(input))).toEqual(prepared);
    await expect(prepareFinancialCommand(db, { ...input, expectedRevision: 1 })).rejects.toThrow('outra decisão financeira');
    expect(await db.financialCommands.count()).toBe(1);
    expect(await db.operations.count()).toBe(0);
    expect(await db.receivedPayments.count()).toBe(0);
    expect(await db.confirmedQuotas.count()).toBe(0);
  });

  it('refuses offline approval without sending or changing the prepared state', async () => {
    const db = store();
    const input = command();
    const server = new FinancialServer();
    await prepareFinancialCommand(db, input);
    vi.stubGlobal('navigator', { onLine: false });
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow('Conecte-se');
    expect(server.requests).toHaveLength(0);
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('prepared');
    expect(await db.receivedPayments.count()).toBe(0);
  });

  it('requires an online human invocation even when a decision already has a cached receipt', async () => {
    const db = store();
    const input = command();
    const server = new FinancialServer();
    await prepareFinancialCommand(db, input);
    await executeFinancialCommand(db, server, input.idempotencyKey);
    vi.stubGlobal('navigator', { onLine: false });
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow('Conecte-se');
    expect(server.requests).toHaveLength(1);
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('accepted');
    expect(await db.receivedPayments.count()).toBe(1);
  });

  it('keeps a lost response unknown across reopening and recovers solely by status lookup', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const proposal = await pendingProposal(db);
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    server.loseAfterAccepting = true;
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow('Lost after accepting');
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect(await db.receivedPayments.count()).toBe(0);
    expect(await db.financialReceipts.count()).toBe(0);
    expect(await db.records.get(PROPOSAL)).toEqual(proposal);
    db.close();
    const reopened = store('account-a', installationId);
    expect((await recoverFinancialCommand(reopened, server, input.idempotencyKey))?.status).toBe('accepted');
    expect(server.requests).toHaveLength(1);
    expect(server.statusCalls).toBe(1);
    expect(await reopened.receivedPayments.count()).toBe(1);
    expect(await reopened.financialReceipts.count()).toBe(1);
    expect((await reopened.financialCommands.get(input.idempotencyKey))?.status).toBe('accepted');
    expect(await reopened.operations.count()).toBe(1);
  });

  it('retains unknown after a missing receipt, never auto-retries, and explicitly retries the identical decision', async () => {
    const db = store();
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    server.loseBeforeAccepting = true;
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow('Lost before processing');
    expect(await recoverFinancialCommand(db, server, input.idempotencyKey)).toBeNull();
    await sync(db, server);
    expect(server.requests).toHaveLength(1);
    expect(server.draftRequests).toHaveLength(0);
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect(await db.receivedPayments.count()).toBe(0);
    expect((await executeFinancialCommand(db, server, input.idempotencyKey)).status).toBe('accepted');
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toEqual(server.requests[1]);
    await executeFinancialCommand(db, server, input.idempotencyKey);
    expect(server.requests).toHaveLength(2);
    expect(await db.receivedPayments.count()).toBe(1);
  });

  it('treats an HTTP 404 status response as unknown and preserves the approved payload', async () => {
    const db = store();
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    server.return404 = true;
    expect(await recoverFinancialCommand(db, server, input.idempotencyKey)).toBeNull();
    expect(await db.financialCommands.get(input.idempotencyKey)).toMatchObject({ status: 'unknown', command: input });
    expect(server.requests).toHaveLength(0);
  });

  it('preserves proposals on conflict or rejection without locally confirming money', async () => {
    const db = store();
    const proposal = await pendingProposal(db);
    const server = new FinancialServer();
    server.snapshot = emptySnapshot(GROUP, 3);
    const conflicting = command();
    await prepareFinancialCommand(db, conflicting);
    expect((await executeFinancialCommand(db, server, conflicting.idempotencyKey)).status).toBe('conflict');
    expect((await db.financialCommands.get(conflicting.idempotencyKey))?.status).toBe('conflict');
    expect((await getFinancialSnapshot(db, GROUP))?.groupRevision).toBe(3);
    const rejected = command(crypto.randomUUID(), 3);
    await prepareFinancialCommand(db, rejected);
    server.rejectNext = true;
    expect((await executeFinancialCommand(db, server, rejected.idempotencyKey)).status).toBe('rejected');
    expect(await db.records.get(PROPOSAL)).toEqual(proposal);
    expect(await db.operations.count()).toBe(1);
    expect(await db.receivedPayments.count()).toBe(0);
  });

  it('keeps later facts when recovering an older accepted receipt', async () => {
    const db = store();
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    server.loseAfterAccepting = true;
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow();
    await applyFinancialSnapshot(db, reverseSnapshot(server.snapshot));
    expect((await recoverFinancialCommand(db, server, input.idempotencyKey))?.groupRevision).toBe(1);
    const latest = await getFinancialSnapshot(db, GROUP);
    expect(latest?.groupRevision).toBe(2);
    expect(latest?.movements).toHaveLength(2);
    expect(computeFinance(latest!).cashCents).toBe('0');
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('accepted');
  });

  it('commits the receipt and accepted facts atomically and retains unknown on a local write failure', async () => {
    const db = store();
    const server = new FinancialServer();
    await applyFinancialSnapshot(db, emptySnapshot());
    const input = command();
    await prepareFinancialCommand(db, input);
    db.financialReceipts.hook('creating', () => { throw new Error('Storage full.'); });
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow('Storage full');
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect((await getFinancialSnapshot(db, GROUP))?.groupRevision).toBe(0);
    expect(await db.receivedPayments.count()).toBe(0);
    expect(await db.financialMovements.count()).toBe(0);
    expect(await db.financialReceipts.count()).toBe(0);
  });

  it('cannot execute or recover another account’s stored decision', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const other = store('account-b', installationId);
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    await expect(executeFinancialCommand(other, server, input.idempotencyKey)).rejects.toThrow('Prepare a decisão');
    await expect(recoverFinancialCommand(other, server, input.idempotencyKey)).rejects.toThrow('não está salva nesta conta');
    expect(server.requests).toHaveLength(0);
    expect(server.statusCalls).toBe(0);
  });

  it('rejects an accepted receipt belonging to another group without confirming any facts', async () => {
    const db = store();
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    vi.spyOn(server, 'reviewDecide').mockResolvedValue({
      apiVersion: 'v1', idempotencyKey: input.idempotencyKey, groupId: OTHER_GROUP,
      status: 'accepted', groupRevision: 1, message: null, confirmedAt: TIME,
      snapshot: emptySnapshot(OTHER_GROUP, 1),
    });
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow('não corresponde');
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('unknown');
    expect(await db.financialReceipts.count()).toBe(0);
    expect(await getFinancialSnapshot(db, GROUP)).toBeNull();
    expect(await getFinancialSnapshot(db, OTHER_GROUP)).toBeNull();
  });

  it('shares one explicit approval between overlapping calls in two database instances', async () => {
    const installationId = crypto.randomUUID();
    const db = store('account-a', installationId);
    const otherTab = store('account-a', installationId);
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    let release!: () => void;
    let enter!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const original = server.reviewDecide.bind(server);
    vi.spyOn(server, 'reviewDecide').mockImplementation(async prepared => {
      enter();
      await waiting;
      return original(prepared);
    });
    const first = executeFinancialCommand(db, server, input.idempotencyKey);
    await entered;
    const second = executeFinancialCommand(otherTab, server, input.idempotencyKey);
    expect(first).toBe(second);
    release();
    await Promise.all([first, second]);
    expect(server.requests).toHaveLength(1);
    expect((await otherTab.financialCommands.get(input.idempotencyKey))?.status).toBe('accepted');
  });
});

describe('financial replication and emergency export', () => {
  it('sync reads confirmed snapshots but never sends prepared financial commands', async () => {
    const db = store();
    const server = new FinancialServer();
    server.snapshot = fullSnapshot();
    const input = command(crypto.randomUUID(), 5);
    await prepareFinancialCommand(db, input);
    await sync(db, server);
    expect((await getFinancialSnapshot(db, GROUP))?.groupRevision).toBe(5);
    expect(server.requests).toHaveLength(0);
    expect(server.draftRequests).toHaveLength(0);
    expect((await db.financialCommands.get(input.idempotencyKey))?.status).toBe('prepared');
  });

  it('rejects a financial pull from another group before persisting any facts', async () => {
    const db = store();
    const server = new FinancialServer();
    server.snapshot = emptySnapshot(OTHER_GROUP, 1);
    await expect(sync(db, server)).rejects.toThrow('outro grupo');
    expect(await getFinancialSnapshot(db, OTHER_GROUP)).toBeNull();
    expect(await getFinancialSnapshot(db, GROUP)).toBeNull();
  });

  it('exports v2 financial facts and unknown commands without losing their keys', async () => {
    const db = store();
    const server = new FinancialServer();
    const input = command();
    await prepareFinancialCommand(db, input);
    server.loseBeforeAccepting = true;
    await expect(executeFinancialCommand(db, server, input.idempotencyKey)).rejects.toThrow();
    const json = JSON.parse(await exportEmergencySnapshot(db)) as { format: string; financialCommands: PersistentFinancialCommand[]; receivedPayments: unknown[]; financialSnapshots: unknown[]; financialReceipts: unknown[] };
    expect(json.format).toBe('bolao-emergency-v4');
    expect(json.financialCommands[0]).toMatchObject({ idempotencyKey: input.idempotencyKey, status: 'unknown', command: input });
    expect(json.receivedPayments).toEqual([]);
    expect(json.financialSnapshots).toEqual([]);
    expect(json.financialReceipts).toEqual([]);
  });
});
