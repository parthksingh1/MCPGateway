/**
 * Load test.
 *
 * Drives real tool calls through the running gateway and reports the latency
 * distribution and throughput it actually achieved. Percentiles come from every
 * recorded sample rather than a sliding estimate, because a benchmark whose
 * numbers cannot be reproduced is worse than no benchmark.
 *
 *   pnpm bench
 *   pnpm bench -- --duration 60 --connections 100 --tool sf.list_opportunities
 *   pnpm bench -- --json > docs/benchmark.json
 *
 * What it measures is the whole enforcement path: token verification, rate
 * limit, policy evaluation (itself a network call), token exchange, the
 * upstream MCP call, and the audit append. It is not a microbenchmark of any
 * one of those.
 */
import { writeFile } from 'node:fs/promises';

const DEFAULTS = {
  gateway: process.env.GATEWAY_URL ?? 'http://localhost:8080',
  issuer: process.env.OIDC_ISSUER ?? 'http://localhost:9000',
  email: 'alice.chen@acme-corp.com',
  password: 'Passw0rd!',
  server: 'salesforce',
  tool: 'sf.list_opportunities',
  durationSeconds: 30,
  connections: 50,
  warmupSeconds: 3,
};

interface Options {
  gateway: string;
  issuer: string;
  email: string;
  password: string;
  server: string;
  tool: string;
  durationSeconds: number;
  connections: number;
  warmupSeconds: number;
  json: boolean;
  out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { ...DEFAULTS, json: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--gateway':
        options.gateway = value ?? options.gateway;
        i += 1;
        break;
      case '--issuer':
        options.issuer = value ?? options.issuer;
        i += 1;
        break;
      case '--email':
        options.email = value ?? options.email;
        i += 1;
        break;
      case '--tool':
        options.tool = value ?? options.tool;
        i += 1;
        break;
      case '--server':
        options.server = value ?? options.server;
        i += 1;
        break;
      case '--duration':
        options.durationSeconds = Number(value ?? options.durationSeconds);
        i += 1;
        break;
      case '--connections':
        options.connections = Number(value ?? options.connections);
        i += 1;
        break;
      case '--out':
        options.out = value ?? null;
        i += 1;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        break;
    }
  }
  return options;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(digest).toString('base64url');
}

/** Signs in through the real authorization-code + PKCE flow. */
async function obtainToken(options: Options): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = 'http://localhost:8080/auth/callback';

  const form = new URLSearchParams({
    response_type: 'code',
    client_id: 'dashboard-bff',
    redirect_uri: redirectUri,
    scope:
      'openid profile email salesforce:read salesforce:read.team postgres:read postgres:query policy:evaluate',
    state: 'bench',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    email: options.email,
    password: options.password,
  });

  const authorize = await fetch(`${options.issuer}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });

  const location = authorize.headers.get('location');
  if (!location) {
    throw new Error(`Sign-in failed (status ${authorize.status}). Is the identity provider up?`);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('No authorization code in the redirect');

  const token = await fetch(`${options.issuer}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('dashboard-bff:dashboard-secret-change-me').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });

  if (!token.ok) throw new Error(`Token endpoint returned ${token.status}`);
  return ((await token.json()) as { access_token: string }).access_token;
}

