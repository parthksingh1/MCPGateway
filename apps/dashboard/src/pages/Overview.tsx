import { useQuery } from '@tanstack/react-query';
import { Inbox, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { LoadingCard, QueryError, TimeRangePicker } from '@/components/shared';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
  MeterBar,
  Skeleton,
  Sparkline,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import {
  cn,
  formatCompact,
  formatMs,
  formatNumber,
  formatPercent,
  formatRelative,
} from '@/lib/utils';

const AXIS = { stroke: '#646c7d', fontSize: 11 };
const GRID = '#232833';

const SERVER_LABEL: Record<string, string> = {
  sf: 'CRM',
  pg: 'Warehouse',
  policy: 'Policy engine',
};

function ChartTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-raised px-2.5 py-2 shadow-pop">
      <p className="mb-1 text-2xs text-content-muted">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-1.5 text-xs tabular">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: entry.color ?? '#4a8fe7' }}
          />
          <span className="text-content-muted">{entry.name}</span>
          <span className="ml-auto font-medium">
            {unit === 'ms' ? formatMs(entry.value ?? 0) : formatNumber(entry.value ?? 0)}
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * A headline number with the shape behind it.
 *
 * The delta compares the most recent half of the window against the one before
 * it. That is a crude trend, and it is labelled as such rather than presented
 * as a period-over-period figure it is not.
 */
function KpiCard({
  label,
  value,
  hint,
  series,
  tone = 'accent',
  invertDelta,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  series: number[];
  tone?: 'accent' | 'deny' | 'warn';
  /** For metrics where a rise is bad, such as denials or latency. */
  invertDelta?: boolean;
  loading?: boolean;
}) {
  const half = Math.floor(series.length / 2);
  const earlier = series.slice(0, half);
  const later = series.slice(half);
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const before = mean(earlier);
  const after = mean(later);
  const delta = before === 0 ? 0 : (after - before) / before;

  // A trend against a near-empty baseline is arithmetic, not information: one
  // call following a quiet hour reads as +4000%. Require a baseline worth
  // comparing against, and cap what is shown so a real spike still reads as a
  // spike without dominating the tile.
  const meaningful =
    series.length >= 4 && before >= 1 && Math.abs(delta) >= 0.05 && Number.isFinite(delta);
  const shown = Math.min(Math.abs(delta), 9.99);
  const capped = Math.abs(delta) > 9.99;
  const rising = delta > 0;
  const good = invertDelta ? !rising : rising;

  const valueTone = tone === 'deny' ? 'text-deny' : tone === 'warn' ? 'text-warn' : 'text-content';

  return (
    <Card className="overflow-hidden">
      <div className="px-5 pb-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs font-medium uppercase tracking-wider text-content-muted">
            {label}
          </p>
          {meaningful && !loading ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-2xs font-medium tabular',
                good ? 'text-allow' : 'text-deny',
              )}
              title="Second half of the window against the first"
            >
              {rising ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
              {capped ? '>999%' : formatPercent(shown, 0)}
            </span>
          ) : null}
        </div>

        {loading ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p className={cn('mt-1 text-2xl font-semibold tabular tracking-tight', valueTone)}>
            {value}
          </p>
        )}
        {hint ? <p className="mt-0.5 text-xs text-content-muted">{hint}</p> : null}
      </div>
      <Sparkline values={series} tone={tone} className="h-7 w-full" />
    </Card>
  );
}

