/** THE ONE DEFINITION of what text `work.search`'s `query` matches against.
 *
 *  ⛔ WHY THIS IS ITS OWN MODULE. Three places need the same answer and they
 *  sit on opposite sides of the storage boundary:
 *    1. `work-entity-store.ts` indexes it into the FTS table on every write.
 *    2. `work-entity-read-tools.ts` indexes READ-THROUGH items — live vendor
 *       records that never touch local storage — into a throwaway index so
 *       they are matched by the same rule.
 *    3. Tests assert the two agree.
 *  A second copy of this mapping is the whole failure: an index built over
 *  `title + body` and a matcher reading `title` alone diverge silently, and the
 *  only symptom is a record that is findable from one Source and not another.
 *
 *  An asset is also matched by its holder's name, which a search adds for the
 *  caller that may read it (`assetSearchableText`) and the index never holds,
 *  and by the values it can share with other things (`assetSharedValues`).
 *
 *  ⚠ The long-text field is per-kind and `booking` HAS NONE — its `title` is a
 *  short label and it carries no prose column. That is the same reasoning
 *  `workEntityLongText` records in `work-entity-read-resolution.ts`; this module
 *  cannot import that one (it takes a materialized `WorkEntity`, and the store
 *  indexes at WRITE time from the write input), so the two are kept in step by
 *  `work-entity-searchable-text.test.ts` rather than by a shared call. */

import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, ASSET_SEARCH_TERMS, assetSearchTerms, type WorkEntityKind } from '@recued/contracts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** `source_extension_blob.preview.*` string fields. Mirrors `previewFields` in
 *  `work-entity-read-resolution.ts`, defensively over the open blob shape, and
 *  additionally accepts the blob still in its stored JSON-string form — the
 *  reindex walker reads columns raw and never parses rows. */
const previewLaneStrings = (blob: unknown): string[] => {
  const parsed = typeof blob === 'string'
    ? ((): unknown => { try { return JSON.parse(blob); } catch { return null; } })()
    : blob;
  if (!isRecord(parsed) || !isRecord(parsed.preview)) return [];
  return Object.values(parsed.preview).filter((v): v is string => typeof v === 'string');
};

/** D-325 (2026-10-25) — what several things can have in common, so that one search finds
 *  every one: where it is kept (a place's name), each detail by its name and value, and
 *  each identifier with its scheme (a car's VIN, and the policy that names it). A detail
 *  set to `false` says the thing is NOT that, so it adds nothing.
 *
 *  ⛔ Never an address or coordinates, a document's details, or the numbers the chat keeps
 *  from its model (`document_number`, `serial_number`, `exact_address`): an index answers
 *  every caller alike. Reads a materialized asset, or the raw row's `data_blob` that the
 *  reindex walker reads. */
const assetSharedValues = (row: Readonly<Record<string, unknown>>): string[] => {
  let data: unknown = row;
  if (typeof row.data_blob === 'string') {
    try { data = JSON.parse(row.data_blob); } catch { data = null; }
  }
  if (!isRecord(data)) return [];
  const values: string[] = [];
  for (const anchor of Array.isArray(data.anchors) ? data.anchors : []) {
    if (!isRecord(anchor)) continue;
    if (anchor.kind === 'place' && typeof anchor.name === 'string') values.push(anchor.name);
    if (anchor.kind === 'identifier' && typeof anchor.scheme === 'string' && typeof anchor.value === 'string') {
      values.push(`${anchor.scheme} ${anchor.value}`);
    }
  }
  for (const [name, value] of Object.entries(isRecord(data.attributes) ? data.attributes : {})) {
    if (name === ASSET_DOCUMENT_DETAILS_ATTRIBUTE) continue;
    if (name === ASSET_SEARCH_TERMS) { values.push(...assetSearchTerms(value)); continue; }
    const words = name.replaceAll('_', ' ');
    if (value === true) values.push(words);
    else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) values.push(`${words} ${value}`);
  }
  return values;
};

/** The prose column each kind carries, or `null` where the kind has none.
 *  Mirrors `workEntityLongText`'s canonical arm exactly. */
export const WORK_ENTITY_LONG_TEXT_FIELD: Readonly<Record<WorkEntityKind, string | null>> = {
  task: 'body',
  note: 'body',
  project: 'description',
  commitment: 'statement',
  // Deliberate, not an omission — see the module docstring.
  booking: null,
  asset: null,
};

