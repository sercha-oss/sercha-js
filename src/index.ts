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
export { DocumentsResource } from './resources/documents.js';
export { StructuresResource } from './resources/structures.js';
export { CorpusesResource } from './resources/corpuses.js';
export { SyncResource } from './resources/sync.js';
export { GrantsResource } from './resources/grants.js';
export {
  AppsResource,
  AppAccessResource,
  AppGuestsResource,
  AppSharesResource,
  AppConfinedResource,
} from './resources/apps.js';

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

export type { Document, Source, SourceDocumentsPage } from './types/documents.js';

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

export type {
  AssignDocumentRequest,
  AssignDocumentResponse,
  ConfirmableFlag,
  ConfirmFlagRequest,
  ConfirmFlagResponse,
  CorpusStructure,
  RerunStructureRequest,
  RerunStructureResponse,
  StructureActor,
  StructureArchived,
  StructureAssignmentEvent,
  StructurePack,
  StructureState,
  StructureTray,
  StructureTrayEntry,
  StructureTrayFlag,
  StructureTrayGroup,
} from './types/structures.js';

export {
  UNASSIGNED_PARTITION_KEY,
  type Corpus,
  type CorpusDocument,
  type CorpusDocumentsPage,
  type CorpusPartitions,
  type PartitionCount,
  type SourceContainer,
} from './types/corpuses.js';

export {
  isTerminalIngestStatus,
  TERMINAL_INGEST_STATUSES,
  type IngestStatus,
  type PushDocument,
  type PushDocumentResult,
  type PushDocumentsRequest,
  type PushDocumentsResponse,
  type SourceSyncState,
  type SyncAccepted,
  type WaitForIngestOptions,
} from './types/sync.js';

export {
  partitionObjectId,
  type CheckGrantRequest,
  type CheckGrantResponse,
  type CreateGrantRequest,
  type Grant,
  type GrantAction,
  type GrantObjectKind,
  type GrantSubjectKind,
  type ListGrantsFilter,
} from './types/grants.js';

export type {
  App,
  AppAccess,
  AppAccessMode,
  AppInviteResponse,
  AppInviteUser,
  AppRole,
  AppShare,
  AppShareRole,
  AppSharesResponse,
  ConfineRequest,
  ConfinedKey,
  ConfinedPerson,
  ConfinedResponse,
  CreateAppShareRequest,
  CreateAppShareResponse,
  CreateGuestLinkRequest,
  GuestLink,
  GuestLinksResponse,
  InviteAppUserRequest,
  OpenAppLinkParams,
  OpenAppLinkResponse,
  PromoteGuestRequest,
  SetAppAccessRequest,
} from './types/apps.js';
