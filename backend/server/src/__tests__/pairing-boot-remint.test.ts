import { describe, expect, it } from 'vitest';

import { createPairingManager, parsePairCodeTtl } from '../pairing.js';

/** What a boot does with the code the previous boot left behind.
 *
 *  ⛔ THE REPORTED BUG (2026-08-26). `recued serve`, Ctrl+C, `recued serve` →
 *  `Pairing code: null`. Boot read `persisted ?? generateState()`, so ANY
 *  persisted row was adopted as-is — including one already expired or consumed,
 *  for both of which `getCode()` returns null. A server left running past its
 *  TTL therefore became unpairable across every subsequent restart.
 *
 *  🔑 Minting on a dead row does not weaken what the persistence is for. The
 *  live case below is the guard on that: a usable code must still be ADOPTED, so
 *  a server and a `recued pair` in another process keep agreeing on one code.
 */
const state = (over: Record<string, unknown> = {}) => ({
  code: 'PERSISTED',
  created_at: 1_000,
  expires_at: 1_000 + 900_000,
  consumed: false,
  ttl_ms: 900_000,
  ...over,
});

const makeStore = (initial: unknown) => {
  let row = initial;
  return {
    read: () => row as never,
    write: (next: unknown) => { row = next; },
    current: () => row as { code: string; consumed: boolean },
  };
};

describe('pairing manager boot', () => {
  it('adopts a LIVE persisted code so two processes agree', () => {
    const store = makeStore(state());
    const mgr = createPairingManager({ store, now: () => 2_000 });
    expect(mgr.getCode()).toBe('PERSISTED');
    expect(store.current().code).toBe('PERSISTED');
  });

  it('mints when the persisted code has EXPIRED', () => {
    const store = makeStore(state());
    // now() is past expires_at — the exact case a restart after the TTL hits.
    const mgr = createPairingManager({ store, now: () => 1_000 + 900_001 });
    const code = mgr.getCode();
    expect(code).not.toBeNull();
    expect(code).not.toBe('PERSISTED');
    expect(store.current().code).toBe(code); // and it was persisted for `recued pair`
  });

  it('mints when the persisted code was CONSUMED', () => {
    const store = makeStore(state({ consumed: true }));
    const mgr = createPairingManager({ store, now: () => 2_000 });
    const code = mgr.getCode();
    expect(code).not.toBeNull();
    expect(code).not.toBe('PERSISTED');
    expect(store.current().consumed).toBe(false);
  });
});

/** `--pair-code-ttl` parsing had NO test at all, which matters because the flag
 *  is the documented escape hatch for asynchronous reviewers and its failure
 *  mode is quiet: an unparseable value returns undefined, the resolver falls
 *  through to the 15-minute default, and the operator who asked for 7 days gets
 *  no signal from the server itself. serve-entry does print an error and exit —
 *  this pins the shape that decision rests on. */
describe('parsePairCodeTtl', () => {
  it('accepts the documented forms', () => {
    expect(parsePairCodeTtl('900000')).toBe(900_000); // bare ms
    expect(parsePairCodeTtl('30m')).toBe(1_800_000);
    expect(parsePairCodeTtl('12h')).toBe(43_200_000);
    expect(parsePairCodeTtl('7d')).toBe(604_800_000);
    expect(parsePairCodeTtl(' 7d ')).toBe(604_800_000); // trimmed
  });

  it('refuses what it cannot honour, rather than guessing', () => {
    for (const bad of ['', '   ', '0', '-1', '7 days', '7w', 'abc', '1e3', undefined]) {
      expect(parsePairCodeTtl(bad as string | undefined)).toBeUndefined();
    }
  });

  it('treats a bare number as milliseconds, not minutes', () => {
    // 900000 is the built-in default expressed in ms; read as minutes it would
    // be 625 days, and the flag's help text promises ms.
    expect(parsePairCodeTtl('900000')).toBe(900_000);
  });
});
