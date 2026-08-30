/** D-254 slice 1 — the INVERSE of {@link composePlatformRecordTargetId}.
 *
 *  ⛔⛔ THE COMPOSER SHIPPED WITHOUT ONE, AND THAT IS THE WHOLE DEFECT D-254
 *  NAMES. `<vendor>_<entity>_<connection_name>_<native_id>` is the primary key
 *  the mirror, the enrichment rows, the timeline/audit links and the cascade all
 *  join on — and until this module, nothing in the tree could read it back.
 *  `matchCrmAlias` matches the `<vendor>_<entity>_` PREFIX only: enough to pick a
 *  scope, never enough to say WHICH CONNECTION a record came from or what the
 *  vendor's own id for it is. So a record that reached a recipe step or a model
 *  could not be written back safely — the routing had to be re-supplied by the
 *  caller, from the op's NAME and the pack's install binding.
 *
 *  🔑 WHY A PARSE IS SAFE HERE AND IS NOT SAFE IN GENERAL. Vendor and entity
 *  segments both match `/^[a-z][a-z0-9_]*$/` — they MAY contain underscores — so
 *  `a_b_c_d_9` has several arithmetically valid splits. Two things make this
 *  deterministic anyway: the `<vendor>_<entity>_` prefix must match a REGISTERED
 *  {@link ConnectionVendorEntity} (not any well-formed pair), and the connection
 *  segment is dash-only, so the first `_` after that prefix ends it and a native
 *  id keeps every underscore it had.
 *
 *  ⛔ AMBIGUITY RETURNS NULL, IT DOES NOT PICK. If two registry entries both
 *  yield a complete parse (`(hub, spot_deal)` alongside `(hubspot, deal)` would),
 *  this returns null rather than choosing. The registry has no such pair today
 *  and a test asserts it, but a parser that silently prefers one would route a
 *  write to the wrong vendor on the day someone adds one — the failure would be a
 *  correct-looking call against the wrong account.
 *
 *  ⚠ A BARE NATIVE ID AND A LOCAL ID BOTH RETURN NULL, and callers must treat
 *  those two nulls differently from each other only by what they already know:
 *  null means "this string carries no routing", never "route it somewhere
 *  sensible". D-254 cell A is exactly this — an email handed to a vendor-qualified
 *  op must deny, not fall through to the pack's bound connection as if it were a
 *  native id. */

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
} from './connection-vendors.js';
import { composePlatformRecordTargetId } from './enrichment-registry.js';

/** The connection PK charset: dash-only, no `_` and no `.`, ≤ 48 chars.
 *
 *  ⛔ THIS CONSTANT IS LOAD-BEARING FOR THE PARSE, not decoration. The composer's
 *  own doc calls the trailing `_` "load-bearing" for the same reason from the
 *  other side — it is what bounds the connection segment so `acme_` never
 *  prefix-matches `acme2_`. Exported here because `enrichment-registry.ts`
 *  already refers to it by this name in prose while no module exported it. */
export const CONNECTION_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** One decomposed platform-record target id. Every field is a segment recovered
 *  verbatim — nothing is normalized, lowercased or defaulted. */
export interface PlatformRecordTargetId {
  /** Registered vendor segment (`hubspot`, `salesforce`). */
  vendor: string;
  /** Registered entity segment (`deal`, `contact`, `company`). */
  entity: string;
  /** The connection PK the record belongs to — the routing key. */
  connection_name: string;
  /** The vendor's own id, underscores intact. */
  native_id: string;
}

/** Recover `(vendor, entity, connection_name, native_id)` from a composed target
 *  id, or `null` for anything that is not one.
 *
 *  `null` for: a bare native id, a local id (an email — the local contact graph's
 *  key), an unregistered `<vendor>_<entity>_` pair, an empty connection or native
 *  segment, a connection segment outside {@link CONNECTION_NAME_REGEX}, and a
 *  string two registry entries could both claim. Never a guess. */
