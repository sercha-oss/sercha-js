import { SerchaConfigError } from './transport/errors.js';

/** Minimal fetch signature, so a custom implementation can be injected. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Service-account credentials for the OAuth client_credentials grant.
 *
 * Sercha's token endpoint uses client_secret_post, so these travel in the
 * request body rather than an Authorization header.
 */
export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * Scopes to request. Defaults to query:read and genie:use, which cover the
   * /api/v1 surface this client exposes.
   *
   * Sercha does not currently enforce scopes on /api/v1 routes, so a narrower
   * set will not restrict this client today. Request what you actually use
   * anyway: enforcement may be added, and a token minted without a scope it
   * needs would then start failing.
   */
  scopes?: string[];
}

/** A pre-obtained bearer token, for callers managing their own token lifecycle. */
export interface StaticToken {
  token: string;
}

export type AuthConfig = ClientCredentials | StaticToken;

export function isClientCredentials(auth: AuthConfig): auth is ClientCredentials {
  return 'clientId' in auth;
}

export interface RetryConfig {
  /** Total attempts including the first. 1 disables retries. Default 3. */
  attempts?: number;
  /** Base delay for exponential backoff, in ms. Default 250. */
  baseDelayMs?: number;
  /** Ceiling for any single backoff delay, in ms. Default 10_000. */
  maxDelayMs?: number;
}

export interface SerchaClientConfig {
  /** Base URL of the Sercha instance, e.g. https://api.acme.sercha.cloud */
  baseUrl: string;
  auth: AuthConfig;
  /**
   * Per-request timeout in ms. Default 35_000.
   *
   * Sercha applies a 30s write deadline to POST /api/v1/query, so a timeout
   * below that will fire before the server's own. The default leaves a small
   * margin so the server's error surfaces instead of a client-side abort.
   * Genie streams are exempt; they use streamTimeoutMs.
   */
  timeoutMs?: number;
  /**
   * Timeout for Genie SSE streams, in ms. Default 300_000.
   *
   * Matches the server's 5-minute per-turn budget. A Genie turn holds one
   * connection open for its full duration, so the request timeout does not
   * apply.
   */
  streamTimeoutMs?: number;
  retry?: RetryConfig;
  /** Injected fetch. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Extra headers on every request. Cannot override Authorization. */
  headers?: Record<string, string>;
  /** User-Agent suffix, to identify the calling application in Sercha's logs. */
  userAgent?: string;
}

export interface ResolvedConfig {
  baseUrl: string;
  auth: AuthConfig;
  timeoutMs: number;
  streamTimeoutMs: number;
  retry: Required<RetryConfig>;
  fetch: FetchLike;
  headers: Record<string, string>;
  userAgent: string | undefined;
}

const DEFAULTS = {
  timeoutMs: 35_000,
  streamTimeoutMs: 300_000,
  retry: { attempts: 3, baseDelayMs: 250, maxDelayMs: 10_000 },
} as const;

export function resolveConfig(config: SerchaClientConfig): ResolvedConfig {
  if (!config.baseUrl) {
    throw new SerchaConfigError('baseUrl is required');
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl);
  } catch {
    throw new SerchaConfigError(`baseUrl is not a valid URL: ${config.baseUrl}`);
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new SerchaConfigError(`baseUrl must be http or https, got ${baseUrl.protocol}`);
  }

  if (!config.auth) {
    throw new SerchaConfigError('auth is required');
  }
  if (isClientCredentials(config.auth)) {
    if (!config.auth.clientId) throw new SerchaConfigError('auth.clientId is required');
    if (!config.auth.clientSecret) throw new SerchaConfigError('auth.clientSecret is required');
  } else if (!config.auth.token) {
    throw new SerchaConfigError('auth.token is required');
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new SerchaConfigError(
      'No fetch implementation available. Use Node 18+, or pass one as config.fetch.',
    );
  }

  const attempts = config.retry?.attempts ?? DEFAULTS.retry.attempts;
  if (attempts < 1) {
    throw new SerchaConfigError(`retry.attempts must be at least 1, got ${attempts}`);
  }

  return {
    // Trailing slashes would produce "//api/v1/..." on join. The server strips
    // them, but the doubled path is confusing in logs.
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    auth: config.auth,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    streamTimeoutMs: config.streamTimeoutMs ?? DEFAULTS.streamTimeoutMs,
    retry: {
      attempts,
      baseDelayMs: config.retry?.baseDelayMs ?? DEFAULTS.retry.baseDelayMs,
      maxDelayMs: config.retry?.maxDelayMs ?? DEFAULTS.retry.maxDelayMs,
    },
    fetch: fetchImpl.bind(globalThis) as FetchLike,
    headers: config.headers ?? {},
    userAgent: config.userAgent,
  };
}
