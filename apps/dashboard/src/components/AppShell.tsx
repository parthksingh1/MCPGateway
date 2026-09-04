import {
  Activity,
  BarChart3,
  FileClock,
  Gauge,
  LogOut,
  Route,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { Badge } from './ui/primitives';

import { api, type Session } from '@/lib/api';
import { cn } from '@/lib/utils';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Exact match, so the overview link is not active on every route. */
  readonly end?: boolean;
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: BarChart3, end: true },
  { to: '/live', label: 'Live requests', icon: Activity },
  { to: '/audit', label: 'Audit log', icon: FileClock },
  { to: '/rate-limits', label: 'Rate limits', icon: Gauge },
  { to: '/policies', label: 'Policies', icon: ShieldCheck },
  { to: '/traces', label: 'Traces', icon: Route },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];

const PLAN_TONE: Record<string, 'accent' | 'neutral' | 'warn'> = {
  enterprise: 'accent',
  pro: 'neutral',
  restricted: 'warn',
};

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5 20 6.5v6.2c0 4.6-3.3 8.2-8 9.3-4.7-1.1-8-4.7-8-9.3V6.5l8-4Z"
        stroke="#4a8fe7"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 12.2l2.1 2.1L15.4 10"
        stroke="#4a8fe7"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const location = useLocation();
  const current = NAV.find((item) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <Logo />
          <span className="text-[13px] font-semibold tracking-tight">mcpgateway</span>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors',
                  isActive
                    ? 'bg-accent-muted font-medium text-accent'
                    : 'text-content-muted hover:bg-surface-raised hover:text-content',
                )
              }
            >
              <item.icon size={15} strokeWidth={1.75} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{session.user.tenantName}</span>
            <Badge tone={PLAN_TONE[session.user.tenantPlan] ?? 'neutral'}>
              {session.user.tenantPlan}
            </Badge>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-raised p-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-muted text-[11px] font-semibold text-accent">
              {initials(session.user.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium leading-tight">{session.user.name}</p>
              <p className="truncate text-2xs capitalize text-content-muted">{session.user.role}</p>
            </div>
            <button
              type="button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => {
                void api.logout().then(() => window.location.assign('/'));
              }}
              className="rounded-md p-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
            >
              <LogOut size={13} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-line px-6">
          <h1 className="text-sm font-semibold tracking-tight">{current?.label ?? 'Overview'}</h1>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</main>
      </div>
    </div>
  );
}
