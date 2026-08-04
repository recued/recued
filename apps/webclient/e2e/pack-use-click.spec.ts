/** ⛔ Pack Use — does pressing an operation button actually open a run?
 *
 *  Reported from a live drive: `#packs/<slug>` → Use → "Get work done" renders
 *  its task buttons and none of them respond. The unit suite already asserts
 *  this exact press calls `openRunModal`, and it passes — against a HAND-ROLLED
 *  fake DOM. Every defect this surface has produced has been found by a real
 *  browser and none by that suite, so this spec puts a real one on the press.
 *
 *  It boots the same `bootstrapPacksRoute` the app boots, with a pack whose
 *  recipe is installed and visible, and clicks the rendered button. */

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

const PACK_SLUG = 'use-click-pack';
const RECIPE_ID = 'post-entry';
const PACK_DETAIL = 'data-recued-packs-surface-detail';
const OPERATION = 'data-recued-pack-app-operation';
const TAB_PANEL = 'data-recued-packs-detail-tab-panel';

const rigEntry = `
import { bootstrapPacksRoute } from './apps/webclient/src/packs/bootstrap-packs-route.ts';
import { RunModal } from './packages/ui-shared/src/index.ts';
const { wireRunModal } = RunModal;

const manifest = {
  manifest_version: 1,
  slug: '${PACK_SLUG}',
  publisher: 'recued-core',
  name: 'Use Click Pack',
  description: 'One visible task.',
  version: 1,
  recipes: [{ slug: '${RECIPE_ID}', version: 1 }],
  contents: [{ type: 'recipe', slug: '${RECIPE_ID}', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['workflow'],
  service_kind: 'workflow',
};
const pack = {
  slug: manifest.slug,
  publisher: manifest.publisher,
  name: manifest.name,
  description: manifest.description,
  version: manifest.version,
  pre_install: false,
  installed: true,
  installed_any_version: true,
  requires: [...manifest.requires],
  recipe_count: 1,
  recipe_refs: [{ slug: '${RECIPE_ID}', version: 1 }],
  body_visibility_grant_keys: [],
  body_visibility_grant_count: 0,
  manifest,
};
const recipeEntry = {
  recipe_id: '${RECIPE_ID}',
  version: 1,
  publisher_id: 'recued-core',
  pack_slug: manifest.slug,
  recipe: {
    recipe_id: '${RECIPE_ID}',
    metadata: { name: 'Post entry', description: 'Record both sides.' },
    steps: [],
    variables: {},
  },
};

globalThis.__useClickRig = { openCalls: [] };

const route = bootstrapPacksRoute({
  root: document.querySelector('#root'),
  document,
  initialPackSlug: manifest.slug,
  packsListCaller: async () => ({
    packs: [pack],
    installed_versions: [{ slug: pack.slug, version: pack.version }],
  }),
  recipesListCaller: async () => ({ recipes: [recipeEntry] }),
  // ⚠ The REAL host behaviour, not a recorder. The first version of this spec
  // stubbed this callback and passed against the very build whose host never
  // attached its overlay — the press was fine, the modal was built into nothing.
  // A stub here tests the click and nothing else.
  openRunModal: (entry) => {
    globalThis.__useClickRig.openCalls.push(entry.recipe_id);
    const handle = wireRunModal({ recipe: entry, document, initialTab: 'run',
      execute: async () => ({ success: true, errors: [], output: { render: [] } }) });
    document.body.appendChild(handle.element);
  },
});
`;

let rigScript = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: rigEntry,
      loader: 'ts',
      resolveDir: process.cwd(),
      sourcefile: 'pack-use-click-rig.ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  rigScript = result.outputFiles[0]!.text;
});

test('⛔ pressing a Use operation opens its run', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.setContent(`<!doctype html><html><head><style>
    :root { --fg:#222; --fg-muted:#667; --fg-subtle:#889; --surface:#fff;
      --surface-subtle:#f6f7f8; --surface-sunk:#f1f3f5; --border:#ccd2d8;
      --border-strong:#9aa5af; --accent:#276ef1; --accent-weak:#dce7ff;
      --danger:#b42318; --muted:#667; }
    body { margin:0; font-family: system-ui, sans-serif; }
    #root { height: 640px; overflow: auto; }
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: rigScript });

  await expect(page.locator(`[${PACK_DETAIL}]`)).toBeVisible();
  // Land on the Use tab — it is the pack's default when it has one.
  const usePanel = page.locator(`[${TAB_PANEL}="use"]`);
  await expect(usePanel).toBeVisible();

  const button = page.locator(`[${OPERATION}="${RECIPE_ID}"]`);
  await expect(button).toBeVisible();

  // ⛔ The whole point: a REAL click, with real hit-testing. Playwright fails
  // here if the element is covered, zero-size or pointer-events:none — each of
  // which a fake DOM dispatching straight at the node cannot see.
  await button.click();

  const opened = await page.evaluate(
    () => (globalThis as unknown as { __useClickRig: { openCalls: string[] } })
      .__useClickRig.openCalls,
  );
  expect({ opened, consoleErrors }).toEqual({ opened: [RECIPE_ID], consoleErrors: [] });

  // ⛔ The assertion the stubbed version could not make: the overlay reached the
  // DOCUMENT. A host that builds a modal and never appends it satisfies every
  // check above and shows the user nothing — which is exactly what shipped.
  //
  // `toBeAttached`, not `toBeVisible`: this rig renders on a bare page without
  // the app shell's layout, so paint geometry is not what it proves. Presence
  // under `document.body` is.
  const overlay = page.locator('body > .run-modal-overlay-root');
  await expect(overlay).toBeAttached();
});
