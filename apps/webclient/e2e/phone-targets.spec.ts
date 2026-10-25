import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  ACCOUNT_MENU_TRIGGER,
  GLOBAL_RUN_PALETTE_TRIGGER,
  HARNESS_URL,
  LIVE_CONTROL_RUN_CONTROL,
  LIVE_CONTROL_TOGGLE,
  installFullAppHooks,
} from './helpers/full-app.js';

/** On a phone, everything a finger presses is at least 44px each way: the
 *  app's own phone control height (`--wc-control-h`). Checked on every route,
 *  in the dialogs, menus and edit modes the routes open, and on the screen a
 *  plain HTTP link gets instead of the app, with a touch screen, because some
 *  routes size their targets for `(pointer: coarse)`.
 *
 *  And every control's label fits inside it. A min-width on a flex item
 *  replaces its auto minimum, which is its label's width, so a size floor
 *  can shrink a row of tabs under their own labels: Settings' tabs did, at
 *  44px each.
 *
 *  And a field's label stays beside its field or above it. A row that wraps
 *  can break between the two: Automation's filters ended a line with "Status"
 *  and started the next with its select.
 *
 *  Not counted: a link inside a sentence, which keeps the sentence's line
 *  (WCAG 2.5.5 exempts it). A checkbox or radio is measured by its label,
 *  which is what a finger presses.
 *
 *  ⛔ Measured 2026-10-24: 57 controls on these routes were under 44px — tabs
 *  at 36-40, toolbar buttons at 34-36, Automation's chips and Chat's Send at
 *  32, and every text field at 40, held there by the input floor. Then 165
 *  more in the states the e2e fixtures load and the buttons there open:
 *  dialog buttons at 34-36, New Task's Close at 25 by 24, a new contact's
 *  fields at 18 tall, Exposure's checkboxes at 36. */

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

installFullAppHooks();

interface Found {
  measured: number;
  small: Array<{ element: string; size: string }>;
  overflowing: Array<{ element: string; by: number }>;
  /** Labels off their field's line and not above or below it either. */
  apart: Array<{ label: string; field: string }>;
}

/** Runs in the page, so it is self-contained. */
const measure = (): Found => {
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  // A link with words beside it, in the same element, is part of a sentence.
  const inSentence = (el: Element): boolean => el.tagName === 'A'
    && [...(el.parentElement?.childNodes ?? [])].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
  const name = (el: Element): string => {
    const mark = [...el.attributes].map((a) => a.name).find((n) => n.startsWith('data-recued'));
    const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${mark ? `[${mark}]` : ''} "${label}"`;
  };
  // How far a control's label runs out of it. Only text in the control's own
  // flow: a badge placed over its corner, or text a box inside it clips on
  // purpose, is not its label.
  const labelOverflow = (el: Element): number => {
    const r = el.getBoundingClientRect();
    let by = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? '').trim()) continue;
      let placed = false;
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.position === 'absolute' || style.position === 'fixed'
          || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          placed = true;
          break;
        }
      }
      if (placed) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        if (q.width < 1 || q.height < 1) continue;
        by = Math.max(by, r.left - q.left, q.right - r.right, r.top - q.top, q.bottom - r.bottom);
      }
    }
    return by;
  };
  const targets = [...document.querySelectorAll<HTMLElement>(
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"]',
  )].filter(shown);
  const found: Found = { measured: targets.length, small: [], overflowing: [], apart: [] };
  for (const el of targets) {
    if (el.tagName === 'A' && (getComputedStyle(el).display === 'inline' || inSentence(el))) continue;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
      const by = labelOverflow(el);
      if (by > 1) found.overflowing.push({ element: name(el), by: Math.round(by) });
    }
    let box: Element = el;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      box = el.closest('label')
        ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null)
        ?? el;
    }
    const r = box.getBoundingClientRect();
    if (r.width >= 43.5 && r.height >= 43.5) continue;
    found.small.push({ element: name(el), size: `${Math.round(r.width)}x${Math.round(r.height)}` });
  }
  // Stacked, some of the label is directly over or under its field; side by
  // side, the two share a line. A label that is neither has been left behind.
  for (const label of document.querySelectorAll<HTMLLabelElement>('label[for]')) {
    const field = label.control;
    if (!field || label.contains(field) || !shown(label) || !shown(field)) continue;
    const a = label.getBoundingClientRect();
    const b = field.getBoundingClientRect();
    const sameLine = a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const stacked = Math.min(a.right, b.right) > Math.max(a.left, b.left);
    if (!sameLine && !stacked) found.apart.push({ label: name(label), field: name(field) });
  }
  return found;
};

const ROUTES = [
  'chat', 'today', 'yours', 'data', 'views', 'mail', 'logs', 'stats', 'reception', 'approvals',
  'kitchen', 'contracts', 'connections', 'packs', 'recipes', 'automation',
  'settings/account', 'settings/servers', 'settings/backup', 'settings/ai-models', 'settings/seller',
  'settings/updates', 'settings/housekeeping', 'settings/privacy', 'settings/devices',
  'settings/notifications', 'settings/email-chat', 'settings/server/connect-device',
  'settings/server/exposure', 'settings/server/hostnames', 'settings/server/certificates',
  'settings/server/timezone', 'settings/server/key-health', 'settings/server/maintenance',
];

test('every route\'s controls are a finger\'s size on a phone', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${HARNESS_URL}?devices=ready&account=bound&server_profiles=multiple#chat`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const small: Array<{ route: string; element: string; size: string }> = [];
  const overflowing: Array<{ route: string; element: string; by: number }> = [];
  const apart: Array<{ route: string; label: string; field: string }> = [];
  let measured = 0;
  for (const route of ROUTES) {
    await page.evaluate((hash) => window.__app.setHash(`#${hash}`), route);
    await page.waitForTimeout(500);
    const found = await page.evaluate(measure);
    measured += found.measured;
    for (const entry of found.small) small.push({ route, ...entry });
    for (const entry of found.overflowing) overflowing.push({ route, ...entry });
    for (const entry of found.apart) apart.push({ route, ...entry });
  }
  // The sweep looked at something: these routes held 633 controls.
  expect(measured).toBeGreaterThan(500);
  expect(small).toEqual([]);
  expect(overflowing).toEqual([]);
  expect(apart).toEqual([]);
});

