import { expect, test, type Page } from '@playwright/test';
import type { McpInboundTokenRecord } from '@recued/contracts';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

declare global {
  interface Window {
    __keyFixture: {
      tokens: McpInboundTokenRecord[];
      next: number;
      failReads: number;
      readMessage: string;
      writeOutcome: 'ok' | 'refuse' | 'lost';
      copyMode: 'ok' | 'refuse' | 'hold' | 'missing' | 'throw';
      clipboard: string[];
      completeCopy?: () => void;
      cursor: number;
      calls: Array<{ method: string; args?: unknown }>;
    };
  }
}

const panel = (page: Page) => page.locator('[data-recued-contract-key]');
const control = (page: Page, name: string) => panel(page).locator('[data-recued-contract-key-' + name + ']');
const calls = (page: Page, method: string) => page.evaluate(name => window.__keyFixture.calls.filter(call => call.method === name), method);
const drain = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const open = async (page: Page, options: { active?: boolean; failRead?: boolean } = {}): Promise<void> => {
  await page.addInitScript(opts => {
    const now = 1_700_000_000_000;
    const contract = { contract_id: 'door_paged_01', minted_at: now, minted_by: 'user', display_name: 'Fixture AI agreement',
      scope: {}, lifecycle_state: 'active', key_authority: 'contract' };
    const makeToken = (number: number): McpInboundTokenRecord => ({
      token_id: 'fixture-token-' + number, bearer_hash: 'fixture-hash-' + number, label: contract.display_name,
      created_at: now + number, revoked_at: null, grants: {}, concurrency_tier: 5, chat_mode: null,
      contract_id: contract.contract_id, updated_at: now + number,
    });
    const state: Window['__keyFixture'] = window.__keyFixture = {
      tokens: opts.active ? [makeToken(1)] : [], next: opts.active ? 2 : 1,
      failReads: opts.failRead ? 1 : 0, readMessage: 'Key list temporarily unavailable.',
      writeOutcome: 'ok', copyMode: 'ok', clipboard: [], cursor: 10_000, calls: [],
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get() {
      if (state.copyMode === 'throw') throw new Error('private-clipboard-detail');
      if (state.copyMode === 'missing') return undefined;
      return { writeText(text: string) {
        state.clipboard.push(text);
        if (state.copyMode === 'refuse') return Promise.reject(new Error('private-clipboard-detail'));
        if (state.copyMode === 'hold') return new Promise<void>(resolve => { state.completeCopy = resolve; });
        return Promise.resolve();
      } };
    } });
    window.__connectionsFixture = async (method, raw) => {
      if (method === 'collection.contract.listContracts') return { result: { contracts: [contract], total: 1, next_cursor: null } };
      if (!method.startsWith('chat.inbound_token.')) return undefined;
      state.calls.push({ method, args: raw });
      if (method === 'chat.inbound_token.list') {
        if (state.failReads > 0) { state.failReads--; return { error: { code: 'fixture_key_unavailable', message: state.readMessage } }; }
        return { result: { tokens: structuredClone(state.tokens) } };
      }
      const outcome = state.writeOutcome; state.writeOutcome = 'ok';
      if (outcome === 'refuse') return { error: { code: 'fixture_refused', message: 'Request refused.' } };
      let result: unknown;
      if (method === 'chat.inbound_token.issue') {
        const number = state.next++, record = makeToken(number);
        state.tokens.push(record); result = { record, bearer_plaintext: 'fixture-only-key-' + number };
      } else if (method === 'chat.inbound_token.revoke') {
        const args = raw as { token_id: string };
        state.tokens = state.tokens.map(token => token.token_id === args.token_id ? { ...token, revoked_at: now + 100 } : token);
        result = { revoked: true, token: state.tokens.find(token => token.token_id === args.token_id) };
      }
      if (outcome === 'lost') return { error: { code: 'fixture_lost', message: 'The reply was lost.' } };
      return { result };
    };
  }, options);
  await page.goto(HARNESS_ORIGIN + '/full-app-harness.html?contracts=paged#contracts/door_paged_01/connect');
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
};
const create = async (page: Page, number = 1): Promise<void> => {
  await control(page, 'create').click();
  await expect(control(page, 'value')).toHaveText('fixture-only-key-' + number);
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
};
const refresh = async (page: Page): Promise<void> => {
  const before = (await calls(page, 'chat.inbound_token.list')).length;
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.inbound_token_changed', token_id: 'fixture-token-1', cursor: ++window.__keyFixture.cursor,
  } }));
  await expect.poll(async () => (await calls(page, 'chat.inbound_token.list')).length).toBeGreaterThan(before);
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
};
let errors: string[] = [], dialogs: string[] = [], popups: string[] = [];
let allowedLeavePrompt: string | null = null;
test.beforeEach(({ page }) => {
  errors = []; dialogs = []; popups = []; allowedLeavePrompt = null;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    if (dialog.message() === allowedLeavePrompt) void dialog.accept(); else void dialog.dismiss();
  });
  page.on('popup', popup => { popups.push(popup.url()); void popup.close(); });
});
test.afterEach(() => {
  expect(errors, 'browser errors').toEqual([]);
  expect(dialogs, 'only the existing route-leave prompt when requested').toEqual(allowedLeavePrompt === null ? [] : [allowedLeavePrompt]);
  expect(popups, 'popups').toEqual([]);
});

