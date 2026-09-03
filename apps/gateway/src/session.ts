import { randomToken } from '@mcpgateway/shared';
import type { Redis } from 'ioredis';

export const SESSION_COOKIE = 'mcpgw_session';
export const LOGIN_STATE_COOKIE = 'mcpgw_login';

export interface SessionRecord {
  readonly subject: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scopes: string[];
  readonly createdAt: number;
}

/**
 * Server-side session store for the console.
 *
 * The browser holds an opaque, httpOnly, SameSite=Lax session id and nothing
 * else. Access and refresh tokens live in Redis, keyed by that id, so a
 * cross-site scripting bug in the console cannot read a bearer token, and
 * signing a user out actually revokes their session rather than only clearing
 * a cookie.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 8 * 60 * 60,
  ) {}

  private key(id: string): string {
    return `sess:${id}`;
  }

  async create(record: Omit<SessionRecord, 'createdAt'>): Promise<string> {
    const id = randomToken(32);
    const payload: SessionRecord = { ...record, createdAt: Date.now() };
    await this.redis.set(this.key(id), JSON.stringify(payload), 'EX', this.ttlSeconds);
    return id;
  }

  async get(id: string | undefined): Promise<SessionRecord | null> {
    if (!id) return null;
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      await this.destroy(id);
      return null;
    }
  }

  async update(id: string, record: SessionRecord): Promise<void> {
    await this.redis.set(this.key(id), JSON.stringify(record), 'EX', this.ttlSeconds);
  }

  async destroy(id: string | undefined): Promise<void> {
    if (!id) return;
    await this.redis.del(this.key(id));
  }

  /** Short-lived storage for the PKCE verifier and CSRF state during login. */
  async putLoginState(
    state: string,
    value: { codeVerifier: string; redirectTo: string },
  ): Promise<void> {
    await this.redis.set(`login:${state}`, JSON.stringify(value), 'EX', 600);
  }

  async takeLoginState(
    state: string | undefined,
  ): Promise<{ codeVerifier: string; redirectTo: string } | null> {
    if (!state) return null;
    const key = `login:${state}`;
    const raw = await this.redis.get(key);
    // Single use: consumed whether or not the rest of the callback succeeds.
    await this.redis.del(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { codeVerifier: string; redirectTo: string };
    } catch {
      return null;
    }
  }
}
