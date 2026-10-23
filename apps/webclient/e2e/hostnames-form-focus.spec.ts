import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

type Mode = 'add' | 'update';
type FormMode = Mode | 'verify';
type Outcome = 'success' | 'error';
type BackgroundRead = { kind: 'local_urls' | 'ddns' | 'addresses'; outcome: Outcome };
type VerificationOutcome = Outcome | 'rejected' | 'unverified';
type Call = { method: string; args: unknown };
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface HostnamesFocusFixture {
  mutations: Call[];
  expectedMutations: Call[];
  probes: unknown[];
  expectedProbes: number;
  detailReads: string[];
  expectedDetailReads: string[];
  statusReads: string[];
  release(outcome: VerificationOutcome): void;
  releaseProbe(outcome: Outcome): void;
  releaseDetail(outcome: Outcome): void;
}
declare global { interface Window { __hostnamesFocus: HostnamesFocusFixture } }
const hostname = 'fixture.example.test';
const secondHostname = 'second.example.test';
const draftName = 'new.example.test';
const draftProof = 'synthetic-proof-draft';
const panel = (page: Page) => page.locator('[data-recued-hostnames-panel]');
const form = (page: Page, mode: FormMode) => panel(page).locator(`[data-recued-hostnames-${mode}-form]`);
const field = (page: Page, mode: FormMode, name: string) => form(page, mode).locator(`[data-recued-hostnames-${mode}-field="${name}"]`);
const port = (page: Page, mode: Mode, value: number) => field(page, mode, `listener_port_${value}`);
const options = (page: Page, mode: Mode, name: string) =>
  field(page, mode, name).locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value));
const tabKey = (browserName: string, backwards = false) =>
  `${browserName === 'webkit' ? 'Alt+' : ''}${backwards ? 'Shift+' : ''}Tab`;
let errors: string[] = [];
let externalRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = []; externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(HARNESS_URL).origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  const receipt = await page.evaluate(() => ({
    actual: window.__hostnamesFocus.mutations, expected: window.__hostnamesFocus.expectedMutations,
    probes: window.__hostnamesFocus.probes.length, expectedProbes: window.__hostnamesFocus.expectedProbes,
    detailReads: window.__hostnamesFocus.detailReads, expectedDetailReads: window.__hostnamesFocus.expectedDetailReads,
  }));
  expect(receipt.actual).toEqual(receipt.expected);
  expect(receipt.probes).toBe(receipt.expectedProbes);
  expect(receipt.detailReads).toEqual(receipt.expectedDetailReads);
});

const backgroundMethod = (kind: BackgroundRead['kind']) => kind === 'local_urls' ? 'network.local_urls'
  : kind === 'ddns' ? 'ddns.status' : 'collection.hostname.addressUses';
const open = async (page: Page, width: number, mode: Mode, opts: { draft?: boolean; write?: boolean; probe?: boolean; verify?: boolean; uploaded?: boolean; secondRow?: boolean; detail?: boolean; background?: BackgroundRead } = {}) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ hostname, secondHostname, mode, write, probe, verify, uploaded, secondRow, detail, background, heldMethod }) => {
    let pending: { method: string; args: Record<string, unknown>; resolve(reply: Reply): void } | null = null;
    let pendingProbe: ((response: Response) => void) | null = null;
    let pendingDetail: ((reply: Reply) => void) | null = null;
    const row = {
      hostname_id: 'fixture-host', hostname, cert_source: uploaded ? 'byo_uploaded' : 'byo_external', verification_method: uploaded ? 'cert_proof' : 'dns_txt',
      ownership_status: 'verified', listener_ports: [443], ddns_managed: false,
      enabled: true, tls_topology: 'server_terminated',
    };
    const rows = secondRow ? [row, { ...row, hostname_id: 'second-host', hostname: secondHostname }] : [row];
    const fixture: HostnamesFocusFixture = {
      mutations: [], expectedMutations: [], probes: [], expectedProbes: 0,
      detailReads: [], expectedDetailReads: [], statusReads: [],
      releaseDetail(outcome) {
        if (!pendingDetail) throw new Error('No pending synthetic hostname detail');
        const resolve = pendingDetail; pendingDetail = null;
        resolve(outcome === 'success' ? { result: { hostname: null } }
          : { error: { code: 'UNAVAILABLE', message: 'Synthetic hostname detail unavailable' } });
      },
      release(outcome) {
        if (!pending) throw new Error('No pending hostname write');
        const item = pending; pending = null;
        item.resolve(outcome === 'error'
          ? { error: { code: 'UNAVAILABLE', message: 'Synthetic hostname write unavailable' } }
          : item.method === 'collection.hostname.verifyOwnership'
            ? { result: outcome === 'rejected'
              ? { ok: false, hostname: item.args.hostname, method: item.args.method, code: 'method_mismatch', expected_method: 'dns_txt' }
              : { ok: true, hostname: item.args.hostname, method: item.args.method, status: outcome === 'unverified' ? 'failed' : 'verified',
                projection: { ...row, hostname: item.args.hostname, verification_method: item.args.method, ownership_status: outcome === 'unverified' ? 'failed' : 'verified' } } }
            : { result: { hostname: { ...row, ...item.args } } });
      },
      releaseProbe(outcome) {
        if (!pendingProbe) throw new Error('No pending synthetic hostname probe');
        const resolve = pendingProbe; pendingProbe = null;
        resolve(new Response(JSON.stringify(outcome === 'error'
          ? { error: { message: 'Synthetic probe unavailable' } }
          : { data: { account_id: 'fixture-account', hostname, detected_public_ip: '203.0.113.5',
            resolved_ips: ['203.0.113.5'], results: uploaded ? [{ kind: 'tls_handshake', status: 'pass', payload: {
              kind: 'tls_handshake', cert_valid: true, cert_matches_hostname: true, cert_expires_at: null, cert_issuer: null,
            } }] : [], probed_at: 1_700_000_000_000, observed_token_hash: 'synthetic-observed-proof' } }),
        { status: outcome === 'error' ? 503 : 200, headers: { 'Content-Type': 'application/json' } }));
      },
    };
    if (probe) {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === 'https://probe.recued.com/v1/diagnostics/probe' && init?.method === 'POST') {
          fixture.probes.push(JSON.parse(String(init.body)));
          return new Promise<Response>(resolve => { pendingProbe = resolve; });
        }
        return originalFetch(input, init);
      };
    }
    Object.assign(window, {
      __hostnamesFocus: fixture,
      __connectionsFixture: async (method: string, args: unknown) => {
        if (background && method === heldMethod) {
          fixture.statusReads.push(method);
          if (background.outcome === 'error') return { error: { code: 'UNAVAILABLE', message: 'Synthetic background status unavailable' } };
          if (background.kind === 'local_urls') return { result: { urls: [{ url: 'http://192.168.1.5:8443', kind: 'lan' }] } };
          if (background.kind === 'ddns') return { result: { enabled: false } };
          return { result: {
            uses: [{ use: 'reception', source: 'owner', hostname, base_url: `https://${hostname}` }],
            choices: [{ hostname, base_url: `https://${hostname}` }],
            links_now: { app: `https://${hostname}`, answers: `https://${hostname}` }, registered_webhooks: 0,
          } };
        }
        if (background?.kind === 'ddns' && method === 'pro_convenience.status') return { result: {
          entitlement: 'entitled', publisher_handle: 'fixture', ddns_hostname: 'fixture.recued.net',
          items: { handle: { state: 'active' }, ddns: { state: 'active' }, acme: { state: 'active' } },
        } };
        if (['collection.hostname.add', 'collection.hostname.update', 'collection.hostname.remove',
          'collection.hostname.verifyOwnership', 'collection.hostname.setAddressUse', 'ddns.setEnabled'].includes(method)) {
          fixture.mutations.push({ method, args });
          if (((write && method === `collection.hostname.${mode}`) || ((probe || verify) && method === 'collection.hostname.verifyOwnership')) && pending === null) {
            return new Promise<Reply>(resolve => { pending = { method, args: args as Record<string, unknown>, resolve }; });
          }
          return { error: { code: 'FORBIDDEN', message: 'Unexpected mutation in local focus fixture.' } };
        }
        if (method === 'collection.hostname.list') return { result: { hostnames: rows } };
        if (method === 'collection.hostname.get') {
          const name = (args as { hostname: string }).hostname; fixture.detailReads.push(name);
          if (detail && pendingDetail === null) return new Promise<Reply>(resolve => { pendingDetail = resolve; });
          return { result: { hostname: rows.find(item => item.hostname === name) ?? null } };
        }
        if (method === 'collection.hostname.addressUses' || method === 'pro_convenience.status') {
          return { error: { code: 'unknown_method', message: 'Optional read not present in fixture.' } };
        }
        if (method === 'network.local_urls') return { result: { urls: [] } };
        if (method === 'ddns.status') return { result: { enabled: false } };
        return undefined;
      },
    });
  }, { hostname, secondHostname, mode, write: opts.write === true, probe: opts.probe === true, verify: opts.verify === true,
    uploaded: opts.uploaded === true, secondRow: opts.secondRow === true, detail: opts.detail === true,
    background: opts.background, heldMethod: opts.background ? backgroundMethod(opts.background.kind) : null });
  const hold = opts.background ? `&hold_rpc=${backgroundMethod(opts.background.kind)}` : '';
  await page.goto(`${HARNESS_URL}?settle_reads=1&notifications=ready&yours=demo${hold}#settings/server/hostnames`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(panel(page).locator(`[data-recued-hostnames-row="${hostname}"]`)).toBeVisible();
  await (mode === 'add' ? panel(page).locator('[data-recued-hostnames-add-open]')
    : panel(page).locator(`[data-recued-hostnames-row="${hostname}"] [data-recued-hostnames-update-open]`)).click();
  await expect(form(page, mode)).toBeVisible();
  if (opts.draft !== false) {
    if (mode === 'add') await field(page, mode, 'hostname').fill(draftName);
    await field(page, mode, 'verification_token_hash').fill(draftProof);
  }
};
const expectDraft = async (page: Page, mode: Mode, proof = draftProof) => {
  if (mode === 'add') await expect(field(page, mode, 'hostname')).toHaveValue(draftName);
  await expect(field(page, mode, 'verification_token_hash')).toHaveValue(proof);
  await expect(field(page, mode, 'enabled')).toBeChecked();
};
const expectPorts = async (page: Page, mode: Mode, selected: number[]) => {
  await expect(form(page, mode).locator('[data-recued-hostnames-ports] input')).toHaveCount(4);
  for (const value of [443, 8446, 8447, 8448]) {
    await expect(port(page, mode, value)).toBeChecked({ checked: selected.includes(value) });
  }
};

