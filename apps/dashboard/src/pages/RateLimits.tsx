import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Save } from 'lucide-react';
import { useState } from 'react';

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
  Input,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { api, type RateLimitConfig, type Session } from '@/lib/api';
import { cn, formatNumber, formatRelative } from '@/lib/utils';

function describeRate(config: RateLimitConfig): string {
  if (config.refillTokens === 0 || config.refillIntervalMs === 0) {
    return `${formatNumber(config.capacity)} then no refill`;
  }
  const perSecond = (config.refillTokens / config.refillIntervalMs) * 1000;
  const perMinute = Math.round(perSecond * 60);
  return `${formatNumber(perMinute)} / min`;
}

function EditableRow({
  config,
  canEdit,
  onSave,
  saving,
}: {
  config: RateLimitConfig;
  canEdit: boolean;
  onSave: (id: string, capacity: number) => void;
  saving: boolean;
}) {
  const [capacity, setCapacity] = useState(String(config.capacity));
  const dirty = Number(capacity) !== config.capacity && capacity !== '';

  return (
    <tr className="transition-colors hover:bg-surface-hover">
      <Td>
        <Badge tone={config.scopeType === 'tenant' ? 'accent' : 'neutral'}>
          {config.scopeType === 'tenant' ? 'tenant' : 'per user'}
        </Badge>
      </Td>
      <Td className="font-mono text-xs">
        {config.toolName === '*' ? (
          <span className="text-content-subtle">all tools</span>
        ) : (
          config.toolName
        )}
      </Td>
      <Td>
        <Badge
          tone={
            config.tier === 'burst' ? 'allow' : config.tier === 'throttled' ? 'warn' : 'neutral'
          }
        >
          {config.tier}
        </Badge>
      </Td>
      <Td>
        <Input
          value={capacity}
          onChange={(event) => setCapacity(event.target.value.replace(/[^0-9]/g, ''))}
          disabled={!canEdit}
          className={cn('h-7 w-24 text-xs tabular', dirty && 'border-accent')}
          inputMode="numeric"
        />
      </Td>
      <Td className="text-xs text-content-muted">{describeRate(config)}</Td>
      <Td className="text-2xs text-content-subtle">{formatRelative(config.updatedAt)}</Td>
      <Td className="text-right">
        <Button
          size="sm"
          variant="primary"
          disabled={!canEdit || !dirty || saving}
          onClick={() => onSave(config.id, Number(capacity))}
        >
          <Save size={12} strokeWidth={2} />
          Save
        </Button>
      </Td>
    </tr>
  );
}

export function RateLimitsPage({ session }: { session: Session }) {
  const client = useQueryClient();
  const canEdit = session.user.scopes.includes('gateway:admin');

  const query = useQuery({
    queryKey: ['rate-limits'],
    queryFn: () => api.rateLimits(),
    refetchInterval: 10_000,
  });

  const save = useMutation({
    mutationFn: ({ id, capacity }: { id: string; capacity: number }) => {
      const config = query.data?.configs.find((entry) => entry.id === id);
      return api.updateRateLimit(id, {
        capacity,
        // Keep the refill rate proportional to the new bucket size, which is
        // what an operator raising a limit during an incident means.
        refillTokens: capacity,
        refillIntervalMs: config?.refillIntervalMs ?? 60_000,
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['rate-limits'] }),
  });

  const configs = query.data?.configs ?? [];
  const buckets = query.data?.buckets ?? [];

  return (
    <div className="space-y-4">
      <p className="text-xs text-content-muted">
        Token buckets guarding {session.user.tenantName}. Changes take effect on every gateway
        replica immediately, over Redis pub/sub — no restart, no deploy.
      </p>

      {query.isLoading ? (
        <LoadingCard rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>
                  Capacity is the largest burst admitted at once; refill returns tokens continuously
                </CardDescription>
              </div>
              {!canEdit ? <Badge tone="neutral">read only — requires gateway:admin</Badge> : null}
            </CardHeader>

            {configs.length === 0 ? (
              <EmptyState
                icon={<Gauge size={17} strokeWidth={1.75} />}
                title="No limits configured"
                description="This tenant falls back to the conservative default, which throttles rather than opening the gate."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th className="w-[96px]">Scope</Th>
                    <Th>Tool</Th>
                    <Th className="w-[96px]">Tier</Th>
                    <Th className="w-[120px]">Capacity</Th>
                    <Th className="w-[140px]">Refill</Th>
                    <Th className="w-[110px]">Updated</Th>
                    <Th className="w-[90px]" />
                  </tr>
                </thead>
                <tbody>
                  {configs.map((config) => (
                    <EditableRow
                      key={config.id}
                      config={config}
                      canEdit={canEdit}
                      saving={save.isPending}
                      onSave={(id, capacity) => save.mutate({ id, capacity })}
                    />
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Live bucket state</CardTitle>
                <CardDescription>
                  Read straight from Redis — what the limiter is actually working with
                </CardDescription>
              </div>
              <Badge tone="neutral">{buckets.length} active</Badge>
            </CardHeader>
            <CardContent>
              {buckets.length === 0 ? (
                <p className="py-4 text-center text-xs text-content-muted">
                  No buckets are currently held. They are created on a caller&apos;s first request
                  and expire once idle.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {buckets.slice(0, 24).map((bucket) => {
                    const label = bucket.key.replace(/^rl:\{[^}]+\}:/, '');
                    return (
                      <div
                        key={bucket.key}
                        className="rounded-lg border border-line bg-surface-raised px-3 py-2"
                      >
                        <p className="truncate font-mono text-2xs text-content-muted">{label}</p>
                        <p className="mt-1 text-sm font-medium tabular">
                          {bucket.tokens?.toFixed(1) ?? '—'}
                          <span className="ml-1 text-2xs font-normal text-content-subtle">
                            tokens
                          </span>
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-2xs leading-relaxed text-content-subtle">
            Every check is a single Lua script evaluated inside Redis, so read, refill, decide and
            write happen as one indivisible step. Doing the same work as <Code>GET</Code> / compute
            / <Code>SET</Code> from the application would let two replicas both admit the request
            that takes the bucket over its limit.
          </p>
        </>
      )}
    </div>
  );
}
