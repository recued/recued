/** D-178 S3 — release signing-key custody gate (pure helpers).
 *
 *  The runtime carries ONE pinned trusted pubkey (`TRUSTED_RELEASE_PUBKEY`,
 *  embedded at build time). These helpers turn "is a key pinned, and is it the
 *  right one" into testable predicates the server boot + the release signer
 *  share:
 *
 *    - `releaseKeyStatus(pubkey)` — pinned? well-formed? An EMPTY pin is the
 *      honest pre-GA state (verifiers short-circuit closed); a NON-empty but
 *      MALFORMED pin is a deploy mistake that must fail loudly, never silently
 *      mis-verify.
 *    - `assertReleaseKeyValid(pubkey)` — boot guard: throw on a non-empty
 *      malformed pin (an empty pin is allowed pre-GA — the caller decides
 *      whether empty is acceptable via `releaseKeyStatus().pinned`).
 *    - `signingKeyMatchesPin(seed, keyId, pubkey)` — the strong invariant: the
 *      pubkey DERIVED from the signer's secret must equal the pinned pubkey, so
 *      a GA build can refuse to publish artifacts signed with the wrong key.
 *
 *  Pure + dependency-free (reuses minisign parse/derive); the GA "must be set"
 *  gate is enforced by the signer (`release-build.mjs`) + an optional boot
 *  assertion in the server. */

import { parsePublicKey, publicKeyFromSeed } from './minisign.js';

export interface ReleaseKeyStatus {
  /** A non-empty pubkey is pinned (GA posture; pre-GA is empty). */
  pinned: boolean;
  /** The pinned key parses as a minisign Ed25519 public key. Vacuously false
   *  when not pinned. */
  valid: boolean;
}

/** Classify the pinned trusted pubkey. */
export const releaseKeyStatus = (pubkey: string): ReleaseKeyStatus => {
  if (!pubkey) return { pinned: false, valid: false };
  return { pinned: true, valid: parsePublicKey(pubkey) !== null };
};

export class ReleaseKeyError extends Error {}

/** Boot guard: a NON-EMPTY pin must be a well-formed minisign pubkey. An empty
 *  pin passes (pre-GA — the verifiers fail closed on their own); callers that
 *  require GA posture check `releaseKeyStatus().pinned` separately. */
export const assertReleaseKeyValid = (pubkey: string): void => {
  const s = releaseKeyStatus(pubkey);
  if (s.pinned && !s.valid) {
    throw new ReleaseKeyError(
      'TRUSTED_RELEASE_PUBKEY is set but not a valid minisign public key — ' +
        'a malformed pin would silently weaken verification; refusing to boot.',
    );
  }
};

/** The strong GA invariant: the pubkey derived from the signer's secret seed
 *  equals the pinned pubkey (comparing the base64 key body, ignoring the
 *  untrusted-comment line + key id formatting). Returns false on any parse
 *  failure. Used by the signer to refuse publishing artifacts signed with a
 *  key that does not match what consumers will verify against. */
export const signingKeyMatchesPin = (
  secretSeed: Uint8Array,
  keyId: Uint8Array,
  pinnedPubkey: string,
): boolean => {
  const pinned = parsePublicKey(pinnedPubkey);
  if (!pinned) return false;
  const derived = parsePublicKey(publicKeyFromSeed(secretSeed, keyId));
  if (!derived) return false;
  return (
    Buffer.from(derived.key).equals(Buffer.from(pinned.key)) &&
    Buffer.from(derived.keyId).equals(Buffer.from(pinned.keyId))
  );
};

/** Filename `release-build` drops into the output dir when it signed with an
 *  EPHEMERAL in-process key, and `release-publish` refuses to upload alongside.
 *
 *  A build with no `RECUED_SIGN_SEED` produces output that is otherwise
 *  INDISTINGUISHABLE from a real release — same files, same shapes, valid
 *  signatures under a throwaway key — and warns only on the console. Publishing
 *  it overwrites the live `manifest.json` with one every consumer rejects,
 *  taking the update channel down until a correctly signed manifest replaces
 *  it. The console warning cannot prevent that: the publish happens later, in
 *  another shell, possibly by another person. This marker carries the warning
 *  ON DISK, to the step that does the irreversible thing.
 *
 *  Shared here (not duplicated in each script) so the writer and the refuser
 *  cannot drift apart — a copied filename would rot silently, and the failure
 *  mode of a drifted name is a publish that no longer refuses. */
export const EPHEMERAL_KEY_MARKER = 'DO-NOT-PUBLISH-EPHEMERAL-KEY.txt';
