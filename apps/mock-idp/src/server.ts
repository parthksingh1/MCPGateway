import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import formbody from '@fastify/formbody';
import { createLogger } from '@mcpgateway/telemetry';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { importJWK, jwtVerify, type JWTPayload, type KeyLike } from 'jose';
import { z } from 'zod';

import { createKeyring, type Keyring } from './keys.js';
import { renderLoginPage } from './login-page.js';
import { loadDirectory, type Directory, type SeedUser } from './store.js';
import { issueAccessToken, issueIdToken, narrowScopes, parseScopeParam } from './tokens.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export interface IdpOptions {
  readonly issuer: string;
  readonly accessTokenTtlSeconds?: number;
  readonly logger?: boolean;
}

interface AuthorizationCode {
  readonly userId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly nonce?: string;
  readonly expiresAt: number;
}

interface RefreshGrant {
  readonly userId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

type Reply = FastifyReply;

const AUTH_CODE_TTL_MS = 60_000;
const REFRESH_TTL_MS = 8 * 60 * 60 * 1000;

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): unknown {
  return reply.code(status).send({ error, error_description: description });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** S256 only. OAuth 2.1 removes the `plain` challenge method. */
function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return constantTimeEquals(computed, challenge);
}

const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
  nonce: z.string().optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
});

const authorizeBodySchema = authorizeQuerySchema.extend({
  email: z.string().min(1),
  password: z.string().min(1),
});