const press = (name: string | RegExp) => async (page: Page): Promise<void> => {
  await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
};

interface State {
  name: string;
  /** The harness's query and hash. */
  at: string;
  /** False for a screen shown instead of the app, which never reports ready. */
  starts?: false;
  /** Opens the state; absent when loading the page is the state. */
  open?: (page: Page) => Promise<void>;
  /** Shown once the state is open, so a state that stops opening fails
   *  instead of passing with nothing in it. */
  shows: (page: Page) => Locator;
}

const STATES: State[] = [
  {
    name: 'the run palette',
    at: '?devices=ready&account=bound&server_profiles=multiple#chat',
    open: async (page) => { await page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`).click(); },
    shows: (page) => page.getByRole('dialog', { name: 'Run a Recipe' }),
  },
  {
    name: 'the account menu',
    at: '?devices=ready&account=bound&server_profiles=multiple#chat',
    open: async (page) => { await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click(); },
    shows: (page) => page.getByRole('dialog', { name: 'Account & servers' }),
  },
  {
    name: 'Chat › Chats',
    at: '?ai=empty&chat=session#chat',
    open: press('Chats'),
    shows: (page) => page.getByRole('heading', { name: 'Chats' }),
  },
  {
    name: 'Chat › Files',
    at: '?ai=two&chat=session#chat/session/chat_1',
    open: press('Files'),
    shows: (page) => page.getByRole('dialog', { name: 'Conversation files' }),
  },
  {
    name: 'Chat › New mail',
    at: '?ai=two&chat=session#chat/new',
    open: press('New mail'),
    shows: (page) => page.getByRole('link', { name: 'Connect mail →' }),
  },
  {
    name: 'Chat › Review undo',
    at: '?chat=session&local_mutation_receipt=1#chat/session/chat_1',
    open: press(/^Review undo/),
    shows: (page) => page.getByRole('button', { name: 'Approve undo' }),
  },
  {
    name: 'Chat › Live control',
    at: '?chat=session&live=interrupted#chat/session/chat_1',
    open: async (page) => { await page.locator(`[${LIVE_CONTROL_TOGGLE}]`).first().click(); },
    shows: (page) => page.getByRole('button', { name: 'Close live control' }),
  },
  {
    name: 'Logs › Live control',
    at: '?live=running&logs_passes=active#logs',
    open: async (page) => { await page.locator(`[${LIVE_CONTROL_TOGGLE}]`).first().click(); },
    shows: (page) => page.locator(`[${LIVE_CONTROL_RUN_CONTROL}]`).first(),
  },
  {
    name: 'Logs, filtered to one recipe',
    at: '?journey=verification&logs_filters=1#logs/recipe/calendar%2Fschedule-review',
    shows: (page) => page.getByRole('button', { name: 'Clear selection' }),
  },
  {
    name: 'a run › Technical evidence',
    at: '?journey=verification#logs/run-verify',
    open: async (page) => { await page.locator('summary', { hasText: 'Technical evidence' }).click(); },
    shows: (page) => page.getByRole('link', { name: 'Run link' }),
  },
  {
    name: 'a connection › Troubleshoot OAuth',
    at: '?connection=calendar-lifecycle#connections/calendar/work-calendar',
    open: press('Troubleshoot OAuth'),
    shows: (page) => page.getByRole('heading', { name: 'Guided OAuth troubleshooting' }),
  },
  {
    name: 'a connection › Manage authentication',
    at: '?connection=calendar-lifecycle#connections/calendar/work-calendar',
    open: press('Manage authentication'),
    shows: (page) => page.getByRole('link', { name: 'Incident history' }),
  },
  {
    name: 'Webhooks › New webhook',
    at: '?connection=webhooks#connections/webhooks',
    open: press('New webhook'),
    shows: (page) => page.getByRole('button', { name: 'Make a webhook' }),
  },
  {
    name: 'Contracts › New contract',
    at: '?contracts=paged#contracts/view/others',
    open: press('+ New contract'),
    shows: (page) => page.getByRole('group', { name: 'New contract' }),
  },
  {
    name: 'Data › New contact',
    at: '?data=contacts#data',
    open: press('New contact'),
    shows: (page) => page.getByRole('dialog', { name: 'New contact' }),
  },
  {
    name: 'Data › New Task',
    at: '?data=work-entities-paged#data/task',
    open: press('+ New Task'),
    shows: (page) => page.getByRole('dialog', { name: 'New Task' }),
  },
  {
    name: 'Data › New Commitment',
    at: '?settle_reads=1&yours=demo#data/commitment',
    open: press('+ New Commitment'),
    shows: (page) => page.getByRole('dialog', { name: 'New Commitment' }),
  },
  {
    name: 'Memory › Add memory',
    at: '?data=memory-rows#data/memory',
    open: press('Add memory'),
    shows: (page) => page.getByRole('button', { name: 'Save', exact: true }),
  },
  {
    name: 'Memory › Import',
    at: '?data=memory-rows#data/memory',
    open: press('Import'),
    shows: (page) => page.getByRole('form', { name: 'Import memory' }),
  },
  {
    name: 'Memory › Forget',
    at: '?data=memory-rows#data/memory',
    open: press(/^Forget memory/),
    shows: (page) => page.getByRole('button', { name: 'Confirm' }),
  },
  {
    name: 'Records › Add filter',
    at: '?data=records#data/records',
    open: press('Add filter'),
    shows: (page) => page.getByLabel('Filter 1 field', { exact: true }),
  },
  {
    name: 'a recipe › Schedule',
    at: '?recipe_connections=choice&recipes=installed#recipes/autorun-live-1',
    open: press('Schedule'),
    shows: (page) => page.getByRole('tab', { name: 'Schedule', selected: true }),
  },
  {
    name: 'Automation › Schedules, filtered by status',
    at: '?automation=rules#automation/schedules',
    shows: (page) => page.getByLabel('Status', { exact: true }),
  },
  {
    name: 'Automation › Triggers, filtered by status and origin',
    at: '?automation=rules#automation/triggers',
    shows: (page) => page.getByLabel('Origin', { exact: true }),
  },
  {
    name: 'Exposure, every cell',
    at: '?settle_reads=1#settings/server/exposure',
    shows: (page) => page.getByRole('checkbox').first(),
  },
  {
    name: 'Yours, a list long enough for pages',
    at: '?yours=demo&yours_asset_filter_pages#yours',
    shows: (page) => page.getByRole('link', { name: 'Next' }),
  },
  {
    name: 'Yours › Classes',
    at: '?yours=demo#yours/assets/classes',
    shows: (page) => page.getByRole('heading', { name: 'Classes', exact: true }),
  },
  {
    name: 'Secure access needed, after a plain HTTP link',
    at: '?chat=session&journey=secure-access&url=https%3A%2F%2Fattacker.example%2Fcollect#chat/session/chat_1',
    starts: false,
    shows: (page) => page.getByRole('region', { name: 'Choose where you want to continue' }),
  },
];

for (const state of STATES) {
  test(`${state.name}: controls are a finger's size on a phone`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}${state.at}`);
    if (state.starts !== false) await page.waitForFunction(() => window.__app?.ready === true);
    await state.open?.(page);
    await expect(state.shows(page)).toBeVisible();
    const found = await page.evaluate(measure);
    expect(found.small).toEqual([]);
    expect(found.overflowing).toEqual([]);
    expect(found.apart).toEqual([]);
  });
}
