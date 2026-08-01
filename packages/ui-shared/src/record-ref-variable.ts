/** Shared `record_ref` variable wiring.
 *
 * `renderVariableWidget` owns the pure shell and this module owns the one DOM
 * upgrade from that shell to a searchable name -> stored-id control. Keeping
 * the upgrade here prevents every modal from re-implementing entity scoping,
 * hidden-input synchronization, and best-effort label hydration.
 */

import type { VariableDefault } from '@recued/contracts';

import {
  RECORD_REF_VARIABLE_ATTR,
  recordRefVariablePickerId,
  toWidgetShape,
} from './variable-widgets.js';
import {
  asRefPickerSearchPage,
  wireRefPicker,
  type RefPickerHandle,
  type RefPickerSearchCaller,
} from './ref-picker/index.js';

/** Build a search caller for one entity, optionally narrowed by equality
 * filters declared on the variable. The filter is discovery UX, not auth. */
export type RecordRefVariableSearch = (
  entity: string,
  scope?: Readonly<Record<string, string>>,
) => RefPickerSearchCaller;

export interface WireRecordRefVariablesOptions {
  variables: Readonly<Record<string, VariableDefault>>;
  /** Current overrides. A missing key falls back to the variable's default. */
  values?: Readonly<Record<string, unknown>>;
  /** Must match the prefix used when rendering the variable shells. */
  idPrefix?: string;
  search: RecordRefVariableSearch;
  /** Receives the committed owner-local record id, or `''` when cleared. */
  onChange(key: string, value: string): void;
}

interface QueryableParent {
  querySelector(selector: string): Element | null;
}

/** Attach every rendered `record_ref` variable under `root`.
 *
 * Missing shells are expected: invoke surfaces omit non-invocation variables,
 * and string-only test DOMs do not parse rendered HTML. In both cases this
 * returns only the handles it genuinely attached. */
export const wireRecordRefVariables = (
  root: ParentNode,
  options: WireRecordRefVariablesOptions,
): RefPickerHandle[] => {
  const queryable = root as unknown as Partial<QueryableParent>;
  if (typeof queryable.querySelector !== 'function') return [];

  const handles: RefPickerHandle[] = [];
  const values = options.values ?? {};
  const idPrefix = options.idPrefix ?? 'variable';
  // One form can name the same inventory more than once (move-tag has source
  // and destination tag fields). The search caller owns its page cache, so
  // reuse it for identical entity/scope pairs instead of reading that page once
  // per input.
  const searches = new Map<string, RefPickerSearchCaller>();

  for (const [key, definition] of Object.entries(options.variables)) {
    // Variable keys are contract-validated, but keep selectors inert for an
    // old/unvalidated artifact rather than interpolating arbitrary CSS.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const override = Object.prototype.hasOwnProperty.call(values, key)
      ? values[key]
      : undefined;
    const shape = toWidgetShape(key, definition, override);
    if (shape.type !== 'record_ref' || shape.entity === undefined || shape.entity === '') {
      continue;
    }

    const row = queryable.querySelector(
      `[${RECORD_REF_VARIABLE_ATTR}="${key}"]`,
    ) as HTMLElement | null;
    if (row === null || typeof row.querySelector !== 'function') continue;
    const pickerId = recordRefVariablePickerId(key, idPrefix);
    if (row.querySelector(`[data-ref-picker="${pickerId}"]`) === null) continue;

    const hidden = row.querySelector(
      `[data-var-key="${key}"]`,
    ) as HTMLInputElement | null;
    const raw = typeof shape.value === 'string' && shape.value.length > 0
      ? shape.value
      : '';
    const scope = shape.entityFilter ?? {};
    const searchKey = JSON.stringify([
      shape.entity,
      Object.entries(scope).sort(([left], [right]) => left.localeCompare(right)),
    ]);
    let search = searches.get(searchKey);
    try {
      if (search === undefined) {
        search = options.search(shape.entity, scope);
        searches.set(searchKey, search);
      }
    } catch {
      // One invalid/temporarily unavailable inventory must not prevent the
      // rest of the editor from mounting; this row retains its raw-id value.
      continue;
    }
    if (search === undefined) continue;
    const picker = wireRefPicker(row, {
      search,
      config: {
        pickerId,
        placeholder: `Search ${shape.entity.replace(/_/g, ' ')}`,
        ariaLabel: `Choose ${shape.label}`,
        emptyText: 'No matching records.',
      },
      minChars: 0,
      initialValue: raw === '' ? null : { id: raw, label: raw },
      onChange: (selection) => {
        const value = selection?.id ?? '';
        if (hidden !== null) hidden.value = value;
        options.onChange(key, value);
      },
    });
    handles.push(picker);

    // The renderer cannot know a stored id's display label. Resolve it once
    // after mounting, but only relabel if the same id is still selected: a slow
    // hydration must never overwrite a choice the owner made meanwhile.
    if (raw !== '') {
      const entityPrefix = `${shape.entity}/`;
      const lookup = raw.startsWith(entityPrefix)
        ? raw.slice(entityPrefix.length)
        : raw;
      void Promise.resolve()
        .then(() => search(lookup))
        .then((result) => {
          const current = picker.getValue();
          if (
            current?.id !== raw
            || current.label !== raw
            || picker.getQuery() !== raw
          ) return;
          const exact = asRefPickerSearchPage(result).options.find(
            (candidate) => candidate.id === raw || candidate.id === lookup,
          );
          if (exact !== undefined && exact.label !== '') {
            // Keep the stored value byte-for-byte; this pass improves only what
            // the owner sees in the text field.
            picker.setValue({ id: raw, label: exact.label });
          }
        })
        .catch(() => { /* Best effort: the raw id remains honest fallback text. */ });
    }
  }

  return handles;
};
