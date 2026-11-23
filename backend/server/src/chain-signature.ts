/** D-348 — what one held call of a chain is (Q3), read from its checkpoint as the resumer holds it.
 *
 *  Its operation, and the values that say whom it reaches and what it changes: the identifying
 *  fields the grounding check reads (`IDENTIFIER_FIELDS`), plus any value shaped like an email
 *  address wherever it sits (an invite's guests). A chat write that creates something in Recued
 *  pins nothing (Q3: "creating inside Recued stays free"); a delete pins nothing either, because
 *  its record is checked when it runs (Q7).
 *
 *  ⛔ UNREADABLE IS NOT EMPTY. A hold this cannot name (a held `foreach` whose one approval covers
 *  several calls, a checkpoint with no operation) has no signature at all, never a looser one: a
 *  call that is not on a chain asks. Nor has a gateway's hold no chain may stand in for
 *  (`chainMayStandIn`, the gates' own check: an action set to "always ask", a review given each
 *  time, a browser upload), so it is never offered on one (§5.1). Nor a delete whose operation
 *  declares no record argument (slice 6): the gate lets a delete through only for a record the
 *  run found, so one it cannot check is on no chain. */

import {
  chainMayStandIn,
  triggerPreapprovalTier1Op,
  type ChainCallSignature,
  type Checkpoint,
} from '@recued/contracts';
import { readForeachCover } from '@recued/gateway';

import { heldArgs } from './ask-card-held-op-details.js';
import { ownDeleteRecord } from './chain-own-records.js';
import { holdCoversSeveralItems } from './foreach-approval-items.js';
import { EMAIL_SHAPE, IDENTIFIER_FIELDS } from './tool-argument-grounding.js';

/** The chat's own writes that create something in Recued: they pin nothing. A contact added (not
 *  changed) and an event on Recued's own calendar are creates too (`chainCallSignatureOf`). */
const CHAT_CREATES_IN_RECUED: ReadonlySet<string> = new Set([
  'work.create', 'memory.write', 'episode.record', 'recipe.schedule',
]);

/** A field's name without its place in a list: `to[1]` → `to`, `attendees[0].email` →
 *  `attendees.email`. */
const fieldOf = (path: string): string => path.replace(/\[\d+\]/g, '');
const leafOf = (path: string): string => (fieldOf(path).split('.').pop() ?? '');

/** Every identifying value in `args`, by field, sorted and without repeats. An address is read
 *  case-blind, as mail is; an id keeps its case. */
export const chainCallPins = (
  args: unknown,
  only: (field: string, value: string) => boolean = () => true,
): Record<string, string[]> => {
  const pins = new Map<string, Set<string>>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 8) return;
    if (typeof node === 'string' || (typeof node === 'number' && Number.isFinite(node))) {
      const raw = String(node).trim();
      if (raw === '') return;
      const email = EMAIL_SHAPE.test(raw);
      if (!email && !IDENTIFIER_FIELDS.test(leafOf(path))) return;
      const field = fieldOf(path);
      const value = email ? raw.toLowerCase() : raw;
      if (!only(field, value)) return;
      const values = pins.get(field) ?? new Set<string>();
      pins.set(field, values.add(value));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${String(i)}]`, depth + 1));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        visit(value, path === '' ? key : `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(args, '', 0);
  return Object.fromEntries([...pins.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([field, values]) => [field, [...values].sort()]));
};

const isEmailField = (_field: string, value: string): boolean => EMAIL_SHAPE.test(value);

/** A chat write's signature, from its tool and arguments: what its hold records and what its gate
 *  matches (slice 4). ⛔ None for a write "Allow in this chat" cannot name, which includes a save
 *  the owner is asked about every time (one they marked wrong, D-198 §13): it is never on a
 *  chain. */
export const chainTier1Signature = (tool: string, args: unknown): ChainCallSignature | undefined => {
  const kind = triggerPreapprovalTier1Op(tool, args);
  if (kind === undefined) return undefined;
  const op = `tier1:${kind}`;
  if (CHAT_CREATES_IN_RECUED.has(tool) || kind === 'contact.write:add') return { op, pins: {} };
  // An event on Recued's own calendar stays in Recued, but an invitation reaches its guests.
  if (kind === 'calendar.create:local') return { op, pins: chainCallPins(args, isEmailField) };
  return { op, pins: chainCallPins(args) };
};

/** A recipe step's call: its recipe and version, its ingredient, operation and connection (as its
 *  gate records them on the hold), and its pins, or none for a delete. One builder for the hold's
 *  record and the gate's match (slice 5), so the two cannot drift apart. */
