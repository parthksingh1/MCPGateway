/**
 * Loads the control plane, the warehouse and a week of audit history.
 *
 * Idempotent: every insert either upserts or is preceded by a delete of the
 * rows it owns, so running it twice leaves the same state. The audit history is
 * the exception — it is appended through the real writer so that the hash chain
 * it produces is genuinely valid, which means a re-run adds to it rather than
 * replacing it. `scripts/reset-demo.ts` clears first.
 */
import { AuditWriter } from '@mcpgateway/audit';
import { createDatabase } from '@mcpgateway/shared/db';
import { sql } from 'drizzle-orm';

// Read lazily rather than at module load, so a caller that sets the
// environment after importing this module still gets the database it meant.
const controlUrl = (): string =>
  process.env.DATABASE_URL ?? 'postgres://mcpgw:mcpgw@localhost:5432/mcpgateway';
const warehouseUrl = (): string =>
  process.env.WAREHOUSE_DATABASE_URL ?? 'postgres://mcpgw:mcpgw@localhost:5432/warehouse';
const auditUrl = (): string => process.env.AUDIT_DATABASE_URL ?? controlUrl();

// Same seed as the CRM fixture generator, so the two datasets have the same
// shape and the same territories.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = createRandom(0x5f3a_71c9);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (min: number, max: number): number => min + random() * (max - min);
const intBetween = (min: number, max: number): number => Math.floor(between(min, max + 1));

interface TenantSeed {
  readonly id: string;
  readonly name: string;
  readonly plan: 'enterprise' | 'pro' | 'restricted';
  readonly region: string;
  readonly territories: readonly string[];
}

const TENANTS: readonly TenantSeed[] = [
  {
    id: 'acme-corp',
    name: 'Acme Corp',
    plan: 'enterprise',
    region: 'us-east-1',
    territories: ['West', 'East'],
  },
  {
    id: 'globex',
    name: 'Globex',
    plan: 'pro',
    region: 'eu-west-1',
    territories: ['North', 'South'],
  },
  {
    id: 'initech',
    name: 'Initech',
    plan: 'restricted',
    region: 'us-west-2',
    territories: ['Central'],
  },
];

interface UserSeed {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'admin' | 'manager' | 'analyst' | 'viewer';
  readonly title: string;
  readonly territory: string | null;
  readonly managerId: string | null;
}

/** Mirrors apps/mock-idp/seed.json. The identity provider is the source of truth. */
const USERS: readonly UserSeed[] = [
  {
    id: 'usr_alice',
    tenantId: 'acme-corp',
    email: 'alice.chen@acme-corp.com',
    name: 'Alice Chen',
    role: 'analyst',
    title: 'Revenue Analyst',
    territory: 'West',
    managerId: 'usr_bob',
  },
  {
    id: 'usr_bob',
    tenantId: 'acme-corp',
    email: 'bob.martinez@acme-corp.com',
    name: 'Bob Martinez',
    role: 'manager',
    title: 'Director, West Region',
    territory: 'West',
    managerId: null,
  },
  {
    id: 'usr_dana',
    tenantId: 'acme-corp',
    email: 'dana.olsen@acme-corp.com',
    name: 'Dana Olsen',
    role: 'admin',
    title: 'Platform Administrator',
    territory: null,
    managerId: null,
  },
  {
    id: 'usr_evan',
    tenantId: 'acme-corp',
    email: 'evan.reyes@acme-corp.com',
    name: 'Evan Reyes',
    role: 'viewer',
    title: 'Account Executive',
    territory: 'East',
    managerId: 'usr_priya',
  },
  {
    id: 'usr_priya',
    tenantId: 'acme-corp',
    email: 'priya.nair@acme-corp.com',
    name: 'Priya Nair',
    role: 'analyst',
    title: 'Revenue Analyst',
    territory: 'East',
    managerId: 'usr_bob',
  },
  {
    id: 'usr_grace',
    tenantId: 'globex',
    email: 'grace.kim@globex.io',
    name: 'Grace Kim',
    role: 'manager',
    title: 'Head of Sales Operations',
    territory: 'North',
    managerId: null,
  },
  {
    id: 'usr_hugo',
    tenantId: 'globex',
    email: 'hugo.silva@globex.io',
    name: 'Hugo Silva',
    role: 'analyst',
    title: 'Sales Analyst',
    territory: 'North',
    managerId: 'usr_grace',
  },
  {
    id: 'usr_ines',
    tenantId: 'globex',
    email: 'ines.dubois@globex.io',
    name: 'Ines Dubois',
    role: 'admin',
    title: 'Platform Administrator',
    territory: null,
    managerId: null,
  },
  {
    id: 'usr_jonah',
    tenantId: 'globex',
    email: 'jonah.wright@globex.io',
    name: 'Jonah Wright',
    role: 'viewer',
    title: 'Account Executive',
    territory: 'South',
    managerId: 'usr_grace',
  },
  {
    id: 'usr_karen',
    tenantId: 'initech',
    email: 'karen.blake@initech.dev',
    name: 'Karen Blake',
    role: 'manager',
    title: 'Commercial Lead',
    territory: 'Central',
    managerId: null,
  },
  {
    id: 'usr_liam',
    tenantId: 'initech',
    email: 'liam.novak@initech.dev',
    name: 'Liam Novak',
    role: 'analyst',
    title: 'Business Analyst',
    territory: 'Central',
    managerId: 'usr_karen',
  },
  {
    id: 'usr_mia',
    tenantId: 'initech',
    email: 'mia.torres@initech.dev',
    name: 'Mia Torres',
    role: 'viewer',
    title: 'Support Specialist',
    territory: 'Central',
    managerId: 'usr_karen',
  },
];

