/** D-178 — the single pinned trusted release public key (minisign format).
 *
 *  Isolated in its own dependency-free module so BOTH the server (via
 *  `release-config.ts`) AND the frozen thin-image launcher (`launcher/bin.ts`)
 *  can embed the SAME constant without the launcher pulling the server graph —
 *  esbuild inlines it into each bundle at build time.
 *
 *  PINNED 2026-07-31 — key id `e297ddfab6e5a170`. Before this it was empty,
 *  which made every verifier short-circuit closed (the server resolved
 *  `update.check` to `not-configured`). With a key pinned, the check is live:
 *  a release this key cannot verify is REJECTED, not merely unreported.
 *
 *  ⛔ NEVER accept this from runtime config — a runtime-supplied trust root is
 *  no trust root at all (I-2). The build-time pin is the only input, and it is
 *  the bare minisign body (no `untrusted comment:` line) because
 *  `distribution/install/install.sh` passes the same string straight to
 *  `minisign -P`, which takes the body alone. The server's own `parsePublicKey`
 *  accepts either form, so the installer is the constraint.
 *
 *  ⚠ Rotating this is not a one-line edit: it must change here, in BOTH
 *  installers, and in the CI `RECUED_EXPECTED_PUBKEY` at the same time, or some
 *  consumer verifies against a key that no longer signs. */
export const TRUSTED_RELEASE_PUBKEY = 'RWTil936tuWhcHNYDf4Ras3oygZ3YYRo1VNcslibSfACY9e6piKLxf8v';
