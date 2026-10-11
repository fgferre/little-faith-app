/** Hash the original bytes; encoding or image processing must not change the evidence. */
export async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('O navegador precisa de um contexto seguro para verificar o SHA-256 da evidência.');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A multiple of three keeps concatenated chunks valid without internal padding. */
export function bytesBase64(bytes: ArrayBuffer): string {
  const input = new Uint8Array(bytes);
  const chunks: string[] = [];
  const size = 32_766;
  for (let offset = 0; offset < input.length; offset += size) {
    chunks.push(btoa(String.fromCharCode(...input.subarray(offset, offset + size))));
  }
  return chunks.join('');
}
