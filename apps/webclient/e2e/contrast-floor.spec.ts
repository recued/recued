import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Every route's text fields have an edge, and every keyboard stop a focus
 *  ring, that a reader can see: 3:1 against what surrounds them (WCAG 1.4.11),
 *  the ring at least 2px wide. Every link draws in the theme, not in the
 *  browser's own link colour, at 4.5:1 (WCAG 1.4.3).
 *
 *  ⛔ Measured 2026-10-23: all 41 fields on these routes drew at 1.17-1.48:1,
 *  and 331 of 380 focus stops drew the accent at 10% (1.14:1). Per-field fixes
 *  could not reach them, because the webclient's input floor outranked a
 *  component's own rule; the fix is app-wide, so the check is too. */

installFullAppHooks();

const ROUTES = [
  'chat', 'today', 'yours', 'data', 'views', 'mail', 'logs', 'stats', 'reception', 'approvals',
  'kitchen', 'contracts', 'connections', 'packs', 'recipes', 'automation',
  'settings/account', 'settings/servers', 'settings/backup', 'settings/ai-models', 'settings/seller',
  'settings/updates', 'settings/housekeeping', 'settings/privacy', 'settings/devices',
  'settings/notifications', 'settings/email-chat', 'settings/server/connect-device',
  'settings/server/exposure', 'settings/server/hostnames', 'settings/server/certificates',
  'settings/server/timezone', 'settings/server/key-health', 'settings/server/maintenance',
];

interface Weak { route: string; element: string; measured: string }

/** Colour maths shared by both measurements, run in the page. Chrome reports
 *  a color-mix() result as `color(srgb r g b)` in 0-1, which an rgb() reader
 *  takes for near-black. */
const MEASURE = `(() => {
  const parse = (css) => {
    let m = /^color\\(srgb ([\\d.e-]+) ([\\d.e-]+) ([\\d.e-]+)(?: \\/ ([\\d.]+))?\\)/.exec(css || '');
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] !== undefined ? +m[4] : 1];
    m = /^rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/.exec(css || '');
    return m ? [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1] : null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
  const behind = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; }
    }
    let base = parse(getComputedStyle(document.body).backgroundColor);
    if (!base || base[3] === 0) base = [255, 255, 255, 1];
    for (const c of stack.reverse()) base = over(c, base);
    return base;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && +cs.opacity > 0.05;
  };
  const name = (el) => {
    const marks = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-recued')).slice(0, 1);
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 30);
    return el.tagName.toLowerCase() + (marks.length ? '[' + marks[0] + ']' : '') + ' "' + label + '"';
  };
  return { parse, over, ratio, behind, shown, name };
})()`;

interface Sweep { measured: number; weak: Array<{ element: string; measured: string }> }

const sweepFields = (page: Page): Promise<Sweep> =>
  page.evaluate((measure) => {
    const { parse, over, ratio, behind, shown, name } = (0, eval)(measure);
    const skip = new Set(['checkbox', 'radio', 'range', 'color', 'hidden', 'file', 'submit', 'button', 'image', 'reset']);
    const fields = [...document.querySelectorAll<HTMLElement>('input, select, textarea')]
      .filter((el) => !(el instanceof HTMLInputElement && skip.has(el.type)) && shown(el));
    const weak = fields.flatMap((el) => {
        const cs = getComputedStyle(el);
        const outside = behind(el.parentElement ?? el);
        const fill = ratio(over(parse(cs.backgroundColor) ?? [0, 0, 0, 0], outside), outside);
        const edge = Math.max(0, ...(['Top', 'Bottom', 'Left', 'Right'] as const)
          .filter((side) => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
            && cs.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none')
          .map((side) => {
            const c = parse(cs.getPropertyValue(`border-${side.toLowerCase()}-color`));
            return c ? ratio(over(c, outside), outside) : 0;
          }));
        return edge >= 3 || fill >= 3 ? [] : [{ element: name(el), measured: `edge ${edge.toFixed(2)}:1, fill ${fill.toFixed(2)}:1` }];
      });
    return { measured: fields.length, weak };
  }, MEASURE);

/** Tab through the route from its top and measure each stop's ring. */
const sweepFocus = async (page: Page): Promise<Sweep> => {
  const weak: Array<{ element: string; measured: string }> = [];
  const started = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-recued-webclient-content]');
    if (content === null) return false;
    content.setAttribute('tabindex', '-1');
    content.focus();
    return true;
  });
  expect(started).toBe(true);
  const seen = new Set<string>();
  for (let stop = 0; stop < 60; stop += 1) {
    await page.keyboard.press('Tab');
    const result = await page.evaluate((measure) => {
      const { parse, over, ratio, behind, shown, name } = (0, eval)(measure);
      const el = document.activeElement as HTMLElement | null;
      const content = document.querySelector('[data-recued-webclient-content]');
      if (el === null || content === null || el === content || !content.contains(el)) return { done: true };
      if (!shown(el)) return { skip: true };
      const cs = getComputedStyle(el);
      const outside = behind(el.parentElement ?? el);
      let best = 0;
      const outline = parse(cs.outlineColor);
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && outline) {
        best = Math.max(best, ratio(over(outline, outside), outside));
      }
      // A ring is a box-shadow with no offset or blur; its width is its spread
      // past the ring inside it.
      const shadows: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of cs.boxShadow === 'none' ? '' : cs.boxShadow) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { shadows.push(current.trim()); current = ''; } else current += ch;
      }
      if (current.trim()) shadows.push(current.trim());
      let inner = 0;
      shadows
        .map((shadow) => {
          const color = /^(rgba?\([^)]*\)|color\([^)]*\))/.exec(shadow)?.[1] ?? '';
          const [x = 0, y = 0, blur = 0, spread = 0] = shadow.replace(color, '').trim().split(/\s+/).map(parseFloat);
          return { color: parse(color), x, y, blur, spread, inset: shadow.includes('inset') };
        })
        .filter((s) => s.color && !s.inset && s.x === 0 && s.y === 0 && s.blur <= 1 && s.spread > 0)
        .sort((a, b) => a.spread - b.spread)
        .forEach((s) => {
          if (s.spread - inner >= 2) best = Math.max(best, ratio(over(s.color, outside), outside));
          inner = s.spread;
        });
      return { element: name(el), best };
    }, MEASURE);
    if ('done' in result) break;
    if ('skip' in result || seen.has(result.element)) continue;
    seen.add(result.element);
    if (result.best < 3) weak.push({ element: result.element, measured: `best ring ${result.best.toFixed(2)}:1` });
  }
  return { measured: seen.size, weak };
};

