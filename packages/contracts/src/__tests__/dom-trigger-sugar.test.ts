/** Brick 3 — DOM-watch authoring sugar + matchable-tail validation.
 *
 *  Covers the dom `on:` form end to end: `parseTriggerOn` recognizes the
 *  fixed `element.changed` shorthand (and ONLY that verb — the poll source
 *  emits only `updated`); `compileTriggerSugarEntry` lowers it to the
 *  canonical `data.dom.element.<base64url(url+selector)>.updated` pattern
 *  that round-trips through `parseDomWatchDemand`; the validator requires
 *  url+selector (literal), rejects connection/fields, allows where, and
 *  fences url/selector to the dom form; and `isUnmatchableDomWatchPattern`
 *  catches the brick-1-deferred raw-pattern footgun (tailless / wrong-kind /
 *  overlong). */

import { describe, expect, it } from 'vitest';
import {
  ELEMENT_ON_SHORTHAND,
  compileTriggerSugarEntry,
  isDomWatchTriggerEntry,
  parseTriggerOn,
  validateRecipeEventTriggerEntry,
} from '../trigger-sugar.js';
import {
  encodeDomWatchTarget,
  isUnmatchableDomWatchPattern,
  parseDomWatchDemand,
} from '../watch.js';

const URL = 'https://app.hubspot.com/contacts/*';
const SELECTOR = '#deal-amount';
const ENC = encodeDomWatchTarget(URL, SELECTOR);
const CANONICAL = `data.dom.element.${ENC}.updated`;

describe('parseTriggerOn — dom form', () => {
  it('parses the fixed element.changed shorthand', () => {
    expect(parseTriggerOn(ELEMENT_ON_SHORTHAND)).toEqual({ kind: 'dom' });
    expect(parseTriggerOn('element.changed')).toEqual({ kind: 'dom' });
  });

  it('admits ONLY the changed verb (the poll source emits only updated)', () => {
    for (const bad of ['element.created', 'element.removed', 'element.updated', 'element', 'dom.changed']) {
      expect(parseTriggerOn(bad), bad).toBeNull();
    }
  });
});

describe('compileTriggerSugarEntry — dom form', () => {
  it('lowers to the canonical data.dom.element.<enc>.updated pattern that round-trips', () => {
    const compiled = compileTriggerSugarEntry(
      { on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR },
      [],
    )!;
    expect(compiled).toEqual([{ pattern: CANONICAL }]);
    // The emitted pattern re-parses to the authored (url, selector).
    const segs = CANONICAL.split('.');
    expect(parseDomWatchDemand(segs.slice(0, 4).join('.'))).toEqual({
      url_pattern: URL,
      selector: SELECTOR,
    });
  });

  it('carries a where content filter onto the row', () => {
    const compiled = compileTriggerSugarEntry(
      { on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR, where: { text: 'Closed Won' } },
      [],
    )!;
    expect(compiled).toEqual([{ pattern: CANONICAL, filter: { 'record.text': 'Closed Won' } }]);
  });

  it('skips (null entry) when url/selector are missing — defensive, validation catches it first', () => {
    expect(compileTriggerSugarEntry({ on: ELEMENT_ON_SHORTHAND, selector: SELECTOR }, [])).toEqual([]);
    expect(compileTriggerSugarEntry({ on: ELEMENT_ON_SHORTHAND, url: URL }, [])).toEqual([]);
  });
});

