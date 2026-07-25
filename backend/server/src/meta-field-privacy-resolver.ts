/** D-165 — MetaField.privacy → D-167 field-privacy resolver.
 *
 *  D-170 already persists decomposed entity schemas in the local manifest
 *  store. This module is the standalone D-165 runtime reader: it turns those
 *  `MetaField.privacy` tags into the D-167 `FieldPrivacyResolver` shape without
 *  touching chat composition. The later chat-wiring slice only needs to inject
 *  the returned resolver in place of `noopFieldPrivacyResolver`.
 */

import type {
  EntityFieldPrivacy,
  EntityPrivacyTag,
  EntitySchemaIngredientInput,
  IngredientManifest,
  PiiAliasableData,
  PiiFieldTag,
} from '@recued/contracts';
import { PII_ENTITY_MARKER_KEY, isEntityFieldPrivacy } from '@recued/contracts';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { withDerivedVendorEntityPrivacy } from './canonical-pii-schemas.js';

type EntitySchemaSource = () => readonly EntitySchemaIngredientInput[];
type ManifestLookup = (slug: string, version?: number) => IngredientManifest | null;

export interface MetaFieldPrivacyResolverDeps {
  /** Current installed entity schemas. Called per packet so install/uninstall
   *  changes take effect on the next LLM egress pass. */
  readonly getEntitySchemas: EntitySchemaSource;
  /** Optional manifest lookup. When present, the resolver also matches the
   *  operation's declared `OperationSpec.operation_id`, not only the short
   *  schema operation key. */
  readonly getManifest?: ManifestLookup;
  /** D-167 E.1 — entity-marker privacy tags. Called per packet so the entity
   *  index reflects the current shipped/installed set. Absent → the entity
   *  index is empty and the `__entity` walk is a no-op (byte-identical with the
   *  operation-only path). */
  readonly getEntityPrivacyTags?: () => readonly EntityPrivacyTag[];
}

export type MetaFieldPrivacyResolver = (packet: PiiAliasableData) => readonly PiiFieldTag[];

interface FieldTagTemplate {
  readonly paths: readonly string[];
  readonly kind: EntityFieldPrivacy;
}

type OperationPrivacyIndex = Map<string, FieldTagTemplate[]>;

/** D-167 E.1 — `entity_id → bare FieldTagTemplate[]`. The entity-keyed peer of
 *  `OperationPrivacyIndex`: the marker walk roots these bare templates at the
 *  path of any object carrying `__entity: <entity_id>`. */
type EntityPrivacyIndex = Map<string, FieldTagTemplate[]>;

const PROTOTYPE_UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Recursion backstop on the `__entity` walk so a pathologically deep packet
 *  can never blow the stack. Generously above the only sites a producer stamps
 *  (the 3 chat-egress projections → `candidates[].record` ≈ depth 6, the
 *  confidence-shape slots ≈ depth 7), so a real stamp is always TAGGED. A marker
 *  somehow deeper than this is, at worst, a comfort miss on TAGGING — never a
 *  marker LEAK: the model-bound strip (`chat-pii-egress.ts`) is iterative and
 *  UNBOUNDED, so it removes a marker at any depth (security ≠ comfort). */
const MAX_ENTITY_WALK_DEPTH = 256;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const hasUnsafePathSegment = (path: string): boolean =>
  path.split('.').some((segment) => PROTOTYPE_UNSAFE_SEGMENTS.has(segment));

/** Convert a conservative JSONPath/dot-path subset into the dot path D-167's
 *  alias substrate accepts. The raw source path is still emitted separately, so
 *  unusual paths remain best-effort instead of being silently discarded. */
