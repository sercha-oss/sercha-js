import { resolveConfig, type SerchaClientConfig } from './config.js';
import { TokenManager } from './auth/token.js';
import { HttpTransport } from './transport/http.js';
import { QueryResource } from './resources/query.js';
import { RunsResource } from './resources/runs.js';
import { GenieResource } from './resources/genie.js';
import { CatalogueResource } from './resources/catalogue.js';
import { LedgerResource } from './resources/ledger.js';
import { SearchResource } from './resources/search.js';
import { StructuresResource } from './resources/structures.js';
import { SyncResource } from './resources/sync.js';
import type { PaginateOptions, QueryOptions, QueryResult, QueryRow } from './types/query.js';
import type {
  GenieConversation,
  GenieConversationDetail,
  GenieEvent,
  GenieTurnResult,
  GenieMessage,
} from './types/genie.js';
import type { ListRunsQuery, Run, WaitForRunOptions } from './types/runs.js';
import type { Document, SearchRequest, SearchResponse } from './types/search.js';
import type { CatalogueEntityType, CatalogueProperty, CatalogueTree } from './types/catalogue.js';
import type {
  AppendLedgerRecord,
  CreateLedgerRecordType,
  LedgerRecord,
  LedgerRecordType,
  ListLedgerRecordsQuery,
} from './types/ledger.js';
import type {
  AssignDocumentRequest,
  AssignDocumentResponse,
  CorpusStructure,
  RerunStructureRequest,
  RerunStructureResponse,
  StructureTray,
} from './types/structures.js';
import type {
  PushDocumentsRequest,
  PushDocumentsResponse,
  SourceSyncState,
  SyncAccepted,
  WaitForIngestOptions,
} from './types/sync.js';

/**
 * The client's capability surface.
 *
 * Consumers should type against this rather than the concrete class, so a stub
 * can be substituted without touching call sites. See the `/testing` entry
 * point for one.
 */
export interface Sercha {
  query<T = QueryRow>(serchaql: string, options?: QueryOptions): Promise<QueryResult<T>>;
  paginate<T = QueryRow>(serchaql: string, options?: PaginateOptions): AsyncGenerator<T>;
  all<T = QueryRow>(serchaql: string, options?: PaginateOptions): Promise<T[]>;
  one<T = QueryRow>(serchaql: string, options?: QueryOptions): Promise<T>;

  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  /**
   * Resolve a document id to its metadata.
   *
   * On the interface for the same reason as the conversation methods: every
   * query row carries the id of the document its facts were extracted from, so
   * an application that shows a figure and wants to name its source has the id
   * already and nothing to do with it. Leaving this off the interface meant
   * anyone following the advice to type against `Sercha` could read the id but
   * never resolve it.
   */
  getDocument(documentId: string, signal?: AbortSignal): Promise<Document>;

  ask(conversationId: string, message: string): Promise<GenieTurnResult>;
  stream(conversationId: string, message: string): AsyncGenerator<GenieEvent>;
  /**
   * Stateless Genie: the caller owns the transcript and Sercha persists
   * nothing.
   *
   * On the interface, not just the concrete client, because this is the mode an
   * application should use. Sercha's conversation storage enforces ownership by
   * the calling identity, and an application authenticates with one service
   * account for all of its users, so that check cannot tell them apart. Owning
   * the transcript avoids the problem rather than working around it.
   */
  askMessages(messages: GenieMessage[]): Promise<GenieTurnResult>;
  streamMessages(messages: GenieMessage[]): AsyncGenerator<GenieEvent>;
  /**
   * Conversation management.
   *
   * On the interface rather than only the concrete client because an
   * application that streams turns necessarily has to create the conversation
   * first, and listing them is how a chat history is built. Leaving these off
   * meant anyone following the advice to type against `Sercha` could stream
   * into a conversation but never open one.
   */
  createConversation(title?: string): Promise<GenieConversation>;
  listConversations(): Promise<GenieConversation[]>;
  getConversation(conversationId: string): Promise<GenieConversationDetail>;

  getRun(runId: string): Promise<Run>;
  listRuns(query?: ListRunsQuery): Promise<Run[]>;
  waitForRun(runId: string, options?: WaitForRunOptions): Promise<Run>;

  catalogueTree(options?: { queryable?: boolean }): Promise<CatalogueTree>;
  entityTypes(corpusId: string): Promise<CatalogueEntityType[]>;
  /**
   * Properties of an entity type.
   *
   * The only schema this API exposes. Part of the interface rather than only
   * the concrete client because validating a query's assumptions against the
   * real schema is something an application does at startup, and it should be
   * able to do that against a stub too.
   */
  entityProperties(corpusId: string, entityType: string): Promise<CatalogueProperty[]>;

