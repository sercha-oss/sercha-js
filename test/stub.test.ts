import { describe, expect, it } from 'vitest';
import { StubSercha } from '../src/testing/index.js';
import type { Sercha } from '../src/client.js';
import { SerchaHttpError } from '../src/transport/errors.js';

describe('StubSercha', () => {
  it('satisfies the Sercha interface', () => {
    // Compile-time assertion: if the stub drifts from the interface, the real
    // client can no longer be swapped for it and this stops compiling.
    const sercha: Sercha = new StubSercha();
    expect(sercha).toBeDefined();
  });

  it('returns fixture rows for an exact statement', async () => {
    const stub = new StubSercha({
      queries: { 'SELECT a FROM c.T': [{ a: 1 }, { a: 2 }] },
    });

    const result = await stub.query('SELECT a FROM c.T');
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.stats.row_count).toBe(2);
    expect(result.columns).toEqual([{ name: 'a' }]);
  });

  // An unconfigured fixture and a genuinely empty result are different, and
  // conflating them lets a test pass against a stub that was never asked what
  // the code actually queries.
  it('throws for an unconfigured statement rather than returning empty', async () => {
    const stub = new StubSercha();
    await expect(stub.query('SELECT a FROM c.T')).rejects.toThrow(/no fixture/);
  });

  it('falls back to onQuery for unmatched statements', async () => {
    const stub = new StubSercha({ onQuery: () => [{ fallback: true }] });
    const result = await stub.query('anything at all');
    expect(result.rows).toEqual([{ fallback: true }]);
  });

  it('prefers an exact fixture over onQuery', async () => {
    const stub = new StubSercha({
      queries: { exact: [{ from: 'fixture' }] },
      onQuery: () => [{ from: 'fallback' }],
    });
    expect((await stub.query('exact')).rows).toEqual([{ from: 'fixture' }]);
  });

  it('records executed statements for assertions', async () => {
    const stub = new StubSercha({ onQuery: () => [] });
    await stub.query('SELECT 1');
    await stub.query('SELECT 2');
    expect(stub.executed).toEqual(['SELECT 1', 'SELECT 2']);
  });

  // Fixtures are keyed by the statement as written, so a consumer's ORDER BY
  // requirement does not force every LIMIT/OFFSET variant into the fixture map.
  it('paginates against the base statement', async () => {
    const stub = new StubSercha({
      queries: { 'SELECT a FROM c.T ORDER BY a': [{ a: 1 }, { a: 2 }, { a: 3 }] },
    });

    const rows = [];
    for await (const row of stub.paginate('SELECT a FROM c.T ORDER BY a', { pageSize: 2 })) {
      rows.push(row);
    }
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('honours maxRows', async () => {
    const stub = new StubSercha({
      queries: { q: [{ a: 1 }, { a: 2 }, { a: 3 }] },
    });
    expect(await stub.all('q', { maxRows: 2 })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('enforces the single-row contract of one()', async () => {
    const stub = new StubSercha({ queries: { q: [{ a: 1 }, { a: 2 }] } });
    await expect(stub.one('q')).rejects.toThrow(/got 2/);
  });

  it('returns a configured run', async () => {
    const stub = new StubSercha({
      runs: {
        'run-1': {
          id: 'run-1',
          pipeline_id: 'p1',
          pipeline_version_id: 'v1',
          status: 'sealed',
          trigger_kind: 'manual',
          created_at: '2026-07-29T00:00:00Z',
        },
      },
    });

    expect((await stub.getRun('run-1')).status).toBe('sealed');
    expect((await stub.waitForRun('run-1')).status).toBe('sealed');
  });

  it('raises a 404 for an unknown run, matching the real client', async () => {
    const stub = new StubSercha();
    const error = await stub.getRun('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).status).toBe(404);
  });

  it('replays a plausible event sequence from a Genie fixture', async () => {
    const stub = new StubSercha({
      genie: {
        'what is up': {
          kind: 'answer',
          text: 'all good',
          queries: [{ id: 0, serchaql: 'SELECT 1', row_count: 1, rows: [{ a: 1 }] }],
          events: [],
        },
      },
    });

    const types = [];
    for await (const event of stub.stream('c1', 'what is up')) types.push(event.type);

    expect(types).toEqual(['query', 'result', 'answer', 'done']);
  });

  it('returns empty collections from an unconfigured catalogue', async () => {
    const tree = await new StubSercha().catalogueTree();
    expect(tree).toEqual({ ontologies: [], corpuses: [], pipelines: [] });
  });

  it('returns configured entity properties', async () => {
    const stub = new StubSercha({
      entityProperties: {
        'corpus-1.Claim': [
          { name: 'status', type: 'string', system: false, required: true },
          { name: 'note', type: 'string', system: false, required: false },
        ],
      },
    });

    const properties = await stub.entityProperties('corpus-1', 'Claim');
    expect(properties.map((p) => p.name)).toEqual(['status', 'note']);
    expect(properties[0]?.required).toBe(true);
  });

  // Unlike a query fixture, an empty property list is a meaningful answer:
  // "the schema is unknown" rather than "the field is absent". Callers
  // validating against it must be able to tell those apart.
  it('returns empty rather than throwing for unconfigured properties', async () => {
    await expect(new StubSercha().entityProperties('corpus-1', 'Claim')).resolves.toEqual([]);
  });

  it('returns configured entity types', async () => {
    const stub = new StubSercha({
      entityTypes: {
        'corpus-1': [{ name: 'Claim', display_name: 'Claim', is_root: true }],
      },
    });
    expect((await stub.entityTypes('corpus-1')).map((t) => t.name)).toEqual(['Claim']);
  });
});
