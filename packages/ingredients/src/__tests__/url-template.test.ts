/** D-112 C4 — URL-safe template interpolation tests. */

import { describe, expect, it } from 'vitest';
import {
  assertUrlSafe,
  interpolateUrl,
  UrlRefInvalidError,
} from '../url-template.js';

const resolver = (vals: Record<string, unknown>) => (ref: string): unknown => vals[ref];

describe('interpolateUrl (D-112 C4) — path segments', () => {
  it('encodes a simple path-segment ref', () => {
    const url = interpolateUrl(
      'https://api.example.com/deals/{{id}}',
      resolver({ id: 'abc 123' }),
    );
    expect(url).toBe('https://api.example.com/deals/abc%20123');
  });

  it('rejects a path-segment ref containing a literal slash', () => {
    expect(() =>
      interpolateUrl(
        'https://api.example.com/deals/{{id}}',
        resolver({ id: '1/../etc/passwd' }),
      ),
    ).toThrow(UrlRefInvalidError);
  });

  it('rejects a protocol-relative value in a path segment', () => {
    expect(() =>
      interpolateUrl(
        'https://api.example.com/deals/{{id}}',
        resolver({ id: '//evil.example/hijack' }),
      ),
    ).toThrow(/URL_REF_INVALID/);
  });

  it('rejects a ref value containing nested template syntax', () => {
    expect(() =>
      interpolateUrl(
        'https://api.example.com/{{id}}',
        resolver({ id: '{{vault.leak}}' }),
      ),
    ).toThrow(/nested template/);
  });

  it('percent-encodes reserved characters in path segments', () => {
    const url = interpolateUrl(
      'https://api.example.com/{{id}}',
      resolver({ id: '?&#%' }),
    );
    expect(url).toBe('https://api.example.com/%3F%26%23%25');
  });

  it('leaves dots alone in path segments (valid path char)', () => {
    const url = interpolateUrl(
      'https://api.example.com/{{id}}',
      resolver({ id: 'v1.2.3' }),
    );
    expect(url).toBe('https://api.example.com/v1.2.3');
  });
});

describe('interpolateUrl (D-112 C4) — query values', () => {
  it('encodes query values', () => {
    const url = interpolateUrl(
      'https://api.example.com/search?q={{q}}',
      resolver({ q: 'hello world & friends' }),
    );
    expect(url).toBe('https://api.example.com/search?q=hello%20world%20%26%20friends');
  });

  it('encodes ampersands so query refs cannot inject extra params', () => {
    const url = interpolateUrl(
      'https://api.example.com/x?q={{q}}&safe=1',
      resolver({ q: 'foo&admin=true' }),
    );
    // The injected `&admin=true` must be encoded — the existing
    // `&safe=1` stays as a real param.
    expect(url).toBe('https://api.example.com/x?q=foo%26admin%3Dtrue&safe=1');
  });

  it('allows slashes in query values (semantically fine)', () => {
    const url = interpolateUrl(
      'https://api.example.com/x?path={{p}}',
      resolver({ p: '/a/b' }),
    );
    expect(url).toBe('https://api.example.com/x?path=%2Fa%2Fb');
  });
});

describe('interpolateUrl (D-112 C4) — scheme / host / fragment pass-through', () => {
  it('passes host refs through unchanged (multi-region pattern)', () => {
    const url = interpolateUrl(
      'https://{{region}}.api.example.com/x',
      resolver({ region: 'eu-west-1' }),
    );
    expect(url).toBe('https://eu-west-1.api.example.com/x');
  });

  it('passes scheme refs through unchanged', () => {
    const url = interpolateUrl(
      '{{scheme}}://api.example.com',
      resolver({ scheme: 'https' }),
    );
    expect(url).toBe('https://api.example.com');
  });

  it('passes fragment refs through unchanged', () => {
    const url = interpolateUrl(
      'https://api.example.com/#{{anchor}}',
      resolver({ anchor: 'section-1' }),
    );
    expect(url).toBe('https://api.example.com/#section-1');
  });
});

describe('interpolateUrl (D-112 C4) — edge cases', () => {
  it('returns the template unchanged when no refs are present', () => {
    expect(interpolateUrl('https://api.example.com/', resolver({}))).toBe(
      'https://api.example.com/',
    );
  });

  it('leaves the placeholder in for unresolved refs (null / undefined)', () => {
    const url = interpolateUrl(
      'https://api.example.com/{{id}}',
      resolver({ other: 'x' }),
    );
    expect(url).toBe('https://api.example.com/{{id}}');
  });

  it('handles multiple refs in one template', () => {
    const url = interpolateUrl(
      'https://api.example.com/{{entity}}/{{id}}?v={{version}}',
      resolver({ entity: 'deals', id: 'a b', version: '1' }),
    );
    expect(url).toBe('https://api.example.com/deals/a%20b?v=1');
  });

  it('coerces non-string values to their String() form', () => {
    const url = interpolateUrl(
      'https://api.example.com/{{id}}',
      resolver({ id: 42 }),
    );
    expect(url).toBe('https://api.example.com/42');
  });

  it('handles relative URL templates (no scheme)', () => {
    const url = interpolateUrl('/v1/deals/{{id}}', resolver({ id: '99' }));
    expect(url).toBe('/v1/deals/99');
  });
});

describe('assertUrlSafe (D-112 C4)', () => {
  it('passes through URLs without `..` segments', () => {
    expect(() => assertUrlSafe('https://api.example.com/v1/foo')).not.toThrow();
    expect(() => assertUrlSafe('https://api.example.com/x.y.z')).not.toThrow();
  });

  it('rejects URLs with path-traversal segments', () => {
    expect(() =>
      assertUrlSafe('https://api.example.com/a/../b'),
    ).toThrow(/path-traversal/);
    expect(() =>
      assertUrlSafe('https://api.example.com/./foo'),
    ).toThrow(/path-traversal/);
  });

  it('silently tolerates malformed URLs (downstream fetch will surface)', () => {
    expect(() => assertUrlSafe('not a url')).not.toThrow();
  });
});
