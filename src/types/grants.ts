/**
 * Grant types: the Sercha-native authorisation assertions behind every
 * corpus, partition and source read or write.
 *
 * Field names are the wire shape verbatim (snake_case), as everywhere else in
 * this client: a mapping layer means every new server field needs a client
 * release before it is reachable.
 *
 * A grant asserts that a subject (a user or a group) holds an action on an
 * object. Actions compose: `annotate` and `curate` each presume `select` on
 * the same corpus (writing about or curating what you cannot read is
 * incoherent), while `write` on a source stands alone (pushing into a source
 * and reading the corpora built over it are separate decisions).
 */

/** Who holds the grant. Groups resolve transitively at check time. */
export type GrantSubjectKind = 'user' | 'group';

/**
 * What the grant permits.
 *
 * - `select`: read the object (query rows, list documents, search hits).
 * - `use`: use a pipeline or binding without administering it.
 * - `admin`: administer the object.
 * - `annotate`: author ledger records about a corpus. Needs `select` too.
 * - `curate`: the structure curation surface on a corpus (tray, assignments,
 *   flag confirmations). Needs `select` too.
 * - `write`: push documents into a source. Stands alone; does not imply
 *   reading what was pushed.
 */
export type GrantAction = 'select' | 'use' | 'admin' | 'annotate' | 'curate' | 'write';

/**
 * What the grant is on.
 *
 * - `corpus`: a whole corpus, by id.
 * - `binding`, `pipeline`: by id.
 * - `ledger`: a bare ledger scan (reading records without joining them to
 *   facts), by ontology.
 * - `partition`: one partition of a corpus. The object id is
 *   `<corpus id>:<partition key>`; build it with `partitionObjectId()`.
 * - `source`: a push source, by id; the object of a `write` grant.
 */
export type GrantObjectKind = 'corpus' | 'binding' | 'pipeline' | 'ledger' | 'partition' | 'source';

/**
 * Build the object id of a partition grant: `<corpus id>:<partition key>`.
 *
 * Corpus ids never carry a colon, so the server splits on the first one and
 * the key may carry anything, including slashes. The key is the value the
 * corpus's documents carry as `partition_key` (a folder prefix, a group
 * value, or a pack chain such as `room/tenant a`); `''` names the global
 * documents.
 */
export function partitionObjectId(corpusId: string, key: string): string {
  return `${corpusId}:${key}`;
}

/** POST /api/v1/grants. */
export interface CreateGrantRequest {
  subject_kind: GrantSubjectKind;
  subject_id: string;
  action: GrantAction;
  object_kind: GrantObjectKind;
  object_id: string;
}

/** A grant as the server returns it. */
export interface Grant {
  id: string;
  subject_kind: GrantSubjectKind;
  subject_id: string;
  action: GrantAction;
  object_kind: GrantObjectKind;
  object_id: string;
  /** RFC3339. */
  granted_at: string;
  /** The user id that created the grant; empty when created by the system. */
  granted_by: string;
}

/**
 * GET /api/v1/grants filter. Every field is optional and absent fields are
 * not applied, so an empty filter lists every grant.
 */
export interface ListGrantsFilter {
  subject_kind?: GrantSubjectKind;
  subject_id?: string;
  action?: GrantAction;
  object_kind?: GrantObjectKind;
  object_id?: string;
}

/**
 * GET /api/v1/grants/check. The subject is always the authenticated caller:
 * the endpoint takes no subject id, so one token cannot probe another's
 * grants.
 */
export interface CheckGrantRequest {
  action: GrantAction;
  object_kind: GrantObjectKind;
  object_id: string;
}

export interface CheckGrantResponse {
  allowed: boolean;
}
