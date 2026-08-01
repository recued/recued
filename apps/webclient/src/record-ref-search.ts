/** The `record_ref` picker's inventory read.
 *
 *  ⛔⛔ EXTRACTED BECAUSE IT WAS A CLOSURE INSIDE `webclient-bootstrap`, AND THAT
 *  IS WHERE THE BUG LIVED. It read the 50 lowest ids once per keystroke and
 *  filtered them in the browser, so a record at row 51 was unreachable — and
 *  indistinguishable from one that does not exist, because the dropdown said
 *  "No matches" and stopped there. A user reads that as a fact about their data.
 *  Nothing could test it: the picker's own tests see a stubbed caller, and the
 *  real one was unreachable from anywhere.
 *
 *  ⚠ TWO READS, AND THE SERVER ONE ONLY ADDS REACH — IT CANNOT REPLACE THE
 *  LOCAL FILTER. The cached page answers the common case exactly: substring,
 *  case-insensitive, one fetch. The server can reach PAST that page, but only
 *  through `prefix`, which is the sole text predicate and is compiled to a
 *  `COLLATE BINARY` range — so it is byte-exact and CASE-SENSITIVE. "business"
 *  does not find "Business bank" on the server, and "bank" never will.
 *
 *  ⇒ so the two are unioned, never swapped: dropping the local filter in favour
 *  of the server would LOSE matches inside the page that the user can see today.
 *  And `truncated` stays keyed on the page being capped even after a successful
 *  server read, because a case-variant or mid-string match beyond the page is
 *  still missable. Over-disclosing is safe here; under-disclosing was the bug.
 *
 *  ⚠ Not every entity can be asked by name: `records.search` admits only the
 *  fields a pack declared in `filter_fields`, and 21 of 37 search bindings have
 *  no label-ish field to declare. The server read is attempted once and, if the
 *  binding refuses it, is not attempted again for that picker.
 */
import { RECORDS_MAX_PAGE_SIZE } from '@recued/contracts';
import type { RefPicker } from '@recued/ui-shared';

/** Fields tried, in order, for a human-readable label. */
export const RECORD_REF_LABEL_FIELDS = ['name', 'label', 'title'] as const;

export interface RecordRefSearchDeps {
  /** `records.search` — narrowed to what this module actually calls. */
  search: (args: {
    owner: { publisher: string; pack_slug: string };
    entity: string;
    limit: number;
    filters?: Record<string, { op: 'eq' | 'prefix'; value: string }>;
  }) => Promise<{ records?: Array<Record<string, unknown>> }>;
}

/** Optional equality scope from a `record_ref` variable or editable column.
 * Presentation-only: the operation still validates the selected reference. */
export type RecordRefEqualityScope = Readonly<Record<string, string>>;

/** The app-level builder before it is bound to one pack owner. */
export type RecordRefSearchBuilder = (
  owner: { publisher: string; pack_slug: string },
  entity: string,
  scope?: RecordRefEqualityScope,
) => RefPicker.RefPickerSearchCaller;

/** Bind the global Records reader to the pack that owns a recipe.
 *
 * Standalone recipes have no Records namespace, so they deliberately keep the
 * raw-id fallback. Centralizing this parse keeps Recipes, Packs, Chat, and any
 * future Run-modal host from inventing subtly different bundle rules. */
export const bindRecordRefSearchToRecipe = (
  build: RecordRefSearchBuilder | undefined,
  recipe: { metadata?: { recipe_bundle?: unknown } } | undefined,
): ((
  entity: string,
  scope?: RecordRefEqualityScope,
) => RefPicker.RefPickerSearchCaller) | undefined => {
  if (build === undefined) return undefined;
  const bundle = recipe?.metadata?.recipe_bundle;
  if (typeof bundle !== 'string') return undefined;
  const parts = bundle.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined;
  const owner = { publisher: parts[0]!, pack_slug: parts[1]! };
  return (entity, scope = {}) => build(owner, entity, scope);
};

/** Mirrors `canonicalRef` in the records store: exactly one slash, a
 *  lowercase-snake kind before it, a non-empty id after. */
const REF_VALUE = /^[a-z][a-z0-9_]*\/[^/]+$/;

/** ⛔⛔ A REF IS NOT A LABEL, AND THE FALLBACK USED TO PICK ONE. It took the
 *  first non-id string field, and in most warehouse schemas the refs are
 *  declared first — so 13 of 21 label-less entities would have shown the user
 *  `contract/abc` as the NAME of the row. `expense-ledger.expense` is the
 *  sharpest: `merchant` is right there and filterable, and the picker displayed
 *  `source_ref`.
 *
 *  ⚠ Detected two ways because neither alone is enough: the `_ref` suffix is a
 *  naming convention (misses `ancestor` / `descendant`), and the value shape is
 *  the store's own canonical form (catches those). A projected record carries no
 *  type information, so there is nothing more authoritative to read.
 *
 *  ⚠ A genuine label containing exactly one slash and starting lowercase
 *  ("acme/co") is skipped by this. That costs a better label; it never shows a
 *  wrong one, and the id remains under it either way. */
const isRefLike = (key: string, value: string): boolean =>
  key.endsWith('_ref') || REF_VALUE.test(value);

/** The KEY a row's label came from — the field to ask the server about.
 *
 *  ⛔⛔ SEARCH THE FIELD YOU DISPLAY. Asking the server about `name` while the
 *  list shows `memo` would answer a question the user did not ask, and would
 *  make every entity whose handle is not literally called "name" un-searchable
 *  — which is most of them: `ledger-book.leg` is found by its memo, an invoice
 *  by its client, a photo by its filename. */
