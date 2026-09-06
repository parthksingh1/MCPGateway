import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

import { cn } from '@/lib/utils';

/**
 * The primitive layer.
 *
 * Small, unopinionated building blocks following shadcn/ui conventions —
 * `cn()` merging so any caller can override, semantic tokens rather than raw
 * colours, and no component that owns its own data. Everything above this file
 * composes these rather than reaching for Tailwind classes directly, which is
 * what keeps spacing and colour consistent across seven pages.
 */

// ------------------------------------------------------------------- surface

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface shadow-panel',
        'animate-fade-in',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-start justify-between gap-4 px-5 pb-3 pt-4', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-[13px] font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-0.5 text-xs text-content-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

// -------------------------------------------------------------------- button

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'bg-surface-raised text-content border border-line hover:bg-surface-hover',
  ghost: 'text-content-muted hover:bg-surface-raised hover:text-content',
  danger: 'bg-deny/90 text-white hover:bg-deny',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-[13px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ className, variant = 'secondary', size = 'md', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex select-none items-center justify-center rounded-lg font-medium',
        'transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

// --------------------------------------------------------------------- badge

type BadgeTone = 'neutral' | 'accent' | 'allow' | 'deny' | 'warn';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-raised text-content-muted border-line',
  accent: 'bg-accent-muted text-accent border-accent-line',
  allow: 'bg-allow-muted text-allow border-allow-line',
  deny: 'bg-deny-muted text-deny border-deny-line',
  warn: 'bg-warn-muted text-warn border-warn-line',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5',
        'text-2xs font-medium leading-none',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

// --------------------------------------------------------------------- input

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-line bg-surface-raised px-3 text-[13px]',
        'text-content placeholder:text-content-subtle',
        'transition-colors focus:border-accent focus:outline-none',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-9 rounded-lg border border-line bg-surface-raised px-2.5 text-[13px] text-content',
        'transition-colors focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: HTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        'mb-1.5 block text-2xs font-medium uppercase tracking-wider text-content-muted',
        className,
      )}
      {...props}
    />
  );
}

// ------------------------------------------------------------------ feedback

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-surface-raised', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-raised text-content-subtle">
          {icon}
        </div>
      ) : null}
      <p className="text-[13px] font-medium text-content">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-content-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

// --------------------------------------------------------------------- table

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-[13px]', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'border-b border-line px-4 py-2.5 text-left text-2xs font-medium uppercase',
        'tracking-wider text-content-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('border-b border-line/60 px-4 py-2.5 align-middle', className)} {...props} />
  );
}

// ---------------------------------------------------------------------- misc

export function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-line', className)} />;
}

/** Monospace inline code, used for ids, hashes and rule names. */
export function Code({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn(
        'rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-content-muted',
        className,
      )}
      {...props}
    />
  );
}

// ------------------------------------------------------------------ status

const STATUS_COLOR: Record<string, string> = {
  ok: 'bg-allow',
  degraded: 'bg-warn',
  down: 'bg-deny',
  unknown: 'bg-line-strong',
};

/** Small state indicator. Pulses only while healthy, so it reads as "live". */
export function StatusDot({ state, pulse }: { state: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse && state === 'ok' ? (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            STATUS_COLOR[state] ?? STATUS_COLOR.unknown,
          )}
        />
      ) : null}
      <span
        className={cn(
          'relative inline-flex h-1.5 w-1.5 rounded-full',
          STATUS_COLOR[state] ?? STATUS_COLOR.unknown,
        )}
      />
    </span>
  );
}

/** Uppercase group heading used in the sidebar and in dense panels. */
export function SectionLabel({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-content-subtle',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Inline trend line. Deliberately axis-free and unlabelled: it exists to show
 * shape next to a number, and anything more would compete with the real charts.
 */
export function Sparkline({
  values,
  className,
  tone = 'accent',
}: {
  values: number[];
  className?: string;
  tone?: 'accent' | 'deny' | 'warn';
}) {
  if (values.length < 2) return <div className={cn('h-6', className)} />;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const width = 100;
  const height = 24;

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 3) - 1.5;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const stroke = tone === 'deny' ? '#e5544b' : tone === 'warn' ? '#d9a441' : '#4a8fe7';
  const id = `spark-${tone}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('h-6 w-full', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points.join(' ')} ${width},${height}`} fill={`url(#${id})`} />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Horizontal proportion bar, used for rankings. */
export function MeterBar({
  value,
  max,
  tone = 'accent',
}: {
  value: number;
  max: number;
  tone?: 'accent' | 'deny' | 'warn' | 'allow';
}) {
  const fill =
    tone === 'deny'
      ? 'bg-deny/70'
      : tone === 'warn'
        ? 'bg-warn/70'
        : tone === 'allow'
          ? 'bg-allow/70'
          : 'bg-accent/70';
  return (
    <div className="h-1 overflow-hidden rounded-full bg-surface-raised">
      <div
        className={cn('h-full rounded-full transition-all duration-500', fill)}
        style={{ width: `${Math.max(2, (value / Math.max(1, max)) * 100)}%` }}
      />
    </div>
  );
}

/** Keyboard hint, for affordances that have a shortcut. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-raised px-1 py-px font-mono text-[10px] text-content-subtle">
      {children}
    </kbd>
  );
}
