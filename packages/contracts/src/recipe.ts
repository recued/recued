import type { RecipeStep, PrefetchStep, PrefetchOpStep } from './steps.js';
import type { ValueHint } from './value-hint.js';
import type { AutoRunSpec } from './reactive.js';
import type { ExecutionScope } from './execution-scope.js';
import type { RunMode } from './memory.js';
import type { RecipeWebhookRequirement, RecipeWebhookTrigger } from './webhook-profiles.js';
import type { PaidDocumentDirectCheckoutClaimConfiguration } from './paid-document-direct-checkout-config.js';
import type { ReviewCriteriaDeclaration } from './review-criteria-config.js';
import type { RecipeFormFieldRequirement } from './recipe-form-fields.js';
import type { SpreadsheetImportDeclaration } from './spreadsheet-import.js';

/** The well-known recipe variable name that, when declared by a recipe,
 *  gives end users the cost-upgrade toggle. Read by the LLM resolver at
 *  runtime from `config.<recipe_id>.allow_llm_upgrade`; falls through to
 *  the user-level global default. Ingredient authors do NOT control this. */
export const ALLOW_UPGRADE_VARIABLE = 'allow_llm_upgrade';

/** Declarative warehouse-event subscription on a recipe.
 *
 *  Unlike the persisted `EventTrigger` row (triggers.ts) which the
 *  user manages manually in the UI, `RecipeEventTrigger` is baked
 *  into the recipe JSON. The server's declarative reconciler scans
 *  every installed recipe for `event_triggers` and materializes live
 *  trigger rows automatically — declarative, not stateful.
 *
 *  TWO authored forms, exactly one per entry (`validateRecipeEventTriggerEntry`):
 *
 *  RAW — a literal bus pattern, optionally filtered:
 *    { "event": "data.connection.api.hubspot.deal.**.updated",
 *      "filter": { "record.stage": "negotiation" } }
 *  `filter` keys are dot-paths into the dispatch payload; values are
 *  scalar literals (AND across entries). Evaluated read-free at
 *  dispatch; a missing path PASSES (fidelity layering — see
 *  `matchesTriggerDispatchFilter` in trigger-sugar.ts).
 *
 *  SUGAR — the canonical `on:` subscriber form (design § 3/§ 4),
 *  compiled down to raw pattern(s) + dispatch filter at
 *  materialization (`compileTriggerSugarEntry`):
 *    { "on": "deal.changed",            // <crm_alias>.<verb> — cross-vendor fan
 *      "connection": "my-hubspot",      // optional literal narrowing
 *      "fields": ["stage", "amount"],   // fire only when THESE canonical fields change
 *      "where": { "id": "{{…}}-free literal" } }  // id / record-field conditions
 *  Also `on: "<vendor>.<entity>.<verb>"` (single vendor — what compiled
 *  workflow recipes mint), `on: "message.received"` (messenger),
 *  `on: "reception.request"` (visitor mutation), and
 *  `on: "form_response.accepted"` (an intake response the owner APPROVED —
 *  written and fired on the approve leg, never at submit. See `trigger-sugar.ts`.), and
 *  `on: "mail_fact.<kind>"` / `on: "mail_fact"` (D-315 — a thing mail facts
 *  fold into was created or changed: of one kind of email, the usual form,
 *  checked exactly against that kind (ruling 43), or of ANY kind that has the
 *  variables it designates (ruling 42). No verb: creation counts as a change
 *  of every variable read, and `fields` picks which changes wake it
 *  (`last_email_at` = every new email about the thing). An entry takes only
 *  `on`, `fields` and `where`; `where` takes variables, `complete` and
 *  `template`, and is STRICT: a variable the fact's kind lacks, or a `null`,
 *  never matches. See `trigger-sugar.ts`). Verbs: created | changed | removed.
 *
 *  DOM watch sugar — `on: "element.changed"` + `url` + `selector`:
 *    { "on": "element.changed",
 *      "url": "https://app.hubspot.com/contacts/*",  // Chrome match pattern
 *      "selector": "#deal-amount" }                  // CSS selector
 *  compiles to `data.dom.element.<base64url(url+selector)>.updated` (the
 *  poll source reads the selector's text on a bridge-served tab and fires
 *  on change). Local/unpublished only — a self-serve PUBLISHED recipe
 *  carrying a dom watch is rejected by the §5 publish gate (an
 *  arbitrary-domain DOM read has no signed pack declaration; ship it in a
 *  pack instead). `where` (content filter) applies; `connection` / `fields`
 *  do not. */
export interface RecipeEventTrigger {
  /** RAW form — warehouse-bus pattern. Same syntax as
   *  `EventTriggerPattern`: dot-delimited segments plus `*` and `**`
   *  wildcards. Exactly one of `event` / `on`. */
  event?: string;
  /** RAW form — dispatch filter. Keys are dot-paths into the event
   *  payload; values are literal matches (scalar equal, AND). Omitted
   *  means "fire on any match". */
  filter?: Record<string, unknown>;
  /** SUGAR form — canonical `on:` value (see the interface doc).
   *  Exactly one of `event` / `on`. */
  on?: string;
  /** SUGAR form — literal connection narrowing: the platform-reference
   *  connection segment, or the messenger vendor (D-163 I-4: the
   *  notification row name IS the vendor). Literal only — config refs
   *  cannot resolve at dispatch time. Not valid for `reception.request`,
   *  `form_response.accepted`, `mail_fact` or `mail_fact.<kind>`. */
  connection?: string;
  /** SUGAR form — canonical field keys; fire only when the event's
   *  `changed_fields` intersects. Entity-change forms only. */
  fields?: string[];
  /** SUGAR form — record conditions: `id` matches the record id (every
   *  source carries it); any other key matches the canonical projection
   *  field `record.<key>` (fat poll-sourced events; doorbell-shaped
   *  reconciler events pass — the recipe's own gates stay the
   *  correctness boundary). Scalar literals only. The fixed
   *  `form_response.accepted` event admits only string `id`, `endpoint_id`,
   *  and `form_definition_id` narrowing because those paths are guaranteed
   *  on its privacy-minimized routing record. */
  where?: Record<string, string | number | boolean>;
  /** DOM-watch SUGAR form (`on: "element.changed"`) — the Chrome match
   *  pattern naming the tab/origin to watch (e.g.
   *  `https://app.hubspot.com/contacts/*`). Literal only; required for the
   *  dom form, rejected on every other form. */
  url?: string;
  /** DOM-watch SUGAR form — the CSS selector whose text is polled for
   *  change. Literal only; required for the dom form, rejected elsewhere. */
  selector?: string;
}

/** The closed block vocabulary a recipe's `output.render` may declare.
 *
 *  ⛔ THE LIST IS THE SOURCE OF TRUTH — `OutputType` DERIVES from it, and so
 *  does the recipe validator's admission set (`packages/recipes`
 *  `validate/constants.ts`) and the renderer's `SectionKind`. A hand-written
 *  second copy of a closed vocabulary is how `door_types` silently drifted out
 *  of its schema (D-207 slice 1c): a `Set<OutputType>` missing a member
 *  TYPECHECKS FINE, so the drift surfaces as a recipe that fails validation for
 *  no legible reason. Add a kind HERE and every consumer widens with it. */
