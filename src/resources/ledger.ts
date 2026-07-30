import type { HttpTransport } from '../transport/http.js';
import { SerchaError } from '../transport/errors.js';
import type {
  AppendLedgerRecord,
  CreateLedgerRecordType,
  LedgerRecord,
  LedgerRecordType,
  ListLedgerRecordsQuery,
} from '../types/ledger.js';

/**
 * Ledger: append-only records about facts.
 *
 * Two rules shape this whole surface, and both are enforced server-side rather
 * than here:
 *
 * There is no update and no delete. A correction is `supersede`, which writes a
 * new record pointing at the one it replaces, and a record may be superseded at
 * most once so chains stay linear. An annotation that could be quietly rewritten
 * afterwards is worth nothing as evidence.
 *
 * Authorship comes from the authenticated caller, never the request body, so a
 * client cannot write a record attributed to someone else.
 */
export class LedgerResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Declare a record type.
   *
   * Types are declared per ontology and are permanent: there is no retire path,
   * and a type is visible to every corpus bound to that ontology. Treat this as
   * a setup action rather than something an application does at runtime.
   */
  async createRecordType(
    input: CreateLedgerRecordType,
    signal?: AbortSignal,
  ): Promise<LedgerRecordType> {
    return this.http.request<LedgerRecordType>('/api/v1/ledger/record-types', {
      method: 'POST',
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /** Record types declared for an ontology. */
  async recordTypes(ontology: string, signal?: AbortSignal): Promise<LedgerRecordType[]> {
    const response = await this.http.request<{ record_types: LedgerRecordType[] | null } | null>(
      '/api/v1/ledger/record-types',
      { query: { ontology }, ...(signal ? { signal } : {}) },
    );
    return response?.record_types ?? [];
  }

  /**
   * Append a record.
   *
   * `subject_key` must come from the `subject_key` system column of a
   * subject-keyed entity, not from a key the caller computed itself. A
   * self-computed key will store successfully and match nothing, which is the
   * silent mis-attachment this design exists to prevent.
   *
   * Note that derived (view) entities do not expose `subject_key`: a view row
   * aggregates many documents, so it has no single document-anchored identity.
   * Select the key from the underlying entity and join the view for values.
   */
  async append(record: AppendLedgerRecord, signal?: AbortSignal): Promise<LedgerRecord> {
    if (!record.subject_key) {
      throw new SerchaError(
        'append() needs a subject_key. Obtain one by selecting the subject_key ' +
          'system column from a subject-keyed entity, for example ' +
          '`SELECT subject_key FROM corpus.EntityType`. It is not available on ' +
          'views, which have no single source document to anchor to.',
      );
    }
    if (!record.subject_corpus_id) {
      throw new SerchaError(
        'append() needs a subject_corpus_id. Subjects are corpus-scoped, so a ' +
          'key alone does not identify one. catalogueTree({ queryable: true }) ' +
          'returns the corpus ids this token may reach.',
      );
    }
    return this.http.request<LedgerRecord>('/api/v1/ledger/records', {
      method: 'POST',
      body: record,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Correct a record by writing its replacement.
   *
   * The original is never modified. Superseding a record that has already been
   * superseded is refused rather than forking the chain, so "the current
   * version" stays unambiguous.
   */
  async supersede(
    id: string,
    record: AppendLedgerRecord,
    signal?: AbortSignal,
  ): Promise<LedgerRecord> {
    return this.http.request<LedgerRecord>(
      `/api/v1/ledger/records/${encodeURIComponent(id)}/supersede`,
      { method: 'POST', body: record, ...(signal ? { signal } : {}) },
    );
  }

  async get(id: string, signal?: AbortSignal): Promise<LedgerRecord> {
    return this.http.request<LedgerRecord>(
      `/api/v1/ledger/records/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
  }

  /** Records matching a filter. */
  async records(query: ListLedgerRecordsQuery = {}, signal?: AbortSignal): Promise<LedgerRecord[]> {
    const response = await this.http.request<{ records: LedgerRecord[] | null } | null>(
      '/api/v1/ledger/records',
      { query: { ...query }, ...(signal ? { signal } : {}) },
    );
    return response?.records ?? [];
  }

  /**
   * Every record about one subject, oldest first.
   *
   * The correction history: what was claimed, then what replaced it. Reading it
   * in order is how a reader sees the reasoning rather than only its conclusion.
   */
  async subjectHistory(subjectKey: string, signal?: AbortSignal): Promise<LedgerRecord[]> {
    const response = await this.http.request<{ records: LedgerRecord[] | null } | null>(
      `/api/v1/ledger/subjects/${encodeURIComponent(subjectKey)}`,
      signal ? { signal } : {},
    );
    return response?.records ?? [];
  }
}
