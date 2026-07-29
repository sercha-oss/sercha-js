import { describe, expect, it } from 'vitest';
import { SseParser, readSseStream } from '../src/transport/sse.js';

describe('SseParser', () => {
  it('parses a simple frame', () => {
    const frames = new SseParser().feed('event: answer\ndata: {"text":"hi"}\n\n');
    expect(frames).toEqual([{ event: 'answer', data: '{"text":"hi"}' }]);
  });

  it('defaults the event name to "message" when absent', () => {
    const frames = new SseParser().feed('data: hello\n\n');
    expect(frames[0]?.event).toBe('message');
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const parser = new SseParser();
    expect(parser.feed('event: ans')).toEqual([]);
    expect(parser.feed('wer\ndata: {"a"')).toEqual([]);
    const frames = parser.feed(':1}\n\n');
    expect(frames).toEqual([{ event: 'answer', data: '{"a":1}' }]);
  });

  it('emits multiple frames arriving in one chunk', () => {
    const frames = new SseParser().feed('data: one\n\ndata: two\n\ndata: three\n\n');
    expect(frames.map((f) => f.data)).toEqual(['one', 'two', 'three']);
  });

  // The UI parser splits on "\n\n" only, so a CRLF stream never yields a frame.
  it('handles CRLF line endings', () => {
    const frames = new SseParser().feed('event: answer\r\ndata: hi\r\n\r\n');
    expect(frames).toEqual([{ event: 'answer', data: 'hi' }]);
  });

  it('handles bare CR line endings', () => {
    const frames = new SseParser().feed('event: answer\rdata: hi\r\r');
    expect(frames).toEqual([{ event: 'answer', data: 'hi' }]);
  });

  it('joins multi-line data with newlines', () => {
    const frames = new SseParser().feed('data: line one\ndata: line two\n\n');
    expect(frames[0]?.data).toBe('line one\nline two');
  });

  it('strips exactly one leading space after the colon', () => {
    const frames = new SseParser().feed('data:  two spaces\n\n');
    expect(frames[0]?.data).toBe(' two spaces');
  });

  it('handles a field with no colon', () => {
    const frames = new SseParser().feed('data\ndata: real\n\n');
    expect(frames[0]?.data).toBe('\nreal');
  });

  it('ignores comment lines used as keep-alives', () => {
    const frames = new SseParser().feed(': keep-alive\ndata: real\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'real' }]);
  });

  it('drops a frame carrying no data lines', () => {
    expect(new SseParser().feed('event: ping\n\n')).toEqual([]);
  });

  it('parses id and retry fields', () => {
    const frames = new SseParser().feed('id: 42\nretry: 3000\ndata: x\n\n');
    expect(frames[0]).toEqual({ event: 'message', data: 'x', id: '42', retry: 3000 });
  });

  it('ignores an id containing NUL, per spec', () => {
    const frames = new SseParser().feed('id: bad\0id\ndata: x\n\n');
    expect(frames[0]?.id).toBeUndefined();
  });

  it('ignores a non-integer retry', () => {
    const frames = new SseParser().feed('retry: soon\ndata: x\n\n');
    expect(frames[0]?.retry).toBeUndefined();
  });

  it('ignores unknown fields', () => {
    const frames = new SseParser().feed('unknown: x\ndata: real\n\n');
    expect(frames[0]?.data).toBe('real');
  });

  // A server that closes straight after the final data line leaves a complete
  // frame with no terminating blank line. That frame is usually the terminal
  // event, so dropping it loses the answer.
  it('flush() emits a trailing frame with no terminating blank line', () => {
    const parser = new SseParser();
    expect(parser.feed('data: last\n')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'message', data: 'last' }]);
  });

  it('flush() emits nothing when the buffer holds only whitespace', () => {
    const parser = new SseParser();
    parser.feed('data: done\n\n');
    expect(parser.flush()).toEqual([]);
  });
});

describe('readSseStream', () => {
  function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  it('yields frames in order', async () => {
    const frames = [];
    for await (const frame of readSseStream(streamOf('data: a\n\ndata: b\n\n'))) {
      frames.push(frame.data);
    }
    expect(frames).toEqual(['a', 'b']);
  });

  it('yields a trailing frame the server did not terminate', async () => {
    const frames = [];
    for await (const frame of readSseStream(streamOf('data: a\n\ndata: unterminated'))) {
      frames.push(frame.data);
    }
    expect(frames).toEqual(['a', 'unterminated']);
  });

  // A streaming decoder is required: splitting a multi-byte character across
  // chunks corrupts it if each chunk is decoded independently.
  it('reassembles a multi-byte character split across chunks', async () => {
    const encoded = new TextEncoder().encode('data: café\n\n');
    const split = encoded.indexOf(0xc3); // first byte of é
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split + 1));
        controller.enqueue(encoded.slice(split + 1));
        controller.close();
      },
    });

    const frames = [];
    for await (const frame of readSseStream(stream)) frames.push(frame.data);
    expect(frames).toEqual(['data: café'.slice(6)]);
  });
});
