/** Unified hint for any user-input value — used by recipe variables AND ingredient vault keys.
 *
 *  Storage scoping (handled by installer/persister, not the engine):
 *    - Vault keys persist as: vault.{publisher_id}.{key}
 *    - Recipe variables persist as: config.{recipe_id}.{variable_key}
 *
 *  At runtime, the engine loads only the current scope into a flat namespace,
 *  so references stay {{vault.x}} and {{config.x}} regardless of persistence layout.
 *
 *  Override precedence at install time:
 *    Recipe.vault_hints[path] > IngredientManifest.vault_hints[path]
 *  This lets recipe authors customize credential prompts for their use case.
 */
/** D-179 P5b — `'file_slug'` formalizes a variable naming a REGISTERED
 *  file collection slug (the queue-sweeper drop dir). Install surfaces
 *  derive a "file access needed" disclosure from it and point the user
 *  at registration (`collection.file.enroll`).
 *
 *  ⚠ THE AUTHORED SET RUNS AHEAD OF THIS UNION, and always has. Measured
 *  over `community/recipes/` on 2026-08-06 — 6,160 variable hints name a
 *  type that is not a member below:
 *
 *      'string'      3,677 in 1,491 recipes
 *      'connection'  1,836 in 1,811 recipes
 *      'array'         591 in   359 recipes
 *      'object'         46 in    37 recipes
 *      'json'           10 in     9 recipes
 *      'long_text'       1 in     1 recipes
 *
 *  ⚠ `'long_text'` (2026-08-22) is the newest member of that set and the only
 *  one whose renderer branch already exists: `variable-widgets.ts` maps it to a
 *  `textarea` widget, because every other string-ish type is a one-line input
 *  and a browser strips the newlines out of a multi-line paste on its way into
 *  one. It stays UNDECLARED here for the same reason as the other five — the
 *  ruling below is that a partial union is worse than the cast, and one member
 *  with a renderer does not change that arithmetic.
 *
 *  🔑 THAT IS A RULING, NOT A BACKLOG. `validate/structural.ts` admits an
 *  unknown TYPE — renderers fall back to `text`, a D-222 § 7 ruling —
 *  while refusing an unknown KEY, which has no fallback. Consumers read
 *  the field as a plain string on purpose: `chat-catalog.ts` casts and
 *  branches on `'array'`, a type undeclared here (its CONTRACT_GAP note).
 *
 *  ⛔ SO DO NOT ADD ONE MEMBER TO CLOSE A TYPECHECK LANE. `'connection'`
 *  is the obvious candidate — this note used to name it first — and
 *  declaring it alone closes 29% of the gap while leaving `'string'`
 *  undeclared in 1,491 recipes, so a lane blocked by this stays blocked
 *  on the identical error. A member added without a renderer branch also
 *  asserts support that D-222 § 7 says is a text fallback. Declare all
 *  five WITH their renderers, or leave the cast; a partial union is the
 *  worst of the two.
 *
 *  (Superseded text named `'service_ref'`, which no recipe authors, and
 *  omitted `'string'` — the largest gap, by 2×.) */
export type ValueHintType =
  | 'secret' | 'url' | 'text' | 'number' | 'boolean' | 'enum' | 'oauth'
  | 'file_slug'
  /** D-200 Slice 0 — a durable `data.file` record reference selected from
   *  the owner's file inventory. This is distinct from `file_slug`, which
   *  names an enrolled collection/drop directory rather than one file. */
  | 'file_ref'
  /** D-215 slice 2 — an ORDERED list of `file_ref`s (a post's images, a
   *  packet's documents). Selection order is part of the value, so the
   *  picker preserves it rather than inventory order. Singular
   *  `'file_ref'` stays the one-file case; this is not a superset the
   *  renderer can collapse. */
  | 'file_ref[]'
  /** D-215 slice 2 — an instant, NOT a wall clock. The control must emit
   *  an explicit offset/zone: a zone-less string parsed server-side
   *  resolves in the SERVER's zone, not the owner's, which is why this
   *  is a typed hint rather than a `'string'` with a nicer label. Every
   *  time-valued argument in the recipe corpus is `'string'` today —
   *  e.g. `create-post-draft-wordpress`'s `date`, which feeds
   *  WordPress's own `status: 'future'` slot.
   *
   *  ⚠ Distinct from a SCHEDULE's `run_at` (when the dish fires, i.e.
   *  when Recued acts). This is a time the RECIPE reasons about — an
   *  embargo, an event date, or a target's own scheduled-publish field.
   *  A recipe can need both at once; do not merge them.
   *
   *  The webclient's widget sends it as ISO 8601 WITH the browser's offset
   *  (`variable-widgets.ts`) — the owner's zone is known only there. */
  | 'datetime'
  /** A calendar DAY, emitted as `YYYY-MM-DD`: no time of day and no zone, so it
   *  means the same wherever it is read. Stored as UTC midnight — the "whole
   *  day" convention a task's due date, a commitment's promise date and a
   *  project's target date already use (`due-day.ts`): a work-entity write
   *  takes the day as it is, and `date_parse` reads it the same way. Use it for
   *  a date that names a day; `datetime` is for an instant. */
  | 'date'
  /** A reference to one of the owner's stored Records rows, chosen from a
   *  search rather than typed. `entity` names which kind the picker searches.
   *
   *  ⛔ Before this there was NO way to say "one of your stored records": a
   *  variable's `options` is a static list authored into the recipe, and the
   *  typed pickers that existed were for FILES and CONNECTIONS. So a create
   *  form could not offer a chooser, and packs inverted the flow instead —
   *  find the row in a list, press an action, and let a `recipe.run` button
   *  carry the id into the form. That works and stays valid; this removes the
   *  need for it. */
  | 'record_ref';

