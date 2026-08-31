import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
}

/**
 * PKCE (RFC 7636). OAuth 2.1 makes this mandatory for every authorization-code
 * flow, public client or not, so the gateway's own login flow uses it too.
 */
export function createPkcePair(): PkcePair {
  // 32 random bytes -> 43 base64url characters, the shortest legal verifier.
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    codeVerifier,
    codeChallenge: challengeFor(codeVerifier),
    codeChallengeMethod: 'S256',
  };
}

export function challengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}
