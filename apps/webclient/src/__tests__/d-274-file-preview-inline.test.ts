/** D-274 — the inline `file_preview` block, both halves.
 *
 *  Pass one is a STRING (this panel builds markup, and drawing a file needs a
 *  live element), pass two mounts the shared body renderer into it. So the
 *  tests are split the same way: the panel emits a mount carrying the file's
 *  identity, and `renderFilePreviewBody` draws into a container.
 *
 *  ⛔ NO JSDOM, per the house pattern — a hand-rolled fake `Document` records
 *  exactly which elements were made and what was set on them, which is a
 *  sharper assertion than querying a real DOM for "an img exists".
 */

import { describe, expect, it, vi } from 'vitest';
import {
  renderRecipeResultPanel,
  createResultActionRegistry,
  RECIPES_FILE_PREVIEW_MOUNT_ATTR,
  RECIPES_FILE_PREVIEW_NAME_ATTR,
  type RecipesResultPanelSnapshot,
  RECIPE_RESULT_PANEL_STYLES,
} from '../recipes/recipe-result-panel.js';
import { renderFilePreviewBody } from '../files/file-preview.js';

// ── a fake Document, only as rich as the renderer actually uses ──────────────
interface FakeEl {
  tag: string; children: FakeEl[]; attrs: Record<string, string>;
  textContent: string; alt?: string; src?: string; className?: string;
  append: (child: FakeEl) => void; setAttribute: (k: string, v: string) => void;
  replaceChildren: (...c: FakeEl[]) => void; decode?: () => Promise<void>;
}
const el = (tag: string, decodes = true): FakeEl => {
  const node: FakeEl = {
    tag, children: [], attrs: {}, textContent: '',
    append(child) { this.children.push(child); },
    setAttribute(k, v) { this.attrs[k] = v; },
    replaceChildren(...c) { this.children = c; },
  };
  if (tag === 'img') node.decode = decodes ? async () => {} : async () => { throw new Error('undecodable'); };
  return node;
};
const fakeDoc = (opts: { imageDecodes?: boolean } = {}) => ({
  createElement: (tag: string) => el(tag, opts.imageDecodes !== false),
  defaultView: { atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary') },
}) as unknown as Document;

const bytesOf = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const host = (doc: Document, body: FakeEl, urls: string[] = []) => ({
  doc, body: body as unknown as HTMLElement,
  urlFor: (_b: Uint8Array, mime: string) => { const u = `blob:${mime}:${urls.length}`; urls.push(u); return u; },
  status: () => {}, signal: new AbortController().signal,
  isCurrent: () => true, onFailure: () => {},
});
const callersFor = (result: unknown) => ({
  preview: vi.fn(async () => result as never),
  read: vi.fn(async () => ({}) as never),
});

describe('renderFilePreviewBody — the shared decoder, drawing into any container', () => {
  const imageFile = (over: Record<string, unknown> = {}) => ({
    record_id: 'file_1', filename: 'group.jpg', mime_type: 'image/jpeg',
    size_bytes: 5, can_download: true,
    content: { kind: 'image', bytes_b64: bytesOf('hello') },
    ...over,
  });

  it('draws an <img> for an image, and returns the metadata its caller needs for chrome', async () => {
    const doc = fakeDoc(); const body = el('div'); const urls: string[] = [];
    const meta = await renderFilePreviewBody(host(doc, body, urls), { record_id: 'file_1' }, callersFor(imageFile()));
    expect(body.children).toHaveLength(1);
    expect(body.children[0]?.tag).toBe('img');
    expect(body.children[0]?.alt).toBe('group.jpg');
    expect(body.children[0]?.src).toBe(urls[0]);        // the CALLER's url, not one it minted
    expect(meta).toMatchObject({ filename: 'group.jpg', mime_type: 'image/jpeg', can_download: true });
    expect(meta.bytes).toBeInstanceOf(Uint8Array);      // handed back for the caller to cache
  });

  it('⛔ refuses bytes whose length disagrees with the declared size', async () => {
    // The integrity check. A truncated download that still decoded would render
    // a half image rather than an error, and nothing downstream would know.
    const doc = fakeDoc(); const body = el('div');
    await expect(renderFilePreviewBody(host(doc, body), { record_id: 'file_1' },
      callersFor(imageFile({ size_bytes: 999 })))).rejects.toThrow(/incomplete/i);
    expect(body.children).toHaveLength(0);
  });

  it('⛔ refuses a payload over the preview cap before decoding it', async () => {
    const doc = fakeDoc(); const body = el('div');
    const huge = { ...imageFile(), content: { kind: 'image', bytes_b64: 'A'.repeat(40 * 1024 * 1024) } };
    await expect(renderFilePreviewBody(host(doc, body), { record_id: 'file_1' }, callersFor(huge)))
      .rejects.toThrow(/too large/i);
  });

  it('refuses a response for a DIFFERENT record than the one asked for', async () => {
    const doc = fakeDoc(); const body = el('div');
    await expect(renderFilePreviewBody(host(doc, body), { record_id: 'file_1' },
      callersFor(imageFile({ record_id: 'file_OTHER' })))).rejects.toThrow(/unavailable/i);
  });

  it('draws nothing and reports the reason when the server offers no preview', async () => {
    const doc = fakeDoc(); const body = el('div');
    const said: string[] = [];
    const meta = await renderFilePreviewBody(
      { ...host(doc, body), status: (t: string) => said.push(t) },
      { record_id: 'file_1' },
      callersFor({ ...imageFile(), content: null, unavailable_reason: 'Too big to preview.' }),
    );
    expect(body.children).toHaveLength(0);
    expect(said).toContain('Too big to preview.');
    expect(meta.bytes).toBeUndefined();     // nothing to cache, and it says so
  });

  it('turns an undecodable image into an error rather than an empty frame', async () => {
    const doc = fakeDoc({ imageDecodes: false }); const body = el('div');
    await expect(renderFilePreviewBody(host(doc, body), { record_id: 'file_1' }, callersFor(imageFile())))
      .rejects.toThrow(/could not be displayed/i);
  });

  it('⛔ reports the file\'s details BEFORE drawing, so a draw that throws still leaves them', async () => {
    // D-274 regression: the dialog enabled Download from the RESULT, and a draw
    // that threw returns none — so a file that could not be shown could not be
    // downloaded either, the one case a person needs the button for.
    const doc = fakeDoc({ imageDecodes: false }); const body = el('div');
    const order: string[] = [];
    const append = body.append.bind(body);
    body.append = (child) => { order.push('draw'); append(child); };
    await expect(renderFilePreviewBody({
      ...host(doc, body),
      onMeta: (meta) => order.push(`meta:${meta.filename}:${String(meta.can_download)}`),
    }, { record_id: 'file_1' }, callersFor(imageFile()))).rejects.toThrow(/could not be displayed/i);
    expect(order).toEqual(['meta:group.jpg:true', 'draw']);
  });

  it('draws a <pre> for text, through the same entry point', async () => {
    const doc = fakeDoc(); const body = el('div');
    await renderFilePreviewBody(host(doc, body), { record_id: 'file_1' }, callersFor({
      record_id: 'file_1', filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 5,
      can_download: true, content: { kind: 'text', bytes_b64: bytesOf('hello') },
    }));
    expect(body.children[0]?.tag).toBe('pre');
    expect(body.children[0]?.textContent).toBe('hello');
  });
});

describe('the result panel emits a mount carrying the file identity', () => {
  const REGISTRY = createResultActionRegistry([], new Map(), false, new Set(), new Map(), new Set());
  const panelWith = (data: unknown): RecipesResultPanelSnapshot => ({
    route_recipe_id: 'photo-detail', source_recipe_id: null, render_recipe_id: 'photo-detail',
    origin: 'run',
    result: {
      recipe_id: 'photo-detail', recipe_hash: 'h', success: true, duration_ms: 1,
      steps: [], errors: [],
      output: { render: [{ type: 'file_preview', source: 'step.preview', data }], sidebar: [] },
    },
  } as unknown as RecipesResultPanelSnapshot);
  const render = (data: unknown): string =>
    renderRecipeResultPanel(panelWith(data), [], REGISTRY, new Map(), new Map(), false, {});

  it('carries the record id and the filename, so pass two needs no other source', () => {
    const html = render({ record_id: 'file_9', filename: 'group.jpg', mime_type: 'image/jpeg' });
    expect(html).toContain(`${RECIPES_FILE_PREVIEW_MOUNT_ATTR}="file_9"`);
    expect(html).toContain(`${RECIPES_FILE_PREVIEW_NAME_ATTR}="group.jpg"`);
  });

  it('says what is loading, so a mount that never fills is not an empty box', () => {
    expect(render({ record_id: 'file_9', filename: 'group.jpg' })).toContain('group.jpg');
  });

  it('⛔ a descriptor with no record id renders a reason, not a dead mount', () => {
    const html = render({ filename: 'group.jpg' });
    expect(html).not.toContain(RECIPES_FILE_PREVIEW_MOUNT_ATTR);
    expect(html).toContain('carries no file');
  });

  it('escapes a hostile filename rather than emitting it into the attribute', () => {
    const html = render({ record_id: 'f1', filename: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
  });
});

describe('the result panel draws LIVE bytes with no fetch and nothing stored', () => {
  const REGISTRY = createResultActionRegistry([], new Map(), false, new Set(), new Map(), new Set());
  const render = (data: unknown): string => renderRecipeResultPanel({
    route_recipe_id: 'profile-detail', source_recipe_id: null, render_recipe_id: 'profile-detail',
    origin: 'run',
    result: {
      recipe_id: 'profile-detail', recipe_hash: 'h', success: true, duration_ms: 1,
      steps: [], errors: [],
      output: { render: [{ type: 'file_preview', source: 'step.live', data }], sidebar: [] },
    },
  } as unknown as RecipesResultPanelSnapshot, [], REGISTRY, new Map(), new Map(), false, {});

  const LIVE = { bytes_b64: 'AAECAw==', mime_type: 'image/jpeg', filename: 'maggie.jpg' };

  it('draws the bytes directly — no mount, so no second pass and nothing to go stale', () => {
    const html = render(LIVE);
    expect(html).toContain('src="data:image/jpeg;base64,AAECAw=="');
    expect(html).not.toContain(RECIPES_FILE_PREVIEW_MOUNT_ATTR);   // nothing to fetch
    expect(html).toContain('alt="maggie.jpg"');
  });

  it('⛔ refuses to draw a non-image inline, rather than emitting a broken <img>', () => {
    // A data: URL for a pdf would render an empty box. The record-id shape is the
    // route for anything the browser cannot draw from bytes alone.
    const html = render({ ...LIVE, mime_type: 'application/pdf' });
    expect(html).not.toContain('data:application/pdf');
    expect(html).toContain('carries no file');
  });

  it('prefers the live bytes when a block somehow carries both', () => {
    // Bytes are the fresher source by construction: they were read this run.
    const html = render({ ...LIVE, record_id: 'file_1' });
    expect(html).toContain('data:image/jpeg;base64');
    expect(html).not.toContain(RECIPES_FILE_PREVIEW_MOUNT_ATTR);
  });

  it('escapes a hostile mime type instead of closing the attribute', () => {
    const html = render({ ...LIVE, mime_type: 'image/jpeg"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
  });
});

describe('⛔ the picture is CONSTRAINED — a review card on a phone', () => {
  /** ⛔⛔ IT HAD NO CSS RULE AT ALL, and the two UA defaults it inherited both
   *  hurt. A `figure` carries `margin: 1em 40px`, which pushed the picture past
   *  the card's own border; an `img` with no `max-width` renders at its natural
   *  size. A preview is 768px wide and a phone column is about 366px.
   *
   *  Measured in real headless Chrome with this panel's OWN stylesheet at a
   *  390px viewport: 512px image in a 366px card, page overflowing, the
   *  photograph cut off at the right edge. With the rules: 344px, no overflow.
   *
   *  🔑 WHY IT MATTERS MORE HERE THAN IT LOOKS. This block is how the photo pack
   *  shows you a face before you approve sending it to someone. The whole
   *  safety story is "a person looks at the picture" — and on a phone half the
   *  picture was off screen. No test asserts pixels, so nothing caught it until
   *  it was rendered. */
  it('the stylesheet constrains the preview image and kills the figure margin', () => {
    // The CSS lives in this module as a template; assert the RULES, which is
    // the thing whose absence caused it — not a screenshot, which no suite here
    // is set up to take.
    const css = RECIPE_RESULT_PANEL_STYLES;
    expect(css, 'a figure default of 40px pushes the picture out of the card')
      .toMatch(/\.recipes-file-preview\s*\{[^}]*margin:\s*0/);
    expect(css, 'without this a 768px preview overflows a phone column')
      .toMatch(/\.recipes-file-preview img\s*\{[^}]*max-width:\s*100%/);
    expect(css, 'and it must not be squashed while being constrained')
      .toMatch(/\.recipes-file-preview img\s*\{[^}]*height:\s*auto/);
  });
});