const draftPrompt = 'Discard the unsaved hostname changes?';
const workPrompt = 'A hostname change is still in progress. Leave Settings anyway?';
const leave = (page: Page) => page.evaluate(() => window.__app.setHash('#yours/assets'));
const unload = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event); return event.defaultPrevented;
});
const selection = (page: Page, mode: Mode) => field(page, mode, 'verification_token_hash').evaluate(node => {
  const input = node as HTMLInputElement;
  return [input.selectionStart, input.selectionEnd, input.selectionDirection];
});
const expectWrite = async (page: Page, mode: Mode) => {
  await page.evaluate(({ mode, hostname, draftName, draftProof }) => window.__hostnamesFocus.expectedMutations.push({
    method: `collection.hostname.${mode}`,
    args: mode === 'add'
      ? { hostname: draftName, cert_source: 'byo_external', verification_method: 'dns_txt', verification_token_hash: draftProof, listener_ports: [443], enabled: true }
      : { hostname, verification_method: 'dns_txt', verification_token_hash: draftProof },
  }), { mode, hostname, draftName, draftProof });
};
const startWrite = async (page: Page, width: number, mode: Mode) => {
  await expectWrite(page, mode);
  const submit = form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`);
  await submit.focus(); await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
  await expect(submit).toBeDisabled();
  expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toEqual(await page.evaluate(() => window.__hostnamesFocus.expectedMutations));
};
const beginWrite = async (page: Page, width: number, mode: Mode) => {
  await open(page, width, mode, { write: true }); await startWrite(page, width, mode);
};

const verificationProof = (page: Page) => field(page, 'verify', 'observed_token_hash');
const verificationSelection = (page: Page) => verificationProof(page).evaluate(node => {
  const input = node as HTMLInputElement;
  return [input.selectionStart, input.selectionEnd, input.selectionDirection];
});
const openVerification = async (page: Page, width: number, opts: { uploaded?: boolean; verify?: boolean; probe?: boolean; secondRow?: boolean; detail?: boolean; background?: BackgroundRead } = {}) => {
  await open(page, width, 'update', { ...opts, draft: false });
  await form(page, 'update').locator('[data-recued-hostnames-update-cancel]').click();
  await panel(page).locator(`[data-recued-hostnames-row="${hostname}"] [data-recued-hostnames-verify-open]`).click();
  await expect(form(page, 'verify')).toBeVisible();
};
const manualProof = `  ${draftProof}  `;
const beginManualVerification = async (page: Page, width: number) => {
  await openVerification(page, width, { verify: true });
  await field(page, 'verify', 'method').selectOption('http_token');
  await verificationProof(page).fill(manualProof);
  await page.evaluate(({ hostname, draftProof }) => window.__hostnamesFocus.expectedMutations.push({
    method: 'collection.hostname.verifyOwnership', args: { hostname, method: 'http_token', observed_token_hash: draftProof },
  }), { hostname, draftProof });
  await form(page, 'verify').locator('[data-recued-hostnames-verify-submit]').focus();
  await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
  await expect(form(page, 'verify').locator('[data-recued-hostnames-verify-submit]')).toBeDisabled();
  expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toEqual(await page.evaluate(() => window.__hostnamesFocus.expectedMutations));
};

type EditorTarget = FormMode | 'detail' | 'remove';
const editorAction = (page: Page, target: EditorTarget, name = hostname) => target === 'add'
  ? panel(page).locator('[data-recued-hostnames-add-open]')
  : panel(page).locator(`[data-recued-hostnames-row="${name}"] [data-recued-hostnames-${target}-open]`);
const editorProof = (page: Page, mode: FormMode) => mode === 'verify' ? verificationProof(page) : field(page, mode, 'verification_token_hash');
const editorSelection = (page: Page, mode: FormMode) => mode === 'verify' ? verificationSelection(page) : selection(page, mode);
const openEditor = async (page: Page, width: number, mode: FormMode, opts: { secondRow?: boolean; detail?: boolean; background?: BackgroundRead } = {}) => {
  if (mode === 'verify') await openVerification(page, width, opts);
  else await open(page, width, mode, { ...opts, draft: false });
};
const activateEditor = async (page: Page, width: number, target: EditorTarget, name = hostname) => {
  await editorAction(page, target, name).focus(); await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
};
const expectEditor = async (page: Page, target: EditorTarget, name = hostname) => {
  if (target === 'detail') await expect(panel(page).locator(`[data-recued-hostnames-detail="${name}"]`)).toBeVisible();
  else if (target === 'remove') await expect(panel(page).locator(`[data-recued-hostnames-remove-confirm-panel="${name}"]`)).toBeVisible();
  else await expect(form(page, target)).toBeVisible();
};
const expectDetailRead = (page: Page, name = hostname) => page.evaluate(name => window.__hostnamesFocus.expectedDetailReads.push(name), name);

const feedbackError = (page: Page, mode: FormMode) => form(page, mode).locator('[data-recued-hostnames-error]:not([data-recued-hostnames-kept-warning])');
for (const width of [390, 1280]) {
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames feedback clears ${mode} validation while preserving native text editing at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode);
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).click();
      const error = feedbackError(page, mode); await expect(error).toHaveText(mode === 'add' ? 'You need to give a name.' : 'No changes to save.');
      const input = field(page, mode, mode === 'add' ? 'hostname' : 'verification_token_hash');
      const raw = mode === 'add' ? draftName : manualProof; const original = (await input.elementHandle())!;
      await input.focus(); await page.keyboard.type(raw); await expect(error).toHaveCount(0);
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await input.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
      expect(await input.evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd, (node as HTMLInputElement).selectionDirection])).toEqual([2, 6, 'backward']);
      await page.keyboard.press('ControlOrMeta+z'); const undone = await input.inputValue(); expect(undone).not.toBe(raw);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input).toHaveValue(raw); await expect(input).toBeFocused();
      expect(await unload(page)).toBe(true);
    });

    test(`Hostnames feedback clears ${mode} validation on a native Enabled change at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).click();
      await expect(feedbackError(page, mode)).toHaveCount(1);
      const checkbox = field(page, mode, 'enabled'); const original = (await checkbox.elementHandle())!;
      await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).not.toBeChecked();
      await expect(feedbackError(page, mode)).toHaveCount(0);
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true); expect(await unload(page)).toBe(true);
    });
  }

  test(`Hostnames feedback clears a missing Add proof while preserving the hostname and native Undo at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'add'); await field(page, 'add', 'hostname').fill(draftName);
    await form(page, 'add').locator('[data-recued-hostnames-add-submit]').click(); await expect(feedbackError(page, 'add')).toContainText('Proof code is required');
    const proof = editorProof(page, 'add'); const original = (await proof.elementHandle())!; await proof.focus(); await page.keyboard.type(manualProof);
    await expect(feedbackError(page, 'add')).toHaveCount(0); await expect(field(page, 'add', 'hostname')).toHaveValue(draftName);
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await page.keyboard.press('ControlOrMeta+z'); await expect(proof).not.toHaveValue(manualProof);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
  });

  for (const outcome of ['success', 'unverified', 'rejected', 'error'] as const) {
    test(`Hostnames feedback clears verification ${outcome} while editing a new proof at ${width}px`, async ({ page }) => {
      await beginManualVerification(page, width); await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
      const proof = verificationProof(page); await expect(proof).toBeEnabled();
      const message = outcome === 'success' || outcome === 'unverified'
        ? form(page, 'verify').locator('[data-recued-hostnames-status]') : feedbackError(page, 'verify');
      await expect(message).toHaveCount(1); const original = (await proof.elementHandle())!;
      await proof.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('new-proof-draft');
      await expect(message).toHaveCount(0); expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 5, 'backward'));
      expect(await verificationSelection(page)).toEqual([1, 5, 'backward']); expect(await unload(page)).toBe(true);
      await page.keyboard.press('ControlOrMeta+z'); await expect(proof).not.toHaveValue('new-proof-draft');
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue('new-proof-draft');
    });
  }

  test(`Hostnames feedback keeps a pending probe message then clears its error on a native certificate change at ${width}px`, async ({ page }) => {
    await openVerification(page, width, { uploaded: true, probe: true });
    await page.evaluate(() => { window.__hostnamesFocus.expectedProbes = 1; });
    await form(page, 'verify').locator('[data-recued-hostnames-verify-submit]').click();
    const progress = form(page, 'verify').locator('[data-recued-hostnames-verify-auto-probe-status]'); await expect(progress).toBeVisible();
    await expect(field(page, 'verify', 'cert_matches_hostname')).toBeDisabled();
    await page.evaluate(() => window.__hostnamesFocus.releaseProbe('error')); await expect(feedbackError(page, 'verify')).toHaveCount(1);
    const checkbox = field(page, 'verify', 'cert_matches_hostname'); const original = (await checkbox.elementHandle())!;
    await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).toBeChecked(); await expect(feedbackError(page, 'verify')).toHaveCount(0);
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true); expect(await unload(page)).toBe(true);
  });

  test(`Hostnames feedback keeps focus outside an editor when scripted input clears its message at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'update'); await form(page, 'update').locator('[data-recued-hostnames-update-submit]').click();
    await expect(feedbackError(page, 'update')).toHaveCount(1); const proof = editorProof(page, 'update'); const original = (await proof.elementHandle())!;
    const other = editorAction(page, 'detail'); await other.focus();
    await proof.evaluate((node, raw) => { const input = node as HTMLInputElement; input.value = raw; input.setSelectionRange(2, 6, 'backward'); input.dispatchEvent(new Event('input', { bubbles: true })); }, manualProof);
    await expect(feedbackError(page, 'update')).toHaveCount(0); await expect(other).toBeFocused();
    expect(await original.evaluate(node => node.isConnected)).toBe(true); expect(await editorSelection(page, 'update')).toEqual([2, 6, 'backward']); expect(await unload(page)).toBe(true);
  });

  test(`Hostnames feedback supports native edits and choices after clearing a message at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'add'); await form(page, 'add').locator('[data-recued-hostnames-add-submit]').click();
    await field(page, 'add', 'hostname').focus(); await page.keyboard.type(draftName); await expect(feedbackError(page, 'add')).toHaveCount(0);
    const method = field(page, 'add', 'method'); await method.focus(); await method.selectOption('http_token'); await expect(method).toBeFocused();
    const proof = editorProof(page, 'add'); const original = (await proof.elementHandle())!; await proof.focus(); await page.keyboard.type(manualProof);
    await expect(field(page, 'add', 'hostname')).toHaveValue(draftName); await expect(method).toHaveValue('http_token'); await expect(feedbackError(page, 'add')).toHaveCount(0);
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await page.keyboard.press('ControlOrMeta+z'); await expect(proof).not.toHaveValue(manualProof);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof); expect(await unload(page)).toBe(true);
  });

  for (const outcome of ['success', 'unverified'] as const) {
    test(`Hostnames feedback refreshes certificate ownership through probe and write ${outcome} at ${width}px`, async ({ page }) => {
      await openVerification(page, width, { uploaded: true, probe: true });
      await page.evaluate(hostname => { window.__hostnamesFocus.expectedProbes = 1; window.__hostnamesFocus.expectedMutations.push({
        method: 'collection.hostname.verifyOwnership', args: { hostname, method: 'cert_proof', cert_matches_hostname: true },
      }); }, hostname);
      await form(page, 'verify').locator('[data-recued-hostnames-verify-submit]').click();
      const retired = (await field(page, 'verify', 'cert_matches_hostname').elementHandle())!;
      await page.evaluate(() => window.__hostnamesFocus.releaseProbe('success'));
      await expect.poll(() => page.evaluate(() => window.__hostnamesFocus.mutations.length)).toBe(1);
      await expect(field(page, 'verify', 'cert_matches_hostname')).toBeChecked(); await expect(field(page, 'verify', 'cert_matches_hostname')).toBeDisabled();
      expect(await retired.evaluate(node => node.isConnected)).toBe(false);
      await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
      const checkbox = field(page, 'verify', 'cert_matches_hostname'); await expect(checkbox).toBeEnabled(); await expect(form(page, 'verify').locator('[data-recued-hostnames-status]')).toHaveCount(1);
      const original = (await checkbox.elementHandle())!; await checkbox.focus(); await page.keyboard.press('Space');
      await expect(checkbox).not.toBeChecked(); await expect(form(page, 'verify').locator('[data-recued-hostnames-status]')).toHaveCount(0);
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true); expect(await unload(page)).toBe(outcome === 'success');
    });
  }
}

const releaseBackground = async (page: Page, kind: BackgroundRead['kind']) => {
  // Hold completed transport replies rather than blocking the fixture handler:
  // several Settings consumers read the same optional status independently.
  const released = await page.evaluate(method => window.__app.releaseRpcResponses!(method), backgroundMethod(kind));
  expect(released).toBeGreaterThan(0);
  expect(released).toBe(await page.evaluate(() => window.__hostnamesFocus.statusReads.length));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

for (const width of [390, 1280]) {
  for (const mode of ['add', 'update', 'verify'] as const) {
    for (const kind of ['local_urls', 'ddns', 'addresses'] as const) {
      for (const outcome of ['success', 'error'] as const) {
        test(`Hostnames background status preserves native ${mode} editing after ${kind} ${outcome} at ${width}px`, async ({ page }) => {
          await openEditor(page, width, mode, { background: { kind, outcome } });
          const proof = editorProof(page, mode); await proof.focus(); await page.keyboard.type(manualProof);
          await page.keyboard.press('ControlOrMeta+z'); const undone = await proof.inputValue(); expect(undone).not.toBe(manualProof);
          await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
          await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
          const original = (await proof.elementHandle())!;
          await releaseBackground(page, kind);
          expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
          await expect(proof).toBeFocused(); await expect(proof).toHaveValue(manualProof);
          expect(await editorSelection(page, mode)).toEqual([2, 6, 'backward']);
          if (kind === 'local_urls') await expect(panel(page).locator('[data-recued-hostnames-local-urls]')).toHaveCount(outcome === 'success' ? 1 : 0);
          if (kind === 'ddns') await expect(panel(page).locator('[data-recued-hostnames-ddns-state="paused"]')).toHaveCount(outcome === 'success' ? 1 : 0);
          if (kind === 'addresses') {
            await expect(panel(page).locator('[data-recued-hostnames-addresses]')).toBeVisible();
            await expect(panel(page).locator('[data-recued-hostnames-address-error]')).toHaveCount(outcome === 'error' ? 1 : 0);
            if (mode === 'update') await expect(form(page, mode).locator('[data-recued-hostnames-kept-warning]')).toHaveCount(outcome === 'success' ? 1 : 0);
          }
          expect(await unload(page)).toBe(true);
          await page.keyboard.press('ControlOrMeta+z'); await expect(proof).toHaveValue(undone);
          await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
          const method = field(page, mode, 'method');
          await method.focus(); await method.selectOption('http_token'); await expect(method).toBeFocused();
          await expect(method).toHaveValue('http_token'); await expect(editorProof(page, mode)).toHaveValue(manualProof);
          await expect(form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`)).toBeEnabled();
        });
      }
    }
  }

  test(`Hostnames background status keeps focus outside the editor at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'update', { background: { kind: 'local_urls', outcome: 'success' } });
    const proof = editorProof(page, 'update'); await proof.focus(); await page.keyboard.type(manualProof);
    await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 5, 'backward'));
    const original = (await proof.elementHandle())!; const other = editorAction(page, 'detail'); await other.focus();
    await releaseBackground(page, 'local_urls');
    await expect(other).toBeFocused(); expect(await original.evaluate(node => node.isConnected)).toBe(true);
    expect(await editorSelection(page, 'update')).toEqual([1, 5, 'backward']);
    expect(await unload(page)).toBe(true);
    await proof.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(proof).not.toHaveValue(manualProof);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
    expect(await unload(page)).toBe(true);
  });

  test(`Hostnames background status retires the previous warning host on a row switch at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'update', { secondRow: true, background: { kind: 'addresses', outcome: 'success' } });
    const retired = (await form(page, 'update').elementHandle())!;
    await activateEditor(page, width, 'update', secondHostname);
    const proof = editorProof(page, 'update'); await proof.focus(); await page.keyboard.type(manualProof);
    const original = (await proof.elementHandle())!; await releaseBackground(page, 'addresses');
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await expect(form(page, 'update')).toHaveAttribute('data-recued-hostnames-update-form', secondHostname);
    await expect(form(page, 'update').locator('[data-recued-hostnames-kept-warning]')).toHaveCount(0);
    await expect(panel(page).locator('[data-recued-hostnames-address-status="reception"]')).toContainText(hostname);
    expect(await retired.evaluate(node => node.isConnected || node.querySelector('[data-recued-hostnames-kept-warning]') !== null)).toBe(false);
    await page.keyboard.press('ControlOrMeta+z'); await expect(proof).not.toHaveValue(manualProof);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
  });

  test(`Hostnames background status refreshes the current Remove warning without replacing its actions at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'update', { background: { kind: 'addresses', outcome: 'success' } });
    const retired = (await form(page, 'update').elementHandle())!; await activateEditor(page, width, 'remove');
    const confirmation = panel(page).locator('[data-recued-hostnames-remove-confirm-panel]');
    const cancel = confirmation.locator('[data-recued-hostnames-remove-cancel]'); await cancel.focus();
    const original = (await cancel.elementHandle())!; await releaseBackground(page, 'addresses');
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await expect(confirmation.locator('[data-recued-hostnames-kept-warning]')).toContainText('Removing it stops it');
    await expect(confirmation.locator('[data-recued-hostnames-remove-confirm]')).toBeEnabled();
    expect(await retired.evaluate(node => node.isConnected || node.querySelector('[data-recued-hostnames-kept-warning]') !== null)).toBe(false);
    expect(await unload(page)).toBe(false);
  });
}

for (const width of [390, 1280]) {
  for (const mode of ['add', 'update', 'verify'] as const) {
    for (const target of (['add', 'update', 'verify', 'detail', 'remove'] as const).filter(target => target !== mode)) {
      test(`Hostnames editor switches preserve ${mode} editing when ${target} is declined and discard only on acceptance at ${width}px`, async ({ page }) => {
        await openEditor(page, width, mode); const proof = editorProof(page, mode); await proof.focus(); await page.keyboard.type(manualProof);
        await page.keyboard.press('ControlOrMeta+z'); const undone = await proof.inputValue(); expect(undone).not.toBe(manualProof);
        await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
        await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
        const original = (await proof.elementHandle())!; const dialogs: string[] = []; let accept = false;
        page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
        await activateEditor(page, width, target); await expect.poll(() => dialogs).toEqual([draftPrompt]);
        await expect(form(page, mode)).toBeVisible(); await expect(proof).toHaveValue(manualProof);
        expect(await original.evaluate(node => node.isConnected)).toBe(true); expect(await editorSelection(page, mode)).toEqual([2, 6, 'backward']);
        await expect(editorAction(page, target)).toBeFocused(); expect(await unload(page)).toBe(true);
        expect(await page.evaluate(() => window.__hostnamesFocus.detailReads)).toEqual([]);
        await proof.focus(); await page.keyboard.press('ControlOrMeta+z'); await expect(proof).toHaveValue(undone);
        await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(manualProof);
        accept = true; if (target === 'detail') await expectDetailRead(page);
        await activateEditor(page, width, target); await expectEditor(page, target);
        expect(dialogs).toEqual([draftPrompt, draftPrompt]); expect(await original.evaluate(node => node.isConnected)).toBe(false);
        expect(await unload(page)).toBe(false); await editorAction(page, mode).click();
        await expect(editorProof(page, mode)).toHaveValue(''); expect(await unload(page)).toBe(false);
        expect(dialogs).toHaveLength(2);
      });
    }

    test(`Hostnames editor switches keep repeated ${mode} opens and restored drafts clean at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); const proof = editorProof(page, mode); await proof.fill(manualProof);
      await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 5, 'backward'));
      const original = (await proof.elementHandle())!; const dialogs: string[] = [];
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      if (mode === 'add') await expect(editorAction(page, mode)).toBeDisabled();
      else for (let i = 0; i < 2; i++) await activateEditor(page, width, mode);
      await expect(proof).toHaveValue(manualProof); expect(await original.evaluate(node => node.isConnected)).toBe(true);
      expect(await editorSelection(page, mode)).toEqual([1, 5, 'backward']); expect(await unload(page)).toBe(true);
      await proof.fill(''); expect(await unload(page)).toBe(false);
      const target = mode === 'add' ? 'update' : 'add'; await activateEditor(page, width, target); await expectEditor(page, target);
      expect(dialogs).toEqual([]); expect(await unload(page)).toBe(false);
    });
  }

  for (const mode of ['update', 'verify'] as const) {
    test(`Hostnames editor switches guard ${mode} changes between different hostname rows at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode, { secondRow: true }); const proof = editorProof(page, mode); await proof.fill(manualProof);
      const original = (await proof.elementHandle())!; const dialogs: string[] = []; let accept = false;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await activateEditor(page, width, mode, secondHostname); await expect.poll(() => dialogs).toEqual([draftPrompt]);
      await expect(form(page, mode)).toHaveAttribute(`data-recued-hostnames-${mode}-form`, hostname);
      await expect(proof).toHaveValue(manualProof); expect(await original.evaluate(node => node.isConnected)).toBe(true);
      accept = true; await activateEditor(page, width, mode, secondHostname);
      await expect(form(page, mode)).toHaveAttribute(`data-recued-hostnames-${mode}-form`, secondHostname);
      await expect(proof).toHaveValue(''); expect(await unload(page)).toBe(false); expect(dialogs).toEqual([draftPrompt, draftPrompt]);
    });
  }

  test(`Hostnames editor switches preserve a certificate checkbox and hidden proof on cancellation at ${width}px`, async ({ page }) => {
    await openVerification(page, width, { uploaded: true }); await field(page, 'verify', 'method').selectOption('dns_txt');
    await verificationProof(page).fill(manualProof); await field(page, 'verify', 'method').selectOption('cert_proof');
    const checkbox = field(page, 'verify', 'cert_matches_hostname'); await checkbox.check(); const original = (await checkbox.elementHandle())!;
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await activateEditor(page, width, 'update'); await expect.poll(() => dialogs).toEqual([draftPrompt]);
    await expect(checkbox).toBeChecked(); expect(await original.evaluate(node => node.isConnected)).toBe(true);
    await field(page, 'verify', 'method').selectOption('dns_txt'); await expect(verificationProof(page)).toHaveValue(manualProof);
    await form(page, 'verify').locator('[data-recued-hostnames-verify-cancel]').click(); expect(await unload(page)).toBe(false);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Hostnames editor switches ignore a late Details ${outcome} while editing a newer proof at ${width}px`, async ({ page }) => {
      await openEditor(page, width, 'add', { detail: true }); await editorProof(page, 'add').fill(manualProof);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
      await expectDetailRead(page); await activateEditor(page, width, 'detail'); await expectEditor(page, 'detail');
      await activateEditor(page, width, 'verify'); const proof = verificationProof(page); await proof.focus(); await page.keyboard.type('newer-proof');
      await page.keyboard.press('ControlOrMeta+z'); const undone = await proof.inputValue(); expect(undone).not.toBe('newer-proof');
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue('newer-proof');
      await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 5, 'backward'));
      const original = (await proof.elementHandle())!; await page.evaluate(outcome => window.__hostnamesFocus.releaseDetail(outcome), outcome);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(proof).toHaveValue('newer-proof'); await expect(proof).toBeFocused();
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await verificationSelection(page)).toEqual([1, 5, 'backward']); expect(await unload(page)).toBe(true);
      await page.keyboard.press('ControlOrMeta+z'); await expect(proof).toHaveValue(undone);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue('newer-proof');
      expect(dialogs).toEqual([draftPrompt]); await expect(panel(page).locator('[data-recued-hostnames-detail]')).toHaveCount(0);
    });
  }
}

