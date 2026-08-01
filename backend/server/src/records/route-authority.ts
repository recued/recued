import type { RecordsPackRef, RecordsSchemaSnapshot } from '@recued/contracts';

import {
  RecordsMigrationRouteError,
  selectRecordsMigrationRoute,
  type RecordsMigrationPlan,
} from './migration.js';

export interface RecordsMigrationArtifact {
  owner: RecordsPackRef;
  version: number;
  artifact_digest: string;
  storage_schema_hash: string;
  declaration_hash: string;
  schema: RecordsSchemaSnapshot;
  migration_plans: readonly RecordsMigrationPlan[];
}

export interface RecordsMigrationAuthorityInput {
  owner: RecordsPackRef;
  from_version: number;
  target_version: number;
  source_storage_schema_hash: string;
  target_storage_schema_hash: string;
  source_artifact_digest: string;
  target_artifact_digest: string;
  source_schema: RecordsSchemaSnapshot;
  target_schema: RecordsSchemaSnapshot;
  source_plans: readonly RecordsMigrationPlan[];
  target_plans: readonly RecordsMigrationPlan[];
  migration_artifacts: readonly RecordsMigrationArtifact[];
  /** Per-entity natural key on each side, canonically ordered. A natural key is
   *  deliberately absent from `storage_schema_hash` (which projects fields
   *  only), so without these an upgrade would accept a version bump that ADDS or
   *  CHANGES a key — leaving every existing row at an id the new key does not
   *  derive, and letting the next create of the same tuple seat a second row.
   *  Omitted ⇒ treated as no keys on that side. */
  source_natural_keys?: Readonly<Record<string, readonly string[]>>;
  target_natural_keys?: Readonly<Record<string, readonly string[]>>;
  /** Entities that currently hold ROWS. Rekeying an empty entity is free — there
   *  are no ids to be wrong — so the refusal must not fire on one, or an ordinary
   *  pack update that adds a key to a new entity is blocked for zero rows.
   *  Omitted ⇒ every entity is treated as populated (fail closed). */
  populated_entities?: readonly string[];
}

export interface RecordsMigrationAuthority {
  route: RecordsMigrationPlan[];
  route_schemas: Record<string, RecordsSchemaSnapshot>;
  artifact_pins: ReadonlyMap<number, string>;
  synthetic_schema_unchanged_upgrade: boolean;
}

export class RecordsMigrationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordsMigrationAuthorityError';
  }
}

const authorityVersionFor = (plan: RecordsMigrationPlan): number =>
  plan.new_v > plan.from_v ? plan.new_v : plan.from_v;

/** Resolve and provenance-check the exact route used both for owner disclosure
 * and for the migration lock. A review can therefore never summarize a
 * different set of destructive steps from the coordinator's selected route. */
