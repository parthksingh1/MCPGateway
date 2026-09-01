import type { RateLimitConfigStore } from './config-store.js';
import type { LimitScope } from './keys.js';
import type { LimitVerdict, TokenBucketLimiter } from './limiter.js';

export interface RateLimitRequest {
  readonly tenantId: string;
  readonly userId: string;
  readonly toolName: string;
  /** Tier override, typically supplied by a matching policy rule. */
  readonly tier?: string;
  readonly cost?: number;
}

export interface RateLimitOutcome {
  readonly allowed: boolean;
  /** The verdict that decided the outcome. */
  readonly verdict: LimitVerdict;
  readonly checked: readonly LimitVerdict[];
}

/**
 * Applies the two buckets that guard every tool call: one per
 * (tenant, user, tool) and one per tenant.
 *
 * The narrower bucket is evaluated first. A single noisy user would otherwise
 * spend tenant-wide tokens on calls that their own bucket was going to reject
 * anyway, letting one caller degrade the whole tenant.
 */
export class RateLimitService {
  constructor(
    private readonly limiter: TokenBucketLimiter,
    private readonly configs: RateLimitConfigStore,
  ) {}

  async check(request: RateLimitRequest): Promise<RateLimitOutcome> {
    const cost = request.cost ?? 1;
    const limits = this.configs.resolve(request.tenantId, request.toolName, request.tier);

    const userScope: LimitScope = {
      type: 'user_tool',
      tenantId: request.tenantId,
      userId: request.userId,
      toolName: request.toolName,
    };
    const userVerdict = await this.limiter.consume(userScope, limits.userTool, cost);
    if (!userVerdict.allowed) {
      return { allowed: false, verdict: userVerdict, checked: [userVerdict] };
    }

    const tenantScope: LimitScope = { type: 'tenant', tenantId: request.tenantId };
    const tenantVerdict = await this.limiter.consume(tenantScope, limits.tenant, cost);

    return {
      allowed: tenantVerdict.allowed,
      verdict: tenantVerdict.allowed ? userVerdict : tenantVerdict,
      checked: [userVerdict, tenantVerdict],
    };
  }
}