export const parsePlatformRecordTargetId = (
  raw: unknown,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): PlatformRecordTargetId | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const parsed: PlatformRecordTargetId[] = [];
  for (const entry of registry) {
    const prefix = `${entry.vendor}_${entry.entity}_`;
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    // The FIRST `_` ends the connection segment — the connection charset has no
    // `_`, so everything after it is the native id with its own underscores kept.
    const cut = rest.indexOf('_');
    if (cut <= 0) continue;
    const connection_name = rest.slice(0, cut);
    const native_id = rest.slice(cut + 1);
    if (native_id.length === 0) continue;
    if (!CONNECTION_NAME_REGEX.test(connection_name)) continue;
    parsed.push({
      vendor: entry.vendor,
      entity: entry.entity,
      connection_name,
      native_id,
    });
  }

  // Exactly one complete parse, or nothing. See the ambiguity note above.
  return parsed.length === 1 ? parsed[0]! : null;
};

/** Does this string carry routing at all? Sugar over
 *  {@link parsePlatformRecordTargetId} for call sites that only need the
 *  question, so they do not re-implement the prefix test and drift from the
 *  charset rule. */
export const isPlatformRecordTargetId = (
  raw: unknown,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): boolean => parsePlatformRecordTargetId(raw, registry) !== null;

// ════════════════════════════════════════════════════════════════
// D-254 slice 1 — routing one operation's args
// ════════════════════════════════════════════════════════════════

export type PlatformRecordIdErrorCode =
  | 'PLATFORM_ID_CONNECTION_REQUIRED'
  | 'PLATFORM_ID_SOURCE_MISMATCH';

/** ⛔ Thrown BEFORE any provider call, and every message says so. A model that
 *  cannot tell "refused, nothing happened" from "attempted and failed" retries
 *  a write it must not repeat. Mirrors `QualifiedWorkEntityIdError`, including
 *  the `retry_with` / `expected_source` / `actual_source` detail fields the
 *  work-entity router already teaches callers to read. */
export class PlatformRecordIdError extends Error {
  readonly code: PlatformRecordIdErrorCode;
  readonly expected_source?: string;
  readonly actual_source?: string;

  constructor(
    code: PlatformRecordIdErrorCode,
    message: string,
    detail: { expected_source?: string; actual_source?: string } = {},
  ) {
    super(message);
    this.name = 'PlatformRecordIdError';
    this.code = code;
    if (detail.expected_source !== undefined) this.expected_source = detail.expected_source;
    if (detail.actual_source !== undefined) this.actual_source = detail.actual_source;
  }
}

export interface PlatformRecordRouting {
  args: Record<string, unknown>;
  routed?: PlatformRecordTargetId & { id_arg: string };
}

/** Validate and UNWRAP a platform-record id supplied to one operation.
 *
 *  🔑 THE ONLY DECLARED INPUT IS `id_arg`, AND THAT IS THE POINT. An earlier cut
 *  also declared the op's vendor and entity; both were redundant. The
 *  connection↔catalog pin already refuses a vendor-B op dispatched against a
 *  vendor-A connection (`ConnectionOperationProfile.catalog_slug`: "a profile
 *  seeded for vendor A's catalog must NOT satisfy a colliding operation
 *  dispatched from vendor B's catalog"), so a declared vendor was one rule at a
 *  second door; and the op's entity is its own annotation, not something a
 *  binding should restate. WHERE THE ID SITS IN THE ARGS is the one fact the id
 *  cannot carry about itself.
 *
 *  ⛔⛔ CALL THIS BEFORE THE GATE. `catalog-gateway.ts` already states the rule
 *  for the work-entity twin — unwrapped *"before request-schema checks,
 *  approval, grants, or dispatch. A mismatch therefore cannot be approved into a
 *  wrong-provider call."* Routing after the gate would check the grant of the
 *  connection the caller NAMED and dispatch against the one the id names.
 *
 *  ⚠ A BARE NATIVE ID PASSES THROUGH UNTOUCHED. That is backward compatibility
 *  with every shipped vendor recipe (`recued-core.hubspot.contact.update
 *  { contact_id: "88" }`) and it is also the honest limit of this layer: the
 *  parser can say a string carries no routing, never that it belongs to some
 *  OTHER key space. D-254 cell A ruled that a local id (an email) reaching a
 *  vendor op must DENY — that ruling is not decidable here, because a vendor is
 *  free to key on an email itself. It has to be enforced where the id's
 *  provenance is known, not where its shape is. */
