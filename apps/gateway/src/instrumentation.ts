import { startTelemetry } from '@mcpgateway/telemetry';

// Loaded via `node --import` so the SDK patches http, fastify, pg and ioredis
// before the application module is evaluated.
startTelemetry({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'gateway' });
