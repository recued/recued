/** D-247 D15 — the install picker's disclosure, resolved SERVER-side.
 *
 *  ⛔⛔ THE MANIFEST CANNOT ANSWER THIS. `chat_exposed` lives on the recipe BODY,
 *  and 0 of 2,310 shipped refs across 340 packs carry one — a picker reasoning
 *  from the manifest alone can show a COUNT and cannot say WHICH. So the preview
 *  runs `resolvePackRecipeBodies`, the SAME function the install runs, because
 *  a preview that named a different set from the one the install enables is worse
 *  than no preview: the owner would have consented to a list that was never true.
 *
 *  ⛔ AND THERE IS NO PRECISE-LOOKING FALLBACK. Unresolvable ⇒ `resolved: false`
 *  and the picker renders nothing. A count it cannot verify is the
 *  assurance-shaped non-assurance this substrate refuses. */

import { describe, expect, it } from 'vitest';
import { buildPackInstallPreview } from '../pack-install-preview.js';

const recipe = (
  recipe_id: string,
  chat_exposed: boolean,
  steps: unknown[] = [{ id: 's', op: 'core.mail.send', input: {} }],
) => ({
  recipe_id, version: 1, ttl: 300, chat_exposed,
  metadata: { name: `The ${recipe_id}`, description: 'd', author: 'recued-core' },
  variables: {}, prefetch_steps: [], steps, output: { sidebar: [] },
});

const manifest = (slugs: string[]) => ({
  pack_slug: 'fleet-money', publisher: 'recued-core', version: 1,
  name: 'Fleet Money', description: 'd',
  recipes: slugs.map((slug) => ({ slug, version: 1 })),
} as never);

const deps = (bodies: Record<string, unknown>) => ({
  recipeStore: { getBundled: (slug: string) => (bodies[slug] ?? null) as never },
  getManifest: () => undefined,
});

describe('D-247 D15 — buildPackInstallPreview', () => {
  it('names the recipes the install will ENABLE, and counts the hidden ones', async () => {
    // The copy names recipes, not a number: "3 recipes will be enabled" tells the
    // owner nothing they can act on; the names are what let them cancel.
    const out = await buildPackInstallPreview(manifest(['open', 'quiet']), deps({
      open: recipe('open', true),
      quiet: recipe('quiet', false),
    }));
    expect(out.resolved).toBe(true);
    expect(out.will_enable.map((r) => r.recipe_id)).toEqual(['open']);
    expect(out.will_enable[0]!.name).toBe('The open');
    expect(out.hidden_count).toBe(1);
  });

  it('classifies a single-op pass-through over a WRITE as an open adapter', async () => {
    // D10 — "grants core.mail.send (write) with no added constraint" is the same
    // statement as "grants this recipe", and the copy must say so.
    const out = await buildPackInstallPreview(manifest(['adapter']), deps({
      adapter: recipe('adapter', true, [{ id: 's', op: 'core.mail.send', input: {} }]),
    }));
    expect(out.will_enable[0]).toMatchObject({
      grant_class: 'open_adapter', top_risk: 'write',
    });
  });

  it('classifies a single-op pass-through over a READ as a read adapter', async () => {
    const out = await buildPackInstallPreview(manifest(['peek']), deps({
      peek: recipe('peek', true, [{ id: 's', op: 'core.mail.get', input: {} }]),
    }));
    expect(out.will_enable[0]).toMatchObject({ grant_class: 'read_adapter', top_risk: 'read' });
  });

  it('classifies a guarded or multi-op recipe as CONSTRAINING', async () => {
    const guarded = await buildPackInstallPreview(manifest(['guarded']), deps({
      guarded: recipe('guarded', true, [
        { id: 's', op: 'core.mail.send', input: {}, skip_when: '{{x}} is_null' },
      ]),
    }));
    expect(guarded.will_enable[0]!.grant_class).toBe('constraining');

    const multi = await buildPackInstallPreview(manifest(['multi']), deps({
      multi: recipe('multi', true, [
        { id: 'a', op: 'core.mail.get', input: {} },
        { id: 'b', op: 'core.mail.send', input: {} },
      ]),
    }));
    expect(multi.will_enable[0]!.grant_class).toBe('constraining');
    expect(multi.will_enable[0]!.top_risk).toBe('write');   // the HIGHEST, not the first
  });

  it('reports UNKNOWN rather than guessing when the closure is underivable', async () => {
    // A templated dispatch has no honest closure. A confident wrong label is
    // worse than an honest blank, because the owner acts on the sentence.
    const out = await buildPackInstallPreview(manifest(['dyn']), deps({
      dyn: recipe('dyn', true, [{ id: 's', ingredient: '{{config.slug}}', input: {} }]),
    }));
    expect(out.will_enable[0]).toMatchObject({ grant_class: 'unknown', top_risk: null });
  });

  it('⛔ an UNRESOLVABLE ref yields resolved:false, never a partial list', async () => {
    // The install itself fails on a ref whose body resolves to null, so the
    // preview inherits that failure mode rather than inventing an "unknown"
    // state — and the picker renders nothing rather than a count it cannot stand
    // behind.
    const out = await buildPackInstallPreview(manifest(['open', 'missing']), deps({
      open: recipe('open', true),
    }));
    expect(out).toEqual({ resolved: false, will_enable: [], hidden_count: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────
// The composition root
// ──────────────────────────────────────────────────────────────────

/** ⛔⛔ THE TESTS ABOVE PASS `getManifest: () => undefined` AND SO TEST ONLY THE
 *  DEGRADED PATH — which is exactly what production was, silently, because
 *  `composePackInstallRpcDeps` never received the dep. `packs.install_preview`
 *  would have answered `grant_class: 'unknown'` for every recipe on every real
 *  server: the disclosure renders, and says nothing.
 *
 *  🔑 A stub that supplies a dep the composition root does not is not a test of
 *  the feature; it is a test of the stub. These assert the forwarding itself. */
describe('D-247 D15 — the preview deps reach the handler', () => {
  it('the composer forwards `getManifest` and `grantEntryStore`', async () => {
    const { composePackInstallRpcDeps } = await import(
      '../composition/bin/wire-pack-install-rpc-deps.js'
    );
    const getManifest = (): undefined => undefined;
    const grantEntryStore = {} as never;
    const { packInstallDeps } = composePackInstallRpcDeps({
      recipeStore: {} as never,
      getManifest,
      grantEntryStore,
    });
    expect(packInstallDeps?.getManifest).toBe(getManifest);
    expect(packInstallDeps?.grantEntryStore).toBe(grantEntryStore);
  });

  it('⛔ and `compose-rpc-context` actually SUPPLIES them', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'serve', 'compose-rpc-context.ts'),
      'utf-8',
    );
    // The composer being ABLE to forward is half the bug; being GIVEN something
    // is the other half. Anchored on the packs-install call, not the file.
    const call = src.slice(src.indexOf('composePackInstallRpcDeps({'));
    const packsCall = call.slice(0, call.indexOf('});') + 3);
    expect(packsCall).toMatch(/\bgetManifest:/);
    expect(packsCall).toMatch(/\bgrantEntryStore:/);
    expect(packsCall).toContain('executorConfig.manifests.get(slug)');
  });
});
