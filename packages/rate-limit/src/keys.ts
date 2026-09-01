export type LimitScopeType = 'tenant' | 'user_tool';

export interface LimitScope {
  readonly type: LimitScopeType;
  readonly tenantId: string;
  readonly userId?: string;
  readonly toolName?: string;
}

/**
 * Bucket keys.
 *
 * The tenant id sits inside braces so that Redis Cluster hashes every bucket
 * belonging to one tenant to the same slot. That keeps a tenant's limits on a
 * single node, and leaves room to evaluate several buckets in one script later
 * without a cross-slot error.
 */
export function bucketKey(scope: LimitScope): string {
  if (scope.type === 'tenant') {
    return `rl:{${scope.tenantId}}:t`;
  }
  return `rl:{${scope.tenantId}}:u:${scope.userId ?? 'anonymous'}:${scope.toolName ?? '*'}`;
}

/** Human-readable label for metrics, audit reasons and the console. */
export function scopeLabel(scope: LimitScope): string {
  return scope.type === 'tenant'
    ? `tenant:${scope.tenantId}`
    : `user:${scope.userId ?? 'anonymous'}/tool:${scope.toolName ?? '*'}`;
}

/** Redis pub/sub channel used to invalidate cached limit configuration. */
export const CONFIG_INVALIDATION_CHANNEL = 'mcpgw:rate-limit:reload';
