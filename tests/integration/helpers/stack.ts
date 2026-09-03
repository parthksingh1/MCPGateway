import { createPkcePair } from '@mcpgateway/auth';
import { createMcpService } from '@mcpgateway/mcp-runtime';
import { gatewayConfigSchema } from '@mcpgateway/shared';
import type { FastifyInstance } from 'fastify';

import { buildGateway } from '../../../apps/gateway/src/app.js';
import { createServices } from '../../../apps/gateway/src/services.js';
import { loadPolicies } from '../../../apps/mcp-servers/policy-engine/src/loader.js';
import { createPolicyTools } from '../../../apps/mcp-servers/policy-engine/src/tools.js';
import { createWarehouseTools } from '../../../apps/mcp-servers/postgres/src/tools.js';
import { Warehouse } from '../../../apps/mcp-servers/postgres/src/warehouse.js';
import { loadDataset } from '../../../apps/mcp-servers/salesforce/src/dataset.js';
import { createCrmTools } from '../../../apps/mcp-servers/salesforce/src/tools.js';
import { buildIdp } from '../../../apps/mock-idp/src/server.js';

/**
 * Boots the whole system in one process on ephemeral ports.
 *
 * Every component is the real one — the identity provider signs real tokens,
 * the gateway performs a real RFC 8693 exchange, the MCP servers verify those
 * tokens against a real JWKS endpoint, and the warehouse runs real SQL under
 * real row-level security. Nothing is stubbed, so a test that passes here says
 * something about the system rather than about the mocks.
 */
export interface Stack {
  readonly gatewayUrl: string;
  readonly issuer: string;
  readonly gateway: FastifyInstance;
  signIn(email: string, scopes?: string): Promise<string>;
  callTool(
    token: string,
    server: string,
    tool: string,
    args?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}

const ALL_SCOPES =
  'openid profile email salesforce:read salesforce:read.team salesforce:read.all salesforce:write postgres:read postgres:query policy:evaluate policy:read gateway:admin';

async function listenOnEphemeralPort(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return address.port;
}

export async function startStack(options: {
  databaseUrl: string;
  auditDatabaseUrl: string;
  warehouseUrl: string;
  redisUrl: string;
}): Promise<Stack> {
  // --- identity provider ---------------------------------------------------
  // Bind first, then rebuild with the issuer set to the port that was assigned,
  // because the issuer has to match the `iss` claim exactly.
  const probe = await buildIdp({ issuer: 'http://127.0.0.1:1' });
  const idpPort = await listenOnEphemeralPort(probe);
  await probe.close();

  const issuer = `http://127.0.0.1:${idpPort}`;
  const idp = await buildIdp({ issuer });
  await idp.listen({ port: idpPort, host: '127.0.0.1' });

  // --- MCP servers ---------------------------------------------------------
  const [dataset, policies] = await Promise.all([loadDataset(), loadPolicies()]);
  const warehouse = new Warehouse({
    connectionString: options.warehouseUrl,
    statementTimeoutMs: 5_000,
    maxRows: 500,
  });

  const salesforce = await createMcpService({
    serviceName: 'mcp-salesforce',
    issuer,
    expectedAudience: 'mcp:salesforce',
    tools: createCrmTools(dataset),
  });
  const postgres = await createMcpService({
    serviceName: 'mcp-postgres',
    issuer,
    expectedAudience: 'mcp:postgres',
    tools: createWarehouseTools(warehouse),
  });
  const policyEngine = await createMcpService({
    serviceName: 'mcp-policy-engine',
    issuer,
    expectedAudience: 'mcp:policy-engine',
    tools: createPolicyTools(policies),
  });

  const [salesforcePort, postgresPort, policyPort] = await Promise.all([
    listenOnEphemeralPort(salesforce.app),
    listenOnEphemeralPort(postgres.app),
    listenOnEphemeralPort(policyEngine.app),
  ]);

  // --- gateway -------------------------------------------------------------
  const config = gatewayConfigSchema.parse({
    NODE_ENV: 'test',
    DATABASE_URL: options.databaseUrl,
    AUDIT_DATABASE_URL: options.auditDatabaseUrl,
    REDIS_URL: options.redisUrl,
    OIDC_ISSUER: issuer,
    GATEWAY_CLIENT_ID: 'mcp-gateway',
    GATEWAY_CLIENT_SECRET: 'gateway-secret-change-me',
    DASHBOARD_CLIENT_ID: 'dashboard-bff',
    DASHBOARD_CLIENT_SECRET: 'dashboard-secret-change-me',
    SESSION_COOKIE_SECRET: 'integration-test-session-secret-value-32',
    MCP_SALESFORCE_URL: `http://127.0.0.1:${salesforcePort}/mcp`,
    MCP_POSTGRES_URL: `http://127.0.0.1:${postgresPort}/mcp`,
    MCP_POLICY_URL: `http://127.0.0.1:${policyPort}/mcp`,
    GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
    DASHBOARD_ORIGIN: 'http://127.0.0.1:3000',
  });

  const services = await createServices(config);
  const gateway = await buildGateway(services);
  const gatewayPort = await listenOnEphemeralPort(gateway);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  /** Drive the real authorization-code + PKCE flow against the real provider. */
  async function signIn(email: string, scopes = ALL_SCOPES): Promise<string> {
    const pkce = createPkcePair();
    const redirectUri = 'http://localhost:8080/auth/callback';

    const authorize = await idp.inject({
      method: 'POST',
      url: '/authorize',
      payload: {
        response_type: 'code',
        client_id: 'dashboard-bff',
        redirect_uri: redirectUri,
        scope: scopes,
        state: 'test',
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        email,
        password: 'Passw0rd!',
      },
    });
    if (authorize.statusCode !== 302) {
      throw new Error(`Sign-in failed for ${email}: ${authorize.statusCode}`);
    }

    const code = new URL(authorize.headers.location as string).searchParams.get('code');
    const token = await idp.inject({
      method: 'POST',
      url: '/token',
      headers: {
        authorization: `Basic ${Buffer.from('dashboard-bff:dashboard-secret-change-me').toString('base64')}`,
      },
      payload: {
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
        code_verifier: pkce.codeVerifier,
      },
    });

    return token.json<{ access_token: string }>().access_token;
  }

  async function callTool(
    token: string,
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await gateway.inject({
      method: 'POST',
      url: `/v1/servers/${server}/tools/${tool}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { arguments: args },
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }

  return {
    gatewayUrl,
    issuer,
    gateway,
    signIn,
    callTool,
    stop: async () => {
      await gateway.close();
      await Promise.all([salesforce.close(), postgres.close(), policyEngine.close()]);
      await warehouse.close();
      await idp.close();
      await services.close();
    },
  };
}