/** Every link the route shows: drawn in the theme rather than in the
 *  browser's own link colour, and at 4.5:1 against what it sits on. */
const sweepLinks = (page: Page): Promise<Sweep> =>
  page.evaluate((measure) => {
    const { parse, over, ratio, behind, shown, name } = (0, eval)(measure);
    // What the browser draws a link in, in this theme, when nothing styles it.
    const probe = document.createElement('a');
    probe.href = '#';
    probe.style.setProperty('all', 'revert');
    document.body.appendChild(probe);
    const browserInk = getComputedStyle(probe).color;
    probe.remove();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(shown);
    const weak = links.flatMap((el) => {
      const ink = getComputedStyle(el).color;
      if (ink === browserInk) return [{ element: name(el), measured: `the browser's own link colour, ${ink}` }];
      const c = parse(ink);
      const outside = behind(el);
      const text = c ? ratio(over(c, outside), outside) : 0;
      return text >= 4.5 ? [] : [{ element: name(el), measured: `text ${text.toFixed(2)}:1` }];
    });
    return { measured: links.length, weak };
  }, MEASURE);

for (const scheme of ['light', 'dark'] as const) {
  test(`every route's fields and focus rings meet 3:1 in the ${scheme} theme`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${HARNESS_URL}?devices=ready&account=bound&server_profiles=multiple#chat`);
    await page.waitForFunction(() => window.__app?.ready === true);
    // Read end states: a box-shadow mid-transition reads as no ring at all.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    const weak: Weak[] = [];
    let fields = 0;
    let stops = 0;
    for (const route of ROUTES) {
      await page.evaluate((hash) => window.__app.setHash(`#${hash}`), route);
      await page.waitForTimeout(500);
      const fieldSweep = await sweepFields(page);
      const focusSweep = await sweepFocus(page);
      fields += fieldSweep.measured;
      stops += focusSweep.measured;
      for (const found of [...fieldSweep.weak, ...focusSweep.weak]) weak.push({ route, ...found });
    }
    // The sweep looked at something: these routes held 41 fields and 380 stops.
    expect(fields).toBeGreaterThan(30);
    expect(stops).toBeGreaterThan(250);
    expect(weak).toEqual([]);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`every route's links draw in the ${scheme} theme at 4.5:1`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${HARNESS_URL}?devices=ready&account=bound&server_profiles=multiple#chat`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const weak: Weak[] = [];
    let links = 0;
    for (const route of ROUTES) {
      await page.evaluate((hash) => window.__app.setHash(`#${hash}`), route);
      await page.waitForTimeout(500);
      const sweep = await sweepLinks(page);
      links += sweep.measured;
      for (const found of sweep.weak) weak.push({ route, ...found });
    }
    // ⛔ Two drew the browser's own link blue (lavender in dark): Today's
    // "Connect a phone channel" and Backup's S3 link.
    // The sweep looked at something: these routes held 80 links.
    expect(links).toBeGreaterThan(60);
    expect(weak).toEqual([]);
  });
}