export const OUTPUT_TYPES = [
  'checklist',
  'table',
  'summary',
  'ai_analysis',
  'text',
  'copyable',
  'button',
  /** D-200 — one or more immutable file cards. The resolved data carries
   *  server-derived file metadata and may include a hash-pinned recipe action;
   *  authenticated preview/download remains a host-owned interaction. */
  'file_artifact',
  /** D-274 — ONE file drawn INLINE, where `file_artifact` draws a card about a
   *  file. Two shapes, and the difference is whether the file is COPIED:
   *
   *    - `{ record_id, filename? }` — a durable `data.file` record. The host
   *      resolves the rest, exactly as `file_artifact` does, so a recipe can
   *      neither forge a descriptor nor name a file it was not given.
   *    - `{ bytes_b64, mime_type, filename }` — the bytes themselves, for a file
   *      the owner keeps on disk and Recued never copies. A run reads it live
   *      (`image.preview` → `file.read-temp`), draws it, and keeps nothing.
   *
   *  ⚠ THE SECOND SHAPE EXISTS BECAUSE A COPY IS A CACHE WITH NO INVALIDATION.
   *  Persisting a thumbnail of a roster photo means swapping that photo leaves
   *  the stored copy silently showing the old face — with nothing anywhere to
   *  reconcile it, and identity is exactly what that picture is being used to
   *  check. Live bytes cannot go stale because they are not kept.
   *
   *  ⚠ And it is for ONE bounded artifact a human is about to look at. The
   *  bytes ride in the result, which is the retention `csv-filter` exists to
   *  avoid for bulk; `file.read-temp` caps the size to keep that honest.
   *
   *  ⛔ IT IS A REQUEST TO DRAW, NOT A PROMISE OF A PICTURE. Only a browser
   *  surface can decode bytes and mount an `<img>`; `packages/renderer` emits
   *  HTML strings for non-browser channels and renders a card instead. A
   *  consumer that does not draw — chat, MCP — receives the resolved DESCRIPTOR
   *  as `data`, which is more useful to a model than markup: it carries a
   *  `record_id` the model can read through the gated file-read op if it holds
   *  that grant.
   *
   *  ⚠ Named for the SURFACE it reuses (`files/file-preview.ts`), not for
   *  `image`: that module already draws text and pdf as well, so a block called
   *  `image` would either lie about a pdf or need a twin. */
  'file_preview',
  /** D-196 § 4.5 / D-207 slice 2 — plain outbound navigation: label + absolute
   *  HTTPS URL + optional description (`ReceptionLinkButton`). The ONE block
   *  that navigates, and the only actionable one a visitor-facing surface can
   *  honour: `button` carries a `recipe.run` descriptor a stranger has no way
   *  to run, whereas this is just an anchor. It is what makes "Proceed to
   *  payment → [Checkout]" and D-196's Subscribe page the SAME block. */
  'link_button',
  /** Raw structured data from a step result — the DETAIL behind a curated
   *  `summary` / `table`.
   *
   *  ⛔ A DECLARATION, not a presentation directive. Like every kind in this
   *  list it says what the data IS and leaves rendering to the consuming
   *  channel: the HTML surfaces collapse it behind native disclosure
   *  (`packages/renderer`), an MCP / chat caller receives the `{type, data}`
   *  block verbatim and never calls the renderer at all, and a D-163
   *  notify-only channel may render nothing. Do not read `json` as an
   *  instruction to print JSON at a reader.
   *
   *  ⚠ WHY THIS EXISTS AT ALL: `output.render` is the ONLY channel by which a
   *  run's data reaches ANY reader. `ExecuteResponse.steps[]` carries
   *  id/type/skipped/duration_ms/error and no values — the response builder
   *  projects them away — and every surface (webclient result panel, MCP, chat,
   *  messenger, reception) reads `render` and nothing else. So a step result
   *  absent from `render` is unreachable by every consumer, human AND model.
   *  This kind is how detail becomes reachable at all.
   *
   *  ⛔ NOT `copyable`, which lifts a `.content` field out of any object handed
   *  to it: a payload that happens to carry one (a Contentful entry, a Freshdesk
   *  ticket) would render as that ONE field with the rest silently dropped —
   *  wrong, and quiet about it. This kind is faithful; what the step produced is
   *  what it shows. */
  'json',
  /** D-222 — an owner-only invocation form whose visible controls and typed
   *  hidden carrier are resolved from declared recipe variables. */
  'filter',
  /** An owner-only field list over ONE Records row, whose label, format, and
   *  privacy class per field are resolved from the pack's own entity schema
   *  (`surfaces.records.schema.entities[<entity>]` on the installed catalog
   *  manifest).
   *
   *  The exact twin of `filter`, on the other boundary: `filter` has no
   *  per-field vocabulary because every control derives from the VARIABLE's
   *  declaration; this has none because every field derives from the ENTITY's
   *  declaration. A block that restated field metadata would let the block and
   *  the schema disagree, and the page would then be describing a record shape
   *  the pack does not have.
   *
   *  ⛔ NOT a detail PAGE. A detail page is just a recipe's whole
   *  `output.render`; this is one block you put on it, next to `text`,
   *  `button`, `table`, and `json`. Two of them is a "Customer" group and a
   *  "Job" group. */
  'record_fields',
] as const;

export type OutputType = typeof OUTPUT_TYPES[number];

interface OutputSectionBase {
  source: string;
  /** Display label for copyable blocks. */
  label?: string;
}

/** Every plain data section. Keeping this arm explicit makes `filter` and
 *  `record_fields` the only members that can carry their own metadata;
 *  `hidden` / `submit` / `entity` cannot accidentally typecheck on an
 *  unrelated block. */
export interface DataOutputSection extends OutputSectionBase {
  type: Exclude<OutputType, 'filter' | 'record_fields' | 'table'>;
}

/** A table whose COLUMNS may come from the entity schema instead of being
 *  hand-written. Both forms stay valid: omit `entity` and the block is the
 *  ordinary table it always was, drawing the `{ columns, rows }` its source
 *  produced.
 *
 *  ⛔ The point is that a pack should name its fields ONCE. Before this, the
 *  same list was written into a `to_table` step's columns, again into
 *  `record_fields`, and again into a `to_csv` step — three hand-maintained
 *  copies of one entity's shape, drifting independently.
 *
 *  ⛔ An EXPORT is deliberately NOT covered, and not because `to_csv` is a
 *  transform that cannot reach the schema. A view and an export are different
 *  kinds of thing:
 *
 *  A table is re-rendered every run and nothing downstream depends on its
 *  shape, so deriving costs nothing when the entity gains a field. A CSV is a
 *  contract with something OUTSIDE the system — a spreadsheet, a bank, or its
 *  own importer — and its column list is what that reader is written against.
 *
 *  `collection-sheet` shows why derivation is not even coherent there: it emits
 *  `contract_id, tenant, unit, method, rent_due, amount_received`, where
 *  `tenant` and `unit` are JOINED from other entities, `rent_due` is a renamed
 *  `rent`, and `amount_received` exists in NO entity at all — it is the blank
 *  the owner fills in. No schema can produce that list, and `import-payments`
 *  reads two of those columns by name.
 *
 *  So the caller writes the list. That is the proper way for an export. */
export interface TableOutputSection extends OutputSectionBase {
  type: 'table';
  /** The row field whose value buckets the rows — `"status"`, `"assignee"`,
   *  `"due_week"`. A grouped list, not a new kind of block.
   *
   *  ⛔ WHY THIS IS A FACET AND NOT AN `OUTPUT_TYPES` MEMBER. Every member of
   *  that list says what the data IS and leaves rendering to the consuming
   *  channel; "board" and "kanban" say how it LOOKS. An MCP caller receiving
   *  `{type: 'board', data}` has no answer to what a board is to it, whereas a
   *  table with a declared grouping it can present as grouped rows — or ignore.
   *  Adding a kind also widens a closed union every consumer has to follow,
   *  which is the drift `OUTPUT_TYPES`' own header warns about.
   *
   *  ⚠ DELIBERATELY NOT NAMED ANYTHING COLUMN-ISH. `TableData.columns` already
   *  means the table's FIELDS, while a board's "columns" are its groups — one
   *  word with two meanings inside one descriptor is how the next reader gets
   *  it wrong. `group_by` is the operation, and it stays accurate whether the
   *  result reads as a board (by status), as lanes (by assignee) or as a
   *  schedule (by date).
   *
   *  ⛔ Refused alongside `edit`: an editable grid submits one ordered set bound
   *  to `edit.into`, and nothing defines which bucket a newly added row joins.
   *  See `table_group_by_with_edit`. */
  group_by?: string;
  /** Entity kind whose schema supplies the columns. Omit for a hand-written
   *  table — `source` then supplies both columns and rows as before. */
  entity?: string;
  /** Which columns, in this order. Omit for every field the schema declares,
   *  in schema order. Naming a field the schema does not declare is an
   *  install-time error, not a blank column. Requires `entity`.
   *
   *  An entry may also be an APPENDED column — the entity supplies the model
   *  and the author extends it. A rent sheet's row is a `receipt` plus the
   *  tenant's name and the rent due, which are joins, not slots on the entity;
   *  without a way to append them the whole table had to give up its entity and
   *  with it every derived label and alignment. */
  fields?: ReadonlyArray<string | TableAppendedColumn>;
  /** Turn the table into an editable grid whose rows come back as ONE config
   *  value — the repeating group ("an order and its line items").
   *
   *  ⛔ Not a new primitive. Child rows ARE a table, and `output.render`
   *  already carries inputs: D-222's `filter` collects edited values and
   *  re-invokes the recipe with a `Record<string, unknown>` config. This is
   *  that mechanism at ROW cardinality — the section already names the entity,
   *  so the shape comes from the pack and only the usage is authored here.
   *
   *  An entity is a CONVENIENCE, not a requirement — see `TableEditSpec`. */
  edit?: TableEditSpec;
  /** D-282 B6 — pick rows, then act on the set. "Select five → Mark paid".
   *
   *  ⛔ A FACET OF `table`, NOT A `selection` BLOCK. Selection has no meaning
   *  apart from the rows it selects: a block would have to name the table it
   *  belongs to, and two sections that must agree about row identity is how one
   *  of them comes to disagree. Same reasoning that keeps `group_by` and `edit`
   *  here.
   *
   *  ⛔ REFUSED ALONGSIDE `edit` (`table_select_with_edit`) — and for a DIFFERENT
   *  reason than `group_by` is. Two submit buttons over one row set is ambiguous
   *  on its face, and with `rows: 'add_remove'` an added row has no id to select
   *  by. ⚠ `group_by` and `select` DO coexist: grouping reorders rows and
   *  selection creates none, so neither breaks the other's meaning. Copying the
   *  `edit` refusal across by analogy would remove the combination this is most
   *  useful in — a board where you tick three cards in one lane. */
  select?: TableSelectSpec;
}

