import { expect, test, type Page } from '@playwright/test';
import type { DiagnosticRequest, DiagnosticResponse } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

type Outcome = 'reachable' | 'blocked' | 'error';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface ConnectionCheckFixture {
  reads: string[];
  writes: unknown[];
  releasePorts(port: number): void;
}
declare global { interface Window { __connectionCheck: ConnectionCheckFixture } }

const panel = (page: Page) => page.locator('[data-recued-connect-device-panel]');
const check = (page: Page) => panel(page).locator('[data-recued-connect-device-check]');
const status = (page: Page) => panel(page).locator('[data-recued-connect-device-check-status]');
const address = (page: Page) => panel(page).locator('[data-recued-connect-device-place="this_computer"] a');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside connection settings', exact: true });
let unexpectedRequests: string[] = [];

installFullAppHooks();
test.beforeEach(() => { unexpectedRequests = []; });
test.afterEach(async ({ page }) => {
  expect(unexpectedRequests).toEqual([]);
  expect(await page.evaluate(() => window.__connectionCheck?.writes ?? [])).toEqual([]);
});

const open = async (page: Page, width: number, opts: { delayedPorts?: boolean; here?: boolean } = {}) => {
  const requests: DiagnosticRequest[] = [];
  const waiting: Array<(outcome: Outcome) => void> = [];
  const hereRequests: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(HARNESS_URL).origin) return route.continue();
    if (url.hostname === 'probe.recued.com' && url.pathname === '/v1/diagnostics/probe') {
      const request = route.request().postDataJSON() as DiagnosticRequest;
      requests.push(request);
      const outcome = await new Promise<Outcome>(resolve => { waiting.push(resolve); });
      const data: DiagnosticResponse = {
        account_id: request.account_id, hostname: request.hostname,
        detected_public_ip: '203.0.113.5', resolved_ips: ['203.0.113.5'], probed_at: Date.now(),
        results: [{ kind: 'port_reachability', status: outcome === 'reachable' ? 'pass' : 'fail',
          payload: { kind: 'port_reachability', port: 443, outcome: outcome === 'reachable' ? 'reachable' : 'blocked' } }],
      };
      return route.fulfill({
        status: outcome === 'error' ? 503 : 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(outcome === 'error'
          ? { error: { code: 'diagnostic_rate_limited', message: 'Fixture check unavailable.' } } : { data }),
      });
    }
    if (url.hostname === 'home.example.test' && url.pathname === '/webclient/' && opts.here !== undefined) {
      hereRequests.push(route.request().method());
      return opts.here ? route.fulfill({ status: 200, body: 'Local address fixture' }) : route.abort();
    }
    unexpectedRequests.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(options => {
    let releasePorts: ((reply: Reply) => void) | undefined;
    const ports = new Promise<Reply>(resolve => { releasePorts = resolve; });
    const fixture: ConnectionCheckFixture = {
      reads: [], writes: [],
      releasePorts: port => { releasePorts!({ result: { urls: [], lan_port: 7717, public_port: port } }); },
    };
    Object.assign(window, {
      __connectionCheck: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        fixture.reads.push(method);
        if (method === 'network.local_urls') return options.delayedPorts ? ports
          : { result: { urls: [], lan_port: 7717, public_port: 443 } };
        if (method === 'network.port_mapping') return { result: { enabled: false, support: 'unsupported' } };
        if (method === 'tls_domain.list') return { result: { entries: options.here === undefined ? []
          : [{ domain: 'home.example.test', expires_at: Date.now() + 3_600_000 }] } };
        if (method === 'server.setConfigField') fixture.writes.push(args);
        return undefined;
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside connection settings';
    document.body.appendChild(button);
    window.__app.setHash('#settings/server/connect-device');
  }, opts);
  await expect(check(page)).toBeVisible();
  await page.waitForFunction(() => ['network.local_urls', 'network.port_mapping', 'tls_domain.list']
    .every(method => window.__connectionCheck.reads.includes(method)));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { requests, hereRequests, pending: () => waiting.length, release: (outcome: Outcome) => {
    const next = waiting.shift();
    expect(next).toBeDefined();
    next!(outcome);
  } };
};

const activate = async (page: Page) => {
  await check(page).focus();
  await page.keyboard.press('Enter');
  await expect(check(page)).toBeDisabled();
  await expect(check(page)).toHaveAttribute('aria-busy', 'true');
  await expect(status(page)).toHaveText('Checking your connection…');
  await expect(status(page)).toHaveAttribute('role', 'status');
  await expect(status(page)).toBeFocused();
  await expect(status(page)).toBeInViewport();
};
const expectResult = async (page: Page, outcome: Outcome) => {
  await expect(check(page)).toBeEnabled();
  if (outcome === 'error') {
    await expect(panel(page).getByRole('alert')).toHaveText('That check could not run just now. Try again in a minute.');
    await expect(status(page)).toHaveCount(0);
  } else {
    await expect(status(page)).toHaveText('Check finished. See the results above.');
    await expect(status(page)).toHaveAttribute('role', 'status');
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect(check(page)).toHaveText('Check again');
  }
};

for (const width of [390, 1280]) {
  for (const outcome of ['reachable', 'error'] as const) {
    for (const owner of ['check', 'outside', 'address'] as const) {
      test(`connection ${outcome} retains ${owner} focus at ${width}px`, async ({ page }, info) => {
        const fixture = await open(page, width);
        const old = await check(page).elementHandle();
        await activate(page);
        await expect.poll(fixture.pending).toBe(1);
        // Old and disabled nodes cannot launch a second probe during a check.
        await old!.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
        await page.keyboard.press('Enter');
        expect(fixture.requests).toHaveLength(1);
        if (owner === 'outside') await outside(page).focus();
        else if (owner === 'address') await address(page).focus();
        if (owner === 'check' && outcome === 'error') await page.screenshot({ path: info.outputPath('checking.png') });
        fixture.release(outcome);
        await expectResult(page, outcome);
        const target = owner === 'outside' ? outside(page) : owner === 'address' ? address(page) : check(page);
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport();
        if (owner === 'check' && outcome === 'error') await page.screenshot({ path: info.outputPath('failed.png') });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({ ports: [443], checks: ['port_reachability'] });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  }

  test(`connection failure can be retried with the keyboard at ${width}px`, async ({ page }) => {
    const fixture = await open(page, width);
    await activate(page);
    await expect.poll(fixture.pending).toBe(1);
    fixture.release('error');
    await expectResult(page, 'error');
    await expect(check(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status(page)).toBeFocused();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect.poll(fixture.pending).toBe(1);
    fixture.release('blocked');
    await expectResult(page, 'blocked');
    await expect(check(page)).toBeFocused();
    await expect(panel(page).locator('[data-recued-connect-device-step-key="router"]'))
      .toHaveAttribute('data-recued-connect-device-step-done', 'false');
    expect(fixture.requests).toHaveLength(2);
  });

  test(`late port reads preserve the active check control at ${width}px`, async ({ page }) => {
    const fixture = await open(page, width, { delayedPorts: true });
    await activate(page);
    await expect.poll(fixture.pending).toBe(1);
    await page.evaluate(() => window.__connectionCheck.releasePorts(443));
    await expect(status(page)).toBeFocused();
    fixture.release('reachable');
    await expectResult(page, 'reachable');
    await expect(check(page)).toBeFocused();
  });

  test(`a removed check capability leaves a focused result at ${width}px`, async ({ page }) => {
    const fixture = await open(page, width, { delayedPorts: true });
    await activate(page);
    await expect.poll(fixture.pending).toBe(1);
    await page.evaluate(() => window.__connectionCheck.releasePorts(8443));
    await expect(panel(page).locator('[data-recued-connect-device-place="other_devices"]')).toContainText('8443');
    await expect(status(page)).toBeFocused();
    fixture.release('reachable');
    await expect(check(page)).toHaveCount(0);
    await expect(status(page)).toHaveText('Check finished. See the results above.');
    await expect(status(page)).toBeFocused();
    await expect(status(page)).toBeInViewport();
  });

  for (const here of [true, false]) {
    test(`a partial connection answer (${here}) survives a failed outside probe at ${width}px`, async ({ page }) => {
      const fixture = await open(page, width, { here });
      await expect(panel(page).locator('[data-recued-connect-device-place="other_devices"] a')).toHaveCount(1);
      await activate(page);
      await expect.poll(fixture.pending).toBe(1);
      await expect.poll(() => fixture.hereRequests.length).toBe(1);
      fixture.release('error');
      await expectResult(page, 'blocked');
      await expect(check(page)).toBeFocused();
      const note = panel(page).locator('[data-recued-connect-device-place="other_devices"] [data-recued-connect-device-note]');
      await expect(note).toContainText(here ? 'This device reached that address' : 'This device could not reach that address');
      expect(fixture.hereRequests).toEqual(['GET']);
    });
  }

  test(`a connection answer cannot reclaim focus after route disposal at ${width}px`, async ({ page }) => {
    const fixture = await open(page, width);
    await activate(page);
    await expect.poll(fixture.pending).toBe(1);
    const reads = await page.evaluate(() => window.__app.rpcCallCount('network.port_mapping'));
    await page.evaluate(() => window.__app.setHash('#yours'));
    await expect(panel(page)).toHaveCount(0);
    await outside(page).focus();
    const response = page.waitForResponse(result => result.url().includes('/v1/diagnostics/probe'));
    fixture.release('error');
    // Let the intercepted response and its finally/refresh callbacks drain.
    await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(outside(page)).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('network.port_mapping'))).toBe(reads);
  });
}
