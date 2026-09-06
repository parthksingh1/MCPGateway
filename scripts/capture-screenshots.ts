/**
 * Captures the screenshots referenced by the README and docs/diagrams.
 *
 * Prerequisite: `make demo`. This drives the real console with a real browser
 * against the running stack — the images are of the product, not mockups.
 *
 *   pnpm screenshots
 *
 * It first generates a burst of live traffic across several users so the charts,
 * the live stream and the traces have something in them. A screenshot of an
 * empty dashboard is worse than no screenshot.
 */
import { fileURLToPath } from 'node:url';

import { chromium, type Page } from '@playwright/test';

const CONSOLE_URL = process.env.CONSOLE_URL ?? 'http://localhost:3000';
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:9000';
const JAEGER_URL = process.env.JAEGER_UI_URL ?? 'http://localhost:16686';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3001';
const OUT = fileURLToPath(new URL('../docs/diagrams/', import.meta.url));

const VIEWPORT = { width: 1600, height: 1000 };
const PASSWORD = 'Passw0rd!';

async function sha256b64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(digest).toString('base64url');
}

/** Signs in through the real flow and returns an access token. */
async function tokenFor(email: string): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = await sha256b64(verifier);
  const redirectUri = 'http://localhost:3000/auth/callback';

  const authorize = await fetch(`${ISSUER}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'dashboard-bff',
      redirect_uri: redirectUri,
      scope:
        'openid profile email salesforce:read salesforce:read.team salesforce:read.all salesforce:write postgres:read postgres:query policy:evaluate policy:read gateway:admin',
      state: 'capture',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      email,
      password: PASSWORD,
    }).toString(),
  });

  const location = authorize.headers.get('location');
  if (!location) throw new Error(`sign-in failed for ${email} (${authorize.status})`);
  const code = new URL(location).searchParams.get('code') ?? '';

  const token = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('dashboard-bff:dashboard-secret-change-me').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  return ((await token.json()) as { access_token: string }).access_token;
}

/**
 * A burst of traffic with a realistic mix — several users, several tools, and a
 * few calls that are refused, so the deny panels and the audit filters have
 * something to show.
 */
async function generateTraffic(): Promise<void> {
  const people = [
    'alice.chen@acme-corp.com',
    'bob.martinez@acme-corp.com',
    'dana.olsen@acme-corp.com',
    'priya.nair@acme-corp.com',
  ];
  const tokens = Object.fromEntries(
    await Promise.all(people.map(async (email) => [email, await tokenFor(email)] as const)),
  );
  const liam = await tokenFor('liam.novak@initech.dev');

  const call = async (
    token: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    await fetch(`${GATEWAY_URL}/v1/servers/${server}/tools/${tool}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: args }),
    }).then((response) => response.arrayBuffer());
  };

  const work: (() => Promise<void>)[] = [];
  for (let i = 0; i < 24; i += 1) {
    const email = people[i % people.length] as string;
    const token = tokens[email] as string;
    work.push(() => call(token, 'salesforce', 'sf.list_opportunities', { limit: 20 }));
    work.push(() =>
      call(token, 'salesforce', 'sf.query', { soql: 'SELECT Id, Name FROM Account LIMIT 10' }),
    );
    if (i % 3 === 0) work.push(() => call(token, 'postgres', 'pg.list_tables', {}));
    if (i % 4 === 0) {
      work.push(() =>
        call(token, 'postgres', 'pg.query', {
          sql: 'SELECT status, count(*)::int AS orders FROM orders GROUP BY status ORDER BY orders DESC',
        }),
      );
    }
    // Refusals: a restricted-plan tenant reaching for personal data, and a
    // write without the scope for it.
    if (i % 5 === 0)
      work.push(() =>
        call(liam, 'salesforce', 'sf.query', { soql: 'SELECT Id, Email, Phone FROM Contact' }),
      );
    if (i % 7 === 0) {
      work.push(() =>
        call(tokens[people[0] as string] as string, 'salesforce', 'sf.create_task', {
          subject: 'Follow up',
          dueDate: '2026-12-01',
        }),
      );
    }
  }

  // Modest concurrency: enough to look busy, not enough to trip a rate limit.
  let index = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (index < work.length) {
        const job = work[index++];
        await job?.().catch(() => undefined);
      }
    }),
  );
}

