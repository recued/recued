import type { Asset, AssetEvidence, AssetFactSource, AssetReading, AssetRule } from './assets.js';
import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE } from './asset-documents.js';

/** Independent capabilities: none of these types enrolls a maintained index. */
export type AssetFactGroup = 'attributes' | 'settings' | 'dates' | 'readings' | 'observations';
export type AssetFieldRef = { kind: 'field'; asset_id: string; group: AssetFactGroup; field: string };
export type AssetRuleRef = { kind: 'rule'; asset_id: string; rule_id: string };
export type AssetFactContextRoot = AssetFieldRef | AssetRuleRef;
/** D-325 — a calculation over saved numbers, never a rule verdict or forecast. */
export type AssetReadingComparison =
  | { kind: 'compared'; value: number; target: number; unit: string; observed_at: number; relation: 'below' | 'equal' | 'above'; difference?: string }
  | { kind: 'unavailable'; reason: 'unreturned_input' | 'unknown' | 'omitted' | 'invalid_reading' | 'unit_mismatch' | 'future' };
export type AssetWriterDeliveryOutcome = 'accepted' | 'confirmed' | 'unchanged' | 'manual_priority' | 'protected_source' | 'before_handoff' | 'older_observation';
/** Only settled, admitted native submissions for this binding and field.
 * No receipt does not prove no execution; rejected/undispatched calls and
 * pre-receipt history are outside this ledger. No recipe lifecycle claim. */
export type AssetWriterDelivery = { status: 'no_receipt' } | {
  status: 'recorded';
  last_submission: { at: number; observation_at: number; outcome: AssetWriterDeliveryOutcome };
  last_accepted?: { at: number; observation_at: number };
};
export interface AssetFactContextRequest { root: AssetFactContextRoot }
export const ASSET_FACT_CONTEXT_REQUEST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['root'], properties: {
    root: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind', 'asset_id', 'group', 'field'], properties: {
        kind: { const: 'field' }, asset_id: { type: 'string', minLength: 1, maxLength: 2000 },
        group: { enum: ['attributes', 'settings', 'dates', 'readings', 'observations'] }, field: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'asset_id', 'rule_id'], properties: {
        kind: { const: 'rule' }, asset_id: { type: 'string', minLength: 1, maxLength: 2000 }, rule_id: { type: 'string', minLength: 1, maxLength: 500 } } },
    ] },
  },
} as const;

export const parseAssetFactContextRequest = (raw: unknown): AssetFactContextRequest => {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(raw) || Object.keys(raw).some(key => key !== 'root') || !object(raw.root)) throw new Error('Choose an asset fact or rule');
  const root = raw.root;
  if (typeof root.asset_id !== 'string' || !root.asset_id.trim() || root.asset_id.length > 2000) throw new Error('Choose an asset fact or rule');
  if (root.kind === 'rule' && Object.keys(root).every(key => ['kind', 'asset_id', 'rule_id'].includes(key)) && typeof root.rule_id === 'string' && root.rule_id.length > 0 && root.rule_id.length <= 500)
    return { root: { kind: 'rule', asset_id: root.asset_id, rule_id: root.rule_id } };
  if (root.kind === 'field' && Object.keys(root).every(key => ['kind', 'asset_id', 'group', 'field'].includes(key))
    && (root.group === 'attributes' || root.group === 'settings' || root.group === 'dates' || root.group === 'readings' || root.group === 'observations')
    && typeof root.field === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(root.field) && !['constructor', 'prototype', ASSET_DOCUMENT_DETAILS_ATTRIBUTE].includes(root.field))
    return { root: { kind: 'field', asset_id: root.asset_id, group: root.group, field: root.field } };
  throw new Error('Choose an ordinary fact or a saved rule');
};