export const normalizeMetaFieldSourcePathForPii = (sourcePath: string): string | null => {
  let path = sourcePath.trim();
  if (path.length === 0) return null;
  if (path === '$') return null;
  if (path.startsWith('$.')) path = path.slice(2);
  else if (path.startsWith('$[')) path = path.slice(1);
  if (path.includes('..') || path.includes('*') || path.includes('?(') || path.includes(':')) {
    return null;
  }

  const out: string[] = [];
  let token = '';
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === '.') {
      if (token.length === 0) {
        if (out.length === 0) return null;
        continue;
      }
      out.push(token);
      token = '';
      continue;
    }
    if (ch !== '[') {
      token += ch;
      continue;
    }
    if (token.length > 0) {
      out.push(token);
      token = '';
    }
    const close = path.indexOf(']', i + 1);
    if (close < 0) return null;
    const inner = path.slice(i + 1, close);
    if (/^\d+$/.test(inner)) {
      out.push(inner);
    } else if (
      (inner.startsWith("'") && inner.endsWith("'"))
      || (inner.startsWith('"') && inner.endsWith('"'))
    ) {
      const quoted = inner.slice(1, -1);
      if (quoted.length === 0 || quoted.includes('\\')) return null;
      out.push(quoted);
    } else {
      return null;
    }
    i = close;
  }
  if (token.length > 0) out.push(token);
  if (out.length === 0 || out.some((segment) => segment.length === 0)) return null;
  const normalized = out.join('.');
  return hasUnsafePathSegment(normalized) ? null : normalized;
};

/** Candidate dot-paths a `MetaField.privacy` tag should be probed at: the raw
 *  `source_path` (matches a vendor-shaped record), its normalized form, and the
 *  canonical `key` (matches a `data.*`-shaped record). Prototype-unsafe segments
 *  are dropped. Shared with the D-167 enrichment-producer tag source
 *  (`housekeeping/enrichment-pii-tag-source.ts`) so chat-egress + enrichment-egress
 *  derive identical candidate paths from one field declaration. */
export const piiPathsForMetaField = (
  field: NonNullable<EntitySchemaIngredientInput['meta_fields']>[number],
): readonly string[] => {
  const paths = new Set<string>();
  const sourcePath = field.source_path.trim();
  if (sourcePath.length > 0 && !hasUnsafePathSegment(sourcePath)) {
    paths.add(sourcePath);
  }
  const normalizedSourcePath = normalizeMetaFieldSourcePathForPii(field.source_path);
  if (normalizedSourcePath !== null) paths.add(normalizedSourcePath);
  if (field.key.length > 0 && !hasUnsafePathSegment(field.key)) {
    paths.add(field.key);
  }
  return [...paths];
};

const operationKeysFor = (
  schema: EntitySchemaIngredientInput,
  operationKey: string,
  operation: { readonly catalog: string; readonly operation: string },
  getManifest: ManifestLookup | undefined,
): readonly string[] => {
  const keys = new Set<string>([
    operation.operation,
    `${operation.catalog}.${operation.operation}`,
    `${operation.catalog}/${operation.operation}`,
  ]);
  if (operationKey === operation.operation) keys.add(operationKey);
  const manifest = getManifest?.(operation.catalog);
  const operationSpec = manifest?.operations?.[operation.operation];
  if (operationSpec?.operation_id) {
    keys.add(operationSpec.operation_id);
    const slash = operationSpec.operation_id.indexOf('/');
    if (slash >= 0 && slash < operationSpec.operation_id.length - 1) {
      keys.add(operationSpec.operation_id.slice(slash + 1));
    }
  }
  if (schema.ingredient_id.length > 0) {
    keys.add(`${schema.ingredient_id}.${operation.operation}`);
    keys.add(`${schema.ingredient_id}/${operation.operation}`);
  }
  return [...keys].filter((key) => key.length > 0);
};

const buildOperationPrivacyIndex = (
  schemas: readonly EntitySchemaIngredientInput[],
  getManifest: ManifestLookup | undefined,
): OperationPrivacyIndex => {
  const index: OperationPrivacyIndex = new Map();
  for (const schema of schemas) {
    const taggedFields = (schema.meta_fields ?? [])
      .filter((field) => field.privacy !== undefined)
      .map((field): FieldTagTemplate | null => {
        const paths = piiPathsForMetaField(field);
        return paths.length > 0 && field.privacy !== undefined
          ? { paths, kind: field.privacy }
          : null;
      })
      .filter((field): field is FieldTagTemplate => field !== null);
    if (taggedFields.length === 0) continue;
    for (const [operationKey, operation] of Object.entries(schema.source_operations)) {
      for (const key of operationKeysFor(schema, operationKey, operation, getManifest)) {
        index.set(key, [...(index.get(key) ?? []), ...taggedFields]);
      }
    }
  }
  return index;
};

