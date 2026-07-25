/** D-119 — Recipe-bundle shared types + decentralized-install helpers.
 *
 *  A `RecipeBundle` is the portable JSON payload produced by a
 *  marketplace export, the kitchen "Save as bundle" path, or a third
 *  party hosting a recipe at a URL of their choice. The same shape
 *  flows through every install entry point (marketplace / file /
 *  URL / kitchen).
 *
 *  Phase 1 ships the type, the deterministic vault-scope keying
 *  helpers, the URL normalizer, the ed25519 signature verifier, and
 *  the collision detector. Phase 2 wires these into the install UI;
 *  no UI surface is touched here.
 *
 *  Design pillars (see D-119):
 *    - **Decentralized**. Anyone can host a bundle on any URL or
 *      share it as a file. Vault scope keys are derived from
 *      observable install inputs (URL host+path, file marker,
 *      marketplace publisher, kitchen origin) so collisions are
 *      detectable without a central registry.
 *    - **Trust through visibility, not modals**. Signatures decorate
 *      a badge and select the verified/unverified vault partition;
 *      verification status is never an install gate.
 *    - **No new sync transports / no new RPC primitives**. Phase 1
 *      is type-level scaffolding plus pure helpers — no IO except
 *      the Web Crypto verify call inside `verifyBundleSignature`.
 */

import type { RecipeDefinition } from './recipe.js';
import type { IngredientManifest } from './ingredient.js';

// ────────────────────────────────────────────────────────────────
// Bundle shape
// ────────────────────────────────────────────────────────────────

/** Optional ed25519 signature on a recipe bundle. The signature is
 *  computed over the canonical JSON bytes of the bundle with the
 *  `signature` field stripped. Verified via Web Crypto's
 *  `subtle.verify({ name: 'Ed25519' }, …)` — Node 20+ + modern
 *  browsers, no new dependencies. */
export interface BundleSignature {
  algorithm: 'ed25519';
  /** Base64-encoded raw 32-byte ed25519 public key. */
  publisher_pubkey: string;
  /** Base64-encoded 64-byte ed25519 signature over canonical bundle bytes
   *  (everything except this field). */
  signature: string;
}

/** Portable recipe-bundle payload. Travels as a single JSON object;
 *  the receiver's installer derives a deterministic vault-scope key
 *  from the install source (file marker / remote URL / marketplace
 *  publisher / kitchen origin) — see `deriveVaultScope`. */
export interface RecipeBundle {
  /** Schema version — `1` for every bundle the engine has ever
   *  emitted. Optional so future install-flow bundles may omit it
   *  while remaining valid; the install path treats absence and `1`
   *  identically. */
  bundle_version?: 1;
  recipe: RecipeDefinition;
  /** Self-contained ingredient manifests carried inside the bundle.
   *  Optional — a marketplace bundle may rely on the marketplace
   *  registry to resolve ingredients separately, while a file/URL
   *  bundle typically carries every non-community-shipped dependency
   *  it needs. The validator at install time runs the same per-
   *  manifest checks regardless of where the manifest came from. */
  ingredients?: IngredientManifest[];
  /** Optional ed25519 signature. When present, verification produces
   *  a verification badge (`signature-verified` /
   *  `signature-mismatch` split into `crypto-invalid` /
   *  `pubkey-rotated` / `unknown-pubkey`); when absent the badge is
   *  `unsigned-host`. Signatures decorate trust UX and select the
   *  verified/unverified remote vault partition; they never block an
   *  install. */
  signature?: BundleSignature;
}

/** Type-guard: does this object look like a `RecipeBundle`? Cheap
 *  shape check — does not validate the recipe or ingredient
 *  contents. The full validator runs at install time on a known-
 *  bundle payload. */
export const isRecipeBundle = (obj: unknown): obj is RecipeBundle =>
  obj != null
  && typeof obj === 'object'
  && Object.prototype.hasOwnProperty.call(obj, 'recipe')
  && (obj as { recipe: unknown }).recipe != null
  && typeof (obj as { recipe: unknown }).recipe === 'object';

// ────────────────────────────────────────────────────────────────
// Vault scope — discriminated union of every install-source shape
// ────────────────────────────────────────────────────────────────