export const chainStepSignature = (call: {
  readonly recipe_id: string;
  readonly recipe_source_hash?: string;
  readonly ingredient: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly destructive: boolean;
  readonly args: unknown;
}): ChainCallSignature => {
  const op = `step:${call.recipe_id}@${call.recipe_source_hash ?? ''}|${call.ingredient}`
    + `|${call.operation_id ?? ''}|${call.connection_name ?? ''}`;
  return call.destructive ? { op, pins: {}, delete: true } : { op, pins: chainCallPins(call.args) };
};

/** A pack action the chat called directly (a raw op): its catalog, its operation (the pack's own
 *  name for it, as the hold records it) and its connection, and its pins, or none for a delete. One
 *  builder for the hold's record and the gate's match (slice 5). */
export const chainRawOpSignature = (call: {
  readonly catalog_slug: string;
  readonly operation: string;
  readonly connection_name?: string;
  readonly destructive: boolean;
  readonly args: unknown;
}): ChainCallSignature => {
  const op = `op:${call.catalog_slug}|${call.operation}|${call.connection_name ?? ''}`;
  return call.destructive ? { op, pins: {}, delete: true } : { op, pins: chainCallPins(call.args) };
};

/** What naming a held call reads beyond its hold. */
export interface ChainSignatureContext {
  /** D-348 slice 6 — the argument a pack action's operation names the record it deletes by (D-254
   *  `record_id_arg`), looked up by catalog and operation (its key or its qualified id); undefined
   *  when it declares none, or the call is no pack action's. */
  readonly deleteRecordArg?: (slug: string, operation: string) => string | undefined;
}

/** The signature of the call a checkpoint holds, or `undefined` when it cannot be named. */
export const chainCallSignatureOf = (
  checkpoint: Checkpoint,
  context: ChainSignatureContext = {},
): ChainCallSignature | undefined => {
  const several = holdCoversSeveralItems(checkpoint);
  const args = heldArgs(checkpoint);
  const raw = checkpoint.raw_op;
  if (raw?.tier1_tool !== undefined) return several ? undefined : chainTier1Signature(raw.tier1_tool, args);
  const provenance = checkpoint.preflight_context?.authorization_provenance;
  if (raw !== undefined) {
    if (several) return undefined;
    if (!chainMayStandIn({ slug: raw.catalog_slug, risk_tier: raw.risk_tier, provenance, args })) return undefined;
    if (raw.risk_tier === 'destructive' && context.deleteRecordArg?.(raw.catalog_slug, raw.operation) === undefined) {
      return undefined;
    }
    return chainRawOpSignature({
      catalog_slug: raw.catalog_slug,
      operation: raw.operation,
      ...(raw.connection_name !== undefined ? { connection_name: raw.connection_name } : {}),
      destructive: raw.risk_tier === 'destructive',
      args,
    });
  }
  const target = checkpoint.approved_target;
  const ingredient = target?.ingredient_slug ?? checkpoint.preflight_context?.tool_slug;
  if (checkpoint.recipe_id === undefined || ingredient === undefined) return undefined;
  const risk_tier = checkpoint.preflight_context?.risk_tier;
  // Slice 6b — a held loop of deletes is one call however many items it covers: a delete pins
  // nothing, and each item is checked against what its run found as it runs. Any other loop is not.
  if (several && risk_tier !== 'destructive') return undefined;
  if (!chainMayStandIn({ slug: ingredient, ...(risk_tier !== undefined ? { risk_tier } : {}), provenance, args })) {
    return undefined;
  }
  // A delete only where its record can be checked: a pack action's declared record (the catalog
  // gate's hold names its operation), or one of Recued's own on the closed list (slice 6b). A held
  // loop's step keeps no state of its own: its calls are on its cover, each as its approval lists
  // it, and every one must name its record (none listed: it is not named).
  const ownDelete = (): boolean => {
    if (!several) return ownDeleteRecord(ingredient, args) !== undefined;
    const items = readForeachCover(checkpoint.preflight_context?.foreach_cover)?.items ?? [];
    return items.length > 0 && items.every((item) => ownDeleteRecord(ingredient, item.args_preview) !== undefined);
  };
  if (risk_tier === 'destructive' && !(target?.operation_id !== undefined
    ? context.deleteRecordArg?.(ingredient, target.operation_id) !== undefined
    : ownDelete())) return undefined;
  return chainStepSignature({
    recipe_id: checkpoint.recipe_id,
    ...(checkpoint.recipe_source_hash !== undefined ? { recipe_source_hash: checkpoint.recipe_source_hash } : {}),
    ingredient,
    ...(target?.operation_id !== undefined ? { operation_id: target.operation_id } : {}),
    ...(target?.connection_name !== undefined ? { connection_name: target.connection_name } : {}),
    destructive: checkpoint.preflight_context?.risk_tier === 'destructive',
    args,
  });
};
