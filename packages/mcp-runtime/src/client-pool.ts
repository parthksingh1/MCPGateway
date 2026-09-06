import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Pool of connected MCP clients, one set per destination.
 *
 * The MCP handshake is not free. Measured against this stack, a
 * connect + callTool + close cycle costs about 64 ms, of which roughly 52 ms is
 * `initialize` and transport setup; the call itself is about 12 ms. The gateway
 * makes two upstream calls per request — the policy decision point and the
 * target server — so building a client per call spends around 100 ms per
 * request doing nothing but shaking hands.
 *
 * ## Why this is safe to pool, when the credential is per user
 *
 * The obvious hazard in pooling is sending one caller's token on another
 * caller's request, which is precisely the failure this gateway exists to
 * prevent. Two properties rule it out:
 *
 *  1. **Exclusive checkout.** An entry is removed from the idle set before use
 *     and returned only after the call settles. No two calls ever hold the same
 *     entry, so there is no window in which the credential could be read by
 *     anyone but its owner.
 *
 *  2. **Headers are read at request time from the entry itself**, not captured
 *     at transport construction. The custom `fetch` reads `entry.headers`, which
 *     the caller sets immediately before the call it exclusively owns.
 *
 * The alternative — one shared client with the token resolved from
 * AsyncLocalStorage — would also work in the common case, but it depends on the
 * SDK never issuing a request outside the caller's async context. That is an
 * assumption about somebody else's code with a token-confusion bug as the
 * failure mode, and it is not worth the small extra concurrency.
 *
 * An entry that errors is discarded rather than returned, because a transport
 * that has failed mid-protocol may have a half-consumed response buffered.
 */

export interface PooledUpstream {
  readonly client: Client;
  /** Headers applied to the next request. Set by the exclusive holder. */
  headers: Record<string, string>;
}

/**
 * `client` and `transport` are typed loosely enough that a test can substitute
 * a double for them. Everything this class does with them is close().
 */
export interface PoolEntry extends PooledUpstream {
  readonly transport: { close(): Promise<void> };
  readonly url: string;
  /** Test seam, invoked before the underlying connection is closed. */
  readonly onDiscard?: () => void;
}

export interface ClientPoolOptions {
  /** Maximum idle clients kept per destination. */
  readonly maxIdlePerTarget?: number;
  /** Client name announced during `initialize`. */
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export class UpstreamClientPool {
  private readonly idle = new Map<string, PoolEntry[]>();
  private readonly maxIdle: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private closed = false;

  constructor(options: ClientPoolOptions = {}) {
    this.maxIdle = options.maxIdlePerTarget ?? 32;
    this.clientName = options.clientName ?? 'mcpgateway';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  /**
   * Take a connected client for `url`, run `fn` with it, and return it to the
   * pool. The entry is exclusively held for the duration of `fn`.
   */
  async withClient<T>(
    url: string,
    headers: Record<string, string>,
    fn: (upstream: PooledUpstream) => Promise<T>,
  ): Promise<T> {
    const entry = (await this.take(url)) ?? (await this.build(url, headers));
    entry.headers = headers;

    try {
      const result = await fn(entry);
      this.give(entry);
      return result;
    } catch (error) {
      // A transport that failed mid-protocol may hold a partial response.
      // Discarding costs one handshake; reusing it risks corrupting the next
      // caller's exchange.
      await this.discard(entry);
      throw error;
    }
  }

  private async take(url: string): Promise<PoolEntry | null> {
    const bucket = this.idle.get(url);
    while (bucket && bucket.length > 0) {
      const entry = bucket.pop();
      if (entry) return entry;
    }
    return null;
  }

  private give(entry: PoolEntry): void {
    if (this.closed) {
      void this.discard(entry);
      return;
    }
    // Clear the credential on return so an idle entry never holds one.
    entry.headers = {};

    const bucket = this.idle.get(entry.url) ?? [];
    if (bucket.length >= this.maxIdle) {
      void this.discard(entry);
      return;
    }
    bucket.push(entry);
    this.idle.set(entry.url, bucket);
  }

  private async discard(entry: PoolEntry): Promise<void> {
    entry.onDiscard?.();
    await entry.client.close().catch(() => undefined);
    await entry.transport.close().catch(() => undefined);
  }

  /**
   * Constructs and connects one entry. Overridden in tests to substitute a
   * double, so the checkout discipline above can be exercised without an MCP
   * server — the property under test is whether two callers can hold the same
   * entry, which is a question about this class alone.
   */
  protected async build(url: string, headers: Record<string, string>): Promise<PoolEntry> {
    // One mutable cell, shared by the fetch closure and the entry's accessor.
    // Handing the closure a separate object would mean the headers set by the
    // current holder were never the ones actually sent — a bug that would look
    // like intermittent 401s under load rather than anything obvious.
    //
    // Seeded with the creating caller's headers, because the servers
    // authenticate every request including `initialize`. That caller holds this
    // entry exclusively at this point, so no credential crosses a boundary.
    const state = { headers };

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      // Read at request time, not captured at construction time.
      fetch: (input, init) => {
        const merged = new Headers(init?.headers);
        for (const [key, value] of Object.entries(state.headers)) merged.set(key, value);
        return globalThis.fetch(input, { ...init, headers: merged });
      },
    });

    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      { capabilities: {} },
    );

    // The handshake happens once per pooled entry rather than once per call.
    await client.connect(transport);

    return {
      client,
      transport,
      url,
      get headers() {
        return state.headers;
      },
      set headers(next: Record<string, string>) {
        state.headers = next;
      },
    };
  }

  /** Idle clients per destination. Exposed for readiness reporting. */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [url, bucket] of this.idle) out[url] = bucket.length;
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.idle.values()].flat();
    this.idle.clear();
    await Promise.all(entries.map((entry) => this.discard(entry)));
  }
}
