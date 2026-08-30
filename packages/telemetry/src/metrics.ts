import { metrics, type Attributes, type Counter, type Histogram } from '@opentelemetry/api';

const meter = metrics.getMeter('mcpgateway', '0.1.0');

/**
 * The instruments behind the two Grafana dashboards.
 *
 * Latency histograms use explicit millisecond boundaries chosen around the
 * shapes this system actually produces: a cached token exchange is sub-
 * millisecond, an uncached one is a network round trip, and a warehouse query
 * can reach into the hundreds of milliseconds. Default exponential buckets put
 * almost every sample in one bucket and make the p99 useless.
 */

export const toolInvocations: Counter<Attributes> = meter.createCounter('mcpgw.tool.invocations', {
  description: 'Tool calls received by the gateway',
  unit: '{call}',
});

export const toolLatency: Histogram<Attributes> = meter.createHistogram('mcpgw.tool.duration', {
  description: 'End-to-end tool call duration measured at the gateway',
  unit: 'ms',
  advice: {
    explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200],
  },
});

export const tokenExchangeLatency: Histogram<Attributes> = meter.createHistogram(
  'mcpgw.token_exchange.duration',
  {
    description: 'RFC 8693 token exchange duration, tagged with cache outcome',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500] },
  },
);

export const tokenExchangeTotal: Counter<Attributes> = meter.createCounter(
  'mcpgw.token_exchange.total',
  { description: 'Token exchanges, tagged cached=true|false and outcome', unit: '{exchange}' },
);

export const policyDecisions: Counter<Attributes> = meter.createCounter('mcpgw.policy.decisions', {
  description: 'Policy decisions by rule and effect',
  unit: '{decision}',
});

export const policyLatency: Histogram<Attributes> = meter.createHistogram('mcpgw.policy.duration', {
  description: 'Policy evaluation duration',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 25, 50, 100, 250] },
});

export const rateLimitDecisions: Counter<Attributes> = meter.createCounter(
  'mcpgw.rate_limit.decisions',
  { description: 'Token bucket outcomes by scope', unit: '{decision}' },
);

export const rateLimitLatency: Histogram<Attributes> = meter.createHistogram(
  'mcpgw.rate_limit.duration',
  {
    description: 'Redis round trip for the atomic token bucket script',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50] },
  },
);

export const auditWrites: Counter<Attributes> = meter.createCounter('mcpgw.audit.writes', {
  description: 'Audit rows appended, tagged by outcome',
  unit: '{row}',
});

export const upstreamLatency: Histogram<Attributes> = meter.createHistogram(
  'mcpgw.upstream.duration',
  {
    description: 'Duration of the call to the target MCP server',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 200, 400, 800, 1600] },
  },
);

export function getMeter() {
  return meter;
}