export function OverviewPage() {
  const [range, setRange] = useState('24h');

  const query = useQuery({
    queryKey: ['overview', range],
    queryFn: () => api.overview(range),
    refetchInterval: 15_000,
  });

  // The most recent denials, so the number in the tile has faces behind it.
  const denials = useQuery({
    queryKey: ['overview-denials', range],
    queryFn: () => api.audit({ decision: 'deny', limit: 6, range }),
    refetchInterval: 20_000,
  });

  const data = query.data;
  const series = (data?.series ?? []).map((point) => ({
    ...point,
    time: new Date(point.bucket).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    total: point.allowed + point.denied,
  }));

  const totals = series.map((point) => point.total);
  const denied = series.map((point) => point.denied);
  const latency = series.map((point) => point.p95LatencyMs);

  // The overview API returns tools, not servers. Deriving the split from the
  // tool prefix avoids a second query for something already implied.
  const byServer = (data?.topTools ?? []).reduce<Record<string, number>>((acc, tool) => {
    const prefix = tool.tool.split('.')[0] ?? 'other';
    acc[prefix] = (acc[prefix] ?? 0) + tool.count;
    return acc;
  }, {});
  const serverRows = Object.entries(byServer).sort((a, b) => b[1] - a[1]);
  const serverMax = serverRows[0]?.[1] ?? 1;

  const empty = !query.isLoading && (data?.totals.invocations ?? 0) === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-content-muted">
          Measured from the audit trail, so every number here has rows behind it.
        </p>
        <TimeRangePicker value={range} onChange={setRange} />
      </div>

      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              label="Invocations"
              value={formatCompact(data?.totals.invocations ?? 0)}
              hint={`${formatNumber(data?.totals.allowed ?? 0)} allowed`}
              series={totals}
              loading={query.isLoading}
            />
            <KpiCard
              label="Denied"
              value={formatNumber(data?.totals.denied ?? 0)}
              hint={`${formatPercent(data?.totals.denyRate ?? 0)} of traffic`}
              series={denied}
              tone="deny"
              invertDelta
              loading={query.isLoading}
            />
            <KpiCard
              label="p95 latency"
              value={formatMs(data?.latency.p95 ?? 0)}
              hint={`p50 ${formatMs(data?.latency.p50 ?? 0)}`}
              series={latency}
              tone="warn"
              invertDelta
              loading={query.isLoading}
            />
            <KpiCard
              label="p99 latency"
              value={formatMs(data?.latency.p99 ?? 0)}
              hint="end to end at the gateway"
              series={latency}
              tone="warn"
              invertDelta
              loading={query.isLoading}
            />
          </div>

          {query.isLoading ? (
            <LoadingCard rows={8} />
          ) : empty ? (
            <Card>
              <EmptyState
                icon={<Inbox size={17} strokeWidth={1.75} />}
                title="No traffic in this window"
                description="Nothing has been routed through the gateway in the selected period. Try a wider range."
              />
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Request volume</CardTitle>
                    <CardDescription>Allowed and denied calls per bucket</CardDescription>
                  </div>
                  <div className="flex items-center gap-3 text-2xs text-content-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" /> allowed
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-deny" /> denied
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="h-[230px] pl-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                      <defs>
                        <linearGradient id="allowFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#4a8fe7" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#4a8fe7" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="denyFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#e5544b" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#e5544b" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={GRID} vertical={false} />
                      <XAxis
                        dataKey="time"
                        tickLine={false}
                        axisLine={false}
                        tick={AXIS}
                        minTickGap={32}
                      />
                      <YAxis tickLine={false} axisLine={false} tick={AXIS} width={44} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2e3542' }} />
                      <Area
                        type="monotone"
                        dataKey="allowed"
                        name="allowed"
                        stroke="#4a8fe7"
                        strokeWidth={1.75}
                        fill="url(#allowFill)"
                      />
                      <Area
                        type="monotone"
                        dataKey="denied"
                        name="denied"
                        stroke="#e5544b"
                        strokeWidth={1.75}
                        fill="url(#denyFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader>
                    <div>
                      <CardTitle>p95 latency</CardTitle>
                      <CardDescription>Measured at the gateway, per bucket</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="h-[180px] pl-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                        <CartesianGrid stroke={GRID} vertical={false} />
                        <XAxis
                          dataKey="time"
                          tickLine={false}
                          axisLine={false}
                          tick={AXIS}
                          minTickGap={32}
                        />
                        <YAxis
                          tickLine={false}
                          axisLine={false}
                          tick={AXIS}
                          width={52}
                          allowDecimals={false}
                          tickFormatter={(value: number) =>
                            value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}`
                          }
                        />
                        <Tooltip
                          content={<ChartTooltip unit="ms" />}
                          cursor={{ stroke: '#2e3542' }}
                        />
                        <Line
                          type="monotone"
                          dataKey="p95LatencyMs"
                          name="p95"
                          stroke="#d9a441"
                          strokeWidth={1.75}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>By server</CardTitle>
                      <CardDescription>Where the calls went</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {serverRows.map(([prefix, count]) => (
                      <div key={prefix}>
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="text-xs text-content">
                            {SERVER_LABEL[prefix] ?? prefix}
                          </span>
                          <span className="tabular text-2xs text-content-muted">
                            {formatCompact(count)}
                          </span>
                        </div>
                        <MeterBar value={count} max={serverMax} />
                      </div>
                    ))}
                    {serverRows.length === 0 ? (
                      <p className="py-2 text-center text-xs text-content-muted">No calls yet</p>
                    ) : null}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Top tools</CardTitle>
                      <CardDescription>By call volume</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2.5">
                    {(data?.topTools ?? []).slice(0, 7).map((tool) => {
                      const max = data?.topTools[0]?.count ?? 1;
                      return (
                        <div key={tool.tool}>
                          <div className="mb-1 flex items-baseline justify-between gap-2">
                            <span className="truncate font-mono text-[11px] text-content">
                              {tool.tool}
                            </span>
                            <span className="tabular text-2xs text-content-muted">
                              {formatCompact(tool.count)}
                            </span>
                          </div>
                          <MeterBar value={tool.count} max={max} />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Recent denials</CardTitle>
                      <CardDescription>What was refused, and by which rule</CardDescription>
                    </div>
                    {(data?.totals.denied ?? 0) > 0 ? (
                      <Badge tone="deny">{formatNumber(data?.totals.denied ?? 0)}</Badge>
                    ) : null}
                  </CardHeader>
                  <CardContent>
                    {denials.isLoading ? (
                      <div className="space-y-2">
                        {Array.from({ length: 4 }, (_, index) => (
                          <Skeleton key={index} className="h-9 w-full" />
                        ))}
                      </div>
                    ) : (denials.data?.rows.length ?? 0) === 0 ? (
                      <EmptyState
                        icon={<ShieldAlert size={16} strokeWidth={1.75} />}
                        title="Nothing refused in this window"
                        description="Denials appear here with the rule that produced them."
                      />
                    ) : (
                      <div className="space-y-1">
                        {denials.data?.rows.map((row) => (
                          <div
                            key={row.id}
                            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised"
                          >
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-deny" />
                            <span className="w-[104px] shrink-0 truncate font-mono text-[11px]">
                              {row.toolName}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-2xs text-content-muted">
                              {row.denyReason ?? '—'}
                            </span>
                            <span className="shrink-0 text-2xs text-content-subtle">
                              {formatRelative(row.ts)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <p className="text-2xs leading-relaxed text-content-subtle">
                Percentiles come from <Code>percentile_disc</Code> over the audit rows rather than
                the metrics pipeline, so the figures above always agree with the rows you can click
                through to on the audit page.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