/** A column the author writes out in full — the jsf shape: build on the
 *  assigned model, extend it with fields carrying their own label and type.
 *
 *  Two jobs, one shape, decided by whether `field` names a schema field:
 *  - it does NOT → an APPENDED column. A rent sheet's row is a `receipt` plus
 *    the tenant's name and the rent due, which are joins, not slots.
 *  - it DOES → an OVERRIDE of that column's presentation. A recipe can retitle
 *    a column or turn a text cell into a picker WITHOUT the pack bumping a
 *    version: how a value is shown is the view's business, and making every
 *    wording change a schema change puts the pack's version in the path of a
 *    caption.
 *
 *  ⛔ Not a second schema. This declares only how to DRAW a value the source row
 *  already carries — no slot, no storage, no validation — so it never moves
 *  `storage_schema_hash` and never widens what a write may contain. */
export interface TableAppendedColumn {
  /** Key on the row, and the column's identity in `edit.columns`. Matching a
   *  schema field overrides it; not matching appends. */
  field: string;
  /** Shown heading. Required — an appended column has no schema to derive one
   *  from, and title-casing the key silently is how `rent_due` becomes a column
   *  nobody meant to label "Rent due". */
  label: string;
  /** Same vocabulary the schema uses (`decimal` / `number` / `date` / …), so an
   *  appended amount right-aligns and an appended date formats exactly like a
   *  declared one. Omit to keep the schema's kind when overriding, or for plain
   *  text when appending. */
  kind?: string;
  /** How an EDITABLE cell accepts input, for the cases the declared `kind`
   *  cannot express. Ignored on a column the section does not make editable —
   *  a read-only cell is text either way.
   *
   *  ⛔ Usually UNNECESSARY. The editor is DERIVED from `kind`
   *  (`tableColumnInputType`): a `date` slot gets a date picker, a `datetime`
   *  gets datetime-local, a `number` / `decimal` gets a numeric field. Same
   *  principle as the right-alignment beside it — from the DECLARED kind, never
   *  the runtime value — so a pack gets sensible editors without every recipe
   *  restating them. Reach for `control` only to say something the kind does
   *  not: that this string column is a closed list, or wants room to type.
   *
   *  ⛔ PRESENTATION, never authorization. A `select` narrows what is easy to
   *  enter, not what may be submitted: the grid ships strings, any host can put
   *  any string in them, and the recipe and store are what refuse a bad one. An
   *  author reading this list as a guarantee would leave the real check
   *  unwritten. */
  control?: TableColumnControl;
  /** Choices for `select` / `radio`. Required for those, meaningless otherwise. */
  options?: readonly string[];
}

/** ⛔ No `checkbox`, deliberately. A grid cell is a STRING by design (which of
 *  them is a number is the recipe's business — the `csv_parse` rule), but a
 *  Records `boolean` slot requires a real boolean at the store
 *  (`records/store.ts:760`). A checkbox emitting `'true'` would be refused, and
 *  refused INSIDE a `foreach`, where a per-item failure never fails the run — so
 *  the recipe would report success having written nothing. Until a boolean cell
 *  has an honest coercion, `select` over the two words is the safe shape. */
export type TableColumnControl = 'text' | 'select' | 'radio' | 'textarea';

export const TABLE_COLUMN_CONTROLS: ReadonlySet<TableColumnControl> = new Set<TableColumnControl>([
  'text', 'select', 'radio', 'textarea',
]);

/** The HTML input type an editable cell of this column should use.
 *
 *  Derived from the declared `kind`, with an authored `control: 'text'` as the
 *  escape hatch for a column whose kind lies about how it is typed (a date kept
 *  in a string slot, a reference that happens to be numeric). Returns null when
 *  the cell is not a plain `<input>` at all — `select` / `radio` / `textarea`
 *  are drawn as their own elements. */
export const tableColumnInputType = (
  column: Pick<ResolvedRecordColumn, 'kind' | 'control' | 'references'>,
): string | null => {
  if (column.control === 'select' || column.control === 'radio'
    || column.control === 'textarea') return null;
  // ⛔ An authored `control: 'text'` still wins — a reference the author wants
  // typed raw stays typed raw. Everything below is the DERIVED default.
  if (column.control === 'text') return 'text';
  // ⛔ A ref column that names its target is a PICKER, not an input. Returning a
  // type here is how it renders as a text box and quietly accepts a mistyped
  // id — the raw-id field `record_ref` exists to replace, one layer up.
  if (column.references !== undefined && column.references.length > 0) return null;
  switch (column.kind) {
    case 'date': return 'date';
    case 'datetime': return 'datetime-local';
    // ⚠ `number` (not `text`) so a phone keyboard shows digits and the browser
    // rejects letters — but the VALUE stays the string the field yields, which
    // is what the wire carries. A `decimal` is money at fixed scale; `step:
    // any` is what keeps "1200.0000" from being rounded by the control.
    case 'number': case 'decimal': return 'number';
    default: return 'text';
  }
};

