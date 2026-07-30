/**
 * @sercha-ai/client/testing — an in-memory Sercha implementation.
 *
 * For developing against Sercha without a running instance, and for tests that
 * should not make network calls. Satisfies the same `Sercha` interface as
 * SerchaClient, so it substitutes at the composition root with no call-site
 * changes.
 *
 * @example
 * ```ts
 * const sercha = new StubSercha({
 *   queries: {
 *     'SELECT _id, status FROM claims.Claim': [
 *       { _id: '1', status: 'open' },
 *       { _id: '2', status: 'closed' },
 *     ],
 *   },
 * });
 * ```
 */

import type { Sercha } from '../client.js';
import { deriveColumns } from '../resources/query.js';
import { SerchaError, SerchaHttpError } from '../transport/errors.js';
import type { PaginateOptions, QueryOptions, QueryResult, QueryRow } from '../types/query.js';
import type {
  GenieConversation,
  GenieConversationDetail,
  GenieEvent,
  GenieTurnResult,
} from '../types/genie.js';
import type { ListRunsQuery, Run, WaitForRunOptions } from '../types/runs.js';
import type { SearchRequest, SearchResponse } from '../types/search.js';
import type { CatalogueEntityType, CatalogueProperty, CatalogueTree } from '../types/catalogue.js';
import type {
  AppendLedgerRecord,
  CreateLedgerRecordType,
  LedgerRecord,
  LedgerRecordType,
  ListLedgerRecordsQuery,
} from '../types/ledger.js';

/** Resolves a statement to rows. Receives the statement with LIMIT/OFFSET applied. */
export type QueryHandler = (serchaql: string) => QueryRow[] | Promise<QueryRow[]>;

export interface StubSerchaOptions {
  /**
   * Fixed responses keyed by exact statement text.
   *
   * Matched before `onQuery`. The key is the statement as written, before
   * paginate() appends LIMIT/OFFSET.
   */
  queries?: Record<string, QueryRow[]>;
  /** Fallback for statements not in `queries`. Defaults to throwing. */
  onQuery?: QueryHandler;
  runs?: Record<string, Run>;
  search?: SearchResponse;
  catalogue?: Partial<CatalogueTree>;
  /** Entity types, keyed by corpus id. */
  entityTypes?: Record<string, CatalogueEntityType[]>;
  /** Entity properties, keyed by "<corpusId>.<entityType>". */
  entityProperties?: Record<string, CatalogueProperty[]>;
  /** Genie turn responses keyed by message text. */
  genie?: Record<string, GenieTurnResult>;
  /** Artificial latency in ms, to surface races that a zero-latency stub hides. */
  latencyMs?: number;
}

/**
 * In-memory Sercha for development and tests.
 *
 * Unmatched statements throw rather than returning empty. An empty result and
 * an unconfigured fixture are different situations, and conflating them lets a
 * test pass against a stub that was never asked what the code actually queries.
 */
export class StubSercha implements Sercha {
  /** Every statement executed, in order. For asserting what the code queried. */
  readonly executed: string[] = [];

  /** Conversations created through this stub. */
  private readonly conversations: GenieConversation[] = [];

  private readonly options: StubSerchaOptions;

  constructor(options: StubSerchaOptions = {}) {
    this.options = options;
  }

  async query<T = QueryRow>(serchaql: string, _options?: QueryOptions): Promise<QueryResult<T>> {
    await this.delay();
    this.executed.push(serchaql);

    const rows = await this.resolve(serchaql);
    return {
      rows: rows as T[],
      stats: { row_count: rows.length },
      columns: deriveColumns(rows),
    };
  }

  async *paginate<T = QueryRow>(
    serchaql: string,
    options: PaginateOptions = {},
  ): AsyncGenerator<T> {
    // Resolve against the base statement, then page in memory, so fixtures are
    // keyed by the statement as written rather than by every LIMIT/OFFSET
    // variant the real client would generate.
    const rows = await this.resolve(serchaql);
    this.executed.push(serchaql);

    const limit = options.maxRows ?? rows.length;
    for (const row of rows.slice(0, limit)) {
      await this.delay();
      yield row as T;
    }
  }

  async all<T = QueryRow>(serchaql: string, options?: PaginateOptions): Promise<T[]> {
    const rows: T[] = [];
    for await (const row of this.paginate<T>(serchaql, options)) rows.push(row);
    return rows;
  }

