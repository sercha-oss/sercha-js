/**
 * Ledger: append-only authored records over document-derived facts.
 *
 * Facts are what documents say, rebuilt by extraction and owned by nobody. The
 * ledger is what people and agents say *about* those facts: "this cost is a
 * legitimate add-back", "this balance sheet does not reconcile". Claims someone
 * made and stands behind, which must outlive any rebuild of the facts they
 * refer to.
 *
 * The invariant the whole design serves: facts stay purely document-derived,
 * and the ledger never writes to them.
 */

/**
 * A record's kind, denormalised from its type for filtering.
 *
 * An `exception` asserts nothing beyond its own existence: "this does not
 * reconcile" is the whole claim, and the row being there is the finding. An
 * `assertion` carries a value.
 */
export type LedgerRecordKind = 'assertion' | 'exception';

/**
 * The basis for a claim, orthogonal to how confident anyone is in it.
 *
 *   observed  read directly off a document
 *   derived   computed from several facts
 *   asserted  a person's judgement, with no single line behind it
 */
export type LedgerAuthority = 'observed' | 'derived' | 'asserted';

export type LedgerAuthorKind = 'human' | 'agent';

/** The column types a record type may declare. */
export type LedgerValueType = 'string' | 'float' | 'int' | 'bool' | 'date';

/**
 * A span of a source document supporting a record.
 *
 * References documents rather than nodes, and carries `external_id` alongside
 * `doc_id`, because documents survive re-extraction and node IDs do not.
 * Everything below `doc_id` is optional: a claim about a computation ("this
 * does not reconcile") has no quotable span.
 */
export interface LedgerEvidence {
  doc_id?: string;
  external_id?: string;
  page?: number;
  cell?: string;
  quote?: string;
}

/** One declared column on a record type. */
export interface LedgerRecordTypeProperty {
  key: string;
  value_type: LedgerValueType;
  /** Part of the record's own identity within its subject. */
  is_key?: boolean;
  required?: boolean;
  /** Permitted values, for an enum column. */
  enum_values?: string[];
}

/**
 * A declared record type.
 *
 * Types are declared per ontology, in the same shape as entities: declaring one
 * adds no table, because every record lives in one store with its typed values
 * in a child table. `on_entity` is what lets a subject key be validated at
 * write time rather than trusted.
 */
export interface LedgerRecordType {
  id: string;
  ontology: string;
  name: string;
  kind: LedgerRecordKind;
  /** The fact entity this type attaches to. */
  on_entity: string;
  properties: LedgerRecordTypeProperty[];
  created_at?: string;
  created_by?: string;
}

export interface CreateLedgerRecordType {
  ontology: string;
  name: string;
  kind: LedgerRecordKind;
  on_entity: string;
  properties: LedgerRecordTypeProperty[];
}

/**
 * A record: something someone said about a fact.
 *
 * `subject_key` is a hash over durable components rather than a foreign key
 * into the facts, so a rebuilt fact recomputes the same key and the record
 * re-attaches with no repair job. Obtain one by selecting the `subject_key`
 * system column from a subject-keyed entity; it is not available on derived
 * (view) entities, which have no single source document to anchor to.
 */
export interface LedgerRecord {
  id: string;
  subject_key: string;
  subject_corpus_id: string;
  subject_entity?: string;
  record_type_id: string;
  kind: LedgerRecordKind;
  /** Typed columns declared by the record type. */
  values: Record<string, string | number | boolean | null>;
  authority: LedgerAuthority;
  /** Agent calibration in [0,1]. Null for human authors, who are not calibrated. */
  confidence?: number | null;
  evidence: LedgerEvidence[];
  author_kind: LedgerAuthorKind;
  author_id?: string | null;
  /** The record this one replaces. A record may be superseded at most once. */
  supersedes_id?: string | null;
  created_at: string;
}

/**
 * What a caller supplies to append a record.
 *
 * Deliberately without `id`, `author_id` or `created_at`: authorship comes from
 * the authenticated caller, so a client cannot write a record attributed to
 * someone else.
 */
export interface AppendLedgerRecord {
  subject_key: string;
  subject_corpus_id: string;
  subject_entity?: string;
  record_type_id: string;
  values?: Record<string, string | number | boolean | null>;
  authority?: LedgerAuthority;
  confidence?: number | null;
  evidence?: LedgerEvidence[];
}

export interface ListLedgerRecordsQuery {
  subject_key?: string;
  corpus_id?: string;
  record_type_id?: string;
  kind?: LedgerRecordKind;
  limit?: number;
}
