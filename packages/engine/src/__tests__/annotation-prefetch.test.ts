/** D-119 Phase 13 — annotation + link prefetch resolver tests.
 *
 *  Covers the per-record ref grammar:
 *    - `{{data.<col>.<id>.annotations.<key>}}` → latest annotation
 *      value per key, folded onto a flat object.
 *    - `{{data.<col>.<id>.links.<role>}}` → outbound links grouped by
 *      role.
 *    - `{{data.<col>.<id>.inbound_links.<role>}}` → inbound links
 *      grouped by role.
 *  Plus dedup: multiple refs at the same record fire one rpc, and
 *  refs at non-canonical collections (`shared.*`, unknown) are
 *  ignored. */

import { describe, expect, it } from 'vitest';

import { resolveValue, type NamespaceStores, type RecipeStep, type Annotation, type Link } from '@recued/contracts';

import { prefetchSharedRefs } from '../shared-prefetch.js';

const mkStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

const mkAnnotation = (overrides: Partial<Annotation>): Annotation => ({
  _id: 'ann',
  _collection: 'annotation',
  target_collection: 'mail',
  target_id: 'msg-1',
  key: 'summary',
  value: 'v',
  authored_by_recipe_id: 'r1',
  source_record_hash: 's',
  authored_at: 1,
  ...overrides,
});

const mkLink = (overrides: Partial<Link>): Link => ({
  _id: 'l',
  _collection: 'link',
  from_collection: 'mail',
  from_id: 'msg-1',
  to_collection: 'file',
  to_id: 'f1',
  role: 'attachment',
  created_at: 1,
  authored_by_recipe_id: 'r1',
  ...overrides,
});

describe('annotation prefetch', () => {
  it('populates {{data.<col>.<id>.annotations.<key>}}', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { tldr: '{{data.mail.msg-1.annotations.summary}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      annotationsForRecord: async (col, id) => {
        expect(col).toBe('mail');
        expect(id).toBe('msg-1');
        return [
          mkAnnotation({ key: 'summary', value: 'Quarterly review' }),
          mkAnnotation({ _id: 'ann2', key: 'risk_score', value: 0.8 }),
        ];
      },
    });
    expect(
      resolveValue('{{data.mail.msg-1.annotations.summary}}', stores),
    ).toBe('Quarterly review');
    expect(
      resolveValue('{{data.mail.msg-1.annotations.risk_score}}', stores),
    ).toBe(0.8);
  });

  it('dedupes multiple refs at the same record into one rpc', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: {
        a: '{{data.mail.msg-1.annotations.summary}}',
        b: '{{data.mail.msg-1.annotations.risk_score}}',
        c: '{{data.mail.msg-1.annotations.category}}',
      },
    } as RecipeStep;
    let calls = 0;
    await prefetchSharedRefs(step, stores, {
      annotationsForRecord: async () => {
        calls++;
        return [];
      },
    });
    expect(calls).toBe(1);
  });

  it('different records each fire their own rpc', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: {
        a: '{{data.mail.m1.annotations.summary}}',
        b: '{{data.mail.m2.annotations.summary}}',
        c: '{{data.calendar.evt-1.annotations.summary}}',
      },
    } as RecipeStep;
    const seen: string[] = [];
    await prefetchSharedRefs(step, stores, {
      annotationsForRecord: async (col, id) => {
        seen.push(`${col}/${id}`);
        return [];
      },
    });
    expect(seen.sort()).toEqual([
      'calendar/evt-1',
      'mail/m1',
      'mail/m2',
    ]);
  });

  it('returns undefined when the record has no matching key', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { x: '{{data.mail.m1.annotations.nonexistent}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      annotationsForRecord: async () => [
        mkAnnotation({ key: 'summary', value: 'only this' }),
      ],
    });
    expect(
      resolveValue('{{data.mail.m1.annotations.nonexistent}}', stores),
    ).toBe(undefined);
    // The known key still resolves
    expect(resolveValue('{{data.mail.m1.annotations.summary}}', stores)).toBe('only this');
  });

  it('drops prototype-sensitive annotation keys from folded results', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { safe: '{{data.mail.m1.annotations.summary}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      annotationsForRecord: async () => [
        mkAnnotation({ key: 'summary', value: 'ok' }),
        mkAnnotation({ key: '__proto__', value: { polluted: true } }),
        mkAnnotation({ key: 'constructor', value: 'bad' }),
        mkAnnotation({ key: 'prototype', value: 'bad' }),
      ],
    });
    expect(resolveValue('{{data.mail.m1.annotations.summary}}', stores)).toBe('ok');
    expect(resolveValue('{{data.mail.m1.annotations.constructor}}', stores)).toBeUndefined();
    const annotations = resolveValue('{{data.mail.m1.annotations}}', stores) as Record<string, unknown>;
    expect((annotations as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(annotations, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(annotations, 'prototype')).toBe(false);
  });

  it('skips refs to non-canonical collections', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: {
        a: '{{data.shared.deal.123.annotations.summary}}',
        b: '{{data.unknown.r1.annotations.summary}}',
      },
    } as RecipeStep;
    let called = false;
    await prefetchSharedRefs(step, stores, {
      annotationsForRecord: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
  });
});

