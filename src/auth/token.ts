import { isClientCredentials, type FetchLike, type ResolvedConfig } from '../config.js';
import { SerchaAuthError } from '../transport/errors.js';

/** Sercha's default scopes for an external application. */
export const DEFAULT_SCOPES = ['query:read', 'genie:use'];

/**
 * Refresh this many ms before actual expiry.
 *
 * Access tokens live 15 minutes. A margin avoids the race where a token passes
 * the expiry check, then expires in flight and returns 401.
 */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  /** Epoch ms at which this token should be considered expired. */
  expiresAt: number;
}

interface TokenEndpointResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

/**
 * Obtains and caches access tokens for the client_credentials grant.
 *
 * Two properties matter and both are easy to get wrong:
 *
 * Refresh is *proactive*. It happens on the expires_in the server reported,
 * minus a margin, rather than reactively on a 401. Reacting to 401s means
 * every token expiry costs a wasted round trip, and conflates "expired" with
 * "revoked" and "insufficient permission".
 *
 * Refresh is *single-flight*. Concurrent callers arriving at an expired token
 * share one in-flight request rather than each issuing their own. Without
 * this, N concurrent requests produce N token calls whose responses race to
 * overwrite the cache.
 */
export class TokenManager {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly auth: ResolvedConfig['auth'];

  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(config: ResolvedConfig) {
    this.baseUrl = config.baseUrl;
    this.fetchImpl = config.fetch;
    this.timeoutMs = config.timeoutMs;
    this.auth = config.auth;
  }

  /** A valid bearer token, minting or refreshing one if needed. */
  async getToken(): Promise<string> {
    if (!isClientCredentials(this.auth)) {
      return this.auth.token;
    }

    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }

    // Join the in-flight refresh rather than starting a second one.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchToken()
      .then((cached) => {
        this.cached = cached;
        return cached.token;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  /**
   * Discard the cached token so the next call mints a fresh one.
   *
   * Used when the server rejects a token the client still believed valid,
   * which means it was revoked or the clock disagrees.
   */
  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<CachedToken> {
    if (!isClientCredentials(this.auth)) {
      // Unreachable: getToken returns early for static tokens.
      throw new SerchaAuthError(0, 'invalid_client', 'no client credentials configured');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.auth.clientId,
      client_secret: this.auth.clientSecret,
      scope: (this.auth.scopes ?? DEFAULT_SCOPES).join(' '),
    });

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal,
      });
    } catch (cause) {
      throw new SerchaAuthError(0, 'network_error', String(cause));
    }

    const parsed: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const err = parsed as { error?: string; error_description?: string } | undefined;
      throw new SerchaAuthError(
        response.status,
        err?.error ?? 'invalid_client',
        err?.error_description,
      );
    }

    const data = parsed as TokenEndpointResponse | undefined;
    if (!data?.access_token) {
      throw new SerchaAuthError(
        response.status,
        'server_error',
        'token endpoint returned no access_token',
      );
    }

    // Guard a missing or nonsensical expires_in. Treating it as immediate
    // expiry would refresh on every request; a long default would keep a dead
    // token. One minute is short enough to recover quickly either way.
    const expiresInMs =
      typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in * 1000 : 60_000;

    return {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(expiresInMs - EXPIRY_MARGIN_MS, 0),
    };
  }
}
