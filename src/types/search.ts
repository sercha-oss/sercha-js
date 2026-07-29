/** Retrieval types for POST /api/v1/search. */

export interface SearchRequest {
  query: string;
  mode?: 'hybrid' | 'text' | 'semantic';
  limit?: number;
  offset?: number;
  source_ids?: string[];
}

export interface SearchResultItem {
  document_id: string;
  source_id: string;
  title: string;
  path: string;
  mime_type: string;
  snippet: string;
  score: number;
  indexed_at: string;
  /** Which query variants matched, when the pipeline expanded the query. */
  matched_queries?: string[];
  /** Reciprocal-rank-fusion score, when hybrid retrieval ran. */
  rrf_score?: number;
  /**
   * Free-form bag from the pipeline. Known keys:
   *   reranked: boolean - a cross-encoder scored this candidate, so `score`
   *     is a rerank score rather than a fusion score.
   *   reranker: string - provider name.
   */
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  mode: string;
  results: SearchResultItem[];
  total_count?: number;
  /** Server-side latency in ms. */
  took?: number;
}

export interface Document {
  id: string;
  source_id: string;
  title: string;
  path: string;
  mime_type: string;
  body?: string;
  indexed_at: string;
  metadata?: Record<string, unknown>;
}

export interface Source {
  id: string;
  name: string;
  connector: string;
  created_at: string;
  updated_at: string;
}