describe('link prefetch', () => {
  it('populates {{data.<col>.<id>.links.<role>}} as an array grouped by role', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { atts: '{{data.mail.m1.links.attachment}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (col, id, dir) => {
        expect(col).toBe('mail');
        expect(id).toBe('m1');
        expect(dir).toBe('outbound');
        return [
          mkLink({ _id: 'l1', role: 'attachment', to_id: 'f1' }),
          mkLink({ _id: 'l2', role: 'attachment', to_id: 'f2' }),
          mkLink({ _id: 'l3', role: 'reply-to', to_id: 'f9' }),
        ];
      },
    });
    const arr = resolveValue('{{data.mail.m1.links.attachment}}', stores) as Link[];
    expect(arr.map((l) => l.to_id)).toEqual(['f1', 'f2']);
    const replies = resolveValue('{{data.mail.m1.links.reply-to}}', stores) as Link[];
    expect(replies).toHaveLength(1);
  });

  it('drops prototype-sensitive link roles from grouped results', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { atts: '{{data.mail.m1.links.attachment}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async () => [
        mkLink({ _id: 'l1', role: 'attachment', to_id: 'f1' }),
        mkLink({ _id: 'l2', role: '__proto__', to_id: 'bad1' }),
        mkLink({ _id: 'l3', role: 'constructor', to_id: 'bad2' }),
        mkLink({ _id: 'l4', role: 'prototype', to_id: 'bad3' }),
      ],
    });
    const arr = resolveValue('{{data.mail.m1.links.attachment}}', stores) as Link[];
    expect(arr.map((l) => l.to_id)).toEqual(['f1']);
    expect(resolveValue('{{data.mail.m1.links.constructor}}', stores)).toBeUndefined();
    const grouped = resolveValue('{{data.mail.m1.links}}', stores) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(grouped, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(grouped, 'prototype')).toBe(false);
  });

  it('inbound_links calls direction=inbound', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { x: '{{data.mail.m1.inbound_links.follow-up-on}}' },
    } as RecipeStep;
    let direction: string | undefined;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (_c, _i, dir) => {
        direction = dir;
        return [
          mkLink({
            _id: 'lx', role: 'follow-up-on',
            from_collection: 'calendar', from_id: 'evt-1',
            to_collection: 'mail', to_id: 'm1',
          }),
        ];
      },
    });
    expect(direction).toBe('inbound');
    const arr = resolveValue(
      '{{data.mail.m1.inbound_links.follow-up-on}}',
      stores,
    ) as Link[];
    expect(arr).toHaveLength(1);
    expect(arr[0].from_id).toBe('evt-1');
  });

  it('outbound and inbound prefetches at the same record run independently', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: {
        a: '{{data.mail.m1.links.attachment}}',
        b: '{{data.mail.m1.inbound_links.reply-to}}',
      },
    } as RecipeStep;
    const directions: string[] = [];
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (_c, _i, dir) => {
        directions.push(dir);
        return [];
      },
    });
    expect(directions.sort()).toEqual(['inbound', 'outbound']);
  });
});

