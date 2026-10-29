/** Source imports are editable Kitchen drafts, never installed capabilities. */
export const KITCHEN_DRAFT_SOURCE_MAX_BYTES = 1_000_000;
export const KITCHEN_DRAFT_MAX_COUNT = 100;
export const KITCHEN_DRAFT_IMPORT_OP = 'core.kitchen.draft.import';
export const KITCHEN_DRAFT_LIST_OP = 'core.kitchen.draft.list';
export const KITCHEN_DRAFT_GET_OP = 'core.kitchen.draft.get';
export const KITCHEN_DRAFT_UPDATE_OP = 'core.kitchen.draft.update';
export const kitchenDraftPath = (draftId: string): string => `/webclient/#kitchen/import/${encodeURIComponent(draftId)}`;

/** UTF-16 range inside a decoded JSON string, before JSON escaping. */
export interface AuthoringReferenceSpan {
  offset: number;
  length: number;
  target: 'key' | 'value';
}

export interface KitchenDraftIssue {
  severity: 'error' | 'warn' | 'info';
  code: string;
  path: string;
  message: string;
  reference_span?: AuthoringReferenceSpan;
}
export interface KitchenDraftValidation {
  valid: boolean;
  issues: KitchenDraftIssue[];
  total_issues: number;
}
export interface KitchenDraftImportInput {
  kind: 'recipe' | 'pack';
  /** Exact JSON source, including unsaved editor changes. Never a path or URL. */
  source: string;
  /** Reuse for a retry of this exact import; use a new key for changed source. */
  request_id: string;
  title?: string;
}
export interface KitchenImportDraft {
  draft_id: string;
  kind: 'recipe' | 'pack';
  title: string;
  source: string;
  source_hash: string;
  revision: number;
  created_at: number;
  updated_at: number;
  validation: KitchenDraftValidation;
  /** D-333 — the saved recipe this item changes. Only the owner's own items have one, so it is
   *  never on an MCP result. */
  base?: KitchenWorkBase;
}
/** D-333 — a saved recipe, at the version that changes in progress began from. */
export interface KitchenWorkBase { recipe_id: string; version: number }
export interface KitchenDraftImportReceipt extends Omit<KitchenImportDraft, 'source'> {
  replayed: boolean;
  /** Relative to the Recued server used for this MCP connection. */
  kitchen_path: string;
  installed: false;
}

/** Listing never includes source, validation bodies or another caller's drafts. */
export type KitchenDraftSummary = Omit<KitchenImportDraft, 'source' | 'validation'>;
export interface KitchenDraftListResult { drafts: KitchenDraftSummary[] }
export interface KitchenDraftUpdateReceipt extends Omit<KitchenImportDraft, 'source'> { installed: false }
/** Owner only (paired webclient). No MCP tool or kernel op can discard a draft. */
export interface KitchenDraftDiscardResult { draft_id: string; discarded: true }

/** D-333 — Kitchen keeps work in progress, not drafts as things of their own: an item
 *  exists until it is saved (it becomes a recipe or an installed pack) or discarded. */
/** The owner's own work in Kitchen; each connection that hands over source has its own origin. */
export const KITCHEN_OWNER_ORIGIN = 'kitchen';
/** The owner's In progress list shows at most this many, newest first. */
export const KITCHEN_WORK_LIST_MAX = 200;
/** Owner only (paired webclient): one item of work in progress, from any origin, without its source. */
export interface KitchenWorkItem {
  draft_id: string;
  kind: 'recipe' | 'pack';
  /** The source's own name once it has one (a recipe's `metadata.name`, a pack's `name`). */
  title: string;
  revision: number;
  created_at: number;
  updated_at: number;
  /** Who started it, in words that follow "From": "Kitchen" for the owner's own, an AI app's
   *  key label, or "a local AI app", "an AI app", "your chat", "a recipe". */
  from: string;
  /** True when it can be saved as it stands; otherwise `problems` errors stop it. */
  ready: boolean;
  problems: number;
  /** Changes to a saved recipe: continued at that recipe's own Kitchen address. */
  base?: KitchenWorkBase;
}
export interface KitchenWorkItemList { items: KitchenWorkItem[] }
/** Owner only: start new work in Kitchen from source (a new recipe's first autosave), or keep
 *  changes to a saved recipe (`base`; one item per recipe, a second is a conflict). */
export interface KitchenDraftCreateInput { kind: 'recipe' | 'pack'; source: string; base?: KitchenWorkBase }
export interface KitchenDraftGetInput { draft_id: string }
export interface KitchenDraftUpdateInput extends KitchenDraftGetInput {
  expected_revision: number;
  source: string;
}
