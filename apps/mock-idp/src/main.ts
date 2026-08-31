import { idpConfigSchema, loadConfig } from '@mcpgateway/shared';
import { createLogger } from '@mcpgateway/telemetry';

import { buildIdp } from './server.js';

const log = createLogger({ serviceName: 'identity' });

async function main(): Promise<void> {
  const config = loadConfig(idpConfigSchema);
  const app = await buildIdp({
    issuer: config.IDP_ISSUER,
    accessTokenTtlSeconds: config.IDP_ACCESS_TOKEN_TTL_SECONDS,
  });

  await app.listen({ port: config.IDP_PORT, host: '0.0.0.0' });
  log.info({ port: config.IDP_PORT, issuer: config.IDP_ISSUER }, 'identity provider listening');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'identity provider failed to start');
  process.exitCode = 1;
});
