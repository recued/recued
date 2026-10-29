import { test, expect } from '@playwright/test';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createFileLifecycleFixture as Factory } from './harness/file-lifecycle-backend.js';

let createFixture: typeof Factory;
const target = resolve(`node_modules/.cache/chat-output-files-${crypto.randomUUID()}.mjs`);
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/file-lifecycle-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href)).createFileLifecycleFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });

for (const large of [false, true]) test('a tool-produced ' + (large ? 'large ' : '') + 'CSV downloads from its answer, survives reload, and rejects changed bytes', async ({ page, context }) => {
  test.setTimeout(120_000);
  const csv = large ? 'Email,Name\n' + ('shared@example.test,Sam' + 'x'.repeat(200) + '\n').repeat(80000)
    : 'Email,Name\nshared@example.test,Sam\nshared@example.test,Samuel\n';
  let chunkReads = 0;
  let fixture: Awaited<ReturnType<typeof Factory>>;
  let outputRef = '', writes = 0, corruptDownload = false, downloads = 0;
  const entry: ToolEntry = { name: 'make-export', tier: 2, description: 'Create the requested CSV',
    arg_schema: {}, topic_tags: ['file'], classification: 'write', risk_tier: 'write', concurrency_safe: false };
  const registry: InternalToolRegistry = { list: () => [entry], listByTier: () => [entry], getByName: name => name === entry.name ? entry : null,
    subscribeRefresh: () => () => {}, dispatch: async () => {
      writes++;
      const saved = await fixture.files!.ingest({ bytes: Buffer.from(csv), filename: 'Contacts.csv', mime_type: 'text/csv',
        origin: 'tool_output', source_id: 'csv-output', scan_status: 'clean' });
      outputRef = saved.record_id; const file = fixture.files!.get(outputRef)!;
      return { ok: true, result: { success: true, output: { render: [{ type: 'file_artifact', data: {
        record_id: outputRef, filename: 'Contacts.csv', mime_type: 'text/csv', size_bytes: Buffer.byteLength(csv), sha256: file.hot_fields.content_hash,
      } }] } } };
    } };
  fixture = await createFixture({ emit: event => { void page.evaluate(event => {
    (window as unknown as { queueTestEvent?(e: unknown): void }).queueTestEvent?.(event);
  }, { ...event, cursor: Date.now() }).catch(() => {}); } }, false, false, {
    registry, modelResponse: packet => Array.isArray(packet.prior_tool_calls) && packet.prior_tool_calls.length
      ? { response: 'Your CSV is attached.', events: [], tool_calls: [], output_files: [outputRef] }
      : { response: '', events: [], tool_calls: [{ tool: 'make-export', args: {} }] },
  });
  page.on('download', () => { downloads++; });
  await context.route('**/existing-files-rpc', async route => {
    const { method, args } = route.request().postDataJSON();
    try {
      const result = await fixture.rpc(method, args ?? {});
      if (method === 'data.file.read') {
        chunkReads++;
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6 * 1024 * 1024);
      }
      await route.fulfill({ json: { result: corruptDownload && method === 'data.file.read'
        ? { ...(result as object), bytes_b64: Buffer.from('corrupted').toString('base64') } : result } });
    } catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  try {
    fixture.release();
    await page.goto('/existing-files-harness.html#chat/session/s');
    await page.locator('[data-recued-chat-route-input]').fill('Export the contacts as a CSV.');
    await page.locator('[data-recued-chat-route-send]').click();
    const button = page.getByRole('button', { name: 'Download Contacts.csv', exact: true });
    await expect(button).toBeVisible();
    const first = page.waitForEvent('download'); await button.click();
    expect(await readFile((await (await first).path())!, 'utf8')).toBe(csv);
    await page.reload(); await expect(button).toBeVisible();
    const again = page.waitForEvent('download'); await button.click();
    expect(await readFile((await (await again).path())!, 'utf8')).toBe(csv);
    expect(writes).toBe(1);
    if (large) expect(chunkReads).toBeGreaterThan(2);
    if (large) {
      await page.getByRole('button', { name: 'Preview Contacts.csv', exact: true }).click();
      const previewDownload = page.getByRole('button', { name: 'Download file', exact: true });
      await expect(previewDownload).toBeEnabled();
      const fromPreview = page.waitForEvent('download'); await previewDownload.click();
      expect(await readFile((await (await fromPreview).path())!, 'utf8')).toBe(csv);
      await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    }
    corruptDownload = true; await button.click();
    await expect(page.getByRole('status').filter({ hasText: /does not match/ })).toBeVisible();
    expect(downloads).toBe(large ? 3 : 2);
  } finally { fixture.release(); fixture.close(); }
});
