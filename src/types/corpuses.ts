/**
 * Corpus read types (Sercha 0.17+), for the grant-scoped read tier behind a
 * "your data" / rooms surface.
 *
 * Field names are the wire shape verbatim (snake_case), for the same reason
 * as the query types: a mapping layer means every new server field needs a
 * client release before it is reachable.
 *
 * Auth varies per endpoint and it matters: `list`/`get` are admin-gated
 * (403 for a default service account — degrade, don't fault), while
 * `documents`/`partitions` need a select GRANT on the corpus and answer 404
 * without one — deliberately indistinguishable from a missing corpus, so an
 * ungranted caller cannot confirm what exists.
 */

import type { Document } from './search.js';

/**
 * The partition key documents carry while they sit in a structure corpus's
 * tray or archive: out of every pack, linked to nothing. A rooms UI should
 * treat it as its own group, never as a pack name.
 */
export const UNASSIGNED_PARTITION_KEY = '_unassigned';

/** A corpus as the admin CRUD surface returns it. */
export interface Corpus {
  id: string;
  name: string;
  container_ids: string[];
  partition_level: number;
  /** '' unpartitioned | 'folder' | 'group' | 'structure'. */
  partition_strategy?: string;
  partition_group_field?: string;
  /**
   * The organise structure of a structure-partitioned corpus, as
   * '<collection_id>.<structure_name>'. Absent on non-structure corpora
   * and on servers older than 0.18.
   */
  partition_structure_ref?: string;
  /** Resolved container rows. Single-GET responses only; lists omit it. */
  containers?: SourceContainer[];
  created_at: string;
  updated_at: string;
}

/** A source container row as embedded in a corpus GET. */
export interface SourceContainer {
  id: string;
  source_id?: string;
  name?: string;
  parent_id?: string;
  authorised?: boolean;
  claimed?: boolean;
  [key: string]: unknown;
}

/** One document row of a corpus listing: the document plus its partition key. */
export interface CorpusDocument extends Document {
  /**
   * The key this document's membership row carries — a pack's structure key,
   * a folder key, or a group label. '' means global/unpartitioned;
   * UNASSIGNED_PARTITION_KEY means trayed or archived.
   */
  partition_key: string;
}

/** GET /api/v1/corpuses/{id}/documents — one page of member documents. */
export interface CorpusDocumentsPage {
  documents: CorpusDocument[];
  /** All members when unfiltered; the matching partition's count when filtered. */
  total: number;
  limit: number;
  offset: number;
}

/** One distinct partition key and how many member documents carry it. */
export interface PartitionCount {
  /** '' is a real value: global/ancestor documents, or an unpartitioned corpus. */
  key: string;
  doc_count: number;
}

/**
 * GET /api/v1/corpuses/{id}/partitions.
 *
 * For a structure-organised corpus the response also carries the room badge:
 * `structure_state` and `tray_count`, so a rooms index renders per-room
 * attention from this one call. Absent for other corpora (and on servers
 * where the structure service is not wired).
 */
export interface CorpusPartitions {
  corpus_id: string;
  structure_state?: string;
  tray_count?: number;
  partitions: PartitionCount[];
}
