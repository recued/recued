/** "Watch this element" — brick 1 (server scaffold + rpc).
 *
 *  Covers the pure scaffold builder, the `triggers.createElementWatch`
 *  handler (save provenance, idempotency, fail-closed input validation),
 *  and one integration assertion that saving the scaffold's `event_triggers`
 *  materializes a DISARMED `origin:'recipe'` dom-watch row (the D-179 P5c
 *  default-off posture the owner chose for this affordance — the user arms
 *  it in #automation; the gesture never silently starts polling). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeDomWatchTarget } from '@recued/contracts';
import { validateRecipe } from '@recued/recipes';
import type { RecipeDefinition } from '@recued/contracts';
import {
  buildElementWatchRecipe,
  elementWatchRecipeId,
  ELEMENT_WATCH_PUBLISHER,
  ELEMENT_WATCH_RECIPE_ID_PREFIX,
} from '../triggers/element-watch-recipe.js';
import {
  handleCreateElementWatch,
  type ElementWatchRpcDeps,
} from '../element-watch-handler.js';
import { reconcileDeclarativeTriggers } from '../triggers/declarative-reconciler.js';
import { createEventTriggersStore } from '../triggers/store.js';

const URL = 'https://app.hubspot.com/contacts/*';
const SELECTOR = "[data-test-id='deal-stage']";

// ── A minimal RecipeStore fake — the handler only calls get() + save() ──
interface SavedRow {
  recipe: RecipeDefinition;
  publisher_id: string;
  source: string;
}
const fakeRecipeStore = () => {
  const saved = new Map<string, SavedRow>();
  const store = {
    get: (id: string): RecipeDefinition | null => saved.get(id)?.recipe ?? null,
    save: (recipe: RecipeDefinition, publisher_id: string, source: string) => {
      saved.set(recipe.recipe_id, { recipe, publisher_id, source });
    },
  };
  return {
    saved,
    deps: { recipeStore: store } as unknown as ElementWatchRpcDeps,
  };
};

describe('buildElementWatchRecipe', () => {
  it('produces a recipe that passes validateRecipe with no error-severity issues', () => {
    const r = buildElementWatchRecipe({ url: URL, selector: SELECTOR });
    expect(r.output).toEqual({
      render: [{ type: 'text', source: 'step.new_text' }],
    });
    const res = validateRecipe(r);
    expect(res.valid).toBe(true);
    // Only `error`-severity issues block (the handler gates on `valid`). The
    // `notification_send` requires-warn is corpus-wide forward-compat (every
    // shipped notify recipe carries it), and the orphan-step info on the
    // side-effecting notify step is benign — neither affects validity.
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('mints a deterministic, grammar-compliant recipe_id (idempotent re-watch)', () => {
    const a = buildElementWatchRecipe({ url: URL, selector: SELECTOR });
    const b = buildElementWatchRecipe({ url: URL, selector: SELECTOR });
    expect(a.recipe_id).toBe(b.recipe_id);
    expect(a.recipe_id).toBe(elementWatchRecipeId(URL, SELECTOR));
    expect(a.recipe_id.startsWith(ELEMENT_WATCH_RECIPE_ID_PREFIX)).toBe(true);
    // recipe_id grammar (validate/structural.ts): lowercase [a-z0-9-], no edge hyphen.
    expect(a.recipe_id).toMatch(/^[a-z0-9-]+$/);
    expect(a.recipe_id.endsWith('-')).toBe(false);
  });

  it('distinct targets → distinct ids (url XOR selector difference)', () => {
    const base = elementWatchRecipeId(URL, SELECTOR);
    expect(elementWatchRecipeId('https://other.example.com/*', SELECTOR)).not.toBe(base);
    expect(elementWatchRecipeId(URL, '.different-selector')).not.toBe(base);
  });

  it('carries the element.changed dom sugar with the literal target', () => {
    const r = buildElementWatchRecipe({ url: URL, selector: SELECTOR });
    expect(r.event_triggers).toEqual([
      { on: 'element.changed', url: URL, selector: SELECTOR },
    ]);
  });

  it('is a local, non-chat-exposed notify recipe (default-text step + notification-send)', () => {
    const r = buildElementWatchRecipe({ url: URL, selector: SELECTOR });
    expect(r.metadata.author).toBe(ELEMENT_WATCH_PUBLISHER);
    expect(r.chat_exposed).toBe(false);
    expect(r.requires).toContain('notification_send');
    const ids = r.steps.map((s) => s.id);
    expect(ids).toEqual(['new_text', 'notify']);
    const newText = r.steps.find((s) => s.id === 'new_text') as Record<string, unknown>;
    expect(newText.transform).toBe('default');
    expect(newText.value).toBe('{{context.event.payload.record.text}}');
    const notify = r.steps.find((s) => s.id === 'notify') as Record<string, unknown>;
    expect(notify.ingredient).toBe('notification-send');
    expect((notify.input as Record<string, unknown>).text).toContain('{{step.new_text}}');
  });

  it('uses a provided label, falling back to a host-derived name when blank', () => {
    expect(buildElementWatchRecipe({ url: URL, selector: SELECTOR, label: 'My deal stage' }).metadata.name)
      .toBe('My deal stage');
    // whitespace-only label is treated as absent
    expect(buildElementWatchRecipe({ url: URL, selector: SELECTOR, label: '   ' }).metadata.name)
      .toBe('Watch element on app.hubspot.com');
    expect(buildElementWatchRecipe({ url: URL, selector: SELECTOR }).metadata.name)
      .toBe('Watch element on app.hubspot.com');
  });
});

describe('handleCreateElementWatch', () => {
  it('saves a local inline recipe and reports created:true', async () => {
    const { saved, deps } = fakeRecipeStore();
    const res = await handleCreateElementWatch(deps, { url: URL, selector: SELECTOR });
    expect(res).toEqual({ recipe_id: elementWatchRecipeId(URL, SELECTOR), created: true });
    const row = saved.get(res.recipe_id)!;
    expect(row.publisher_id).toBe(ELEMENT_WATCH_PUBLISHER);
    expect(row.source).toBe('inline');
  });

  it('is idempotent — re-watching the same target overwrites and reports created:false', async () => {
    const { saved, deps } = fakeRecipeStore();
    await handleCreateElementWatch(deps, { url: URL, selector: SELECTOR, label: 'first' });
    const res2 = await handleCreateElementWatch(deps, { url: URL, selector: SELECTOR, label: 'second' });
    expect(res2.created).toBe(false);
    expect(saved.size).toBe(1);
    // the overwrite carries the latest label
    expect(saved.get(res2.recipe_id)!.recipe.metadata.name).toBe('second');
  });

  it('rejects empty url / empty selector', async () => {
    const { deps } = fakeRecipeStore();
    await expect(handleCreateElementWatch(deps, { url: '', selector: SELECTOR })).rejects.toThrow(/url/);
    await expect(handleCreateElementWatch(deps, { url: URL, selector: '  ' })).rejects.toThrow(/selector/);
  });

  it('rejects a whitespace-bearing url (would split the watch target)', async () => {
    const { saved, deps } = fakeRecipeStore();
    await expect(
      handleCreateElementWatch(deps, { url: 'https://a b.com/*', selector: SELECTOR }),
    ).rejects.toThrow(/whitespace-free/);
    expect(saved.size).toBe(0);
  });

  it('rejects a structurally-invalid url and saves nothing (Codex MED — fail-closed)', async () => {
    const { saved, deps } = fakeRecipeStore();
    for (const url of ['not-a-url', 'ftp:/bad', 'javascript:alert(1)']) {
      await expect(
        handleCreateElementWatch(deps, { url, selector: SELECTOR }),
      ).rejects.toThrow(/Chrome match pattern/);
    }
    expect(saved.size).toBe(0);
  });
});

describe('scaffold → reconciler integration', () => {
  let db: Database.Database;
  afterEach(() => db.close());
  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('materializes exactly one DISARMED origin:recipe dom-watch row (the user arms it in #automation)', () => {
    const store = createEventTriggersStore(db);
    const recipe = buildElementWatchRecipe({ url: URL, selector: SELECTOR });
    let mint = 0;
    reconcileDeclarativeTriggers({
      store,
      listStored: () => [
        {
          recipe_id: recipe.recipe_id,
          publisher_id: ELEMENT_WATCH_PUBLISHER,
          recipe_json: JSON.stringify(recipe),
        },
      ],
      now: () => 5_000,
      mintTriggerId: () => `t-${++mint}`,
    });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('recipe');
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].pattern).toBe(
      `data.dom.element.${encodeDomWatchTarget(URL, SELECTOR)}.updated`,
    );
  });
});
