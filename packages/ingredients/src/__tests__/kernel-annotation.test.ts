/** D-119 Phase 13 — annotation + link kernel dispatch tests.
 *
 *  Covers the seven new slugs (`data-annotate`, `annotation-list`,
 *  `annotation-search`, `annotation-delete`, `data-link`, `link-list`,
 *  `link-delete`): canonical-ref normalization, explicit collection/id
 *  fallback, SERVER_NOT_REACHABLE when dispatchers are absent, and
 *  BAD_INPUT on missing endpoint specifiers. */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';
import type {
  Annotation,
  AnnotationFilter,
  AnnotationSearchMatch,
  AnnotationSearchQuery,
  Link,
  LinkFilter,
} from '@recued/contracts';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const mkAnnotation = (overrides: Partial<Annotation> = {}): Annotation => ({
  _id: 'ann-1',
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

const mkLink = (overrides: Partial<Link> = {}): Link => ({
  _id: 'link-1',
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

describe('kernel adapter — data-annotate', () => {
  it('routes a canonical ref to the annotate dispatcher', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotate: async (input) => {
        captured = input;
        return { annotation: mkAnnotation() };
      },
    });
    const res = await adapter(
      mkCall('data-annotate', {
        ref: { _id: 'msg-42', _collection: 'mail', subject: 'hi' },
        key: 'summary',
        value: 'v',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'src',
        recipe_hash: 'rec',
      }),
    );
    expect((captured as { target_collection: string }).target_collection).toBe('mail');
    expect((captured as { target_id: string }).target_id).toBe('msg-42');
    expect((res as { annotation: Annotation }).annotation._collection).toBe('annotation');
  });

  it('falls back to explicit target_collection + target_id', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotate: async (input) => {
        captured = input;
        return { annotation: mkAnnotation() };
      },
    });
    await adapter(
      mkCall('data-annotate', {
        target_collection: 'calendar',
        target_id: 'evt-1',
        key: 'tldr',
        value: 'short',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'src',
        recipe_hash: 'rec',
        model_used: 'gpt-4',
      }),
    );
    expect((captured as { target_collection: string }).target_collection).toBe('calendar');
    expect((captured as { target_id: string }).target_id).toBe('evt-1');
    expect((captured as { model_used?: string }).model_used).toBe('gpt-4');
  });

  it('SERVER_NOT_REACHABLE when annotate dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall('data-annotate', {
        target_collection: 'mail', target_id: 'm1',
        key: 'summary', value: 'v', authored_by_recipe_id: 'r1',
        source_record_hash: 's', recipe_hash: 'r',
      })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('BAD_INPUT when neither ref nor target_* is supplied', async () => {
    const adapter = createKernelAdapter({
      annotate: async () => ({ annotation: mkAnnotation() }),
    });
    await expect(
      adapter(mkCall('data-annotate', {
        key: 'summary', value: 'v', authored_by_recipe_id: 'r1',
        source_record_hash: 's', recipe_hash: 'r',
      })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('BAD_INPUT when ref is not canonical', async () => {
    const adapter = createKernelAdapter({
      annotate: async () => ({ annotation: mkAnnotation() }),
    });
    await expect(
      adapter(mkCall('data-annotate', {
        ref: { something: 'else' },
        key: 'summary', value: 'v', authored_by_recipe_id: 'r1',
        source_record_hash: 's', recipe_hash: 'r',
      })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('kernel adapter — annotation list/search/delete', () => {
  it('annotation-list passes the filter through', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationList: async (input) => {
        captured = input;
        return { annotations: [mkAnnotation()] };
      },
    });
    const filter: AnnotationFilter = { target_collection: 'mail', key: 'summary' };
    const res = await adapter(mkCall('annotation-list', filter as Record<string, unknown>));
    expect(captured).toEqual(filter);
    expect((res as { annotations: Annotation[] }).annotations).toHaveLength(1);
  });

  it('annotation-search passes the query through', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationSearch: async (input) => {
        captured = input;
        const m: AnnotationSearchMatch = {
          annotation_id: 'a',
          target_collection: 'mail',
          target_id: 'msg-1',
          key: 'summary',
          value: 'hit',
          rank: -1.0,
        };
        return { matches: [m] };
      },
    });
    const q: AnnotationSearchQuery = { query: 'Acme' };
    await adapter(mkCall('annotation-search', q as unknown as Record<string, unknown>));
    expect((captured as { query: string }).query).toBe('Acme');
  });

  it('annotation-delete passes the filter through', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationDelete: async (input) => {
        captured = input;
        return { ok: true, deleted: 3 };
      },
    });
    const res = await adapter(
      mkCall('annotation-delete', { key: 'summary' }),
    );
    expect(captured).toEqual({ key: 'summary' });
    expect((res as { deleted: number }).deleted).toBe(3);
  });

  it('SERVER_NOT_REACHABLE for each list/search/delete when slot absent', async () => {
    const adapter = createKernelAdapter({});
    for (const slug of ['annotation-list', 'annotation-search', 'annotation-delete']) {
      await expect(adapter(mkCall(slug, {}))).rejects.toMatchObject({
        code: 'SERVER_NOT_REACHABLE',
      });
    }
  });
});

describe('kernel adapter — data-link', () => {
  it('accepts canonical refs on both from + to', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkWrite: async (input) => {
        captured = input;
        return { link: mkLink() };
      },
    });
    await adapter(mkCall('data-link', {
      from: { _id: 'msg-1', _collection: 'mail' },
      to: { _id: 'f1', _collection: 'file' },
      role: 'attachment',
      authored_by_recipe_id: 'r1',
    }));
    expect((captured as { from_collection: string }).from_collection).toBe('mail');
    expect((captured as { to_collection: string }).to_collection).toBe('file');
  });

  it('falls back to explicit from_collection/from_id + to_collection/to_id', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkWrite: async (input) => {
        captured = input;
        return { link: mkLink() };
      },
    });
    await adapter(mkCall('data-link', {
      from_collection: 'mail', from_id: 'm2',
      to_collection: 'calendar', to_id: 'evt-1',
      role: 'scheduled-from',
      authored_by_recipe_id: 'r1',
    }));
    expect((captured as { from_id: string }).from_id).toBe('m2');
    expect((captured as { to_id: string }).to_id).toBe('evt-1');
  });

  it('BAD_INPUT when from or to is missing', async () => {
    const adapter = createKernelAdapter({
      linkWrite: async () => ({ link: mkLink() }),
    });
    await expect(adapter(mkCall('data-link', {
      from_collection: 'mail', from_id: 'm1',
      role: 'r', authored_by_recipe_id: 'r1',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('kernel adapter — link list/delete', () => {
  it('link-list passes filter through', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkList: async (input) => {
        captured = input;
        return { links: [mkLink()] };
      },
    });
    const filter: LinkFilter = { role: 'attachment' };
    const res = await adapter(mkCall('link-list', filter as Record<string, unknown>));
    expect(captured).toEqual(filter);
    expect((res as { links: Link[] }).links).toHaveLength(1);
  });

  it('link-delete passes filter through', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkDelete: async (input) => {
        captured = input;
        return { ok: true, deleted: 2 };
      },
    });
    await adapter(mkCall('link-delete', { from_collection: 'mail', from_id: 'm1' }));
    expect((captured as { from_collection: string }).from_collection).toBe('mail');
  });
});