/** The editable half of a `table`. */
export interface TableEditSpec {
  /** Variable the collected rows are submitted as — an array of objects. The
   *  recipe must DECLARE it, because that declaration is the argument
   *  boundary: the server admits this key and no other from the grid. */
  into: string;
  /** Submit-button label. */
  submit: string;
  /** Let the owner add and remove rows. Omit for a fixed set (edit what is
   *  there, add nothing) — a correction grid rather than a composition one. */
  rows?: 'fixed' | 'add_remove';
  /** Declared variables whose EFFECTIVE VALUES ride back with the submission.
   *
   *  ⛔ A submit is a fresh run of the whole recipe with only what the grid
   *  sends. Without this it sends one key, so every other variable falls to its
   *  DEFAULT — the recipe re-reads its data under different settings than the
   *  rows the owner is looking at. `collect-rent` hit this twice: `period` was a
   *  required slot on the write (fixed by SHOWING it, which a period column
   *  earns), and `limit` silently reverted to 200 after a run the owner had
   *  narrowed to 10, so the re-render listed tenancies the grid never showed.
   *
   *  The same mechanism `filter` has, for the same reason, with the same rule:
   *  a name here must be a DECLARED variable, because the declaration is the
   *  argument boundary the server bounds the submission against.
   *
   *  ⚠ Reach for a shown COLUMN first where the value is per-row or worth
   *  seeing — carried columns are visible, and a hidden value is one the owner
   *  cannot check. This is for run-level settings that are not row data: a
   *  limit, a mode, a threshold. */
  hidden?: string[];
  /** Which columns the owner may TYPE INTO. With an `entity`, omit to make
   *  every derived column except the identity editable. WITHOUT one this is
   *  REQUIRED — there is no schema to derive from, so nothing else says which
   *  cells accept typing.
   *
   *  ⛔ Needed the moment a real grid was wired. A rent-collection sheet shows
   *  the tenancy and the rent DUE and lets the owner type only what ARRIVED —
   *  a typeable `contract_ref` would let a payment be re-pointed at another
   *  tenant by editing the row it is sitting in. Shown and editable are
   *  different questions, and only the second is a write. */
  columns?: string[];
  /** Equality scope a REF column's picker applies, as `{ column: { field:
   *  value } }`. The cell-level twin of `ValueHint.entity_filter`, and needed
   *  for the same reason: an entity holding several independent trees would
   *  otherwise offer, at every keystroke, choices the write refuses.
   *
   *  ⚠ Discovery UX, never an authority boundary. */
  scopes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** D-282 B6 — the selectable half of a `table`.
 *
 *  Deliberately the SAME SHAPE as `TableEditSpec` minus everything about
 *  typing: one declared variable the chosen set submits to, one button label,
 *  and the run-level carriers. What differs is the cardinality of the value —
 *  `edit` submits an array of OBJECTS (what each row should become), `select`
 *  submits an array of STRINGS (which rows the owner picked). The receiving
 *  recipe loops with `foreach`. */
export interface TableSelectSpec {
  /** Variable the chosen row ids submit as — an array of strings. The recipe
   *  must DECLARE it, because that declaration is the argument boundary: the
   *  server admits this key and no other from the selection.
   *
   *  ⚠ Declare it as an `array` with a `default: []`, not a required slot. A
   *  bulk action is one of several things a list can do, and a required
   *  variable makes the LIST itself un-runnable until something supplies it —
   *  which is `needsAnArgument`, so the view stops being a tab. */
  into: string;
  /** Action-button label: "Mark paid", "Advance stage", "Archive". */
  submit: string;
  /** Row field carrying the id that submits.
   *
   *  ⛔ REQUIRED WITHOUT AN `entity` — with one, the identity column the schema
   *  declares (`kind: 'id'`) is used. Without a schema nothing else says which
   *  field IS the row, and guessing would submit whichever column happened to
   *  look id-shaped: the exact foreign-key-as-identity failure that shipped
   *  Open controls pointing at the wrong record.
   *
   *  ⚠ It need not be a SHOWN column. The checkbox is bound to a row the owner
   *  is looking at, so they can see what they picked; the id is the machine
   *  handle, not the thing being checked. */
  id_field?: string;
  /** Declared variables whose EFFECTIVE VALUES ride back with the selection.
   *
   *  Exactly `TableEditSpec.hidden`, for exactly its reason: a submit is a
   *  fresh run of the whole recipe with only what the control sends, so without
   *  this a `limit` the owner narrowed to 10 silently reverts to its default
   *  and the re-render lists rows the selection never covered. */
  hidden?: string[];
}

/** D-222 — authored owner filter. Field presentation comes exclusively from
 *  the named variable declarations; the block deliberately has no per-field
 *  label/type/default vocabulary of its own. */
export interface FilterOutputSection extends OutputSectionBase {
  type: 'filter';
  fields: string[];
  hidden: string[];
  submit: string;
}

/** An owner-only schema-bound field list over one Records row. `source`
 *  resolves to the record (a `RecordsFriendlyRecord`, or a wrapper carrying
 *  one under `record` / `records[0]`). */
export interface RecordFieldsOutputSection extends OutputSectionBase {
  type: 'record_fields';
  /** Entity kind whose schema resolves label / format / privacy — the same
   *  `kind` the pack's composition declares (`job`, `job_event`). */
  entity: string;
  /** Which fields to show, in this order. Omit for every field the schema
   *  declares, in schema order. Naming a field the schema does not declare is
   *  an install-time error, not a blank row. */
  fields?: string[];
}

export type OutputSection =
  | DataOutputSection
  | FilterOutputSection
  | RecordFieldsOutputSection
  | TableOutputSection;

/** One resolved field of a `record_fields` block. The renderer draws exactly
 *  this and derives nothing further. */
export interface ResolvedRecordField {
  /** Friendly key from the entity schema (`contact_name`). */
  key: string;
  /** Display label. Title-cased from `key` — the entity schema declares no
   *  label, so a pack wanting "PO number" rather than "Po number" needs a
   *  `label` cell on the entity field, which is a schema decision. */
  label: string;
  /** Drives formatting: `datetime` / `date` through the existing date path,
   *  `decimal` at fixed scale, `boolean` as Yes/No. */
  kind: string;
  /** Declared PII class, carried so an owner surface can badge it. It does
   *  NOT gate display: this block is owner-only, and the public path has its
   *  own stricter closed-list ceiling (`STATUS_PROJECTION_FIELDS_VISIBLE`). */
  privacy?: string;
  /** The author's sentence about the field, when the declaration carries one
   *  (the http entity path does; the Records path does not). NOT a label — it
   *  reads "Attendee name.", not "Name" — so a surface may show it as help
   *  text but must not substitute it for `label`. */
  description?: string;
  /** False when the schema marks the field optional AND the record omits it —
   *  the "not set" case every pack currently hand-writes as a `default` step. */
  present: boolean;
  value: unknown;
}

/** One resolved column of an entity-derived `table` block. */
export interface ResolvedRecordColumn {
  /** Path the renderer reads on each row — the schema key, or `source_path`
   *  where the raw record nests the value elsewhere. */
  field: string;
  label: string;
  kind: string;
  format?: 'date';
  /** For a `ref` column — the entity it points at, so an EDITABLE cell can be a
   *  picker rather than a box you type an id into. Absent on every other kind.
   *
   *  ⚠ The same vocabulary a `record_ref` VARIABLE uses, deliberately: a form's
   *  chooser and a grid cell's chooser name the entity the same way, so a host
   *  wires one control for both. Presentation only — what the picker offers is
   *  not what the operation admits. */
  references?: string;
  /** From an authored column's `control`. Presentation only — see
   *  `TableAppendedColumn.control`. */
  control?: TableColumnControl;
  options?: readonly string[];
}

/** Host-derived state for an editable `table`. Present only when the section
 *  declares `edit`; the renderer draws exactly this. */
export interface ResolvedTableEditDescriptor {
  section_index: number;
  recipe_hash: string;
  /** The variable the rows submit as. */
  into: string;
  submit: string;
  rows: 'fixed' | 'add_remove';
  /** Columns the owner may type into — the section's derived columns minus the
   *  identity one. ⛔ An `id` is not an editable cell: it is what the row IS,
   *  and letting it be typed would make a correction indistinguishable from a
   *  re-parent. */
  editable: readonly string[];
  /** Shown columns that are NOT editable, carried into the submission unchanged
   *  so a row can say WHICH row it is.
   *
   *  ⛔ Without this a grid cannot edit anything that already exists. A rent
   *  sheet submitted `{amount, method, reference}` with no `contract_ref`, so
   *  every receipt was written against no tenancy, the store refused each one
   *  inside a `foreach` — where a per-item failure never fails the run — and the
   *  month reported success having collected nothing.
   *
   *  ⚠ A carried value is CLIENT-SUPPLIED, exactly like an edited one: the whole
   *  array arrives under one key and any host can put anything in it. Carrying
   *  grants no new power (dropping never protected against a hostile client,
   *  only against an honest one) — the reference a row names is checked where it
   *  is written, not here. */
  carry: readonly string[];
  /** Per-column picker scope, carried through from `TableEditSpec.scopes` so
   *  the renderer does not re-read the recipe. */
  scopes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Effective values for the section's `hidden` variables, to be sent back
   *  with the rows so the resubmitted run reads its data under the SAME
   *  settings the owner is looking at.
   *
   *  ⛔ Host-derived, exactly like `filter`'s: cloned from the executed run's
   *  effective config, never round-tripped through a DOM string. A key with no
   *  effective value is OMITTED rather than sent as undefined — the recipe's own
   *  default is then the honest answer, and `undefined` on the wire would be
   *  indistinguishable from "the owner cleared it". */
  hidden: Readonly<Record<string, unknown>>;
}

/** Host-derived state for a selectable `table`. Present only when the section
 *  declares `select`; the renderer draws exactly this. */
export interface ResolvedTableSelectDescriptor {
  section_index: number;
  recipe_hash: string;
  /** The variable the chosen ids submit as. */
  into: string;
  submit: string;
  /** The row field the id comes from — RESOLVED, always present.
   *
   *  ⛔ Resolved host-side rather than left to the renderer, so every surface
   *  reads the same field. With an entity it is the schema's `kind: 'id'`
   *  column; without one it is the author's `id_field`. A consumer that had to
   *  re-derive it would be a second copy of the identity rule, and the two
   *  disagreeing means a selection that submits the wrong records — silently,
   *  because every id is a plausible string. */
  id_field: string;
  /** Effective values for the section's `hidden` variables, cloned from the
   *  executed run's effective config exactly as `table_edit`'s are. A key with
   *  no effective value is OMITTED rather than sent as undefined. */
  hidden: Readonly<Record<string, unknown>>;
  /** Why the descriptor resolved unusable, when it did. Present ⇒ the renderer
   *  draws NO checkboxes and says why.
   *
   *  ⛔ A selectable table whose identity could not be resolved must not render
   *  as selectable-but-broken. `no_identity` = an entity was named and its
   *  schema declares no single `kind: 'id'` column (and the author named no
   *  `id_field`), which is not the same as "the pack is not installed" —
   *  `record_columns.unresolved` reports that one. Two causes, two names; a
   *  surface that collapsed them would tell the owner to install something
   *  they already have. */
  unresolved?: 'no_identity';
}

export interface ResolvedRecordColumnsDescriptor {
  entity: string;
  columns: ResolvedRecordColumn[];
  /** Why it resolved empty, when it did — same vocabulary as its sibling so a
   *  surface reports one reason, not two. */
  unresolved?: 'no_schema';
}

export interface ResolvedRecordFieldsDescriptor {
  entity: string;
  fields: ResolvedRecordField[];
  /** Why the block resolved empty, when it did. `no_schema` = no installed
   *  catalog declares this entity (an uninstalled pack, or a manifest the host
   *  could not supply); `no_record` = the source resolved to no record. A
   *  consumer must be able to tell "nothing to show" from "could not look". */
  unresolved?: 'no_schema' | 'no_record';
}

/** D-222 — the host-derived descriptor attached to a resolved filter block.
 *  `definitions` and `values` contain only `fields ∪ hidden`; consumers must
 *  never reconstruct either from authored/client input.
 *
 *  `recipe_hash` is the stored authored-snapshot hash. The engine's existing
 *  top-level hash can describe a dispatch-lowered execution recipe, so it is
 *  not always the immutable stored section identity required by a later
 *  filter submit. */
export interface ResolvedFilterDescriptor {
  section_index: number;
  recipe_hash: string;
  fields: readonly string[];
  hidden: readonly string[];
  submit: string;
  definitions: Record<string, VariableDefault>;
  values: Record<string, unknown>;
  paging?: {
    next_cursor?: string;
    prev_cursor?: string;
  };
}

/** Resolved engine/transport block. Filter metadata is present only when the
 *  authored discriminator is `filter`; `record_fields` metadata only when it
 *  is `record_fields`. */
export type ResolvedOutputSection = {
  type: string;
  data: unknown;
  label?: string;
  filter?: ResolvedFilterDescriptor;
  record_fields?: ResolvedRecordFieldsDescriptor;
  /** Present only on a `table` that named an entity — the index signature
   *  below would have accepted it untyped, which is how a consumer ends up
   *  reading a field nothing declares. */
  record_columns?: ResolvedRecordColumnsDescriptor;
  /** Present only on a `table` that declared `edit`. */
  table_edit?: ResolvedTableEditDescriptor;
  /** Present only on a `table` that declared `select`. */
  table_select?: ResolvedTableSelectDescriptor;
} & Record<string, unknown>;

/** D-222 host control-plane provenance. It is not recipe-readable and never
 *  enters `config` or `context`. */
export interface OutputFilterInvocation {
  kind: 'output.filter';
  recipe_hash: string;
  section_index: number;
}

/** D-222's sibling for an editable grid. Same proof, same reason: the config
 *  did not come from a caller, it came from a section the INSTALLED recipe
 *  declares — so the server can bound which keys it admits. */
export interface OutputTableEditInvocation {
  kind: 'output.table_edit';
  recipe_hash: string;
  section_index: number;
}

/** D-282 B6's sibling for a selectable table. Third member of the same family,
 *  through the same gate: the config came from a section the INSTALLED recipe
 *  declares, at a section index whose hash still matches, so the server can
 *  bound which keys it admits. */
export interface OutputTableSelectInvocation {
  kind: 'output.table_select';
  recipe_hash: string;
  section_index: number;
}

export type RecipeInvocation =
  | OutputFilterInvocation
  | OutputTableEditInvocation
  | OutputTableSelectInvocation;

export const FILTER_CONFIG_KEY_NOT_ALLOWED = 'filter_config_key_not_allowed' as const;
export const FILTER_INVOCATION_STALE = 'filter_invocation_stale' as const;
export const FILTER_INVOCATION_FORBIDDEN = 'filter_invocation_forbidden' as const;

export interface RecipeOutput {
  /** Canonical D-195 render surface. Parsers normalize legacy sidebar-only
   *  authored recipes into this field before execution. */
  render?: OutputSection[];
  /** Legacy migration alias. Parsers normalize this into render before
   *  execution when authored by old recipes. */
  sidebar?: OutputSection[];
  /** D-232 § 19.3 — the exchange output kind. A recipe RETURNS (`render`) or it
   *  FIRES (`exchange`); the alternatives live in one block so result-XOR-fire
   *  is structural rather than a rule an author must remember. */
  exchange?: RecipeExchangeOutput;
}

/** D-232 § 19.3 — "output to exchange store and fire".
 *
 *  ⛔ Deliberately NOT a step. The gateway is per-op-step and single-valued,
 *  while a recipe's outcome resolves only when the run ends — so a step-level
 *  exchange (§ 18.5, retired) has to represent "a value that isn't ready", and
 *  the paused-run shape it would carry reads as an ordinary object to the
 *  caller. As an OUTPUT there is nothing to represent: the run is over.
 *
 *  🔑 The engine derives the acknowledgement (ref + callback op) from this
 *  block, so no recipe authors it and none can forget it — leaving a caller with
 *  no ref to query is the one failure the exchange exists to prevent. */
export interface RecipeExchangeOutput {
  /** Correlation id for this exchange, stable across the conversation. A
   *  `{{ref}}` resolved at fire time against the finished run's stores. */
  ref: string;
  /** WHERE THIS MESSAGE GOES: the tool that carries it. Resolved at fire time
   *  to the one INSTALLED operation whose `mcp` binding names it, which is what
   *  keeps a peer choosing among the owner's operations rather than naming a
   *  tool directly (D-232 § 20.6).
   *
   *  ⛔ SEPARATE FROM `callback_op`, AND THE ASKER IS WHY. On the ANSWERING side
   *  the two coincide — B delivers to `…/peer-appointment-reply`, which is also
   *  where the conversation's answer lands — so one field appeared to do both
   *  jobs. On the ASKING side they are plainly different: A delivers to
   *  `…/peer-request-appointment` and asks to be answered at
   *  `…/peer-appointment-reply`. One field would have made A's receipt say the
   *  answer arrives at the tool A just sent to, which is false, or routed A's
   *  request through the reply operation, which is the wrong direction. */
  deliver_to: string;
  /** D-232 § 28 — this answer must LEAVE THE SERVER; refuse rather than deliver
   *  it locally.
   *
   *  ⛔⛔ "NO CONNECTION ⇒ ROUTE LOCAL" IS RIGHT FOR ONE CASE AND CATASTROPHIC
   *  FOR THE OTHER, AND THE SUBSTRATE CANNOT TELL THEM APART. An mcp binding
   *  with no connection names a recipe on THIS server — correct for the owner's
   *  own recipe→recipe exchange. For an answer owed to a PEER it means the run
   *  is filed under THEIR ref, delivered to ourselves, and reported `succeeded`,
   *  while the peer waits forever. Seen exactly that way: bob replied to bob
   *  under alice's ref.
   *
   *  Both look identical at fire time — same shape, same empty connection, a
   *  contracted caller in both — so the ONLY thing that can distinguish them is
   *  the author saying which they meant. An answering recipe sets this; a local
   *  one does not.
   *
   *  ⚠ CHECKED LOCALLY AND ONLY LOCALLY. The alternative is asking the peer to
   *  confirm which contract they present, which probes another server before it
   *  has agreed to anything. Each side binds its own connection and neither
   *  interrogates the other; this needs no cooperation from them and fails at
   *  the moment it matters, on the side that made the mistake. */
  require_connection?: boolean;
  /** Where the far side should answer — the endpoint of the CONVERSATION, not
   *  of this message. Echoed into the acknowledgement so the caller knows where
   *  the rest arrives, and carried in the payload so the far side knows where
   *  to send it. Absent when nothing further is expected. */
  callback_op?: string;
  /** Connection naming the peer. ABSENT routes locally, the same discriminator
   *  the gateway uses for an `mcp` binding (§ 18.4). */
  connection?: string;
  /** Extra fields to carry alongside the outcome. The OUTCOME itself is never
   *  authored here — see `ExchangeFirePayload`. */
  data?: Record<string, unknown>;
}

/** THE rule for which sections a recipe actually renders — `render`, else the
 *  legacy `sidebar` alias, else none.
 *
 *  ⛔ ONE COPY. This was a private const in the engine, and D-207 slice 2 needed
 *  a second caller: the reception submit path has to know whether a paired
 *  recipe's response carries anything, because that decides whether a rejected
 *  submission may still be told "Submission received". If that answer ever
 *  disagreed with the answer the ENGINE gives when it builds `output.render`,
 *  the rule would fire on the wrong forms — silently, and in the direction of
 *  lying to someone.
 *
 *  ⚠ NOTE THE PRECEDENCE, which a naive re-derivation gets wrong: an EMPTY
 *  `render: []` beats a populated `sidebar`, because `Array.isArray([])` is
 *  true. `render` present at all means the author moved off the legacy alias, so
 *  an empty one means "renders nothing" — not "fall back to sidebar". */
export const recipeOutputSections = (recipe: {
  output?: { render?: OutputSection[]; sidebar?: OutputSection[] };
}): OutputSection[] =>
  Array.isArray(recipe.output?.render)
    ? recipe.output.render
    : Array.isArray(recipe.output?.sidebar)
      ? recipe.output.sidebar
      : [];

export type RecipeOutputAction = {
  kind: 'recipe.run';
  label: string;
  recipe_id: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  variant?: 'primary' | 'secondary' | 'danger';
  confirm?: string;
};

export interface RecipeMetadata {
  name: string;
  description: string;
  author: string;
  supported_platforms: string[];
  /** D-195 — namespaced identity of the BulkPackManifest that owns this
   *  recipe's install flow. Shape: <pack.publisher>/<pack.slug>; omit when the
   *  recipe is independently installable or has no single carrier. */
  recipe_bundle?: string;
  variant_group?: string;
  tags?: string[];
  fork_of?: { recipe_id: string; author: string; version: number };
  /** D-234 § 234.3 — WHERE AN OWNER GOES TO ACT ON WHAT THIS RECIPE PRODUCED.
   *  A bare `recipe_id` on this same server, never a URL.
   *
   *  ⛔⛔ A RECIPE CANNOT BUILD ITS OWN DEEP LINK, AND SHOULD NOT TRY. Every
   *  channel that carries a notification's `link_url` needs an ABSOLUTE url —
   *  `email` appends it raw, `remote` (Slack / Telegram) passes it through, and
   *  the ask landing runs it through `safeHttpUrl`, which refuses a bare
   *  `#recipes/…`. The only public base URL is a BOOT-TIME fact
   *  (`RECUED_PUBLIC_BASE_URL`, the same one `askAnswerLink` is built from), and
   *  `context.server.name` is a DISPLAY LABEL, not a hostname. So a recipe that
   *  authored a link would emit one that resolves for nobody.
   *
   *  🔑 The recipe therefore names a DESTINATION and the host resolves it
   *  (`ownerSurfaceLink`). The split is the point: the recipe knows which surface
   *  reads its output, the host knows where this server lives, and neither has to
   *  learn the other's fact.
   *
   *  ⚠ Its reason for existing is that some runs are triggered by somebody else
   *  — a peer, a schedule, a webhook — so their output is never in front of the
   *  owner. `output.render` is NOT persisted (the audit row keeps only a capped
   *  `output_string`), so there is no run to link to; what an owner can be sent
   *  to is a recipe they RUN, which produces the content fresh. */
  owner_surface?: string;
  /** Long-form documentation in Markdown. Rendered on the marketplace
   *  detail page. Max 10,000 characters. Optional — description is
   *  the card/search preview, readme is the detail page explainer. */
  readme?: string;
  /** v3 — the author's source repo URL (https). Issues, bugs, and
   *  support route THERE; the marketplace hosts no comments / issue
   *  tracking. Entered in the marketplace publish flow (Kitchen renders
   *  it read-only) and never inherited across fork-and-publish. */
  repo?: string;
  /** Wall-clock execution budget in milliseconds. When set, the engine
   *  aborts the run with RECIPE_BUDGET_EXCEEDED if the recipe hasn't
   *  completed within this many ms of start. Approval waits are excluded
   *  from the budget (users take their own time). Required for context /
   *  auto-run recipes (must respond fast); optional for manual + scheduled. */
  budget_ms?: number;
  /** D-119 Phase 15 — author-declared execution scope.
   *  Optional. When present, must be a subset of the scope derived
   *  from the recipe's ingredient manifests at install time. Wider-
   *  than-derived declarations error with `EXECUTION_SCOPE_TOO_WIDE`.
   *  Marketplace UI shows the narrower of (declared, derived); the
   *  install gate uses the derived constraint to refuse incompatible
   *  installs (`EXECUTION_SCOPE_INCOMPATIBLE`). See
   *  `packages/contracts/src/execution-scope.ts`. */
  execution_scope?: ExecutionScope[];
  /** D-200 — optional owner-local direct-checkout deployment locators. The
   * complete block is part of the saved recipe and therefore of the exact
   * form/recipe pair revision. It carries no product/economic terms, Seller
   * identity, hosted provider result, quantity, or total. */
  paid_document_direct_checkout?: PaidDocumentDirectCheckoutClaimConfiguration;
  /** D-250 addendum — review criteria for a registry board, declared on the recipe so they
   *  travel with the pinned version (a criteria change IS a version change, and reviews stay
   *  comparable to what they were made against).
   *  ⛔ ONE OPTIONAL FIELD, SHAPE OWNED ELSEWHERE — `review-criteria-config.ts`, following the
   *  `paid_document_direct_checkout` precedent above. Registry boards are one feature and
   *  most recipes will never declare a criterion; the schema should not grow a structured
   *  concern for all of them. */
  review_criteria?: ReviewCriteriaDeclaration['criteria'];
  /** D-220 Slice A1 — the named intake-form answers this recipe reads.
   *
   *  A recipe that consumes an accepted Reception submission reads answers by
   *  STATIC path (`record.values.<name>`), so the field names are a hard
   *  contract with whatever form the owner pairs it to. Declaring them lets
   *  `validateRecipe` cross-check the claim against the recipe's own refs, and
   *  lets the wiring surfaces (pair-bind / "Automate this form") refuse a
   *  mismatched form where the OWNER is standing — instead of at fire, where a
   *  misspelled field resolves `undefined`, a `default` fallback covers it, and
   *  the run reports success having stored nothing.
   *
   *  `[]` is a positive claim ("reads no named answers" — the seller-opener
   *  shape); ABSENT means undeclared and unchecked. See
   *  `packages/contracts/src/recipe-form-fields.ts`. */
  requires_form_fields?: ReadonlyArray<RecipeFormFieldRequirement>;
  /** D-292 — this recipe imports a spreadsheet the owner uploads: which
   *  variable takes the file, which one makes a run a check that records
   *  nothing, and which ones each name a header cell. A surface reads it to
   *  guide the owner through upload → match columns → check → import instead of
   *  asking them to type header names.
   *
   *  ⛔ ONE OPTIONAL FIELD, SHAPE OWNED ELSEWHERE (`spreadsheet-import.ts`),
   *  after the `requires_form_fields` precedent. `validateRecipe` cross-checks it
   *  against the recipe's own variables and steps — above all that `preview`
   *  reaches `dry_run`, or a check would import for real. */
  spreadsheet_import?: SpreadsheetImportDeclaration;
  /** D-302 — variables an earlier version declared and this one dropped. A value
   *  still saved for one is dropped before the run instead of refused: see
   *  {@link withoutRetiredConfig}. `validateRecipe` refuses a name that is also
   *  declared. */
  retired_variables?: string[];
  /** What a retired variable's saved value still means for the variables that
   *  replaced it. When `variable` (retired above) was saved as `when`, a run sets
   *  each `set` variable the owner has not saved. See {@link carriedFromRetired}. */
  retired_carries?: RetiredCarry[];
}

/** One carry from a retired variable's saved value into its replacements. */
export interface RetiredCarry {
  readonly variable: string;
  readonly when: string;
  readonly set: Readonly<Record<string, string>>;
}

/** Recipe variable: shorthand primitive (default value) OR full hint for
 *  richer UI. `null` means "required, no default" — preflight surfaces
 *  the variable as missing when the caller's config omits it. */
export type VariableDefault = number | boolean | string | string[] | ValueHint | null;

/** D-222 Slice A — the stable error code for an invocation that names a config
 *  key the recipe does not declare.
 *
 *  ⛔ NOT `undeclared_variable_ref`, and neither substitutes for the other. That
 *  check walks the recipe DOCUMENT at install and proves an authored
 *  `{{config.X}}` points at a declaration; this one checks the INPUT a caller
 *  supplies at execution. A recipe can pass the first and still be handed a key
 *  it never declared — which is the gap that made "`variables` is the argument
 *  boundary" a claim about a check that validates something else. */
export const UNDECLARED_CONFIG_ARGUMENT = 'undeclared_config_argument' as const;

/** Where an undeclared config key entered the run. An owner who mistyped an
 *  argument and an owner carrying a stale stored overlay have the SAME symptom
 *  and different fixes, so the refusal names the origin rather than making them
 *  guess. `wire` = this request's own `config`; `overlay` = an install-dish,
 *  group, schedule/trigger, webhook, or failure-handler patch merged in
 *  server-side. */
export type UndeclaredConfigOrigin = 'wire' | 'overlay';

export interface UndeclaredConfigArgument {
  readonly key: string;
  readonly origin: UndeclaredConfigOrigin;
}

/** Structured `RpcError.details` for {@link UNDECLARED_CONFIG_ARGUMENT} — typed
 *  fields so a surface or a test asserts on them instead of parsing prose. */
export interface UndeclaredConfigArgumentDetails {
  readonly undeclared: ReadonlyArray<UndeclaredConfigArgument>;
  /** Declared keys, so a caller can see what it *could* have sent. Sorted. */
  readonly declared: ReadonlyArray<string>;
}

/** D-222 Slice A — every own top-level key of the effective config that the
 *  recipe does not declare, tagged with where it came from.
 *
 *  PURE, and deliberately shaped as a reporter rather than a thrower: the
 *  execute boundary owns the refusal (and its status code), while the rule
 *  itself stays testable without a server. Returns `[]` when every key is
 *  declared — including the ordinary case of an empty config.
 *
 *  ⚠ OWN keys only. `Object.keys` already skips the prototype chain, which is
 *  the behaviour we want: a `__proto__`-shaped payload must not be read as a
 *  declared key, and an inherited property is not something a caller "sent".
 *
 *  `wireKeys` is the request's own config key set captured BEFORE server-side
 *  overlays merge. Pass it to get origin attribution; omit it and every finding
 *  reports `overlay`, which is the safe default — claiming a key came from the
 *  wire when we do not know would point the owner at the wrong fix. */
/** D-232 § 21 — the EXCHANGE ENVELOPE: keys the engine always puts on the wire
 *  when one recipe answers another, and which therefore may always ride along
 *  undeclared.
 *
 *  ⛔⛔ WITHOUT THIS THE PROTOCOL CANNOT GROW A SINGLE FIELD. Every arg a
 *  receiver does not declare is refused with `UNDECLARED_CONFIG_ARGUMENT` (400),
 *  so adding `kind` + `reason` to the exchange broke EVERY existing receiver at
 *  once — and it broke them at the far side, where the asker sees only that the
 *  answer never arrived. A protocol whose every extension is a simultaneous
 *  breaking change for all participants, including third-party ones on servers
 *  you do not control, is not a protocol. Found by adding one field.
 *
 *  ⚠ WHY EXEMPTING THESE IS SAFE, stated plainly because it is a real relaxation
 *  of a D-222 guard: an undeclared key is UNREADABLE. A recipe reaches config
 *  only through `{{config.<name>}}`, which resolves against its declared
 *  variables — so a key nobody declared cannot be read, cannot be gated on, and
 *  cannot reach a step. The guard exists to catch a caller who MEANT to send
 *  something and got the name wrong; it is not an authority boundary. A receiver
 *  that wants any of these declares it, and then it is validated like any other
 *  variable.
 *
 *  🔑 CLOSED AND ENGINE-OWNED. Every member is derived by the engine from the
 *  RUN — never authored — which is what keeps this from becoming a hole a caller
 *  can widen. Adding a member here is a protocol change and should be treated as
 *  one. */
export const EXCHANGE_ENVELOPE_KEYS: readonly string[] = Object.freeze([
  'exchange_ref',
  'outcome',
  'kind',
  'reason',
  'errors',
]);

const EXCHANGE_ENVELOPE_KEY_SET: ReadonlySet<string> = new Set(EXCHANGE_ENVELOPE_KEYS);

export const isExchangeEnvelopeKey = (key: string): boolean =>
  EXCHANGE_ENVELOPE_KEY_SET.has(key);

export const undeclaredConfigArguments = (
  variables: Readonly<Record<string, VariableDefault>> | undefined,
  config: Readonly<Record<string, unknown>> | undefined,
  wireKeys?: ReadonlySet<string>,
): UndeclaredConfigArgument[] => {
  if (config === undefined) return [];
  const declared = variables ?? {};
  const out: UndeclaredConfigArgument[] = [];
  for (const key of Object.keys(config)) {
    if (Object.prototype.hasOwnProperty.call(declared, key)) continue;
    // § 21 — the exchange envelope always rides along; see the doc above for why
    // exempting it is safe and why the protocol is unextendable without it.
    if (EXCHANGE_ENVELOPE_KEY_SET.has(key)) continue;
    out.push({ key, origin: wireKeys?.has(key) === true ? 'wire' : 'overlay' });
  }
  return out;
};

/** D-302 — the recipe's retired variables (`metadata.retired_variables`); none
 *  when absent or malformed (`validateRecipe` refuses a malformed list at install). */
export const retiredVariablesOf = (recipe: { readonly metadata?: unknown }): readonly string[] => {
  const metadata = recipe.metadata;
  if (metadata === null || typeof metadata !== 'object') return [];
  const list = (metadata as { retired_variables?: unknown }).retired_variables;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string' && name !== '') : [];
};

/** The recipe's retired carries (`metadata.retired_carries`), well-formed ones only
 *  (`validateRecipe` refuses a malformed list at install). */
export const retiredCarriesOf = (recipe: { readonly metadata?: unknown }): readonly RetiredCarry[] => {
  const metadata = recipe.metadata;
  if (metadata === null || typeof metadata !== 'object') return [];
  const list = (metadata as { retired_carries?: unknown }).retired_carries;
  if (!Array.isArray(list)) return [];
  return list.filter((carry): carry is RetiredCarry =>
    carry !== null && typeof carry === 'object'
    && typeof (carry as RetiredCarry).variable === 'string'
    && typeof (carry as RetiredCarry).when === 'string'
    && (carry as RetiredCarry).set !== null && typeof (carry as RetiredCarry).set === 'object'
    && Object.values((carry as RetiredCarry).set).every((value) => typeof value === 'string'));
};

/** The values a run takes from RETIRED variables' saved values
 *  (`metadata.retired_carries`).
 *
 *  ⛔ WHY (integrity audit, 2026-09-24). D-302 retired the importers' thousands mark
 *  and asked for the decimal mark instead, defaulting to the point. An owner whose
 *  saved thousands mark was `.` had their amounts read with the point, so `1.200`
 *  became 1.2, silently. Their old setting still says what the new one must be, and
 *  a carry names that.
 *
 *  When a retired `variable` was saved as `when`, each `set` variable the config does
 *  not hold takes the carried value. A value the owner saved for the new variable
 *  always wins. A variable a later version declares again is not in `retired`, so it
 *  carries nothing. */
export const carriedFromRetired = (
  recipe: { readonly metadata?: unknown },
  config: Readonly<Record<string, unknown>>,
  retired: readonly string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const carry of retiredCarriesOf(recipe)) {
    if (!retired.includes(carry.variable) || config[carry.variable] !== carry.when) continue;
    for (const [name, value] of Object.entries(carry.set)) {
      if (config[name] === undefined && !(name in out)) out[name] = value;
    }
  }
  return out;
};

