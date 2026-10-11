import { planningInvalid, planningText } from './prepared-plans';
import { sha256Hex } from './canonical';

export const MAX_SOURCE_BYTES = 1_048_576;
export function sourceTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return planningInvalid(field, 'Horário UTC obrigatório.');
  }
  const date = new Date(value);
  const expected = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== expected) return planningInvalid(field, 'Horário UTC inválido.');
  return date.toISOString();
}
export function sourceDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return planningInvalid(field, 'Data de calendário inválida.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return planningInvalid(field, 'Data de calendário inválida.');
  return value;
}
export function sourceHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return planningInvalid(field, 'SHA-256 hexadecimal inválido.');
  return value;
}
export function sourceRaw(value: unknown, field = 'rawText'): string {
  const raw = planningText(value, field, MAX_SOURCE_BYTES, true);
  if (new TextEncoder().encode(raw).length > MAX_SOURCE_BYTES) return planningInvalid(field, 'Fonte excede o limite de 1 MiB.');
  return raw;
}
export function verifySourceHash(raw: string, hash: unknown): string {
  const verified = sourceHash(hash, 'sha256');
  if (sha256Hex(raw) !== verified) return planningInvalid('sha256', 'Hash da fonte original não confere.');
  return verified;
}
