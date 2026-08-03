/**
 * @sercha-ai/client — TypeScript client for the Sercha Enterprise API.
 *
 * @example
 * ```ts
 * import { SerchaClient } from '@sercha-ai/client';
 *
 * const sercha = new SerchaClient({
 *   baseUrl: process.env.SERCHA_BASE_URL!,
 *   auth: {
 *     clientId: process.env.SERCHA_CLIENT_ID!,
 *     clientSecret: process.env.SERCHA_CLIENT_SECRET!,
 *   },
 * });
 *
 * const { rows } = await sercha.query('SELECT _id, status FROM claims.Claim');
 * ```
 */

export { SerchaClient, type Sercha } from './client.js';

export {
  type SerchaClientConfig,
  type AuthConfig,
  type ClientCredentials,
  type StaticToken,
  type RetryConfig,
  type FetchLike,
} from './config.js';

export { DEFAULT_SCOPES } from './auth/token.js';

export {
  SerchaError,
  SerchaConfigError,
  SerchaHttpError,
  SerchaAuthError,
  SerchaDecodeError,
  SerchaTimeoutError,
  SerchaRunTimeoutError,
  PluginConfirmationRequiredError,
  type PluginCallEstimate,
} from './transport/errors.js';

export { QueryResource, deriveColumns } from './resources/query.js';
export { RunsResource } from './resources/runs.js';
export { GenieResource, type StreamOptions } from './resources/genie.js';
export { CatalogueResource } from './resources/catalogue.js';
export { LedgerResource } from './resources/ledger.js';
export { SearchResource } from './resources/search.js';

export type {
  CellValue,
  ExecutionContext,
  NestedRowSet,
  ObjectKind,
  PaginateOptions,
  QueryColumn,
  QueryOptions,
  QueryOpStat,
  QueryResult,
  QueryRow,
  QueryStats,
  RawQueryResponse,
} from './types/query.js';

export {
  isTerminalStatus,
  TERMINAL_RUN_STATUSES,
  type ListRunsQuery,
  type Pipeline,
  type Run,
  type RunKind,
  type RunStaging,
  type RunStatus,
  type RunTraceEntry,
  type TriggerKind,
  type WaitForRunOptions,
} from './types/runs.js';

export {
  isTerminalEvent,
  TERMINAL_GENIE_EVENTS,
  type GenieConversation,
  type GenieConversationDetail,
  type GenieEvent,
  type GenieEventType,
  type GenieMessage,
  type GenieQuery,
  type GenieTurn,
  type GenieTurnResult,
} from './types/genie.js';

export type {
  CatalogueEntityType,
  CatalogueNameItem,
  CatalogueProperty,
  CatalogueTree,
  CatalogueTreeCorpus,
  CatalogueTreeOntology,
  CatalogueTreePipeline,
} from './types/catalogue.js';

export type {
  Document,
  SearchRequest,
  SearchResponse,
  SearchResultItem,
  Source,
} from './types/search.js';

// Exported for consumers implementing the Sercha interface themselves, e.g. a
// recording proxy or a fixture generator.
export { SseParser, readSseStream, type SseFrame } from './transport/sse.js';

export type {
  AppendLedgerRecord,
  CreateLedgerRecordType,
  LedgerAuthorKind,
  LedgerAuthority,
  LedgerEvidence,
  LedgerRecord,
  LedgerRecordKind,
  LedgerRecordType,
  LedgerRecordTypeProperty,
  LedgerValueType,
  ListLedgerRecordsQuery,
} from './types/ledger.js';