  /**
   * Ledger: append-only records about facts.
   *
   * On the interface rather than only the concrete client because annotating a
   * fact is an ordinary thing for an application to do, and it should be
   * testable against a stub without reaching a real instance. Reading records
   * is also possible through `query()` via `ledger.*` relations; these methods
   * are the write path and the typed read.
   */
  createRecordType(input: CreateLedgerRecordType): Promise<LedgerRecordType>;
  recordTypes(ontology: string): Promise<LedgerRecordType[]>;
  appendRecord(record: AppendLedgerRecord): Promise<LedgerRecord>;
  supersedeRecord(id: string, record: AppendLedgerRecord): Promise<LedgerRecord>;
  getRecord(id: string): Promise<LedgerRecord>;
  listRecords(query?: ListLedgerRecordsQuery): Promise<LedgerRecord[]>;
  subjectHistory(subjectKey: string): Promise<LedgerRecord[]>;

  /**
   * Pack Builder: the structure of a corpus organised into packs.
   *
   * On the interface, not only the concrete client, because pack review is an
   * application surface: a review UI reads the tree and the tray, records the
   * human's placements, and asks the agent to regroup — it cannot exist
   * without these, and it should be buildable against a stub. All four are
   * admin-gated (403 for a default service account, degrade gracefully), and a
   * corpus that does not organise by structure answers 409.
   */
  structure(corpusId: string): Promise<CorpusStructure>;
  structureTray(corpusId: string, opts?: { groupBy?: 'candidate' }): Promise<StructureTray>;
  assignDocument(corpusId: string, req: AssignDocumentRequest): Promise<AssignDocumentResponse>;
  rerunStructure(corpusId: string, req?: RerunStructureRequest): Promise<RerunStructureResponse>;

  /**
   * Source sync and document push.
   *
   * On the interface because these are application surfaces, not admin
   * plumbing: an ingest UI is push-then-poll (pushDocuments + waitForIngest —
   * acceptance is not indexing, so without the poll the first search after a
   * push silently misses the document), and an ops page exists to surface the
   * sync `warning` field, which flags a sync that "succeeded" while almost
   * certainly misconfigured. Both should be buildable against a stub.
   * triggerSync and pushDocuments are admin/write-gated (403 for a default
   * service account, degrade gracefully); reading state is not.
   */
  triggerSync(sourceId: string): Promise<SyncAccepted>;
  syncState(sourceId: string): Promise<SourceSyncState>;
  syncStates(): Promise<SourceSyncState[]>;
  pushDocuments(sourceId: string, req: PushDocumentsRequest): Promise<PushDocumentsResponse>;
  waitForIngest(documentIds: string[], opts?: WaitForIngestOptions): Promise<Document[]>;
}

/**
 * Client for the Sercha Enterprise API.
 *
 * ```ts
 * const sercha = new SerchaClient({
 *   baseUrl: 'https://api.acme.sercha.cloud',
 *   auth: { clientId, clientSecret },
 * });
 *
 * const { rows } = await sercha.query('SELECT _id, status FROM claims.Claim');
 * ```
 *
 * Instances are safe to share and should be: the client caches access tokens,
 * so constructing one per request defeats that and mints a token every time.
 */
export class SerchaClient implements Sercha {
  readonly queries: QueryResource;
  readonly runs: RunsResource;
  readonly genie: GenieResource;
  readonly catalogue: CatalogueResource;
  readonly ledger: LedgerResource;
  readonly documents: SearchResource;
  readonly structures: StructuresResource;
  readonly sync: SyncResource;

  private readonly transport: HttpTransport;

  constructor(config: SerchaClientConfig) {
    const resolved = resolveConfig(config);
    const tokens = new TokenManager(resolved);
    this.transport = new HttpTransport(resolved, tokens);

    this.queries = new QueryResource(this.transport);
    this.runs = new RunsResource(this.transport);
    this.genie = new GenieResource(this.transport);
    this.catalogue = new CatalogueResource(this.transport);
    this.ledger = new LedgerResource(this.transport);
    this.documents = new SearchResource(this.transport);
    this.structures = new StructuresResource(this.transport);
    this.sync = new SyncResource(this.transport);
  }

  // Shorthands for the common operations. The resource objects above remain
  // available for everything else.

  query<T = QueryRow>(serchaql: string, options?: QueryOptions): Promise<QueryResult<T>> {
    return this.queries.run<T>(serchaql, options);
  }

  paginate<T = QueryRow>(serchaql: string, options?: PaginateOptions): AsyncGenerator<T> {
    return this.queries.paginate<T>(serchaql, options);
  }

