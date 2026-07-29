import type { HttpTransport } from '../transport/http.js';
import type { Document, SearchRequest, SearchResponse, Source } from '../types/search.js';

/**
 * Document retrieval.
 *
 * Distinct from query(): search is ranked full-text and semantic retrieval
 * over document bodies, while SerchaQL queries the extracted entity graph.
 */
export class SearchResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Search indexed documents.
   *
   * Search runs under the server's extended 5-minute deadline rather than the
   * 30s one, so the client timeout is raised to match; a hybrid search over a
   * large corpus can legitimately exceed 30s.
   */
  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const response = await this.http.request<SearchResponse>('/api/v1/search', {
      method: 'POST',
      body: request,
      timeoutMs: 300_000,
      ...(signal ? { signal } : {}),
    });
    return { ...response, results: response.results ?? [] };
  }

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

  async getSource(sourceId: string, signal?: AbortSignal): Promise<Source> {
    return this.http.request<Source>(`/api/v1/sources/${encodeURIComponent(sourceId)}`, {
      ...(signal ? { signal } : {}),
    });
  }
}