export interface ValueHint {
  label: string;
  type: ValueHintType;
  /** If true, user can skip this and the recipe still works (e.g., Exa anonymous queries). Default: required. */
  optional?: boolean;
  default?: unknown;
  help?: string;
  link?: string;
  /** For type: 'enum' — the available choices, first is default. */
  options?: string[];
  /** For type: 'oauth' — provider name for broker routing. */
  provider?: string;
  /** For type: 'oauth' — scopes to request. */
  scopes?: string[];
  /** For type: 'file_ref' — optional MIME allow-list a picker may use to
   *  narrow results. Enforcement still belongs at the file-read operation;
   *  this field is discovery UX, never an authority boundary. */
  accept_mime_types?: string[];
  /** For type: 'connection' — which connection registry the picker filters.
   *
   *  Declared 2026-07-30, closing a long-standing CONTRACT_GAP: this field was
   *  already load-bearing in 1,751 shipped recipes and written by the Kitchen's
   *  own connection-variable builder, which had to cast through `unknown`
   *  precisely because it was undeclared here. It is declared now because
   *  `variable_hint_unknown_key` fences every other unknown key, and a fence
   *  whose allow-list lives somewhere other than this interface would be a
   *  second copy of the vocabulary — the exact drift that made `required`
   *  survive 1,968 times. The member list and the fence read the same source. */
  connection_kind?: 'api' | 'mcp' | 'notification';
  /** For `type: 'record_ref'` — the entity kind the picker searches, resolved
   *  against the pack that owns the recipe. The same vocabulary a ref FIELD
   *  uses (`references`), so a form's chooser and a stored reference name the
   *  entity the same way.
   *
   *  ⚠ Discovery UX, never an authority boundary: what the picker offers is
   *  not what the operation admits. The op's own binding still gates the
   *  write, exactly as `accept_mime_types` narrows a file picker without
   *  loosening the file read. */
  entity?: string;
  /** For `type: 'record_ref'` — equality filters the picker applies on top of
   *  `entity`, as `{ field: value }`.
   *
   *  ⛔ NEEDED THE MOMENT AN ENTITY IS A FOREST. `ledger-book`'s tags are one
   *  entity holding several independent trees — `person -> department ->
   *  division` is one, a project tree is another — and a line may carry at most
   *  one tag from each. A picker offering every tag therefore offers, at every
   *  keystroke, choices the write will refuse; scoping it to `root_ref` is what
   *  makes the rule visible in the control instead of in a guard afterwards.
   *
   *  ⚠ DISCOVERY UX, never an authority boundary — the same standing as
   *  `entity` above. Narrowing what is offered does not narrow what the
   *  operation admits, and a caller that ignores the picker entirely is gated
   *  by the op's binding exactly as before. */
  entity_filter?: Readonly<Record<string, string>>;
}

/** Every admitted key on the object form. The fence derives from this, so adding
 *  a member above is all it takes to admit one — there is no second list.
 *
 *  ⚠ Deliberately asymmetric with `ValueHintType`: an unknown `type` STAYS
 *  admitted (the authored corpus runs ahead of the union and renderers fall back
 *  to `text`), while an unknown KEY refuses. An unknown type has a fallback; an
 *  unknown key has none — it is a field the author believes does something and
 *  nothing reads. */
export const VALUE_HINT_KEYS = [
  'label', 'type', 'optional', 'default', 'help', 'link',
  'options', 'provider', 'scopes', 'accept_mime_types', 'connection_kind',
  'entity', 'entity_filter',
] as const satisfies ReadonlyArray<keyof ValueHint>;

/** `satisfies` above proves the list contains only REAL members. It does not
 *  prove the list is COMPLETE — and that is the dangerous direction: a member
 *  declared on the interface but forgotten here would make the fence reject a
 *  legitimate field, with a typecheck that stays green. This line fails to
 *  compile if any `keyof ValueHint` is missing from the list. Both directions are
 *  now machine-checked, so the list cannot drift from the interface. */
type _ValueHintKeysAreComplete =
  Exclude<keyof ValueHint, (typeof VALUE_HINT_KEYS)[number]> extends never
    ? true
    : { missing_from_VALUE_HINT_KEYS: Exclude<keyof ValueHint, (typeof VALUE_HINT_KEYS)[number]> };
const _valueHintKeysAreComplete: _ValueHintKeysAreComplete = true;
void _valueHintKeysAreComplete;