for (const width of [390, 1280]) {
  for (const uploaded of [false, true]) {
    test(`Manual hostname verification keeps ${uploaded ? 'certificate' : 'external'} method focus and native traversal at ${width}px`, async ({ page, browserName }) => {
      await openVerification(page, width, { uploaded });
      const method = field(page, 'verify', 'method');
      if (uploaded) await method.selectOption('dns_txt');
      await verificationProof(page).fill(manualProof);
      await method.focus(); await method.selectOption('http_token');
      await expect(method).toBeFocused(); await expect(verificationProof(page)).toHaveValue(manualProof);
      await page.keyboard.press(tabKey(browserName)); await expect(verificationProof(page)).toBeFocused();
      await verificationProof(page).evaluate(node => {
        const input = node as HTMLInputElement; input.setSelectionRange(input.value.length, input.value.length);
      });
      await page.keyboard.type('-edited'); await expect(verificationProof(page)).toHaveValue(`${manualProof}-edited`);
      await page.keyboard.press(tabKey(browserName, true)); await expect(method).toBeFocused();
      if (uploaded) {
        await method.selectOption('cert_proof'); await expect(method).toBeFocused();
        await expect(verificationProof(page)).toHaveCount(0);
        await page.keyboard.press(tabKey(browserName));
        const certificate = field(page, 'verify', 'cert_matches_hostname'); await expect(certificate).toBeFocused();
        await page.keyboard.press('Space'); await expect(certificate).toBeChecked(); await expect(certificate).toBeFocused();
        await page.keyboard.press(tabKey(browserName, true)); await expect(method).toBeFocused();
      }
      await method.selectOption('dns_txt'); await expect(method).toBeFocused();
      await expect(verificationProof(page)).toHaveValue(`${manualProof}-edited`); expect(await unload(page)).toBe(true);
      const outside = page.locator('[data-recued-global-run-palette-trigger]'); await outside.focus();
      await method.evaluate(node => {
        (node as HTMLSelectElement).value = 'http_token'; node.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect(method).toHaveValue('http_token'); await expect(outside).toBeFocused();
      await expect(verificationProof(page)).toHaveValue(`${manualProof}-edited`);
    });
  }

  test(`Manual hostname verification preserves raw drafts and native editing on cancellation at ${width}px`, async ({ page }) => {
    await openVerification(page, width); const raw = `  ${draftProof}  `; const proof = verificationProof(page);
    await proof.focus(); await page.keyboard.type(raw);
    await page.keyboard.press('ControlOrMeta+z'); const undone = await proof.inputValue(); expect(undone).not.toBe(raw);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(raw);
    await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
    const original = (await proof.elementHandle())!; const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    expect(await unload(page)).toBe(true); await leave(page); await expect.poll(() => dialogs).toEqual([draftPrompt]);
    await expect(proof).toHaveValue(raw); await expect(proof).toBeFocused();
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await verificationSelection(page)).toEqual([2, 6, 'backward']);
    await page.keyboard.press('ControlOrMeta+z'); await expect(proof).toHaveValue(undone);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(raw);
    accept = true; await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
    await expect(form(page, 'verify')).toHaveCount(0); expect(await unload(page)).toBe(false);
    expect(dialogs).toEqual([draftPrompt, draftPrompt]);
  });

  test(`Manual hostname verification protects native reload and canceled selection at ${width}px`, async ({ page }) => {
    await openVerification(page, width); const proof = verificationProof(page); await proof.fill(draftProof); await proof.focus();
    await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 5, 'backward'));
    const original = (await proof.elementHandle())!; const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
    expect(await unload(page)).toBe(true); await page.evaluate(() => { location.reload(); });
    await expect.poll(() => dialogs).toEqual(['beforeunload']); await expect(proof).toHaveValue(draftProof); await expect(proof).toBeFocused();
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await verificationSelection(page)).toEqual([1, 5, 'backward']);
    accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(panel(page)).toBeVisible(); await expect(form(page, 'verify')).toHaveCount(0);
    expect(await unload(page)).toBe(false); expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  });

  for (const uploaded of [false, true]) {
    test(`Manual hostname verification keeps restored ${uploaded ? 'certificate' : 'external'} fields and canceled forms clean at ${width}px`, async ({ page }) => {
      await openVerification(page, width, { uploaded }); expect(await unload(page)).toBe(false);
      if (uploaded) {
        const checkbox = field(page, 'verify', 'cert_matches_hostname');
        await checkbox.check(); expect(await unload(page)).toBe(true);
        await checkbox.uncheck(); expect(await unload(page)).toBe(false);
        await field(page, 'verify', 'method').selectOption('dns_txt'); expect(await unload(page)).toBe(true);
        await verificationProof(page).fill(draftProof);
        await field(page, 'verify', 'method').selectOption('cert_proof');
        await expect(verificationProof(page)).toHaveCount(0); expect(await unload(page)).toBe(true);
        await field(page, 'verify', 'method').selectOption('dns_txt'); await verificationProof(page).fill('');
        await field(page, 'verify', 'method').selectOption('cert_proof'); expect(await unload(page)).toBe(false);
        await field(page, 'verify', 'cert_matches_hostname').check(); expect(await unload(page)).toBe(true);
      } else {
        await verificationProof(page).fill(' '); expect(await unload(page)).toBe(true);
        await verificationProof(page).fill(''); expect(await unload(page)).toBe(false);
        await field(page, 'verify', 'method').selectOption('http_token'); expect(await unload(page)).toBe(true);
        await field(page, 'verify', 'method').selectOption('dns_txt'); expect(await unload(page)).toBe(false);
        await verificationProof(page).fill(draftProof); expect(await unload(page)).toBe(true);
      }
      await form(page, 'verify').locator('[data-recued-hostnames-verify-cancel]').click();
      await expect(form(page, 'verify')).toHaveCount(0); expect(await unload(page)).toBe(false);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    });
  }

  test(`Manual hostname verification keeps seeded Add proofs clean until edited at ${width}px`, async ({ page }) => {
    await beginWrite(page, width, 'add'); await page.evaluate(() => window.__hostnamesFocus.release('success'));
    await expect(form(page, 'add')).toHaveCount(0); await expect(verificationProof(page)).toHaveValue(draftProof);
    expect(await unload(page)).toBe(false); await verificationProof(page).fill('changed-proof'); expect(await unload(page)).toBe(true);
    await verificationProof(page).fill(''); expect(await unload(page)).toBe(true);
    await verificationProof(page).fill(draftProof); expect(await unload(page)).toBe(false);
    await form(page, 'verify').locator('[data-recued-hostnames-verify-cancel]').click(); expect(await unload(page)).toBe(false);
    await panel(page).locator(`[data-recued-hostnames-row="${draftName}"] [data-recued-hostnames-verify-open]`).click();
    await expect(verificationProof(page)).toHaveValue(''); expect(await unload(page)).toBe(false);
  });

  test(`Manual hostname verification retains drafts across tabs and canceled Back/Forward at ${width}px`, async ({ page }) => {
    await openVerification(page, width); await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
    await panel(page).locator('[data-recued-hostnames-verify-open]').click(); await verificationProof(page).fill(draftProof);
    const original = (await verificationProof(page).elementHandle())!; const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.getByRole('tab', { name: 'Certificates', exact: true }).click(); expect(await unload(page)).toBe(true);
    await page.getByRole('tab', { name: 'Hostnames', exact: true }).click();
    await expect(verificationProof(page)).toHaveValue(draftProof); expect(dialogs).toEqual([]);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt);
      await expect(page).toHaveURL(/#settings\/server\/hostnames$/u); await expect(verificationProof(page)).toHaveValue(draftProof);
      expect(await original.evaluate(node => node.isConnected)).toBe(true);
    }
    accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.goForward(); await expect(form(page, 'verify')).toHaveCount(0); expect(await unload(page)).toBe(false);
    expect(dialogs).toEqual([draftPrompt, draftPrompt, draftPrompt]);
  });

  for (const outcome of ['success', 'unverified', 'rejected', 'error'] as const) {
    test(`Manual hostname verification guards pending work until ${outcome} and acknowledges verified values at ${width}px`, async ({ page }) => {
      await beginManualVerification(page, width); expect(await unload(page)).toBe(true);
      const dialogs: string[] = [];
      page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? 'beforeunload' : dialog.message()); void dialog.dismiss(); });
      await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt]);
      await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual([workPrompt, 'beforeunload']);
      await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
      if (outcome === 'success') {
        await expect(form(page, 'verify')).toContainText('You own it. Checked.'); expect(await unload(page)).toBe(false);
        await expect(verificationProof(page)).toHaveValue(manualProof);
        await verificationProof(page).fill(`${manualProof}!`); expect(await unload(page)).toBe(true);
        await verificationProof(page).fill(manualProof); expect(await unload(page)).toBe(false);
      } else {
        if (outcome === 'unverified') await expect(form(page, 'verify')).toContainText('Recued could not show that you own it.');
        else await expect(form(page, 'verify').getByRole('alert')).toContainText(outcome === 'rejected' ? 'Expected DNS TXT.' : 'Synthetic hostname write unavailable');
        await expect(verificationProof(page)).toHaveValue(manualProof); await expect(field(page, 'verify', 'method')).toHaveValue('http_token');
        expect(await unload(page)).toBe(true); await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt, 'beforeunload', draftPrompt]);
        await verificationProof(page).fill(''); await field(page, 'verify', 'method').selectOption('dns_txt'); expect(await unload(page)).toBe(false);
      }
      await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(dialogs).toHaveLength(outcome === 'success' ? 2 : 3);
      expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toHaveLength(1);
    });

    test(`Manual hostname verification ignores a late ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
      await beginManualVerification(page, width); const dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([workPrompt]);
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
      await panel(page).locator('[data-recued-hostnames-verify-open]').click();
      const proof = verificationProof(page); await proof.fill('newer-proof-draft'); await proof.focus();
      await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 4, 'backward'));
      const fresh = (await proof.elementHandle())!;
      await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(proof).toHaveValue('newer-proof-draft'); await expect(proof).toBeFocused();
      expect(await fresh.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await verificationSelection(page)).toEqual([1, 4, 'backward']); expect(await unload(page)).toBe(true);
      await expect(form(page, 'verify').getByRole('alert')).toHaveCount(0);
      accept = false; await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt, draftPrompt]);
      expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toHaveLength(1);
    });
  }
}

const expectEditorSwitchesLocked = async (page: Page, locked: boolean) => {
  for (const action of ['add', 'detail', 'update', 'verify', 'remove']) {
    const buttons = panel(page).locator(`[data-recued-hostnames-${action}-open]`);
    expect(await buttons.count()).toBeGreaterThan(0);
    for (const button of await buttons.all()) {
      if (locked) await expect(button).toBeDisabled(); else await expect(button).toBeEnabled();
    }
  }
};
const beginProbe = async (page: Page, width: number) => {
  await open(page, width, 'update', { draft: false, probe: true });
  await form(page, 'update').locator('[data-recued-hostnames-update-cancel]').click();
  await panel(page).locator('[data-recued-hostnames-verify-open]').click();
  await page.evaluate(() => { window.__hostnamesFocus.expectedProbes = 1; });
  await panel(page).locator('[data-recued-hostnames-verify-submit]').click();
  await expect.poll(() => page.evaluate(() => window.__hostnamesFocus.probes.length)).toBe(1);
  await expect(panel(page).locator('[data-recued-hostnames-verify-auto-probe-status]')).toHaveText('Checking from the outside…');
};

for (const width of [390, 1280]) {
  for (const mode of ['add', 'update'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      test(`Hostnames audit locks the submitted ${mode} editor through ${outcome} at ${width}px`, async ({ page }) => {
        await open(page, width, mode, { write: true });
        const oldProof = (await field(page, mode, 'verification_token_hash').elementHandle())!;
        const oldActions = await panel(page).locator('[data-recued-hostnames-add-open], [data-recued-hostnames-detail-open], [data-recued-hostnames-update-open], [data-recued-hostnames-verify-open], [data-recued-hostnames-remove-open]').elementHandles();
        await startWrite(page, width, mode);
        const controls = await form(page, mode).locator('input, select').all(); expect(controls.length).toBeGreaterThanOrEqual(8);
        for (const control of controls) await expect(control).toBeDisabled();
        await expectEditorSwitchesLocked(page, true);
        await oldProof.evaluate(node => { const input = node as HTMLInputElement; input.value = 'newer-unsubmitted-proof'; input.dispatchEvent(new Event('input', { bubbles: true })); });
        for (const action of oldActions) await action.evaluate(node => (node as HTMLButtonElement).click());
        await expectDraft(page, mode); expect(await unload(page)).toBe(true);
        await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
        if (outcome === 'success') {
          await expect(form(page, mode)).toHaveCount(0); expect(await unload(page)).toBe(false);
          await expectEditorSwitchesLocked(page, false);
        } else {
          await expect(form(page, mode).getByRole('alert')).toContainText('Synthetic hostname write unavailable');
          await expectDraft(page, mode); expect(await unload(page)).toBe(true);
          for (const control of await form(page, mode).locator('input, select').all()) await expect(control).toBeEnabled();
          await expect(panel(page).locator('[data-recued-hostnames-update-open]')).toBeEnabled();
          await field(page, mode, 'verification_token_hash').fill('recovered-proof');
          await expect(field(page, mode, 'verification_token_hash')).toHaveValue('recovered-proof');
        }
        expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toHaveLength(1);
      });
    }
  }

  for (const outcome of ['success', 'error'] as const) {
    test(`Hostnames audit guards automatic verification through probe ${outcome} at ${width}px`, async ({ page }) => {
      await beginProbe(page, width); expect(await unload(page)).toBe(true);
      const verify = panel(page).locator('[data-recued-hostnames-verify-form]');
      for (const control of await verify.locator('input, select').all()) await expect(control).toBeDisabled();
      await expectEditorSwitchesLocked(page, true);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt]);
      if (outcome === 'success') await page.evaluate(hostname => window.__hostnamesFocus.expectedMutations.push({
        method: 'collection.hostname.verifyOwnership', args: { hostname, method: 'dns_txt', observed_token_hash: 'synthetic-observed-proof' },
      }), hostname);
      await page.evaluate(outcome => window.__hostnamesFocus.releaseProbe(outcome), outcome);
      if (outcome === 'success') {
        await expect.poll(() => page.evaluate(() => window.__hostnamesFocus.mutations.length)).toBe(1);
        expect(await unload(page)).toBe(true); await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt, workPrompt]);
        await page.evaluate(() => window.__hostnamesFocus.release('success'));
        await expect(verify).toContainText('You own it. Checked.');
      } else await expect(verify.getByRole('alert')).toContainText('Synthetic probe unavailable');
      expect(await unload(page)).toBe(false); await expectEditorSwitchesLocked(page, false);
      await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    });

    test(`Hostnames audit retires a late probe ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
      await beginProbe(page, width); const dialogs: string[] = [];
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
      await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([workPrompt]);
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
      await panel(page).locator('[data-recued-hostnames-add-open]').click();
      const proof = field(page, 'add', 'verification_token_hash'); await proof.fill('fresh-proof-draft'); await proof.focus();
      await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 4, 'backward'));
      const fresh = (await proof.elementHandle())!;
      await page.evaluate(outcome => window.__hostnamesFocus.releaseProbe(outcome), outcome);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toEqual([]);
      await expect(proof).toHaveValue('fresh-proof-draft'); await expect(proof).toBeFocused();
      expect(await fresh.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await selection(page, 'add')).toEqual([1, 4, 'backward']);
      await expect(form(page, 'add').getByRole('alert')).toHaveCount(0); expect(await unload(page)).toBe(true);
    });
  }
}

