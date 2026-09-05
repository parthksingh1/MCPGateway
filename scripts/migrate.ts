/**
 * Migration runner.
 *
 * Applies the checked-in SQL files in lexical order, recording each in
 * `schema_migrations` inside the same transaction as the migration itself, so a
 * partial apply cannot be recorded as complete.
 *
 * The warehouse database has its own directory and its own ledger.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const CONTROL_DIR = new URL('../infra/migrations/', import.meta.url);
const WAREHOUSE_DIR = new URL('../infra/migrations/warehouse/', import.meta.url);

interface Target {
  readonly name: string;
  readonly url: string;
  readonly dir: URL;
}

async function listMigrations(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function applyTo(target: Target): Promise<void> {
  const files = await listMigrations(target.dir);
  if (files.length === 0) {
    console.log(`  ${target.name}: no migrations found`);
    return;
  }

  const client = new pg.Client({ connectionString: target.url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const seen = new Map(applied.rows.map((row) => [row.name, row.checksum.trim()]));

    for (const file of files) {
      const sql = await readFile(new URL(file, target.dir), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = seen.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          // Editing an applied migration means two environments now disagree
          // about what the schema is. Refuse rather than paper over it.
          throw new Error(
            `Migration ${file} has changed since it was applied to ${target.name}. ` +
              'Add a new migration instead of editing a released one.',
          );
        }
        continue;
      }

      process.stdout.write(`  ${target.name}: applying ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        console.log('done');
      } catch (error) {
        await client.query('ROLLBACK');
        console.log('failed');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

export async function runMigrations(options: { controlUrl?: string; warehouseUrl?: string } = {}) {
  const controlUrl =
    options.controlUrl ??
    process.env.DATABASE_URL ??
    'postgres://mcpgw:mcpgw@localhost:5432/mcpgateway';
  const warehouseUrl =
    options.warehouseUrl ??
    process.env.WAREHOUSE_DATABASE_URL ??
    'postgres://mcpgw:mcpgw@localhost:5432/warehouse';

  await applyTo({ name: 'control-plane', url: controlUrl, dir: CONTROL_DIR });
  await applyTo({ name: 'warehouse', url: warehouseUrl, dir: WAREHOUSE_DIR });
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  console.log('Applying migrations');
  runMigrations()
    .then(() => console.log('Migrations complete'))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