  async one<T = QueryRow>(serchaql: string, options?: QueryOptions): Promise<T> {
    const result = await this.query<T>(serchaql, options);
    if (result.rows.length !== 1) {
      throw new SerchaError(`Expected exactly 1 row, got ${result.rows.length}`);
    }
    return result.rows[0] as T;
  }

  async search(request: SearchRequest, _signal?: AbortSignal): Promise<SearchResponse> {
    await this.delay();
    return (
      this.options.search ?? {
        query: request.query,
        mode: request.mode ?? 'hybrid',
        results: [],
        total_count: 0,
      }
    );
  }

  async ask(_conversationId: string, message: string): Promise<GenieTurnResult> {
    await this.delay();
    const configured = this.options.genie?.[message];
    if (configured) return configured;

    return {
      kind: 'answer',
      text: `[stub] no Genie fixture configured for: ${message}`,
      queries: [],
      events: [],
    };
  }

  async *stream(conversationId: string, message: string): AsyncGenerator<GenieEvent> {
    const result = await this.ask(conversationId, message);
    // Replay a plausible event sequence so consumers exercise their own
    // stream handling rather than only the accumulated shape.
    for (const query of result.queries) {
      yield { type: 'query', query };
      yield { type: 'result', query };
    }
    yield {
      type: result.kind,
      text: result.text,
      ...(result.kind === 'error' ? { message: result.text } : {}),
    };
    yield { type: 'done', ...(result.model ? { model: result.model } : {}) };
  }

  async createConversation(title?: string): Promise<GenieConversation> {
    await this.delay();
    const id = `stub-conversation-${this.conversations.length + 1}`;
    const conversation = { id, title: title ?? 'New chat', created_at: 0, updated_at: 0 };
    this.conversations.push(conversation);
    return conversation;
  }

  async listConversations(): Promise<GenieConversation[]> {
    await this.delay();
    return this.conversations;
  }

  async getConversation(conversationId: string): Promise<GenieConversationDetail> {
    await this.delay();
    const conversation = this.conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new SerchaHttpError(404, `conversation ${conversationId} not found`);
    return { conversation, turns: [] };
  }

  async getRun(runId: string): Promise<Run> {
    await this.delay();
    const run = this.options.runs?.[runId];
    if (!run) {
      throw new SerchaHttpError(404, `run ${runId} not found`);
    }
    return run;
  }

  async listRuns(query: ListRunsQuery = {}): Promise<Run[]> {
    await this.delay();
    let runs = Object.values(this.options.runs ?? {});
    if (query.pipeline_id) runs = runs.filter((r) => r.pipeline_id === query.pipeline_id);
    if (query.status) runs = runs.filter((r) => r.status === query.status);
    if (query.trigger_kind) runs = runs.filter((r) => r.trigger_kind === query.trigger_kind);
    return query.limit ? runs.slice(0, query.limit) : runs;
  }

  /** Returns the configured run as-is; does not poll, since nothing changes. */
  async waitForRun(runId: string, _options?: WaitForRunOptions): Promise<Run> {
    return this.getRun(runId);
  }

  async catalogueTree(_options?: { queryable?: boolean }): Promise<CatalogueTree> {
    await this.delay();
    return {
      ontologies: this.options.catalogue?.ontologies ?? [],
      corpuses: this.options.catalogue?.corpuses ?? [],
      pipelines: this.options.catalogue?.pipelines ?? [],
    };
  }

  async entityTypes(corpusId: string): Promise<CatalogueEntityType[]> {
    await this.delay();
    return this.options.entityTypes?.[corpusId] ?? [];
  }

  /**
   * Returns an empty list when unconfigured rather than throwing.
   *
   * Unlike a query fixture, an empty property list is a meaningful answer: it
   * says the schema is unknown. Callers validating against it should treat
   * "no properties" as "cannot verify" rather than "the field is absent".
   */
  async entityProperties(corpusId: string, entityType: string): Promise<CatalogueProperty[]> {
    await this.delay();
    return this.options.entityProperties?.[`${corpusId}.${entityType}`] ?? [];
  }

  /**
   * Ledger, backed by memory.
   *
   * A working append-only store rather than a set of no-ops, because the
   * behaviour worth testing IS the append-only behaviour: that a correction
   * writes a new record, that the original survives it, and that a record
   * cannot be superseded twice. A stub returning empty objects would let an
   * application pass its tests and then break on the first real correction.
   */
  private readonly recordTypes_: LedgerRecordType[] = [];
  private readonly records_: LedgerRecord[] = [];
  private seq = 0;