for (const width of [390, 1280]) {
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames navigation preserves ${mode} drafts and native editing on cancellation at ${width}px`, async ({ page }) => {
      const raw = `  ${draftProof}  `;
      await open(page, width, mode);
      const proof = field(page, mode, 'verification_token_hash');
      await proof.fill(''); await proof.focus(); await page.keyboard.type(raw);
      await page.keyboard.press('ControlOrMeta+z'); const undoValue = await proof.inputValue(); expect(undoValue).not.toBe(raw);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(raw);
      await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
      const original = (await proof.elementHandle())!;
      const dialogs: string[] = []; let accept = false;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      expect(await unload(page)).toBe(true); await leave(page);
      await expect.poll(() => dialogs).toEqual([draftPrompt]);
      await expect(proof).toHaveValue(raw); await expect(proof).toBeFocused();
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await selection(page, mode)).toEqual([2, 6, 'backward']);
      await page.keyboard.press('ControlOrMeta+z'); await expect(proof).toHaveValue(undoValue);
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(proof).toHaveValue(raw);
      accept = true; await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
      await expect(form(page, mode)).toHaveCount(0); expect(await unload(page)).toBe(false);
      expect(dialogs).toEqual([draftPrompt, draftPrompt]);
    });

    test(`Hostnames navigation protects ${mode} drafts during native reload at ${width}px`, async ({ page }) => {
      await open(page, width, mode);
      const proof = field(page, mode, 'verification_token_hash');
      await proof.focus(); await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 5, 'backward'));
      const original = (await proof.elementHandle())!;
      const dialogs: string[] = []; let accept = false;
      page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
      expect(await unload(page)).toBe(true);
      await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
      await expectDraft(page, mode); await expect(proof).toBeFocused();
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await selection(page, mode)).toEqual([1, 5, 'backward']);
      accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
      await expect(panel(page)).toBeVisible(); await expect(form(page, mode)).toHaveCount(0);
      expect(await unload(page)).toBe(false); expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
    });

    test(`Hostnames navigation leaves restored ${mode} fields and canceled forms clean at ${width}px`, async ({ page }) => {
      await open(page, width, mode, { draft: false }); expect(await unload(page)).toBe(false);
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).click();
      await expect(form(page, mode).getByRole('alert')).toHaveText(mode === 'add' ? 'You need to give a name.' : 'No changes to save.');
      expect(await unload(page)).toBe(false);
      for (const name of mode === 'add' ? ['hostname', 'verification_token_hash'] : ['verification_token_hash']) {
        await field(page, mode, name).fill(' '); expect(await unload(page)).toBe(true);
        await field(page, mode, name).fill(''); expect(await unload(page)).toBe(false);
      }
      await field(page, mode, 'cert_source').selectOption('byo_uploaded'); expect(await unload(page)).toBe(true);
      await field(page, mode, 'cert_source').selectOption('byo_external'); expect(await unload(page)).toBe(false);
      await field(page, mode, 'method').selectOption('http_token'); expect(await unload(page)).toBe(true);
      await field(page, mode, 'method').selectOption('dns_txt'); expect(await unload(page)).toBe(false);
      for (const value of [443, 8447]) {
        await port(page, mode, value).click(); expect(await unload(page)).toBe(true);
        await port(page, mode, value).click(); expect(await unload(page)).toBe(false);
      }
      await field(page, mode, 'enabled').uncheck(); expect(await unload(page)).toBe(true);
      await field(page, mode, 'enabled').check(); expect(await unload(page)).toBe(false);
      await field(page, mode, 'verification_token_hash').fill(draftProof); expect(await unload(page)).toBe(true);
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-cancel]`).click();
      await expect(form(page, mode)).toHaveCount(0); expect(await unload(page)).toBe(false);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    });

    test(`Hostnames navigation keeps ${mode} drafts across Settings tabs at ${width}px`, async ({ page }) => {
      await open(page, width, mode);
      const original = (await field(page, mode, 'verification_token_hash').elementHandle())!;
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await page.getByRole('tab', { name: 'Certificates', exact: true }).click();
      await expect(page.locator('[data-recued-tls-certs-panel]')).toBeVisible(); expect(await unload(page)).toBe(true);
      await page.getByRole('tab', { name: 'Hostnames', exact: true }).click();
      await expectDraft(page, mode); expect(await original.evaluate(node => node.isConnected)).toBe(true);
      expect(dialogs).toEqual([]);
      // A direct deep link remounts Settings, unlike an in-page tab click.
      await page.evaluate(() => window.__app.setHash('#settings/server/certificates'));
      await expect.poll(() => dialogs).toEqual([draftPrompt]); await expectDraft(page, mode);
      await expect(page).toHaveURL(/#settings\/server\/hostnames$/u);
      await leave(page); await expect.poll(() => dialogs).toEqual([draftPrompt, draftPrompt]);
      await expectDraft(page, mode);
    });

    for (const outcome of ['success', 'error'] as const) {
      test(`Hostnames navigation guards the pending ${mode} write until ${outcome} at ${width}px`, async ({ page }) => {
        await beginWrite(page, width, mode); expect(await unload(page)).toBe(true);
        const dialogs: string[] = []; let accept = false;
        page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? 'beforeunload' : dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
        await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt]);
        await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual([workPrompt, 'beforeunload']);
        await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
        if (outcome === 'success') {
          await expect(form(page, mode)).toHaveCount(0); expect(await unload(page)).toBe(false);
          await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
          expect(dialogs).toEqual([workPrompt, 'beforeunload']);
        } else {
          await expect(form(page, mode).getByRole('alert')).toContainText('Synthetic hostname write unavailable');
          await expectDraft(page, mode); expect(await unload(page)).toBe(true);
          await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt, 'beforeunload', draftPrompt]);
          accept = true; await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
          expect(dialogs).toEqual([workPrompt, 'beforeunload', draftPrompt, draftPrompt]);
        }
        expect(await unload(page)).toBe(false);
        expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toHaveLength(1);
      });

      test(`Hostnames navigation ignores a late ${mode} ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
        await beginWrite(page, width, mode);
        const dialogs: string[] = []; let accept = true;
        page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
        await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
        expect(dialogs).toEqual([workPrompt]); expect(await unload(page)).toBe(false);
        await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
        await expect(form(page, mode)).toHaveCount(0);
        await panel(page).locator(`[data-recued-hostnames-${mode}-open]`).click();
        const proof = field(page, mode, 'verification_token_hash'); await proof.fill('newer-proof-draft');
        await proof.focus(); await proof.evaluate(node => (node as HTMLInputElement).setSelectionRange(1, 4, 'backward'));
        const fresh = (await proof.elementHandle())!;
        await page.evaluate(outcome => window.__hostnamesFocus.release(outcome), outcome);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(proof).toHaveValue('newer-proof-draft'); await expect(proof).toBeFocused();
        expect(await fresh.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        expect(await selection(page, mode)).toEqual([1, 4, 'backward']);
        await expect(form(page, mode).getByRole('alert')).toHaveCount(0); expect(await unload(page)).toBe(true);
        accept = false; await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt, draftPrompt]);
        expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toHaveLength(1);
      });
    }

    test(`Hostnames navigation preserves Back and Forward after repeated ${mode} cancellation at ${width}px`, async ({ page }) => {
      await open(page, width, mode, { draft: false }); await leave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      await page.evaluate(() => window.__app.setHash('#settings/server/hostnames'));
      await panel(page).locator(`[data-recued-hostnames-${mode}-open]`).click();
      const proof = field(page, mode, 'verification_token_hash'); await proof.fill(draftProof);
      const original = (await proof.elementHandle())!; const dialogs: string[] = []; let accept = false;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      for (let attempt = 1; attempt <= 2; attempt++) {
        await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt);
        await expect(page).toHaveURL(/#settings\/server\/hostnames$/u); await expect(proof).toHaveValue(draftProof);
        expect(await original.evaluate(node => node.isConnected)).toBe(true);
      }
      accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      await page.goForward(); await expect(form(page, mode)).toHaveCount(0); expect(await unload(page)).toBe(false);
      expect(dialogs).toEqual([draftPrompt, draftPrompt, draftPrompt]);
    });
  }
}

for (const width of [390, 1280]) {
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames ${mode} keeps repeated port toggles and bidirectional keyboard traversal at ${width}px`, async ({ page, browserName }) => {
      await open(page, width, mode);
      await port(page, mode, 443).focus();
      await page.keyboard.press('Space');
      await expect(port(page, mode, 443)).toBeFocused();
      await expectPorts(page, mode, []);
      await page.keyboard.press('Space');
      await expect(port(page, mode, 443)).toBeFocused();
      await expectPorts(page, mode, [443]);
      await page.keyboard.press(tabKey(browserName));
      await expect(port(page, mode, 8446)).toBeFocused();
      await page.keyboard.press('Space');
      await expect(port(page, mode, 8446)).toBeFocused();
      await page.keyboard.press(tabKey(browserName));
      await expect(port(page, mode, 8447)).toBeFocused();
      await page.keyboard.press('Space');
      await expect(port(page, mode, 8447)).toBeFocused();
      await expectPorts(page, mode, [443, 8446, 8447]);
      await page.keyboard.press(tabKey(browserName, true));
      await expect(port(page, mode, 8446)).toBeFocused();
      await page.keyboard.press('Space');
      await expect(port(page, mode, 8446)).toBeFocused();
      await expectPorts(page, mode, [443, 8447]);
      await expectDraft(page, mode);
    });

    test(`Hostnames ${mode} certificate choices keep focus while updating compatible fields at ${width}px`, async ({ page, browserName }) => {
      await open(page, width, mode);
      const source = field(page, mode, 'cert_source');
      expect(await options(page, mode, 'cert_source')).toEqual(['byo_external', 'byo_uploaded', 'recued_acme']);
      await source.focus();
      // Controlled selection drives the browser's change handler. Native
      // keyboard traversal and checkbox activation are checked separately.
      await source.selectOption('byo_uploaded');
      await expect(source).toBeFocused();
      await expect(field(page, mode, 'method')).toHaveValue('cert_proof');
      expect(await options(page, mode, 'method')).toEqual(['cert_proof', 'dns_txt', 'http_token']);
      await expect(field(page, mode, 'verification_token_hash')).toHaveCount(0);
      await page.keyboard.press(tabKey(browserName));
      await expect(field(page, mode, 'method')).toBeFocused();

      await source.focus();
      await source.selectOption('byo_external');
      await expect(source).toBeFocused();
      expect(await options(page, mode, 'method')).toEqual(['dns_txt', 'http_token']);
      await expectDraft(page, mode);
      await source.selectOption('recued_acme');
      await expect(source).toBeFocused();
      await expect(field(page, mode, 'method')).toHaveCount(0);
      await expect(field(page, mode, 'verification_token_hash')).toHaveCount(0);
      await page.keyboard.press(tabKey(browserName));
      await expect(port(page, mode, 443)).toBeFocused();
      await source.focus();
      await source.selectOption('byo_external');
      await expect(source).toBeFocused();
      // ACME deliberately clears the old proof code.
      await expectDraft(page, mode, '');
      await expectPorts(page, mode, [443]);
    });

    test(`Hostnames ${mode} proof choices keep focus and restore the retained draft at ${width}px`, async ({ page, browserName }) => {
      await open(page, width, mode);
      const method = field(page, mode, 'method');
      await method.focus();
      await method.selectOption('http_token');
      await expect(method).toBeFocused();
      await expectDraft(page, mode);
      await page.keyboard.press(tabKey(browserName));
      await expect(field(page, mode, 'verification_token_hash')).toBeFocused();
      await field(page, mode, 'verification_token_hash').evaluate(input => {
        const text = input as HTMLInputElement;
        text.setSelectionRange(text.value.length, text.value.length);
      });
      await page.keyboard.type('-edited');
      await expectDraft(page, mode, `${draftProof}-edited`);

      await field(page, mode, 'cert_source').focus();
      await field(page, mode, 'cert_source').selectOption('byo_uploaded');
      await expect(field(page, mode, 'verification_token_hash')).toHaveCount(0);
      await method.focus();
      await method.selectOption('dns_txt');
      await expect(method).toBeFocused();
      await expectDraft(page, mode, `${draftProof}-edited`);
      await method.selectOption('cert_proof');
      await expect(method).toBeFocused();
      await expect(field(page, mode, 'verification_token_hash')).toHaveCount(0);
      await page.keyboard.press(tabKey(browserName));
      await expect(port(page, mode, 443)).toBeFocused();
    });

    test(`Hostnames ${mode} changes leave outside keyboard focus alone at ${width}px`, async ({ page }) => {
      await open(page, width, mode);
      const outside = page.locator('[data-recued-global-run-palette-trigger]');
      await outside.focus();
      await expect(outside).toBeFocused();
      await port(page, mode, 8446).evaluate(input => {
        (input as HTMLInputElement).checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect(outside).toBeFocused();
      await field(page, mode, 'method').selectOption('http_token');
      await expect(outside).toBeFocused();
      await field(page, mode, 'cert_source').selectOption('byo_uploaded');
      await expect(outside).toBeFocused();
      await expectPorts(page, mode, [443, 8446]);
    });

    test(`Hostnames ${mode} empty ports stay blocked and recover without losing the changed control at ${width}px`, async ({ page, browserName }) => {
      await open(page, width, mode);
      await port(page, mode, 443).focus();
      await page.keyboard.press('Space');
      await expect(port(page, mode, 443)).toBeFocused();
      await expectPorts(page, mode, []);
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).click();
      await expect(form(page, mode).getByRole('alert')).toHaveText('Pick at least one port.');
      await port(page, mode, 8446).focus();
      await page.keyboard.press('Space');
      await expect(port(page, mode, 8446)).toBeFocused();
      await expect(form(page, mode).getByRole('alert')).toHaveCount(0);
      await expectPorts(page, mode, [8446]);
      await expectDraft(page, mode);
      await page.keyboard.press(tabKey(browserName));
      await expect(port(page, mode, 8447)).toBeFocused();
    });
  }
}

