import type { HttpTransport } from '../transport/http.js';
import { SerchaRunTimeoutError } from '../transport/errors.js';
import {
  isTerminalStatus,
  type ListRunsQuery,
  type Run,
  type RunStaging,
  type RunTraceEntry,
  type WaitForRunOptions,
} from '../types/runs.js';

const DEFAULTS = {
  timeoutMs: 900_000,
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 15_000,
} as const;

/**
 * Pipeline runs.
 *
 * Note on permissions: reading runs needs only an authenticated token, but
 * triggering, replaying, cancelling and deleting are admin-gated. A default
 * service account can observe runs and not start them.
 */
export class RunsResource {
  constructor(private readonly http: HttpTransport) {}

  /** One run by ID. Includes document_ids and document_count. */
  async get(runId: string, signal?: AbortSignal): Promise<Run> {
    return this.http.request<Run>(`/api/v1/runs/${encodeURIComponent(runId)}`, {
      ...(signal ? { signal } : {}),
    });
  }

  /** List runs, newest first. Server default limit is 50. */
  async list(query: ListRunsQuery = {}, signal?: AbortSignal): Promise<Run[]> {
    const runs = await this.http.request<Run[] | null>('/api/v1/runs', {
      query: { ...query },
      ...(signal ? { signal } : {}),
    });
    // List endpoints return JSON null rather than [] when empty.
    return runs ?? [];
  }

  /** Execution trace for a run. Empty until the run starts. */
  async trace(runId: string, signal?: AbortSignal): Promise<RunTraceEntry[]> {
    const response = await this.http.request<{ trace?: RunTraceEntry[] | null }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/trace`,
      { ...(signal ? { signal } : {}) },
    );
    return response.trace ?? [];
  }

  /** Node and edge counts a run staged. */
  async staging(runId: string, signal?: AbortSignal): Promise<RunStaging> {
    return this.http.request<RunStaging>(`/api/v1/runs/${encodeURIComponent(runId)}/staging`, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Trigger a run of a pipeline. Returns immediately with the queued run.
   *
   * Requires an admin token. A default service account gets 403.
   *
   * The returned run omits document_ids and document_count; fetch it with
   * get() if those are needed.
   *
   * @param triggeredBy Ignored since 0.3.0, and kept only so an existing caller
   * still compiles. The server took this from the request body and trusted it,
   * which let any caller attribute a run to any user id it chose. Sercha's own
   * rule, stated in its query handler, is that a subject is always derived from
   * the authenticated caller and never accepted from a body, because doing so
   * allows privilege escalation by forging another user's identity. This
   * parameter was the one place that rule was broken, so the SDK stopped
   * sending the field. Attribution now comes from the token, which is the only
   * source that cannot be forged.
   */
  async trigger(pipelineId: string, triggeredBy?: string, signal?: AbortSignal): Promise<Run> {
    void triggeredBy;
    return this.http.request<Run>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}/runs`, {
      method: 'POST',
      body: {},
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Poll a run until it reaches a terminal state.
   *
   * Returns the run at `sealed` or `failed` — a failed run is returned, not
   * thrown, because failure is an outcome to inspect (`run.error`) rather than
   * a client fault. Check the status.
   *
   * The poll interval grows geometrically toward maxPollIntervalMs, so a short
   * run is noticed quickly without a long one polling hundreds of times.
   *
   * Raises SerchaRunTimeoutError past the budget; the run continues
   * server-side, so its ID stays valid for a later check.
   */
  async waitFor(runId: string, options: WaitForRunOptions = {}): Promise<Run> {
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxInterval = options.maxPollIntervalMs ?? DEFAULTS.maxPollIntervalMs;
    let interval = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;

    const deadline = Date.now() + timeoutMs;
    let last: Run | undefined;

    for (;;) {
      last = await this.get(runId, options.signal);
      options.onPoll?.(last);

      if (isTerminalStatus(last.status)) {
        return last;
      }

      if (Date.now() >= deadline) {
        throw new SerchaRunTimeoutError(runId, last.status, timeoutMs);
      }

      // Never sleep past the deadline: doing so reports the timeout later than
      // the caller asked for.
      const remaining = deadline - Date.now();
      await sleep(Math.min(interval, remaining), options.signal);
      interval = Math.min(interval * 1.5, maxInterval);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
