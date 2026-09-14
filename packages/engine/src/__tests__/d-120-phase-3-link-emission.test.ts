/** D-120 Phase 3 — engine-side link emission via `runStep`.
 *
 *  Exercises the full extraction → classification → emit pipeline:
 *    - touches harvested from `data.<col>.<id>` refs in step input
 *    - per-touch shouldLink filter (sidecar / foreach / scan)
 *    - step-level stepEmitsLinks gate (external_call / action /
 *      ai-prompt; transforms / data reads / contracted ai-* skipped)
 *    - per-recipe `provenance: false` opt-out
 *    - foreach iteration depth tracker (parent scan only — no
 *      per-item links)
 */

import { describe, expect, it } from 'vitest';
import type {
  EmittedLink,
  IngredientManifest,
  NamespaceStores,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import { runStep } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const recipe = (
  partial: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id: 'phase-3-emission',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'phase 3',
    description: 'test',
    author: 'test',
    supported_platforms: ['hubspot'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...partial,
});

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
  data: {},
});

const manifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest => ({
  slug: 'send-email',
  name: 'Send email',
  description: 'sends mail',
  author: 'test',
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  input: { url: 'https://api.smtp.example.com/send' },
  output: { ok: 'ok' },
  ...overrides,
});

const setup = (
  step: RecipeStep,
  opts: {
    manifestForSlug?: (slug: string) => IngredientManifest | null;
    provenance?: boolean;
    capture?: boolean;
    /** D-210 step 3 — the step result the executor returns. The write
     *  link reads its entity id from this (a calendar mutation surfaces
     *  `source_id`). Defaults to `{ ok: true }` (the pre-D-210 harness). */
    executorResult?: unknown;
  } = {},
): { ctx: ExecutionContext; emitted: EmittedLink[] } => {
  const emitted: EmittedLink[] = [];
  const executor: IngredientExecutor = async () =>
    opts.executorResult ?? { ok: true };
  const ctx: ExecutionContext = {
    recipe: recipe({
      steps: [step],
      ...(opts.provenance === false ? { provenance: false } : {}),
    }),
    stores: baseStores(),
    ingredientExecutor: executor,
    manifestGetter: opts.manifestForSlug ?? (() => manifest()),
    ...(opts.capture === false
      ? {}
      : { linkSink: (link: EmittedLink) => emitted.push(link) }),
  };
  return { ctx, emitted };
};

describe('runStep — link emission for side-effecting ingredient steps', () => {
  it('emits one link per resolved data.<col>.<id> ref in input', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: {
        url: 'https://api.smtp.example.com/send',
        body: '{{data.mail.msg-1.subject}}',
      },
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      step_id: 'send',
      collection: 'mail',
      entity_id: 'msg-1',
      access: 'read',
      kind: 'execution.action',
    });
  });

  it('emits classified.action when manifest has external_call', async () => {
    const step: RecipeStep = {
      id: 'post',
      ingredient: 'slack-post',
      input: { url: 'https://slack.com/api/chat.postMessage', text: '{{data.deal.42.name}}' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () =>
        manifest({ slug: 'slack-post', input: { url: 'https://slack.com/api/chat.postMessage' } }),
    });
    await runStep(step, ctx);
    expect(emitted[0].kind).toBe('execution.action');
    expect(emitted[0].collection).toBe('deal');
  });

  it('dedupes touches per (collection, entity_id) within a single step', async () => {
    const step: RecipeStep = {
      id: 'multi',
      ingredient: 'send-email',
      input: {
        subject: '{{data.mail.msg-1.subject}}',
        body: '{{data.mail.msg-1.body}}',
        from: '{{data.mail.msg-1.from}}',
      },
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].entity_id).toBe('msg-1');
  });

  it('emits one row per distinct entity when the step touches several', async () => {
    const step: RecipeStep = {
      id: 'merge',
      ingredient: 'send-email',
      input: {
        a: '{{data.mail.msg-1.subject}}',
        b: '{{data.mail.msg-2.subject}}',
        c: '{{data.contact.alice.email}}',
      },
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(3);
    expect(new Set(emitted.map((l) => `${l.collection}:${l.entity_id}`))).toEqual(
      new Set(['mail:msg-1', 'mail:msg-2', 'contact:alice']),
    );
  });

  it('shares one ts across all touches of a single step', async () => {
    const step: RecipeStep = {
      id: 'multi',
      ingredient: 'send-email',
      input: {
        a: '{{data.mail.msg-1.subject}}',
        b: '{{data.contact.alice.email}}',
      },
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(new Set(emitted.map((l) => l.ts)).size).toBe(1);
  });
});

