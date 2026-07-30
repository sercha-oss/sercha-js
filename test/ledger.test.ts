import { describe, expect, it } from 'vitest';
import { StubSercha } from '../src/testing/index.js';
import type { CreateLedgerRecordType } from '../src/types/ledger.js';

const TYPE: CreateLedgerRecordType = {
  ontology: 'lyft',
  name: 'Adjustment',
  kind: 'assertion',
  on_entity: 'PositionStatement',
  properties: [
    { key: 'account_label', value_type: 'string', is_key: true, required: true },
    { key: 'amount', value_type: 'float', required: true },
    {
      key: 'defensibility',
      value_type: 'string',
      required: true,
      enum_values: ['objective', 'supportable', 'advocacy'],
    },
  ],
};

async function seeded(): Promise<{ sercha: StubSercha; typeId: string }> {
  const sercha = new StubSercha();
  const type = await sercha.createRecordType(TYPE);
  return { sercha, typeId: type.id };
}

function record(typeId: string, over: Record<string, unknown> = {}) {
  return {
    subject_key: 'abc123',
    subject_corpus_id: 'corpus-1',
    record_type_id: typeId,
    values: { account_label: 'Restructuring Costs', amount: 185, defensibility: 'objective' },
    authority: 'derived' as const,
    ...over,
  };
}

describe('record types', () => {
  it('is discoverable once declared', async () => {
    const { sercha } = await seeded();
    const types = await sercha.recordTypes('lyft');
    expect(types).toHaveLength(1);
    expect(types[0]?.name).toBe('Adjustment');
    expect(types[0]?.properties).toHaveLength(3);
  });

  it('is scoped to its ontology', async () => {
    const { sercha } = await seeded();
    expect(await sercha.recordTypes('other')).toHaveLength(0);
  });

  it('refuses a redeclaration, because types are permanent', async () => {
    const { sercha } = await seeded();
    await expect(sercha.createRecordType(TYPE)).rejects.toThrow(/already declared/);
  });
});

describe('appending records', () => {
  it('carries typed values and the declared kind', async () => {
    const { sercha, typeId } = await seeded();
    const written = await sercha.appendRecord(record(typeId));
    expect(written.kind).toBe('assertion');
    expect(written.values.amount).toBe(185);
    expect(written.supersedes_id).toBeNull();
  });

  it('refuses a record with no subject key', async () => {
    const { sercha, typeId } = await seeded();
    await expect(sercha.appendRecord(record(typeId, { subject_key: '' }))).rejects.toThrow(
      /subject_key/,
    );
  });

  it('refuses a subject key with no corpus, since subjects are corpus-scoped', async () => {
    const { sercha, typeId } = await seeded();
    await expect(sercha.appendRecord(record(typeId, { subject_corpus_id: '' }))).rejects.toThrow(
      /subject_corpus_id/,
    );
  });

  it('refuses an undeclared record type', async () => {
    const { sercha } = await seeded();
    await expect(sercha.appendRecord(record('rt_nonexistent'))).rejects.toThrow(
      /Declare it with createRecordType/,
    );
  });

  it('defaults confidence to null, because a human is not calibrated', async () => {
    const { sercha, typeId } = await seeded();
    const written = await sercha.appendRecord(record(typeId));
    expect(written.confidence).toBeNull();
  });
});

describe('correction', () => {
  it('writes a new record and leaves the original intact', async () => {
    const { sercha, typeId } = await seeded();
    const first = await sercha.appendRecord(record(typeId));
    const second = await sercha.supersedeRecord(
      first.id,
      record(typeId, {
        values: { account_label: 'Restructuring Costs', amount: 250, defensibility: 'objective' },
      }),
    );

    expect(second.supersedes_id).toBe(first.id);
    // The whole point: the superseded record is still readable afterwards.
    const original = await sercha.getRecord(first.id);
    expect(original.values.amount).toBe(185);
  });

  it('keeps chains linear by refusing a second supersede', async () => {
    const { sercha, typeId } = await seeded();
    const first = await sercha.appendRecord(record(typeId));
    await sercha.supersedeRecord(first.id, record(typeId));
    await expect(sercha.supersedeRecord(first.id, record(typeId))).rejects.toThrow(
      /already been superseded/,
    );
  });

  it('reads a subject history in order', async () => {
    const { sercha, typeId } = await seeded();
    const first = await sercha.appendRecord(record(typeId));
    await sercha.supersedeRecord(first.id, record(typeId));
    const history = await sercha.subjectHistory('abc123');
    expect(history).toHaveLength(2);
    expect(history[1]?.supersedes_id).toBe(first.id);
  });
});

describe('filtering', () => {
  it('narrows by subject and corpus', async () => {
    const { sercha, typeId } = await seeded();
    await sercha.appendRecord(record(typeId));
    await sercha.appendRecord(record(typeId, { subject_key: 'other' }));

    expect(await sercha.listRecords({ subject_key: 'abc123' })).toHaveLength(1);
    expect(await sercha.listRecords({ corpus_id: 'corpus-1' })).toHaveLength(2);
    expect(await sercha.listRecords({ corpus_id: 'nope' })).toHaveLength(0);
  });
});