/** D-167 E.1 — build the entity-marker index from operation-FREE
 *  `EntityPrivacyTag`s. Each bare field becomes a single-path `FieldTagTemplate`
 *  the marker walk roots at a `__entity`-tagged object. Defensive hygiene
 *  mirrors `buildOperationPrivacyIndex` / `piiPathsForMetaField`: a field with
 *  an empty path, a prototype-unsafe segment, or a kind outside the 9-kind
 *  `EntityFieldPrivacy` enum is dropped (never tag a path the alias walker
 *  can't honor). An entity with no usable fields contributes no index entry. */
const buildEntityPrivacyIndex = (
  tags: readonly EntityPrivacyTag[],
): EntityPrivacyIndex => {
  const index: EntityPrivacyIndex = new Map();
  for (const tag of tags) {
    if (tag.entity_id.length === 0) continue;
    const templates = tag.fields
      .filter(
        (field) =>
          field.path.length > 0
          && !hasUnsafePathSegment(field.path)
          && isEntityFieldPrivacy(field.kind),
      )
      .map((field): FieldTagTemplate => ({ paths: [field.path], kind: field.kind }));
    if (templates.length === 0) continue;
    index.set(tag.entity_id, [...(index.get(tag.entity_id) ?? []), ...templates]);
  }
  return index;
};

/** Expand a `[]` array-wildcard `source_path` against the ACTUAL data the tag
 *  is being matched against, into concrete dot-numeric paths the D-167 alias
 *  walker (`transforms/pii-alias.ts` `getAtPath`/`setAtPath`) understands —
 *  `candidates[].record.email` over a 2-element array becomes
 *  `['candidates.0.record.email', 'candidates.1.record.email']`. This is what
 *  lets a fan-out result (`contact.search` / `deal.search` →
 *  `{ candidates: [ { record: { email, name } }, … ] }`) alias EVERY hit rather
 *  than only `candidates[0]`: the chat surface merges up to 100 candidates, so a
 *  fixed index would leak the rest.
 *
 *  - A path with no `[]` returns `[path]` unchanged and is NOT existence-checked
 *    — preserving the "emit the static path; the alias pass resolves it lazily"
 *    contract every non-wildcard schema relies on (byte-identical behaviour).
 *  - A `[]` segment whose data slot is absent or not an array contributes no
 *    path (comfort fail-open — aliasing is best-effort, never fabricate shape).
 *  - Nested wildcards (`a[].b[].c`) fan as a cartesian product over present
 *    indices. Prototype-unsafe keys are dropped. */
const expandArrayWildcardPath = (root: unknown, path: string): readonly string[] => {
  if (!path.includes('[]')) return [path];
  let frontier: Array<{ node: unknown; parts: string[] }> = [{ node: root, parts: [] }];
  for (const seg of path.split('.')) {
    const isWildcard = seg.endsWith('[]');
    const key = isWildcard ? seg.slice(0, -2) : seg;
    if (PROTOTYPE_UNSAFE_SEGMENTS.has(key)) return [];
    const next: Array<{ node: unknown; parts: string[] }> = [];
    for (const { node, parts } of frontier) {
      let target = node;
      let keyedParts = parts;
      if (key.length > 0) {
        if (node === null || typeof node !== 'object') continue;
        target = (node as Record<string, unknown>)[key];
        keyedParts = [...parts, key];
      }
      if (isWildcard) {
        if (!Array.isArray(target)) continue;
        target.forEach((el, i) => next.push({ node: el, parts: [...keyedParts, String(i)] }));
      } else {
        next.push({ node: target, parts: keyedParts });
      }
    }
    frontier = next;
  }
  return frontier.map((f) => f.parts.join('.'));
};

