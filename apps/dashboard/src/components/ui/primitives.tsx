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