describe('runStep — emission gates', () => {
  it('does not emit for transform steps (pure, no causal effect)', async () => {
    const step: RecipeStep = {
      id: 'filter',
      transform: 'filter',
      items: '{{data.mail.msg-1.threads}}',
      conditions: [],
    } as unknown as RecipeStep;
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('does not emit for data-category reads (observational)', async () => {
    const step: RecipeStep = {
      id: 'read',
      ingredient: 'mail-read',
      input: { id: '{{data.mail.msg-1.id}}' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () =>
        manifest({ slug: 'mail-read', category: 'data', risk_tier: 'read', input: {} }),
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('does not emit when ctx.linkSink is unwired (extension path)', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: { body: '{{data.mail.msg-1.subject}}' },
    };
    const { ctx } = setup(step, { capture: false });
    // No linkSink — calling runStep must not throw and must not emit.
    const log = await runStep(step, ctx);
    expect(log.error).toBeNull();
  });

  it('honors recipe.provenance === false and emits nothing', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: { body: '{{data.mail.msg-1.subject}}' },
    };
    const { ctx, emitted } = setup(step, { provenance: false });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('treats provenance === true (explicit) the same as default', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: { body: '{{data.mail.msg-1.subject}}' },
    };
    const emitted: EmittedLink[] = [];
    const ctx: ExecutionContext = {
      recipe: { ...recipe({ steps: [step] }), provenance: true },
      stores: baseStores(),
      ingredientExecutor: async () => ({ ok: true }),
      manifestGetter: () => manifest(),
      linkSink: (link) => emitted.push(link),
    };
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
  });

  it('skips touches on sidecar collections (annotation / link)', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: {
        subject: '{{data.annotation.foo.value}}',
        body: '{{data.mail.msg-1.subject}}',
      },
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].collection).toBe('mail');
  });

  it('does not emit on errored steps (fail_on triggered)', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: { body: '{{data.mail.msg-1.subject}}' },
      fail_on: '{{step.send}} is_not_null',
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('does not emit on skipped steps (skip_when triggered)', async () => {
    const step: RecipeStep = {
      id: 'send',
      ingredient: 'send-email',
      input: { body: '{{data.mail.msg-1.subject}}' },
      skip_when: '1 equal 1',
    };
    const { ctx, emitted } = setup(step);
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });
});

