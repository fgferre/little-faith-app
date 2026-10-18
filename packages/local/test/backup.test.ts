import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT, collectBackup, createLocalStore, prepareEvidenceUpload, restoreBackup, saveDraft,
  summarizeBackup, validateBackupManifest,
} from '../src';
import type { BackupBundle, BolaoDatabase } from '../src';
import { GROUP, id, POOL, TIME } from './planning-fixtures';

const ACCOUNT = id(200);
const OTHER_ACCOUNT = id(201);
const stores: BolaoDatabase[] = [];
function store(accountId = ACCOUNT, installationId: string = crypto.randomUUID()): BolaoDatabase {
  const db = createLocalStore({ accountId, installationId });
  stores.push(db);
  return db;
}

afterEach(async () => {
  const deleting = stores.splice(0);
  for (const db of deleting) db.close();
  for (const db of deleting) await db.delete();
});

async function seeded(): Promise<BolaoDatabase> {
  const db = store();
  await saveDraft(db, { groupId: GROUP, kind: 'group', data: { name: 'Bolão da firma', statute: 'Cotas pagas antes do sorteio.' } });
  await saveDraft(db, {
    id: POOL, groupId: GROUP, kind: 'pool',
    data: { title: 'Mega de amigos', lotteryId: 'mega-sena', contestNumber: 3000, deadlineAt: '2026-10-09T18:00:00.000Z', quotaPriceCents: '2000', participationMode: 'internal', status: 'draft' },
  });
  await saveDraft(db, { groupId: GROUP, kind: 'person', data: { name: 'Ana', nickname: '', adultDeclared: true } });
  const bytes = Uint8Array.from({ length: 4_099 }, (_, index) => index % 256);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  await prepareEvidenceUpload(db, { groupId: GROUP, poolId: POOL, original: new Blob([bytes], { type: 'image/png' }) });
  return db;
}

async function isEmpty(db: BolaoDatabase): Promise<boolean> {
  return (await Promise.all(db.tables.map(table => table.count()))).every(count => count === 0);
}

describe('complete backup', () => {
  it('round-trips every table and original into an empty store of the same account', async () => {
    const source = await seeded();
    const bundle = await collectBackup(source);
    const manifest = validateBackupManifest(JSON.parse(JSON.stringify(bundle.manifest)));
    expect(manifest).toMatchObject({ format: BACKUP_FORMAT, accountId: ACCOUNT, installationId: source.installationId });
    expect(manifest.tables).not.toHaveProperty('linkMessages');
    const summary = summarizeBackup(manifest);
    expect(summary).toMatchObject({ accountId: ACCOUNT, createdAt: manifest.createdAt, groups: 1, pools: 1, persons: 1, files: 1 });
    expect(summary.rows).toBeGreaterThan(4);
    const destination = store(ACCOUNT);
    await expect(restoreBackup(destination, { manifest, files: bundle.files })).resolves.toEqual(summary);
    for (const table of source.tables) {
      const expected = await table.toArray();
      const restored = await destination.table(table.name).toArray();
      if (table.name !== 'evidenceUploads') {
        expect(restored, table.name).toEqual(expected);
        continue;
      }
      expect(restored).toHaveLength(1);
      const [{ original: before, ...rest }] = expected as [{ original: Blob }];
      const [{ original: after, ...restoredRest }] = restored as [{ original: Blob }];
      expect(restoredRest).toEqual(rest);
      expect(after.type).toBe(before.type);
      expect(new Uint8Array(await after.arrayBuffer())).toEqual(new Uint8Array(await before.arrayBuffer()));
    }
  });

  it('refuses a store that already has data and leaves it unchanged', async () => {
    const bundle = await collectBackup(await seeded());
    const destination = store(ACCOUNT);
    const existing = await saveDraft(destination, { groupId: GROUP, kind: 'person', data: { name: 'Bia', nickname: '', adultDeclared: true } });
    await expect(restoreBackup(destination, bundle)).rejects.toThrow(/já tem dados/);
    expect(await destination.records.toArray()).toEqual([existing]);
    expect(await destination.evidenceUploads.count()).toBe(0);
  });

  it('refuses a backup of another account', async () => {
    const bundle = await collectBackup(await seeded());
    const destination = store(OTHER_ACCOUNT);
    await expect(restoreBackup(destination, bundle)).rejects.toThrow(/outra conta/);
    expect(await isEmpty(destination)).toBe(true);
  });

  it('refuses an original altered by one byte and writes nothing', async () => {
    const bundle = await collectBackup(await seeded());
    const bytes = new Uint8Array(await bundle.files[0]!.blob.arrayBuffer());
    bytes[100] = bytes[100]! ^ 1;
    const altered: BackupBundle = { manifest: bundle.manifest, files: [{ path: bundle.files[0]!.path, blob: new Blob([bytes], { type: 'image/png' }) }] };
    const destination = store(ACCOUNT);
    await expect(restoreBackup(destination, altered)).rejects.toThrow(/corrompido/);
    expect(await isEmpty(destination)).toBe(true);
  });

  it('rejects a foreign format and an unknown table', () => {
    const manifest = { format: BACKUP_FORMAT, createdAt: TIME, installationId: id(300), accountId: ACCOUNT, tables: { records: [] }, files: [] };
    expect(validateBackupManifest(manifest)).toBe(manifest);
    expect(() => validateBackupManifest({ ...manifest, format: 'x' })).toThrow(/não é um backup/);
    expect(() => validateBackupManifest({ ...manifest, tables: { records: [], ghosts: [] } })).toThrow(/desconhecida/);
  });
});
