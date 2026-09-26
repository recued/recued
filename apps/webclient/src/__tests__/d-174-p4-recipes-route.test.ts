import { describe, expect, it, vi } from 'vitest';
import type {
  AutoRunStatusEntry,
  ConnectionView,
  DependencyResolution,
  Dish,
  RecipeDefinition,
  RecipeRunnabilityEntry,
  ResolvedFilterDescriptor,
  RunnabilityStatus,
  ServerExecuteResponse,
  ServerRecipeFullEntry,
  ServerRecipeListEntry,
} from '@recued/contracts';

import { RunModal } from '@recued/ui-shared';

import {
  RECIPES_ROUTE_BACK_ATTR,
  RECIPES_ROUTE_CONNECTIONS_ATTR,
  RECIPES_ROUTE_CONNECTIONS_LINK_ATTR,
  RECIPES_ROUTE_DEFINITION_ATTR,
  RECIPES_ROUTE_DETAIL_ATTR,
  RECIPES_ROUTE_DETAIL_HEADING_ATTR,
  RECIPES_ROUTE_EDIT_LINK_ATTR,
  RECIPES_ROUTE_FROM_PACK_ATTR,
  RECIPES_ROUTE_RECORDS_ATTR,
  RECIPES_ROUTE_RECORDS_PACK_ATTR,
  RECIPES_ROUTE_HEADING_ATTR,
  RECIPES_ROUTE_HOST_ATTR,
  RECIPES_ROUTE_KITCHEN_LINK_ATTR,
  RECIPES_ROUTE_COUNT_ATTR,
  RECIPES_ROUTE_PAGER_ATTR,
  RECIPES_ROUTE_PAGER_CONTROL_ATTR,
  RECIPES_ROUTE_RECIPE_CARD_ATTR,
  RECIPES_ROUTE_RECIPE_OPEN_ATTR,
  RECIPES_ROUTE_RECIPE_TRIGGER_ATTR,
  RECIPES_ROUTE_RELATED_ATTR,
  RECIPES_ROUTE_RELATED_ROW_ATTR,
  RECIPES_ROUTE_RESULT_PANEL_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_FILE_ATTR,
  RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR,
  RECIPES_ROUTE_RESULT_FACTS_ATTR,
  RECIPES_ROUTE_RESULT_REASON_ATTR,
  RECIPES_ROUTE_RESULT_PROVENANCE_ATTR,
  RECIPES_ROUTE_RESULT_RETURN_ATTR,
  RECIPES_ROUTE_RESULT_SECTION_ATTR,
  RECIPES_ROUTE_RUN_BUTTON_ATTR,
  RECIPES_ROUTE_RUNNABILITY_ATTR,
  RECIPES_ROUTE_RUNS_LINK_ATTR,
  RECIPES_ROUTE_AUTOMATION_LINK_ATTR,
  RECIPES_ROUTE_AUTO_RUN_ERROR_ATTR,
  RECIPES_ROUTE_BUNDLE_RETRY_ATTR,
  RECIPES_ROUTE_BUNDLE_STATUS_ATTR,
  RECIPES_ROUTE_STYLES_MARKER,
  bootstrapRecipesRoute,
  type RecipeExecuteCaller,
  type RecipeFileReadCaller,
  type RecipesConnectionsListCaller,
  type RecipesListCaller,
  type RecipesRunnabilityCaller,
} from '../recipes/bootstrap-recipes-route.js';

import {
  autoRunStatus,
  deferred,
  executeResponse,
  makeFakeDocument,
  makeFakeEl,
  mountRoute,
  recipeDefinition,
  recipeEntry,
  targetRecipeWithEntityContext,
  type FakeDoc,
  type FakeEl,
} from './helpers/recipes-route-rig.js';

// The Run modal is the shared `@recued/ui-shared` RunModal — it portals to
// `opts.root` (no `body` in the fake doc), a SIBLING of the route host, and
// renders into that overlay element's `innerHTML`. This finds that overlay's
// HTML (empty string when no modal is open).
const runModalHtml = (root: FakeEl): string =>
  root.children.find((c) =>
    c.innerHTML.includes(RunModal.RUN_MODAL_OVERLAY_ATTR),
  )?.innerHTML ?? '';

type RecipesRouteSubscribe = NonNullable<
  Parameters<typeof bootstrapRecipesRoute>[0]['subscribe']
>;

const shellHtml = (root: FakeEl): string => root.children[0]!.innerHTML;

const RESULT_ACTION_SELECT_ATTR = 'data-recued-recipes-result-action-select';

/** D-282 B1 — a group of three or fewer runnable actions renders as BUTTONS, each with
 *  its own label, variant and action id. Only a wider group collapses into the picker
 *  that `resultActionSelection` reads. */
const inlineResultActionIds = (html: string): string[] =>
  [...html.matchAll(new RegExp(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="([^"]+)"`, 'g'))]
    .map((m) => m[1]!);

const resultActionSelection = (
  html: string,
): { groupId: string | undefined; actionIds: string[] } => ({
  groupId: html.match(
    new RegExp(`${RESULT_ACTION_SELECT_ATTR}="([^"]+)"`),
  )?.[1],
  actionIds: [...html.matchAll(/<option value="([^"]+)">/g)]
    .map((m) => m[1]!),
});

const appendSelectedResultAction = (
  doc: FakeDoc,
  routeRoot: FakeEl,
  groupId: string,
  actionId: string,
): void => {
  const select = doc.createElement('select') as FakeEl & { value: string };
  select.setAttribute(RESULT_ACTION_SELECT_ATTR, groupId);
  select.value = actionId;
  routeRoot.appendChild(select);
};

const clickRecipeAction = (
  root: FakeEl,
  action: string,
  recipeId: string,
  extraAttrs: Record<string, string> = {},
): void => {
  const actionTarget = {
    textContent: '',
    contains: () => false,
    getAttribute: (name: string) => {
      if (Object.prototype.hasOwnProperty.call(extraAttrs, name)) return extraAttrs[name]!;
      if (name === 'data-recued-recipes-action') return action;
      if (name === 'data-recipe-id') return recipeId;
      return null;
    },
    setAttribute: vi.fn(),
  };
  const target = {
    closest: (selector: string) =>
      selector.includes('data-recued-recipes-action') ? actionTarget : null,
  };
  for (const fn of root.children[0]!.listeners.get('click') ?? []) {
    fn({ target, preventDefault: vi.fn() } as unknown as Event);
  }
};

describe('R24 — Recipes route: list view', () => {
  it('⛔⛔ opening a detail PUSHES so native Back returns to the list, not past it', async () => {
    /** `#recipes` → `#recipes/<id>` used `replaceState` for the whole transition, which
     *  OVERWROTE the list entry — so the browser's Back button skipped the list and
     *  landed a level above it, on the route the owner came from rather than the one
     *  they were looking at. Same defect as `#packs` and `#data`; the three shared one
     *  hash-sync shape, so they shared the bug.
     *  🔑 `pushState` emits no `hashchange` either, so the reason `replaceState` was
     *  chosen — in-page navigation must never remount — is untouched.
     *  ⚠ Asserted as the ORDERED sequence of history calls. "pushState was called" alone
     *  would pass even if it also pushed on the way back, which would trap Back in a
     *  loop bouncing the owner into the recipe they just closed. */
    const calls: string[] = [];
    const rig = mountRoute({
      history: {
        replaceState: (_d, _u, url) => { calls.push(`replace ${String(url)}`); },
        pushState: (_d, _u, url) => { calls.push(`push ${String(url)}`); },
      },
    });
    await rig.route.whenLoaded();

    rig.route.openRecipe('daily-brief');
    expect(calls, 'entering a detail must PUSH a history entry')
      .toContain('push #recipes/daily-brief');
    expect(calls, 'and must not merely replace the list away')
      .not.toContain('replace #recipes/daily-brief');

    /** Returning to the list REPLACES — pushing here too would leave two entries and
     *  Back would bounce the owner into the recipe they just closed. */
    rig.route.closeDetail();
    expect(calls).toContain('replace #recipes');
    expect(calls.filter((c) => c.startsWith('push ')),
      'only the detail-opening step may push').toEqual(['push #recipes/daily-brief']);
    rig.route.dispose();
  });

  it('⚠ mounting straight onto a deep link does NOT push — it is already that entry', async () => {
    /** ⛔ The counterpart the packs fix never needed (its surface skips `onNavigate` on
     *  initial paint). Here the route mounts with `initialRecipeId`, so the browser is
     *  ALREADY on `#recipes/<id>`. Pushing that would stack a duplicate entry and the
     *  owner's FIRST Back press would appear to do nothing — a worse bug than the one
     *  being fixed, because it looks like the button is broken.
     *  🔑 A "first sync is never a navigation" flag was tried and was WRONG: the list
     *  path does not sync on mount at all, so the flag swallowed the first REAL detail
     *  open. The tracker is seeded from the mounted selection instead, which is correct
     *  whether or not mount syncs — and this test is what tells the two apart. */
    const calls: string[] = [];
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      // Two entries: the sideways move below needs somewhere to go.
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry(), recipeEntry('second-recipe')],
      })),
      history: {
        replaceState: (_d, _u, url) => { calls.push(`replace ${String(url)}`); },
        pushState: (_d, _u, url) => { calls.push(`push ${String(url)}`); },
      },
    });
    await rig.route.whenLoaded();

    expect(calls.filter((c) => c.startsWith('push ')),
      'a deep-linked mount is not a navigation').toEqual([]);

    /** ⛔⛔ THE ASSERTION THE SEED ACTUALLY EARNS. Going DETAIL → DETAIL straight from a
     *  deep-linked mount must REPLACE: the owner is moving sideways, not a level down,
     *  and pushing would make Back walk every recipe they browsed through.
     *  🔑 Without seeding `syncedRecipeId` from the mounted selection this reads as a
     *  fresh entry into a detail and pushes. My first version of this test only checked
     *  that the MOUNT did not push, which a null seed also satisfies — the mutant
     *  survived. This is the transition that tells them apart. */
    rig.route.openRecipe('second-recipe');
    expect(calls.filter((c) => c.startsWith('push ')),
      'detail -> detail is sideways, not a level down').toEqual([]);
    expect(calls).toContain('replace #recipes/second-recipe');

    /** …and a genuine list -> detail after that still pushes, so the seed has not simply
     *  disabled pushing altogether. */
    rig.route.closeDetail();
    rig.route.openRecipe('daily-brief');
    expect(calls.filter((c) => c.startsWith('push ')))
      .toEqual(['push #recipes/daily-brief']);
    rig.route.dispose();
  });

  it('mounts the installed library from recipe.list + the tool catalog', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    expect(rig.recipesListCaller).toHaveBeenCalledTimes(1);
    expect(rig.toolCatalogCaller).toHaveBeenCalledTimes(1);
    expect(rig.doc.styleElements[0]?.attrs.has(RECIPES_ROUTE_STYLES_MARKER))
      .toBe(true);
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      `.recipes-actions > .recipes-inline-link,\n[${RECIPES_ROUTE_DETAIL_ATTR}] > .recipes-inline-link`,
    );
    expect(rig.doc.styleElements[0]?.textContent).toContain('min-height: 36px');
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      '.recipes-chip {\n  min-height: 36px;',
    );
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      `[${RECIPES_ROUTE_DEFINITION_ATTR}] summary {\n  box-sizing: border-box;\n  min-height: 36px;`,
    );
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      `min-height: 44px;\n    padding-block: 13px;`,
    );
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      `[${RECIPES_ROUTE_DEFINITION_ATTR}] {\n  min-width: 0;`,
    );
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      `width: 100%;\n  max-width: 100%;\n  margin: 8px 0 0;`,
    );
    expect(rig.doc.styleElements[0]?.textContent).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));',
    );
    expect(rig.doc.styleElements[0]?.textContent).toMatch(
      /\.recipe-card-name\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(rig.doc.styleElements[0]?.textContent).toMatch(
      /\.recipe-card-footer\s*\{[^}]*flex-wrap:\s*wrap/s,
    );
    expect(rig.doc.styleElements[0]?.textContent).toMatch(
      new RegExp(`\\[${RECIPES_ROUTE_DETAIL_ATTR}\\]\\s*\\{[^}]*min-width:\\s*0[^}]*max-width:\\s*100%`, 's'),
    );
    expect(rig.doc.styleElements[0]?.textContent).toMatch(
      /\.recipes-detail-name\s*\{[^}]*flex:\s*1 1 180px[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(rig.doc.styleElements[0]?.textContent).toMatch(
      /\.recipes-runnability-detail\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(rig.doc.styleElements[0]?.textContent).toMatch(
      /\.recipes-pii-detail\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );

    const shell = rig.root.children[0]!;
    expect(shell.attrs.has(RECIPES_ROUTE_HOST_ATTR)).toBe(true);
    expect(shell.innerHTML).toContain(RECIPES_ROUTE_HEADING_ATTR);
    expect(shell.innerHTML).toContain('Daily brief');
    expect(shell.innerHTML).toContain(RECIPES_ROUTE_KITCHEN_LINK_ATTR);
    // Pack machinery + the Exposed-tools section moved out of this route.
    expect(shell.innerHTML).not.toContain('Installed packs');
    expect(shell.innerHTML).not.toContain('Exposed tools');
    expect(rig.route.selectedRecipe()).toBeNull();

    rig.route.dispose();
  });

  it('separates preview, full detail, and contextual Run on each card', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    const card = html.match(
      new RegExp(`<div ${RECIPES_ROUTE_RECIPE_CARD_ATTR}="daily-brief"[^>]*>`),
    )?.[0] ?? '';
    expect(card).not.toContain('role="button"');
    expect(card).toContain('role="group" tabindex="0"');
    expect(card).toContain('Space to preview; Enter to open details.');
    expect(html).toContain('data-recued-recipes-action="preview-recipe"');
    expect(html).toContain('aria-label="Preview Daily brief"');
    expect(html).toContain(
      `${RECIPES_ROUTE_RECIPE_OPEN_ATTR}="daily-brief"`,
    );
    expect(html).toContain('aria-label="Open Daily brief details"');
    expect(html).toContain('aria-label="Run Daily brief"');

    rig.route.dispose();
  });

  it('routes a reactive card to Automation instead of offering a manual Run', async () => {
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('watch-mail', {
          recipe: recipeDefinition('watch-mail', {
            auto_run: { interval_ms: 60_000 },
            trigger_steps: [{ id: 'watch', ingredient: 'mail-watcher' }],
          } as unknown as Partial<RecipeDefinition>),
        })],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).not.toContain('data-recued-recipes-action="open-run"');
    expect(html).not.toContain(`${RECIPES_ROUTE_RUN_BUTTON_ATTR}="watch-mail"`);
    expect(html).toContain('href="#automation/watch-mail"');
    expect(html).toContain('aria-label="Manage automation for Daily brief"');

    rig.route.dispose();
  });

  it('keeps Refresh focusable while blocking duplicate in-flight reads', async () => {
    const secondRead = deferred<Awaited<ReturnType<RecipesListCaller>>>();
    let calls = 0;
    const recipesListCaller = vi.fn<RecipesListCaller>(async () => {
      calls += 1;
      if (calls === 1) return { recipes: [recipeEntry()] };
      return secondRead.promise;
    });
    const rig = mountRoute({ recipesListCaller });
    await rig.route.whenLoaded();

    clickRecipeAction(rig.root, 'refresh', '');
    expect(recipesListCaller).toHaveBeenCalledTimes(2);
    expect(shellHtml(rig.root)).toContain(
      'aria-disabled="true" aria-busy="true"',
    );
    expect(shellHtml(rig.root)).toContain('Refreshing…');

    clickRecipeAction(rig.root, 'refresh', '');
    expect(recipesListCaller).toHaveBeenCalledTimes(2);

    secondRead.resolve({ recipes: [recipeEntry()] });
    await rig.route.whenLoaded();
    expect(shellHtml(rig.root)).toContain(
      'aria-disabled="false" aria-busy="false"',
    );

    rig.route.dispose();
  });

  it('shows the per-card "from pack X" label (delta 3)', async () => {
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('hub-sync', {
            recipe: recipeDefinition('hub-sync', {
              depends_on: ['recued-core.hubspot'],
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_FROM_PACK_ATTR}="recued-core.hubspot"`);
    expect(html).toContain('data-recued-provenance');
    expect(html).toContain('from Hubspot');
    expect(html).toContain('href="#packs"');

    rig.route.dispose();
  });

  it('labels a pack-owned recipe that declares no depends_on', async () => {
    // The D-221 Records-pack shape: every member calls only its OWN pack's
    // Tier-P ops, so `depends_on` is legitimately absent and
    // `metadata.recipe_bundle` is the only provenance. Reading `depends_on`
    // alone rendered no label at all here.
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('list-job-board', {
            recipe: recipeDefinition('list-job-board', {
              metadata: {
                name: 'List the job board',
                description: 'Search Records by status.',
                author: 'recued-core',
                supported_platforms: [],
                recipe_bundle: 'recued-core/job-status-board',
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(
      `${RECIPES_ROUTE_FROM_PACK_ATTR}="recued-core.job-status-board"`,
    );
    expect(html).toContain('from Job status board');

    // …and the detail header carries the same label.
    clickRecipeAction(rig.root, 'open-recipe', 'list-job-board');
    expect(shellHtml(rig.root)).toContain('from Job status board');

    rig.route.dispose();
  });

  it('separates the owning pack from a co-installed dependency', async () => {
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('close-job', {
            recipe: recipeDefinition('close-job', {
              depends_on: ['recued-core.email-outbox-pack'],
              metadata: {
                name: 'Close a job',
                description: 'Close it and mail the customer.',
                author: 'recued-core',
                supported_platforms: [],
                recipe_bundle: 'recued-core/job-status-board',
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    // "from" is the owning pack; a dep the recipe merely calls is "needs".
    expect(html).toContain('from Job status board · needs Email outbox');
    expect(html).toContain(
      `${RECIPES_ROUTE_FROM_PACK_ATTR}="recued-core.job-status-board recued-core.email-outbox-pack"`,
    );

    rig.route.dispose();
  });

  it('filters a pack-owned recipe by its pack, and never as Standalone', async () => {
    const bundleMeta = {
      name: 'List the job board',
      description: 'Search Records by status.',
      author: 'recued-core',
      supported_platforms: [] as string[],
      recipe_bundle: 'recued-core/job-status-board',
    };
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('list-job-board', {
            recipe: recipeDefinition('list-job-board', { metadata: bundleMeta }),
          }),
          recipeEntry('loose-brief'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    // The pack chip exists and is keyed on the bundle's pack_ref.
    expect(shellHtml(rig.root)).toContain('data-filter-value="recued-core.job-status-board"');

    clickRecipeAction(rig.root, 'filter-set', '', {
      'data-filter-kind': 'pack',
      'data-filter-value': 'recued-core.job-status-board',
    });
    let html = shellHtml(rig.root);
    expect(html).toContain('list-job-board');
    expect(html).not.toContain('loose-brief');

    // Standalone must NOT claim a pack member — the one affirmatively false
    // reading of a missing `depends_on`.
    clickRecipeAction(rig.root, 'filter-set', '', {
      'data-filter-kind': 'pack',
      'data-filter-value': '__standalone__',
    });
    html = shellHtml(rig.root);
    expect(html).toContain('loose-brief');
    expect(html).not.toContain('list-job-board');

    rig.route.dispose();
  });

  describe('D-221 — the stored-Records disclosure on the detail', () => {
    const recordsPack = (ops: ReadonlyArray<{ op: string; risk: string; action: string; entity: string }>) => ({
      slug: 'job-status-board',
      publisher: 'recued-core',
      name: 'Job Status Board',
      description: '',
      version: 1,
      pre_install: false,
      installed: true,
      requires: [],
      recipe_count: 8,
      body_visibility_grant_count: 0,
      manifest: {
        contents: [
          {
            type: 'composition',
            composition: {
              schema_version: 1,
              slug: 'job-status-board-records',
              ingredients: [],
              operations: ops.map((o) => ({
                op: o.op,
                ingredient: 'job-status-board-records',
                risk: o.risk,
                approval: 'never',
                args: [],
                bind: { kind: 'core.records', action: o.action, entity: o.entity },
              })),
            },
          },
        ],
      },
    });

    const mountWithRecords = (
      ops: ReadonlyArray<string>,
      packsListCaller?: NonNullable<Parameters<typeof mountRoute>[0]>['packsListCaller'],
    ) =>
      mountRoute({
        recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
          recipes: [
            recipeEntry('reclaim-closed-job', {
              recipe: recipeDefinition('reclaim-closed-job', {
                requires: [],
                metadata: {
                  name: 'Reclaim a closed job',
                  description: 'Reclaim quota from a closed job.',
                  author: 'recued-core',
                  supported_platforms: [],
                  recipe_bundle: 'recued-core/job-status-board',
                },
                steps: ops.map((op, i) => ({ id: `s${i}`, op, args: {} })),
              } as never),
            }),
          ],
        })),
        ...(packsListCaller !== undefined ? { packsListCaller } : {}),
      });

    it('names the entities a recipe touches and marks a deletion destructive', async () => {
      const rig = mountWithRecords(
        [
          'recued-core.job-status-board.job.search',
          'recued-core.job-status-board.job.delete',
          'recued-core.job-status-board.job_event.delete',
        ],
        vi.fn(async () => ({
          packs: [
            recordsPack([
              { op: 'job.search', risk: 'read', action: 'search', entity: 'job' },
              { op: 'job.delete', risk: 'destructive', action: 'delete', entity: 'job' },
              { op: 'job_event.delete', risk: 'destructive', action: 'delete', entity: 'job_event' },
            ]),
          ],
        })) as never,
      );
      await rig.route.whenLoaded();
      clickRecipeAction(rig.root, 'open-recipe', 'reclaim-closed-job');

      const html = shellHtml(rig.root);
      expect(html).toContain(`${RECIPES_ROUTE_RECORDS_ATTR}="destructive"`);
      expect(html).toContain(
        `${RECIPES_ROUTE_RECORDS_PACK_ATTR}="recued-core.job-status-board"`,
      );
      expect(html).toContain('job — reads + deletes (search, delete)');
      expect(html).toContain('job_event — deletes (delete)');
      expect(html).toContain('changes things on this server, and DELETES some of them');
      // The pack's own classification replaces "Risk: unknown" — this recipe
      // is not chat-exposed, so the tool catalog has nothing to say about it.
      expect(html).toContain('<strong>Risk:</strong> destructive.');
      expect(html).toContain('Set by the Pack.');
      expect(html).not.toContain('<strong>Risk:</strong> unknown.');

      rig.route.dispose();
    });

    it('marks a read-only recipe present, not destructive', async () => {
      const rig = mountWithRecords(
        ['recued-core.job-status-board.job.search'],
        vi.fn(async () => ({
          packs: [
            recordsPack([
              { op: 'job.search', risk: 'read', action: 'search', entity: 'job' },
            ]),
          ],
        })) as never,
      );
      await rig.route.whenLoaded();
      clickRecipeAction(rig.root, 'open-recipe', 'reclaim-closed-job');

      const html = shellHtml(rig.root);
      expect(html).toContain(`${RECIPES_ROUTE_RECORDS_ATTR}="present"`);
      expect(html).toContain('job — reads (search)');
      expect(html).toContain('<strong>Risk:</strong> read.');
      // A read-only recipe must not claim it changes anything.
      expect(html).toContain('only reads things on this server');
      expect(html).not.toContain('changes data stored on this server');

      rig.route.dispose();
    });

    it('says the roster is unavailable rather than rendering silence as "no Records"', async () => {
      // No caller at all — the disclosure must NOT quietly disappear, which
      // would read as "this recipe stores nothing".
      const rig = mountWithRecords(['recued-core.job-status-board.job.delete']);
      await rig.route.whenLoaded();
      clickRecipeAction(rig.root, 'open-recipe', 'reclaim-closed-job');

      const html = shellHtml(rig.root);
      expect(html).toContain(`${RECIPES_ROUTE_RECORDS_ATTR}="unknown"`);
      expect(html).toContain("stored-data use can't be shown");

      rig.route.dispose();
    });

    it('reports an op whose pack is not installed', async () => {
      const rig = mountWithRecords(
        ['recued-core.not-installed.job.delete'],
        vi.fn(async () => ({ packs: [] })) as never,
      );
      await rig.route.whenLoaded();
      clickRecipeAction(rig.root, 'open-recipe', 'reclaim-closed-job');

      const html = shellHtml(rig.root);
      expect(html).toContain(`${RECIPES_ROUTE_RECORDS_ATTR}="unresolved"`);
      expect(html).toContain('recued-core.not-installed.job.delete');

      rig.route.dispose();
    });

    it('shows nothing for a recipe that touches no Records', async () => {
      const rig = mountWithRecords(
        ['core.ai.extract'],
        vi.fn(async () => ({ packs: [] })) as never,
      );
      await rig.route.whenLoaded();
      clickRecipeAction(rig.root, 'open-recipe', 'reclaim-closed-job');

      expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RECORDS_ATTR);

      rig.route.dispose();
    });
  });

  it('classifies trigger kind structurally — delta 6 (classifyRecipeAction)', async () => {
    // A `trigger_steps` recipe is reactive even with no "notification"
    // string; a recipe whose step ids merely CONTAIN "notification" is NOT
    // an alert (the old JSON.stringify scan misfired on exactly this).
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('reactive-one', {
            recipe: recipeDefinition('reactive-one', {
              trigger_steps: [{ id: 'watch', ingredient: 'x' }],
            } as unknown as Partial<RecipeDefinition>),
          }),
          recipeEntry('notify-named', {
            recipe: recipeDefinition('notify-named', {
              steps: [{ id: 'notification-cleanup', ingredient: 'noop' }],
            } as unknown as Partial<RecipeDefinition>),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="reactive"`);
    expect(html).toContain(`${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="manual"`);
    // The notify-named recipe is manual, not alert — the structural swap.
    expect(html).not.toContain(`${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="alert"`);

    rig.route.dispose();
  });

  it('renders a bounded recipe page instead of mounting the full library', async () => {
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: Array.from({ length: 50 }, (_, idx) =>
          recipeEntry(`recipe-${String(idx).padStart(2, '0')}`)),
      })),
    });
    await rig.route.whenLoaded();

    let html = shellHtml(rig.root);
    expect(html.match(new RegExp(`${RECIPES_ROUTE_RECIPE_CARD_ATTR}=`, 'g'))).toHaveLength(24);
    expect(html).toContain(`${RECIPES_ROUTE_COUNT_ATTR}`);
    expect(html).toContain('Showing 1–24 of 50 recipes');
    expect(html).toContain(`${RECIPES_ROUTE_PAGER_ATTR}`);
    expect(html.match(new RegExp(`${RECIPES_ROUTE_PAGER_CONTROL_ATTR}=`, 'g')))
      .toHaveLength(2);
    expect(html).toContain('Page 1 of 3');

    clickRecipeAction(rig.root, 'recipe-page', '', { 'data-page': '3' });
    html = shellHtml(rig.root);
    expect(html.match(new RegExp(`${RECIPES_ROUTE_RECIPE_CARD_ATTR}=`, 'g'))).toHaveLength(2);
    expect(html).toContain('Showing 49–50 of 50 recipes');
    expect(html).toContain('Page 3 of 3');

    rig.route.dispose();
  });

  it('restores list filters, page, and scroll after the route remounts', async () => {
    const doc = makeFakeDocument();
    const list = vi.fn<RecipesListCaller>(async () => ({
      recipes: [
        ...Array.from({ length: 30 }, (_, idx) => {
          const recipeId = `pack-recipe-${String(idx).padStart(2, '0')}`;
          return recipeEntry(recipeId, {
            recipe: recipeDefinition(recipeId, {
              metadata: {
                name: `Pack recipe ${idx}`,
                description: 'Search Records by status.',
                author: 'recued-core',
                supported_platforms: [],
                recipe_bundle: 'recued-core/job-status-board',
              },
            }),
          });
        }),
        recipeEntry('loose-recipe'),
      ],
    }));
    const firstScroll = makeFakeEl('main') as FakeEl & {
      scrollTop: number;
      scrollLeft: number;
    };
    firstScroll.scrollTop = 0;
    firstScroll.scrollLeft = 0;
    const first = mountRoute({
      document: doc,
      root: doc.createElement('div'),
      scrollRoot: firstScroll,
      recipesListCaller: list,
    });
    await first.route.whenLoaded();

    clickRecipeAction(first.root, 'filter-set', '', {
      'data-filter-kind': 'pack',
      'data-filter-value': 'recued-core.job-status-board',
    });
    clickRecipeAction(first.root, 'recipe-page', '', { 'data-page': '2' });
    firstScroll.scrollTop = 620;
    firstScroll.scrollLeft = 7;
    first.route.openRecipe('pack-recipe-24');
    first.route.dispose();

    const secondScroll = makeFakeEl('main') as FakeEl & {
      scrollTop: number;
      scrollLeft: number;
    };
    secondScroll.scrollTop = 0;
    secondScroll.scrollLeft = 0;
    const second = mountRoute({
      document: doc,
      root: doc.createElement('div'),
      scrollRoot: secondScroll,
      recipesListCaller: list,
    });
    await second.route.whenLoaded();

    const html = shellHtml(second.root);
    expect(html).toContain('Page 2 of 2');
    expect(html).toContain('pack-recipe-24');
    expect(html).not.toContain('loose-recipe');
    expect(secondScroll.scrollTop).toBe(620);
    expect(secondScroll.scrollLeft).toBe(7);
    second.route.dispose();
  });

  it('disposes the route and broadcast subscriptions cleanly', async () => {
    const unsubscribers = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const subscribeKinds: string[] = [];
    let nextUnsubscriber = 0;
    const subscribe: RecipesRouteSubscribe = (kind) => {
      subscribeKinds.push(kind);
      const unsubscribe = unsubscribers[nextUnsubscriber]!;
      nextUnsubscriber += 1;
      return unsubscribe;
    };
    const rig = mountRoute({ subscribe });
    await rig.route.whenLoaded();

    expect(subscribeKinds).toEqual([
      // D-display-mode P2 — a board left on a screen refreshes when something
      // ELSE completes. Deliberate: this list is a ratchet, and it caught the
      // addition, which is what it is for.
      'execution',
      'pack_installed',
      'pack_uninstalled',
      'chat.inbound_token_changed',
      'recipe_runnability_changed',
      'schedule',
      'automation_rule_changed',
    ]);

    rig.route.dispose();
    expect(rig.root.children).toHaveLength(0);
    expect(unsubscribers.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });
});

