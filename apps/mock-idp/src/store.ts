import { readFile } from 'node:fs/promises';

import { z } from 'zod';

/**
 * MOCK: enterprise identity provider (Okta / Entra ID / Auth0).
 *
 * Everything this file backs — the subject directory, the client registry and
 * the entitlement mapping — lives in a real IdP in production. It is reproduced
 * here so the OAuth 2.1 authorization-code + PKCE flow and the RFC 8693 token
 * exchange run end to end offline. The wire protocol is the real one; only the
 * storage is local. Point OIDC_ISSUER at any RFC 8693-capable provider and the
 * gateway needs no code change.
 */

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  password: z.string(),
  name: z.string(),
  tenantId: z.string(),
  role: z.enum(['admin', 'manager', 'analyst', 'viewer']),
  title: z.string(),
  territory: z.string().nullable(),
  managerId: z.string().nullable(),
});

const clientSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string().nullable(),
  name: z.string(),
  confidential: z.boolean(),
  redirectUris: z.array(z.string()),
  allowedScopes: z.array(z.string()),
  allowedGrants: z.array(z.string()),
});

const seedSchema = z.object({
  scopeSets: z.record(z.array(z.string())),
  audienceNamespaces: z.record(z.array(z.string())),
  users: z.array(userSchema),
  clients: z.array(clientSchema),
});

export type SeedUser = z.infer<typeof userSchema>;
export type SeedClient = z.infer<typeof clientSchema>;
export type Seed = z.infer<typeof seedSchema>;

export interface Directory {
  readonly seed: Seed;
  findUserByEmail(email: string): SeedUser | undefined;
  findUserById(id: string): SeedUser | undefined;
  findClient(clientId: string): SeedClient | undefined;
  /** The full entitlement set for a subject, derived from their role. */
  entitlementsFor(user: SeedUser): readonly string[];
  /** Scope namespaces a given audience is permitted to receive. */
  namespacesFor(audience: string): readonly string[];
  listUsers(): readonly SeedUser[];
}

const ALWAYS_GRANTED = ['openid', 'profile', 'email'] as const;

export async function loadDirectory(
  path = new URL('../seed.json', import.meta.url),
): Promise<Directory> {
  const raw = await readFile(path, 'utf8');
  const seed = seedSchema.parse(JSON.parse(raw));

  const byEmail = new Map(seed.users.map((u) => [u.email.toLowerCase(), u]));
  const byId = new Map(seed.users.map((u) => [u.id, u]));
  const clients = new Map(seed.clients.map((c) => [c.clientId, c]));

  return {
    seed,
    findUserByEmail: (email) => byEmail.get(email.trim().toLowerCase()),
    findUserById: (id) => byId.get(id),
    findClient: (clientId) => clients.get(clientId),
    entitlementsFor: (user) => [...ALWAYS_GRANTED, ...(seed.scopeSets[user.role] ?? [])],
    namespacesFor: (audience) => seed.audienceNamespaces[audience] ?? [],
    listUsers: () => seed.users,
  };
}
