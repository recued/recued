import { describe, it, expect } from 'vitest';
import { executeDOM, type DOMContext } from '../dom.js';
import { IngredientError, type ResolvedCall } from '../types.js';
import type { IngredientManifest } from '@recued/contracts';

/** Convert a manifest + input into the ResolvedCall shape executeDOM now expects. */
const toResolved = (manifest: IngredientManifest, input: Record<string, unknown> = {}): ResolvedCall => ({
  slug: manifest.slug,
  risk_tier: manifest.risk_tier,
  input,
  output: manifest.output ?? {},
  fallback: manifest.fallback,
});

/** Minimal Document mock. Maps CSS selectors to text content. */
const mockDocument = (selectors: Record<string, string | null | { throw: true }>): Document => ({
  querySelector: (sel: string): Element | null => {
    if (!(sel in selectors)) return null;
    const value = selectors[sel];
    if (typeof value === 'object' && value !== null && 'throw' in value) {
      throw new Error('invalid selector');
    }
    if (value === null) return null;
    return { textContent: value as string } as Element;
  },
} as unknown as Document);

const ctx = (url: string, selectors: Record<string, string | null | { throw: true }> = {}): DOMContext => ({
  document: mockDocument(selectors),
  url,
});

const baseManifest: IngredientManifest = {
  slug: 'email-reader-hubspot',
  name: 'HubSpot Email Reader',
  description: 'Reads email content from HubSpot UI',
  author: 'recued-core',
  kind: 'dom',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {
    "[data-test-id='email-subject']": 'subject',
    "[data-test-id='email-body']": 'body',
  },
};

