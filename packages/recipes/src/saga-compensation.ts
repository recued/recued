/** R2 step 6 (write-saga) — compensation derivation.
 *
 *  When a multi-write canonical run tears (a later step fails AFTER a
 *  catalog write landed — "C created, A-delete failed", recipe-identity
 *  doc §1.3/§4), the gateway's saga-reconciliation leaf surfaces the
 *  torn state as a `notification.ask`. THIS module derives the
 *  `undo` option's substance: the inverse canonical operation for a
 *  landed write, as a fresh single-op-step recipe dispatched through
 *  the NORMAL door (dispatch-resolve → catalog gate → preflight
 *  approval) with `predecessor_commit_id` provenance.
 *
 *  Derivation is **registry/catalog-driven, never inferred** (the same
 *  rule §1.5 pins for degraded runs): an inverse exists only when the
 *  catalog itself declares it. v1 inverse table:
 *
 *    create → `<entity>.delete` with the created record's vendor id
 *             (from the landed commit's recorded output), IFF the SAME
 *             catalog declares the delete op + its REST binding.
 *    update → none (restoring prior values needs a prior-state
 *             snapshot substrate that does not exist — disclosed, not
 *             guessed).
 *    delete → none (irreversible by nature).
 *
 *  "Reversibility is honest — not 'everything is reversible'"
 *  (v3-converged-spec §5). A landed write with no derivable inverse is
 *  DISCLOSED by the saga ask; it never silently gains an undo.
 *
 *  The derived recipe is canonical (a `CanonicalOpStep` on the
 *  crm_alias vocabulary) so the compensating dispatch reuses the R2
 *  machinery end-to-end: `resolveCanonicalRecipeForDispatch` binds the
 *  slot to the landed write's connection, the catalog gate holds the
 *  destructive delete at preflight (`approval: 'always'`), and ONLY
 *  the user's approval lets it cross the boundary. Compensation is
 *  never auto-dispatched and never bypasses the gate — the saga ask
 *  routes, the preflight ask ENFORCES (two asks by design).
 */

import {
  CATALOG_VENDOR_SLUGS,
  CONNECTION_VENDOR_ENTITIES,
} from '@recued/contracts';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Inputs / outputs
// ────────────────────────────────────────────────────────────────

/** One confirmed-landed catalog write inside a torn run, as classified
 *  by the gateway saga leaf (`detectTornSaga`). `operation_key` is the
 *  catalog manifest's `operations` MAP KEY — vendor-entity-keyed
 *  (`'deal.create'` on hubspot-catalog, `'opportunity.create'` on
 *  salesforce-catalog) — NOT the canonical crm_alias op. */
export interface LandedCatalogWrite {
  /** The landed commit — becomes the compensating run's
   *  `predecessor_commit_id`. */
  commit_id: string;
  /** Catalog `operations` key, e.g. `'opportunity.create'`. */
  operation_key: string;
  /** Publisher-scoped operation id, e.g.
   *  `'recued-core/salesforce.opportunity.create'` — display only. */
  operation_id: string;
  /** The catalog ingredient slug the write dispatched through. */
  catalog_slug: string;
  /** The RESOLVED connection name the write targeted (the commit's
   *  wire-input `connection`). */
  connection_name: string;
  /** The commit's recorded `output` — the connection-api response
   *  envelope `{ status, headers, result }`; the created record's
   *  vendor id lives in `result`. */
  output: unknown;
}

/** A derived, dispatch-ready compensation: a fresh single-op canonical
 *  recipe + the config that binds its connection slot. JSON-serialisable
 *  by construction — the saga ask persists it as handler payload, so an
 *  answer after a restart dispatches exactly what was offered. */
export interface CompensationPlan {
  /** Single-`CanonicalOpStep` recipe (`<alias>.delete`, selector =
   *  the created id). Dispatched INLINE — never installed/persisted. */
  recipe: RecipeDefinition;
  /** Binds the recipe's one connection slot to the landed write's
   *  connection. */
  config: Record<string, unknown>;
  /** The landed commit this plan undoes. */
  predecessor_commit_id: string;
  /** Human line for the ask body, e.g.
   *  `"delete deal 31337 on 'hubspot1' (created by deal.create)"`. */
  description: string;
}

// ────────────────────────────────────────────────────────────────
// Internal lookups
// ────────────────────────────────────────────────────────────────

/** catalog slug → vendor slug (inverse of `CATALOG_VENDOR_SLUGS`).
 *  Computed per call over a 2-entry registry — not worth caching. */
const vendorForCatalogSlug = (catalog_slug: string): string | undefined => {
  for (const [vendor, slug] of Object.entries(CATALOG_VENDOR_SLUGS)) {
    if (slug === catalog_slug) return vendor;
  }
  return undefined;
};

/** The crm_alias for a (vendor, vendor-entity) pair, from the shipped
 *  registry. Undefined when the entity is not registered or carries no
 *  alias — derivation then fails closed (no inverse). */
const crmAliasFor = (vendor: string, entity: string): string | undefined => {
  for (const row of CONNECTION_VENDOR_ENTITIES) {
    if (row.vendor === vendor && row.entity === entity) {
      return (row as { crm_alias?: string }).crm_alias;
    }
  }
  return undefined;
};