/** The detail view's Definition is the full body. List rows lost their steps in
 *  f95faec10, and the Definition, rendered from the row, showed a recipe with no steps:
 *  an owner checking what it does saw nothing it does (2026-09-24 audit). */
describe('Recipes route: the detail Definition is the full body (recipe.get)', () => {
  const trimmed = (): ServerRecipeListEntry => {
    const entry = recipeEntry();
    const { steps: _steps, ...rest } = entry.recipe as unknown as Record<string, unknown>;
    return { ...entry, recipe: rest as unknown as ServerRecipeListEntry['recipe'] };
  };
  const full = recipeEntry('daily-brief', {
    recipe: recipeDefinition('daily-brief', {
      steps: [
        { id: 'read_inbox', ingredient: 'mail-list' },
        { id: 'summarize_day', ingredient: 'ai-summarize' },
      ],
    } as unknown as Partial<RecipeDefinition>),
  });
  const stepIds = ((full.recipe as unknown as { steps?: Array<{ id: string }> }).steps ?? []).map((s) => s.id);

  it('⛔ shows the steps the list row does not carry', async () => {
    expect(stepIds.length, 'the fixture needs steps for this test to mean anything').toBeGreaterThan(0);
    const got = deferred<{ recipe: ServerRecipeFullEntry | null }>();
    const recipeGetCaller = vi.fn(async () => got.promise);
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({ recipes: [trimmed()] })),
      recipeGetCaller,
    });
    await rig.route.whenLoaded();
    expect(shellHtml(rig.root)).toContain('Loading the definition');
    got.resolve({ recipe: full as unknown as ServerRecipeFullEntry });
    await vi.waitFor(() => expect(shellHtml(rig.root)).not.toContain('Loading the definition'));
    const html = shellHtml(rig.root);
    expect(recipeGetCaller).toHaveBeenCalledWith({ recipe_id: 'daily-brief' });
    for (const id of stepIds) expect(html).toContain(`&quot;id&quot;: &quot;${id}&quot;`);
    rig.route.dispose();
  });

  it('an answer for an older copy of the recipe does not replace the newer one', async () => {
    const bodyWith = (id: string): ServerRecipeFullEntry => recipeEntry('daily-brief', {
      recipe: recipeDefinition('daily-brief', {
        steps: [{ id, ingredient: 'mail-list' }],
      } as unknown as Partial<RecipeDefinition>),
    }) as unknown as ServerRecipeFullEntry;
    const older = deferred<{ recipe: ServerRecipeFullEntry | null }>();
    const newer = deferred<{ recipe: ServerRecipeFullEntry | null }>();
    const reads = [older, newer];
    const recipeGetCaller = vi.fn(async () => reads.shift()!.promise);
    let hash = 'hash-before-update';
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [{ ...trimmed(), recipe_hash: hash }],
      })),
      recipeGetCaller,
    });
    await rig.route.whenLoaded();
    // The recipe changes while its first read is still out: the list now has a new hash.
    hash = 'hash-after-update';
    rig.route.refresh();
    await rig.route.whenLoaded();
    expect(recipeGetCaller).toHaveBeenCalledTimes(2);

    newer.resolve({ recipe: bodyWith('step_after_update') });
    await vi.waitFor(() => expect(shellHtml(rig.root)).toContain('step_after_update'));
    older.resolve({ recipe: bodyWith('step_before_update') });
    // A macrotask runs only once every promise callback queued before it has run.
    await new Promise((settled) => setTimeout(settled, 0));
    expect(shellHtml(rig.root)).toContain('step_after_update');
    expect(shellHtml(rig.root)).not.toContain('step_before_update');
    rig.route.dispose();
  });

  it('says why when the body cannot be read, rather than showing a recipe with no steps', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({ recipes: [trimmed()] })),
      recipeGetCaller: vi.fn(async () => { throw new Error('server unreachable'); }),
    });
    await rig.route.whenLoaded();
    await vi.waitFor(() => expect(shellHtml(rig.root))
      .toContain('Could not load the definition: server unreachable'));
    rig.route.dispose();
  });
});

