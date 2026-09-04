import { useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/shared';
import { Skeleton } from '@/components/ui/primitives';
import { ApiError, api } from '@/lib/api';
import { AuditPage } from '@/pages/Audit';
import { LivePage } from '@/pages/Live';
import { OverviewPage } from '@/pages/Overview';
import { PoliciesPage } from '@/pages/Policies';
import { RateLimitsPage } from '@/pages/RateLimits';
import { SettingsPage } from '@/pages/Settings';
import { SignInPage } from '@/pages/SignIn';
import { TracesPage } from '@/pages/Traces';

function BootSkeleton() {
  return (
    <div className="flex h-full">
      <div className="w-[228px] border-r border-line bg-surface p-3">
        <Skeleton className="mb-6 h-8 w-full" />
        <div className="space-y-1.5">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-6">
        <Skeleton className="h-8 w-48" />
      </div>
    </div>
  );
}

export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.session(),
    // A 401 is the normal state before signing in, not a fault to retry.
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 60_000,
  });

  if (session.isLoading) return <BootSkeleton />;
  if (!session.data) return <SignInPage />;

  const active = session.data;

  return (
    <AppShell session={active}>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/live" element={<LivePage session={active} />} />
          <Route path="/audit" element={<AuditPage session={active} />} />
          <Route path="/rate-limits" element={<RateLimitsPage session={active} />} />
          <Route path="/policies" element={<PoliciesPage />} />
          <Route path="/traces" element={<TracesPage session={active} />} />
          <Route path="/settings" element={<SettingsPage session={active} />} />
          <Route path="*" element={<OverviewPage />} />
        </Routes>
      </ErrorBoundary>
    </AppShell>
  );
}
