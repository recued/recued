/** D-149 P4 § A.5.1 — reception_page renderer tests (pure-fn).
 *
 *  Covers:
 *    - `htmlEscape` substitutes the 5 XML predeclared entities.
 *    - Placeholder body has the substrate-defined copy + no user fields.
 *    - Configured render emits the closed-list field set.
 *    - Header carries CSP + viewport + favicon link. */

import { describe, expect, it } from 'vitest';
import {
  htmlEscape,
  renderReceptionPageHtml,
  renderReceptionPagePlaceholderHtml,
  type ReceptionPageRenderInput,
} from '../ports/reception/handlers/reception-page-render.js';
import {
  assembleReceptionPageSourceView,
  buildReceptionPagePacketRawInput,
} from '../ports/reception/transformations/reception-page.js';
import type { ReceptionPageConfig } from '@recued/contracts';

describe('D-149 P4 § A.5.1 — htmlEscape', () => {
  it('substitutes the 5 XML predeclared entities', () => {
    expect(htmlEscape('&')).toBe('&amp;');
    expect(htmlEscape('<')).toBe('&lt;');
    expect(htmlEscape('>')).toBe('&gt;');
    expect(htmlEscape('"')).toBe('&quot;');
    expect(htmlEscape("'")).toBe('&#39;');
  });

  it('escapes a mixed string', () => {
    expect(htmlEscape('Tom & Jerry "say" <hi>')).toBe(
      'Tom &amp; Jerry &quot;say&quot; &lt;hi&gt;',
    );
  });

  it('passes through plain text unchanged', () => {
    expect(htmlEscape('hello world')).toBe('hello world');
  });
});

describe('D-149 P4 § A.5.1 — renderReceptionPagePlaceholderHtml', () => {
  it('contains the substrate placeholder copy', () => {
    const out = renderReceptionPagePlaceholderHtml('UTC');
    expect(out).toContain('Reception is not yet configured');
  });

  it('emits CSP meta-tag with script-src none', () => {
    const out = renderReceptionPagePlaceholderHtml('UTC');
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain("script-src 'none'");
    expect(out).toContain("default-src 'self'");
  });

  it('emits favicon + style link', () => {
    const out = renderReceptionPagePlaceholderHtml('UTC');
    expect(out).toContain('/reception/_static/favicon.ico');
    expect(out).toContain('/reception/_static/style.css');
  });

  it('escapes tz_label in the footer', () => {
    const out = renderReceptionPagePlaceholderHtml('<bad>');
    expect(out).toContain('&lt;bad&gt;');
    expect(out).not.toContain('<bad>');
  });
});