describe('executeDOM — basic extraction', () => {
  it('reads textContent from selectors', async () => {
    const result = await executeDOM(toResolved(baseManifest), ctx('https://app.hubspot.com/contacts/123/email/abc', {
      "[data-test-id='email-subject']": 'Welcome to Acme',
      "[data-test-id='email-body']": 'Thanks for signing up!',
    })) as Record<string, unknown>;

    expect(result.subject).toBe('Welcome to Acme');
    expect(result.body).toBe('Thanks for signing up!');
  });

  it('trims whitespace from textContent', async () => {
    const result = await executeDOM(toResolved(baseManifest), ctx('https://x.com', {
      "[data-test-id='email-subject']": '   Hello   ',
      "[data-test-id='email-body']": '\n\n  Body text  \n',
    })) as Record<string, unknown>;

    expect(result.subject).toBe('Hello');
    expect(result.body).toBe('Body text');
  });

  it('returns null for missing elements', async () => {
    const result = await executeDOM(toResolved(baseManifest), ctx('https://x.com', {
      "[data-test-id='email-subject']": 'Found',
      // body selector not in mock → null
    })) as Record<string, unknown>;

    expect(result.subject).toBe('Found');
    expect(result.body).toBeNull();
  });

  it('handles empty manifest output', async () => {
    const empty: IngredientManifest = { ...baseManifest, output: {} };
    const result = await executeDOM(toResolved(empty), ctx('https://x.com')) as Record<string, unknown>;
    expect(result).toEqual({});
  });

  it('handles invalid CSS selectors gracefully', async () => {
    const result = await executeDOM(toResolved(baseManifest), ctx('https://x.com', {
      "[data-test-id='email-subject']": { throw: true },
      "[data-test-id='email-body']": 'Body',
    })) as Record<string, unknown>;

    expect(result.subject).toBeNull();
    expect(result.body).toBe('Body');
  });

  it('drops prototype-sensitive read field names', async () => {
    const manifest: IngredientManifest = {
      ...baseManifest,
      output: {
        '.safe': 'safe',
        '.proto': '__proto__',
        '.ctor': 'constructor',
        '.prototype': 'prototype',
      },
    };
    const result = await executeDOM(toResolved(manifest), ctx('https://x.com', {
      '.safe': 'kept',
      '.proto': 'bad',
      '.ctor': 'bad',
      '.prototype': 'bad',
    })) as Record<string, unknown>;

    expect(result).toEqual({ safe: 'kept' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
  });
});

describe('executeDOM — trigger URL matching', () => {
  const triggerManifest: IngredientManifest = {
    ...baseManifest,
    output: {
      'app.hubspot.com/contacts/*/email*': 'trigger',
      "[data-test-id='subject']": 'subject',
    },
  };

  it('runs when URL matches trigger pattern', async () => {
    const result = await executeDOM(toResolved(triggerManifest), ctx(
      'https://app.hubspot.com/contacts/123/email/abc',
      { "[data-test-id='subject']": 'Hello' },
    )) as Record<string, unknown>;

    expect(result.subject).toBe('Hello');
  });

  it('throws DOM_PAGE_NOT_MATCHING when URL does not match', async () => {
    try {
      await executeDOM(toResolved(triggerManifest), ctx('https://app.hubspot.com/deals/456'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      expect((e as IngredientError).code).toBe('DOM_PAGE_NOT_MATCHING');
    }
  });

  it('does NOT include trigger entries in result', async () => {
    const result = await executeDOM(toResolved(triggerManifest), ctx(
      'https://app.hubspot.com/contacts/1/email/x',
      { "[data-test-id='subject']": 'Hi' },
    )) as Record<string, unknown>;

    expect(result['app.hubspot.com/contacts/*/email*']).toBeUndefined();
    expect(Object.keys(result)).toEqual(['subject']);
  });

  it('matches any of multiple trigger patterns (OR logic)', async () => {
    const multiTrigger: IngredientManifest = {
      ...baseManifest,
      output: {
        'app.hubspot.com/contacts/*/email*': 'trigger',
        '*.lightning.force.com/*/email*': 'trigger',
        "[data-test-id='subject']": 'subject',
      },
    };

    // Match the second pattern
    const result = await executeDOM(toResolved(multiTrigger), ctx(
      'https://my-org.lightning.force.com/lightning/r/123/email/abc',
      { "[data-test-id='subject']": 'SF Email' },
    )) as Record<string, unknown>;

    expect(result.subject).toBe('SF Email');
  });

  it('runs on any URL when no trigger entries exist', async () => {
    const noTrigger: IngredientManifest = {
      ...baseManifest,
      output: { "[data-test-id='subject']": 'subject' },
    };

    const result = await executeDOM(toResolved(noTrigger), ctx('https://anywhere.example.com', {
      "[data-test-id='subject']": 'Anywhere',
    })) as Record<string, unknown>;

    expect(result.subject).toBe('Anywhere');
  });
});

describe('executeDOM — URL pattern matching details', () => {
  it('handles wildcards in path segments', async () => {
    const m: IngredientManifest = {
      ...baseManifest,
      output: { 'app.hubspot.com/contacts/*/email*': 'trigger', 'div': 'data' },
    };

    await expect(executeDOM(toResolved(m), ctx('https://app.hubspot.com/contacts/123/email/456', { 'div': 'x' })))
      .resolves.toBeDefined();

    await expect(executeDOM(toResolved(m), ctx('https://app.hubspot.com/contacts/email')))
      .rejects.toThrow();
  });

  it('wildcard crosses path segments (Chrome match-pattern semantics)', async () => {
    const m: IngredientManifest = {
      ...baseManifest,
      output: { 'app.hubspot.com/deals/*': 'trigger', 'div': 'data' },
    };

    // /deals/123 matches
    await expect(executeDOM(toResolved(m), ctx('https://app.hubspot.com/deals/123', { 'div': 'x' })))
      .resolves.toBeDefined();

    // /deals/123/edit also matches (* matches any chars including /)
    await expect(executeDOM(toResolved(m), ctx('https://app.hubspot.com/deals/123/edit', { 'div': 'y' })))
      .resolves.toBeDefined();
  });

  it('matches with explicit protocol in pattern', async () => {
    const m: IngredientManifest = {
      ...baseManifest,
      output: { 'https://app.hubspot.com/*/email*': 'trigger', 'div': 'data' },
    };

    await expect(executeDOM(toResolved(m), ctx('https://app.hubspot.com/contacts/email', { 'div': 'x' })))
      .resolves.toBeDefined();
  });

  it('escapes regex special characters in patterns', async () => {
    // Pattern with literal dots and parens
    const m: IngredientManifest = {
      ...baseManifest,
      output: { 'app.hubspot.com/page(1)/*': 'trigger', 'div': 'data' },
    };

    await expect(executeDOM(toResolved(m), ctx('https://app.hubspot.com/page(1)/anything', { 'div': 'x' })))
      .resolves.toBeDefined();

    // Should NOT match this similar URL (the "(" in the pattern is literal)
    await expect(executeDOM(toResolved(m), ctx('https://appXhubspot.com/page1/anything')))
      .rejects.toThrow();
  });
});

describe('executeDOM — context handling', () => {
  it('throws when no DOMContext provided in non-browser environment', async () => {
    try {
      await executeDOM(toResolved(baseManifest));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      expect((e as IngredientError).code).toBe('DOM_SELECTOR_NOT_FOUND');
    }
  });
});

describe('executeDOM — realistic HubSpot example', () => {
  it('extracts a draft email from the HubSpot inbox UI', async () => {
    const draftEmailReader: IngredientManifest = {
      slug: 'draft-email-reader-hubspot',
      name: 'HubSpot Draft Email Reader',
      description: 'Reads the currently composed email from the HubSpot inbox',
      author: 'recued-core',
      kind: 'dom',
      category: 'data',
      risk_tier: 'read',
      input: {},
      output: {
        'app.hubspot.com/contacts/*/email*': 'trigger',
        "[data-test-id='email-subject']": 'subject',
        "[data-test-id='email-body']": 'body',
        "[data-test-id='email-recipient']": 'recipient',
      },
    };

    const result = await executeDOM(toResolved(draftEmailReader), ctx(
      'https://app.hubspot.com/contacts/12345/email/draft-67',
      {
        "[data-test-id='email-subject']": 'Following up on our call',
        "[data-test-id='email-body']": 'Hi Sarah,\n\nThanks for the great chat...',
        "[data-test-id='email-recipient']": 'sarah@acme.com',
      },
    )) as Record<string, unknown>;

    expect(result).toEqual({
      subject: 'Following up on our call',
      body: 'Hi Sarah,\n\nThanks for the great chat...',
      recipient: 'sarah@acme.com',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// DOM write tests
// ────────────────────────────────────────────────────────────────

/** Rich element mock that tracks value writes + dispatched events. */
interface MockEl {
  tagName: string;
  value?: string;
  textContent?: string | null;
  isContentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  events: string[];
  dispatchEvent: (e: { type: string }) => boolean;
}

const makeInput = (): MockEl => {
  const el: MockEl = {
    tagName: 'INPUT',
    value: '',
    events: [],
    dispatchEvent(e) { this.events.push(e.type); return true; },
  };
  return el;
};

const makeTextarea = (): MockEl => ({ ...makeInput(), tagName: 'TEXTAREA' });
const makeSelect = (): MockEl => ({ ...makeInput(), tagName: 'SELECT' });

const makeContentEditable = (): MockEl => ({
  tagName: 'DIV',
  textContent: '',
  isContentEditable: true,
  events: [],
  dispatchEvent(e) { this.events.push(e.type); return true; },
});

const makeReadonlyInput = (): MockEl => ({ ...makeInput(), readOnly: true });
const makeDisabledInput = (): MockEl => ({ ...makeInput(), disabled: true });
const makeDisplayDiv = (): MockEl => ({
  tagName: 'DIV',
  textContent: 'read-only display text',
  events: [],
  dispatchEvent(e) { this.events.push(e.type); return true; },
});

const writableDocument = (elements: Record<string, MockEl | null>): Document => ({
  querySelector: (sel: string): Element | null => {
    const el = elements[sel];
    return (el as unknown as Element | null) ?? null;
  },
} as unknown as Document);

const writableCtx = (url: string, elements: Record<string, MockEl | null>): DOMContext => ({
  document: writableDocument(elements),
  url,
});

const writeManifest: IngredientManifest = {
  slug: 'email-writer-hubspot',
  name: 'HubSpot Email Writer',
  description: 'Writes into the HubSpot email composer',
  author: 'recued-core',
  kind: 'dom',
  category: 'action',
  risk_tier: 'write',
  input: {
    'dom.match': 'app.hubspot.com/contacts/*/email*',
    subject: null,
    body: null,
  },
  output: {
    'app.hubspot.com/contacts/*/email*': 'trigger',
    "[data-test-id='email-subject']": 'dom.subject',
    "[data-test-id='email-body']": 'dom.body',
  },
};

describe('executeDOM — write mode (dom.* prefix)', () => {
  it('writes input.subject and input.body into their target elements', async () => {
    const subjectEl = makeInput();
    const bodyEl = makeTextarea();
    const result = await executeDOM(
      toResolved(writeManifest, { subject: 'Hello Sarah', body: 'Quick follow-up' }),
      writableCtx('https://app.hubspot.com/contacts/123/email/abc', {
        "[data-test-id='email-subject']": subjectEl,
        "[data-test-id='email-body']": bodyEl,
      }),
    ) as { written: number; fields: string[]; failed: string[] };

    expect(subjectEl.value).toBe('Hello Sarah');
    expect(bodyEl.value).toBe('Quick follow-up');
    expect(result.written).toBe(2);
    expect(result.fields.sort()).toEqual(['body', 'subject']);
    expect(result.failed).toEqual([]);
  });

  it('dispatches input + change events for React/Vue compatibility', async () => {
    const subjectEl = makeInput();
    await executeDOM(
      toResolved(writeManifest, { subject: 'Hello' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": subjectEl,
        "[data-test-id='email-body']": null,
      }),
    );
    expect(subjectEl.events).toEqual(['input', 'change']);
  });

  it('writes to contenteditable via textContent + input event only', async () => {
    const bodyEl = makeContentEditable();
    await executeDOM(
      toResolved(writeManifest, { body: 'Rich text body' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": null,
        "[data-test-id='email-body']": bodyEl,
      }),
    );
    expect(bodyEl.textContent).toBe('Rich text body');
    expect(bodyEl.events).toEqual(['input', 'change']);
  });

  it('writes to <select> via .value', async () => {
    const selectManifest: IngredientManifest = {
      ...writeManifest,
      input: { 'dom.match': 'example.com/*', status: null },
      output: {
        'example.com/*': 'trigger',
        "[name='status']": 'dom.status',
      },
    };
    const selectEl = makeSelect();
    const result = await executeDOM(
      toResolved(selectManifest, { status: 'closed_won' }),
      writableCtx('https://example.com/deals/1', {
        "[name='status']": selectEl,
      }),
    ) as { written: number };
    expect(selectEl.value).toBe('closed_won');
    expect(result.written).toBe(1);
  });

  it('partial update: only writes supplied fields, skips null/missing', async () => {
    const subjectEl = makeInput();
    const bodyEl = makeInput();
    // Only supply subject, leave body undefined
    const result = await executeDOM(
      toResolved(writeManifest, { subject: 'Only this' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": subjectEl,
        "[data-test-id='email-body']": bodyEl,
      }),
    ) as { written: number; fields: string[]; failed: string[] };
    expect(subjectEl.value).toBe('Only this');
    expect(bodyEl.value).toBe('');  // untouched
    expect(result.written).toBe(1);
    expect(result.fields).toEqual(['subject']);
    expect(result.failed).toEqual([]);
  });

  it('null input value skips the field without error', async () => {
    const subjectEl = makeInput();
    const result = await executeDOM(
      toResolved(writeManifest, { subject: null, body: 'body text' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": subjectEl,
        "[data-test-id='email-body']": makeTextarea(),
      }),
    ) as { written: number; fields: string[] };
    expect(subjectEl.value).toBe('');
    expect(result.fields).toEqual(['body']);
  });

  it('readonly input → field fails, overall write succeeds if others succeed', async () => {
    const subjectEl = makeReadonlyInput();
    const bodyEl = makeInput();
    const result = await executeDOM(
      toResolved(writeManifest, { subject: 'Hello', body: 'World' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": subjectEl,
        "[data-test-id='email-body']": bodyEl,
      }),
    ) as { written: number; fields: string[]; failed: string[] };
    expect(result.written).toBe(1);
    expect(result.fields).toEqual(['body']);
    expect(result.failed).toEqual(['subject']);
    // Subject wasn't touched
    expect(subjectEl.value).toBe('');
  });

  it('disabled input → field fails', async () => {
    const subjectEl = makeDisabledInput();
    const result = await executeDOM(
      toResolved(writeManifest, { subject: 'Hello', body: 'World' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": subjectEl,
        "[data-test-id='email-body']": makeInput(),
      }),
    ) as { failed: string[] };
    expect(result.failed).toEqual(['subject']);
  });

  it('display div (non-form, non-contenteditable) → field fails', async () => {
    const el = makeDisplayDiv();
    const result = await executeDOM(
      toResolved(writeManifest, { subject: 'Hello', body: 'World' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": el,
        "[data-test-id='email-body']": makeInput(),
      }),
    ) as { failed: string[] };
    expect(result.failed).toEqual(['subject']);
    // textContent unchanged
    expect(el.textContent).toBe('read-only display text');
  });

  it('all write targets fail → throws DOM_WRITE_FAILED', async () => {
    const ro1 = makeReadonlyInput();
    const ro2 = makeReadonlyInput();
    await expect(executeDOM(
      toResolved(writeManifest, { subject: 'Hello', body: 'World' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": ro1,
        "[data-test-id='email-body']": ro2,
      }),
    )).rejects.toMatchObject({ code: 'DOM_WRITE_FAILED' });
  });

  it('URL mismatch on write mode still throws DOM_PAGE_NOT_MATCHING', async () => {
    await expect(executeDOM(
      toResolved(writeManifest, { subject: 'Hello' }),
      writableCtx('https://www.google.com/search', {
        "[data-test-id='email-subject']": makeInput(),
      }),
    )).rejects.toMatchObject({ code: 'DOM_PAGE_NOT_MATCHING' });
  });

  it('no values supplied at all → returns empty result without throwing', async () => {
    const result = await executeDOM(
      toResolved(writeManifest),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": makeInput(),
        "[data-test-id='email-body']": makeInput(),
      }),
    ) as { written: number; failed: string[] };
    expect(result.written).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('coerces non-string values to string', async () => {
    const numericManifest: IngredientManifest = {
      ...writeManifest,
      input: { 'dom.match': 'example.com/*', amount: null },
      output: {
        'example.com/*': 'trigger',
        "[name='amount']": 'dom.amount',
      },
    };
    const el = makeInput();
    await executeDOM(
      toResolved(numericManifest, { amount: 12345 }),
      writableCtx('https://example.com/deals', {
        "[name='amount']": el,
      }),
    );
    expect(el.value).toBe('12345');
  });

  it('write fallback chain: first-declared selector wins when both would match', async () => {
    // Both selectors would match an element — the executor must pick the
    // FIRST-declared, not whichever would come first in document order.
    // A broken implementation that naively passes the full combined string
    // to querySelector would potentially pick the wrong one.
    const oldDesignEl = makeInput();
    const newDesignEl = makeInput();
    const chainManifest: IngredientManifest = {
      ...writeManifest,
      input: { 'dom.match': 'app.hubspot.com/contacts/*/email*', subject: null },
      output: {
        'app.hubspot.com/contacts/*/email*': 'trigger',
        "[data-olddesign-id='subject'],[data-id='subject'],#Subject": 'dom.subject',
      },
    };
    await executeDOM(
      toResolved(chainManifest, { subject: 'Declaration-order wins' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        // Both selectors have elements — first in declaration order should win
        "[data-olddesign-id='subject']": oldDesignEl,
        "[data-id='subject']": newDesignEl,
      }),
    );
    expect(oldDesignEl.value).toBe('Declaration-order wins');
    expect(newDesignEl.value).toBe('');  // untouched
  });

  it('write fallback chain: skips missing selectors until one matches', async () => {
    const realEl = makeInput();
    const chainManifest: IngredientManifest = {
      ...writeManifest,
      input: { 'dom.match': 'example.com/*', subject: null },
      output: {
        'example.com/*': 'trigger',
        "[data-v1='x'],[data-v2='x'],[data-v3='x']": 'dom.subject',
      },
    };
    await executeDOM(
      toResolved(chainManifest, { subject: 'third try' }),
      writableCtx('https://example.com/compose', {
        // Only the THIRD selector matches
        "[data-v3='x']": realEl,
      }),
    );
    expect(realEl.value).toBe('third try');
  });

  it('write fallback chain: all selectors miss → field fails', async () => {
    const chainManifest: IngredientManifest = {
      ...writeManifest,
      input: { 'dom.match': 'example.com/*', subject: null },
      output: {
        'example.com/*': 'trigger',
        "[data-v1='x'],[data-v2='x']": 'dom.subject',
      },
    };
    await expect(executeDOM(
      toResolved(chainManifest, { subject: 'no match' }),
      writableCtx('https://example.com/compose', {
        // Neither selector matches anything
      }),
    )).rejects.toMatchObject({ code: 'DOM_WRITE_FAILED' });
  });

  it('write fallback chain: first match is non-writable → fails the field (no continuation)', async () => {
    // By design: the fallback chain is for "which page VERSION", not
    // "which writable control". Once a selector matches, that element is
    // used — even if it turns out to be readonly.
    const readonlyEl = makeReadonlyInput();
    const writableEl = makeInput();
    const chainManifest: IngredientManifest = {
      ...writeManifest,
      input: { 'dom.match': 'example.com/*', subject: null },
      output: {
        'example.com/*': 'trigger',
        "[data-v1='x'],[data-v2='x']": 'dom.subject',
      },
    };
    const result = await executeDOM(
      toResolved(chainManifest, { subject: 'hello' }),
      writableCtx('https://example.com/compose', {
        "[data-v1='x']": readonlyEl,  // first-declared, non-writable
        "[data-v2='x']": writableEl,   // second-declared, writable — NOT reached
      }),
    ).catch(e => e);
    // First-declared selector matched a readonly element → failure, no continuation
    expect(result).toBeInstanceOf(IngredientError);
    expect((result as IngredientError).code).toBe('DOM_WRITE_FAILED');
    expect(writableEl.value).toBe('');  // never touched
  });

  it('mixed read + write in one ingredient', async () => {
    const mixedManifest: IngredientManifest = {
      ...writeManifest,
      slug: 'mixed-dom-hubspot',
      input: {
        'dom.match': 'example.com/*',
        new_subject: null,
      },
      output: {
        'example.com/*': 'trigger',
        "[data-test-id='old-subject']": 'old_subject',   // READ
        "[data-test-id='new-subject']": 'dom.new_subject', // WRITE
      },
    };
    const oldEl = { textContent: 'Previous subject', tagName: 'DIV' } as unknown as Element;
    const newEl = makeInput();
    const result = await executeDOM(
      toResolved(mixedManifest, { new_subject: 'Shiny new subject' }),
      writableCtx('https://example.com/compose', {
        "[data-test-id='old-subject']": oldEl as unknown as MockEl,
        "[data-test-id='new-subject']": newEl,
      }),
    ) as { reads: Record<string, string | null>; writes: { written: number; fields: string[] } };
    expect(result.reads.old_subject).toBe('Previous subject');
    expect(newEl.value).toBe('Shiny new subject');
    expect(result.writes.fields).toEqual(['new_subject']);
  });
});

// ────────────────────────────────────────────────────────────────
// Selector fallback chains (comma-separated, declaration-order)
// ────────────────────────────────────────────────────────────────

describe('executeDOM — read fallback chain (declaration-order)', () => {
  const chainManifest: IngredientManifest = {
    ...baseManifest,
    output: {
      "[data-olddesign-id='subject'],[data-id='subject'],#Subject": 'subject',
    },
  };

  it('first-declared selector wins when both would match', async () => {
    // If a naive implementation passed the combined string to querySelector,
    // it would return whichever element comes first in document order. We
    // want declaration-order instead: the FIRST selector that matches wins.
    const result = await executeDOM(toResolved(chainManifest), ctx('https://x.com', {
      "[data-olddesign-id='subject']": 'Old design value',
      "[data-id='subject']": 'New design value',
      "#Subject": 'Legacy value',
    })) as Record<string, unknown>;
    expect(result.subject).toBe('Old design value');
  });

  it('falls through to second when first misses', async () => {
    const result = await executeDOM(toResolved(chainManifest), ctx('https://x.com', {
      // First selector has no entry in the mock → querySelector returns null
      "[data-id='subject']": 'New design value',
      "#Subject": 'Legacy value',
    })) as Record<string, unknown>;
    expect(result.subject).toBe('New design value');
  });

  it('falls through to third when first and second miss', async () => {
    const result = await executeDOM(toResolved(chainManifest), ctx('https://x.com', {
      "#Subject": 'Legacy value',
    })) as Record<string, unknown>;
    expect(result.subject).toBe('Legacy value');
  });

  it('returns null when no selector in the chain matches', async () => {
    const result = await executeDOM(toResolved(chainManifest), ctx('https://x.com', {
      // None of the chain selectors are in the mock
    })) as Record<string, unknown>;
    expect(result.subject).toBeNull();
  });

  it('tolerates whitespace around commas', async () => {
    const whitespaceManifest: IngredientManifest = {
      ...baseManifest,
      output: {
        "[a]  ,  [b]  ,  [c]": 'field',
      },
    };
    const result = await executeDOM(toResolved(whitespaceManifest), ctx('https://x.com', {
      '[b]': 'second matches',
    })) as Record<string, unknown>;
    expect(result.field).toBe('second matches');
  });

  it('does NOT split commas inside attribute selectors', async () => {
    // [data-foo="a,b"] has an internal comma — must NOT be split.
    const attrManifest: IngredientManifest = {
      ...baseManifest,
      output: {
        '[data-foo="a,b"],[data-bar="c,d,e"]': 'value',
      },
    };
    // The mock key must be the full intact sub-selector
    const result = await executeDOM(toResolved(attrManifest), ctx('https://x.com', {
      '[data-foo="a,b"]': 'found',
    })) as Record<string, unknown>;
    expect(result.value).toBe('found');
  });

  it('does NOT split commas inside :nth-child() parens', async () => {
    const parenManifest: IngredientManifest = {
      ...baseManifest,
      output: {
        'li:nth-child(2n+1,3),p:nth-child(3n)': 'result',
      },
    };
    const result = await executeDOM(toResolved(parenManifest), ctx('https://x.com', {
      'li:nth-child(2n+1,3)': 'nth match',
    })) as Record<string, unknown>;
    expect(result.result).toBe('nth match');
  });

  it('skips invalid sub-selectors and continues the chain', async () => {
    // The mock throws for "{throw: true}" keys — simulating an invalid selector.
    // The chain should skip past the invalid one and try the next.
    const brokenManifest: IngredientManifest = {
      ...baseManifest,
      output: {
        '[invalid], [data-valid="x"]': 'field',
      },
    };
    const result = await executeDOM(toResolved(brokenManifest), ctx('https://x.com', {
      '[invalid]': { throw: true },
      '[data-valid="x"]': 'recovered',
    })) as Record<string, unknown>;
    expect(result.field).toBe('recovered');
  });

  it('single-selector (no comma) still works', async () => {
    const simpleManifest: IngredientManifest = {
      ...baseManifest,
      output: { '[data-x]': 'field' },
    };
    const result = await executeDOM(toResolved(simpleManifest), ctx('https://x.com', {
      '[data-x]': 'no chain needed',
    })) as Record<string, unknown>;
    expect(result.field).toBe('no chain needed');
  });
});

// ────────────────────────────────────────────────────────────────
// DOM click tests
// ────────────────────────────────────────────────────────────────

/** Button mock that tracks dispatched events + .click() fallback. */
const makeButton = (): MockEl & { clickCount: number; click: () => void } => {
  const el = {
    tagName: 'BUTTON',
    textContent: 'Send',
    events: [] as string[],
    clickCount: 0,
    dispatchEvent(e: { type: string }) {
      this.events.push(e.type);
      if (e.type === 'click') this.clickCount++;
      return true;
    },
    // Fallback used when PointerEvent/MouseEvent aren't available (Node test env)
    click() { this.clickCount++; this.events.push('click'); },
  };
  return el;
};

describe('executeDOM — click support', () => {
  it('dispatches click event sequence on "click" output value', async () => {
    const btn = makeButton();
    const result = await executeDOM(
      {
        slug: 'gemini-chat-write',
        risk_tier: 'write',
        input: {},
        output: {
          'gemini.google.com/*': 'trigger',
          "button[aria-label='Send']": 'click',
        },
      },
      writableCtx('https://gemini.google.com/app', {
        "button[aria-label='Send']": btn as unknown as MockEl,
      }),
    );
    expect(btn.clickCount).toBe(1);
    // In Node test env, PointerEvent/MouseEvent aren't available so
    // dispatchClick falls back to .click(). In browser, the full
    // pointer sequence fires. Either way, click must have happened.
    expect(btn.events).toContain('click');
    expect(result).toEqual({ clicked: 1 });
  });

  it('skips missing click selectors without error', async () => {
    const result = await executeDOM(
      {
        slug: 'test-clicker',
        risk_tier: 'write',
        input: {},
        output: { 'button.missing': 'click' },
      },
      writableCtx('https://example.com', {}),
    );
    expect(result).toEqual({ clicked: 0 });
  });

  it('combines writes + clicks in correct order', async () => {
    const inputEl = makeInput();
    const btn = makeButton();
    const order: string[] = [];

    // Track order via dispatchEvent interception
    const origInputDispatch = inputEl.dispatchEvent.bind(inputEl);
    inputEl.dispatchEvent = (e) => { order.push(`write:${e.type}`); return origInputDispatch(e); };
    const origBtnDispatch = btn.dispatchEvent.bind(btn);
    (btn as unknown as MockEl).dispatchEvent = (e) => { order.push(`click:${e.type}`); return origBtnDispatch(e); };
    const origBtnClick = btn.click.bind(btn);
    btn.click = () => { order.push('click:click'); origBtnClick(); };

    await executeDOM(
      {
        slug: 'chat-write-send',
        risk_tier: 'write',
        input: { prompt: 'Hello' },
        output: {
          'textarea.prompt': 'dom.prompt',
          'button.send': 'click',
        },
      },
      writableCtx('https://example.com', {
        'textarea.prompt': inputEl,
        'button.send': btn as unknown as MockEl,
      }),
    );

    // Writes must happen before clicks
    const firstWrite = order.findIndex((e) => e.startsWith('write:'));
    const firstClick = order.findIndex((e) => e.startsWith('click:'));
    expect(firstWrite).toBeLessThan(firstClick);
    expect(inputEl.value).toBe('Hello');
    expect(btn.clickCount).toBe(1);
  });

  it('reads + clicks: reads happen before clicks', async () => {
    const btn = makeButton();
    const result = await executeDOM(
      {
        slug: 'read-and-click',
        risk_tier: 'write',
        input: {},
        output: {
          '.status': 'current_status',
          'button.next': 'click',
        },
      },
      {
        document: {
          querySelector: (sel: string) => {
            if (sel === '.status') return { textContent: 'Draft' } as Element;
            if (sel === 'button.next') return btn as unknown as Element;
            return null;
          },
        } as unknown as Document,
        url: 'https://example.com',
      },
    );
    expect(result).toEqual({
      reads: { current_status: 'Draft' },
      clicked: 1,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Contenteditable execCommand
// ────────────────────────────────────────────────────────────────

describe('executeDOM — contenteditable write', () => {
  it('falls back to textContent when execCommand is unavailable', async () => {
    const el = makeContentEditable();
    await executeDOM(
      toResolved({
        ...baseManifest,
        output: { 'example.com/*': 'trigger', '.editor': 'dom.body' },
      } as IngredientManifest, { body: 'Hello world' }),
      writableCtx('https://example.com/page', { '.editor': el }),
    );
    // textContent fallback should have set the value
    expect(el.textContent).toBe('Hello world');
    expect(el.events).toContain('input');
    expect(el.events).toContain('change');
  });

  it('uses execCommand path (and selection setup) when a full document API is available', async () => {
    // Build a contenteditable element with an ownerDocument that supports
    // getSelection + createRange + execCommand. The setElementValue path
    // sets up the selection, calls execCommand, and returns without
    // touching the textContent fallback.
    const events: string[] = [];
    const execCalls: Array<[string, boolean, string | undefined]> = [];
    const selectionCalls: string[] = [];

    const el = {
      tagName: 'DIV',
      textContent: '',
      isContentEditable: true,
      ownerDocument: null as unknown as Document,
      dispatchEvent(e: { type: string }) { events.push(e.type); return true; },
    };
    const ownerDocument = {
      getSelection: () => ({
        removeAllRanges() { selectionCalls.push('removeAllRanges'); },
        addRange() { selectionCalls.push('addRange'); },
      }),
      createRange: () => ({
        selectNodeContents() { selectionCalls.push('selectNodeContents'); },
      }),
      execCommand: (cmd: string, ui: boolean, value: string | undefined) => {
        execCalls.push([cmd, ui, value]);
        el.textContent = value ?? '';
        return true; // success — textContent fallback should NOT fire
      },
    } as unknown as Document;
    el.ownerDocument = ownerDocument;

    await executeDOM(
      toResolved({
        ...baseManifest,
        output: { 'example.com/*': 'trigger', '.rich': 'dom.body' },
      } as IngredientManifest, { body: 'rich text' }),
      writableCtx('https://example.com/x', { '.rich': el as unknown as MockEl }),
    );

    expect(execCalls).toEqual([['insertText', false, 'rich text']]);
    expect(selectionCalls).toEqual(['selectNodeContents', 'removeAllRanges', 'addRange']);
    expect(el.textContent).toBe('rich text');
    expect(events).toEqual(['input', 'change']);
  });

  it('uses textContent fallback when execCommand returns false', async () => {
    const el = {
      tagName: 'DIV',
      textContent: '',
      isContentEditable: true,
      ownerDocument: {
        getSelection: () => null, // triggers the `if (selection)` skip
        execCommand: () => false,  // fallback path
      } as unknown as Document,
      events: [] as string[],
      dispatchEvent(e: { type: string }) { this.events.push(e.type); return true; },
    };
    await executeDOM(
      toResolved({
        ...baseManifest,
        output: { 'example.com/*': 'trigger', '.rich': 'dom.body' },
      } as IngredientManifest, { body: 'fallback value' }),
      writableCtx('https://example.com/x', { '.rich': el as unknown as MockEl }),
    );
    expect(el.textContent).toBe('fallback value');
    expect(el.events).toEqual(['input', 'change']);
  });

  it('returns false (field fails) when textContent write also throws', async () => {
    // Create an element whose textContent setter throws outright. The
    // outer try builds the range/selection and calls execCommand; if the
    // initial `el.textContent = ''` clear throws, the catch path's
    // `el.textContent = value` also throws, yielding `return false`.
    const el = {
      tagName: 'DIV',
      isContentEditable: true,
      ownerDocument: {
        getSelection: () => null,
        execCommand: () => false,
      } as unknown as Document,
      events: [] as string[],
      get textContent() { return ''; },
      set textContent(_v: string) { throw new Error('locked'); },
      dispatchEvent(e: { type: string }) { this.events.push(e.type); return true; },
    };
    await expect(executeDOM(
      toResolved({
        ...baseManifest,
        output: { 'example.com/*': 'trigger', '.rich': 'dom.body' },
      } as IngredientManifest, { body: 'nope' }),
      writableCtx('https://example.com/x', { '.rich': el as unknown as MockEl }),
    )).rejects.toMatchObject({ code: 'DOM_WRITE_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Form-control value-set throws + event dispatch throws
// ────────────────────────────────────────────────────────────────

describe('executeDOM — form-control write failures', () => {
  it('returns false when setting .value throws (form control write error)', async () => {
    // The element is recognized as a form control but its value setter
    // throws — setElementValue must catch and mark the field failed.
    const el = {
      tagName: 'INPUT',
      disabled: false,
      readOnly: false,
      get value() { return ''; },
      set value(_v: string) { throw new Error('frozen'); },
      dispatchEvent() { return true; },
    };
    await expect(executeDOM(
      toResolved(writeManifest, { subject: 'x', body: 'y' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": el as unknown as MockEl,
        "[data-test-id='email-body']": el as unknown as MockEl,
      }),
    )).rejects.toMatchObject({ code: 'DOM_WRITE_FAILED' });
  });

  it('survives dispatchEvent throwing (DOM value already set)', async () => {
    const el = {
      tagName: 'INPUT',
      disabled: false,
      readOnly: false,
      value: '',
      dispatchEvent() { throw new Error('listener failed'); },
    };
    const result = await executeDOM(
      toResolved(writeManifest, { subject: 'hi' }),
      writableCtx('https://app.hubspot.com/contacts/1/email/x', {
        "[data-test-id='email-subject']": el as unknown as MockEl,
        "[data-test-id='email-body']": null,
      }),
    ) as { fields: string[]; failed: string[] };
    // dispatchWriteEvents swallows the throw, so the write is still
    // considered successful and the element's .value was set.
    expect(el.value).toBe('hi');
    expect(result.fields).toEqual(['subject']);
    expect(result.failed).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Enter-action support
// ────────────────────────────────────────────────────────────────

describe('executeDOM — enter action', () => {
  // The Node test env lacks KeyboardEvent. Stub it with a plain constructor
  // whose instances carry a `type` — enough for dispatchEvent to see.
  const withKeyboardEventStub = async (fn: () => Promise<unknown>) => {
    const g = globalThis as unknown as { KeyboardEvent?: unknown };
    const saved = g.KeyboardEvent;
    class StubKeyboardEvent {
      type: string;
      constructor(type: string, _opts?: unknown) { this.type = type; }
    }
    g.KeyboardEvent = StubKeyboardEvent;
    try { return await fn(); } finally { g.KeyboardEvent = saved; }
  };

  it('dispatches a full keydown/keypress/keyup sequence for "enter" output value', async () => {
    const events: string[] = [];
    const el = {
      tagName: 'INPUT',
      dispatchEvent(e: { type: string }) { events.push(e.type); return true; },
    };
    await withKeyboardEventStub(async () => {
      const result = await executeDOM(
        {
          slug: 'search-submit',
          risk_tier: 'write',
          input: {},
          output: {
            'example.com/*': 'trigger',
            'input.search': 'enter',
          },
        },
        writableCtx('https://example.com/search', { 'input.search': el as unknown as MockEl }),
      );
      expect(events).toEqual(['keydown', 'keypress', 'keyup']);
      expect(result).toEqual({ clicked: 1 });
    });
  });

  it('returns clicked:0 when no enter target matches', async () => {
    const result = await executeDOM(
      {
        slug: 'search-submit',
        risk_tier: 'write',
        input: {},
        output: { 'input.search': 'enter' },
      },
      writableCtx('https://example.com/search', {}),
    );
    expect(result).toEqual({ clicked: 0 });
  });
});
