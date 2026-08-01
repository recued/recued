/** D-226 — `{{data.contact.<email>.rollups.<pack>.<output>}}`.
 *
 *  The grammar's hard part is the same one annotations and links already solve:
 *  a canonical contact id IS an email and therefore contains dots, so the tag
 *  has to be found by anchoring from the right rather than by assuming the id
 *  is one segment. Rollups then need ONE MORE tail segment than any existing
 *  tag, because a rollup names a pack and then an output.
 *
 *  A parser that gets this wrong does not throw — it returns null, nothing
 *  prefetches, and the ref quietly resolves to undefined. Which is why the
 *  cases below are mostly about refs that must PARSE. */
import { describe, expect, it } from 'vitest';
import type { NamespaceStores } from '@recued/contracts';
import { parseAnnotationLinkRef, prefetchSharedRefs } from '../shared-prefetch.js';
import type { RootRollup, SharedResolvers } from '../shared-prefetch.js';

describe('parseAnnotationLinkRef — the rollups grammar', () => {
  it('parses a pack + output tail off a DOTTED email id', () => {
    expect(parseAnnotationLinkRef('contact.bob@acme.test.rollups.billable-hours.unbilled_minutes'))
      .toEqual({
        kind: 'rollup', collection: 'contact', id: 'bob@acme.test',
        rest: ['billable-hours', 'unbilled_minutes'],
      });
  });

  it('parses the pack-level and group-level reads too', () => {
    expect(parseAnnotationLinkRef('contact.bob@acme.test.rollups.billable-hours'))
      .toMatchObject({ kind: 'rollup', id: 'bob@acme.test', rest: ['billable-hours'] });
    expect(parseAnnotationLinkRef('contact.bob@acme.test.rollups'))
      .toMatchObject({ kind: 'rollup', id: 'bob@acme.test', rest: [] });
  });

  it('survives an id with several dots', () => {
    expect(parseAnnotationLinkRef('contact.a.b.c@x.co.uk.rollups.p.k'))
      .toMatchObject({ id: 'a.b.c@x.co.uk', rest: ['p', 'k'] });
  });

  it('⛔ does NOT widen the other tags — annotations still cap at one tail', () => {
    // The deeper tail is scoped to `rollups` alone. If it leaked, this would
    // parse as an annotation ref and the resolver would be asked for a record
    // it never serves.
    expect(parseAnnotationLinkRef('contact.bob@acme.test.annotations.a.b')).toBeNull();
    expect(parseAnnotationLinkRef('contact.bob@acme.test.links.a.b')).toBeNull();
  });

  it('refuses a rollup ref with no id', () => {
    expect(parseAnnotationLinkRef('contact.rollups.p.k')).toBeNull();
  });

  it('refuses a collection that is not annotatable', () => {
    expect(parseAnnotationLinkRef('shared.bob.rollups.p.k')).toBeNull();
  });

  it('refuses a prototype-poisoning segment', () => {
    expect(parseAnnotationLinkRef('contact.bob.rollups.__proto__.k')).toBeNull();
  });
});

const stores = (): NamespaceStores => ({ data: {} } as unknown as NamespaceStores);

const rollupResolver = (rollups: RootRollup[]): SharedResolvers & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    rollupsForRecord: async (collection: string, id: string) => {
      calls.push(`${collection}.${id}`);
      return rollups;
    },
  } as SharedResolvers & { calls: string[] };
};

const ROLLUPS: RootRollup[] = [
  {
    publisher: 'recued-core', pack_slug: 'billable-hours', label: 'Unbilled time',
    value: { unbilled_minutes: 135, entry_count: 3, last_task: 'ENG-502' }, complete: true,
  },
  {
    publisher: 'recued-core', pack_slug: 'job-status-board', label: 'Open jobs',
    value: { job_count: 2 }, complete: false, incomplete_reason: 'more than 100 job rows reach this root',
  },
];

const walk = (root: unknown, path: string): unknown => {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

describe('prefetchSharedRefs — seeding a rollup group', () => {
  const run = async (input: Record<string, unknown>, resolvers: SharedResolvers) => {
    const s = stores();
    await prefetchSharedRefs({ id: 'x', transform: 'template', ...input } as never, s, resolvers);
    return s;
  };

  it('seeds the group so a deep ref walks straight to the number', async () => {
    const s = await run(
      { template: '{{data.contact.bob@acme.test.rollups.billable-hours.unbilled_minutes}}' },
      rollupResolver(ROLLUPS),
    );
    expect(walk(s.data, 'contact.bob@acme.test.rollups.billable-hours.unbilled_minutes')).toBe(135);
    expect(walk(s.data, 'contact.bob@acme.test.rollups.job-status-board.job_count')).toBe(2);
  });

  it('carries completeness onto every pack entry', async () => {
    const s = await run({ template: '{{data.contact.bob@acme.test.rollups}}' }, rollupResolver(ROLLUPS));
    expect(walk(s.data, 'contact.bob@acme.test.rollups.billable-hours._complete')).toBe(true);
    expect(walk(s.data, 'contact.bob@acme.test.rollups.job-status-board._complete')).toBe(false);
    expect(walk(s.data, 'contact.bob@acme.test.rollups.job-status-board._incomplete_reason'))
      .toMatch(/more than/);
    expect(walk(s.data, 'contact.bob@acme.test.rollups.billable-hours._label')).toBe('Unbilled time');
  });

  it('fetches ONCE for several refs at the same identity', async () => {
    const resolver = rollupResolver(ROLLUPS);
    await run({
      template: '{{data.contact.bob@acme.test.rollups.billable-hours.unbilled_minutes}}'
        + ' {{data.contact.bob@acme.test.rollups.billable-hours.entry_count}}'
        + ' {{data.contact.bob@acme.test.rollups.job-status-board.job_count}}',
    }, resolver);
    expect(resolver.calls).toEqual(['contact.bob@acme.test']);
  });

  it('seeds an empty group when no pack declares onto the identity', async () => {
    const s = await run(
      { template: '{{data.contact.nobody@x.test.rollups.billable-hours.unbilled_minutes}}' },
      rollupResolver([]),
    );
    // Present-but-empty, so a recipe can tell "nothing to say" from "not wired".
    expect(walk(s.data, 'contact.nobody@x.test.rollups')).toEqual({});
    expect(walk(s.data, 'contact.nobody@x.test.rollups.billable-hours.unbilled_minutes')).toBeUndefined();
  });

  it('⛔ two publishers sharing a slug become an ERROR, not one of them silently winning', async () => {
    const s = await run({ template: '{{data.contact.bob@acme.test.rollups.hours.total}}' },
      rollupResolver([
        { publisher: 'recued-core', pack_slug: 'hours', value: { total: 1 }, complete: true },
        { publisher: 'someone-else', pack_slug: 'hours', value: { total: 999 }, complete: true },
      ]));
    const entry = walk(s.data, 'contact.bob@acme.test.rollups.hours') as Record<string, unknown>;
    expect(entry.error).toBe('ambiguous_pack_slug');
    expect(entry.publishers).toEqual(['recued-core', 'someone-else']);
    // and above all: neither publisher's number is presented as the answer
    expect(entry.total).toBeUndefined();
  });

  it('does not fetch when the recipe references no rollup', async () => {
    const resolver = rollupResolver(ROLLUPS);
    await run({ template: '{{step.other}}' }, resolver);
    expect(resolver.calls).toEqual([]);
  });
});
