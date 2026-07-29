import { describe, expect, it, vi } from 'vitest';
import { SerchaRunTimeoutError } from '../src/transport/errors.js';
import type { Run, RunStatus } from '../src/types/runs.js';
import { json, mockFetch, requestUrl, testClient as clientWith } from './helpers.js';

function run(status: RunStatus, extra: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    pipeline_id: 'pipe-1',
    pipeline_version_id: 'ver-1',
    status,
    trigger_kind: 'manual',
    created_at: '2026-07-29T00:00:00Z',
    ...extra,
  };
}

describe('runs', () => {
  it('fetches a run by id', async () => {
    const fetchImpl = mockFetch(json(run('running')));
    expect((await clientWith(fetchImpl).getRun('run-1')).status).toBe('running');
  });

  it('normalises a null run list', async () => {
    const fetchImpl = mockFetch(json(null));
    expect(await clientWith(fetchImpl).listRuns()).toEqual([]);
  });

  it('passes list filters through as query parameters', async () => {
    const fetchImpl = mockFetch(json([]));
    await clientWith(fetchImpl).listRuns({ pipeline_id: 'p1', status: 'failed', limit: 10 });

    const url = requestUrl(fetchImpl);
    expect(url).toContain('pipeline_id=p1');
    expect(url).toContain('status=failed');
    expect(url).toContain('limit=10');
  });

  it('normalises an absent trace to an empty array', async () => {
    const fetchImpl = mockFetch(json({ run_id: 'run-1', status: 'queued', trace: null }));
    expect(await clientWith(fetchImpl).runs.trace('run-1')).toEqual([]);
  });
});

describe('waitFor', () => {
  const fast = { pollIntervalMs: 1, maxPollIntervalMs: 2 };

  it('returns immediately when the run is already sealed', async () => {
    const fetchImpl = mockFetch(json(run('sealed')));
    const result = await clientWith(fetchImpl).waitForRun('run-1', fast);
    expect(result.status).toBe('sealed');
  });

  it('polls through non-terminal states until sealed', async () => {
    const fetchImpl = mockFetch(
      json(run('queued')),
      json(run('running')),
      json(run('sealing')),
      json(run('sealed')),
    );

    const result = await clientWith(fetchImpl).waitForRun('run-1', fast);
    expect(result.status).toBe('sealed');
  });

  // Failure is an outcome to inspect, not a client fault: throwing would force
  // callers to unwrap an error to read run.error.
  it('returns a failed run rather than throwing', async () => {
    const fetchImpl = mockFetch(json(run('failed', { error: 'op crashed' })));
    const result = await clientWith(fetchImpl).waitForRun('run-1', fast);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('op crashed');
  });

  it('reports progress through onPoll', async () => {
    const fetchImpl = mockFetch(json(run('running')), json(run('sealed')));
    const seen: string[] = [];

    await clientWith(fetchImpl).waitForRun('run-1', {
      ...fast,
      onPoll: (r) => seen.push(r.status),
    });

    expect(seen).toEqual(['running', 'sealed']);
  });

  it('raises a run timeout carrying the last observed status', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: 'tok', token_type: 'Bearer', expires_in: 900 });
      }
      return json(run('running'));
    });

    const error = await clientWith(fetchImpl as unknown as ReturnType<typeof mockFetch>)
      .waitForRun('run-1', { ...fast, timeoutMs: 5 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaRunTimeoutError);
    expect((error as SerchaRunTimeoutError).lastStatus).toBe('running');
    expect((error as SerchaRunTimeoutError).runId).toBe('run-1');
    // The run keeps executing server-side, so the message must not imply it stopped.
    expect((error as SerchaRunTimeoutError).message).toMatch(/still executing/);
  });

  it('stops polling when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: 'tok', token_type: 'Bearer', expires_in: 900 });
      }
      controller.abort();
      return json(run('running'));
    });

    await expect(
      clientWith(fetchImpl as unknown as ReturnType<typeof mockFetch>).waitForRun('run-1', {
        ...fast,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });
});
