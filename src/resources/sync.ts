import type { HttpTransport } from '../transport/http.js';
import { isAccepted202, type Accepted202 } from '../transport/http.js';
import { SerchaTimeoutError } from '../transport/errors.js';
import type { Document } from '../types/documents.js';
import {
  isTerminalIngestStatus,
  type PushDocumentsRequest,
  type PushDocumentsResponse,
  type SourceSyncState,
  type SyncAccepted,
  type WaitForIngestOptions,
} from '../types/sync.js';

const INGEST_DEFAULTS = {
  timeoutMs: 300_000,
  pollIntervalMs: 1_000,
  maxPollIntervalMs: 15_000,
} as const;

/**
 * Source sync and document push.
 *
 * Everything here is asynchronous on the server side: a sync trigger answers
 * 202 and runs in the background, and a pushed document is accepted long
 * before it is processed. The methods reflect that split — trigger/push
 * return immediately, and the state/polling methods observe progress.
 *
 * Triggering syncs and pushing documents are admin/write-gated: a default
 * service account receives 403 on them and applications should degrade
 * gracefully. Reading sync state needs only an authenticated token.
 */
export class SyncResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Queue a sync of a source. Returns the accepted task, not the result.
   *
   * Requires an admin token; a default service account gets 403. Watch
   * progress through syncState(), not by re-triggering: a second trigger
   * while one is running is at best a no-op.
   */
  async triggerSync(sourceId: string, signal?: AbortSignal): Promise<SyncAccepted> {
    const response = await this.http.request<SyncAccepted | Accepted202<SyncAccepted>>(
      `/api/v1/sources/${encodeURIComponent(sourceId)}/sync`,
      { method: 'POST', body: {}, ...(signal ? { signal } : {}) },
    );
    // The transport tags 202 bodies so the query resource can run its confirm
    // protocol; here 202 is simply the success shape, so unwrap it.
    return isAccepted202<SyncAccepted>(response) ? response.body : response;
  }

  /**
   * The sync state of one source.
   *
   * Check `warning`: it is non-null when a sync completed but almost certainly
   * did not do what was intended (zero documents enumerated over a source with
   * zero local documents), and nothing else surfaces that — the sync itself
   * reports success.
   */
  async syncState(sourceId: string, signal?: AbortSignal): Promise<SourceSyncState> {
    return this.http.request<SourceSyncState>(
      `/api/v1/sources/${encodeURIComponent(sourceId)}/sync`,
      signal ? { signal } : {},
    );
  }

  /** Sync states for every source, for an ops overview. */
  async syncStates(signal?: AbortSignal): Promise<SourceSyncState[]> {
    const states = await this.http.request<SourceSyncState[] | null>(
      '/api/v1/sources/sync-states',
      signal ? { signal } : {},
    );
    // List endpoints return JSON null rather than [] when empty.
    return states ?? [];
  }

  /**
   * Push documents into a source.
   *
   * Write-gated: a default service account gets 403. Acceptance is not
   * indexing — a returned document_id means the bytes were stored, and the
   * document then moves through ingest_status 'processing' to 'indexed' or
   * 'failed'. Use waitForIngest() before treating a pushed document as
   * processed, or the first read after a push silently misses it.
   *
   * Partial failure is per-result, not per-request: inspect `error` on each
   * entry of `results`.
   */
  async pushDocuments(
    sourceId: string,
    req: PushDocumentsRequest,
    signal?: AbortSignal,
  ): Promise<PushDocumentsResponse> {
    const response = await this.http.request<PushDocumentsResponse>(
      `/api/v1/sources/${encodeURIComponent(sourceId)}/documents`,
      { method: 'POST', body: req, ...(signal ? { signal } : {}) },
    );
    return { ...response, results: response.results ?? [] };
  }

  /**
   * Poll pushed documents until every one reaches a terminal ingest state.
   *
   * Returns the documents in the order the ids were given. 'failed' is
   * returned, not thrown — like a failed run, it is an outcome to inspect per
   * document rather than a client fault. Check ingest_status.
   *
   * The poll interval grows geometrically toward maxPollIntervalMs, so a fast
   * ingest is noticed quickly without a slow one polling hundreds of times.
   * Documents already terminal stop being polled, so the cost tracks the
   * stragglers rather than the batch size.
   *
   * Raises SerchaTimeoutError past the budget, naming the still-pending ids;
   * ingest continues server-side, so those ids stay valid for a later check.
   */
  async waitForIngest(documentIds: string[], opts: WaitForIngestOptions = {}): Promise<Document[]> {
    const timeoutMs = opts.timeoutMs ?? INGEST_DEFAULTS.timeoutMs;
    const maxInterval = opts.maxPollIntervalMs ?? INGEST_DEFAULTS.maxPollIntervalMs;
    let interval = opts.pollIntervalMs ?? INGEST_DEFAULTS.pollIntervalMs;

    const deadline = Date.now() + timeoutMs;
    const settled = new Map<string, Document>();
    let pending = [...documentIds];

    for (;;) {
      const still: string[] = [];
      for (const id of pending) {
        const document = await this.http.request<Document>(
          `/api/v1/documents/${encodeURIComponent(id)}`,
          opts.signal ? { signal: opts.signal } : {},
        );
        // Absent means the document never passed through async ingest, which
        // only ever ends indexed.
        if (!document.ingest_status || isTerminalIngestStatus(document.ingest_status)) {
          settled.set(id, document);
        } else {
          still.push(id);
        }
      }
      pending = still;

      if (pending.length === 0) {
        return documentIds.map((id) => settled.get(id)!);
      }

      if (Date.now() >= deadline) {
        throw new SerchaTimeoutError(
          timeoutMs,
          `Ingest did not complete within ${timeoutMs}ms; still pending: ` +
            `${pending.join(', ')}. Ingest continues server-side, so these ids ` +
            'remain valid for a later check.',
        );
      }

      // Never sleep past the deadline: doing so reports the timeout later
      // than the caller asked for.
      const remaining = deadline - Date.now();
      await sleep(Math.min(interval, remaining), opts.signal);
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
