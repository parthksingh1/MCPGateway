import { AlertTriangle, Check, X } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Badge, Button, Card, EmptyState, Skeleton } from './ui/primitives';

import { cn, formatMs } from '@/lib/utils';

/** Allow / deny, rendered the same way everywhere it appears. */
export function DecisionBadge({ decision }: { decision: 'allow' | 'deny' }) {
  return (
    <Badge tone={decision === 'allow' ? 'allow' : 'deny'}>
      {decision === 'allow' ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
      {decision}
    </Badge>
  );
}

/** Latency coloured against the thresholds an operator actually cares about. */
export function LatencyValue({ ms }: { ms: number }) {
  const tone = ms >= 800 ? 'text-deny' : ms >= 250 ? 'text-warn' : 'text-content-muted';
  return <span className={cn('tabular', tone)}>{formatMs(ms)}</span>;
}

export function StatCard({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'allow' | 'deny' | 'warn';
  loading?: boolean;
}) {
  const valueTone =
    tone === 'allow'
      ? 'text-allow'
      : tone === 'deny'
        ? 'text-deny'
        : tone === 'warn'
          ? 'text-warn'
          : 'text-content';

  return (
    <Card className="px-5 py-4">
      <p className="text-2xs font-medium uppercase tracking-wider text-content-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <p className={cn('mt-1.5 text-2xl font-semibold tabular tracking-tight', valueTone)}>
          {value}
        </p>
      )}
      {hint ? <p className="mt-1 text-xs text-content-muted">{hint}</p> : null}
    </Card>
  );
}

export function TimeRangePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const options = ['15m', '1h', '24h', '7d'];
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-raised p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            'rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors',
            value === option
              ? 'bg-accent-muted text-accent'
              : 'text-content-muted hover:text-content',
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function LoadingCard({ rows = 5 }: { rows?: number }) {
  return (
    <Card className="p-5">
      <div className="space-y-2.5">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </Card>
  );
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <Card>
      <EmptyState
        icon={<AlertTriangle size={17} strokeWidth={1.75} />}
        title="Could not load this view"
        description={message}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Stops one broken panel from blanking the whole console. A render error in a
 * chart should cost that chart, not the page an operator is using to work out
 * what is wrong.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- the browser console is the only sink available here
    console.error('Console render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <Card>
          <EmptyState
            icon={<AlertTriangle size={17} strokeWidth={1.75} />}
            title="This view failed to render"
            description={this.state.error.message}
            action={
              <Button size="sm" onClick={() => this.setState({ error: null })}>
                Reload view
              </Button>
            }
          />
        </Card>
      );
    }
    return this.props.children;
  }
}
