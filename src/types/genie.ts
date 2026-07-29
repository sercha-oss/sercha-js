/**
 * Genie types.
 *
 * Note the timestamp inconsistency with the rest of the API: Genie reports
 * unix milliseconds as numbers, everything else uses RFC3339 strings. Left as
 * the wire shape rather than normalised, so a value never silently means
 * something other than what the server sent.
 */

import type { QueryRow } from './query.js';

export type GenieEventType =
  'thinking' | 'query' | 'result' | 'sync' | 'analysis' | 'question' | 'answer' | 'done' | 'error';

/**
 * One SerchaQL statement Genie ran during a turn.
 *
 * Emitted twice: as `query` when drafted (no rows), then as `result` when
 * execution finishes. `id` pairs the two.
 */
export interface GenieQuery {
  id: number;
  title?: string;
  serchaql: string;
  /** Present on `result` only, and capped. Use row_count for the true total. */
  rows?: QueryRow[];
  /** Total rows the statement produced, regardless of how many were sent. */
  row_count: number;
  truncated?: boolean;
  error?: string;
}

/**
 * One streamed event of a Genie turn.
 *
 * `answer` and `question` are terminal, followed only by `done`. `error` is
 * terminal when the turn fails.
 */
export interface GenieEvent {
  type: GenieEventType;
  /** Present on thinking, question, answer, sync and analysis. */
  text?: string;
  /** Present on query and result. */
  query?: GenieQuery;
  /** Present on done. */
  model?: string;
  /** Present on error. */
  message?: string;
  /** Present on done for conversation-scoped turns. */
  conversation_id?: string;
}

/** Timestamps are unix milliseconds. */
export interface GenieConversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface GenieTurn {
  id: string;
  seq: number;
  user_message: string;
  terminal_kind: 'answer' | 'question' | 'error' | string;
  terminal_text: string;
  model: string;
  created_at: number;
  events: GenieEvent[];
}

export interface GenieConversationDetail {
  conversation: GenieConversation;
  turns: GenieTurn[];
}

/** Terminal event types: the turn produces exactly one. */
export const TERMINAL_GENIE_EVENTS: readonly GenieEventType[] = ['answer', 'question', 'error'];

export function isTerminalEvent(type: GenieEventType): boolean {
  return TERMINAL_GENIE_EVENTS.includes(type);
}

/** Accumulated outcome of a turn, for callers not consuming events directly. */
export interface GenieTurnResult {
  /** The terminal event's type. */
  kind: 'answer' | 'question' | 'error';
  /** The terminal event's text. */
  text: string;
  /** Every statement Genie ran, with results merged in. */
  queries: GenieQuery[];
  /** Model that produced the turn, from the `done` event. */
  model?: string;
  conversation_id?: string;
  /** Every event, in order, for callers wanting the full trace. */
  events: GenieEvent[];
}
