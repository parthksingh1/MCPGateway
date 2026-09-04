import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, GitBranch } from 'lucide-react';

import { LoadingCard, QueryError } from '@/components/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
} from '@/components/ui/primitives';
import { api, type Session } from '@/lib/api';
import { formatDateTime, formatMs } from '@/lib/utils';

/** The spans a single tool call produces, in the order they open. */
const SPAN_SHAPE = [
  { name: 'gateway  POST /v1/servers/:server/tools/:tool', depth: 0, service: 'gateway' },
  { name: 'token exchange  mcp:policy-engine', depth: 1, service: 'gateway' },
  { name: 'mcp.call  policy.evaluate', depth: 1, service: 'gateway' },
  { name: 'mcp.tool  policy.evaluate', depth: 2, service: 'mcp-policy-engine' },
  { name: 'token exchange  mcp:salesforce', depth: 1, service: 'gateway' },
  { name: 'mcp.call  sf.list_opportunities', depth: 1, service: 'gateway' },
  { name: 'mcp.tool  sf.list_opportunities', depth: 2, service: 'mcp-salesforce' },
  { name: 'audit append', depth: 1, service: 'gateway' },
] as const;

const SERVICE_TONE: Record<string, 'accent' | 'allow' | 'warn'> = {
  gateway: 'accent',
  'mcp-policy-engine': 'warn',
  'mcp-salesforce': 'allow',
};

export function TracesPage({ session }: { session: Session }) {
  const recent = useQuery({
    queryKey: ['audit', 'traces'],
    queryFn: () => api.audit({ limit: 12, range: '24h' }),
  });

  const withTraces = (recent.data?.rows ?? []).filter((row) => row.traceId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-content-muted">
          Every request produces one trace spanning the gateway, the policy engine, the target MCP
          server and its downstream call.
        </p>
        <a href={session.links.traces} target="_blank" rel="noreferrer">
          <Button variant="primary" size="sm">
            Open Jaeger
            <ArrowUpRight size={13} strokeWidth={2} />
          </Button>
        </a>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Span structure</CardTitle>
            <CardDescription>What one allowed tool call looks like</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {SPAN_SHAPE.map((span) => (
            <div
              key={span.name}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-raised"
              style={{ paddingLeft: `${span.depth * 20 + 8}px` }}
            >
              {span.depth > 0 ? (
                <GitBranch size={11} className="shrink-0 rotate-90 text-content-subtle" />
              ) : null}
              <span className="font-mono text-[11px] text-content">{span.name}</span>
              <Badge tone={SERVICE_TONE[span.service] ?? 'neutral'} className="ml-auto">
                {span.service}
              </Badge>
            </div>
          ))}
          <p className="pt-2 text-2xs leading-relaxed text-content-subtle">
            Context propagates as a W3C <Code>traceparent</Code> header on the outbound MCP call, so
            the child spans recorded by a separate process still join the same trace.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Recent traces</CardTitle>
            <CardDescription>From the last 24 hours of audited calls</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {recent.isLoading ? (
            <LoadingCard rows={5} />
          ) : recent.isError ? (
            <QueryError error={recent.error} onRetry={() => void recent.refetch()} />
          ) : withTraces.length === 0 ? (
            <EmptyState
              icon={<GitBranch size={17} strokeWidth={1.75} />}
              title="No traces recorded yet"
              description="Traces appear once calls flow through the gateway with the collector running."
            />
          ) : (
            <div className="space-y-1">
              {withTraces.map((row) => (
                <a
                  key={row.id}
                  href={`${session.links.traces}/trace/${row.traceId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-hover"
                >
                  <span className="w-[150px] shrink-0 tabular text-2xs text-content-subtle">
                    {formatDateTime(row.ts)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.toolName}</span>
                  <Badge tone={row.decision === 'allow' ? 'allow' : 'deny'}>{row.decision}</Badge>
                  <span className="w-16 shrink-0 text-right tabular text-2xs text-content-muted">
                    {formatMs(row.latencyMs)}
                  </span>
                  <Code className="hidden shrink-0 lg:block">{row.traceId?.slice(0, 12)}…</Code>
                  <ArrowUpRight size={13} className="shrink-0 text-content-subtle" />
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
