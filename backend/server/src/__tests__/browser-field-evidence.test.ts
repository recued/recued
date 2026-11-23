import { describe, expect, it, vi } from 'vitest';
import { BROWSER_POST_ACTION_CHARS, isBrowserPostActionState, type BrowserPostActionState, type BridgeResult } from '@recued/contracts';
import { browserFieldEvidence, BROWSER_FIELD_EVIDENCE_CHARS, BROWSER_FIELD_EVIDENCE_ITEMS } from '../bridges/browser-field-evidence.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { BATCH_READS_MAX_CHARS } from '../bridges/dom-adapter.js';

const full = { whole: true, truncated: false };
const bookTitle = 'The Road to Little Dribbling: Adventures of an American in Britain';
const fieldsHtml = `<main><h1>Stories and books</h1><a ref="e12" href="/story">.name Grandfathered</a>`
  + `<a ref="e13" title="${bookTitle}" aria-label="Book details">The Road to Little ...</a>`
  + '<table><tr><td><img alt="A portrait, not its caption"><div>Daguerreotype of Lovelace (c. 1843)</div></td></tr></table></main>';

describe('bounded fields from the same cleaned browser read', () => {
  it('preserves headline punctuation and separates displayed text, title attributes and aria labels', () => {
    const view = browserFieldEvidence(fieldsHtml, full)!;
    expect(view).toMatchObject({ scope: 'main', complete: true });
    expect(view.items.find(item => item.ref === 'e12')!.fields.text)
      .toEqual({ value: '.name Grandfathered', source: 'textContent' });
    expect(view.items.find(item => item.ref === 'e13')!.fields).toEqual({
      text: { value: 'The Road to Little ...', source: 'textContent' },
      title_attribute: { value: bookTitle, source: 'title' }, aria_label: { value: 'Book details', source: 'aria-label' },
    });
  });

  it('keeps alt text, semantic captions and nearby cell text distinct without attributing a group caption to an image', () => {
    const view = browserFieldEvidence(fieldsHtml + '<figure><img alt="Other portrait"><figcaption>Its actual caption</figcaption></figure>', full)!;
    const image = view.items.find(item => item.tag === 'img')!;
    expect(image.fields).toEqual({ alt: { value: 'A portrait, not its caption', source: 'alt' },
      nearby_text: { value: 'Daguerreotype of Lovelace (c. 1843)', source: 'containing-cell.textContent' } });
    expect(image.fields.caption).toBeUndefined();
    const semantic = browserFieldEvidence('<figure><img alt="Different alt"><figcaption>Its actual caption</figcaption></figure>', full)!;
    expect(semantic.items[0]!.fields.caption).toEqual({ value: 'Its actual caption', source: 'figcaption.textContent' });
    const ambiguous = browserFieldEvidence('<figure><img alt="One"><img alt="Two"><figcaption>Both</figcaption></figure>', full)!;
    expect(ambiguous.items.every(item => item.fields.caption === undefined)).toBe(true);
    expect(browserFieldEvidence('<img alt="Only alt">', full)!.items[0]!.fields).not.toHaveProperty('caption');
  });

  it('never reads form values, hidden text or page programs into the field view', () => {
    const html = '<main><h1>Safe<input value="SECRET_INPUT"><textarea>SECRET_AREA</textarea><script>SECRET_SCRIPT</script></h1>'
      + '<a ref="e1" title="&quot;literal&quot; &amp; punctuation">Visible.name</a>'
      + '<div hidden><a>SECRET_HIDDEN</a></div><nav><a>Navigation</a></nav></main>';
    const view = browserFieldEvidence(html, full)!;
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(JSON.stringify(view)).not.toContain('Navigation');
    expect(view.items.find(item => item.ref === 'e1')!.fields.title_attribute!.value).toBe('"literal" & punctuation');
  });

  it('marks source, value, item and character limits instead of presenting clipped fields as complete', () => {
    const cut = browserFieldEvidence('<a ref="e1">' + 'x'.repeat(1_001) + '</a>', { whole: false, truncated: true })!;
    expect(cut).toMatchObject({ scope: 'region', complete: false, incomplete: ['page_truncated', 'value_truncated'] });
    expect(cut.items[0]!.fields.text).toMatchObject({ truncated: true });
    const many = browserFieldEvidence(Array.from({ length: 30 }, (_, i) => `<a ref="e${i + 1}">Text ${i}</a>`).join(''), full)!;
    expect(many.items).toHaveLength(BROWSER_FIELD_EVIDENCE_ITEMS);
    expect(many).toMatchObject({ complete: false, incomplete: ['item_limit'] });
    const large = browserFieldEvidence('<a title="' + 't'.repeat(1_000) + '">' + 'x'.repeat(1_000) + '</a>'
      + '<a title="' + 't'.repeat(1_000) + '">' + 'x'.repeat(1_000) + '</a>', full)!;
    expect(JSON.stringify(large).length).toBeLessThanOrEqual(BROWSER_FIELD_EVIDENCE_CHARS);
    expect(large.incomplete).toContain('character_limit');
    expect(browserFieldEvidence('<div>'.repeat(130) + '<a>Deep</a>' + '</div>'.repeat(130), full))
      .toMatchObject({ complete: false, incomplete: ['depth_limit'] });
    expect(browserFieldEvidence('<i></i>'.repeat(15_001), full)).toMatchObject({ complete: false, incomplete: ['node_limit'] });
  });

  it('limits a whole read to its main content while a scoped read retains its own source region', () => {
    for (const tag of ['main', 'article']) {
      const html = `<a ref="e1">Outside</a><${tag}><a ref="e2">Inside</a></${tag}>`;
      expect(browserFieldEvidence(html, full)!.items.map(item => item.ref)).toEqual(['e2']);
      expect(browserFieldEvidence(html, { ...full, whole: false })!.items.map(item => item.ref)).toEqual(['e1', 'e2']);
    }
  });
});