describe('D-149 P4 § A.5.1 — renderReceptionPageHtml', () => {
  const baseInput: ReceptionPageRenderInput = {
    display_name: 'Mary',
    tagline: 'Available',
    tz_label: 'UTC',
    preferred_contact_methods: ['email'],
    cta_buttons: [
      {
        label: 'Schedule',
        endpoint_id: 'sl_abc',
        kind: 'scheduling_link',
        href: '/reception/scheduling/sl_abc',
      },
    ],
  };

  it('renders display_name + tagline', () => {
    const out = renderReceptionPageHtml(baseInput);
    expect(out).toContain('Mary');
    expect(out).toContain('Available');
  });

  it('renders CTA with kind→path-segment mapping', () => {
    const out = renderReceptionPageHtml(baseInput);
    expect(out).toContain('/reception/scheduling/sl_abc');
  });

  it('CTAs use rel=noopener noreferrer (link-redirect defense)', () => {
    const out = renderReceptionPageHtml(baseInput);
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('omits avatar img when avatar_url unset; renders placeholder div', () => {
    const out = renderReceptionPageHtml(baseInput);
    expect(out).toContain('class="rcp-avatar" aria-hidden="true"');
    expect(out).not.toContain('<img class="rcp-avatar"');
  });

  it('renders avatar img when avatar_url set', () => {
    const out = renderReceptionPageHtml({
      ...baseInput,
      avatar_url: 'https://example.com/me.jpg',
    });
    expect(out).toContain('<img class="rcp-avatar" src="https://example.com/me.jpg"');
  });

  it('escapes display_name (XSS hardening)', () => {
    const out = renderReceptionPageHtml({
      ...baseInput,
      display_name: '<img src=x onerror=alert(1)>',
    });
    expect(out).not.toContain('<img src=x onerror=alert(1)>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders placeholder hint when every section is empty', () => {
    const out = renderReceptionPageHtml({
      ...baseInput,
      preferred_contact_methods: [],
      cta_buttons: [],
      custom_links: undefined,
    });
    expect(out).toContain('Reception is not yet configured');
  });

  it('renders custom_links when provided', () => {
    const out = renderReceptionPageHtml({
      ...baseInput,
      custom_links: [{ label: 'My blog', url: 'https://example.com/blog' }],
    });
    expect(out).toContain('My blog');
    expect(out).toContain('https://example.com/blog');
  });

  it('renders D-196 link buttons as escaped plain navigation with descriptions', () => {
    const out = renderReceptionPageHtml({
      ...baseInput,
      link_buttons: [{
        label: 'Subscribe <now>',
        url: 'https://buy.stripe.com/example?plan=pro&source=reception',
        description: 'Checkout stays on the seller\'s provider & never posts here.',
      }],
    });
    expect(out).toContain('Subscribe &lt;now&gt;');
    expect(out).toContain('https://buy.stripe.com/example?plan=pro&amp;source=reception');
    expect(out).toContain('seller&#39;s provider &amp; never posts here.');
    // D-207 slice 2 — the block now comes from the ONE shared renderer
    // (`@recued/renderer`), which the intake-form response also consumes, so it
    // carries the renderer's class vocabulary rather than this page's `rcp-*`.
    // The page still owns the section chrome around it.
    expect(out).toContain('class="block link-button-block"');
    expect(out).toContain('class="link-button"');
    expect(out).toContain('class="rcp-section-title">Links</p>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('target=');
  });

  it('drops D-196 link buttons that fail the reusable contract at the render boundary', () => {
    const out = renderReceptionPageHtml({
      ...baseInput,
      link_buttons: [
        { label: 'Safe', url: 'https://example.com/safe' },
        { label: 'Unsafe', url: 'javascript:alert(1)' },
      ],
    });
    expect(out).toContain('https://example.com/safe');
    expect(out).toContain('Safe');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('Unsafe');
  });
});

describe('D-149 P4 § A.5.1 — assembleReceptionPageSourceView', () => {
  const baseConfig: ReceptionPageConfig = {
    display_overrides: {
      display_name: 'Mary',
      tagline: 'Available',
      tz_label: 'UTC',
      preferred_contact_methods: ['email'],
    },
    sections_enabled: {
      contact_card: true,
      contact_methods: true,
      availability_cta: true,
      intake_cta: false,
      drop_cta: false,
      custom_links: false,
    },
    linked_endpoints: {
      scheduling_link_endpoint_id: 'sl_abc',
    },
  };

  it('produces a usable source view for a valid config', () => {
    const view = assembleReceptionPageSourceView(baseConfig);
    expect(view).not.toBeNull();
    expect(view?.display_name).toBe('Mary');
    expect(view?.section_config?.availability_cta).toBe(true);
    expect(view?.linked_endpoints?.scheduling_link_endpoint_id).toBe('sl_abc');
  });

  it('returns null when display_name is empty', () => {
    const broken = {
      ...baseConfig,
      display_overrides: { ...baseConfig.display_overrides, display_name: '' },
    };
    expect(assembleReceptionPageSourceView(broken)).toBeNull();
  });

  it('returns null when tz_label is empty', () => {
    const broken = {
      ...baseConfig,
      display_overrides: { ...baseConfig.display_overrides, tz_label: '' },
    };
    expect(assembleReceptionPageSourceView(broken)).toBeNull();
  });

  it('round-trips through buildReceptionPagePacketRawInput', () => {
    const view = assembleReceptionPageSourceView(baseConfig);
    if (!view) throw new Error('view should not be null');
    const raw = buildReceptionPagePacketRawInput(view);
    expect(raw.display_name).toBe('Mary');
    expect(raw.section_config?.availability_cta).toBe(true);
  });
});