const CLIENTS = [
  {
    clientId: 'dashboard-bff',
    name: 'Operations Console',
    confidential: true,
    redirectUris: ['http://localhost:3000/auth/callback', 'http://localhost:8080/auth/callback'],
    allowedScopes: [
      'openid',
      'profile',
      'email',
      'offline_access',
      'salesforce:read',
      'salesforce:read.team',
      'salesforce:read.all',
      'salesforce:write',
      'postgres:read',
      'postgres:query',
      'postgres:admin',
      'policy:evaluate',
      'policy:read',
      'gateway:admin',
    ],
    allowedGrants: ['authorization_code', 'refresh_token'],
  },
  {
    clientId: 'mcp-gateway',
    name: 'MCP Gateway',
    confidential: true,
    redirectUris: [],
    allowedScopes: [
      'salesforce:read',
      'salesforce:read.team',
      'salesforce:read.all',
      'salesforce:write',
      'postgres:read',
      'postgres:query',
      'postgres:admin',
      'policy:evaluate',
      'policy:read',
    ],
    allowedGrants: ['client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange'],
  },
  {
    clientId: 'claude-desktop',
    name: 'Claude Desktop',
    confidential: false,
    redirectUris: ['http://127.0.0.1:33418/callback'],
    allowedScopes: [
      'openid',
      'profile',
      'email',
      'offline_access',
      'salesforce:read',
      'salesforce:read.team',
      'postgres:read',
      'postgres:query',
      'policy:evaluate',
      'policy:read',
    ],
    allowedGrants: ['authorization_code', 'refresh_token'],
  },
  {
    clientId: 'internal-agent',
    name: 'Internal Automation Agent',
    confidential: true,
    redirectUris: [],
    allowedScopes: ['postgres:read', 'postgres:query'],
    allowedGrants: ['client_credentials'],
  },
];

/**
 * Rate limits per plan. Enterprise gets a `burst` tier as well, which the
 * policy bundle's tier-override rule selects.
 */
const RATE_LIMITS: Record<TenantSeed['plan'], { tenant: number; user: number; burst?: number }> = {
  enterprise: { tenant: 12_000, user: 600, burst: 1_800 },
  pro: { tenant: 3_000, user: 180 },
  restricted: { tenant: 600, user: 30 },
};

const TOOL_NAMES = [
  'sf.query',
  'sf.get_contact',
  'sf.list_opportunities',
  'sf.create_task',
  'pg.list_tables',
  'pg.describe_table',
  'pg.query',
];

const SERVER_FOR_TOOL: Record<string, string> = {
  'sf.query': 'salesforce',
  'sf.get_contact': 'salesforce',
  'sf.list_opportunities': 'salesforce',
  'sf.create_task': 'salesforce',
  'pg.list_tables': 'postgres',
  'pg.describe_table': 'postgres',
  'pg.query': 'postgres',
};

const DENY_REASONS = [
  'policy:deny-pii-on-restricted-plan',
  'policy:deny-bulk-extraction',
  'policy:deny-warehouse-query-for-viewers',
  'scope:salesforce:write',
  'rate_limit:user:tool',
  'permission_mirror:no_scopes_for_mcp:salesforce',
];