const pushTemplates = (
  out: PiiFieldTag[],
  seen: Set<string>,
  templates: readonly FieldTagTemplate[] | undefined,
  prefix: string,
  /** The data the `prefix` resolves against (the tool-call `result` envelope),
   *  so `[]`-wildcard template paths fan against the real array. */
  resultData: unknown,
): void => {
  if (templates === undefined) return;
  for (const template of templates) {
    for (const rawPath of template.paths) {
      for (const path of expandArrayWildcardPath(resultData, rawPath)) {
        const fullPath = prefix.length > 0 ? `${prefix}.${path}` : path;
        const key = `${fullPath}\0${template.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: fullPath, kind: template.kind });
      }
    }
  }
};

const candidateOperationNames = (record: Record<string, unknown>): readonly string[] => {
  const names = new Set<string>();
  for (const key of [
    'tool_name',
    'tool',
    'operation_id',
    'operation',
    'recipe_slug',
    'ingredient_id',
  ]) {
    const value = stringValue(record, key);
    if (value) names.add(value);
  }
  return [...names];
};

const pushRecordEnvelopeTags = (
  out: PiiFieldTag[],
  seen: Set<string>,
  index: OperationPrivacyIndex,
  record: Record<string, unknown>,
  basePath: string,
): void => {
  const result = record.result;
  if (result === undefined) return;
  const resultPrefix = basePath.length > 0 ? `${basePath}.result` : 'result';
  for (const operationName of candidateOperationNames(record)) {
    pushTemplates(out, seen, index.get(operationName), resultPrefix, result);
  }
};

/** D-167 E.1 — the additive, bounded recursive `__entity` walk. Any object that
 *  carries `__entity: E` with `E` in the entity index emits that entity's bare
 *  field templates rooted at the object's path; unmarked structure is left
 *  untouched, so with no markers present (or an empty index) this contributes
 *  nothing ⇒ **byte-identical** with the operation-only path. Shares `out`/`seen`
 *  with the operation walk, so a `(path, kind)` produced by BOTH (a stamped
 *  marker AND an explicit operation path, the P2 overlap) is emitted once.
 *
 *  `visited` is the DFS-ancestor set (added on enter, removed on exit), NOT a
 *  global seen-set: it blocks true cycles (an ancestor reappearing in its own
 *  subtree) while still emitting tags for the same record at every distinct
 *  path it occupies — the by-ref re-embedding the confidence shape relies on.
 *  Prototype-unsafe keys are never descended; depth is capped. */
const walkEntityMarkers = (
  out: PiiFieldTag[],
  seen: Set<string>,
  index: EntityPrivacyIndex,
  node: unknown,
  path: string,
  depth: number,
  visited: Set<object>,
): void => {
  if (index.size === 0) return;
  if (depth > MAX_ENTITY_WALK_DEPTH) return;
  if (node === null || typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    node.forEach((element, idx) => {
      const childPath = path.length > 0 ? `${path}.${idx}` : String(idx);
      walkEntityMarkers(out, seen, index, element, childPath, depth + 1, visited);
    });
    visited.delete(node);
    return;
  }

  const record = node as Record<string, unknown>;
  const marker = record[PII_ENTITY_MARKER_KEY];
  if (typeof marker === 'string') {
    pushTemplates(out, seen, index.get(marker), path, record);
  }
  for (const [key, value] of Object.entries(record)) {
    if (PROTOTYPE_UNSAFE_SEGMENTS.has(key)) continue;
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    walkEntityMarkers(out, seen, index, value, childPath, depth + 1, visited);
  }
  visited.delete(node);
};

const resolveFromPacket = (
  packet: PiiAliasableData,
  index: OperationPrivacyIndex,
  entityIndex: EntityPrivacyIndex,
): PiiFieldTag[] => {
  if (typeof packet === 'string') return [];
  const out: PiiFieldTag[] = [];
  const seen = new Set<string>();

  if (Array.isArray(packet)) {
    packet.forEach((item, idx) => {
      if (isObjectRecord(item)) pushRecordEnvelopeTags(out, seen, index, item, String(idx));
    });
    walkEntityMarkers(out, seen, entityIndex, packet, '', 0, new Set());
    return out;
  }

  if (Array.isArray(packet.prior_tool_calls)) {
    packet.prior_tool_calls.forEach((raw, idx) => {
      if (isObjectRecord(raw)) {
        pushRecordEnvelopeTags(out, seen, index, raw, `prior_tool_calls.${idx}`);
      }
    });
  }
  // D-167 (recall path) — the composer routes memory RECALL dispatches into the
  // typed `recall_context` field (`partitionPriorToolCalls`). Operation-scan those
  // entries the same way as `prior_tool_calls` so moving an entry between the two
  // fields keeps resolver coverage byte-identical (any entry that DID match an
  // operation schema is still tagged at its new path). Memory recall results carry
  // no schema today — the recall-index seed-then-scan is their coverage — but
  // mirroring here keeps the boundary uniform + forward-compatible.
  if (Array.isArray(packet.recall_context)) {
    packet.recall_context.forEach((raw, idx) => {
      if (isObjectRecord(raw)) {
        pushRecordEnvelopeTags(out, seen, index, raw, `recall_context.${idx}`);
      }
    });
  }
  pushRecordEnvelopeTags(out, seen, index, packet, '');
  walkEntityMarkers(out, seen, entityIndex, packet, '', 0, new Set());
  return out;
};

export const createMetaFieldPrivacyResolver = (
  deps: MetaFieldPrivacyResolverDeps,
): MetaFieldPrivacyResolver => (packet) =>
  resolveFromPacket(
    packet,
    buildOperationPrivacyIndex(deps.getEntitySchemas(), deps.getManifest),
    buildEntityPrivacyIndex(deps.getEntityPrivacyTags?.() ?? []),
  );

export const listLocalManifestEntitySchemas = (
  store: Pick<LocalManifestStore, 'slugs' | 'getEntitySchemas'>,
): EntitySchemaIngredientInput[] =>
  store.slugs().flatMap((slug) => store.getEntitySchemas(slug));

export const createMetaFieldPrivacyResolverFromLocalManifestStore = (
  store: Pick<LocalManifestStore, 'slugs' | 'getEntitySchemas' | 'getManifest'>,
  /** D-167 — shipped first-party canonical/CRM privacy-tagged schemas
   *  (`CANONICAL_PII_ENTITY_SCHEMAS`) the boot wiring unions in so PII protection
   *  is ON by default with no install. Defaults to none, so every existing caller
   *  (and the no-op invariant) is byte-identical: an empty union over an empty
   *  `local_manifest` resolves to `[]`. The chat index dedups `(path, kind)` per
   *  resolve, so a shipped + installed tag for the same field collapses — no
   *  double-aliasing. */
  shippedSchemas: readonly EntitySchemaIngredientInput[] = [],
  /** D-167 — operation-id manifests for the built-in catalogs the shipped CRM
   *  schemas bind to (`CANONICAL_PII_CATALOG_MANIFESTS`). The marketplace
   *  `hubspot-catalog` / `salesforce-catalog` live in the gateway dispatch
   *  registry, not `local_manifest`, so `operationKeysFor` cannot learn their
   *  fully-qualified `operation_id` from the store — without this fallback a chat
   *  tool call named `recued-core/hubspot.contact.read` misses the shipped index
   *  and egresses raw PII. The store lookup wins when present; this is the
   *  fallback. Omitting it preserves the prior store-only behaviour. */
  shippedManifests?: ReadonlyMap<string, IngredientManifest>,
  /** D-167 E.1 — shipped operation-FREE entity-marker privacy tags
   *  (`CANONICAL_PII_ENTITY_PRIVACY_TAGS`). Defaults to none, so every existing
   *  caller and the no-op invariant are byte-identical: an empty entity index
   *  makes the `__entity` walk a no-op regardless of packet shape. Wiring them
   *  live (so the index is populated) is the P2 slice that also stamps the
   *  markers — until then no packet carries a marker, so behaviour is identical
   *  whether or not this is passed. */
  shippedEntityPrivacyTags: readonly EntityPrivacyTag[] = [],
): MetaFieldPrivacyResolver =>
  createMetaFieldPrivacyResolver({
    // `withDerivedVendorEntityPrivacy` is applied INSIDE the factory, not at the call
    // site, so a caller cannot forget it. It back-fills the canonical privacy kinds on
    // any `crm_alias: 'contact'` schema that did not tag them — which is EVERY
    // pack-declared CRM contact (pipedrive / zoho / dynamics all ship with zero privacy
    // tags), whose email + phone + name were egressing RAW. Explicit author tags win, so
    // the two hand-written HubSpot/Salesforce schemas are untouched. Evaluated per
    // resolve (like the store read), so a runtime pack install is reflected immediately.
    getEntitySchemas: () =>
      withDerivedVendorEntityPrivacy([
        ...shippedSchemas,
        ...listLocalManifestEntitySchemas(store),
      ]),
    getManifest: (slug, version) =>
      store.getManifest(slug, version) ?? shippedManifests?.get(slug) ?? null,
    getEntityPrivacyTags: () => shippedEntityPrivacyTags,
  });
