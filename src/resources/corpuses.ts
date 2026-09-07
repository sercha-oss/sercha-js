import type { HttpTransport } from '../transport/http.js';
import type { Corpus, CorpusDocumentsPage, CorpusPartitions } from '../types/corpuses.js';

/**
 * Corpus reads: the listing, membership and partition surfaces behind a
 * "your data" / rooms UI (Sercha 0.17+).
 *
 * Two auth tiers inside one resource, and the difference is the point:
 * `list`/`get` are admin-gated (403 for a default service account — hide the
 * surface, don't fault), while `documents`/`partitions` need only a select
 * grant on the corpus and answer 404 without one. An application should
 * discover its corpora from the grant-filtered catalogue tree and use the
 * granted reads here; the admin pair exists for operator tooling.
 */
export class CorpusesResource {
  constructor(private readonly http: HttpTransport) {}

  /** Every corpus. Admin-gated; a bare array on the wire, null when empty. */
  async list(signal?: AbortSignal): Promise<Corpus[]> {
    const corpora = await this.http.request<Corpus[] | null>('/api/v1/corpuses', {
      ...(signal ? { signal } : {}),
    });
    return corpora ?? [];
  }

  /** One corpus with its resolved containers. Admin-gated. */
  async get(corpusId: string, signal?: AbortSignal): Promise<Corpus> {
    return this.http.request<Corpus>(`/api/v1/corpuses/${encodeURIComponent(corpusId)}`, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * One page of the corpus's member documents, each row carrying its
   * partition_key. Requires a select grant on the corpus (or admin).
   *
   * `partitionKey` filters to one partition — pass it to list a pack's
   * members. The empty string is a real key (global documents), which is why
   * the option is a presence test, not a truthiness test. A 404 can mean
   * missing corpus, missing grant, or a server where the route is not wired;
   * the caller cannot and should not distinguish.
   */
  async documents(
    corpusId: string,
    opts?: { limit?: number; offset?: number; partitionKey?: string },
    signal?: AbortSignal,
  ): Promise<CorpusDocumentsPage> {
    const query: Record<string, string | number> = {};
    if (opts?.limit !== undefined) query.limit = opts.limit;
    if (opts?.offset !== undefined) query.offset = opts.offset;
    if (opts?.partitionKey !== undefined) query.partition_key = opts.partitionKey;
    const response = await this.http.request<CorpusDocumentsPage>(
      `/api/v1/corpuses/${encodeURIComponent(corpusId)}/documents`,
      { ...(Object.keys(query).length ? { query } : {}), ...(signal ? { signal } : {}) },
    );
    return { ...response, documents: response.documents ?? [] };
  }

  /**
   * The corpus's distinct partition keys with member counts, plus — for a
   * structure-organised corpus — the room badge (`structure_state`,
   * `tray_count`). Requires a select grant on the corpus (or admin).
   */
  async partitions(corpusId: string, signal?: AbortSignal): Promise<CorpusPartitions> {
    const response = await this.http.request<CorpusPartitions>(
      `/api/v1/corpuses/${encodeURIComponent(corpusId)}/partitions`,
      { ...(signal ? { signal } : {}) },
    );
    return { ...response, partitions: response.partitions ?? [] };
  }
}
