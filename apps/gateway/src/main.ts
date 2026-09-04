import { gatewayConfigSchema, loadConfig } from '@mcpgateway/shared';
import { createLogger } from '@mcpgateway/telemetry';

import { buildGateway } from './app.js';
import { createServices } from './services.js';

const log = createLogger({ serviceName: 'gateway' });

async function main(): Promise<void> {
  const config = loadConfig(gatewayConfigSchema);
  const services = await createServices(config);
  const app = await buildGateway(services);

  await app.listen({ port: config.GATEWAY_PORT, host: config.GATEWAY_HOST });
  log.info({ port: config.GATEWAY_PORT, issuer: config.OIDC_ISSUER }, 'gateway listening');

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        log.info({ signal }, 'draining');
        // Close the server first so in-flight requests finish before their
        // dependencies are torn out from under them.
        await app.close();
        await services.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'gateway failed to start');
  process.exit(1);
});
