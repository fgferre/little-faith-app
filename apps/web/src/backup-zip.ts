import {
  BlobReader,
  BlobWriter,
  configure,
  ERR_INVALID_PASSWORD,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { validateBackupManifest } from "@bolao/local";
import type { BackupBundle } from "@bolao/local";

/**
 * O backup com senha (item 11 de docs/PENDENCIAS.md, decisão do dono em 17/10): o pacote de `@bolao/local` num zip AES-256,
 * com o manifesto em "backup.json" e cada original no seu caminho. Sem a senha nenhum conteúdo abre; os arquivos são pequenos,
 * então tudo roda sem web workers, igual no navegador e nos testes.
 */
configure({ useWebWorkers: false });

const MANIFEST = "backup.json";
export const MIN_BACKUP_PASSWORD = 8;
const NOT_A_BACKUP = "Este arquivo não é um backup do Little Faith.";

export async function writeBackupZip(
  bundle: BackupBundle,
  password: string,
): Promise<Blob> {
  // Senha vazia faria o zip.js gravar sem criptografia; a tela já exige o mínimo, esta camada também.
  if (password.length < MIN_BACKUP_PASSWORD) {
    throw new Error(
      `A senha precisa ter pelo menos ${MIN_BACKUP_PASSWORD} caracteres.`,
    );
  }
  const writer = new ZipWriter(new BlobWriter("application/zip"), {
    password,
    encryptionStrength: 3,
    zipCrypto: false,
  });
  await writer.add(MANIFEST, new TextReader(JSON.stringify(bundle.manifest)));
  for (const file of bundle.files) {
    await writer.add(file.path, new BlobReader(file.blob));
  }
  return await writer.close();
}

export async function readBackupZip(
  file: Blob,
  password: string,
): Promise<BackupBundle> {
  const reader = new ZipReader(new BlobReader(file), { password });
  try {
    const entries = await reader.getEntries().catch(() => {
      throw new Error(NOT_A_BACKUP);
    });
    const byPath = new Map(
      entries.flatMap((entry) => entry.directory ? [] : [[entry.filename, entry] as const]),
    );
    const head = byPath.get(MANIFEST);
    if (!head) throw new Error(NOT_A_BACKUP);
    const text = await head.getData(new TextWriter()).catch((error: unknown) => {
      if (error instanceof Error && error.message === ERR_INVALID_PASSWORD) {
        throw new Error("Senha incorreta.");
      }
      throw error;
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(NOT_A_BACKUP);
    }
    const manifest = validateBackupManifest(parsed);
    const files: BackupBundle["files"] = [];
    for (const ref of manifest.files) {
      const entry = byPath.get(ref.path);
      if (!entry) {
        throw new Error("O backup está incompleto: falta um comprovante.");
      }
      files.push({
        path: ref.path,
        blob: await entry.getData(new BlobWriter(ref.mimeType)),
      });
    }
    return { manifest, files };
  } finally {
    await reader.close();
  }
}
