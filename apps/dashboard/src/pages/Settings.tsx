import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Users } from 'lucide-react';

import { LoadingCard, QueryError } from '@/components/shared';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { api, type Session } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

const ROLE_TONE: Record<string, 'accent' | 'allow' | 'neutral'> = {
  admin: 'accent',
  manager: 'allow',
};

export function SettingsPage({ session }: { session: Session }) {
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api.tenant() });
  const isAdmin = session.user.scopes.includes('gateway:admin');
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.clients(),
    enabled: isAdmin,
  });

  return (
    <div className="space-y-4">
      {tenant.isLoading ? (
        <LoadingCard rows={4} />
      ) : tenant.isError ? (
        <QueryError error={tenant.error} onRetry={() => void tenant.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Organisation</CardTitle>
                <CardDescription>
                  Settings that apply to every caller in this tenant
                </CardDescription>
              </div>
              <Badge tone="accent">{tenant.data?.tenant?.plan}</Badge>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Name', tenant.data?.tenant?.name ?? '—'],
                  ['Identifier', tenant.data?.tenant?.id ?? '—'],
                  ['Region', tenant.data?.tenant?.region ?? '—'],
                  [
                    'Created',
                    tenant.data?.tenant ? formatDateTime(tenant.data.tenant.createdAt) : '—',
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-2xs uppercase tracking-wider text-content-muted">
                      {label}
                    </dt>
                    <dd className="mt-0.5 text-[13px]">{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>People</CardTitle>
                <CardDescription>
                  Roles here are mirrored into database roles by the warehouse server
                </CardDescription>
              </div>
              <Badge tone="neutral">{tenant.data?.users.length ?? 0}</Badge>
            </CardHeader>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th className="w-[110px]">Role</Th>
                  <Th className="w-[120px]">Territory</Th>
                  <Th className="w-[140px]">Database role</Th>
                </tr>
              </thead>
              <tbody>
                {(tenant.data?.users ?? []).map((user) => (
                  <tr key={user.id} className="transition-colors hover:bg-surface-hover">
                    <Td className="font-medium">{user.name}</Td>
                    <Td className="text-xs text-content-muted">{user.email}</Td>
                    <Td>
                      <Badge tone={ROLE_TONE[user.role] ?? 'neutral'}>{user.role}</Badge>
                    </Td>
                    <Td className="text-xs text-content-muted">{user.territory ?? '—'}</Td>
                    <Td>
                      <Code>app_{user.role}</Code>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>OAuth clients</CardTitle>
            <CardDescription>
              Applications registered to obtain tokens against this deployment
            </CardDescription>
          </div>
          {!isAdmin ? <Badge tone="neutral">requires gateway:admin</Badge> : null}
        </CardHeader>

        {!isAdmin ? (
          <EmptyState
            icon={<Users size={17} strokeWidth={1.75} />}
            title="Not available for your role"
            description="Client registrations are visible to administrators. Your other views are unaffected."
          />
        ) : clients.isLoading ? (
          <CardContent>
            <LoadingCard rows={4} />
          </CardContent>
        ) : clients.isError ? (
          <CardContent>
            <QueryError error={clients.error} onRetry={() => void clients.refetch()} />
          </CardContent>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th className="w-[110px]">Type</Th>
                <Th>Grants</Th>
                <Th className="w-[90px] text-right">Scopes</Th>
              </tr>
            </thead>
            <tbody>
              {(clients.data?.clients ?? []).map((client) => (
                <tr key={client.client_id} className="transition-colors hover:bg-surface-hover">
                  <Td>
                    <p className="font-medium">{client.name}</p>
                    <Code className="mt-0.5 inline-block">{client.client_id}</Code>
                  </Td>
                  <Td>
                    <Badge tone={client.confidential ? 'accent' : 'warn'}>
                      {client.confidential ? 'confidential' : 'public'}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {client.allowed_grants.map((grant) => (
                        <Code key={grant}>
                          {grant.startsWith('urn:') ? 'token-exchange' : grant}
                        </Code>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-right tabular text-xs text-content-muted">
                    {client.allowed_scopes.length}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Observability</CardTitle>
            <CardDescription>Where traces, metrics and logs are collected</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {[
            ['Traces', session.links.traces],
            ['Metrics and dashboards', session.links.metrics],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs transition-colors hover:bg-surface-hover"
            >
              {label}
              <ArrowUpRight size={12} strokeWidth={2} className="text-content-subtle" />
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
