import { resolveConfig, type SerchaClientConfig } from './config.js';
import { TokenManager } from './auth/token.js';
import { HttpTransport } from './transport/http.js';
import { QueryResource } from './resources/query.js';
import { RunsResource } from './resources/runs.js';
import { GenieResource } from './resources/genie.js';
import { CatalogueResource } from './resources/catalogue.js';
import { SearchResource } from './resources/search.js';
import type { PaginateOptions, QueryOptions, QueryResult, QueryRow } from './types/query.js';
import type { GenieEvent, GenieTurnResult } from './types/genie.js';
import type { ListRunsQuery, Run, WaitForRunOptions } from './types/runs.js';
import type { SearchRequest, SearchResponse } from './types/search.js';
import type { CatalogueTree } from './types/catalogue.js';

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

  ask(conversationId: string, message: string): Promise<GenieTurnResult>;
  stream(conversationId: string, message: string): AsyncGenerator<GenieEvent>;

  getRun(runId: string): Promise<Run>;
  listRuns(query?: ListRunsQuery): Promise<Run[]>;
  waitForRun(runId: string, options?: WaitForRunOptions): Promise<Run>;

  catalogueTree(options?: { queryable?: boolean }): Promise<CatalogueTree>;
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
  readonly documents: SearchResource;

  private readonly transport: HttpTransport;

  constructor(config: SerchaClientConfig) {
    const resolved = resolveConfig(config);
    const tokens = new TokenManager(resolved);
    this.transport = new HttpTransport(resolved, tokens);

    this.queries = new QueryResource(this.transport);
    this.runs = new RunsResource(this.transport);
    this.genie = new GenieResource(this.transport);
    this.catalogue = new CatalogueResource(this.transport);
    this.documents = new SearchResource(this.transport);
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

  ask(conversationId: string, message: string): Promise<GenieTurnResult> {
    return this.genie.ask(conversationId, message);
  }

  stream(conversationId: string, message: string): AsyncGenerator<GenieEvent> {
    return this.genie.stream(conversationId, message);
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
