/** D-148 § A.15 / I-15 — NO SMART-REDIRECT ON ADDRESS CHANGES.
 *
 *  The invariant, in the spec's own words: *"Smart-redirect protocol means
 *  cloud has authority to redirect clients to a new server. A compromised
 *  cloud could redirect to attacker-controlled server. Manual update preserves
 *  the trust anchor at the user-bound action."*
 *
 *  ⛔⛔ § A.15 CLAIMED THIS WAS ALREADY ENFORCED — *"code grep + structural
 *  tests assert no smart-redirect logic in webclient / bridge / CLI"* — AND IT
 *  WAS NOT. Verified 2026-09-17: zero occurrences of `smart-redirect` /
 *  `smart_redirect` anywhere in `apps`, `packages` or `backend`; the only
 *  `I-15` hits belonged to D-149's unrelated reception invariant. The claim
 *  had no test behind it for the whole life of the spec. This file is that
 *  test.
 *
 *  ⚠ WHY IT MATTERS NOW RATHER THAN IN PRINCIPLE. `handle_changed` is a real
 *  broadcast the handle state machine already emits, kept dormant only because
 *  its broadcaster is a no-op and no kind exists in the wire union
 *  (`wire-cert-stack.ts`). Its own comment says the future slice will *"drive a
 *  webclient handler that refreshes the user-visible label"* — and a handler
 *  that refreshes a LABEL from a server event is one line away from one that
 *  refreshes the ADDRESS. This guard has to exist before that slice, not after.
 *
 *  ── What it enforces ────────────────────────────────────────────────────
 *  Every call that writes a server address into client storage is enumerated,
 *  and each one's argument must be rooted at a name this file has judged to be
 *  user-supplied or locally-held. A write whose address comes from a wire
 *  payload — an event, an rpc result, a passport, a response — is what
 *  smart-redirect IS, so the root name is the thing to police.
 *
 *  ⚠ It is a STRUCTURAL guard and says so plainly. It proves no address writer
 *  takes its URL from an obviously wire-rooted expression, and it makes adding
 *  any new writer a deliberate act that trips a test. It does NOT prove the
 *  value was not laundered through a local variable first — a reviewer still
 *  has to read a new entry. Claiming more than that would be worse than
 *  claiming nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { codeOf } from './helpers/source-text.js';
import { resolve } from 'node:path';

const CLIENT_ROOTS = [
  resolve(import.meta.dirname, '..'),                                  // apps/webclient/src
  resolve(import.meta.dirname, '..', '..', '..', 'bridge', 'src'),     // apps/bridge/src
];

const sourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
      sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
};

/** Every shape that puts a server address into client storage.
 *
 *  ⚠ `set('server_url', …)` is one of them because `local-store.ts` intercepts
 *  it: the value SELECTS a profile (adopt-or-mint), so it is an address write
 *  even though it reads like a field assignment. */
const ADDRESS_WRITE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // ⛔ THE ARGUMENT IS CAPTURED AS RAW TEXT, NOT AS AN IDENTIFIER, AND THAT IS
  // THE WHOLE POINT. The first version of this file captured
  // `([A-Za-z_$][\w$]*)` — a bare identifier — so a write whose argument did
  // not START with an identifier character MATCHED NOTHING AND WAS INVISIBLE.
  // `set('server_url', `wss://${event.host}/ws`)` passed all five tests with a
  // smart-redirect sitting in the tree, and a template literal is the most
  // natural way anyone would build a URL. Found by mutation, after shipping.
  { label: "set('server_url', …)", re: /\.set\(\s*'server_url'\s*,\s*([^)]*)/g },
  { label: 'ensureProfile(…)', re: /\.ensureProfile\(\s*([^)]*)/g },
  // Selects (or mints) the record by its first argument, like ensureProfile.
  { label: 'commitPair(…)', re: /\.commitPair\(\s*([^)]*)/g },
  { label: 'retargetProfile(…)', re: /\.retargetProfile\(\s*([^)]*)/g },
];

/** Collapse an argument expression to something stable enough to pin. */
const normaliseArg = (raw: string): string =>
  raw.replace(/\s+/g, ' ').trim().slice(0, 80);

