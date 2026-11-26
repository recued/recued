import { describe, expect, it } from 'vitest';
import { browserActReadsOnly, browserActStepMayMove, browserActStepWrites, parseBrowserActSteps } from '../browser-act.js';
import { BROWSER_COLLECT_MAX_VIOLATIONS, parseBrowserCollectSelector } from '../browser-collect.js';

const collect = { do: 'collect', items: '.item', fields: { name: '.name', link: { selector: 'a', attribute: 'href' } },
  next: { text: 'Next' }, max_pages: 3 };

describe('bounded browser collection contract', () => {
  it('normalizes fields and bounds and classifies navigation for existing admission', () => {
    const parsed = parseBrowserActSteps([collect]);
    expect(parsed).toEqual({ ok: true, steps: [{ ...collect, fields: { name: { selector: '.name' },
      link: { selector: 'a', attribute: 'href' } }, max_items: 200, max_seconds: 60 }] });
    if (!parsed.ok) return;
    // It may move its tab, so a step after it could not be read first; but it reads (2026-11-23, the owner: "make
    // Collects that turn pages read too"), on one page or across its Next pages, and a change before it still asks.
    expect(browserActStepMayMove(parsed.steps[0]!)).toBe(true);
    expect(browserActStepWrites(parsed.steps[0]!)).toBe(false);
    expect(browserActReadsOnly(parsed.steps)).toBe(true);
    const single = parseBrowserActSteps([{ ...collect, max_pages: 1 }]);
    expect(single.ok && browserActReadsOnly(single.steps)).toBe(true);
    const behindClick = parseBrowserActSteps([{ do: 'click', text: 'Show all' }, collect]);
    expect(behindClick.ok && browserActReadsOnly(behindClick.steps)).toBe(false);
  });

  it('refuses actions after collection and malformed or unbounded requests before dispatch', () => {
    expect(parseBrowserActSteps([collect, { do: 'click', text: 'Buy' }])).toMatchObject({ ok: false, error: expect.stringContaining('last browser step') });
    for (const change of [{ max_pages: 0 }, { max_pages: undefined }, { max_items: 0 }, { max_seconds: 1.5 },
      { next: undefined }, { fields: {} }, { fields: { name: { selector: '.name', script: 'x' } } },
      { dedupe_by: ['unknown'] }, { where: { field: 'unknown', equals: 'x' } }, { items: 'a:hover' },
      { next: { text: 'Next', selector: 'a' } }, { script: 'return document.body' }]) {
      expect(parseBrowserActSteps([{ ...collect, ...change }]), JSON.stringify(change)).toMatchObject({ ok: false });
    }
  });

  it('identifies document-local refs as unsupported pagination arguments with accepted alternatives', () => {
    const parsed = parseBrowserActSteps([{ ...collect, next: { ref: 'PRIVATE_REF' } }]);
    expect(parsed).toMatchObject({ ok: false, violations: [{ path: 'steps[0].next.ref',
      message: expect.stringContaining('next.ref is unsupported') }] });
    if (parsed.ok) return;
    expect(parsed.error).toContain('next:{"text":"Next"}');
    expect(parsed.error).toContain('next:{"selector":"a.next"}');
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_REF');
  });

  it('accepts the documented selector subset and rejects syntax it cannot interpret', () => {
    for (const selector of ['.item > span.name', ':scope > a[href="/next page"]', '#list .row, [data-testid=x]', '[id="123"]']) {
      expect(parseBrowserCollectSelector(selector), selector).toBeDefined();
    }
    for (const selector of ['.item >> a', 'a:nth-child(2 of .visible)', 'a + span', 'a[href^="/"]', 'a,', '> a', 'a >', 'a\\:b', '[href="x]']) {
      expect(parseBrowserCollectSelector(selector), selector).toBeUndefined();
    }
  });

  it('parses bounded CSS sibling formulas and refuses unsupported or malformed variants', () => {
    for (const selector of ['td:nth-child(4)', 'td:nth-of-type(2)', 'li:nth-child(2n + 1)',
      'li:nth-last-child(-n+3)', 'p:nth-last-of-type(even)', ':scope:first-child', '*:only-of-type',
      'a:last-child:first-of-type', 'span:nth-child(+3)', 'li:nth-child(0n-1)']) {
      expect(parseBrowserCollectSelector(selector), selector).toBeDefined();
    }
    for (const selector of ['li:nth-child()', 'li:nth-child(2n + -1)', 'li:nth-child(n 2)',
      'li:nth-child(2 n)', 'li:nth-child(n of .item)', 'li:nth-child(1000001)',
      'li:nth-child(nth-child(2))', 'li:first-child()', 'li:not(.hidden)', 'li:has(a)']) {
      expect(parseBrowserCollectSelector(selector), selector).toBeUndefined();
    }
    expect(parseBrowserActSteps([{ ...collect, fields: { name: 'td:hover' } }])).toMatchObject({ ok: false,
      violations: [{ path: 'steps[0].fields.name.selector', message: expect.stringContaining('unsupported selector') }] });
  });

  it('keeps legacy then_read and validates opt-in text results', () => {
    expect(parseBrowserActSteps([{ do: 'click', ref: 'e1', then_read: '#result', then_read_form: 'text' }]))
      .toEqual({ ok: true, steps: [{ do: 'click', ref: 'e1', then_read: '#result', then_read_form: 'text' }] });
    expect(parseBrowserActSteps([{ do: 'click', ref: 'e1', then_read_form: 'text' }])).toMatchObject({ ok: false });
  });

  it('reports all independent collection limits together with their original step and legacy first error', () => {
    const parsed = parseBrowserActSteps([{ do: 'click', text: 'Travel' },
      { ...collect, max_pages: 0, max_items: 0, max_seconds: 0 }]);
    expect(parsed).toEqual({ ok: false, error: 'step 2: max_pages must be an integer from 1 to 20', violations: [
      { path: 'steps[1].max_pages', code: 'out_of_range', message: 'max_pages must be an integer from 1 to 20', expected_type: 'integer', min: 1, max: 20, received: 0 },
      { path: 'steps[1].max_items', code: 'out_of_range', message: 'max_items is from 1 to 500, counting source items including duplicates', expected_type: 'integer', min: 1, max: 500, received: 0 },
      { path: 'steps[1].max_seconds', code: 'out_of_range', message: 'max_seconds is from 1 to 120', expected_type: 'integer', min: 1, max: 120, received: 0 },
    ] });
    // 2026-11-21 (D-402, benchmark task I, live) — a whole number above a bound is read at the bound, and the step keeps what
    // it asked for, rather than refused (asked for 50 pages and 1,000 items in 37 of 57 runs of task I).
    const over = parseBrowserActSteps([{ do: 'click', text: 'Travel' }, { ...collect, max_pages: 50, max_items: 1000, max_seconds: 121 }]);
    expect(over.ok && over.steps[1]).toMatchObject({ do: 'collect', max_pages: 20, max_items: 500, max_seconds: 120,
      asked: { max_pages: 50, max_items: 1000, max_seconds: 121 } });
    const within = parseBrowserActSteps([collect]);
    expect(within.ok).toBe(true);
    expect(within.ok && 'asked' in within.steps[0]!).toBe(false);
    const missing = parseBrowserActSteps([{ ...collect, max_pages: undefined }]);
    expect(missing).toMatchObject({ ok: false, violations: [{ path: 'steps[0].max_pages', code: 'required', min: 1, max: 20 }] });
    expect(parseBrowserActSteps([{ ...collect, max_pages: 1.5 }])).toMatchObject({ ok: false,
      violations: [{ path: 'steps[0].max_pages', code: 'invalid_type', expected_type: 'integer', received: 1.5 }] });
  });

  it('bounds malformed-field corrections, marks omitted violations and never echoes argument values', () => {
    const fields = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, {
      selector: 'a', attribute: 'SECRET_ATTRIBUTE', many: 'SECRET_MANY', required: 'SECRET_REQUIRED',
    }]));
    const parsed = parseBrowserActSteps([{ ...collect, fields, max_pages: 'SECRET_BOUND' }]);
    expect(parsed).toMatchObject({ ok: false, violations_truncated: true });
    if (parsed.ok) return;
    expect(parsed.violations).toHaveLength(BROWSER_COLLECT_MAX_VIOLATIONS);
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });
});
