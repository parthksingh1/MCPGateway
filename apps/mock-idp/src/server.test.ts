import { createPkcePair } from '@mcpgateway/auth';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildIdp, ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from './server.js';

const ISSUER = 'http://localhost:9000';
const REDIRECT_URI = 'http://localhost:8080/auth/callback';
const DASHBOARD_AUTH = Buffer.from('dashboard-bff:dashboard-secret-change-me').toString('base64');
const GATEWAY_AUTH = Buffer.from('mcp-gateway:gateway-secret-change-me').toString('base64');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildIdp({ issuer: ISSUER });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const SCOPES =
  'openid profile email salesforce:read salesforce:read.team salesforce:write postgres:read postgres:query';

/** Drive the full authorization-code + PKCE flow and return the access token. */
async function signIn(email: string, scope = SCOPES): Promise<string> {
  const pkce = createPkcePair();
  const authorize = await app.inject({
    method: 'POST',
    url: '/authorize',
    payload: {
      response_type: 'code',
      client_id: 'dashboard-bff',
      redirect_uri: REDIRECT_URI,
      scope,
      state: 'state-1',
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      email,
      password: 'Passw0rd!',
    },
  });

  expect(authorize.statusCode).toBe(302);
  const location = new URL(authorize.headers.location as string);
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { authorization: `Basic ${DASHBOARD_AUTH}` },
    payload: {
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.codeVerifier,
    },
  });

  expect(token.statusCode).toBe(200);
  return token.json<{ access_token: string }>().access_token;
}

async function exchange(
  subjectToken: string,
  audience: string,
  scope?: string,
): Promise<ReturnType<typeof app.inject> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: '/token',
    headers: { authorization: `Basic ${GATEWAY_AUTH}` },
    payload: {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      audience,
      ...(scope ? { scope } : {}),
    },
  });
}

