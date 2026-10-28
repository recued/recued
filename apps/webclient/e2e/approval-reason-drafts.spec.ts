import { expect, test, type Page } from '@playwright/test';
import type { ServerPendingAsk } from '@recued/contracts';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

declare global { interface Window {
  __approvalDrafts: { invalidate(): Promise<void>; remount(): Promise<void>; dispose(): void };
} }

let bundle: string, tokens: string;
const pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors.length = 0; page.on('pageerror', error => pageErrors.push(String(error)));
});
test.afterEach(() => { expect(pageErrors, 'uncaught page errors').toEqual([]); });
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { bootstrapApprovalsRoute } from './apps/webclient/src/approvals/bootstrap-approvals-route.ts';
    const handlers = new Map();
    const rpc = async (method, args = {}) => {
      const response = await fetch('/approval-drafts-rpc', {method:'POST', body:JSON.stringify({method,args})});
      const body = await response.json(); if(body.error) throw new Error(body.error); return body.result;
    };
    let route;
    const mount = async () => {
      route = bootstrapApprovalsRoute({root:document.getElementById('app'),
        runApprovalList:() => rpc('approval.list'), runApprovalResolve:args => rpc('approval.resolve',args),
        runApprovalSubscribe:() => rpc('approval.subscribe'), runList:() => rpc('notification.pending_asks'),
        runSubmitAnswer:args => rpc('notification.submitAnswer',args),
        subscribe:(kind,fn) => {const set=handlers.get(kind)??new Set(); set.add(fn); handlers.set(kind,set); return () => set.delete(fn);}});
      await route.whenLoaded();
    };
    await mount();
    window.__approvalDrafts = {
      invalidate:async () => {for(const fn of handlers.get('notification.ask')??[]) fn({kind:'notification.ask',ask_id:'queue-update'}); await route.asksPanel().whenLoaded();},
      dispose:() => route.dispose(), remount:async () => {route.dispose(); await mount();}
    };
    document.body.dataset.ready='true';
  ` }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' });
  bundle = result.outputFiles[0]!.text;
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const ask = (id: string, required = true): ServerPendingAsk => ({ ask_id: id, title: `Review quote ${id}`,
  text: 'Check the quote and explain your decision.', body: 'Quote total: $1,250. Includes one extra visit.',
  options: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Reject' }],
  note_prompt: required ? 'required' : 'optional', created_at: 1_700_000_000_000 });
const note = (page: Page, id = 'a') => page.locator(`[data-recued-ask-note="${id}"]`);
const card = (page: Page, id = 'a') => page.locator(`[data-recued-approvals-focus="${id}"]`);
const approve = (page: Page, id = 'a') => card(page, id).locator('[data-recued-ask-option="yes"]');
const invalidate = (page: Page) => page.evaluate(() => window.__approvalDrafts.invalidate());

const setup = async (page: Page) => {
  let asks = [ask('a'), ask('b', false)], failList = false;
  let held: { promise: Promise<boolean>; release(ok: boolean): void } | undefined;
  const submissions: Array<{ ask_id: string; option_id: string; note?: string }> = [];
  await page.route('**/approval-drafts-rpc', async route => {
    const { method, args } = route.request().postDataJSON();
    let result: unknown = {};
    if (method === 'approval.list') result = { approvals: [] };
    if (method === 'approval.subscribe') result = { approvals: [], seq: 0 };
    if (method === 'notification.pending_asks') {
      if (failList) { failList = false; await route.fulfill({ json: { error: 'Question list temporarily unavailable' } }); return; }
      result = { asks };
    }
    if (method === 'notification.submitAnswer') {
      submissions.push(args);
      const wait = held; held = undefined;
      if (wait && !await wait.promise) { await route.fulfill({ json: { error: 'Answer temporarily unavailable' } }); return; }
      asks = asks.filter(ask => ask.ask_id !== args.ask_id); result = { ok: true };
    }
    await route.fulfill({ json: { result } });
  });
  await page.route('**/approval-drafts.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.route('**/approval-drafts.html', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}
    body{margin:0;font:14px system-ui;color:var(--fg);background:var(--bg)}</style></head>
    <body><main id="app"></main><script type="module" src="/approval-drafts.js"></script></body></html>` }));
  await page.goto('/approval-drafts.html'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  return { submissions, setAsks: (next: ServerPendingAsk[]) => { asks = next; }, failList: () => { failList = true; },
    holdSubmit: () => {
      let release!: (ok: boolean) => void;
      const promise = new Promise<boolean>(resolve => { release = resolve; }); held = { promise, release }; return release;
    } };
};

test('a queue update preserves every reason, focused selection and textarea reading position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await setup(page);
  await note(page, 'b').fill('Keep the other decision separate.');
  const reason = 'I checked this part of the quote.\n'.repeat(12);
  await note(page).fill(reason);
  const before = await note(page).evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(9, 24, 'backward'); el.scrollTop = 45;
    return { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, top: el.scrollTop };
  });
  f.setAsks([ask('c'), ask('b', false), ask('a')]);
  await invalidate(page);
  await expect(note(page)).toHaveValue(reason); await expect(note(page)).toBeFocused();
  await expect(note(page, 'b')).toHaveValue('Keep the other decision separate.');
  expect(await note(page).evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, top: el.scrollTop }))).toEqual(before);
  await note(page).fill(''); await invalidate(page); await expect(note(page)).toHaveValue('');
});

