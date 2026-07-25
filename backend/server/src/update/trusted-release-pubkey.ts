/** D-178 — the single pinned trusted release public key (minisign format).
 *
 *  Isolated in its own dependency-free module so BOTH the server (via
 *  `release-config.ts`) AND the frozen thin-image launcher (`launcher/bin.ts`)
 *  can embed the SAME constant without the launcher pulling the server graph —
 *  esbuild inlines it into each bundle at build time.
 *
 *  EMPTY until the signing identity is generated + custody is set up (D-178
 *  rev 4 / pre-GA): an empty key makes every verifier fail/short-circuit closed
 *  (the server resolves `update.check` to `not-configured`; the launcher's
 *  re-verify is bypassed pre-GA — see `verifyBinarySignature`). Override only via
 *  the build-time pin once the key exists — NEVER accept it from runtime config
 *  (that would defeat I-2). */
export const TRUSTED_RELEASE_PUBKEY = '';
