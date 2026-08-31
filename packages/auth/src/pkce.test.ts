import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { challengeFor, createPkcePair } from './pkce.js';

describe('createPkcePair', () => {
  it('produces a verifier within the RFC 7636 length bounds', () => {
    const { codeVerifier } = createPkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('always advertises S256', () => {
    expect(createPkcePair().codeChallengeMethod).toBe('S256');
  });

  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const expected = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPkcePair().codeVerifier));
    expect(seen.size).toBe(50);
  });
});

describe('challengeFor', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
