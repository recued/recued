import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { createApprovalWinnerFixture, WINNER_ASK } from '../../../backend/server/src/__tests__/approval-winner-fixture.js';

test.use({ javaScriptEnabled: false });
const start = async () => {
  const fixture = await createApprovalWinnerFixture();
  const server = createServer((req, res) => { void Promise.resolve(fixture.handler(req, res)).catch(() => { res.statusCode = 503; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No ask listener');
  return { fixture, url: `http://127.0.0.1:${address.port}/ask/${WINNER_ASK}?via=telegram`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); fixture.close(); } };
};
const pressApprove = async (page: Page) => {
  await page.getByRole('button', { name: 'Approve', exact: true }).focus(); await page.keyboard.press('Enter');
};

test('two valid forms release only the first decision and its edited checkpoint', async ({ page, context }) => {
  const f = await start(), gate = f.fixture.stallCheckpointWrite();
  try {
    const other = await context.newPage();
    await page.goto(f.url); await other.goto(f.url.replace('via=telegram', 'via=slack'));
    await page.locator('[name="edit.title"]').fill('Winner A'); await other.locator('[name="edit.title"]').fill('Losing B');
    const first = page.waitForNavigation({ waitUntil: 'load' }); await pressApprove(page); await gate.entered;
    const second = other.waitForNavigation({ waitUntil: 'load' }); await pressApprove(other);
    expect((await second)?.status()).toBe(200); gate.release(); expect((await first)?.status()).toBe(200);
    expect(f.fixture.resumes.map(c => c.arg_overrides)).toStrictEqual([{ title: 'Winner A' }]);
    expect((await f.fixture.ask())?.answered_via).toBe('telegram');
    expect(f.fixture.activities().filter(row => row.target === 'cp-1')).toHaveLength(1);
    await expect(other.locator('.recorded')).toHaveText('Response recorded: Approve via telegram');
  } finally { gate.release(); await f.close(); }
});

test('a decision accepted during shutdown replays its exact edit after reopening SQLite', async ({ page }) => {
  const f = await start();
  try {
    f.fixture.block.beginStopping(); await page.goto(f.url); await page.locator('[name="edit.title"]').fill('Saved winner');
    const accepted = page.waitForNavigation({ waitUntil: 'load' }); await pressApprove(page); expect((await accepted)?.status()).toBe(200);
    expect(f.fixture.resumes).toHaveLength(0); expect((await f.fixture.checkpoints.get('cp-1'))?.arg_overrides).toBeUndefined();
    await f.fixture.restart(); await page.goto(f.url);
    expect(f.fixture.resumes.map(c => c.arg_overrides)).toStrictEqual([{ title: 'Saved winner' }]);
    expect(f.fixture.activities().filter(row => row.target === 'cp-1')).toHaveLength(1);
    await expect(page.locator('.recorded')).toHaveText('Response recorded: Approve via telegram');
  } finally { await f.close(); }
});

test('a plain channel denial wins against an edited form waiting on held details', async ({ page }) => {
  const f = await start();
  let gate: ReturnType<typeof f.fixture.stallLookup> | undefined;
  try {
    await page.goto(f.url); await page.locator('[name="edit.title"]').fill('Losing edit'); gate = f.fixture.stallLookup();
    const completed = page.waitForNavigation({ waitUntil: 'load' }); await pressApprove(page); await gate.entered;
    expect(await f.fixture.plainAnswer('deny')).toBe('answered'); gate.release(); expect((await completed)?.status()).toBe(200);
    expect(f.fixture.resumes).toHaveLength(0); expect(f.fixture.denials[0]?.arg_overrides).toBeUndefined();
    expect(f.fixture.activities().filter(row => row.target === 'cp-1')).toHaveLength(0);
    await expect(page.locator('.recorded')).toHaveText('Response recorded: Deny via ui');
  } finally { gate?.release(); await f.close(); }
});