async function seedControlPlane(): Promise<void> {
  const handle = createDatabase(controlUrl());
  try {
    process.stdout.write('  tenants, users, clients ... ');
    for (const tenant of TENANTS) {
      await handle.db.execute(sql`
        INSERT INTO tenants (id, name, plan, region)
        VALUES (${tenant.id}, ${tenant.name}, ${tenant.plan}, ${tenant.region})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan, region = EXCLUDED.region
      `);
      await handle.db.execute(sql`
        INSERT INTO tenant_settings (tenant_id, audit_payload_capture, policy_bundle)
        VALUES (${tenant.id}, false, 'baseline')
        ON CONFLICT (tenant_id) DO NOTHING
      `);
    }

    for (const user of USERS) {
      await handle.db.execute(sql`
        INSERT INTO users (id, tenant_id, email, name, role, title, territory, manager_id)
        VALUES (${user.id}, ${user.tenantId}, ${user.email}, ${user.name}, ${user.role},
                ${user.title}, ${user.territory}, ${user.managerId})
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
          title = EXCLUDED.title, territory = EXCLUDED.territory, manager_id = EXCLUDED.manager_id
      `);
    }

    for (const client of CLIENTS) {
      await handle.db.execute(sql`
        INSERT INTO oauth_clients (client_id, name, confidential, redirect_uris, allowed_scopes, allowed_grants)
        VALUES (${client.clientId}, ${client.name}, ${client.confidential},
                ${JSON.stringify(client.redirectUris)}::jsonb,
                ${JSON.stringify(client.allowedScopes)}::jsonb,
                ${JSON.stringify(client.allowedGrants)}::jsonb)
        ON CONFLICT (client_id) DO UPDATE SET
          name = EXCLUDED.name, allowed_scopes = EXCLUDED.allowed_scopes,
          allowed_grants = EXCLUDED.allowed_grants, redirect_uris = EXCLUDED.redirect_uris
      `);
    }
    console.log('done');

    process.stdout.write('  rate limits ... ');
    for (const tenant of TENANTS) {
      const limits = RATE_LIMITS[tenant.plan];

      await upsertRateLimit(handle.db, tenant.id, 'tenant', '*', 'default', limits.tenant, 60_000);
      await upsertRateLimit(handle.db, tenant.id, 'user_tool', '*', 'default', limits.user, 60_000);

      if (limits.burst) {
        await upsertRateLimit(
          handle.db,
          tenant.id,
          'tenant',
          '*',
          'burst',
          limits.tenant * 2,
          60_000,
        );
        await upsertRateLimit(
          handle.db,
          tenant.id,
          'user_tool',
          '*',
          'burst',
          limits.burst,
          60_000,
        );
      }

      // The throttled tier the policy bundle selects for restricted plans.
      await upsertRateLimit(
        handle.db,
        tenant.id,
        'tenant',
        '*',
        'throttled',
        Math.max(60, Math.round(limits.tenant / 4)),
        60_000,
      );
      await upsertRateLimit(
        handle.db,
        tenant.id,
        'user_tool',
        '*',
        'throttled',
        Math.max(10, Math.round(limits.user / 4)),
        60_000,
      );

      // Warehouse queries are the expensive call, so they get their own,
      // tighter bucket regardless of plan.
      await upsertRateLimit(
        handle.db,
        tenant.id,
        'user_tool',
        'pg.query',
        'default',
        Math.max(10, Math.round(limits.user / 6)),
        60_000,
      );
    }
    console.log('done');
  } finally {
    await handle.close();
  }
}