async function signInBrowser(page: Page, email: string): Promise<void> {
  await page.goto(CONSOLE_URL, { waitUntil: 'networkidle' });
  const signIn = page.getByRole('link', { name: /continue with single sign-on/i });
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click();
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.waitForURL(new RegExp(CONSOLE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.waitForLoadState('networkidle');
}

async function shot(page: Page, name: string): Promise<void> {
  // Let charts finish their entry animation before capturing.
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  captured ${name}.png`);
}

async function main(): Promise<void> {
  console.log('Generating traffic so the views have something in them');
  await generateTraffic();
  // The overview reads from the audit trail; give the appends a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  const page = await context.newPage();

  try {
    console.log('Capturing the console');

    // Sign-in page, before authenticating.
    await page.goto(CONSOLE_URL, { waitUntil: 'networkidle' });
    await shot(page, 'console-signin');

    await signInBrowser(page, 'dana.olsen@acme-corp.com');
    await shot(page, 'console-overview');

    await page.getByRole('link', { name: 'Live requests' }).click();
    await page.waitForLoadState('networkidle');
    // Expand the first row so the permission-mirroring detail is visible.
    const firstRow = page
      .locator('button')
      .filter({ hasText: /sf\.|pg\./ })
      .first();
    if (await firstRow.isVisible().catch(() => false)) await firstRow.click();
    await shot(page, 'console-live');

    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /verify chain/i }).click();
    await page.getByText(/chain intact/i).waitFor({ timeout: 60_000 });
    await shot(page, 'console-audit');

    await page.getByRole('link', { name: 'Rate limits' }).click();
    await page.waitForLoadState('networkidle');
    await shot(page, 'console-rate-limits');

    await page.getByRole('link', { name: 'Policies' }).click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Evaluate' }).click();
    await page.getByText('deny-warehouse-query-for-viewers').first().waitFor({ timeout: 30_000 });
    await shot(page, 'console-policies');

    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForLoadState('networkidle');
    await shot(page, 'console-settings');

    console.log('Capturing Jaeger');
    // Resolve a trace id through the API and navigate straight to it. Clicking
    // the first /trace/ link on the search page is fragile — Jaeger's own
    // compare affordance matches the same selector.
    const search = (await fetch(
      `${JAEGER_URL}/api/traces?service=gateway&limit=20&lookback=1h`,
    ).then((response) => response.json())) as { data?: { traceID: string; spans?: unknown[] }[] };

    // Prefer a trace with several spans: a single-span trace shows none of the
    // cross-service structure that is the point of the screenshot.
    const richest = (search.data ?? [])
      .slice()
      .sort((a, b) => (b.spans?.length ?? 0) - (a.spans?.length ?? 0))[0];

    if (richest) {
      await page.goto(`${JAEGER_URL}/trace/${richest.traceID}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3_000);
      const expandAll = page.getByRole('button', { name: /expand all/i }).first();
      if (await expandAll.isVisible().catch(() => false)) {
        await expandAll.click();
        await page.waitForTimeout(1_000);
      }
      await shot(page, 'trace-example');
    } else {
      console.log('  no trace found — skipping trace-example.png');
    }

    console.log('Capturing Grafana');
    for (const [uid, name] of [
      ['mcpgw-slos', 'grafana-slos'],
      ['mcpgw-mirroring', 'grafana-mirroring'],
    ] as const) {
      await page.goto(`${GRAFANA_URL}/d/${uid}?from=now-1h&to=now&kiosk`, {
        waitUntil: 'networkidle',
      });
      await page.waitForTimeout(4_000);
      await shot(page, name);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots written to docs/diagrams/`);
}

main().catch((error: unknown) => {
  console.error(`\nCapture failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Is the stack running? Try `make demo` first.\n');
  process.exit(1);
});
