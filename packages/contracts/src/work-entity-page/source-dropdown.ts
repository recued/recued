/** D-145 PA6 — Source dropdown options builder.
 *
 *  Pure: given the active kind + the registered Source rows for that
 *  kind, return the dropdown option list — All-Sources sentinel
 *  prepended, then registered Sources in registration order.
 *
 *  Spec: D-145 § A.2.2 (resolver behavior — `data.<kind>.*`
 *  polymorphic across all registered Sources for that kind).
 */

import {
  RECUED_BUILTIN_SOURCE_ID,
  type SourceRegistration,
} from '../source-primitive.js';
import type { WorkEntityKind } from '../work-entities.js';
import {
  SOURCE_DROPDOWN_ALL_VALUE,
  type SourceDropdownOption,
} from './types.js';

/** Static label for the All-Sources sentinel option. */
export const SOURCE_DROPDOWN_ALL_LABEL = 'All Sources';

/** Build dropdown options for a kind. The All-Sources sentinel is
 *  always first; registered Sources follow in registration order
 *  (caller is responsible for filtering to the kind — this function
 *  is permissive on `sources` and only honors entries whose
 *  `top_tier_kind` matches `kind`).
 *
 *  When zero registered Sources match the kind, the dropdown still
 *  carries the All-Sources sentinel — collapsing the list to nothing
 *  would break the dropdown invariant (the page-level "no Sources"
 *  empty state is rendered separately based on `sources.length`).
 */
export const buildSourceDropdownOptions = (
  kind: WorkEntityKind,
  sources: readonly SourceRegistration[],
): readonly SourceDropdownOption[] => {
  const matched = sources.filter((s) => s.top_tier_kind === kind);
  const sentinel: SourceDropdownOption = {
    id: SOURCE_DROPDOWN_ALL_VALUE,
    label: SOURCE_DROPDOWN_ALL_LABEL,
    source_kind: 'sentinel',
    write_capable: false,
  };
  return [
    sentinel,
    ...matched.map<SourceDropdownOption>((s) => ({
      id: s.id,
      label: s.source_label,
      source_kind: s.source_kind,
      write_capable: s.write_capable,
    })),
  ];
};

/** Resolve the Source id the create dialog should default to.
 *
 *  Order of preference:
 *    1. `selected_source_id` — the dropdown selection IS the explicit id.
 *    2. The Recued built-in Source for the kind (`recued.<kind>`), if
 *       registered.
 *    3. The first write-capable registered Source.
 *    4. `null` if no Source is write-capable — caller's create-button
 *       affordance should be hidden in that case.
 *
 *  ⛔ There was a per-kind default-Source step between 1 and 2. It is gone
 *  (D-187 Sources half): write is always source-aware by id, and nothing
 *  infers a destination from stored state. */
export const resolveCreateDialogSourceId = (
  kind: WorkEntityKind,
  selected_source_id: string | null,
  sources: readonly SourceRegistration[],
): string | null => {
  const registered = sources.filter((s) => s.top_tier_kind === kind);
  const writeCapable = registered.filter((s) => s.write_capable);
  if (writeCapable.length === 0) return null;

  const isWriteCapable = (id: string): boolean =>
    writeCapable.some((s) => s.id === id);

  if (selected_source_id !== null && isWriteCapable(selected_source_id)) {
    return selected_source_id;
  }
  // ⛔ No stored default step (D-187 Sources half) — the dropdown SELECTION is
  // the explicit id, and absent that the local built-in wins.
  const builtinId = RECUED_BUILTIN_SOURCE_ID(kind);
  if (isWriteCapable(builtinId)) return builtinId;
  return writeCapable[0]?.id ?? null;
};

/** Map from a dropdown option id to the page-state `selected_source_id`
 *  shape — `null` for All-Sources, verbatim for concrete Sources.
 *  Returns `undefined` when the id is not in the dropdown options
 *  (caller should reject the selection rather than silently flipping
 *  to All-Sources). */
export const dropdownIdToSelectedSourceId = (
  id: string,
  options: readonly SourceDropdownOption[],
): string | null | undefined => {
  if (id === SOURCE_DROPDOWN_ALL_VALUE) return null;
  const found = options.find((opt) => opt.id === id);
  if (found === undefined) return undefined;
  return found.id;
};

/** Inverse of `dropdownIdToSelectedSourceId` — produces the dropdown
 *  option id that corresponds to the page-state's
 *  `selected_source_id` (`SOURCE_DROPDOWN_ALL_VALUE` when null). */
export const selectedSourceIdToDropdownId = (
  selected_source_id: string | null,
): string =>
  selected_source_id === null ? SOURCE_DROPDOWN_ALL_VALUE : selected_source_id;