/** The created record's vendor id, extracted from the landed commit's
 *  recorded output (`{ status, headers, result }`). Probes the two
 *  shipped create-response id keys — HubSpot returns the object with
 *  `id`, Salesforce returns `{ id, success, errors }` (lowercase, NB
 *  distinct from its read-shape `Id`) — then `Id` defensively. The
 *  value is about to be substituted into a vendor PATH TEMPLATE
 *  (`/objects/deals/{{deal_id}}`), so it is charset-fenced: leading
 *  alphanumeric, then `[A-Za-z0-9_-]` (HubSpot ids are numeric,
 *  Salesforce 15/18-char alphanumeric — no real vendor id starts with
 *  `-`/`_`, and the leading-alnum rule also rejects a negative-number
 *  coercion like `'-5'`). Anything else — including an empty string or
 *  a path-traversal-shaped value from a hostile response — fails
 *  closed to "no inverse" rather than riding into the path. */
const SAFE_VENDOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const extractCreatedRecordId = (output: unknown): string | undefined => {
  if (output === null || typeof output !== 'object') return undefined;
  const result = (output as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') return undefined;
  for (const key of ['id', 'Id'] as const) {
    const raw = (result as Record<string, unknown>)[key];
    const value =
      typeof raw === 'string' ? raw
      : typeof raw === 'number' && Number.isFinite(raw) ? String(raw)
      : undefined;
    if (value !== undefined && SAFE_VENDOR_ID.test(value)) return value;
  }
  return undefined;
};

/** The connection-slot variable name on every derived compensation
 *  recipe. One slot, explicitly named on the op-step (clearer than the
 *  single-variable implicit tier, and pinned for tests). */
export const COMPENSATION_CONNECTION_VARIABLE = 'target_connection';

/** Derived recipe ids are namespaced so audit readers can spot a
 *  compensation run's recipe at a glance. */
export const COMPENSATION_RECIPE_ID_PREFIX = 'saga-undo-';

// ────────────────────────────────────────────────────────────────
// Derivation
// ────────────────────────────────────────────────────────────────

/** Derive the inverse canonical operation for one landed catalog
 *  write, or `null` when no inverse is derivable. Pure — reads only
 *  the landed write + the catalog manifest + the shipped registry.
 *
 *  Fail-closed paths (every `null` is a disclosed-but-not-undoable
 *  landed write, never an error):
 *    - verb is not `create` (update/delete carry no v1 inverse);
 *    - the catalog does not declare `<entity>.delete` (operation OR
 *      REST binding missing);
 *    - the catalog slug has no registered vendor, or the entity no
 *      crm_alias (the canonical recipe could not name the op);
 *    - no safe created-record id is extractable from the output. */
export const deriveCompensation = (
  landed: LandedCatalogWrite,
  manifest: IngredientManifest,
): CompensationPlan | null => {
  const dot = landed.operation_key.indexOf('.');
  if (dot <= 0) return null;
  const vendorEntity = landed.operation_key.slice(0, dot);
  const verb = landed.operation_key.slice(dot + 1);
  if (verb !== 'create') return null;

  // The inverse must be DECLARED by the same catalog — operation row
  // AND a REST surface binding (the gateway dispatches from the
  // binding; an op row alone is not executable).
  const inverseKey = `${vendorEntity}.delete`;
  const operations = manifest.operations ?? {};
  if (!Object.prototype.hasOwnProperty.call(operations, inverseKey)) return null;
  const executes = manifest.surfaces?.api?.executes ?? {};
  if (!Object.prototype.hasOwnProperty.call(executes, inverseKey)) return null;

  const vendor = vendorForCatalogSlug(landed.catalog_slug);
  if (vendor === undefined) return null;
  const alias = crmAliasFor(vendor, vendorEntity);
  if (alias === undefined) return null;

  const createdId = extractCreatedRecordId(landed.output);
  if (createdId === undefined) return null;

  const recipe: RecipeDefinition = {
    recipe_id: `${COMPENSATION_RECIPE_ID_PREFIX}${landed.commit_id}`,
    version: 1,
    ttl: 0,
    metadata: {
      name: `Undo ${alias} create`,
      description:
        `Saga compensation — delete ${alias} ${createdId} on `
        + `'${landed.connection_name}' to undo the landed `
        + `${landed.operation_id} from a torn run. Derived, dispatched `
        + `inline through the normal gate; never installed.`,
      author: 'recued',
      supported_platforms: [],
    },
    variables: {
      [COMPENSATION_CONNECTION_VARIABLE]: {
        label: 'Connection to undo on',
        type: 'connection',
        connection_kind: 'api',
        default: '',
      } as unknown as RecipeDefinition['variables'][string],
    },
    prefetch_steps: [],
    steps: [
      {
        id: 'undo',
        op: `${alias}.delete`,
        connection: `{{config.${COMPENSATION_CONNECTION_VARIABLE}}}`,
        args: { id: createdId },
      },
    ],
    output: { render: [] },
  };

  return {
    recipe,
    config: { [COMPENSATION_CONNECTION_VARIABLE]: landed.connection_name },
    predecessor_commit_id: landed.commit_id,
    description:
      `delete ${alias} ${createdId} on '${landed.connection_name}' `
      + `(created by ${landed.operation_id})`,
  };
};
