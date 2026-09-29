import { describe, expect, it } from 'vitest';
import { SerchaHttpError } from '../src/transport/errors.js';
import { partitionObjectId } from '../src/types/grants.js';
import type { Grant } from '../src/types/grants.js';
import {
  apiCalls,
  json,
  mockFetch,
  requestBody,
  requestUrl,
  testClient as clientWith,
} from './helpers.js';

function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: 'g-1',
    subject_kind: 'user',
    subject_id: 'founder@x.com',
    action: 'select',
    object_kind: 'partition',
    object_id: 'corpus-1:room/tenant a',
    granted_at: '2026-09-01T00:00:00Z',
    granted_by: 'admin-1',
    ...over,
  };
}

describe('partitionObjectId', () => {
  it('joins the corpus id and key on the first colon, keeping slashes in the key', () => {
    expect(partitionObjectId('corpus-1', 'room/tenant a')).toBe('corpus-1:room/tenant a');
  });

  it('names the global documents with an empty key', () => {
    expect(partitionObjectId('corpus-1', '')).toBe('corpus-1:');
  });
});

describe('grants resource', () => {
  it('posts a grant with the five wire fields', async () => {
    const fetchImpl = mockFetch(json(grant(), 201));
    const created = await clientWith(fetchImpl).grants.create({
      subject_kind: 'user',
      subject_id: 'founder@x.com',
      action: 'select',
      object_kind: 'partition',
      object_id: partitionObjectId('corpus-1', 'room/tenant a'),
    });

    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/grants');
    expect(init?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({
      subject_kind: 'user',
      subject_id: 'founder@x.com',
      action: 'select',
      object_kind: 'partition',
      object_id: 'corpus-1:room/tenant a',
    });
    expect(created.id).toBe('g-1');
  });

  it('lists with only the filter fields that were given, and coalesces null', async () => {
    const fetchImpl = mockFetch(json(null));
    const grants = await clientWith(fetchImpl).grants.list({
      object_kind: 'source',
      action: 'write',
    });

    const url = new URL(requestUrl(fetchImpl));
    expect(url.pathname).toBe('/api/v1/grants');
    expect(url.searchParams.get('object_kind')).toBe('source');
    expect(url.searchParams.get('action')).toBe('write');
    expect(url.searchParams.has('subject_id')).toBe(false);
    expect(apiCalls(fetchImpl)[0]![1]?.method).toBe('GET');
    expect(grants).toEqual([]);
  });

  it('lists everything with no query string when the filter is empty', async () => {
    const fetchImpl = mockFetch(json([grant()]));
    const grants = await clientWith(fetchImpl).grants.list();
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/grants');
    expect(grants).toHaveLength(1);
  });

  it('gets one grant by id', async () => {
    const fetchImpl = mockFetch(json(grant({ id: 'g/2' })));
    const found = await clientWith(fetchImpl).grants.get('g/2');
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/grants/g%2F2');
    expect(found.id).toBe('g/2');
  });

  it('deletes a grant and resolves on 204', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    await expect(clientWith(fetchImpl).grants.delete('g-1')).resolves.toBeUndefined();
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/grants/g-1');
    expect(init?.method).toBe('DELETE');
  });

  it('checks the caller against an object as query parameters', async () => {
    const fetchImpl = mockFetch(json({ allowed: true }));
    const result = await clientWith(fetchImpl).grants.check({
      action: 'select',
      object_kind: 'corpus',
      object_id: 'corpus-1',
    });

    const url = new URL(requestUrl(fetchImpl));
    expect(url.pathname).toBe('/api/v1/grants/check');
    expect(url.searchParams.get('action')).toBe('select');
    expect(url.searchParams.get('object_kind')).toBe('corpus');
    expect(url.searchParams.get('object_id')).toBe('corpus-1');
    expect(apiCalls(fetchImpl)[0]![1]?.method).toBe('GET');
    expect(result.allowed).toBe(true);
  });

  it('surfaces the 403 a non-admin token gets on the admin routes', async () => {
    const fetchImpl = mockFetch(json({ error: 'admin role required' }, 403));
    await expect(clientWith(fetchImpl).grants.list()).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<SerchaHttpError>);
  });
});
