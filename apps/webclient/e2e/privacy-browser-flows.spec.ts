import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

const recipeMethod = 'chat.execution.browser_flow.recipe';
const forgetMethod = 'chat.execution.browser_flow.forget';
const historyMethod = 'chat.execution.learned';
const action = (page: Page, kind: 'recipe' | 'forget', id = 'first') =>
  page.locator(`[data-recued-learning-flow-${kind}="${id}"]`);
const retry = (page: Page) => page.getByRole('button', { name: 'Retry learned history', exact: true });
const outside = (page: Page) => page.getByRole('link', { name: 'Receipt extraction and source controls', exact: true });
const press = async (control: ReturnType<typeof action>) => { await control.focus(); await control.press('Enter'); };
const release = (page: Page, method: string) => page.evaluate(method => window.__app.releaseRpcResponses?.(method), method);
const calls = (page: Page, method: string) => page.evaluate(method => window.__privacyFlows.calls.filter(call => call.method === method), method);

declare global { interface Window { __privacyFlows: {
  failRecipe: boolean; failForget: boolean; failRead: boolean;
  calls: Array<{ method: string; args: unknown }>;
} } }

const open = async (page: Page, width: number, count = 2) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(count => {
    let flows = ['first', 'second'].slice(0, count).map((flow_id, index) => ({
      flow_id, kept_at: 1_700_000_000_000, sites: [`reports-${index + 1}.example.test`],
      steps: [{ do: 'click', url: `https://reports-${index + 1}.example.test/`, title: 'Reports',
        element: { role: 'button', label: 'Save report' }, at: 1 },
      { do: 'press', url: `https://reports-${index + 1}.example.test/saved`, title: 'Saved reports',
        element: { role: 'link', label: 'Open saved report' }, key: 'Enter', at: 2 }],
    }));
    const controls = { calls: [] as Array<{ method: string; args: unknown }>, failRecipe: true, failForget: true, failRead: false };
    window.__privacyFlows = controls;
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (!['chat.execution.learned', 'chat.execution.browser_flow.recipe', 'chat.execution.browser_flow.forget'].includes(method)) return;
      controls.calls.push({ method, args });
      const failure = (message: string) => ({ error: { code: 'UNAVAILABLE', message } });
      if (method === 'chat.execution.learned') {
        if (controls.failRead) { controls.failRead = false; return failure('Learning history could not be checked.'); }
        return { result: { cases: [], browser_flows: structuredClone(flows) } };
      }
      if (method === 'chat.execution.browser_flow.recipe') return controls.failRecipe
        ? failure('The recipe could not be made. Try again.')
        : { result: { ok: false, issues: ['The saved steps are no longer available.'] } };
      if (controls.failForget) return failure('The saved steps could not be forgotten. Try again.');
      flows = flows.filter(flow => flow.flow_id !== (args as { flow_id: string }).flow_id);
      return { result: { removed: true } };
    } });
  }, count);
  await page.goto(`${HARNESS_URL}?settle_reads=1&hold_rpc=${recipeMethod}&hold_rpc=${forgetMethod}#settings/privacy`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(action(page, 'recipe')).toBeVisible();
};

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  test(`Settings Learning kept-step recipes retain the current keyboard owner through pending and refusal at ${width}px`, async ({ page }) => {
    await open(page, width);
    const steps = page.locator('[data-recued-learning-flow="first"]').getByRole('listitem');
    await expect(steps).toHaveCount(2);
    await press(action(page, 'recipe'));
    await expect(action(page, 'recipe')).toHaveText('Making the recipe…');
    await expect(action(page, 'recipe')).toBeFocused();
    await action(page, 'recipe', 'second').evaluate(button => (button as HTMLButtonElement).click());
    expect(await calls(page, recipeMethod)).toEqual([{ method: recipeMethod, args: { flow_id: 'first' } }]);
    await release(page, recipeMethod);
    await expect(page.locator('[data-recued-learning-flow-error="first"]')).toContainText('could not be made');
    await expect(action(page, 'recipe')).toBeFocused();
    await page.evaluate(() => { window.__privacyFlows.failRecipe = false; });
    await action(page, 'recipe').press('Enter'); await release(page, recipeMethod);
    await expect(page.locator('[data-recued-learning-flow-error="first"]')).toContainText('no longer available');
    await expect(action(page, 'recipe')).toBeFocused();
  });

  test(`Settings Learning kept-step replies respect focus moved outside at ${width}px`, async ({ page }) => {
    await open(page, width);
    await press(action(page, 'recipe')); await outside(page).focus(); await release(page, recipeMethod);
    await expect(page.locator('[data-recued-learning-flow-error="first"]')).toBeVisible();
    await expect(outside(page)).toBeFocused();
  });

  test(`Settings Learning kept-step Forget retains confirmation and the next saved row at ${width}px`, async ({ page }) => {
    await open(page, width);
    await press(action(page, 'forget'));
    await expect(action(page, 'forget')).toHaveText('Tap again to forget');
    await expect(action(page, 'forget')).toBeFocused(); expect(await calls(page, forgetMethod)).toEqual([]);
    await action(page, 'forget').press('Enter');
    await expect(action(page, 'forget')).toHaveText('Forgetting…');
    await expect(action(page, 'recipe')).toHaveText('Make a recipe');
    await expect(action(page, 'forget')).toHaveAttribute('aria-busy', 'true');
    await expect(action(page, 'forget')).toBeFocused();
    await release(page, forgetMethod);
    await expect(page.locator('[data-recued-learning-flow-error="first"]')).toContainText('could not be forgotten');
    await expect(action(page, 'forget')).toBeFocused();
    await page.evaluate(method => { window.__privacyFlows.failForget = false; window.__app.holdRpcResponses?.(method); }, historyMethod);
    await action(page, 'forget').press('Enter'); await release(page, forgetMethod);
    await expect.poll(() => calls(page, historyMethod)).toHaveLength(2);
    await expect(action(page, 'forget')).toBeFocused(); await release(page, historyMethod);
    await expect(action(page, 'forget', 'second')).toBeFocused(); await expect(action(page, 'forget')).toHaveCount(0);
    expect(await calls(page, forgetMethod)).toHaveLength(2);
  });

  test(`Settings Learning kept-step Forget recovers a failed history check into the empty list at ${width}px`, async ({ page }) => {
    await open(page, width, 1);
    await page.evaluate(method => { window.__privacyFlows.failForget = false; window.__privacyFlows.failRead = true; window.__app.holdRpcResponses?.(method); }, historyMethod);
    await press(action(page, 'forget')); await action(page, 'forget').press('Enter'); await release(page, forgetMethod);
    await expect.poll(() => calls(page, historyMethod)).toHaveLength(2); await release(page, historyMethod);
    await expect(retry(page)).toBeFocused(); await expect(page.locator('[data-recued-learning-cases-empty]')).toHaveCount(0);
    await retry(page).press('Enter'); await release(page, historyMethod);
    await expect(page.locator('[data-recued-learning-cases-empty]')).toBeFocused();
    expect(await calls(page, forgetMethod)).toEqual([{ method: forgetMethod, args: { flow_id: 'first' } }]);
  });
}