const validationCases = [
  { label: 'Add hostname', mode: 'add', target: 'hostname', message: 'You need to give a name.' },
  { label: 'Add proof', mode: 'add', target: 'verification_token_hash', message: 'Proof code is required for HTTP token and DNS TXT proofs.' },
  { label: 'Add port', mode: 'add', target: 'listener_port_443', message: 'Pick at least one port.' },
  { label: 'Edit proof', mode: 'update', target: 'verification_token_hash', message: 'Proof code is required when changing to HTTP token or DNS TXT proof.' },
  { label: 'Edit port', mode: 'update', target: 'listener_port_443', message: 'Pick at least one port.' },
] as const;
const prepareInvalid = async (page: Page, mode: Mode, target: string) => {
  if (mode === 'add') await field(page, mode, 'hostname').fill(target === 'hostname' ? '  ' : `  ${draftName}  `);
  else await field(page, mode, 'method').selectOption('http_token');
  await editorProof(page, mode).fill(target === 'verification_token_hash' ? '  ' : manualProof);
  if (target === 'listener_port_443') await port(page, mode, 443).uncheck();
};
for (const width of [390, 1280]) {
  for (const { label, mode, target, message } of validationCases) {
    test(`Hostnames validation focuses ${label} after native keyboard submission at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, target);
      const rawProof = await editorProof(page, mode).inputValue();
      const submit = form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`);
      await submit.focus(); await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
      await expect(feedbackError(page, mode)).toHaveText(message);
      const invalid = field(page, mode, target); await expect(invalid).toBeFocused();
      await expect(editorProof(page, mode)).toHaveValue(rawProof);
      if (mode === 'add') await expect(field(page, mode, 'hostname')).toHaveValue(target === 'hostname' ? '  ' : `  ${draftName}  `);
      if (target === 'listener_port_443') {
        await page.keyboard.press('Space'); await expect(port(page, mode, 443)).toBeChecked();
        await expect(port(page, mode, 443)).toBeFocused(); await expect(feedbackError(page, mode)).toHaveCount(0);
      } else {
        const original = (await invalid.elementHandle())!;
        await page.keyboard.press('ControlOrMeta+A'); const correction = target === 'hostname' ? draftName : manualProof; await page.keyboard.type(correction);
        await expect(feedbackError(page, mode)).toHaveCount(0); await expect(invalid).toHaveValue(correction);
        expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        await invalid.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 6, 'backward'));
        expect(await invalid.evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd, (node as HTMLInputElement).selectionDirection])).toEqual([2, 6, 'backward']);
        await page.keyboard.press('ControlOrMeta+z'); await expect(invalid).not.toHaveValue(correction);
        await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(invalid).toHaveValue(correction); await expect(invalid).toBeFocused();
      }
      expect(await unload(page)).toBe(true);
    });
  }
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames validation focuses ${mode} proof after a native pointer submission at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, 'verification_token_hash');
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).click();
      await expect(feedbackError(page, mode)).toContainText('Proof code is required'); await expect(editorProof(page, mode)).toBeFocused();
    });
    test(`Hostnames validation preserves outside focus for scripted ${mode} submission at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, 'verification_token_hash');
      await page.evaluate(() => { const other = document.createElement('button'); other.id = 'validation-focus-fixture'; other.textContent = 'Other action'; document.body.appendChild(other); other.focus(); });
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).evaluate(node => (node as HTMLButtonElement).click());
      await expect(feedbackError(page, mode)).toContainText('Proof code is required'); await expect(page.locator('#validation-focus-fixture')).toBeFocused();
    });
    test(`Hostnames validation ignores a retired ${mode} submit button after reopening at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, 'verification_token_hash');
      const retired = (await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).elementHandle())!;
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-cancel]`).click();
      await activateEditor(page, width, mode); await prepareInvalid(page, mode, 'verification_token_hash');
      const input = editorProof(page, mode); await input.focus(); const original = (await input.elementHandle())!;
      await retired.evaluate(node => (node as HTMLButtonElement).click());
      await expect(feedbackError(page, mode)).toHaveCount(0); await expect(input).toBeFocused();
      expect(await original.evaluate(node => node.isConnected)).toBe(true);
    });
  }
  test(`Hostnames validation leaves an unchanged Edit form without an arbitrary field target at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'update'); await form(page, 'update').locator('[data-recued-hostnames-update-submit]').focus(); await page.keyboard.press('Enter');
    await expect(feedbackError(page, 'update')).toHaveText('No changes to save.'); expect(await editorProof(page, 'update').evaluate(node => node === document.activeElement)).toBe(false);
    expect(await unload(page)).toBe(false);
  });
}