describe('runStep — foreach iterations are not linked', () => {
  it('inner per-iteration data.* reads emit nothing (parent scan rule)', async () => {
    const step: RecipeStep = {
      id: 'each',
      foreach: '[{"id":"a"},{"id":"b"}]',
      ingredient: 'send-email',
      input: { to: '{{data.contact.{{item.id}}.email}}' },
    } as unknown as RecipeStep;
    const stores = baseStores();
    (stores.step as Record<string, unknown>).list = [{ id: 'a' }, { id: 'b' }];
    const emitted: EmittedLink[] = [];
    const innerStep: RecipeStep = {
      id: 'each',
      foreach: '{{step.list}}',
      ingredient: 'send-email',
      input: { to: '{{data.contact.alice.email}}' },
    };
    const ctx: ExecutionContext = {
      recipe: recipe({ steps: [innerStep] }),
      stores,
      ingredientExecutor: async () => ({ ok: true }),
      manifestGetter: () => manifest(),
      linkSink: (link) => emitted.push(link),
    };
    await runStep(innerStep, ctx);
    expect(emitted).toHaveLength(0);
    void step; // keep param for type assertions only
  });

  it('foreach over a literal array does not crash + emits nothing', async () => {
    const step: RecipeStep = {
      id: 'each-literal',
      foreach: '{{step.items}}',
      ingredient: 'send-email',
      input: { to: '{{data.contact.alice.email}}' },
    };
    const stores = baseStores();
    (stores.step as Record<string, unknown>).items = [1, 2, 3];
    const emitted: EmittedLink[] = [];
    const ctx: ExecutionContext = {
      recipe: recipe({ steps: [step] }),
      stores,
      ingredientExecutor: async () => ({ ok: true }),
      manifestGetter: () => manifest(),
      linkSink: (link) => emitted.push(link),
    };
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// D-210 step 3 — write links (the classifier's dormant access:'write'
// branch, activated by a manifest `writes` declaration). The written
// entity's id is in the step RESULT, never in a `data.*` input ref, so
// these emit even when the step reads nothing. Mirrors the calendar
// mutations: `kind: 'storage'`, no external_call, id at `source_id`.
// ────────────────────────────────────────────────────────────────

/** A write-declaring kernel storage ingredient (the calendar shape):
 *  `category: 'action'` so `stepEmitsLinks` passes, no url so it is NOT
 *  an external_call (kind stays write/derived, never action), and a
 *  `writes` target keyed on the result's `source_id`. */
const writesManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest => ({
  slug: 'calendar-create',
  name: 'Create calendar event',
  description: 'creates an event',
  author: 'recued',
  kind: 'storage',
  category: 'action',
  risk_tier: 'write',
  input: {},
  output: { source_id: 'source_id' },
  writes: { collection: 'calendar', id_output_field: 'source_id' },
  ...overrides,
});

describe('runStep — D-210 write links', () => {
  it('emits one execution.write link keyed on the result id', async () => {
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'local', calendar_id: 'local' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest(),
      executorResult: { source_id: 'evt-1', ical_uid: 'evt-1@local.recued' },
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      step_id: 'create',
      collection: 'calendar',
      entity_id: 'evt-1',
      access: 'write',
      kind: 'execution.write',
    });
  });

  it('⛔ reaches a NESTED id, which is where every work-entity op keeps it', async () => {
    // `id_output_field` took a bare key because the two families that declared
    // `writes` first — mail and calendar — happen to return the written id as a
    // TOP-LEVEL scalar. Every work-entity op returns `{ <kind>: { id, … } }`,
    // so the format could not express the shape of the ops that most need it:
    // a recipe creating a task emitted NO link, and `data.timeline('task:<id>')`
    // was empty for every owner, forever.
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'task-create',
      input: { title: 'Ship it' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest({
        slug: 'task-create',
        output: { task: 'task' },
        writes: { collection: 'task', id_output_field: 'task.id' },
      }),
      executorResult: { task: { id: 'task-7', title: 'Ship it' } },
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      collection: 'task', entity_id: 'task-7', access: 'write',
    });
  });

  it('a path that resolves to a non-scalar keys no link, rather than a malformed one', async () => {
    // ⚠ The guard the flat version already had, now that a path can end
    // anywhere: a missing segment, a null, or an object is not an id.
    for (const result of [
      { task: {} },                    // no id
      { task: { id: '' } },            // empty
      { task: { id: { nested: 1 } } }, // not a scalar
      { task: null },                  // null mid-path
      {},                              // missing entirely
    ]) {
      const step: RecipeStep = { id: 'create', ingredient: 'task-create', input: {} };
      const { ctx, emitted } = setup(step, {
        manifestForSlug: () => writesManifest({
          slug: 'task-create',
          output: { task: 'task' },
          writes: { collection: 'task', id_output_field: 'task.id' },
        }),
        executorResult: result,
      });
      await runStep(step, ctx);
      expect(emitted).toHaveLength(0);
    }
  });

  it('emits the write link even though the step reads no data.* ref', async () => {
    // The whole point of removing the `touches.length === 0` early-out:
    // a calendar mutation's input is a bare slug + source_id, no
    // `data.calendar.*` ref, so the read loop is empty.
    const step: RecipeStep = {
      id: 'del',
      ingredient: 'calendar-delete',
      input: { slug: 'local', source_id: 'evt-9' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () =>
        writesManifest({ slug: 'calendar-delete', risk_tier: 'destructive' }),
      // delete surfaces the id it removed (slice B adds source_id to its
      // result); with no data.* input ref this is the only link.
      executorResult: { deleted: true, source_id: 'evt-9' },
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      collection: 'calendar',
      entity_id: 'evt-9',
      access: 'write',
      kind: 'execution.write',
    });
  });

  it('classifies execution.derived when the step also read a different collection', async () => {
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'calendar-create',
      // the event body is derived from a contact record
      input: { slug: 'local', summary: '{{data.contact.alice.name}}' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest(),
      executorResult: { source_id: 'evt-2' },
    });
    await runStep(step, ctx);
    // one read link (contact:alice) + one write link (calendar:evt-2)
    const write = emitted.find((l) => l.access === 'write');
    expect(write).toMatchObject({
      collection: 'calendar',
      entity_id: 'evt-2',
      kind: 'execution.derived',
    });
    expect(emitted.find((l) => l.collection === 'contact')?.access).toBe('read');
  });

  it('stringifies a numeric id', async () => {
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'local' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest(),
      executorResult: { source_id: 12345 },
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].entity_id).toBe('12345');
  });

  it('emits no write link when the result lacks the declared id field', async () => {
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'local' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest(),
      executorResult: { ok: true }, // no source_id
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('emits no write link when the id is empty or non-scalar', async () => {
    for (const bad of [{ source_id: '' }, { source_id: {} }, { source_id: null }]) {
      const step: RecipeStep = {
        id: 'create',
        ingredient: 'calendar-create',
        input: { slug: 'local' },
      };
      const { ctx, emitted } = setup(step, {
        manifestForSlug: () => writesManifest(),
        executorResult: bad,
      });
      await runStep(step, ctx);
      expect(emitted).toHaveLength(0);
    }
  });

  it('does NOT emit a write link for an action ingredient without a writes declaration', async () => {
    // Scoping proof — the general action manifest (send-email) writes no
    // provenance for its result, only read links from its inputs.
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'local' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest({ writes: undefined }),
      executorResult: { source_id: 'evt-3' },
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('honors recipe.provenance === false for the write link', async () => {
    const step: RecipeStep = {
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'local' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () => writesManifest(),
      executorResult: { source_id: 'evt-4' },
      provenance: false,
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(0);
  });

  it('emits the write link INDEPENDENTLY of stepEmitsLinks (a declared write is not observational)', async () => {
    // A `writes` declaration means the step mutated an entity — side-effecting
    // by definition — so it must emit even on a category `stepEmitsLinks`
    // rejects (here `category: 'data'`, which the read-link gate treats as
    // observational). Guards against a silently-dead `writes` declaration.
    const step: RecipeStep = {
      id: 'write',
      ingredient: 'odd-writer',
      input: { slug: 'local' },
    };
    const { ctx, emitted } = setup(step, {
      manifestForSlug: () =>
        writesManifest({ slug: 'odd-writer', category: 'data', risk_tier: 'read' }),
      executorResult: { source_id: 'evt-5' },
    });
    await runStep(step, ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      collection: 'calendar',
      entity_id: 'evt-5',
      access: 'write',
    });
  });
});
