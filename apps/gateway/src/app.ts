import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { toGatewayError } from '@mcpgateway/shared';
import Fastify, { type FastifyInstance } from 'fastify';

import './context.js';
import { authPlugin } from './plugins/auth.js';
import { telemetryPlugin } from './plugins/telemetry.js';
import { tenantContextPlugin } from './plugins/tenant-context.js';
import { createApiRoutes } from './routes/api.js';
import { createBffRoutes } from './routes/bff.js';
import { createHealthRoutes } from './routes/health.js';
import { createToolRoutes } from './routes/tools.js';
import type { GatewayServices } from './services.js';
import { SessionStore } from './session.js';

/**
 * Assembles the gateway.
 *
 * Registration order is the pipeline order. Fastify runs hooks in the order
 * their plugins were registered, so this function is the authoritative
 * statement of how a request is processed.
 */
export async function buildGateway(services: GatewayServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    // Fastify's default 100 char limit truncates the SOQL and SQL that tool
    // routes legitimately receive in error messages.
    ajv: { customOptions: { allErrors: false } },
  });

  const sessions = new SessionStore(services.redis);

  app.decorate('services', services);

  // --- 1. telemetry --------------------------------------------------------
  await app.register(telemetryPlugin, { logger: services.logger });

  await app.register(cookie, {
    secret: services.config.SESSION_COOKIE_SECRET,
    hook: 'onRequest',
  });

  await app.register(cors, {
    // The console runs on its own origin and must send the session cookie.
    origin: [services.config.DASHBOARD_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
    exposedHeaders: [
      'x-request-id',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-scope',
      'retry-after',
    ],
  });

  // --- 2. auth, 3. tenant-context -----------------------------------------
  await app.register(authPlugin, { services, sessions });
  await app.register(tenantContextPlugin, { services });

  // --- routes --------------------------------------------------------------
  await app.register(createHealthRoutes(services));
  await app.register(createBffRoutes(services, sessions));
  await app.register(createApiRoutes(services));

  // Stages 4 to 8 live inside this encapsulation context, which also carries
  // its own error handler so that a refusal is audited before it is returned.
  await app.register(createToolRoutes(services));

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
    }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    const failure = toGatewayError(error);

    if (failure.status >= 500) {
      services.logger.error(
        { err: error, requestId: request.requestId, url: request.url },
        'unhandled gateway error',
      );
    }

    if (failure.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(failure.retryAfterSeconds));
    }

    return reply.code(failure.status).send(failure.toResponseBody());
  });

  return app;
}
