/** D-213 Track B — source-safe projection of live structured prompt parts. */

import {
  PII_ENTITY_MARKER_KEY,
  isEntityFieldPrivacy,
  type PiiAliasableData,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart, PromptPart } from '@recued/middleware';

import type { RetainedAliasCandidate } from './storage/chat-store.js';

export const MAX_ENTITY_PARTS = 64;
export const MAX_ENTITY_RECORDS = 256;
const MAX_RETAINED_CANDIDATES = 1_024;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_SOURCE_VALUES = 8_192;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
// ⛔ DERIVED from D-167, never restated. Coarse = city / state / country only —
// they stay VISIBLE so the model can reason about timezone, hours, currency and
// jurisdiction (D-167 open-question #9). The POSTCODE is deliberately NOT coarse:
// D-167 aliases it at its leaf and derives its composite prose forms from it. A
// hand-copy of this set is how three documents drifted into calling the postcode
// coarse (D-213 § "T2′ — the POSTCODE is not coarse").
const ADDRESS_COARSE_KEYS = piiEgress.ADDRESS_COARSE_KEYS;
const textEncoder = new TextEncoder();

type CoreFieldShape =
  | 'string'
  | 'nullable_string'
  | 'number'
  | 'boolean'
  | 'string_array'
  | 'contact';

const CORE_ENTITY_FIELDS: ReadonlyMap<
  string,
  ReadonlyMap<string, CoreFieldShape>
> = new Map([
  ['contact', new Map<string, CoreFieldShape>([
    ['email', 'nullable_string'],
    ['name', 'string'],
    ['target_id', 'string'],
    ['phone', 'string'],
    ['company', 'string'],
    ['kind', 'string'],
    ['ambiguous', 'boolean'],
    ['lifecycle_stage', 'string'],
    ['recent_activity_at', 'number'],
    ['identityKey', 'string'],
    ['title', 'string'],
    ['birthday', 'string'],
    ['emails', 'string_array'],
  ])],
  ['deal', new Map<string, CoreFieldShape>([
    ['name', 'string'],
    ['target_id', 'string'],
    ['stage', 'string'],
    ['amount', 'number'],
    ['owner', 'string'],
    ['close_date', 'number'],
    ['close_state', 'string'],
    ['contact_id', 'string'],
    ['contact', 'contact'],
    ['contact_core_fenced', 'boolean'],
  ])],
  ['account', new Map<string, CoreFieldShape>([
    ['name', 'string'],
    ['target_id', 'string'],
    ['domain', 'string'],
    ['industry', 'string'],
    ['owner', 'string'],
    ['num_employees', 'number'],
    ['annual_revenue', 'number'],
  ])],
]);

const isNamespacedEntity = (entity: string): boolean =>
  entity.includes('/') || entity.includes('.') || entity.includes(':');

interface RetainableSourceBudget {
  entity_parts: number;
  entity_records: number;
  values: number;
  bytes: number;
}

const createRetainableSourceBudget = (): RetainableSourceBudget => ({
  entity_parts: 0,
  entity_records: 0,
  values: 0,
  bytes: 0,
});

const assertJsonData = (
  root: unknown,
  budget: RetainableSourceBudget,
): void => {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const next = stack.pop()!;
    budget.values += 1;
    if (budget.values > MAX_SOURCE_VALUES || next.depth > 12) {
      throw new Error('chat-pii-source: entity payload exceeds source bounds');
    }
    const value = next.value;
    if (typeof value === 'string') {
      budget.bytes += textEncoder.encode(value).byteLength;
      if (budget.bytes > MAX_SOURCE_BYTES) {
        throw new Error('chat-pii-source: entity payload exceeds source bounds');
      }
      continue;
    }
    if (
      value === null
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const member of value) {
        stack.push({ value: member, depth: next.depth + 1 });
      }
      continue;
    }
    if (typeof value !== 'object') {
      throw new Error('chat-pii-source: entity payload is not JSON data');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('chat-pii-source: entity payload is not JSON data');
    }
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(key) || key === PII_ENTITY_MARKER_KEY) {
        throw new Error('chat-pii-source: unsafe entity payload key');
      }
      budget.bytes += textEncoder.encode(key).byteLength;
      if (budget.bytes > MAX_SOURCE_BYTES) {
        throw new Error('chat-pii-source: entity payload exceeds source bounds');
      }
      stack.push({ value: member, depth: next.depth + 1 });
    }
  }
};

