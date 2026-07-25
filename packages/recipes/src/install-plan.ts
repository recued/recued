/** D-119 Phase 2 — bundle install planner.
 *
 *  Pure orchestrator that ties Phase 1 helpers (`deriveVaultScope`,
 *  `vaultScopeKey`, `verifyBundleSignature`, `detectVaultScopeCollision`)
 *  together with Phase 2's `parseBundle` so every install path
 *  (file-picker / URL-paste / marketplace) hits one decision point.
 *
 *  The planner does no I/O of its own. The caller injects:
 *    - `lookupExisting`  — install registry lookup keyed by vault scope.
 *    - `resolvePubkey`?  — Trusted Publishers lookup; omit to skip the
 *                          known/unknown/rotated split.
 *    - `contentHash`     — pre-computed canonical hash of the bundle
 *                          content. Caller picks the hash function
 *                          (SHA-256 of canonical JSON in production;
 *                          a stub in tests).
 *
 *  Every outcome carries enough structure for the install UI to render
 *  the next screen without additional work — verified-or-not badge,
 *  collision dialog, validation errors, ready-to-install plan.
 */

import type {
  BundleSignatureResult,
  ExecutionScope,
  FetchedRemoteBundle,
  InstallSource,
  NonRemoteInstallSource,
  PubkeyResolver,
  RecipeBundle,
  RemoteBundleInstallDescriptor,
  VaultScope,
  VaultScopeLookup,
} from '@recued/contracts';
import {
  deriveExecutionScope,
  deriveVaultScope,
  detectVaultScopeCollision,
  vaultScopeKey,
  verifyBundleSignature,
} from '@recued/contracts';
import { parseBundle } from './parse-bundle.js';
import type { ValidationIssue } from './validate.js';

// ────────────────────────────────────────────────────────────────
// Plan inputs / outputs
// ────────────────────────────────────────────────────────────────

interface PlanBundleInstallCommonInput {
  /** SHA-256 (or similar) of the canonical bundle content. The
   *  collision detector compares it against any previously-installed
   *  content under the same scope key. Same hash → idempotent
   *  reinstall, no prompt. */
  contentHash: string;
  /** Install registry lookup. Returns the previously-installed content
   *  hash or null if unused. */
  lookupExisting: VaultScopeLookup;
  /** Optional Trusted Publishers resolver. When omitted,
   *  cryptographically-valid signatures are reported as `verified`
   *  with no known/unknown/rotated distinction (suitable for the
   *  initial install before the trust set has any entries). */
  resolvePubkey?: PubkeyResolver;
  /** D-119 Phase 15 — current device's runtime role. When provided,
   *  the planner refuses installs whose derived execution scope
   *  excludes this role (`kind: 'incompatible'` outcome). Omit to
   *  skip the gate (e.g., dry-run, marketplace preview). The check
   *  only runs when the bundle carries `ingredients[]` — without
   *  resolved manifests there's nothing to derive against. */
  installRole?: ExecutionScope;
}

/** The install payload is discriminated by source kind.
 *
 *  File, marketplace, and kitchen callers provide their raw `input` directly.
 *  A remote caller must instead provide the single `FetchedRemoteBundle`
 *  returned by `fetchBundleByUrl`; its payload and post-redirect URL cannot be
 *  supplied independently. This makes the final response URL load-bearing for
 *  vault scope rather than a caller convention. */
type PlanNonRemoteBundleInstallInput = PlanBundleInstallCommonInput & {
  input: unknown;
  source: NonRemoteInstallSource;
  fetched?: never;
};

type PlanRemoteBundleInstallInput = PlanBundleInstallCommonInput & {
  fetched: FetchedRemoteBundle;
  source: RemoteBundleInstallDescriptor;
  input?: never;
};

export type PlanBundleInstallInput =
  | PlanNonRemoteBundleInstallInput
  | PlanRemoteBundleInstallInput;

const isRemoteBundleInstallInput = (
  args: PlanBundleInstallInput,
): args is PlanRemoteBundleInstallInput => args.source.kind === 'bundle-remote';