/** D-303 — the variables `before` declares that `after` does not: what an update
 *  dropped. `before` null (a fresh install) drops nothing. */
export const droppedVariables = (
  before: { readonly variables?: unknown } | null,
  after: { readonly variables?: unknown },
): string[] => {
  const names = (recipe: { readonly variables?: unknown } | null): string[] => {
    const variables = recipe?.variables;
    return variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? Object.keys(variables) : [];
  };
  const kept = new Set(names(after));
  return names(before).filter((name) => !kept.has(name));
};

/** D-302 — `config` without the keys the recipe RETIRED.
 *
 *  ⛔ WHY A RETIRED KEY IS DROPPED, NOT REFUSED. D-222 refuses any config key the
 *  recipe does not declare, from every contributor: the wire, and the install,
 *  dish and group overlays saved earlier. So an update that removes a variable
 *  would stop EVERY run of an owner who ever saved a value for it, and nothing
 *  prunes those overlays. A recipe that lists the variable here says the knob is
 *  gone on purpose, so its saved value is dropped. The value stays stored, and
 *  nothing is lost. A key the recipe never declared is still refused. */
export const withoutRetiredConfig = (
  config: Readonly<Record<string, unknown>>,
  retired: readonly string[],
): Record<string, unknown> => {
  if (retired.length === 0) return { ...config };
  const drop = new Set(retired);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !drop.has(key)));
};

