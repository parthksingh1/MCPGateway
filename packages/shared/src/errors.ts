/**
 * Error taxonomy shared by every service.
 *
 * Two rules hold throughout the codebase:
 *   1. Every failure that reaches a client is one of these classes, so the HTTP
 *      status, the MCP error code and the audit `deny_reason` all derive from a
 *      single source of truth instead of being invented at each call site.
 *   2. Anything security-relevant fails closed. There is no code path that
 *      degrades to a broader set of permissions when a check errors out.
 */

/** Stable machine-readable identifiers. Emitted in audit rows and API bodies. */
export const ErrorCode = {
  BAD_REQUEST: 'bad_request',
  UNAUTHENTICATED: 'unauthenticated',
  TOKEN_EXPIRED: 'token_expired',
  PERMISSION_MIRROR_FAILED: 'permission_mirror_failed',
  POLICY_DENIED: 'policy_denied',
  SCOPE_DENIED: 'scope_denied',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  UPSTREAM_ERROR: 'upstream_error',
  AUDIT_CHAIN_BROKEN: 'audit_chain_broken',
  CONFIGURATION_INVALID: 'configuration_invalid',
  NOT_FOUND: 'not_found',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface GatewayErrorOptions {
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Seconds a client should wait before retrying. Surfaced as `Retry-After`. */
  readonly retryAfterSeconds?: number;
}

/** Base class for every deliberate failure in the system. */
export class GatewayError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCodeValue, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = options.status ?? 500;
    this.details = options.details ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    Error.captureStackTrace?.(this, new.target);
  }

  /** Body shape returned to HTTP clients. Never includes a stack or a cause. */
  toResponseBody(): { error: { code: ErrorCodeValue; message: string; details?: unknown } } {
    const body: { code: ErrorCodeValue; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (Object.keys(this.details).length > 0) body.details = this.details;
    return { error: body };
  }
}

export class BadRequestError extends GatewayError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.BAD_REQUEST, message, { status: 400, details });
  }
}

export class UnauthenticatedError extends GatewayError {
  constructor(message = 'A valid bearer token is required', details?: Record<string, unknown>) {
    super(ErrorCode.UNAUTHENTICATED, message, { status: 401, details });
  }
}

export class TokenExpiredError extends GatewayError {
  constructor(message = 'The presented access token has expired') {
    super(ErrorCode.TOKEN_EXPIRED, message, { status: 401 });
  }
}

/**
 * Raised when the gateway cannot mint a downstream token that carries the
 * caller's own identity. This is the load-bearing failure of the whole design:
 * rather than fall back to a service account (which would silently widen the
 * caller's reach to the union of every user's permissions) the request is
 * refused and audited.
 */
export class PermissionMirrorError extends GatewayError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(ErrorCode.PERMISSION_MIRROR_FAILED, message, { status: 403, details, cause });
  }
}

export class PolicyDeniedError extends GatewayError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.POLICY_DENIED, message, { status: 403, details });
  }
}

export class ScopeDeniedError extends GatewayError {
  constructor(required: readonly string[], held: readonly string[]) {
    super(ErrorCode.SCOPE_DENIED, `Missing required scope: ${required.join(', ')}`, {
      status: 403,
      details: { required, held },
    });
  }
}

export class RateLimitedError extends GatewayError {
  constructor(retryAfterMs: number, details?: Record<string, unknown>) {
    super(ErrorCode.RATE_LIMITED, 'Rate limit exceeded', {
      status: 429,
      details: { ...details, retryAfterMs },
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });
  }
}

export class UpstreamUnavailableError extends GatewayError {
  constructor(target: string, cause?: unknown) {
    super(ErrorCode.UPSTREAM_UNAVAILABLE, `Upstream '${target}' is unavailable`, {
      status: 503,
      details: { target },
      cause,
    });
  }
}

export class UpstreamError extends GatewayError {
  constructor(target: string, message: string, details?: Record<string, unknown>) {
    super(ErrorCode.UPSTREAM_ERROR, message, { status: 502, details: { target, ...details } });
  }
}

export class AuditChainBrokenError extends GatewayError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.AUDIT_CHAIN_BROKEN, message, { status: 500, details });
  }
}

export class ConfigurationError extends GatewayError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.CONFIGURATION_INVALID, message, { status: 500, details });
  }
}

export class NotFoundError extends GatewayError {
  constructor(what: string) {
    super(ErrorCode.NOT_FOUND, `${what} was not found`, { status: 404 });
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

/** Normalise anything thrown into a `GatewayError` without losing the cause. */
export function toGatewayError(value: unknown): GatewayError {
  if (isGatewayError(value)) return value;
  const message = value instanceof Error ? value.message : 'Unexpected error';
  return new GatewayError(ErrorCode.INTERNAL, message, { status: 500, cause: value });
}
