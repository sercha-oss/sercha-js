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
  GenieMessage,
  GenieTurnResult,
} from '../types/genie.js';
import type { ListRunsQuery, Run, WaitForRunOptions } from '../types/runs.js';
import type { Document, SearchRequest, SearchResponse } from '../types/search.js';
import type { CatalogueEntityType, CatalogueProperty, CatalogueTree } from '../types/catalogue.js';
import type {
  AppendLedgerRecord,
  CreateLedgerRecordType,
  LedgerRecord,
  LedgerRecordType,
  ListLedgerRecordsQuery,
} from '../types/ledger.js';
import type {
  AssignDocumentRequest,
  AssignDocumentResponse,
  ConfirmFlagRequest,
  ConfirmFlagResponse,
  CorpusStructure,
  RerunStructureRequest,
  RerunStructureResponse,
  StructureArchived,
  StructureAssignmentEvent,
  StructurePack,
  StructureState,
  StructureTray,
  StructureTrayEntry,
  StructureTrayFlag,
  StructureTrayGroup,
} from '../types/structures.js';
import { UNASSIGNED_PARTITION_KEY } from '../types/corpuses.js';
import type { CorpusDocument, CorpusDocumentsPage, CorpusPartitions } from '../types/corpuses.js';
import { SerchaTimeoutError } from '../transport/errors.js';
import type {
  IngestStatus,
  PushDocumentsRequest,
  PushDocumentsResponse,
  SourceSyncState,
  SyncAccepted,
  WaitForIngestOptions,
} from '../types/sync.js';
import { isTerminalIngestStatus } from '../types/sync.js';

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
  /** Documents by id, for resolving the source behind a query row. */
  documents?: Record<string, Document>;
  catalogue?: Partial<CatalogueTree>;
  /** Entity types, keyed by corpus id. */
  entityTypes?: Record<string, CatalogueEntityType[]>;
  /** Entity properties, keyed by "<corpusId>.<entityType>". */
  entityProperties?: Record<string, CatalogueProperty[]>;
  /** Genie turn responses keyed by message text. */
  genie?: Record<string, GenieTurnResult>;
  /**
   * Corpus structures keyed by corpus id, for the Pack Builder surface.
   *
   * A corpus absent here answers 409, exactly as a real corpus that does not
   * organise by structure would — so the graceful-degrade path an application
   * needs is exercisable against the stub.
   */
  structures?: Record<string, StubStructureFixture>;
  /**
   * Sync states returned by syncState()/syncStates().
   *
   * When omitted the stub supplies defaults that include one state with a
   * non-null `warning`, so the ops path that renders warnings is exercised by
   * default rather than only when someone remembers to configure it.
   */
  syncStates?: SourceSyncState[];
  /**
   * Polls before a pushed document flips from 'processing' to 'indexed'.
   * Default 2, so waitForIngest observes 'processing' at least once and then
   * completes — a deterministic tick, no time mocks. Zero or negative disables
   * automatic promotion; promote explicitly with stubIndexDocuments(), or do
   * not, to drive the timeout path.
   */
  indexAfterPolls?: number;
  /** Artificial latency in ms, to surface races that a zero-latency stub hides. */
  latencyMs?: number;
}

/** Fixture for one corpus's structure. */
export interface StubStructureFixture {
  packs: StructurePack[];
  /** Documents waiting for a human. Consumed as assignDocument places them. */
  tray?: StructureTrayEntry[];
  structure_ref?: string;
  /** Defaults to needs_review while the tray has entries, fresh after. */
  structure_state?: StructureState;
}

/** The stub's view of one corpus's structure, for assertions. */
export interface StubStructureState {
  assignments: Record<string, { container_id: string; locked: boolean }>;
  events: StructureAssignmentEvent[];
  tray: StructureTrayEntry[];
  /** Settled retirements, populated by confirmFlag. */
  archived: StructureTrayEntry[];
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