describe('field evidence through the real DOM adapter', () => {
  it('adds exact fields to fresh outline/text and scoped HTML reads, never a loading result or a later cached part', async () => {
    let html = fieldsHtml, loading = false;
    const dispatch = vi.fn(async () => ({ kind: 'completed' as const, bridge_client_token_id: 'bridge', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
        outputs: { page: '7:DOC1', url: 'https://example.org/', title: 'Page title', html, truncated: false, ...(loading ? { loading } : {}) } } as BridgeResult }));
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
    });
    const read = (input: Record<string, unknown>) => adapter({ slug: 'dom-inspect', risk_tier: 'read', output: {},
      input: { target: '*://*/*', page: '7:DOC1', ...input },
      stepMeta: { recipe_id: 'inspect-web-page', step_id: 'read', run_id: 'r1' } }) as Promise<Record<string, unknown>>;
    for (const form of ['outline', 'text']) {
      const out = await read({ form });
      expect(out).toHaveProperty('field_evidence.scope', 'main');
      expect(JSON.stringify(out.field_evidence)).toContain('.name Grandfathered');
      expect(out.title).toBe('Page title');
    }
    expect(await read({ form: 'html' })).not.toHaveProperty('field_evidence');
    const before = dispatch.mock.calls.length;
    expect(await read({ form: 'text', from: 1 })).not.toHaveProperty('field_evidence');
    expect(dispatch.mock.calls.length).toBe(before);
    html = '<a ref="e13" title="' + bookTitle + '">The Road to Little ...</a>';
    const scoped = await read({ ref: 'e13' });
    expect(scoped).toHaveProperty('field_evidence.scope', 'region');
    expect(JSON.stringify(scoped.field_evidence)).not.toContain('Grandfathered');
    loading = true;
    expect(await read({ form: 'outline' })).not.toHaveProperty('field_evidence');
    expect(await read({ ref: 'e13' })).not.toHaveProperty('field_evidence');
    loading = false;
    const stillLoading = await read({ ref: 'e13' });
    expect(stillLoading.loading).toBe(true);
    expect(stillLoading).not.toHaveProperty('field_evidence');
  });

  it('charges structured field evidence to a batch read budget instead of allowing it past the text-only limit', async () => {
    const html = '<main>' + Array.from({ length: 12 }, (_, i) => `<a ref="e${i + 1}">Link ${i} ${'x'.repeat(130)}</a>`).join('') + '</main>';
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ cancel: vi.fn(), canResolve: () => true, dispatch: async () => ({
        kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
          outputs: { page: '7:DOC1', url: 'https://example.org/', title: 'Links', html, truncated: false } } as BridgeResult,
      }) }),
    });
    const result = await adapter({ slug: 'dom-act', risk_tier: 'write', output: {},
      input: { target: '*://*/*', page: '7:DOC1', steps: Array.from({ length: 20 }, () => ({ do: 'read', form: 'text' })) },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'read', run_id: 'r2' } }) as { tabs: Array<{ reads: Array<{ text?: string; not_read?: string }> }> };
    const reads = result.tabs[0]!.reads;
    const first = reads.find(read => read.text)!;
    expect(first.text!.length * 20).toBeLessThan(60_000);
    expect(reads.some(read => read.not_read?.includes('60000'))).toBe(true);
  });

  it('keeps a fresh bounded action view when the separate batch read budget is exhausted', async () => {
    let clicked = false;
    const dispatch = vi.fn(async (request: { action: string }) => {
      if (request.action === 'click') clicked = true;
      return { kind: 'completed' as const, bridge_client_token_id: 'bridge', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
          outputs: request.action === 'click' ? { page: '7:DOC1', url: 'https://example.org/', title: 'Page', clicked: true, moved: false }
            : { page: '7:DOC1', url: 'https://example.org/', title: 'Page', truncated: false,
              html: clicked ? '<main><h1>Changed title</h1>'
                + Array.from({ length: 16 }, (_, i) => `<a ref="e${i + 2}">${'Link text '.repeat(80)}</a>`).join('') + '</main>'
                : '<main><p>' + 'x'.repeat(4_000) + '</p><button ref="e1" id="change">Change</button></main>' } } as BridgeResult };
    });
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }),
    });
    const result = await adapter({ slug: 'dom-act', risk_tier: 'write', output: {},
      input: { target: '*://*/*', page: '7:DOC1', steps: [
        ...Array.from({ length: 19 }, () => ({ do: 'read', form: 'text' })), { do: 'click', selector: '#change' },
      ] }, stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'closing-budget' } }) as {
      tabs: Array<{ reads: Array<{ text?: string; not_read?: string; [key: string]: unknown }>; post_action: BrowserPostActionState }>;
    };
    const tab = result.tabs[0]!;
    expect(tab.reads.some(read => read.not_read)).toBe(true);
    // The read budget covers returned string/structured content. The passive
    // action receipt has its own fixed bound, including optional metadata.
    const delivered = tab.reads.filter(read => !read.not_read).flatMap(read => Object.values(read))
      .reduce<number>((n, value) => n + (typeof value === 'string' ? value.length
        : value !== null && typeof value === 'object' ? JSON.stringify(value).length : 0), 0);
    expect(delivered).toBeLessThanOrEqual(BATCH_READS_MAX_CHARS);
    expect(isBrowserPostActionState(tab.post_action)).toBe(true);
    expect(JSON.stringify(tab.post_action).length).toBeLessThanOrEqual(BROWSER_POST_ACTION_CHARS);
    expect(tab.post_action).toMatchObject({ action_status: 'acknowledged', application_outcome: 'unverified',
      view_status: 'fresh', current_page: '7:DOC1' });
    expect(tab.post_action.view!.outline).toContain('Changed title');
    if (tab.post_action.view!.field_evidence) expect(tab.post_action.view!.field_evidence).toMatchObject({ complete: false });
    else expect(tab.post_action.view!.omitted).toContain('field_evidence');
    expect(tab).not.toHaveProperty('page_observation');
    expect(dispatch.mock.calls.filter(([request]) => request.action === 'click')).toHaveLength(1);
    expect(dispatch.mock.calls.slice(dispatch.mock.calls.findIndex(([request]) => request.action === 'click') + 1))
      .toHaveLength(1);
  });
});