export type AssetFactContextNode =
  | { ref: AssetFieldRef; kind: 'field'; label: string; value: unknown; known: boolean; source: AssetFactSource | null; value_omitted?: true; source_restricted?: true; future?: true }
  | { ref: AssetRuleRef; kind: 'rule'; title: string; rule: AssetRule }
  | { ref: { kind: 'evidence'; asset_id: string; evidence: AssetEvidence }; kind: 'evidence'; evidence: AssetEvidence }
  | { ref: { kind: 'writer'; asset_id: string; binding_id: string }; kind: 'writer'; name: string; enabled: boolean; delivery?: AssetWriterDelivery };
export type AssetFactContextRef = AssetFactContextNode['ref'];
export interface AssetFactContextEdge {
  from: AssetFactContextRef;
  to: AssetFactContextRef;
  kind: 'uses' | 'supported_by' | 'updated_by';
}
export interface AssetFactContext {
  root: AssetFactContextRoot;
  asset: { id: string; name: string; status?: Asset['status']; source_state?: Asset['sync_state'] };
  nodes: AssetFactContextNode[];
  edges: AssetFactContextEdge[];
  read_at: number;
  /** No cached values: every returned value belongs to this synchronous read. */
  freshness: 'current';
  /** Registered bindings for the input field only. Disabled counts are included
   * when the native registry was checked; their omission cannot prove absence.
   * Writer nodes describe enabled bindings only. This does not prove
   * recipe validity, scheduling or execution. Restricted/unavailable/partial
   * checks cannot establish absence. Manual priority is independent of events. */
  writer_check?: {
    scope: 'enabled_bindings' | 'registered_bindings';
    field: string;
    status: 'complete' | 'partial' | 'restricted' | 'unavailable' | 'not_applicable';
    enabled_count?: number;
    disabled_count?: number;
    /** No current lifecycle, schedule or whole-recipe history is read.
     * Writer nodes can separately carry settled field-submission receipts. */
    execution_status?: 'not_checked';
    manual_priority?: boolean;
  };
  completeness: 'complete' | 'partial';
  omitted: Array<'node_budget' | 'edge_budget' | 'byte_budget' | 'restricted_context' | 'unsupported_value' | 'source_unavailable'>;
  missing: AssetFieldRef[];
}

/** One confirmed copy. Source, target and their receipts are checked atomically.
 * The server mints provenance and the evidence receipt; text is never parsed. */
export interface AssetAttributeReadingCommand {
  action: 'asset.record_attribute_reading';
  id: string;
  request_id: string;
  attribute: string;
  expected_source: { value: string; source: AssetFactSource | null };
  field: string;
  expected_target: { exists: boolean; value: AssetReading | null; source: AssetFactSource | null };
  reading: Omit<AssetReading, 'evidence'>;
}

/** Add support to a saved observation without taking over its writer. */
export interface AssetAddEvidenceCommand {
  action: 'asset.add_evidence';
  id: string;
  path: `${'readings' | 'observations'}.${string}`;
  expected: { value: NonNullable<Asset['readings'][string] | Asset['observations'][string]>; source: AssetFactSource | null };
  evidence: { collection: 'file'; id: string };
  attachment_id: string;
}

export const assetRuleInput = (asset_id: string, rule: AssetRule): AssetFieldRef => ({
  kind: 'field', asset_id, group: rule.when.kind === 'objective' ? 'readings' : rule.when.kind === 'condition' ? 'observations' : 'dates', field: rule.when.field,
});

/** A structured tuple, never a field name concatenated with an asset/rule id. */
export const assetFactRefKey = (ref: AssetFactContextRef): string => ref.kind === 'field'
  ? JSON.stringify([ref.kind, ref.asset_id, ref.group, ref.field]) : ref.kind === 'rule'
    ? JSON.stringify([ref.kind, ref.asset_id, ref.rule_id]) : ref.kind === 'writer'
      ? JSON.stringify([ref.kind, ref.asset_id, ref.binding_id])
      : JSON.stringify([ref.kind, ref.asset_id, ref.evidence.collection, ref.evidence.id, ref.evidence.field ?? null, ref.evidence.value ?? null]);

export const assetFieldValue = (asset: Asset, ref: AssetFieldRef): unknown => Object.hasOwn(asset[ref.group], ref.field) ? asset[ref.group][ref.field] : null;
