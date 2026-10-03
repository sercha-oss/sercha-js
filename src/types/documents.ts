/** Document and source types for /api/v1/documents and /api/v1/sources. */

import type { IngestStatus } from './sync.js';

export interface Document {
  id: string;
  source_id: string;
  title: string;
  path: string;
  mime_type: string;
  body?: string;
  indexed_at: string;
  /**
   * Where an asynchronously ingested document is in the pipeline. Absent on
   * older servers; treat absence as indexed, since only push-ingested
   * documents pass through a processing phase.
   */
  ingest_status?: IngestStatus;
  /**
   * Hex sha256 of the document's NORMALISED text (Sercha 0.17+). Empty or
   * absent means "not yet computed" — never treat two empties as a match
   * when clustering duplicates.
   */
  content_hash?: string;
  /** The provider-side container the document was found in. */
  container_id?: string;
  /** Caller- or connector-assigned identity within the source. */
  external_id?: string;
  created_at?: string;
  updated_at?: string;
  blob_retention_status?: string;
  metadata?: Record<string, unknown>;
}

/**
 * GET /api/v1/sources/{id}/documents — one page of a source's documents.
 * `total` counts the whole source, not the container-filtered subset.
 */
export interface SourceDocumentsPage {
  documents: Document[];
  total: number;
  limit: number;
  offset: number;
}

export interface Source {
  id: string;
  name: string;
  connector: string;
  created_at: string;
  updated_at: string;
}
