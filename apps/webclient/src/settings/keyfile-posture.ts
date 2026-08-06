/** D-212 §7.10 — the webclient's keyfile-posture projection.
 *
 *  §7.10 replaced the retracted §7.9 refusal (which bricked headless
 *  installs) with a floor that is reachable on every platform: an operator
 *  MAY run unsealed, and the thing that makes that acceptable is that the
 *  posture stays **legible and standing**. That floor only holds if every
 *  surface renders it — the CLI (`recued auth-status`) and the bridge side
 *  panel already do; this is the webclient's half.
 *
 *  ⛔⛔ `'none'` IS NOT `null`, and this module exists mostly to keep them
 *  apart. `null` is the ordinary not-wired case this shape uses for its
 *  counters; `'none'` is a KNOWN and materially worse posture. They are the
 *  same width on screen and opposite in meaning, so they get different
 *  tones, different words, and only one of them carries a consequence.
 *  Collapsing them would delete the only control that replaced §7.9.
 *
 *  Pure by design — no DOM, no rpc. The panel owns rendering; this owns
 *  what each posture MEANS, so the wording is testable on its own and the
 *  next surface to adopt it inherits the same words rather than paraphrasing
 *  them.
 *
 *  Spec: D-212 § 7.10 (legibility) + § 7.11 (regeneration). */

import type { ServerSystemStatus } from '@recued/contracts';

/** The contract's four states, verbatim. */
export type KeyfileSealing = ServerSystemStatus['keyfile_sealing'];

/** Rendering tone. Four values for four genuinely different situations —
 *  `unreported` and `unreadable` are both "we don't know", but one is the
 *  server declining to say and the other is us failing to ask, and an
 *  operator can only act on the second. */
export type KeyfilePostureTone = 'sealed' | 'unsealed' | 'unreported' | 'unreadable';

/** What the panel knows. `unreadable` is not a contract value — it is the
 *  `system.status` read having failed, kept distinct from every posture the
 *  server can actually report. */
export type KeyfilePostureInput =
  | { kind: 'value'; sealing: KeyfileSealing }
  | { kind: 'unreadable'; message: string };

export interface KeyfilePostureView {
  tone: KeyfilePostureTone;
  /** Chip text — the posture in two or three words. */
  status: string;
  /** One line: what is (or is not) protecting the keyfile. */
  detail: string;
  /** What being in this state COSTS. Non-null ONLY for `unsealed` — a
   *  consequence line under a sealed keyfile would be noise, and noise is
   *  how a real warning stops being read. */
  consequence: string | null;
  /** How to change it, with its price named. Non-null ONLY for `unsealed`. */
  remediation: string | null;
}

/** The unsealed remediation, verified against the code that implements it
 *  rather than paraphrased from the warning:
 *
 *   1. Setting `RECUED_IDENTITY_PASSPHRASE` on a realm that is already
 *      encrypted does NOT re-seal the keyfile in place — `file-store.ts`
 *      refuses ("unsealed but already holds this realm's server vault key,
 *      so a passphrase cannot be applied to it now"). Sealing is chosen once.
 *   2. That refusal is what makes step 2 work: `recover-keyfile` skips its
 *      `keyfile_is_healthy` guard precisely because the keyfile no longer
 *      opens under the new environment.
 *   3. ⛔ And it is not free. Regeneration mints a NEW server identity — the
 *      keyfile also holds `server_identity`, `publisher_identity` and the
 *      D-175 account binding. §7.11 says to name the parts; the CLI + bridge
 *      one-liners have no room to and say only "set the passphrase and run
 *      recover-keyfile", which reads cheaper than it is. This surface is a
 *      page, so it has the room. */
const UNSEALED_REMEDIATION =
  'Sealing is chosen once, at install. To change it now: set '
  + 'RECUED_IDENTITY_PASSPHRASE on the server, then run ‘recued recover-keyfile’ '
  + 'with your 24-word recovery key. That mints a new server identity — every '
  + 'paired device, this one included, has to pair again, your publisher '
  + 'identity changes, and the account binding is lost. Your data is untouched.';

/** Project a posture into the words a reader sees. */
export const describeKeyfilePosture = (
  input: KeyfilePostureInput,
): KeyfilePostureView => {
  if (input.kind === 'unreadable') {
    return {
      tone: 'unreadable',
      status: 'Couldn’t read',
      // Says what failed AND what it does not imply. An operator reading a
      // blank posture next to a green page would reasonably assume the good
      // case; this refuses to let the absence be read as an answer.
      // ⚠ `message` arrives already humanized by the panel (the webclient's
      // rpc-error copy never lets a method name, a timeout in ms, or an
      // error code reach a user), so it is a finished sentence — hence the
      // dash rather than a colon.
      detail:
        `Couldn’t read the keyfile posture — ${input.message} `
        + 'This is a failed read, not a report that the keyfile is sealed.',
      consequence: null,
      remediation: null,
    };
  }

  switch (input.sealing) {
    case 'machine':
      return {
        tone: 'sealed',
        status: 'Sealed by this machine',
        detail:
          'A platform secret store (OS keyring, Windows DPAPI or systemd-creds) '
          + 'holds the secret that unwraps this keyfile, and it lives outside the '
          + 'data directory — so a copy of that directory does not carry it.',
        consequence: null,
        remediation: null,
      };
    case 'passphrase':
      return {
        tone: 'sealed',
        status: 'Sealed by your passphrase',
        detail:
          'RECUED_IDENTITY_PASSPHRASE unwraps this keyfile at boot. The server '
          + 'reads it from its environment and never writes it to the data '
          + 'directory.',
        consequence: null,
        remediation: null,
      };
    case 'none':
      return {
        tone: 'unsealed',
        // ⛔ Never "—", never blank. §7.10 permits this posture BECAUSE it
        // stays visible; rendering it as absence removes the permission's
        // only condition.
        status: '⚠ UNSEALED',
        detail:
          'The key that opens this realm sits readable in the server’s own data '
          + 'directory, with nothing wrapping it.',
        consequence:
          'Your realm is still encrypted, but the key travels with the data '
          + 'directory: anyone who copies that whole directory gets everything '
          + 'in it. Only copies that omit the keyfile — for example, a '
          + 'database-only backup — retain this protection.',
        remediation: UNSEALED_REMEDIATION,
      };
    case null:
      return {
        tone: 'unreported',
        status: 'Not reported',
        detail:
          'This server reported no keyfile posture — it predates the field, or '
          + 'its key store isn’t wired. That is an unknown, not a sealed keyfile.',
        consequence: null,
        remediation: null,
      };
  }
};
