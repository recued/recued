import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeCommand, ExecutionSource } from '@recued/contracts';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import type { BrowserFiles } from '../bridges/browser-files.js';
import { createPublicFileFetch } from '../http-toolkit/http-actions.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { keptTabPdfs } from '../chat-tab-pdf-read.js';

/** A small, valid PDF so Chrome actually opens its native viewer. */
const pdf = () => {
  const stream = 'BT /F1 14 Tf 30 100 Td (A confirmed browser PDF.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, n) => { offsets.push(Buffer.byteLength(text)); text += `${n + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}`
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
};

describe('PDF handoff and collector guidance through the real Chrome Bridge', () => {
  let server: Server, base: string;
  let fixture: Awaited<ReturnType<typeof createReviewedBrowserFixture>>;
  let formPosts = 0;
  const bytes = pdf();
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/continuation') {
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Start</title><a id="login" href="/continuation-login">Login</a>'); return;
      }
      if (req.url === '/continuation-login') {
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Login</title><form action="/continuation-done"><label>Email<input id="email" name="email"></label><button id="save">Save</button></form>'); return;
      }
      if (req.url?.startsWith('/continuation-done?')) {
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Saved</title><main>Saved the requested value.</main>'); return;
      }
      if (req.url === '/choice-result' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => {
          formPosts += 1;
          const values = new URLSearchParams(body);
          const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><title>Received choices</title><main><h2>Submitted Values</h2>'
            + '<p>Other field</p>'.repeat(10) + '<p>checkboxes</p>'
            + values.getAll('checkboxes').map(value => `<p>${escape(value)}</p>`).join('')
            + `<p>radioval</p><p>${escape(values.get('radioval') ?? '')}</p>`
            + '<h2>Editable form</h2><input type="checkbox" checked value="cb3"></main>');
        });
        return;
      }
      if (req.url === '/report.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(bytes); return; }
      if (req.url === '/portrait.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'); return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/choices') {
        res.end('<!doctype html><title>Choices</title><main><form method="post" action="/choice-result">'
          + ['cb1', 'cb2', 'cb3'].map(value => `<input id="${value}" name="checkboxes" type="checkbox" value="${value}"${value === 'cb3' ? ' checked' : ''}>`).join('')
          + '<input id="rd2" name="radioval" type="radio" value="rd2" checked>'
          + '<input id="rd3" name="radioval" type="radio" value="rd3"><button id="send" type="submit">Send</button></form></main>');
        return;
      }
      if (req.url === '/fields') {
        res.end('<!doctype html><title>Field sources</title><main><h1>Read exact fields</h1>'
          + '<a href="/story">.name Grandfathered</a>'
          + '<a href="/book" title="The Road to Little Dribbling: Adventures of an American in Britain">The Road to Little ...</a>'
          + '<table><tr><td><img src="/portrait.svg" width="20" height="20" alt="A portrait described by alt text">'
          + '<div>Daguerreotype of Lovelace (c. 1843)</div></td></tr></table></main>'); return;
      }
      if (req.url === '/fields-link') { res.end('<!doctype html><title>Start</title><main><a href="/fields">Read fields</a></main>'); return; }
      const n = Number(req.url?.split('/').at(-1));
      res.end(req.url?.startsWith('/rows/') ? '<!doctype html><title>Rows</title><main>'
        + ['Ada', 'Grace', 'Linus'].map(name => `<article class="entry"><span class="name">${name}${n}</span>`
          + '<span class="category">news</span></article>').join('')
        + (n < 3 ? `<a href="/rows/${n + 1}">Next →</a>` : '') + '</main>'
        : '<!doctype html><title>Guide</title><main><a href="/report.pdf" target="_blank">Read the report</a></main>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    fixture = await createReviewedBrowserFixture('about:blank');
  }, 240_000);
  afterAll(async () => { await fixture?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); }, 120_000);

  const harness = (source?: ExecutionSource) => {
    const commands: BridgeCommand[] = [];
    const saved = new Map<string, { bytes: Buffer; filename: string; mime_type: string }>();
    const files: BrowserFiles = {
      keep: async value => {
        const sha256 = createHash('sha256').update(value.bytes).digest('hex'), file_ref = `file:${sha256.slice(0, 32)}`;
        saved.set(file_ref, value);
        return { file_ref, filename: value.filename, mime_type: value.mime_type, size_bytes: value.bytes.length, sha256 };
      }, read: async ref => saved.get(ref)!, about: ref => {
        const value = saved.get(ref); return value ? { filename: value.filename, mime_type: value.mime_type, size_bytes: value.bytes.length } : undefined;
      },
    };
    const adapter = createBridgeDomAdapter({ files, pageReads: createPageReadStore(),
      fetchFile: createPublicFileFetch({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], treatAsPublic: a => a === '127.0.0.1' }),
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ cancel: async () => ({ ok: true }), canResolve: () => true, dispatch: async request => {
        await fixture.grant(request.ingredient);
        const command: BridgeCommand = { ...request, command_id: randomUUID(), target_domain_pattern: `${base}/*`, timeout_ms: 20_000 };
        commands.push(command);
        const { result } = await fixture.ordinaryCommand(command);
        return { kind: 'completed', result, bridge_client_token_id: 'fixture', attempts: 1 };
      } }),
    });
    const run = async (slug: string, input: Record<string, unknown>) => adapter({ slug,
      risk_tier: slug === 'dom-inspect' ? 'read' : 'write', output: {}, input: { target: `${base}/*`, ...input },
      stepMeta: { recipe_id: slug, step_id: slug, run_id: randomUUID(), ...(source ? { execution_source: source } : {}) } }) as Promise<Record<string, unknown>>;
    return { run, saved, commands };
  };

  it('continues a redirected form in the observed tab when a later call repeats its starting URL', async () => {
    await fixture.reset(`${base}/continuation`);
    const t = harness({ channel: 'chat', actor: 'user_self', chat_session_id: 'continuation', turn_id: 'turn1', user_id: 'owner' });
    const initial = await t.run('dom-inspect', { form: 'outline' });
    await t.run('dom-act', { page: `${base}/continuation`, steps: [{ do: 'click', selector: '#login' }, { do: 'read' }] });
    const before = t.commands.length;
    const done = await t.run('dom-act', { page: `${base}/continuation`, steps: [
      { do: 'type', selector: '#email', value: 'fixture@example.org' }, { do: 'click', selector: '#save' }, { do: 'read' },
    ] });
    const tab = (done.tabs as Array<{ page: string; reads: Array<{ outline: string }> }>)[0]!;
    expect(tab.page.split(':')[0]).toBe(String(initial.page).split(':')[0]);
    expect(tab.reads.at(-1)?.outline).toContain('Saved the requested value');
    expect(t.commands.slice(before).some(command => ['list_tabs', 'open_tab'].includes(command.action))).toBe(false);
  }, 40_000);

  it('reports selector cardinality through the real Bridge and reads a requested later item', async () => {
    await fixture.reset(`${base}/rows/1`);
    const t = harness(); const page = await t.run('dom-inspect', { form: 'outline' });
    const first = await t.run('dom-inspect', { page: page.page, selector: 'article.entry', form: 'outline' });
    expect(first).toMatchObject({ read_state: { scope: { kind: 'element', matched_count: 3, selected_index: 1 } } });
    expect(first.outline).toContain('Ada1'); expect(first.outline).not.toContain('Grace1');
    const second = await t.run('dom-inspect', { page: page.page, selector: 'article.entry:nth-of-type(2)', form: 'outline' });
    expect(second).toMatchObject({ read_state: { scope: { matched_count: 1, selected_index: 1 } } });
    expect(second.outline).toContain('Grace1'); expect(second.outline).not.toContain('Ada1');
  }, 40_000);

  it('reads all echoed choices after one native form POST, beyond eight section lines', async () => {
    await fixture.reset(`${base}/choices`);
    formPosts = 0;
    const t = harness();
    const read = await t.run('dom-inspect', { form: 'outline' });
    const done = await t.run('dom-act', { page: read.page, steps: [
      { do: 'type', selector: '#cb1', value: 'true' }, { do: 'type', selector: '#cb2', value: 'true' },
      { do: 'type', selector: '#cb3', value: 'false' }, { do: 'type', selector: '#rd3', value: 'true' },
      { do: 'submit', selector: '#send' }, { do: 'read', find: 'Submitted Values' },
    ] });
    const tab = (done.tabs as Array<{ reads: Array<Record<string, unknown>> }>)[0]!;
    expect(tab.reads[0]).toMatchObject({ complete: true, truncated: false });
    for (const value of ['cb1', 'cb2', 'rd3']) expect(tab.reads[0]!.lines).toContain(value);
    expect(tab.reads[0]!.lines).not.toContain('cb3');
    expect(formPosts).toBe(1);
    expect(t.commands.filter(command => command.action === 'submit')).toHaveLength(1);
  }, 40_000);

  it('hands a PDF opened in another tab to the existing reader without switching the action tab', async () => {
    await fixture.reset(`${base}/guide`);
    const t = harness(); const read = await t.run('dom-inspect', { form: 'outline' });
    const ref = /\[link: Read the report\]\((e\d+)/.exec(String(read.outline))![1];
    const clicked = await t.run('dom-click', { page: read.page, ref });
    expect(clicked.page).toBe(read.page);
    const kept = keptTabPdfs({ ok: true, result: clicked });
    expect(kept).toHaveLength(1);
    expect(t.saved.get(kept[0]!.file_ref)!.bytes.equals(bytes)).toBe(true);
    expect(clicked.pdf).toMatchObject({ source_url: `${base}/report.pdf` });
  }, 40_000);

  it('turns a verified selector hint into bounded collection on the real cleaned HTML', async () => {
    await fixture.reset(`${base}/rows/1`);
    const t = harness(); const read = await t.run('dom-inspect', { form: 'outline' });
    const hint = read.collection_hint as { step: Record<string, unknown> };
    const raw = await t.run('dom-inspect', { page: read.page, form: 'html' });
    expect(hint, String(raw.html)).toBeDefined();
    const answer = await t.run('dom-act', { page: read.page, steps: [{ ...hint.step, max_pages: 3 }] });
    const tabs = answer.tabs as Array<{ reads: Array<{ collection: { complete: boolean; records: Array<{ values: { name: string } }> } }> }>;
    const collection = tabs[0]!.reads[0]!.collection;
    expect(collection.complete).toBe(true);
    expect(collection.records.map(r => r.values.name)).toEqual(['Ada1', 'Grace1', 'Linus1', 'Ada2', 'Grace2', 'Linus2', 'Ada3', 'Grace3', 'Linus3']);
  }, 40_000);

  it('preserves exact linked text and source-labelled image fields from a real cleaned Chrome read', async () => {
    await fixture.reset(`${base}/fields`);
    const t = harness(), read = await t.run('dom-inspect', { form: 'outline' });
    const fields = read.field_evidence as { items: Array<{ tag: string; ref?: string; fields: Record<string, { value: string; source: string }> }> };
    expect(fields.items.some(item => item.fields.text?.value === '.name Grandfathered')).toBe(true);
    const book = fields.items.find(item => item.fields.title_attribute?.value.startsWith('The Road to Little Dribbling'))!;
    expect(book.ref).toMatch(/^e\d+$/);
    expect(book.fields.text!.value).toBe('The Road to Little ...');
    const image = fields.items.find(item => item.tag === 'img')!;
    expect(image.fields.alt).toEqual({ value: 'A portrait described by alt text', source: 'alt' });
    expect(image.fields.nearby_text).toEqual({ value: 'Daguerreotype of Lovelace (c. 1843)', source: 'containing-cell.textContent' });
    expect(image.fields.caption).toBeUndefined();
  }, 40_000);

  it('returns destination fields on a real navigation using only its existing post-click read', async () => {
    await fixture.reset(`${base}/fields-link`);
    const t = harness(), read = await t.run('dom-inspect', { form: 'outline' });
    const ref = /\[link: Read fields\]\((e\d+)/.exec(String(read.outline))![1];
    const before = t.commands.length;
    const clicked = await t.run('dom-click', { page: read.page, ref });
    const observation = clicked.page_observation as { state: string; loading: boolean; field_evidence: {
      items: Array<{ tag: string; fields: Record<string, { value: string; source: string }> }> } };
    expect(observation).toMatchObject({ state: 'snapshot', loading: false });
    expect(observation.field_evidence.items.some(item => item.fields.text?.value === '.name Grandfathered')).toBe(true);
    const image = observation.field_evidence.items.find(item => item.tag === 'img')!;
    expect(image.fields.nearby_text).toEqual({ value: 'Daguerreotype of Lovelace (c. 1843)', source: 'containing-cell.textContent' });
    expect(image.fields.alt!.value).toBe('A portrait described by alt text');
    expect(t.commands.slice(before).map(command => command.action)).toEqual(['click', 'reread']);
  }, 40_000);
});