test('key lookup recovers from detailed and empty errors with a read-only single-flight Retry', async ({ page }) => {
  await open(page, { failRead: true });
  await expect(panel(page).getByRole('alert')).toContainText('Key list temporarily unavailable.');
  await page.evaluate(() => { window.__keyFixture.failReads = 1; window.__keyFixture.readMessage = ''; });
  await control(page, 'retry').click();
  await expect(panel(page).getByRole('alert')).toContainText('Could not check this contract’s key');
  await page.evaluate(() => window.__app.holdRpcResponses?.('chat.inbound_token.list'));
  await control(page, 'retry').focus(); await control(page, 'retry').press('Enter');
  await expect(control(page, 'retry')).toHaveText('Checking…'); await expect(control(page, 'retry')).toBeFocused();
  await control(page, 'retry').dispatchEvent('click'); await control(page, 'retry').press('Enter');
  expect((await calls(page, 'chat.inbound_token.list')).length).toBe(3);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.inbound_token.list'))).toBe(1);
  await expect(control(page, 'create')).toBeFocused(); await expect(panel(page).getByRole('alert')).toHaveCount(0);
  expect(await calls(page, 'chat.inbound_token.issue')).toEqual([]); expect(await calls(page, 'chat.inbound_token.revoke')).toEqual([]);
});

test('keyboard creation, copying and turn-off retain focus and guard duplicate commands', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__keyFixture.failReads = 1; window.__app.holdRpcResponses?.('chat.inbound_token.issue'); });
  await control(page, 'create').focus(); await control(page, 'create').press('Enter');
  await expect(control(page, 'create')).toHaveText('Creating…'); await expect(control(page, 'create')).toBeFocused();
  await control(page, 'create').dispatchEvent('click'); await control(page, 'create').press('Enter');
  expect((await calls(page, 'chat.inbound_token.issue')).length).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.inbound_token.issue'))).toBe(1);
  await expect(control(page, 'value')).toHaveText('fixture-only-key-1'); await expect(control(page, 'copy')).toBeFocused();
  await expect(panel(page)).toContainText('Showing the last confirmed key state');
  await control(page, 'retry').click(); await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => { window.__keyFixture.copyMode = 'hold'; });
  await control(page, 'copy').focus(); await control(page, 'copy').press('Enter');
  await expect(control(page, 'copy')).toHaveText('Copying…'); await expect(control(page, 'copy')).toBeFocused();
  await control(page, 'copy').dispatchEvent('click'); await control(page, 'copy').press('Enter');
  expect(await page.evaluate(() => window.__keyFixture.clipboard)).toEqual(['fixture-only-key-1']);
  await control(page, 'turn-off').focus();
  await page.evaluate(() => window.__keyFixture.completeCopy?.()); await expect(control(page, 'copy')).toHaveText('Copied');
  await expect(control(page, 'turn-off')).toBeFocused();
  await control(page, 'turn-off').press('Enter'); await expect(control(page, 'confirm')).toBeFocused();
  await control(page, 'cancel').focus(); await control(page, 'cancel').press('Enter'); await expect(control(page, 'turn-off')).toBeFocused();
  await control(page, 'turn-off').press('Enter');
  await page.evaluate(() => window.__app.holdRpcResponses?.('chat.inbound_token.revoke'));
  await control(page, 'confirm').press('Enter'); await expect(control(page, 'confirm')).toHaveText('Turning off…');
  await expect(control(page, 'confirm')).toBeFocused(); await control(page, 'confirm').dispatchEvent('click'); await control(page, 'confirm').press('Enter');
  expect((await calls(page, 'chat.inbound_token.revoke')).length).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.inbound_token.revoke'))).toBe(1);
  await expect(control(page, 'create')).toBeFocused(); await expect(panel(page)).toContainText('Key turned off.');
  await expect(control(page, 'value')).toHaveCount(0);
});

