/** D-120 Phase 4 — `data.memory.*` namespace exposure (contracts).
 *
 *  Substrate-only assertions:
 *    - `MEMORY_DATA_SUBNAMESPACE` + `MEMORY_DATA_ALIAS_SUBNAMESPACE`
 *    - `MEMORY_DATA_SUBNAMESPACES` set membership + `isMemoryDataSubnamespace`
 *    - resolver alias collapses `data.audit.*` onto `data.memory.*`
 *    - `parseDataEntityRef` continues to reject both names (no link emission
 *      for the read-only memory surface)
 */

import { describe, expect, it } from 'vitest';
import {
  MEMORY_DATA_ALIAS_SUBNAMESPACE,
  MEMORY_DATA_SUBNAMESPACE,
  MEMORY_DATA_SUBNAMESPACES,
  MEMORY_READ_PERMISSION,
  collectRefs,
  isMemoryDataSubnamespace,
  parseDataEntityRef,
  resolveRef,
  type NamespaceStores,
} from '../index.js';

describe('D-120 Phase 4 — memory namespace constants', () => {
  it('exports the canonical sub-namespace literal', () => {
    expect(MEMORY_DATA_SUBNAMESPACE).toBe('memory');
  });

  it('exports the deprecated audit alias', () => {
    expect(MEMORY_DATA_ALIAS_SUBNAMESPACE).toBe('audit');
  });

  it('declares both names as memory data sub-namespaces', () => {
    expect(MEMORY_DATA_SUBNAMESPACES.has('memory')).toBe(true);
    expect(MEMORY_DATA_SUBNAMESPACES.has('audit')).toBe(true);
  });

  it('rejects unrelated sub-names', () => {
    expect(isMemoryDataSubnamespace('shared')).toBe(false);
    expect(isMemoryDataSubnamespace('mail')).toBe(false);
    expect(isMemoryDataSubnamespace('calendar')).toBe(false);
    expect(isMemoryDataSubnamespace('annotation')).toBe(false);
    expect(isMemoryDataSubnamespace('')).toBe(false);
  });

  it('exposes the staged-trust permission slug', () => {
    expect(MEMORY_READ_PERMISSION).toBe('read_memory');
  });
});

describe('D-120 Phase 4 — resolver alias (data.audit.* → data.memory.*)', () => {
  const stores: NamespaceStores = {
    vault: {},
    config: {},
    context: {},
    meta: {},
    step: {},
    data: {
      memory: {
        'run-1': { recipe_id: 'r1', commit_status: 'succeeded', started_at: 100 },
        'run-2': { recipe_id: 'r1', commit_status: 'failed', started_at: 200 },
      },
    },
  };

  it('resolves data.memory.<id> to the entry', () => {
    expect(resolveRef('{{data.memory.run-1}}', stores)).toEqual({
      recipe_id: 'r1',
      commit_status: 'succeeded',
      started_at: 100,
    });
  });

  it('resolves data.audit.<id> to the same entry as data.memory.<id>', () => {
    expect(resolveRef('{{data.audit.run-1}}', stores))
      .toEqual(resolveRef('{{data.memory.run-1}}', stores));
  });

  it('resolves nested fields uniformly across both names', () => {
    expect(resolveRef('{{data.memory.run-1.commit_status}}', stores)).toBe('succeeded');
    expect(resolveRef('{{data.audit.run-1.commit_status}}', stores)).toBe('succeeded');
    expect(resolveRef('{{data.memory.run-2.started_at}}', stores)).toBe(200);
    expect(resolveRef('{{data.audit.run-2.started_at}}', stores)).toBe(200);
  });

  it('returns undefined for missing entries through both names', () => {
    expect(resolveRef('{{data.memory.run-99}}', stores)).toBeUndefined();
    expect(resolveRef('{{data.audit.run-99}}', stores)).toBeUndefined();
  });

  it('does not alias other data sub-namespaces (mail / calendar untouched)', () => {
    const mailStores: NamespaceStores = {
      vault: {},
      config: {},
      context: {},
      meta: {},
      step: {},
      data: {
        mail: { 'msg-1': { subject: 'hi' } },
      },
    };
    expect(resolveRef('{{data.mail.msg-1.subject}}', mailStores)).toBe('hi');
  });
});

describe('D-120 Phase 4 — collectRefs alias collapse', () => {
  it('rewrites data.audit.* onto data.memory.* during ref collection', () => {
    const refs = collectRefs({
      a: '{{data.audit.run-1.commit_status}}',
      b: '{{data.memory.run-1.commit_status}}',
    });
    // Both refs collapse onto the same {ns, path} entry — the second
    // ref dedupes and we get exactly one result.
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ ns: 'data', path: 'memory.run-1.commit_status' });
  });

  it('preserves other ref shapes unchanged after alias rewrite', () => {
    const refs = collectRefs({
      a: '{{data.audit.run-1}}',
      b: '{{config.threshold}}',
      c: '{{step.score}}',
    });
    const sorted = refs.map((r) => `${r.ns}.${r.path}`).sort();
    expect(sorted).toEqual([
      'config.threshold',
      'data.memory.run-1',
      'step.score',
    ]);
  });
});

describe('D-120 Phase 4 — link emission gates (regression)', () => {
  it('parseDataEntityRef rejects audit + memory (no self-linking)', () => {
    expect(parseDataEntityRef('data', 'audit.run-1')).toBeNull();
    expect(parseDataEntityRef('data', 'memory.run-1')).toBeNull();
  });

  it('still parses warehouse collections normally', () => {
    expect(parseDataEntityRef('data', 'mail.msg-1.subject')).toEqual({
      collection: 'mail',
      entity_id: 'msg-1',
    });
  });
});
