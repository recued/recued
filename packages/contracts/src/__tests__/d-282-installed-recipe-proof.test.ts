/** D-282 — the read-only proof on an INSTALLED recipe.
 *
 *  ⛔⛔ THE HOLE THESE PIN. Pack install LOWERS each `<publisher>.<pack>.<op>`
 *  step into a call on the pack's catalog ingredient and stores that body, and
 *  every proof here read only `op`. So on an installed pack every read failed
 *  closed: `rental-book`, driven live against a booted server, showed no views
 *  and no lookups, just eighteen operation buttons, its list and detail pages
 *  among them. Every earlier check fed AUTHORED bodies, where the same recipes
 *  classify correctly, so nothing but the live drive could see it.
 *
 *  The step shapes below are the ones `resolvePackOpStepRecipes` emits; the
 *  real-install test in `rental-book-business-workflow.test.ts` runs the real
 *  lowering. */
import { describe, expect, it } from 'vitest';

import {
  buildPackOperationIndex,
  isProvablyReadOnly,
  kernelOpBackingSlug,
  kernelOpDelivers,
  kernelOpIsWatcher,
  recipeDeclaredOps,
  recipeRecordsUsage,
  recipeSpendsPerRun,
  stepsAreAnalysable,
} from '../index.js';

const PACK = {
  slug: 'rental-book',
  publisher: 'recued-core',
  name: 'Rental Book',
  manifest: {
    contents: [{
      type: 'composition',
      composition: {
        schema_version: 1,
        slug: 'rental-book',
        operations: [
          {
            op: 'building.search', ingredient: 'rental-book', risk: 'read',
            bind: { kind: 'core.records', action: 'search', entity: 'building' },
          },
          {
            op: 'building.create', ingredient: 'rental-book', risk: 'write',
            bind: { kind: 'core.records', action: 'create', entity: 'building' },
          },
        ],
      },
    }],
  },
} as never;

/** What install names a Records catalog: a digest of the owner. */
const CATALOG = 'records-7a22a7e8f412e8dc19128db7db1f393c';
const installed = buildPackOperationIndex([PACK], new Map([[CATALOG, 'recued-core.rental-book']]));
const noCatalogs = buildPackOperationIndex([PACK]);

/** A body as install stores it: the op step lowered onto the catalog. */
const lowered = (operation: string, ingredient = CATALOG): never => ({
  recipe_id: 'list-buildings',
  steps: [
    { id: 'cap', transform: 'clamp', input: '{{config.limit}}', min: 1, max: 200 },
    { id: 'read', ingredient, input: { operation, args: { limit: '{{step.cap}}' } } },
    { id: 'rows', transform: 'default', value: '{{step.read.records}}', fallback: [] },
  ],
} as never);

const authored = (op: string): never => ({
  recipe_id: 'list-buildings',
  steps: [{ id: 'read', op, args: {} }],
} as never);