test('a queue update preserves native Undo and Redo for the current reason', async ({ page }) => {
  const f = await setup(page);
  const reason = 'I checked the revised quote.';
  await note(page).pressSequentially(reason);
  await note(page).press('ControlOrMeta+z');
  const undone = await note(page).inputValue();
  expect(undone).not.toBe(reason);
  await note(page).press('ControlOrMeta+Shift+z'); await expect(note(page)).toHaveValue(reason);
  await invalidate(page);
  await note(page).press('ControlOrMeta+z'); await expect(note(page)).toHaveValue(undone);
  await note(page).press('ControlOrMeta+Shift+z'); await expect(note(page)).toHaveValue(reason);
  f.setAsks([{ ...ask('a'), body: 'A changed quote that needs a fresh reason.' }, ask('b', false)]);
  await invalidate(page); await note(page).focus();
  await note(page).press('ControlOrMeta+z'); await expect(note(page)).toHaveValue('');
  await note(page).press('ControlOrMeta+Shift+z'); await expect(note(page)).toHaveValue('');
});

test('a failed answer keeps its reason available for an exact retry without duplicate submissions', async ({ page }) => {
  const f = await setup(page), release = f.holdSubmit();
  const reason = 'The additional visit is within the agreed quote.';
  try {
    await note(page).fill(reason); await approve(page).click();
    await expect(approve(page)).toBeDisabled(); await invalidate(page);
    await expect.poll(() => f.submissions.length).toBe(1);
    await approve(page).dispatchEvent('click'); expect(f.submissions).toHaveLength(1);
    release(false); await expect(card(page).locator('[data-recued-ask-error]')).toBeVisible();
    await expect(note(page)).toHaveValue(reason); await expect(approve(page)).toBeFocused();
    await approve(page).press('Enter'); await expect(card(page)).toHaveCount(0);
    expect(f.submissions).toEqual([{ ask_id: 'a', option_id: 'yes', note: reason }, { ask_id: 'a', option_id: 'yes', note: reason }]);
  } finally { release(false); }
});

test('a delayed answer failure keeps newer edits and a different decision’s current caret', async ({ page }) => {
  const f = await setup(page), release = f.holdSubmit();
  try {
    await note(page).fill('The original submitted reason.'); await approve(page).click();
    await expect(approve(page)).toBeDisabled();
    await note(page).fill('A newer unsent reason.');
    await note(page, 'b').fill('Still reviewing the other quote.');
    await note(page, 'b').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 15, 'backward'));
    release(false); await expect(card(page).locator('[data-recued-ask-error]')).toBeVisible();
    await expect(note(page)).toHaveValue('A newer unsent reason.');
    await expect(note(page, 'b')).toHaveValue('Still reviewing the other quote.'); await expect(note(page, 'b')).toBeFocused();
    expect(await note(page, 'b').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual([6, 15, 'backward']);
    expect(f.submissions[0]?.note).toBe('The original submitted reason.');
  } finally { release(false); }
});

test('a failed queue read retains the draft and a manual retry keeps the owner’s Refresh focus', async ({ page }) => {
  const f = await setup(page);
  await note(page).fill('Keep this reason through the outage.'); f.failList(); await invalidate(page);
  await expect(page.locator('[data-recued-approvals-error]')).toContainText('Question list temporarily unavailable');
  await expect(note(page)).toHaveValue('Keep this reason through the outage.'); await expect(note(page)).toBeFocused();
  const refresh = page.locator('[data-recued-approvals-refresh]');
  await refresh.focus(); await expect(refresh).toBeFocused(); await refresh.press('Enter');
  await expect(page.locator('[data-recued-approvals-error]')).toHaveCount(0);
  await expect(note(page)).toHaveValue('Keep this reason through the outage.'); await expect(refresh).toBeFocused();
});

test('unchanged review data keeps the draft, but changed decision content clears it', async ({ page }) => {
  const f = await setup(page), original = ask('a');
  await note(page, 'b').fill('Unrelated draft.'); await note(page).fill('Reason for the original quote.');
  const { created_at, ...rest } = original;
  f.setAsks([{ created_at, ...rest }, ask('b', false)]);
  await invalidate(page); await expect(note(page)).toHaveValue('Reason for the original quote.'); await expect(note(page)).toBeFocused();
  f.setAsks([{ ...original, body: 'A different quote: $1,750.' }, ask('b', false)]);
  await invalidate(page); await expect(note(page)).toHaveValue(''); await expect(card(page)).toBeFocused();
  await expect(note(page, 'b')).toHaveValue('Unrelated draft.');
});

test('a closed decision retires its draft and cannot restore it into a reused identifier', async ({ page }) => {
  const f = await setup(page);
  await note(page, 'b').fill('Other decision.'); await note(page).fill('This reason must retire.');
  f.setAsks([ask('b', false)]); await invalidate(page);
  await expect(card(page)).toHaveCount(0); await expect(card(page, 'b')).toBeFocused();
  f.setAsks([ask('a'), ask('b', false)]); await invalidate(page);
  await expect(note(page)).toHaveValue(''); await expect(note(page, 'b')).toHaveValue('Other decision.');
});

test('leaving the page clears drafts and late failures cannot alter a newly opened review', async ({ page }) => {
  const f = await setup(page), release = f.holdSubmit();
  try {
    await note(page).fill('Previous page reason.'); await approve(page).click(); await expect(approve(page)).toBeDisabled();
    await page.evaluate(() => window.__approvalDrafts.remount()); await expect(note(page)).toHaveValue('');
    await note(page).fill('Fresh page reason.'); await note(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(1, 5));
    const response = page.waitForResponse(response => response.url().endsWith('/approval-drafts-rpc')
      && response.request().postDataJSON().method === 'notification.submitAnswer');
    release(false); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.locator('[data-recued-ask-error]:visible')).toHaveCount(0);
    await expect(note(page)).toHaveValue('Fresh page reason.'); await expect(note(page)).toBeFocused();
    expect(await note(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([1, 5]);
  } finally { release(false); }
});