describe('validateRecipeEventTriggerEntry — dom form', () => {
  const ok = (entry: unknown) => validateRecipeEventTriggerEntry(entry);

  it('accepts a well-formed dom watch', () => {
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR })).toEqual([]);
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR, where: { text: 'x' } })).toEqual([]);
  });

  it('requires url AND selector', () => {
    expect(ok({ on: ELEMENT_ON_SHORTHAND, selector: SELECTOR })).toEqual([
      expect.stringContaining("'url' is required"),
    ]);
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL })).toEqual([
      expect.stringContaining("'selector' is required"),
    ]);
  });

  it('rejects empty / non-string / ref-bearing url+selector', () => {
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: '', selector: SELECTOR })[0]).toContain('non-empty');
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: 42, selector: SELECTOR })[0]).toContain('non-empty');
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: '{{config.url}}', selector: SELECTOR })[0]).toContain('literal');
  });

  it('rejects a whitespace-bearing url (would split the codec target wrongly)', () => {
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: 'https://x.test/a b/*', selector: SELECTOR })[0])
      .toContain('whitespace-free');
    // but a selector WITH spaces (descendant combinator) is fine — it is the
    // second codec half.
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL, selector: '#a .b > span' })).toEqual([]);
  });

  it('rejects connection and fields, allows where', () => {
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR, connection: 'x' })[0]).toContain("'connection' does not apply");
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR, fields: ['text'] })[0]).toContain("'fields' does not apply");
    expect(ok({ on: ELEMENT_ON_SHORTHAND, url: URL, selector: SELECTOR, where: { text: 'x' } })).toEqual([]);
  });

  it('fences url/selector to the dom form — rejects them on other on-forms', () => {
    expect(ok({ on: 'deal.changed', url: URL })[0]).toContain('applies only to the dom watch sugar');
    expect(ok({ on: 'message.received', selector: SELECTOR })[0]).toContain('applies only to the dom watch sugar');
  });

  it('fences url/selector off the raw event form', () => {
    expect(ok({ event: 'data.mail.**.created', url: URL })[0]).toContain('belongs to the dom watch sugar');
    expect(ok({ event: 'data.mail.**.created', selector: SELECTOR })[0]).toContain('belongs to the dom watch sugar');
  });

  it("names the dom shorthand in the unparseable-'on' error", () => {
    expect(ok({ on: 'totally.bogus' })[0]).toContain(ELEMENT_ON_SHORTHAND);
  });
});

describe('matchable-tail — raw dom-element patterns', () => {
  it('rejects an UNMATCHABLE dom pattern (silently-dead subscription)', () => {
    for (const bad of [
      `data.dom.element.${ENC}`,            // tailless
      'data.dom.element.foo',               // tailless literal
      'data.dom.element.*',                 // tailless single-wildcard
      'data.dom.element',                   // no target at all
      `data.dom.element.${ENC}.created`,    // wrong kind — source emits only updated
      `data.dom.element.${ENC}.deleted`,    // wrong kind
      `data.dom.element.${ENC}.updated.x`,  // overlong — emit is exactly 5 segments
      'data.dom.element.**.created',        // ** before a wrong-kind literal still can't match
    ]) {
      const problems = validateRecipeEventTriggerEntry({ event: bad });
      expect(problems.some((p) => p.includes('can never match')), bad).toBe(true);
    }
  });

  it('accepts a dom pattern that can match the data.dom.element.<target>.updated emit', () => {
    for (const good of [
      CANONICAL,
      `data.dom.element.${ENC}.**`,
      `data.dom.element.${ENC}.*`,
      'data.dom.element.*.updated',
      'data.dom.element.*.*',
      'data.dom.element.**',
      'data.dom.element.**.updated',
      'data.dom.**',
    ]) {
      expect(validateRecipeEventTriggerEntry({ event: good }), good).toEqual([]);
    }
  });

  it('isUnmatchableDomWatchPattern is dom-only — leaves connection-api / mcp patterns alone', () => {
    // The same tail-less shape on a NON-dom namespace is NOT flagged here
    // (those emits are variable-length; uniform enforcement is deferred).
    expect(isUnmatchableDomWatchPattern('data.connection.api.hubspot.deal')).toBe(false);
    expect(isUnmatchableDomWatchPattern('data.connection.mcp.c.resource.uri')).toBe(false);
    expect(isUnmatchableDomWatchPattern(`data.dom.element.${ENC}`)).toBe(true);
    expect(isUnmatchableDomWatchPattern(`data.dom.element.${ENC}.updated`)).toBe(false);
  });
});

describe('isDomWatchTriggerEntry — the publish-gate classifier', () => {
  it('flags the dom sugar shorthand and any raw data.dom.* pattern', () => {
    expect(isDomWatchTriggerEntry({ on: ELEMENT_ON_SHORTHAND })).toBe(true);
    expect(isDomWatchTriggerEntry({ event: CANONICAL })).toBe(true);
    expect(isDomWatchTriggerEntry({ event: 'data.dom.**' })).toBe(true);
  });

  it('does NOT flag connection-bound or push subscriptions', () => {
    expect(isDomWatchTriggerEntry({ on: 'deal.changed' })).toBe(false);
    expect(isDomWatchTriggerEntry({ on: 'message.received' })).toBe(false);
    expect(isDomWatchTriggerEntry({ event: 'data.connection.api.hubspot.deal.**.updated' })).toBe(false);
    expect(isDomWatchTriggerEntry({ event: 'data.mail.**.created' })).toBe(false);
  });
});
