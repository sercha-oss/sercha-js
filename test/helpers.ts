import { vi } from 'vitest';
import { SerchaClient } from '../src/client.js';

/** JSON response with the right content-type. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** SSE response streaming the given raw frames. */
export function sseResponse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** One `event:`/`data:` SSE frame. */
export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A fetch double that answers the token endpoint automatically and plays the
 * queued responses in order.
 *
 * The explicit signature matters: without it the mock's parameters are
 * inferred from the first call, so `init` narrows away and every inspection
 * of the request body needs a cast.
 */
export type MockFetch = ReturnType<typeof mockFetch>;

/** One recorded call. `init` is optional because GET requests omit it. */
export type MockCall = [url: string, init?: RequestInit];

export function mockFetch(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    void init;
    if (url.endsWith('/oauth/token')) {
      return json({ access_token: 'tok', token_type: 'Bearer', expires_in: 900 });
    }
    return queue.shift() ?? json({ error: 'no queued response' }, 500);
  });
}

/** Calls that were not the automatic token exchange. */
export function apiCalls(fetchImpl: MockFetch): MockCall[] {
  return fetchImpl.mock.calls.filter(([url]) => !url.endsWith('/oauth/token'));
}

/** Calls to the token endpoint. */
export function tokenCalls(fetchImpl: MockFetch): MockCall[] {
  return fetchImpl.mock.calls.filter(([url]) => url.endsWith('/oauth/token'));
}

/** The parsed JSON body of the nth API call. */
export function requestBody(fetchImpl: MockFetch, index = 0): Record<string, unknown> {
  const call = apiCalls(fetchImpl)[index];
  if (!call) throw new Error(`no API call at index ${index}`);
  const body = call[1]?.body;
  if (typeof body !== 'string') throw new Error(`call ${index} had no string body`);
  return JSON.parse(body) as Record<string, unknown>;
}

/** Request headers of the nth API call. */
export function requestHeaders(fetchImpl: MockFetch, index = 0): Record<string, string> {
  const call = apiCalls(fetchImpl)[index];
  if (!call) throw new Error(`no API call at index ${index}`);
  return (call[1]?.headers ?? {}) as Record<string, string>;
}

/** URL of the nth API call. */
export function requestUrl(fetchImpl: MockFetch, index = 0): string {
  const call = apiCalls(fetchImpl)[index];
  if (!call) throw new Error(`no API call at index ${index}`);
  return call[0];
}

export interface TestClientOptions {
  attempts?: number;
  headers?: Record<string, string>;
  baseUrl?: string;
}

/** Client wired to a mock fetch, with retries off and near-zero backoff. */
export function testClient(fetchImpl: MockFetch, options: TestClientOptions = {}): SerchaClient {
  return new SerchaClient({
    baseUrl: options.baseUrl ?? 'https://sercha.test',
    auth: { clientId: 'id', clientSecret: 'secret' },
    fetch: fetchImpl,
    retry: { attempts: options.attempts ?? 1, baseDelayMs: 1, maxDelayMs: 2 },
    ...(options.headers ? { headers: options.headers } : {}),
  });
}