describe('the read-only proof on a body install lowered', () => {
  it('⛔ proves a lowered read exactly as it proves the authored op', () => {
    expect(isProvablyReadOnly(lowered('building.search'), installed)).toBe(true);
    expect(isProvablyReadOnly(lowered('building.search'), installed))
      .toBe(isProvablyReadOnly(authored('recued-core.rental-book.building.search'), installed));
  });

  it('⛔ a lowered WRITE is still a write', () => {
    expect(isProvablyReadOnly(lowered('building.create'), installed)).toBe(false);
  });

  it('reads a lowered PREFETCH step the same way', () => {
    const prefetched = {
      recipe_id: 'list-buildings',
      prefetch_steps: [{ id: 'read', ingredient: CATALOG, input: { operation: 'building.search', args: {} } }],
      steps: [{ id: 'rows', transform: 'default', value: '{{step.read.records}}', fallback: [] }],
    } as never;
    expect(isProvablyReadOnly(prefetched, installed)).toBe(true);
  });

  it('⛔ without the catalog map a lowered step is not understood, so it fails closed', () => {
    // The answer every caller gave before the fix, and the one a caller that
    // cannot derive catalog slugs still gives.
    expect(stepsAreAnalysable((lowered('building.search') as { steps: unknown }).steps, noCatalogs)).toBe(false);
    expect(isProvablyReadOnly(lowered('building.search'), noCatalogs)).toBe(false);
  });

  it('⛔ an operation the pack does not declare stays unresolved, so it fails closed', () => {
    expect(isProvablyReadOnly(lowered('building.teleport'), installed)).toBe(false);
    expect(recipeDeclaredOps(lowered('building.teleport'), installed).unresolved)
      .toEqual(['recued-core.rental-book.building.teleport']);
  });

  it('⛔ an ingredient no map names stays un-analysable — nothing is guessed at', () => {
    expect(isProvablyReadOnly(lowered('building.search', 'some-unknown-ingredient'), installed)).toBe(false);
  });

  it('the Records disclosure and the declared risk read a lowered body too', () => {
    expect(recipeRecordsUsage(lowered('building.create'), installed)).toEqual([{
      pack_ref: 'recued-core.rental-book',
      pack_name: 'Rental Book',
      entities: [{ entity: 'building', actions: ['create'], effects: ['write'] }],
    }]);
    expect(recipeDeclaredOps(lowered('building.create'), installed).risk).toBe('write');
  });
});

/** A KERNEL op lowers the same way, onto its backing ingredient
 *  (`resolveKernelClosedKindOpStep`: `{ ingredient: backing_slug, input: args }`).
 *  Backing slugs come from the registry, so these follow it rather than a
 *  spelling. */
describe('the proofs on a kernel op install lowered', () => {
  const lowered = (...ops: string[]): never => ({
    recipe_id: 'r',
    steps: ops.map((op) => ({ id: op, ingredient: kernelOpBackingSlug(op)!, input: {} })),
  } as never);

  it('⛔ proves a lowered kernel read as the op it backs, with no catalog map', () => {
    expect(isProvablyReadOnly(lowered('core.data.calendar.list'), noCatalogs)).toBe(true);
  });

  it('⛔ a lowered kernel WRITE is still a write', () => {
    expect(isProvablyReadOnly(lowered('core.data.calendar.list', 'core.mail.send'), noCatalogs)).toBe(false);
  });

  it('⛔ the cost half sees a lowered AI call, and only that', () => {
    expect(recipeSpendsPerRun(lowered('core.ai.classify'))).toBe(true);
    expect(recipeSpendsPerRun(lowered('core.data.calendar.list'))).toBe(false);
  });

  it('⛔ an ingredient that is both a kernel backing slug and a mapped catalog is neither', () => {
    const slug = kernelOpBackingSlug('core.data.calendar.list')!;
    const both = buildPackOperationIndex([PACK], new Map([[slug, 'recued-core.rental-book']]));
    expect(stepsAreAnalysable([{ id: 'k', ingredient: slug, input: { operation: 'building.search' } }], both))
      .toBe(false);
  });
});

/** A `read`-risk op can still DELIVER something. `core.notification.send` and
 *  `core.preapproval.request` change no stored record, so the approval gate is
 *  right to call them reads, but nothing that runs unasked may send.
 *  `meeting-action-item-digest-fireflies` reads meetings and, by default,
 *  notifies: it classified as a view, and only the lowering bug that hid every
 *  installed kernel step kept it from notifying on every tab switch. */
