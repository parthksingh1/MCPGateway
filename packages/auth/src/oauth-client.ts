import { BadRequestError, UpstreamUnavailableError } from '@mcpgateway/shared';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export interface ProviderMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly userinfo_endpoint?: string;
  readonly introspection_endpoint?: string;
  readonly code_challenge_methods_supported?: string[];
  readonly grant_types_supported?: string[];
}

export interface OAuthClientOptions {
  /** Issuer identifier, exactly as it appears in the `iss` claim. */
  readonly issuer: string;
  /**
   * Network address used to reach the provider, when it differs from the
   * issuer identifier. Inside a container network the provider answers on
   * `http://identity:9000` while still identifying itself as
   * `http://localhost:9000` — the address a browser must use. Endpoint URLs
   * from discovery are rebased onto this host; the issuer check is unaffected.
   */
  readonly baseUrl?: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly issued_token_type?: string;
}

export interface TokenExchangeRequest {
  readonly subjectToken: string;
  readonly audience: string;
  readonly scopes?: readonly string[];
  readonly resource?: string;
}

/** Thin OAuth 2.1 client covering the grants the gateway actually performs. */
export class OAuthClient {
  private readonly issuer: string;
  private readonly baseUrl: string | undefined;
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private metadataPromise: Promise<ProviderMetadata> | null = null;

  constructor(options: OAuthClientOptions) {
    this.issuer = options.issuer.replace(/\/$/, '');
    this.baseUrl = options.baseUrl?.replace(/\/$/, '');
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  /** Fetch and memoise the provider's discovery document. */
  async metadata(): Promise<ProviderMetadata> {
    this.metadataPromise ??= this.fetchMetadata().catch((error: unknown) => {
      // Do not memoise a failure: a provider that was briefly down should be
      // retried on the next call rather than poisoning the process.
      this.metadataPromise = null;
      throw error;
    });
    return this.metadataPromise;
  }

  private async fetchMetadata(): Promise<ProviderMetadata> {
    const discoveryBase = this.baseUrl ?? this.issuer;
    const response = await this.request(`${discoveryBase}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new UpstreamUnavailableError(`oidc-discovery (${response.status})`);
    }
    const raw = (await response.json()) as ProviderMetadata;
    if (raw.issuer !== this.issuer) {
      throw new UpstreamUnavailableError(
        `oidc-discovery: issuer mismatch, expected '${this.issuer}' but the provider announced '${raw.issuer}'`,
      );
    }
    return {
      ...raw,
      authorization_endpoint: raw.authorization_endpoint,
      token_endpoint: this.rebase(raw.token_endpoint),
      jwks_uri: this.rebase(raw.jwks_uri),
      ...(raw.userinfo_endpoint ? { userinfo_endpoint: this.rebase(raw.userinfo_endpoint) } : {}),
      ...(raw.introspection_endpoint
        ? { introspection_endpoint: this.rebase(raw.introspection_endpoint) }
        : {}),
    };
  }

  /** Swap the host of an announced endpoint for the reachable one. */
  private rebase(endpoint: string): string {
    if (!this.baseUrl) return endpoint;
    const target = new URL(endpoint);
    const base = new URL(this.baseUrl);
    target.protocol = base.protocol;
    target.host = base.host;
    return target.toString();
  }

  async jwksUri(): Promise<string> {
    return (await this.metadata()).jwks_uri;
  }

  /** Build the browser-facing authorization URL (uses the public issuer host). */
  async authorizationUrl(input: {
    redirectUri: string;
    scopes: readonly string[];
    state: string;
    codeChallenge: string;
    nonce?: string;
  }): Promise<string> {
    const meta = await this.metadata();
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.nonce) url.searchParams.set('nonce', input.nonce);
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<TokenResponse> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async clientCredentials(input: {
    tenantId: string;
    scopes?: readonly string[];
    audience?: string;
  }): Promise<TokenResponse> {
    return this.token({
      grant_type: 'client_credentials',
      tenant_id: input.tenantId,
      ...(input.scopes ? { scope: input.scopes.join(' ') } : {}),
      ...(input.audience ? { audience: input.audience } : {}),
    });
  }

  /**
   * RFC 8693 token exchange.
   *
   * Presents the caller's own token and asks for one addressed to `audience`.
   * The returned token keeps the caller as its subject, so the downstream
   * service authorises the human, not the gateway.
   */
  async exchangeToken(input: TokenExchangeRequest): Promise<TokenResponse> {
    return this.token({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: input.subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: input.audience,
      ...(input.scopes?.length ? { scope: input.scopes.join(' ') } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
    });
  }

  private async token(params: Record<string, string>): Promise<TokenResponse> {
    const meta = await this.metadata();
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };

    if (this.clientSecret) {
      const basic = Buffer.from(
        `${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`,
        'utf8',
      ).toString('base64');
      headers.authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', this.clientId);
    }

    const response = await this.request(meta.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof payload.error === 'string' ? payload.error : 'invalid_request';
      const description =
        typeof payload.error_description === 'string'
          ? payload.error_description
          : `Token endpoint returned ${response.status}`;
      throw new BadRequestError(`${error}: ${description}`, {
        status: response.status,
        oauthError: error,
      });
    }
    return payload as unknown as TokenResponse;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new UpstreamUnavailableError('identity-provider', error);
    } finally {
      clearTimeout(timer);
    }
  }
}