/** The leading identifier, when there is one — `pair` in `pair.serverUrl`.
 *  Null for a literal, a template or anything else, which is exactly why the
 *  PIN and not this is what closes the guard. */
const argRoot = (raw: string): string | null =>
  /^([A-Za-z_$][\w$]*)/.exec(normaliseArg(raw))?.[1] ?? null;

interface Write {
  file: string;
  label: string;
  /** The argument expression as written, normalised. Pinning the TEXT rather
   *  than a parsed root is what makes every shape visible. */
  arg: string;
}

const collectWrites = (): Write[] => {
  const writes: Write[] = [];
  for (const root of CLIENT_ROOTS) {
    for (const file of sourceFiles(root)) {
      // ⚠ CODE ONLY. A comment showing a smart-redirect as an EXAMPLE of what
      // not to do — exactly the kind this file's own header contains — would
      // otherwise be scanned as a real writer and fail the pin, teaching the
      // next reader to silence the guard rather than read it.
      const src = codeOf(file);
      for (const { label, re } of ADDRESS_WRITE_PATTERNS) {
        for (const m of src.matchAll(new RegExp(re.source, 'g'))) {
          writes.push({
            file: file.slice(file.indexOf('apps/')),
            label,
            arg: normaliseArg(m[1] ?? ''),
          });
        }
      }
    }
  }
  return writes;
};

/** The pinned set. Each entry names WHERE the address comes from — that
 *  provenance is the whole review, so it is written down rather than implied.
 *
 *  ⛔ ADDING A LINE HERE IS A SECURITY DECISION. The question to answer is not
 *  "does this compile" but "could a server or the cloud choose this value?" */
const ALLOWED_WRITES: ReadonlyArray<Write & { why: string }> = [
  {
    file: 'apps/webclient/src/auth/pair-code-success.ts',
    label: "set('server_url', …)",
    arg: 'wsServerUrl',
    why: 'normaliseServerUrlToWs(options.serverUrl) — the address the USER typed into the pair form, normalised client-side. The retired `server_address_hints` channel, where the SERVER proposed addresses, is gone; only two comments mention it.',
  },
  {
    file: 'apps/webclient/src/auth/pair-code-success.ts',
    label: 'ensureProfile(…)',
    arg: 'wsServerUrl',
    why: 'Same user-typed address, selecting the roster row the pair lands in.',
  },
  {
    file: 'apps/webclient/src/auth/pair-code-success.ts',
    label: 'commitPair(…)',
    arg: 'wsServerUrl, pairing',
    why: 'Same user-typed address, selecting the roster row; `pairing` is the four fields the save lands on it in one write (passport-verified key, metadata, pin, sealed token).',
  },
  {
    file: 'apps/webclient/src/boot/pair-fallback-bootstrap.ts',
    label: 'ensureProfile(…)',
    arg: 'pairedUrl',
    why: 'normaliseServerUrlToWs(paired.serverUrl) — `PairCodeInputSuccess.serverUrl` is the address the USER typed into this pair form, the same one the save below selects. Selected first only when another tab switched the browser while this pairing waited to be saved, so the save lands on its own server rather than being refused over another.',
  },
  {
    file: 'apps/webclient/src/webclient-bootstrap.ts',
    label: 'ensureProfile(…)',
    arg: 'pair.serverUrl',
    why: 'Hydrated from THIS browser\'s own storage at boot. Re-asserting a locally-held address, not adopting a proposed one.',
  },
  {
    file: 'apps/webclient/src/webclient-bootstrap.ts',
    label: 'retargetProfile(…)',
    arg: 'id, next_url, next_token, expected_token_id',
    why: 'Settings → Servers. `next_url` is the user\'s typed candidate (normalised as pairing does), written only after that candidate SIGNED a fresh nonce with the pinned server_public_key (auth/retarget-server-url.ts). User-initiated and destination-verified — the two things § A.15 asks for. `expected_token_id` makes it a compare-and-set: it never writes the older token over a newer sign-in.',
  },
  {
    file: 'apps/bridge/src/pairing/pair-completion.ts',
    label: "set('server_url', …)",
    arg: 'wsServerUrl',
    why: 'The bridge\'s own pair form (in its side panel; its service worker finishes the pair) — same normalisation of a user-typed address.',
  },
];

