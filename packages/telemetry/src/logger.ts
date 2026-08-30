import pino, { type Logger, type LoggerOptions } from 'pino';

import { currentSpanId, currentTraceId } from './trace.js';

export type { Logger } from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  'access_token',
  'refresh_token',
  'client_secret',
  'password',
  'token',
];

export interface CreateLoggerOptions {
  readonly serviceName: string;
  readonly level?: string;
  readonly pretty?: boolean;
}

/**
 * Structured logger. Every record carries `service`, and `trace_id`/`span_id`
 * whenever a span is active, which is what makes the Loki -> Tempo/Jaeger jump
 * in Grafana work without any per-call-site plumbing.
 *
 * Secrets are redacted by path rather than by convention so that a stray
 * `logger.info({ headers })` cannot leak a bearer token.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const pretty = options.pretty ?? process.env.NODE_ENV === 'development';

  const config: LoggerOptions = {
    level,
    base: { service: options.serviceName },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const traceId = currentTraceId();
      const spanId = currentSpanId();
      if (!traceId) return {};
      return spanId ? { trace_id: traceId, span_id: spanId } : { trace_id: traceId };
    },
  };

  if (pretty) {
    return pino({
      ...config,
      transport: {
        target: 'pino/file',
        options: { destination: 1 },
      },
    });
  }

  return pino(config);
}
