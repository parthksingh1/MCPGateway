import { PermissionMirrorError } from '@mcpgateway/shared';
import type { FastifyRequest } from 'fastify';

import type { GatewayServices } from '../services.js';

/**
 * Stage 6 of the pipeline — permission mirroring.
 *
 * Exchanges the caller's access token for one addressed to the specific MCP
 * server this call is bound for. The exchanged token names the same subject,
 * carries a narrowed scope set, and expires in minutes.
 *
 * There is no `else` branch here. If the exchange fails the request fails, and
 * the failure is audited. A fallback to a service account would be a single
 * line of code and would silently give every caller the union of every user's
 * permissions — which is the exact behaviour this gateway exists to remove, and
 * the reason the absence of that line is worth stating out loud.
 */
export function createTokenExchangeStage(services: GatewayServices) {
  return async function tokenExchangeStage(request: FastifyRequest): Promise<void> {
    const principal = request.principal;
    const invocation = request.invocation;
    if (!principal || !invocation) return;

    const target = services.targets[invocation.server];

    // Ask only for the scopes that belong to this server. The provider narrows
    // again on its side; requesting narrowly here keeps the cache key tight so
    // one user's tokens for different servers never collide.
    const requestedScopes = principal.scopes.filter((scope) =>
      scope.startsWith(`${target.namespace}:`),
    );

    if (requestedScopes.length === 0) {
      invocation.decision = 'deny';
      invocation.denyReason = `permission_mirror:no_scopes_for_${target.audience}`;
      throw new PermissionMirrorError(
        `The caller holds no scopes for '${target.audience}', so no downstream token can be minted for them.`,
        { audience: target.audience, held: [...principal.scopes] },
      );
    }

    try {
      invocation.tokenExchange = await services.tokenExchange.mint({
        principal,
        subjectToken: request.inboundToken ?? '',
        audience: target.audience,
        scopes: requestedScopes,
      });
    } catch (error) {
      invocation.decision = 'deny';
      invocation.denyReason = 'permission_mirror:exchange_failed';
      throw error;
    }
  };
}