describe('R24 — Recipes route: list -> detail (delta 1)', () => {
  it('opens a deep-linked recipe DETAIL after the initial load (not the run modal)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    expect(rig.route.selectedRecipe()).toBe('daily-brief');
    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="daily-brief"`);
    expect(html).toContain(
      `${RECIPES_ROUTE_DETAIL_HEADING_ATTR}="daily-brief" tabindex="-1"`,
    );
    expect(html).toContain(RECIPES_ROUTE_BACK_ATTR);
    expect(html).toContain('Summarize today.'); // full description on the detail
    expect(html).toContain(RECIPES_ROUTE_DEFINITION_ATTR);
    // The deep link no longer auto-opens the run modal.
    expect(runModalHtml(rig.root)).toBe('');

    rig.route.dispose();
  });

  it('starts the detail result panel empty instead of rendering stale output (D-195 P3)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_PANEL_ATTR}=""`);
    expect(html).toContain('No current-session result yet');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_SECTION_ATTR);
    expect(rig.route.resultPanel()).toBeNull();

    rig.route.dispose();
  });

  it('drops a deep link to an unknown recipe back to the list', async () => {
    const rig = mountRoute({ initialRecipeId: 'ghost' });
    await rig.route.whenLoaded();

    expect(rig.route.selectedRecipe()).toBeNull();
    expect(shellHtml(rig.root)).toContain(RECIPES_ROUTE_HEADING_ATTR);

    rig.route.dispose();
  });

  it('keeps the deep-link selection through a transient list failure, then resolves on refresh (codex HIGH 1)', async () => {
    let calls = 0;
    const recipesListCaller = vi.fn<RecipesListCaller>(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network');
      return { recipes: [recipeEntry()] };
    });
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipesListCaller });
    await rig.route.whenLoaded();

    // The list errored — but a transient failure must NOT discard the valid
    // deep-link (it would permanently rewrite the URL to #recipes).
    expect(rig.route.selectedRecipe()).toBe('daily-brief');

    rig.route.refresh();
    await rig.route.whenLoaded();
    expect(rig.route.selectedRecipe()).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="daily-brief"`);

    rig.route.dispose();
  });

  it('openRecipe shows the detail and closeDetail returns to the list', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    rig.route.openRecipe('daily-brief');
    expect(rig.route.selectedRecipe()).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="daily-brief"`);

    rig.route.closeDetail();
    expect(rig.route.selectedRecipe()).toBeNull();
    const list = shellHtml(rig.root);
    expect(list).toContain(`${RECIPES_ROUTE_HEADING_ATTR} tabindex="-1"`);
    expect(list).not.toContain(RECIPES_ROUTE_DETAIL_ATTR);

    rig.route.dispose();
  });

  it('links the detail to Logs and Automation (delta 5 + #automation)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(RECIPES_ROUTE_RUNS_LINK_ATTR);
    // R24 follow-on — the Logs link deep-links the recipe filter, not bare #logs.
    expect(html).toContain('href="#logs/recipe/daily-brief"');
    expect(html).toContain(RECIPES_ROUTE_AUTOMATION_LINK_ATTR);
    expect(html).toContain('href="#automation/daily-brief"');
    expect(html).toContain('data-recued-recipes-action="open-run"');
    expect(html).toContain('data-recued-recipes-action="open-schedule"');

    rig.route.dispose();
  });

  it('renders a standing dish owner through the shared provenance component', async () => {
    const dish: Dish = {
      dish_id: 'dish-1',
      recipe_id: 'daily-brief',
      publisher_id: 'recued-core',
      name: 'Weekday digest',
      is_default: false,
      config_overlay: {},
      enabled: true,
      created_at: 1,
      managed_by_schedule_id: 'schedule-1',
    };
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      dishesListCaller: vi.fn(async () => ({ dishes: [dish] })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain('data-dish-origin="schedule"');
    expect(html).toContain('data-recued-provenance');
    expect(html).toContain('Schedule schedule-1');

    rig.route.dispose();
  });

  it('gives an auto-run detail lifecycle controls instead of Run or Schedule', async () => {
    const update = deferred<{ entry: AutoRunStatusEntry }>();
    const autoRunUpdateCaller = vi.fn(() => update.promise);
    const rig = mountRoute({
      initialRecipeId: 'watch-mail',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('watch-mail', {
          recipe: recipeDefinition('watch-mail', {
            auto_run: { interval_ms: 60_000 },
            trigger_steps: [{ id: 'watch', ingredient: 'mail-watcher' }],
          } as unknown as Partial<RecipeDefinition>),
        })],
      })),
      // Even a legacy/explicit hybrid schedule is managed in Automation; its
      // presence must not put Schedule back on a reactive recipe detail.
      schedulesListCaller: vi.fn(async () => ({
        schedules: [{
          schedule_id: 'legacy-reactive-schedule',
          recipe_id: 'watch-mail',
          publisher_id: 'recued-core',
          cron_expression: '0 9 * * *',
          enabled: true,
          created_at: 1,
          last_run_at: null,
          next_run_at: null,
          last_status: null,
          last_error: null,
        }],
      })),
      schedulesCreateCaller: vi.fn(async () => {
        throw new Error('reactive detail must not create a schedule');
      }),
      autoRunListCaller: vi.fn(async () => ({
        entries: [autoRunStatus('watch-mail')],
      })),
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();

    let html = shellHtml(rig.root);
    expect(html).not.toContain('data-recued-recipes-action="open-run"');
    expect(html).not.toContain('data-recued-recipes-action="run-defaults"');
    expect(html).not.toContain('data-recued-recipes-action="open-schedule"');
    expect(html).toContain('data-recued-recipes-action="toggle-auto-run:off"');
    expect(html).toContain('>Pause auto-run</button>');
    expect(html).toContain('>Manage automation</a>');

    clickRecipeAction(rig.root, 'toggle-auto-run:off', 'watch-mail');
    expect(autoRunUpdateCaller).toHaveBeenCalledWith({
      recipe_id: 'watch-mail',
      enabled: false,
    });
    html = shellHtml(rig.root);
    expect(html).toContain('Pausing…');
    expect(html).toContain('aria-disabled="true" aria-busy="true"');

    update.resolve({ entry: autoRunStatus('watch-mail', { enabled: false }) });
    await vi.waitFor(() => expect(shellHtml(rig.root)).toContain('Arm auto-run'));
    expect(shellHtml(rig.root)).toContain(
      'data-recued-recipes-action="toggle-auto-run:on"',
    );

    rig.route.dispose();
  });

  it('offers Arm when an auto-run definition has no status entry yet', async () => {
    const autoRunUpdateCaller = vi.fn(async () => ({
      entry: autoRunStatus('watch-mail'),
    }));
    const rig = mountRoute({
      initialRecipeId: 'watch-mail',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('watch-mail', {
          recipe: recipeDefinition('watch-mail', {
            auto_run: { interval_ms: 60_000 },
          }),
        })],
      })),
      autoRunListCaller: vi.fn(async () => ({ entries: [] })),
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();

    let html = shellHtml(rig.root);
    expect(html).toContain('data-recued-recipes-action="toggle-auto-run:on"');
    expect(html).toContain('>Arm auto-run</button>');

    clickRecipeAction(rig.root, 'toggle-auto-run:on', 'watch-mail');
    expect(autoRunUpdateCaller).toHaveBeenCalledWith({
      recipe_id: 'watch-mail',
      enabled: true,
    });
    html = shellHtml(rig.root);
    expect(html).toContain('Setting it to run on its own…');
    await vi.waitFor(() => expect(shellHtml(rig.root)).toContain('Pause auto-run'));

    rig.route.dispose();
  });

  it('offers Re-arm when an auto-run circuit is tripped', async () => {
    const rig = mountRoute({
      initialRecipeId: 'watch-mail',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('watch-mail', {
          recipe: recipeDefinition('watch-mail', {
            auto_run: { interval_ms: 60_000 },
          }),
        })],
      })),
      autoRunListCaller: vi.fn(async () => ({
        entries: [autoRunStatus('watch-mail', { auto_disabled: true })],
      })),
      autoRunUpdateCaller: vi.fn(async () => ({
        entry: autoRunStatus('watch-mail'),
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain('data-recued-recipes-action="toggle-auto-run:on"');
    expect(html).toContain('>Re-arm auto-run</button>');

    rig.route.dispose();
  });

  it('gives an event-triggered detail Manage instead of Run or Schedule', async () => {
    const rig = mountRoute({
      initialRecipeId: 'on-new-mail',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('on-new-mail', {
          recipe: recipeDefinition('on-new-mail', {
            event_triggers: [{ event: 'data.mail.**.created' }],
          }),
        })],
      })),
      schedulesListCaller: vi.fn(async () => ({
        schedules: [{
          schedule_id: 'legacy-event-schedule',
          recipe_id: 'on-new-mail',
          publisher_id: 'recued-core',
          cron_expression: '0 9 * * *',
          enabled: true,
          created_at: 1,
          last_run_at: null,
          next_run_at: null,
          last_status: null,
          last_error: null,
        }],
      })),
      schedulesCreateCaller: vi.fn(async () => {
        throw new Error('triggered detail must not create a schedule');
      }),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).not.toContain('data-recued-recipes-action="open-run"');
    expect(html).not.toContain('data-recued-recipes-action="open-schedule"');
    expect(html).not.toContain('data-recued-recipes-action="toggle-auto-run:');
    expect(html).toContain(
      'class="recipes-button recipes-button--primary"\n            href="#automation/on-new-mail"',
    );
    expect(html).toContain('>Manage automation</a>');

    rig.route.dispose();
  });

  it('summarizes a one-shot by its run time instead of exposing raw cron', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      schedulesListCaller: vi.fn(async () => ({
        schedules: [{
          schedule_id: 'once-1',
          recipe_id: 'daily-brief',
          publisher_id: 'recued-core',
          mode: 'one_shot' as const,
          cron_expression: '17 4 9 12 *',
          run_at: 1_800_000_000_000,
          enabled: true,
          created_at: 1_700_000_000_000,
          last_run_at: null,
          next_run_at: 1_800_000_000_000,
          last_status: null,
          last_error: null,
        }],
      })),
    });
    await rig.route.whenLoaded();
    const html = shellHtml(rig.root);
    expect(html).toContain('Once —');
    expect(html).not.toContain('17 4 9 12 *');
    rig.route.dispose();
  });

  it('links "Edit in Kitchen" to the recipe editor (Edit→Kitchen)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    // The former disabled "coming soon" placeholder is now a live deep-link
    // into the Kitchen recipe editor loaded on this recipe.
    expect(html).toContain(RECIPES_ROUTE_EDIT_LINK_ATTR);
    expect(html).toContain('href="#kitchen/recipe/daily-brief"');
    expect(html).not.toContain('coming soon');
    expect(html).not.toContain('disabled>Edit in Kitchen');

    rig.route.dispose();
  });

  it('keeps Config focusable, blocks duplicate reads, and reports a retryable failure', async () => {
    const configRead = deferred<{ config_overlay: Record<string, unknown> }>();
    const recipeConfigGetCaller = vi.fn(() => configRead.promise);
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeConfigGetCaller,
      recipeConfigSetCaller: vi.fn(async () => ({ config_overlay: {} })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief', {
          recipe: recipeDefinition('daily-brief', {
            variables: { limit: 25 },
          }),
        })],
      })),
    });
    await rig.route.whenLoaded();

    clickRecipeAction(rig.root, 'open-recipe-config', 'daily-brief');
    clickRecipeAction(rig.root, 'open-recipe-config', 'daily-brief');

    expect(recipeConfigGetCaller).toHaveBeenCalledTimes(1);
    const pendingButton = shellHtml(rig.root).match(
      /<button type="button" class="recipes-button"[\s\S]*?data-recued-recipes-action="open-recipe-config"[\s\S]*?<\/button>/,
    )?.[0];
    expect(pendingButton).toContain('aria-disabled="true" aria-busy="true"');
    expect(pendingButton).not.toContain(' disabled');
    expect(pendingButton).toContain('Loading settings…');

    configRead.reject(new Error('read failed'));
    await vi.waitFor(() => expect(shellHtml(rig.root)).not.toContain('Loading settings…'));
    expect(shellHtml(rig.root)).toContain('>Config</button>');
    expect(shellHtml(rig.root)).toContain('role="alert"');
    expect(shellHtml(rig.root)).toContain(
      'load the settings: read failed. Try again.',
    );

    rig.route.dispose();
  });

  it('retires a Config read when the same recipe is reopened', async () => {
    const firstRead = deferred<{ config_overlay: Record<string, unknown> }>();
    const secondRead = deferred<{ config_overlay: Record<string, unknown> }>();
    const recipeConfigGetCaller = vi.fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeConfigGetCaller,
      recipeConfigSetCaller: vi.fn(async () => ({ config_overlay: {} })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief', {
          recipe: recipeDefinition('daily-brief', {
            variables: { limit: 25 },
          }),
        })],
      })),
    });
    await rig.route.whenLoaded();

    clickRecipeAction(rig.root, 'open-recipe-config', 'daily-brief');
    expect(recipeConfigGetCaller).toHaveBeenCalledTimes(1);
    rig.route.closeDetail();
    rig.route.openRecipe('daily-brief');
    expect(shellHtml(rig.root)).toContain('>Config</button>');
    expect(shellHtml(rig.root)).not.toContain('Loading settings…');

    clickRecipeAction(rig.root, 'open-recipe-config', 'daily-brief');
    expect(recipeConfigGetCaller).toHaveBeenCalledTimes(2);
    firstRead.reject(new Error('stale read failed'));
    await firstRead.promise.catch(() => undefined);
    await Promise.resolve();
    expect(shellHtml(rig.root)).toContain('Loading settings…');
    expect(shellHtml(rig.root)).not.toContain('stale read failed');

    secondRead.reject(new Error('current read failed'));
    await vi.waitFor(() => expect(shellHtml(rig.root)).not.toContain('Loading settings…'));
    expect(shellHtml(rig.root)).toContain('load the settings: current read failed');

    rig.route.dispose();
  });

  it('renders installed same-bundle siblings with eligible controls (D-195 P2)', async () => {
    const bundle = 'recued-core/outbound-follow-up-response';
    const bundledRecipe = (
      recipe_id: string,
      name: string,
      withVariable = false,
      withAutoRun = false,
    ) =>
      recipeDefinition(recipe_id, {
        depends_on: ['recued-core.follow-up-pack'],
        metadata: {
          name,
          description: `${name} description`,
          author: 'recued-core',
          supported_platforms: [],
          tags: ['bundle'],
          recipe_bundle: bundle,
        },
        ...(withVariable
          ? { variables: { thread_key: { label: 'Thread key', type: 'text' } } }
          : {}),
        ...(withAutoRun
          ? { auto_run: { interval_ms: 60_000, dynamic: false } }
          : {}),
      });
    const autoRunUpdateCaller = vi.fn(async (args: {
      recipe_id: string;
      enabled?: boolean;
    }) => ({
      entry: {
        recipe_id: args.recipe_id,
        publisher_id: 'recued-core',
        recipe_name: 'Close action',
        interval_ms: 60_000,
        dynamic: false,
        enabled: args.enabled ?? true,
        auto_disabled: false,
        consecutive_failures: 0,
        last_failure_at: null,
        last_failure_reason: null,
        next_run_at: null,
        last_started_at: null,
        last_finished_at: null,
        config_overlay: {},
        variables: {},
      },
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue', { recipe: bundledRecipe('review-queue', 'Review queue') }),
          recipeEntry('reply-action', { recipe: bundledRecipe('reply-action', 'Reply action', true) }),
          recipeEntry('close-action', {
            recipe: bundledRecipe('close-action', 'Close action', false, true),
          }),
          recipeEntry('unrelated', {
            recipe: recipeDefinition('unrelated', {
              depends_on: ['recued-core.follow-up-pack'],
              metadata: {
                name: 'Unrelated',
                description: 'Outside the lifecycle.',
                author: 'recued-core',
                supported_platforms: [],
                tags: ['bundle'],
                recipe_bundle: 'recued-core/other-flow',
              },
            }),
          }),
        ],
      })),
      schedulesListCaller: vi.fn(async () => ({
        schedules: [{
          schedule_id: 'legacy-close-action-schedule',
          recipe_id: 'close-action',
          publisher_id: 'recued-core',
          cron_expression: '0 9 * * *',
          enabled: true,
          created_at: 1,
          last_run_at: null,
          next_run_at: null,
          last_status: null,
          last_error: null,
        }],
      })),
      schedulesCreateCaller: vi.fn(async (args) => ({
        schedule: {
          schedule_id: 'schedule-1',
          recipe_id: args.recipe_id,
          publisher_id: args.publisher_id ?? 'recued-core',
          cron_expression: args.cron_expression,
          enabled: true,
          created_at: 1,
          last_run_at: null,
          next_run_at: null,
          last_status: null,
          last_error: null,
        },
      })),
      autoRunListCaller: vi.fn(async () => ({
        entries: [{
          recipe_id: 'close-action',
          publisher_id: 'recued-core',
          recipe_name: 'Close action',
          interval_ms: 60_000,
          dynamic: false,
          enabled: true,
          auto_disabled: false,
          consecutive_failures: 0,
          last_failure_at: null,
          last_failure_reason: null,
          next_run_at: null,
          last_started_at: null,
          last_finished_at: null,
          config_overlay: {},
          variables: {},
        }],
      })),
      autoRunUpdateCaller,
      recipeConfigGetCaller: vi.fn(async () => ({ config_overlay: {} })),
      recipeConfigSetCaller: vi.fn(async () => ({ config_overlay: {} })),
      recipeCatalogCaller: vi.fn(async () => ({
        status: 'ok' as const,
        rows: [
          { recipe_id: 'review-queue', publisher_id: 'recued-core', name: 'Review queue', description: '', type: 'recipe', version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0, created_at: '', depends_on: [], recipe_bundle: bundle },
          { recipe_id: 'reply-action', publisher_id: 'recued-core', name: 'Reply action', description: '', type: 'recipe', version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0, created_at: '', depends_on: [], recipe_bundle: bundle },
          { recipe_id: 'close-action', publisher_id: 'recued-core', name: 'Close action', description: '', type: 'recipe', version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0, created_at: '', depends_on: [], recipe_bundle: bundle },
        ],
      })),
      packCatalogCaller: vi.fn(async () => ({
        status: 'ok' as const,
        rows: [{
          slug: 'outbound-follow-up-response',
          publisher_id: 'recued-core',
          name: 'Outbound Follow-Up Loop',
          description: '',
          version: 1,
          pack_kind: 'app_pack',
          tags: [],
          download_count: 0,
          item_count: 3,
          recipe_refs: [
            { slug: 'review-queue', version: 1 },
            { slug: 'reply-action', version: 1 },
            { slug: 'close-action', version: 1 },
          ],
          created_at: '',
        }],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ATTR}="${bundle}"`);
    expect(html).not.toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="review-queue"`);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="reply-action"`);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="close-action"`);
    // Same tags / packs are not enough; only metadata.recipe_bundle groups rows.
    expect(html).not.toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="unrelated"`);
    expect(html).toContain('href="#recipes/reply-action"');
    expect(html).toContain(`${RECIPES_ROUTE_RUN_BUTTON_ATTR}="reply-action"`);
    expect(html).toContain('data-recipe-id="reply-action">Config</button>');
    expect(html).toContain('data-recipe-id="reply-action">Schedule</button>');
    expect(html).toContain('href="#automation/reply-action"');
    expect(html).toContain('href="#logs/recipe/reply-action"');
    expect(html).toContain('aria-label="Open Reply action (reply-action)"');
    expect(html).toContain('aria-label="Run Reply action (reply-action)"');
    expect(html).toContain('aria-label="Config Reply action (reply-action)"');
    expect(html).toContain('aria-label="Schedule Reply action (reply-action)"');
    expect(html).toContain(
      'aria-label="Automation for Reply action (reply-action)"',
    );
    expect(html).toContain('aria-label="Logs for Reply action (reply-action)"');
    expect(html).toContain('auto-run');
    expect(html).toContain('data-recued-recipes-action="toggle-auto-run:off"');
    expect(html).toContain('data-recipe-id="close-action">Pause auto-run</button>');
    expect(html).toContain(
      'aria-label="Pause auto-run Close action (close-action)"',
    );
    expect(html).toContain('data-recued-recipes-bundle-pack="outbound-follow-up-response"');
    expect(html).toContain('href="#packs/outbound-follow-up-response"');
    expect(html).toContain('See the whole Pack');
    const reactiveRow = html.match(
      /<li data-recued-recipes-related-row="close-action">[\s\S]*?<\/li>/,
    )?.[0] ?? '';
    expect(reactiveRow).not.toContain('data-recued-recipes-action="open-run"');
    expect(reactiveRow).not.toContain('data-recued-recipes-action="open-schedule"');
    expect(reactiveRow).toContain('href="#automation/close-action"');
    expect(reactiveRow).toContain('href="#logs/recipe/close-action"');
    clickRecipeAction(rig.root, 'toggle-auto-run:off', 'close-action');
    expect(autoRunUpdateCaller).toHaveBeenCalledWith({
      recipe_id: 'close-action',
      enabled: false,
    });

    rig.route.dispose();
  });

  it('keeps a related auto-run mutation single-flight and reports failures in place', async () => {
    const bundle = 'recued-core/pipeline-response';
    const bundledRecipe = (
      recipe_id: string,
      name: string,
      withAutoRun = false,
    ) => recipeDefinition(recipe_id, {
      metadata: {
        name,
        description: `${name} description`,
        author: 'recued-core',
        supported_platforms: [],
        tags: ['bundle'],
        recipe_bundle: bundle,
      },
      ...(withAutoRun
        ? { auto_run: { interval_ms: 60_000, dynamic: false } }
        : {}),
    });
    type AutoRunUpdateCaller = NonNullable<
      Parameters<typeof bootstrapRecipesRoute>[0]['autoRunUpdateCaller']
    >;
    const update = deferred<Awaited<ReturnType<AutoRunUpdateCaller>>>();
    const autoRunUpdateCaller = vi.fn<AutoRunUpdateCaller>(() => update.promise);
    const confirm = vi.fn(() => false);
    const rig = mountRoute({
      confirm,
      initialRecipeId: 'watch-pipeline',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('watch-pipeline', {
            recipe: bundledRecipe('watch-pipeline', 'Watch pipeline'),
          }),
          recipeEntry('close-action', {
            recipe: bundledRecipe('close-action', 'Close action', true),
          }),
        ],
      })),
      autoRunListCaller: vi.fn(async () => ({
        entries: [{
          recipe_id: 'close-action',
          publisher_id: 'recued-core',
          recipe_name: 'Close action',
          interval_ms: 60_000,
          dynamic: false,
          enabled: true,
          auto_disabled: false,
          consecutive_failures: 0,
          last_failure_at: null,
          last_failure_reason: null,
          next_run_at: null,
          last_started_at: null,
          last_finished_at: null,
          config_overlay: {},
          variables: {},
        }],
      })),
      autoRunUpdateCaller,
    });
    await rig.route.whenLoaded();

    clickRecipeAction(rig.root, 'toggle-auto-run:off', 'close-action');
    const busyRow = shellHtml(rig.root).match(
      /<li data-recued-recipes-related-row="close-action">[\s\S]*?<\/li>/,
    )?.[0] ?? '';
    expect(busyRow).toContain('Pausing…');
    expect(busyRow).toContain('aria-disabled="true" aria-busy="true"');
    expect(busyRow).not.toMatch(/\sdisabled(?:[ >])/);
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'Something is still happening. Leave anyway?',
    );

    rig.route.closeDetail();
    expect(confirm).toHaveBeenCalledWith(
      'Something is still happening. Leave anyway?',
    );
    expect(rig.route.selectedRecipe()).toBe('watch-pipeline');

    clickRecipeAction(rig.root, 'toggle-auto-run:off', 'close-action');
    expect(autoRunUpdateCaller).toHaveBeenCalledTimes(1);

    update.reject(new Error('server unavailable'));
    await vi.waitFor(() => {
      const html = shellHtml(rig.root);
      expect(html).toContain(
        `${RECIPES_ROUTE_AUTO_RUN_ERROR_ATTR}="close-action"`,
      );
      expect(html).toContain(
        'Recued could not change that: server unavailable',
      );
      expect(html).toContain('Pause auto-run');
    });
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();

    rig.route.dispose();
  });

  it('offers the directly named pack when only part of a recipe_bundle is installed', async () => {
    const bundle = 'recued-core/task-closure';
    const selected = recipeDefinition('create-task', {
      metadata: {
        name: 'Create task',
        description: '',
        author: 'recued-core',
        supported_platforms: [],
        recipe_bundle: bundle,
      },
    });
    const catalogRow = (recipe_id: string, name: string) => ({
      recipe_id,
      publisher_id: 'recued-core',
      name,
      description: '',
      type: 'recipe',
      version: 1,
      platforms: [] as string[],
      tags: [] as string[],
      download_count: 0,
      rating_avg: 0,
      rating_count: 0,
      created_at: '',
      depends_on: [] as string[],
      recipe_bundle: bundle,
    });
    const rig = mountRoute({
      initialRecipeId: 'create-task',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('create-task', { recipe: selected })],
      })),
      recipeCatalogCaller: async () => ({
        status: 'ok',
        rows: [
          catalogRow('create-task', 'Create task'),
          catalogRow('watch-task', 'Watch task'),
          catalogRow('review-task', 'Review task'),
        ],
      }),
      packCatalogCaller: async () => ({
        status: 'ok',
        rows: [{
          slug: 'task-closure',
          publisher_id: 'recued-core',
          name: 'Task Closure Loop',
          description: '',
          version: 1,
          pack_kind: 'app_pack',
          tags: [],
          download_count: 0,
          item_count: 4,
          recipe_refs: [
            { slug: 'create-task', version: 1 },
            { slug: 'watch-task', version: 1 },
            { slug: 'review-task', version: 1 },
            { slug: 'pack-extra', version: 1 },
          ],
          created_at: '',
        }],
      }),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ATTR}="${bundle}"`);
    expect(html).toContain('data-recued-recipes-bundle-pack="task-closure"');
    expect(html).toContain('Install everything (4)');
    // The section exists for installation even though no sibling is installed.
    expect(html).not.toContain(RECIPES_ROUTE_RELATED_ROW_ATTR);

    rig.route.dispose();
  });

  it('loads bundle catalogs lazily when an installed recipe detail opens', async () => {
    const bundle = 'recued-core/task-closure';
    const selected = recipeDefinition('create-task', {
      metadata: {
        name: 'Create task',
        description: '',
        author: 'recued-core',
        supported_platforms: [],
        recipe_bundle: bundle,
      },
    });
    const recipeCatalogCaller = vi.fn(async () => ({
      status: 'ok' as const,
      rows: ['create-task', 'watch-task'].map((recipe_id) => ({
        recipe_id,
        publisher_id: 'recued-core',
        name: recipe_id,
        description: '',
        type: 'recipe',
        version: 1,
        platforms: [],
        tags: [],
        download_count: 0,
        rating_avg: 0,
        rating_count: 0,
        created_at: '',
        depends_on: [],
        recipe_bundle: bundle,
      })),
    }));
    const packCatalogCaller = vi.fn(async () => ({
      status: 'ok' as const,
      rows: [{
        slug: 'task-closure',
        publisher_id: 'recued-core',
        name: 'Task Closure Loop',
        description: '',
        version: 1,
        pack_kind: 'app_pack',
        tags: [],
        download_count: 0,
        item_count: 2,
        recipe_refs: [
          { slug: 'create-task', version: 1 },
          { slug: 'watch-task', version: 1 },
        ],
        created_at: '',
      }],
    }));
    const rig = mountRoute({
      recipesListCaller: async () => ({
        recipes: [recipeEntry('create-task', { recipe: selected })],
      }),
      recipeCatalogCaller,
      packCatalogCaller,
    });
    await rig.route.whenLoaded();
    expect(recipeCatalogCaller).not.toHaveBeenCalled();
    expect(packCatalogCaller).not.toHaveBeenCalled();

    rig.route.openRecipe('create-task');
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'data-recued-recipes-bundle-pack="task-closure"',
      );
    });
    expect(recipeCatalogCaller).toHaveBeenCalledTimes(1);
    expect(packCatalogCaller).toHaveBeenCalledTimes(1);

    rig.route.dispose();
  });

  it('recovers failed carrier membership once and keeps the verified handoff through Refresh', async () => {
    const bundle = 'recued-core/task-closure';
    const selected = recipeDefinition('create-task', {
      metadata: {
        name: 'Create task',
        description: '',
        author: 'recued-core',
        supported_platforms: [],
        recipe_bundle: bundle,
      },
    });
    const catalogRows = ['create-task', 'watch-task'].map((recipe_id) => ({
      recipe_id,
      publisher_id: 'recued-core',
      name: recipe_id,
      description: '',
      type: 'recipe',
      version: 1,
      platforms: [] as string[],
      tags: [] as string[],
      download_count: 0,
      rating_avg: 0,
      rating_count: 0,
      created_at: '',
      depends_on: [] as string[],
      recipe_bundle: bundle,
    }));
    const membership = deferred<Array<{ slug: string; version: number }>>();
    let packVersion = 1;
    const packRecipeRefsCaller = vi.fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => membership.promise);
    const rig = mountRoute({
      initialRecipeId: 'create-task',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('create-task', { recipe: selected })],
      })),
      recipeCatalogCaller: vi.fn(async () => ({
        status: 'ok' as const,
        rows: catalogRows,
      })),
      packCatalogCaller: vi.fn(async () => ({
        status: 'ok' as const,
        rows: [{
          slug: 'task-closure',
          publisher_id: 'recued-core',
          name: 'Task Closure Loop',
          description: '',
          version: packVersion,
          pack_kind: 'app_pack',
          tags: [],
          download_count: 0,
          item_count: 2,
          recipe_refs: [],
          created_at: '',
        }],
      })),
      packRecipeRefsCaller,
    });
    await rig.route.whenLoaded();

    expect(packRecipeRefsCaller).toHaveBeenCalledTimes(1);
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_BUNDLE_STATUS_ATTR}="task-closure"`,
    );
    expect(shellHtml(rig.root)).toContain('Couldn’t verify this recipe’s workflow pack contents.');
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_BUNDLE_RETRY_ATTR}="task-closure"`,
    );
    expect(shellHtml(rig.root)).not.toContain(
      'data-recued-recipes-bundle-pack="task-closure"',
    );

    clickRecipeAction(rig.root, 'retry-bundle-carrier', 'create-task');
    expect(packRecipeRefsCaller).toHaveBeenCalledTimes(2);
    expect(shellHtml(rig.root)).toContain('Trying again…');
    const busyRetry = shellHtml(rig.root).match(
      /<button[^>]*data-recued-recipes-bundle-retry="task-closure"[^>]*>Retrying…<\/button>/,
    )?.[0] ?? '';
    expect(busyRetry).toContain('aria-disabled="true"');
    expect(busyRetry).toContain('aria-busy="true"');
    expect(busyRetry).not.toMatch(/\sdisabled(?:[ >])/);

    clickRecipeAction(rig.root, 'retry-bundle-carrier', 'create-task');
    clickRecipeAction(rig.root, 'retry-bundle-carrier', 'create-task');
    expect(packRecipeRefsCaller).toHaveBeenCalledTimes(2);

    membership.resolve([
      { slug: 'create-task', version: 1 },
      { slug: 'watch-task', version: 1 },
    ]);
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'data-recued-recipes-bundle-pack="task-closure"',
      );
    });
    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_BUNDLE_STATUS_ATTR);

    rig.route.refresh();
    await rig.route.whenLoaded();
    expect(packRecipeRefsCaller).toHaveBeenCalledTimes(2);
    expect(shellHtml(rig.root)).toContain(
      'data-recued-recipes-bundle-pack="task-closure"',
    );

    packVersion = 2;
    packRecipeRefsCaller.mockResolvedValueOnce([
      { slug: 'create-task', version: 1 },
      { slug: 'watch-task', version: 1 },
    ]);
    rig.route.refresh();
    await rig.route.whenLoaded();
    expect(packRecipeRefsCaller).toHaveBeenCalledTimes(3);
    expect(shellHtml(rig.root)).toContain(
      'data-recued-recipes-bundle-pack="task-closure"',
    );

    rig.route.dispose();
  });

  it('does not render a related-recipes panel for unbundled recipes', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RELATED_ATTR);

    rig.route.dispose();
  });
});

