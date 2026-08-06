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

  it('⛔ D-231 — data.audit.* reads its OWN store, not data.memory.*', () => {
    // The intent of the retired alias test was "both names reach the audit
    // log", which was right while audit WAS the memory substrate. D-198 split
    // the stores; D-231 removed the rewrite. The assertion inverts: a
    // `data.audit.*` ref must NOT fall through to `data.memory.*`, or a recipe
    // asking for run history silently gets the owner's private notes.
    expect(resolveRef('{{data.audit.run-1}}', stores)).toBeUndefined();

    const withAudit: NamespaceStores = {
      ...stores,
      data: {
        ...(stores.data as Record<string, unknown>),
        audit: { 'run-1': { recipe_id: 'r1', commit_status: 'succeeded', started_at: 100 } },
      },
    };
    expect(resolveRef('{{data.audit.run-1.commit_status}}', withAudit)).toBe('succeeded');
  });

  it('the two namespaces hold DIFFERENT values under the same key', () => {
    // The sharpest statement of the split: same id, two stores, two answers.
    // Under the alias these were provably equal; now they must not be.
    const both: NamespaceStores = {
      ...stores,
      data: {
        memory: { 'k1': { kind: 'note', summary: 'owner note' } },
        audit: { 'k1': { recipe_id: 'r1', commit_status: 'failed' } },
      },
    };
    expect(resolveRef('{{data.memory.k1.summary}}', both)).toBe('owner note');
    expect(resolveRef('{{data.audit.k1.commit_status}}', both)).toBe('failed');
    expect(resolveRef('{{data.memory.k1.commit_status}}', both)).toBeUndefined();
  });

  it('resolves nested fields under each name independently', () => {
    expect(resolveRef('{{data.memory.run-1.commit_status}}', stores)).toBe('succeeded');
    expect(resolveRef('{{data.memory.run-2.started_at}}', stores)).toBe(200);
  });

  it('returns undefined for missing entries', () => {
    expect(resolveRef('{{data.memory.run-99}}', stores)).toBeUndefined();
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
  it('⛔ D-231 — ref collection keeps the two namespaces DISTINCT', () => {
    // Under the alias these deduped to one entry. They must not now: a
    // prefetcher that saw one ref would fetch one store and leave the other
    // silently undefined.
    const refs = collectRefs({
      a: '{{data.audit.run-1.commit_status}}',
      b: '{{data.memory.run-1.commit_status}}',
    });
    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({ ns: 'data', path: 'audit.run-1.commit_status' });
    expect(refs).toContainEqual({ ns: 'data', path: 'memory.run-1.commit_status' });
  });

  it('preserves other ref shapes unchanged', () => {
    const refs = collectRefs({
      a: '{{data.audit.run-1}}',
      b: '{{config.threshold}}',
      c: '{{step.score}}',
    });
    expect(refs).toContainEqual({ ns: 'data', path: 'audit.run-1' });
    expect(refs).toContainEqual({ ns: 'config', path: 'threshold' });
    expect(refs).toContainEqual({ ns: 'step', path: 'score' });
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
