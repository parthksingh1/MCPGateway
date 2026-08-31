import { BadRequestError, UpstreamUnavailableError } from '@mcpgateway/shared';
import { describe, expect, it, vi } from 'vitest';

import { OAuthClient, TOKEN_EXCHANGE_GRANT, ACCESS_TOKEN_TYPE } from './oauth-client.js';

const ISSUER = 'http://localhost:9000';
const INTERNAL = 'http://identity:9000';

function discoveryDocument(issuer = ISSUER): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/userinfo`,
    introspection_endpoint: `${issuer}/introspect`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('OAuthClient discovery', () => {
  it('memoises the discovery document', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(discoveryDocument()));
    const client = new OAuthClient({ issuer: ISSUER, clientId: 'c', fetchImpl: impl });

    await client.metadata();
    await client.metadata();
    expect(calls).toHaveLength(1);
  });

  it('does not memoise a failure', async () => {
    let attempt = 0;
    const { impl } = stubFetch(() => {
      attempt += 1;
      return attempt === 1 ? jsonResponse({}, 503) : jsonResponse(discoveryDocument());
    });
    const client = new OAuthClient({ issuer: ISSUER, clientId: 'c', fetchImpl: impl });

    await expect(client.metadata()).rejects.toThrow(UpstreamUnavailableError);
    await expect(client.metadata()).resolves.toMatchObject({ issuer: ISSUER });
  });

  it('rejects a provider that announces a different issuer', async () => {
    const { impl } = stubFetch(() => jsonResponse(discoveryDocument('http://elsewhere')));
    const client = new OAuthClient({ issuer: ISSUER, clientId: 'c', fetchImpl: impl });
    await expect(client.metadata()).rejects.toThrow(/issuer mismatch/);
  });

  it('rebases back-channel endpoints onto the reachable host but leaves the browser URL alone', async () => {
    const { impl } = stubFetch(() => jsonResponse(discoveryDocument()));
    const client = new OAuthClient({
      issuer: ISSUER,
      baseUrl: INTERNAL,
      clientId: 'c',
      fetchImpl: impl,
    });

    const meta = await client.metadata();
    expect(meta.token_endpoint).toBe(`${INTERNAL}/token`);
    expect(meta.jwks_uri).toBe(`${INTERNAL}/jwks`);
    // The browser must be sent to the address it can actually resolve.
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/authorize`);
  });

  it('surfaces a network failure as an upstream error', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new OAuthClient({ issuer: ISSUER, clientId: 'c', fetchImpl: impl });
    await expect(client.metadata()).rejects.toThrow(UpstreamUnavailableError);
  });
});

describe('OAuthClient authorization URL', () => {
  it('always carries PKCE parameters', async () => {
    const { impl } = stubFetch(() => jsonResponse(discoveryDocument()));
    const client = new OAuthClient({ issuer: ISSUER, clientId: 'dashboard-bff', fetchImpl: impl });

    const url = new URL(
      await client.authorizationUrl({
        redirectUri: 'http://localhost:8080/auth/callback',
        scopes: ['openid', 'salesforce:read'],
        state: 'state-value',
        codeChallenge: 'challenge-value',
        nonce: 'nonce-value',
      }),
    );

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('scope')).toBe('openid salesforce:read');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('nonce')).toBe('nonce-value');
  });
});

describe('OAuthClient token requests', () => {
  it('sends RFC 8693 parameters and authenticates with client_secret_basic', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith('/token')
        ? jsonResponse({
            access_token: 'downstream-token',
            token_type: 'Bearer',
            expires_in: 300,
            scope: 'salesforce:read',
            issued_token_type: ACCESS_TOKEN_TYPE,
          })
        : jsonResponse(discoveryDocument()),
    );
    const client = new OAuthClient({
      issuer: ISSUER,
      clientId: 'mcp-gateway',
      clientSecret: 'shh',
      fetchImpl: impl,
    });

    const result = await client.exchangeToken({
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });

    expect(result.access_token).toBe('downstream-token');

    const tokenCall = calls.find((c) => c.url.endsWith('/token'));
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    expect(body.get('grant_type')).toBe(TOKEN_EXCHANGE_GRANT);
    expect(body.get('subject_token')).toBe('caller-token');
    expect(body.get('subject_token_type')).toBe(ACCESS_TOKEN_TYPE);
    expect(body.get('audience')).toBe('mcp:salesforce');
    expect(body.get('scope')).toBe('salesforce:read');
    // The secret travels in the Authorization header, never in the body.
    expect(body.get('client_secret')).toBeNull();

    const headers = tokenCall?.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.authorization.slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('mcp-gateway:shh');
  });

  it('falls back to client_id in the body for a public client', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith('/token')
        ? jsonResponse({ access_token: 't', token_type: 'Bearer', expires_in: 60 })
        : jsonResponse(discoveryDocument()),
    );
    const client = new OAuthClient({ issuer: ISSUER, clientId: 'claude-desktop', fetchImpl: impl });

    await client.exchangeAuthorizationCode({
      code: 'code',
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeVerifier: 'verifier',
    });

    const tokenCall = calls.find((c) => c.url.endsWith('/token'));
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    expect(body.get('client_id')).toBe('claude-desktop');
    expect(body.get('code_verifier')).toBe('verifier');
    expect((tokenCall?.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('maps an OAuth error response onto a BadRequestError carrying the code', async () => {
    const { impl } = stubFetch((url) =>
      url.endsWith('/token')
        ? jsonResponse({ error: 'invalid_scope', error_description: 'no scopes for audience' }, 400)
        : jsonResponse(discoveryDocument()),
    );
    const client = new OAuthClient({
      issuer: ISSUER,
      clientId: 'mcp-gateway',
      clientSecret: 'shh',
      fetchImpl: impl,
    });

    await expect(
      client.exchangeToken({ subjectToken: 's', audience: 'mcp:salesforce' }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      client.exchangeToken({ subjectToken: 's', audience: 'mcp:salesforce' }),
    ).rejects.toThrow(/invalid_scope/);
  });

  it('sends the refresh and client-credentials grants', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith('/token')
        ? jsonResponse({ access_token: 't', token_type: 'Bearer', expires_in: 60 })
        : jsonResponse(discoveryDocument()),
    );
    const client = new OAuthClient({
      issuer: ISSUER,
      clientId: 'internal-agent',
      clientSecret: 'shh',
      fetchImpl: impl,
    });

    await client.refresh('refresh-value');
    await client.clientCredentials({ tenantId: 'acme-corp', scopes: ['postgres:read'] });

    const bodies = calls
      .filter((c) => c.url.endsWith('/token'))
      .map((c) => new URLSearchParams(String(c.init?.body)));
    expect(bodies[0]?.get('grant_type')).toBe('refresh_token');
    expect(bodies[0]?.get('refresh_token')).toBe('refresh-value');
    expect(bodies[1]?.get('grant_type')).toBe('client_credentials');
    expect(bodies[1]?.get('tenant_id')).toBe('acme-corp');
    expect(bodies[1]?.get('scope')).toBe('postgres:read');
  });

  it('exposes the jwks uri from discovery', async () => {
    const { impl } = stubFetch(() => jsonResponse(discoveryDocument()));
    const client = new OAuthClient({
      issuer: ISSUER,
      baseUrl: INTERNAL,
      clientId: 'c',
      fetchImpl: impl,
    });
    await expect(client.jwksUri()).resolves.toBe(`${INTERNAL}/jwks`);
  });
});
