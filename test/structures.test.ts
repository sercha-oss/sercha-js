import { describe, expect, it } from 'vitest';
import { SerchaHttpError } from '../src/transport/errors.js';
import type { StructurePack, StructureTrayEntry } from '../src/types/structures.js';
import { StubSercha } from '../src/testing/index.js';
import { json, mockFetch, requestBody, requestUrl, testClient as clientWith } from './helpers.js';

function pack(over: Partial<StructurePack> = {}): StructurePack {
  return {
    id: 'pack-1',
    level_name: 'client',
    slug: 'acme',
    display_name: 'Acme Pty Ltd',
    doc_count: 3,
    subtree_doc_count: 7,
    unlocked_agent_count: 2,
    review_state: 'pending',
    children: [],
    ...over,
  };
}

function trayEntry(over: Partial<StructureTrayEntry> = {}): StructureTrayEntry {
  return {
    document_id: 'doc-1',
    document_title: 'Q3 statement',
    document_path: '/inbox/q3.pdf',
    event_id: 'evt-1',
    actor: 'agent',
    flag: 'no_pack',
    flag_payload: null,
    rationale: 'no existing pack fits',
    confidence: 0.4,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('structures resource', () => {
  it('fetches the pack tree for a corpus', async () => {
    const fetchImpl = mockFetch(
      json({
        corpus_id: 'c1',
        structure_ref: 'ref-1',
        structure_state: 'needs_review',
        tray_count: 2,
        packs: [pack({ children: [pack({ id: 'pack-2', slug: 'q3' })] })],
      }),
    );

    const structure = await clientWith(fetchImpl).structure('c1');
    expect(requestUrl(fetchImpl)).toContain('/api/v1/corpuses/c1/structure');
    expect(structure.structure_state).toBe('needs_review');
    expect(structure.packs[0]?.children[0]?.slug).toBe('q3');
  });

  it('normalises null pack lists at every level of the tree', async () => {
    const fetchImpl = mockFetch(
      json({
        corpus_id: 'c1',
        structure_ref: 'ref-1',
        structure_state: 'fresh',
        tray_count: 0,
        packs: [{ ...pack(), children: null }],
      }),
    );

    const structure = await clientWith(fetchImpl).structure('c1');
    expect(structure.packs[0]?.children).toEqual([]);
  });

  it('normalises a null top-level pack list', async () => {
    const fetchImpl = mockFetch(
      json({
        corpus_id: 'c1',
        structure_ref: 'ref-1',
        structure_state: 'fresh',
        tray_count: 0,
        packs: null,
      }),
    );
    expect((await clientWith(fetchImpl).structure('c1')).packs).toEqual([]);
  });

  it('fetches the tray and coalesces a null entry list', async () => {
    const fetchImpl = mockFetch(json({ entries: null }));
    const tray = await clientWith(fetchImpl).structureTray('c1');
    expect(requestUrl(fetchImpl)).toContain('/api/v1/corpuses/c1/structure/tray');
    expect(requestUrl(fetchImpl)).not.toContain('group_by');
    expect(tray.entries).toEqual([]);
  });

  it('passes group_by through as a query parameter', async () => {
    const fetchImpl = mockFetch(json({ entries: [], groups: [] }));
    await clientWith(fetchImpl).structureTray('c1', { groupBy: 'candidate' });
    expect(requestUrl(fetchImpl)).toContain('group_by=candidate');
  });

  it('posts an assignment by container id', async () => {
    const fetchImpl = mockFetch(
      json({
        event: {
          id: 'evt-9',
          document_id: 'doc-1',
          container_id: 'pack-1',
          actor: 'human',
          rationale: 'belongs to Acme',
          created_at: '2026-08-01T00:00:00Z',
        },
        container_id: 'pack-1',
        locked: true,
        partition_key: 'acme',
      }),
    );

    const result = await clientWith(fetchImpl).assignDocument('c1', {
      document_id: 'doc-1',
      container_id: 'pack-1',
      rationale: 'belongs to Acme',
    });

    expect(requestUrl(fetchImpl)).toContain('/api/v1/corpuses/c1/structure/assignments');
    expect(requestBody(fetchImpl)).toEqual({
      document_id: 'doc-1',
      container_id: 'pack-1',
      rationale: 'belongs to Acme',
    });
    expect(result.locked).toBe(true);
    expect(result.partition_key).toBe('acme');
  });

  it('posts an assignment by level values', async () => {
    const fetchImpl = mockFetch(
      json({
        event: {
          id: 'evt-9',
          document_id: 'doc-1',
          container_id: 'pack-3',
          actor: 'human',
          rationale: null,
          created_at: '2026-08-01T00:00:00Z',
        },
        container_id: 'pack-3',
        locked: true,
        partition_key: 'q3',
      }),
    );

    await clientWith(fetchImpl).assignDocument('c1', {
      document_id: 'doc-1',
      level_values: ['Acme Pty Ltd', 'Q3'],
    });
    expect(requestBody(fetchImpl)).toEqual({
      document_id: 'doc-1',
      level_values: ['Acme Pty Ltd', 'Q3'],
    });
  });

  it('triggers a rerun with an empty body by default', async () => {
    const fetchImpl = mockFetch(
      json({ run_id: 'r1', status: 'queued', pipeline_id: 'p1', trigger_kind: 'manual' }),
    );
    const run = await clientWith(fetchImpl).rerunStructure('c1');
    expect(requestUrl(fetchImpl)).toContain('/api/v1/corpuses/c1/structure/rerun');
    expect(requestBody(fetchImpl)).toEqual({});
    expect(run.run_id).toBe('r1');
  });

  it('scopes a rerun to specific documents', async () => {
    const fetchImpl = mockFetch(
      json({
        run_id: 'r1',
        status: 'queued',
        pipeline_id: 'p1',
        trigger_kind: 'manual',
        document_ids: ['doc-1'],
      }),
    );
    await clientWith(fetchImpl).rerunStructure('c1', { document_ids: ['doc-1'] });
    expect(requestBody(fetchImpl)).toEqual({ document_ids: ['doc-1'] });
  });

  // A corpus that does not organise by structure is a property of the corpus,
  // not a transient fault; the client must hand the 409 through untouched so
  // an application can route on the code.
  it('surfaces the 409 for a non-structure corpus with its code', async () => {
    const fetchImpl = mockFetch(
      json(
        { error: 'corpus c1 does not organise by structure', code: 'corpus_not_structured' },
        409,
      ),
    );
    const error = await clientWith(fetchImpl)
      .structure('c1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).status).toBe(409);
    expect((error as SerchaHttpError).code).toBe('corpus_not_structured');
  });

  // Everything on this surface is admin-gated: a default service account gets
  // 403 and the application is expected to degrade, so the error must arrive
  // recognisable rather than wrapped.
  it('surfaces the admin gate as a 403 SerchaHttpError', async () => {
    const fetchImpl = mockFetch(json({ error: 'admin required' }, 403));
    const error = await clientWith(fetchImpl)
      .assignDocument('c1', { document_id: 'doc-1', container_id: 'pack-1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).status).toBe(403);
    expect((error as SerchaHttpError).isAuthError).toBe(true);
  });
});

describe('structures 0.5.0 surface', () => {
  it('unwraps the real 202 from rerunStructure', async () => {
    // The 0.4.0 regression: the server answers 202, the transport tags it,
    // and rerunStructure handed callers {status, body} with run_id
    // undefined. This mock is a REAL 202 - the shipped test mocked 200 and
    // hid the bug.
    const fetch = mockFetch(
      json({ run_id: 'run-9', status: 'queued', pipeline_id: 'p1', trigger_kind: 'manual' }, 202),
    );
    const client = clientWith(fetch);
    const run = await client.rerunStructure('c1');
    expect(run.run_id).toBe('run-9');
    expect(run.status).toBe('queued');
  });

  it('passes the tray flag filter through', async () => {
    const fetch = mockFetch(json({ entries: null }));
    const client = clientWith(fetch);
    await client.structureTray('c1', { flag: 'duplicate_of' });
    expect(requestUrl(fetch, 0)).toContain('flag=duplicate_of');
  });

  it('posts a confirmation and returns the settled state', async () => {
    const fetch = mockFetch(
      json({
        event: {
          id: 'ev-1',
          document_id: 'doc-1',
          actor: 'human',
          rationale: 'same bytes',
          flag: 'duplicate_of',
          flag_payload: { primary_document_id: 'doc-0' },
          created_at: '2026-01-01T00:00:00Z',
        },
        locked: true,
        partition_key: '_unassigned',
      }),
    );
    const client = clientWith(fetch);
    const result = await client.confirmFlag('c1', {
      document_id: 'doc-1',
      flag: 'duplicate_of',
      target_document_id: 'doc-0',
      rationale: 'same bytes',
    });
    expect(requestUrl(fetch, 0)).toContain('/structure/flags');
    expect(requestBody(fetch, 0)).toMatchObject({
      document_id: 'doc-1',
      flag: 'duplicate_of',
      target_document_id: 'doc-0',
    });
    expect(result.locked).toBe(true);
    expect(result.event.flag).toBe('duplicate_of');
  });

  it('lists the archive and coalesces the null empty list', async () => {
    const fetch = mockFetch(json({ corpus_id: 'c1', count: 0, entries: null }));
    const client = clientWith(fetch);
    const archived = await client.structureArchived('c1');
    expect(requestUrl(fetch, 0)).toContain('/structure/archived');
    expect(archived.entries).toEqual([]);
  });
});

describe('stub structures', () => {
  function seeded() {
    return new StubSercha({
      structures: {
        c1: {
          packs: [
            pack({
              children: [
                pack({ id: 'pack-2', slug: 'q3', display_name: 'Q3', level_name: 'period' }),
              ],
            }),
          ],
          tray: [
            trayEntry(),
            trayEntry({
              document_id: 'doc-2',
              event_id: 'evt-2',
              flag: 'multi_tenancy',
              flag_payload: { candidate: 'acme' },
            }),
          ],
        },
      },
    });
  }

  it('answers 409 for a corpus with no structure fixture, like a real non-structure corpus', async () => {
    const error = await seeded()
      .structure('other')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SerchaHttpError);
    expect((error as SerchaHttpError).status).toBe(409);
    expect((error as SerchaHttpError).code).toBe('corpus_not_structured');
  });

  it('reports the tray count and needs_review while entries remain', async () => {
    const structure = await seeded().structure('c1');
    expect(structure.tray_count).toBe(2);
    expect(structure.structure_state).toBe('needs_review');
  });

  it('locks an assignment and returns the pack slug as the partition key', async () => {
    const sercha = seeded();
    const result = await sercha.assignDocument('c1', {
      document_id: 'doc-1',
      container_id: 'pack-2',
    });

    expect(result.locked).toBe(true);
    expect(result.partition_key).toBe('q3');
    expect(result.event.actor).toBe('human');
    expect(sercha.stubStructureState('c1').assignments['doc-1']).toEqual({
      container_id: 'pack-2',
      locked: true,
    });
  });

  it('resolves level values through the tree by slug or display name', async () => {
    const result = await seeded().assignDocument('c1', {
      document_id: 'doc-1',
      level_values: ['Acme Pty Ltd', 'q3'],
    });
    expect(result.container_id).toBe('pack-2');
    expect(result.partition_key).toBe('q3');
  });

  it('consumes the tray entry once a human places the document', async () => {
    const sercha = seeded();
    await sercha.assignDocument('c1', { document_id: 'doc-1', container_id: 'pack-1' });

    const tray = await sercha.structureTray('c1');
    expect(tray.entries.map((e) => e.document_id)).toEqual(['doc-2']);
    expect((await sercha.structure('c1')).tray_count).toBe(1);
  });

  // Humans can re-repair: the second placement wins and the lock stays, so a
  // rerun still cannot move the document.
  it('lets a second human assignment update the pack and stay locked', async () => {
    const sercha = seeded();
    await sercha.assignDocument('c1', { document_id: 'doc-1', container_id: 'pack-1' });
    const second = await sercha.assignDocument('c1', {
      document_id: 'doc-1',
      container_id: 'pack-2',
    });

    expect(second.locked).toBe(true);
    expect(sercha.stubStructureState('c1').assignments['doc-1']).toEqual({
      container_id: 'pack-2',
      locked: true,
    });
    expect(sercha.stubStructureState('c1').events).toHaveLength(2);
  });

  it('rejects an assignment to a pack that does not exist', async () => {
    await expect(
      seeded().assignDocument('c1', { document_id: 'doc-1', container_id: 'nope' }),
    ).rejects.toThrow(/no pack/);
  });

  it('rerun returns a queued run and leaves locked assignments untouched', async () => {
    const sercha = seeded();
    await sercha.assignDocument('c1', { document_id: 'doc-1', container_id: 'pack-1' });

    const run = await sercha.rerunStructure('c1', { document_ids: ['doc-1'] });
    expect(run.run_id).toMatch(/^stub-structure-run-/);
    expect(run.document_ids).toEqual(['doc-1']);
    expect(sercha.stubStructureState('c1').assignments['doc-1']).toEqual({
      container_id: 'pack-1',
      locked: true,
    });
  });

  it('groups the tray by candidate when asked', async () => {
    const tray = await seeded().structureTray('c1', { groupBy: 'candidate' });
    expect(tray.entries).toHaveLength(2);
    // Wire ordering, not lexicographic: the '' bucket (entries naming no
    // candidate) sorts LAST so the actionable clusters lead.
    const candidates = tray.groups?.map((g) => g.candidate);
    expect(candidates).toEqual(['acme', '']);
  });
});