export const routePlatformRecordOperationArgs = (input: {
  /** `OperationSpec.record_id_arg` — the ONLY thing the id cannot carry. */
  id_arg: string | undefined;
  operation: string;
  connection_name: string;
  args: Record<string, unknown>;
  registry?: ReadonlyArray<ConnectionVendorEntity>;
}): PlatformRecordRouting => {
  const id_arg = input.id_arg;
  if (id_arg === undefined || id_arg.length === 0) return { args: input.args };

  const raw = input.args[id_arg];
  const parsed = parsePlatformRecordTargetId(raw, input.registry ?? CONNECTION_VENDOR_ENTITIES);
  if (parsed === null) return { args: input.args };

  if (input.connection_name.length === 0) {
    throw new PlatformRecordIdError(
      'PLATFORM_ID_CONNECTION_REQUIRED',
      `PLATFORM_ID_CONNECTION_REQUIRED: '${input.operation}' needs an exact connection before `
        + `a record id can be routed. No provider call was made. Retry naming connection `
        + `'${parsed.connection_name}' with the same id.`,
      { actual_source: parsed.connection_name },
    );
  }

  if (parsed.connection_name !== input.connection_name) {
    // D-254 cell B, resolved the way the work-entity router already resolves it:
    // REFUSE and name the connection to retry on, rather than silently redirecting
    // the call. Re-routing would move the grant check onto a connection the caller
    // never named; refusing keeps one behaviour across both entity families.
    throw new PlatformRecordIdError(
      'PLATFORM_ID_SOURCE_MISMATCH',
      `PLATFORM_ID_SOURCE_MISMATCH: '${input.operation}' is bound to connection `
        + `'${input.connection_name}', but the id belongs to '${parsed.connection_name}'. `
        + `No provider call was made. Retry against '${parsed.connection_name}' with the `
        + 'same id.',
      { expected_source: input.connection_name, actual_source: parsed.connection_name },
    );
  }

  // Same connection, same entity ⇒ hand the provider ITS OWN id.
  return {
    args: { ...input.args, [id_arg]: parsed.native_id },
    routed: { ...parsed, id_arg },
  };
};

// ════════════════════════════════════════════════════════════════
// D-254 slice 2 — composing on the way OUT
// ════════════════════════════════════════════════════════════════

/** ⛔⛔ ADDITIVE, AND THAT IS A RULING, NOT A PREFERENCE. Three shipped decisions
 *  say vendor-shaped data stays vendor-shaped:
 *
 *  - **D-190 fork C2** — `id` in the canonical projection is a VENDOR-SHAPED
 *    SELECTOR (Pipedrive numeric, HubSpot/Salesforce string): *"the divergence is
 *    accepted, not coerced"*. Rewriting `id` would coerce it.
 *  - **D-206 / D-205 ruling 3** — a vendor foreign key (`deal.meta.contact_id`) is
 *    stored and joined RAW, because *"Recued is not a cache of external systems"*
 *    and the reverse lookup joins that raw id against `platform_ids`. Composing a
 *    ref field would break the join it exists for.
 *  - **The reconciler's own note** — *"the `<vendor>_<entity>_` prefix is added
 *    here (the projection emits none)"*: the composed id is Recued's STORAGE key,
 *    added at the storage boundary, not baked into the payload upstream of it.
 *
 *  ⇒ this ADDS `target_id` beside the vendor's own fields and rewrites nothing. A
 *  record that already carries a `target_id` is left exactly as it is — a
 *  collision is the vendor's field to keep, not ours to take.
 *
 *  ⚠ WHY THIS IS NOT THE MIRROR IMAGE OF THE DECOMPOSER. Decompose reads an id
 *  that already carries `(vendor, entity, connection, native)`, so its whole
 *  declaration is "which arg". Compose must CONSTRUCT that tuple, so every part
 *  has to be supplied or derived — and each one it cannot establish is a reason to
 *  do nothing rather than to guess. An unregistered `(vendor, entity)`, an absent
 *  vendor, or an empty connection all return the result untouched. */
