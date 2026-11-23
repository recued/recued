/** D-402 slice F3d (and F3, H4a) — the question before a run, as the owner answers it, in a real browser:
 *  the Attention popover the bell opens, and the Approvals page its "Open approvals" leads to. The rows are
 *  the server's own (`handlePendingAsks` over the asks `handleExecute` raised in `d-402-run-question.test.ts`
 *  and `d-402-browser-check.test.ts`, 2026-11-18): an AI app's run, named by the owner's name for its key,
 *  and a chat's run that names its two browsers. Each surface is mounted as the webclient mounts it, with its
 *  own styles: the popover injects its own, the Approvals route injects `APPROVALS_ROUTE_STYLES`. */

import { expect, test, type Page } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { readFile } from 'node:fs/promises';

const esbuild: BuildOptions = { bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' };
const ANSWERS = [
  { id: 'run_once', label: 'Yes, this time' }, { id: 'run_always', label: 'Always, for this recipe' },
  { id: 'run_each_step', label: 'Ask me at each step' }, { id: 'run_no', label: 'No' },
];
const APP = { ask_id: 'ask-app', title: 'Run “Add a morning note”?',
  text: 'Claude Desktop asks to run it. Without asking, it will: add a note.', options: ANSWERS };
const TWO_BROWSERS = { ask_id: 'ask-chat', title: 'Run “Read in two browsers”?',
  text: 'Your chat asks to run it. Without asking, it will: act in Home on b.example. In Work it reads a.example. '
    + 'What it reads in Work is used in Home.', options: ANSWERS };

/** The two rows, waiting 1 and 4 minutes; each answer kept, and its row gone once answered. */
const STATE = `
  const now = Date.now();
  let open = [{ ...${JSON.stringify(APP)}, created_at: now - 60_000 }, { ...${JSON.stringify(TWO_BROWSERS)}, created_at: now - 240_000 }];
  window.__answers = [];
  const list = async () => ({ asks: open });
  const answer = async (args) => { window.__answers.push(args); open = open.filter((ask) => ask.ask_id !== args.ask_id); return { ok: true }; };
`;
const bundles: Record<'popover' | 'approvals', string> = { popover: '', approvals: '' };
let tokens: string;
test.beforeAll(async () => {
  bundles.popover = (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents: `
    import { mountApprovalAttentionPopover } from './apps/webclient/src/attention/approval-attention-popover.ts';
    ${STATE}
    const handle = mountApprovalAttentionPopover({ host: document.getElementById('app'), document,
      runApprovalList: async () => ({ approvals: [] }),
      runApprovalResolve: async (args) => ({ approval_id: args.approval_id, accepted: true }),
      runApprovalSubscribe: async () => ({ approvals: [], seq: 1 }),
      runPendingAsksList: list, runPendingAskSubmitAnswer: answer });
    await handle.refreshAsks();
    handle.open();
    document.body.dataset.ready = 'true';
  ` } })).outputFiles![0]!.text;
  bundles.approvals = (await build({ ...esbuild, stdin: { resolveDir: process.cwd(), contents: `
    import { mountAsksPanel } from './apps/webclient/src/approvals/asks-panel.ts';
    import { APPROVALS_ROUTE_STYLES } from './apps/webclient/src/approvals/bootstrap-approvals-route.ts';
    ${STATE}
    const style = document.createElement('style');
    style.textContent = APPROVALS_ROUTE_STYLES;
    document.head.appendChild(style);
    const panel = mountAsksPanel({ host: document.getElementById('app'), document, runList: list, runSubmitAnswer: answer });
    await panel.whenLoaded();
    document.body.dataset.ready = 'true';
  ` } })).outputFiles![0]!.text;
  tokens = await readFile('packages/ui-shared/src/theme/tokens.css', 'utf8');
});

const open = async (page: Page, surface: keyof typeof bundles) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`**/run-question-${surface}.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: bundles[surface] }));
  await page.route(`**/run-question-${surface}.html`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}
    body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg)} #app{padding:8px 16px}</style></head>
    <body><main id="app"></main><script type="module" src="/run-question-${surface}.js"></script></body></html>` }));
  await page.goto(`/run-question-${surface}.html`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  return errors;
};

const SURFACES = [
  { surface: 'popover' as const, row: '[data-recued-attention-gateway-ask]', answer: (id: string) => `[data-option-id="${id}"]` },
  { surface: 'approvals' as const, row: '[data-recued-ask-card]', answer: (id: string) => `[data-recued-ask-option="${id}"]` },
];

for (const { surface, row, answer } of SURFACES) {
  for (const width of [390, 1280]) {
    test(`${surface}: an AI app's run asked by the app's name, and a run in two browsers, each with its four answers, at ${width}px`,
      async ({ page }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
        const errors = await open(page, surface);
        const app = page.locator(row, { hasText: 'Claude Desktop asks to run it' });
        const chat = page.locator(row, { hasText: 'Your chat asks to run it' });
        await expect(app).toContainText(APP.title);
        await expect(app).toContainText(APP.text);
        await expect(chat).toContainText(TWO_BROWSERS.text);
        for (const card of [app, chat]) {
          for (const { id, label } of ANSWERS) {
            const button = card.locator(answer(id));
            await expect(button).toHaveText(label);
            await expect(button).toBeVisible();
            const box = (await button.boundingBox())!;
            // Every answer whole and inside the page; a finger's height on a phone.
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            if (width === 390) expect(box.height).toBeGreaterThanOrEqual(44);
            expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`run-question-${surface}-${width}.png`), fullPage: true });
        // "Yes, this time" on the app's question answers that question alone, and its row goes.
        await app.locator(answer('run_once')).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __answers: unknown[] }).__answers))
          .toEqual([{ ask_id: 'ask-app', option_id: 'run_once' }]);
        await expect(app).toHaveCount(0);
        await expect(chat).toHaveCount(1);
        expect(errors).toEqual([]);
      });
  }
}
