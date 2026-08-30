import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/** URL-safe random token, used for authorization codes and session ids. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison for secrets (client secrets, PKCE verifiers). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so the timing does not leak the length mismatch.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
