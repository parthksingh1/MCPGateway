import type { InvocationEvent } from '@mcpgateway/shared';

export type StreamListener = (event: InvocationEvent) => void;

export interface InvocationStreamOptions {
  /** Events replayed to a client that has just connected. */
  readonly historySize?: number;
}

/**
 * In-process fan-out of tool invocations to the console's live view.
 *
 * A ring buffer of recent events is replayed on connect, so a page opened after
 * the interesting request still shows it rather than an empty panel waiting for
 * the next call.
 *
 * This is deliberately per-process. With several gateway replicas a client
 * would only see the events from the replica it happened to connect to; the
 * production answer is a Redis stream, which the audit table already makes
 * unnecessary for durability — this path exists for immediacy, not for record
 * keeping.
 */
export class InvocationStream {
  private readonly listeners = new Set<StreamListener>();
  private readonly history: InvocationEvent[] = [];
  private readonly historySize: number;

  constructor(options: InvocationStreamOptions = {}) {
    this.historySize = options.historySize ?? 200;
  }

  publish(event: InvocationEvent): void {
    this.history.push(event);
    if (this.history.length > this.historySize) {
      this.history.splice(0, this.history.length - this.historySize);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failed listener is a dead connection, not a reason to drop the
        // event for everyone else.
      }
    }
  }

  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Most recent events, oldest first. */
  recent(limit = 50, tenantId?: string): InvocationEvent[] {
    const filtered = tenantId
      ? this.history.filter((event) => event.tenantId === tenantId)
      : this.history;
    return filtered.slice(-limit);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  close(): void {
    this.listeners.clear();
  }
}
