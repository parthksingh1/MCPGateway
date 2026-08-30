import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly endpoint?: string;
  readonly environment?: string;
  readonly disabled?: boolean;
  readonly diagnostics?: boolean;
}

export interface TelemetryHandle {
  readonly serviceName: string;
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Boots the OpenTelemetry SDK for one process.
 *
 * Must run before any instrumented module is imported, which is why every
 * service calls this from a dedicated `instrumentation.ts` entrypoint that is
 * loaded ahead of the application module. Traces and metrics both go to the
 * local collector over OTLP/HTTP; the collector fans them out to Jaeger and
 * Prometheus. Logs are written to stdout by pino with the active trace and span
 * ids injected, and are correlated in Grafana on `trace_id`.
 */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  const {
    serviceName,
    serviceVersion = process.env.SERVICE_VERSION ?? '0.1.0',
    endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    environment = process.env.NODE_ENV ?? 'development',
    disabled = process.env.OTEL_SDK_DISABLED === 'true',
    diagnostics = process.env.OTEL_DIAG === 'true',
  } = options;

  if (disabled) {
    return { serviceName, enabled: false, shutdown: async () => undefined };
  }

  if (diagnostics) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment.name': environment,
    'service.namespace': 'mcpgateway',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [
      new HttpInstrumentation({
        // Liveness and readiness probes would otherwise dominate the trace store.
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/healthz') || url.startsWith('/readyz') || url === '/metrics';
        },
        applyCustomAttributesOnSpan: (span, request) => {
          const route = (request as { url?: string }).url;
          if (route) span.setAttribute(ATTR_HTTP_ROUTE, route.split('?')[0] ?? route);
        },
      }),
      new UndiciInstrumentation(),
      new FastifyInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await sdk.shutdown();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown();
    });
  }

  return { serviceName, enabled: true, shutdown };
}