describe('R24 — Recipes route: exposure is per-contract, no toggle', () => {
  it('the detail has NO exposure toggle and points to Contracts', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    // The "Exposed as a tool" section is now a read-only pointer — no toggle
    // control, no per-recipe chat_exposed flag surfaced here.
    expect(html).toContain('Exposed as a tool');
    expect(html).toContain('granted per contract');
    expect(html).toContain('href="#contracts"');
    expect(html).not.toContain('toggle-chat-exposed');
    expect(html).not.toContain('set on the server');
    // The dishonest global "in the live catalog" claim is gone from Depends-on.
    expect(html).not.toContain('is in the live catalog');
    expect(html).not.toContain('No MCP-exposed recipe tool');

    rig.route.dispose();
  });
});

describe('R24 — Recipes route: run + schedule modal', () => {
  it('retains the modal owner while a recipe command is pending', async () => {
    const execution = deferred<ServerExecuteResponse>();
    const rig = mountRoute({
      recipeExecuteCaller: vi.fn(() => execution.promise),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    const pending = rig.route.confirmRun();
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'Something is still happening. Leave anyway?',
    );

    execution.resolve(executeResponse());
    await pending;
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();
    rig.route.dispose();
  });

  it('forwards the recipe-owned Records search so record_ref renders as a picker', async () => {
    const entry = recipeEntry('open-rental-contract', {
      recipe: recipeDefinition('open-rental-contract', {
        metadata: {
          name: 'Open a rental contract',
          description: 'Choose a customer.',
          author: 'recued-core',
          supported_platforms: [],
          tags: [],
          recipe_bundle: 'recued-core/rental-book',
        },
        variables: {
          customer_id: {
            label: 'Customer',
            type: 'record_ref',
            entity: 'customer',
          },
        },
      }),
    });
    const rig = mountRoute({
      recipesListCaller: vi.fn(async () => ({ recipes: [entry] })),
      recordRefSearchCaller: vi.fn(() => async () => []),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('open-rental-contract');
    expect(runModalHtml(rig.root)).toContain(
      'data-ref-picker="run-modal-var-record-ref-customer_id"',
    );
    expect(runModalHtml(rig.root)).not.toMatch(
      /data-var-type="record_ref"[^>]*type="text"/,
    );
    rig.route.dispose();
  });

  it('runs a recipe through the modal caller with parsed config', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            {
              type: 'summary',
              data: { fields: [{ label: 'Deal', value: 'Acme' }] },
            },
            {
              type: 'table',
              data: {
                columns: [
                  { field: 'stage', label: 'Stage' },
                  { field: 'amount', label: 'Amount', format: 'currency' },
                  { field: 'confidence', label: 'Confidence', format: 'percent' },
                ],
                rows: [{ stage: 'Negotiation', amount: 1_500, confidence: 0.825 }],
              },
            },
            {
              type: 'checklist',
              data: {
                title: 'Review',
                items: [{ label: 'Ready', status: 'ok', detail: 'Owner can proceed' }],
              },
            },
            { type: 'copyable', label: 'Draft', data: 'copy this value' },
            // Raw step detail. Its whole reason for existing is that
            // `output.render` is the ONLY channel a run's data reaches a reader
            // through — so if this panel cannot render it, the detail is
            // unreachable everywhere.
            {
              type: 'json',
              label: 'Previous Inventory',
              data: { sku: 'A-1', stock: 4 },
            },
            {
              type: 'ai_analysis',
              data: {
                summary: 'AI says proceed',
                confidence: 0.82,
                key_points: ['Owner confirmed'],
              },
            },
            { type: 'button', data: [{ kind: 'recipe.run', label: 'Escalate', recipe_id: 'escalate' }] },
            // Schema-bound field list. This panel keeps its OWN section switch,
            // so a kind added to the shared renderer lands here as
            // "unsupported" unless it is wired here too — and the detail would
            // then be visible on a reception page and missing for the owner.
            {
              type: 'record_fields',
              label: 'Job',
              data: { record: { id: 'job_1' } },
              record_fields: {
                entity: 'job',
                fields: [
                  { key: 'title', label: 'Title', kind: 'string', present: true,
                    value: 'Replace the pump' },
                  { key: 'contact_name', label: 'Contact name', kind: 'string',
                    privacy: 'name', present: false, value: undefined },
                ],
              },
            },
          ],
          sidebar: [{ type: 'text', data: 'legacy stale output' }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({ recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRecipe('daily-brief');
    rig.route.openRunModal('daily-brief');
    rig.route.setRunConfigText('{"topic":"pipeline"}');
    await rig.route.confirmRun();

    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      config: { topic: 'pipeline' },
    });
    expect(rig.route.runModal()?.result?.success).toBe(true);
    expect(runModalHtml(rig.root)).toContain('Run completed');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_PANEL_ATTR}="daily-brief"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="summary"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="table"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="checklist"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="copyable"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="json"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="ai_analysis"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="button"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="record_fields"`);
    expect(shellHtml(rig.root)).toContain('Replace the pump');
    expect(shellHtml(rig.root)).toContain('Not set');
    expect(shellHtml(rig.root)).toContain('Acme');
    expect(shellHtml(rig.root)).toContain('Negotiation');
    expect(shellHtml(rig.root)).toContain('$1.5K');
    expect(shellHtml(rig.root)).toContain('82.5%');
    expect(shellHtml(rig.root)).toContain('Owner can proceed');
    expect(shellHtml(rig.root)).toContain('copy this value');
    // The json block: titled by its authored label, pretty-printed behind a
    // native <details> (no script — the same block reception serves under
    // `script-src 'none'`), and NOT the unsupported-kind fallback.
    expect(shellHtml(rig.root)).toContain('Previous Inventory');
    expect(shellHtml(rig.root)).toContain('&quot;stock&quot;: 4');
    expect(shellHtml(rig.root)).toContain('<details');
    expect(shellHtml(rig.root)).not.toContain('Unsupported output section type');
    expect(shellHtml(rig.root)).toContain('class="copy-btn"');
    expect(shellHtml(rig.root)).toContain('data-action="copy"');
    expect(shellHtml(rig.root)).toContain('AI says proceed');
    expect(shellHtml(rig.root)).toContain('class="ai-summary"');
    expect(shellHtml(rig.root)).toContain('82%');
    expect(shellHtml(rig.root)).toContain('Owner confirmed');
    expect(shellHtml(rig.root)).toContain('Escalate');
    expect(shellHtml(rig.root)).toContain('Recipe &quot;escalate&quot; is not installed.');
    expect(shellHtml(rig.root)).not.toContain('legacy stale output');
    expect(shellHtml(rig.root)).toContain('role="status" aria-live="polite"');
    expect(rig.route.resultPanel()).toMatchObject({
      route_recipe_id: 'daily-brief',
      source_recipe_id: 'daily-brief',
      render_recipe_id: 'daily-brief',
      origin: 'recipe-detail',
    });
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="recipe-detail"`,
    );
    expect(shellHtml(rig.root)).toContain(
      'data-recued-reference-id="daily-brief"',
    );
    expect(shellHtml(rig.root)).toContain('data-recued-provenance');
    rig.route.closeRunModal();
    expect(runModalHtml(rig.root)).toBe('');
    expect(shellHtml(rig.root)).toContain('Acme');

    rig.route.dispose();
  });

  it('renders audit-backed Run facts in the modal and persistent result', async () => {
    const receipt =
      '34 steps · 1,249 items · 2 provider calls · 13,385 tokens · 42 seconds';
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        run_facts: {
          steps_run: 34,
          items_total: 1_249,
          provider_calls: 2,
          total_tokens: 13_385,
          duration_ms: 42_000,
        },
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(runModalHtml(rig.root)).toContain(RunModal.RUN_MODAL_FACTS_ATTR);
    expect(runModalHtml(rig.root)).toContain(receipt);
    expect(shellHtml(rig.root)).toContain(RECIPES_ROUTE_RESULT_FACTS_ATTR);
    expect(shellHtml(rig.root)).toContain(receipt);
    expect(shellHtml(rig.root)).not.toContain(' · 7 ms · 1 step');
    rig.route.dispose();
  });

  it('⛔ a run that returned errors says why, in the modal and the persistent result (D-312)', async () => {
    const reason = 'notification-send: "slak" is not a channel';
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        success: false,
        errors: [{
          code: 'BAD_INPUT',
          message: reason,
          source: { recipe_id: 'daily-brief', step_id: 'send', ingredient_slug: null },
        }],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const shown = 'notification-send: &quot;slak&quot; is not a channel (step send)';
    expect(runModalHtml(rig.root)).toContain(RunModal.RUN_MODAL_REASON_ATTR);
    expect(runModalHtml(rig.root)).toContain(shown);
    expect(shellHtml(rig.root)).toContain(RECIPES_ROUTE_RESULT_REASON_ATTR);
    expect(shellHtml(rig.root)).toContain(shown);
    rig.route.dispose();
  });

  it('copies copyable output through the browser clipboard affordance (D-195 P3)', async () => {
    const clipboardWrite = vi.fn(async (_value: string) => {});
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      clipboardWrite,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{ type: 'copyable', label: 'Draft', data: 'copy this value' }],
          } as unknown as ServerExecuteResponse['output'],
        })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    clickRecipeAction(rig.root, 'copy', '', { 'data-value': 'copy this value' });

    await vi.waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('copy this value');
    });

    rig.route.dispose();
  });

  it('renders unsupported result sections without dropping adjacent output (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            { type: 'text', data: 'known result survives' },
            {
              type: 'future_widget',
              data: { value: 'future payload' },
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="text"`);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="future_widget"`);
    expect(html).toContain('known result survives');
    expect(html).toContain('Recued cannot show this: future_widget');
    expect(html).toContain('Unsupported output section type: future_widget');
    expect(html).toContain('future payload');

    rig.route.dispose();
  });

  it('renders held runs as awaiting approval without result output (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        success: false,
        output: {
          render: [{ type: 'text', data: 'held output must not render' }],
          sidebar: [],
        },
        awaiting_approval: true,
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(shellHtml(rig.root)).toContain('Awaiting approval');
    expect(shellHtml(rig.root)).toContain('role="status" aria-live="polite"');
    expect(shellHtml(rig.root)).toContain('held for approval');
    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RESULT_SECTION_ATTR);
    expect(shellHtml(rig.root)).not.toContain('held output must not render');

    rig.route.dispose();
  });

  it('announces a terminated run and keeps returned output non-actionable (D-195 P3)', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          success: false,
          run_terminated: 'killed',
          awaiting_approval: true,
          output: {
            render: [{ type: 'button', data: {
              kind: 'recipe.run',
              label: 'Must not run',
              recipe_id: 'reply-action',
            } }],
          } as unknown as ServerExecuteResponse['output'],
        })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Run terminated');
    expect(html).not.toContain('Awaiting approval');
    expect(html).not.toContain('held for approval');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_SECTION_ATTR);
    expect(html).not.toContain('Must not run');

    rig.route.dispose();
  });

  it('fails closed for unknown or missing checklist statuses (D-195 P4)', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{
              type: 'checklist',
              data: {
                items: [
                  { label: 'Known good', status: 'ok' },
                  { label: 'Still pending', status: 'pending' },
                  { label: 'Missing status' },
                ],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('<strong>OK:</strong>');
    expect(html.match(/<strong>Unknown:<\/strong>/g)).toHaveLength(2);
    expect(html).not.toContain('<strong>OK:</strong>\n            <span>Still pending</span>');
    expect(html).not.toContain('<strong>OK:</strong>\n            <span>Missing status</span>');

    rig.route.dispose();
  });

  it('renders result output when awaiting approval is explicitly false (D-195 P3 audit)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [{ type: 'text', data: 'visible result' }],
          sidebar: [],
        },
        awaiting_approval: false,
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(shellHtml(rig.root)).toContain('Run completed');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="text"`);
    expect(shellHtml(rig.root)).toContain('visible result');
    expect(shellHtml(rig.root)).not.toContain('Awaiting approval');
    expect(shellHtml(rig.root)).not.toContain('held for approval');

    rig.route.dispose();
  });

  it('replaces same-recipe current-session results instead of appending history (D-195 P3)', async () => {
    let runCount = 0;
    const execute = vi.fn<RecipeExecuteCaller>(async () => {
      runCount += 1;
      return executeResponse({
        output: {
          render: [{ type: 'text', data: `current result ${runCount}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain('current result 1');

    rig.route.closeRunModal();
    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('daily-brief');
    expect(html).toContain('current result 2');
    expect(html).not.toContain('current result 1');

    rig.route.dispose();
  });

  it('does not paint a modal result into a different detail after navigation (D-195 P3 audit)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) =>
      executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          recipeEntry('other-recipe', {
            recipe: recipeDefinition('other-recipe', {
              metadata: {
                name: 'Other recipe',
                description: 'Different detail.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    rig.route.openRecipe('other-recipe');
    await rig.route.confirmRun();

    expect(execute).toHaveBeenCalledWith({ recipe_id: 'daily-brief', config: {} });
    expect(rig.route.selectedRecipe()).toBe('other-recipe');
    expect(rig.route.resultPanel()).toBeNull();
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="other-recipe"`);
    expect(shellHtml(rig.root)).not.toContain('result for daily-brief');

    rig.route.dispose();
  });

  it('falls back to legacy output.sidebar when output.render is absent (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          sidebar: [{ type: 'text', data: 'legacy sidebar result' }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="text"`);
    expect(shellHtml(rig.root)).toContain('legacy sidebar result');

    rig.route.dispose();
  });

  it('renders a related-recipe run result in the current detail without navigating (D-195 P3)', async () => {
    const bundle = 'recued-core/outbound-follow-up-response';
    const bundledRecipe = (recipe_id: string, name: string) =>
      recipeDefinition(recipe_id, {
        metadata: {
          name,
          description: `${name} description`,
          author: 'recued-core',
          supported_platforms: [],
          tags: ['bundle'],
          recipe_bundle: bundle,
        },
      });
    const execute = vi.fn<RecipeExecuteCaller>(async (args) =>
      executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue', { recipe: bundledRecipe('review-queue', 'Review queue') }),
          recipeEntry('reply-action', { recipe: bundledRecipe('reply-action', 'Reply action') }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');

    clickRecipeAction(rig.root, 'open-run', 'reply-action');
    await rig.route.confirmRun();

    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(execute).toHaveBeenLastCalledWith({ recipe_id: 'reply-action', config: {} });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.source_recipe_id).toBeNull();
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.origin).toBe('related-recipes');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="review-queue"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_PANEL_ATTR}="reply-action"`);
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="related-recipes"`,
    );
    expect(shellHtml(rig.root)).toContain('Source recipe:</strong> None');
    expect(shellHtml(rig.root)).toContain('Return to Review queue result');
    expect(shellHtml(rig.root)).toContain('result for reply-action');

    rig.route.dispose();
  });

  it('opens result action runs with prefilled config and context (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'review-queue') {
        return executeResponse({
          recipe_id: 'review-queue',
          recipe_hash: 'hash-review-queue',
          output: {
            render: [{
              type: 'button',
              data: {
                kind: 'recipe.run',
                label: 'Draft reply',
                recipe_id: 'reply-action',
                variant: 'primary',
                config: { tone: 'warm' },
                context: {
                  entity_id: 42,
                  review: { mode: 'draft', recipients: ['owner', 'legal'] },
                  notify: true,
                },
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('reply-action', {
            recipe: recipeDefinition('reply-action', {
              metadata: {
                name: 'Reply action',
                description: 'Draft a reply.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
              output: {
                sidebar: [{ type: 'text', source: '{{context.entity_id}}' }],
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    rig.route.closeRunModal();

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.runModal()?.recipe_id).toBe('reply-action');
    expect(rig.route.runModal()?.config_text).toContain('"tone": "warm"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({
      entity_id: 42,
      review: { mode: 'draft', recipients: ['owner', 'legal'] },
      notify: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runModalHtml(rig.root)).toContain(`${RunModal.RUN_MODAL_OVERLAY_ATTR}="reply-action"`);
    expect(runModalHtml(rig.root)).toContain('Reply action');
    expect(runModalHtml(rig.root)).toContain('&quot;tone&quot;: &quot;warm&quot;');
    expect(runModalHtml(rig.root)).toContain('Target — entity_id');
    expect(runModalHtml(rig.root)).toContain('Context JSON (prefilled)');
    expect(runModalHtml(rig.root)).toContain('&quot;entity_id&quot;: 42');
    expect(runModalHtml(rig.root)).toContain('&quot;mode&quot;: &quot;draft&quot;');
    expect(runModalHtml(rig.root)).toContain('Target recipe: <code>reply-action</code>');
    expect(runModalHtml(rig.root)).toContain('Publisher: <code>recued-core</code>');

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'reply-action',
      config: { tone: 'warm' },
      context: {
        entity_id: 42,
        review: { mode: 'draft', recipients: ['owner', 'legal'] },
        notify: true,
      },
    });
    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.source_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.origin).toBe('result-action');
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="result-action"`,
    );
    expect(shellHtml(rig.root)).toContain('result for reply-action');

    rig.route.dispose();
  });

  it('can return from a child result to the source result panel (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'review-queue') {
        return executeResponse({
          recipe_id: 'review-queue',
          recipe_hash: 'hash-review-queue',
          output: {
            render: [
              { type: 'text', data: 'source review result' },
              {
                type: 'button',
                data: {
                  kind: 'recipe.run',
                  label: 'Draft reply',
                  recipe_id: 'reply-action',
                  context: { entity_id: 'deal-42' },
                },
              },
            ],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `child result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue', {
            recipe: recipeDefinition('review-queue', {
              metadata: {
                name: 'Review queue',
                description: 'Review source results.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
            }),
          }),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain('source review result');

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(rig.route.runModal()?.recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain('source review result');

    await rig.route.confirmRun();

    let html = shellHtml(rig.root);
    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.source_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.origin).toBe('result-action');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');
    expect(html).toContain('child result for reply-action');
    expect(html).not.toContain('source review result');
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_RETURN_ATTR}="review-queue"`);
    expect(html).toContain('Return to Review queue result');

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'review-queue',
    });

    html = shellHtml(rig.root);
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();
    expect(html).toContain('source review result');
    expect(html).not.toContain('child result for reply-action');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_RETURN_ATTR);

    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();

    html = shellHtml(rig.root);
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();
    expect(html).toContain('source review result');
    expect(html).not.toContain('child result for reply-action');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_RETURN_ATTR);

    rig.route.dispose();
  });

  it('keeps a navigable result stack across nested result actions (D-195 P3)', async () => {
    const namedRecipe = (recipe_id: string, name: string) =>
      recipeEntry(recipe_id, {
        recipe: recipeDefinition(recipe_id, {
          metadata: {
            name,
            description: `${name} description`,
            author: 'recued-core',
            supported_platforms: [],
            tags: [],
          },
        }),
      });
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      const next = args.recipe_id === 'review-queue'
        ? { label: 'Open reply', recipe_id: 'reply-action' }
        : args.recipe_id === 'reply-action'
          ? { label: 'Close watch', recipe_id: 'close-action' }
          : null;
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [
            { type: 'text', data: `result for ${args.recipe_id}` },
            ...(next === null
              ? []
              : [{ type: 'button', data: { kind: 'recipe.run', ...next } }]),
          ],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          namedRecipe('review-queue', 'Review queue'),
          namedRecipe('reply-action', 'Reply action'),
          namedRecipe('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();

    expect(rig.route.resultPanel()).toMatchObject({
      render_recipe_id: 'close-action',
      source_recipe_id: 'reply-action',
      origin: 'result-action',
      previous: {
        render_recipe_id: 'reply-action',
        source_recipe_id: 'review-queue',
        previous: { render_recipe_id: 'review-queue' },
      },
    });
    expect(shellHtml(rig.root)).toContain('Return to Reply action result');

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'reply-action',
    });
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain('Return to Review queue result');

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'review-queue',
    });
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();
    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RESULT_RETURN_ATTR);

    rig.route.dispose();
  });

  it('replaces an older same-recipe snapshot when result actions cycle A to B to A', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      const target = args.recipe_id === 'review-queue' ? 'reply-action' : 'review-queue';
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [
            { type: 'text', data: `fresh result for ${args.recipe_id}` },
            {
              type: 'button',
              data: {
                kind: 'recipe.run',
                label: `Run ${target}`,
                recipe_id: target,
              },
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('reply-action', {
            recipe: recipeDefinition('reply-action', {
              metadata: {
                name: 'Reply action',
                description: 'Cycles back to the source recipe.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();

    expect(rig.route.resultPanel()).toMatchObject({
      render_recipe_id: 'review-queue',
      previous: { render_recipe_id: 'reply-action' },
    });
    expect(rig.route.resultPanel()?.previous?.previous).toBeUndefined();

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'reply-action',
    });
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();

    rig.route.dispose();
  });

  it('honors result action confirmation before opening the target run (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'button',
              data: {
                kind: 'recipe.run',
                label: 'Close watch',
                recipe_id: 'close-action',
                confirm: 'Close this watch?',
                config: { status: 'closed' },
                context: { entity_id: 'deal-42' },
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const confirm = vi.fn<(message?: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      confirm,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(confirm).toHaveBeenNthCalledWith(1, 'Close this watch?');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rig.route.runModal()).toBeNull();
    expect(runModalHtml(rig.root)).toBe('');
    expect(execute).toHaveBeenCalledTimes(1);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(confirm).toHaveBeenNthCalledWith(2, 'Close this watch?');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-42' });
    expect(execute).toHaveBeenCalledTimes(1);

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'close-action',
      config: { status: 'closed' },
      context: { entity_id: 'deal-42' },
    });
    expect(shellHtml(rig.root)).toContain('result for close-action');

    rig.route.dispose();
  });

  it('renders an exact file card, authenticated download, and hash-pinned approval action (D-200)', async () => {
    const sha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'JVBERi0xLjQK',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: sha256,
    }));
    const execute = vi.fn<RecipeExecuteCaller>(async () => executeResponse({
      output: {
        render: [{
          type: 'file_artifact',
          label: 'Artifacts ready for exact review',
          data: [{
            title: 'Paid document for response submission-1',
            record_id: 'file:abcdef0123456789abcdef0123456789',
            filename: 'document.pdf',
            mime_type: 'application/pdf',
            size_bytes: 9,
            sha256,
            generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
            generation_mode: 'static',
            origin: { submission_id: 'submission-1', task_id: 'task-1' },
            payment: {
              amount_minor: 7_500,
              currency: 'usd',
              status: 'paid',
              verified_at: Date.UTC(2026, 6, 11, 11, 55, 0),
            },
            template: {
              filename: 'template.md',
              sha256: 'b'.repeat(64),
              format: 'markdown',
            },
            approval_action: {
              kind: 'recipe.run',
              label: 'Approve and send exact PDF',
              recipe_id: 'approve-deliver-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
              variant: 'primary',
            },
            decision_actions: [{
              kind: 'recipe.run',
              label: 'Regenerate exact PDF',
              recipe_id: 'generate-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
            }, {
              kind: 'recipe.run',
              label: 'Reject exact PDF',
              recipe_id: 'regenerate-reject-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
                decision: 'reject',
              },
            }, {
              kind: 'recipe.run',
              label: 'Cancel fulfillment',
              recipe_id: 'regenerate-reject-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
                decision: 'cancel',
              },
            }],
          }, {
            title: 'Same blob with mismatched displayed metadata',
            record_id: 'file:abcdef0123456789abcdef0123456789',
            filename: 'different-name.pdf',
            mime_type: 'application/pdf',
            size_bytes: 9,
            sha256,
            generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
            origin: { submission_id: 'submission-1' },
            approval_action: {
              kind: 'recipe.run',
              label: 'Approve and send exact PDF',
              recipe_id: 'approve-deliver-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
            },
          }],
        }],
      } as unknown as ServerExecuteResponse['output'],
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileBrowser: true,
      recipeExecuteCaller: execute,
      fileReadCaller,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
          recipeEntry('generate-paid-document'),
          recipeEntry('regenerate-reject-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [
          'review-queue',
          'approve-deliver-paid-document',
          'generate-paid-document',
          'regenerate-reject-paid-document',
        ].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="file_artifact"`);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_FILE_ATTR}="result-file-0"`);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_FILE_ATTR}="result-file-1"`);
    expect(html).toContain('Preview exact PDF');
    expect(html).toContain('Download exact PDF');
    expect(html).toContain('7,500 USD in the smallest coins');
    expect(html).toContain('template.md');
    expect(html).toContain(sha256);
    expect(html).toContain('Approve and send exact PDF');
    expect(html).toContain('Regenerate exact PDF');
    expect(html).toContain('Reject exact PDF');
    expect(html).toContain('Cancel fulfillment');
    expect(html).toContain('Preview or download this exact file before approving it.');
    expect(html).toContain('Preview or download this exact file before deciding.');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    // INVERTED at D-207 3d·6b (`d3d60acf1`), which deleted the offer↔task link
    // substrate — op, table, rpc projection, UI and renderer paths — and took
    // `origin.task_id` out of the contract with it. This asserted the opposite:
    // that card 0's Task row rendered.
    //
    // ⚠ Card 0's fixture still CARRIES `task_id: 'task-1'`, deliberately and
    // not as leftovers. Removing it would make these assertions pass for the
    // wrong reason — "no Task row because no task data" instead of "no Task row
    // because the renderer path is gone". Feeding the deleted field and getting
    // nothing back is the only version of this that pins the deletion.
    expect(html).not.toContain('task-1');
    expect(html).not.toContain('<dt class="recipes-result-label">Task</dt>');

    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'download',
    });
    await vi.waitFor(() => {
      expect(fileReadCaller).toHaveBeenCalledWith({
        record_id: 'file:abcdef0123456789abcdef0123456789',
      });
      expect(shellHtml(rig.root)).toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`,
      );
      expect(shellHtml(rig.root)).toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-3"`,
      );
      expect(shellHtml(rig.root)).not.toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-4"`,
      );
    });

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    expect(rig.route.runModal()?.recipe_id).toBe('approve-deliver-paid-document');
    expect(rig.route.runModal()?.config_text).toContain('"submission_id": "submission-1"');
    expect(rig.route.runModal()?.config_text).toContain(
      `"reviewed_artifact_sha256": "${sha256}"`,
    );

    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-1',
    });
    expect(rig.route.runModal()?.recipe_id).toBe('generate-paid-document');
    expect(rig.route.runModal()?.config_text).toContain('"submission_id": "submission-1"');
    expect(rig.route.runModal()?.config_text).toContain(
      `"reviewed_artifact_sha256": "${sha256}"`,
    );

    rig.route.dispose();
  });

  it('keeps approval locked when the host cannot safely open returned bytes (D-200 audit)', async () => {
    const sha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'WA==',
      mime_type: 'text/html',
      filename: 'unsafe.html',
      size_bytes: 1,
      blob_hash: sha256,
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileReadCaller,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        output: {
          render: [{
            type: 'file_artifact',
            data: {
              record_id: 'file:abcdef0123456789abcdef0123456789',
              filename: 'unsafe.html',
              mime_type: 'text/html',
              size_bytes: 1,
              sha256,
              generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
              origin: { submission_id: 'submission-1' },
              approval_action: {
                kind: 'recipe.run',
                label: 'Approve and send exact PDF',
                recipe_id: 'approve-deliver-paid-document',
                config: {
                  submission_id: 'submission-1',
                  reviewed_artifact_sha256: sha256,
                },
              },
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).not.toContain('Preview exact PDF');
    expect(shellHtml(rig.root)).toContain('Download exact file');
    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'download',
    });

    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'This browser cannot safely open the file.',
      );
    });
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    rig.route.dispose();
  });

  it('keeps approval locked when decoded bytes disagree with authenticated size metadata (D-200 audit)', async () => {
    const sha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'JVBERi0xLjQ=',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: sha256,
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileBrowser: true,
      fileReadCaller,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        output: {
          render: [{
            type: 'file_artifact',
            data: {
              record_id: 'file:abcdef0123456789abcdef0123456789',
              filename: 'document.pdf',
              mime_type: 'application/pdf',
              size_bytes: 9,
              sha256,
              generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
              origin: { submission_id: 'submission-1' },
              approval_action: {
                kind: 'recipe.run',
                label: 'Approve and send exact PDF',
                recipe_id: 'approve-deliver-paid-document',
                config: {
                  submission_id: 'submission-1',
                  reviewed_artifact_sha256: sha256,
                },
              },
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'download',
    });

    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'The file is not the size it said it was.',
      );
    });
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    rig.route.dispose();
  });

  it('does not let stale read cleanup clear a newer exact-file verification (D-200 audit)', async () => {
    type FileReadResult = Awaited<ReturnType<RecipeFileReadCaller>>;
    const sha256 = 'a'.repeat(64);
    const exactFile: FileReadResult = {
      record_id: 'file:abcdef0123456789abcdef0123456789',
      bytes_b64: 'JVBERi0xLjQK',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: sha256,
    };
    const firstRead = deferred<FileReadResult>();
    const secondRead = deferred<FileReadResult>();
    const reads = [firstRead, secondRead];
    let readIndex = 0;
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(() => {
      const read = reads[readIndex];
      readIndex += 1;
      if (read === undefined) throw new Error('unexpected extra file read');
      return read.promise;
    });
    const execute = vi.fn<RecipeExecuteCaller>(async () => executeResponse({
      output: {
        render: [{
          type: 'file_artifact',
          data: {
            record_id: exactFile.record_id,
            filename: exactFile.filename,
            mime_type: exactFile.mime_type,
            size_bytes: exactFile.size_bytes,
            sha256,
            generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
            origin: { submission_id: 'submission-1' },
            approval_action: {
              kind: 'recipe.run',
              label: 'Approve and send exact PDF',
              recipe_id: 'approve-deliver-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
            },
          },
        }],
      } as unknown as ServerExecuteResponse['output'],
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileBrowser: true,
      fileReadCaller,
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();

    const runReview = async (): Promise<void> => {
      rig.route.openRunModal('review-queue');
      await rig.route.confirmRun();
      rig.route.closeRunModal();
    };
    const startRead = (): void => {
      clickRecipeAction(rig.root, 'open-result-file', '', {
        [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
        'data-recued-recipes-result-file-mode': 'download',
      });
    };

    await runReview();
    startRead();
    await vi.waitFor(() => expect(fileReadCaller).toHaveBeenCalledTimes(1));

    await runReview();
    startRead();
    await vi.waitFor(() => expect(fileReadCaller).toHaveBeenCalledTimes(2));
    expect(shellHtml(rig.root)).toContain('Reading the exact file…');

    firstRead.resolve(exactFile);
    await firstRead.promise;
    await Promise.resolve();

    expect(shellHtml(rig.root)).toContain('Reading the exact file…');
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    secondRead.resolve(exactFile);
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`,
      );
    });

    rig.route.dispose();
  });

  it('refuses changed authenticated bytes and mismatched approval pins (D-200)', async () => {
    const reviewedSha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'JVBERi0xLjQ=',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: 'c'.repeat(64),
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileReadCaller,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        output: {
          render: [{
            type: 'file_artifact',
            data: {
              record_id: 'file:abcdef0123456789abcdef0123456789',
              filename: 'document.pdf',
              mime_type: 'application/pdf',
              size_bytes: 9,
              sha256: reviewedSha256,
              generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
              origin: { submission_id: 'submission-1' },
              approval_action: {
                kind: 'recipe.run',
                label: 'Approve and send exact PDF',
                recipe_id: 'approve-deliver-paid-document',
                config: {
                  submission_id: 'submission-1',
                  reviewed_artifact_sha256: 'b'.repeat(64),
                },
              },
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).toContain(
      'This does not match the answer and the file Recued has.',
    );
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'preview',
    });
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'The file that came back does not match the fingerprint you checked.',
      );
    });
    expect(shellHtml(rig.root)).toContain(RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR);

    rig.route.dispose();
  });

  it('renders result actions in tables, checklists, and multi-action groups (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            {
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: 'Name' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: 'Acme',
                  action: { kind: 'recipe.run', label: 'Open row', recipe_id: 'reply-action' },
                }],
              },
            },
            {
              type: 'checklist',
              data: {
                items: [{
                  label: 'Reply needed',
                  status: 'issue',
                  detail: 'Owner should respond',
                  actions: [
                    { kind: 'recipe.run', label: 'Approve', recipe_id: 'reply-action' },
                    { kind: 'recipe.run', label: 'Missing target', recipe_id: 'missing-action' },
                  ],
                }],
              },
            },
            {
              type: 'button',
              data: [
                { kind: 'recipe.run', label: 'Send nudge', recipe_id: 'reply-action' },
                { kind: 'recipe.run', label: 'Close watch', recipe_id: 'reply-action' },
              ],
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Open row');
    expect(html).toContain('Approve');
    expect(html).toContain('Send nudge');
    expect(html).toContain('Close watch');
    // ⚠ D-282 B1 — two actions are two BUTTONS now, not a picker. Their labels are
    // asserted above; what changed is that each is independently pressable.
    expect(html).not.toContain('data-recued-recipes-result-action-select="result-action-group-');
    expect(inlineResultActionIds(html).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('Recipe &quot;missing-action&quot; is not installed.');

    rig.route.dispose();
  });

  it('opens the fenced-delivery reconciler from a sending review row (D-200 audit)', async () => {
    const confirm = vi.fn<(message?: string) => boolean>().mockReturnValue(true);
    const rig = mountRoute({
      initialRecipeId: 'review-paid-document-artifacts',
      confirm,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{
              type: 'table',
              data: {
                columns: [
                  { field: 'submission_id', label: 'Submission' },
                  { field: 'action', label: 'Recovery', type: 'action' },
                ],
                rows: [{
                  submission_id: 'submission-1',
                  action: {
                    kind: 'recipe.run',
                    label: 'Reconcile fenced delivery',
                    recipe_id: 'reconcile-paid-document-delivery',
                    config: { submission_id: 'submission-1' },
                    confirm: 'Check the exact provider proof without resending?',
                  },
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-paid-document-artifacts'),
          recipeEntry('reconcile-paid-document-delivery'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [
          'review-paid-document-artifacts',
          'reconcile-paid-document-delivery',
        ].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-paid-document-artifacts');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).toContain('Reconcile fenced delivery');
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`,
    );

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(confirm).toHaveBeenCalledWith(
      'Check the exact provider proof without resending?',
    );
    expect(rig.route.runModal()?.recipe_id).toBe('reconcile-paid-document-delivery');
    expect(JSON.parse(rig.route.runModal()?.config_text ?? '')).toEqual({
      submission_id: 'submission-1',
    });
    expect(rig.route.runModal()?.context_values).toEqual({});

    rig.route.dispose();
  });

  it('opens a checklist item action with prefilled config and context (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'checklist',
              data: {
                items: [{
                  label: 'Review needed',
                  status: 'issue',
                  detail: 'Owner should respond.',
                  action: {
                    kind: 'recipe.run',
                    label: 'Draft reply',
                    recipe_id: 'reply-action',
                    config: { tone: 'direct' },
                    context: { entity_id: 'deal-7' },
                  },
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    expect(html).toContain('Review needed');
    expect(html).toContain('Draft reply');
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    expect(html).not.toContain(`${RESULT_ACTION_SELECT_ATTR}="`);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(rig.route.runModal()?.recipe_id).toBe('reply-action');
    expect(rig.route.runModal()?.config_text).toContain('"tone": "direct"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-7' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runModalHtml(rig.root)).toContain(`${RunModal.RUN_MODAL_OVERLAY_ATTR}="reply-action"`);
    expect(runModalHtml(rig.root)).toContain('Reply action');
    expect(runModalHtml(rig.root)).toContain('&quot;tone&quot;: &quot;direct&quot;');
    expect(runModalHtml(rig.root)).toContain('deal-7');

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'reply-action',
      config: { tone: 'direct' },
      context: { entity_id: 'deal-7' },
    });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(shellHtml(rig.root)).toContain('result for reply-action');

    rig.route.dispose();
  });

  it('opens the selected result action from a checklist multi-action group (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'checklist',
              data: {
                items: [{
                  label: 'Reply needed',
                  status: 'issue',
                  detail: 'Owner should choose the next action.',
                  actions: [
                    {
                      kind: 'recipe.run',
                      label: 'Draft reply',
                      recipe_id: 'reply-action',
                      config: { tone: 'warm' },
                      context: { entity_id: 'deal-42' },
                    },
                    {
                      kind: 'recipe.run',
                      label: 'Close watch',
                      recipe_id: 'close-action',
                      config: { status: 'closed' },
                      context: { entity_id: 'deal-99' },
                    },
                  ],
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    // ⚠ D-282 B1 — two runnable actions are two buttons; the SECOND is pressed
    // directly rather than chosen from a picker and then run.
    const actionIds = inlineResultActionIds(html);
    expect(actionIds).toEqual(['result-action-0', 'result-action-1']);
    expect(html).not.toContain(`${RESULT_ACTION_SELECT_ATTR}="`);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: actionIds[1]!,
    });

    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-99' });
    expect(execute).toHaveBeenCalledTimes(1);

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'close-action',
      config: { status: 'closed' },
      context: { entity_id: 'deal-99' },
    });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('close-action');
    expect(shellHtml(rig.root)).toContain('result for close-action');

    rig.route.dispose();
  });

  /** D-282 B1 — the OTHER side of the threshold. Three or fewer runnable actions render
   *  as buttons; a wider group still collapses into the picker, because four buttons do
   *  not fit a table cell and the widest groups in the corpus (one 4, two 5, one 6) live
   *  in cells as well as in `button` blocks. This is the only cover the picker has left,
   *  so it asserts the whole path: the control exists, and pressing Run opens the action
   *  the select is pointing at. */
  it('keeps the picker for a group wider than three, and runs the chosen one', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: 'Name' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: 'Acme',
                  action: [
                    { kind: 'recipe.run', label: 'One', recipe_id: 'reply-action' },
                    { kind: 'recipe.run', label: 'Two', recipe_id: 'close-action' },
                    { kind: 'recipe.run', label: 'Three', recipe_id: 'reply-action' },
                    {
                      kind: 'recipe.run',
                      label: 'Four',
                      recipe_id: 'close-action',
                      config: { status: 'closed' },
                    },
                  ],
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    const { groupId, actionIds } = resultActionSelection(html);
    expect(groupId).toBe('result-action-group-0');
    expect(actionIds).toHaveLength(4);
    // ⛔ Four is past the threshold, so NO standalone action buttons were drawn.
    expect(html).not.toContain('="run-result-action"');

    appendSelectedResultAction(rig.doc, rig.root.children[0]!, groupId!, actionIds[3]!);
    clickRecipeAction(rig.root, 'run-selected-result-action', '', {
      [RESULT_ACTION_SELECT_ATTR]: groupId!,
    });

    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');

    rig.route.dispose();
  });

  it('opens the selected result action from a table-cell multi-action group (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: 'Name' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: 'Acme',
                  action: [
                    {
                      kind: 'recipe.run',
                      label: 'Draft reply',
                      recipe_id: 'reply-action',
                      config: { tone: 'warm' },
                      context: { entity_id: 'deal-42' },
                    },
                    {
                      kind: 'recipe.run',
                      label: 'Close watch',
                      recipe_id: 'close-action',
                      config: { status: 'closed' },
                      context: { entity_id: 'deal-99' },
                    },
                  ],
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    expect(html).toContain('Acme');
    expect(html).toContain('Draft reply');
    expect(html).toContain('Close watch');
    // ⚠ D-282 B1 — two runnable actions are two buttons; the SECOND is pressed
    // directly rather than chosen from a picker and then run.
    const actionIds = inlineResultActionIds(html);
    expect(actionIds).toEqual(['result-action-0', 'result-action-1']);
    expect(html).not.toContain(`${RESULT_ACTION_SELECT_ATTR}="`);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: actionIds[1]!,
    });

    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-99' });
    expect(execute).toHaveBeenCalledTimes(1);

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'close-action',
      config: { status: 'closed' },
      context: { entity_id: 'deal-99' },
    });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('close-action');
    expect(shellHtml(rig.root)).toContain('result for close-action');

    rig.route.dispose();
  });

  it('escapes result output and keeps unsupported actions non-executable (D-195 P4 security)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            {
              type: 'summary',
              label: '<img src=x onerror="alert(1)">',
              data: {
                fields: [
                  { label: '<script>alert(1)</script>', value: '<b>unsafe</b>' },
                ],
              },
            },
            {
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: '<th onclick="steal()">Name</th>' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: '<svg onload="steal()">',
                  action: {
                    kind: 'rpc.call',
                    label: '<button onclick="steal()">Run</button>',
                    recipe_id: 'reply-action',
                  },
                }],
              },
            },
            {
              type: 'checklist',
              data: {
                items: [{
                  label: '<iframe src="bad"></iframe>',
                  status: 'issue',
                  detail: '<style>body{display:none}</style>',
                  action: {
                    kind: 'url.open',
                    label: '<a href="javascript:alert(1)">Open</a>',
                    recipe_id: 'reply-action',
                  },
                }],
              },
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;unsafe&lt;/b&gt;');
    expect(html).toContain('&lt;th onclick=&quot;steal()&quot;&gt;Name&lt;/th&gt;');
    expect(html).toContain('&lt;svg onload=&quot;steal()&quot;&gt;');
    expect(html).toContain('&lt;iframe src=&quot;bad&quot;&gt;&lt;/iframe&gt;');
    expect(html).toContain('&lt;button onclick=&quot;steal()&quot;&gt;Run&lt;/button&gt;');
    expect(html).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;Open&lt;/a&gt;');
    expect(html).toContain('You can only open things that run a Recipe.');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<th onclick=');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<iframe src=');
    expect(html).not.toContain('<button onclick=');
    expect(html).not.toContain('<a href="javascript:');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`);

    rig.route.dispose();
  });

  it('rejects reserved context and blocked targets but accepts other author keys (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [{
            type: 'button',
            data: [
              {
                kind: 'recipe.run',
                label: 'Reserved context',
                recipe_id: 'reply-action',
                context: { event: 'source-event' },
              },
              {
                kind: 'recipe.run',
                label: 'Blocked target',
                recipe_id: 'blocked-action',
              },
              {
                kind: 'recipe.run',
                label: 'Missing pack target',
                recipe_id: 'pack-blocked-action',
              },
              {
                kind: 'recipe.run',
                label: 'Forged caller',
                recipe_id: 'reply-action',
                context: { caller: { contract_id: 'ct_forged' } },
              },
              {
                kind: 'recipe.run',
                label: 'Author context',
                recipe_id: 'reply-action',
                context: { entity_id: 'deal-42', review_mode: 'owner' },
              },
            ],
          }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          recipeEntry('reply-action'),
          recipeEntry('blocked-action'),
          recipeEntry('pack-blocked-action'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [
          {
            recipe_id: 'reply-action',
            status: 'runnable' as RunnabilityStatus,
            dependencies: [],
          },
          {
            recipe_id: 'blocked-action',
            status: 'blocked' as RunnabilityStatus,
            dependencies: [],
          },
          {
            recipe_id: 'pack-blocked-action',
            status: 'blocked' as RunnabilityStatus,
            dependencies: [{
              capability: 'recued-core.officecli',
              ops: [],
              optional: false,
              satisfied: false,
              providers: [],
              unprovided_ops: [],
            }],
          },
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('You cannot use the name Recued keeps for itself: &quot;event&quot;.');
    expect(html).toContain('You cannot use the name Recued keeps for itself: &quot;caller&quot;.');
    expect(html).toContain('That Recipe cannot run. It needs a provider you do not have.');
    expect(html).toContain('That Recipe needs a Pack you have not installed.');
    // ⚠ D-282 B1 — the ONE runnable action in this group is a button with its label,
    // and the four refusals above still show their own reasons. A group that is partly
    // invalid must say which half and why, not render the runnable remainder silently.
    expect(html).toContain('>Author context</button>');
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    expect(html).not.toContain('is not a visible target for this recipe');

    rig.route.dispose();
  });

  it('rejects non-JSON action config and context before opening a run (D-195 P4)', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{
              type: 'button',
              data: [
                {
                  kind: 'recipe.run',
                  label: 'Bad context',
                  recipe_id: 'reply-action',
                  context: { value: undefined },
                },
                {
                  kind: 'recipe.run',
                  label: 'Bad config',
                  recipe_id: 'reply-action',
                  config: { count: Number.POSITIVE_INFINITY },
                },
              ],
            }],
          } as unknown as ServerExecuteResponse['output'],
        })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('The details have to be a JSON object.');
    expect(html).toContain('The settings have to be a JSON object.');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`);

    rig.route.dispose();
  });

  it('disables result actions when runnability cannot be verified (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [{
            type: 'button',
            data: {
              kind: 'recipe.run',
              label: 'Draft reply',
              recipe_id: 'reply-action',
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      runnabilityCaller: null,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Draft reply');
    expect(html).toContain('Recued cannot tell whether this can run.');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`);

    rig.route.dispose();
  });

  it('opens the run modal on the Schedule tab (quick-schedule via L1)', async () => {
    const rig = mountRoute({
      schedulesListCaller: vi.fn(async () => ({ schedules: [] })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief', 'schedule');
    expect(rig.route.runModal()?.recipe_id).toBe('daily-brief');
    expect(runModalHtml(rig.root)).toContain('Schedule');

    rig.route.dispose();
  });
});

const connectionRecipeEntry = (): ServerRecipeListEntry =>
  recipeEntry('crm-sync', {
    recipe: recipeDefinition('crm-sync', {
      requires: ['read_memory', 'read_connection_hubspot'],
      steps: [
        {
          id: 'pull',
          ingredient: 'crm-reader',
          input: { base: '{{connection.api.hubspot.base_url}}' },
        },
      ] as unknown as RecipeDefinition['steps'],
    }),
  });

const enrolledConnection = (
  name: string,
  display_name: string,
): ConnectionView =>
  ({ name, kind: 'api', display_name }) as ConnectionView;

describe('R24 — Recipes route detail → connection needs (UX flow-10)', () => {
  it('surfaces the connection a recipe needs + an enroll CTA on the detail', async () => {
    const rig = mountRoute({
      initialRecipeId: 'crm-sync',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [connectionRecipeEntry()],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(RECIPES_ROUTE_CONNECTIONS_ATTR);
    expect(html).toContain('hubspot (api)');
    expect(html).toContain(RECIPES_ROUTE_CONNECTIONS_LINK_ATTR);
    expect(html).toContain('href="#connections"');

    rig.route.dispose();
  });

  it('marks a needed connection "connected" (no CTA) when already enrolled', async () => {
    const rig = mountRoute({
      initialRecipeId: 'crm-sync',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [connectionRecipeEntry()],
      })),
      connectionsListCaller: vi.fn<RecipesConnectionsListCaller>(async () => ({
        connections: [enrolledConnection('hubspot', 'HubSpot Prod')],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain('HubSpot Prod — connected');
    expect(html).not.toContain(RECIPES_ROUTE_CONNECTIONS_LINK_ATTR);

    rig.route.dispose();
  });
});

// ── runnability consumer (the visible half) ──────────────────────────

const unsatisfiedDep = (
  overrides: Partial<DependencyResolution> = {},
): DependencyResolution => ({
  capability: 'crm',
  ops: ['search'],
  optional: false,
  satisfied: false,
  providers: [],
  unprovided_ops: ['search'],
  ...overrides,
});

const missingPackDep = (packRef: string): DependencyResolution => ({
  capability: packRef,
  ops: [],
  optional: false,
  satisfied: false,
  providers: [],
  unprovided_ops: [],
});

const runnabilityEntry = (
  recipe_id: string,
  status: RunnabilityStatus,
  dependencies: DependencyResolution[] = [],
): RecipeRunnabilityEntry => ({ recipe_id, status, dependencies });

describe('R24 — Recipes route runnability consumer', () => {
  it('reads recipe.runnability on mount and renders per-recipe status pills', async () => {
    const runnabilityCaller = vi.fn<RecipesRunnabilityCaller>(async () => ({
      recipes: [
        runnabilityEntry('daily-brief', 'runnable'),
        runnabilityEntry('deal-watch', 'blocked', [unsatisfiedDep()]),
        runnabilityEntry('contact-enrich', 'degraded', [
          unsatisfiedDep({
            capability: 'acct',
            ops: ['enrich'],
            optional: true,
            unprovided_ops: ['enrich'],
          }),
        ]),
      ],
    }));
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry(),
          recipeEntry('deal-watch'),
          recipeEntry('contact-enrich'),
          recipeEntry('extra-recipe'),
        ],
      })),
      runnabilityCaller,
    });
    await rig.route.whenLoaded();

    expect(runnabilityCaller).toHaveBeenCalledTimes(1);
    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="runnable"`);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="blocked"`);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="degraded"`);
    expect(html).toContain('Add a provider for crm.search.');
    expect(html).toContain(
      'Add a provider for acct.enrich (optional — those steps skip).',
    );
    // Exactly the three snapshot-covered recipes carry a pill.
    expect(html.split(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="`).length - 1).toBe(3);

    rig.route.dispose();
  });

  it('patches pills in place from recipe_runnability_changed without a re-read', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => {};
    }) as RecipesRouteSubscribe;
    const runnabilityCaller = vi.fn<RecipesRunnabilityCaller>(async () => ({
      recipes: [runnabilityEntry('daily-brief', 'runnable')],
    }));
    const rig = mountRoute({ runnabilityCaller, subscribe });
    await rig.route.whenLoaded();
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RUNNABILITY_ATTR}="runnable"`,
    );

    listeners.get('recipe_runnability_changed')!({
      kind: 'recipe_runnability_changed',
      recipes: [runnabilityEntry('daily-brief', 'blocked', [unsatisfiedDep()])],
      cursor: 7,
    });

    expect(runnabilityCaller).toHaveBeenCalledTimes(1);
    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="blocked"`);
    expect(html).toContain('Add a provider for crm.search.');

    rig.route.dispose();
  });

  it('offers the missing pack before Run and recovers from the live snapshot', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => {};
    }) as RecipesRouteSubscribe;
    const recipe = recipeEntry('pack-blocked', {
      recipe: recipeDefinition('pack-blocked', { variables: { limit: 25 } }),
    });
    const rig = mountRoute({
      initialRecipeId: 'pack-blocked',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({ recipes: [recipe] })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [runnabilityEntry(
          'pack-blocked',
          'blocked',
          [missingPackDep('recued-core.officecli')],
        )],
      })),
      subscribe,
    });
    await rig.route.whenLoaded();

    let html = shellHtml(rig.root);
    expect(html).toContain('Cannot run. Install a Pack');
    expect(html).toContain('Install the officecli pack to make this recipe work.');
    expect(html).toContain('data-recued-pack-install-offer');
    expect(html).toContain('href="#packs/officecli"');
    expect(html).toContain('Get officecli');
    const blockedPrimary = html.match(
      /<button type="button" class="recipes-button recipes-button--primary"[\s\S]*?<\/button>/,
    )?.[0];
    const blockedOverride = html.match(
      /<button type="button" class="recipes-button"[\s\S]*?>Run with overrides<\/button>/,
    )?.[0];
    expect(blockedPrimary).toContain(' disabled');
    expect(blockedOverride).toContain(' disabled');
    expect(blockedPrimary).toContain('Install the missing Pack before you run this.');
    expect(blockedOverride).toContain('Install the missing Pack before you run this.');

    listeners.get('recipe_runnability_changed')!({
      kind: 'recipe_runnability_changed',
      recipes: [runnabilityEntry('pack-blocked', 'runnable')],
      cursor: 8,
    });

    html = shellHtml(rig.root);
    expect(html).toContain('data-recued-recipes-action="run-defaults"');
    expect(html).not.toContain('Cannot run. Install a Pack');
    expect(html).not.toContain('data-recued-pack-install-offer');
    const recoveredPrimary = html.match(
      /<button type="button" class="recipes-button recipes-button--primary"[\s\S]*?<\/button>/,
    )?.[0];
    expect(recoveredPrimary).not.toContain(' disabled');

    rig.route.dispose();
  });

  it('degrades to no pills when the runnability read fails, without a load error', async () => {
    const rig = mountRoute({
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => {
        throw new Error('not_configured');
      }),
    });
    await rig.route.whenLoaded();

    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RUNNABILITY_ATTR);
    expect(rig.route.getLoadErrors()).toEqual({});

    rig.route.dispose();
  });
});