async function upsertRateLimit(
  db: ReturnType<typeof createDatabase>['db'],
  tenantId: string,
  scopeType: string,
  toolName: string,
  tier: string,
  capacity: number,
  intervalMs: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO rate_limit_configs (tenant_id, scope_type, tool_name, tier, capacity, refill_tokens, refill_interval_ms)
    VALUES (${tenantId}, ${scopeType}, ${toolName}, ${tier}, ${capacity}, ${capacity}, ${intervalMs})
    ON CONFLICT (tenant_id, scope_type, tool_name, tier) DO UPDATE SET
      capacity = EXCLUDED.capacity,
      refill_tokens = EXCLUDED.refill_tokens,
      refill_interval_ms = EXCLUDED.refill_interval_ms,
      updated_at = now()
  `);
}

const PRODUCT_CATEGORIES = ['Hardware', 'Software', 'Services', 'Support', 'Training'];
const CHANNELS = ['direct', 'partner', 'self-serve', 'marketplace'];
const ORDER_STATUS = ['completed', 'completed', 'completed', 'shipped', 'pending', 'cancelled'];
const SEGMENTS = ['Enterprise', 'Mid-Market', 'SMB'];
const COUNTRIES = ['US', 'US', 'US', 'CA', 'GB', 'DE', 'FR', 'AU'];

/**
 * Seasonality: a weekly cycle (weekdays busier than weekends) multiplied by a
 * quarter-end push. Without it every chart in the console is a flat line, which
 * makes the console look broken rather than quiet.
 */
function volumeMultiplier(date: Date): number {
  const weekday = date.getUTCDay();
  const weekly = weekday === 0 || weekday === 6 ? 0.35 : 1;
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth();
  const quarterEnd = month % 3 === 2 && dayOfMonth > 20 ? 1.8 : 1;
  return weekly * quarterEnd;
}

async function seedWarehouse(): Promise<void> {
  const handle = createDatabase(warehouseUrl());
  try {
    process.stdout.write('  clearing warehouse ... ');
    await handle.db.execute(
      sql`TRUNCATE order_items, orders, customers, products RESTART IDENTITY CASCADE`,
    );
    console.log('done');

    process.stdout.write('  products ... ');
    const products: { id: number; tenantId: string; price: number }[] = [];
    let productId = 1;
    for (const tenant of TENANTS) {
      const values: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        const price = Number(between(19, 4_800).toFixed(2));
        const category = pick(PRODUCT_CATEGORIES);
        products.push({ id: productId, tenantId: tenant.id, price });
        values.push(
          `(${productId}, '${tenant.id}', 'SKU-${String(productId).padStart(5, '0')}', '${category} Package ${i + 1}', '${category}', ${price})`,
        );
        productId += 1;
      }
      await handle.db.execute(
        sql.raw(
          `INSERT INTO products (id, tenant_id, sku, name, category, unit_price) VALUES ${values.join(',')}`,
        ),
      );
    }
    console.log(`${products.length} rows`);

    process.stdout.write('  customers ... ');
    const customers: { id: number; tenantId: string; territory: string }[] = [];
    let customerId = 1;
    for (const tenant of TENANTS) {
      const values: string[] = [];
      const count = tenant.id === 'acme-corp' ? 1_400 : tenant.id === 'globex' ? 900 : 500;
      for (let i = 0; i < count; i += 1) {
        const territory = pick(tenant.territories);
        const segment = pick(SEGMENTS);
        const created = new Date(Date.now() - intBetween(30, 900) * 86_400_000).toISOString();
        customers.push({ id: customerId, tenantId: tenant.id, territory });
        values.push(
          `(${customerId}, '${tenant.id}', '${territory}', 'Customer ${customerId}', 'customer${customerId}@${tenant.id}.example', '+1-555-${String(intBetween(1000, 9999))}', '${pick(['Springfield', 'Riverton', 'Fairview', 'Lakeside', 'Ashford'])}', '${pick(COUNTRIES)}', '${segment}', '${created}')`,
        );
        customerId += 1;
      }
      for (let i = 0; i < values.length; i += 500) {
        await handle.db.execute(
          sql.raw(
            `INSERT INTO customers (id, tenant_id, territory, name, email, phone, city, country, segment, created_at) VALUES ${values.slice(i, i + 500).join(',')}`,
          ),
        );
      }
    }
    console.log(`${customers.length} rows`);

    process.stdout.write('  orders and line items ... ');
    const TOTAL_ORDERS = 50_000;
    const DAYS = 90;
    let orderId = 1;
    let itemId = 1;

    // Distribute orders across 90 days weighted by the seasonality curve, so
    // the daily totals have shape rather than being uniform noise.
    const weights: number[] = [];
    for (let day = 0; day < DAYS; day += 1) {
      const date = new Date(Date.now() - (DAYS - day) * 86_400_000);
      weights.push(volumeMultiplier(date));
    }
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

    for (let day = 0; day < DAYS; day += 1) {
      const dayOrders = Math.round((TOTAL_ORDERS * (weights[day] ?? 1)) / weightTotal);
      const orderValues: string[] = [];
      const itemValues: string[] = [];

      for (let i = 0; i < dayOrders; i += 1) {
        const customer = customers[Math.floor(random() * customers.length)];
        if (!customer) continue;

        const timestamp = new Date(
          Date.now() - (DAYS - day) * 86_400_000 + intBetween(0, 86_399) * 1_000,
        ).toISOString();

        const lineCount = intBetween(1, 5);
        let total = 0;
        const tenantProducts = products.filter((product) => product.tenantId === customer.tenantId);

        for (let line = 0; line < lineCount; line += 1) {
          const product = tenantProducts[Math.floor(random() * tenantProducts.length)];
          if (!product) continue;
          const quantity = intBetween(1, 12);
          const lineTotal = Number((product.price * quantity).toFixed(2));
          total += lineTotal;
          itemValues.push(
            `(${itemId}, ${orderId}, ${product.id}, ${quantity}, ${product.price}, ${lineTotal})`,
          );
          itemId += 1;
        }

        orderValues.push(
          `(${orderId}, '${customer.tenantId}', '${customer.territory}', ${customer.id}, '${timestamp}', '${pick(ORDER_STATUS)}', '${pick(CHANNELS)}', ${total.toFixed(2)})`,
        );
        orderId += 1;
      }

      if (orderValues.length > 0) {
        for (let i = 0; i < orderValues.length; i += 500) {
          await handle.db.execute(
            sql.raw(
              `INSERT INTO orders (id, tenant_id, territory, customer_id, order_date, status, channel, total_amount) VALUES ${orderValues.slice(i, i + 500).join(',')}`,
            ),
          );
        }
      }
      if (itemValues.length > 0) {
        for (let i = 0; i < itemValues.length; i += 500) {
          await handle.db.execute(
            sql.raw(
              `INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total) VALUES ${itemValues.slice(i, i + 500).join(',')}`,
            ),
          );
        }
      }
    }
    console.log(`${orderId - 1} orders, ${itemId - 1} line items`);

    await handle.db.execute(sql`ANALYZE customers, products, orders, order_items`);
  } finally {
    await handle.close();
  }
}

/**
 * Seven days of audit history, written through the real `AuditWriter` so the
 * chain it produces genuinely verifies. Seeding rows with a fabricated hash
 * would make the verifier's green tick meaningless the first time anyone
 * checked it.
 */
async function seedAuditHistory(count: number): Promise<void> {
  const handle = createDatabase(auditUrl(), 5);
  const writer = new AuditWriter(handle.db);

  try {
    const now = Date.now();
    const window = 7 * 24 * 60 * 60 * 1000;

    // Rejection sampling against the seasonality curve, so quiet periods are
    // genuinely quieter rather than uniformly noisy — then sorted so `seq` and
    // `ts` agree and the console's ordering reads as a real timeline.
    const events: { at: Date }[] = [];
    let attempts = 0;
    while (events.length < count && attempts < count * 20) {
      attempts += 1;
      const at = new Date(now - random() * window);
      if (random() < volumeMultiplier(at)) events.push({ at });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    let written = 0;
    for (const event of events) {
      const tenant = pick(TENANTS);
      const candidates = USERS.filter((user) => user.tenantId === tenant.id);
      const user = pick(candidates);
      const tool = pick(TOOL_NAMES);

      // Restricted tenants and viewers are denied more often, which is what
      // makes the console's deny-rate panel show a difference between tenants.
      const denyChance = tenant.plan === 'restricted' ? 0.28 : user.role === 'viewer' ? 0.12 : 0.04;
      const denied = random() < denyChance;

      // Warehouse queries are slower than CRM lookups, and a small tail is
      // slower still, so the percentile panels have something to show.
      const base = tool.startsWith('pg.') ? between(25, 140) : between(8, 55);
      const latency = random() < 0.02 ? base * between(4, 12) : base;

      await writer.append({
        tenantId: tenant.id,
        userId: user.id,
        actorTokenJti: `seed_${Math.floor(random() * 1e9).toString(36)}`,
        mcpServer: SERVER_FOR_TOOL[tool] ?? 'salesforce',
        toolName: tool,
        arguments: { seeded: true, tool, at: event.at.toISOString() },
        decision: denied ? 'deny' : 'allow',
        denyReason: denied ? pick(DENY_REASONS) : null,
        latencyMs: Math.round(denied ? latency / 3 : latency),
        traceId: Math.floor(random() * 1e16)
          .toString(16)
          .padStart(32, '0'),
        occurredAt: event.at,
      });

      written += 1;
      if (written % 500 === 0)
        process.stdout.write(`\r  audit history ... ${written}/${events.length}`);
    }
    console.log(`\r  audit history ... ${written} events                    `);
  } finally {
    await handle.close();
  }
}

export async function seed(
  options: { auditEvents?: number; skipWarehouse?: boolean } = {},
): Promise<void> {
  console.log('Seeding control plane');
  await seedControlPlane();

  if (!options.skipWarehouse) {
    console.log('Seeding warehouse');
    await seedWarehouse();
  }

  console.log('Seeding audit history');
  await seedAuditHistory(options.auditEvents ?? 5_000);
}

const invokedDirectly = process.argv[1]?.endsWith('seed.ts') === true;

if (invokedDirectly) {
  const startedAt = Date.now();
  seed()
    .then(() => console.log(`\nSeed complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`))
    .catch((error: unknown) => {
      console.error('\nSeed failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
