import { describe, expect, it } from 'vitest';
import { SerchaError, SerchaHttpError } from '../src/transport/errors.js';
import {
  frame,
  json,
  mockFetch,
  requestBody,
  sseResponse,
  testClient as clientWith,
} from './helpers.js';

describe('genie.stream', () => {
  it('yields events in order', async () => {
    const fetchImpl = mockFetch(
      sseResponse(
        frame('thinking', { type: 'thinking', text: 'considering' }),
        frame('answer', { type: 'answer', text: '42' }),
        frame('done', { type: 'done', model: 'claude' }),
      ),
    );

    const types = [];
    for await (const event of clientWith(fetchImpl).stream('conv-1', 'question?')) {
      types.push(event.type);
    }
    expect(types).toEqual(['thinking', 'answer', 'done']);
  });

  it('sends only the new message', async () => {
    const fetchImpl = mockFetch(sseResponse(frame('done', { type: 'done' })));
    for await (const _ of clientWith(fetchImpl).stream('conv-1', 'hello')) {
      // drain
    }

    expect(requestBody(fetchImpl)).toEqual({ message: 'hello' });
  });

  // The out-of-band error frame carries {"message"} with no type field. Taking
  // the type from the SSE event name avoids inferring it from payload shape.
  it('recovers the type of an error frame from the event name', async () => {
    const fetchImpl = mockFetch(
      sseResponse('event: error\ndata: {"message":"llm unavailable"}\n\n'),
    );

    const events = [];
    for await (const event of clientWith(fetchImpl).stream('conv-1', 'q')) events.push(event);

    expect(events[0]).toMatchObject({ type: 'error', message: 'llm unavailable' });
  });

  it('skips a malformed frame without killing the stream', async () => {
    const fetchImpl = mockFetch(
      sseResponse(
        'event: thinking\ndata: {not json\n\n',
        frame('answer', { type: 'answer', text: 'survived' }),
      ),
    );

    const events = [];
    for await (const event of clientWith(fetchImpl).stream('conv-1', 'q')) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe('survived');
  });

  // Errors raised before the stream opens arrive as plain JSON with a normal
  // status, so an ok response is not by itself proof of a stream.
  it('raises when the server answers with JSON instead of a stream', async () => {
    const fetchImpl = mockFetch(json({ error: 'conversations disabled' }, 200));
    const iterator = clientWith(fetchImpl).stream('conv-1', 'q');
    await expect(iterator.next()).rejects.toThrow(/conversations disabled/);
  });

  it('surfaces a 404 for an unknown conversation', async () => {
    const fetchImpl = mockFetch(json({ error: 'conversation not found' }, 404));
    const error = await clientWith(fetchImpl)
      .stream('nope', 'q')
      .next()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).status).toBe(404);
  });
});

describe('genie.ask', () => {
  it('accumulates a turn into its terminal answer', async () => {
    const fetchImpl = mockFetch(
      sseResponse(
        frame('thinking', { type: 'thinking', text: 'planning' }),
        frame('answer', { type: 'answer', text: 'the answer' }),
        frame('done', { type: 'done', model: 'claude', conversation_id: 'conv-1' }),
      ),
    );

    const result = await clientWith(fetchImpl).ask('conv-1', 'q');

    expect(result.kind).toBe('answer');
    expect(result.text).toBe('the answer');
    expect(result.model).toBe('claude');
    expect(result.conversation_id).toBe('conv-1');
    expect(result.events).toHaveLength(3);
  });

  // `result` repeats its `query` id and adds rows, so the pair must collapse
  // to one entry rather than appearing twice.
  it('merges each query with its result', async () => {
    const query = { id: 0, serchaql: 'SELECT 1', row_count: 0 };
    const fetchImpl = mockFetch(
      sseResponse(
        frame('query', { type: 'query', query }),
        frame('result', { type: 'result', query: { ...query, rows: [{ a: 1 }], row_count: 1 } }),
        frame('answer', { type: 'answer', text: 'done' }),
        frame('done', { type: 'done' }),
      ),
    );

    const result = await clientWith(fetchImpl).ask('conv-1', 'q');

    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.rows).toEqual([{ a: 1 }]);
    expect(result.queries[0]?.row_count).toBe(1);
  });

  it('orders queries by id regardless of arrival order', async () => {
    const fetchImpl = mockFetch(
      sseResponse(
        frame('result', { type: 'result', query: { id: 1, serchaql: 'B', row_count: 0 } }),
        frame('result', { type: 'result', query: { id: 0, serchaql: 'A', row_count: 0 } }),
        frame('answer', { type: 'answer', text: 'x' }),
        frame('done', { type: 'done' }),
      ),
    );

    const result = await clientWith(fetchImpl).ask('conv-1', 'q');
    expect(result.queries.map((q) => q.serchaql)).toEqual(['A', 'B']);
  });

  it('treats a question as a terminal outcome', async () => {
    const fetchImpl = mockFetch(
      sseResponse(
        frame('question', { type: 'question', text: 'which corpus?' }),
        frame('done', { type: 'done' }),
      ),
    );

    const result = await clientWith(fetchImpl).ask('conv-1', 'q');
    expect(result.kind).toBe('question');
    expect(result.text).toBe('which corpus?');
  });

  it('reports an error turn as a terminal error', async () => {
    const fetchImpl = mockFetch(
      sseResponse('event: error\ndata: {"message":"llm unavailable"}\n\n'),
    );

    const result = await clientWith(fetchImpl).ask('conv-1', 'q');
    expect(result.kind).toBe('error');
    expect(result.text).toBe('llm unavailable');
  });

  // Reporting an empty answer would misrepresent a dropped connection as a
  // turn that had nothing to say.
  it('raises when the stream ends with no terminal event', async () => {
    const fetchImpl = mockFetch(
      sseResponse(frame('thinking', { type: 'thinking', text: 'interrupted' })),
    );

    const error = await clientWith(fetchImpl)
      .ask('conv-1', 'q')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaError);
    expect((error as SerchaError).message).toMatch(/without a terminal event/);
  });
});

describe('genie conversations', () => {
  it('creates a conversation with a title', async () => {
    const fetchImpl = mockFetch(json({ id: 'c1', title: 'Review', created_at: 1, updated_at: 1 }));
    const conversation = await clientWith(fetchImpl).genie.createConversation('Review');
    expect(conversation.id).toBe('c1');
  });

  it('normalises a null conversation list', async () => {
    const fetchImpl = mockFetch(json(null));
    expect(await clientWith(fetchImpl).genie.listConversations()).toEqual([]);
  });
});
