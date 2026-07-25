/** D-192 P3b - projector coverage for canonical coercions, required row signals,
 * preview/extension/relationship bounds, hash stability, version timestamps, tombstones, and the P6 note lanes. */

import {
  TASK_TITLE_MAX,
  WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS,
  WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS,
  type WorkEntitySourceSync,
} from '@recued/contracts';
import { STRIP_HTML_MAX_INPUT } from '@recued/transforms';
import { describe, expect, it } from 'vitest';

import {
  KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS,
} from '../work-entity-source-boot.js';
import {
  isSourceRowTombstoned,
  projectWorkEntitySourceRow,
  workEntitySourceVersionToken,
  type WorkEntityProjectionDeclaration,
} from '../work-entity-source-projector.js';

const SOURCE = 'hubspot.acme.task';
const CONNECTION = 'acme';
const RECORD = 'remote-1';
const ISO_DUE = '2026-07-02T00:00:00.000Z';
const ISO_UPDATED = '2026-07-01T12:00:00.000Z';

const taskDeclaration = (
  overrides: Partial<WorkEntityProjectionDeclaration> = {},
): WorkEntityProjectionDeclaration => ({
  kind: 'task',
  remote: {
    entity: 'task',
    id: 'id',
    version: { kind: 'updated_at', field: 'updatedAt' },
    hash_fields: ['title', 'done', 'state', 'priority', 'due', 'body'],
  },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'native',
    tombstone_field: 'archived',
    stale_after_ms: 21_600_000,
  },
  projection: {
    canonical: {
      title: 'properties.title',
      state: 'properties.state',
      priority: 'properties.priority',
      due_at: 'properties.due',
    },
  },
  ...overrides,
});

const projectDeclaration = (
  overrides: Partial<WorkEntityProjectionDeclaration> = {},
): WorkEntityProjectionDeclaration => ({
  kind: 'project',
  remote: {
    entity: 'project',
    id: 'id',
    version: { kind: 'updated_at', field: 'updatedAt' },
    hash_fields: ['title', 'state', 'target'],
  },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 21_600_000,
  },
  projection: {
    canonical: {
      title: 'name',
      state: 'status',
    },
  },
  ...overrides,
});

const noteDeclaration = (): WorkEntityProjectionDeclaration => ({
  kind: 'note',
  remote: {
    entity: 'note',
    id: 'id',
    version: { kind: 'updated_at', field: 'updatedAt' },
    hash_fields: ['title'],
  },
  sync: {
    mode: 'read_only',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 21_600_000,
  },
  projection: {
    canonical: { title: 'title' },
  },
});

const runProjector = (
  declaration: WorkEntityProjectionDeclaration,
  raw: Record<string, unknown>,
) =>
  projectWorkEntitySourceRow({
    declaration,
    source_id: SOURCE,
    connection_name: CONNECTION,
    source_record_id: RECORD,
    raw,
  });

const expectOk = (
  result: ReturnType<typeof projectWorkEntitySourceRow>,
): Extract<ReturnType<typeof projectWorkEntitySourceRow>, { ok: true }> => {
  if (!result.ok) throw new Error(`expected projector success, got ${result.reason}`);
  return result;
};

const expectFailed = (
  result: ReturnType<typeof projectWorkEntitySourceRow>,
): Extract<ReturnType<typeof projectWorkEntitySourceRow>, { ok: false }> => {
  if (result.ok) throw new Error('expected projector failure');
  return result;
};

const expectTaskWrite = (
  result: ReturnType<typeof projectWorkEntitySourceRow>,
) => {
  const out = expectOk(result);
  if (out.upsert.kind !== 'task') throw new Error(`expected task projection, got ${out.upsert.kind}`);
  return out.upsert.write;
};

const expectProjectWrite = (
  result: ReturnType<typeof projectWorkEntitySourceRow>,
) => {
  const out = expectOk(result);
  if (out.upsert.kind !== 'project') throw new Error(`expected project projection, got ${out.upsert.kind}`);
  return out.upsert.write;
};

const taskRaw = (
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: RECORD,
  updatedAt: ISO_UPDATED,
  properties,
  ...extra,
});

