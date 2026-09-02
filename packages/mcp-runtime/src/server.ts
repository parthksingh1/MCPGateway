import { randomUUID } from 'node:crypto';

import { JwksCache, extractBearer, verifyAccessToken, OAuthClient } from '@mcpgateway/auth';
import {
  UnauthenticatedError,
  ScopeDeniedError,
  roleSchema,
  isGatewayError,
  toGatewayError,
} from '@mcpgateway/shared';
import {
  createLogger,
  currentTraceId,
  withSpan,
  annotate,
  GatewayAttr,
  type Logger,
} from '@mcpgateway/telemetry';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { JWTPayload } from 'jose';
import type { ZodRawShape } from 'zod';

import { missingScopes, type DownstreamPrincipal, type ToolContext } from './context.js';
import { describeFailure, type ToolDefinition } from './tool.js';

export interface McpServiceOptions {
  readonly serviceName: string;
  readonly version?: string;
  /** Issuer identifier, exactly as it appears in the `iss` claim. */
  readonly issuer: string;
  /** Reachable address of the identity provider, when it differs from `issuer`. */
  readonly issuerInternal?: string;
  /** Audience this server accepts. A token for another server is refused. */
  readonly expectedAudience: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools are heterogeneous by design; each entry is a ToolDefinition over its own Zod shape, and the union cannot be expressed without an existential type.
  readonly tools: readonly ToolDefinition<any>[];
  /** Extra readiness checks, e.g. a database ping. */
  readonly readiness?: () => Promise<Record<string, 'ok' | 'degraded' | 'down'>>;
  readonly logger?: Logger;
}

