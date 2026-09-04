import { ArrowRight, FileClock, Gauge, KeyRound, Route } from 'lucide-react';

import { api } from '@/lib/api';

const PILLARS = [
  {
    icon: KeyRound,
    title: 'Per-user credentials downstream',
    body: 'Each tool call carries a token minted for the person who made it, scoped to one service.',
  },
  {
    icon: Gauge,
    title: 'Atomic rate limiting',
    body: 'Token buckets evaluated inside Redis, exact under concurrency across every replica.',
  },
  {
    icon: FileClock,
    title: 'Tamper-evident audit',
    body: 'Append-only, hash-chained, and verifiable from the genesis hash on demand.',
  },
  {
    icon: Route,
    title: 'End-to-end tracing',
    body: 'One trace per request, spanning the gateway, policy, the target server and downstream.',
  },
];

export function SignInPage() {
  return (
    <div className="grid h-full lg:grid-cols-2">
      <div className="flex items-center justify-center px-8 py-12">
        <div className="w-full max-w-[340px]">
          <div className="mb-8 flex items-center gap-2.5">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
            <span className="text-[15px] font-semibold tracking-tight">mcpgateway</span>
          </div>

          <h1 className="text-2xl font-semibold leading-tight tracking-tight">
            Operations console
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-content-muted">
            Traffic, policy decisions, rate limits and the audit trail for every tool call your
            agents make.
          </p>

          <a
            href={api.loginUrl(window.location.pathname)}
            className="mt-7 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Continue with single sign-on
            <ArrowRight size={15} strokeWidth={2} />
          </a>

          <p className="mt-4 text-2xs leading-relaxed text-content-subtle">
            You will be redirected to your identity provider. The console never receives your access
            token — it is held server-side and referenced by a session cookie.
          </p>
        </div>
      </div>

      <div className="hidden border-l border-line bg-surface lg:flex lg:items-center lg:justify-center lg:px-12">
        <div className="w-full max-w-[380px] space-y-5">
          {PILLARS.map((pillar) => (
            <div key={pillar.title} className="flex gap-3.5">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised text-accent">
                <pillar.icon size={15} strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-[13px] font-medium">{pillar.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-content-muted">{pillar.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
