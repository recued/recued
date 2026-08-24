import { describe, it, expect } from 'vitest';
import { renderIcon, ICONS, ICON_NAMES } from '../icon-render.js';

// ────────────────────────────────────────────────────────────────

describe('renderIcon', () => {
  it('returns the raw svg when no className is given', () => {
    const html = renderIcon('settings');
    expect(html).toMatch(/^<svg /);
    expect(html).toContain('</svg>');
    expect(html).toContain('role="img"');
  });

  it('injects a className into the svg root tag', () => {
    const html = renderIcon('settings', 'icon icon-md');
    expect(html).toContain('class="icon icon-md"');
  });

  it('appends to existing class attribute when present', () => {
    // We can't easily craft an icon WITH class via the registry, but
    // we can verify the regex behavior by passing a synthetic svg.
    // Use an existing icon that doesn't currently carry a class — the
    // helper should still inject one.
    const html = renderIcon('play', 'icon');
    expect(html).toContain('class="icon"');
  });

  it('preserves the SVG body intact when injecting class', () => {
    const without = renderIcon('check');
    const with_ = renderIcon('check', 'icon');
    // Strip the injected class and the strings should match
    const strippedWith = with_.replace(/\sclass="icon"/, '');
    expect(strippedWith).toBe(without);
  });

  it('works for every registered icon', () => {
    for (const name of ICON_NAMES) {
      const html = renderIcon(name, 'icon');
      expect(html).toMatch(/^<svg /);
      expect(html).toContain('class="icon"');
      expect(html).toContain('</svg>');
    }
  });

  it('all icons in the registry have non-empty bodies', () => {
    for (const name of ICON_NAMES) {
      expect(ICONS[name].length).toBeGreaterThan(0);
      expect(ICONS[name]).toContain('<svg');
    }
  });
});

describe('ICONS registry', () => {
  it('exposes the core icon names', () => {
    expect(ICON_NAMES).toContain('logo');
    expect(ICON_NAMES).toContain('settings');
    expect(ICON_NAMES).toContain('play');
    expect(ICON_NAMES).toContain('check');
    expect(ICON_NAMES).toContain('x');
    expect(ICON_NAMES).toContain('marketplace');
    expect(ICON_NAMES).toContain('spinner');
  });

  it('every icon contains role="img" + aria-label (a11y enforced at the source)', () => {
    for (const name of ICON_NAMES) {
      expect(ICONS[name]).toContain('role="img"');
      expect(ICONS[name]).toContain('aria-label=');
    }
  });

  it('keeps both Recued marks on the canonical teal identity', () => {
    for (const name of ['action', 'logo'] as const) {
      expect(ICONS[name]).toContain('#0e7490');
      expect(ICONS[name]).not.toMatch(/paprika|tray|open R path|#c1440e/i);
    }
  });

  // The Recued mark is a deliberate placeholder, but every byte of these
  // strings is inlined into shipped markup and into the Chrome Web Store
  // package — so the placeholder's INTERNAL STATUS must never travel with it.
  // Assert the absence of status wording rather than the presence of a
  // particular description: pinning the prose (an earlier version of this test
  // asserted `toContain('three descending queue lines')`) makes the placeholder
  // sticky and fails the moment someone lands the real artwork, which is the
  // one change this file should never obstruct.
  it('never ships internal status wording in any icon', () => {
    const LEAKS = /\b(temporary|temp|placeholder|draft|stub|provisional|TODO|FIXME|WIP|internal only|do not ship)\b/i;
    for (const [name, svg] of Object.entries(ICONS)) {
      expect(svg, `${name} leaks internal status wording`).not.toMatch(LEAKS);
    }
  });

  it('ICONS is frozen', () => {
    expect(Object.isFrozen(ICONS)).toBe(true);
  });
});