  /**
   * Resolve a document id against the configured fixtures.
   *
   * Throws for an unknown id rather than returning a placeholder. A caller
   * asking where a figure came from is checking provenance, and inventing a
   * document would answer the question wrongly instead of admitting the
   * fixture is missing.
   */
  async getDocument(documentId: string, _signal?: AbortSignal): Promise<Document> {
    await this.delay();
    const pushed = this.pushedDocuments.get(documentId);
    if (pushed) {
      // Each read is one ingest tick: after indexAfterPolls of them the
      // document promotes, which is what makes waitForIngest terminate
      // deterministically with no time mocks.
      pushed.polls += 1;
      const threshold = this.options.indexAfterPolls ?? 2;
      if (
        threshold > 0 &&
        pushed.polls >= threshold &&
        pushed.document.ingest_status === 'processing'
      ) {
        pushed.document = { ...pushed.document, ingest_status: 'indexed' };
      }
      return pushed.document;
    }
    const found = this.options.documents?.[documentId];
    if (!found) {
      throw new Error(
        `StubSercha: no document fixture for ${documentId}. ` +
          'Add one to the `documents` option.',
      );
    }
    return found;
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

  /**
   * Stateless ask. Fixtures are keyed on the message, so the last user turn is
   * what selects one: the earlier transcript is context the stub does not model.
   */
  async askMessages(messages: GenieMessage[]): Promise<GenieTurnResult> {
    return this.ask('', lastUserMessage(messages));
  }

  async *streamMessages(messages: GenieMessage[]): AsyncGenerator<GenieEvent> {
    yield* this.stream('', lastUserMessage(messages));
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

  /**
   * Pack Builder, backed by memory.
   *
   * Working lock semantics rather than no-ops, because the behaviour worth
   * testing IS the locking: a human placement survives an agent rerun, a tray
   * entry disappears once resolved, and a second human can re-repair without
   * unlocking. A stub returning canned objects would let a review UI pass its
   * tests and then lose a human's work on the first real rerun.
   *
   * There is no agent in the stub, so every assignDocument is the human path
   * and locks. rerunStructure is the agent path, and it leaves locked
   * assignments untouched — which, with no agent, means it changes nothing.
   */
  private readonly structureStates = new Map<string, StubStructureState>();
  private structureSeq = 0;

  async structure(corpusId: string): Promise<CorpusStructure> {
    await this.delay();
    const fixture = this.structureFixture(corpusId);
    const state = this.structureState(corpusId);
    return {
      corpus_id: corpusId,
      structure_ref: fixture.structure_ref ?? `stub-structure-${corpusId}`,
      structure_state:
        fixture.structure_state ?? (state.tray.length > 0 ? 'needs_review' : 'fresh'),
      tray_count: state.tray.length,
      packs: fixture.packs,
    };
  }

  async structureTray(
    corpusId: string,
    opts?: { groupBy?: 'candidate'; flag?: StructureTrayFlag },
  ): Promise<StructureTray> {
    await this.delay();
    this.structureFixture(corpusId);
    let entries = [...this.structureState(corpusId).tray];
    if (opts?.flag) entries = entries.filter((entry) => entry.flag === opts.flag);
    if (opts?.groupBy !== 'candidate') return { entries };

    const groups = new Map<string, StructureTrayGroup>();
    for (const entry of entries) {
      const payload = entry.flag_payload as { candidate?: unknown } | null | undefined;
      // The server's ungrouped bucket is '' (sorted last), not a made-up
      // word — the stub must not disagree with the wire.
      const candidate = typeof payload?.candidate === 'string' ? payload.candidate : '';
      const group = groups.get(candidate) ?? { candidate, entries: [] };
      group.entries.push(entry);
      groups.set(candidate, group);
    }
    // The server sorts groups by candidate with the '' bucket LAST, so the
    // actionable clusters lead; mirror that.
    const sorted = [...groups.values()].sort((a, b) =>
      a.candidate === '' ? 1 : b.candidate === '' ? -1 : a.candidate.localeCompare(b.candidate),
    );
    return { entries, groups: sorted };
  }

  async assignDocument(
    corpusId: string,
    req: AssignDocumentRequest,
  ): Promise<AssignDocumentResponse> {
    await this.delay();
    const fixture = this.structureFixture(corpusId);
    const state = this.structureState(corpusId);

    const pack =
      'container_id' in req
        ? findPack(fixture.packs, req.container_id)
        : findPackByLevels(fixture.packs, req.level_values);
    if (!pack) {
      const target = 'container_id' in req ? req.container_id : req.level_values.join('/');
      throw new SerchaHttpError(404, `StubSercha: no pack ${target} in corpus ${corpusId}.`);
    }

    // Locked assignments are still re-assignable here: locks stop the agent,
    // not a human, and every stub caller is the human path. The assignment
    // stays locked afterwards so a rerun cannot undo the repair either way.
    state.assignments[req.document_id] = { container_id: pack.id, locked: true };

    const event: StructureAssignmentEvent = {
      id: `stub-assignment-${++this.structureSeq}`,
      document_id: req.document_id,
      container_id: pack.id,
      actor: 'human',
      rationale: req.rationale ?? null,
      created_at: new Date(0).toISOString(),
    };
    state.events.push(event);

    // The tray entry is consumed: it existed because the document had no
    // confident home, and now it has one.
    state.tray = state.tray.filter((entry) => entry.document_id !== req.document_id);
    // And so is any settled retirement: a re-filed document is no longer
    // archived, exactly as the server's standing-opinion projection behaves.
    state.archived = state.archived.filter((entry) => entry.document_id !== req.document_id);

    return { event, container_id: pack.id, locked: true, partition_key: pack.slug };
  }

  /** Returns a fake queued run and touches nothing: locked assignments survive. */
  async rerunStructure(
    corpusId: string,
    req: RerunStructureRequest = {},
  ): Promise<RerunStructureResponse> {
    await this.delay();
    this.structureFixture(corpusId);
    return {
      run_id: `stub-structure-run-${++this.structureSeq}`,
      status: 'queued',
      pipeline_id: 'stub-structure-pipeline',
      trigger_kind: 'manual',
      ...(req.document_ids ? { document_ids: req.document_ids } : {}),
    };
  }

  /** The stub's assignment/tray state for a corpus, for assertions. */
  stubStructureState(corpusId: string): StubStructureState {
    this.structureFixture(corpusId);
    return this.structureState(corpusId);
  }

  private structureFixture(corpusId: string): StubStructureFixture {
    const fixture = this.options.structures?.[corpusId];
    if (!fixture) {
      // The same answer a real non-structure corpus gives, so an application's
      // degrade-on-409 path is what a missing fixture exercises.
      throw new SerchaHttpError(409, `Corpus ${corpusId} does not organise by structure.`, {
        code: 'corpus_not_structured',
      });
    }
    return fixture;
  }

  /**
   * Confirms like the server: locks, leaves the working structure, moves the
   * entry from the tray to the archive. Target validation mirrors the wire
   * (400 when a retirement names no survivor).
   */
  async confirmFlag(corpusId: string, req: ConfirmFlagRequest): Promise<ConfirmFlagResponse> {
    await this.delay();
    this.structureFixture(corpusId);
    const state = this.structureState(corpusId);

    const needsTarget = req.flag === 'duplicate_of' || req.flag === 'superseded_by';
    if (needsTarget && !('target_document_id' in req && req.target_document_id)) {
      throw new SerchaHttpError(400, `StubSercha: target_document_id is required for ${req.flag}.`);
    }

    const payload = needsTarget
      ? {
          [req.flag === 'duplicate_of' ? 'primary_document_id' : 'current_document_id']: (
            req as { target_document_id: string }
          ).target_document_id,
        }
      : null;
    const event: StructureAssignmentEvent = {
      id: `stub-assignment-${++this.structureSeq}`,
      document_id: req.document_id,
      actor: 'human',
      rationale: req.rationale ?? null,
      flag: req.flag,
      flag_payload: payload,
      created_at: new Date(0).toISOString(),
    };
    state.events.push(event);
    delete state.assignments[req.document_id];

    const trayEntry = state.tray.find((entry) => entry.document_id === req.document_id);
    state.tray = state.tray.filter((entry) => entry.document_id !== req.document_id);
    state.archived = state.archived.filter((entry) => entry.document_id !== req.document_id);
    state.archived.push({
      document_id: req.document_id,
      document_title: trayEntry?.document_title ?? req.document_id,
      document_path: trayEntry?.document_path ?? '',
      event_id: event.id,
      actor: 'human',
      flag: req.flag,
      flag_payload: payload,
      rationale: req.rationale ?? '',
      confidence: null,
      created_at: event.created_at,
    });

    return { event, locked: true, partition_key: UNASSIGNED_PARTITION_KEY };
  }

  /** The settled complement of the tray, per the server's contract. */
  async structureArchived(corpusId: string): Promise<StructureArchived> {
    await this.delay();
    this.structureFixture(corpusId);
    const entries = [...this.structureState(corpusId).archived];
    return { corpus_id: corpusId, count: entries.length, entries };
  }

  /**
   * Serves the corpus fixtures' rows as documents. Minimal on purpose: the
   * stub has no document store, so each fixture row's _doc becomes a
   * document id and the partition key comes from the standing assignment
   * (pack slug), the archive (the unassigned sentinel), or ''.
   */
  async corpusDocuments(
    corpusId: string,
    opts?: { limit?: number; offset?: number; partitionKey?: string },
  ): Promise<CorpusDocumentsPage> {
    await this.delay();
    const all = this.stubCorpusDocuments(corpusId);
    const filtered =
      opts?.partitionKey !== undefined
        ? all.filter((doc) => doc.partition_key === opts.partitionKey)
        : all;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 20;
    return {
      documents: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }

  async corpusPartitions(corpusId: string): Promise<CorpusPartitions> {
    await this.delay();
    const counts = new Map<string, number>();
    for (const doc of this.stubCorpusDocuments(corpusId)) {
      counts.set(doc.partition_key, (counts.get(doc.partition_key) ?? 0) + 1);
    }
    const partitions = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, doc_count]) => ({ key, doc_count }));
    const fixture = this.options.structures?.[corpusId];
    const state = fixture ? this.structureState(corpusId) : undefined;
    return {
      corpus_id: corpusId,
      ...(state
        ? {
            structure_state: state.tray.length > 0 ? 'needs_review' : 'fresh',
            tray_count: state.tray.length,
          }
        : {}),
      partitions,
    };
  }

