import type { DraftOperation, EntityKind, PushReceipt } from '../../../packages/core/src/types.ts';
import { validateDraftOperation } from '../../../packages/core/src/validation.ts';
import type { FinancialCommand, FinancialReceipt, FinancialSnapshot } from '../../../packages/core/src/financial-types.ts';
import { validateFinancialCommand, validateFinancialReceipt, validateFinancialSnapshot } from '../../../packages/core/src/financial.ts';
import type { PlanningCommand, PlanningReceipt, PlanningSnapshot } from '../../../packages/core/src/planning-types.ts';
import { MAX_PLANNING_COMMAND_BYTES, validatePlanningCommand, validatePlanningReceipt, validatePlanningSnapshot } from '../../../packages/core/src/planning.ts';
import type { ResultCommand, ResultReceipt, ResultSnapshot } from '../../../packages/core/src/result-types.ts';
import { MAX_RESULT_COMMAND_BYTES, validateResultCommand, validateResultReceipt, validateResultSnapshot } from '../../../packages/core/src/results.ts';
import type { RegistrationCommand, RegistrationReceipt, RegistrationSnapshot } from '../../../packages/core/src/registration-types.ts';
import { MAX_REGISTRATION_COMMAND_BYTES, validateRegistrationCommand, validateRegistrationReceipt, validateRegistrationSnapshot } from '../../../packages/core/src/registration.ts';
import type { SettlementCommand, SettlementReceipt, SettlementSnapshot } from '../../../packages/core/src/settlement-types.ts';
import { MAX_SETTLEMENT_COMMAND_BYTES, validateSettlementCommand, validateSettlementReceipt, validateSettlementSnapshot } from '../../../packages/core/src/settlement.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds: EntityKind[] = ['group', 'person', 'pool', 'quota', 'bet', 'payment-proposal'];
const envelopeKeys = ['apiVersion', 'idempotencyKey', 'groupId', 'entityId', 'kind', 'expectedVersion', 'data', 'createdAt'];
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Shared core validation; SQL independently protects RPCs, dependencies and authorization. */
export function parsePush(value: unknown): DraftOperation[] | null {
  if (!isObject(value) || !exactKeys(value, ['operations']) || !Array.isArray(value.operations)
    || value.operations.length < 1 || value.operations.length > 100) return null;
  for (const op of value.operations) {
    if (!isObject(op) || !exactKeys(op, envelopeKeys) || op.apiVersion !== 'v1'
      || !isUuid(op.idempotencyKey) || !isUuid(op.groupId) || !isUuid(op.entityId)
      || !isCursor(op.expectedVersion) || !isObject(op.data)
      || typeof op.kind !== 'string' || !kinds.includes(op.kind as EntityKind)
      || typeof op.createdAt !== 'string' || op.createdAt.length > 40 || !isoTimestamp.test(op.createdAt)
      || !Number.isFinite(Date.parse(op.createdAt)) || new TextEncoder().encode(JSON.stringify(op)).length > 65536) return null;
    try { validateDraftOperation(op); } catch { return null; }
  }
  // Preserve the submitted payload for strict idempotency comparison, even if core canonicalizes it.
  return value.operations as DraftOperation[];
}

export function isPushReceipt(value: unknown): value is PushReceipt {
  return isObject(value) && isUuid(value.idempotencyKey) && isUuid(value.entityId)
    && ['accepted', 'conflict', 'rejected'].includes(String(value.status))
    && isCursor(value.serverVersion) && isCursor(value.groupRevision)
    && (value.message === null || typeof value.message === 'string')
    && (value.record === null || isObject(value.record));
}

export function parseFinancialReview(value: unknown): FinancialCommand | null {
  if (!isObject(value) || !exactKeys(value, ['command'])
    || new TextEncoder().encode(JSON.stringify(value.command)).length > 65536) return null;
  try { validateFinancialCommand(value.command); } catch { return null; }
  // Preserve the exact submitted command so a changed payload cannot reuse its receipt.
  return value.command as FinancialCommand;
}

export function isFinancialReceipt(value: unknown): value is FinancialReceipt {
  try { validateFinancialReceipt(value); return true; } catch { return false; }
}

