import { expect, test, type Page } from '@playwright/test';
import { applyPreset, PATH_ROLES, PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE, type ExposureState, type PathRole } from '@recued/contracts';
import { writeFile } from 'node:fs/promises';
import type { ExposureGetCaller } from '../src/settings/exposure-panel.js';
import { FIXED_NOW, HARNESS_URL } from './helpers/full-app.js';

type ExposureRead = Awaited<ReturnType<ExposureGetCaller>>;
interface GridFixture { reply: ExposureRead; writes: unknown[] }
declare global { interface Window { __exposureGrid: GridFixture } }
const panel = (page: Page) => page.locator('[data-recued-exposure-panel]');
const grid = (page: Page) => panel(page).locator('.exposure-grid');
const table = (page: Page) => panel(page).getByRole('table', { name: 'What each part allows', exact: true });
const guidance = (page: Page) => panel(page).locator('[data-recued-exposure-grid-guidance]');
const control = (page: Page, path: PathRole, cell: 'lan' | 'public') =>
  table(page).getByRole('checkbox', { name: `${path} ${cell}`, exact: true });
const guidanceCopy = 'To allow access from the internet, set up a web address under Settings, Server, Hostnames.';
let errors: Error[] = [];
let externalRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = []; externalRequests = [];
  page.on('pageerror', error => errors.push(error));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.map(error => error.message)).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.__exposureGrid?.writes ?? [])).toEqual([]);
});

const open = async (page: Page, width: number, scenario: 'gated' | 'allowed' | 'mixed' = 'gated') => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const resolution = applyPreset('lan_only', { acknowledged: false });
  if (scenario === 'mixed') resolution.reception = { ...resolution.reception, public: true };
  const reply: ExposureRead = { state: { resolution, derived_preset_label: scenario === 'mixed' ? 'custom' : 'lan_only',
    public_mcp_acknowledgement: { acknowledged: false }, last_changed_at: FIXED_NOW, changed_by_client_id: 'device-current' },
    apex_mode: 'serve_webclient', has_public_address: scenario === 'allowed' };
  await page.evaluate(reply => {
    const fixture: GridFixture = { reply, writes: [] };
    Object.assign(window, {
      __exposureGrid: fixture,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (method.startsWith('exposure.') && method !== 'exposure.get') fixture.writes.push({ method, args });
        return method === 'exposure.get' ? { result: structuredClone(fixture.reply) } : undefined;
      },
    });
    window.__app.setHash('#settings/server/exposure');
  }, reply);
  await expect(table(page)).toBeVisible();
  return reply;
};
const expectGuidance = async (page: Page, state: ExposureState, hasAddress: boolean) => {
  const blocked = PATH_ROLES.filter(path => !hasAddress && !state.resolution[path].public);
  await expect(guidance(page)).toHaveCount(blocked.length ? 1 : 0);
  let id: string | null = null;
  if (blocked.length) {
    await expect(guidance(page)).toHaveText(guidanceCopy);
    await expect(guidance(page)).toBeVisible();
    id = await guidance(page).getAttribute('id');
    expect(id).toBeTruthy();
    expect(await page.locator('[id]').evaluateAll((nodes, id) => nodes.filter(node => node.id === id).length, id)).toBe(1);
    await expect(table(page)).toHaveAttribute('aria-describedby', id!);
    await expect(table(page)).toHaveAccessibleDescription(guidanceCopy);
    const hintBox = (await guidance(page).boundingBox())!;
    expect(hintBox.width).toBeGreaterThanOrEqual((await table(page).boundingBox())!.width - 1);
    expect(hintBox.height).toBeLessThan(110);
  } else {
    await expect(table(page)).not.toHaveAttribute('aria-describedby');
    await expect(table(page)).toHaveAccessibleDescription('');
  }
  for (const path of PATH_ROLES) {
    const publicInput = control(page, path, 'public');
    await expect(publicInput).toBeChecked({ checked: state.resolution[path].public });
    await expect(control(page, path, 'lan')).toBeChecked({ checked: state.resolution[path].lan });
    await expect(control(page, path, 'lan')).toBeEnabled();
    await expect(control(page, path, 'lan')).toHaveAccessibleDescription('');
    if (blocked.includes(path)) {
      await expect(publicInput).toBeDisabled();
      await expect(publicInput).toHaveAttribute('aria-describedby', id!);
      await expect(publicInput).toHaveAccessibleDescription(guidanceCopy);
    } else {
      await expect(publicInput).toBeEnabled();
      await expect(publicInput).not.toHaveAttribute('aria-describedby');
      await expect(publicInput).toHaveAccessibleDescription('');
    }
  }
};
const geometry = (page: Page) => table(page).evaluate(table => {
  const rect = (node: Element) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const rows = Array.from(table.querySelectorAll('tbody tr')).map(row => {
    const lan = row.querySelector('[data-recued-exposure-cell$=".lan"]')!.closest('label')!;
    const publicInput = row.querySelector('[data-recued-exposure-cell$=".public"]')!.closest('label')!;
    const lanBox = rect(lan); const publicBox = rect(publicInput);
    return { path: row.getAttribute('data-recued-exposure-path'), row: rect(row),
      cells: Array.from(row.children).map(cell => ({ ...rect(cell), display: getComputedStyle(cell).display })),
      lan: lanBox, public: publicBox,
      switchOffset: Math.abs(lanBox.y + lanBox.height / 2 - publicBox.y - publicBox.height / 2) };
  });
  return { table: rect(table), rows, overflow: document.documentElement.scrollWidth > innerWidth };
});
const expectGeometry = async (page: Page, width: number) => {
  await expect(table(page).getByRole('columnheader')).toHaveText(['Path', 'LAN', 'Public']);
  await expect(table(page).locator('thead th[scope="col"]')).toHaveCount(3);
  await expect(table(page).getByRole('row')).toHaveCount(PATH_ROLES.length + 1);
  await expect(table(page).getByRole('cell')).toHaveCount(PATH_ROLES.length * 3);
  await expect(table(page).getByRole('checkbox')).toHaveCount(PATH_ROLES.length * 2);
  await expect(table(page).locator('.exposure-hint-inline')).toHaveCount(0);
  const measured = await geometry(page);
  expect(measured.overflow).toBe(false);
  expect(measured.table.height).toBeLessThan(width === 280 ? 1050 : width === 390 ? 720 : 620);
  for (const row of measured.rows) {
    expect(row.cells).toHaveLength(3);
    expect(row.switchOffset, row.path!).toBeLessThan(1);
    for (const cell of row.cells) {
      expect(cell.display).toBe('table-cell');
      expect(Math.abs(cell.y - row.row.y)).toBeLessThan(1);
      expect(Math.abs(cell.height - row.row.height)).toBeLessThan(1);
    }
    for (const target of [row.lan, row.public]) {
      expect(target.width).toBeGreaterThanOrEqual(36);
      expect(target.height).toBeGreaterThanOrEqual(36);
    }
  }
  return measured;
};
const liveState = (publicOn: boolean, at: number): ExposureState => ({
  resolution: Object.fromEntries(PATH_ROLES.map(path => [path, { lan: true, public: publicOn }])) as ExposureState['resolution'],
  derived_preset_label: 'custom', last_changed_at: at, changed_by_client_id: 'device-other',
  public_mcp_acknowledgement: { acknowledged: true, acknowledged_at: FIXED_NOW,
    acknowledged_by_client_id: 'device-other', free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE },
});
const broadcast = (page: Page, state: ExposureState) => page.evaluate(state => window.__app.fireMessage({
  type: 'server_event', event: { kind: 'exposure_changed', resolution: state.resolution,
    derived_preset_label: state.derived_preset_label, public_mcp_acknowledgement: state.public_mcp_acknowledgement,
    changed_at: state.last_changed_at, changed_by_client_id: state.changed_by_client_id, cursor: state.last_changed_at },
}), state);