  private stubCorpusDocuments(corpusId: string): CorpusDocument[] {
    const fixture = this.options.structures?.[corpusId];
    const state = fixture ? this.structureState(corpusId) : undefined;
    const packSlug = (containerId: string): string =>
      (fixture && findPack(fixture.packs, containerId)?.slug) ?? '';
    const docs: CorpusDocument[] = [];
    const seen = new Set<string>();
    const push = (id: string, title: string, path: string, key: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      docs.push({
        id,
        source_id: 'stub-source',
        title,
        path,
        mime_type: 'application/octet-stream',
        indexed_at: new Date(0).toISOString(),
        partition_key: key,
      });
    };
    if (state) {
      for (const [docId, assignment] of Object.entries(state.assignments)) {
        push(docId, docId, '', packSlug(assignment.container_id));
      }
      for (const entry of state.tray) {
        push(
          entry.document_id,
          entry.document_title,
          entry.document_path,
          UNASSIGNED_PARTITION_KEY,
        );
      }
      for (const entry of state.archived) {
        push(
          entry.document_id,
          entry.document_title,
          entry.document_path,
          UNASSIGNED_PARTITION_KEY,
        );
      }
    }
    return docs;
  }

  private structureState(corpusId: string): StubStructureState {
    let state = this.structureStates.get(corpusId);
    if (!state) {
      state = {
        assignments: {},
        events: [],
        tray: [...(this.options.structures?.[corpusId]?.tray ?? [])],
        archived: [],
      };
      this.structureStates.set(corpusId, state);
    }
    return state;
  }