export const stampPlatformRecordIds = (input: {
  result: unknown;
  /** The bound connection's vendor (`resolveConnectionVendor`). Absent ⇒ no stamp. */
  vendor: string | undefined;
  /** The registry entity the op returns, derived from its op family. */
  entity: string;
  connection_name: string;
  /** WHERE THE RECORDS SIT in the returned value, resolved by the gateway's own
   *  `resolveCatalogRecordsPath` — never re-derived here. Its first segment is the
   *  executor envelope key; the rest is the declared `result_path`. */
  records_path?: readonly string[] | undefined;
  registry?: ReadonlyArray<ConnectionVendorEntity>;
}): unknown => {
  const { result, vendor, entity, connection_name } = input;
  if (vendor === undefined || vendor.length === 0) return result;
  if (connection_name.length === 0) return result;
  const registry = input.registry ?? CONNECTION_VENDOR_ENTITIES;
  // ⛔ REGISTRY-BOUNDED BOTH WAYS. An unregistered pair could still be composed
  // arithmetically — and the resulting id would never PARSE back, so it would read
  // as routable and route nowhere. Silence is the honest output.
  if (!registry.some((e) => e.vendor === vendor && e.entity === entity)) return result;

  const stamp = (record: unknown): unknown => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return record;
    const row = record as Record<string, unknown>;
    if ('target_id' in row) return record; // the vendor's field to keep
    const native = row['id'];
    // A number is HubSpot/Pipedrive-shaped and stringifies losslessly here; anything
    // else (an object id, a missing id) is not a selector this can compose from.
    if (typeof native !== 'string' && typeof native !== 'number') return record;
    const nativeId = String(native);
    if (nativeId.length === 0) return record;
    return {
      ...row,
      target_id: composePlatformRecordTargetId(vendor, entity, connection_name, nativeId),
    };
  };

  const path = input.records_path;
  if (path === undefined || path.length === 0) return stamp(result);

  const at = (root: unknown, segs: readonly string[]): unknown =>
    segs.reduce<unknown>(
      (node, seg) =>
        node !== null && typeof node === 'object' && !Array.isArray(node)
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      root,
    );
  const withAt = (root: unknown, segs: readonly string[], next: unknown): unknown => {
    if (segs.length === 0) return next;
    if (root === null || typeof root !== 'object' || Array.isArray(root)) return root;
    const [head, ...rest] = segs as [string, ...string[]];
    const node = root as Record<string, unknown>;
    return { ...node, [head]: withAt(node[head], rest, next) };
  };

  const rows = at(result, path);
  if (Array.isArray(rows)) return withAt(result, path, rows.map(stamp));

  // ⚠ NOT AN ERROR CASE — IT IS HALF THE OPS. The surface declares ONE
  // `result_path` for the whole catalog (`results`), so a targeted `deal.read`
  // returning the record itself has no such key. The collection path's FIRST
  // segment is the executor envelope, and the record is what sits there. Treating
  // a non-matching path as "do nothing" would leave every read unstamped while
  // every search worked — a split nobody would think to test for.
  const bodyPath = path.slice(0, 1);
  const body = at(result, bodyPath);
  if (body === undefined) return result;
  return withAt(result, bodyPath, stamp(body));
};
