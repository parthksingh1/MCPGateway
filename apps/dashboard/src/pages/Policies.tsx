import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Play, ShieldCheck, X } from 'lucide-react';
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
  Input,
  Label,
  Select,
} from '@/components/ui/primitives';
import { api, type PolicyRule } from '@/lib/api';
import { cn } from '@/lib/utils';

const EFFECT_TONE = {
  allow: 'allow',
  deny: 'deny',
  annotate: 'accent',
} as const;

function RuleCard({ rule, highlighted }: { rule: PolicyRule; highlighted: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-3 transition-colors',
        highlighted ? 'border-accent-line bg-accent-muted' : 'border-line bg-surface-raised',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-medium">{rule.id}</span>
            <Badge tone={EFFECT_TONE[rule.effect]}>{rule.effect}</Badge>
            {rule.rateTier ? <Badge tone="neutral">tier: {rule.rateTier}</Badge> : null}
          </div>
          {rule.description ? (
            <p className="mt-1.5 text-xs leading-relaxed text-content-muted">{rule.description}</p>
          ) : null}
          {rule.reason ? (
            <p className="mt-1 text-2xs text-content-subtle">Refusal message: {rule.reason}</p>
          ) : null}
        </div>
        <span className="shrink-0 tabular text-2xs text-content-subtle">#{rule.priority}</span>
      </div>
    </div>
  );
}

export function PoliciesPage() {
  const bundle = useQuery({ queryKey: ['policies'], queryFn: () => api.policies() });

  const [tool, setTool] = useState('pg.query');
  const [server, setServer] = useState('postgres');
  const [role, setRole] = useState('viewer');
  const [scopes, setScopes] = useState('postgres:read postgres:query');
  const [args, setArgs] = useState('{"sql": "SELECT count(*) FROM orders"}');
  const [argsError, setArgsError] = useState<string | null>(null);

  const evaluate = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(args) as Record<string, unknown>;
        setArgsError(null);
      } catch {
        setArgsError('Arguments must be valid JSON');
        throw new Error('Arguments must be valid JSON');
      }
      return api.evaluatePolicy({
        tool,
        server,
        role,
        scopes: scopes.split(/\s+/).filter(Boolean),
        arguments: parsed,
      });
    },
  });

  const decidingRuleId = evaluate.data?.ruleId;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <p className="text-xs text-content-muted">
          Rules are evaluated in ascending priority. The first allow or deny that matches decides;
          annotate rules attach a rate tier and evaluation continues. Reaching the end applies the
          bundle default, which is <Code>deny</Code>.
        </p>

        {bundle.isLoading ? (
          <LoadingCard rows={7} />
        ) : bundle.isError ? (
          <QueryError error={bundle.error} onRetry={() => void bundle.refetch()} />
        ) : (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{bundle.data?.bundle} bundle</CardTitle>
                <CardDescription>
                  {bundle.data?.rules.length} rules · default effect{' '}
                  <Code>{bundle.data?.defaultEffect}</Code>
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {bundle.data?.rules.map((rule) => (
                <RuleCard key={rule.id} rule={rule} highlighted={rule.id === decidingRuleId} />
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Evaluate a call</CardTitle>
              <CardDescription>Runs the real evaluator without performing the call</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tool</Label>
                <Input value={tool} onChange={(event) => setTool(event.target.value)} />
              </div>
              <div>
                <Label>Server</Label>
                <Select
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  className="w-full"
                >
                  <option value="salesforce">salesforce</option>
                  <option value="postgres">postgres</option>
                  <option value="policy-engine">policy-engine</option>
                </Select>
              </div>
            </div>

            <div>
              <Label>Caller role</Label>
              <Select
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className="w-full"
              >
                <option value="admin">admin</option>
                <option value="manager">manager</option>
                <option value="analyst">analyst</option>
                <option value="viewer">viewer</option>
              </Select>
            </div>

            <div>
              <Label>Scopes</Label>
              <Input value={scopes} onChange={(event) => setScopes(event.target.value)} />
            </div>

            <div>
              <Label>Arguments</Label>
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={4}
                spellCheck={false}
                className={cn(
                  'w-full rounded-lg border bg-surface-raised px-3 py-2 font-mono text-[11px]',
                  'text-content transition-colors focus:border-accent focus:outline-none',
                  argsError ? 'border-deny-line' : 'border-line',
                )}
              />
              {argsError ? <p className="mt-1 text-2xs text-deny">{argsError}</p> : null}
            </div>

            <Button
              variant="primary"
              className="w-full"
              onClick={() => evaluate.mutate()}
              disabled={evaluate.isPending}
            >
              <Play size={13} strokeWidth={2} />
              {evaluate.isPending ? 'Evaluating…' : 'Evaluate'}
            </Button>
          </CardContent>
        </Card>

        {evaluate.data ? (
          <Card>
            <CardHeader>
              <CardTitle>Result</CardTitle>
              <Badge tone={evaluate.data.decision === 'allow' ? 'allow' : 'deny'}>
                {evaluate.data.decision === 'allow' ? (
                  <Check size={10} strokeWidth={3} />
                ) : (
                  <X size={10} strokeWidth={3} />
                )}
                {evaluate.data.decision}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-2xs uppercase tracking-wider text-content-muted">Decided by</p>
                <p className="mt-0.5 font-mono text-xs">{evaluate.data.ruleId}</p>
                <p className="mt-1 text-xs text-content-muted">{evaluate.data.reason}</p>
              </div>

              {evaluate.data.rateTier ? (
                <div>
                  <p className="text-2xs uppercase tracking-wider text-content-muted">Rate tier</p>
                  <Badge tone="accent" className="mt-1">
                    {evaluate.data.rateTier}
                  </Badge>
                </div>
              ) : null}

              <div>
                <p className="mb-1.5 text-2xs uppercase tracking-wider text-content-muted">
                  Rules considered
                </p>
                <div className="space-y-1">
                  {evaluate.data.trace.map((entry) => (
                    <div
                      key={entry.ruleId}
                      className="flex items-center gap-2 rounded-md bg-surface-raised px-2 py-1"
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          entry.matched ? 'bg-accent' : 'bg-line-strong',
                        )}
                      />
                      <span
                        className={cn(
                          'truncate font-mono text-2xs',
                          entry.matched ? 'text-content' : 'text-content-subtle',
                        )}
                      >
                        {entry.ruleId}
                      </span>
                      {entry.detail ? (
                        <span className="ml-auto text-2xs text-content-subtle">{entry.detail}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <p className="flex items-center gap-1.5 text-2xs text-content-subtle">
                <ShieldCheck size={11} strokeWidth={2} />
                Evaluated in {evaluate.data.durationMs.toFixed(2)} ms
              </p>
            </CardContent>
          </Card>
        ) : null}

        {evaluate.isError && !argsError ? <QueryError error={evaluate.error} /> : null}
      </div>
    </div>
  );
}
