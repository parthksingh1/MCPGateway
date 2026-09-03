import { extractBearer, verifyAccessToken } from '@mcpgateway/auth';
import { UnauthenticatedError } from '@mcpgateway/shared';
import { annotate, GatewayAttr } from '@mcpgateway/telemetry';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import type { GatewayServices } from '../services.js';
import { SESSION_COOKIE, type SessionStore } from '../session.js';

export interface AuthPluginOptions {
  readonly services: GatewayServices;
  readonly sessions: SessionStore;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler that populates `request.principal` or refuses the request. */
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

/**
 * Stage 2 of the pipeline.
 *
 * Two credential shapes reach the gateway and both end at the same place — a
 * verified token and a `Principal` derived only from its claims:
 *
 *   Authorization: Bearer   an agent or service calling the API directly
 *   session cookie          the console, whose tokens never reach the browser
 *
 * The cookie is an opaque id; the access token behind it is fetched from Redis
 * server-side. Nothing about the caller is read from a header, a query
 * parameter or the request body.
 */
const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  const { services, sessions } = options;

  app.decorateRequest('principal', undefined);
  app.decorateRequest('inboundToken', undefined);

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const bearer = extractBearer(request.headers.authorization);
    let token = bearer;

    if (!token) {
      const sessionId = request.cookies[SESSION_COOKIE];
      const session = await sessions.get(sessionId);
      if (session) token = session.accessToken;
    }

    if (!token) {
      throw new UnauthenticatedError(
        'Present an access token as a bearer credential, or sign in to the console.',
      );
    }

    const { principal } = await verifyAccessToken(token, services.jwks, {
      issuer: services.config.OIDC_ISSUER,
    });

    request.principal = principal;
    request.inboundToken = token;

    annotate({
      [GatewayAttr.TENANT_ID]: principal.tenantId,
      [GatewayAttr.USER_ID]: principal.subject,
      [GatewayAttr.USER_ROLE]: principal.role,
    });
  };

  app.decorate('authenticate', authenticate);
};

export const authPlugin = fp(plugin, { name: 'gateway-auth' });
