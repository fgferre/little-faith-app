/**
 * O backup completo com senha (docs/ESPECIFICACAO.md, seção 5; item 11 de docs/PENDENCIAS.md, decisão do dono em 17/10):
 * tudo o que este aparelho guarda para esta conta, em todos os grupos, menos os links pessoais (`linkMessages`, credenciais que
 * ficam no aparelho que os criou; a especificação manda recriar os convites depois de restaurar). Os originais dos comprovantes
 * saem como arquivos à parte, conferidos pelo SHA-256; o manifesto é JSON puro, sem Blob. Quem tranca com a senha é o app
 * (zip AES-256), não esta camada.
 */
export const BACKUP_FORMAT = 'bolao-backup-v1';

/** Um original de comprovante dentro do backup: o caminho do arquivo no pacote e a conferência do conteúdo. */
export interface BackupFileRef {
  evidenceId: string;
  path: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

/** O manifesto do backup: serializável como JSON; `tables` traz cada tabela local pelo nome, com as linhas como estão. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  installationId: string;
  accountId: string;
  /** As linhas de `evidenceUploads` têm `original` trocado por um `BackupFileRef`; as demais tabelas vão inteiras. */
  tables: Record<string, unknown[]>;
  files: BackupFileRef[];
}

/** O manifesto mais os bytes dos originais, na ordem de `manifest.files`. */
export interface BackupBundle {
  manifest: BackupManifest;
  files: { path: string; blob: Blob }[];
}

/** O que o backup traz, para a pessoa conferir antes de restaurar e o app contar depois. */
export interface BackupSummary {
  createdAt: string;
  accountId: string;
  groups: number;
  pools: number;
  persons: number;
  files: number;
  rows: number;
}
