import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import type { Keyring } from './keys.js';
import type { SeedUser } from './store.js';

export interface IssueAccessTokenInput {
  readonly keyring: Keyring;
  readonly issuer: string;
  readonly user: SeedUser;
  readonly clientId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly ttlSeconds: number;
  /**
   * RFC 8693 `act` claim. Present on exchanged tokens and names the party that
   * performed the exchange, so a downstream service can tell "Alice, via the
   * gateway" apart from "Alice, directly".
   */
  readonly actor?: { readonly sub: string };
}

export interface IssuedToken {
  readonly token: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

export async function issueAccessToken(input: IssueAccessTokenInput): Promise<IssuedToken> {
  const { keyring, issuer, user, clientId, audience, scopes, ttlSeconds, actor } = input;
  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const expiresAt = now + ttlSeconds;

  const builder = new SignJWT({
    scope: [...scopes].join(' '),
    client_id: clientId,
    tenant_id: user.tenantId,
    role: user.role,
    email: user.email,
    name: user.name,
    territory: user.territory,
    ...(actor ? { act: actor } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyring.active.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setSubject(user.id)
    .setAudience(audience)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(expiresAt)
    .setJti(jti);

  return {
    token: await builder.sign(keyring.active.privateKey),
    jti,
    expiresAt,
    scopes: [...scopes],
  };
}

export async function issueIdToken(input: {
  readonly keyring: Keyring;
  readonly issuer: string;
  readonly user: SeedUser;
  readonly clientId: string;
  readonly nonce?: string;
  readonly ttlSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: input.user.email,
    email_verified: true,
    name: input.user.name,
    preferred_username: input.user.email,
    tenant_id: input.user.tenantId,
    role: input.user.role,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.keyring.active.kid })
    .setIssuer(input.issuer)
    .setSubject(input.user.id)
    .setAudience(input.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + input.ttlSeconds)
    .setJti(randomUUID())
    .sign(input.keyring.active.privateKey);
}

/**
 * Reduce a requested scope set to what may actually be granted.
 *
 * Three filters compose, and the result is always a subset of all three:
 *   1. what the subject is entitled to (their role)
 *   2. what the client is registered to ask for
 *   3. which namespaces the target audience is allowed to receive
 *
 * This is the mechanism that stops an exchanged token from being broader than
 * the token it was exchanged for. Widening is not expressible here.
 */
export function narrowScopes(input: {
  readonly requested: readonly string[];
  readonly subjectEntitlements: readonly string[];
  readonly clientAllowed: readonly string[];
  readonly audienceNamespaces: readonly string[];
}): string[] {
  const { requested, subjectEntitlements, clientAllowed, audienceNamespaces } = input;
  const entitled = new Set(subjectEntitlements);
  const allowed = new Set(clientAllowed);
  const namespaceFilter = (scope: string): boolean => {
    if (audienceNamespaces.length === 0) return true;
    const namespace = scope.split(':')[0];
    return namespace !== undefined && audienceNamespaces.includes(namespace);
  };

  const candidates = requested.length > 0 ? requested : subjectEntitlements;
  return [...new Set(candidates)]
    .filter((scope) => entitled.has(scope))
    .filter((scope) => allowed.has(scope))
    .filter(namespaceFilter)
    .sort();
}

export function parseScopeParam(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s+]+/).filter((s) => s.length > 0);
}
