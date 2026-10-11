import type { ParticipantCard } from '../../../packages/core/src/participant-types.ts';
import { hashBytes } from './evidence.ts';
import { isObject, isUuid } from './contract.ts';

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
    && Array.isArray(value.pools) && value.pools.every(pool => isObject(pool) && isUuid(pool.id) && isObject(pool.quota) && Array.isArray(pool.games));
}

export function isParticipantLink(value: unknown): value is { id: string; personId: string; createdAt: string; revokedAt: string | null } {
  return isObject(value) && isUuid(value.id) && isUuid(value.personId) && typeof value.createdAt === 'string'
    && (value.revokedAt === null || typeof value.revokedAt === 'string');
}
