import type { HttpTransport } from '../transport/http.js';
import { isAccepted202 } from '../transport/http.js';
import { PluginConfirmationRequiredError, SerchaError } from '../transport/errors.js';
import type {
  PaginateOptions,
  QueryColumn,
  QueryOptions,
  QueryResult,
  QueryRow,
  RawQueryResponse,
} from '../types/query.js';

const DEFAULT_PAGE_SIZE = 500;

/** SerchaQL execution. */
export class QueryResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Run one SerchaQL statement.
   *
   * The type parameter asserts the row shape; it is not validated at runtime,
   * since the server sends no schema to check against.
   *
   * Throws PluginConfirmationRequiredError when the statement would exceed a
   * plugin's soft call limit. That is a protocol step: inspect the estimate
   * and re-run with `{ confirm: true }` if acceptable.
   */
  async run<T = QueryRow>(serchaql: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    const body: Record<string, unknown> = { serchaql };
    if (options.confirm) body.confirm = true;

    const response = await this.http.request<
      RawQueryResponse | { status: 202; body: RawQueryResponse }
    >('/api/v1/query', {
      method: 'POST',
      body,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    if (isAccepted202<RawQueryResponse>(response)) {
      const estimate = response.body.estimate;
      if (!estimate) {
        throw new SerchaError('Server returned 202 confirmation_required without an estimate');
      }
      // Re-throwing after the caller already confirmed would loop forever.
      if (options.confirm) {
        throw new SerchaError('Server still requires confirmation after confirm:true was sent');
      }
      throw new PluginConfirmationRequiredError(estimate);
    }

    const raw = response;
    const rows = (raw.rows ?? []) as T[];

    return {
      rows,
      stats: {
        row_count: raw.stats?.row_count ?? rows.length,
        ...(raw.stats?.op_stats ? { op_stats: raw.stats.op_stats } : {}),
      },
      columns: deriveColumns(raw.rows ?? []),
      ...(raw.context ? { context: raw.context } : {}),
    };
  }

  /**
   * Iterate every row of a statement, paging in-language.
   *
   * The API has no HTTP pagination, so this appends LIMIT/OFFSET to the
   * statement and issues one request per page. That keeps each request inside
   * the server's 30s deadline and 10 MiB body cap, which a single unbounded
   * SELECT over a large entity would otherwise breach.
   *
   * The statement MUST carry a deterministic ORDER BY. OFFSET over an
   * unordered result is not stable across requests: rows shift between pages,
   * so some are yielded twice and others never. This cannot be detected
   * client-side, so it is checked before the first request.
   *
   * The statement must not already contain LIMIT or OFFSET.
   */
  async *paginate<T = QueryRow>(
    serchaql: string,
    options: PaginateOptions = {},
  ): AsyncGenerator<T> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (pageSize < 1) {
      throw new SerchaError(`pageSize must be at least 1, got ${pageSize}`);
    }

    const statement = stripTrailingSemicolon(serchaql);
    assertPaginable(statement);

    let offset = 0;
    let yielded = 0;

    for (;;) {
      const remaining = options.maxRows !== undefined ? options.maxRows - yielded : Infinity;
      if (remaining <= 0) return;

      const limit = Math.min(pageSize, remaining);
      const page = await this.run<T>(`${statement} LIMIT ${limit} OFFSET ${offset}`, options);

      for (const row of page.rows) {
        yield row;
        yielded++;
      }

      // A short page means the result is exhausted. Requesting the next one
      // would cost a round trip to learn nothing.
      if (page.rows.length < limit) return;
      offset += page.rows.length;
    }
  }

  /** Collect every row of a statement into an array. See paginate for caveats. */
  async all<T = QueryRow>(serchaql: string, options: PaginateOptions = {}): Promise<T[]> {
    const rows: T[] = [];
    for await (const row of this.paginate<T>(serchaql, options)) {
      rows.push(row);
    }
    return rows;
  }

  /**
   * Run a statement expected to produce exactly one row.
   *
   * Throws when it produces none or several, rather than returning the first,
   * since a query written to return one row that returns three is a bug in the
   * query, and silently taking rows[0] hides it.
   */
  async one<T = QueryRow>(serchaql: string, options: QueryOptions = {}): Promise<T> {
    const result = await this.run<T>(serchaql, options);
    if (result.rows.length !== 1) {
      throw new SerchaError(`Expected exactly 1 row, got ${result.rows.length}`);
    }
    return result.rows[0] as T;
  }

  /**
   * The compiled plan for a statement, without executing it.
   *
   * The shape is Sercha's internal plan representation: useful for debugging,
   * not a stable contract.
   */
  async explain(serchaql: string, options: QueryOptions = {}): Promise<unknown> {
    return this.http.request<unknown>('/api/v1/query', {
      method: 'POST',
      body: { serchaql },
      query: { explain: 'true' },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
}

/**
 * Column names in first-seen order across rows.
 *
 * The union across all rows, not just the first: a column absent from row 0
 * but present later would otherwise be dropped.
 */
export function deriveColumns(rows: QueryRow[]): QueryColumn[] {
  const seen = new Set<string>();
  const columns: QueryColumn[] = [];
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!seen.has(name)) {
        seen.add(name);
        columns.push({ name });
      }
    }
  }
  return columns;
}

function stripTrailingSemicolon(statement: string): string {
  return statement.trim().replace(/;+$/, '').trimEnd();
}

/** Comment- and string-stripped copy, for keyword checks that must not match literals. */
function stripLiteralsAndComments(statement: string): string {
  return statement
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

function assertPaginable(statement: string): void {
  const bare = stripLiteralsAndComments(statement);

  if (/\bLIMIT\b/i.test(bare) || /\bOFFSET\b/i.test(bare)) {
    throw new SerchaError(
      'paginate() appends its own LIMIT/OFFSET, so the statement must not ' +
        'contain either. Use run() for a statement that pages itself.',
    );
  }

  if (!/\bORDER\s+BY\b/i.test(bare)) {
    throw new SerchaError(
      'paginate() requires an ORDER BY. Paging with OFFSET over an unordered ' +
        'result is not stable: rows move between pages, so some are returned ' +
        'twice and others skipped. Order by a unique column, typically _id.',
    );
  }
}