export const resolveRecordsMigrationAuthority = (
  input: RecordsMigrationAuthorityInput,
): RecordsMigrationAuthority => {
  const upgrading = input.target_version > input.from_version;
  const validateArtifactPlans = (
    version: number,
    plans: readonly RecordsMigrationPlan[],
    label: string,
  ): void => {
    for (const plan of plans) {
      if (authorityVersionFor(plan) !== version) {
        throw new RecordsMigrationAuthorityError(
          `${label} cannot authorize migration edge ${plan.from_v}->${plan.new_v}`,
        );
      }
    }
  };

  const targetPlans = [...input.target_plans];
  validateArtifactPlans(
    input.target_version,
    targetPlans,
    `target Records artifact v${input.target_version}`,
  );
  const routeSchemas: Record<string, RecordsSchemaSnapshot> = {
    [String(input.from_version)]: input.source_schema,
    [String(input.target_version)]: input.target_schema,
  };
  const artifactPins = new Map<number, string>([
    [input.from_version, input.source_artifact_digest],
    [input.target_version, input.target_artifact_digest],
  ]);
  const historicalPlans: RecordsMigrationPlan[] = [];
  for (const artifact of input.migration_artifacts) {
    if (artifact.owner.publisher !== input.owner.publisher
      || artifact.owner.pack_slug !== input.owner.pack_slug
      || !Number.isSafeInteger(artifact.version)
      || artifact.version <= 0
      || !artifact.artifact_digest
      || !artifact.storage_schema_hash
      || !artifact.declaration_hash
      || artifact.schema.decimal_scale !== input.target_schema.decimal_scale
      || Object.keys(artifact.schema.entities).length === 0) {
      throw new RecordsMigrationAuthorityError(
        'historical Records route artifact has invalid provenance/schema',
      );
    }
    if (artifact.version === input.from_version
      || artifact.version === input.target_version
      || routeSchemas[String(artifact.version)] !== undefined) {
      throw new RecordsMigrationAuthorityError(
        `duplicate Records route artifact v${artifact.version}`,
      );
    }
    validateArtifactPlans(
      artifact.version,
      artifact.migration_plans,
      `historical Records artifact v${artifact.version}`,
    );
    routeSchemas[String(artifact.version)] = artifact.schema;
    artifactPins.set(artifact.version, artifact.artifact_digest);
    historicalPlans.push(...artifact.migration_plans);
  }

  const sourcePlans = upgrading ? [] : [...input.source_plans];
  if (!upgrading) {
    validateArtifactPlans(
      input.from_version,
      sourcePlans,
      `installed Records artifact v${input.from_version}`,
    );
  }
  let route: RecordsMigrationPlan[];
  let syntheticSchemaUnchangedUpgrade = false;
  try {
    route = selectRecordsMigrationRoute(
      upgrading
        ? [...targetPlans, ...historicalPlans]
        : [...sourcePlans, ...historicalPlans],
      input.from_version,
      input.target_version,
    );
  } catch (error) {
    const noDeclaredRoute = error instanceof RecordsMigrationRouteError
      && error.message === 'no complete monotonic migration route';
    if (!noDeclaredRoute
      || !upgrading
      || input.source_storage_schema_hash !== input.target_storage_schema_hash) {
      throw new RecordsMigrationAuthorityError(
        error instanceof Error ? error.message : 'no complete migration route',
      );
    }
    // Schema-unchanged forward bumps without a declared route still pass
    // through the durable, receipt-pinned system version sweep.
    route = [];
    syntheticSchemaUnchangedUpgrade = true;
  }
  // ⛔ Outside the `catch` ON PURPOSE. This first shipped inside it, so it only
  // ran when NO route resolved — meaning a pack could add a natural_key and
  // silence the guard entirely by declaring any unrelated v1→v2 route. Verified:
  // with one declared edge the rekey was admitted.
  //
  // The original message also advised "declare a rekey route", which v1 cannot
  // do. The closed mapping vocabulary is move/copy/clear/default/safe_cast/
  // change_kind/relationship — every one of them operates on FIELDS, and
  // `change_kind` explicitly preserves `pk` (§ 10.4). No primitive rewrites a
  // primary key, so no declared route can make a rekey safe, and a route's
  // presence must not be taken as the author having handled it.
  //
  // A natural key is absent from `storage_schema_hash` (fields only), so nothing
  // upstream can see this transition. Rekeying an entity that holds rows would
  // leave each row at an id the new key does not derive; the next create of that
  // same tuple then seats a SECOND row, which is the one invariant `natural_key`
  // exists to state. Refused in BOTH directions — a downgrade that drops a key is
  // the same corruption in reverse.
  const keySet = (value: readonly string[] | undefined): string | null =>
    value === undefined ? null : JSON.stringify([...value].sort());
  const populated = input.populated_entities === undefined
    ? null
    : new Set(input.populated_entities);
  const rekeyed = [...new Set([
    ...Object.keys(input.source_natural_keys ?? {}),
    ...Object.keys(input.target_natural_keys ?? {}),
  ])]
    .filter((entity) => (populated === null || populated.has(entity))
      && keySet(input.source_natural_keys?.[entity])
        !== keySet(input.target_natural_keys?.[entity]))
    .sort();
  if (rekeyed.length > 0) {
    throw new RecordsMigrationAuthorityError(
      `natural_key changed on populated ${rekeyed.join(', ')}. `
      + 'Records v1 has no mapping that rewrites a primary key, so no migration can '
      + 'relocate the existing rows: keep the key as it was, or export and purge '
      + `${rekeyed.length === 1 ? 'that entity' : 'those entities'} before the upgrade.`,
    );
  }
  for (const edge of route) {
    if (routeSchemas[String(edge.from_v)] === undefined
      || routeSchemas[String(edge.new_v)] === undefined
      || !artifactPins.has(authorityVersionFor(edge))) {
      throw new RecordsMigrationAuthorityError(
        `migration edge ${edge.from_v}->${edge.new_v} lacks a digest-pinned schema artifact`,
      );
    }
  }
  return {
    route,
    route_schemas: routeSchemas,
    artifact_pins: artifactPins,
    synthetic_schema_unchanged_upgrade: syntheticSchemaUnchangedUpgrade,
  };
};
