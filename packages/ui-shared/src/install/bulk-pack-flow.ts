/** D-122 Phase 4 — bulk-pack install orchestrator (shared).
 *
 *  Single entry point shared surfaces invoke. Composes the
 *  marketplace resolver, the cost estimator, the dialog render, and
 *  the engine's atomic install transaction.
 *
 *  The orchestrator is injection-shaped — every IO + adapter is
 *  passed in (`fetchPack`, `resolvePack`, `estimateCost`,
 *  `presentDialog`, `installPack`). This keeps the shared module
 *  testable; the webclient install flow provides the thin adapter
 *  module that wires fetch / WebRpcAdapter.
 *
 *  Spec: `docs/d-122-spec.md` §"Atomic install".
 */

import {
  type BulkPackManifest,
} from '@recued/contracts';
import type {
  BulkPackInstallResult,
  BulkPackInstallInput,
} from '@recued/marketplace';

/** Per-recipe cost row the orchestrator hands the dialog. */
export interface PackRecipeCost {
  slug: string;
  daily_fires: number;
  daily_tokens: number;
}

/** Cost estimate the orchestrator computes once + passes to the
 *  dialog. The orchestrator doesn't re-import `@recued/marketplace`
 *  to keep the package dep direction one-way (apps → ui-shared →
 *  contracts/engine). Flat shape — no per-tier breakdown post the
 *  runs_on rip. */
export interface PackCostEstimate {
  per_recipe: PackRecipeCost[];
  total_daily_fires: number;
  total_daily_tokens: number;
  free_pool_consumption_pct: number | null;
  byok_dollars_per_day: number | null;
}

/** Pack resolution shape — same fields the engine's `BulkPackInstallInput`
 *  takes. The orchestrator forwards this verbatim into `installPack`. */
export interface PackResolution {
  manifest: BulkPackManifest;
  ready: boolean;
  recipes: BulkPackInstallInput['recipes'];
}

/** Outcome returned by `presentDialog`. Indicates which button the
 *  user clicked. The pre-rip dialog had a "skip backfill" secondary
 *  button + a BYOK acceleration toggle; both retired with the
 *  scheduler. */
export type DialogOutcome =
  | { kind: 'install' }
  | { kind: 'cancel' };

/** Adapter set the orchestrator uses. Tests pass in-memory stubs;
 *  apps wire chrome.runtime / fetch / SwConn / WebRpc. */
export interface BulkPackFlowAdapters {
  /** Fetch the manifest by slug. Returns null on 404; throws on
   *  network / validation errors so the host can surface them. */
  fetchPack: (slug: string) => Promise<BulkPackManifest | null>;
  /** Expand the manifest into resolved recipes. */
  resolvePack: (manifest: BulkPackManifest) => Promise<PackResolution>;
  /** Snapshot per-collection × per-tier record counts from the
   *  warehouse + the user's daily free-pool budget so the cost
   *  estimator has data. The orchestrator doesn't compute the
   *  estimate itself — it delegates to `estimateCost` which is
   *  injected so tests can pass a deterministic stub. */
  estimateCost: (resolution: PackResolution) => Promise<PackCostEstimate>;
  /** Show the dialog. The host renders the bulk-pack-dialog HTML and
   *  resolves the promise when the user clicks install / cancel. */
  presentDialog: (resolution: PackResolution, estimate: PackCostEstimate) => Promise<DialogOutcome>;
  /** Run the atomic install transaction. Same shape as the engine's
   *  `installBulkPack`; the host wires the registry. */
  installPack: (
    input: BulkPackInstallInput,
  ) => Promise<BulkPackInstallResult>;
  /** Audit emission hook — the host emits one row per pack-install
   *  outcome (`pack_installed` / `pack_install_failed`). Optional;
   *  tests omit it. */
  emitAudit?: (event: PackAuditEvent) => void | Promise<void>;
}

/** Audit event shapes the orchestrator emits at the seams. The host
 *  forwards them to the audit log. */
export type PackAuditEvent =
  | {
      kind: 'pack_install_started';
      pack_slug: string;
      publisher: string;
      manifest_version: number;
    }
  | {
      kind: 'pack_install_completed';
      pack_slug: string;
      publisher: string;
      installed_recipe_count: number;
    }
  | {
      kind: 'pack_install_failed';
      pack_slug: string;
      publisher: string;
      reason: string;
      failed_at_slug?: string;
    }
  | {
      kind: 'pack_install_cancelled';
      pack_slug: string;
      publisher: string;
    };

/** Final result the orchestrator returns. */
export type BulkPackFlowResult =
  | { kind: 'installed'; slug: string; result: BulkPackInstallResult }
  | { kind: 'cancelled'; slug: string }
  | { kind: 'failed'; slug: string; reason: string; result?: BulkPackInstallResult }
  | { kind: 'pack_not_found'; slug: string };

/** Run a bulk-pack install end-to-end. The function never throws on
 *  domain failures — every outcome surfaces as a typed `BulkPackFlowResult`
 *  the host renders into success / cancellation / error UI. Network
 *  / unexpected JS errors still bubble. */
export const runBulkPackInstall = async (
  slug: string,
  adapters: BulkPackFlowAdapters,
): Promise<BulkPackFlowResult> => {
  const manifest = await adapters.fetchPack(slug);
  if (manifest == null) {
    return { kind: 'pack_not_found', slug };
  }
  await adapters.emitAudit?.({
    kind: 'pack_install_started',
    pack_slug: slug,
    publisher: manifest.publisher,
    manifest_version: manifest.manifest_version,
  });

  const resolution = await adapters.resolvePack(manifest);
  const estimate = await adapters.estimateCost(resolution);
  const outcome = await adapters.presentDialog(resolution, estimate);
  if (outcome.kind === 'cancel') {
    await adapters.emitAudit?.({
      kind: 'pack_install_cancelled',
      pack_slug: slug,
      publisher: manifest.publisher,
    });
    return { kind: 'cancelled', slug };
  }

  const input: BulkPackInstallInput = {
    manifest_version: manifest.manifest_version,
    pack_slug: manifest.slug,
    publisher: manifest.publisher,
    requires: manifest.requires,
    recipes: resolution.recipes,
    ready: resolution.ready,
    ...(manifest.webhook_requirements !== undefined
      ? { webhook_requirements: [...manifest.webhook_requirements] }
      : {}),
    // D-139 P6.B (Codex /codex:review P2 #1 fold-back) — forward the
    // pack-level body-content MCP grants from the manifest. Without
    // this thread the engine's `installBulkPack` would never see
    // them and the `crm-commitment-tracker` install would silently
    // skip persisting `data.contact.engagements.body_content`. Closed
    // list per BULK_PACK_BODY_VISIBILITY_GRANT_KEYS; manifest-side
    // validator already rejects unknown / duplicate / over-cap entries.
    mcp_body_visibility_grants: manifest.mcp_body_visibility_grants,
  };
  const result = await adapters.installPack(input);

  if (!result.ok) {
    await adapters.emitAudit?.({
      kind: 'pack_install_failed',
      pack_slug: slug,
      publisher: manifest.publisher,
      reason: result.failure?.message ?? 'unknown',
      failed_at_slug: result.failure?.failed_at?.slug,
    });
    return {
      kind: 'failed',
      slug,
      reason: result.failure?.message ?? 'unknown failure',
      result,
    };
  }

  await adapters.emitAudit?.({
    kind: 'pack_install_completed',
    pack_slug: slug,
    publisher: manifest.publisher,
    installed_recipe_count: result.installed.length,
  });

  return { kind: 'installed', slug, result };
};