const submitInvalidNative = async (page: Page, width: number, mode: Mode) => {
  await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).focus();
  await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
};
for (const width of [390, 1280]) {
  test(`Hostnames validation audit advances through Add errors before one trimmed write at ${width}px`, async ({ page }) => {
    await open(page, width, 'add', { draft: false, write: true });
    await field(page, 'add', 'hostname').fill('  '); await editorProof(page, 'add').fill('  '); await port(page, 'add', 443).uncheck();
    for (const { target, message, raw } of [
      { target: 'hostname', message: 'You need to give a name.', raw: `  ${draftName}  ` },
      { target: 'verification_token_hash', message: 'Proof code is required for HTTP token and DNS TXT proofs.', raw: manualProof },
      { target: 'listener_port_443', message: 'Pick at least one port.', raw: '' },
    ]) {
      await submitInvalidNative(page, width, 'add'); await expect(feedbackError(page, 'add')).toHaveText(message);
      const invalid = field(page, 'add', target); await expect(invalid).toBeFocused(); await expect(invalid).toBeInViewport();
      if (target === 'listener_port_443') await page.keyboard.press('Space');
      else { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(raw); }
      await expect(feedbackError(page, 'add')).toHaveCount(0);
    }
    await expect(field(page, 'add', 'hostname')).toHaveValue(`  ${draftName}  `); await expect(editorProof(page, 'add')).toHaveValue(manualProof);
    await startWrite(page, width, 'add');
    await page.evaluate(() => { const other = document.createElement('button'); other.id = 'validation-audit-outside'; other.textContent = 'Other action'; document.body.appendChild(other); other.focus(); window.__hostnamesFocus.release('error'); });
    await expect(feedbackError(page, 'add')).toContainText('Synthetic hostname write unavailable'); await expect(page.locator('#validation-audit-outside')).toBeFocused();
    await expect(field(page, 'add', 'hostname')).toHaveValue(`  ${draftName}  `); await expect(editorProof(page, 'add')).toHaveValue(manualProof); expect(await unload(page)).toBe(true);
  });
  for (const source of ['recued_acme', 'byo_uploaded'] as const) {
    test(`Hostnames validation audit focuses Add ports for ${source} without a hidden proof at ${width}px`, async ({ page }) => {
      await openEditor(page, width, 'add'); await field(page, 'add', 'hostname').fill(`  ${draftName}  `);
      await field(page, 'add', 'cert_source').selectOption(source); await expect(editorProof(page, 'add')).toHaveCount(0); await port(page, 'add', 443).uncheck();
      await submitInvalidNative(page, width, 'add'); await expect(feedbackError(page, 'add')).toHaveText('Pick at least one port.');
      await expect(port(page, 'add', 443)).toBeFocused(); await expect(port(page, 'add', 443)).toBeInViewport();
      await page.keyboard.press('Space'); await expect(port(page, 'add', 443)).toBeChecked(); await expect(port(page, 'add', 443)).toBeFocused();
      await expect(feedbackError(page, 'add')).toHaveCount(0); await expect(field(page, 'add', 'cert_source')).toHaveValue(source); expect(await unload(page)).toBe(true);
    });
  }
  test(`Hostnames validation audit corrects an uploaded Edit proof before one native write at ${width}px`, async ({ page }) => {
    await open(page, width, 'update', { draft: false, write: true, uploaded: true });
    await field(page, 'update', 'method').selectOption('dns_txt'); await editorProof(page, 'update').fill('  ');
    await submitInvalidNative(page, width, 'update'); await expect(feedbackError(page, 'update')).toHaveText('Proof code is required when changing to HTTP token or DNS TXT proof.');
    const proof = editorProof(page, 'update'); await expect(proof).toBeFocused(); await expect(proof).toBeInViewport();
    const button = (await form(page, 'update').locator('[data-recued-hostnames-update-submit]').elementHandle())!;
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(manualProof); await expect(feedbackError(page, 'update')).toHaveCount(0);
    expect(await button.evaluate(node => node.isConnected)).toBe(true); await startWrite(page, width, 'update');
    await page.evaluate(() => { const other = document.createElement('button'); other.id = 'validation-audit-outside'; other.textContent = 'Other action'; document.body.appendChild(other); other.focus(); window.__hostnamesFocus.release('error'); });
    await expect(feedbackError(page, 'update')).toContainText('Synthetic hostname write unavailable'); await expect(page.locator('#validation-audit-outside')).toBeFocused();
    await expect(proof).toHaveValue(manualProof); expect(await unload(page)).toBe(true);
  });
}