test('clipboard denial, absence and a throwing getter explain manual copying and keep selection through refresh', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await open(page); await create(page);
  for (const mode of ['refuse', 'missing', 'throw'] as const) {
    await page.evaluate(value => { window.__keyFixture.copyMode = value; }, mode);
    await control(page, 'copy').focus(); await control(page, 'copy').press('Enter');
    await expect(control(page, 'copy-status')).toContainText('copy it manually');
    await expect(control(page, 'copy')).toBeFocused(); await expect(control(page, 'value')).toHaveText('fixture-only-key-1');
    await expect(panel(page)).not.toContainText('private-clipboard-detail');
  }
  await control(page, 'value').evaluate(node => { const text = node.firstChild!; getSelection()!.setBaseAndExtent(text, 9, text, 2); });
  const selected = await page.evaluate(() => getSelection()!.toString());
  await refresh(page);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(selected);
  await control(page, 'copy').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('key-manual-copy-phone.png') });
  await page.evaluate(() => { window.__keyFixture.copyMode = 'ok'; });
  await control(page, 'copy').click(); await expect(control(page, 'copy-status')).toHaveText('Key copied.');
  expect(await page.evaluate(() => window.__keyFixture.clipboard)).toEqual(['fixture-only-key-1', 'fixture-only-key-1']);
});

test('an old clipboard response cannot label a replacement key Copied', async ({ page }) => {
  await open(page); await create(page);
  await page.evaluate(() => { window.__keyFixture.copyMode = 'hold'; });
  await control(page, 'copy').click();
  await control(page, 'turn-off').click(); await control(page, 'confirm').click(); await expect(control(page, 'create')).toBeEnabled();
  await create(page, 2); await page.evaluate(() => window.__keyFixture.completeCopy?.()); await drain(page);
  await expect(control(page, 'copy')).toHaveText('Copy'); await expect(control(page, 'copy-status')).toHaveCount(0);
  expect(await page.evaluate(() => window.__keyFixture.clipboard)).toEqual(['fixture-only-key-1']);
  await page.evaluate(() => { window.__keyFixture.copyMode = 'ok'; });
  await control(page, 'copy').click(); await expect(control(page, 'copy')).toHaveText('Copied');
  expect(await page.evaluate(() => window.__keyFixture.clipboard)).toEqual(['fixture-only-key-1', 'fixture-only-key-2']);
});

test('a changed saved key retires an armed turn-off confirmation', async ({ page }) => {
  await open(page, { active: true }); await control(page, 'turn-off').focus(); await control(page, 'turn-off').press('Enter');
  await expect(control(page, 'confirm')).toBeFocused();
  await page.evaluate(() => { window.__keyFixture.tokens = [{ ...window.__keyFixture.tokens[0]!, token_id: 'replacement' }]; });
  await refresh(page);
  await expect(control(page, 'confirm')).toHaveCount(0); await expect(control(page, 'turn-off')).toBeFocused();
  await expect(panel(page)).toContainText('The saved key changed.');
  expect(await calls(page, 'chat.inbound_token.revoke')).toEqual([]);
  await control(page, 'turn-off').press('Enter'); await control(page, 'confirm').press('Enter');
  expect((await calls(page, 'chat.inbound_token.revoke')).map(call => call.args)).toEqual([{ token_id: 'replacement' }]);
});

test('failed turn-off and refresh preserve the key and require a read before another explicit command', async ({ page }) => {
  await open(page, { active: true });
  await page.evaluate(() => { window.__keyFixture.writeOutcome = 'refuse'; window.__keyFixture.failReads = 1; });
  await control(page, 'turn-off').click(); await control(page, 'confirm').click();
  await expect(panel(page).getByRole('alert')).toContainText('Couldn’t confirm the key was turned off');
  await expect(panel(page)).toContainText('Showing the last confirmed key state');
  await expect(panel(page)).toHaveAttribute('data-state', 'active');
  await expect(control(page, 'turn-off')).toBeDisabled(); await control(page, 'turn-off').dispatchEvent('click');
  await control(page, 'retry').click(); await expect(control(page, 'turn-off')).toBeEnabled();
  expect((await calls(page, 'chat.inbound_token.revoke')).length).toBe(1);
  await control(page, 'turn-off').click(); await control(page, 'confirm').click(); await expect(panel(page)).toHaveAttribute('data-state', 'none');
  expect((await calls(page, 'chat.inbound_token.revoke')).length).toBe(2);
});

test('a confirmed turn-off remains off when its follow-up read fails', async ({ page }) => {
  await open(page, { active: true });
  await page.evaluate(() => { window.__keyFixture.failReads = 1; });
  await control(page, 'turn-off').click(); await control(page, 'confirm').click();
  await expect(panel(page)).toHaveAttribute('data-state', 'none'); await expect(panel(page)).toContainText('Key turned off.');
  await expect(control(page, 'create')).toBeDisabled(); await control(page, 'create').dispatchEvent('click');
  await control(page, 'retry').click(); await expect(control(page, 'create')).toBeEnabled();
  expect((await calls(page, 'chat.inbound_token.revoke')).length).toBe(1); expect(await calls(page, 'chat.inbound_token.issue')).toEqual([]);
});