/** Resolve the remote vault partition from evidence owned by this planner.
 *
 *  A valid accepted signature verifies the bundle regardless of transport.
 *  An unsigned bundle is host-verified only when its final fetch URL is HTTPS.
 *  Invalid, unknown, or rotated signatures remain explicitly unverified even
 *  when transported over HTTPS: a claimed signature must not silently degrade
 *  to transport-only trust. */
const remoteBundleIsVerified = (
  fetched: FetchedRemoteBundle,
  signatureStatus: BundleSignatureResult,
): boolean => signatureStatus.status === 'verified'
  || (
    signatureStatus.status === 'unverified-not-signed'
    && new URL(fetched.finalUrl).protocol === 'https:'
  );

export type PlanBundleInstallOutcome =
  | {
      kind: 'invalid';
      /** All issues from the bundle validator — error / warn / info. */
      issues: ValidationIssue[];
    }
  | {
      kind: 'collision';
      bundle: RecipeBundle;
      vaultScope: VaultScope;
      scopeKey: string;
      signatureStatus: BundleSignatureResult;
      /** Hash of the previously-installed content under this scope key. */
      existingHash: string;
    }
  | {
      kind: 'incompatible';
      /** D-119 Phase 15 — derived execution scope of the bundle's
       *  ingredients. The current device's role is not in this set,
       *  so the recipe cannot run here. Surfaced as
       *  `EXECUTION_SCOPE_INCOMPATIBLE` to the user. */
      bundle: RecipeBundle;
      vaultScope: VaultScope;
      scopeKey: string;
      signatureStatus: BundleSignatureResult;
      derivedScope: ExecutionScope[];
      installRole: ExecutionScope;
    }
  | {
      kind: 'ready';
      bundle: RecipeBundle;
      vaultScope: VaultScope;
      scopeKey: string;
      signatureStatus: BundleSignatureResult;
    };

// ────────────────────────────────────────────────────────────────
// planBundleInstall
// ────────────────────────────────────────────────────────────────

/** Decide what the install UI should do next, given a bundle payload
 *  and the install source. Pure orchestration — no I/O outside the
 *  injected callbacks. */
export const planBundleInstall = async (
  args: PlanBundleInstallInput,
): Promise<PlanBundleInstallOutcome> => {
  const remote = isRemoteBundleInstallInput(args);
  const input = remote ? args.fetched.bundle : args.input;

  const parsed = parseBundle(input);
  if (!parsed.ok) return { kind: 'invalid', issues: parsed.issues };
  const bundle = parsed.recipe;

  const signatureStatus = await verifyBundleSignature(bundle, {
    resolvePubkey: args.resolvePubkey,
  });

  const installSource: InstallSource = remote
    ? {
        ...args.source,
        finalUrl: args.fetched.finalUrl,
        verified: remoteBundleIsVerified(args.fetched, signatureStatus),
      }
    : args.source;
  const vaultScope = deriveVaultScope(installSource);
  const scopeKey = vaultScopeKey(vaultScope);

  // D-119 Phase 15 — execution scope gate. Only fires when the
  // bundle carries `ingredients[]` (otherwise the install path has
  // no manifests to derive against; the device-side install handler
  // re-runs this gate post-resolution). Independent of collision
  // detection: incompatibility means "this recipe will never run
  // here," which the user needs to know before clicking Replace.
  if (
    args.installRole !== undefined
    && Array.isArray(bundle.ingredients)
    && bundle.ingredients.length > 0
  ) {
    const derivedScope = deriveExecutionScope(bundle.ingredients);
    if (!derivedScope.includes(args.installRole)) {
      return {
        kind: 'incompatible',
        bundle,
        vaultScope,
        scopeKey,
        signatureStatus,
        derivedScope,
        installRole: args.installRole,
      };
    }
  }

  const collision = await detectVaultScopeCollision(
    scopeKey,
    args.contentHash,
    args.lookupExisting,
  );
  if (collision.collides) {
    return {
      kind: 'collision',
      bundle,
      vaultScope,
      scopeKey,
      signatureStatus,
      existingHash: collision.existingHash ?? '',
    };
  }
  return { kind: 'ready', bundle, vaultScope, scopeKey, signatureStatus };
};
