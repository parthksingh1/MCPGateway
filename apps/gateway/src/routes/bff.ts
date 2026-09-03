import { createPkcePair, verifyAccessToken } from '@mcpgateway/auth';
import { BadRequestError, randomToken } from '@mcpgateway/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import type { GatewayServices } from '../services.js';
import { LOGIN_STATE_COOKIE, SESSION_COOKIE, type SessionStore } from '../session.js';

const CONSOLE_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'salesforce:read',
  'salesforce:read.team',
  'salesforce:read.all',
  'salesforce:write',
  'postgres:read',
  'postgres:query',
  'postgres:admin',
  'policy:evaluate',
  'policy:read',
  'gateway:admin',
];

/**
 * Backend-for-frontend for the console.
 *
 * The console is a single-page app and therefore an untrusted environment for a
 * bearer token: anything it can read, a cross-site scripting bug can exfiltrate.
 * So the OAuth flow terminates here. The browser only ever receives an opaque,
 * httpOnly, SameSite=Lax session cookie; the access and refresh tokens stay in
 * Redis, and the gateway attaches them server-side.
 *
 * PKCE is used even though this is a confidential client. OAuth 2.1 requires it
 * for every authorization-code flow, and it costs nothing.
 */
export function createBffRoutes(
  services: GatewayServices,
  sessions: SessionStore,
): FastifyPluginAsync {
  const secure = services.config.NODE_ENV === 'production' && services.config.GATEWAY_PUBLIC_URL.startsWith('https');

  return async (app) => {
    app.get<{ Querystring: { redirect?: string } }>('/auth/login', async (request, reply) => {
      const pkce = createPkcePair();
      const state = randomToken(24);

      // Only same-origin relative paths, so the login endpoint cannot be used
      // as an open redirect.
      const requested = request.query.redirect ?? '/';
      const redirectTo = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

      await sessions.putLoginState(state, { codeVerifier: pkce.codeVerifier, redirectTo });

      const url = await services.dashboardOauth.authorizationUrl({
        redirectUri: `${services.config.GATEWAY_PUBLIC_URL}/auth/callback`,
        scopes: CONSOLE_SCOPES,
        state,
        codeChallenge: pkce.codeChallenge,
      });

      return reply
        .setCookie(LOGIN_STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: 'lax',
          secure,
          path: '/',
          maxAge: 600,
        })
        .redirect(url, 302);
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/auth/callback',
      async (request, reply) => {
        const { code, state, error } = request.query;
        if (error) throw new BadRequestError(`The identity provider returned '${error}'`);
        if (!code || !state) throw new BadRequestError('code and state are required');

        // The state must match the cookie as well as exist server-side: the
        // cookie ties the callback to the browser that started the flow.
        if (request.cookies[LOGIN_STATE_COOKIE] !== state) {
          throw new BadRequestError('Login state does not match this browser session');
        }

        const login = await sessions.takeLoginState(state);
        if (!login) throw new BadRequestError('Login state has expired; start again');

        const tokens = await services.dashboardOauth.exchangeAuthorizationCode({
          code,
          redirectUri: `${services.config.GATEWAY_PUBLIC_URL}/auth/callback`,
          codeVerifier: login.codeVerifier,
        });

        const { principal } = await verifyAccessToken(tokens.access_token, services.jwks, {
          issuer: services.config.OIDC_ISSUER,
        });

        const sessionId = await sessions.create({
          subject: principal.subject,
          tenantId: principal.tenantId,
          email: principal.email ?? '',
          name: principal.name ?? principal.subject,
          role: principal.role,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: principal.expiresAt,
          scopes: [...principal.scopes],
        });

        services.logger.info(
          { subject: principal.subject, tenant: principal.tenantId },
          'console session established',
        );

        return reply
          .clearCookie(LOGIN_STATE_COOKIE, { path: '/' })
          .setCookie(SESSION_COOKIE, sessionId, {
            httpOnly: true,
            sameSite: 'lax',
            secure,
            path: '/',
            maxAge: 8 * 60 * 60,
          })
          .redirect(`${services.config.DASHBOARD_ORIGIN}${login.redirectTo}`, 302);
      },
    );

    app.get('/auth/session', async (request, reply) => {
      const session = await sessions.get(request.cookies[SESSION_COOKIE]);
      if (!session) return reply.code(401).send({ authenticated: false });

      const tenant = await services.db.db
        .execute<{ name: string; plan: string } & Record<string, unknown>>(
          sql`SELECT name, plan FROM tenants WHERE id = ${session.tenantId}`,
        )
        .catch(() => null);

      return reply.send({
        authenticated: true,
        user: {
          subject: session.subject,
          email: session.email,
          name: session.name,
          role: session.role,
          tenantId: session.tenantId,
          tenantName: tenant?.rows[0]?.name ?? session.tenantId,
          tenantPlan: tenant?.rows[0]?.plan ?? 'unknown',
          scopes: session.scopes,
        },
        links: {
          traces: services.config.JAEGER_UI_URL,
          metrics: services.config.GRAFANA_URL,
        },
      });
    });

    app.post('/auth/logout', async (request, reply) => {
      // Destroying the server-side record is what actually ends the session;
      // clearing the cookie alone would leave a usable credential in Redis.
      await sessions.destroy(request.cookies[SESSION_COOKIE]);
      return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
    });
  };
}