for (const width of [280, 390, 1280]) {
  for (const scenario of ['gated', 'allowed', 'mixed'] as const) {
    test(`Exposure grid aligns ${scenario} choices and describes only blocked switches at ${width}px`, async ({ page }, info) => {
      const reply = await open(page, width, scenario);
      await expectGuidance(page, reply.state, reply.has_public_address!);
      const measured = await expectGeometry(page, width);
      await writeFile(info.outputPath('geometry.json'), JSON.stringify({ width, scenario, browser: info.project.name, ...measured }, null, 2));
      if (scenario === 'gated' && width !== 280) {
        await grid(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('grid.png') });
      }
      // Native focus reaches every available choice without changing it.
      for (const path of PATH_ROLES) for (const cell of ['lan', 'public'] as const) {
        const input = control(page, path, cell);
        if (await input.isEnabled()) {
          await input.focus();
          await expect(input).toBeFocused();
        }
      }
    });
  }

  test(`Exposure grid updates shared guidance as existing public paths close at ${width}px`, async ({ page }) => {
    await open(page, width);
    const id = await guidance(page).getAttribute('id');
    const publicState = liveState(true, FIXED_NOW + 10);
    await broadcast(page, publicState);
    await expectGuidance(page, publicState, false);
    await expectGeometry(page, width);
    const closedState = liveState(false, FIXED_NOW + 20);
    await broadcast(page, closedState);
    await expectGuidance(page, closedState, false);
    await expect(guidance(page)).toHaveAttribute('id', id!);
    await expectGeometry(page, width);
  });

  test(`Exposure grid remounts address guidance without stale descriptions at ${width}px`, async ({ page }) => {
    const reply = await open(page, width);
    const oldId = await guidance(page).getAttribute('id');
    for (const hasAddress of [true, false]) {
      await page.evaluate(() => window.__app.setHash('#yours'));
      await expect(panel(page)).toHaveCount(0);
      await page.evaluate(hasAddress => {
        window.__exposureGrid.reply.has_public_address = hasAddress;
        window.__app.setHash('#settings/server/exposure');
      }, hasAddress);
      await expect(table(page)).toBeVisible();
      await expectGuidance(page, reply.state, hasAddress);
      await expectGeometry(page, width);
      expect(await page.locator('[id]').evaluateAll((nodes, id) => nodes.some(node => node.id === id), oldId)).toBe(false);
      if (!hasAddress) expect(await guidance(page).getAttribute('id')).not.toBe(oldId);
    }
  });
}