describe('discovery', () => {
  it('publishes the endpoints and grants a client needs', async () => {
    const response = await app.inject({ url: '/.well-known/openid-configuration' });
    const body = response.json<Record<string, unknown>>();

    expect(body.issuer).toBe(ISSUER);
    expect(body.grant_types_supported).toContain(TOKEN_EXCHANGE_GRANT);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('serves a key set with a kid on every key', async () => {
    const response = await app.inject({ url: '/jwks' });
    const body = response.json<{ keys: { kid?: string; kty?: string }[] }>();

    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(key.kid).toBeTruthy();
      // A published key set must never contain private or symmetric material.
      expect(key.kty).toBe('RSA');
      expect(key).not.toHaveProperty('d');
    }
  });
});

describe('authorization code flow', () => {
  it('issues an access token for valid credentials', async () => {
    const token = await signIn('alice.chen@acme-corp.com');
    const claims = decodeJwt(token);

    expect(claims.sub).toBe('usr_alice');
    expect(claims.tenant_id).toBe('acme-corp');
    expect(claims.role).toBe('analyst');
  });

  it('re-renders the sign-in page on bad credentials', async () => {
    const pkce = createPkcePair();
    const response = await app.inject({
      method: 'POST',
      url: '/authorize',
      payload: {
        response_type: 'code',
        client_id: 'dashboard-bff',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        email: 'alice.chen@acme-corp.com',
        password: 'wrong',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('not valid');
  });

  it('rejects an unregistered redirect_uri', async () => {
    const pkce = createPkcePair();
    const response = await app.inject({
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: 'dashboard-bff',
        redirect_uri: 'https://attacker.example/callback',
        scope: 'openid',
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_request');
  });

  it('rejects a plain code challenge', async () => {
    const response = await app.inject({
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: 'dashboard-bff',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'plain',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a mismatched PKCE verifier', async () => {
    const pkce = createPkcePair();
    const authorize = await app.inject({
      method: 'POST',
      url: '/authorize',
      payload: {
        response_type: 'code',
        client_id: 'dashboard-bff',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        email: 'alice.chen@acme-corp.com',
        password: 'Passw0rd!',
      },
    });
    const code = new URL(authorize.headers.location as string).searchParams.get('code');

    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: `Basic ${DASHBOARD_AUTH}` },
      payload: {
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: REDIRECT_URI,
        code_verifier: createPkcePair().codeVerifier,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_grant');
  });

  it('treats an authorization code as single use', async () => {
    const pkce = createPkcePair();
    const authorize = await app.inject({
      method: 'POST',
      url: '/authorize',
      payload: {
        response_type: 'code',
        client_id: 'dashboard-bff',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        email: 'bob.martinez@acme-corp.com',
        password: 'Passw0rd!',
      },
    });
    const code = new URL(authorize.headers.location as string).searchParams.get('code') as string;
    const payload = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.codeVerifier,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: `Basic ${DASHBOARD_AUTH}` },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: `Basic ${DASHBOARD_AUTH}` },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(400);
  });

  it('rejects a client that cannot authenticate', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        authorization: `Basic ${Buffer.from('dashboard-bff:wrong').toString('base64')}`,
      },
      payload: { grant_type: 'authorization_code', code: 'x', code_verifier: 'y' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toBe('invalid_client');
  });
});

describe('token exchange (RFC 8693)', () => {
  it('keeps the caller as the subject and records the gateway as the actor', async () => {
    const subjectToken = await signIn('alice.chen@acme-corp.com');
    const response = await exchange(subjectToken, 'mcp:salesforce');

    expect(response.statusCode).toBe(200);
    const body = response.json<{ access_token: string; issued_token_type: string }>();
    expect(body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);

    const claims = decodeJwt(body.access_token);
    expect(claims.sub).toBe('usr_alice');
    expect(claims.aud).toBe('mcp:salesforce');
    expect(claims.act).toEqual({ sub: 'mcp-gateway' });
  });

  it('restricts the exchanged token to the audience own namespace', async () => {
    const subjectToken = await signIn('alice.chen@acme-corp.com');
    const response = await exchange(subjectToken, 'mcp:salesforce');
    const claims = decodeJwt(response.json<{ access_token: string }>().access_token);

    const scopes = String(claims.scope).split(' ');
    expect(scopes.every((scope) => scope.startsWith('salesforce:'))).toBe(true);
    expect(scopes).not.toContain('postgres:read');
  });

  it('gives a manager strictly more than an analyst for the same audience', async () => {
    const analyst = await exchange(await signIn('alice.chen@acme-corp.com'), 'mcp:salesforce');
    const manager = await exchange(await signIn('bob.martinez@acme-corp.com'), 'mcp:salesforce');

    const analystScopes = String(
      decodeJwt(analyst.json<{ access_token: string }>().access_token).scope,
    ).split(' ');
    const managerScopes = String(
      decodeJwt(manager.json<{ access_token: string }>().access_token).scope,
    ).split(' ');

    expect(analystScopes).toEqual(['salesforce:read']);
    expect(managerScopes).toContain('salesforce:read.team');
    expect(analystScopes.every((scope) => managerScopes.includes(scope))).toBe(true);
  });

  it('cannot widen: asking for a scope the subject lacks yields nothing extra', async () => {
    const subjectToken = await signIn('alice.chen@acme-corp.com');
    const response = await exchange(subjectToken, 'mcp:salesforce', 'salesforce:read.all');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_scope');
  });

  it('cannot widen even when the subject token was narrow to begin with', async () => {
    const narrow = await signIn('bob.martinez@acme-corp.com', 'openid salesforce:read');
    const response = await exchange(narrow, 'mcp:salesforce', 'salesforce:write');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_scope');
  });

  it('rejects an unverifiable subject token', async () => {
    const response = await exchange('not-a-jwt', 'mcp:salesforce');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_grant');
  });

  it('rejects an unsupported subject_token_type', async () => {
    const subjectToken = await signIn('alice.chen@acme-corp.com');
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: `Basic ${GATEWAY_AUTH}` },
      payload: {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        audience: 'mcp:salesforce',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses the grant for a client not registered to perform it', async () => {
    const subjectToken = await signIn('alice.chen@acme-corp.com');
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: `Basic ${DASHBOARD_AUTH}` },
      payload: {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience: 'mcp:salesforce',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('unauthorized_client');
  });

  it('issues a short-lived token', async () => {
    const subjectToken = await signIn('alice.chen@acme-corp.com');
    const response = await exchange(subjectToken, 'mcp:postgres');
    const body = response.json<{ expires_in: number }>();
    expect(body.expires_in).toBeLessThanOrEqual(300);
  });
});

describe('introspection and userinfo', () => {
  it('describes an active token', async () => {
    const token = await signIn('grace.kim@globex.io');
    const response = await app.inject({ method: 'POST', url: '/introspect', payload: { token } });
    const body = response.json<{ active: boolean; sub: string; tenant_id: string }>();

    expect(body.active).toBe(true);
    expect(body.sub).toBe('usr_grace');
    expect(body.tenant_id).toBe('globex');
  });

  it('reports an unparseable token as inactive rather than erroring', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/introspect',
      payload: { token: 'garbage' },
    });
    expect(response.json<{ active: boolean }>().active).toBe(false);
  });

  it('returns profile details for a bearer token', async () => {
    const token = await signIn('mia.torres@initech.dev');
    const response = await app.inject({
      url: '/userinfo',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json<{ email: string; role: string }>()).toMatchObject({
      email: 'mia.torres@initech.dev',
      role: 'viewer',
    });
  });

  it('requires a bearer token for userinfo', async () => {
    const response = await app.inject({ url: '/userinfo' });
    expect(response.statusCode).toBe(401);
  });
});
