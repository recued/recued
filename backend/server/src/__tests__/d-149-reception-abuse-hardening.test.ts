/** D-149 reception abuse-hardening batch (Codex pass-2 verified findings).
 *
 *  Regression guards for four availability/abuse fixes on the reception
 *  untrusted-input surface:
 *    #1 rate-limiter — the in-memory bucket map is bounded (cap-evict +
 *       window-expiry prune) so an IP-rotation flood can't exhaust memory.
 *    #2 drop multipart — the pre-file parse buffer is bounded so a body
 *       with no boundary can't grow `buf` without limit.
 *    #4 intake honeypot — `getAll`, not `get`, so an empty duplicate of a
 *       honeypot field can't hide a filled one.
 *    #5 same-origin — the shared guard matches host, and ALSO scheme when
 *       `X-Forwarded-Proto` makes the public scheme known (no regression
 *       when it's absent). */

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RECEPTION_RATE_LIMIT_DEFAULTS, type IntakeFormConfigField } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { buildBucketKey, createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { parseMultipartUpload } from '../ports/reception/handlers/drop-link.js';
import { parseFormBody } from '../ports/reception/handlers/intake-form.js';
import { verifyReceptionSameOrigin } from '../ports/reception/handlers/same-origin.js';

const NOW = 1_700_000_000_000;

// ════════ #1 rate-limiter — bounded memory ════════
describe('#1 rate-limiter map is bounded under an IP-rotation flood', () => {
  const globalKey = (ip: string) => buildBucketKey({ bucket_kind: 'per_ip_global', source_ip_hash: ip });

  it('evicts the oldest-inserted bucket once the hard cap is reached', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    // cap = 4 ⇒ 2 distinct IPs (2 buckets each) fill it; the 3rd evicts IP-1.
    const limiter = createReceptionRateLimiter({ db, maxMemoryBuckets: 4 });
    for (const ip of ['ip-1', 'ip-2', 'ip-3']) {
      limiter.consumePreVerify({ source_ip_hash: ip, endpoint_kind: 'reception_page', now: NOW });
    }
    expect(limiter.peek(globalKey('ip-1'))).toBeUndefined(); // oldest — evicted
    expect(limiter.peek(globalKey('ip-2'))).toBeDefined();
    expect(limiter.peek(globalKey('ip-3'))).toBeDefined();
  });

  it('prunes window-expired buckets (memory + SQLite) on snapshot', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    limiter.consumePreVerify({ source_ip_hash: 'ip-x', endpoint_kind: 'reception_page', now: NOW });
    expect(limiter.peek(globalKey('ip-x'))).toBeDefined();
    const past = NOW + RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global.window_ms + 1;
    limiter.snapshot(past);
    expect(limiter.peek(globalKey('ip-x'))).toBeUndefined(); // dropped from memory
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM reception_rate_limiter`).get() as { n: number };
    expect(rows.n).toBe(0); // expired snapshot rows deleted
  });
});

// ════════ #2 drop multipart — bounded pre-file buffer ════════
describe('#2 drop multipart parser bounds the pre-file buffer', () => {
  it('aborts with prefile_buffer_overflow on a no-boundary flood', async () => {
    const req = Object.assign(new EventEmitter(), { pause: () => {} }) as unknown as IncomingMessage;
    const parsing = parseMultipartUpload({
      req,
      boundary: 'thisboundarynevercomes',
      onTextField: () => {},
      onFilePart: async () => {},
    });
    // Stream > 1 MiB of preamble with no boundary delimiter.
    setImmediate(() => {
      req.emit('data', Buffer.alloc(1024 * 1024 + 1, 0x41));
      req.emit('end');
    });
    await expect(parsing).rejects.toThrow('prefile_buffer_overflow');
  });
});

// ════════ #4 intake honeypot — getAll, not get ════════
describe('#4 intake honeypot trips on a non-empty duplicate value', () => {
  const fields: ReadonlyArray<IntakeFormConfigField> = [
    { name: 'subject', type: 'text', label: 'Subject', required: true },
  ];
  const honeypots = new Set(['website']);

  it('an empty leading duplicate cannot hide a filled honeypot value', () => {
    // `website=&website=bot` — `get` would see only the leading '' and miss it.
    const parsed = parseFormBody('subject=hi&website=&website=bot', fields, honeypots);
    expect('honeypotsTripped' in parsed).toBe(true);
    if ('honeypotsTripped' in parsed) expect(parsed.honeypotsTripped).toContain('website');
  });

  it('a genuinely empty honeypot still does not trip', () => {
    const parsed = parseFormBody('subject=hi&website=', fields, honeypots);
    expect('honeypotsTripped' in parsed).toBe(true);
    if ('honeypotsTripped' in parsed) expect(parsed.honeypotsTripped).toEqual([]);
  });
});

// ════════ #5 same-origin — host + scheme-when-known ════════
describe('#5 same-origin guard', () => {
  const req = (headers: Record<string, string>): IncomingMessage =>
    ({ headers } as unknown as IncomingMessage);

  it('accepts a same-host Origin', () => {
    expect(verifyReceptionSameOrigin(req({ host: 'app.example', origin: 'https://app.example' }))).toBe(true);
  });
  it('rejects a cross-host Origin', () => {
    expect(verifyReceptionSameOrigin(req({ host: 'app.example', origin: 'https://evil.example' }))).toBe(false);
  });
  it('falls back to Referer when Origin is absent', () => {
    expect(verifyReceptionSameOrigin(req({ host: 'app.example', referer: 'https://app.example/x' }))).toBe(true);
  });
  it('rejects when both Origin and Referer are absent', () => {
    expect(verifyReceptionSameOrigin(req({ host: 'app.example' }))).toBe(false);
  });
  it('PERMITS an opaque `Origin: null` (no-JS same-origin <form> under I-12b no-referrer)', () => {
    // A `Referrer-Policy: no-referrer` page (Must Hold I-12b) makes a same-origin
    // navigation POST send `Origin: null` + no Referer — a legit no-JS visitor
    // submit. Not cross-origin-attributable → permit + defer to the PRIMARY
    // form-nonce CSRF defense (a sandbox attacker posting `null` still can't
    // obtain the single-use nonce). Without this, every no-JS reception form 403s.
    expect(verifyReceptionSameOrigin(req({ host: 'app.example', origin: 'null' }))).toBe(true);
    // ...and a concrete cross-origin Origin is STILL rejected (the relaxation is
    // scoped to the opaque literal, not to "any non-matching origin").
    expect(verifyReceptionSameOrigin(req({ host: 'app.example', origin: 'https://evil.example' }))).toBe(false);
    // ...and the nonce stays primary even for `null`: the host gate still applies
    // to concrete origins, and absent-everything is still rejected (above).
  });
  it('enforces scheme ONLY when the caller trusts X-Forwarded-Proto (behind a proxy)', () => {
    // trustForwardedProto=true ⇒ proxy says https; an http Origin is rejected.
    const h = (proto: string) => ({ host: 'app.example', origin: `${proto}://app.example`, 'x-forwarded-proto': 'https' });
    expect(verifyReceptionSameOrigin(req(h('http')), true)).toBe(false);
    expect(verifyReceptionSameOrigin(req(h('https')), true)).toBe(true);
  });
  it('IGNORES a (forgeable) X-Forwarded-Proto when untrusted — default host-only, no regression', () => {
    // Direct listener (default false): a visitor-forged XFP must NOT flip the
    // result; the http Origin still matches the host → accepted host-only.
    expect(
      verifyReceptionSameOrigin(req({ host: 'app.example', origin: 'http://app.example', 'x-forwarded-proto': 'https' })),
    ).toBe(true);
  });
});
