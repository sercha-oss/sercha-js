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