/** Discriminated union covering every vault-scope shape the install
 *  paths produce. The string form returned by `vaultScopeKey` is what
 *  persists; the `VaultScope` object is the typed intermediate that
 *  carries enough structure for the install UI to render badges /
 *  collision prompts / blast-radius views. */
export type VaultScope =
  | { kind: 'marketplace'; publisher: string; slug: string }
  | { kind: 'bundle-file'; slug: string }
  | { kind: 'bundle-remote'; host: string; path: string; slug: string; verified: boolean }
  | { kind: 'kitchen'; slug: string };

/** Opaque proof that a remote-bundle URL came from the fetch response after
 *  redirect processing, rather than from the URL the user originally pasted.
 *
 *  Only the remote bundle fetch boundary should mint this type. It keeps a
 *  plain request URL from being accidentally reused as vault authority while
 *  remaining a string at runtime. */
declare const REDIRECT_RESOLVED_BUNDLE_URL: unique symbol;
export type RedirectResolvedBundleUrl = string & {
  readonly [REDIRECT_RESOLVED_BUNDLE_URL]: true;
};

/** The payload and authoritative post-redirect URL returned by a remote bundle
 *  fetch. Keeping them in one object lets the install planner bind the bytes it
 *  validates to the origin it uses for vault scope. */
export interface FetchedRemoteBundle {
  readonly bundle: RecipeBundle;
  readonly finalUrl: RedirectResolvedBundleUrl;
}

/** Install sources that do not involve a remote redirect chain. */
export type NonRemoteInstallSource =
  | { kind: 'marketplace'; publisher: string; slug: string }
  | { kind: 'bundle-file'; slug: string }
  | { kind: 'kitchen'; slug: string };

/** Metadata supplied by the caller for a fetched remote bundle. The final URL
 *  and verification state are deliberately absent: they must be resolved from
 *  `FetchedRemoteBundle` and the bundle signature by the install planner. */
export interface RemoteBundleInstallDescriptor {
  readonly kind: 'bundle-remote';
  readonly slug: string;
}

/** Remote install source accepted by `deriveVaultScope`. `finalUrl` is branded
 *  proof from the fetch response, never the user-pasted request URL;
 *  `verified` is the install planner's result, never caller-supplied metadata. */
export type RemoteBundleInstallSource = RemoteBundleInstallDescriptor & {
  readonly finalUrl: RedirectResolvedBundleUrl;
  readonly verified: boolean;
};

/** Discriminated union covering every install entry point that yields a
 *  `VaultScope`. */
export type InstallSource = NonRemoteInstallSource | RemoteBundleInstallSource;

/** Convert an `InstallSource` to its `VaultScope`. Identity for the
 *  marketplace / bundle-file / kitchen kinds; for `bundle-remote` it
 *  normalizes the URL down to `{ host, path }`. */
export function deriveVaultScope(install: InstallSource): VaultScope {
  switch (install.kind) {
    case 'marketplace':
      return { kind: 'marketplace', publisher: install.publisher, slug: install.slug };
    case 'bundle-file':
      return { kind: 'bundle-file', slug: install.slug };
    case 'bundle-remote': {
      const { host, path } = normalizeUrlForVaultScope(install.finalUrl);
      return { kind: 'bundle-remote', host, path, slug: install.slug, verified: install.verified };
    }
    case 'kitchen':
      return { kind: 'kitchen', slug: install.slug };
  }
}

/** Compute the canonical persistence key for a vault scope.
 *
 *    marketplace      →  `marketplace:<publisher>/<slug>`
 *    bundle-file      →  `bundle:/<slug>`
 *    bundle-remote    →  `bundle:<host><path>[-unverified]/<slug>`
 *    kitchen          →  `local:<slug>`
 *
 *  The `-unverified` suffix on the host+path segment of unverified
 *  remote bundles is what lets a publisher rotate from "claimed
 *  signed" → "actually verified" without colliding with the broken
 *  install: the unverified install lives under one key, the verified
 *  one under a different key, and the user's collision prompt makes
 *  the switch explicit. */
export function vaultScopeKey(s: VaultScope): string {
  switch (s.kind) {
    case 'marketplace':
      return `marketplace:${s.publisher}/${s.slug}`;
    case 'bundle-file':
      return `bundle:/${s.slug}`;
    case 'bundle-remote':
      return `bundle:${s.host}${s.path}${s.verified ? '' : '-unverified'}/${s.slug}`;
    case 'kitchen':
      return `local:${s.slug}`;
  }
}

