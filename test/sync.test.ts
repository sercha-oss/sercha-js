import { describe, expect, it } from 'vitest';
import { SerchaHttpError, SerchaTimeoutError } from '../src/transport/errors.js';
import { isTerminalIngestStatus, TERMINAL_INGEST_STATUSES } from '../src/types/sync.js';
import type { Document } from '../src/types/search.js';
import { StubSercha } from '../src/testing/index.js';
import { json, mockFetch, requestBody, requestUrl, testClient as clientWith } from './helpers.js';

const fast = { pollIntervalMs: 1, maxPollIntervalMs: 2 };

function doc(id: string, over: Partial<Document> = {}): Document {
  return {
    id,
    source_id: 's1',
    title: 'pushed.pdf',
    path: '/pushed.pdf',
    mime_type: 'application/pdf',
    indexed_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('terminal ingest statuses', () => {
  it('treats indexed and failed as terminal, processing as not', () => {
    expect(TERMINAL_INGEST_STATUSES).toEqual(['indexed', 'failed']);
    expect(isTerminalIngestStatus('indexed')).toBe(true);
    expect(isTerminalIngestStatus('failed')).toBe(true);
    expect(isTerminalIngestStatus('processing')).toBe(false);
  });
});

describe('sync resource', () => {
  // The transport tags every 202 JSON body as { status: 202, body } for the
  // query confirm protocol; the sync resource must unwrap that rather than
  // hand the tagged envelope to the caller.
  it('unwraps the transport-tagged 202 from a sync trigger', async () => {
    const fetchImpl = mockFetch(
      json({ status: 'accepted', source_id: 's1', task_id: 'task-9' }, 202),
    );

    const accepted = await clientWith(fetchImpl).triggerSync('s1');
    expect(requestUrl(fetchImpl)).toContain('/api/v1/sources/s1/sync');
    expect(accepted).toEqual({ status: 'accepted', source_id: 's1', task_id: 'task-9' });
  });

  it('fetches the sync state of one source, warning included', async () => {
    const fetchImpl = mockFetch(
      json({
        source_id: 's1',
        status: 'completed',
        last_sync_at: '2026-08-01T00:00:00Z',
        warning: 'sync enumerated zero documents',
        cursor_age_hours: 96,
      }),
    );

    const state = await clientWith(fetchImpl).syncState('s1');
    expect(requestUrl(fetchImpl)).toContain('/api/v1/sources/s1/sync');
    expect(state.warning).toBe('sync enumerated zero documents');
    // Unknown fields survive: the type is open so a newer server's additions
    // are reachable without a client release.
    expect(state.cursor_age_hours).toBe(96);
  });

  it('normalises a null sync-states list', async () => {
    const fetchImpl = mockFetch(json(null));
    expect(await clientWith(fetchImpl).syncStates()).toEqual([]);
    expect(requestUrl(fetchImpl)).toContain('/api/v1/sources/sync-states');
  });

  it('pushes documents and returns per-document results', async () => {
    const fetchImpl = mockFetch(
      json({
        results: [{ document_id: 'd1', external_id: 'ext-1', ingest_status: 'processing' }],
      }),
    );

    const response = await clientWith(fetchImpl).pushDocuments('s1', {
      mode: 'single',
      documents: [
        {
          external_id: 'ext-1',
          title: 'a.pdf',
          path: '/a.pdf',
          mime_type: 'application/pdf',
          content: 'aGVsbG8=',
        },
      ],
    });

    expect(requestUrl(fetchImpl)).toContain('/api/v1/sources/s1/documents');
    expect(requestBody(fetchImpl)).toMatchObject({ mode: 'single' });
    expect(response.results[0]?.ingest_status).toBe('processing');
  });

  it('normalises a null push result list', async () => {
    const fetchImpl = mockFetch(json({ results: null }));
    const response = await clientWith(fetchImpl).pushDocuments('s1', {
      mode: 'single',
      documents: [],
    });
    expect(response.results).toEqual([]);
  });

  // Pushing is write-gated: a default service account gets 403 and the
  // application is expected to degrade, so the error must arrive recognisable.
  it('surfaces the write gate on push as a 403 SerchaHttpError', async () => {
    const fetchImpl = mockFetch(json({ error: 'write scope required' }, 403));
    const error = await clientWith(fetchImpl)
      .pushDocuments('s1', { mode: 'single', documents: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).status).toBe(403);
    expect((error as SerchaHttpError).isAuthError).toBe(true);
  });
});

describe('waitForIngest', () => {
  it('polls a processing document until it is indexed', async () => {
    const fetchImpl = mockFetch(
      json(doc('d1', { ingest_status: 'processing' })),
      json(doc('d1', { ingest_status: 'processing' })),
      json(doc('d1', { ingest_status: 'indexed' })),
    );

    const [document] = await clientWith(fetchImpl).waitForIngest(['d1'], fast);
    expect(document?.ingest_status).toBe('indexed');
  });

  it('stops polling settled documents and preserves input order', async () => {
    // Round 1: d1 terminal (no ingest_status, i.e. never async-ingested),
    // d2 processing. Round 2: only d2 is fetched again.
    const fetchImpl = mockFetch(
      json(doc('d1')),
      json(doc('d2', { ingest_status: 'processing' })),
      json(doc('d2', { ingest_status: 'indexed' })),
    );

    const documents = await clientWith(fetchImpl).waitForIngest(['d1', 'd2'], fast);
    expect(documents.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(requestUrl(fetchImpl, 2)).toContain('/api/v1/documents/d2');
  });

  // A failed ingest is an outcome to inspect per document, like a failed run:
  // throwing would force callers to unwrap an error to learn which document.
  it('returns a failed document rather than throwing', async () => {
    const fetchImpl = mockFetch(json(doc('d1', { ingest_status: 'failed' })));
    const [document] = await clientWith(fetchImpl).waitForIngest(['d1'], fast);
    expect(document?.ingest_status).toBe('failed');
  });

  it('raises SerchaTimeoutError naming the still-pending ids', async () => {
    const fetchImpl = mockFetch(
      ...Array.from({ length: 20 }, () => json(doc('d1', { ingest_status: 'processing' }))),
    );

    const error = await clientWith(fetchImpl)
      .waitForIngest(['d1'], { ...fast, timeoutMs: 5 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaTimeoutError);
    expect((error as SerchaTimeoutError).message).toContain('d1');
    // Ingest keeps going server-side, so the message must not imply it stopped.
    expect((error as SerchaTimeoutError).message).toMatch(/continues server-side/);
  });
});

describe('stub sync', () => {
  const push = {
    mode: 'single' as const,
    documents: [
      {
        external_id: 'ext-1',
        title: 'a.pdf',
        path: '/a.pdf',
        mime_type: 'application/pdf',
        content: 'aGVsbG8=',
      },
    ],
  };

  it('accepts a sync trigger', async () => {
    const accepted = await new StubSercha().triggerSync('s1');
    expect(accepted.status).toBe('accepted');
    expect(accepted.source_id).toBe('s1');
    expect(accepted.task_id).toMatch(/^stub-sync-task-/);
  });

  it('includes a warning state by default, so apps can render the path', async () => {
    const states = await new StubSercha().syncStates();
    expect(states.length).toBeGreaterThan(1);
    expect(states.some((s) => typeof s.warning === 'string' && s.warning.length > 0)).toBe(true);
  });

  it('stores pushed documents as processing: acceptance is not indexing', async () => {
    const sercha = new StubSercha();
    const { results } = await sercha.pushDocuments('s1', push);
    expect(results[0]?.ingest_status).toBe('processing');

    const document = await sercha.getDocument(results[0]!.document_id!);
    expect(document.ingest_status).toBe('processing');
    expect(document.source_id).toBe('s1');
  });

  it('promotes on the Nth poll, so waitForIngest completes without time mocks', async () => {
    const sercha = new StubSercha();
    const { results } = await sercha.pushDocuments('s1', push);

    const [document] = await sercha.waitForIngest([results[0]!.document_id!]);
    expect(document?.ingest_status).toBe('indexed');
  });

  it('promotes explicitly through stubIndexDocuments when automatic promotion is off', async () => {
    const sercha = new StubSercha({ indexAfterPolls: 0 });
    const { results } = await sercha.pushDocuments('s1', push);
    const id = results[0]!.document_id!;

    sercha.stubIndexDocuments([id]);
    const [document] = await sercha.waitForIngest([id]);
    expect(document?.ingest_status).toBe('indexed');
  });

  it('drives the failed path through stubIndexDocuments', async () => {
    const sercha = new StubSercha({ indexAfterPolls: 0 });
    const { results } = await sercha.pushDocuments('s1', push);
    const id = results[0]!.document_id!;

    sercha.stubIndexDocuments([id], 'failed');
    const [document] = await sercha.waitForIngest([id]);
    expect(document?.ingest_status).toBe('failed');
  });

  it('times out naming the pending ids when nothing promotes', async () => {
    const sercha = new StubSercha({ indexAfterPolls: 0 });
    const { results } = await sercha.pushDocuments('s1', push);
    const id = results[0]!.document_id!;

    const error = await sercha.waitForIngest([id]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SerchaTimeoutError);
    expect((error as SerchaTimeoutError).message).toContain(id);
  });
});
