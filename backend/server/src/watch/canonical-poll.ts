/** Poll-manager / G6 — the canonical poll fetch (the CRM caller of the
 *  `source-mirror` fetch core since D-192 P1.5).
 *
 *  One watch tick = ONE gated + audited connection-agnostic
 *  `<entity>.search` (full canonical projection, walk-all pagination)
 *  against the watch key's connection, projected to canonical records
 *  keyed by canonical `id`. Runs the SAME pipeline the R1 install
 *  resolver lowers into recipes — `vendorEntityResponseRows` →
 *  `deriveVendorSearchArgs` (match-all) → catalog gateway →
 *  `buildProjectionTemplate` applied via the `map` transform — so poll
 *  records are byte-identical to what a resolved recipe's projection
 *  step would see (one semantics source).
 *
 *  This module is the CRM-SPECIFIC resolution stage (Codex H4 — the
 *  residue that never generalizes): the `${entity}.search` op-key
 *  convention, the vendor-registry projection derivation, and the
 *  search-arg dialect. The neutral half — gateway invocation with a
 *  scoped ctx + audit capture, envelope extraction, projection
 *  evaluation, id-keying, truncated/complete — lives in
 *  `../source-mirror/fetch.js` (`runSourceMirrorFetch`), shared with
 *  future declared-Source sync runners (D-192 P3). */

import type {
  ConnectionVendorEntity,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import { CONNECTION_VENDOR_ENTITIES, entityFieldsFromRegistry } from '@recued/contracts';
import {
  buildProjectionTemplate,
  deriveVendorSearchArgs,
  vendorEntityResponseRows,
} from '@recued/recipes';
import type { IngredientManifest } from '@recued/contracts';
import {
  runSourceMirrorFetch,
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
} from '../source-mirror/fetch.js';

export interface CanonicalPollDeps extends SourceMirrorFetchDeps {
  /** Vendor → projection registry. Defaults to the kernel
   *  `CONNECTION_VENDOR_ENTITIES`; the seam exists for D-170
   *  third-party per-install registries (slice 4.5) to plug into. */
  resolveVendorRegistry?: (vendor: string) => ReadonlyArray<ConnectionVendorEntity>;
}

export type CanonicalPollOutcome = SourceMirrorFetchOutcome;

/** Minimal, fully-typed recipe identity for the scoped gateway ctx —
 *  audit rows attribute poll calls to `watch-poll`. Never installed,
 *  never executed as a recipe. */
const WATCH_POLL_RECIPE: RecipeDefinition = {
  recipe_id: 'watch-poll',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Watch poll',
    description:
      'Synthetic identity for poll-manager gateway calls (G6). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

/** Run one canonical watch poll for `(vendor, entity, connection)`.
 *
 *  `origin` (D-192 CRM escalation parity) — the dispatching caller's
 *  source + honest trigger origin + correlation id when the poll is
 *  CALLER-TRIGGERED (the chat/mcp S3 live escalation), threaded
 *  verbatim onto the gated invoke so the audit carries the real
 *  `(channel × actor × contract_id)` and the catalog gateway's
 *  per-actor `contract.override` tightening applies. Absent (the
 *  reconciler / watch-manager cycles) → the background `system` /
 *  `reactive` posture stands byte-identical. */
export const runCanonicalWatchPoll = async (
  deps: CanonicalPollDeps,
  input: {
    vendor: string;
    entity: string;
    connection_name: string;
    origin?: {
      execution_source?: ExecutionSource;
      trigger_source: string;
      correlation_id?: string;
    };
  },
): Promise<CanonicalPollOutcome> => {
  const { vendor, entity, connection_name, origin } = input;

  const profile = deps.profiles.get(connection_name);
  if (profile === null) {
    return {
      ok: false,
      kind: 'config',
      reason: `connection '${connection_name}' has no operation profile (not enrolled?)`,
    };
  }
  const catalogSlug = profile.catalog_slug;
  if (catalogSlug === undefined || catalogSlug.length === 0) {
    return {
      ok: false,
      kind: 'config',
      reason: `connection '${connection_name}' carries no catalog binding — cannot resolve a search surface`,
    };
  }
  const manifest: IngredientManifest | null =
    deps.executorConfig.manifests.get(catalogSlug) ?? null;
  if (manifest === null) {
    return {
      ok: false,
      kind: 'config',
      reason: `catalog manifest '${catalogSlug}' is not installed`,
    };
  }
  const operationKey = `${entity}.search`;
  const opRow = manifest.operations?.[operationKey];
  if (opRow === undefined) {
    return {
      ok: false,
      kind: 'config',
      reason: `catalog '${catalogSlug}' declares no '${operationKey}' operation — entity not watchable on this connection`,
    };
  }

  const registry = deps.resolveVendorRegistry?.(vendor) ?? CONNECTION_VENDOR_ENTITIES;
  const rows = vendorEntityResponseRows(entityFieldsFromRegistry(vendor, registry), entity);
  if (rows.length === 0) {
    return {
      ok: false,
      kind: 'config',
      reason: `no projectable canonical fields registered for '${vendor}.${entity}' — cannot snapshot`,
    };
  }

  const searchStyle = manifest.surfaces?.api?.search_style;
  const derived = deriveVendorSearchArgs(searchStyle, entity, rows, {});
  if (!derived.ok) {
    return { ok: false, kind: 'config', reason: derived.reason };
  }

  const resultPath = opRow.result_path ?? manifest.surfaces?.api?.result_path;
  if (resultPath === undefined || resultPath.length === 0) {
    return {
      ok: false,
      kind: 'config',
      reason: `catalog '${catalogSlug}' declares no result_path for '${operationKey}' — cannot locate the record envelope`,
    };
  }

  return runSourceMirrorFetch(deps, {
    connection_name,
    manifest,
    catalogSlug,
    operationKey,
    args: derived.args,
    resultPath,
    projectionTemplate: buildProjectionTemplate(rows),
    auditRecipe: WATCH_POLL_RECIPE,
    stepId: 'watch_poll',
    ...(origin?.execution_source !== undefined
      ? { execution_source: origin.execution_source }
      : {}),
    ...(origin !== undefined ? { trigger_source: origin.trigger_source } : {}),
    ...(origin?.correlation_id !== undefined
      ? { correlation_id: origin.correlation_id }
      : {}),
  });
};