// ────────────────────────────────────────────────────────────────
// URL normalization for vault scope
// ────────────────────────────────────────────────────────────────

/** Normalize a remote-bundle URL to the `{ host, path }` pair used
 *  to derive its vault scope. The caller must supply the post-redirect
 *  `Response.url`; redirect following is asynchronous network work owned by
 *  `fetchBundleByUrl`, not this pure normalizer. Lowercases the final URL and
 *  collapses every non-`[a-z0-9._-]` byte in the path/query/hash to `/` so the
 *  resulting key is short, filesystem-safe, and stable across cosmetic URL
 *  variations. The trailing `/` on the raw concatenated path is stripped
 *  before collapse. */
export function normalizeUrlForVaultScope(
  finalUrl: RedirectResolvedBundleUrl,
): { host: string; path: string } {
  const url = new URL(finalUrl.toLowerCase());
  const host = url.host;
  const rawPath = (url.pathname + url.search + url.hash).replace(/\/$/, '');
  const path = rawPath.replace(/[^a-z0-9._-]+/g, '/');
  return { host, path };
}

// ────────────────────────────────────────────────────────────────
// Signature verification
// ────────────────────────────────────────────────────────────────

/** Outcome of a `verifyBundleSignature` call. The five values map
 *  one-to-one onto the install-time verification badges:
 *
 *    `unverified-not-signed` — bundle has no `signature` block. UI
 *      renders the `unsigned-host` (or `host-verified` if HTTPS)
 *      badge.
 *    `verified`              — signature passes Web Crypto verify
 *      AND the publisher pubkey is in the user's trusted set.
 *      UI: `signature-verified` badge.
 *    `crypto-invalid`        — signature does not cryptographically
 *      verify. UI: `signature-mismatch (crypto-invalid)` badge.
 *    `unknown-pubkey`        — signature verifies but the publisher
 *      pubkey is not in the user's trusted set. UI:
 *      `signature-mismatch (unknown-publisher)` badge.
 *    `pubkey-rotated`        — signature verifies but the user has
 *      previously seen a different pubkey for this publisher. UI:
 *      `signature-mismatch (publisher-key-rotated)` badge. */
export type BundleSignatureStatus =
  | 'unverified-not-signed'
  | 'verified'
  | 'crypto-invalid'
  | 'unknown-pubkey'
  | 'pubkey-rotated';

/** Result of resolving a publisher pubkey against the user's trusted
 *  set. `known` ⇒ the user has installed something signed with this
 *  exact pubkey before. `rotated` ⇒ a different pubkey was previously
 *  seen for this publisher (handle / domain). `unknown` ⇒ first
 *  contact. */
export type PubkeyTrustState = 'known' | 'unknown' | 'rotated';

/** Async resolver consulted by `verifyBundleSignature` after the
 *  cryptographic verify passes. The install flow injects a resolver
 *  backed by the Trusted Publishers store; tests use stubs. */
export type PubkeyResolver = (publisher_pubkey: string) => Promise<PubkeyTrustState>;

/** Detailed return value carried alongside `BundleSignatureStatus`.
 *  Includes the publisher pubkey for downstream UI consumers (badge
 *  rendering, blast-radius view in Trusted Publishers). */
export interface BundleSignatureResult {
  status: BundleSignatureStatus;
  publisher_pubkey?: string;
}

/** Canonical JSON serialization for signature input. Sorts object
 *  keys recursively so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce
 *  the same bytes, and strips the `signature` field at every depth.
 *
 *  Phase 1 keeps this intentionally simple — the canonical bundle is
 *  the top-level `{ recipe, ingredients?, bundle_version? }` minus
 *  `signature`. We do not yet track a separate "canonical-JSON"
 *  spec; whoever signs and whoever verifies must agree on this
 *  function. */
export function canonicalBundleBytes(bundle: RecipeBundle): Uint8Array {
  const stripped = stripSignature(bundle);
  const json = stableStringify(stripped);
  return new TextEncoder().encode(json);
}

function stripSignature(bundle: RecipeBundle): Omit<RecipeBundle, 'signature'> {
  const { signature: _signature, ...rest } = bundle;
  return rest;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]));
  return '{' + entries.join(',') + '}';
}

