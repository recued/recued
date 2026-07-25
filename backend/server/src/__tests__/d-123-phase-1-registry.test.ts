/** D-123 Phase 1 — Registry + topo-sort tests. */

import { describe, expect, it } from 'vitest';

import type { HousekeepingStepResult } from '@recued/contracts';

import {
  createHousekeepingRegistry,
  type HousekeepingTaskInstance,
} from '../housekeeping/registry.js';

const stub = (
  id: string,
  depends_on: ReadonlyArray<string> = [],
): HousekeepingTaskInstance => ({
  meta: {
    id,
    description: `stub task ${id}`,
    interruptible: true,
    kind: 'core',
    ...(depends_on.length > 0 ? { depends_on } : {}),
  },
  async step(): Promise<HousekeepingStepResult> {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

describe('createHousekeepingRegistry', () => {
  it('register / get / list round-trip', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('audit-compaction'));
    reg.register(stub('link-discovery'));
    expect(reg.list().map((t) => t.meta.id).sort()).toEqual([
      'audit-compaction',
      'link-discovery',
    ]);
    expect(reg.get('audit-compaction')?.meta.id).toBe('audit-compaction');
    expect(reg.get('missing')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('audit-compaction'));
    expect(() => reg.register(stub('audit-compaction'))).toThrow(
      /already registered/,
    );
  });

  it('unregister removes the entry', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('audit-compaction'));
    reg.unregister('audit-compaction');
    expect(reg.get('audit-compaction')).toBeUndefined();
  });
});

describe('topoSort', () => {
  it('returns an empty list when no tasks registered', () => {
    const reg = createHousekeepingRegistry();
    expect(reg.topoSort()).toEqual([]);
  });

  it('orders independent tasks lexicographically by id', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('z'));
    reg.register(stub('a'));
    reg.register(stub('m'));
    expect(reg.topoSort().map((t) => t.meta.id)).toEqual(['a', 'm', 'z']);
  });

  it('honours a linear depends_on chain', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('alias-suggester', ['contact-dedupe-sanitizer']));
    reg.register(stub('contact-dedupe-sanitizer'));
    expect(reg.topoSort().map((t) => t.meta.id)).toEqual([
      'contact-dedupe-sanitizer',
      'alias-suggester',
    ]);
  });

  it('honours a diamond dependency graph', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('d', ['b', 'c']));
    reg.register(stub('c', ['a']));
    reg.register(stub('b', ['a']));
    reg.register(stub('a'));
    const ids = reg.topoSort().map((t) => t.meta.id);
    expect(ids[0]).toBe('a');
    expect(ids[ids.length - 1]).toBe('d');
    // b before d, c before d
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
  });

  it('throws on cycle', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('a', ['b']));
    reg.register(stub('b', ['a']));
    expect(() => reg.topoSort()).toThrow(/cycle detected/);
  });

  it('excludes tasks with missing dependencies but does not throw', () => {
    const reg = createHousekeepingRegistry();
    reg.register(stub('alias-suggester', ['missing-dep']));
    reg.register(stub('audit-compaction'));
    const ids = reg.topoSort().map((t) => t.meta.id);
    expect(ids).toEqual(['audit-compaction']);
  });
});
