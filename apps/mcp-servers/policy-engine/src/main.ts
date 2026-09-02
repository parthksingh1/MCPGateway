import { createMcpService } from '@mcpgateway/mcp-runtime';
import { loadConfig, mcpServerConfigSchema } from '@mcpgateway/shared';
import { createLogger } from '@mcpgateway/telemetry';

import { loadPolicies } from './loader.js';
import { createPolicyTools } from './tools.js';

const log = createLogger({ serviceName: 'mcp-policy-engine' });

async function main(): Promise<void> {
  const config = loadConfig(mcpServerConfigSchema);
  const catalogue = await loadPolicies();

  log.info(
    {
      bundles: catalogue.list().map((bundle) => ({
        name: bundle.name,
        rules: bundle.rules.length,
        defaultEffect: bundle.defaultEffect,
      })),
    },
    'policy bundles loaded',
  );

  const service = await createMcpService({
    serviceName: config.SERVICE_NAME,
    issuer: config.OIDC_ISSUER,
    ...(config.OIDC_ISSUER_INTERNAL ? { issuerInternal: config.OIDC_ISSUER_INTERNAL } : {}),
    expectedAudience: config.EXPECTED_AUDIENCE,
    tools: createPolicyTools(catalogue),
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
  log.fatal({ err: error }, 'policy engine failed to start');
  process.exit(1);
});
