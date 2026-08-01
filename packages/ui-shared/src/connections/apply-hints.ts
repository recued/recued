/** D-223 Slice 1 — apply a pack's connection hints to initial form state.
 *
 *  A hint sets a VALUE on a field the owner can see and change. This module is
 *  where that sentence becomes enforcement, because two of its conditions are not
 *  structural:
 *
 *  1. **The field must be visible and editable.** A registered vendor schema may
 *     mark a field `hidden` or `readonly` — Microsoft fixes its Graph base — and a
 *     hint landing on one of those would set a value the owner never sees. That is
 *     the exact boundary the decision draws, so such a hint is DROPPED.
 *  2. **The value must still be admissible.** An installed pack may predate a
 *     tightening of the filter, so admission is re-checked here rather than
 *     trusted from publish time.
 *
 *  Everything else holds by construction: this returns values to merge into form
 *  state and cannot reach the schema, so no hint can make a field appear, vanish,
 *  or lock. D-223 § 2 / § 2.1. */

import { canApplyConnectionSetupGuideSuggestion, type ConnectionHint } from '@recued/contracts';

import type { ConnectionField, ConnectionSchema } from '../connection-schemas/types.js';

/** One value a hint actually placed, with the publisher that suggested it.
 *  Provenance rides along so the form can attribute it (Slice 2) — it is a
 *  display fact, never stored on the enrolled connection. */
export interface AppliedConnectionHint {
  key: string;
  value: string;
  publisher: string;
}

export interface ConnectionHintSource {
  publisher: string;
  hints: readonly ConnectionHint[];
}

/** A field is hint-targetable when the schema renders it AND lets the owner edit
 *  it. `showWhen` is deliberately NOT evaluated here: it is a function of live
 *  form values, and seeding runs before the owner has produced any. A value whose
 *  field is currently hidden by a predicate is simply not projected at submit,
 *  which is the existing behaviour for every seeded default. */
const targetable = (field: ConnectionField | undefined): boolean =>
  field !== undefined && field.hidden !== true && field.readonly !== true;

/** The values a set of packs' hints contribute for one connection slug.
 *
 *  Later sources do not overwrite earlier ones: two packs hinting the same field
 *  is a conflict with no principled winner, so the first admitted value stands and
 *  the owner adjusts. Silently preferring whichever pack sorted last would make
 *  the outcome depend on install order.
 */
export const applyConnectionHints = (
  schema: ConnectionSchema | undefined,
  sources: readonly ConnectionHintSource[],
  connection: string,
): AppliedConnectionHint[] => {
  if (schema === undefined || connection.length === 0) return [];
  const byKey = new Map<string, ConnectionField>();
  for (const field of schema.fields) byKey.set(field.key, field);

  const applied: AppliedConnectionHint[] = [];
  const taken = new Set<string>();

  for (const source of sources) {
    for (const hint of source.hints) {
      if (hint?.connection !== connection) continue;
      const values = hint.values;
      if (values == null || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values)) {
        if (taken.has(key)) continue;
        if (typeof value !== 'string') continue;
        if (!targetable(byKey.get(key))) continue;
        if (!canApplyConnectionSetupGuideSuggestion(key, value)) continue;
        taken.add(key);
        applied.push({ key, value, publisher: source.publisher });
      }
    }
  }
  return applied;
};

/** The merge-ready form-value patch. Separate from {@link applyConnectionHints}
 *  so a caller can seed the form and keep the provenance for display. */
export const connectionHintValues = (
  applied: readonly AppliedConnectionHint[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of applied) out[key] = value;
  return out;
};

/** Which connection a hinting pack should DISCLOSE in its install dialog, if any.
 *
 *  ⚠ DISCLOSURE, NOT A ROUTE — and this docstring used to say otherwise. It
 *  claimed the hint path was "otherwise unreachable" for third-party publishers,
 *  because the install dialog's Connect section renders only for a
 *  `connection_requirements` descriptor and the kind-picker's vendor preset cards
 *  were retired (R13). A live-server run on 2026-07-30 falsified it: the pack
 *  DETAIL's Connections row already deep-links to the enroll form
 *  (`connections-readiness-controls`, pre-dating D-223) and renders for a
 *  hint-only pack. Reachability was never missing; disclosure was.
 *
 *  The link this once justified was worse than redundant. Hints are sourced from
 *  INSTALLED packs, so a link fired from the install dialog — where the pack is by
 *  definition not installed — reached a blank, unattributed form. See
 *  `packs-install-dialog.ts` → `renderConnectionHintDisclosure`.
 *
 *  Returns undefined when a descriptor is present: that pack already has the
 *  Connect section, and a hint must never add adoption to it. Returns undefined
 *  when there are no hints, because naming a connection the pack suggested
 *  nothing for tells the owner nothing.
 */
export const connectionHintSetupSlug = (
  hints: readonly ConnectionHint[] | undefined,
  hasConnectionRequirement: boolean,
): string | undefined => {
  if (hasConnectionRequirement) return undefined;
  const first = hints?.find((h) => typeof h?.connection === 'string' && h.connection.length > 0);
  return first?.connection;
};
