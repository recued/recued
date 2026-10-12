/** D-320 ruling 19 — the lowest Recued a pack or a recipe runs on.
 *
 *  A pack declares it at its root (`min_recued_version`) and a recipe in its
 *  metadata (`metadata.min_recued_version`). A server older than the version
 *  named refuses to install or update the pack or recipe, and says to update
 *  Recued (`pack-host-capabilities.ts`, `recipe.installBySlug`). Name a release
 *  that has shipped: the field states which released server carries what the
 *  content needs.
 *
 *  ⚠ A SERVER ENFORCES ONLY WHAT IT SHIPPED WITH. 26.10.11 and every server
 *  before it accept the field and ignore it (measured on 26.10.9's own
 *  validators, 2026-10-11), so it gates installs only on servers from the
 *  release that added it. What reaches an older one is the release feed's
 *  `min_supported`, which words its update notice and blocks nothing.
 *
 *  The grammar is the release feed's (`RELEASE_VERSION_RE`, `@recued/release`),
 *  held equal to it by a test, so a floor compares the way the update checker
 *  compares the server's own version (`compareVersions`). */
export const RECUED_VERSION_RE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:\.[1-9]\d{0,8})?$/;

/** Is this a Recued release version (`yy.m.d`, or a hotfix `yy.m.d.n`)? */
export const isRecuedVersion = (v: unknown): v is string =>
  typeof v === 'string' && RECUED_VERSION_RE.test(v);
