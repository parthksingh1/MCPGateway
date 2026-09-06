import { BadRequestError, UpstreamError, type Role } from '@mcpgateway/shared';
import { withSpan, annotate } from '@mcpgateway/telemetry';
import pg from 'pg';

import { guardStatement } from './guard.js';

export interface WarehouseCaller {
  readonly tenantId: string;
  readonly role: Role;
  readonly territory: string | null;
}

export interface QueryOutcome {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly appliedRole: string;
}

export interface WarehouseOptions {
  readonly connectionString: string;
  readonly statementTimeoutMs: number;
  readonly maxRows: number;
  readonly poolSize?: number;
}

/** Only these tables are addressable through the tool surface. */
export const EXPOSED_TABLES = ['customers', 'products', 'orders', 'order_items'] as const;
export type ExposedTable = (typeof EXPOSED_TABLES)[number];

/**
 * Upper bound on the row counts reported by `pg.list_tables`. Large enough to
 * be useful, small enough that the listing stays O(1) in table size.
 */
const LIST_TABLES_COUNT_CAP = 10_000;

const ROLE_TO_DB_ROLE: Record<Role, string> = {
  admin: 'app_admin',
  manager: 'app_manager',
  analyst: 'app_analyst',
  viewer: 'app_viewer',
};

/**
 * Warehouse access, scoped per request by the database itself.
 *
 * Every statement runs inside a transaction that first assumes the Postgres
 * role mirroring the caller's application role and publishes the caller's
 * tenant and territory as transaction-local settings. Row-level security
 * policies read those settings, so what comes back is what that specific person
 * is entitled to see — not what the application remembered to filter.
 *
 * All three values come from the verified downstream token. None of them can be
 * influenced by a tool argument, which is what stops a caller from asking for
 * someone else's rows.
 */
export class Warehouse {
  private readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;
  private readonly maxRows: number;

  constructor(options: WarehouseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'mcp-postgres',
    });
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.maxRows = options.maxRows;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Run `fn` in a read-only transaction with the caller's role and context
   * applied. `SET LOCAL` scopes all of it to the transaction, so a pooled
   * connection can never leak one caller's identity into the next request.
   */
  private async withCallerContext<T>(
    caller: WarehouseCaller,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const dbRole = ROLE_TO_DB_ROLE[caller.role];
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Number(this.statementTimeoutMs)}`);
      // Parameterised: these values come from a token, but building SQL by
      // concatenation is a habit worth not having.
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', caller.tenantId]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.territory',
        caller.territory ?? '',
      ]);
      // SET LOCAL ROLE takes an identifier, not a parameter. The value is from a
      // fixed map keyed by a validated enum, never from request data.
      await client.query(`SET LOCAL ROLE ${dbRole}`);

      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listTables(caller: WarehouseCaller): Promise<{
    tables: { name: string; rowsVisible: number; exact: boolean; description: string }[];
    appliedRole: string;
    countedUpTo: number;
  }> {
    return withSpan('warehouse.list_tables', async () => {
      const descriptions: Record<ExposedTable, string> = {
        customers: 'Customer accounts, one row per customer, scoped by territory',
        products: 'Product catalogue with list prices',
        orders: 'Order headers with status, channel and total value',
        order_items: 'Order line items joining orders to products',
      };

      // Counting is bounded rather than exhaustive. An unbounded COUNT(*) is a
      // full scan of every visible row, and `order_items` is only visible
      // through a correlated EXISTS against `orders`, so the planner evaluates
      // that predicate per row. On a modest warehouse that alone exceeded the
      // statement timeout — a listing endpoint that gets slower as the data
      // grows, to render a number nobody reads precisely.
      //
      // Stopping at the cap gives an O(cap) answer that still respects
      // row-level security, and the response says which counts are exact so the
      // caller is not misled.
      const cap = LIST_TABLES_COUNT_CAP;

      return this.withCallerContext(caller, async (client) => {
        const tables: {
          name: string;
          rowsVisible: number;
          exact: boolean;
          description: string;
        }[] = [];

        for (const table of EXPOSED_TABLES) {
          // Counted through the caller's own role, so "rows visible" means
          // visible to them rather than the true table size.
          const result = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM (SELECT 1 FROM ${table} LIMIT ${cap + 1}) AS capped`,
          );
          const counted = Number(result.rows[0]?.count ?? 0);
          tables.push({
            name: table,
            rowsVisible: Math.min(counted, cap),
            exact: counted <= cap,
            description: descriptions[table],
          });
        }

        return { tables, appliedRole: ROLE_TO_DB_ROLE[caller.role], countedUpTo: cap };
      });
    });
  }

  /**
   * `caller` is accepted for symmetry with the other operations but is not used
   * to scope the read: describing a table's columns is structure, not rows, and
   * the caller's role has no catalog privileges by design.
   */
  async describeTable(
    _caller: WarehouseCaller,
    table: string,
  ): Promise<{
    table: string;
    columns: { name: string; type: string; nullable: boolean }[];
    rowLevelSecurity: string;
  }> {
    if (!EXPOSED_TABLES.includes(table as ExposedTable)) {
      throw new BadRequestError(
        `Unknown table '${table}'. Available tables: ${EXPOSED_TABLES.join(', ')}`,
        { available: EXPOSED_TABLES },
      );
    }

    return withSpan('warehouse.describe_table', async () => {
      const result = await this.pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [table],
      );

      const territoryScoped = table === 'customers' || table === 'orders';
      return {
        table,
        columns: result.rows.map((row) => ({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
        })),
        rowLevelSecurity: territoryScoped
          ? 'Tenant-scoped for every role; additionally territory-scoped for analyst and viewer.'
          : 'Tenant-scoped for every role.',
      };
    });
  }

  async query(caller: WarehouseCaller, sql: string, limit?: number): Promise<QueryOutcome> {
    const effectiveMax = Math.min(limit ?? this.maxRows, this.maxRows);
    const guarded = guardStatement(sql, { maxRows: effectiveMax });

    return withSpan('warehouse.query', async () => {
      annotate({ 'db.system': 'postgresql', 'db.operation': 'SELECT' });
      const startedAt = performance.now();

      return this.withCallerContext(caller, async (client) => {
        let result: pg.QueryResult;
        try {
          result = await client.query(guarded.sql);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Query failed';
          if (/statement timeout|canceling statement/i.test(message)) {
            throw new UpstreamError(
              'warehouse',
              `Query exceeded the ${this.statementTimeoutMs}ms statement timeout`,
              { timeoutMs: this.statementTimeoutMs },
            );
          }
          // Surface the database's own message: it is the most useful thing an
          // analyst can act on, and it cannot leak rows.
          throw new BadRequestError(`Query rejected by the database: ${message}`);
        }

        const durationMs = performance.now() - startedAt;
        return {
          columns: result.fields.map((field) => field.name),
          rows: result.rows as Record<string, unknown>[],
          rowCount: result.rowCount ?? result.rows.length,
          truncated: (result.rowCount ?? 0) >= guarded.limit,
          durationMs: Number(durationMs.toFixed(2)),
          appliedRole: ROLE_TO_DB_ROLE[caller.role],
        };
      });
    });
  }
}
