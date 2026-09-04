import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
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

import { LoadingCard, QueryError, StatCard, TimeRangePicker } from '@/components/shared';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatCompact, formatMs, formatNumber, formatPercent } from '@/lib/utils';

const AXIS = { stroke: '#646c7d', fontSize: 11 };
const GRID = '#232833';

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

export function OverviewPage() {
  const [range, setRange] = useState('24h');

  const query = useQuery({
    queryKey: ['overview', range],
    queryFn: () => api.overview(range),
    refetchInterval: 15_000,
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

  const empty = !query.isLoading && (data?.totals.invocations ?? 0) === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-content-muted">
          Traffic through the gateway, measured from the audit trail.
        </p>
        <TimeRangePicker value={range} onChange={setRange} />
      </div>

      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Invocations"
              value={formatCompact(data?.totals.invocations ?? 0)}
              hint={`${formatNumber(data?.totals.allowed ?? 0)} allowed`}
              loading={query.isLoading}
            />
            <StatCard
              label="Denied"
              value={formatNumber(data?.totals.denied ?? 0)}
              hint={`${formatPercent(data?.totals.denyRate ?? 0)} of traffic`}
              tone={(data?.totals.denyRate ?? 0) > 0.15 ? 'deny' : 'default'}
              loading={query.isLoading}
            />
            <StatCard
              label="p95 latency"
              value={formatMs(data?.latency.p95 ?? 0)}
              hint={`p50 ${formatMs(data?.latency.p50 ?? 0)}`}
              tone={(data?.latency.p95 ?? 0) > 500 ? 'warn' : 'default'}
              loading={query.isLoading}
            />
            <StatCard
              label="p99 latency"
              value={formatMs(data?.latency.p99 ?? 0)}
              hint="end to end at the gateway"
              tone={(data?.latency.p99 ?? 0) > 1_000 ? 'warn' : 'default'}
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
                <CardContent className="h-[240px] pl-1">
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
                  <CardContent className="h-[190px] pl-1">
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
                          width={44}
                          tickFormatter={(value: number) => `${value}`}
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
                      <CardTitle>Top tools</CardTitle>
                      <CardDescription>By call volume</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2.5">
                    {(data?.topTools ?? []).map((tool) => {
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
                          <div className="h-1 overflow-hidden rounded-full bg-surface-raised">
                            <div
                              className="h-full rounded-full bg-accent/70"
                              style={{ width: `${Math.max(3, (tool.count / max) * 100)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
