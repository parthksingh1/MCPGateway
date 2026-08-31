import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

export interface SigningKey {
  readonly kid: string;
  readonly alg: 'RS256';
  readonly privateKey: KeyLike;
  readonly publicJwk: JWK;
}

export interface Keyring {
  /** Key new tokens are signed with. */
  readonly active: SigningKey;
  /** Everything a verifier should currently trust, newest first. */
  jwks(): { keys: JWK[] };
  /** Rotate: mint a new active key while keeping the previous one servable. */
  rotate(): Promise<SigningKey>;
}

async function createKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');
  return {
    kid,
    alg: 'RS256',
    privateKey,
    publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
  };
}

/**
 * Signing keys are generated at boot rather than baked into the image, so the
 * repository never carries a private key and every restart exercises the
 * consumer-side kid-miss refresh path in the gateway's JWKS cache.
 */
export async function createKeyring(): Promise<Keyring> {
  let keys = [await createKey()];

  return {
    get active() {
      const first = keys[0];
      if (!first) throw new Error('Keyring is empty');
      return first;
    },
    jwks: () => ({ keys: keys.map((k) => k.publicJwk) }),
    rotate: async () => {
      const next = await createKey();
      // Retain the previous key so tokens signed a moment ago still verify.
      keys = [next, ...keys].slice(0, 2);
      return next;
    },
  };
}
