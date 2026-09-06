import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
} from '@opentelemetry/api';

/**
 * The instruments behind the two Grafana dashboards.
 *
 * ## Why these are lazy
 *
 * `metrics.getMeter()` resolves against whatever MeterProvider is registered at
 * the moment it is called, and unlike the tracer API it returns no proxy — a
 * meter obtained before the SDK starts is a no-op meter forever.
 *
 * This module is reached through the package barrel, so importing
 * `startTelemetry` from `@mcpgateway/telemetry` also evaluates this file, which
 * would otherwise create every instrument *before* the SDK was configured. The
 * symptom is quiet and easy to miss: auto-instrumentation metrics arrive
 * normally while every application metric silently goes nowhere, and the
 * dashboards read "No data" with no error anywhere to explain it.
 *
 * Deferring creation until first use removes the ordering requirement
 * altogether.
 *
 * Latency histograms use explicit millisecond boundaries chosen around the
 * shapes this system actually produces: a cached token exchange is sub-
 * millisecond, an uncached one is a network round trip, and a warehouse query
 * can reach into the hundreds of milliseconds. Default exponential buckets put
 * almost every sample in one bucket and make the p99 useless.
 */

let cachedMeter: Meter | undefined;

function meter(): Meter {
  cachedMeter ??= metrics.getMeter('mcpgateway', '0.1.0');
  return cachedMeter;
}

/** A counter that binds to the real meter on first use. */
function lazyCounter(name: string, options: Parameters<Meter['createCounter']>[1]) {
  let instrument: Counter<Attributes> | undefined;
  return {
    add(value: number, attributes?: Attributes): void {
      instrument ??= meter().createCounter(name, options);
      instrument.add(value, attributes);
    },
  };
}

/** A histogram that binds to the real meter on first use. */
function lazyHistogram(name: string, options: Parameters<Meter['createHistogram']>[1]) {
  let instrument: Histogram<Attributes> | undefined;
  return {
    record(value: number, attributes?: Attributes): void {
      instrument ??= meter().createHistogram(name, options);
      instrument.record(value, attributes);
    },
  };
}

export const toolInvocations = lazyCounter('mcpgw.tool.invocations', {
  description: 'Tool calls received by the gateway',
  unit: '{call}',
});

export const toolLatency = lazyHistogram('mcpgw.tool.duration', {
  description: 'End-to-end tool call duration measured at the gateway',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200] },
});

export const tokenExchangeLatency = lazyHistogram('mcpgw.token_exchange.duration', {
  description: 'RFC 8693 token exchange duration, tagged with cache outcome',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500] },
});

export const tokenExchangeTotal = lazyCounter('mcpgw.token_exchange.total', {
  description: 'Token exchanges, tagged cached=true|false and outcome',
  unit: '{exchange}',
});

export const policyDecisions = lazyCounter('mcpgw.policy.decisions', {
  description: 'Policy decisions by rule and effect',
  unit: '{decision}',
});

export const policyLatency = lazyHistogram('mcpgw.policy.duration', {
  description: 'Policy evaluation duration',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 25, 50, 100, 250] },
});

export const rateLimitDecisions = lazyCounter('mcpgw.rate_limit.decisions', {
  description: 'Token bucket outcomes by scope',
  unit: '{decision}',
});

export const rateLimitLatency = lazyHistogram('mcpgw.rate_limit.duration', {
  description: 'Redis round trip for the atomic token bucket script',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50] },
});

export const auditWrites = lazyCounter('mcpgw.audit.writes', {
  description: 'Audit rows appended, tagged by outcome',
  unit: '{row}',
});

export const upstreamLatency = lazyHistogram('mcpgw.upstream.duration', {
  description: 'Duration of the call to the target MCP server',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 200, 400, 800, 1600] },
});

export function getMeter(): Meter {
  return meter();
}