describe('a recipe that delivers is not read-only, whatever its approval risk', () => {
  it('names the delivering ops by entity', () => {
    expect(kernelOpDelivers('core.notification.send')).toBe(true);
    expect(kernelOpDelivers('core.preapproval.request')).toBe(true);
    expect(kernelOpDelivers('core.data.calendar.list')).toBe(false);
  });

  it('⛔ refuses an authored notification send after a read', () => {
    const authoredSend = {
      recipe_id: 'digest',
      steps: [
        { id: 'read', op: 'recued-core.rental-book.building.search', args: {} },
        { id: 'notify', op: 'core.notification.send', args: {} },
      ],
    } as never;
    expect(isProvablyReadOnly(authoredSend, noCatalogs)).toBe(false);
  });

  it('⛔ refuses a notification send install lowered', () => {
    const loweredSend = {
      recipe_id: 'digest',
      steps: [{ id: 'notify', ingredient: kernelOpBackingSlug('core.notification.send')!, input: {} }],
    } as never;
    expect(isProvablyReadOnly(loweredSend, noCatalogs)).toBe(false);
  });
});

/** `csv.filter` SAVES its matches as a new file record on every run, so it is a
 *  write and never runs unasked. It was rated `read` on its name, which would
 *  have let a view add a file on every tab switch. Its reading twin, `csv.rows`,
 *  returns the matches and saves nothing, so a view may use it. */
describe('a CSV search auto-runs only when it saves nothing', () => {
  const csvRecipe = (step: Record<string, unknown>): never => ({
    recipe_id: 'sheet-search', steps: [step],
  } as never);

  it('proves csv.rows read-only, authored or lowered', () => {
    expect(isProvablyReadOnly(csvRecipe({ id: 's', op: 'core.storage.csv.rows', args: {} }), noCatalogs))
      .toBe(true);
    expect(isProvablyReadOnly(
      csvRecipe({ id: 's', ingredient: kernelOpBackingSlug('core.storage.csv.rows')!, input: {} }),
      noCatalogs,
    )).toBe(true);
  });

  it('⛔ refuses csv.filter, authored or lowered, because it saves', () => {
    expect(isProvablyReadOnly(csvRecipe({ id: 's', op: 'core.storage.csv.filter', args: {} }), noCatalogs))
      .toBe(false);
    expect(isProvablyReadOnly(
      csvRecipe({ id: 's', ingredient: kernelOpBackingSlug('core.storage.csv.filter')!, input: {} }),
      noCatalogs,
    )).toBe(false);
  });
});

/** Watchers are `risk: 'read'` for the approval gate, but `core.watch.http`
 *  fetches a URL the recipe names and `core.watch.webhook` drains its queue. No
 *  view can reach one today (the validator admits watchers only in
 *  `trigger_steps`, which requires `auto_run`, which makes an automation), so
 *  these pin the backstop for when that chain loosens. */
describe('a watcher is never read-only for a view, whatever its approval risk', () => {
  const recipe = (field: 'steps' | 'trigger_steps', step: Record<string, unknown>): never =>
    ({ recipe_id: 'w', steps: [], [field]: [step] }) as never;

  it('names the watchers by entity', () => {
    expect(kernelOpIsWatcher('core.watch.http')).toBe(true);
    expect(kernelOpIsWatcher('core.watch.time-relative')).toBe(true);
    expect(kernelOpIsWatcher('core.data.calendar.list')).toBe(false);
  });

  it('proves a plain read in the same position — the control', () => {
    expect(isProvablyReadOnly(
      recipe('trigger_steps', { id: 'r', op: 'core.data.calendar.list', args: {} }), noCatalogs,
    )).toBe(true);
  });

  it('⛔ refuses an authored watcher', () => {
    expect(isProvablyReadOnly(
      recipe('trigger_steps', { id: 'w', op: 'core.watch.http', args: {} }), noCatalogs,
    )).toBe(false);
  });

  it('⛔ refuses a watcher install lowered', () => {
    expect(isProvablyReadOnly(
      recipe('trigger_steps', { id: 'w', ingredient: kernelOpBackingSlug('core.watch.http')!, input: {} }),
      noCatalogs,
    )).toBe(false);
  });

  it('⛔ refuses a watcher even where the validator would not admit one', () => {
    expect(isProvablyReadOnly(
      recipe('steps', { id: 'w', op: 'core.watch.time-relative', args: {} }), noCatalogs,
    )).toBe(false);
  });
});
