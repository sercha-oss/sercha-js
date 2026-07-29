/** Pipeline and run types. Timestamps here are RFC3339 strings. */

export type RunStatus = 'queued' | 'running' | 'sealing' | 'sealed' | 'failed';

export type TriggerKind = 'manual' | 'scheduled' | 'binding' | 'sync';

export type RunKind = 'extraction' | 'query';

/** Statuses from which a run will not advance. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['sealed', 'failed'];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface Pipeline {
  id: string;
  name: string;
  current_version_id?: string;
  created_at: string;
  updated_at: string;
}

export interface RunTraceEntry {
  invocation_id: string;
  op_id: string;
  op_version: string;
  status?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  nodes_staged?: number;
  edges_staged?: number;
  error?: string;
  [key: string]: unknown;
}

export interface Run {
  id: string;
  pipeline_id: string;
  pipeline_version_id: string;
  status: RunStatus;
  started_at?: string;
  ended_at?: string;
  trigger_kind: TriggerKind;
  triggered_by?: string;
  trace?: RunTraceEntry[];
  /** Populated when status is "failed". */
  error?: string;
  kind?: RunKind;
  created_at: string;
  /**
   * Documents the run was scoped to.
   *
   * Only returned by the GET endpoints; the trigger response omits both this
   * and document_count.
   */
  document_ids?: string[];
  document_count?: number;
}

export interface RunStaging {
  run_id: string;
  node_count: number;
  edge_count: number;
  node_count_by_graph: Record<string, number>;
  edge_count_by_type: Record<string, number>;
}

export interface ListRunsQuery {
  pipeline_id?: string;
  status?: RunStatus;
  trigger_kind?: TriggerKind;
  /** RFC3339. */
  started_after?: string;
  /** RFC3339. */
  started_before?: string;
  /** Server default is 50. */
  limit?: number;
  offset?: number;
}

export interface WaitForRunOptions {
  /**
   * Give up after this long. Default 900_000 (15 min).
   *
   * Exceeding it raises SerchaRunTimeoutError; the run continues server-side.
   */
  timeoutMs?: number;
  /** Initial poll interval in ms. Default 2_000. */
  pollIntervalMs?: number;
  /**
   * Ceiling for the poll interval in ms. Default 15_000.
   *
   * The interval grows geometrically from pollIntervalMs to this, so a short
   * run is detected promptly without a long one polling hundreds of times.
   */
  maxPollIntervalMs?: number;
  signal?: AbortSignal;
  /** Called on each poll, for progress reporting. */
  onPoll?: (run: Run) => void;
}
