import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileClock, Link2, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { DecisionBadge, LatencyValue, LoadingCard, QueryError } from '@/components/shared';
import {
  Badge,
  Button,
  Card,
  Code,
  EmptyState,
  Input,
  Select,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { api, type AuditRow, type Session } from '@/lib/api';
import { cn, formatDateTime, formatNumber, shortHash } from '@/lib/utils';

const PAGE_SIZE = 25;

function ChainRow({ row }: { row: AuditRow }) {
  return (
    <div className="grid gap-x-8 border-t border-line bg-canvas/60 px-4 py-3 lg:grid-cols-2">
      <div className="space-y-1.5">
        <p className="text-2xs font-semibold uppercase tracking-wider text-content-muted">
          Chain position
        </p>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-content-muted">seq</span>
          <Code>{row.seq}</Code>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-16 text-content-muted">previous</span>
          <Code>{shortHash(row.prevHash, 24)}…</Code>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-16 text-content-muted">this row</span>
          <Code className="text-accent">{shortHash(row.rowHash, 24)}…</Code>
        </div>
        <p className="pt-1 text-2xs leading-relaxed text-content-subtle">
          This row commits to the one before it. Altering any field above changes its hash and
          breaks every link that follows.
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-2xs font-semibold uppercase tracking-wider text-content-muted">Call</p>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-24 text-content-muted">server</span>
          <span>{row.mcpServer}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-24 text-content-muted">token id</span>
          <Code>{row.actorTokenJti}</Code>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-24 text-content-muted">arguments</span>
          <Code>{shortHash(row.argumentsHash, 20)}…</Code>
        </div>
        <p className="pt-1 text-2xs leading-relaxed text-content-subtle">
          Arguments are stored as a digest, not in full. The hash proves the call was not altered
          without retaining the customer data it may have contained.
        </p>
      </div>
    </div>
  );
}

export function AuditPage({ session }: { session: Session }) {
  const [page, setPage] = useState(0);
  const [decision, setDecision] = useState('');
  const [server, setServer] = useState('');
  const [range, setRange] = useState('7d');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['audit', page, decision, server, range, search],
    queryFn: () =>
      api.audit({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        decision: decision || undefined,
        server: server || undefined,
        range,
        search: search || undefined,
      }),
  });

  const verify = useMutation({ mutationFn: () => api.verifyChain() });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle"
          />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search user, tool or reason"
            className="pl-9"
          />
        </div>

        <Select
          value={decision}
          onChange={(event) => {
            setDecision(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All decisions</option>
          <option value="allow">Allowed</option>
          <option value="deny">Denied</option>
        </Select>

        <Select
          value={server}
          onChange={(event) => {
            setServer(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All servers</option>
          <option value="salesforce">salesforce</option>
          <option value="postgres">postgres</option>
          <option value="policy-engine">policy-engine</option>
        </Select>

        <Select
          value={range}
          onChange={(event) => {
            setRange(event.target.value);
            setPage(0);
          }}
        >
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </Select>

        <Button
          variant="primary"
          onClick={() => verify.mutate()}
          disabled={verify.isPending}
          className="ml-auto"
        >
          <ShieldCheck size={14} strokeWidth={2} />
          {verify.isPending ? 'Verifying…' : 'Verify chain'}
        </Button>
      </div>

      {verify.data ? (
        <Card
          className={cn(
            'border px-4 py-3',
            verify.data.valid
              ? 'border-allow-line bg-allow-muted'
              : 'border-deny-line bg-deny-muted',
          )}
        >
          <div className="flex items-start gap-3">
            {verify.data.valid ? (
              <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-allow" strokeWidth={2} />
            ) : (
              <ShieldAlert size={17} className="mt-0.5 shrink-0 text-deny" strokeWidth={2} />
            )}
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[13px] font-medium',
                  verify.data.valid ? 'text-allow' : 'text-deny',
                )}
              >
                {verify.data.valid
                  ? `Chain intact — ${formatNumber(verify.data.rowsChecked)} rows verified in ${verify.data.durationMs.toFixed(0)} ms`
                  : 'Chain verification failed'}
              </p>
              {verify.data.firstBreak ? (
                <div className="mt-1.5 space-y-0.5 text-xs text-content-muted">
                  <p>
                    First break at seq <Code>{verify.data.firstBreak.seq ?? 'tail'}</Code> —{' '}
                    {verify.data.firstBreak.reason}
                  </p>
                  <p>
                    expected <Code>{shortHash(verify.data.firstBreak.expected, 16)}…</Code>, found{' '}
                    <Code>{shortHash(verify.data.firstBreak.actual, 16)}…</Code>
                  </p>
                </div>
              ) : (
                <p className="mt-0.5 text-xs text-content-muted">
                  Every row was recomputed from the genesis hash for {session.user.tenantName} and
                  each link holds.
                </p>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {verify.isError ? <QueryError error={verify.error} /> : null}

      {query.isLoading ? (
        <LoadingCard rows={10} />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileClock size={17} strokeWidth={1.75} />}
            title="No matching events"
            description="Nothing in this window matches the current filters. Widen the time range or clear the search."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th className="w-[150px]">Time</Th>
                <Th className="w-[92px]">Decision</Th>
                <Th>Tool</Th>
                <Th className="w-[150px]">User</Th>
                <Th className="w-[190px]">Reason</Th>
                <Th className="w-[80px] text-right">Latency</Th>
                <Th className="w-[44px]" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <>
                  <tr
                    key={row.id}
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    className="cursor-pointer transition-colors hover:bg-surface-hover"
                  >
                    <Td className="tabular text-2xs text-content-muted">
                      {formatDateTime(row.ts)}
                    </Td>
                    <Td>
                      <DecisionBadge decision={row.decision} />
                    </Td>
                    <Td className="font-mono text-xs">{row.toolName}</Td>
                    <Td className="truncate text-xs text-content-muted">
                      {row.userName ?? row.userId}
                    </Td>
                    <Td className="truncate text-2xs text-content-subtle">
                      {row.denyReason ?? '—'}
                    </Td>
                    <Td className="text-right text-xs">
                      <LatencyValue ms={row.latencyMs} />
                    </Td>
                    <Td className="text-right">
                      {row.traceId ? (
                        <a
                          href={`${session.links.traces}/trace/${row.traceId}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          title="Open trace"
                          className="inline-flex text-content-subtle transition-colors hover:text-accent"
                        >
                          <Link2 size={13} strokeWidth={1.75} />
                        </a>
                      ) : null}
                    </Td>
                  </tr>
                  {expanded === row.id ? (
                    <tr key={`${row.id}-detail`}>
                      <td colSpan={7} className="p-0">
                        <ChainRow row={row} />
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
            </tbody>
          </Table>

          <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
            <p className="text-2xs text-content-muted">
              {formatNumber(total)} events
              <span className="mx-1.5 text-content-subtle">·</span>
              page {page + 1} of {lastPage + 1}
            </p>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={page >= lastPage}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}

      <p className="flex items-center gap-1.5 text-2xs text-content-subtle">
        <Badge tone="neutral">append-only</Badge>
        The gateway writes these rows as a role holding INSERT and nothing else. Verification
        recomputes every hash from genesis rather than trusting the stored values.
      </p>
    </div>
  );
}
