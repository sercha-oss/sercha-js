import type { HttpTransport } from '../transport/http.js';
import { SerchaError, SerchaHttpError } from '../transport/errors.js';
import { readSseStream } from '../transport/sse.js';
import type {
  GenieMessage,
  GenieConversation,
  GenieConversationDetail,
  GenieEvent,
  GenieQuery,
  GenieTurnResult,
} from '../types/genie.js';

export interface StreamOptions {
  signal?: AbortSignal;
  /** Overrides the client's streamTimeoutMs. */
  timeoutMs?: number;
}

/**
 * Genie: the conversational agent surface.
 *
 * Turns are streamed, not polled. There is no run ID and no completion
 * endpoint: a turn runs on one held-open connection for up to five minutes.
 * If the connection drops mid-turn the events are lost, but the turn is
 * persisted server-side, so getConversation() recovers what it produced.
 */
export class GenieResource {
  constructor(private readonly http: HttpTransport) {}

  async createConversation(title?: string, signal?: AbortSignal): Promise<GenieConversation> {
    return this.http.request<GenieConversation>('/api/v1/genie/conversations', {
      method: 'POST',
      body: title ? { title } : {},
      ...(signal ? { signal } : {}),
    });
  }

  /** List conversations, newest first. */
  async listConversations(signal?: AbortSignal): Promise<GenieConversation[]> {
    const list = await this.http.request<GenieConversation[] | null>(
      '/api/v1/genie/conversations',
      { ...(signal ? { signal } : {}) },
    );
    return list ?? [];
  }

  /** A conversation with its full turn history, including replayed events. */
  async getConversation(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<GenieConversationDetail> {
    return this.http.request<GenieConversationDetail>(
      `/api/v1/genie/conversations/${encodeURIComponent(conversationId)}`,
      { ...(signal ? { signal } : {}) },
    );
  }

  async renameConversation(
    conversationId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request<void>(
      `/api/v1/genie/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'PUT', body: { title }, ...(signal ? { signal } : {}) },
    );
  }

  /** Delete a conversation. Idempotent. */
  async deleteConversation(conversationId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<void>(
      `/api/v1/genie/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE', ...(signal ? { signal } : {}) },
    );
  }

  /**
   * Send a message and stream the turn's events as they arrive.
   *
   * Only the new message is sent; the server rebuilds the transcript from
   * stored turns.
   *
   * The generator ends when the stream closes. Exactly one terminal event
   * (`answer`, `question` or `error`) precedes the closing `done`.
   */
  async *stream(
    conversationId: string,
    message: string,
    options: StreamOptions = {},
  ): AsyncGenerator<GenieEvent> {
    yield* this.streamFrom(
      `/api/v1/genie/conversations/${encodeURIComponent(conversationId)}/chat`,
      { message },
      options,
    );
  }

  /**
   * Run a turn against a transcript the caller owns.
   *
   * The stateless surface. Sercha persists nothing: no conversation is created,
   * no turn is stored, and the done event carries no conversation_id. The
   * application supplies the whole history on every call and keeps it wherever
   * it likes.
   *
   * This is the mode an application should use. Sercha's own conversation
   * storage enforces ownership by the calling identity, and an application
   * authenticates with one service account for all of its users, so that check
   * cannot distinguish them: every user would see every other user's
   * conversations. Owning the transcript sidesteps that entirely, and lets the
   * application scope conversations however it needs to.
   *
   * Two things the caller inherits responsibility for. The backend caps a
   * transcript at 40 messages of 8000 characters each, so a long conversation
   * has to be trimmed before it is sent. And a conversation-scoped turn gets an
   * enrichment block listing previously executed statements and their row
   * counts, telling the model not to re-run them; there is no equivalent here,
   * so an application that wants it synthesises one from the query and result
   * events it already receives.
   */
  async *streamMessages(
    messages: GenieMessage[],
    options: StreamOptions = {},
  ): AsyncGenerator<GenieEvent> {
    if (messages.length === 0) {
      throw new SerchaError('streamMessages needs at least one message.');
    }
    // `stateless` is what keeps this method honest. Without it the server
    // reads a single message as the start of a new conversation and persists
    // it, emitting an id the caller never asked for and will never clean up.
    //
    // It is sent on every call, not only single-message ones: a first turn has
    // no prior turns, so the transcript legitimately holds one message, and a
    // count cannot distinguish that from "begin a conversation". The caller
    // chose this method, and that is the statement of intent.
    //
    // Older servers ignore the unknown field. Against one of those a
    // single-message call still creates a conversation, so pass at least two
    // messages if you must support them.
    yield* this.streamFrom('/api/v1/genie/chat', { messages, stateless: true }, options);
  }

  /**
   * Shared SSE plumbing for both surfaces.
   *
   * Extracted so the two entry points cannot drift on error handling, which is
   * the fiddly part: a pre-stream failure arrives as ordinary JSON with a
   * normal status code, so an ok response is not by itself proof of a stream.
   */
  private async *streamFrom(
    path: string,
    body: Record<string, unknown>,
    options: StreamOptions,
  ): AsyncGenerator<GenieEvent> {
    const url = this.http.buildUrl(path);
    const timeoutMs = options.timeoutMs ?? this.http.resolved.streamTimeoutMs;

    const response = await this.http.resolved.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Sercha sends JSON for pre-stream errors, so both are acceptable.
        Accept: 'text/event-stream, application/json',
        Authorization: await this.http.authHeader(),
        ...this.http.resolved.headers,
      },
      body: JSON.stringify(body),
      signal: composeSignal(options.signal, timeoutMs),
    });

    if (!response.ok) {
      throw await toStreamError(response);
    }

    // Errors before the stream opens arrive as plain JSON with a normal status
    // code, so an ok response is not by itself proof of a stream.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw await toStreamError(response);
    }

    if (!response.body) {
      throw new SerchaError('Genie stream response had no body');
    }

    for await (const frame of readSseStream(response.body, options.signal)) {
      let event: GenieEvent;
      try {
        event = JSON.parse(frame.data) as GenieEvent;
      } catch {
        // A malformed frame should not kill a turn that is otherwise
        // proceeding; the terminal event is what matters.
        continue;
      }

      // Error frames are emitted out-of-band as `event: error` with a body of
      // {"message"} and no `type`. Take the type from the SSE event name so
      // the payload shape does not have to be guessed at.
      if (!event.type && frame.event && frame.event !== 'message') {
        event.type = frame.event as GenieEvent['type'];
      }
      if (!event.type && event.message) {
        event.type = 'error';
      }

      yield event;
    }
  }

  /**
   * Run a turn and return its accumulated outcome.
   *
   * Convenience over stream() for callers wanting the answer rather than the
   * progress. `query` and `result` events are merged so each statement appears
   * once, with its rows.
   */
  async ask(
    conversationId: string,
    message: string,
    options: StreamOptions = {},
  ): Promise<GenieTurnResult> {
    return collectTurn(this.stream(conversationId, message, options));
  }

  /**
   * Run a stateless turn and return its accumulated outcome.
   *
   * The same relationship to streamMessages that ask() has to stream(): for a
   * caller that wants the answer rather than the progress. `query` and `result`
   * events are merged so each statement appears once, with its rows.
   *
   * A UI rendering its own tables usually wants streamMessages instead, since
   * this resolves only when the turn is complete.
   */
  async askMessages(
    messages: GenieMessage[],
    options: StreamOptions = {},
  ): Promise<GenieTurnResult> {
    return collectTurn(this.streamMessages(messages, options));
  }
}

