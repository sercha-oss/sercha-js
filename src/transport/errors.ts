/**
 * Error hierarchy.
 *
 * Every failure the client raises is a SerchaError, so `catch (e) { if (e
 * instanceof SerchaError) }` is sufficient. Subclasses narrow the cause where
 * a caller can plausibly act on it differently.
 */

/** Base class for every error this client raises. */
export class SerchaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SerchaError';
  }
}

/** Thrown when the client is constructed with unusable configuration. */
export class SerchaConfigError extends SerchaError {
  constructor(message: string) {
    super(message);
    this.name = 'SerchaConfigError';
  }
}

/**
 * A non-2xx HTTP response.
 *
 * The server's error envelope is `{ error, code?, object_ref? }`. `error`
 * carries the human-readable message and becomes `message`. `code` and
 * `objectRef` are populated only by the SerchaQL query endpoint, which
 * identifies the named object a statement failed on.
 */
export class SerchaHttpError extends SerchaError {
  readonly status: number;
  /** Structured error code, e.g. "corpus_not_found". Query endpoint only. */
  readonly code?: string;
  /** The named object the statement failed on. Query endpoint only. */
  readonly objectRef?: { kind: string; ref: string };
  /** Raw parsed body, for cases the typed fields do not cover. */
  readonly body?: unknown;

  constructor(
    status: number,
    message: string,
    opts: { code?: string; objectRef?: { kind: string; ref: string }; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'SerchaHttpError';
    this.status = status;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.objectRef !== undefined) this.objectRef = opts.objectRef;
    if (opts.body !== undefined) this.body = opts.body;
  }

  /** 401 or 403. Distinguishes credential problems from other 4xx. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * Whether retrying this exact request could plausibly succeed. 429 and the
   * transient 5xx family; notably not 500, which usually indicates a
   * deterministic server-side fault.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/** OAuth token endpoint failure. Carries the RFC 6749 error code. */
export class SerchaAuthError extends SerchaError {
  /** e.g. "invalid_client", "invalid_scope", "unsupported_grant_type". */
  readonly oauthError: string;
  readonly status: number;

  constructor(status: number, oauthError: string, description?: string) {
    super(description ? `${oauthError}: ${description}` : oauthError);
    this.name = 'SerchaAuthError';
    this.status = status;
    this.oauthError = oauthError;
  }
}

/**
 * A 2xx response whose body could not be decoded.
 *
 * Distinct from a network fault because it is deterministic: the same request
 * will produce the same unparseable body, so it is not retried.
 */
export class SerchaDecodeError extends SerchaError {
  readonly status: number;
  /** Start of the raw body, for diagnosis. */
  readonly rawBody: string;

  constructor(status: number, rawBody: string, options?: { cause?: unknown }) {
    super(`Malformed JSON in ${status} response: ${rawBody.slice(0, 200)}`, options);
    this.name = 'SerchaDecodeError';
    this.status = status;
    this.rawBody = rawBody;
  }
}

/** A request exceeded its timeout, or the caller's AbortSignal fired. */
export class SerchaTimeoutError extends SerchaError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'SerchaTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The server returned 202 because running the statement would exceed a
 * plugin's soft call limit.
 *
 * This is a protocol step, not a fault: inspect `estimate`, and if the cost is
 * acceptable re-issue the same query with `{ confirm: true }`. Ignoring it
 * means the query silently never runs.
 */
export class PluginConfirmationRequiredError extends SerchaError {
  readonly estimate: PluginCallEstimate;

  constructor(estimate: PluginCallEstimate) {
    super(
      `Query requires confirmation: ${estimate.uncached_calls} uncached ` +
        `${estimate.provider} calls exceed the soft limit of ${estimate.soft_call_limit}`,
    );
    this.name = 'PluginConfirmationRequiredError';
    this.estimate = estimate;
  }
}

/** Cost estimate attached to a 202 confirmation-required response. */
export interface PluginCallEstimate {
  provider: string;
  operation: string;
  uncached_calls: number;
  soft_call_limit: number;
  rate_limit_rpm: number;
  /** 0 means the wait is negligible. */
  estimated_wait_seconds: number;
}

/** Polling for a terminal run state exceeded the caller's budget. */
export class SerchaRunTimeoutError extends SerchaError {
  readonly runId: string;
  /** Last status observed before giving up. The run itself continues. */
  readonly lastStatus: string;

  constructor(runId: string, lastStatus: string, timeoutMs: number) {
    super(
      `Run ${runId} did not reach a terminal state within ${timeoutMs}ms ` +
        `(last status: ${lastStatus}). The run is still executing server-side.`,
    );
    this.name = 'SerchaRunTimeoutError';
    this.runId = runId;
    this.lastStatus = lastStatus;
  }
}