/** Decode a base64 string to bytes. Local helper to keep `@recued/contracts`
 *  free of any cross-package import. Throws on malformed input. */
function base64Decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Verify a bundle's optional ed25519 signature.
 *
 *  Returns one of five statuses. The cryptographic verify uses
 *  `crypto.subtle.verify({ name: 'Ed25519' }, …)` — supported on
 *  Node 20+ and modern browsers. The trusted-set lookup is delegated
 *  to the optional `resolvePubkey` callback; when omitted, a
 *  cryptographically valid signature is reported as `verified` with
 *  no rotation/unknown distinction (suitable for tests that don't
 *  exercise the trusted-set path). */
export async function verifyBundleSignature(
  bundle: RecipeBundle,
  options: { resolvePubkey?: PubkeyResolver } = {},
): Promise<BundleSignatureResult> {
  if (!bundle.signature) return { status: 'unverified-not-signed' };

  const { algorithm, publisher_pubkey, signature } = bundle.signature;
  if (algorithm !== 'ed25519') return { status: 'crypto-invalid', publisher_pubkey };

  let pubkeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubkeyBytes = base64Decode(publisher_pubkey);
    sigBytes = base64Decode(signature);
  } catch {
    return { status: 'crypto-invalid', publisher_pubkey };
  }
  if (pubkeyBytes.length !== 32 || sigBytes.length !== 64) {
    return { status: 'crypto-invalid', publisher_pubkey };
  }

  const data = canonicalBundleBytes(bundle);

  let valid = false;
  try {
    // Cast through unknown — the contracts package is lib:["ES2022"] only,
    // so DOM types `AlgorithmIdentifier` and `BufferSource` aren't visible
    // even though Node 20+ + modern browsers all accept the inputs at
    // runtime. The casts narrow back to the subtle.* call signatures.
    const algorithm = { name: 'Ed25519' } as unknown as Parameters<typeof crypto.subtle.verify>[0];
    const key = await crypto.subtle.importKey(
      'raw',
      pubkeyBytes as unknown as Parameters<typeof crypto.subtle.importKey>[1],
      algorithm as unknown as Parameters<typeof crypto.subtle.importKey>[2],
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      algorithm,
      key,
      sigBytes as unknown as Parameters<typeof crypto.subtle.verify>[2],
      data as unknown as Parameters<typeof crypto.subtle.verify>[3],
    );
  } catch {
    return { status: 'crypto-invalid', publisher_pubkey };
  }
  if (!valid) return { status: 'crypto-invalid', publisher_pubkey };

  if (!options.resolvePubkey) return { status: 'verified', publisher_pubkey };

  const trust = await options.resolvePubkey(publisher_pubkey);
  switch (trust) {
    case 'known':   return { status: 'verified',       publisher_pubkey };
    case 'unknown': return { status: 'unknown-pubkey', publisher_pubkey };
    case 'rotated': return { status: 'pubkey-rotated', publisher_pubkey };
  }
}

// ────────────────────────────────────────────────────────────────
// Vault-scope collision detection
// ────────────────────────────────────────────────────────────────

/** Async lookup the install flow injects to ask whether a vault
 *  scope key already exists locally, and if so what its content
 *  hash was. Returns null when the key is unused. The install flow
 *  backs this with the install registry; tests use a Map. */
export type VaultScopeLookup = (key: string) => Promise<string | null>;

/** Outcome of a collision check. `collides: false` means the install
 *  can proceed without a prompt. `collides: true` means the install
 *  UI must surface a replace-or-cancel dialog with `existingHash` so
 *  the user can compare. */
export interface VaultScopeCollision {
  collides: boolean;
  /** Content hash of the previously installed item under this vault
   *  scope key. Present whenever `collides === true`. */
  existingHash?: string;
}

/** Detect whether a vault scope key already holds a different
 *  content. Same scope key + same hash = idempotent reinstall (no
 *  collision). Same scope key + different hash = a real conflict
 *  the user has to resolve. */
export async function detectVaultScopeCollision(
  scopeKey: string,
  newContentHash: string,
  lookupExisting: VaultScopeLookup,
): Promise<VaultScopeCollision> {
  const existingHash = await lookupExisting(scopeKey);
  if (existingHash === null) return { collides: false };
  if (existingHash === newContentHash) return { collides: false };
  return { collides: true, existingHash };
}
