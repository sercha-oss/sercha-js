import type { ResolvedConfig } from '../config.js';
import type { TokenManager } from '../auth/token.js';
import { SerchaDecodeError, SerchaError, SerchaHttpError, SerchaTimeoutError } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Serialised as JSON. Omit for GET. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Caller cancellation, composed with the client's own timeout. */
  signal?: AbortSignal;
  /** Overrides the client default. Used by long-running endpoints. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * The 202 body from POST /api/v1/query. Not an error at the transport layer:
 * the query resource turns it into PluginConfirmationRequiredError, because
 * only it knows the retry-with-confirm protocol.
 */
export interface Accepted202<T> {
  status: 202;
  body: T;
}

export function isAccepted202<T>(value: unknown): value is Accepted202<T> {
  return typeof value === 'object' && value !== null && (value as Accepted202<T>).status === 202;
}

const RETRY_AFTER_CAP_MS = 60_000;

/**
 * HTTP transport: auth injection, timeouts, retries, error normalisation.
 *
 * Everything here is endpoint-agnostic. Endpoint-specific protocol (the 202
 * confirm dance, run polling, SSE framing) lives in the resource modules.
 */
export class HttpTransport {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly tokens: TokenManager,
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const { attempts, baseDelayMs, maxDelayMs } = this.config.retry;

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.attempt<T>(url, options, timeoutMs);
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error) || attempt === attempts) {
          throw error;
        }

        // A 401 on a token we believed valid means revoked, or clock skew.
        // Drop it so the retry mints a fresh one; without this the retry
        // replays the same dead token.
        if (error instanceof SerchaHttpError && error.status === 401) {
          this.tokens.invalidate();
        }

        await this.sleep(this.backoffMs(error, attempt, baseDelayMs, maxDelayMs), options.signal);
      }
    }

    throw lastError;
  }

  private async attempt<T>(url: string, options: RequestOptions, timeoutMs: number): Promise<T> {
    const token = await this.tokens.getToken();
    const signal = this.composeSignal(options.signal, timeoutMs);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.config.headers,
      ...options.headers,
      // Last, so neither caller headers nor config can displace credentials.
      Authorization: `Bearer ${token}`,
    };
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.config.fetch(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      });
    } catch (cause) {
      // An abort is either the caller's signal or our timeout. Distinguish
      // them: the caller's cancellation should propagate as-is.
      if (cause instanceof Error && cause.name === 'AbortError') {
        if (options.signal?.aborted) throw cause;
        throw new SerchaTimeoutError(timeoutMs);
      }
      throw new SerchaError(`Request to ${url} failed: ${String(cause)}`, { cause });
    }

    if (!response.ok) {
      throw await this.toHttpError(response);
    }

    return (await this.decodeBody<T>(response)) as T;
  }

  /**
   * Decode a 2xx body.
   *
   * Deliberately does not assume JSON. 204 and 200-with-empty-body are both
   * real responses here (DELETE returns 204; some handlers return an empty
   * 200), and calling .json() on either throws a parse error that looks like
   * a server fault.
   */
  private async decodeBody<T>(response: Response): Promise<T | undefined> {
    if (response.status === 204 || response.status === 205) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      const text = await response.text();
      if (!text) return undefined;
      // A JSON body with a wrong or missing content-type is more likely than
      // a genuinely non-JSON 2xx on this API, so try before giving up.
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }

    const text = await response.text();
    if (!text) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new SerchaDecodeError(response.status, text, { cause });
    }

    // 202 carries a protocol signal the resource layer must handle, so tag it
    // rather than returning a body indistinguishable from a 200.
    if (response.status === 202) {
      return { status: 202, body: parsed } as unknown as T;
    }
    return parsed as T;
  }

  private async toHttpError(response: Response): Promise<SerchaHttpError> {
    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    const envelope = body as
      | {
          error?: string;
          message?: string;
          code?: string;
          object_ref?: { kind: string; ref: string };
        }
      | undefined;

    // The API returns the message under `error`; `message` is a legacy shape.
    // Timeout responses are plain text, so fall back to the raw body.
    const message =
      envelope?.error ??
      envelope?.message ??
      (text && !body ? text.slice(0, 200) : undefined) ??
      `HTTP ${response.status}`;

    return new SerchaHttpError(response.status, message, {
      ...(envelope?.code !== undefined ? { code: envelope.code } : {}),
      ...(envelope?.object_ref !== undefined ? { objectRef: envelope.object_ref } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  }

  private shouldRetry(error: unknown): boolean {
    // Deterministic: the same request produces the same unparseable body, so
    // retrying only delays the error. Checked before SerchaError, which it
    // extends.
    if (error instanceof SerchaDecodeError) return false;

    if (error instanceof SerchaHttpError) {
      // 401 is retried once so a revoked token can be re-minted; the
      // invalidate() in the retry loop is what makes that meaningful.
      return error.isRetryable || error.status === 401;
    }

    // Timeouts and network faults are transient by nature. A bare SerchaError
    // from the fetch call is a connection-level failure.
    return error instanceof SerchaTimeoutError || error instanceof SerchaError;
  }

  /**
   * Backoff for the next attempt: server-directed if it said so, otherwise
   * exponential with full jitter.
   *
   * Jitter matters when a sweep fires many queries at once: without it, all of
   * them back off in lockstep and re-collide on every retry.
   */
  private backoffMs(error: unknown, attempt: number, base: number, max: number): number {
    if (error instanceof SerchaHttpError) {
      const retryAfter = this.parseRetryAfter(error);
      if (retryAfter !== undefined) return Math.min(retryAfter, RETRY_AFTER_CAP_MS);
    }
    const exponential = Math.min(base * 2 ** (attempt - 1), max);
    return Math.random() * exponential;
  }

  private parseRetryAfter(error: SerchaHttpError): number | undefined {
    const body = error.body as { retry_after?: unknown } | undefined;
    const value = body?.retry_after;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value * 1000;
    }
    return undefined;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Compose the caller's signal with our timeout, whichever fires first. */
  private composeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!caller) return timeout;
    // AbortSignal.any is Node 20+/modern browsers; fall back for Node 18.
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([caller, timeout]);
    }
    const controller = new AbortController();
    const abort = (reason: unknown) => controller.abort(reason);
    if (caller.aborted) abort(caller.reason);
    else caller.addEventListener('abort', () => abort(caller.reason), { once: true });
    if (timeout.aborted) abort(timeout.reason);
    else timeout.addEventListener('abort', () => abort(timeout.reason), { once: true });
    return controller.signal;
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${this.config.baseUrl}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /** Bearer token for callers managing their own connection, e.g. SSE. */
  async authHeader(): Promise<string> {
    return `Bearer ${await this.tokens.getToken()}`;
  }

  get resolved(): ResolvedConfig {
    return this.config;
  }
}