  /**
   * Sync and push, backed by memory.
   *
   * Pushed documents genuinely pass through 'processing' before 'indexed',
   * because acceptance-is-not-indexing is the behaviour worth testing: an
   * application that searches immediately after pushDocuments() resolves
   * should see that miss against the stub too, not first in production.
   * Promotion is a deterministic poll count (see indexAfterPolls), so
   * waitForIngest is testable without time mocks.
   */
  private readonly pushedDocuments = new Map<string, { document: Document; polls: number }>();
  private syncSeq = 0;

  async triggerSync(sourceId: string): Promise<SyncAccepted> {
    await this.delay();
    return { status: 'accepted', source_id: sourceId, task_id: `stub-sync-task-${++this.syncSeq}` };
  }

  async syncState(sourceId: string): Promise<SourceSyncState> {
    await this.delay();
    const configured = this.stubSyncStates().find((s) => s.source_id === sourceId);
    return configured ?? { source_id: sourceId, status: 'idle', last_sync_at: null, warning: null };
  }

  async syncStates(): Promise<SourceSyncState[]> {
    await this.delay();
    return this.stubSyncStates();
  }

  async pushDocuments(sourceId: string, req: PushDocumentsRequest): Promise<PushDocumentsResponse> {
    await this.delay();
    const results = req.documents.map((doc) => {
      const id = `stub-doc-${++this.syncSeq}`;
      this.pushedDocuments.set(id, {
        polls: 0,
        document: {
          id,
          source_id: sourceId,
          title: doc.title,
          path: doc.path,
          mime_type: doc.mime_type,
          indexed_at: new Date(0).toISOString(),
          ingest_status: 'processing',
        },
      });
      return {
        document_id: id,
        external_id: doc.external_id,
        ingest_status: 'processing' as IngestStatus,
      };
    });
    return { results };
  }

