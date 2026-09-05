/**
 * Walks the full OAuth 2.1 + RFC 8693 flow against the running stack and
 * prints each step, including the decoded tokens.
 *
 * The point is to make permission mirroring inspectable: you can see that the
 * token the gateway sends downstream carries the same subject as the one the
 * user signed in with, a narrower scope set, a different audience, and an
 * actor claim naming the gateway.
 *
 *   pnpm oauth:walkthrough
 *   pnpm oauth:walkthrough -- --email bob.martinez@acme-corp.com
 */
const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const BLUE = '[34m';
const GREEN = '[32m';
const YELLOW = '[33m';

const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:9000';
const REDIRECT_URI = 'http://localhost:8080/auth/callback';

function step(number: number, title: string): void {
  console.log(`\n${BOLD}${BLUE}${number}. ${title}${RESET}`);
}

function detail(label: string, value: string): void {
  console.log(`   ${DIM}${label.padEnd(18)}${RESET}${value}`);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('Not a JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function printClaims(claims: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in claims)) continue;
    const value = claims[key];
    const rendered =
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    detail(key, rendered);
  }
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(digest).toString('base64url');
}

async function main(): Promise<void> {
  const emailArg = process.argv.indexOf('--email');
  const email = emailArg === -1 ? 'alice.chen@acme-corp.com' : (process.argv[emailArg + 1] ?? '');

  console.log(`\n${BOLD}Permission mirroring, end to end${RESET}`);
  console.log(`${DIM}issuer ${ISSUER} · subject ${email}${RESET}`);

  // ------------------------------------------------------------------ 1
  step(1, 'Discovery');
  const metadata = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as {
    token_endpoint: string;
    grant_types_supported: string[];
    code_challenge_methods_supported: string[];
  };
  detail('token endpoint', metadata.token_endpoint);
  detail('PKCE methods', metadata.code_challenge_methods_supported.join(', '));
  detail(
    'token exchange',
    metadata.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:token-exchange')
      ? `${GREEN}supported${RESET}`
      : `${YELLOW}not advertised${RESET}`,
  );

  // ------------------------------------------------------------------ 2
  step(2, 'Authorization code with PKCE');
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = await sha256Base64Url(verifier);
  detail('code_verifier', `${verifier.slice(0, 24)}… ${DIM}(never leaves the client)${RESET}`);
  detail('code_challenge', `${challenge.slice(0, 24)}…`);

  const authorize = await fetch(`${ISSUER}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'dashboard-bff',
      redirect_uri: REDIRECT_URI,
      scope:
        'openid profile email salesforce:read salesforce:read.team salesforce:write postgres:read postgres:query policy:evaluate',
      state: 'walkthrough',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      email,
      password: 'Passw0rd!',
    }).toString(),
  });

  const location = authorize.headers.get('location');
  if (!location) throw new Error(`Sign-in failed with status ${authorize.status}`);
  const code = new URL(location).searchParams.get('code') ?? '';
  detail('authorization code', `${code.slice(0, 24)}…`);

  // ------------------------------------------------------------------ 3
  step(3, 'Exchange the code for the caller access token');
  const tokenResponse = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('dashboard-bff:dashboard-secret-change-me').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });

  const tokens = (await tokenResponse.json()) as { access_token: string; scope: string };
  const callerClaims = decodeJwtPayload(tokens.access_token);
  console.log(`   ${DIM}claims:${RESET}`);
  printClaims(callerClaims, ['iss', 'sub', 'aud', 'tenant_id', 'role', 'scope', 'jti']);

  // ------------------------------------------------------------------ 4
  step(4, 'Token exchange for the CRM server (RFC 8693)');
  console.log(
    `   ${DIM}This is what the gateway does on every call. The subject token is the${RESET}`,
  );
  console.log(`   ${DIM}caller's; the result is addressed to one downstream service.${RESET}\n`);

  const exchanged = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('mcp-gateway:gateway-secret-change-me').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: tokens.access_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: 'mcp:salesforce',
    }).toString(),
  });

  if (!exchanged.ok) {
    const error = (await exchanged.json()) as { error: string; error_description: string };
    throw new Error(`Exchange refused: ${error.error} — ${error.error_description}`);
  }

  const downstream = (await exchanged.json()) as { access_token: string; expires_in: number };
  const downstreamClaims = decodeJwtPayload(downstream.access_token);
  printClaims(downstreamClaims, ['iss', 'sub', 'aud', 'tenant_id', 'role', 'scope', 'act', 'exp']);

  // ------------------------------------------------------------------ 5
  step(5, 'What changed');
  const callerScopes = String(callerClaims.scope ?? '')
    .split(' ')
    .filter(Boolean);
  const downstreamScopes = String(downstreamClaims.scope ?? '')
    .split(' ')
    .filter(Boolean);

  const sameSubject = callerClaims.sub === downstreamClaims.sub;
  const narrowed = downstreamScopes.every((scope) => callerScopes.includes(scope));

  detail(
    'subject',
    sameSubject
      ? `${GREEN}unchanged${RESET} ${DIM}(${String(downstreamClaims.sub)}) — the downstream service authorises the human${RESET}`
      : `${YELLOW}changed${RESET}`,
  );
  detail(
    'audience',
    `${String(callerClaims.aud)} → ${BOLD}${String(downstreamClaims.aud)}${RESET}`,
  );
  detail(
    'scopes',
    `${callerScopes.length} → ${downstreamScopes.length} ${narrowed ? `${GREEN}(subset)${RESET}` : `${YELLOW}(NOT a subset)${RESET}`}`,
  );
  detail(
    'dropped',
    callerScopes.filter((scope) => !downstreamScopes.includes(scope)).join(' ') || '—',
  );
  detail('actor', downstreamClaims.act ? JSON.stringify(downstreamClaims.act) : '—');
  detail('lifetime', `${downstream.expires_in}s`);

  // ------------------------------------------------------------------ 6
  step(6, 'Widening is not expressible');
  const widened = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('mcp-gateway:gateway-secret-change-me').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: tokens.access_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: 'mcp:salesforce',
      scope: 'salesforce:read.all',
    }).toString(),
  });

  const widenResult = (await widened.json()) as { error?: string; error_description?: string };
  if (widened.ok) {
    console.log(`   ${YELLOW}The provider granted a scope the subject does not hold.${RESET}`);
  } else {
    detail('requested', 'salesforce:read.all (an admin-only scope)');
    detail(
      'result',
      `${GREEN}refused${RESET} — ${widenResult.error}: ${widenResult.error_description}`,
    );
  }

  console.log(
    `\n${DIM}The gateway performs steps 4 and 6 on every request. There is no code path\nthat falls back to a service account when an exchange fails.${RESET}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(`\nWalkthrough failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Is the identity provider running? Try `make demo` first.\n');
  process.exit(1);
});
