/**
 * Source sync and document push types.
 *
 * Field names are the wire shape verbatim (snake_case), as everywhere else in
 * this client: a mapping layer means every new server field needs a client
 * release before it is reachable.
 */

/**
 * POST /api/v1/sources/{sourceId}/sync answers 202: the sync is queued, not
 * done. `task_id` identifies the background task; watch progress through the
 * sync state, not by retrying the trigger.
 */
export interface SyncAccepted {
  status: 'accepted';
  source_id: string;
  task_id: string;
}

/**
 * The sync state of one source.
 *
 * Deliberately open (index signature): the server adds fields to this shape
 * between versions, and a closed type would hide them behind a client release.
 * The named fields are the ones an application can rely on.
 */
export interface SourceSyncState {
  source_id: string;
  status: string;
  /** RFC3339, null until the first sync completes. */
  last_sync_at?: string | null;
  /**
   * Set when something completed without doing what was almost certainly
   * intended — since Sercha 0.16.2, a sync that enumerated zero documents over
   * a source that also has zero local documents, which is nearly always a
   * misconfigured root or a stale cursor rather than a genuinely empty source.
   * A non-null warning deserves operator attention: render it, do not log and
   * drop it, because the sync "succeeded" and nothing else will flag it.
   */
  warning?: string | null;
  [key: string]: unknown;
}

/**
 * Where a pushed document is in the ingest pipeline.
 *
 * Acceptance is not indexing: pushDocuments() returning is only the start.
 * A document is processed at `indexed` and never will be at `failed`.
 */
export type IngestStatus = 'processing' | 'indexed' | 'failed';

/** Statuses from which a document's ingest will not advance. */
export const TERMINAL_INGEST_STATUSES: readonly IngestStatus[] = ['indexed', 'failed'];

export function isTerminalIngestStatus(status: IngestStatus): boolean {
  return TERMINAL_INGEST_STATUSES.includes(status);
}

/** One document to push. `content` is the raw bytes, base64-encoded. */
export interface PushDocument {
  external_id: string;
  title: string;
  path: string;
  mime_type: string;
  /** Base64-encoded document bytes. */
  content: string;
}

/**
 * POST /api/v1/sources/{sourceId}/documents.
 *
 * `mode: 'single'` is the only mode this client sends today; it is explicit in
 * the type so a future batch mode is an addition rather than a silent change
 * of meaning.
 */
export interface PushDocumentsRequest {
  mode: 'single';
  documents: PushDocument[];
}

/**
 * Per-document outcome of a push. Partial failure is normal: check `error`
 * per result rather than assuming the whole batch landed.
 */
export interface PushDocumentResult {
  document_id?: string;
  external_id?: string;
  error?: string;
  ingest_status?: IngestStatus;
}

export interface PushDocumentsResponse {
  results: PushDocumentResult[];
}

export interface WaitForIngestOptions {
  /**
   * Give up after this long. Default 300_000 (5 min).
   *
   * Exceeding it raises SerchaTimeoutError naming the still-pending ids;
   * ingest continues server-side, so the ids stay valid for a later check.
   */
  timeoutMs?: number;
  /** Initial poll interval in ms. Default 1_000. */
  pollIntervalMs?: number;
  /**
   * Ceiling for the poll interval in ms. Default 15_000.
   *
   * The interval grows geometrically from pollIntervalMs to this, so a fast
   * ingest is noticed promptly without a slow one polling hundreds of times.
   */
  maxPollIntervalMs?: number;
  signal?: AbortSignal;
}