describe('R24 — targeting guard (design § 8) — run modal warn + disable', () => {
  const targetedEntry = (): ServerRecipeListEntry =>
    recipeEntry('assess-deal-risk', {
      recipe: recipeDefinition('assess-deal-risk', {
        prefetch_steps: [
          {
            id: 'deal',
            ingredient: 'deal-reader-hubspot',
            input: { deal_id: '{{context.entity_id}}' },
          },
        ],
      }),
    });

  const mountTargeted = (execute = vi.fn<RecipeExecuteCaller>(async () => executeResponse())) =>
    ({
      execute,
      rig: mountRoute({
        recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
          recipes: [targetedEntry()],
        })),
        recipeExecuteCaller: execute,
      }),
    });

  it('confirmRun refuses to dispatch while the target is missing', async () => {
    const { rig, execute } = mountTargeted();
    await rig.route.whenLoaded();

    rig.route.openRunModal('assess-deal-risk');
    await rig.route.confirmRun();

    expect(execute).not.toHaveBeenCalled();
    expect(rig.route.runModal()?.error).toContain('needs a target record');

    rig.route.dispose();
  });

  it('filling the target enables Run and threads it as context', async () => {
    const { rig, execute } = mountTargeted();
    await rig.route.whenLoaded();

    rig.route.openRunModal('assess-deal-risk');
    rig.route.setRunTargetValue('entity_id', ' deal-42 ');

    await rig.route.confirmRun();
    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'assess-deal-risk',
      config: {},
      context: { entity_id: 'deal-42' },
    });
    expect(rig.route.runModal()?.result?.success).toBe(true);

    rig.route.dispose();
  });
});

