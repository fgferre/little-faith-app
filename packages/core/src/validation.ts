import type { DraftOperation, EntityDataMap, EntityKind, LotteryId, PixReceiver } from './types';
import { CATALOG_VERSION, LOTTERIES, validateBet } from './lotteries';
import { validatePixReceiver } from './pix';
import { centsValue } from './money';
import { GENERATION_ALGORITHM_VERSION } from './generation';

export const MAX_OPERATIONAL_CENTS = Number.MAX_SAFE_INTEGER.toString();
/** An operational limit, not an official Caixa quota limit: 10,000 internal quotas per person. */
export const MAX_QUOTA_UNITS = 1_000_000;

export class DomainValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

/**
 * Shape and arithmetic validation shared by local saves and the server.
 * Authentication, group membership, references, versions, available balance and
 * confirmation authority still require the server's transactional validation.
 */
export function validateEntityData<K extends EntityKind>(kind: K, input: unknown): EntityDataMap[K];
export function validateEntityData(kind: EntityKind, input: unknown): EntityDataMap[EntityKind] {
  const data = object(input, 'data');
  switch (kind) {
    case 'group': {
      keys(data, ['name', 'statute'], ['pix']);
      const group = { name: text(data.name, 'name', 120, true), statute: text(data.statute, 'statute', 12_000) };
      return Object.hasOwn(data, 'pix') ? { ...group, pix: data.pix === null ? null : pixReceiver(data.pix) } : group;
    }
    case 'person':
      keys(data, ['name', 'nickname', 'adultDeclared']);
      return { name: text(data.name, 'name', 120, true), nickname: text(data.nickname, 'nickname', 80), adultDeclared: boolean(data.adultDeclared, 'adultDeclared') };
    case 'pool': {
      keys(data, ['title', 'lotteryId', 'contestNumber', 'deadlineAt', 'quotaPriceCents', 'participationMode', 'status'], ['contestCount']);
      return {
        ...(Object.hasOwn(data, 'contestCount') ? { contestCount: positiveInteger(data.contestCount, 'contestCount', 12) } : {}),
        title: text(data.title, 'title', 160, true),
        lotteryId: lotteryId(data.lotteryId),
        contestNumber: data.contestNumber === null ? null : positiveInteger(data.contestNumber, 'contestNumber', 999_999),
        deadlineAt: data.deadlineAt === null ? null : utcTimestamp(data.deadlineAt, 'deadlineAt'),
        quotaPriceCents: positiveCents(data.quotaPriceCents, 'quotaPriceCents'),
        participationMode: member(data.participationMode, ['undecided', 'internal', 'official'], 'participationMode'),
        status: member(data.status, ['draft', 'locked', 'registered', 'settled'], 'status'),
      };
    }
    case 'quota':
      keys(data, ['poolId', 'personId', 'units']);
      return { poolId: uuid(data.poolId, 'poolId'), personId: uuid(data.personId, 'personId'), units: positiveInteger(data.units, 'units', MAX_QUOTA_UNITS) };
    case 'bet': {
      keys(data, ['poolId', 'lotteryId', 'numbers', 'authorIds', 'catalogVersion', 'seed', 'generationAlgorithmVersion']);
      const modality = lotteryId(data.lotteryId);
      if (!Array.isArray(data.numbers)) fail('numbers', 'Informe a lista de dezenas.');
      let numbers: number[];
      try { numbers = validateBet(modality, data.numbers as number[]); }
      catch (error) { fail('numbers', error instanceof Error ? error.message : 'Dezenas inválidas.'); }
      if (!Array.isArray(data.authorIds) || data.authorIds.length > 200) fail('authorIds', 'Informe no máximo 200 autores.');
      const authorIds = data.authorIds.map((author: unknown) => uuid(author, 'authorIds'));
      if (new Set(authorIds).size !== authorIds.length) fail('authorIds', 'Um autor não pode aparecer duas vezes no mesmo jogo.');
      if (data.catalogVersion !== CATALOG_VERSION) fail('catalogVersion', 'O catálogo mudou; revise o jogo antes de sincronizar.');
      if (data.seed !== null && (typeof data.seed !== 'string' || !/^[0-9a-f]{64}$/i.test(data.seed))) {
        fail('seed', 'A semente do jogo deve conter 64 caracteres hexadecimais.');
      }
      if (data.seed === null && data.generationAlgorithmVersion !== null) {
        fail('generationAlgorithmVersion', 'Jogos manuais devem ter semente e versão de geração nulas.');
      }
      if (data.seed !== null && data.generationAlgorithmVersion !== GENERATION_ALGORITHM_VERSION) {
        fail('generationAlgorithmVersion', 'Versão de geração não suportada; revise a origem do jogo.');
      }
      return {
        poolId: uuid(data.poolId, 'poolId'), lotteryId: modality, numbers,
        authorIds, catalogVersion: CATALOG_VERSION, seed: data.seed === null ? null : data.seed.toLowerCase(),
        generationAlgorithmVersion: data.seed === null ? null : GENERATION_ALGORITHM_VERSION,
      };
    }
    case 'payment-proposal':
      keys(data, ['poolId', 'personId', 'amountCents', 'note', 'status']);
      return {
        poolId: uuid(data.poolId, 'poolId'), personId: uuid(data.personId, 'personId'),
        amountCents: positiveCents(data.amountCents, 'amountCents'), note: text(data.note, 'note', 2_000),
        status: member(data.status, ['pending', 'needs-review', 'rejected'], 'status'),
      };
    default:
      return fail('kind', 'Tipo de entidade não suportado.');
  }
}