const coreFieldMatches = (
  shape: CoreFieldShape,
  value: unknown,
): boolean => {
  switch (shape) {
    case 'string':
      return typeof value === 'string';
    case 'nullable_string':
      return value === null || typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string_array':
      return Array.isArray(value)
        && value.every((member) => typeof member === 'string');
    case 'contact':
      return coreRecordMatches('contact', value);
  }
};

const coreRecordMatches = (
  entity: string,
  value: unknown,
): boolean => {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return false;
  const fields = CORE_ENTITY_FIELDS.get(entity);
  if (fields === undefined) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(record).every(([key, member]) => {
    const shape = fields.get(key);
    return shape !== undefined && coreFieldMatches(shape, member);
  });
};

const validateRetainablePromptPartWithBudget = (
  part: PromptPart,
  budget: RetainableSourceBudget,
): void => {
  if (part.role !== 'entity') return;
  budget.entity_parts += 1;
  if (budget.entity_parts > MAX_ENTITY_PARTS) {
    throw new Error('chat-pii-source: entity part limit exceeded');
  }
  budget.entity_records += Array.isArray(part.payload) ? part.payload.length : 0;
  if (budget.entity_records > MAX_ENTITY_RECORDS) {
    throw new Error('chat-pii-source: entity record limit exceeded');
  }
  if (
    typeof part.source !== 'string'
    || part.source.length === 0
    || typeof part.entity !== 'string'
    || part.entity.length === 0
    || !Array.isArray(part.payload)
    || part.payload.length > MAX_ENTITY_RECORDS
    || typeof part.render !== 'function'
  ) {
    throw new Error('chat-pii-source: malformed entity contribution');
  }
  const coreFields = CORE_ENTITY_FIELDS.get(part.entity);
  if (coreFields === undefined && !isNamespacedEntity(part.entity)) {
    throw new Error(
      `chat-pii-source: non-core entity id must be namespaced: ${part.entity}`,
    );
  }
  for (const record of part.payload) {
    if (
      record === null
      || typeof record !== 'object'
      || Array.isArray(record)
    ) {
      throw new Error('chat-pii-source: malformed entity record');
    }
    if (coreFields !== undefined && !coreRecordMatches(part.entity, record)) {
      throw new Error(
        `chat-pii-source: reserved ${part.entity} entity used with a non-core shape`,
      );
    }
    assertJsonData(record, budget);
  }
};

/** Validate at the framework contribution boundary, before a producer can
 * resolve the turn or reach provider egress. */
export const validateRetainablePromptPart = (part: PromptPart): void =>
  validateRetainablePromptPartWithBudget(part, createRetainableSourceBudget());

/** One validator per composed stream. This enforces part, record, value and
 * byte ceilings cumulatively at contribution time, rather than waiting for the
 * finalizer after a producer has already populated an oversized draft. */
export const createRetainablePromptPartValidator = ():
  ((part: PromptPart) => void) => {
  const budget = createRetainableSourceBudget();
  return (part): void => validateRetainablePromptPartWithBudget(part, budget);
};

const getAtPath = (root: unknown, path: string): unknown => {
  let current = root;
  for (const segment of path.split('.')) {
    if (segment.length === 0 || UNSAFE_KEYS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const stringLeaves = (
  root: unknown,
  kind: RetainedAliasCandidate['kind'],
): string[] => {
  const out: string[] = [];
  const stack: Array<{
    value: unknown;
    coarseAddressSubtree: boolean;
  }> = [{ value: root, coarseAddressSubtree: false }];
  while (stack.length > 0) {
    const { value, coarseAddressSubtree } = stack.pop()!;
    if (typeof value === 'string') {
      if (value.length > 0 && !coarseAddressSubtree) {
        out.push(value);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const member of value) {
        stack.push({ value: member, coarseAddressSubtree });
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, member] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!UNSAFE_KEYS.has(key)) {
          stack.push({
            value: member,
            coarseAddressSubtree:
              coarseAddressSubtree
              || (
                kind === 'address'
                && ADDRESS_COARSE_KEYS.has(key.toLowerCase())
              ),
          });
        }
      }
    }
  }
  return out;
};

/** D-167 parity for the flat projection. The live path reads the record's
 *  structure to derive the layouts a postcode plausibly appears in
 *  (`Mountain View, CA 94043`) — ledger-only targets that exist because a BARE
 *  postcode is never a match form: `94043` alone is indistinguishable from an
 *  invoice number, and a false identity costs more than a miss.
 *
 *  A flat `{value, kind}` list has no structure, so without this a reharvested
 *  address is strictly WEAKER than a live one — the whole run leaks in prose, and
 *  the postcode either does nothing or (alphanumeric) becomes the lone form D-167
 *  forbids. Emitting the composites as candidates restores the mechanism while
 *  staying inside O-5: they are still `{value, kind}` strings, and multi-token so
 *  they are safe to seed broadly.
 *
 *  ⚠ Not full parity: a composite reaching the packet through the candidate path
 *  allocates a plain `pii.Address<N>`, not the geo-suffixed
 *  `pii.Address<N>.mountain-view.ca` the live `aliasBuilder` emits, so the model
 *  loses region grain on that replaced run. Accepted (owner, 2026-07-24). */
const addressCompositeForms = (value: unknown): readonly string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const parts = piiEgress.readAddressComponents(value as Record<string, unknown>);
  return parts === undefined ? [] : piiEgress.addressMatchForms(parts);
};