test('a replacement created during turn-off is distinguished from the revoked key', async ({ page }) => {
  await open(page, { active: true });
  await page.evaluate(() => window.__app.holdRpcResponses?.('chat.inbound_token.revoke'));
  await control(page, 'turn-off').click(); await control(page, 'confirm').click();
  await expect.poll(async () => (await calls(page, 'chat.inbound_token.revoke')).length).toBe(1);
  await page.evaluate(() => {
    const prior = window.__keyFixture.tokens[0]!;
    window.__keyFixture.tokens.push({ ...prior, token_id: 'replacement', bearer_hash: 'replacement-hash',
      created_at: prior.created_at + 1000, revoked_at: null });
  });
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.inbound_token.revoke'))).toBe(1);
  await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
  await expect(panel(page)).toHaveAttribute('data-state', 'active');
  await expect(panel(page).getByRole('status')).toContainText('different key is now active');
  await expect(control(page, 'value')).toHaveCount(0);
  expect((await calls(page, 'chat.inbound_token.revoke')).map(call => call.args)).toEqual([{ token_id: 'fixture-token-1' }]);
  await control(page, 'turn-off').click(); await control(page, 'cancel').click(); await refresh(page);
  await expect(panel(page)).not.toContainText('The previous key was turned off');
});

test('lost creation and turn-off replies never replay writes or recover a one-time value', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__keyFixture.writeOutcome = 'lost'; });
  await control(page, 'create').click();
  await expect(panel(page)).toHaveAttribute('data-state', 'active');
  await expect(panel(page).getByRole('alert')).toContainText('Couldn’t confirm key creation');
  await expect(control(page, 'value')).toHaveCount(0); await expect(control(page, 'create')).toHaveCount(0);
  expect((await calls(page, 'chat.inbound_token.issue')).length).toBe(1);
  await page.evaluate(() => { window.__keyFixture.writeOutcome = 'lost'; window.__keyFixture.failReads = 1; });
  await control(page, 'turn-off').click(); await control(page, 'confirm').click();
  await expect(panel(page).getByRole('alert')).toContainText('Couldn’t confirm the key was turned off');
  await expect(panel(page)).not.toContainText('Key turned off.');
  await control(page, 'retry').click(); await expect(panel(page)).toHaveAttribute('data-state', 'none');
  await expect(control(page, 'create')).toBeEnabled();
  expect((await calls(page, 'chat.inbound_token.revoke')).length).toBe(1);
  expect((await calls(page, 'chat.inbound_token.issue')).length).toBe(1);
});

test('a late create reply leaves Chat and later one-time key visibility alone', async ({ page }) => {
  await open(page); await page.evaluate(() => window.__app.holdRpcResponses?.('chat.inbound_token.issue'));
  await control(page, 'create').click();
  await expect.poll(async () => (await calls(page, 'chat.inbound_token.issue')).length).toBe(1);
  allowedLeavePrompt = 'Something is still happening. Leave anyway?';
  await page.evaluate(() => window.__app.setHash('#chat'));
  const input = page.locator('[data-recued-chat-route-input]'); await input.fill('Keep this question');
  const reads = (await calls(page, 'chat.inbound_token.list')).length;
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.inbound_token.issue'))).toBe(1); await drain(page);
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Keep this question'); await expect(panel(page)).toHaveCount(0);
  expect((await calls(page, 'chat.inbound_token.list')).length).toBe(reads);
  await input.fill('');
  await page.evaluate(() => window.__app.setHash('#contracts/door_paged_01/connect'));
  await expect(panel(page)).toHaveAttribute('data-state', 'active'); await expect(control(page, 'value')).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage, sessionStorage].some(storage => Object.values(storage).some(value => value.includes('fixture-only-key-1'))))).toBe(false);
});

test('a clipboard completion after leaving cannot reclaim focus or expose its value on return', async ({ page }) => {
  await open(page); await create(page);
  await page.evaluate(() => { window.__keyFixture.copyMode = 'hold'; }); await control(page, 'copy').click();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const input = page.locator('[data-recued-chat-route-input]'); await input.fill('Keep this draft');
  await page.evaluate(() => window.__keyFixture.completeCopy?.()); await drain(page);
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Keep this draft'); await expect(panel(page)).toHaveCount(0);
  await input.fill('');
  await page.evaluate(() => window.__app.setHash('#contracts/door_paged_01/connect'));
  await expect(panel(page)).toHaveAttribute('data-state', 'active'); await expect(control(page, 'value')).toHaveCount(0);
  await expect(control(page, 'copy')).toHaveCount(0);
});