/** Roots that would mean the address came off the wire. ⚠ The weaker half:
 *  it only fires when the argument HAS a leading identifier, and it is
 *  laundered past by one local variable. The PIN above is what closes the
 *  guard; this states the shape of the defect in one place. */
const WIRE_ROOTED = [
  'event', 'evt', 'message', 'msg', 'payload', 'response', 'res', 'result',
  'passport', 'notice', 'broadcast', 'server', 'cloud', 'remote', 'body',
];

const key = (w: Write): string => `${w.file} :: ${w.label} :: ${w.arg}`;

describe('D-148 I-15 — no smart-redirect on address changes', () => {
  it('finds address writers at all — the scan is not vacuous', () => {
    // ⚠ A guard whose scan silently matched nothing would pass for ever while
    // enforcing nothing, which is the failure mode this whole file exists
    // because of.
    expect(collectWrites().length).toBeGreaterThanOrEqual(ALLOWED_WRITES.length);
  });

  it('⛔ every client-side address write is one of the reviewed ones', () => {
    const found = collectWrites().map(key).sort();
    const allowed = ALLOWED_WRITES.map(key).sort();
    // A new writer, or a writer whose argument changed provenance, lands here.
    // Read the entry's `why` before adding one: the question is not whether it
    // compiles, it is whether a server or the cloud could choose that value.
    expect(found).toEqual(allowed);
  });

  it('⛔ no address is written from a wire-rooted expression', () => {
    for (const write of collectWrites()) {
      const root = argRoot(write.arg);
      if (root === null) continue; // a literal or template — the pin covers it
      expect(
        WIRE_ROOTED,
        `${key(write)} takes its address from something that looks server-supplied`,
      ).not.toContain(root.toLowerCase());
    }
  });

  it('⛔ sees a write whose argument is not a bare identifier', () => {
    // ⚠ REGRESSION GUARD FOR THIS FILE ITSELF. The first version captured only
    // `([A-Za-z_$][\w$]*)`, so `set('server_url', `wss://${event.host}/ws`)`
    // matched NOTHING and passed every test. The scan must see a template
    // literal, a string literal and a call expression alike.
    const shapes = [
      "await store.set('server_url', `wss://${event.host}/ws`);",
      "await store.set('server_url', 'wss://fixed.example/ws');",
      "await store.ensureProfile(buildUrl(event));",
      "await store.commitPair(`wss://${event.host}/ws`, fields);",
    ];
    for (const line of shapes) {
      const hits = [...line.matchAll(/\.(?:set\(\s*'server_url'\s*,|ensureProfile\(|commitPair\(|retargetProfile\()\s*([^)]*)/g)];
      expect(hits.length, `scan is blind to: ${line}`).toBeGreaterThan(0);
      expect(normaliseArg(hits[0]![1] ?? '').length).toBeGreaterThan(0);
    }
  });

  it('the reviewed set itself carries no wire-rooted entry', () => {
    // Closes the loop: someone silencing the previous test by pinning a
    // wire-rooted writer trips this one instead.
    for (const write of ALLOWED_WRITES) {
      const root = argRoot(write.arg);
      if (root !== null) expect(WIRE_ROOTED).not.toContain(root.toLowerCase());
      expect(write.why.length).toBeGreaterThan(40);
    }
  });

  it('⚠ the dormant handle_changed broadcast still reaches no client handler', () => {
    // The spec's own flow (§ A.5.1 step 5) has the server emit
    // `account.handle_changed` so clients "refresh their pinned server_url".
    // That is the sentence smart-redirect would be built from. It is dormant
    // today: the broadcaster is a no-op and there is no such kind on the wire.
    // When the future Settings → Handle slice wires it, this assertion fails
    // and whoever wires it has to come and read § A.15 first.
    const contracts = codeOf(
      resolve(import.meta.dirname, '..', '..', '..', '..', 'packages', 'contracts', 'src', 'events.ts'),
    );
    expect(contracts).not.toMatch(/'handle_changed'|"handle_changed"/);
  });
});
