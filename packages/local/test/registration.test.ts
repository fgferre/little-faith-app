import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON } from '@bolao/core';
import type { RegistrationCommand, RegistrationReceipt, RegistrationSnapshot, RegistrationTransport } from '@bolao/core';
import {
  applyFinancialSnapshot, applyPlanningSnapshot, applyRegistrationSnapshot, createLocalStore,
  executeRegistrationCommand, exportEmergencySnapshot, getFinancialSnapshot, getPlanningSnapshot,
  getRegistrationSnapshot, prepareEvidenceUpload, prepareRegistrationCommand, recoverRegistrationCommand, saveDraft, sync,
} from '../src';
import type { BolaoDatabase, LocalSyncTransport } from '../src';
import { financialSnapshot, GROUP, id, lockedSnapshot, OTHER_GROUP, POOL } from './planning-fixtures';
import {
  ACCOUNT, CONFIRMED_AT, evidence, EVIDENCE_TEXT, registrationCommand, registrationSnapshot, report, reportedSnapshot,
} from './registration-fixtures';

const stores: Dexie[] = [];
function store(accountId = ACCOUNT, installationId: string = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}
async function initial(db: BolaoDatabase) { await applyPlanningSnapshot(db, lockedSnapshot()); await applyRegistrationSnapshot(db, registrationSnapshot()); }

