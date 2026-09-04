import { NotFoundError, UnauthenticatedError } from '@mcpgateway/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import type { TenantRecord } from '../context.js';
import type { GatewayServices } from '../services.js';

export interface TenantContextOptions {
  readonly services: GatewayServices;
  /** How long a tenant row is reused before being re-read. */
  readonly cacheTtlMs?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    resolveTenant: (request: FastifyRequest) => Promise<void>;
  }
}

/**
 * Stage 3 of the pipeline.
 *
 * Resolves the tenant named by the token's `tenant_id` claim into a record the
 * later stages need — chiefly the plan, which policy rules and rate tiers key
 * off. The tenant comes from the token, never from a path parameter or a
 * header, so there is no request shape that lets a caller act as another
 * tenant.
 *
 * Rows are cached briefly. Tenant plans change on the order of months and this
 * lookup would otherwise put a database round trip in front of every call.
 */
const plugin: FastifyPluginAsync<TenantContextOptions> = async (app, options) => {
  const { services } = options;
  const ttl = options.cacheTtlMs ?? 30_000;
  const cache = new Map<string, { record: TenantRecord; expiresAt: number }>();

  app.decorateRequest('tenant', undefined);

  const resolveTenant = async (request: FastifyRequest): Promise<void> => {
    const principal = request.principal;
    if (!principal)
      throw new UnauthenticatedError('Tenant context requires an authenticated caller');

    const cached = cache.get(principal.tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      request.tenant = cached.record;
      return;
    }

    const result = await services.db.db.execute<{ id: string; name: string; plan: string }>(sql`
      SELECT id, name, plan FROM tenants WHERE id = ${principal.tenantId}
    `);
    const row = result.rows[0];
    if (!row) {
      // A token naming a tenant that does not exist is not a 404 for the caller
      // to explore; it means the directory and the control plane disagree.
      throw new NotFoundError(`Tenant ${principal.tenantId}`);
    }

    const record: TenantRecord = { id: row.id, name: row.name, plan: row.plan };
    cache.set(principal.tenantId, { record, expiresAt: Date.now() + ttl });
    request.tenant = record;
  };

  app.decorate('resolveTenant', resolveTenant);
};

export const tenantContextPlugin = fp(plugin, { name: 'gateway-tenant-context' });
