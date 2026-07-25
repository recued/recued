/** dom poll grammar (the 3rd WatchPollSource).
 *
 *  Wire-level pins: a `(url_pattern, selector)` target (carrying `/` `:`
 *  `[` `]` ` ` `>` `'`) must encode into ONE dotted bus-path segment, the
 *  authored subscriber pattern must parse back to the SAME target, and
 *  the source's `event_scope` path must be re-parseable — drift here is a
 *  silently dead subscription (the watcher emits one path, the recipe
 *  subscribes to another). */

import { describe, expect, it } from 'vitest';
import {
  DOM_WATCH_CONNECTION,
  DOM_WATCH_PLATFORM,
  DOM_WATCH_POLL_SOURCE_ID,
  DOM_WATCH_VENDOR,
  decodeDomWatchTarget,
  domWatchEventScope,
  encodeDomWatchTarget,
  parseDomWatchDemand,
} from '../watch.js';

/** The `isValidPattern` segment grammar (warehouse-events glob) — an
 *  encoded target MUST be exactly one such segment so the authored
 *  pattern is creatable via `triggers.create`. Inlined to keep contracts
 *  tests package-local. */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

describe('dom watch target codec', () => {
  const targets: Array<{ url_pattern: string; selector: string }> = [
    { url_pattern: 'https://app.hubspot.com/contacts/*', selector: '#deal-amount' },
    // selector with a descendant combinator (interior space)
    { url_pattern: '*://*.example.com/*', selector: '.container .item' },
    // attribute selector with a quoted value (interior space + quotes)
    { url_pattern: 'https://x.com/board', selector: "[data-test='a b'] > span" },
    // unicode in the selector
    { url_pattern: 'https://résumé.example/*', selector: '.naïve' },
    // minimal
    { url_pattern: 'https://a/', selector: 'b' },
  ];

  it('round-trips every target shape through a single url-safe segment', () => {
    for (const t of targets) {
      const encoded = encodeDomWatchTarget(t.url_pattern, t.selector);
      expect(encoded).toMatch(SEGMENT_RE);
      expect(encoded.includes('.')).toBe(false); // never breaks the dotted path
      expect(decodeDomWatchTarget(encoded)).toEqual(t);
    }
  });

  it('the FIRST space is the boundary even when the selector contains spaces', () => {
    // url patterns are space-free by Chrome-match-pattern grammar, so the
    // first space splits url_pattern | selector regardless of how many
    // spaces the selector carries.
    const encoded = encodeDomWatchTarget('https://x.com/*', 'div p   span');
    expect(decodeDomWatchTarget(encoded)).toEqual({
      url_pattern: 'https://x.com/*',
      selector: 'div p   span',
    });
  });

  it('decode rejects empty, padded, corrupt, and separator-less segments', () => {
    expect(decodeDomWatchTarget('')).toBeNull();
    // canonical encode is unpadded — a padded variant is non-canonical
    const padded = `${encodeDomWatchTarget('https://x/', 'b')}=`;
    expect(decodeDomWatchTarget(padded)).toBeNull();
    // a `.` is not a base64url char and would never be one segment
    expect(decodeDomWatchTarget('not.base64')).toBeNull();
    // a decoded form with no space separator (single token) is invalid
    const noSep = Buffer.from('nospacehere', 'utf8').toString('base64url');
    expect(decodeDomWatchTarget(noSep)).toBeNull();
  });

  it('decode rejects an empty half (leading / trailing separator)', () => {
    // hand-encode a decoded form whose url_pattern or selector is empty —
    // both must be non-empty.
    const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
    expect(decodeDomWatchTarget(b64(' selector-only'))).toBeNull(); // empty url
    expect(decodeDomWatchTarget(b64('url-only '))).toBeNull(); // empty selector
  });
});

describe('parseDomWatchDemand', () => {
  const enc = encodeDomWatchTarget('https://app.hubspot.com/contacts/*', '#deal-amount');

  it('parses url_pattern + selector from a literal pattern (with trailing kind / **)', () => {
    expect(parseDomWatchDemand(`data.dom.element.${enc}.updated`)).toEqual({
      url_pattern: 'https://app.hubspot.com/contacts/*',
      selector: '#deal-amount',
    });
    expect(parseDomWatchDemand(`data.dom.element.${enc}.**`)).toEqual({
      url_pattern: 'https://app.hubspot.com/contacts/*',
      selector: '#deal-amount',
    });
  });

  it('returns null for non-dom / malformed / wildcard patterns', () => {
    // wrong prefix (connection-api, not dom)
    expect(parseDomWatchDemand('data.connection.api.hubspot.deal.**')).toBeNull();
    // wrong prefix (mcp)
    expect(parseDomWatchDemand('data.connection.mcp.s.resource.x.updated')).toBeNull();
    // too few segments
    expect(parseDomWatchDemand(`data.dom.element`)).toBeNull();
    // missing the literal `element` marker
    expect(parseDomWatchDemand(`data.dom.node.${enc}.updated`)).toBeNull();
    // wildcard target — no enumerable poll target
    expect(parseDomWatchDemand('data.dom.element.*.updated')).toBeNull();
    expect(parseDomWatchDemand('data.dom.element.**')).toBeNull();
    // undecodable target segment
    expect(parseDomWatchDemand('data.dom.element.not.base64.x')).toBeNull();
  });
});

describe('domWatchEventScope', () => {
  it('emits the dom path triple, re-parseable to the source target', () => {
    const encoded = encodeDomWatchTarget('https://x.com/feed', '.price');
    const scope = domWatchEventScope(encoded);
    expect(scope).toEqual({
      platform: DOM_WATCH_PLATFORM,
      slug: 'element',
      entity_type: encoded,
    });
    // The emitted bus path (data.<platform>.<slug>.<entity_type>.<kind>)
    // round-trips to the SAME demand a subscriber authored.
    const emittedPath = `data.${scope.platform}.${scope.slug}.${scope.entity_type}.updated`;
    expect(parseDomWatchDemand(emittedPath)).toEqual({
      url_pattern: 'https://x.com/feed',
      selector: '.price',
    });
  });

  it('exposes stable source id + sentinels', () => {
    expect(DOM_WATCH_POLL_SOURCE_ID).toBe('dom-watch');
    expect(DOM_WATCH_VENDOR).toBe('dom-watch');
    expect(DOM_WATCH_PLATFORM).toBe('dom');
    expect(DOM_WATCH_CONNECTION).toBe('bridge');
  });

  it('the dom watch vendor is keyspace-disjoint from the connection-api vendor', () => {
    // A connection-api watch key leads with a SEGMENT_RE identifier
    // (parseWatchDemandFromPattern pins the pattern vendor to
    // /^[a-z][a-z0-9_]*$/). The hyphenated dom sentinel must NOT match
    // it, so the dom + connection-api sources can never mint colliding
    // `watchKeyOf(...)` leading segments. Guards the fix; do not "tidy"
    // the hyphen away.
    expect(/^[a-z][a-z0-9_]*$/.test(DOM_WATCH_VENDOR)).toBe(false);
  });
});