describe('D-222 — recipe detail defaults and resolved output filters', () => {
  it('runs a defaulted-primitive-only recipe directly and keeps an override path', async () => {
    const execution = deferred<ServerExecuteResponse>();
    const execute = vi.fn<RecipeExecuteCaller>(() => execution.promise);
    const confirm = vi.fn(() => false);
    const response = executeResponse({
      recipe_id: 'primitive-defaults',
      output: { render: [], sidebar: [] },
    });
    const rig = mountRoute({
      initialRecipeId: 'primitive-defaults',
      recipeExecuteCaller: execute,
      confirm,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('primitive-defaults', {
          recipe: recipeDefinition('primitive-defaults', {
            variables: { limit: 25, include_closed: false },
          }),
        })],
      })),
    });
    await rig.route.whenLoaded();

    const detail = shellHtml(rig.root);
    expect(detail).toContain('data-recued-recipes-action="run-defaults"');
    expect(detail).toContain('Run with overrides');

    clickRecipeAction(rig.root, 'run-defaults', 'primitive-defaults');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith({ recipe_id: 'primitive-defaults', config: {} });
    const pendingButton = shellHtml(rig.root).match(
      /<button type="button" class="recipes-button recipes-button--primary"[\s\S]*?<\/button>/,
    )?.[0];
    expect(pendingButton).toContain('aria-disabled="true" aria-busy="true"');
    expect(pendingButton).not.toContain(' disabled');
    expect(pendingButton).toContain('Running…');
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'Something is still happening. Leave anyway?',
    );

    rig.route.closeDetail();
    expect(confirm).toHaveBeenCalledWith(
      'Something is still happening. Leave anyway?',
    );
    expect(rig.route.selectedRecipe()).toBe('primitive-defaults');

    clickRecipeAction(rig.root, 'run-defaults', 'primitive-defaults');
    expect(execute).toHaveBeenCalledTimes(1);

    execution.resolve(response);
    await vi.waitFor(() => expect(shellHtml(rig.root)).toContain('Run completed'));
    expect(shellHtml(rig.root)).not.toContain('aria-disabled="true" aria-busy="true"');
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();

    clickRecipeAction(rig.root, 'open-run', 'primitive-defaults');
    expect(runModalHtml(rig.root)).toContain('<summary>Run with overrides</summary>');
    expect(runModalHtml(rig.root)).toContain('data-recued-run-modal-config');

    rig.route.dispose();
  });

  it('rejects a default run result from an earlier visit to the same recipe', async () => {
    const firstExecution = deferred<ServerExecuteResponse>();
    const secondExecution = deferred<ServerExecuteResponse>();
    const execute = vi.fn<RecipeExecuteCaller>()
      .mockImplementationOnce(() => firstExecution.promise)
      .mockImplementationOnce(() => secondExecution.promise);
    const rig = mountRoute({
      initialRecipeId: 'primitive-defaults',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('primitive-defaults', {
          recipe: recipeDefinition('primitive-defaults', {
            variables: { limit: 25, include_closed: false },
          }),
        })],
      })),
    });
    await rig.route.whenLoaded();

    clickRecipeAction(rig.root, 'run-defaults', 'primitive-defaults');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    rig.route.closeDetail();
    rig.route.openRecipe('primitive-defaults');
    clickRecipeAction(rig.root, 'run-defaults', 'primitive-defaults');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    firstExecution.resolve(executeResponse({
      recipe_id: 'primitive-defaults',
      recipe_hash: 'first-visit-result',
    }));
    await vi.waitFor(() => expect(firstExecution.promise).resolves.toBeDefined());
    expect(rig.route.resultPanel()).toBeNull();
    expect(shellHtml(rig.root)).toContain('Running…');

    secondExecution.resolve(executeResponse({
      recipe_id: 'primitive-defaults',
      recipe_hash: 'current-visit-result',
    }));
    await vi.waitFor(() => expect(rig.route.resultPanel()?.result.recipe_hash)
      .toBe('current-visit-result'));
    expect(shellHtml(rig.root)).not.toContain('Running…');

    rig.route.dispose();
  });

  it('submits typed filter state with stored provenance and deterministic paging', async () => {
    const definitions: ResolvedFilterDescriptor['definitions'] = {
      status: { label: 'Status', type: 'text', default: 'open' },
      cursor: '',
      count: { label: 'Hidden count', type: 'number', default: 25 },
      enabled: { label: 'Hidden enabled', type: 'boolean', default: false },
      tags: { label: 'Hidden tags', type: 'array', default: ['a'] } as never,
      nil: { label: 'Hidden null', type: 'future_null', default: null } as never,
      opaque: { label: 'Hidden future', type: 'future_widget', default: { exact: true } } as never,
    };
    const resultFor = (
      status: string,
      cursor: string,
      paging: ResolvedFilterDescriptor['paging'],
      page: string,
    ): ServerExecuteResponse => executeResponse({
      recipe_id: 'job-board',
      recipe_hash: `execution-${page}`,
      output: {
        render: [
          {
            type: 'table',
            data: {
              columns: [{ field: 'id', label: 'ID' }],
              rows: [{ id: `${page}-row` }, { id: `${page}-row` }],
            },
          },
          {
            type: 'filter',
            data: {},
            filter: {
              section_index: 1,
              recipe_hash: 'stored-job-board-hash',
              fields: ['status'],
              hidden: ['cursor', 'count', 'enabled', 'tags', 'nil', 'opaque'],
              submit: 'Search jobs',
              definitions,
              values: {
                status,
                cursor,
                count: 25,
                enabled: false,
                tags: ['a', 'b'],
                nil: null,
                opaque: { exact: true },
              },
              ...(paging === undefined ? {} : { paging }),
            },
          },
        ],
        sidebar: [],
      },
    });
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      const config = args.config ?? {};
      if (args.invocation === undefined) {
        return resultFor('open', '', { next_cursor: 'next-token' }, 'one');
      }
      if (config.cursor === 'next-token') {
        return resultFor(String(config.status), 'next-token', { prev_cursor: 'previous-token' }, 'two');
      }
      if (config.cursor === 'previous-token') {
        return resultFor(String(config.status), 'previous-token', { next_cursor: 'next-token' }, 'one');
      }
      return resultFor(String(config.status), '', { next_cursor: 'next-token' }, 'one');
    });
    const rig = mountRoute({
      initialRecipeId: 'job-board',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('job-board', {
          recipe: recipeDefinition('job-board', {
            variables: definitions,
          }),
        })],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('job-board');
    await rig.route.confirmRun();
    const key = rig.route.resultFilterKeys()[0];
    if (key === undefined) throw new Error('filter state was not installed from result output');
    expect(key).toBe('job-board:stored-job-board-hash:1');
    expect(shellHtml(rig.root).match(/<td>one-row<\/td>/g)).toHaveLength(1);

    rig.route.setResultFilterValue(key, 'status', 'closed');
    expect(shellHtml(rig.root)).toMatch(/data-recued-recipes-result-filter-page="next" disabled/);
    await rig.route.submitResultFilter(key, 'next');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(shellHtml(rig.root)).toContain('Run Search before paging');

    await rig.route.submitResultFilter(key, 'search');
    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'job-board',
      config: {
        status: 'closed',
        cursor: '',
        count: 25,
        enabled: false,
        tags: ['a', 'b'],
        nil: null,
        opaque: { exact: true },
      },
      invocation: {
        kind: 'output.filter',
        recipe_hash: 'stored-job-board-hash',
        section_index: 1,
      },
    });
    expect(shellHtml(rig.root)).toContain('value="closed"');

    const searchKey = rig.route.resultFilterKeys()[0]!;
    await rig.route.submitResultFilter(searchKey, 'next');
    expect(execute).toHaveBeenNthCalledWith(3, {
      recipe_id: 'job-board',
      config: {
        status: 'closed',
        cursor: 'next-token',
        count: 25,
        enabled: false,
        tags: ['a', 'b'],
        nil: null,
        opaque: { exact: true },
      },
      invocation: {
        kind: 'output.filter',
        recipe_hash: 'stored-job-board-hash',
        section_index: 1,
      },
    });
    expect(shellHtml(rig.root).match(/<td>two-row<\/td>/g)).toHaveLength(1);
    expect(rig.route.resultPanel()?.origin).toBe('result-filter');

    const pageTwoKey = rig.route.resultFilterKeys()[0]!;
    await rig.route.submitResultFilter(pageTwoKey, 'previous');
    expect(execute).toHaveBeenNthCalledWith(4, expect.objectContaining({
      config: expect.objectContaining({ status: 'closed', cursor: 'previous-token' }),
    }));
    expect(shellHtml(rig.root).match(/<td>one-row<\/td>/g)).toHaveLength(1);

    rig.route.dispose();
  });

  it('keeps a pending result page owned through detail navigation', async () => {
    const result = executeResponse({
      recipe_id: 'job-board',
      output: { render: [{
        type: 'filter',
        data: {},
        filter: {
          section_index: 0,
          recipe_hash: 'stored-job-board-hash',
          fields: ['status'],
          hidden: ['cursor'],
          submit: 'Search jobs',
          definitions: {
            status: { label: 'Status', type: 'text', default: 'open' },
            cursor: '',
          },
          values: { status: 'open', cursor: '' },
          paging: { next_cursor: 'next-token' },
        },
      }], sidebar: [] },
    });
    const paged = deferred<ServerExecuteResponse>();
    const execute = vi.fn<RecipeExecuteCaller>()
      .mockResolvedValueOnce(result)
      .mockImplementationOnce(() => paged.promise);
    const confirm = vi.fn(() => false);
    const rig = mountRoute({
      initialRecipeId: 'job-board',
      recipeExecuteCaller: execute,
      confirm,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('job-board', {
          recipe: recipeDefinition('job-board', {
            variables: {
              status: { label: 'Status', type: 'text', default: 'open' } as never,
              cursor: '',
            },
          }),
        })],
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('job-board');
    await rig.route.confirmRun();

    const page = rig.route.submitResultFilter(
      rig.route.resultFilterKeys()[0]!,
      'next',
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(shellHtml(rig.root)).toContain('Loading next page…');
    expect(shellHtml(rig.root)).toMatch(
      /result-filter-page:next[^>]*aria-disabled="true" aria-busy="true"/,
    );
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'Something is still happening. Leave anyway?',
    );

    rig.route.closeDetail();
    expect(confirm).toHaveBeenCalledWith(
      'Something is still happening. Leave anyway?',
    );
    expect(rig.route.selectedRecipe()).toBe('job-board');

    paged.resolve(result);
    await page;
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();
  });
});