const labelKeyOf = (record: Record<string, unknown>): string | null => {
  const named = RECORD_REF_LABEL_FIELDS
    .find((field) => typeof record[field] === 'string' && (record[field] as string).trim() !== '');
  if (named !== undefined) return named;
  return Object.entries(record)
    .find((entry): entry is [string, string] => entry[0] !== 'id'
      && !entry[0].startsWith('_') && typeof entry[1] === 'string'
      && entry[1].trim() !== '' && !isRefLike(entry[0], entry[1]))?.[0] ?? null;
};

/** Project one warehouse row to a picker option. */
const toOption = (record: Record<string, unknown>): RefPicker.RefPickerOption | null => {
  const id = typeof record.id === 'string' ? record.id : '';
  if (id === '') return null;
  const named = RECORD_REF_LABEL_FIELDS
    .map((field) => record[field])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const strings = Object.entries(record)
    .filter((entry): entry is [string, string] => entry[0] !== 'id'
      && !entry[0].startsWith('_') && typeof entry[1] === 'string' && entry[1].trim() !== '');
  // ⛔ Falls back to the row's OWN id, never to a ref pointing at some other
  // row: `contract/abc` reads as this row's identity and is not.
  const label = named ?? strings.find(([k, v]) => !isRefLike(k, v))?.[1] ?? id;
  // No point printing the id twice when it is already the label.
  return label === id ? { id, label } : { id, label, sublabel: id };
};

/** One picker's reader. The page is fetched ONCE and filtered per keystroke —
 *  the request never depended on the query, so re-issuing it per keystroke only
 *  got more wasteful as the page grew. A failed load is not cached, so the next
 *  keystroke retries rather than latching the error for the picker's life. */
export const createRecordRefSearchCaller = (deps: RecordRefSearchDeps) => (
  owner: { publisher: string; pack_slug: string },
  entity: string,
  scope: RecordRefEqualityScope = {},
): ((query: string) => Promise<RefPicker.RefPickerSearchPage>) => {
  const scopeFilters = Object.fromEntries(Object.entries(scope).map(([field, value]) => [
    field, { op: 'eq' as const, value },
  ]));
  let page: Promise<{
    options: RefPicker.RefPickerOption[]; truncated: boolean; labelField: string | null;
  }> | null = null;
  const load = (): Promise<{
    options: RefPicker.RefPickerOption[]; truncated: boolean; labelField: string | null;
  }> => {
    page ??= deps.search({
      owner,
      entity,
      limit: RECORDS_MAX_PAGE_SIZE,
      ...(Object.keys(scopeFilters).length > 0 ? { filters: scopeFilters } : {}),
    })
      .then((result) => {
        const records = result.records ?? [];
        return {
          options: records
            .map(toOption)
            .filter((o): o is RefPicker.RefPickerOption => o !== null),
          // ⛔ A FULL page means "there may be more", not "there are more" — the
          // read cannot tell the difference and the wording must not either.
          truncated: records.length >= RECORDS_MAX_PAGE_SIZE,
          // Read off the data rather than assumed, and it is the SAME choice
          // `toOption` displays — an entity with no usable handle (every string
          // is a ref) simply gets no server reach.
          labelField: records.map(labelKeyOf).find((k) => k !== null) ?? null,
        };
      })
      .catch((err: unknown) => { page = null; throw err; });
    return page;
  };
  // Set once the binding has refused a label filter — asking again every
  // keystroke would spend a failed round trip to learn the same thing.
  let serverSearchUnavailable = false;

  /** Reach PAST the cached page. Returns [] when it cannot — an unusable
   *  server read must degrade to the local answer, never to an error. */
  const beyondPage = async (
    query: string, labelField: string | null, truncated: boolean,
  ): Promise<RefPicker.RefPickerOption[]> => {
    // ⛔ ONLY when the page was capped. If the whole inventory fitted, the local
    // answer is already complete and a round trip per keystroke buys nothing —
    // which is the cost the cached page exists to avoid. This gate is why the
    // common case is still exactly one read for the picker's life.
    if (
      !truncated
      || labelField === null
      || Object.prototype.hasOwnProperty.call(scopeFilters, labelField)
      || serverSearchUnavailable
      || query === ''
    ) return [];
    try {
      const result = await deps.search({
        owner, entity, limit: RECORDS_MAX_PAGE_SIZE,
        filters: {
          ...scopeFilters,
          [labelField]: { op: 'prefix', value: query },
        },
      });
      return (result.records ?? [])
        .map(toOption)
        .filter((o): o is RefPicker.RefPickerOption => o !== null);
    } catch {
      serverSearchUnavailable = true;
      return [];
    }
  };

  return async (query: string) => {
    const { options, truncated, labelField } = await load();
    const raw = query.trim();
    if (raw === '') return { options, truncated };
    const needle = raw.toLowerCase();
    const local = options.filter((option) => option.label.toLowerCase().includes(needle)
      || option.id.toLowerCase().includes(needle));
    const remote = await beyondPage(raw, labelField, truncated);
    // Union, local first — the page is what the user has already been shown, so
    // its order is the one they are reading. Dedupe on id, not label: two
    // records may legitimately share a name.
    const seen = new Set(local.map((o) => o.id));
    return {
      options: [...local, ...remote.filter((o) => !seen.has(o.id))],
      truncated,
    };
  };
};