export function isFinancialSnapshot(value: unknown): value is FinancialSnapshot {
  try { validateFinancialSnapshot(value); return true; } catch { return false; }
}

export function parsePlanningReview(value: unknown): PlanningCommand | null {
  if (!isObject(value) || !exactKeys(value, ['command'])
    || new TextEncoder().encode(JSON.stringify(value.command)).length > MAX_PLANNING_COMMAND_BYTES) return null;
  try { validatePlanningCommand(value.command); } catch { return null; }
  return value.command as PlanningCommand;
}

export function isPlanningReceipt(value: unknown): value is PlanningReceipt {
  try { validatePlanningReceipt(value); return true; } catch { return false; }
}

export function isPlanningSnapshot(value: unknown): value is PlanningSnapshot {
  try { validatePlanningSnapshot(value); return true; } catch { return false; }
}

export function parseResultReview(value: unknown): ResultCommand | null {
  if (!isObject(value) || !exactKeys(value, ['command']) || new TextEncoder().encode(JSON.stringify(value.command)).length > MAX_RESULT_COMMAND_BYTES) return null;
  try { validateResultCommand(value.command); } catch { return null; }
  return value.command as ResultCommand;
}
export function isResultReceipt(value: unknown): value is ResultReceipt {
  try { validateResultReceipt(value); return true; } catch { return false; }
}
export function isResultSnapshot(value: unknown): value is ResultSnapshot {
  try { validateResultSnapshot(value); return true; } catch { return false; }
}
export function parseRegistrationReview(value: unknown): RegistrationCommand | null {
  if (!isObject(value) || !exactKeys(value, ['command']) || new TextEncoder().encode(JSON.stringify(value.command)).length > MAX_REGISTRATION_COMMAND_BYTES) return null;
  try { validateRegistrationCommand(value.command); } catch { return null; }
  return value.command as RegistrationCommand;
}
export function isRegistrationReceipt(value: unknown): value is RegistrationReceipt {
  try { validateRegistrationReceipt(value); return true; } catch { return false; }
}
export function isRegistrationSnapshot(value: unknown): value is RegistrationSnapshot {
  try { validateRegistrationSnapshot(value); return true; } catch { return false; }
}
/** Closing/reopening are parsed here and answered by SQL with an explicit rejection receipt. */
export const SETTLEMENT_ACTION_TYPES = ['expense_confirm', 'prize_confirm', 'redemption_record', 'redemption_reverse',
  'distribution_record', 'distribution_reverse', 'pool_settle', 'pool_reopen'];
export function parseSettlementReview(value: unknown): SettlementCommand | null {
  if (!isObject(value) || !exactKeys(value, ['command']) || new TextEncoder().encode(JSON.stringify(value.command)).length > MAX_SETTLEMENT_COMMAND_BYTES) return null;
  try { validateSettlementCommand(value.command); } catch { return null; }
  // Preserve the exact submitted command so a changed payload cannot reuse its receipt.
  return value.command as SettlementCommand;
}
export function isSettlementReceipt(value: unknown): value is SettlementReceipt {
  try { validateSettlementReceipt(value); return true; } catch { return false; }
}
export function isSettlementSnapshot(value: unknown): value is SettlementSnapshot {
  try { validateSettlementSnapshot(value); return true; } catch { return false; }
}

/** Called only after Supabase Auth validated this exact bearer token. Never authorizes on its own. */
export function readVerifiedTokenClaims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isObject(claims) ? claims : null;
  } catch { return null; }
}

export function isHumanSession(claims: Record<string, unknown> | null, user: {
  id: string; is_anonymous?: boolean; app_metadata: Record<string, unknown>;
}): boolean {
  if (!claims || claims.sub !== user.id || claims.role !== 'authenticated' || !isUuid(claims.session_id)
    || Object.hasOwn(claims, 'client_id') || claims.is_anonymous === true || user.is_anonymous === true) return false;
  const tokenMetadata = isObject(claims.app_metadata) ? claims.app_metadata : {};
  return (tokenMetadata.actor_type ?? 'human') === 'human' && (user.app_metadata.actor_type ?? 'human') === 'human';
}