describe('a run that refused items says so', () => {
  // ⛔⛔ A `foreach` is continue-on-error, so refused items never reach
  // `errors[]` and never make `success` false. Before this, a month that wrote
  // NO receipts rendered exactly like one that wrote them all — which is how
  // three defects shipped in one pack at `success: true`.
  const RESULT = (foreach: { items: number; failed: number } | undefined) => ({
    recipe_id: 'collect', recipe_hash: 'h', success: true, errors: [],
    steps: [{ id: 'recorded', type: 'ingredient', skipped: false, duration_ms: 1,
              error: null, ...(foreach === undefined ? {} : { foreach }) }],
    output: { render: [] },
  });
  const mount = (result: unknown) => mountRoute({
    initialRecipeId: 'collect',
    recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => result as never),
    recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
      recipes: [recipeEntry('collect', { recipe: recipeDefinition('collect') })],
    })),
  });
  const drive = async (result: unknown) => {
    const rig = mount(result);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();
    return shellHtml(rig.root);
  };

  it('reports how many items were refused, and in which step', async () => {
    const html = await drive(RESULT({ items: 12, failed: 3 }));
    expect(html).toContain('data-recued-recipes-result-refused="3"');
    expect(html).toContain('3 of 12 items');
    expect(html).toContain('recorded');
  });

  it('says plainly when EVERY item was refused', async () => {
    // The remedy differs from a partial failure — a broken recipe refuses
    // everything, bad data refuses one — so the owner needs the distinction.
    const html = await drive(RESULT({ items: 2, failed: 2 }));
    expect(html).toContain('were all refused');
  });

  it('stays SILENT on a clean run and on a run with no foreach at all', async () => {
    // ⛔ An alert on every successful loop would be trained away in a week, and
    // then the one that mattered would be invisible too.
    for (const result of [RESULT({ items: 5, failed: 0 }), RESULT(undefined)]) {
      const html = await drive(result);
      expect(html, JSON.stringify(result).slice(0, 60))
        .not.toContain('data-recued-recipes-result-refused');
    }
  });
});

