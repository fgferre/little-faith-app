import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, currentResult, sha256Hex } from '@bolao/core';
import type { ResultCommand, ResultReceipt, ResultTransport } from '@bolao/core';
import {
  applyFinancialSnapshot, applyPlanningSnapshot, applyResultSnapshot, collectResults, createLocalStore,
  executeResultCommand, exportEmergencySnapshot, getFinancialSnapshot, getPlanningSnapshot, getResultSnapshot,
  prepareResultCommand, recoverResultCommand, saveDraft, sync,
} from '../src';
import type { BolaoDatabase, LocalSyncTransport } from '../src';
import { financialSnapshot, GROUP, id, lockedSnapshot, OTHER_GROUP, POOL } from './planning-fixtures';
import { calendarCommand, DECIDED_AT, emptyResultSnapshot, manualCalendar, manualCommand, manualResult, officialResult } from './result-fixtures';

const stores: Dexie[] = [];
function store(accountId = id(200), installationId: string = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}

class ResultServer implements ResultTransport, LocalSyncTransport {
  snapshot = emptyResultSnapshot();
  readonly receipts = new Map<string, ResultReceipt>();
  readonly payloads = new Map<string, string>();
  readonly requests: ResultCommand[] = [];
  statusCalls = 0;
  collectCalls = 0;
  loseAfterAccepting = false;
  loseBeforeAccepting = false;
  return404 = false;
  rejectNext = false;
  collectionError: Error | null = null;
  async listGroupIds() { return [GROUP]; }
  async push() { return []; }
  async pull(groupId: string) { return { groupId, changes: [], nextCursor: this.snapshot.groupRevision, hasMore: false }; }
  async resultsPull() { return structuredClone(this.snapshot); }
  async resultsCollect(groupId: string, poolId: string) {
    expect(groupId).toBe(GROUP); expect(poolId).toBe(POOL);
    this.collectCalls += 1;
    if (this.collectionError) throw this.collectionError;
    return structuredClone(this.snapshot);
  }
  async resultCommandStatus(key: string) {
    this.statusCalls += 1;
    if (this.return404) throw Object.assign(new Error('Decisão ausente.'), { status: 404 });
    return structuredClone(this.receipts.get(key) ?? null);
  }
  async resultDecide(command: ResultCommand): Promise<ResultReceipt> {
    this.requests.push(structuredClone(command));
    const payload = canonicalJSON(command);
    if (this.payloads.has(command.idempotencyKey) && this.payloads.get(command.idempotencyKey) !== payload) throw new Error('Decisão idempotente foi alterada.');
    this.payloads.set(command.idempotencyKey, payload);
    if (this.loseBeforeAccepting) { this.loseBeforeAccepting = false; throw new Error('Resposta perdida antes de confirmar.'); }
    const previous = this.receipts.get(command.idempotencyKey);
    if (previous) return structuredClone(previous);
    let receipt: ResultReceipt;
    if (this.rejectNext || command.expectedRevision !== this.snapshot.groupRevision) {
      receipt = { apiVersion: 'v1', idempotencyKey: command.idempotencyKey, receiptId: null, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: this.rejectNext ? 'rejected' : 'conflict', message: 'Revise as fontes e a versão original.', confirmedAt: null, snapshot: structuredClone(this.snapshot) };
      this.rejectNext = false;
    } else {
      const receiptId = crypto.randomUUID();
      const action = command.action;
      if (action.type === 'result_manual') this.snapshot.results.push(manualResult(command, this.snapshot.results.length + 1, receiptId));
      else if (action.type === 'calendar_confirm') this.snapshot.calendarVersions.push(manualCalendar(command, this.snapshot.calendarVersions.length + 1, receiptId));
      else this.snapshot.selections.push({ id: id(800 + this.snapshot.selections.length), groupId: GROUP, poolId: action.poolId, version: this.snapshot.selections.length + 1, resultId: action.resultId, observedResultIds: action.observedResultIds, reason: action.reason, selectedAt: DECIDED_AT, receiptId });
      this.snapshot.groupRevision += 1;
      receipt = { apiVersion: 'v1', idempotencyKey: command.idempotencyKey, receiptId, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'accepted', message: null, confirmedAt: DECIDED_AT, snapshot: structuredClone(this.snapshot) };
    }
    this.receipts.set(command.idempotencyKey, receipt);
    if (this.loseAfterAccepting) { this.loseAfterAccepting = false; throw new Error('Resposta perdida depois de confirmar.'); }
    return structuredClone(receipt);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

describe('immutable collected results and calendars', () => {
  it('preserves original source/hash, pending payouts and every version without touching finances or drafts', async () => {
    const db = store();
    const draft = await saveDraft(db, { groupId: GROUP, kind: 'person', data: { name: 'Nome preparado', nickname: '', adultDeclared: true } });
    await applyFinancialSnapshot(db, financialSnapshot());
    await applyPlanningSnapshot(db, lockedSnapshot());
    const first = { ...emptyResultSnapshot(11), results: [officialResult()] };
    await applyResultSnapshot(db, first);
    db.close();
    const reopened = store(db.accountId, db.installationId);
    const second = { ...emptyResultSnapshot(12), results: [first.results[0]!, officialResult(2, [1, 2, 3, 4, 5, 6], true)] };
    await applyResultSnapshot(reopened, second);
    expect((await getResultSnapshot(reopened, GROUP))?.results.map(result => result.rawText)).toEqual(second.results.map(result => result.rawText));
    expect(first.results[0]!.payouts).toBeNull();
    expect(currentResult((await getResultSnapshot(reopened, GROUP))!, POOL).status).toBe('complete');
    expect(await reopened.records.get(draft.id)).toEqual(draft);
    expect(await reopened.operations.count()).toBe(1);
    expect(await getFinancialSnapshot(reopened, GROUP)).toEqual(financialSnapshot());
    expect(await getPlanningSnapshot(reopened, GROUP)).toEqual(lockedSnapshot());
  });

  it('does not infer zero or erase a complete version after a later waiting response', async () => {
    const db = store();
    const complete = officialResult(1, [1, 2, 3, 4, 5, 6], true);
    const waiting = officialResult(2, null);
    await applyResultSnapshot(db, { ...emptyResultSnapshot(12), results: [complete, waiting] });
    const cached = (await getResultSnapshot(db, GROUP))!;
    expect(cached.results).toHaveLength(2);
    expect(waiting.drawnNumbers).toBeNull();
    expect(waiting.payouts).toBeNull();
    expect(currentResult(cached, POOL).result?.id).toBe(complete.id);
  });

  it('preserves incompatible official/manual versions as a conflict without choosing one locally', async () => {
    const db = store();
    const snapshot = { ...emptyResultSnapshot(12), results: [officialResult(), manualResult(manualCommand(), 2)] };
    await applyResultSnapshot(db, snapshot);
    const cached = (await getResultSnapshot(db, GROUP))!;
    expect(currentResult(cached, POOL).status).toBe('conflict');
    expect(currentResult(cached, POOL).conflictingResultIds).toHaveLength(2);
    expect(cached.selections).toEqual([]);
  });

  it('rejects changed/deleted facts and invalid source/hash while keeping the last valid snapshot', async () => {
    const db = store();
    const first = { ...emptyResultSnapshot(11), results: [officialResult()] };
    await applyResultSnapshot(db, first);
    const changed = { ...emptyResultSnapshot(12), results: [{ ...first.results[0]!, sourceReference: 'Histórico reescrito.' }] };
    await expect(applyResultSnapshot(db, changed)).rejects.toThrow('alterar um resultado');
    await expect(applyResultSnapshot(db, emptyResultSnapshot(12))).rejects.toThrow('não podem ser removidas');
    const wrongHash = { ...emptyResultSnapshot(12), results: [first.results[0]!, { ...officialResult(2), sha256: '1'.repeat(64) }] };
    await expect(applyResultSnapshot(db, wrongHash)).rejects.toThrow();
    const badSource = { ...emptyResultSnapshot(12), results: [first.results[0]!, { ...officialResult(2), rawText: '{formato alterado', sha256: sha256Hex('{formato alterado') }] };
    await expect(applyResultSnapshot(db, badSource)).rejects.toThrow();
    expect(await getResultSnapshot(db, GROUP)).toEqual(first);
  });

  it('ignores old snapshots but refuses new versions without an advanced revision', async () => {
    const db = store();
    const first = { ...emptyResultSnapshot(11), results: [officialResult()] };
    const second = { ...emptyResultSnapshot(12), results: [first.results[0]!, officialResult(2, [1, 2, 3, 4, 5, 6], true)] };
    await applyResultSnapshot(db, first);
    await expect(applyResultSnapshot(db, { ...second, groupRevision: 11 })).rejects.toThrow('não avançou');
    await applyResultSnapshot(db, second);
    await applyResultSnapshot(db, first);
    expect(await getResultSnapshot(db, GROUP)).toEqual(second);
  });

  it('keeps result data isolated by account/demo and rejects cross-group reuse of fact ids', async () => {
    const db = store();
    const other = store(id(201), db.installationId);
    const demo = store('demo', db.installationId);
    const snapshot = { ...emptyResultSnapshot(11), results: [officialResult()] };
    await applyResultSnapshot(db, snapshot);
    expect(await getResultSnapshot(other, GROUP)).toBeNull();
    expect(await getResultSnapshot(demo, GROUP)).toBeNull();
    const foreign = { ...emptyResultSnapshot(1, OTHER_GROUP), results: [{ ...officialResult(), groupId: OTHER_GROUP }] };
    await expect(applyResultSnapshot(db, foreign)).rejects.toThrow('alterar um resultado');
    expect(await getResultSnapshot(db, OTHER_GROUP)).toBeNull();
  });

  it('rolls back immutable rows and revision together if storing the snapshot fails', async () => {
    const db = store();
    vi.spyOn(db.resultSnapshots, 'put').mockRejectedValueOnce(new Error('Espaço local insuficiente.'));
    await expect(applyResultSnapshot(db, { ...emptyResultSnapshot(11), results: [officialResult()], calendarVersions: [manualCalendar()] })).rejects.toThrow('insuficiente');
    expect(await db.contestResults.count()).toBe(0);
    expect(await db.contestCalendars.count()).toBe(0);
    expect(await getResultSnapshot(db, GROUP)).toBeNull();
  });
});

describe('technical result collection without approval', () => {
  it('records fetch failures separately without erasing the last valid result or sending saved decisions', async () => {
    const db = store();
    const server = new ResultServer();
    server.snapshot = { ...emptyResultSnapshot(11), results: [officialResult()] };
    const first = await collectResults(db, server, GROUP, POOL);
    const command = manualCommand();
    await prepareResultCommand(db, command);
    server.collectionError = new Error('Serviço de resultados indisponível.');
    await expect(collectResults(db, server, GROUP, POOL)).rejects.toThrow('indisponível');
    expect(await getResultSnapshot(db, GROUP)).toEqual(first);
    expect(await db.resultCollectionAttempts.where('status').equals('failed').count()).toBe(1);
    expect(await db.resultCollectionAttempts.where('status').equals('succeeded').count()).toBe(1);
    expect(server.requests).toHaveLength(0);
    expect((await db.resultCommands.get(command.idempotencyKey))?.status).toBe('prepared');
  });

  it('records invalid/hash/cross-group collections as failures without damaging valid data', async () => {
    const db = store();
    const server = new ResultServer();
    server.snapshot = { ...emptyResultSnapshot(11), results: [officialResult()] };
    const first = await collectResults(db, server, GROUP, POOL);
    server.snapshot = { ...emptyResultSnapshot(12), results: [officialResult(), { ...officialResult(2), sha256: 'f'.repeat(64) }] };
    await expect(collectResults(db, server, GROUP, POOL)).rejects.toThrow();
    server.snapshot = emptyResultSnapshot(0, OTHER_GROUP);
    await expect(collectResults(db, server, GROUP, POOL)).rejects.toThrow('outro grupo');
    expect(await getResultSnapshot(db, GROUP)).toEqual(first);
    expect(await getResultSnapshot(db, OTHER_GROUP)).toBeNull();
    expect(await db.resultCollectionAttempts.where('status').equals('failed').count()).toBe(2);
  });

  it('prohibits offline collection and deduplicates simultaneous technical calls', async () => {
    const db = store();
    const server = new ResultServer();
    vi.stubGlobal('navigator', { onLine: false });
    await expect(collectResults(db, server, GROUP, POOL)).rejects.toThrow('internet');
    expect(server.collectCalls).toBe(0);
    expect(await db.resultCollectionAttempts.count()).toBe(0);
    vi.unstubAllGlobals();
    await Promise.all([collectResults(db, server, GROUP, POOL), collectResults(db, server, GROUP, POOL)]);
    expect(server.collectCalls).toBe(1);
  });

  it('returns the newer local revision when a delayed valid collection is older', async () => {
    const db = store();
    const server = new ResultServer();
    server.snapshot = { ...emptyResultSnapshot(11), results: [officialResult()] };
    const newer = { ...emptyResultSnapshot(12), results: [officialResult(), officialResult(2, [1, 2, 3, 4, 5, 6], true)] };
    await applyResultSnapshot(db, newer);
    expect(await collectResults(db, server, GROUP, POOL)).toEqual(newer);
  });
});

describe('manual results, conflict choices and calendar decisions', () => {
  it('prepares offline with immutable key/payload and refuses offline confirmation', async () => {
    const db = store();
    const server = new ResultServer();
    const command = manualCommand();
    vi.stubGlobal('navigator', { onLine: false });
    const prepared = await prepareResultCommand(db, command);
    expect(await prepareResultCommand(db, command)).toEqual(prepared);
    await expect(prepareResultCommand(db, { ...command, action: { ...command.action, reason: 'Outro motivo' } })).rejects.toThrow('outra decisão');
    await expect(executeResultCommand(db, server, command.idempotencyKey)).rejects.toThrow('internet');
    expect(server.requests).toHaveLength(0);
    expect(await db.contestResults.count()).toBe(0);
    expect(await db.operations.count()).toBe(0);
  });

  it('recovers lost manual and calendar replies after reopen by GET without resending', async () => {
    for (const command of [manualCommand(), calendarCommand()]) {
      const db = store();
      const server = new ResultServer();
      await prepareResultCommand(db, command);
      server.loseAfterAccepting = true;
      await expect(executeResultCommand(db, server, command.idempotencyKey)).rejects.toThrow('depois');
      expect((await db.resultCommands.get(command.idempotencyKey))?.status).toBe('unknown');
      expect(await db.contestResults.count()).toBe(0);
      expect(await db.contestCalendars.count()).toBe(0);
      db.close();
      const reopened = store(db.accountId, db.installationId);
      expect((await recoverResultCommand(reopened, server, command.idempotencyKey))?.status).toBe('accepted');
      expect(server.requests).toHaveLength(1);
      expect(server.statusCalls).toBe(1);
      expect((await reopened.resultCommands.get(command.idempotencyKey))?.command).toEqual(command);
      await executeResultCommand(reopened, server, command.idempotencyKey);
      expect(server.requests).toHaveLength(1);
    }
  });

  it('keeps absent decisions unknown until a new explicit same-payload execution', async () => {
    const db = store();
    const server = new ResultServer();
    const command = manualCommand();
    await prepareResultCommand(db, command);
    server.loseBeforeAccepting = true;
    await expect(executeResultCommand(db, server, command.idempotencyKey)).rejects.toThrow('antes');
    server.return404 = true;
    expect(await recoverResultCommand(db, server, command.idempotencyKey)).toBeNull();
    expect((await db.resultCommands.get(command.idempotencyKey))?.status).toBe('unknown');
    expect(server.requests).toHaveLength(1);
    server.return404 = false;
    await executeResultCommand(db, server, command.idempotencyKey);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toEqual(server.requests[1]);
  });

  it('preserves proposed manual values and reasons for conflicts and rejections', async () => {
    for (const status of ['conflict', 'rejected'] as const) {
      const db = store();
      const server = new ResultServer();
      const command = manualCommand(crypto.randomUUID(), status === 'conflict' ? 9 : 10);
      await prepareResultCommand(db, command);
      server.rejectNext = status === 'rejected';
      expect((await executeResultCommand(db, server, command.idempotencyKey)).status).toBe(status);
      expect((await db.resultCommands.get(command.idempotencyKey))?.command).toEqual(command);
      expect(await db.contestResults.count()).toBe(0);
    }
  });

  it('rejects an accepted manual/calendar fact with changed human justification', async () => {
    for (const command of [manualCommand(), calendarCommand()]) {
      const db = store();
      const server = new ResultServer();
      await prepareResultCommand(db, command);
      vi.spyOn(server, 'resultDecide').mockImplementation(input => ResultServer.prototype.resultDecide.call(server, { ...input, action: { ...input.action, reason: 'Outra decisão humana.' } }));
      await expect(executeResultCommand(db, server, command.idempotencyKey)).rejects.toThrow('exatamente');
      expect((await db.resultCommands.get(command.idempotencyKey))?.status).toBe('unknown');
      expect(await db.contestResults.count()).toBe(0);
      expect(await db.contestCalendars.count()).toBe(0);
    }
  });

  it('accepts the original manual action despite harmless raw JSON whitespace while preserving its hash', async () => {
    const db = store();
    const server = new ResultServer();
    const command = manualCommand();
    await prepareResultCommand(db, command);
    vi.spyOn(server, 'resultDecide').mockImplementation(async input => {
      const receipt = await ResultServer.prototype.resultDecide.call(server, input);
      const fact = receipt.snapshot!.results[0]!;
      fact.rawText = JSON.stringify(input.action, null, 2);
      fact.sha256 = sha256Hex(fact.rawText);
      return receipt;
    });
    const receipt = await executeResultCommand(db, server, command.idempotencyKey);
    expect((await getResultSnapshot(db, GROUP))?.results[0]?.rawText).toBe(receipt.snapshot?.results[0]?.rawText);
  });

  it('preserves incompatible versions after resolution and reopens conflict for a new incompatible source', async () => {
    const db = store();
    const server = new ResultServer();
    server.snapshot = { ...emptyResultSnapshot(12), results: [officialResult(), manualResult(manualCommand(), 2)] };
    await applyResultSnapshot(db, server.snapshot);
    const command: ResultCommand = { apiVersion: 'v1', idempotencyKey: crypto.randomUUID(), groupId: GROUP, expectedRevision: 12, action: { type: 'result_resolve', poolId: POOL, poolVersion: 3, resultId: server.snapshot.results[0]!.id, observedResultIds: server.snapshot.results.map(row => row.id), reason: 'Todas as versões foram conferidas.' } };
    await prepareResultCommand(db, command);
    await executeResultCommand(db, server, command.idempotencyKey);
    expect(currentResult((await getResultSnapshot(db, GROUP))!, POOL).status).toBe('numbers-only');
    expect((await getResultSnapshot(db, GROUP))?.results).toHaveLength(2);
    server.snapshot.results.push(officialResult(3, [13, 14, 15, 16, 17, 18], true));
    server.snapshot.groupRevision += 1;
    const later = await collectResults(db, server, GROUP, POOL);
    expect(currentResult(later, POOL).status).toBe('conflict');
    expect(later.selections).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });

  it('persists receipt and facts atomically and recovers a local failure using GET', async () => {
    const db = store();
    const server = new ResultServer();
    const command = manualCommand();
    await prepareResultCommand(db, command);
    vi.spyOn(db.resultReceipts, 'put').mockRejectedValueOnce(new Error('Erro local ao salvar recibo.'));
    await expect(executeResultCommand(db, server, command.idempotencyKey)).rejects.toThrow('salvar recibo');
    expect(await db.contestResults.count()).toBe(0);
    expect(await getResultSnapshot(db, GROUP)).toBeNull();
    expect((await db.resultCommands.get(command.idempotencyKey))?.status).toBe('unknown');
    expect((await recoverResultCommand(db, server, command.idempotencyKey))?.status).toBe('accepted');
    expect(server.requests).toHaveLength(1);
  });

  it('keeps a newer result snapshot when the accepted old manual receipt is delivered late', async () => {
    const db = store();
    const server = new ResultServer();
    const command = manualCommand();
    await prepareResultCommand(db, command);
    server.loseAfterAccepting = true;
    await expect(executeResultCommand(db, server, command.idempotencyKey)).rejects.toThrow();
    server.snapshot.results.push(officialResult(2, [1, 2, 3, 4, 5, 6], true));
    server.snapshot.groupRevision += 1;
    await applyResultSnapshot(db, server.snapshot);
    expect((await recoverResultCommand(db, server, command.idempotencyKey))?.status).toBe('accepted');
    expect((await getResultSnapshot(db, GROUP))?.groupRevision).toBe(12);
    expect((await getResultSnapshot(db, GROUP))?.results).toHaveLength(2);
  });

  it('deduplicates decisions across open connections and enforces account recovery scope', async () => {
    const db = store();
    const second = store(db.accountId, db.installationId);
    const other = store(id(201), db.installationId);
    const server = new ResultServer();
    const command = manualCommand();
    await prepareResultCommand(db, command);
    const [one, two] = await Promise.all([executeResultCommand(db, server, command.idempotencyKey), executeResultCommand(second, server, command.idempotencyKey)]);
    expect(one).toEqual(two);
    expect(server.requests).toHaveLength(1);
    await expect(recoverResultCommand(other, server, command.idempotencyKey)).rejects.toThrow('nesta conta');
    expect(server.statusCalls).toBe(0);
  });
});

describe('result sync and emergency persistence', () => {
  it('pulls result history without collecting or sending unknown human commands', async () => {
    const db = store();
    const server = new ResultServer();
    const command = manualCommand();
    await prepareResultCommand(db, command);
    await db.resultCommands.update(command.idempotencyKey, { status: 'unknown' });
    server.snapshot = { ...emptyResultSnapshot(11), results: [officialResult()] };
    await sync(db, server);
    expect(await getResultSnapshot(db, GROUP)).toEqual(server.snapshot);
    expect(server.requests).toHaveLength(0);
    expect(server.statusCalls).toBe(0);
    expect(server.collectCalls).toBe(0);
    const exported = JSON.parse(await exportEmergencySnapshot(db));
    expect(exported.resultCommands[0]).toMatchObject({ status: 'unknown', command });
    expect(exported.contestResults[0].rawText).toBe(server.snapshot.results[0]!.rawText);
    expect(exported.contestResults[0].sha256).toBe(server.snapshot.results[0]!.sha256);
  });

  it('rejects a foreign result pull without erasing the prior group cache', async () => {
    const db = store();
    const server = new ResultServer();
    const cached = { ...emptyResultSnapshot(11), results: [officialResult()] };
    await applyResultSnapshot(db, cached);
    server.resultsPull = async () => emptyResultSnapshot(0, OTHER_GROUP);
    await expect(sync(db, server)).rejects.toThrow('outro grupo');
    expect(await getResultSnapshot(db, GROUP)).toEqual(cached);
    expect(await db.metadata.get('lastSyncAt')).toBeUndefined();
  });
});
