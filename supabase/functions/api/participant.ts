import type { ParticipantAnswerKind, ParticipantCard, ParticipantResponse, ParticipantResponsesPull } from '../../../packages/core/src/participant-types.ts';
import type { EvidenceMimeType } from '../../../packages/core/src/registration-types.ts';
import { hashBytes } from './evidence.ts';
import { exactKeys, isObject, isUuid } from './contract.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes in base64url. Only the SHA-256 of the token text is stored; the token itself leaves once, in the creation reply. */
export async function createParticipantToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { token, tokenHash: await hashBytes(new TextEncoder().encode(token)) };
}

/** Null for anything that cannot be a link token, so malformed links never reach the database. */
export async function participantTokenHash(token: unknown): Promise<string | null> {
  return typeof token === 'string' && TOKEN_RE.test(token) ? await hashBytes(new TextEncoder().encode(token)) : null;
}

export function isParticipantCard(value: unknown): value is ParticipantCard {
  return isObject(value) && value.version === 1 && typeof value.generatedAt === 'string' && isObject(value.group) && typeof value.group.name === 'string'
    && isObject(value.person) && isUuid(value.person.id) && typeof value.person.name === 'string'
    && Array.isArray(value.pools) && value.pools.every(pool => isObject(pool) && isUuid(pool.id) && (pool.quota === null || isObject(pool.quota)) && Array.isArray(pool.games)
      && typeof pool.responseOpen === 'boolean' && (pool.response === null || isObject(pool.response)))
    && (value.pinSet === undefined || typeof value.pinSet === 'boolean');
}

export function isAnswerKind(value: unknown): value is ParticipantAnswerKind {
  return value === 'in' || value === 'out' || value === 'paid';
}

/** Whole cents as text, 1 to 16 digits with no leading zero: the same rule participant_respond enforces. */
export function isAnswerCents(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value);
}

export function isParticipantResponse(value: unknown): value is ParticipantResponse {
  return isObject(value) && isUuid(value.id) && isUuid(value.poolId) && isUuid(value.personId) && isUuid(value.linkId) && isAnswerKind(value.kind)
    && (value.kind === 'paid' ? isAnswerCents(value.amountCents) : value.amountCents === null)
    && (value.proofId === null || (value.kind === 'paid' && isUuid(value.proofId))) && typeof value.createdAt === 'string';
}

export function isParticipantReminder(value: unknown): value is ParticipantResponsesPull['reminders'][number] {
  return isObject(value) && isUuid(value.id) && isUuid(value.poolId) && isUuid(value.personId) && typeof value.remindedAt === 'string';
}

function isProofSummary(proof: unknown, proofId: string | null): boolean {
  return proofId === null ? proof === null : isObject(proof) && proof.id === proofId && typeof proof.sha256 === 'string'
    && typeof proof.mimeType === 'string' && typeof proof.byteSize === 'number';
}

/** The organizer's history: every answer carries the summary of its proof, present exactly when the answer names one. */
export function isParticipantResponsesPull(value: unknown): value is ParticipantResponsesPull {
  return isObject(value) && Array.isArray(value.responses)
    && value.responses.every(response => isObject(response) && isParticipantResponse(response) && isProofSummary(response.proof, response.proofId))
    && Array.isArray(value.reminders) && value.reminders.every(isParticipantReminder);
}

export function isParticipantProofStatus(value: unknown): value is {
  id: string; groupId: string; poolId: string; personId: string; sha256: string; mimeType: EvidenceMimeType; byteSize: number; storagePath: string; uploadedAt: string;
} {
  return isObject(value) && isUuid(value.id) && isUuid(value.groupId) && isUuid(value.poolId) && isUuid(value.personId)
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
    && (value.mimeType === 'application/pdf' || value.mimeType === 'image/jpeg' || value.mimeType === 'image/png' || value.mimeType === 'image/webp')
    && Number.isInteger(value.byteSize) && typeof value.storagePath === 'string' && typeof value.uploadedAt === 'string';
}

export function isParticipantLink(value: unknown): value is { id: string; personId: string; createdAt: string; revokedAt: string | null; hasPin?: boolean } {
  return isObject(value) && isUuid(value.id) && isUuid(value.personId) && typeof value.createdAt === 'string'
    && (value.revokedAt === null || typeof value.revokedAt === 'string') && (value.hasPin === undefined || typeof value.hasPin === 'boolean');
}

/** Exactly four digits: the same rule the database enforces on the card PIN. */
export function isPin(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}$/.test(value);
}

/** Digits only, country code first, 10 to 15 digits: the same rule the database enforces on person_phones. */
export function isPhone(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{9,14}$/.test(value);
}

export function isPersonPhone(value: unknown): value is { personId: string; phone: string } {
  return isObject(value) && exactKeys(value, ['personId', 'phone']) && isUuid(value.personId) && isPhone(value.phone);
}
