import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

const PACK_SLUG = 'mail-tools';
const PACK_CARD = 'data-recued-discover-card';
const PACK_SEARCH = 'data-recued-discover-search';
const PACK_LIST = 'data-recued-packs-surface-list';
const PACK_DETAIL = 'data-recued-packs-surface-detail';
const PACK_BACK = 'data-recued-packs-detail-back';
const PACK_DELETE = 'data-recued-packs-row-delete';
const PACK_DELETE_CONFIRM = 'data-recued-packs-row-delete-confirm';
const PACK_DELETE_CANCEL = 'data-recued-packs-row-delete-cancel';
const PACK_INSTALL = 'data-recued-packs-row-install';
const PACK_DIALOG = 'data-recued-packs-dialog';
const PACK_DIALOG_INSTALL = 'data-recued-packs-dialog-install';
const PACK_DIALOG_CANCEL = 'data-recued-packs-dialog-cancel';
const PACK_DIALOG_PERMISSION = 'data-recued-packs-dialog-permission';

const rigEntry = `
import { bootstrapPacksRoute } from './apps/webclient/src/packs/bootstrap-packs-route.ts';

const manifest = {
  manifest_version: 1,
  slug: '${PACK_SLUG}',
  publisher: 'recued-core',
  name: 'Mail Tools',
  description: 'Daily mail workflows.',
  version: 1,
  recipes: [{ slug: 'mail-digest', version: 1 }],
  requires: ['install_bulk_pack', 'read_mail'],
  tags: ['mail', 'workflow'],
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
  recipe_count: manifest.recipes.length,
  body_visibility_grant_count: 0,
  manifest,
};
let finishRecipes;
const listeners = new Map();
const subscribe = (kind, listener) => {
  const current = listeners.get(kind) ?? new Set();
  current.add(listener);
  listeners.set(kind, current);
  return () => current.delete(listener);
};
const recipes = new Promise((resolve) => {
  finishRecipes = () => resolve({ recipes: [] });
});
let installed = true;
let installCalls = 0;
let finishInstall;
let failInstall;
const install = new Promise((resolve) => {
  finishInstall = () => {
    installed = true;
    resolve({
      result: { ok: true, installed: [], rolled_back: [] },
    });
  };
  failInstall = () => resolve({
    result: {
      ok: false,
      installed: [],
      rolled_back: [],
      failure: { code: 'permission_denied', message: 'Permission missing.' },
    },
  });
});
let uninstallCalls = 0;
let finishUninstall;
let failUninstall;
const uninstall = new Promise((resolve) => {
  finishUninstall = () => {
    installed = false;
    resolve({
      result: {
        ok: true,
        removed: { recipes: [], standing_instructions: 0, body_grants: [] },
      },
    });
  };
  failUninstall = () => resolve({
    result: {
      ok: false,
      removed: { recipes: [], standing_instructions: 0, body_grants: [] },
      failure: { code: 'not_found', message: 'Pack disappeared.' },
    },
  });
});

let route;
const mountRoute = (initialPackSlug) => bootstrapPacksRoute({
  root: document.querySelector('#root'),
  document,
  packsListCaller: async () => ({
    packs: [{
      ...pack,
      installed,
      installed_any_version: installed,
    }],
    installed_versions: installed
      ? [{ slug: pack.slug, version: pack.version }]
      : [],
  }),
  packsInstallCaller: () => {
    installCalls += 1;
    return install;
  },
  packsUninstallCaller: () => {
    uninstallCalls += 1;
    return uninstall;
  },
  recipesListCaller: () => recipes,
  subscribe,
  ...(initialPackSlug === undefined ? {} : { initialPackSlug }),
});
globalThis.__packsFocusRig = {
  finishRecipes: () => finishRecipes(),
  finishInstall: () => finishInstall(),
  failInstall: () => failInstall(),
  getInstallCalls: () => installCalls,
  finishUninstall: () => finishUninstall(),
  failUninstall: () => failUninstall(),
  getUninstallCalls: () => uninstallCalls,
  showUninstalled: () => {
    installed = false;
    for (const listener of listeners.get('pack_uninstalled') ?? []) {
      listener({ kind: 'pack_uninstalled' });
    }
  },
  firePackChanged: () => {
    for (const listener of listeners.get('pack_installed') ?? []) {
      listener({ kind: 'pack_installed' });
    }
  },
  remountDeepLink: () => {
    route.dispose();
    route = mountRoute('${PACK_SLUG}');
  },
};
route = mountRoute();
`;

