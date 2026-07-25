/** D-192 — SILENT-STALENESS OBSERVABILITY: which declared field paths have never
 *  actually carried a value?
 *
 *  ── The failure this exists to make visible ──────────────────────────────────
 *  A declared field path that does not exist on the vendor's records resolves to
 *  `undefined`, SILENTLY. Nothing errors. And because the sync's change detection
 *  is `source_record_hash`-based:
 *
 *      if (priorHashes.get(rid) === projected.upsert.write.source_record_hash) {
 *        unchanged += 1; continue;                       // never re-written
 *      }
 *
 *  …a Source whose `remote.hash_fields` are ALL phantom hashes a constant tuple of
 *  `undefined`s forever. Every row reads "unchanged". The mirror freezes. The user
 *  sees a Source that syncs cleanly, reports no errors, and is quietly frozen at
 *  whatever it captured on its first walk — for as long as they keep it installed.
 *
 *  ── Why THIS signal and not "it has never observed a change" ─────────────────
 *  That was the first idea, and it is the weaker one: it cannot tell a BROKEN
 *  Source from a QUIET one. A user who simply has not touched their tasks in a
 *  month produces the identical trace. This signal is direct instead — it names
 *  the exact path, it does not depend on user activity at all, and it catches the
 *  whole phantom class (version / hash / tombstone) rather than only its symptom.
 *
 *  ── It OBSERVES; it does not GATE ───────────────────────────────────────────
 *  Per the D-192 authority-ladder §0: the substrate makes failures VISIBLE, it
 *  does not decide who may publish. So this reports a FACT — *"declared path `X`
 *  has carried a value on 0 of the 1,240 rows this Source has ever seen"* — and
 *  never a verdict. Whether that is a phantom path or a field the vendor
 *  legitimately leaves empty is a judgment for a human, and the two are honestly
 *  distinguished below by ROLE, not asserted away.
 *
 *  Runtime-only, and deliberately NOT in `packages/` (§0.1): the production server
 *  is the only thing that ever runs it. */

import type { WorkEntitySourceDeclaration } from '@recued/contracts';

import { getByDotPath } from './source-mirror/fetch.js';

/** What a declared path is FOR — which is what makes a never-valued path
 *  interpretable rather than just curious. */
export type WorkEntityFieldRole =
  /** `remote.version.field` — the record's updated-at / revision. EVERY record
   *  carries one, so "never valued" is a near-certain wrong path. */
  | 'version'
  /** `remote.hash_fields[]` — the change-detection inputs. If they are ALL never
   *  valued the hash is constant and the Source is FROZEN (the silent staleness).
   *  A SINGLE never-valued hash field is weaker: it may be a wrong path, or a
   *  field the vendor legitimately leaves empty (a task `body` nobody fills in) —
   *  either way that field is contributing nothing to change detection. */
  | 'hash'
  /** `remote.tombstone_field` — a deletion flag. It is normally PRESENT and
   *  `false`; "never valued" therefore means absent, not "nothing was deleted".
   *  (We count presence, never truthiness — `false` is a value.) */
  | 'tombstone';

export interface WorkEntityDeclaredPath {
  path: string;
  role: WorkEntityFieldRole;
}

export interface WorkEntityPathHealth {
  role: WorkEntityFieldRole;
  /** Rows on which `getByDotPath` returned something other than undefined/null.
   *  Presence, NOT truthiness — `false` and `0` are values. */
  with_value: number;
}

export interface WorkEntitySourceFieldHealth {
  /** Rows this Source has POLLED over its whole lifetime — the denominator.
   *  Includes rows that later failed projection: they are still real vendor
   *  records, and their paths are exactly the evidence we want. */
  rows_seen: number;
  paths: Record<string, WorkEntityPathHealth>;
}

/** Below this many lifetime rows we say nothing at all. A Source that has seen
 *  three tasks tells you nothing about whether a path is real. */
export const FIELD_HEALTH_MIN_ROWS = 20;

/** The load-bearing declared paths — the ones whose silence is a defect rather
 *  than merely sparse data.
 *
 *  Deliberately EXCLUDES `projection.canonical.*`: `due_at`, `priority` and
 *  `completed_at` are legitimately empty on most rows, so a never-valued
 *  projection path is ordinary and would drown the real signal in noise. (`title`
 *  is required, but a null title already FAILS the row closed and is visible as
 *  `failed_rows` — it is not silent, so it needs no help from us.) */
export const declaredLoadBearingPaths = (
  // Narrowed to exactly what this reads. The pack and kernel declarations have
  // since CONVERGED (the authority ladder made `contract_source` optional on
  // both — ratified 2026-07-14), but the narrowing is kept: this reads `remote`
  // and `sync` and nothing else, and saying so is the honest signature.
  //
  // 🔑 Note what that convergence means HERE, of all places: an unpinned Source
  // is exactly the one with no documentary field proof — so it is exactly the
  // one whose phantom paths only this health tally will ever catch. Absence of
  // a pin is not a reason to check less; it is the reason this exists.
  declaration: Pick<WorkEntitySourceDeclaration, 'remote' | 'sync'>,
): WorkEntityDeclaredPath[] => {
  const paths: WorkEntityDeclaredPath[] = [];
  const { remote } = declaration;
  if (remote.version.kind !== 'none' && remote.version.field !== undefined) {
    paths.push({ path: remote.version.field, role: 'version' });
  }
  for (const field of remote.hash_fields ?? []) {
    paths.push({ path: field, role: 'hash' });
  }
  // `tombstone_field` lives on `sync`, NOT on `remote` (contract
  // `WorkEntitySourceSync`). Only meaningful under `tombstones: 'native'` — under
  // any other posture the field is inert, so its silence would mean nothing.
  const { tombstone_field } = declaration.sync;
  if (declaration.sync.tombstones === 'native' && tombstone_field !== undefined) {
    paths.push({ path: tombstone_field, role: 'tombstone' });
  }
  // A path can be declared twice (the version field is conventionally also a
  // hash field). Keep the FIRST role — `version` outranks `hash`, and the
  // stronger interpretation is the useful one.
  const seen = new Set<string>();
  return paths.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
};

