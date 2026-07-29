/**
 * SerchaQL query types.
 *
 * Field names are the wire shape verbatim (snake_case). There is no
 * camelCase mapping layer: a translation layer means every new server field
 * needs a client release before it is reachable, and mismatches surface as
 * undefined rather than as a type error.
 */

/**
 * A nested relation value.
 *
 * Columns of type `relation` arrive as a positional RowSet rather than a flat
 * object, because a relation is a table, not a scalar.
 */
export interface NestedRowSet {
  schema: Array<{ name: string; type: string }>;
  rows: Array<{ values: unknown[] }>;
}

/** Any value a column can hold once unwrapped by the server. */
export type CellValue = string | number | boolean | null | NestedRowSet;

/**
 * One result row: a flat object keyed by column name.
 *
 * Entity scans also carry system columns: `_id`, `_entity_type`, `_doc`,
 * `_run_id`, `_confidence`.
 */
export type QueryRow = Record<string, CellValue>;

export interface QueryOpStat {
  operator_kind: string;
  rows_in: number;
  rows_out: number;
  elapsed_ns: number;
}

export interface QueryStats {
  row_count: number;
  op_stats?: QueryOpStat[];
}

/**
 * Execution context for the statement.
 *
 * Present for SELECT/SEARCH where the executor resolves a corpus; absent for
 * DDL and SHOW. `pipeline_config_hash` is reserved and always absent today.
 */
export interface ExecutionContext {
  corpus_id?: string;
  ontology_version?: string;
  pipeline_config_hash?: string;
}

/** Column descriptor, derived client-side. See QueryResult.columns. */
export interface QueryColumn {
  name: string;
}

export interface QueryResult<T = QueryRow> {
  rows: T[];
  stats: QueryStats;
  /**
   * Column names in first-seen order across the returned rows.
   *
   * Derived client-side: the wire format sends flat row objects with no
   * schema. This carries no type information, and a column absent from every
   * returned row cannot appear here at all — so it describes this result, not
   * the underlying entity. Use the catalogue for the real schema.
   */
  columns: QueryColumn[];
  context?: ExecutionContext;
}

/** Kinds an error's object_ref can point at. */
export type ObjectKind =
  | 'ontology'
  | 'entity'
  | 'edge'
  | 'property'
  | 'corpus'
  | 'binding'
  | 'pipeline'
  | 'surface'
  | 'source'
  | 'document'
  | 'view'
  | 'mview';

/** Raw wire response from POST /api/v1/query. */
export interface RawQueryResponse {
  rows?: QueryRow[];
  stats?: { row_count?: number; op_stats?: QueryOpStat[] };
  context?: ExecutionContext;
  confirmation_required?: true;
  estimate?: {
    provider: string;
    operation: string;
    uncached_calls: number;
    soft_call_limit: number;
    rate_limit_rpm: number;
    estimated_wait_seconds: number;
  };
}

export interface QueryOptions {
  /**
   * Proceed past a plugin soft call limit.
   *
   * Set only after a PluginConfirmationRequiredError, having decided its
   * estimate is acceptable.
   */
  confirm?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PaginateOptions extends QueryOptions {
  /**
   * Rows per request. Default 500.
   *
   * Sercha applies a 30s deadline to the query endpoint and caps bodies at
   * 10 MiB, so a large page size fails the whole page rather than degrading.
   */
  pageSize?: number;
  /** Stop after this many rows. Unbounded by default. */
  maxRows?: number;
}
