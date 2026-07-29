import { describe, expect, it } from 'vitest';
import {
  PluginConfirmationRequiredError,
  SerchaError,
  SerchaHttpError,
} from '../src/transport/errors.js';
import { apiCalls, json, mockFetch, requestBody, testClient as clientWith } from './helpers.js';

describe('query', () => {
  it('returns rows, stats and derived columns', async () => {
    const fetchImpl = mockFetch(
      json({ rows: [{ _id: '1', status: 'open' }], stats: { row_count: 1 } }),
    );

    const result = await clientWith(fetchImpl).query('SELECT _id, status FROM c.Claim');

    expect(result.rows).toEqual([{ _id: '1', status: 'open' }]);
    expect(result.stats.row_count).toBe(1);
    expect(result.columns).toEqual([{ name: '_id' }, { name: 'status' }]);
  });

  it('sends the statement under the serchaql key', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    await clientWith(fetchImpl).query('SELECT 1');

    expect(requestBody(fetchImpl)).toEqual({ serchaql: 'SELECT 1' });
  });

  it('derives columns from the union across rows, not just the first', async () => {
    const fetchImpl = mockFetch(json({ rows: [{ a: 1 }, { a: 2, b: 3 }] }));
    const result = await clientWith(fetchImpl).query('SELECT a, b FROM c.T');
    expect(result.columns).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('falls back to the row count when stats are absent', async () => {
    const fetchImpl = mockFetch(json({ rows: [{ a: 1 }, { a: 2 }] }));
    const result = await clientWith(fetchImpl).query('SELECT a FROM c.T');
    expect(result.stats.row_count).toBe(2);
  });

  it('surfaces the structured error envelope', async () => {
    const fetchImpl = mockFetch(
      json(
        {
          error: 'corpus not found: nope',
          code: 'corpus_not_found',
          object_ref: { kind: 'corpus', ref: 'nope' },
        },
        400,
      ),
    );

    await expect(clientWith(fetchImpl).query('SELECT 1 FROM nope.T')).rejects.toMatchObject({
      status: 400,
      code: 'corpus_not_found',
      objectRef: { kind: 'corpus', ref: 'nope' },
      message: 'corpus not found: nope',
    });
  });

  it('maps a 403 to an auth error', async () => {
    const fetchImpl = mockFetch(json({ error: 'admin required' }, 403));
    const error = await clientWith(fetchImpl)
      .query('CREATE CORPUS x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).isAuthError).toBe(true);
  });

  describe('plugin confirmation', () => {
    const estimate = {
      provider: 'acme',
      operation: 'enrich',
      uncached_calls: 500,
      soft_call_limit: 100,
      rate_limit_rpm: 60,
      estimated_wait_seconds: 480,
    };

    it('throws with the estimate on a 202', async () => {
      const fetchImpl = mockFetch(json({ confirmation_required: true, estimate }, 202));
      const error = await clientWith(fetchImpl)
        .query('SELECT enrich(x) FROM c.T')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PluginConfirmationRequiredError);
      expect((error as PluginConfirmationRequiredError).estimate).toEqual(estimate);
    });

    it('sends confirm:true when the caller confirms', async () => {
      const fetchImpl = mockFetch(json({ rows: [{ a: 1 }] }));
      await clientWith(fetchImpl).query('SELECT enrich(x) FROM c.T', { confirm: true });

      expect(requestBody(fetchImpl)).toMatchObject({ confirm: true });
    });

    // Re-throwing here would make a caller that retries on the error loop.
    it('raises a distinct error when 202 persists after confirming', async () => {
      const fetchImpl = mockFetch(json({ confirmation_required: true, estimate }, 202));
      await expect(
        clientWith(fetchImpl).query('SELECT enrich(x) FROM c.T', { confirm: true }),
      ).rejects.toThrow(/still requires confirmation/);
    });

    it('raises rather than hanging when a 202 carries no estimate', async () => {
      const fetchImpl = mockFetch(json({ confirmation_required: true }, 202));
      await expect(clientWith(fetchImpl).query('SELECT enrich(x) FROM c.T')).rejects.toThrow(
        /without an estimate/,
      );
    });
  });

  describe('one()', () => {
    it('returns the single row', async () => {
      const fetchImpl = mockFetch(json({ rows: [{ n: 42 }] }));
      expect(await clientWith(fetchImpl).one('SELECT count(*) AS n FROM c.T')).toEqual({ n: 42 });
    });

    it('throws when the statement returns nothing', async () => {
      const fetchImpl = mockFetch(json({ rows: [] }));
      await expect(clientWith(fetchImpl).one('SELECT 1')).rejects.toThrow(/got 0/);
    });

    // Returning rows[0] here would hide a query that is wrong.
    it('throws when the statement returns several rows', async () => {
      const fetchImpl = mockFetch(json({ rows: [{ a: 1 }, { a: 2 }] }));
      await expect(clientWith(fetchImpl).one('SELECT a FROM c.T')).rejects.toThrow(/got 2/);
    });
  });
});

describe('paginate', () => {
  it('pages until a short page is returned', async () => {
    const fetchImpl = mockFetch(json({ rows: [{ i: 1 }, { i: 2 }] }), json({ rows: [{ i: 3 }] }));

    const rows = await clientWith(fetchImpl).all('SELECT i FROM c.T ORDER BY i', { pageSize: 2 });
    expect(rows).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it('appends LIMIT and OFFSET to each page', async () => {
    const fetchImpl = mockFetch(json({ rows: [{ i: 1 }] }), json({ rows: [] }));
    await clientWith(fetchImpl).all('SELECT i FROM c.T ORDER BY i', { pageSize: 1 });

    expect(requestBody(fetchImpl, 0).serchaql).toBe(
      'SELECT i FROM c.T ORDER BY i LIMIT 1 OFFSET 0',
    );
    expect(requestBody(fetchImpl, 1).serchaql).toBe(
      'SELECT i FROM c.T ORDER BY i LIMIT 1 OFFSET 1',
    );
  });

  it('stops at maxRows without over-fetching', async () => {
    const fetchImpl = mockFetch(json({ rows: [{ i: 1 }, { i: 2 }] }));
    const rows = await clientWith(fetchImpl).all('SELECT i FROM c.T ORDER BY i', {
      pageSize: 10,
      maxRows: 2,
    });

    expect(rows).toHaveLength(2);
    expect(apiCalls(fetchImpl)).toHaveLength(1);
  });

  it('strips a trailing semicolon before appending LIMIT', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    await clientWith(fetchImpl).all('SELECT i FROM c.T ORDER BY i;', { pageSize: 5 });

    expect(requestBody(fetchImpl).serchaql).toBe('SELECT i FROM c.T ORDER BY i LIMIT 5 OFFSET 0');
  });

  // OFFSET over an unordered result silently duplicates and skips rows.
  it('refuses a statement with no ORDER BY', async () => {
    const client = clientWith(mockFetch());
    await expect(client.all('SELECT i FROM c.T')).rejects.toThrow(/requires an ORDER BY/);
  });

  it('refuses a statement that already pages itself', async () => {
    const client = clientWith(mockFetch());
    await expect(client.all('SELECT i FROM c.T ORDER BY i LIMIT 10')).rejects.toThrow(
      /must not contain either/,
    );
  });

  it('does not mistake the word LIMIT inside a string literal for a clause', async () => {
    const fetchImpl = mockFetch(json({ rows: [] }));
    await expect(
      clientWith(fetchImpl).all("SELECT i FROM c.T WHERE note = 'LIMIT' ORDER BY i"),
    ).resolves.toEqual([]);
  });

  it('does not mistake ORDER BY inside a comment for the real clause', async () => {
    const client = clientWith(mockFetch());
    await expect(client.all('SELECT i FROM c.T -- ORDER BY i')).rejects.toThrow(
      /requires an ORDER BY/,
    );
  });

  it('rejects a pageSize below 1', async () => {
    const client = clientWith(mockFetch());
    await expect(client.all('SELECT i FROM c.T ORDER BY i', { pageSize: 0 })).rejects.toThrow(
      SerchaError,
    );
  });
});
