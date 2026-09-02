import { hasScope, type Role } from '@mcpgateway/shared';
import type { Logger } from '@mcpgateway/telemetry';

/**
 * The caller, as reconstructed from the downstream token.
 *
 * Every field here comes from a signature-verified JWT minted by the identity
 * provider for this specific server's audience. An MCP server never trusts a
 * header, a query parameter, or anything the gateway asserts out of band — if
 * the claim is not in the token, the server does not know it.
 */
export interface DownstreamPrincipal {
  readonly subject: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly scopes: readonly string[];
  readonly tokenId: string;
  readonly email: string | null;
  readonly name: string | null;
  /** Sales territory / book of business, used for row-level filtering. */
  readonly territory: string | null;
  /**
   * RFC 8693 actor: the party that performed the exchange. Present on tokens
   * that arrived through the gateway, absent on a token presented directly.
   */
  readonly actor: string | null;
}

export interface ToolContext {
  readonly principal: DownstreamPrincipal;
  readonly logger: Logger;
  readonly traceId: string | null;
  readonly requestId: string;
}

export function principalHasScope(
  principal: DownstreamPrincipal,
  required: string,
): boolean {
  return hasScope(principal.scopes, required);
}

/** True when the caller holds every scope in `required`. */
export function principalHasAllScopes(
  principal: DownstreamPrincipal,
  required: readonly string[],
): boolean {
  return required.every((scope) => principalHasScope(principal, scope));
}

export function missingScopes(
  principal: DownstreamPrincipal,
  required: readonly string[],
): string[] {
  return required.filter((scope) => !principalHasScope(principal, scope));
}
