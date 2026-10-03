import type { HttpTransport } from '../transport/http.js';
import type { Document, Source, SourceDocumentsPage } from '../types/documents.js';

/**
 * Documents and sources: resolve a document id, list sources and page through
 * a source's documents.
 */
export class DocumentsResource {
  constructor(private readonly http: HttpTransport) {}

  async getDocument(documentId: string, signal?: AbortSignal): Promise<Document> {
    return this.http.request<Document>(`/api/v1/documents/${encodeURIComponent(documentId)}`, {
      ...(signal ? { signal } : {}),
    });
  }

  async listSources(signal?: AbortSignal): Promise<Source[]> {
    const sources = await this.http.request<Source[] | null>('/api/v1/sources', {
      ...(signal ? { signal } : {}),
    });
    return sources ?? [];
  }

  /**
   * One page of a source's documents, optionally scoped to containers.
   *
   * `total` counts the whole source regardless of the container filter — the
   * server has no filtered count. Documents carry ingest_status and (on
   * Sercha 0.17+) content_hash.
   */
  async listSourceDocuments(
    sourceId: string,
    opts?: { limit?: number; offset?: number; containerIds?: string[] },
    signal?: AbortSignal,
  ): Promise<SourceDocumentsPage> {
    const query: Record<string, string | number> = {};
    if (opts?.limit !== undefined) query.limit = opts.limit;
    if (opts?.offset !== undefined) query.offset = opts.offset;
    // The server takes a comma-separated list; the SDK does the joining so
    // callers can pass an array like everywhere else.
    if (opts?.containerIds?.length) query.container_ids = opts.containerIds.join(',');
    const response = await this.http.request<SourceDocumentsPage>(
      `/api/v1/sources/${encodeURIComponent(sourceId)}/documents`,
      { ...(Object.keys(query).length ? { query } : {}), ...(signal ? { signal } : {}) },
    );
    return { ...response, documents: response.documents ?? [] };
  }

  async getSource(sourceId: string, signal?: AbortSignal): Promise<Source> {
    return this.http.request<Source>(`/api/v1/sources/${encodeURIComponent(sourceId)}`, {
      ...(signal ? { signal } : {}),
    });
  }
}
