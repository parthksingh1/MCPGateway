import { createMcpService } from '@mcpgateway/mcp-runtime';
import { loadConfig, warehouseConfigSchema } from '@mcpgateway/shared';
import { createLogger } from '@mcpgateway/telemetry';

import { createWarehouseTools } from './tools.js';
import { Warehouse } from './warehouse.js';

const log = createLogger({ serviceName: 'mcp-postgres' });

async function main(): Promise<void> {
  const config = loadConfig(warehouseConfigSchema);

  const warehouse = new Warehouse({
    connectionString: config.WAREHOUSE_DATABASE_URL,
    statementTimeoutMs: config.PG_STATEMENT_TIMEOUT_MS,
    maxRows: config.PG_MAX_ROWS,
  });

  const service = await createMcpService({
    serviceName: config.SERVICE_NAME,
    issuer: config.OIDC_ISSUER,
    ...(config.OIDC_ISSUER_INTERNAL ? { issuerInternal: config.OIDC_ISSUER_INTERNAL } : {}),
    expectedAudience: config.EXPECTED_AUDIENCE,
    tools: createWarehouseTools(warehouse),
    readiness: async () => ({ warehouse: (await warehouse.ping()) ? 'ok' : 'down' }),
    logger: log,
  });

  await service.listen(config.PORT);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        await service.close();
        await warehouse.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'warehouse MCP server failed to start');
  process.exit(1);
});
