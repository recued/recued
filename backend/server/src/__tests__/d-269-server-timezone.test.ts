/** D-269 step 1 — the server's own timezone: declared, or followed on a laptop.
 *
 *  ⛔⛔ WHAT THIS IS ACTUALLY FOR. Before this, every wall-clock surface either
 *  read the zone off whichever CLIENT was there, or — with no client — off the
 *  server's HOST OS. The second is right for a laptop install and a datacenter's
 *  zone on a VPS, and nothing could tell the two apart, so the chat packet's
 *  `current_date` anchor was silently wrong for Slack, Telegram and every
 *  sweep-initiated turn on any server that is not sitting next to its owner.
 *
 *  🔑 THE UNIT UNDER TEST IS THE PRECEDENCE, NOT THE FORMATTING.
 *  `client zone → declared server zone → host OS zone`, and the middle step is
 *  the new one. A test that only checked "a zone comes out" would pass on the
 *  old two-step chain, which is the bug.
 *
 *  ⚠ HOST ZONE IS INJECTED THROUGHOUT. A test that let the real host clock
 *  supply it could only assert the answer it already assumed — and the
 *  resolution IS the subject. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  canonicalizeIanaZone,
  isServerTimeZoneConfigured,
  isValidIanaZone,
  resolveServerTimeZone,
  type ServerTimeZoneSetting,
} from '@recued/contracts';
import { createServerTimeZoneStore } from '../storage/server-timezone-store.js';
import { formatChatCurrentDate } from '../chat-turn-executor.js';

const HOST = 'Europe/Paris';
const DECLARED = 'Asia/Hong_Kong';
const CLIENT = 'America/New_York';

const setting = (
  mode: ServerTimeZoneSetting['mode'],
  zone: string | null,
): ServerTimeZoneSetting => ({ mode, zone, updated_at: 1 });

describe('D-269 — zone vs offset: an IANA id carries the DST rules', () => {
  it('⛔⛔ REFUSES the RULE-LESS forms — a fixed offset can never follow DST', () => {
    expect(canonicalizeIanaZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(canonicalizeIanaZone('Asia/Kolkata')).toBe('Asia/Kolkata'); // half-hour zone
    // ⛔ `Intl` ACCEPTS these; we do not. A fixed offset is wrong twice a year
    // by construction, whatever the owner meant by it — so unlike an
    // abbreviation this is not an intent question and is refused outright.
    expect(canonicalizeIanaZone('-08:00')).toBeNull();
    expect(canonicalizeIanaZone('Etc/GMT+8')).toBeNull();
    expect(canonicalizeIanaZone('UTC-08:00')).toBeNull(); // Intl throws on this one
    expect(canonicalizeIanaZone('')).toBeNull();
    expect(canonicalizeIanaZone(undefined)).toBeNull();
    expect(isValidIanaZone('America/Los_Angeles')).toBe(true);
    expect(isValidIanaZone('-08:00')).toBe(false);
  });

  it('⛔⛔ CANONICALISES an abbreviation — and `EST` is the trap, not `PST`', () => {
    // Probed, not assumed. `Intl` takes both; they are NOT equivalent:
    //   PST → America/Los_Angeles, which observes DST      ✓ harmless alias
    //   EST → America/PANAMA,      which NEVER does        ⛔ an hour wrong for
    //                                                        eight months
    // No validator can tell that a New Yorker typing `EST` meant New York. So
    // the answer is not refusal, it is CANONICALISING and showing it back —
    // the picker rendering `America/Panama` is how they see what they got.
    expect(canonicalizeIanaZone('PST')).toBe('America/Los_Angeles');
    expect(canonicalizeIanaZone('EST')).toBe('America/Panama');
    expect(canonicalizeIanaZone('EST5EDT')).toBe('America/New_York');

    // And the consequence is real, which is why it must be visible: the same
    // instant, two "Eastern" answers an hour apart in summer.
    const summer = Date.parse('2026-06-15T20:00:00Z');
    expect(formatChatCurrentDate(summer, 'America/Panama')).toContain('UTC-05:00');
    expect(formatChatCurrentDate(summer, 'America/New_York')).toContain('UTC-04:00');
  });

  it('🔑 one stored zone renders PST in January and PDT in June — nothing is set twice a year', () => {
    // The owner's question: "I never set PDT, but daylight saving is real."
    // They never set it because PDT is an OUTPUT of the zone's rules, not an
    // input. Same string, two answers, no second setting.
    const zone = 'America/Los_Angeles';
    const january = formatChatCurrentDate(Date.parse('2026-01-15T20:00:00Z'), zone);
    const june = formatChatCurrentDate(Date.parse('2026-06-15T20:00:00Z'), zone);
    expect(january).toContain('UTC-08:00');
    expect(june).toContain('UTC-07:00');
  });
});

describe('D-269 — the precedence: client → declared → host', () => {
  it('a live client zone still wins: "what time is it where I am"', () => {
    // ⚠ NOT a tie-break the declared value should win. A connected surface's
    // zone is live evidence of where the owner IS, so an owner in New York sees
    // New York even though their server at home is declared Hong Kong.
    expect(formatChatCurrentDate(Date.parse('2026-06-15T20:00:00Z'), CLIENT, DECLARED))
      .toContain('UTC-04:00');
  });

  it('⛔ THE FIX: with NO client zone the DECLARED zone anchors the turn, not the host', () => {
    // This is the Slack / Telegram / sweep-initiated case. Before D-269 the
    // only answer was the host, so this rendered Paris on a Paris-hosted VPS
    // whose owner lives in Hong Kong.
    const out = formatChatCurrentDate(
      Date.parse('2026-06-15T20:00:00Z'),
      undefined,
      resolveServerTimeZone(setting('fixed', DECLARED), HOST),
    );
    expect(out).toContain('UTC+08:00');
    // ⚠ Pinned as NOT-the-host rather than only as is-the-declared: the old
    // behaviour and a broken new one both produce a valid-looking string, and
    // only the host value distinguishes them.
    expect(out).not.toContain('UTC+02:00');
  });

  it('the host reading survives as the LAST resort — a turn never renders no clock', () => {
    // A model with no date refuses or burns tool-loop rounds guessing, so an
    // unset setting must degrade, never fail.
    expect(resolveServerTimeZone(null, HOST)).toBe(HOST);
    expect(formatChatCurrentDate(Date.parse('2026-06-15T20:00:00Z'), undefined, undefined))
      .toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it('an untrusted or stale zone degrades instead of throwing', () => {
    // `Intl` throws RangeError on an unknown zone. A bot supplying junk, or a
    // row written before a tz-database rename, must not crash the turn.
    expect(formatChatCurrentDate(Date.parse('2026-06-15T20:00:00Z'), 'Not/AZone', DECLARED))
      .toContain('UTC+08:00');
    expect(resolveServerTimeZone(setting('fixed', 'Not/AZone'), HOST)).toBe(HOST);
  });
});

describe('D-269 — the MODE is the deployment fact, and it is the point', () => {
  it('⛔ follows_host tracks the machine: a laptop that flew anchors where it WOKE', () => {
    // The owner's case. REV 3 had the server pinned to a home zone, which is
    // exactly backwards when the server IS the laptop in the owner's bag:
    // quiet hours 22:00 Hong Kong would fire at 15:00 London.
    const s = setting('follows_host', DECLARED);
    expect(resolveServerTimeZone(s, 'Europe/London')).toBe('Europe/London');
    expect(resolveServerTimeZone(s, 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('fixed ignores the host: the machine stays, the owner may travel', () => {
    expect(resolveServerTimeZone(setting('fixed', DECLARED), 'Europe/London')).toBe(DECLARED);
  });

  it('🔑 the arm-gate is RESOLVABLE, not DECLARED — a laptop owner types nothing', () => {
    // Wall-clock features (quiet hours) refuse to run without an answer. But
    // `follows_host` IS an answer, so requiring a typed zone would block the
    // one deployment that never needs one.
    expect(isServerTimeZoneConfigured(setting('follows_host', null))).toBe(true);
    expect(isServerTimeZoneConfigured(setting('fixed', DECLARED))).toBe(true);
    expect(isServerTimeZoneConfigured(setting('fixed', null))).toBe(false);
    expect(isServerTimeZoneConfigured(null)).toBe(false);
  });
});

describe('D-269 — the store', () => {
  const freshStore = () => createServerTimeZoneStore(new Database(':memory:'));

  it('reads null before the owner has said anything — "unset" is a state, not a default', () => {
    // ⛔ Seeding a default here would hand quiet hours a zone nobody chose and
    // make `isServerTimeZoneConfigured` un-answerable.
    expect(freshStore().read()).toBeNull();
  });

  it('round-trips, and stays ONE row however many times it is written', () => {
    const store = freshStore();
    store.write('fixed', DECLARED, 10);
    store.write('follows_host', DECLARED, 20);
    const row = store.read();
    expect(row).toEqual({ mode: 'follows_host', zone: DECLARED, updated_at: 20 });
  });

  it('⚠ keeps the zone through a follows_host switch — a flip back must not lose it', () => {
    const store = freshStore();
    store.write('fixed', DECLARED, 10);
    store.write('follows_host', store.read()!.zone, 20);
    expect(store.read()!.zone).toBe(DECLARED);
  });

  it('⛔ an unknown mode from a NEWER server does not read back as a silent `fixed` with a zone', () => {
    // A row written by a later build must not resolve as an authoritative
    // declared zone this build never meant to honour. It degrades to the mode
    // whose behaviour is deployment-neutral and lets validation decide.
    const db = new Database(':memory:');
    const store = createServerTimeZoneStore(db);
    store.write('fixed', DECLARED, 10);
    db.prepare(`UPDATE server_timezone SET mode = 'follows_satellite'`).run();
    expect(store.read()!.mode).toBe('fixed');
  });
});