  all<T = QueryRow>(serchaql: string, options?: PaginateOptions): Promise<T[]> {
    return this.queries.all<T>(serchaql, options);
  }

  one<T = QueryRow>(serchaql: string, options?: QueryOptions): Promise<T> {
    return this.queries.one<T>(serchaql, options);
  }

  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    return this.documents.search(request, signal);
  }

  getDocument(documentId: string, signal?: AbortSignal): Promise<Document> {
    return this.documents.getDocument(documentId, signal);
  }

  askMessages(messages: GenieMessage[]): Promise<GenieTurnResult> {
    return this.genie.askMessages(messages);
  }

  streamMessages(messages: GenieMessage[]): AsyncGenerator<GenieEvent> {
    return this.genie.streamMessages(messages);
  }

  ask(conversationId: string, message: string): Promise<GenieTurnResult> {
    return this.genie.ask(conversationId, message);
  }

  stream(conversationId: string, message: string): AsyncGenerator<GenieEvent> {
    return this.genie.stream(conversationId, message);
  }

  createConversation(title?: string): Promise<GenieConversation> {
    return this.genie.createConversation(title);
  }

  listConversations(): Promise<GenieConversation[]> {
    return this.genie.listConversations();
  }

  getConversation(conversationId: string): Promise<GenieConversationDetail> {
    return this.genie.getConversation(conversationId);
  }

  getRun(runId: string): Promise<Run> {
    return this.runs.get(runId);
  }

  listRuns(query?: ListRunsQuery): Promise<Run[]> {
    return this.runs.list(query);
  }

  waitForRun(runId: string, options?: WaitForRunOptions): Promise<Run> {
    return this.runs.waitFor(runId, options);
  }

  catalogueTree(options?: { queryable?: boolean }): Promise<CatalogueTree> {
    return this.catalogue.tree(options);
  }

  entityTypes(corpusId: string): Promise<CatalogueEntityType[]> {
    return this.catalogue.entityTypes(corpusId);
  }

  entityProperties(corpusId: string, entityType: string): Promise<CatalogueProperty[]> {
    return this.catalogue.entityProperties(corpusId, entityType);
  }

  createRecordType(input: CreateLedgerRecordType): Promise<LedgerRecordType> {
    return this.ledger.createRecordType(input);
  }

  recordTypes(ontology: string): Promise<LedgerRecordType[]> {
    return this.ledger.recordTypes(ontology);
  }

  appendRecord(record: AppendLedgerRecord): Promise<LedgerRecord> {
    return this.ledger.append(record);
  }

  supersedeRecord(id: string, record: AppendLedgerRecord): Promise<LedgerRecord> {
    return this.ledger.supersede(id, record);
  }

  getRecord(id: string): Promise<LedgerRecord> {
    return this.ledger.get(id);
  }

  listRecords(query?: ListLedgerRecordsQuery): Promise<LedgerRecord[]> {
    return this.ledger.records(query);
  }

  subjectHistory(subjectKey: string): Promise<LedgerRecord[]> {
    return this.ledger.subjectHistory(subjectKey);
  }

  structure(corpusId: string): Promise<CorpusStructure> {
    return this.structures.structure(corpusId);
  }

  structureTray(corpusId: string, opts?: { groupBy?: 'candidate' }): Promise<StructureTray> {
    return this.structures.structureTray(corpusId, opts);
  }

  assignDocument(corpusId: string, req: AssignDocumentRequest): Promise<AssignDocumentResponse> {
    return this.structures.assignDocument(corpusId, req);
  }

  rerunStructure(corpusId: string, req?: RerunStructureRequest): Promise<RerunStructureResponse> {
    return this.structures.rerunStructure(corpusId, req);
  }

  triggerSync(sourceId: string): Promise<SyncAccepted> {
    return this.sync.triggerSync(sourceId);
  }

  syncState(sourceId: string): Promise<SourceSyncState> {
    return this.sync.syncState(sourceId);
  }

  syncStates(): Promise<SourceSyncState[]> {
    return this.sync.syncStates();
  }

  pushDocuments(sourceId: string, req: PushDocumentsRequest): Promise<PushDocumentsResponse> {
    return this.sync.pushDocuments(sourceId, req);
  }

  waitForIngest(documentIds: string[], opts?: WaitForIngestOptions): Promise<Document[]> {
    return this.sync.waitForIngest(documentIds, opts);
  }

  /**
   * Check the instance is reachable and the credentials work.
   *
   * Issues a real authenticated request, so it exercises the token exchange
   * rather than only TCP reachability.
   */
  async ping(signal?: AbortSignal): Promise<boolean> {
    await this.catalogue.corpuses(signal);
    return true;
  }
}