describe('a filter cannot silently discard typed grid rows', () => {
  // ⛔⛔ The hazard is CROSS-SECTION: the filter is what re-runs, the table is
  // what loses. Searching or paging produces a new result, and a new result
  // RESETS every grid — so a sheet of typed amounts vanished with no warning and
  // no undo. The filter already protected its own three fields from exactly
  // this; the grid's loss is far larger and had no guard at all.
  const BOTH = () => executeResponse({
    recipe_id: 'collect',
    recipe_hash: 'h',
    output: {
      render: [
        {
          type: 'filter',
          data: {},
          filter: {
            section_index: 0, recipe_hash: 'h', submit: 'Search',
            fields: ['status'], hidden: ['cursor'],
            definitions: { status: { label: 'Status', type: 'text', default: '' }, cursor: '' },
            values: { status: '', cursor: '' },
            paging: { next_cursor: 'PAGE2' },
          },
        },
        {
          type: 'table',
          data: { rows: [{ contract_ref: 'rental_contract/rec_1', amount: '' }] },
          record_columns: {
            entity: 'receipt',
            columns: [
              { field: 'contract_ref', label: 'Tenancy', kind: 'string' },
              { field: 'amount', label: 'Amount', kind: 'decimal' },
            ],
          },
          table_edit: {
            section_index: 1, recipe_hash: 'h', into: 'payments',
            submit: 'Save what arrived', rows: 'fixed',
            editable: ['amount'], carry: ['contract_ref'], hidden: {},
          },
        },
      ],
    },
  } as never);

  const drive = async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () => BOTH() as never);
    const rig = mountRoute({
      initialRecipeId: 'collect',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('collect', {
            recipe: recipeDefinition('collect', {
              variables: {
                payments: { label: 'Payments', type: 'array', default: [] } as never,
                status: { label: 'Status', type: 'text', default: '' } as never,
                cursor: { label: 'Cursor', type: 'text', default: '' } as never,
              },
            }),
          }),
          recipeEntry('elsewhere', { recipe: recipeDefinition('elsewhere') }),
        ],
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();
    return { rig, execute };
  };

  it('leaves Search and paging usable while the grid is untouched', async () => {
    // ⛔ The isolating half. Without it, a guard that disabled the buttons
    // ALWAYS would pass every assertion below.
    const { rig } = await drive();
    const html = shellHtml(rig.root);
    expect(html).not.toContain('data-recued-recipes-result-filter-blocked');
    expect(html).toContain('result-filter-page:next');
    expect(html).not.toMatch(/result-filter-search[^>]*disabled/);
  });

  it('disables Search and paging, and says why, once a row is typed', async () => {
    const { rig } = await drive();
    const key = rig.route.resultGridKeys()[0]!;
    rig.route.setResultGridCell(key, 0, 'amount', '800.00');
    const html = shellHtml(rig.root);
    expect(html).toContain('data-recued-recipes-result-filter-blocked');
    expect(html).toContain('would discard what you have typed');
    expect(html).toMatch(/result-filter-search[^>]*disabled/);
    expect(html).toMatch(/result-filter-page:next[^>]*disabled/);
  });

  it('REFUSES the dispatch, not just the button', async () => {
    // ⛔ A disabled button is presentation. A host that draws its own Search
    // control must hit the same wall — the refusal has to be where the change
    // happens, which is the only place that can actually stop it.
    const { rig, execute } = await drive();
    const key = rig.route.resultGridKeys()[0]!;
    rig.route.setResultGridCell(key, 0, 'amount', '800.00');
    const before = execute.mock.calls.length;
    await rig.route.submitResultFilter(rig.route.resultFilterKeys()[0]!, 'next');
    expect(execute.mock.calls.length, 'the re-run never dispatched').toBe(before);
    expect(shellHtml(rig.root)).toContain('would discard what you have typed');
  });

  it('lets the owner page again once the rows are SAVED', async () => {
    // ⛔ The recovery path. A guard with no way out is a trap: the owner would
    // be unable to page for the rest of the session without re-running the
    // recipe from scratch and losing the rows anyway.
    const { rig, execute } = await drive();
    const key = rig.route.resultGridKeys()[0]!;
    rig.route.setResultGridCell(key, 0, 'amount', '800.00');
    await rig.route.submitResultGrid(key);

    const html = shellHtml(rig.root);
    expect(html).not.toContain('data-recued-recipes-result-filter-blocked');
    const before = execute.mock.calls.length;
    await rig.route.submitResultFilter(rig.route.resultFilterKeys()[0]!, 'next');
    expect(execute.mock.calls.length, 'paging dispatched again').toBe(before + 1);
  });
});

describe('the editable grid in the result panel', () => {
  const GRID_RESULT = (rows: Array<Record<string, string>>) => ({
    recipe_id: 'collect', recipe_hash: 'stored-collect-hash', success: true,
    steps: [], errors: [],
    output: {
      render: [{
        type: 'table',
        data: { rows },
        record_columns: {
          entity: 'receipt',
          columns: [
            { field: 'contract_ref', label: 'Tenancy', kind: 'string' },
            { field: 'amount', label: 'Amount', kind: 'decimal' },
          ],
        },
        table_edit: {
          section_index: 0, recipe_hash: 'stored-collect-hash',
          into: 'payments', submit: 'Save what arrived',
          rows: 'fixed', editable: ['amount'], carry: ['contract_ref'], hidden: {},
        },
      }],
    },
  });

  const mountGrid = (
    execute: RecipeExecuteCaller,
    confirm?: (message?: string) => boolean,
  ) => mountRoute({
    initialRecipeId: 'collect',
    recipeExecuteCaller: execute,
    ...(confirm !== undefined ? { confirm } : {}),
    recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
      recipes: [recipeEntry('collect', {
        recipe: recipeDefinition('collect', {
          variables: { payments: { label: 'Payments', type: 'array', default: [] } as never },
        }),
      })],
    })),
  });

  it('types only the columns the section says are editable', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    // ⛔ The amount is an input; the tenancy is TEXT. A typeable tenancy would
    // let a payment be re-pointed at another tenant by editing its row.
    expect(html).toContain('data-recued-recipes-result-grid-cell="0:amount"');
    expect(html).not.toContain('grid-cell="0:contract_ref"');
    expect(html).toContain('rental_contract/rec_1');
    // …and the save button carries the authored label.
    expect(html).toContain('Save what arrived');
    // A review is not a write. Saving wakes up only after a real edit, so an
    // accidental click cannot dispatch a redundant correction run.
    expect(html).toContain('1 row · No changes yet');
    expect(html).toMatch(/result-grid-submit[^>]*disabled/);
    // A fixed grid offers no add-row control.
    expect(html).not.toContain('result-grid-add');
  });

  it('enables Save and marks the sheet unsaved after the first edit', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const key = rig.route.resultGridKeys()[0]!;
    rig.route.setResultGridCell(key, 0, 'amount', '800.00');
    const html = shellHtml(rig.root);
    expect(html).toContain('1 row · Unsaved changes');
    expect(html).toContain('data-dirty="true"');
    expect(html).not.toMatch(/result-grid-submit[^>]*disabled/);
  });

  it('keeps dirty rows and their save owned through detail navigation', async () => {
    const saved = deferred<ServerExecuteResponse>();
    const execute = vi.fn<RecipeExecuteCaller>()
      .mockResolvedValueOnce(
        GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never,
      )
      .mockImplementationOnce(() => saved.promise);
    const confirm = vi.fn(() => false);
    const rig = mountGrid(execute, confirm);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const key = rig.route.resultGridKeys()[0]!;
    rig.route.setResultGridCell(key, 0, 'amount', '800.00');
    expect(rig.route.hasUnsavedChanges()).toBe(true);
    expect(rig.route.unsavedChangesPrompt()).toBe(
      'You have changes you have not saved. Leave anyway?',
    );

    rig.route.closeDetail();
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'You have changes you have not saved. Leave anyway?',
    );
    expect(rig.route.selectedRecipe()).toBe('collect');

    const save = rig.route.submitResultGrid(key);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'Something is still happening. Leave anyway?',
    );
    expect(rig.route.hasUnsavedChanges()).toBe(true);

    rig.route.closeDetail();
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Something is still happening. Leave anyway?',
    );
    expect(rig.route.selectedRecipe()).toBe('collect');

    saved.resolve(
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '800.00' }]) as never,
    );
    await save;
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();
    expect(rig.route.hasUnsavedChanges()).toBe(false);
    expect(rig.route.unsavedChangesPrompt()).toBeNull();
  });

  it('refuses an untouched submit at the dispatch seam too', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    await rig.route.submitResultGrid(rig.route.resultGridKeys()[0]!);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('submits ONE key — the declared variable — with the section proof', async () => {
    // ⛔⛔ This assertion USED to read `payments: [{ amount: '800.00' }]`, and
    // passed: the grid submitted the editable set alone, so the row could not
    // say WHICH tenancy the money was for. Live, every receipt was then written
    // against nothing, the store refused each one inside a `foreach` — where a
    // per-item failure never fails the run — and the month reported success
    // having collected no rent. The carried identity is the fix, and this is
    // where it is pinned.
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const key = rig.route.resultGridKeys()[0];
    if (key === undefined) throw new Error('no editable grid was installed from result output');
    rig.route.setResultGridCell(key, 0, 'amount', '800.00');
    await rig.route.submitResultGrid(key);

    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'collect',
      config: { payments: [{ contract_ref: 'rental_contract/rec_1', amount: '800.00' }] },
      invocation: {
        kind: 'output.table_edit',
        recipe_hash: 'stored-collect-hash',
        section_index: 0,
      },
    });
  });

  it('right-aligns the quantity columns — header, cell and input', async () => {
    // ⛔ From the declared KIND. Money in a Records pack is a `decimal` slot
    // returned as the STRING "1200.0000", so aligning on the runtime value
    // would left-align every amount in the ledger.
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toMatch(/<th class="is-numeric">Amount<\/th>/);
    expect(html).toMatch(/<th>Tenancy<\/th>/);
    // …and the editable cell too, so a figure does not jump left as it is typed.
    expect(html).toMatch(/class="input recipes-result-grid-cell is-numeric"/);
  });

  it('keeps a typed cell across a re-render before the save', async () => {
    // ⛔ The value comes from the GRID state, not the row — otherwise a repaint
    // between typing and saving silently discards what was entered.
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      GRID_RESULT([{ contract_ref: 'rental_contract/rec_1', amount: '' }]) as never);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const key = rig.route.resultGridKeys()[0]!;
    rig.route.setResultGridCell(key, 0, 'amount', '450.00');
    expect(shellHtml(rig.root)).toContain('value="450.00"');
  });

  it('composes an initially empty bare table, renders added rows, and removes back to clean', async () => {
    // No entity and no `to_table` headings: the descriptor's declared columns
    // are enough to render a reusable empty collection form.
    const composeResult = {
      recipe_id: 'collect', recipe_hash: 'stored-collect-hash', success: true,
      steps: [], errors: [],
      output: {
        render: [{
          type: 'table',
          data: [],
          table_edit: {
            section_index: 0, recipe_hash: 'stored-collect-hash',
            into: 'payments', submit: 'Save lines', rows: 'add_remove',
            editable: ['description', 'quantity'], carry: [], hidden: {},
          },
        }],
      },
    } as never;
    const execute = vi.fn<RecipeExecuteCaller>(async () => composeResult);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const key = rig.route.resultGridKeys()[0]!;
    let html = shellHtml(rig.root);
    expect(html).toContain('<th>Description</th>');
    expect(html).toContain('<th>Quantity</th>');
    expect(html).toContain('No rows yet. Add a row to get started.');
    expect(html).toContain('result-grid-add');

    rig.route.addResultGridRow(key);
    html = shellHtml(rig.root);
    expect(html).toContain('data-recued-recipes-result-grid-cell="0:description"');
    expect(html).toContain('data-recued-recipes-action="result-grid-remove"');
    expect(html).toContain('1 row · Unsaved changes');

    rig.route.removeResultGridRow(key, 0);
    html = shellHtml(rig.root);
    expect(html).toContain('0 rows · No changes yet');
    expect(html).toMatch(/result-grid-submit[^>]*disabled/);
  });

  it('submits rows composed through add/remove mode with the shared invocation proof', async () => {
    const initial = {
      recipe_id: 'collect', recipe_hash: 'stored-collect-hash', success: true,
      steps: [], errors: [],
      output: { render: [{
        type: 'table', data: [],
        table_edit: {
          section_index: 0, recipe_hash: 'stored-collect-hash',
          into: 'payments', submit: 'Save lines', rows: 'add_remove',
          editable: ['description', 'quantity'], carry: [], hidden: { period: '2026-07' },
        },
      }] },
    } as never;
    const execute = vi.fn<RecipeExecuteCaller>(async () => initial);
    const rig = mountGrid(execute);
    await rig.route.whenLoaded();
    rig.route.openRunModal('collect');
    await rig.route.confirmRun();

    const key = rig.route.resultGridKeys()[0]!;
    rig.route.addResultGridRow(key);
    rig.route.setResultGridCell(key, 0, 'description', 'Labour');
    rig.route.setResultGridCell(key, 0, 'quantity', '2');
    await rig.route.submitResultGrid(key);

    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'collect',
      config: {
        period: '2026-07',
        payments: [{ description: 'Labour', quantity: '2' }],
      },
      invocation: {
        kind: 'output.table_edit',
        recipe_hash: 'stored-collect-hash',
        section_index: 0,
      },
    });
  });
});