export interface McpService {
  readonly app: FastifyInstance;
  readonly logger: Logger;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Shared scaffolding for every MCP server in this repository.
 *
 * Three things are handled here rather than in each server:
 *
 *  - **Transport.** Streamable HTTP per the current MCP specification, run in
 *    stateless mode: a fresh `McpServer` and transport are constructed for each
 *    request. That costs a little per call and buys two things — the request's
 *    principal is captured in a closure that no other request can observe, and
 *    the process holds no session state, so it scales horizontally without
 *    sticky routing.
 *
 *  - **Authorisation.** The bearer token is verified against the provider's
 *    JWKS with this server's audience required, so a token minted for the
 *    Salesforce server is rejected here. Scopes are checked against the tool's
 *    declared requirement before the handler runs. The server authorises the
 *    end user named in the token; it never sees, and has no way to use, a
 *    gateway service credential.
 *
 *  - **Tracing.** The inbound `traceparent` is already active by the time a
 *    handler runs (the HTTP instrumentation extracts it), so each tool call
 *    becomes a child span of the gateway's span and the whole request shows up
 *    as one trace.
 */
export async function createMcpService(options: McpServiceOptions): Promise<McpService> {
  const version = options.version ?? '0.1.0';
  const logger = options.logger ?? createLogger({ serviceName: options.serviceName });

  const oauth = new OAuthClient({
    issuer: options.issuer,
    ...(options.issuerInternal ? { baseUrl: options.issuerInternal } : {}),
    clientId: options.serviceName,
  });

  // Resolved lazily so the server can boot before the identity provider is up.
  let jwks: JwksCache | null = null;
  const getJwks = async (): Promise<JwksCache> => {
    jwks ??= new JwksCache({ jwksUri: await oauth.jwksUri() });
    return jwks;
  };

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.get('/healthz', async () => ({ status: 'ok', service: options.serviceName, version }));

  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'degraded' | 'down'> = {};
    try {
      await getJwks();
      checks.identity = 'ok';
    } catch {
      checks.identity = 'down';
    }
    Object.assign(checks, (await options.readiness?.()) ?? {});

    const ready = Object.values(checks).every((state) => state === 'ok');
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });

  /** Advertised so a client can discover how to authenticate. */
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: options.expectedAudience,
    authorization_servers: [options.issuer],
    scopes_supported: [...new Set(options.tools.flatMap((tool) => tool.requiredScopes))].sort(),
    bearer_methods_supported: ['header'],
  }));

  app.get('/tools', async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiredScopes: tool.requiredScopes,
      readOnly: tool.readOnly ?? false,
    })),
  }));

  async function authenticate(request: FastifyRequest): Promise<DownstreamPrincipal> {
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new UnauthenticatedError('A downstream bearer token is required');

    const cache = await getJwks();
    const { claims } = await verifyAccessToken(token, cache, {
      issuer: options.issuer,
      // Refusing a token addressed elsewhere is what stops a token minted for
      // one MCP server from being replayed against another.
      audience: options.expectedAudience,
    });

    return toPrincipal(claims);
  }

  app.post('/mcp', async (request, reply) => {
    const requestId = randomUUID();
    let principal: DownstreamPrincipal;

    try {
      principal = await authenticate(request);
    } catch (error) {
      const failure = toGatewayError(error);
      logger.warn({ err: failure, requestId }, 'rejected unauthenticated MCP request');
      return reply
        .code(failure.status === 403 ? 403 : 401)
        .header(
          'www-authenticate',
          `Bearer resource_metadata="${options.expectedAudience}", error="invalid_token"`,
        )
        .send(failure.toResponseBody());
    }

    const server = new McpServer({ name: options.serviceName, version });

    for (const tool of options.tools) {
      registerTool(server, tool, {
        principal,
        logger: logger.child({ tool: tool.name, subject: principal.subject }),
        traceId: currentTraceId(),
        requestId,
      });
    }

    // Stateless: no session id, and a plain JSON response rather than an SSE
    // stream, because every tool here is a single request/response call.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      logger.error({ err: error, requestId }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: { code: 'internal_error' } }));
      }
    }
  });

  // Stateless mode has no stream to resume and no session to delete.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (_request, reply) =>
      reply.code(405).header('allow', 'POST').send({
        error: {
          code: 'method_not_allowed',
          message: 'This server runs the Streamable HTTP transport in stateless mode.',
        },
      }),
    );
  }

  function registerTool<Shape extends ZodRawShape>(
    server: McpServer,
    tool: ToolDefinition<Shape>,
    context: ToolContext,
  ): void {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly ?? false },
      },
      // The SDK infers the callback signature from `inputSchema`; the args are
      // already validated against the Zod shape by the time this runs.
      (async (args: Parameters<typeof tool.handler>[0]) => {
        return withSpan(`mcp.tool ${tool.name}`, async () => {
          annotate({
            [GatewayAttr.MCP_SERVER]: options.serviceName,
            [GatewayAttr.MCP_TOOL]: tool.name,
            [GatewayAttr.TENANT_ID]: context.principal.tenantId,
            [GatewayAttr.USER_ID]: context.principal.subject,
            [GatewayAttr.USER_ROLE]: context.principal.role,
          });

          try {
            const absent = missingScopes(context.principal, tool.requiredScopes);
            if (absent.length > 0) {
              throw new ScopeDeniedError(absent, context.principal.scopes);
            }

            const result = await tool.handler(args, context);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              structuredContent: isRecord(result) ? result : { value: result },
            };
          } catch (error) {
            const failure = describeFailure(error);
            context.logger.warn(
              { err: isGatewayError(error) ? error.code : error, requestId: context.requestId },
              'tool call failed',
            );
            return {
              isError: true as const,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: failure.data, message: failure.message }, null, 2),
                },
              ],
            };
          }
        });
        // The SDK's ToolCallback type is derived from the schema shape, which is
        // existential across the heterogeneous tool list.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      }) as any,
    );
  }

  return {
    app,
    logger,
    listen: async (port, host = '0.0.0.0') => {
      await app.listen({ port, host });
      logger.info({ port, service: options.serviceName }, 'MCP server listening');
    },
    close: async () => {
      await app.close();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPrincipal(claims: JWTPayload & Record<string, unknown>): DownstreamPrincipal {
  const roleResult = roleSchema.safeParse(claims.role);
  const actor =
    isRecord(claims.act) && typeof claims.act.sub === 'string' ? claims.act.sub : null;

  return {
    subject: String(claims.sub ?? ''),
    tenantId: typeof claims.tenant_id === 'string' ? claims.tenant_id : '',
    // An unrecognised role degrades to the least privileged one rather than
    // failing open.
    role: roleResult.success ? roleResult.data : 'viewer',
    scopes: typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [],
    tokenId: typeof claims.jti === 'string' ? claims.jti : '',
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
    territory: typeof claims.territory === 'string' ? claims.territory : null,
    actor,
  };
}