export async function buildIdp(options: IdpOptions): Promise<FastifyInstance> {
  const issuer = options.issuer.replace(/\/$/, '');
  const accessTokenTtl = options.accessTokenTtlSeconds ?? 900;
  const log = createLogger({ serviceName: 'identity' });

  const [directory, keyring] = await Promise.all([loadDirectory(), createKeyring()]);

  const codes = new Map<string, AuthorizationCode>();
  const refreshTokens = new Map<string, RefreshGrant>();

  const app = Fastify({ logger: false, trustProxy: true, disableRequestLogging: true });
  await app.register(formbody);

  app.addHook('onRequest', async (request) => {
    log.debug({ method: request.method, url: request.url }, 'idp request');
  });

  // ------------------------------------------------------------- discovery
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/userinfo`,
    introspection_endpoint: `${issuer}/introspect`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'client_credentials',
      TOKEN_EXCHANGE_GRANT,
    ],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: [
      ...new Set(directory.seed.clients.flatMap((client) => client.allowedScopes)),
    ].sort(),
  };

  app.get('/.well-known/openid-configuration', async () => metadata);
  app.get('/.well-known/oauth-authorization-server', async () => metadata);
  app.get('/jwks', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return keyring.jwks();
  });
  app.get('/healthz', async () => ({ status: 'ok', issuer }));

  // ---------------------------------------------------------- authorization
  app.get('/authorize', async (request, reply) => {
    const parsed = authorizeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return oauthError(reply, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'bad');
    }
    const params = parsed.data;
    const client = directory.findClient(params.client_id);
    if (!client) return oauthError(reply, 400, 'invalid_client', 'Unknown client');
    if (!client.redirectUris.includes(params.redirect_uri)) {
      return oauthError(reply, 400, 'invalid_request', 'redirect_uri is not registered');
    }
    if (!client.allowedGrants.includes('authorization_code')) {
      return oauthError(reply, 400, 'unauthorized_client', 'Grant not permitted for this client');
    }

    const requested = parseScopeParam(params.scope);
    void reply.type('text/html; charset=utf-8');
    return renderLoginPage({
      clientName: client.name,
      scopes: requested.filter((s) => client.allowedScopes.includes(s)),
      hidden: {
        response_type: params.response_type,
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        scope: params.scope ?? '',
        state: params.state ?? '',
        nonce: params.nonce ?? '',
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
      },
    });
  });

  app.post('/authorize', async (request, reply) => {
    const parsed = authorizeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return oauthError(reply, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'bad');
    }
    const params = parsed.data;
    const client = directory.findClient(params.client_id);
    if (!client || !client.redirectUris.includes(params.redirect_uri)) {
      return oauthError(reply, 400, 'invalid_client', 'Unknown client or redirect_uri');
    }

    const user = directory.findUserByEmail(params.email);
    const credentialsValid =
      user !== undefined && constantTimeEquals(user.password, params.password);
    if (!user || !credentialsValid) {
      void reply.type('text/html; charset=utf-8').code(401);
      return renderLoginPage({
        clientName: client.name,
        scopes: parseScopeParam(params.scope).filter((s) => client.allowedScopes.includes(s)),
        hidden: {
          response_type: params.response_type,
          client_id: params.client_id,
          redirect_uri: params.redirect_uri,
          scope: params.scope ?? '',
          state: params.state ?? '',
          nonce: params.nonce ?? '',
          code_challenge: params.code_challenge,
          code_challenge_method: params.code_challenge_method,
        },
        error: 'Those credentials are not valid.',
        email: params.email,
      });
    }

    const scopes = narrowScopes({
      requested: parseScopeParam(params.scope),
      subjectEntitlements: directory.entitlementsFor(user),
      clientAllowed: client.allowedScopes,
      audienceNamespaces: [],
    });

    const code = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    codes.set(code, {
      userId: user.id,
      clientId: client.clientId,
      redirectUri: params.redirect_uri,
      scopes,
      codeChallenge: params.code_challenge,
      ...(params.nonce ? { nonce: params.nonce } : {}),
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const target = new URL(params.redirect_uri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    log.info({ userId: user.id, clientId: client.clientId }, 'authorization code issued');
    return reply.redirect(target.toString(), 302);
  });

  // ------------------------------------------------------------------ token
  app.post('/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const grantType = body.grant_type;

    const auth = resolveClientCredentials(request.headers.authorization, body);
    const client = auth.clientId ? directory.findClient(auth.clientId) : undefined;
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Unknown client');
    if (client.confidential) {
      if (!auth.clientSecret || client.clientSecret === null) {
        return oauthError(reply, 401, 'invalid_client', 'Client authentication required');
      }
      if (!constantTimeEquals(client.clientSecret, auth.clientSecret)) {
        return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
      }
    }
    if (grantType === undefined || !client.allowedGrants.includes(grantType)) {
      return oauthError(reply, 400, 'unauthorized_client', `Grant '${grantType}' not permitted`);
    }

    switch (grantType) {
      case 'authorization_code':
        return handleAuthorizationCode(body, client.clientId, reply);
      case 'refresh_token':
        return handleRefresh(body, client.clientId, reply);
      case 'client_credentials':
        return handleClientCredentials(body, client.clientId, client.allowedScopes, reply);
      case TOKEN_EXCHANGE_GRANT:
        return handleTokenExchange(body, client.clientId, client.allowedScopes, reply);
      default:
        return oauthError(reply, 400, 'unsupported_grant_type', `Unsupported: ${grantType}`);
    }
  });

  async function handleAuthorizationCode(
    body: Record<string, string | undefined>,
    clientId: string,
    reply: Reply,
  ): Promise<unknown> {
    const code = body.code;
    const verifier = body.code_verifier;
    if (!code || !verifier) {
      return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are required');
    }
    const grant = codes.get(code);
    // Authorization codes are single use; consume before validating so a replay
    // cannot succeed even if the first attempt failed for another reason.
    codes.delete(code);
    if (!grant) return oauthError(reply, 400, 'invalid_grant', 'Unknown or already-used code');
    if (grant.expiresAt < Date.now()) {
      return oauthError(reply, 400, 'invalid_grant', 'Authorization code has expired');
    }
    if (grant.clientId !== clientId) {
      return oauthError(reply, 400, 'invalid_grant', 'Code was issued to a different client');
    }
    if (body.redirect_uri !== undefined && body.redirect_uri !== grant.redirectUri) {
      return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch');
    }
    if (!verifyPkce(verifier, grant.codeChallenge)) {
      return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
    }
    const user = directory.findUserById(grant.userId);
    if (!user) return oauthError(reply, 400, 'invalid_grant', 'Subject no longer exists');

    return issueTokenResponse(reply, {
      user,
      clientId,
      scopes: grant.scopes,
      audience: clientId,
      includeIdToken: grant.scopes.includes('openid'),
      ...(grant.nonce ? { nonce: grant.nonce } : {}),
      includeRefresh: grant.scopes.includes('offline_access'),
    });
  }

  async function handleRefresh(
    body: Record<string, string | undefined>,
    clientId: string,
    reply: Reply,
  ): Promise<unknown> {
    const token = body.refresh_token;
    if (!token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');
    const grant = refreshTokens.get(token);
    // Rotate on use: the presented token is invalidated whether or not the
    // request ultimately succeeds.
    refreshTokens.delete(token);
    if (!grant || grant.expiresAt < Date.now()) {
      return oauthError(reply, 400, 'invalid_grant', 'Refresh token is not valid');
    }
    if (grant.clientId !== clientId) {
      return oauthError(reply, 400, 'invalid_grant', 'Refresh token belongs to another client');
    }
    const user = directory.findUserById(grant.userId);
    if (!user) return oauthError(reply, 400, 'invalid_grant', 'Subject no longer exists');

    return issueTokenResponse(reply, {
      user,
      clientId,
      scopes: grant.scopes,
      audience: clientId,
      includeIdToken: false,
      includeRefresh: true,
    });
  }

  async function handleClientCredentials(
    body: Record<string, string | undefined>,
    clientId: string,
    clientAllowed: readonly string[],
    reply: Reply,
  ): Promise<unknown> {
    const tenantId = body.tenant_id;
    if (!tenantId) {
      return oauthError(reply, 400, 'invalid_request', 'tenant_id is required for this grant');
    }
    // A service principal is still a subject: it gets its own identifier rather
    // than borrowing a human's, so audit rows stay attributable.
    const servicePrincipal: SeedUser = {
      id: `svc_${clientId}`,
      email: `${clientId}@service.local`,
      password: '',
      name: clientId,
      tenantId,
      role: 'analyst',
      title: 'Service principal',
      territory: null,
      managerId: null,
    };
    const scopes = narrowScopes({
      requested: parseScopeParam(body.scope),
      subjectEntitlements: clientAllowed,
      clientAllowed,
      audienceNamespaces: [],
    });
    return issueTokenResponse(reply, {
      user: servicePrincipal,
      clientId,
      scopes,
      audience: body.audience ?? clientId,
      includeIdToken: false,
      includeRefresh: false,
    });
  }

  /**
   * RFC 8693 token exchange — the operation the whole gateway is built around.
   *
   * The gateway presents a caller's access token plus a target audience and gets
   * back a token that still names the caller as `sub` but is scoped to that one
   * downstream service. The actor claim records that the gateway performed the
   * exchange. Scopes can only narrow (see `narrowScopes`), so no exchange can
   * hand back more authority than the subject token carried.
   */
  async function handleTokenExchange(
    body: Record<string, string | undefined>,
    clientId: string,
    clientAllowed: readonly string[],
    reply: Reply,
  ): Promise<unknown> {
    const subjectToken = body.subject_token;
    const audience = body.audience;
    if (!subjectToken || !audience) {
      return oauthError(reply, 400, 'invalid_request', 'subject_token and audience are required');
    }
    if (body.subject_token_type !== ACCESS_TOKEN_TYPE) {
      return oauthError(reply, 400, 'invalid_request', 'Unsupported subject_token_type');
    }

    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(subjectToken, resolveLocalKey, { issuer });
      claims = verified.payload;
    } catch (error) {
      log.warn({ err: error }, 'token exchange rejected: subject token failed verification');
      return oauthError(reply, 400, 'invalid_grant', 'subject_token is not valid');
    }

    const user = typeof claims.sub === 'string' ? directory.findUserById(claims.sub) : undefined;
    if (!user) return oauthError(reply, 400, 'invalid_grant', 'Unknown subject');

    const subjectScopes = parseScopeParam(
      typeof claims.scope === 'string' ? claims.scope : undefined,
    );
    const requested = parseScopeParam(body.scope);
    const granted = narrowScopes({
      requested,
      // Intersecting with the subject token's own scopes is what makes this an
      // exchange rather than a fresh grant: the result can never widen.
      subjectEntitlements: subjectScopes.filter((s) => directory.entitlementsFor(user).includes(s)),
      clientAllowed,
      audienceNamespaces: directory.namespacesFor(audience),
    });

    if (granted.length === 0) {
      return oauthError(
        reply,
        400,
        'invalid_scope',
        `Subject holds no scopes valid for audience '${audience}'`,
      );
    }

    // Exchanged tokens are deliberately short-lived: they are minted per call
    // and cached for at most a few minutes.
    const ttl = Math.min(accessTokenTtl, 300);
    const issued = await issueAccessToken({
      keyring,
      issuer,
      user,
      clientId,
      audience,
      scopes: granted,
      ttlSeconds: ttl,
      actor: { sub: clientId },
    });

    log.info(
      { subject: user.id, audience, granted: granted.length, requested: requested.length },
      'token exchange completed',
    );

    return reply.send({
      access_token: issued.token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: granted.join(' '),
    });
  }

  async function issueTokenResponse(
    reply: Reply,
    input: {
      user: SeedUser;
      clientId: string;
      scopes: readonly string[];
      audience: string;
      includeIdToken: boolean;
      includeRefresh: boolean;
      nonce?: string;
    },
  ): Promise<unknown> {
    const issued = await issueAccessToken({
      keyring,
      issuer,
      user: input.user,
      clientId: input.clientId,
      audience: input.audience,
      scopes: input.scopes,
      ttlSeconds: accessTokenTtl,
    });

    const response: Record<string, unknown> = {
      access_token: issued.token,
      token_type: 'Bearer',
      expires_in: accessTokenTtl,
      scope: input.scopes.join(' '),
    };

    if (input.includeIdToken) {
      response.id_token = await issueIdToken({
        keyring,
        issuer,
        user: input.user,
        clientId: input.clientId,
        ttlSeconds: accessTokenTtl,
        ...(input.nonce ? { nonce: input.nonce } : {}),
      });
    }

    if (input.includeRefresh) {
      const refresh = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      refreshTokens.set(refresh, {
        userId: input.user.id,
        clientId: input.clientId,
        scopes: input.scopes,
        expiresAt: Date.now() + REFRESH_TTL_MS,
      });
      response.refresh_token = refresh;
    }

    return reply.send(response);
  }

  // ------------------------------------------------------------ introspect
  app.post('/introspect', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const token = body.token;
    if (!token) return reply.send({ active: false });
    try {
      const { payload } = await jwtVerify(token, resolveLocalKey, { issuer });
      return reply.send({
        active: true,
        sub: payload.sub,
        aud: payload.aud,
        iss: payload.iss,
        exp: payload.exp,
        iat: payload.iat,
        jti: payload.jti,
        scope: payload.scope,
        client_id: payload.client_id,
        tenant_id: payload.tenant_id,
        role: payload.role,
        act: payload.act,
        token_type: 'Bearer',
      });
    } catch {
      return reply.send({ active: false });
    }
  });

  app.get('/userinfo', async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return oauthError(reply, 401, 'invalid_token', 'Bearer token required');
    try {
      const { payload } = await jwtVerify(token, resolveLocalKey, { issuer });
      const user =
        typeof payload.sub === 'string' ? directory.findUserById(payload.sub) : undefined;
      if (!user) return oauthError(reply, 401, 'invalid_token', 'Unknown subject');
      return reply.send({
        sub: user.id,
        email: user.email,
        email_verified: true,
        name: user.name,
        tenant_id: user.tenantId,
        role: user.role,
        title: user.title,
        territory: user.territory,
      });
    } catch {
      return oauthError(reply, 401, 'invalid_token', 'Token is not valid');
    }
  });

  app.post('/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    if (body.token) refreshTokens.delete(body.token);
    return reply.code(200).send({});
  });

  /** Resolve the verification key for a JWS header, by `kid`. */
  async function resolveLocalKey(header: { kid?: string }): Promise<KeyLike> {
    const jwk = keyring.jwks().keys.find((k) => k.kid === header.kid) ?? keyring.active.publicJwk;
    const key = await importJWK(jwk, 'RS256');
    if (key instanceof Uint8Array) throw new Error('Unexpected symmetric key in keyring');
    return key;
  }

  // Expire authorization codes and refresh grants without waiting for a request.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of codes) if (value.expiresAt < now) codes.delete(key);
    for (const [key, value] of refreshTokens) if (value.expiresAt < now) refreshTokens.delete(key);
  }, 30_000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.decorate('directory', directory);
  app.decorate('keyring', keyring);

  return app;
}

/** Accepts `client_secret_basic` and `client_secret_post`, in that order. */
function resolveClientCredentials(
  authorization: string | undefined,
  body: Record<string, string | undefined>,
): { clientId?: string; clientSecret?: string } {
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator > 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    }
  }
  const result: { clientId?: string; clientSecret?: string } = {};
  if (body.client_id) result.clientId = body.client_id;
  if (body.client_secret) result.clientSecret = body.client_secret;
  return result;
}

declare module 'fastify' {
  interface FastifyInstance {
    directory: Directory;
    keyring: Keyring;
  }
}
