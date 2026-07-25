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
 *  at registration (`collection.file.enroll`). Note the authored set
 *  historically ran ahead of this union (`'connection'` /
 *  `'service_ref'` / `'array'` — see chat-catalog.ts CONTRACT_GAP);
 *  the structural validator accepts unknown hint types by design. */
export type ValueHintType =
  | 'secret' | 'url' | 'text' | 'number' | 'boolean' | 'enum' | 'oauth'
  | 'file_slug'
  /** D-200 Slice 0 — a durable `data.file` record reference selected from
   *  the owner's file inventory. This is distinct from `file_slug`, which
   *  names an enrolled collection/drop directory rather than one file. */
  | 'file_ref';

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
}
