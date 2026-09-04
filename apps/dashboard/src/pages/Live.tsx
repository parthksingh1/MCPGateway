import { ChevronRight, Radio, Signal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DecisionBadge, LatencyValue } from '@/components/shared';
import { Badge, Card, Code, EmptyState } from '@/components/ui/primitives';
import type { InvocationEvent, Session } from '@/lib/api';
import { cn, formatMs, formatTime, splitToolName } from '@/lib/utils';

const MAX_EVENTS = 200;

/**
 * Server-sent events from the gateway.
 *
 * The gateway replays its recent ring buffer on connect, so a page opened after
 * the interesting request still shows it instead of an empty panel waiting for
 * the next call.
 */
function useInvocationStream(): { events: InvocationEvent[]; connected: boolean } {
  const [events, setEvents] = useState<InvocationEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/stream', { withCredentials: true });

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as InvocationEvent;
        setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };

    return () => source.close();
  }, []);

  return { events, connected };
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1">
      <span className="w-40 shrink-0 text-2xs uppercase tracking-wider text-content-muted">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-xs">{children}</div>
    </div>
  );
}

function EventDetail({ event, jaegerUrl }: { event: InvocationEvent; jaegerUrl: string }) {
  return (
    <div className="border-t border-line bg-canvas/60 px-4 py-3">
      <div className="grid gap-x-8 lg:grid-cols-2">
        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-content-muted">
            Permission mirroring
          </p>
          {event.tokenExchange ? (
            <>
              <DetailRow label="Downstream subject">
                <Code>{event.tokenExchange.downstreamSubject}</Code>
              </DetailRow>
              <DetailRow label="Audience">
                <Code>{event.tokenExchange.audience}</Code>
              </DetailRow>
              <DetailRow label="Exchange">
                <span className="tabular">
                  {formatMs(event.tokenExchange.latencyMs)}{' '}
                  <Badge tone={event.tokenExchange.cached ? 'accent' : 'neutral'} className="ml-1">
                    {event.tokenExchange.cached ? 'cached' : 'minted'}
                  </Badge>
                </span>
              </DetailRow>
            </>
          ) : (
            <p className="py-1 text-xs text-content-muted">
              No token was minted — the request was refused first.
            </p>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-content-muted">
            Decision
          </p>
          {event.policy ? (
            <>
              <DetailRow label="Rule">
                <Code>{event.policy.ruleId}</Code>
              </DetailRow>
              <DetailRow label="Reason">
                <span className="text-content-muted">{event.policy.reason}</span>
              </DetailRow>
              {event.policy.rateTier ? (
                <DetailRow label="Rate tier">
                  <Badge tone="accent">{event.policy.rateTier}</Badge>
                </DetailRow>
              ) : null}
            </>
          ) : null}
          {event.rateLimit ? (
            <DetailRow label="Rate limit">
              <span className="tabular text-content-muted">
                {event.rateLimit.remaining} / {event.rateLimit.limit} remaining
                <span className="ml-1.5 text-content-subtle">({event.rateLimit.scope})</span>
              </span>
            </DetailRow>
          ) : null}
          {event.denyReason ? (
            <DetailRow label="Refused because">
              <Code className="text-deny">{event.denyReason}</Code>
            </DetailRow>
          ) : null}
          {event.traceId ? (
            <DetailRow label="Trace">
              <a
                href={`${jaegerUrl}/trace/${event.traceId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-accent hover:underline"
              >
                {event.traceId.slice(0, 16)}…
              </a>
            </DetailRow>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function LivePage({ session }: { session: Session }) {
  const { events, connected } = useInvocationStream();
  const [expanded, setExpanded] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-content-muted">
          Every call routed through the gateway for {session.user.tenantName}, as it happens.
        </p>
        <Badge tone={connected ? 'allow' : 'warn'}>
          <Signal size={10} strokeWidth={2.5} className={cn(connected && 'animate-pulse')} />
          {connected ? 'streaming' : 'reconnecting'}
        </Badge>
      </div>

      <Card className="overflow-hidden">
        {events.length === 0 ? (
          <EmptyState
            icon={<Radio size={17} strokeWidth={1.75} />}
            title="Waiting for traffic"
            description="Calls appear here the moment they reach the gateway. Run a tool from the policy page or with the API to see one."
          />
        ) : (
          <div ref={listRef} className="max-h-[calc(100vh-14rem)] overflow-y-auto">
            {events.map((event) => {
              const { prefix, action } = splitToolName(event.tool);
              const isOpen = expanded === event.id;
              return (
                <div key={event.id} className="border-b border-line/60 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : event.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                      'hover:bg-surface-hover',
                      isOpen && 'bg-surface-hover',
                    )}
                  >
                    <ChevronRight
                      size={13}
                      className={cn(
                        'shrink-0 text-content-subtle transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                    <span className="w-[68px] shrink-0 tabular text-2xs text-content-subtle">
                      {formatTime(event.ts)}
                    </span>
                    <DecisionBadge decision={event.decision} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      <span className="text-content-subtle">{prefix}.</span>
                      <span className="text-content">{action}</span>
                    </span>
                    <span className="hidden w-32 shrink-0 truncate text-xs text-content-muted md:block">
                      {event.userName ?? event.userId}
                    </span>
                    <span className="w-16 shrink-0 text-right">
                      <LatencyValue ms={event.latencyMs} />
                    </span>
                  </button>
                  {isOpen ? <EventDetail event={event} jaegerUrl={session.links.traces} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