let rigScript = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: rigEntry,
      loader: 'ts',
      resolveDir: process.cwd(),
      sourcefile: 'packs-focus-rig.ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  rigScript = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>
          :root {
            --fg: #222;
            --fg-muted: #667;
            --fg-subtle: #889;
            --surface: #fff;
            --surface-subtle: #f6f7f8;
            --surface-sunk: #f1f3f5;
            --border: #ccd2d8;
            --border-strong: #9aa5af;
            --accent: #276ef1;
            --accent-weak: #dce7ff;
            --danger: #b42318;
            --muted: #667;
          }
          body { margin: 0; font-family: system-ui, sans-serif; }
          #root { height: 420px; overflow: auto; }
        </style>
      </head>
      <body><div id="root"></div></body>
    </html>`);
  await page.evaluate((slug) => {
    const row = {
      slug,
      publisher_id: 'recued-core',
      name: 'Mail Tools',
      description: 'Daily mail workflows.',
      version: 1,
      pack_kind: 'capability',
      service_kind: 'workflow',
      tags: ['mail', 'workflow'],
      download_count: 42,
      item_count: 1,
      recipe_refs: [{ slug: 'mail-digest', version: 1 }],
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const secondRow = {
      ...row,
      slug: 'calendar-tools',
      name: 'Calendar Tools',
      description: 'Daily calendar workflows.',
      download_count: 21,
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/catalog/search')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        return new Response(JSON.stringify({
          rows: page === 2 ? [secondRow] : [row],
          total: 2,
          totalPages: 2,
          page,
          facets: {
            service_kind: [{ value: 'workflow', count: 1 }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/catalog/versions')) {
        return new Response(JSON.stringify({ versions: { [slug]: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/catalog/packs.json')) {
        return new Response(JSON.stringify([row]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected packs rig fetch: ${url}`);
    };
  }, PACK_SLUG);
  await page.addScriptTag({ content: rigScript });
});

test('Packs never paints a stale search response beneath a newer query', async ({ page }) => {
  await expect(page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`)).toBeVisible();
  await page.evaluate(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const state = {
      firstStarted: false,
      secondStarted: false,
      releaseFirst: () => {},
      releaseSecond: () => {},
    };
    const row = (slug: string, name: string) => ({
      slug,
      publisher_id: 'recued-core',
      name,
      description: `${name} description.`,
      version: 1,
      pack_kind: 'capability',
      service_kind: 'workflow',
      tags: ['workflow'],
      download_count: 1,
      item_count: 1,
      recipe_refs: [],
      created_at: '2026-01-01T00:00:00.000Z',
    });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/catalog/search')) {
        const query = url.searchParams.get('q');
        if (query === 'first') {
          state.firstStarted = true;
          await new Promise<void>((resolve) => { state.releaseFirst = resolve; });
          return new Response(JSON.stringify({
            rows: [row('first-result', 'First Result')],
            total: 1,
            totalPages: 1,
            page: 1,
            facets: {},
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (query === 'second') {
          state.secondStarted = true;
          await new Promise<void>((resolve) => { state.releaseSecond = resolve; });
          return new Response(JSON.stringify({
            rows: [row('second-result', 'Second Result')],
            total: 1,
            totalPages: 1,
            page: 1,
            facets: {},
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
      return originalFetch(input, init);
    };
    (globalThis as typeof globalThis & { __packsSearchFreshnessRig?: typeof state })
      .__packsSearchFreshnessRig = state;
  });

  const search = page.locator(`[${PACK_SEARCH}]`);
  await search.fill('first');
  await page.waitForFunction(() => (
    globalThis as typeof globalThis & {
      __packsSearchFreshnessRig?: { firstStarted: boolean };
    }
  ).__packsSearchFreshnessRig?.firstStarted === true);

  await search.fill('second');
  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __packsSearchFreshnessRig?: { releaseFirst(): void };
    }
  ).__packsSearchFreshnessRig?.releaseFirst());
  await page.waitForFunction(() => (
    globalThis as typeof globalThis & {
      __packsSearchFreshnessRig?: { secondStarted: boolean };
    }
  ).__packsSearchFreshnessRig?.secondStarted === true);

  await expect(page.getByText('First Result', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __packsSearchFreshnessRig?: { releaseSecond(): void };
    }
  ).__packsSearchFreshnessRig?.releaseSecond());
  await expect(page.getByText('Second Result', { exact: true })).toBeVisible();
  await expect(page.getByText('First Result', { exact: true })).toHaveCount(0);
});

test('Packs moves focus into detail, preserves it through hydration, and restores the card', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await expect(card).toBeVisible();
  await card.focus();
  await page.keyboard.press('Enter');

  const list = page.locator(`[${PACK_LIST}]`);
  const detail = page.locator(`[${PACK_DETAIL}]`);
  const back = page.locator(`[${PACK_BACK}]`);
  await expect(list).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(back).toBeFocused();

  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { finishRecipes(): void };
    }).__packsFocusRig.finishRecipes();
  });
  await expect(back).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  await expect(card).toBeFocused();
});

test('Packs starts detail at the top and restores the exact browse scroll position', async ({ page }) => {
  const root = page.locator('#root');
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await expect(card).toBeVisible();
  await card.evaluate((element) => {
    element.style.marginTop = '960px';
    element.style.marginBottom = '480px';
    element.scrollIntoView({ block: 'center' });
  });
  const browseScroll = await root.evaluate((element) => element.scrollTop);
  expect(browseScroll).toBeGreaterThan(0);

  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${PACK_BACK}]`)).toBeFocused();
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBe(0);

  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBe(browseScroll);
});