interface Sample {
  latencyMs: number;
  status: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function runWorker(
  options: Options,
  token: string,
  deadline: number,
  samples: Sample[],
): Promise<void> {
  const url = `${options.gateway}/v1/servers/${options.server}/tools/${options.tool}`;
  const body = JSON.stringify({ arguments: { limit: 10 } });

  while (Date.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      });
      // Drain the body: leaving it unread keeps the socket busy and would
      // understate latency while overstating throughput.
      await response.arrayBuffer();
      samples.push({ latencyMs: performance.now() - startedAt, status: response.status });
    } catch {
      samples.push({ latencyMs: performance.now() - startedAt, status: 0 });
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.json) {
    console.log('\nLoad test');
    console.log(`  gateway      ${options.gateway}`);
    console.log(`  tool         ${options.server}/${options.tool}`);
    console.log(`  connections  ${options.connections}`);
    console.log(
      `  duration     ${options.durationSeconds}s (plus ${options.warmupSeconds}s warm-up)`,
    );
    console.log('');
  }

  const token = await obtainToken(options);

  // Warm-up is discarded. The first calls pay for JIT, connection setup, an
  // uncached token exchange and a cold JWKS fetch, none of which represents
  // steady state.
  const warmupSamples: Sample[] = [];
  await Promise.all(
    Array.from({ length: Math.min(8, options.connections) }, () =>
      runWorker(options, token, Date.now() + options.warmupSeconds * 1000, warmupSamples),
    ),
  );

  const samples: Sample[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + options.durationSeconds * 1000;

  await Promise.all(
    Array.from({ length: options.connections }, () => runWorker(options, token, deadline, samples)),
  );

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const byStatus = samples.reduce<Record<number, number>>((acc, sample) => {
    acc[sample.status] = (acc[sample.status] ?? 0) + 1;
    return acc;
  }, {});

  const successful = samples.filter((sample) => sample.status === 200).length;
  const rateLimited = byStatus[429] ?? 0;

  const result = {
    configuration: {
      gateway: options.gateway,
      tool: `${options.server}/${options.tool}`,
      connections: options.connections,
      durationSeconds: options.durationSeconds,
      warmupSeconds: options.warmupSeconds,
      warmupRequestsDiscarded: warmupSamples.length,
    },
    throughput: {
      requests: samples.length,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      requestsPerSecond: Number((samples.length / elapsedSeconds).toFixed(1)),
      successfulPerSecond: Number((successful / elapsedSeconds).toFixed(1)),
    },
    latencyMs: {
      min: Number((latencies[0] ?? 0).toFixed(2)),
      p50: Number(percentile(latencies, 50).toFixed(2)),
      p75: Number(percentile(latencies, 75).toFixed(2)),
      p90: Number(percentile(latencies, 90).toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      p99: Number(percentile(latencies, 99).toFixed(2)),
      max: Number((latencies[latencies.length - 1] ?? 0).toFixed(2)),
      mean: Number(
        (latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)).toFixed(
          2,
        ),
      ),
    },
    outcomes: {
      successful,
      rateLimited,
      errors: samples.length - successful - rateLimited,
      byStatus,
    },
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: (await import('node:os')).cpus().length,
      timestamp: new Date().toISOString(),
    },
  };

  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const row = (label: string, value: string): string => `  ${label.padEnd(22)}${value}`;
  console.log('Throughput');
  console.log(row('requests', String(result.throughput.requests)));
  console.log(row('elapsed', `${result.throughput.elapsedSeconds}s`));
  console.log(row('requests/sec', String(result.throughput.requestsPerSecond)));
  console.log(row('successful/sec', String(result.throughput.successfulPerSecond)));
  console.log('\nLatency (ms)');
  for (const key of ['min', 'p50', 'p75', 'p90', 'p95', 'p99', 'max', 'mean'] as const) {
    console.log(row(key, String(result.latencyMs[key])));
  }
  console.log('\nOutcomes');
  console.log(row('200 ok', String(result.outcomes.successful)));
  console.log(row('429 rate limited', String(result.outcomes.rateLimited)));
  console.log(row('other', String(result.outcomes.errors)));
  console.log(
    `\nRecord these numbers in docs/BENCHMARKS.md along with the machine they came from.\n`,
  );

  if (rateLimited > samples.length * 0.5) {
    console.log(
      'Note: more than half the requests were rate limited, so the latency figures\n' +
        'describe refusals rather than work. Raise the tenant limit on the rate limits\n' +
        'page, or run against a tenant on the enterprise plan, before quoting these.\n',
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\nLoad test failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Is the stack running? Try `make demo` first.\n');
  process.exit(1);
});
