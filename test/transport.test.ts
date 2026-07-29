import { describe, expect, it, vi } from 'vitest';
import { SerchaClient } from '../src/client.js';
import { SerchaConfigError, SerchaDecodeError, SerchaHttpError } from '../src/transport/errors.js';
import {
  apiCalls,
  json,
  mockFetch,
  requestHeaders,
  requestUrl,
  testClient,
  tokenCalls,
} from './helpers.js';

const clientWith = (fetchImpl: ReturnType<typeof mockFetch>, attempts = 3) =>
  testClient(fetchImpl, { attempts });

const queryCalls = apiCalls;

describe('config validation', () => {
  const auth = { clientId: 'id', clientSecret: 'secret' };

  it('rejects a missing baseUrl', () => {
    expect(() => new SerchaClient({ baseUrl: '', auth })).toThrow(SerchaConfigError);
  });

  it('rejects a malformed baseUrl', () => {
    expect(() => new SerchaClient({ baseUrl: 'not a url', auth })).toThrow(/not a valid URL/);
  });

  it('rejects a non-http protocol', () => {
    expect(() => new SerchaClient({ baseUrl: 'ftp://sercha.test', auth })).toThrow(
      /must be http or https/,
    );
  });

  it('rejects credentials missing a secret', () => {
    expect(
      () =>
        new SerchaClient({ baseUrl: 'https://s.test', auth: { clientId: 'id', clientSecret: '' } }),
    ).toThrow(/clientSecret is required/);
  });

  it('rejects retry.attempts below 1', () => {
    expect(
      () => new SerchaClient({ baseUrl: 'https://s.test', auth, retry: { attempts: 0 } }),
    ).toThrow(/at least 1/);
  });

  it('strips trailing slashes from baseUrl so paths do not double up', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    const client = testClient(fetchImpl, { attempts: 1, baseUrl: 'https://sercha.test///' });
    await client.query('SELECT 1');
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/query');
  });
});

describe('retry', () => {
  it('retries a 503 and succeeds', async () => {
    const fetchImpl = mockFetch(json({ error: 'unavailable' }, 503), json({ rows: [{ a: 1 }] }));
    const result = await clientWith(fetchImpl).query('SELECT a FROM c.T');

    expect(result.rows).toEqual([{ a: 1 }]);
    expect(queryCalls(fetchImpl)).toHaveLength(2);
  });

  it('retries 429', async () => {
    const fetchImpl = mockFetch(json({ error: 'slow down' }, 429), json({ rows: [] }));
    await clientWith(fetchImpl).query('SELECT 1');
    expect(queryCalls(fetchImpl)).toHaveLength(2);
  });

  it('gives up after the configured attempts', async () => {
    const fetchImpl = mockFetch(
      json({ error: 'a' }, 503),
      json({ error: 'b' }, 503),
      json({ error: 'c' }, 503),
    );

    await expect(clientWith(fetchImpl, 3).query('SELECT 1')).rejects.toMatchObject({ status: 503 });
    expect(queryCalls(fetchImpl)).toHaveLength(3);
  });

  // A 400 means the request itself is wrong; replaying it wastes a round trip
  // and delays the error the caller needs to see.
  it('does not retry a 400', async () => {
    const fetchImpl = mockFetch(json({ error: 'bad statement' }, 400));
    await expect(clientWith(fetchImpl).query('SELECT bad')).rejects.toMatchObject({ status: 400 });
    expect(queryCalls(fetchImpl)).toHaveLength(1);
  });

  it('does not retry a 403', async () => {
    const fetchImpl = mockFetch(json({ error: 'admin required' }, 403));
    await expect(clientWith(fetchImpl).query('CREATE CORPUS x')).rejects.toMatchObject({
      status: 403,
    });
    expect(queryCalls(fetchImpl)).toHaveLength(1);
  });

  it('does not retry a 500, which is usually deterministic', async () => {
    const fetchImpl = mockFetch(json({ error: 'boom' }, 500));
    await expect(clientWith(fetchImpl).query('SELECT 1')).rejects.toMatchObject({ status: 500 });
    expect(queryCalls(fetchImpl)).toHaveLength(1);
  });

  // A 401 on a token the client believed valid means revoked or clock skew.
  // Retrying with the same dead token would fail identically.
  it('mints a fresh token when a 401 is retried', async () => {
    const fetchImpl = mockFetch(json({ error: 'token revoked' }, 401), json({ rows: [] }));
    await clientWith(fetchImpl).query('SELECT 1');

    expect(tokenCalls(fetchImpl)).toHaveLength(2);
    expect(queryCalls(fetchImpl)).toHaveLength(2);
  });

  it('retries a network fault', async () => {
    let first = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: 'tok', token_type: 'Bearer', expires_in: 900 });
      }
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      return json({ rows: [{ a: 1 }] });
    });

    const result = await clientWith(fetchImpl as unknown as ReturnType<typeof mockFetch>).query(
      'SELECT a FROM c.T',
    );
    expect(result.rows).toEqual([{ a: 1 }]);
  });
});

