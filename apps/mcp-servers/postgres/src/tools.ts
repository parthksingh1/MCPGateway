import { defineTool, type ToolDefinition, type ToolContext } from '@mcpgateway/mcp-runtime';
import { z } from 'zod';

import { EXPOSED_TABLES, type Warehouse, type WarehouseCaller } from './warehouse.js';

/**
 * The caller is derived entirely from the verified token. There is deliberately
 * no tool argument for tenant, role or territory: if a caller could name them,
 * the row-level security policies would be advisory rather than enforcing.
 */
function callerFrom(context: ToolContext): WarehouseCaller {
  return {
    tenantId: context.principal.tenantId,
    role: context.principal.role,
    territory: context.principal.territory,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runtime's tool list is heterogeneous; see McpServiceOptions.
export function createWarehouseTools(warehouse: Warehouse): ToolDefinition<any>[] {
  const listTables = defineTool({
    name: 'pg.list_tables',
    title: 'List warehouse tables',
    description:
      'Lists the warehouse tables available to the caller, with the number of rows each one exposes to them under row-level security.',
    inputSchema: {},
    requiredScopes: ['postgres:read'],
    readOnly: true,
    handler: async (_args, context) => warehouse.listTables(callerFrom(context)),
  });

  const describeTable = defineTool({
    name: 'pg.describe_table',
    title: 'Describe a warehouse table',
    description:
      'Returns the columns of a warehouse table and a note on how row-level security applies to it.',
    inputSchema: {
      table: z.enum(EXPOSED_TABLES).describe(`One of: ${EXPOSED_TABLES.join(', ')}`),
    },
    requiredScopes: ['postgres:read'],
    readOnly: true,
    handler: async (args, context) => warehouse.describeTable(callerFrom(context), args.table),
  });

  const query = defineTool({
    name: 'pg.query',
    title: 'Run a read-only warehouse query',
    description:
      'Executes a single SELECT (or WITH) statement against the warehouse. The statement runs in a read-only transaction under the caller own database role, so results are already restricted to the rows they are entitled to see. Catalog schemas are not reachable and the result set is capped.',
    inputSchema: {
      sql: z.string().min(1).describe('A single SELECT or WITH statement'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5_000)
        .optional()
        .describe('Maximum rows to return; capped by the server maximum'),
    },
    requiredScopes: ['postgres:query'],
    readOnly: true,
    handler: async (args, context) => warehouse.query(callerFrom(context), args.sql, args.limit),
  });

  return [listTables, describeTable, query];
}