  /**
   * Poll counting stands in for time: the budget is a fixed number of polls
   * rather than a wall clock, so the timeout path is reachable in a test
   * without faking timers — configure indexAfterPolls <= 0 and the pending
   * ids are named in the error, exactly as the real client names them.
   */
  async waitForIngest(documentIds: string[], opts: WaitForIngestOptions = {}): Promise<Document[]> {
    const maxPolls = 25;
    const settled = new Map<string, Document>();
    let pending = [...documentIds];

    for (let poll = 0; poll < maxPolls; poll++) {
      const still: string[] = [];
      for (const id of pending) {
        const document = await this.getDocument(id);
        if (!document.ingest_status || isTerminalIngestStatus(document.ingest_status)) {
          settled.set(id, document);
        } else {
          still.push(id);
        }
      }
      pending = still;
      if (pending.length === 0) {
        return documentIds.map((id) => settled.get(id)!);
      }
    }

    const timeoutMs = opts.timeoutMs ?? 0;
    throw new SerchaTimeoutError(
      timeoutMs,
      `Ingest did not complete within ${timeoutMs}ms; still pending: ` +
        `${pending.join(', ')}. Ingest continues server-side, so these ids ` +
        'remain valid for a later check.',
    );
  }

  /**
   * Promote pushed documents to a terminal state immediately.
   *
   * The explicit tick, for tests that want to control exactly when ingest
   * completes — or to drive the failed path, which automatic promotion never
   * produces.
   */
  stubIndexDocuments(documentIds?: string[], status: IngestStatus = 'indexed'): void {
    for (const [id, pushed] of this.pushedDocuments) {
      if (documentIds && !documentIds.includes(id)) continue;
      if (pushed.document.ingest_status === 'processing') {
        pushed.document = { ...pushed.document, ingest_status: status };
      }
    }
  }

  private stubSyncStates(): SourceSyncState[] {
    return (
      this.options.syncStates ?? [
        {
          source_id: 'stub-source-1',
          status: 'completed',
          last_sync_at: new Date(0).toISOString(),
          warning: null,
          document_count: 12,
        },
        {
          source_id: 'stub-source-2',
          status: 'completed',
          last_sync_at: new Date(0).toISOString(),
          // A default state carries a warning so an ops page renders the
          // warning path without anyone remembering to configure it.
          warning:
            'sync enumerated zero documents over a source with zero local ' +
            'documents; this is almost always a misconfigured root or a stale cursor',
          document_count: 0,
        },
      ]
    );
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

/**
 * The message a stateless fixture lookup should key on.
 *
 * The last user turn, because that is the question being asked; the rest of the
 * transcript is context. Falls back to the final message so a malformed
 * transcript still produces a deterministic lookup rather than throwing.
 */
function findPack(packs: StructurePack[], id: string): StructurePack | undefined {
  for (const pack of packs) {
    if (pack.id === id) return pack;
    const inChildren = findPack(pack.children, id);
    if (inChildren) return inChildren;
  }
  return undefined;
}

/** Walk one level per value, matching slug or display name at each. */
function findPackByLevels(packs: StructurePack[], levels: string[]): StructurePack | undefined {
  let current: StructurePack | undefined;
  let candidates = packs;
  for (const value of levels) {
    current = candidates.find((p) => p.slug === value || p.display_name === value);
    if (!current) return undefined;
    candidates = current.children;
  }
  return current;
}

function lastUserMessage(messages: GenieMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i]!.content;
  }
  return messages[messages.length - 1]?.content ?? '';
}
