import { createMcpService } from '@mcpgateway/mcp-runtime';
import { loadConfig, mcpServerConfigSchema } from '@mcpgateway/shared';
import { createLogger } from '@mcpgateway/telemetry';

import { loadDataset } from './dataset.js';
import { createCrmTools } from './tools.js';

const log = createLogger({ serviceName: 'mcp-salesforce' });

async function main(): Promise<void> {
  const config = loadConfig(mcpServerConfigSchema);
  const dataset = await loadDataset();

  log.info(
    {
      accounts: dataset.accounts.length,
      contacts: dataset.contacts.length,
      opportunities: dataset.opportunities.length,
    },
    'CRM records loaded',
  );

  const service = await createMcpService({
    serviceName: config.SERVICE_NAME,
    issuer: config.OIDC_ISSUER,
    ...(config.OIDC_ISSUER_INTERNAL ? { issuerInternal: config.OIDC_ISSUER_INTERNAL } : {}),
    expectedAudience: config.EXPECTED_AUDIENCE,
    tools: createCrmTools(dataset),
    logger: log,
  });

  await service.listen(config.PORT);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void service.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'CRM MCP server failed to start');
  process.exit(1);
});
