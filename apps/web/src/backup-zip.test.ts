import { describe, expect, it, vi } from "vitest";
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { BACKUP_FORMAT } from "@bolao/local";
import type { BackupBundle, BackupManifest } from "@bolao/local";
import { readBackupZip, writeBackupZip } from "./backup-zip";

// Aqui só a camada do zip: a validação do manifesto tem testes próprios em packages/local.
vi.mock("@bolao/local", async (importOriginal) => ({
  ...await importOriginal<typeof import("@bolao/local")>(),
  validateBackupManifest: (input: unknown) => input,
}));

const PASSWORD = "senha-forte-123";

async function tinyBundle(): Promise<BackupBundle> {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes))
    .toString("hex");
  const path = "comprovantes/ev-1.png";
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    installationId: "inst",
    accountId: "acc",
    tables: { records: [] },
    files: [{ evidenceId: "ev-1", path, mimeType: "image/png", byteSize: 3, sha256 }],
  };
  return { manifest, files: [{ path, blob: new Blob([bytes], { type: "image/png" }) }] };
}

describe("backup com senha em zip", () => {
  it("volta igual com a senha certa, e nada abre sem ela", async () => {
    const bundle = await tinyBundle();
    const zip = await writeBackupZip(bundle, PASSWORD);

    const back = await readBackupZip(zip, PASSWORD);
    expect(back.manifest).toEqual(bundle.manifest);
    const [only, ...rest] = back.files;
    expect(rest).toEqual([]);
    expect(only?.path).toBe("comprovantes/ev-1.png");
    expect(only?.blob.type).toBe("image/png");
    expect([...new Uint8Array(await only!.blob.arrayBuffer())])
      .toEqual([1, 2, 3]);

    const locked = new ZipReader(new BlobReader(zip));
    const entries = await locked.getEntries();
    expect(entries.map((e) => [e.filename, e.encrypted])).toEqual([
      ["backup.json", true],
      ["comprovantes/ev-1.png", true],
    ]);
    const head = entries[0];
    if (!head || head.directory) throw new Error("backup.json não é arquivo");
    await expect(head.getData(new TextWriter())).rejects.toThrow();
    await locked.close();
  });

  it("recusa a senha errada", async () => {
    const zip = await writeBackupZip(await tinyBundle(), PASSWORD);
    await expect(readBackupZip(zip, "errada")).rejects.toThrow(/Senha incorreta/);
  });

  it("recusa um zip que não é backup", async () => {
    const writer = new ZipWriter(new BlobWriter("application/zip"), {
      password: PASSWORD,
      encryptionStrength: 3,
    });
    await writer.add("outro.txt", new TextReader("oi"));
    const zip = await writer.close();
    await expect(readBackupZip(zip, PASSWORD)).rejects.toThrow(/não é um backup/);
  });
});
