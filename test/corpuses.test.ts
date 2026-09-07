import { describe, expect, it } from 'vitest';
import { StubSercha } from '../src/testing/index.js';
import { UNASSIGNED_PARTITION_KEY } from '../src/index.js';
import type { StructurePack, StructureTrayEntry } from '../src/index.js';
import { json, mockFetch, requestUrl, testClient } from './helpers.js';

function pack(overrides: Partial<StructurePack> = {}): StructurePack {
  return {
    id: 'pack-1',
    level_name: 'tenancy',
    slug: 'acme',
    display_name: 'ACME',
    doc_count: 1,
    subtree_doc_count: 1,
    unlocked_agent_count: 0,
    review_state: 'reviewed',
    children: [],
    ...overrides,
  };
}

function trayEntry(overrides: Partial<StructureTrayEntry> = {}): StructureTrayEntry {
  return {
    document_id: 'doc-1',
    document_title: 'Doc 1',
    document_path: '/room/doc-1',
    event_id: 'ev-1',
    actor: 'agent',
    flag: 'duplicate_of',
    flag_payload: { primary_document_id: 'doc-0' },
    rationale: 'byte-identical',
    confidence: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('corpuses resource', () => {
  it('lists corpora and coalesces the null empty list', async () => {
    const fetch = mockFetch(json(null));
    const client = testClient(fetch);
    expect(await client.corpuses.list()).toEqual([]);
    expect(requestUrl(fetch, 0)).toContain('/api/v1/corpuses');
  });

  it('pages documents and passes the partition filter through verbatim', async () => {
    const fetch = mockFetch(
      json({ documents: null, total: 0, limit: 10, offset: 0 }),
      json({
        documents: [{ id: 'd1', partition_key: '' }],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );
    const client = testClient(fetch);

    const empty = await client.corpusDocuments('c1', { limit: 10 });
    expect(empty.documents).toEqual([]);

    // The EMPTY key is a real filter value (global documents), so it must
    // reach the query string rather than being dropped as falsy.
    await client.corpusDocuments('c1', { partitionKey: '' });
    expect(requestUrl(fetch, 1)).toContain('partition_key=');
  });

  it('returns partitions with the structure badge fields when present', async () => {
    const fetch = mockFetch(
      json({
        corpus_id: 'c1',
        structure_state: 'needs_review',
        tray_count: 2,
        partitions: [{ key: 'finance/invoices', doc_count: 6 }],
      }),
    );
    const client = testClient(fetch);
    const partitions = await client.corpusPartitions('c1');
    expect(partitions.structure_state).toBe('needs_review');
    expect(partitions.tray_count).toBe(2);
    expect(partitions.partitions[0]?.key).toBe('finance/invoices');
  });
});

describe('stub corpuses', () => {
  const seeded = () =>
    new StubSercha({
      structures: {
        c1: { packs: [pack()], tray: [trayEntry()] },
      },
    });

  it('serves tray documents under the unassigned sentinel', async () => {
    const sercha = seeded();
    const page = await sercha.corpusDocuments('c1');
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0]?.partition_key).toBe(UNASSIGNED_PARTITION_KEY);
  });

  it('moves a confirmed document from tray to archive, and undo removes it', async () => {
    const sercha = seeded();
    const result = await sercha.confirmFlag('c1', {
      document_id: 'doc-1',
      flag: 'duplicate_of',
      target_document_id: 'doc-0',
    });
    expect(result.locked).toBe(true);
    expect(result.partition_key).toBe(UNASSIGNED_PARTITION_KEY);

    const tray = await sercha.structureTray('c1');
    expect(tray.entries).toHaveLength(0);
    const archived = await sercha.structureArchived('c1');
    expect(archived.count).toBe(1);
    expect(archived.entries[0]?.flag).toBe('duplicate_of');

    // Undo: a human re-assignment removes the settled retirement.
    await sercha.assignDocument('c1', { document_id: 'doc-1', container_id: 'pack-1' });
    expect((await sercha.structureArchived('c1')).count).toBe(0);
  });

  it('refuses a retirement naming no survivor', async () => {
    const sercha = seeded();
    await expect(
      // Cast because the type system already forbids this shape; the stub
      // must also enforce it at runtime, as the server does with a 400.
      sercha.confirmFlag('c1', {
        document_id: 'doc-1',
        flag: 'duplicate_of',
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('derives partitions from standing state with the room badge', async () => {
    const sercha = seeded();
    const partitions = await sercha.corpusPartitions('c1');
    expect(partitions.structure_state).toBe('needs_review');
    expect(partitions.tray_count).toBe(1);
    expect(partitions.partitions.map((p) => p.key)).toContain(UNASSIGNED_PARTITION_KEY);
  });
});