/** Validating a draft never turns it into a financial confirmation or a locked pool. */
export function validateDraftOperation(input: unknown): DraftOperation {
  const operation = object(input, 'operation');
  keys(operation, ['apiVersion', 'idempotencyKey', 'groupId', 'entityId', 'kind', 'expectedVersion', 'data', 'createdAt']);
  if (operation.apiVersion !== 'v1') fail('apiVersion', 'Versão da API não suportada.');
  const kind = member(operation.kind, ['group', 'person', 'pool', 'quota', 'bet', 'payment-proposal'], 'kind');
  const groupId = uuid(operation.groupId, 'groupId');
  const entityId = uuid(operation.entityId, 'entityId');
  if (kind === 'group' && groupId !== entityId) fail('entityId', 'O identificador do grupo deve ser igual ao da entidade.');
  const data = validateEntityData(kind, operation.data);
  if (kind === 'pool' && (data as EntityDataMap['pool']).status !== 'draft') {
    fail('status', 'Travar ou encerrar um bolão exige um comando confirmado pelo servidor.');
  }
  if (!Number.isSafeInteger(operation.expectedVersion) || (operation.expectedVersion as number) < 0) {
    fail('expectedVersion', 'A versão esperada deve ser um inteiro não negativo.');
  }
  return {
    apiVersion: 'v1', idempotencyKey: uuid(operation.idempotencyKey, 'idempotencyKey'),
    groupId, entityId, kind, expectedVersion: operation.expectedVersion as number,
    data, createdAt: utcTimestamp(operation.createdAt, 'createdAt'),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field, 'Informe um objeto de dados válido.');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...expected, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(key, `Campo não suportado: ${key}.`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(key, `Campo obrigatório ausente: ${key}.`);
  }
}

/** Groups store the Pix receiver only in normal form, so the code built on any device is the same. */
function pixReceiver(value: unknown): PixReceiver {
  const pix = object(value, 'pix');
  keys(pix, ['key', 'keyType', 'name', 'city']);
  const input = { key: text(pix.key, 'pix.key', 77, true), keyType: text(pix.keyType, 'pix.keyType', 10, true), name: text(pix.name, 'pix.name', 25, true), city: text(pix.city, 'pix.city', 15, true) };
  let receiver: PixReceiver;
  try { receiver = validatePixReceiver(input); }
  catch (error) { return fail('pix', error instanceof Error ? error.message : 'Chave Pix inválida.'); }
  // The SQL check accepts only this normal form too (private.pix_receiver_valid).
  if (receiver.key !== input.key || receiver.name !== input.name || receiver.city !== input.city) {
    fail('pix', 'A chave Pix precisa estar no formato normalizado.');
  }
  return receiver;
}

function text(value: unknown, field: string, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    fail(field, `O campo ${field} deve conter ${required ? 'de 1 a' : 'até'} ${maximum} caracteres.`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, `O campo ${field} deve ser verdadeiro ou falso.`);
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    fail(field, `O campo ${field} deve conter um identificador UUID.`);
  }
  return value.toLowerCase();
}

function member<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(field, `Valor inválido para ${field}.`);
  return value as T;
}

function lotteryId(value: unknown): LotteryId {
  return member(value, Object.keys(LOTTERIES) as LotteryId[], 'lotteryId');
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(field, `O campo ${field} deve ser inteiro entre 1 e ${maximum}.`);
  }
  return value;
}

function positiveCents(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_OPERATIONAL_CENTS.length) fail(field, 'Informe centavos inteiros positivos.');
  let cents: bigint;
  try { cents = centsValue(value); }
  catch { return fail(field, 'Informe centavos inteiros positivos em formato canônico.'); }
  if (cents <= 0n || cents > BigInt(MAX_OPERATIONAL_CENTS)) fail(field, `O valor deve estar entre 1 e ${MAX_OPERATIONAL_CENTS} centavos.`);
  return cents.toString();
}

function utcTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    fail(field, `O campo ${field} deve conter data e horário UTC em formato ISO.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    fail(field, `Data ou horário inválido em ${field}.`);
  }
  return timestamp.toISOString();
}

function fail(field: string, message: string): never {
  throw new DomainValidationError(field, message);
}