/** Tally one cycle's rows. Returns a delta to merge — never mutates the store. */
export const tallyCycleFieldHealth = (
  declared: readonly WorkEntityDeclaredPath[],
  rows: ReadonlyArray<Record<string, unknown>>,
): WorkEntitySourceFieldHealth => {
  const paths: Record<string, WorkEntityPathHealth> = {};
  for (const { path, role } of declared) paths[path] = { role, with_value: 0 };
  for (const raw of rows) {
    for (const { path } of declared) {
      const v = getByDotPath(raw, path);
      // Presence, not truthiness: `false` / `0` / `''` are values a vendor
      // legitimately returns. Only undefined/null means "the path isn't there".
      if (v !== undefined && v !== null) paths[path].with_value += 1;
    }
  }
  return { rows_seen: rows.length, paths };
};

/** Fold a cycle's delta into the stored lifetime tally.
 *
 *  ⚠ A path that is no longer declared is DROPPED, and a newly declared path
 *  starts from zero — otherwise a re-authored declaration would inherit the old
 *  one's evidence and either exonerate a fresh phantom or keep accusing a path
 *  that no longer exists. (The sync state's `contract_hash` already resets
 *  incremental trust on a declaration change; this keeps the health tally honest
 *  across the same event.) */
export const mergeFieldHealth = (
  prior: WorkEntitySourceFieldHealth | null,
  delta: WorkEntitySourceFieldHealth,
): WorkEntitySourceFieldHealth => {
  const paths: Record<string, WorkEntityPathHealth> = {};
  for (const [path, d] of Object.entries(delta.paths)) {
    const p = prior?.paths[path];
    // Only carry prior evidence forward when the ROLE still matches — a path
    // whose role changed is, for our purposes, a different claim.
    const carried = p !== undefined && p.role === d.role ? p.with_value : 0;
    paths[path] = { role: d.role, with_value: carried + d.with_value };
  }
  const priorRows = prior?.rows_seen ?? 0;
  return { rows_seen: priorRows + delta.rows_seen, paths };
};

export interface WorkEntityNeverValuedPath {
  path: string;
  role: WorkEntityFieldRole;
  rows_seen: number;
}

export interface WorkEntitySourceStalenessSignal {
  /** Declared load-bearing paths that have carried a value on ZERO rows, across
   *  enough rows to mean something. A FACT, not a verdict (see the header). */
  never_valued: WorkEntityNeverValuedPath[];
  /** 🔴 THE ALARM. Every declared hash field is never-valued ⇒ the record hash is
   *  a constant ⇒ change detection is DEAD ⇒ the mirror is FROZEN and will never
   *  update again, silently, with no error and no symptom. Unlike `never_valued`
   *  this is not a judgment call: it is the silent-staleness condition itself. */
  change_detection_dead: boolean;
}

export const stalenessSignal = (
  health: WorkEntitySourceFieldHealth | null,
): WorkEntitySourceStalenessSignal => {
  const empty: WorkEntitySourceStalenessSignal = {
    never_valued: [], change_detection_dead: false,
  };
  if (health === null || health.rows_seen < FIELD_HEALTH_MIN_ROWS) return empty;

  const never_valued: WorkEntityNeverValuedPath[] = [];
  for (const [path, p] of Object.entries(health.paths)) {
    if (p.with_value === 0) {
      never_valued.push({ path, role: p.role, rows_seen: health.rows_seen });
    }
  }
  const hashPaths = Object.values(health.paths).filter((p) => p.role === 'hash');
  const change_detection_dead =
    hashPaths.length > 0 && hashPaths.every((p) => p.with_value === 0);

  return { never_valued, change_detection_dead };
};

/** Human-facing summary — the whole point is that a person reads this and goes
 *  "…that field name is wrong". State the evidence, never the verdict. */
export const describeStalenessSignal = (
  source_id: string,
  signal: WorkEntitySourceStalenessSignal,
): string | null => {
  if (signal.never_valued.length === 0) return null;
  const lines = signal.never_valued.map(
    (n) => `  · '${n.path}' (${n.role}) — a value on 0 of ${n.rows_seen} rows`,
  );
  const head = signal.change_detection_dead
    ? `Source '${source_id}' is FROZEN: every declared hash field is empty, so its record hash`
      + ' never changes and no update can ever be detected. This Source is silently stale.'
    : `Source '${source_id}' declares field paths that have never carried a value:`;
  return `${head}\n${lines.join('\n')}`;
};
