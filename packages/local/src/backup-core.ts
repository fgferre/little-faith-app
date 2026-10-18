import type { BolaoDatabase } from './database';
import { sha256Bytes } from './binary';
import { BACKUP_FORMAT } from './backup-types';
import type { BackupBundle, BackupFileRef, BackupManifest, BackupSummary } from './backup-types';

/** Every local table of database versions 1-6 except linkMessages, which never leaves the device that created it. */
const BACKUP_TABLES = new Set([
  'records', 'operations', 'receipts', 'cursors', 'confirmedPayments', 'metadata', 'serverRecords',
  'statutes', 'statuteAcceptances', 'receivedPayments', 'paymentAllocations', 'financialMovements', 'confirmedQuotas',
  'quotaRevocations', 'financialSnapshots', 'financialCommands', 'financialReceipts',
  'planningCandidates', 'planningAnalyses', 'simulationCheckpoints', 'appliedPlans', 'poolManifests', 'planningSnapshots',
  'planningCommands', 'planningReceipts',
  'evidenceUploads', 'confirmedEvidence', 'registrationManifests', 'registrationReports', 'registrationSnapshots',
  'registrationCommands', 'registrationReceipts', 'contestResults', 'resultSelections', 'contestCalendars', 'resultSnapshots',
  'resultCommands', 'resultReceipts', 'resultCollectionAttempts',
  'expenseConfirmations', 'prizeConfirmations', 'prizeRedemptions', 'settlementDistributions', 'poolSettlements',
  'settlementSnapshots', 'settlementCommands', 'settlementReceipts',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NOT_A_BACKUP = 'Este arquivo não é um backup do Little Faith.';
const UNKNOWN_TABLE = 'O backup tem uma tabela desconhecida; atualize o app antes de restaurar.';
const REFS_MISMATCH = 'O backup está incompleto: comprovantes e referências não batem.';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileRef(value: unknown): value is BackupFileRef {
  return isObject(value)
    && typeof value.evidenceId === 'string' && value.evidenceId !== ''
    && value.path === `files/${value.evidenceId}`
    && typeof value.mimeType === 'string'
    && Number.isSafeInteger(value.byteSize) && (value.byteSize as number) >= 0
    && typeof value.sha256 === 'string' && SHA256_HEX.test(value.sha256);
}

function sameRef(a: BackupFileRef, b: BackupFileRef): boolean {
  return a.evidenceId === b.evidenceId && a.path === b.path && a.mimeType === b.mimeType
    && a.byteSize === b.byteSize && a.sha256 === b.sha256;
}

/** Reúne tudo deste aparelho e desta conta num pacote (manifesto JSON mais os originais dos comprovantes). */
export async function collectBackup(db: BolaoDatabase): Promise<BackupBundle> {
  const createdAt = new Date().toISOString();
  // linkMessages hold personal link URLs (credentials) and stay on the device that created them.
  const tables = db.tables.filter(table => table.name !== 'linkMessages');
  // Capture every table atomically, then read Blob bytes outside the IDB transaction.
  const snapshot: Record<string, unknown[]> = await db.transaction('r', tables, async () => {
    const rows = await Promise.all(tables.map(async table => [table.name, await table.toArray()] as const));
    return Object.fromEntries(rows);
  });
  const refs: BackupFileRef[] = [];
  const files: BackupBundle['files'] = [];
  if (snapshot.evidenceUploads) {
    const serialized = [];
    for (const row of snapshot.evidenceUploads) {
      if (!isObject(row) || typeof row.id !== 'string' || !(row.original instanceof Blob)) {
        throw new Error('Uma evidência local está sem o arquivo original; o backup não foi concluído.');
      }
      const original = row.original;
      const sha256 = await sha256Bytes(await original.arrayBuffer());
      if (row.sha256 !== sha256) {
        throw new Error('O SHA-256 de uma evidência local não corresponde ao original; o backup não foi concluído.');
      }
      const ref: BackupFileRef = { evidenceId: row.id, path: `files/${row.id}`, mimeType: original.type, byteSize: original.size, sha256 };
      serialized.push({ ...row, original: ref });
      refs.push(ref);
      files.push({ path: ref.path, blob: original });
    }
    snapshot.evidenceUploads = serialized;
  }
  return {
    manifest: { format: BACKUP_FORMAT, createdAt, installationId: db.installationId, accountId: db.accountId, tables: snapshot, files: refs },
    files,
  };
}

/** Valida um manifesto lido de um arquivo: formato, versão, campos e referências de arquivos; devolve o manifesto tipado. */
export function validateBackupManifest(input: unknown): BackupManifest {
  if (!isObject(input) || input.format !== BACKUP_FORMAT) throw new Error(NOT_A_BACKUP);
  if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))
    || typeof input.installationId !== 'string' || !input.installationId.trim()
    || typeof input.accountId !== 'string' || !input.accountId.trim()) {
    throw new Error(NOT_A_BACKUP);
  }
  const tables = input.tables;
  if (!isObject(tables) || !Object.keys(tables).every(name => BACKUP_TABLES.has(name) && Array.isArray(tables[name]))) {
    throw new Error(UNKNOWN_TABLE);
  }
  if (!Array.isArray(input.files) || !input.files.every(isFileRef)) throw new Error(REFS_MISMATCH);
  const refs = new Map(input.files.map(ref => [ref.evidenceId, ref]));
  const evidence = (tables.evidenceUploads ?? []) as unknown[];
  const rowIds = new Set<string>();
  for (const row of evidence) {
    // Each evidence row points to exactly one file ref, with the same content check it was saved with.
    const ref = isObject(row) && typeof row.id === 'string' ? refs.get(row.id) : undefined;
    if (!ref || !isObject(row) || !isFileRef(row.original) || !sameRef(row.original, ref) || row.sha256 !== ref.sha256 || rowIds.has(ref.evidenceId)) {
      throw new Error(REFS_MISMATCH);
    }
    rowIds.add(ref.evidenceId);
  }
  if (refs.size !== input.files.length || rowIds.size !== refs.size) throw new Error(REFS_MISMATCH);
  return input as unknown as BackupManifest;
}