class RegistrationServer implements RegistrationTransport, LocalSyncTransport {
  snapshot: RegistrationSnapshot = registrationSnapshot();
  readonly receipts = new Map<string, RegistrationReceipt>();
  readonly payloads = new Map<string, string>();
  readonly requests: RegistrationCommand[] = [];
  statusCalls = 0;
  loseAfterAccepting = false;
  loseBeforeAccepting = false;
  return404 = false;
  rejectNext = false;
  async listGroupIds() { return [GROUP]; }
  async push() { return []; }
  async pull(groupId: string) { return { groupId, changes: [], nextCursor: this.snapshot.groupRevision, hasMore: false }; }
  async registrationPull() { return structuredClone(this.snapshot); }
  async registrationCommandStatus(key: string) {
    this.statusCalls += 1;
    if (this.return404) throw Object.assign(new Error('Recibo ausente.'), { status: 404 });
    return structuredClone(this.receipts.get(key) ?? null);
  }
  async registrationDecide(command: RegistrationCommand): Promise<RegistrationReceipt> {
    this.requests.push(structuredClone(command));
    const payload = canonicalJSON(command);
    if (this.payloads.has(command.idempotencyKey) && this.payloads.get(command.idempotencyKey) !== payload) throw new Error('Payload idempotente alterado.');
    this.payloads.set(command.idempotencyKey, payload);
    if (this.loseBeforeAccepting) { this.loseBeforeAccepting = false; throw new Error('Resposta perdida antes da aceitação.'); }
    const previous = this.receipts.get(command.idempotencyKey);
    if (previous) return structuredClone(previous);
    let receipt: RegistrationReceipt;
    if (this.rejectNext || command.expectedRevision !== this.snapshot.groupRevision) {
      receipt = { apiVersion: 'v1', idempotencyKey: command.idempotencyKey, receiptId: null, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: this.rejectNext ? 'rejected' : 'conflict', message: 'Revise a conferência original.', confirmedAt: null, snapshot: structuredClone(this.snapshot) };
      this.rejectNext = false;
    } else {
      const receiptId = crypto.randomUUID();
      const version = 1 + this.snapshot.reports.filter(row => row.poolId === command.action.poolId).length;
      this.snapshot.reports.push(report(command, version, receiptId));
      this.snapshot.groupRevision += 1;
      receipt = { apiVersion: 'v1', idempotencyKey: command.idempotencyKey, receiptId, groupId: GROUP, groupRevision: this.snapshot.groupRevision, status: 'accepted', message: null, confirmedAt: CONFIRMED_AT, snapshot: structuredClone(this.snapshot) };
    }
    this.receipts.set(command.idempotencyKey, receipt);
    if (this.loseAfterAccepting) { this.loseAfterAccepting = false; throw new Error('Resposta perdida depois da aceitação.'); }
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

describe('append-only frozen registration history', () => {
  it('stores partial and divergent versions without changing drafts, financial facts or planned games', async () => {
    const db = store();
    const draft = await saveDraft(db, { groupId: GROUP, kind: 'person', data: { name: 'Rascunho', nickname: '', adultDeclared: true } });
    await applyFinancialSnapshot(db, financialSnapshot());
    await initial(db);
    const missing = registrationCommand(id(420), 8, true);
    const first = reportedSnapshot(missing);
    await applyRegistrationSnapshot(db, first);
    const divergent = registrationCommand(id(421), 9);
    divergent.action.poolVersion = 3;
    divergent.action.items[0]!.observed!.contestNumber = 3001;
    divergent.action.items[0]!.reason = 'A cartela pertence a outro concurso.';
    divergent.action.reason = 'Concurso divergente preservado.';
    const secondReport = report(divergent, 2, id(402));
    expect(secondReport.comparison.status).toBe('divergent');
    const second = { ...first, groupRevision: 10, reports: [...first.reports, secondReport] };
    await applyRegistrationSnapshot(db, second);
    expect((await getRegistrationSnapshot(db, GROUP))?.reports).toHaveLength(2);
    expect((await getRegistrationSnapshot(db, GROUP))?.reports.find(row => row.version === 1)?.comparison.status).toBe('partial');
    expect(await db.records.get(draft.id)).toEqual(draft);
    expect(await db.operations.count()).toBe(1);
    expect(await getFinancialSnapshot(db, GROUP)).toEqual(financialSnapshot());
    expect(await getPlanningSnapshot(db, GROUP)).toEqual(lockedSnapshot());
  });

  it('preserves newer facts when an older snapshot arrives', async () => {
    const db = store();
    await applyRegistrationSnapshot(db, reportedSnapshot());
    await applyRegistrationSnapshot(db, registrationSnapshot());
    expect(await getRegistrationSnapshot(db, GROUP)).toEqual(reportedSnapshot());
  });

  it('rejects edits, deleted history, same-revision additions and inconsistent comparisons atomically', async () => {
    const db = store();
    const original = reportedSnapshot();
    await applyRegistrationSnapshot(db, original);
    const changed = structuredClone(original);
    changed.groupRevision += 1;
    changed.reports[0]!.reason = 'Motivo reescrito.';
    await expect(applyRegistrationSnapshot(db, changed)).rejects.toThrow('alterar um relatório');
    await expect(applyRegistrationSnapshot(db, { ...registrationSnapshot(), groupRevision: 10 })).rejects.toThrow('não podem ser removidos');
    await expect(applyRegistrationSnapshot(db, { ...original, groupRevision: 9, evidence: [...original.evidence, { ...evidence(), id: id(499), storagePath: `${GROUP}/${id(499)}.pdf` }] })).rejects.toThrow('não avançou');
    const wrongComparison = structuredClone(original);
    wrongComparison.groupRevision += 1;
    wrongComparison.reports[0]!.comparison.status = 'partial';
    await expect(applyRegistrationSnapshot(db, wrongComparison)).rejects.toThrow();
    expect(await getRegistrationSnapshot(db, GROUP)).toEqual(original);
  });

  it('does not insert technical metadata into an older complete registration revision', async () => {
    const db = store();
    const empty = { ...registrationSnapshot(7), evidence: [] };
    await applyRegistrationSnapshot(db, empty);
    await db.confirmedEvidence.add(evidence());
    expect((await getRegistrationSnapshot(db, GROUP))?.evidence).toEqual([]);
    await applyRegistrationSnapshot(db, registrationSnapshot(8));
    expect((await getRegistrationSnapshot(db, GROUP))?.evidence).toEqual([evidence()]);
    await expect(applyRegistrationSnapshot(db, { ...empty, groupRevision: 9 })).rejects.toThrow('remover evidências');
  });

  it('reconciles a pending local upload from a validated registration pull without confirming a report', async () => {
    const db = store();
    const metadata = evidence();
    const prepared = await prepareEvidenceUpload(db, { id: metadata.id, groupId: GROUP, poolId: POOL, original: new Blob([EVIDENCE_TEXT], { type: metadata.mimeType }), originalName: metadata.originalName });
    await db.evidenceUploads.update(prepared.id, { status: 'unknown' });
    await applyRegistrationSnapshot(db, registrationSnapshot());
    expect((await db.evidenceUploads.get(prepared.id))?.status).toBe('uploaded');
    expect(await db.registrationReports.count()).toBe(0);
    expect(await db.registrationCommands.count()).toBe(0);
  });

  it('keeps account/demo scopes separate and rejects foreign group fact identifiers', async () => {
    const db = store();
    const other = store(id(201), db.installationId);
    const demo = store('demo', db.installationId);
    await applyRegistrationSnapshot(db, registrationSnapshot());
    expect(await getRegistrationSnapshot(other, GROUP)).toBeNull();
    expect(await getRegistrationSnapshot(demo, GROUP)).toBeNull();
    const foreign: RegistrationSnapshot = { groupId: OTHER_GROUP, groupRevision: 1, manifests: [], reports: [], evidence: [evidence(OTHER_GROUP)] };
    await expect(applyRegistrationSnapshot(db, foreign)).rejects.toThrow('metadados imutáveis');
    expect(await getRegistrationSnapshot(db, OTHER_GROUP)).toBeNull();
  });

  it('rolls back all report, evidence and revision writes if persistence fails', async () => {
    const db = store();
    vi.spyOn(db.registrationSnapshots, 'update').mockRejectedValueOnce(new Error('Quota local insuficiente.'));
    await expect(applyRegistrationSnapshot(db, reportedSnapshot())).rejects.toThrow('insuficiente');
    expect(await db.registrationReports.count()).toBe(0);
    expect(await db.registrationManifests.count()).toBe(0);
    expect(await db.confirmedEvidence.count()).toBe(0);
    expect(await getRegistrationSnapshot(db, GROUP)).toBeNull();
  });
});

describe('explicit registration decisions', () => {
  it('prepares an immutable human proposal offline without confirmed effects', async () => {
    const db = store();
    const command = registrationCommand();
    vi.stubGlobal('navigator', { onLine: false });
    const saved = await prepareRegistrationCommand(db, command);
    expect(saved).toMatchObject({ command, status: 'prepared' });
    expect(await prepareRegistrationCommand(db, command)).toEqual(saved);
    await expect(prepareRegistrationCommand(db, { ...command, action: { ...command.action, reason: 'Outro motivo' } })).rejects.toThrow('outra decisão');
    expect(await db.registrationReports.count()).toBe(0);
    expect(await db.operations.count()).toBe(0);
  });

  it('prohibits offline confirmation and sending before originals/manifest are available', async () => {
    const db = store();
    const server = new RegistrationServer();
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('manifesto');
    await applyPlanningSnapshot(db, lockedSnapshot());
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('arquivos de evidência');
    await applyRegistrationSnapshot(db, registrationSnapshot());
    vi.stubGlobal('navigator', { onLine: false });
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('internet');
    expect(server.requests).toHaveLength(0);
    expect((await db.registrationCommands.get(command.idempotencyKey))?.status).toBe('prepared');
  });

  it('recovers a lost response after reopening using only GET with exact frozen checklist', async () => {
    const db = store();
    const server = new RegistrationServer();
    await initial(db);
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    server.loseAfterAccepting = true;
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('depois');
    expect((await db.registrationCommands.get(command.idempotencyKey))?.status).toBe('unknown');
    expect(await db.registrationReports.count()).toBe(0);
    db.close();
    const reopened = store(db.accountId, db.installationId);
    const receipt = await recoverRegistrationCommand(reopened, server, command.idempotencyKey);
    expect(receipt?.status).toBe('accepted');
    expect(await reopened.registrationReports.count()).toBe(1);
    expect((await reopened.registrationCommands.get(command.idempotencyKey))?.command).toEqual(command);
    expect(server.requests).toHaveLength(1);
    expect(server.statusCalls).toBe(1);
    expect(await executeRegistrationCommand(reopened, server, command.idempotencyKey)).toEqual(receipt);
  });

  it('leaves 404 unknown and only resends after another explicit execute with the same payload', async () => {
    const db = store();
    const server = new RegistrationServer();
    await initial(db);
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    server.loseBeforeAccepting = true;
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('antes');
    server.return404 = true;
    expect(await recoverRegistrationCommand(db, server, command.idempotencyKey)).toBeNull();
    expect(server.requests).toHaveLength(1);
    expect((await db.registrationCommands.get(command.idempotencyKey))?.status).toBe('unknown');
    server.return404 = false;
    await executeRegistrationCommand(db, server, command.idempotencyKey);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toEqual(server.requests[1]);
  });

  it('preserves the original proposal for conflicts and rejections', async () => {
    for (const status of ['conflict', 'rejected'] as const) {
      const db = store();
      const server = new RegistrationServer();
      await initial(db);
      const command = registrationCommand(crypto.randomUUID(), status === 'conflict' ? 7 : 8);
      await prepareRegistrationCommand(db, command);
      server.rejectNext = status === 'rejected';
      expect((await executeRegistrationCommand(db, server, command.idempotencyKey)).status).toBe(status);
      expect((await db.registrationCommands.get(command.idempotencyKey))?.command).toEqual(command);
      expect(await db.registrationReports.count()).toBe(0);
      expect(server.requests).toHaveLength(1);
      await executeRegistrationCommand(db, server, command.idempotencyKey);
      expect(server.requests).toHaveLength(1);
    }
  });

  it('rejects accepted facts for a different approved reason and keeps the unknown decision', async () => {
    const db = store();
    const server = new RegistrationServer();
    await initial(db);
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    const decide = vi.spyOn(server, 'registrationDecide');
    decide.mockImplementation(async input => {
      const altered = { ...input, action: { ...input.action, reason: 'Uma aprovação diferente.' } };
      return RegistrationServer.prototype.registrationDecide.call(server, altered);
    });
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('exatamente');
    expect(await db.registrationReports.count()).toBe(0);
    expect((await db.registrationCommands.get(command.idempotencyKey))?.status).toBe('unknown');
  });

  it('stores accepted receipt and facts atomically and recovers local storage failures', async () => {
    const db = store();
    const server = new RegistrationServer();
    await initial(db);
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    vi.spyOn(db.registrationReceipts, 'put').mockRejectedValueOnce(new Error('Falha ao salvar recibo.'));
    await expect(executeRegistrationCommand(db, server, command.idempotencyKey)).rejects.toThrow('salvar recibo');
    expect(await db.registrationReports.count()).toBe(0);
    expect(await db.registrationReceipts.count()).toBe(0);
    expect((await db.registrationCommands.get(command.idempotencyKey))?.status).toBe('unknown');
    expect((await recoverRegistrationCommand(db, server, command.idempotencyKey))?.status).toBe('accepted');
    expect(server.requests).toHaveLength(1);
  });

  it('does not regress newer reports when the original accepted response arrives late', async () => {
    const db = store();
    const server = new RegistrationServer();
    await initial(db);
    const first = registrationCommand(id(430), 8, true);
    await prepareRegistrationCommand(db, first);
    server.loseAfterAccepting = true;
    await expect(executeRegistrationCommand(db, server, first.idempotencyKey)).rejects.toThrow();
    const next = registrationCommand(id(431), 9);
    next.action.poolVersion = 3;
    await server.registrationDecide(next);
    await applyRegistrationSnapshot(db, server.snapshot);
    expect((await recoverRegistrationCommand(db, server, first.idempotencyKey))?.status).toBe('accepted');
    expect((await getRegistrationSnapshot(db, GROUP))?.reports).toHaveLength(2);
    expect((await getRegistrationSnapshot(db, GROUP))?.groupRevision).toBe(10);
  });

  it('deduplicates simultaneous decisions and refuses command recovery from another account', async () => {
    const db = store();
    const second = store(db.accountId, db.installationId);
    const other = store(id(201), db.installationId);
    const server = new RegistrationServer();
    await initial(db);
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    const [one, two] = await Promise.all([executeRegistrationCommand(db, server, command.idempotencyKey), executeRegistrationCommand(second, server, command.idempotencyKey)]);
    expect(one).toEqual(two);
    expect(server.requests).toHaveLength(1);
    await expect(recoverRegistrationCommand(other, server, command.idempotencyKey)).rejects.toThrow('nesta conta');
    expect(server.statusCalls).toBe(0);
  });
});

describe('registration sync and emergency snapshot', () => {
  it('pulls registration facts without sending a saved human decision', async () => {
    const db = store();
    const server = new RegistrationServer();
    const command = registrationCommand();
    await prepareRegistrationCommand(db, command);
    await sync(db, server);
    expect(await getRegistrationSnapshot(db, GROUP)).toEqual(registrationSnapshot());
    expect((await db.registrationCommands.get(command.idempotencyKey))?.status).toBe('prepared');
    expect(server.requests).toHaveLength(0);
    expect(server.statusCalls).toBe(0);
    const snapshot = JSON.parse(await exportEmergencySnapshot(db));
    expect(snapshot.registrationCommands[0].command).toEqual(command);
    expect(snapshot.registrationManifests).toHaveLength(1);
    expect(snapshot.confirmedEvidence).toHaveLength(1);
    expect(snapshot.registrationReports).toEqual([]);
  });

  it('blocks wrong group snapshots and preserves the prior complete registration', async () => {
    const db = store();
    const server = new RegistrationServer();
    await initial(db);
    server.registrationPull = async () => ({ groupId: OTHER_GROUP, groupRevision: 0, manifests: [], evidence: [], reports: [] });
    await expect(sync(db, server)).rejects.toThrow('outro grupo');
    expect(await getRegistrationSnapshot(db, GROUP)).toEqual(registrationSnapshot());
    expect(await db.metadata.get('lastSyncAt')).toBeUndefined();
  });
});
