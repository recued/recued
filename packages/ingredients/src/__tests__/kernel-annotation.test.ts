/** D-119 Phase 13 — annotation + link kernel dispatch tests.
 *
 *  Covers `annotation-list`, `annotation-search`, `annotation-delete`,
 *  `link-list` and `link-delete`: what each forwards, how the deletes are
 *  scoped, and SERVER_NOT_REACHABLE when dispatchers are absent.
 *  (`data-annotate` / `data-link` and their canonical-ref normalization were
 *  RETIRED 2026-09-23 — never wired on the server, unused, duplicates of
 *  `annotation-create` / `link-create`.) */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
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

  /** ⛔ A recipe deletes only the annotations it wrote (owner decision,
   *  2026-09-23): housekeeping re-derives some annotations and the server keeps
   *  system state in others, so the author is pinned to the engine's identity
   *  for the run, not taken from the step. */
  const inRun = (input: Record<string, unknown>) =>
    ({ ...mkCall('annotation-delete', input), stepMeta: { recipe_id: 'r1', run_id: 'run-1' } }) as never;

  it("annotation-delete is pinned to the running recipe's own annotations", async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationDelete: async (input) => {
        captured = input;
        return { ok: true, deleted: 3 };
      },
    });
    const res = await adapter(inRun({ key: 'summary' }));
    expect(captured).toEqual({ key: 'summary', authored_by_recipe_id: 'r1' });
    expect((res as { deleted: number }).deleted).toBe(3);

    // ...and a step naming ANOTHER author still deletes only its own.
    await adapter(inRun({ key: 'summary', authored_by_recipe_id: 'housekeeping:link-discovery' }));
    expect(captured).toEqual({ key: 'summary', authored_by_recipe_id: 'r1' });
  });

  it('annotation-delete refuses outside a recipe run — there is no identity to scope to', async () => {
    const adapter = createKernelAdapter({ annotationDelete: async () => ({ ok: true, deleted: 0 }) });
    await expect(adapter(mkCall('annotation-delete', { key: 'summary' })))
      .rejects.toMatchObject({ code: 'ANNOTATION_DELETE_NEEDS_RECIPE' });
  });

  /** The store refuses an empty filter so a slip cannot wipe the table. The pin
   *  would make `{}` non-empty ("everything I wrote"), so the step's own filter
   *  is held to the rule first. */
  it('annotation-delete still refuses an empty filter, pin or no pin', async () => {
    let calls = 0;
    const adapter = createKernelAdapter({
      annotationDelete: async () => { calls += 1; return { ok: true, deleted: 0 }; },
    });
    for (const input of [{}, { limit: 5 }, { key: undefined }]) {
      await expect(adapter(inRun(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    expect(calls).toBe(0);
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

  /** The opposite of annotation-delete, on purpose (owner decision,
   *  2026-09-23): nothing regenerates typed links, so a recipe's delete is not
   *  pinned to its own — even inside a run, no author is added. */
  it('link-delete is NOT scoped to the running recipe', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkDelete: async (input) => { captured = input; return { ok: true, deleted: 2 }; },
    });
    await adapter({
      ...mkCall('link-delete', { role: 'thread_participant' }),
      stepMeta: { recipe_id: 'r1', run_id: 'run-1' },
    } as never);
    expect(captured).toEqual({ role: 'thread_participant' });
  });
});
