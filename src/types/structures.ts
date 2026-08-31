/**
 * Pack Builder types, for corpora organised by structure (Sercha 0.16.3+).
 *
 * Field names are the wire shape verbatim (snake_case), for the same reason as
 * the query types: a mapping layer means every new server field needs a client
 * release before it is reachable.
 *
 * Every structure endpoint is admin-gated. A default service account receives
 * 403, so an application embedding this surface should degrade gracefully
 * rather than treat the 403 as a fault.
 */

/**
 * Where the corpus's structure stands as a whole.
 *
 * `grouping` means the agent is still working, so counts are moving;
 * `needs_review` means the tray has entries a human should look at. Reading
 * this before rendering a review UI prevents presenting half-built state as
 * settled.
 */
export type StructureState = 'fresh' | 'stale' | 'grouping' | 'needs_review';

/** Who produced a tray entry or an assignment event. */
export type StructureActor = 'agent' | 'mapper' | 'human';

/**
 * Why a document landed in the tray instead of a pack.
 *
 * `multi_tenancy`: it plausibly belongs to more than one pack;
 * `duplicate_of`: it appears to duplicate a document already placed;
 * `no_pack`: no existing pack fits. Null means the entry is informational.
 */
export type StructureTrayFlag = 'multi_tenancy' | 'duplicate_of' | 'no_pack';

/**
 * One pack in the corpus structure. Recursive: packs nest via `children`.
 *
 * `doc_count` covers this pack alone; `subtree_doc_count` includes every
 * descendant, so a rollup does not need to walk the tree itself.
 */
export interface StructurePack {
  id: string;
  level_name: string;
  slug: string;
  display_name: string;
  doc_count: number;
  subtree_doc_count: number;
  unlocked_agent_count: number;
  unlocked_field_count?: number;
  /** Required fields the pack's documents have not yet yielded. */
  missing_required_fields?: string[];
  review_state: string;
  children: StructurePack[];
}

/** GET /api/v1/corpuses/{corpusId}/structure. */
export interface CorpusStructure {
  corpus_id: string;
  structure_ref: string;
  structure_state: StructureState;
  /** Documents waiting in the tray. Nonzero means a human has work to do. */
  tray_count: number;
  packs: StructurePack[];
}

/**
 * A document the agent could not place confidently.
 *
 * `flag_payload` is deliberately untyped: its shape depends on the flag and on
 * the server version, and narrowing it here would silently drop fields a newer
 * server sends. Inspect it per flag.
 */
export interface StructureTrayEntry {
  document_id: string;
  document_title: string;
  document_path: string;
  event_id: string;
  actor: StructureActor;
  flag: StructureTrayFlag | null;
  flag_payload: unknown;
  rationale: string;
  /** Null when the actor was a human: humans are not calibrated. */
  confidence: number | null;
  created_at: string;
}

/** One group of tray entries, when the tray was requested grouped. */
export interface StructureTrayGroup {
  candidate: string;
  entries: StructureTrayEntry[];
  [key: string]: unknown;
}

/** GET /api/v1/corpuses/{corpusId}/structure/tray. */
export interface StructureTray {
  entries: StructureTrayEntry[];
  /** Present only when the tray was requested with a group_by. */
  groups?: StructureTrayGroup[];
}

/**
 * Assignment target: either a known pack by id, or a path of level values for
 * a pack that may not exist yet — the server creates the missing levels.
 *
 * A union rather than two optional fields, so sending both (or neither) is a
 * type error here instead of a 4xx there.
 */
export type AssignDocumentRequest =
  | {
      document_id: string;
      container_id: string;
      /** Why the human placed it here. Stored on the event for the next reviewer. */
      rationale?: string;
    }
  | {
      document_id: string;
      level_values: string[];
      rationale?: string;
    };

/** The recorded assignment event. Actor comes from the caller, never the body. */
export interface StructureAssignmentEvent {
  id: string;
  document_id: string;
  container_id: string;
  actor: StructureActor;
  rationale: string | null;
  created_at: string;
}

/** POST /api/v1/corpuses/{corpusId}/structure/assignments. */
export interface AssignDocumentResponse {
  event: StructureAssignmentEvent;
  container_id: string;
  /**
   * A human assignment locks: the agent will not move this document on a later
   * rerun. Another human can still re-repair it.
   */
  locked: boolean;
  /** The `_folder` value the document's rows now carry in queries. */
  partition_key: string;
}

export interface RerunStructureRequest {
  /** Scope the rerun to these documents. Omit to rerun the whole corpus. */
  document_ids?: string[];
}

/** POST /api/v1/corpuses/{corpusId}/structure/rerun. */
export interface RerunStructureResponse {
  run_id: string;
  status: string;
  pipeline_id: string;
  trigger_kind: string;
  document_ids?: string[];
}