const projectedStrings = (
  value: unknown,
  kind: RetainedAliasCandidate['kind'],
): readonly string[] => {
  if (kind === 'address') {
    return [...stringLeaves(value, kind), ...addressCompositeForms(value)];
  }
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  // A tagged list of scalar identifiers is a common schema shape (`emails`,
  // account ids). Do not recurse into object members: a container tagged
  // `name` must never silently retype a descendant `email` as a broad name
  // candidate. Structured-container projection is reserved for addresses.
  return value.filter(
    (member): member is string =>
      typeof member === 'string' && member.length > 0,
  );
};

const projectPacket = (
  packet: PiiAliasableData,
  resolver: piiEgress.FieldPrivacyResolver,
  acceptPath: (path: string) => boolean,
): readonly RetainedAliasCandidate[] => {
  const out: RetainedAliasCandidate[] = [];
  const seen = new Set<string>();
  let retainedBytes = 0;
  const fields = resolver(packet);
  if (!Array.isArray(fields)) {
    throw new Error('chat-pii-source: privacy resolver returned malformed fields');
  }
  for (const field of fields) {
    if (
      field === null
      || typeof field !== 'object'
      || typeof field.path !== 'string'
      || !isEntityFieldPrivacy(field.kind)
      || !acceptPath(field.path)
      // A `content` tag attests free-form prose, not a typed value. Retaining
      // the whole tool result would violate the no-tool-output source rule.
      || field.kind === 'content'
    ) continue;
    for (const value of projectedStrings(
      getAtPath(packet, field.path),
      field.kind,
    )) {
      const key = `${field.kind}\u0000${value}`;
      if (seen.has(key)) continue;
      if (out.length >= MAX_RETAINED_CANDIDATES) {
        throw new Error('chat-pii-source: retained candidate limit exceeded');
      }
      retainedBytes += textEncoder.encode(value).byteLength;
      if (retainedBytes > MAX_SOURCE_BYTES) {
        throw new Error('chat-pii-source: retained candidate byte limit exceeded');
      }
      seen.add(key);
      out.push({ value, kind: field.kind });
    }
  }
  return out;
};

/** The single live-structured-part → flat retained-candidate projector. It
 * never invokes or retains `render`, entity ids, paths, record ids, or shape. */
export const projectEntityPromptPartCandidates = (
  parts: readonly EntityPromptPart[],
  resolver: piiEgress.FieldPrivacyResolver,
): readonly RetainedAliasCandidate[] => {
  const budget = createRetainableSourceBudget();
  const marked: Record<string, unknown>[] = [];
  for (const part of parts) {
    validateRetainablePromptPartWithBudget(part, budget);
    for (const record of part.payload) {
      marked.push({ ...record, [PII_ENTITY_MARKER_KEY]: part.entity });
    }
  }
  return projectPacket(
    marked as PiiAliasableData,
    resolver,
    () => true,
  );
};

/** Project only schema-tagged values from actual tool-dispatch feedback. The
 * recall_context broker result and free-form content-tagged output are excluded. */
export const projectToolDispatchCandidates = (
  packet: PiiAliasableData,
  resolver: piiEgress.FieldPrivacyResolver,
): readonly RetainedAliasCandidate[] =>
  projectPacket(
    packet,
    resolver,
    (path) => path === 'prior_tool_calls' || path.startsWith('prior_tool_calls.'),
  );
