import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  ChevronsUpDown,
  Database,
  FileClock,
  Gauge,
  KeyRound,
  LogOut,
  Route,
  Server,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { Badge, SectionLabel, StatusDot } from './ui/primitives';

import { api, type HealthState, type Session } from '@/lib/api';
import { cn } from '@/lib/utils';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Shown under the page title in the header. */
  readonly caption: string;
  /** Exact match, so the overview link is not active on every route. */
  readonly end?: boolean;
}

interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

/**
 * Navigation is grouped by what an operator is trying to do rather than listed
 * flat. Seven undifferentiated links make the reader scan all seven; three
 * groups of two or three make the shape of the product legible at a glance.
 */
const NAV: readonly NavGroup[] = [
  {
    label: 'Observe',
    items: [
      {
        to: '/',
        label: 'Overview',
        icon: BarChart3,
        end: true,
        caption: 'Traffic, latency and denials across the tenant',
      },
      {
        to: '/live',
        label: 'Live requests',
        icon: Activity,
        caption: 'Every call as it reaches the gateway',
      },
      {
        to: '/traces',
        label: 'Traces',
        icon: Route,
        caption: 'One trace per request, across every service it touches',
      },
    ],
  },
  {
    label: 'Govern',
    items: [
      {
        to: '/policies',
        label: 'Policies',
        icon: ShieldCheck,
        caption: 'Rules evaluated before any credential is minted',
      },
      {
        to: '/rate-limits',
        label: 'Rate limits',
        icon: Gauge,
        caption: 'Token buckets, and what the limiter currently holds',
      },
      {
        to: '/audit',
        label: 'Audit log',
        icon: FileClock,
        caption: 'Append-only, hash-chained, verifiable on demand',
      },
    ],
  },
  {
    label: 'Administer',
    items: [
      {
        to: '/settings',
        label: 'Settings',
        icon: Settings2,
        caption: 'Tenant, people and registered OAuth clients',
      },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((group) => group.items);

/** Maps a readiness key onto a readable name and an icon. */
const DEPENDENCY_META: Record<string, { label: string; icon: LucideIcon }> = {
  database: { label: 'PostgreSQL', icon: Database },
  redis: { label: 'Redis', icon: Database },
  identity: { label: 'Identity', icon: KeyRound },
  'mcp:salesforce': { label: 'CRM server', icon: Server },
  'mcp:postgres': { label: 'Warehouse', icon: Server },
  'mcp:policy-engine': { label: 'Policy engine', icon: Server },
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

/**
 * Dependency health, polled from the gateway's own readiness endpoint.
 *
 * This is the panel an operator looks at first when something is wrong, so it
 * lives permanently in the sidebar rather than behind a page. It also fills
 * space that was otherwise dead.
 */
function SystemStatus() {
  const readiness = useQuery({
    queryKey: ['readyz'],
    queryFn: () => api.readiness(),
    refetchInterval: 15_000,
    retry: false,
  });

  const checks = readiness.data?.checks ?? {};
  const entries = Object.entries(checks).filter(([key]) => key in DEPENDENCY_META);
  const worst: HealthState = entries.some(([, state]) => state === 'down')
    ? 'down'
    : entries.some(([, state]) => state === 'degraded')
      ? 'degraded'
      : 'ok';

  const summary =
    entries.length === 0
      ? 'Checking…'
      : worst === 'ok'
        ? 'All systems normal'
        : worst === 'degraded'
          ? 'Degraded'
          : 'Dependency down';

  return (
    <div className="mx-2 rounded-lg border border-line bg-surface-raised/50">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <StatusDot state={entries.length === 0 ? 'unknown' : worst} pulse />
        <span className="text-[11px] font-medium">{summary}</span>
      </div>

      {entries.length > 0 ? (
        <div className="space-y-px border-t border-line/70 px-2.5 py-2">
          {entries.map(([key, state]) => {
            const meta = DEPENDENCY_META[key];
            if (!meta) return null;
            return (
              <div key={key} className="flex items-center gap-2 py-[3px]">
                <meta.icon size={11} strokeWidth={1.75} className="shrink-0 text-content-subtle" />
                <span className="flex-1 truncate text-[11px] text-content-muted">{meta.label}</span>
                <StatusDot state={state} />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function QuickLinks({ session }: { session: Session }) {
  const links = [
    { label: 'Traces', href: session.links.traces },
    { label: 'Dashboards', href: session.links.metrics },
  ];

  return (
    <div className="px-2 pb-1">
      <SectionLabel>External</SectionLabel>
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] text-content-muted transition-colors hover:bg-surface-raised hover:text-content"
        >
          <ArrowUpRight
            size={15}
            strokeWidth={1.75}
            className="text-content-subtle transition-colors group-hover:text-accent"
          />
          {link.label}
        </a>
      ))}
    </div>
  );
}

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const location = useLocation();
  const current =
    ALL_ITEMS.find((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
    ) ?? ALL_ITEMS[0];

  return (
    <div className="flex h-full">
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Logo />
          <span className="text-[13px] font-semibold tracking-tight">mcpgateway</span>
          <Badge tone="neutral" className="ml-auto">
            v0.1.0
          </Badge>
        </div>

        {/* Tenant. Sits above navigation because everything below is scoped to it. */}
        <div className="border-b border-line px-2 py-2">
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-raised px-2.5 py-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-muted text-[10px] font-semibold text-accent">
              {initials(session.user.tenantName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium leading-tight">
                {session.user.tenantName}
              </p>
              <p className="truncate text-[10px] capitalize text-content-subtle">
                {session.user.tenantPlan} plan
              </p>
            </div>
            <ChevronsUpDown size={12} className="shrink-0 text-content-subtle" />
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {NAV.map((group) => (
            <div key={group.label}>
              <SectionLabel>{group.label}</SectionLabel>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors',
                        isActive
                          ? 'bg-accent-muted font-medium text-accent'
                          : 'text-content-muted hover:bg-surface-raised hover:text-content',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* Active rail, so the selected item reads at a glance. */}
                        <span
                          className={cn(
                            'absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-accent transition-opacity',
                            isActive ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        <item.icon size={15} strokeWidth={1.75} />
                        {item.label}
                        {item.to === '/live' ? <StatusDot state="ok" pulse /> : null}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}

          <QuickLinks session={session} />
        </nav>

        <div className="shrink-0 space-y-2 border-t border-line py-2">
          <SystemStatus />

          <div className="mx-2 flex items-center gap-2.5 rounded-lg border border-line bg-surface-raised p-2">
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
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line px-6">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight tracking-tight">{current?.label}</h1>
            <p className="truncate text-2xs text-content-muted">{current?.caption}</p>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Badge tone="neutral" className="gap-1.5">
              <StatusDot state="ok" pulse />
              {session.user.tenantId}
            </Badge>
            <Badge tone="accent">{session.user.role}</Badge>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</main>
      </div>
    </div>
  );
}