/**
 * Accumulate a turn's events into its outcome.
 *
 * Shared by both ask surfaces so they cannot diverge on how a terminal event
 * is recognised or how queries are merged with their results.
 */
async function collectTurn(stream: AsyncGenerator<GenieEvent>): Promise<GenieTurnResult> {
  const events: GenieEvent[] = [];
  const queries = new Map<number, GenieQuery>();
  let terminal: { kind: 'answer' | 'question' | 'error'; text: string } | undefined;
  let model: string | undefined;
  let conversation: string | undefined;

  for await (const event of stream) {
    events.push(event);

    switch (event.type) {
      case 'query':
      case 'result':
        // `result` carries the same id as its `query` plus rows, so it
        // supersedes it.
        if (event.query) queries.set(event.query.id, event.query);
        break;
      case 'answer':
      case 'question':
        terminal = { kind: event.type, text: event.text ?? '' };
        break;
      case 'error':
        terminal = { kind: 'error', text: event.message ?? event.text ?? 'Genie turn failed' };
        break;
      case 'done':
        model = event.model;
        conversation = event.conversation_id;
        break;
      default:
        break;
    }
  }

  if (!terminal) {
    // The stream closed without a terminal event: a dropped connection or a
    // server-side abort. Surfacing this as an empty answer would be a lie.
    throw new SerchaError(
      'Genie stream ended without a terminal event. The turn may have been ' +
        'interrupted; fetch the conversation to see what was persisted.',
    );
  }

  return {
    kind: terminal.kind,
    text: terminal.text,
    queries: [...queries.values()].sort((a, b) => a.id - b.id),
    ...(model !== undefined ? { model } : {}),
    ...(conversation !== undefined ? { conversation_id: conversation } : {}),
    events,
  };
}

async function toStreamError(response: Response): Promise<SerchaHttpError> {
  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const envelope = body as { error?: string; message?: string; code?: string } | undefined;
  const message =
    envelope?.error ?? envelope?.message ?? (text ? text.slice(0, 200) : `HTTP ${response.status}`);

  return new SerchaHttpError(response.status, message, {
    ...(envelope?.code !== undefined ? { code: envelope.code } : {}),
    ...(body !== undefined ? { body } : {}),
  });
}

function composeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([caller, timeout]);
  }
  const controller = new AbortController();
  const abort = (reason: unknown) => controller.abort(reason);
  if (caller.aborted) abort(caller.reason);
  else caller.addEventListener('abort', () => abort(caller.reason), { once: true });
  if (timeout.aborted) abort(timeout.reason);
  else timeout.addEventListener('abort', () => abort(timeout.reason), { once: true });
  return controller.signal;
}
