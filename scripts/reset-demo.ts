/**
 * Wipes and reloads every dataset.
 *
 * Truncating `audit_events` requires table ownership — the gateway's own role
 * cannot do it, which is the point. This script connects as the owner, which is
 * an administrative operation and is treated as one.
 *
 *   pnpm reset
 *   pnpm reset -- --keep-warehouse
 */
import { createDatabase } from '@mcpgateway/shared/db';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { seed } from './seed.js';

const CONTROL_URL = process.env.DATABASE_URL ?? 'postgres://mcpgw:mcpgw@localhost:5432/mcpgateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function clearControlPlane(): Promise<void> {
  const handle = createDatabase(CONTROL_URL);
  try {
    process.stdout.write('  audit trail ... ');
    // The chain heads go with the events. Leaving them would make the next
    // append link to a hash whose row no longer exists, and verification would
    // correctly report a broken chain on freshly seeded data.
    await handle.db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    await handle.db.execute(sql`TRUNCATE audit_payloads, audit_events RESTART IDENTITY`);
    await handle.db.execute(sql`TRUNCATE audit_chain_heads`);
    await handle.db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
    console.log('cleared');

    process.stdout.write('  configuration ... ');
    await handle.db.execute(sql`TRUNCATE rate_limit_configs`);
    console.log('cleared');
  } finally {
    await handle.close();
  }
}

async function clearRedis(): Promise<void> {
  process.stdout.write('  redis keys ... ');
  const redis = new Redis(REDIS_URL);
  try {
    // Scoped deletes rather than FLUSHDB: this Redis may be shared, and
    // wiping somebody else's keyspace is not this script's business.
    let removed = 0;
    for (const pattern of ['rl:*', 'tex:*', 'sess:*', 'login:*']) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
    }
    console.log(`${removed} removed`);
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const keepWarehouse = process.argv.includes('--keep-warehouse');

  console.log('\nResetting');
  await clearControlPlane();
  await clearRedis();

  console.log('');
  await seed({ skipWarehouse: keepWarehouse });

  console.log('\nReset complete. Run `pnpm verify:audit` to confirm the chains are valid.\n');
}

main().catch((error: unknown) => {
  console.error(`\nReset failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