describe('response decoding', () => {
  it('handles 204 with no body', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    await expect(clientWith(fetchImpl).genie.deleteConversation('abc')).resolves.toBeUndefined();
  });

  // Calling .json() on an empty 200 throws a parse error that reads like a
  // server fault; the UI client has this bug.
  it('handles an empty 200 body', async () => {
    const fetchImpl = mockFetch(
      new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(clientWith(fetchImpl).listRuns()).resolves.toEqual([]);
  });

  it('parses JSON sent with a wrong content-type', async () => {
    const fetchImpl = mockFetch(
      new Response(JSON.stringify({ rows: [{ a: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const result = await clientWith(fetchImpl).query('SELECT a FROM c.T');
    expect(result.rows).toEqual([{ a: 1 }]);
  });

  it('raises a clear error on malformed JSON rather than a parse crash', async () => {
    const fetchImpl = mockFetch(
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const error = await clientWith(fetchImpl)
      .query('SELECT 1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaDecodeError);
    expect((error as SerchaDecodeError).rawBody).toBe('{not json');
  });

  // The same request yields the same unparseable body, so retrying only
  // delays the error the caller needs.
  it('does not retry a malformed body', async () => {
    const fetchImpl = mockFetch(
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(clientWith(fetchImpl, 3).query('SELECT 1')).rejects.toBeInstanceOf(
      SerchaDecodeError,
    );
    expect(queryCalls(fetchImpl)).toHaveLength(1);
  });

  it('normalises a null list body to an empty array', async () => {
    const fetchImpl = mockFetch(json(null));
    await expect(clientWith(fetchImpl).listRuns()).resolves.toEqual([]);
  });

  // The server's timeout handler returns plain text, not the JSON envelope.
  it('uses a plain-text error body as the message', async () => {
    const fetchImpl = mockFetch(new Response('request timed out', { status: 503 }));
    const error = await clientWith(fetchImpl, 1)
      .query('SELECT 1')
      .catch((e: unknown) => e);
    expect((error as SerchaHttpError).message).toBe('request timed out');
  });
});

describe('request construction', () => {
  it('sends the bearer token', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    await clientWith(fetchImpl).query('SELECT 1');

    expect(requestHeaders(fetchImpl).Authorization).toBe('Bearer tok');
  });

  it('does not let caller headers displace the Authorization header', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    const client = testClient(fetchImpl, {
      attempts: 1,
      headers: { Authorization: 'Bearer attacker-supplied' },
    });
    await client.query('SELECT 1');

    expect(requestHeaders(fetchImpl).Authorization).toBe('Bearer tok');
  });

  it('applies custom headers that do not collide', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    const client = testClient(fetchImpl, { attempts: 1, headers: { 'X-Request-Id': 'abc' } });
    await client.query('SELECT 1');

    expect(requestHeaders(fetchImpl)['X-Request-Id']).toBe('abc');
  });

  it('encodes path parameters', async () => {
    const fetchImpl = mockFetch(json({ id: 'a/b' }));
    await clientWith(fetchImpl).getRun('a/b');
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/runs/a%2Fb');
  });

  it('omits undefined query parameters', async () => {
    const fetchImpl = mockFetch(json([]));
    await clientWith(fetchImpl).listRuns({ status: 'sealed', pipeline_id: undefined });
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/runs?status=sealed');
  });
});