/** The human half of the refusal. Kept beside the reporter so the wording lives
 *  in one place, and separate from it so the rule can be tested without
 *  asserting on prose. */
export const undeclaredConfigArgumentMessage = (
  found: ReadonlyArray<UndeclaredConfigArgument>,
): string => {
  const rendered = found
    .map((f) => `'${f.key}' (${f.origin})`)
    .join(', ');
  const plural = found.length === 1 ? 'key' : 'keys';
  return `config ${plural} not declared by this recipe: ${rendered}. `
    + `A recipe's \`variables\` block is the argument boundary — declare the `
    + `variable, or drop the key from the request or the stored overlay.`;
};

/** D-116 — declarative error-handler binding on a recipe.
 *
 *  When a recipe declares `on_failure`, the install path:
 *    1. Resolves `recipe_id` in the local install registry. Missing →
 *       `ON_FAILURE_HANDLER_UNKNOWN`.
 *    2. Verifies the handler is reactive (has `trigger_steps`). Missing
 *       → `ON_FAILURE_HANDLER_NOT_REACTIVE`.
 *    3. Verifies the handler has a `recipe-watcher` step in
 *       `trigger_steps`. Missing → `ON_FAILURE_HANDLER_MISSING_WATCHER`.
 *
 *  At runtime the handler's recipe-watcher filter is augmented so the
 *  handler fires only on failures of THIS source recipe. Handler input
 *  sees `{{trigger.failure.*}}` with `recipe_id`, `process_id`,
 *  `error_class`, `step_id`, `at`. */