  async createRecordType(input: CreateLedgerRecordType): Promise<LedgerRecordType> {
    await this.delay();
    const existing = this.recordTypes_.find(
      (t) => t.ontology === input.ontology && t.name === input.name,
    );
    // Types are permanent and have no retire path, so redeclaring one is a
    // mistake worth surfacing rather than silently returning the original.
    if (existing) {
      throw new SerchaError(`Record type ${input.ontology}.${input.name} is already declared.`);
    }
    const created: LedgerRecordType = {
      id: `rt_${++this.seq}`,
      created_at: new Date(0).toISOString(),
      ...input,
    };
    this.recordTypes_.push(created);
    return created;
  }

  async recordTypes(ontology: string): Promise<LedgerRecordType[]> {
    await this.delay();
    return this.recordTypes_.filter((t) => t.ontology === ontology);
  }

  async appendRecord(record: AppendLedgerRecord): Promise<LedgerRecord> {
    await this.delay();
    return this.write(record, null);
  }

  async supersedeRecord(id: string, record: AppendLedgerRecord): Promise<LedgerRecord> {
    await this.delay();
    if (!this.records_.some((r) => r.id === id)) {
      throw new SerchaError(`No record ${id} to supersede.`);
    }
    // At most once, so chains stay linear and "the current version" is
    // unambiguous.
    if (this.records_.some((r) => r.supersedes_id === id)) {
      throw new SerchaError(
        `Record ${id} has already been superseded. Correct the current version instead.`,
      );
    }
    return this.write(record, id);
  }

  async getRecord(id: string): Promise<LedgerRecord> {
    await this.delay();
    const found = this.records_.find((r) => r.id === id);
    if (!found) throw new SerchaError(`No record ${id}.`);
    return found;
  }

  async listRecords(query: ListLedgerRecordsQuery = {}): Promise<LedgerRecord[]> {
    await this.delay();
    return this.records_.filter(
      (r) =>
        (query.subject_key === undefined || r.subject_key === query.subject_key) &&
        (query.corpus_id === undefined || r.subject_corpus_id === query.corpus_id) &&
        (query.record_type_id === undefined || r.record_type_id === query.record_type_id) &&
        (query.kind === undefined || r.kind === query.kind),
    );
  }

  async subjectHistory(subjectKey: string): Promise<LedgerRecord[]> {
    await this.delay();
    return this.records_.filter((r) => r.subject_key === subjectKey);
  }

  private write(record: AppendLedgerRecord, supersedesId: string | null): LedgerRecord {
    if (!record.subject_key) {
      throw new SerchaError('append needs a subject_key.');
    }
    if (!record.subject_corpus_id) {
      throw new SerchaError('append needs a subject_corpus_id.');
    }
    const type = this.recordTypes_.find((t) => t.id === record.record_type_id);
    // The real ledger requires a declared type, so the stub does too: an
    // application that works against the stub without one would fail on first
    // contact with a real instance.
    if (!type) {
      throw new SerchaError(
        `No record type ${record.record_type_id}. Declare it with createRecordType first.`,
      );
    }
    const written: LedgerRecord = {
      id: `rec_${++this.seq}`,
      subject_key: record.subject_key,
      subject_corpus_id: record.subject_corpus_id,
      ...(record.subject_entity ? { subject_entity: record.subject_entity } : {}),
      record_type_id: record.record_type_id,
      kind: type.kind,
      values: record.values ?? {},
      authority: record.authority ?? 'asserted',
      confidence: record.confidence ?? null,
      evidence: record.evidence ?? [],
      author_kind: 'human',
      author_id: 'stub-user',
      supersedes_id: supersedesId,
      created_at: new Date(0).toISOString(),
    };
    this.records_.push(written);
    return written;
  }

  private async resolve(serchaql: string): Promise<QueryRow[]> {
    const exact = this.options.queries?.[serchaql];
    if (exact) return exact;

    if (this.options.onQuery) {
      return this.options.onQuery(serchaql);
    }

    throw new SerchaError(
      `StubSercha has no fixture for this statement. Add it to \`queries\`, ` +
        `or supply \`onQuery\` for a catch-all.\n\n  ${serchaql}`,
    );
  }

  private delay(): Promise<void> {
    const ms = this.options.latencyMs ?? 0;
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }
}
