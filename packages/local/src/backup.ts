import type { BolaoDatabase } from './database';
import { bytesBase64, sha256Bytes } from './binary';

/** This optional local export is not the encrypted complete backup from docs/ESPECIFICACAO.md. */
export async function exportEmergencySnapshot(db: BolaoDatabase): Promise<string> {
  const createdAt = new Date().toISOString();
  // linkMessages hold personal link URLs (credentials) and stay on the device that created them.
  const tables = db.tables.filter(table => table.name !== 'linkMessages');
  // Capture every table atomically, then read Blob bytes outside the IDB transaction.
  const snapshot: Record<string, unknown[]> = await db.transaction('r', tables, async () => {
    const rows = await Promise.all(tables.map(async table => [table.name, await table.toArray()] as const));
    return Object.fromEntries(rows);
  });
  if (snapshot.evidenceUploads) {
    const serialized = [];
    for (const row of snapshot.evidenceUploads) {
      if (typeof row !== 'object' || row === null || !('original' in row) || !(row.original instanceof Blob)) {
        throw new Error('Uma evidência local está sem o arquivo original; a cópia de emergência não foi concluída.');
      }
      const original = row.original;
      const bytes = await original.arrayBuffer();
      const sha256 = await sha256Bytes(bytes);
      if (!('sha256' in row) || row.sha256 !== sha256) {
        throw new Error('O SHA-256 de uma evidência local não corresponde ao original; a cópia de emergência não foi concluída.');
      }
      serialized.push({
        ...row,
        original: { encoding: 'base64', mimeType: original.type, byteSize: original.size, sha256, data: bytesBase64(bytes) },
      });
    }
    snapshot.evidenceUploads = serialized;
  }
  return JSON.stringify({
    format: 'bolao-emergency-v5',
    encrypted: false,
    warning: 'Esta cópia local não está criptografada e contém dados privados, incluindo os originais de evidências locais em base64. Guarde-a em local protegido. Ela não substitui o backup completo do grupo, não baixa arquivos ausentes do servidor e não autoriza reenviar ou confirmar pendências.',
    createdAt,
    installationId: db.installationId,
    accountId: db.accountId,
    ...snapshot,
  }, null, 2);
}