export interface OnFailureBinding {
  /** Recipe_id of the handler. Must already be installed when THIS
   *  recipe installs. Pointing at `recipe_id` itself is rejected —
   *  failures of the handler would re-fire it. */
  recipe_id: string;
  /** Optional config patch merged onto the handler at dispatch.
   *  (Historically "same shape as `event_triggers.config_patch`" —
   *  that trigger field was retired by D-179 P2 in favor of dish
   *  overlays; this binding-local patch is unaffected.) */
  config?: Record<string, unknown>;
}

export interface RecipeDefinition {
  recipe_id: string;
  version: number;
  ttl: number;
  trigger?: string[];
  metadata: RecipeMetadata;
  /** User-configurable variables. Persist as config.{recipe_id}.{key}.
   *  Recipes that want to expose a per-install LLM-upgrade toggle declare
   *  a variable named `allow_llm_upgrade` (boolean). See ALLOW_UPGRADE_VARIABLE. */
  variables: Record<string, VariableDefault>;
  /** Override ingredient vault_hints for the same path. Lets recipes customize credential prompts. */
  vault_hints?: Record<string, ValueHint>;
  /** Warehouse-event subscriptions. When present, the server's
   *  event-trigger binder registers each entry with the warehouse
   *  bus on recipe install. Recipes without this field are
   *  manual-only (URL-trigger + approval-only). */
  event_triggers?: RecipeEventTrigger[];
  /** D-201 — owner-local webhook requirements.  Published pack recipes usually
   *  inherit requirements from their owning pack; a standalone local recipe
   *  may carry this same portable shape itself. */
  webhook_requirements?: RecipeWebhookRequirement[];
  /** D-201 — strict logical-binding + exact-event trigger grammar.  This is
   *  intentionally separate from `event_triggers`: no vendor type is embedded
   *  in a warehouse topic and no missing-path filter can pass. */
  webhook_triggers?: RecipeWebhookTrigger[];
  /** D-116 — declarative error-handler binding. When THIS recipe
   *  fails, the engine fires the bound handler recipe (which must
   *  already be installed + reactive + have a recipe-watcher step).
   *  One-hop only — chains compose by binding handlers on handlers. */
  on_failure?: OnFailureBinding;
  /** D-115 — reactive recipes. When present, the engine treats this
   *  recipe as auto-running on a short interval. The extension SW
   *  drives ticks via `chrome.alarms` (clamped to 30s / ~1m floor);
   *  the server uses `setTimeout` (sub-second supported). Pairs with
   *  `trigger_steps` to gate firings — `auto_run` without
   *  `trigger_steps` would tick unconditionally, which is allowed but
   *  rare. Coexists with cron `schedule` rows (different regime). */
  auto_run?: AutoRunSpec;
  /** D-115 — gate phase that runs before `prefetch_steps` on every
   *  `auto_run` tick. All steps must yield `TriggerOutput.should_run
   *  === true` for the tick to proceed; any false short-circuits
   *  silently (no audit entry, no side effect). Outputs surface as
   *  `{{trigger.<step_id>.<field>}}` to downstream phases. Forbidden
   *  without `auto_run` — would never fire. */
  trigger_steps?: RecipeStep[];
  /** D-182 Slice 4 — a prefetch entry is EITHER a concrete `PrefetchStep`
   *  (`ingredient` + input) OR a `PrefetchOpStep` (a two-tier `op` id). The
   *  op-step lowering (`lowerOpStepRecipe`) concretizes every `PrefetchOpStep`
   *  into a `PrefetchStep` BEFORE the engine runs, so the engine prefetch runner
   *  only ever executes concrete steps (it narrows + throws on any survivor). */
  prefetch_steps: Array<PrefetchStep | PrefetchOpStep>;
  steps: RecipeStep[];
  output: RecipeOutput;
  /** D-120 Phase 3 — provenance opt-out. Default `true` (engine emits
   *  causal entity↔memory links for every step touch — the substrate
   *  L3+ pattern detection consumes). Explicit `false` silences
   *  emission for the entire run; marketplace surfaces a "No
   *  provenance" badge so users can see the recipe declines tracing.
   *  Use only for genuinely ephemeral recipes (one-shot search /
   *  scratch) — durable workflows should leave it on so the warehouse
   *  carries the why-trail alongside the what. */
  provenance?: boolean;
  /** D-120 Phase 4 — staged-trust permission requests. Recipes that
   *  reference `{{data.memory.*}}` (or its `data.audit.*` alias)
   *  must declare `requires: ['read_memory']` so the install dialog
   *  can surface the permission for explicit user approval. Same
   *  pattern as vault scoping — default-deny; the validator hard-
   *  errors when a recipe reads from the memory namespace without the
   *  permission declared. Unrecognised entries are warned (forward-
   *  compat: future permissions surface alongside without a hard
   *  break). */
  requires?: string[];
  /** D-120 Phase 7.5 — declarative run-mode override. Authors set
   *  `'backfill'` on cursor-loop recipes that walk historical data;
   *  the engine stamps `audit_log.run_mode` accordingly so backfill
   *  links use `event_at` rather than today's timestamp on
   *  `data.timeline()` ordering. Default when absent: engine infers
   *  `'manual'` for chat / Run-Now / UI triggers, `'live'` for cron /
   *  reactive / auto_run. */
  run_mode?: RunMode;
  /** D-137 § A.1.1 (amended 2026-07-02) — Tier 2 chat-catalog exposure
   *  flag. Explicit `true` surfaces the recipe in the chat agent's tool
   *  catalog under `<publisher_id>/<recipe_id>`; explicit `false` keeps
   *  it runnable via `recipe.run` Tier 1 + URL trigger + scheduler
   *  without polluting the chat catalog.
   *
   *  An ABSENT flag falls to a SOURCE-DEPENDENT default
   *  (`isRecipeChatExposed` in @recued/recipes): EXPOSED for
   *  user-authored recipes (stored `source: 'inline'` — a person who
   *  authored a recipe intends to use it), HIDDEN for pack-bundled /
   *  distributed content (at 300-pack scale every silently-exposed
   *  recipe inflates every installer's cached catalog prefix ~160
   *  tok/entry — pack authors declare exposure deliberately). The
   *  pre-flip corpus was grandfathered with explicit `true`. */
  chat_exposed?: boolean;
  /** D-182 §3 — the Tier-P packs whose ops this recipe uses
   *  (`<publisher>.<pack>`, optionally `@N` version-pinned). Tier-K `core.*`
   *  ops need NONE (kernel — always present). Distinct from `requires`
   *  (permissions). The install + Compose validators confirm every Tier-P
   *  `op` a step names is covered by an entry here
   *  (`uncoveredOpDependencies`). Replaces the dropped capability-keyed
   *  `{capability, ops, optional}` DI graph (§3 / §5); Tier-K `core.*` runnability
   *  is now kernel-derived (R1 verb-split), not declared. Omit when the recipe
   *  calls only Tier-K kernel ops. */
  depends_on?: string[];
}