const expectValidationAssociation = async (page: Page, mode: Mode, target = 'verification_token_hash') => {
  const input = field(page, mode, target); const message = feedbackError(page, mode); const text = (await message.textContent())!;
  await expect(input).toHaveAttribute('aria-invalid', 'true'); const id = await message.getAttribute('id'); expect(id).toBeTruthy();
  await expect(input).toHaveAttribute('aria-describedby', id!); await expect(input).toHaveAccessibleDescription(text);
  expect(await page.locator('[id]').evaluateAll((nodes, id) => nodes.filter(node => node.id === id).length, id)).toBe(1);
  await expect(form(page, mode).locator('[aria-invalid="true"]')).toHaveCount(1);
  return { input, message, id, text };
};
const expectNoValidationAssociation = async (page: Page, mode: Mode, target = 'verification_token_hash') => {
  const input = field(page, mode, target); await expect(input).not.toHaveAttribute('aria-invalid'); await expect(input).not.toHaveAttribute('aria-describedby');
  await expect(input).toHaveAccessibleDescription('');
};
for (const width of [390, 1280]) {
  for (const { label, mode, target, message } of validationCases) {
    test(`Hostnames validation associations mark ${label} after keyboard submission and clear on correction at ${width}px`, async ({ page, browserName }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, target); await submitInvalidNative(page, width, mode);
      await expect(feedbackError(page, mode)).toHaveText(message); const { input } = await expectValidationAssociation(page, mode, target); await expect(input).toBeFocused();
      await page.keyboard.press(tabKey(browserName)); await page.keyboard.press(tabKey(browserName, true)); await expect(input).toBeFocused(); await expect(input).toHaveAccessibleDescription(message);
      if (target === 'listener_port_443') {
        await page.keyboard.press('Space'); await expect(port(page, mode, 443)).toBeChecked(); await expect(port(page, mode, 443)).toBeFocused();
        await expectNoValidationAssociation(page, mode, target);
      } else {
        const original = (await input.elementHandle())!; const correction = target === 'hostname' ? draftName : manualProof;
        await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(correction); await expectNoValidationAssociation(page, mode, target);
        expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
        await page.keyboard.press('ControlOrMeta+z'); await expect(input).not.toHaveValue(correction); await expectNoValidationAssociation(page, mode, target);
        await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input).toHaveValue(correction); await expect(input).toBeFocused();
      }
      await expect(feedbackError(page, mode)).toHaveCount(0); expect(await unload(page)).toBe(true);
    });
  }
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames validation associations survive ${mode} address status and preserve kept warnings at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode, { background: { kind: 'addresses', outcome: 'success' } });
      await prepareInvalid(page, mode, 'verification_token_hash'); await submitInvalidNative(page, width, mode); const { input, id, text } = await expectValidationAssociation(page, mode);
      await input.evaluate(node => (node as HTMLInputElement).setSelectionRange(0, 2, 'backward')); const original = (await input.elementHandle())!;
      await releaseBackground(page, 'addresses'); await expect(input).toHaveAttribute('aria-describedby', id!); await expect(input).toHaveAccessibleDescription(text);
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true); expect(await editorSelection(page, mode)).toEqual([0, 2, 'backward']);
      const warning = mode === 'update' ? form(page, mode).locator('[data-recued-hostnames-kept-warning]') : null;
      if (warning) await expect(warning).toHaveCount(1);
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(manualProof); await expectNoValidationAssociation(page, mode); await expect(feedbackError(page, mode)).toHaveCount(0);
      if (warning) await expect(warning).toHaveCount(1); expect(await unload(page)).toBe(true);
    });
    test(`Hostnames validation associations preserve outside focus on scripted ${mode} validation at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, 'verification_token_hash');
      await page.evaluate(() => { const other = document.createElement('button'); other.id = 'association-outside-fixture'; other.textContent = 'Other action'; document.body.appendChild(other); other.focus(); });
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`).evaluate(node => (node as HTMLButtonElement).click());
      await expectValidationAssociation(page, mode); await expect(page.locator('#association-outside-fixture')).toBeFocused();
    });
    test(`Hostnames validation associations clear before a ${mode} write and stay absent for server errors at ${width}px`, async ({ page }) => {
      await open(page, width, mode, { draft: false, write: true, uploaded: mode === 'update' });
      if (mode === 'add') await field(page, mode, 'hostname').fill(draftName); else await field(page, mode, 'method').selectOption('dns_txt');
      await editorProof(page, mode).fill('  '); await submitInvalidNative(page, width, mode); await expectValidationAssociation(page, mode);
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(manualProof); await expectNoValidationAssociation(page, mode); await startWrite(page, width, mode);
      await expect(form(page, mode).locator('[aria-invalid="true"]')).toHaveCount(0); await expectNoValidationAssociation(page, mode);
      await page.evaluate(() => window.__hostnamesFocus.release('error')); await expect(feedbackError(page, mode)).toContainText('Synthetic hostname write unavailable');
      await expect(feedbackError(page, mode)).not.toHaveAttribute('id'); await expectNoValidationAssociation(page, mode); await expect(editorProof(page, mode)).toHaveValue(manualProof); expect(await unload(page)).toBe(true);
    });
  }
}