test('Packs preserves the focused card through a live catalog repaint', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await expect(card).toBeVisible();
  await card.focus();
  await card.evaluate((element) => element.setAttribute('data-before-refresh', ''));

  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { firePackChanged(): void };
    }).__packsFocusRig.firePackChanged();
  });

  await expect(card).not.toHaveAttribute('data-before-refresh', '');
  await expect(card).toBeFocused();
});

test('Packs keeps keyboard ownership when paging reaches the final page', async ({ page }) => {
  const next = page.getByRole('button', { name: 'Next ›' });
  await expect(next).toBeVisible();
  await next.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(page.getByRole('button', { name: '‹ Prev' })).toBeFocused();
  await expect(page.locator(`[${PACK_CARD}][data-id="calendar-tools"]`)).toBeVisible();
});

test('Packs restores the selected card after the hidden browse list refreshes', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await expect(card).toBeVisible();
  await card.focus();
  await card.evaluate((element) => element.setAttribute('data-before-hidden-refresh', ''));
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${PACK_BACK}]`)).toBeFocused();

  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { firePackChanged(): void };
    }).__packsFocusRig.firePackChanged();
  });
  await expect(card).not.toHaveAttribute('data-before-hidden-refresh', '');

  const back = page.locator(`[${PACK_BACK}]`);
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();
});

test('Packs moves focus into a directly mounted pack detail', async ({ page }) => {
  await page.evaluate(() => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside Packs';
    document.body.appendChild(outside);
    outside.focus();
    (globalThis as typeof globalThis & {
      __packsFocusRig: { remountDeepLink(): void };
    }).__packsFocusRig.remountDeepLink();
  });

  await expect(page.locator(`[${PACK_LIST}]`)).toBeHidden();
  await expect(page.locator(`[${PACK_DETAIL}]`)).toBeVisible();
  await expect(page.locator(`[${PACK_BACK}]`)).toBeFocused();
});

test('Packs detail tabs form one arrow-key keyboard stop', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { finishRecipes(): void };
    }).__packsFocusRig.finishRecipes();
  });

  const detail = page.getByRole('tab', { name: 'Detail', exact: true });
  const permissions = page.getByRole('tab', { name: 'Permissions', exact: true });
  const access = page.getByRole('tab', { name: 'Access', exact: true });
  await expect(detail).toHaveAttribute('aria-selected', 'true');
  await expect(detail).toHaveAttribute('tabindex', '0');
  await expect(permissions).toHaveAttribute('tabindex', '-1');
  await expect(access).toHaveAttribute('tabindex', '-1');

  await detail.focus();
  await page.keyboard.press('ArrowRight');
  await expect(permissions).toHaveAttribute('aria-selected', 'true');
  await expect(permissions).toBeFocused();
  await page.keyboard.press('End');
  await expect(access).toHaveAttribute('aria-selected', 'true');
  await expect(access).toBeFocused();
  await page.keyboard.press('Home');
  await expect(detail).toHaveAttribute('aria-selected', 'true');
  await expect(detail).toBeFocused();
});

test('Packs transfers focus through Delete reveal and Cancel', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');

  const deleteButton = page.locator(`[${PACK_DELETE}="${PACK_SLUG}"]`);
  await deleteButton.focus();
  await page.keyboard.press('Enter');

  const confirmButton = page.locator(
    `[${PACK_DELETE_CONFIRM}="${PACK_SLUG}"]`,
  );
  await expect(confirmButton).toBeFocused();

  const cancelButton = page.locator(
    `[${PACK_DELETE_CANCEL}="${PACK_SLUG}"]`,
  );
  await cancelButton.focus();
  await page.keyboard.press('Enter');
  await expect(deleteButton).toBeFocused();
});

test('Packs keeps Confirm focused while deleting and lands on Install', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');

  await page.locator(`[${PACK_DELETE}="${PACK_SLUG}"]`).click();
  const confirmButton = page.locator(
    `[${PACK_DELETE_CONFIRM}="${PACK_SLUG}"]`,
  );
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(confirmButton).toHaveText('Deleting…');
  await expect(confirmButton).toHaveAttribute('aria-disabled', 'true');
  await expect(confirmButton).toHaveAttribute('aria-busy', 'true');
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __packsFocusRig: { getUninstallCalls(): number };
    }
  ).__packsFocusRig.getUninstallCalls())).toBe(1);

  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { finishUninstall(): void };
    }).__packsFocusRig.finishUninstall();
  });
  await expect(page.locator(`[${PACK_INSTALL}="${PACK_SLUG}"]`)).toBeFocused();
});

test('Packs restores Confirm focus when deleting fails', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');

  await page.locator(`[${PACK_DELETE}="${PACK_SLUG}"]`).click();
  const confirmButton = page.locator(
    `[${PACK_DELETE_CONFIRM}="${PACK_SLUG}"]`,
  );
  await page.keyboard.press('Enter');
  await expect(confirmButton).toHaveText('Deleting…');
  await expect(confirmButton).toBeFocused();

  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { failUninstall(): void };
    }).__packsFocusRig.failUninstall();
  });
  await expect(confirmButton).toHaveText('Confirm delete');
  await expect(confirmButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(confirmButton).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('could not find');
});

test('Packs moves focus into Install consent and restores its opener on Cancel', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { showUninstalled(): void };
    }).__packsFocusRig.showUninstalled();
  });

  const installButton = page.locator(`[${PACK_INSTALL}="${PACK_SLUG}"]`);
  await expect(installButton).toBeVisible();
  await installButton.focus();
  await page.keyboard.press('Enter');

  const dialog = page.locator(`[${PACK_DIALOG}]`);
  await expect(dialog).toBeFocused();
  const cancelButton = page.locator(`[${PACK_DIALOG_CANCEL}]`);
  await cancelButton.focus();
  await page.keyboard.press('Enter');
  await expect(installButton).toBeFocused();
});

test('Packs preserves the active permission while Install consent repaints', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { showUninstalled(): void };
    }).__packsFocusRig.showUninstalled();
  });
  await page.locator(`[${PACK_INSTALL}="${PACK_SLUG}"]`).click();

  const permission = page.locator(
    `[${PACK_DIALOG_PERMISSION}="read_mail"]`,
  );
  await expect(permission).toBeChecked();
  await permission.focus();
  await page.keyboard.press('Space');
  await expect(permission).not.toBeChecked();
  await expect(permission).toBeFocused();
});

test('Packs keeps Install focused while submitting and lands on Delete', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { showUninstalled(): void };
    }).__packsFocusRig.showUninstalled();
  });
  await page.locator(`[${PACK_INSTALL}="${PACK_SLUG}"]`).click();

  const submitButton = page.locator(`[${PACK_DIALOG_INSTALL}]`);
  await submitButton.focus();
  await page.keyboard.press('Enter');
  await expect(submitButton).toHaveText('Installing…');
  await expect(submitButton).toHaveAttribute('aria-disabled', 'true');
  await expect(submitButton).toHaveAttribute('aria-busy', 'true');
  await expect(submitButton).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __packsFocusRig: { getInstallCalls(): number };
    }
  ).__packsFocusRig.getInstallCalls())).toBe(1);

  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { finishInstall(): void };
    }).__packsFocusRig.finishInstall();
  });
  await expect(page.locator(`[${PACK_DELETE}="${PACK_SLUG}"]`)).toBeFocused();
});

test('Packs restores Install focus when submission fails', async ({ page }) => {
  const card = page.locator(`[${PACK_CARD}][data-id="${PACK_SLUG}"]`);
  await card.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { showUninstalled(): void };
    }).__packsFocusRig.showUninstalled();
  });
  await page.locator(`[${PACK_INSTALL}="${PACK_SLUG}"]`).click();

  const submitButton = page.locator(`[${PACK_DIALOG_INSTALL}]`);
  await submitButton.focus();
  await page.keyboard.press('Enter');
  await expect(submitButton).toHaveText('Installing…');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & {
      __packsFocusRig: { failInstall(): void };
    }).__packsFocusRig.failInstall();
  });
  await expect(submitButton).toHaveText('Install');
  await expect(submitButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(submitButton).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('required permission');
});
