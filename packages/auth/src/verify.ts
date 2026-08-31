import {
  roleSchema,
  TokenExpiredError,
  UnauthenticatedError,
  type Principal,
  type Role,
} from '@mcpgateway/shared';
import { jwtVerify, type JWTPayload } from 'jose';

import type { JwksCache } from './jwks-cache.js';

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience?: string | readonly string[];
  /** Tolerance for clock skew between issuer and verifier. */
  readonly clockToleranceSeconds?: number;
}

export interface VerifiedToken {
  readonly claims: JWTPayload & Record<string, unknown>;
  readonly principal: Principal;
}

const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;

/**
 * Verify a bearer token and project it into a `Principal`.
 *
 * The algorithm allow-list is explicit: accepting whatever the token header
 * asks for is how `alg: none` and HMAC-confusion attacks get in. Nothing about
 * the caller's identity is read from anywhere but the verified payload.
 */
export async function verifyAccessToken(
  token: string,
  jwks: JwksCache,
  options: VerifyOptions,
): Promise<VerifiedToken> {
  if (!token) throw new UnauthenticatedError();

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, (header) => jwks.getKey(header.kid), {
      issuer: options.issuer,
      ...(options.audience === undefined
        ? {}
        : { audience: options.audience as string | string[] }),
      algorithms: [...ALLOWED_ALGORITHMS],
      clockTolerance: options.clockToleranceSeconds ?? 5,
    });
    payload = result.payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'JWTExpired') {
      throw new TokenExpiredError();
    }
    throw new UnauthenticatedError('Access token verification failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  return { claims: payload as VerifiedToken['claims'], principal: principalFromClaims(payload) };
}

export function principalFromClaims(payload: JWTPayload): Principal {
  const subject = payload.sub;
  const tenantId = payload.tenant_id;
  const tokenId = payload.jti;
  const clientId = payload.client_id;

  if (typeof subject !== 'string' || subject.length === 0) {
    throw new UnauthenticatedError('Token carries no subject');
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new UnauthenticatedError('Token carries no tenant_id claim');
  }
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    // Without a jti an audit row cannot name the exact credential used, which
    // defeats the point of recording the actor at all.
    throw new UnauthenticatedError('Token carries no jti claim');
  }

  const roleResult = roleSchema.safeParse(payload.role);
  const role: Role = roleResult.success ? roleResult.data : 'viewer';

  const principal: Principal = {
    subject,
    tenantId,
    role,
    scopes: parseScope(payload.scope),
    tokenId,
    clientId: typeof clientId === 'string' ? clientId : 'unknown',
    expiresAt: typeof payload.exp === 'number' ? payload.exp : 0,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
  };

  return principal;
}

export function parseScope(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter((s) => s.length > 0);
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  return [];
}

/** Seconds until `exp`, floored at zero. */
export function remainingLifetimeSeconds(expiresAt: number, now = Date.now()): number {
  return Math.max(0, expiresAt - Math.floor(now / 1000));
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : undefined;
}
