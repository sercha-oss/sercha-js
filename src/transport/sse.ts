/**
 * Server-sent events parsing, per the WHATWG spec's event-stream format.
 *
 * Written against the spec rather than against observed Sercha output, since
 * the failure mode of a loose parser is silent event loss: a dropped frame
 * looks identical to a turn that had nothing to say.
 */

/** One decoded SSE frame. */
export interface SseFrame {
  /** The `event:` field. Defaults to "message" when absent, per spec. */
  event: string;
  /** Concatenated `data:` lines, joined with newlines. */
  data: string;
  /** The `id:` field, when present. */
  id?: string;
  /** The `retry:` field in ms, when present and valid. */
  retry?: number;
}

/**
 * Incremental SSE parser.
 *
 * Fed arbitrary chunk boundaries; emits only complete frames. Holds a partial
 * frame across feeds, which is the whole point: network chunks split mid-frame
 * routinely, and a parser that assumes otherwise loses data under load rather
 * than in testing.
 */
export class SseParser {
  private buffer = '';

  /** Feed a chunk, returning any frames it completed. */
  feed(chunk: string): SseFrame[] {
    // Normalise line endings up front. The spec permits CRLF, LF and bare CR;
    // proxies do rewrite these, and splitting on "\n\n" alone silently fails
    // to find frame boundaries in a CRLF stream.
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const frames: SseFrame[] = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /**
   * Flush at end of stream.
   *
   * A well-behaved server terminates the last frame with a blank line, but a
   * connection closed straight after the final `data:` leaves a complete frame
   * in the buffer with no boundary. Discarding it loses the terminal event,
   * which is usually the one that matters.
   */
  flush(): SseFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const frame = parseFrame(this.buffer);
    this.buffer = '';
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of raw.split('\n')) {
    // A leading colon marks a comment, used for keep-alives.
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Exactly one leading space after the colon is part of the delimiter, not
    // the value. Trimming instead would corrupt data with meaningful
    // whitespace.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        // The spec requires ignoring an id containing NUL.
        if (!value.includes('\0')) id = value;
        break;
      case 'retry': {
        const ms = Number(value);
        if (Number.isInteger(ms) && ms >= 0) retry = ms;
        break;
      }
      default:
        // Unknown fields are ignored, per spec.
        break;
    }
  }

  // A frame with no data lines carries no event, only metadata.
  if (dataLines.length === 0) return undefined;

  return {
    event: event ?? 'message',
    data: dataLines.join('\n'),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

/**
 * Read a response body as a stream of SSE frames.
 *
 * Decodes with a streaming TextDecoder so multi-byte UTF-8 sequences split
 * across chunk boundaries reassemble correctly, and flushes at the end so a
 * trailing unterminated frame is not lost.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    // Flush the decoder before the parser: a trailing partial multi-byte
    // sequence must be emitted before the final frame is assembled.
    const tail = decoder.decode();
    if (tail) yield* parser.feed(tail);
    yield* parser.flush();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
