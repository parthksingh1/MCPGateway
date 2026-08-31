export interface LoginPageInput {
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly hidden: Readonly<Record<string, string>>;
  readonly error?: string;
  readonly email?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Verify your identity',
  profile: 'Read your profile',
  email: 'Read your email address',
  offline_access: 'Maintain access when you are away',
  'salesforce:read': 'Read CRM records you own',
  'salesforce:read.team': 'Read CRM records across your team',
  'salesforce:read.all': 'Read CRM records across the organisation',
  'salesforce:write': 'Create and update CRM records',
  'postgres:read': 'Inspect warehouse schemas',
  'postgres:query': 'Run read-only warehouse queries',
  'postgres:admin': 'Administer warehouse access',
  'policy:read': 'Read policy definitions',
  'gateway:admin': 'Administer gateway configuration',
};

/** Server-rendered sign-in page. No client-side framework, no build step. */
export function renderLoginPage(input: LoginPageInput): string {
  const hiddenFields = Object.entries(input.hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
    .join('\n      ');

  const consentItems = input.scopes
    .filter((scope) => SCOPE_LABELS[scope] !== undefined)
    .map((scope) => `<li><span class="dot"></span>${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</li>`)
    .join('\n        ');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in &middot; mcpgateway</title>
<style>
  :root {
    --bg: #0a0c10;
    --panel: #12151c;
    --panel-2: #171b24;
    --border: #232833;
    --text: #e6e9ef;
    --muted: #8b93a4;
    --accent: #4a8fe7;
    --danger: #e5544b;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background:
      radial-gradient(1000px 500px at 50% -10%, rgba(74,143,231,.10), transparent 60%),
      var(--bg);
    color: var(--text);
    font: 400 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 32px 20px;
  }
  .card {
    width: 100%; max-width: 400px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px;
    box-shadow: 0 24px 60px -20px rgba(0,0,0,.7);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .brand svg { display: block; }
  .brand-name { font-weight: 600; letter-spacing: -.01em; font-size: 15px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 6px; letter-spacing: -.02em; font-weight: 600; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
  .sub strong { color: var(--text); font-weight: 500; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
  input[type=email], input[type=password] {
    width: 100%; padding: 10px 12px; margin-bottom: 16px;
    background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius);
    font-size: 14px; font-family: inherit; outline: none;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(74,143,231,.15); }
  button {
    width: 100%; padding: 11px 12px; border: 0; border-radius: var(--radius);
    background: var(--accent); color: #fff; font-size: 14px; font-weight: 500;
    font-family: inherit; cursor: pointer; transition: filter .15s ease;
  }
  button:hover { filter: brightness(1.08); }
  .consent {
    margin: 24px 0 0; padding-top: 20px; border-top: 1px solid var(--border);
  }
  .consent h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .consent ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .consent li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #c3c9d6; }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none; }
  .error {
    background: rgba(229,84,75,.10); border: 1px solid rgba(229,84,75,.35);
    color: #ff9c95; padding: 9px 12px; border-radius: var(--radius);
    font-size: 13px; margin-bottom: 18px;
  }
  .foot { margin-top: 22px; text-align: center; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/authorize">
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.5 20 6.5v6.2c0 4.6-3.3 8.2-8 9.3-4.7-1.1-8-4.7-8-9.3V6.5l8-4Z"
              stroke="#4a8fe7" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M9 12.2l2.1 2.1L15.4 10" stroke="#4a8fe7" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="brand-name">mcpgateway</span>
    </div>

    <h1>Sign in to continue</h1>
    <p class="sub"><strong>${escapeHtml(input.clientName)}</strong> is requesting access to your account.</p>

    ${input.error ? `<div class="error">${escapeHtml(input.error)}</div>` : ''}

    <label for="email">Work email</label>
    <input id="email" name="email" type="email" autocomplete="username" required
           value="${escapeHtml(input.email ?? '')}" placeholder="you@company.com" />

    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required
           placeholder="••••••••" />

    ${hiddenFields}

    <button type="submit">Continue</button>

    ${
      consentItems
        ? `<div class="consent">
      <h2>This will allow ${escapeHtml(input.clientName)} to</h2>
      <ul>
        ${consentItems}
      </ul>
    </div>`
        : ''
    }

    <p class="foot">Protected by OAuth 2.1 with PKCE</p>
  </form>
</body>
</html>`;
}
