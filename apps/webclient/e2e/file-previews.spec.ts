import { test, expect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

let createFixture: typeof Factory;
const target = resolve('node_modules/.cache/file-previews-' + crypto.randomUUID() + '.mjs');
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createFileLifecycleFixture: typeof Factory }).createFileLifecycleFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });
type Fixture = Awaited<ReturnType<typeof Factory>>;
const previewMethod = 'data.file.attachments.preview';
const setup = async (browser: Browser, seed?: (fixture: Fixture) => Promise<void>) => {
  const context = await browser.newContext(); const page = await context.newPage();
  await context.addInitScript(() => {
    const urls = new Set<string>(); const violations: string[] = []; let workers = 0;
    const create = URL.createObjectURL; const revoke = URL.revokeObjectURL; const terminate = Worker.prototype.terminate;
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    Worker.prototype.terminate = function () { workers++; terminate.call(this); };
    document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective + ': ' + event.blockedURI));
    Object.assign(window, { previewResources: () => ({ urls: urls.size, terminated: workers, violations }) });
  });
  // Exercise the same self-hosted script/worker and image posture as the server.
  await context.route('**/existing-files-harness.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" } });
  });
  const fixture = await createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } }, false, true);
  await seed?.(fixture);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let pending: Promise<void> | undefined; let release: (() => void) | undefined; let failPreview = false;
  await context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
    try {
      if (method === previewMethod) { await pending; if (failPreview) { failPreview = false; throw new Error('Preview connection interrupted'); } }
      const result = await fixture.rpc(method, args ?? {});
      await route.fulfill({ json: { result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  await page.goto('/existing-files-harness.html#chat/session/s');
  const input = page.locator('[data-recued-chat-route-input]'); await expect(input).toBeVisible();
  const viewer = page.getByRole('dialog', { name: 'File preview', exact: true });
  const picker = page.getByRole('dialog', { name: 'Choose from Files', exact: true });
  const conversation = page.getByRole('dialog', { name: 'Conversation files', exact: true });
  return { context, page, fixture, calls, input, viewer, picker, conversation,
    chips: page.locator('[data-recued-chat-route-attachments]'),
    resources: () => page.evaluate(() => (window as unknown as { previewResources(): { urls: number; terminated: number; violations: string[] } }).previewResources()),
    pick: async () => { await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
      await page.getByRole('button', { name: 'Choose from Files', exact: true }).click(); await expect(picker).toBeVisible(); },
    openConversation: async () => { await page.locator('[data-chat-conversation-files-open]').click(); await expect(conversation).toBeVisible(); },
    fail: () => { failPreview = true; },
    hold: () => { pending = new Promise<void>(done => { release = done; }); return () => { pending = undefined; release?.(); }; },
    close: async () => { release?.(); fixture.release(); await context.close(); fixture.close(); },
  };
};
const noWrites = (calls: Array<{ method: string }>) =>
  expect(calls.filter(call => ['chat.send', 'chat.session.create', 'data.file.attachments.import'].includes(call.method) || call.method.startsWith('upload.'))).toEqual([]);

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const xlsx = (wide = false, find = false) => {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheet = (body: string) => strToU8(`<worksheet xmlns="${ns}"><dimension ref="A1:XFD1048576"/><sheetData>${body}</sheetData></worksheet>`);
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + [1, 2, 3].map(n => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>`
      + '<sheet name="Prices" sheetId="1" r:id="r1"/><sheet name="Summary" sheetId="2" r:id="r2"/><sheet name="Empty" sheetId="3" r:id="r3"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + [1, 2, 3].map(n => `<Relationship Id="r${n}" Type="${rel}/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('')
      + `<Relationship Id="strings" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="styles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<sst xmlns="${ns}"><si><t>Name</t></si><si><r><t>Supplier </t></r><r><t>North</t></r><rPh sb="0" eb="1"><t>Phonetic guide</t></rPh></si></sst>`),
    'xl/styles.xml': strToU8(`<styleSheet xmlns="${ns}"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="2"/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': sheet(wide ? '<row r="1"><c r="CW1"><v>9</v></c></row>'
      : '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c><c r="C1" t="inlineStr"><is><t>&lt;img src=https://outside.invalid/tracker onerror=alert(1)&gt;</t></is></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>00125.50</v></c><c r="C2" s="1"><v>61</v></c></row>'
      + '<row r="3"><c r="A3" t="str"><f>WEBSERVICE("https://outside.invalid/formula")</f><v>Cached answer</v></c><c r="B3"><f>SUM(1,2)</f></c><c r="C3" t="b"><v>0</v></c></row>'
      + Array.from({ length: 57 }, (_, n) => `<row r="${n + 5}"><c r="A${n + 5}" t="inlineStr"><is><t>Customer ${n + 5}</t></is></c></row>`).join('')
      + (find ? '<row r="240"><c r="U240" t="inlineStr"><is><t>Target target &lt;img.*&gt;</t></is></c></row>' : '')),
    'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1" s="2"><f>SUM(Prices!B2:B61)</f><v>2500.5</v></c></row>'
      + (find ? '<row r="2"><c r="A2" t="inlineStr"><is><t>Final target</t></is></c></row>' : '')
      + '<row r="1048576"><c r="XFD1048576" s="0"><v/></c></row>'),
    'xl/worksheets/sheet3.xml': sheet(''),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(`<Relationships><Relationship Target="https://outside.invalid/linked"/></Relationships>`),
    'xl/vbaProject.bin': strToU8('not executed'),
  }));
};

test('XLSX saved values, sparse positions and sheet pages survive file actions on desktop and phone', async ({ browser }, testInfo) => {
  const bytes = xlsx();
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'xlsx-prices', name: 'Prices.xlsx', mime_type: 'application/octet-stream', bytes });
  });
  const outside: string[] = []; f.page.on('request', request => { if (request.url().includes('outside.invalid')) outside.push(request.url()); });
  try {
    await f.page.setViewportSize({ width: 1280, height: 900 }); await f.input.fill('Keep this draft');
    const open = f.page.getByRole('button', { name: 'Preview Prices.xlsx', exact: true }); await open.click();
    const table = f.viewer.getByRole('table', { name: 'Worksheet: Prices', exact: true });
    await expect(table.getByRole('cell', { name: 'Supplier North', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: '00125.50', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: '1900-03-01', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Cached answer', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'Result not saved', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: 'FALSE', exact: true })).toBeVisible();
    const gap = table.getByRole('row').filter({ has: f.page.getByRole('rowheader', { name: '4', exact: true }) });
    expect(await gap.getByRole('cell').allTextContents()).toEqual(['', '', '']);
    await expect(table).toContainText('<img src=https://outside.invalid/tracker onerror=alert(1)>');
    expect(await table.locator('img,script,iframe,a').count()).toBe(0);
    await f.page.screenshot({ path: testInfo.outputPath('xlsx-preview-desktop.png') });
    const next = f.viewer.getByRole('button', { name: 'Next rows', exact: true });
    await next.focus(); await f.page.keyboard.press('Enter'); await expect(next).toBeFocused();
    await expect(f.viewer).toContainText('Rows 51–61 of 61');
    const select = f.viewer.getByRole('combobox', { name: 'Worksheet', exact: true });
    await select.selectOption({ label: 'Summary' });
    await expect(f.viewer.getByRole('cell', { name: '2500.50', exact: true })).toBeVisible();
    await expect(f.viewer).toContainText('Rows 1–1 of 1');
    await select.selectOption({ label: 'Empty' }); await expect(f.viewer).toContainText('no saved cell values');
    await select.selectOption({ label: 'Prices' }); await expect(f.viewer).toContainText('Rows 51–61 of 61');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    await expect(f.viewer.getByRole('heading', { name: 'File details' })).toBeVisible();
    await f.viewer.getByRole('button', { name: /Back to preview/ }).click(); await expect(f.viewer).toContainText('Rows 51–61 of 61');
    await f.page.setViewportSize({ width: 390, height: 844 });
    await f.page.screenshot({ path: testInfo.outputPath('xlsx-preview-mobile.png') });
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await readFile((await (await saving).path())!)).toEqual(bytes);
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'data.file.read' || call.method === 'data.file.attachments.convert')).toBe(false);
    await f.page.keyboard.press('Escape'); await expect(f.input).toHaveValue('Keep this draft');
    noWrites(f.calls); expect(outside).toEqual([]); expect((await f.resources()).violations).toEqual([]);
    expect((await f.resources()).terminated).toBe(1);
  } finally { await f.close(); }
});

test('connected XLSX exports explain a worksheet limit and still show other sheets and download the original', async ({ browser }) => {
  const bytes = xlsx(true); const f = await setup(browser);
  try {
    f.fixture.cloudSource!.add('one', 'Native prices', { mime_type: 'application/vnd.google-apps.spreadsheet' });
    f.fixture.cloudSource!.respond(bytes, xlsxMime);
    await f.page.evaluate(() => { location.hash = '#data/files'; });
    await f.page.getByRole('button', { name: /Work drive/ }).click();
    await f.page.locator('[data-recued-data-action="file-open-preview"]').filter({ hasText: 'Native prices' }).click();
    await expect(f.viewer.getByRole('alert')).toContainText('exceeds the preview limits');
    await f.viewer.getByRole('combobox', { name: 'Worksheet' }).selectOption({ label: 'Summary' });
    await expect(f.viewer.getByRole('cell', { name: '2500.50', exact: true })).toBeVisible();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in workbook', exact: true });
    await find.fill('2500.50'); await find.press('Enter');
    await expect(f.viewer.locator('[data-spreadsheet-find-status]')).toContainText('Cell 1 of 1 · Summary · B1');
    await expect(f.viewer.locator('[data-spreadsheet-find-status]')).toContainText('Unsearched worksheets: Prices');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Origin', exact: true }).click();
    await expect(f.viewer).toContainText('/Clients/Native prices');
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download exported file', exact: true }).click();
    const download = await saving; expect(download.suggestedFilename()).toBe('Native prices.xlsx');
    expect(await readFile((await download.path())!)).toEqual(bytes);
    expect(f.fixture.cloudSource!.downloads()).toBe(1); noWrites(f.calls);
  } finally { await f.close(); }
});

test('XLSX Find opens matching sheets, row pages and distant columns, while cell jumps preserve sparse coordinates', async ({ browser }, testInfo) => {
  const bytes = xlsx(false, true);
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'xlsx-find', name: 'Find.xlsx', mime_type: xlsxMime, bytes }).then(() => {}));
  try {
    await f.input.fill('Keep my draft'); await f.page.getByRole('button', { name: 'Preview Find.xlsx', exact: true }).click();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in workbook', exact: true });
    const status = f.viewer.locator('[data-spreadsheet-find-status]');
    const active = f.viewer.locator('[data-spreadsheet-active-cell]');
    await find.fill('target'); await find.press('Enter');
    await expect(status).toHaveText('Cell 1 of 2 · Prices · U240');
    await expect(f.viewer).toContainText('Rows 201–240 of 240');
    await expect(active).toHaveText('Target target <img.*>'); await expect(active).toBeInViewport();
    await f.viewer.getByRole('button', { name: 'Next match', exact: true }).click();
    await expect(status).toHaveText('Cell 2 of 2 · Summary · A2');
    await expect(f.viewer.getByRole('combobox', { name: 'Worksheet' })).toHaveValue('1');
    await f.page.keyboard.press('Control+f'); await expect(find).toBeFocused(); await find.press('Shift+Enter');
    await expect(status).toHaveText('Cell 1 of 2 · Prices · U240');
    const address = f.viewer.getByRole('textbox', { name: 'Cell address', exact: true });
    await address.fill('C4'); await address.press('Enter');
    await expect(active).toHaveAttribute('data-spreadsheet-cell', 'C4'); await expect(active).toHaveText('');
    await expect(status).toHaveText('2 matching cells');
    await expect(f.viewer).toContainText('Rows 1–50 of 240');
    await address.fill('V1'); await address.press('Enter');
    await expect(f.viewer.getByRole('alert')).toHaveText('Choose a cell within A1:U240.');
    await expect(active).toHaveAttribute('data-spreadsheet-cell', 'C4');
    await f.page.setViewportSize({ width: 390, height: 844 });
    await address.fill('$u$240'); await f.viewer.getByRole('button', { name: 'Go to cell', exact: true }).click();
    await expect(address).toHaveValue('U240'); await expect(active).toHaveText('Target target <img.*>'); await expect(active).toBeInViewport();
    await f.viewer.screenshot({ path: testInfo.outputPath('xlsx-find-mobile.png') });
    await find.fill('Result not saved'); await find.press('Enter'); await expect(status).toHaveText('No matching cells.');
    await f.viewer.getByRole('combobox', { name: 'Worksheet' }).selectOption({ label: 'Empty' });
    await address.fill('A1'); await address.press('Enter');
    await expect(f.viewer.getByRole('alert')).toHaveText('This worksheet has no cells to jump to.');
    await find.fill('2500.50'); await find.press('Enter');
    await expect(status).toHaveText('Cell 1 of 1 · Summary · B1');
    expect(await f.viewer.locator('img,script,iframe').count()).toBe(0);
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await readFile((await (await saving).path())!)).toEqual(bytes);
    await f.viewer.getByRole('button', { name: 'Close preview' }).click(); await expect(f.input).toHaveValue('Keep my draft');
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(1); noWrites(f.calls);
    expect((await f.resources()).violations).toEqual([]);
  } finally { await f.close(); }
});

test('CSV Find searches every data page and column, keeps its query through Raw text, and treats markup literally', async ({ browser }, testInfo) => {
  const csv = 'Target heading,' + Array.from({ length: 11 }, (_, n) => `Field ${n + 2}`).join(',') + '\n'
    + Array.from({ length: 70 }, (_, n) => Array.from({ length: 12 }, (_, column) => n === 0 && column === 0 ? 'Target target'
      : n === 60 && column === 11 ? 'Target <img.*>' : `${n + 1}:${column + 1}`).join(',') + '\n').join('');
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'csv-find', name: 'Find.csv', mime_type: 'text/csv', bytes: csv }).then(() => {}));
  try {
    await f.page.setViewportSize({ width: 390, height: 844 }); await f.input.fill('Unsent CSV draft');
    await f.page.getByRole('button', { name: 'Preview Find.csv', exact: true }).click();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in CSV', exact: true });
    const status = f.viewer.locator('[data-spreadsheet-find-status]'), active = f.viewer.locator('[data-spreadsheet-active-cell]');
    // Change pages in the same turn as typing, before the debounce can fire.
    // Finishing that search must not undo the owner's later page navigation.
    await find.evaluate(input => {
      (input as HTMLInputElement).value = 'target'; input.dispatchEvent(new Event('input', { bubbles: true }));
      const next = Array.from(input.closest('.csv-preview')!.querySelectorAll('button')).find(button => button.textContent === 'Next rows')!;
      next.focus(); next.click();
    });
    await expect(status).toHaveText('2 matching cells'); await expect(f.viewer).toContainText('Rows 51–70 of 70');
    await find.press('Enter'); await expect(status).toHaveText('Cell 1 of 2 · CSV data · A1');
    await f.viewer.getByRole('button', { name: 'Next match', exact: true }).click();
    await expect(status).toHaveText('Cell 2 of 2 · CSV data · L61');
    await expect(f.viewer).toContainText('Rows 51–70 of 70'); await expect(active).toHaveText('Target <img.*>'); await expect(active).toBeInViewport();
    await expect(f.viewer.getByRole('rowheader', { name: '61', exact: true })).toBeInViewport();
    await f.viewer.getByRole('button', { name: 'Raw text', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText(csv);
    await f.viewer.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(find).toHaveValue('target'); await expect(active).toBeInViewport();
    const address = f.viewer.getByRole('textbox', { name: 'Cell address', exact: true });
    await address.fill('M1'); await address.press('Enter'); await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expect(active).toHaveAttribute('data-spreadsheet-cell', 'L61');
    await address.fill('$L$61'); await address.press('Enter'); await expect(address).toHaveValue('L61'); await expect(active).toBeInViewport();
    await f.viewer.screenshot({ path: testInfo.outputPath('csv-find-mobile.png') });
    await find.fill('<img.*>'); await find.press('Enter'); await expect(status).toHaveText('Cell 1 of 1 · CSV data · L61');
    expect(await f.viewer.locator('img,script,iframe').count()).toBe(0);
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    expect(await readFile((await (await saving).path())!, 'utf8')).toBe(csv);
    await find.press('Escape'); await expect(find).toHaveValue(''); await expect(f.viewer).toBeVisible();
    await f.page.keyboard.press('Escape'); await expect(f.viewer).toBeHidden(); await expect(f.input).toHaveValue('Unsent CSV draft');
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(1); noWrites(f.calls);
  } finally { await f.close(); }
});

test('spreadsheet Find can stop within a large CSV and close during a replacement search without late updates', async ({ browser }) => {
  const csv = Array.from({ length: 10_000 }, (_, row) => Array.from({ length: 10 }, (_, column) => `${row}:${column}`).join(',') + '\n').join('');
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'csv-long', name: 'Long.csv', mime_type: 'text/csv; header=absent', bytes: csv }).then(() => {}));
  const errors: string[] = []; f.page.on('pageerror', error => errors.push(error.message));
  try {
    await f.input.fill('Keep this draft'); await f.page.getByRole('button', { name: 'Preview Long.csv', exact: true }).click();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in CSV', exact: true });
    await find.fill('missing'); await find.press('Enter'); await f.viewer.getByRole('button', { name: 'Stop search', exact: true }).click();
    await expect(f.viewer.locator('[data-spreadsheet-find-status]')).toHaveText('Search stopped. 0 matching cells found so far.');
    await find.fill(':'); await find.press('Enter');
    await expect(f.viewer.locator('[data-spreadsheet-find-status]')).toContainText('Search limits reached; some cells were not searched.');
    await find.fill('different'); await find.press('Enter'); await f.viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(f.viewer).toBeHidden(); await expect(f.input).toHaveValue('Keep this draft');
    expect(errors).toEqual([]); noWrites(f.calls); expect((await f.resources()).urls).toBe(0);
  } finally { await f.close(); }
});

test('CSV tables page and switch to original text without changing the draft, download or Data preview', async ({ browser }, testInfo) => {
  const csv = 'Name,Amount,Comment\r\n"North, West",00125.50,"First line\nSecond line"\r\n'
    + 'Literal,0,"<img src=x onerror=window.csvExecuted=true>"\r\n'
    + Array.from({ length: 120 }, (_, index) => `Customer ${index + 3},${index + 1},=1+1\r\n`).join('');
  let fileId = '';
  const f = await setup(browser, async fixture => {
    fileId = (await fixture.addConversationFile({ id: 'csv-report', name: 'Report.csv', mime_type: 'text/csv', bytes: csv })).version;
  });
  try {
    await f.page.setViewportSize({ width: 1280, height: 800 }); await f.input.fill('Unsent message');
    await f.page.getByRole('button', { name: 'Preview Report.csv', exact: true }).click();
    const table = f.viewer.getByRole('table', { name: 'CSV data: Report.csv', exact: true });
    await expect(table.getByRole('cell', { name: 'North, West', exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: '00125.50', exact: true })).toBeVisible();
    expect(await table.getByRole('cell', { name: 'First line Second line', exact: true }).textContent()).toBe('First line\nSecond line');
    await expect(table.getByRole('cell', { name: '<img src=x onerror=window.csvExecuted=true>', exact: true })).toBeVisible();
    expect(await table.locator('img,script').count()).toBe(0);
    expect(await f.page.evaluate(() => Reflect.get(window, 'csvExecuted'))).toBeUndefined();
    await expect(f.viewer.getByRole('status').filter({ hasText: 'Rows 1–50 of 122' })).toBeVisible();
    await f.page.screenshot({ path: testInfo.outputPath('csv-table-desktop.png') });
    const next = f.viewer.getByRole('button', { name: 'Next rows', exact: true });
    await next.focus(); await f.page.keyboard.press('Enter'); await expect(next).toBeFocused();
    await expect(f.viewer).toContainText('Rows 51–100 of 122');
    const grid = f.viewer.getByRole('region', { name: 'CSV table scroll area', exact: true });
    const scroll = await grid.evaluate(node => { node.scrollTop = 80; return node.scrollTop; });
    await f.viewer.getByRole('button', { name: 'Raw text', exact: true }).click();
    expect(await f.viewer.getByLabel('File text', { exact: true }).textContent()).toBe(csv);
    await f.viewer.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(f.viewer).toContainText('Rows 51–100 of 122');
    expect(await grid.evaluate(node => node.scrollTop)).toBe(scroll);
    await f.viewer.getByRole('button', { name: 'Table', exact: true }).click();
    expect(await grid.evaluate(node => node.scrollTop)).toBe(scroll);
    await next.focus(); await f.page.keyboard.press('Enter'); await expect(next).toBeFocused(); await expect(next).toHaveAttribute('aria-disabled', 'true');
    await expect(f.viewer).toContainText('Rows 101–122 of 122');
    await expect(table.getByRole('rowheader', { name: '122', exact: true })).toBeVisible();
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    const download = await saving; expect(await readFile((await download.path())!, 'utf8')).toBe(csv);
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
    await f.viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(f.input).toHaveValue('Unsent message'); await f.input.fill('');
    await f.openConversation();
    await f.conversation.locator(`[data-conversation-file="${fileId}"]`).getByRole('link', { name: 'Open in Data', exact: true }).click();
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByRole('table').getByRole('cell', { name: 'North, West', exact: true })).toBeVisible();
    noWrites(f.calls);
  } finally { await f.close(); }
});

test('phone CSV previews retain paging focus and keep malformed CSV readable and downloadable', async ({ browser }, testInfo) => {
  const csv = Array.from({ length: 61 }, (_, index) => `Customer ${index + 1},${index + 1},Reviewed\n`).join('');
  const broken = 'Name,Comment\nAlice,"unfinished';
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'csv-good', name: 'Good.csv', mime_type: 'application/csv; header="absent"; charset=utf-8', bytes: csv });
    await fixture.addConversationFile({ id: 'csv-broken', name: 'Broken.csv', mime_type: 'text/csv', bytes: broken });
  });
  try {
    await f.page.setViewportSize({ width: 390, height: 844 }); await f.pick();
    const open = f.picker.getByRole('button', { name: 'Preview Good.csv', exact: true }); await open.focus(); await f.page.keyboard.press('Enter');
    await expect(f.viewer.getByRole('table')).toBeVisible();
    await expect(f.viewer.getByRole('columnheader', { name: 'Column 1', exact: true })).toBeVisible();
    await expect(f.viewer.getByRole('cell', { name: 'Customer 1', exact: true })).toBeVisible();
    await expect(f.viewer).toContainText('Rows 1–50 of 61');
    const next = f.viewer.getByRole('button', { name: 'Next rows', exact: true });
    await next.focus(); await f.page.keyboard.press('Enter');
    await expect(f.viewer).toContainText('Rows 51–61 of 61'); await expect(next).toBeFocused();
    await f.page.screenshot({ path: testInfo.outputPath('csv-table-mobile.png') });
    await f.page.keyboard.press('Escape'); await expect(open).toBeFocused();
    await f.picker.getByRole('button', { name: 'Preview Broken.csv', exact: true }).click();
    await expect(f.viewer.getByRole('button', { name: 'Table', exact: true })).toBeDisabled();
    await expect(f.viewer.getByRole('button', { name: 'Raw text', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await f.viewer.getByLabel('File text', { exact: true }).textContent()).toBe(broken);
    await expect(f.viewer.getByRole('status').filter({ hasText: 'could not be shown as a table' })).toBeVisible();
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await readFile((await (await saving).path())!, 'utf8')).toBe(broken);
    noWrites(f.calls); expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
  } finally { await f.close(); }
});

// Valid PDF, including an ignored document action. No network or library fixture dependency.
const pdfFixture = (texts = ['First retained PDF page', 'Second retained PDF page'], rotatedPage = 0) => {
  const streams = texts.map(text => 'BT /F1 24 Tf 30 200 Td (' + text.replace(/[\\()]/g, '\\$&') + ') Tj ET\n');
  const font = 3 + texts.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${texts.length} >>`,
  ];
  for (const [i, stream] of streams.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] ${rotatedPage === i + 1 ? '/Rotate 90' : ''} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n` + xref + '\n%%EOF\n');
};

test('Conversation files and Data preview the same historical bytes without changing the draft or message', async ({ browser }) => {
  let original!: { source: string; version: string };
  const f = await setup(browser, async fixture => {
    original = await fixture.addConversationFile({ id: 'old', source: 'same', name: 'Original.txt', bytes: 'Original evidence', ts: 1 });
    await fixture.addConversationFile({ id: 'new', source: 'same', name: 'Replacement.txt', bytes: 'Replacement evidence', ts: 2 });
  });
  try {
    const messages = await f.fixture.messages();
    await f.input.fill('Unsent draft'); await f.page.locator('[data-chat-reply-action="file-message"]').click();
    await f.page.locator('[data-recued-chat-route-message="old"]').getByRole('button', { name: 'Preview Original.txt', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Original evidence');
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await f.openConversation();
    const row = f.conversation.locator('[data-conversation-file="' + original.version + '"]');
    await row.getByRole('button', { name: 'Preview Original.txt', exact: true }).evaluate(button => button.setAttribute('data-preview-old-control', ''));
    await row.getByRole('button', { name: 'Preview Original.txt', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Original evidence');
    await f.page.evaluate(() => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
        kind: 'chat.session_changed', session_id: 's', field: 'attachments', value: true, cursor: Date.now() + 10_000,
      });
    });
    await expect(f.conversation.locator('[data-preview-old-control]')).toHaveCount(0);
    await f.page.keyboard.press('Escape'); await expect(f.conversation).toBeVisible();
    await expect(row.getByRole('button', { name: 'Preview Original.txt', exact: true })).toBeFocused();
    await f.page.keyboard.press('Escape'); await expect(f.input).toHaveValue('Unsent draft');
    await expect(f.page.locator('[data-chat-reply-draft="file-message"]')).toBeVisible();
    await f.input.fill(''); await f.page.getByRole('button', { name: 'Remove reply', exact: true }).click();
    await f.openConversation(); await row.getByRole('link', { name: 'Open in Data' }).click();
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Original evidence');
    noWrites(f.calls); expect(await f.fixture.messages()).toEqual(messages);
  } finally { await f.close(); }
});

test('picker and composer image previews preserve selections and release their object URLs', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'image', name: 'Pixel.png', type: 'image',
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRFkAAAAASUVORK5CYII=', 'base64') });
  });
  try {
    await f.input.fill('Keep my text'); await f.pick();
    await f.picker.getByRole('checkbox', { name: /Pixel.png/ }).check();
    await f.picker.getByRole('button', { name: 'Preview Pixel.png', exact: true }).click();
    await expect(f.viewer.getByRole('img', { name: 'Pixel.png', exact: true })).toBeVisible();
    await expect.poll(() => f.resources().then(value => value.urls)).toBe(1);
    await f.page.keyboard.press('Escape');
    await expect(f.picker.getByRole('checkbox', { name: /Pixel.png/ })).toBeChecked();
    await expect.poll(() => f.resources().then(value => value.urls)).toBe(0);
    await f.picker.getByRole('button', { name: 'Attach 1 file', exact: true }).click();
    await f.chips.getByRole('button', { name: 'Preview Pixel.png', exact: true }).click();
    await expect(f.viewer.getByRole('img')).toBeVisible(); await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await expect(f.input).toHaveValue('Keep my text'); await expect(f.chips).toContainText('Pixel.png');
    noWrites(f.calls); expect((await f.resources()).violations).toEqual([]);
  } finally { await f.close(); }
});

test('remote PDF uses the local worker, pages and zooms on mobile, and Download saves the exact preview', async ({ browser }, testInfo) => {
  const bytes = pdfFixture(); const f = await setup(browser);
  const workerRequests: string[] = []; f.page.on('request', request => { if (request.url().includes('pdf.worker')) workerRequests.push(request.url()); });
  let releaseReader!: () => void;
  const readerReady = new Promise<void>(resolve => { releaseReader = resolve; });
  await f.context.route('**/file-preview/*/pdf.mjs', async route => { await readerReady; await route.continue().catch(() => {}); });
  try {
    await f.page.setViewportSize({ width: 390, height: 844 }); f.fixture.cloudSource!.respond(bytes, 'application/pdf');
    const before = f.fixture.files!.totalBytes(); await f.pick(); await f.picker.getByRole('combobox', { name: 'File source' }).selectOption('google.work.file');
    await f.picker.getByRole('button', { name: 'Preview Cloud report.pdf', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    releaseReader();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toHaveCount(1);
    await f.viewer.getByRole('button', { name: 'Back to preview', exact: false }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    await expect(f.viewer).toContainText('Temporary preview'); await expect(f.viewer).toContainText('Page 1 of 2');
    await f.viewer.getByRole('button', { name: 'Show page text' }).click();
    await expect(f.viewer.getByLabel('PDF page text')).toContainText('First retained PDF page');
    await f.viewer.getByRole('button', { name: 'Next page' }).click();
    await expect(f.viewer.getByLabel('PDF page text')).toContainText('Second retained PDF page');
    await expect(f.viewer.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await f.viewer.getByRole('button', { name: 'Zoom in' }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    expect(await f.viewer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await f.viewer.screenshot({ path: testInfo.outputPath('file-preview-pdf-mobile.png') });
    f.fixture.cloudSource!.respond('Changed after preview', 'application/pdf');
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    const download = await saving; expect(await readFile((await download.path())!)).toEqual(bytes);
    expect(download.suggestedFilename()).toBe('Cloud report.pdf'); expect(f.fixture.cloudSource!.downloads()).toBe(1);
    expect(f.fixture.files!.totalBytes()).toBe(before); noWrites(f.calls);
    expect(workerRequests).toHaveLength(1); expect(new URL(workerRequests[0]!).origin).toBe(new URL(f.page.url()).origin);
    expect((await f.resources()).violations).toEqual([]);
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await expect.poll(() => f.resources().then(value => value.terminated)).toBe(1);
    await expect.poll(() => f.resources().then(value => value.urls)).toBe(0);
  } finally { releaseReader(); await f.close(); }
});

test('PDF page entry jumps directly and rejects invalid pages without losing the current page', async ({ browser }) => {
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'jump-pdf', name: 'Guide.pdf',
    mime_type: 'application/pdf', bytes: pdfFixture(['First page', 'Second page', 'Third page']) }).then(() => {}));
  try {
    await f.page.getByRole('button', { name: 'Preview Guide.pdf', exact: true }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    const page = f.viewer.getByRole('spinbutton', { name: 'Page number', exact: true });
    await page.fill('3'); await page.press('Enter');
    await expect(f.viewer.getByRole('img', { name: 'PDF page 3 of 3' })).toBeVisible();
    await page.fill('4'); await page.press('Enter');
    await expect(f.viewer.getByRole('alert')).toContainText('Enter a whole page number from 1 to 3.');
    await expect(f.viewer.getByRole('img', { name: 'PDF page 3 of 3' })).toBeVisible();
    await page.fill('2.5'); await page.press('Enter'); await expect(page).toHaveAttribute('aria-invalid', 'true');
    await page.fill('1'); await f.viewer.getByRole('button', { name: 'Go to page', exact: true }).click();
    await expect(f.viewer.getByRole('img', { name: 'PDF page 1 of 3' })).toBeVisible();
    await expect(f.viewer.getByRole('alert')).toBeHidden(); noWrites(f.calls);
  } finally { await f.close(); }
});

test('PDF Find counts literal matches, navigates rotated pages, and retains highlights after zoom', async ({ browser }, testInfo) => {
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'find-pdf', name: 'Contract.pdf',
    mime_type: 'application/pdf', bytes: pdfFixture(['renewal and renewal', 'Renewal deadline <img.*>', 'Final renewal'], 2) }).then(() => {}));
  try {
    await f.page.getByRole('button', { name: 'Preview Contract.pdf', exact: true }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in PDF', exact: true });
    await find.fill('renewal'); await find.press('Enter');
    await expect(f.viewer.locator('[data-pdf-find-status]')).toHaveText('Match 1 of 4 · page 1');
    await f.viewer.getByRole('button', { name: 'Next match', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Next match', exact: true }).click();
    await f.page.keyboard.press('Control+f'); await expect(find).toBeFocused();
    await find.press('Shift+Enter');
    await expect(f.viewer.locator('[data-pdf-find-status]')).toHaveText('Match 2 of 4 · page 1');
    await find.press('Enter');
    await expect(f.viewer.locator('[data-pdf-find-status]')).toHaveText('Match 3 of 4 · page 2');
    await expect(f.viewer.locator('.pdf-text-layer [data-pdf-find-active]')).toHaveText('Renewal');
    await expect(f.viewer.locator('.pdf-text-layer [data-pdf-find-active]')).toBeInViewport();
    await f.viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    await expect(f.viewer.locator('.pdf-text-layer [data-pdf-find-active]')).toHaveText('Renewal');
    await f.viewer.getByRole('button', { name: 'Show page text', exact: true }).click();
    await expect(f.viewer.getByLabel('PDF page text').locator('[data-pdf-find-active]')).toHaveText('Renewal');
    await find.fill('<img.*>'); await find.press('Enter');
    await expect(f.viewer.locator('[data-pdf-find-status]')).toHaveText('Match 1 of 1 · page 2');
    await expect(f.viewer.locator('.pdf-text-layer [data-pdf-find-active]')).toHaveText('<img.*>');
    await expect(f.viewer.locator('.pdf-text-layer [data-pdf-find-active]')).toBeInViewport();
    await expect(f.viewer.locator('img,script,iframe')).toHaveCount(0);
    await f.viewer.screenshot({ path: testInfo.outputPath('pdf-find-rotated.png') });
    await find.fill('absent word'); await find.press('Enter');
    await expect(f.viewer.locator('[data-pdf-find-status]')).toHaveText('No matches found.');
    await expect(f.viewer.getByRole('button', { name: 'Next match' })).toBeDisabled();
    await find.press('Escape'); await expect(f.viewer).toBeVisible(); await expect(find).toHaveValue('');
    await f.page.keyboard.press('Escape'); await expect(f.viewer).toBeHidden();
    expect((await f.resources()).violations).toEqual([]); noWrites(f.calls);
  } finally { await f.close(); }
});

test('PDF Find distinguishes a file with no searchable text from a completed no-match search', async ({ browser }) => {
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'scan-pdf', name: 'Scan.pdf',
    mime_type: 'application/pdf', bytes: pdfFixture(['']) }).then(() => {}));
  try {
    await f.page.getByRole('button', { name: 'Preview Scan.pdf', exact: true }).click();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in PDF', exact: true });
    await find.fill('renewal'); await find.press('Enter');
    await expect(f.viewer.locator('[data-pdf-find-status]')).toHaveText('This PDF has no searchable text.');
    await expect(f.viewer.locator('canvas[data-file-preview-rendered]')).toBeVisible();
    await expect(f.viewer.getByRole('button', { name: 'Next match' })).toBeDisabled();
  } finally { await f.close(); }
});

test('PDF Find can stop and close during a longer search without late changes or retained workers', async ({ browser }) => {
  const f = await setup(browser, fixture => fixture.addConversationFile({ id: 'long-pdf', name: 'Long.pdf',
    mime_type: 'application/pdf', bytes: pdfFixture(Array.from({ length: 1000 }, (_, n) => `Page ${n + 1} renewal`)) }).then(() => {}));
  const errors: string[] = []; f.page.on('pageerror', error => errors.push(error.message));
  try {
    await f.input.fill('Keep this draft'); await f.page.getByRole('button', { name: 'Preview Long.pdf', exact: true }).click();
    const find = f.viewer.getByRole('searchbox', { name: 'Find in PDF', exact: true });
    await find.fill('renewal'); await find.press('Enter');
    await f.viewer.getByRole('button', { name: 'Stop search', exact: true }).click();
    await expect(f.viewer.locator('[data-pdf-find-status]')).toContainText('Search stopped after');
    await find.fill('different'); await find.press('Enter');
    await f.viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(f.viewer).toBeHidden(); await expect(f.input).toHaveValue('Keep this draft');
    await expect.poll(() => f.resources().then(value => value.terminated)).toBe(1);
    expect(errors).toEqual([]); expect((await f.resources()).urls).toBe(0); noWrites(f.calls);
  } finally { await f.close(); }
});

const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const docx = (body: string) => Buffer.from(zipSync({
  '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>'),
  'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Target="https://outside.invalid/tracker"/></Relationships>'),
}));

test('DOCX text, details and origin share one viewer on desktop and phone without running document content', async ({ browser }, testInfo) => {
  const bytes = docx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Client proposal</w:t></w:r></w:p>'
    + '<w:p><w:hyperlink><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;</w:t></w:r></w:hyperlink></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>00125.50</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:drawing><w:r><w:t>Hidden object</w:t></w:r></w:drawing></w:p>'
    + Array.from({ length: 90 }, (_, n) => `<w:p><w:r><w:t>Paragraph ${n + 1}</w:t></w:r></w:p>`).join('')
    + `<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>${'z'.repeat(100_002)}</w:t></w:r></w:p>`);
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'docx', name: 'Proposal.docx', mime_type: docxMime, bytes });
    await fixture.addConversationFile({ id: 'docx-empty', name: 'Pictures.docx', mime_type: docxMime,
      bytes: docx('<w:p><w:drawing/></w:p>') });
  });
  const outside: string[] = []; f.page.on('request', request => { if (request.url().includes('outside.invalid')) outside.push(request.url()); });
  try {
    await f.page.setViewportSize({ width: 1280, height: 900 }); await f.input.fill('Keep this draft');
    await f.page.getByRole('button', { name: 'Preview Proposal.docx', exact: true }).click();
    const article = f.viewer.getByLabel('Document text', { exact: true });
    await expect(article.getByRole('heading', { name: 'Client proposal', level: 1 })).toBeVisible();
    await expect(article.getByRole('cell', { name: '00125.50', exact: true })).toBeVisible();
    await expect(article).toContainText('<img src=x onerror=alert(1)>'); await expect(article).not.toContainText('Hidden object');
    expect((await article.textContent())!.length).toBe(100_000);
    await expect(f.viewer.getByRole('status').filter({ hasText: 'Showing the first 100,000 characters' })).toBeVisible();
    expect(await article.locator('img,script,iframe,a').count()).toBe(0);
    await f.page.screenshot({ path: testInfo.outputPath('file-viewer-docx-desktop.png') });
    const scroller = f.viewer.locator('.file-preview-content');
    const position = await scroller.evaluate(node => { node.scrollTop = 600; return node.scrollTop; });
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    await expect(f.viewer.getByRole('heading', { name: 'File details' })).toBeVisible(); await expect(f.viewer.locator('dd')).toContainText(['Proposal.docx', docxMime]);
    await f.viewer.getByRole('button', { name: 'Back to preview', exact: false }).click();
    expect(await scroller.evaluate(node => node.scrollTop)).toBe(position);
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Origin', exact: true }).click();
    await expect(f.viewer).toContainText('Messenger attachment');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    const saving = f.page.waitForEvent('download');
    await f.viewer.getByRole('group', { name: 'File actions', exact: true }).getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await readFile((await (await saving).path())!)).toEqual(bytes);
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
    await f.viewer.getByRole('button', { name: 'Close preview' }).click(); await expect(f.input).toHaveValue('Keep this draft');
    await f.page.setViewportSize({ width: 390, height: 844 });
    await f.page.getByRole('button', { name: 'Preview Proposal.docx', exact: true }).click();
    await expect(article).toContainText('Client proposal');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    await f.page.screenshot({ path: testInfo.outputPath('file-viewer-details-mobile.png') });
    await expect(f.viewer.getByRole('button', { name: 'Close preview' })).toBeInViewport();
    await expect(f.viewer.getByRole('button', { name: 'Download file', exact: true })).toBeInViewport();
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await f.page.getByRole('button', { name: 'Preview Pictures.docx', exact: true }).click();
    await expect(f.viewer.getByLabel('Document text', { exact: true })).toContainText('no text to preview');
    await expect(f.viewer.getByRole('button', { name: 'Download file', exact: true })).toBeEnabled();
    noWrites(f.calls); expect(outside).toEqual([]); expect((await f.resources()).violations).toEqual([]);
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await expect.poll(() => f.resources().then(value => value.terminated)).toBe(3);
  } finally { await f.close(); }
});

test('Data and its import chooser preview provider exports and label their independent download', async ({ browser }) => {
  const bytes = docx('<w:p><w:r><w:t>Exported document content</w:t></w:r></w:p>');
  const f = await setup(browser);
  try {
    f.fixture.cloudSource!.add('one', 'Native plan', { mime_type: 'application/vnd.google-apps.document' });
    f.fixture.cloudSource!.respond(bytes, docxMime);
    await f.page.evaluate(() => { location.hash = '#data/files'; });
    await f.page.getByRole('button', { name: /Work drive/ }).click();
    await f.page.locator('[data-recued-data-action="file-open-preview"]').filter({ hasText: 'Native plan' }).click();
    await expect(f.viewer.getByLabel('Document text', { exact: true })).toHaveText('Exported document content');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Origin', exact: true }).click();
    await expect(f.viewer).toContainText('Work drive'); await expect(f.viewer).toContainText('/Clients/Native plan');
    expect(f.fixture.cloudSource!.downloads()).toBe(1); await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    await f.page.getByRole('button', { name: 'Details for Native plan', exact: true }).click();
    await f.page.getByRole('button', { name: 'Import and use in Chat', exact: true }).click();
    const chooser = f.page.getByRole('dialog', { name: 'Import and use in Chat', exact: true });
    await expect(chooser.getByRole('button', { name: 'Preview file', exact: true })).toBeEnabled();
    await chooser.getByRole('button', { name: 'Preview file', exact: true }).focus(); await f.page.keyboard.press('Enter');
    await expect(f.viewer.getByLabel('Document text', { exact: true })).toHaveText('Exported document content');
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download exported file', exact: true }).click();
    const download = await saving; expect(await readFile((await download.path())!)).toEqual(bytes);
    expect(download.suggestedFilename()).toBe('Native plan.docx'); expect(f.fixture.cloudSource!.downloads()).toBe(2);
    noWrites(f.calls);
    await f.page.keyboard.press('Escape'); await expect(chooser).toBeVisible();
    await expect(chooser.getByRole('button', { name: 'Preview file', exact: true })).toBeFocused();
  } finally { await f.close(); }
});

test('HTML remains plain text and a shortened preview downloads the complete original', async ({ browser }) => {
  const source = '<script>window.previewExecuted=true</script><img src="https://outside.invalid/tracker">' + 'z'.repeat(100_010);
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'html', name: 'Document.html', mime_type: 'text/html', bytes: source });
  });
  try {
    await f.openConversation(); await f.conversation.getByRole('button', { name: 'Preview Document.html', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toContainText('<script>');
    await expect(f.viewer).toContainText('first 100,000 characters');
    expect(await f.viewer.locator('section').locator('script,iframe,object,img').count()).toBe(0);
    expect(await f.page.evaluate(() => Reflect.get(window, 'previewExecuted'))).toBeUndefined();
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    expect((await readFile((await (await saving).path())!)).toString()).toBe(source);
    noWrites(f.calls); expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
  } finally { await f.close(); }
});

test('retry recovers a failed preview and late replies retire on close and navigation', async ({ browser }) => {
  const f = await setup(browser, async fixture => { await fixture.addConversationFile({ id: 'text', name: 'Note.txt', bytes: 'Retained note' }); });
  try {
    await f.pick(); f.fail(); await f.picker.getByRole('button', { name: 'Preview Note.txt', exact: true }).click();
    await expect(f.viewer.getByRole('alert')).toContainText('connection interrupted');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    await expect(f.viewer.locator('dd').first()).toHaveText('Note.txt');
    expect(f.calls.some(call => call.method === previewMethod && call.args.metadata_only === true)).toBe(true);
    expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
    await f.viewer.getByRole('button', { name: 'Back to preview', exact: false }).click();
    const fallback = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await readFile((await (await fallback).path())!, 'utf8')).toBe('Retained note');
    await expect(f.viewer.getByRole('alert')).toContainText('connection interrupted');
    await f.viewer.getByRole('button', { name: 'Retry preview' }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Retained note');
    await f.page.keyboard.press('Escape');
    const release = f.hold(); await f.picker.getByRole('button', { name: 'Preview Note.txt', exact: true }).click();
    await expect(f.viewer).toContainText('Loading preview');
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    await expect(f.viewer.locator('.file-preview-info')).toContainText('Loading file information');
    await f.page.keyboard.press('Escape');
    await expect(f.viewer).toHaveCount(0); await expect(f.picker).toBeVisible(); release();
    await f.picker.getByRole('button', { name: 'Preview Note.txt', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Retained note');
    await f.page.evaluate(() => { location.hash = '#chat/new'; });
    await expect(f.viewer).toHaveCount(0); await expect(f.picker).toHaveCount(0);
    noWrites(f.calls); await expect.poll(() => f.resources().then(value => value.urls)).toBe(0);
  } finally { await f.close(); }
});

test('Data keeps an open preview through a warehouse refresh and retires a pending read on route changes', async ({ browser }) => {
  let id = '';
  const f = await setup(browser, async fixture => {
    id = (await fixture.addConversationFile({ id: 'data-note', name: 'Data note.txt', bytes: 'Saved note' })).version;
  });
  try {
    const hash = '#data/files/record/received/' + encodeURIComponent(id);
    await f.page.evaluate(hash => { location.hash = hash; }, hash);
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Saved note');
    await f.page.evaluate(() => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
        kind: 'warehouse', collection: 'file', op: 'insert', id: 'unrelated', cursor: Date.now() + 10_000,
      });
    });
    await f.page.waitForTimeout(650); // Cross the production warehouse refresh debounce.
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Saved note');
    await f.viewer.getByRole('button', { name: 'Close preview' }).click();
    const release = f.hold(); await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer).toContainText('Loading preview');
    await f.page.evaluate(() => { location.hash = '#chat/new'; }); await expect(f.viewer).toHaveCount(0);
    await f.page.evaluate(hash => { location.hash = hash; }, hash); release();
    await f.page.getByRole('button', { name: 'Preview file', exact: true }).click();
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveText('Saved note');
    expect(f.calls.filter(call => call.method === previewMethod)).toHaveLength(3); noWrites(f.calls);
  } finally { await f.close(); }
});

test('a changed picker selection reports the conflict before reading or altering a draft', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'selected', source: 'changing', name: 'Selected.txt', bytes: 'first' });
  });
  try {
    await f.input.fill('Still writing'); await f.pick();
    await expect(f.picker.getByRole('button', { name: 'Preview Selected.txt', exact: true })).toBeVisible();
    await f.fixture.addConversationFile({ id: 'changed', source: 'changing', name: 'Changed.txt', bytes: 'second' });
    await f.picker.getByRole('button', { name: 'Preview Selected.txt', exact: true }).click();
    await expect(f.viewer.getByRole('alert')).toContainText('file changed');
    await expect(f.viewer.getByLabel('File text', { exact: true })).toHaveCount(0);
    await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    await expect(f.viewer.getByRole('alert', { name: 'Download status', exact: true })).toContainText('file changed');
    expect(f.calls.some(call => call.method === 'data.file.read')).toBe(false);
    await f.page.keyboard.press('Escape'); await f.page.keyboard.press('Escape');
    await expect(f.input).toHaveValue('Still writing'); noWrites(f.calls);
  } finally { await f.close(); }
});

for (const invalid of [
  { name: 'Broken.pdf', mime: 'application/pdf', bytes: '%PDF-broken', message: 'Invalid PDF' },
  { name: 'Broken.png', mime: 'image/png', bytes: 'not an image', message: 'could not be displayed' },
  { name: 'Broken.docx', mime: docxMime, bytes: 'not a Word document', message: 'Invalid or oversized DOCX' },
  { name: 'Malformed.docx', mime: docxMime, bytes: docx('<w:p>'), message: 'could not be read' },
  { name: 'Binary.txt', mime: 'text/plain', bytes: '\0binary', message: 'binary data' },
]) test('an unreadable ' + invalid.name + ' still downloads its original bytes', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'invalid', name: invalid.name, mime_type: invalid.mime, bytes: invalid.bytes });
  });
  try {
    await f.openConversation(); await f.conversation.getByRole('button', { name: 'Preview ' + invalid.name, exact: true }).click();
    await expect(f.viewer.getByRole('alert')).toContainText(invalid.message);
    await expect(f.viewer.getByRole('button', { name: 'Download file' })).toBeEnabled();
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file' }).click();
    expect(await readFile((await (await saving).path())!)).toEqual(Buffer.from(invalid.bytes));
    noWrites(f.calls);
  } finally { await f.close(); }
});


const workbookMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
test('explicit conversion shows inert document text and keeps the saved original download', async ({ browser }, testInfo) => {
  const original = 'original workbook bytes';
  const f = await setup(browser, async fixture => {
    fixture.previewConversion.readers = ['markitdown', 'docling'];
    fixture.previewConversion.text = '# Budget\n<img src=x onerror=window.convertedExecuted=true>\n00125.50';
    await fixture.addConversationFile({ id: 'convert-workbook', name: 'Budget.xlsx', mime_type: workbookMime, bytes: original });
  });
  try {
    await f.input.fill('Keep this draft'); await f.openConversation();
    await f.conversation.getByRole('button', { name: 'Preview Budget.xlsx', exact: true }).click();
    const convert = f.viewer.getByRole('button', { name: 'Convert for preview', exact: true });
    await expect(convert).toBeEnabled(); expect(f.fixture.previewConversion.runs).toBe(0);
    await expect(f.viewer.getByRole('combobox', { name: 'Document reader' })).toHaveValue('markitdown');
    await convert.click();
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toContainText('<img src=x');
    expect(await f.page.evaluate(() => Reflect.get(window, 'convertedExecuted'))).toBeUndefined();
    expect(f.fixture.previewConversion.input!.toString()).toBe(original);
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    expect((await readFile((await (await saving).path())!)).toString()).toBe(original);
    await f.viewer.getByRole('button', { name: 'File actions', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'File details', exact: true }).click();
    await expect(f.viewer.getByRole('heading', { name: 'File details', exact: true })).toBeVisible();
    await expect(f.viewer).toContainText(workbookMime);
    await f.viewer.getByRole('button', { name: 'Back to preview', exact: false }).click();
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toContainText('00125.50');
    await f.viewer.screenshot({ path: testInfo.outputPath('converted-preview-desktop.png') });
    await f.viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(f.input).toHaveValue('Keep this draft'); noWrites(f.calls);
    expect(f.fixture.previewConversion.runs).toBe(1);
  } finally { await f.close(); }
});

test('remote conversion waits for approval before downloading and retains no imported source on mobile', async ({ browser }, testInfo) => {
  const original = Buffer.from('remote workbook original');
  const mime = 'application/vnd.oasis.opendocument.spreadsheet';
  const f = await setup(browser, async fixture => {
    fixture.previewConversion.readers = ['markitdown']; fixture.previewConversion.mode = 'hold';
    fixture.previewConversion.text = 'Approved remote workbook text';
    fixture.cloudSource!.add('workbook', 'Cloud budget.ods', { mime_type: mime, size: original.length });
    fixture.cloudSource!.respond(original, mime);
  });
  try {
    await f.page.setViewportSize({ width: 390, height: 844 }); const before = f.fixture.files!.totalBytes();
    await f.pick(); await f.picker.getByRole('combobox', { name: 'File source' }).selectOption('google.work.file');
    await f.picker.getByRole('button', { name: 'Preview Cloud budget.ods', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Convert for preview', exact: true }).click();
    await expect(f.viewer.getByRole('link', { name: 'Review approval (new tab)', exact: true })).toBeVisible();
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await f.viewer.screenshot({ path: testInfo.outputPath('converted-preview-approval-mobile.png') });
    await f.fixture.previewConversion.approve();
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toHaveText('Approved remote workbook text');
    expect(f.fixture.cloudSource!.downloads()).toBe(1);
    expect(f.fixture.previewConversion.input).toEqual(original);
    expect(f.fixture.files!.totalBytes()).toBe(before);
    await f.viewer.screenshot({ path: testInfo.outputPath('converted-preview-mobile.png') });
    f.fixture.cloudSource!.respond('provider changed bytes without a mirror update', mime);
    await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    await expect(f.viewer.getByLabel('Download status', { exact: true })).toContainText('changed');
    const download = f.calls.filter(call => call.method === 'data.file.read').at(-1)!;
    expect(download.args.expected_hash).toMatch(/^[a-f0-9]{64}$/);
    f.fixture.cloudSource!.respond(original, mime);
    const saving = f.page.waitForEvent('download'); await f.viewer.getByRole('button', { name: 'Download file', exact: true }).click();
    expect(await readFile((await (await saving).path())!)).toEqual(original);
    noWrites(f.calls);
  } finally { await f.close(); }
});

test('missing readers can be rechecked and a failed conversion can be retried explicitly', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    await fixture.addConversationFile({ id: 'missing-reader', name: 'Budget.xlsx', mime_type: workbookMime, bytes: 'workbook' });
    fixture.previewConversion.mode = 'failure';
  });
  try {
    await f.openConversation(); await f.conversation.getByRole('button', { name: 'Preview Budget.xlsx', exact: true }).click();
    await expect(f.viewer.getByRole('link', { name: 'Browse reader packs (new tab)', exact: true })).toBeVisible();
    expect(f.fixture.previewConversion.runs).toBe(0);
    f.fixture.previewConversion.readers = ['markitdown'];
    await f.viewer.getByRole('button', { name: 'Check readers', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Convert for preview', exact: true }).click();
    await expect(f.viewer.getByLabel('Conversion status', { exact: true })).toContainText('could not be converted');
    await expect(f.viewer).not.toContainText('private-adapter-diagnostic');
    await expect(f.viewer.getByRole('button', { name: 'Download file', exact: true })).toBeEnabled();
    f.fixture.previewConversion.mode = 'ready';
    await f.viewer.getByRole('button', { name: 'Retry conversion', exact: true }).click();
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toContainText('Stored values');
    f.fixture.previewConversion.mode = 'failure';
    await f.viewer.getByRole('button', { name: 'Convert again', exact: true }).click();
    await expect(f.viewer.getByLabel('Conversion status', { exact: true })).toContainText('could not be converted');
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toHaveCount(0);
    f.fixture.previewConversion.mode = 'ready';
    await f.viewer.getByRole('button', { name: 'Retry conversion', exact: true }).click();
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toContainText('Stored values');
    expect(f.fixture.previewConversion.runs).toBe(4);
  } finally { await f.close(); }
});

test('a remote source changed during an approval hold is rejected before its bytes are fetched', async ({ browser }) => {
  const mime = 'application/vnd.oasis.opendocument.spreadsheet';
  const f = await setup(browser, async fixture => {
    fixture.previewConversion.readers = ['markitdown']; fixture.previewConversion.mode = 'hold';
    fixture.cloudSource!.add('workbook', 'Cloud budget.ods', { mime_type: mime, size: 10 });
  });
  try {
    await f.pick(); await f.picker.getByRole('combobox', { name: 'File source' }).selectOption('google.work.file');
    await f.picker.getByRole('button', { name: 'Preview Cloud budget.ods', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Convert for preview', exact: true }).click();
    await expect(f.viewer.getByRole('link', { name: 'Review approval (new tab)', exact: true })).toBeVisible();
    f.fixture.cloudSource!.add('workbook', 'Changed budget.ods', { mime_type: mime, revision: 'v2', size: 10 });
    await f.fixture.previewConversion.approve();
    await expect(f.viewer.getByLabel('Conversion status', { exact: true })).toContainText('changed');
    expect(f.fixture.cloudSource!.downloads()).toBe(0);
    await expect(f.viewer.getByLabel('Converted document text', { exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test('closing the viewer retires a late conversion status reply', async ({ browser }) => {
  const f = await setup(browser, async fixture => {
    fixture.previewConversion.readers = ['markitdown']; fixture.previewConversion.mode = 'hold';
    await fixture.addConversationFile({ id: 'late-conversion', name: 'Budget.xlsx', mime_type: workbookMime, bytes: 'workbook' });
  });
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  await f.context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON();
    if (method === 'data.file.attachments.convert' && args.action === 'status') { entered(); await pending; }
    await route.fallback();
  });
  try {
    await f.input.fill('Still my draft'); await f.openConversation();
    await f.conversation.getByRole('button', { name: 'Preview Budget.xlsx', exact: true }).click();
    await f.viewer.getByRole('button', { name: 'Convert for preview', exact: true }).click();
    await waiting;
    await f.viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
    await f.fixture.previewConversion.approve();
    const replied = f.page.waitForResponse(response => response.url().endsWith('/existing-files-rpc')
      && response.request().postDataJSON().method === 'data.file.attachments.convert'
      && response.request().postDataJSON().args.action === 'status');
    release(); await replied;
    await expect(f.viewer).toHaveCount(0); await expect(f.input).toHaveValue('Still my draft');
    await expect(f.page.getByLabel('Converted document text', { exact: true })).toHaveCount(0);
  } finally { release(); await f.close(); }
});