/** Conta o que o backup traz, sem tocar no banco. */
export function summarizeBackup(manifest: BackupManifest): BackupSummary {
  const records = manifest.tables.records ?? [];
  const count = (kind: string) => records.filter(row => isObject(row) && row.kind === kind).length;
  return {
    createdAt: manifest.createdAt,
    accountId: manifest.accountId,
    groups: count('group'),
    pools: count('pool'),
    persons: count('person'),
    files: manifest.files.length,
    rows: Object.values(manifest.tables).reduce((total, rows) => total + rows.length, 0),
  };
}

async function assertEmpty(db: BolaoDatabase): Promise<void> {
  const counts = await Promise.all(db.tables.filter(table => table.name !== 'metadata').map(table => table.count()));
  if (counts.some(count => count > 0)) {
    throw new Error('Este aparelho já tem dados. Restaure num aparelho vazio, ou apague os dados deste aparelho antes.');
  }
}

/**
 * Restaura o pacote neste aparelho: só numa base vazia e da mesma conta; confere o SHA-256 de cada original antes de gravar;
 * grava todas as tabelas numa transação só, mantendo os identificadores. Devolve o resumo do que entrou.
 */
export async function restoreBackup(db: BolaoDatabase, bundle: BackupBundle): Promise<BackupSummary> {
  const manifest = validateBackupManifest(bundle.manifest);
  if (manifest.accountId !== db.accountId) {
    throw new Error('Este backup é de outra conta. Entre com a conta de origem antes de restaurar.');
  }
  await assertEmpty(db);
  // Read and check every original outside the IDB transaction; nothing is written until all of them match.
  const originals = new Map<string, Blob>();
  for (const ref of manifest.files) {
    const file = bundle.files.find(candidate => candidate.path === ref.path);
    if (!file || !(file.blob instanceof Blob)) throw new Error('O backup está incompleto: falta um comprovante.');
    const bytes = await file.blob.arrayBuffer();
    if (bytes.byteLength !== ref.byteSize || await sha256Bytes(bytes) !== ref.sha256) {
      throw new Error('Um comprovante do backup está corrompido; nada foi restaurado.');
    }
    originals.set(ref.evidenceId, new Blob([bytes], { type: ref.mimeType }));
  }
  const tables: Record<string, unknown[]> = { ...manifest.tables };
  if (tables.evidenceUploads) {
    tables.evidenceUploads = tables.evidenceUploads.map(row => {
      const stored = row as { id: string };
      return { ...stored, original: originals.get(stored.id) };
    });
  }
  // The emptiness check runs again inside the write, so a second restore started meanwhile cannot merge into the first.
  await db.transaction('rw', db.tables, async () => {
    await assertEmpty(db);
    for (const [name, rows] of Object.entries(tables)) await db.table(name).bulkPut(rows);
  });
  return summarizeBackup(manifest);
}