describe('projectWorkEntitySourceRow', () => {
  it('projects the kernel HubSpot task declaration from nested properties paths', () => {
    const declaration = KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS.hubspot[0];
    const write = expectTaskWrite(runProjector(declaration, {
      id: RECORD,
      updatedAt: ISO_UPDATED,
      archived: false,
      properties: {
        hs_task_subject: 'Call Alice',
        hs_task_status: 'IN_PROGRESS',
        hs_task_priority: 'LOW',
        hs_timestamp: ISO_DUE,
      },
    }));

    expect(write).toMatchObject({
      title: 'Call Alice',
      state: 'IN_PROGRESS',
      priority: 'low',
      due_at: Date.parse(ISO_DUE),
      source_id: SOURCE,
      source_record_id: RECORD,
      connection_id: CONNECTION,
      source_updated_at: Date.parse(ISO_UPDATED),
    });
  });

  it.each([
    ['ISO string', ISO_DUE, Date.parse(ISO_DUE)],
    ['epoch-ms digit string', '1793664000000', 1_793_664_000_000],
    ['number', 1_793_664_000_123, 1_793_664_000_123],
  ])('coerces due_at from %s', (_label, value, expected) => {
    const write = expectTaskWrite(runProjector(taskDeclaration(), taskRaw({
      title: 'Due task',
      state: 'OPEN',
      due: value,
    })));

    expect(write.due_at).toBe(expected);
  });

  it.each([
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
  ])('coerces done from %s', (value, expected) => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', done: 'done' } },
    }), {
      title: 'Done task',
      done: value,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.done).toBe(expected);
  });

  it.each([
    [100, true],
    [50, false],
    ['100', true],
    ['50', false],
  ])('derives done with number_equals from percentComplete %s', (percentComplete, expected) => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: 'title',
          done: { kind: 'number_equals', field: 'percentComplete', value: 100 },
        },
      },
    }), {
      title: `Derived completion ${String(percentComplete)}`,
      percentComplete,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.done).toBe(expected);
    expect('done' in write).toBe(true);
  });

  it('fails a derived-done task row when percentComplete is absent and no state lane exists', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: 'title',
          done: { kind: 'number_equals', field: 'percentComplete', value: 100 },
        },
      },
    }), {
      title: 'Missing derived completion',
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('completion signal');
  });

  it('fails a derived-done task row when percentComplete is non-numeric', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: 'title',
          done: { kind: 'number_equals', field: 'percentComplete', value: 100 },
        },
      },
    }), {
      title: 'Invalid derived completion',
      percentComplete: 'half of it',
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('derivation');
  });

  it('fails loud when validator drift puts a derivation on a non-derivable field', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: 'title',
          done: 'done',
          state: { kind: 'number_equals', field: 'percentComplete', value: 100 },
        },
      },
    }), {
      title: 'Drifted derivation',
      done: false,
      percentComplete: 100,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('inadmissible derivation');
  });

  it('uses the first usable title candidate when the primary is present and coercible', () => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.action'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: {
        note: 'Primary outreach note',
        action: 'fallback_action_slug',
      },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.title).toBe('Primary outreach note');
  });

  it.each([
    ['null', { note: null, action: 'Fallback title after null' }, 'Fallback title after null'],
    ['empty string', { note: '', action: 'Fallback title after empty' }, 'Fallback title after empty'],
    ['absent key', { action: 'Fallback title after missing' }, 'Fallback title after missing'],
  ])('falls back when the primary title candidate is %s', (_label, attributes, expected) => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.action'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes,
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.title).toBe(expected);
  });

  it('falls back when the primary title exceeds the task canonical cap', () => {
    const overCapPrimary = 'p'.repeat(TASK_TITLE_MAX + 1);
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.action'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: {
        note: overCapPrimary,
        action: 'outreach_action_fallback',
      },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.title).toBe('outreach_action_fallback');
  });

  it('fails the required-title check when every coalesce candidate is absent', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.action'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: { unrelated: 'non-title sentinel' },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('required canonical field');
  });

  it("reports the first candidate's coercion failure when no title candidate survives", () => {
    const firstCandidate = 'a'.repeat(TASK_TITLE_MAX + 11);
    const secondCandidate = 'b'.repeat(TASK_TITLE_MAX + 23);
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.action'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: {
        note: firstCandidate,
        action: secondCandidate,
      },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain(`${firstCandidate.length} chars`);
    expect(out.reason).not.toContain(`${secondCandidate.length} chars`);
  });

  it('fails loud when validator drift supplies a singleton coalesce', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: { note: 'Singleton candidate title' },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('inadmissible coalesce');
  });

  it('fails loud when validator drift puts a coalesce on a non-coalescable field', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: 'attributes.note',
          done: ['flags.primary', 'flags.fallback'],
        },
      },
    }), {
      attributes: { note: 'Non-coalescable done title' },
      flags: { primary: true, fallback: false },
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('inadmissible coalesce');
  });

  it('fails loud when validator drift puts a non-string entry in a coalesce', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 42] as unknown as string[],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: { note: 'String candidate before invalid entry' },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('inadmissible coalesce');
  });

  it('coerces a numeric fallback through the shared title text coercion seam', () => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.actionCode'],
          done: 'completionFlag',
        },
      },
    }), {
      attributes: { note: null, actionCode: 8675309 },
      completionFlag: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.title).toBe('8675309');
    expect(typeof write.title).toBe('string');
  });

  // ── CORE #8e — transform derivation (title ← strip_html(body)) ──
  const transformTitleDecl = () => taskDeclaration({
    projection: {
      canonical: {
        title: { kind: 'transform', field: 'properties.body', transform: 'strip_html' },
        state: 'properties.state',
      },
    },
  });

  it('derives a clean title from an HTML body via strip_html (CORE #8e)', () => {
    const write = expectTaskWrite(runProjector(transformTitleDecl(), taskRaw({
      body: '<p>Review <b>Q3</b> deck</p>',
      state: 'open',
    })));

    expect(write.title).toBe('Review Q3 deck');
  });

  it('decodes entities after stripping tags in a transform title (CORE #8e)', () => {
    const write = expectTaskWrite(runProjector(transformTitleDecl(), taskRaw({
      body: '<p>3 &lt; 5 &amp; ok</p>',
      state: 'open',
    })));

    expect(write.title).toBe('3 < 5 & ok');
  });

  it('fails the required-title check when the transform source is absent (CORE #8e)', () => {
    const out = expectFailed(runProjector(transformTitleDecl(), taskRaw({ state: 'open' })));
    expect(out.reason).toContain('required canonical field');
  });

  it('fails the required-title check when an all-markup body strips to empty (CORE #8e)', () => {
    const out = expectFailed(runProjector(transformTitleDecl(), taskRaw({
      body: '<br/><hr/>',
      state: 'open',
    })));
    expect(out.reason).toContain('required canonical field');
  });

  it('fails the row on a present non-string transform source (no [object Object] title) (CORE #8e)', () => {
    const out = expectFailed(runProjector(transformTitleDecl(), taskRaw({
      body: { nested: 'markup' },
      state: 'open',
    })));
    expect(out.reason).toContain("expected text at 'properties.body'");
  });

  it('fails the row when the stripped transform title exceeds the canonical cap (CORE #8e)', () => {
    const out = expectFailed(runProjector(transformTitleDecl(), taskRaw({
      body: `<p>${'a'.repeat(TASK_TITLE_MAX + 50)}</p>`,
      state: 'open',
    })));
    expect(out.reason).toContain('exceeds the canonical cap');
  });

  it('fails closed when the transform input would clip (codex #8e fold) (CORE #8e)', () => {
    const out = expectFailed(runProjector(transformTitleDecl(), taskRaw({
      body: 'x'.repeat(STRIP_HTML_MAX_INPUT + 1),
      state: 'open',
    })));
    expect(out.reason).toContain('would clip to a truncated result');
  });

  it('fails loud when validator drift puts a transform on a non-transformable field (CORE #8e)', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: 'properties.title',
          state: { kind: 'transform', field: 'properties.body', transform: 'strip_html' },
        },
      },
    }), taskRaw({ title: 'Drifted transform', body: '<p>x</p>', state: 'open' })));

    expect(out.reason).toContain('inadmissible derivation');
  });

  it('fails loud when validator drift names an unknown transform (CORE #8e)', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: {
          title: { kind: 'transform', field: 'properties.body', transform: 'nope' } as never,
          state: 'properties.state',
        },
      },
    }), taskRaw({ body: '<p>x</p>', state: 'open' })));

    expect(out.reason).toContain("unknown canonical transform 'nope'");
  });

  it.each([
    [12.4, 12, true],
    [12.5, 13, true],
    [0, 0, true],
    [100, 100, true],
    [-1, undefined, false],
    [101, undefined, false],
  ])('coerces progress %s', (value, expected, ok) => {
    const out = runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', done: 'done', progress: 'progress' } },
    }), {
      title: 'Progress task',
      done: false,
      progress: value,
      updatedAt: ISO_UPDATED,
    });

    if (ok) expect(expectTaskWrite(out).progress).toBe(expected);
    else expect(expectFailed(out).reason).toContain('outside');
  });

  it.each([
    ['LOW', 'low'],
    ['Normal', 'medium'],
    ['Highest', 'high'],
    ['wibble', undefined],
    [7, undefined],
  ])('maps priority vocabulary value %s', (value, expected) => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', done: 'done', priority: 'priority' } },
    }), {
      title: 'Priority task',
      done: false,
      priority: value,
      updatedAt: ISO_UPDATED,
    }));

    if (expected === undefined) expect('priority' in write).toBe(false);
    else expect(write.priority).toBe(expected);
  });

  it.each([
    ['absent title', {}, 'required canonical field'],
    ['over-cap title', { title: 'x'.repeat(TASK_TITLE_MAX + 1), done: false }, 'canonical cap'],
  ])('fails when %s', (_label, fields, reason) => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', done: 'done' } },
    }), {
      ...fields,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain(reason);
  });

  it('fails task rows with no completion signal after projection', () => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', due_at: 'due' } },
    }), {
      title: 'Missing completion signal',
      due: ISO_DUE,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain('completion signal');
  });

  it.each([
    ['Open', 'active'],
    ['On Hold', 'paused'],
    ['Done', 'completed'],
    ['cancelled', 'archived'],
  ])('maps project state %s', (value, expected) => {
    const write = expectProjectWrite(runProjector(projectDeclaration(), {
      id: RECORD,
      name: 'Launch',
      status: value,
      updatedAt: ISO_UPDATED,
    }));

    expect(write.state).toBe(expected);
  });

  it.each([
    ['unmapped state', { name: 'Launch', status: 'wibble' }, 'maps to no canonical project state'],
    ['absent state', { name: 'Launch' }, 'required canonical field is absent'],
  ])('fails project rows with %s', (_label, raw, reason) => {
    expect(expectFailed(runProjector(projectDeclaration(), {
      id: RECORD,
      updatedAt: ISO_UPDATED,
      ...raw,
    })).reason).toContain(reason);
  });

  it('clamps present preview fields and marks fidelity exactly for present keys', () => {
    const out = expectOk(runProjector(taskDeclaration({
      projection: {
        canonical: { title: 'title', done: 'done' },
        preview: {
          body: { field: 'body', max_chars: 5 },
          notes: { field: 'notes', max_chars: 5 },
        },
      },
    }), {
      title: 'Preview task',
      done: false,
      body: 'abcdefghi',
      updatedAt: ISO_UPDATED,
    }));

    expect(out.upsert.write.source_extension_blob).toEqual({
      preview: { body: 'abcde' },
      detail_fidelity: { body: 'preview' },
    });
  });

  it('omits preview and fidelity when preview values are absent', () => {
    const out = expectOk(runProjector(taskDeclaration({
      projection: {
        canonical: { title: 'title', done: 'done' },
        preview: { body: { field: 'body', max_chars: 5 } },
      },
    }), {
      title: 'No preview',
      done: false,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.upsert.write.source_extension_blob).toBeUndefined();
  });

  it('accepts bounded extension scalars', () => {
    const out = expectOk(runProjector(taskDeclaration({
      projection: {
        canonical: { title: 'title', done: 'done' },
        extension: { vendor_status: 'status' },
      },
    }), {
      title: 'Extension task',
      done: false,
      status: 'queued',
      updatedAt: ISO_UPDATED,
    }));

    expect(out.upsert.write.source_extension_blob).toEqual({ vendor_status: 'queued' });
  });

  it.each([
    ['string over scalar cap', 'value', 'x'.repeat(WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS + 1), 'string'],
    ['array over item cap', 'value', Array.from({ length: WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS + 1 }, (_, i) => i), 'array'],
    ['depth over cap', 'value', { a: { b: { c: { d: 'x' } } } }, 'nesting'],
    [
      'serialized blob over 8 KiB',
      'value',
      Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, 'x'.repeat(200)])),
      'serializes',
    ],
  ])('fails extension lane for %s', (_label, field, value, reason) => {
    const out = expectFailed(runProjector(taskDeclaration({
      projection: {
        canonical: { title: 'title', done: 'done' },
        extension: { ext: field },
      },
    }), {
      title: 'Extension fail',
      done: false,
      [field]: value,
      updatedAt: ISO_UPDATED,
    }));

    expect(out.reason).toContain(reason);
  });

  it.each([
    [
      'one scalar',
      { parent: 'p1' },
      {
        rel_parent_project_id: {
          target: 'project',
          pairing: 'remote_id',
          remote_entity: 'project',
          value: 'p1',
        },
      },
      true,
    ],
    [
      'one numeric scalar',
      { parent: 42 },
      {
        rel_parent_project_id: {
          target: 'project',
          pairing: 'remote_id',
          remote_entity: 'project',
          value: '42',
        },
      },
      true,
    ],
    [
      'many array',
      { blockers: ['t1', 7] },
      {
        rel_blocks_task_ids: {
          target: 'task',
          pairing: 'remote_id',
          remote_entity: 'task',
          values: ['t1', '7'],
        },
      },
      true,
    ],
    ['absent', {}, undefined, true],
    ['array for one', { parent: ['p1'] }, undefined, false],
  ])('projects relationship hints for %s', (_label, rawRel, expectedBlob, ok) => {
    const out = runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', done: 'done' } },
      relationships: [
        {
          local_field: 'parent_project_id',
          remote_field: 'parent',
          target: 'project',
          remote_entity: 'project',
          pairing: 'remote_id',
          cardinality: 'one',
          write_back: false,
        },
        {
          local_field: 'blocks_task_ids',
          remote_field: 'blockers',
          target: 'task',
          remote_entity: 'task',
          pairing: 'remote_id',
          cardinality: 'many',
          write_back: false,
        },
      ],
    }), {
      title: 'Relationship task',
      done: false,
      updatedAt: ISO_UPDATED,
      ...rawRel,
    });

    if (!ok) {
      expect(expectFailed(out).reason).toContain('cardinality-one');
      return;
    }
    expect(expectOk(out).upsert.write.source_extension_blob).toEqual(expectedBlob);
  });

  it('hashes stored payload only: stable for same row, changed by extension, not changed by source_updated_at', () => {
    const declaration = taskDeclaration({
      projection: {
        canonical: { title: 'title', done: 'done' },
        extension: { ext: 'ext' },
      },
    });
    const first = expectOk(runProjector(declaration, {
      title: 'Hash task',
      done: false,
      ext: 'a',
      updatedAt: '2026-07-01T00:00:00.000Z',
    })).upsert.write;
    const same = expectOk(runProjector(declaration, {
      title: 'Hash task',
      done: false,
      ext: 'a',
      updatedAt: '2026-07-01T00:00:00.000Z',
    })).upsert.write;
    const changedExt = expectOk(runProjector(declaration, {
      title: 'Hash task',
      done: false,
      ext: 'b',
      updatedAt: '2026-07-01T00:00:00.000Z',
    })).upsert.write;
    const changedVersion = expectOk(runProjector(declaration, {
      title: 'Hash task',
      done: false,
      ext: 'a',
      updatedAt: '2026-07-01T01:00:00.000Z',
    })).upsert.write;

    expect(first.source_record_hash).toBe(same.source_record_hash);
    expect(first.source_record_hash).not.toBe(changedExt.source_record_hash);
    expect(first.source_record_hash).toBe(changedVersion.source_record_hash);
    expect(first.source_updated_at).not.toBe(changedVersion.source_updated_at);
  });

  it('hashes derived completion changes for tokenless rows and stays stable for identical rows', () => {
    const declaration = taskDeclaration({
      remote: {
        ...taskDeclaration().remote,
        version: { kind: 'none' },
      },
      projection: {
        canonical: {
          title: 'title',
          done: { kind: 'number_equals', field: 'percentComplete', value: 100 },
        },
      },
    });
    const incomplete = expectTaskWrite(runProjector(declaration, {
      title: 'Tokenless hash task',
      percentComplete: 50,
    }));
    const same = expectTaskWrite(runProjector(declaration, {
      title: 'Tokenless hash task',
      percentComplete: 50,
    }));
    const complete = expectTaskWrite(runProjector(declaration, {
      title: 'Tokenless hash task',
      percentComplete: 100,
    }));

    expect(incomplete.source_record_hash).toBe(same.source_record_hash);
    expect(incomplete.source_record_hash).not.toBe(complete.source_record_hash);
  });

  it.each([
    ['ISO version', ISO_UPDATED, Date.parse(ISO_UPDATED), true],
    ['absent version', undefined, undefined, true],
    ['unparseable version', 'nope', undefined, false],
  ])('handles source_updated_at from %s', (_label, version, expected, ok) => {
    const raw: Record<string, unknown> = {
      title: 'Version task',
      done: false,
    };
    if (version !== undefined) raw.updatedAt = version;
    const out = runProjector(taskDeclaration({
      projection: { canonical: { title: 'title', done: 'done' } },
    }), raw);

    if (!ok) expect(expectFailed(out).reason).toContain('remote.version');
    else expect(expectOk(out).upsert.write.source_updated_at).toBe(expected);
  });

  it("omits source version fields when remote.version kind is 'none'", () => {
    const write = expectTaskWrite(runProjector(taskDeclaration({
      remote: {
        ...taskDeclaration().remote,
        version: { kind: 'none' },
      },
      projection: {
        canonical: {
          title: 'title',
          done: { kind: 'number_equals', field: 'percentComplete', value: 100 },
        },
      },
    }), {
      title: 'Tokenless projection',
      percentComplete: 100,
      updatedAt: ISO_UPDATED,
    }));

    expect(write).not.toHaveProperty('source_version_token');
    expect(write).not.toHaveProperty('source_updated_at');
  });

  it("keeps remote.version kind 'none' tokenless under declaration drift", () => {
    const version = { kind: 'none', field: 'updatedAt' } as const;
    const raw = {
      title: 'Drifted tokenless projection',
      done: false,
      updatedAt: 'must-not-become-a-token',
    };

    expect(workEntitySourceVersionToken(version, raw)).toBeUndefined();
    const write = expectTaskWrite(runProjector(taskDeclaration({
      remote: {
        ...taskDeclaration().remote,
        version,
      },
      projection: { canonical: { title: 'title', done: 'done' } },
    }), raw));
    expect(write).not.toHaveProperty('source_version_token');
  });

  it('projects note rows with an empty canonical body — remote text rides the preview lane (P6)', () => {
    const decl = noteDeclaration();
    decl.projection.preview = { body: { field: 'content', max_chars: 100 } };
    decl.projection.extension = { detail_fidelity: 'preview' };
    const out = expectOk(runProjector(decl, {
      id: RECORD,
      title: 'Kickoff notes',
      content: 'Long remote note content the mirror must never treat as complete.',
      updatedAt: ISO_UPDATED,
    }));
    if (out.upsert.kind !== 'note') throw new Error('expected a note upsert');
    expect(out.upsert.write.title).toBe('Kickoff notes');
    // The canonical long-body column NEVER receives remote text.
    expect(out.upsert.write.body).toBe('');
    const blob = out.upsert.write.source_extension_blob as Record<string, Record<string, unknown>>;
    expect(blob.preview?.body).toBe('Long remote note content the mirror must never treat as complete.');
    expect(blob.detail_fidelity?.body).toBe('preview');
    expect(out.upsert.write.source_updated_at).toBe(Date.parse(ISO_UPDATED));
  });

  it('projects a title-less note row — a note has no required canonical field', () => {
    const out = expectOk(runProjector(noteDeclaration(), {
      id: RECORD,
      updatedAt: ISO_UPDATED,
    }));
    if (out.upsert.kind !== 'note') throw new Error('expected a note upsert');
    expect(out.upsert.write.title).toBeUndefined();
    expect(out.upsert.write.body).toBe('');
  });
});

describe('isSourceRowTombstoned', () => {
  const nativeSync: WorkEntitySourceSync = {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'native',
    tombstone_field: 'archived',
    stale_after_ms: 21_600_000,
  };

  it.each([
    [true, true],
    ['true', true],
    [1, true],
    ['active', false],
    ['yes', false],
    ['random truthy string', false],
  ])('reads native tombstone marker %s as %s', (value, expected) => {
    expect(isSourceRowTombstoned(nativeSync, { archived: value })).toBe(expected);
  });

  it('returns false when tombstones are none, the tombstone field is missing, or the field is absent', () => {
    expect(isSourceRowTombstoned({
      ...nativeSync,
      tombstones: 'none',
    }, { archived: true })).toBe(false);
    expect(isSourceRowTombstoned({
      mode: 'read_write',
      depth: 'meta',
      tombstones: 'native',
      stale_after_ms: 21_600_000,
    }, { archived: true })).toBe(false);
    expect(isSourceRowTombstoned(nativeSync, {})).toBe(false);
  });
});