for (const width of [390, 1280]) {
  test(`Hostnames validation association audit moves the error description across Add fields at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'add'); await field(page, 'add', 'hostname').fill('  '); await editorProof(page, 'add').fill('  '); await port(page, 'add', 443).uncheck();
    let id: string | null = null;
    for (const { target, text, correction } of [
      { target: 'hostname', text: 'You need to give a name.', correction: `  ${draftName}  ` },
      { target: 'verification_token_hash', text: 'Proof code is required for HTTP token and DNS TXT proofs.', correction: manualProof },
      { target: 'listener_port_443', text: 'Pick at least one port.', correction: '' },
    ]) {
      await submitInvalidNative(page, width, 'add'); await expect(feedbackError(page, 'add')).toHaveText(text); const current = await expectValidationAssociation(page, 'add', target);
      if (id === null) id = current.id; else expect(current.id).toBe(id); await expect(current.input).toBeFocused();
      if (target === 'listener_port_443') await page.keyboard.press('Space');
      else { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(correction); }
      await expectNoValidationAssociation(page, 'add', target); await expect(feedbackError(page, 'add')).toHaveCount(0);
    }
    await expect(field(page, 'add', 'hostname')).toHaveValue(`  ${draftName}  `); await expect(editorProof(page, 'add')).toHaveValue(manualProof); expect(await unload(page)).toBe(true);
  });
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames validation association audit retires ${mode} proof descriptions after a certificate-source change at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, 'verification_token_hash'); await submitInvalidNative(page, width, mode);
      const { input, id } = await expectValidationAssociation(page, mode); const retired = (await input.elementHandle())!;
      const source = field(page, mode, 'cert_source'); await source.focus(); await source.selectOption('recued_acme'); await expect(source).toBeFocused();
      await expect(editorProof(page, mode)).toHaveCount(0); await expect(feedbackError(page, mode)).toHaveCount(0); await expect(form(page, mode).locator('[aria-invalid]')).toHaveCount(0);
      expect(await retired.evaluate(node => ({ invalid: node.getAttribute('aria-invalid'), describedby: node.getAttribute('aria-describedby'), connected: node.isConnected }))).toEqual({ invalid: null, describedby: null, connected: false });
      expect(await page.locator('[id]').evaluateAll((nodes, id) => nodes.filter(node => node.id === id).length, id)).toBe(0); expect(await unload(page)).toBe(true);
    });
  }
  test(`Hostnames validation association audit clears a proof description while hostname editing keeps focus and Undo at ${width}px`, async ({ page }) => {
    await openEditor(page, width, 'add'); await prepareInvalid(page, 'add', 'verification_token_hash'); await submitInvalidNative(page, width, 'add');
    await expectValidationAssociation(page, 'add'); const proof = (await editorProof(page, 'add').elementHandle())!; const name = field(page, 'add', 'hostname'); const original = (await name.elementHandle())!;
    await name.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('corrected.example.test'); await expectNoValidationAssociation(page, 'add'); await expect(feedbackError(page, 'add')).toHaveCount(0);
    expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true); expect(await proof.evaluate(node => node.isConnected)).toBe(true);
    await page.keyboard.press('ControlOrMeta+z'); await expect(name).not.toHaveValue('corrected.example.test'); await expectNoValidationAssociation(page, 'add');
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(name).toHaveValue('corrected.example.test'); await expect(name).toBeFocused(); expect(await unload(page)).toBe(true);
  });
}


for (const width of [390, 1280]) {
  for (const [mode, name, label] of [
    ['add', 'hostname', 'Add hostname'], ['add', 'verification_token_hash', 'Add proof'],
    ['update', 'verification_token_hash', 'Edit proof'],
  ] as const) {
    test(`Hostnames validation Enter submits ${label} once and preserves drafts on failure at ${width}px`, async ({ page }) => {
      await open(page, width, mode, { write: true });
      if (mode === 'add') await field(page, mode, 'hostname').fill(`  ${draftName}  `);
      await editorProof(page, mode).fill(manualProof); await expectWrite(page, mode);
      await field(page, mode, name).focus(); await page.keyboard.press('Enter');
      const submit = form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`);
      await expect(submit).toBeDisabled(); expect(await unload(page)).toBe(true);
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toEqual(await page.evaluate(() => window.__hostnamesFocus.expectedMutations));
      const dialogs: string[] = []; page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
      await leave(page); await expect.poll(() => dialogs).toEqual([workPrompt]);
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('#settings/server/hostnames');
      await expect(form(page, mode)).toBeVisible();
      await page.evaluate(() => window.__hostnamesFocus.release('error'));
      await expect(feedbackError(page, mode)).toContainText('Synthetic hostname write unavailable');
      await expect(submit).toBeEnabled(); await expect(editorProof(page, mode)).toHaveValue(manualProof);
      if (mode === 'add') await expect(field(page, mode, 'hostname')).toHaveValue(`  ${draftName}  `);
      await expectNoValidationAssociation(page, mode); expect(await unload(page)).toBe(true);
    });
  }
  for (const [mode, target, label] of [
    ['add', 'hostname', 'Add hostname'], ['add', 'verification_token_hash', 'Add proof'], ['add', 'listener_port_443', 'Add ports'],
    ['update', 'verification_token_hash', 'Edit proof'], ['update', 'listener_port_443', 'Edit ports'],
  ] as const) {
    test(`Hostnames validation Enter focuses and describes ${label} without writing at ${width}px`, async ({ page }) => {
      await openEditor(page, width, mode); await prepareInvalid(page, mode, target);
      await editorProof(page, mode).focus(); await page.keyboard.press('Enter');
      await expect(field(page, mode, target)).toBeFocused(); await expectValidationAssociation(page, mode, target);
      await expect(editorProof(page, mode)).toHaveValue(target === 'verification_token_hash' ? '  ' : manualProof);
      if (mode === 'add') await expect(field(page, mode, 'hostname')).toHaveValue(target === 'hostname' ? '  ' : `  ${draftName}  `);
      expect(await unload(page)).toBe(true);
    });
  }
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames validation Enter ignores ${mode} shortcuts, consumed keys and active composition at ${width}px`, async ({ page }) => {
      await open(page, width, mode, { write: true }); const input = editorProof(page, mode);
      const original = (await input.elementHandle())!; await input.focus();
      for (const shortcut of ['Shift+Enter', 'Alt+Enter', 'Control+Enter', 'Meta+Enter']) await page.keyboard.press(shortcut);
      await input.evaluate(node => node.addEventListener('keydown', event => event.preventDefault(), { capture: true, once: true }));
      await page.keyboard.press('Enter');
      await input.evaluate(node => {
        for (const options of [{}, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
        }
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });
      await page.keyboard.press('Enter');
      await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await expect(form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`)).toBeEnabled();
      await expect(feedbackError(page, mode)).toHaveCount(0); await expect(input).toHaveValue(draftProof);
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await page.evaluate(() => window.__hostnamesFocus.mutations)).toEqual([]);
      await expectWrite(page, mode); await page.keyboard.press('Enter');
      await expect(form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`)).toBeDisabled();
      await page.evaluate(() => window.__hostnamesFocus.release('success')); await expect(form(page, mode)).toHaveCount(0);
    });
    test(`Hostnames validation Enter ignores retired ${mode} text after reopening at ${width}px`, async ({ page }) => {
      await open(page, width, mode); const retired = (await editorProof(page, mode).elementHandle())!;
      await form(page, mode).locator(`[data-recued-hostnames-${mode}-cancel]`).click(); await editorAction(page, mode).click();
      if (mode === 'add') await field(page, mode, 'hostname').fill(draftName);
      await editorProof(page, mode).fill(manualProof); const current = (await editorProof(page, mode).elementHandle())!;
      await retired.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      await expect(form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`)).toBeEnabled(); await expect(feedbackError(page, mode)).toHaveCount(0);
      expect(await current.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(editorProof(page, mode)).toHaveValue(manualProof);
    });
    test(`Hostnames validation Enter preserves ${mode} checkbox and select keyboard behavior at ${width}px`, async ({ page }) => {
      await open(page, width, mode); const checkbox = field(page, mode, 'enabled');
      await checkbox.focus(); await page.keyboard.press('Enter'); await expect(checkbox).toBeChecked();
      await page.keyboard.press('Space'); await expect(checkbox).not.toBeChecked();
      const method = field(page, mode, 'method'); await method.focus();
      await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
      await expect(method).toHaveValue('dns_txt'); await expect(form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`)).toBeEnabled();
      await expect(feedbackError(page, mode)).toHaveCount(0); await expect(editorProof(page, mode)).toHaveValue(draftProof);
    });
  }
  test(`Hostnames validation Enter keeps manual Verify explicit at ${width}px`, async ({ page }) => {
    await openVerification(page, width, { verify: true }); await field(page, 'verify', 'method').selectOption('http_token');
    await verificationProof(page).fill(manualProof); await verificationProof(page).focus(); await page.keyboard.press('Enter');
    await expect(verificationProof(page)).toBeFocused(); await expect(verificationProof(page)).toHaveValue(manualProof);
    await expect(form(page, 'verify').locator('[data-recued-hostnames-verify-submit]')).toBeEnabled();
    await expect(feedbackError(page, 'verify')).toHaveCount(0); expect(await unload(page)).toBe(true);
  });
}


for (const width of [390, 1280]) {
  for (const mode of ['add', 'update'] as const) {
    test(`Hostnames validation Enter audit retries ${mode} with native Numpad Enter after a server error at ${width}px`, async ({ page }) => {
      await open(page, width, mode, { write: true }); await expectWrite(page, mode);
      await editorProof(page, mode).focus(); await page.keyboard.press('Enter');
      const submit = form(page, mode).locator(`[data-recued-hostnames-${mode}-submit]`); await expect(submit).toBeDisabled();
      await page.evaluate(() => window.__hostnamesFocus.release('error')); await expect(feedbackError(page, mode)).toContainText('Synthetic hostname write unavailable');
      const input = editorProof(page, mode); const original = (await input.elementHandle())!;
      await input.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(manualProof);
      await expect(feedbackError(page, mode)).toHaveCount(0); await expectNoValidationAssociation(page, mode);
      expect(await original.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expectWrite(page, mode); await page.keyboard.press('NumpadEnter'); await expect(submit).toBeDisabled();
      await page.keyboard.press('NumpadEnter'); expect(await unload(page)).toBe(true);
      await page.evaluate(() => window.__hostnamesFocus.release('success')); await expect(form(page, mode)).toHaveCount(0);
      if (mode === 'add') await expect(verificationProof(page)).toHaveValue(manualProof);
    });
  }
  for (const source of ['recued_acme', 'byo_uploaded'] as const) {
    test(`Hostnames validation Enter audit submits Add ${source} with the proof field hidden at ${width}px`, async ({ page }) => {
      await open(page, width, 'add', { write: true, draft: false }); await field(page, 'add', 'hostname').fill(`  ${draftName}  `);
      await field(page, 'add', 'cert_source').selectOption(source); await expect(editorProof(page, 'add')).toHaveCount(0);
      await page.evaluate(({ source, draftName }) => window.__hostnamesFocus.expectedMutations.push({ method: 'collection.hostname.add',
        args: { hostname: draftName, cert_source: source, ...(source === 'byo_uploaded' ? { verification_method: 'cert_proof' } : {}), listener_ports: [443], enabled: true } }), { source, draftName });
      await field(page, 'add', 'hostname').focus(); await page.keyboard.press('Enter');
      await expect(form(page, 'add').locator('[data-recued-hostnames-add-submit]')).toBeDisabled(); await page.keyboard.press('Enter');
      await page.evaluate(() => window.__hostnamesFocus.release('success')); await expect(form(page, 'add')).toHaveCount(0);
    });
  }
  test(`Hostnames validation Enter audit advances through Add errors before a single write at ${width}px`, async ({ page }) => {
    await open(page, width, 'add', { write: true, draft: false }); await port(page, 'add', 443).uncheck();
    await field(page, 'add', 'hostname').focus(); await page.keyboard.press('Enter'); await expectValidationAssociation(page, 'add', 'hostname');
    await page.keyboard.type(`  ${draftName}  `); await page.keyboard.press('Enter');
    await expectValidationAssociation(page, 'add'); await expect(editorProof(page, 'add')).toBeFocused();
    const input = (await editorProof(page, 'add').elementHandle())!; await page.keyboard.type(manualProof);
    expect(await input.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter'); await expectValidationAssociation(page, 'add', 'listener_port_443'); await expect(port(page, 'add', 443)).toBeFocused();
    await page.keyboard.press('Space'); await expect(feedbackError(page, 'add')).toHaveCount(0); await expectWrite(page, 'add');
    await editorProof(page, 'add').focus(); await page.keyboard.press('Enter');
    await expect(form(page, 'add').locator('[data-recued-hostnames-add-submit]')).toBeDisabled();
    await page.evaluate(() => window.__hostnamesFocus.release('success')); await expect(form(page, 'add')).toHaveCount(0);
    await expect(verificationProof(page)).toHaveValue(manualProof);
  });
}