describe('D-172 P2 — contact + work-entity link surfacing', () => {
  it('resolves {{data.contact.<id>.links.attachment}} → file records', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { atts: '{{data.contact.jane.links.attachment}}' },
    } as RecipeStep;
    let seen: { col: string; id: string; dir: string } | undefined;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (col, id, dir) => {
        seen = { col, id, dir };
        return [
          mkLink({
            _id: 'la',
            from_collection: 'contact',
            from_id: 'jane',
            to_collection: 'file',
            to_id: 'file:abc',
            role: 'attachment',
          }),
        ];
      },
    });
    // The prefetcher MUST recognize `contact` (it was excluded pre-D-172).
    expect(seen).toEqual({ col: 'contact', id: 'jane', dir: 'outbound' });
    const arr = resolveValue(
      '{{data.contact.jane.links.attachment}}',
      stores,
    ) as Link[];
    expect(arr.map((l) => l.to_id)).toEqual(['file:abc']);
  });

  it('resolves {{data.file.<id>.inbound_links.attachment}} → owning entities', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { owners: '{{data.file.file_abc.inbound_links.attachment}}' },
    } as RecipeStep;
    let direction: string | undefined;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (_c, _i, dir) => {
        direction = dir;
        return [
          mkLink({
            _id: 'lb',
            from_collection: 'contact',
            from_id: 'jane',
            to_collection: 'file',
            to_id: 'file_abc',
            role: 'attachment',
          }),
        ];
      },
    });
    expect(direction).toBe('inbound');
    const arr = resolveValue(
      '{{data.file.file_abc.inbound_links.attachment}}',
      stores,
    ) as Link[];
    expect(arr.map((l) => l.from_id)).toEqual(['jane']);
  });

  it('resolves {{data.file.<id>.links.attachment}} when the file id uses the file: prefix', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { atts: '{{data.file.file:abc.links.attachment}}' },
    } as RecipeStep;
    let seen: { col: string; id: string; dir: string } | undefined;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (col, id, dir) => {
        seen = { col, id, dir };
        return [
          mkLink({
            _id: 'lf',
            from_collection: 'file',
            from_id: 'file:abc',
            to_collection: 'file',
            to_id: 'file:def',
            role: 'attachment',
          }),
        ];
      },
    });
    expect(seen).toEqual({ col: 'file', id: 'file:abc', dir: 'outbound' });
    const arr = resolveValue(
      '{{data.file.file:abc.links.attachment}}',
      stores,
    ) as Link[];
    expect(arr.map((l) => l.to_id)).toEqual(['file:def']);
  });

  it('recognizes the N.3 work-entity attachment targets', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: {
        a: '{{data.task.t1.links.attachment}}',
        b: '{{data.project.p1.links.attachment}}',
        c: '{{data.commitment.c1.links.attachment}}',
        d: '{{data.note.n1.links.attachment}}',
      },
    } as RecipeStep;
    const seen: string[] = [];
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (col, id) => {
        seen.push(`${col}/${id}`);
        return [];
      },
    });
    expect(seen.sort()).toEqual([
      'commitment/c1',
      'note/n1',
      'project/p1',
      'task/t1',
    ]);
  });

  // MUTATION CHECK — were `contact` removed from ANNOTATABLE_COLLECTIONS,
  // parseAnnotationLinkRef returns null for the contact path and the
  // resolver never fires. This test asserts the set-entry is load-bearing.
  it('mutation: dropping contact from the set would skip the contact prefetch', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { atts: '{{data.contact.jane.links.attachment}}' },
    } as RecipeStep;
    let called = false;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async () => {
        called = true;
        return [];
      },
    });
    // With `contact` in the set this MUST be true; removing the entry
    // flips it to false (the ref is no longer parsed).
    expect(called).toBe(true);
  });

  it('resolves dotted contact email ids by anchoring the tag from the right', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { atts: '{{data.contact.jane@x.com.links.attachment}}' },
    } as RecipeStep;
    let firedFor: { col: string; id: string } | undefined;
    await prefetchSharedRefs(step, stores, {
      linksForRecord: async (col, id) => {
        firedFor = { col, id };
        return [
          mkLink({
            _id: 'ldot',
            from_collection: 'contact',
            from_id: 'jane@x.com',
            to_collection: 'file',
            to_id: 'file:abc',
            role: 'attachment',
          }),
        ];
      },
    });
    // The old segments[1] parser saw id=`jane@x`, tag=`com`, and never
    // called the resolver. The right-anchored parser keeps the full id.
    expect(firedFor).toEqual({ col: 'contact', id: 'jane@x.com' });
    const arr = resolveValue(
      '{{data.contact.jane@x.com.links.attachment}}',
      stores,
    ) as Link[];
    expect(arr.map((l) => l.to_id)).toEqual(['file:abc']);
  });
});

describe('no-op when no resolvers wired', () => {
  it('absent annotation/link resolvers leave stores untouched', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { x: '{{data.mail.m1.annotations.summary}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {});
    // No data namespace seeded — resolves to undefined, not an error.
    expect(
      resolveValue('{{data.mail.m1.annotations.summary}}', stores),
    ).toBe(undefined);
  });
});
