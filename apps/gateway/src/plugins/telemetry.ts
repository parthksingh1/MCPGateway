import { randomUUID } from 'node:crypto';

import { currentTraceId, type Logger } from '@mcpgateway/telemetry';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export interface TelemetryPluginOptions {
  readonly logger: Logger;
}

/**
 * Stage 1 of the pipeline.
 *
 * Assigns a request id, echoes it back so a caller can quote it in a support
 * request, and logs one line per completed request with the trace id attached.
 * Health probes are excluded: they are the majority of traffic in a Kubernetes
 * deployment and carry no information.
 */
const plugin: FastifyPluginAsync<TelemetryPluginOptions> = async (app, options) => {
  const { logger } = options;

  app.decorateRequest('requestId', '');

  app.addHook('onRequest', async (request, reply) => {
    const inbound = request.headers['x-request-id'];
    request.requestId = typeof inbound === 'string' && inbound.length <= 200 ? inbound : randomUUID();
    void reply.header('x-request-id', request.requestId);
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/healthz') || request.url.startsWith('/readyz')) return;

    logger.info(
      {
        requestId: request.requestId,
        method: request.method,
        url: request.url.split('?')[0],
        status: reply.statusCode,
        durationMs: Number(reply.elapsedTime.toFixed(2)),
        traceId: currentTraceId(),
        subject: request.principal?.subject,
        tenant: request.principal?.tenantId,
      },
      'request completed',
    );
  });
};

export const telemetryPlugin = fp(plugin, { name: 'gateway-telemetry' });