/** The TITLE column each kind carries, or `null` where the kind has none.
 *
 *  ⛔ `commitment` HAS NO `title` COLUMN — its `statement` IS its name. This
 *  matters only to a caller reading columns straight out of SQL: the write path
 *  passes a materialized entity and `typeof row.title === 'string'` is simply
 *  false there, so it never noticed. The reindex walker DID notice, with
 *  `SqliteError: no such column: title`, on the first upgrade that ran it. */
export const WORK_ENTITY_TITLE_FIELD: Readonly<Record<WorkEntityKind, string | null>> = {
  task: 'title',
  note: 'title',
  project: 'title',
  booking: 'title',
  commitment: null,
  asset: 'name',
};

/** `title` is what the user NAMES the record, and for several kinds it is the
 *  only place a distinguishing word appears — "Kestrel ring 04" carries the
 *  identifier in the title and nothing but boilerplate in the body. An index
 *  over the prose column alone (which is what `data_note_fts` was) cannot find
 *  a record by its own name. */
export const workEntitySearchableText = (
  kind: WorkEntityKind,
  row: { readonly title?: string | null } & Readonly<Record<string, unknown>>,
  typeSearchTerms: readonly string[] = [],
): string => {
  const parts: string[] = [];
  const titleField = WORK_ENTITY_TITLE_FIELD[kind];
  const title = titleField !== null && typeof row[titleField] === 'string' ? row[titleField] as string : '';
  if (title.length > 0) parts.push(title);
  const field = WORK_ENTITY_LONG_TEXT_FIELD[kind];
  if (field !== null) {
    const long = row[field];
    if (typeof long === 'string' && long.length > 0) parts.push(long);
  }
  // ⛔⛔ THE PREVIEW LANE IS NOT AN EDGE CASE — IT IS WHERE MIRRORED TEXT LIVES.
  // `workEntityLongText`'s docstring states it: "sync NEVER populates [canonical
  // long-body columns] — the projector confines remote text to the preview
  // lane". So a canonical-columns-only index can find Recued-authored records
  // and NONE of the vendor-mirrored ones, which is most of a synced warehouse.
  // Caught by `d-192-read-tools.test.ts`, which seeds exactly that row.
  //
  // Every preview string is indexed, not just the first. `workEntityLongText`
  // returns one because it must choose what to DISPLAY; an index has no such
  // constraint, and a record should be findable by any of its text. */
  for (const text of previewLaneStrings(row.source_extension_blob)) parts.push(text);
  if (kind === 'asset') parts.push(...assetSharedValues(row), ...typeSearchTerms);
  // Newline, not space: it cannot occur mid-token, so two fields can never
  // fuse into a phrase that neither contains ("Kestrel ring" + "04 notes"
  // must not answer a phrase query for "ring 04 notes").
  return parts.join('\n');
};

/** An asset's text with its holder's name, so "Maya Chen passport" finds the
 *  asset named "Passport" that Maya Chen holds.
 *
 *  ⛔ THE NAME IS ADDED WHEN A SEARCH RUNS, NEVER INDEXED. Whether a caller may
 *  know who holds an asset is decided per caller (contact grants, the contact's
 *  sphere), and an index answers every caller alike: a name in it would let a
 *  search say who holds what to a door that may not read contacts. A renamed
 *  contact would also leave the index holding the old name. */
export const assetSearchableText = (
  asset: object,
  holderName: string,
  typeSearchTerms: readonly string[] = [],
): string => [workEntitySearchableText('asset', asset as Readonly<Record<string, unknown>>, typeSearchTerms), holderName]
  .filter((part) => part.length > 0).join('\n');

/** The FTS key for one record. Dotted so `packages/fts`'s `scope: '<kind>.*'`
 *  selects exactly one kind — its prefix match is over `<prefix>.`, so an
 *  underscore-joined key would be matched by nothing and every search would
 *  silently return empty. */
export const workEntityFtsKey = (kind: WorkEntityKind, id: string): string => `${kind}.${id}`;

/** `<kind>.*` — the scope selecting every record of one kind. */
export const workEntityFtsScope = (kind: WorkEntityKind): string => `${kind}.*`;
