/** Source imports are editable Kitchen drafts, never installed capabilities. */
export const KITCHEN_DRAFT_SOURCE_MAX_BYTES = 1_000_000;
export const KITCHEN_DRAFT_MAX_COUNT = 100;
export const KITCHEN_DRAFT_IMPORT_OP = 'core.kitchen.draft.import';
export const KITCHEN_DRAFT_LIST_OP = 'core.kitchen.draft.list';
export const KITCHEN_DRAFT_GET_OP = 'core.kitchen.draft.get';
export const KITCHEN_DRAFT_UPDATE_OP = 'core.kitchen.draft.update';
/** D-402 slice A5 — an AI app's draft request: the job it kept for its draft, made into a recipe
 *  kept in the owner's Kitchen as Recued's. A write, off for every door until the owner grants it. */
export const KITCHEN_DRAFT_FROM_JOB_OP = 'core.kitchen.draft.from_job';
export const KITCHEN_DRAFT_FROM_JOB_SLUG = 'kitchen-draft-from-job';
/** D-402 slice A5 — what an AI app's draft request returns. */
export interface KitchenDraftFromJobReceipt {
  draft_id: string;
  title: string;
  /** Relative to the Recued server. */
  kitchen_path: string;
  /** What the owner reads in Kitchen: the app's labels, as checked, and the compiler's notes. */
  notes: string[];
  installed: false;
}
export const kitchenDraftPath = (draftId: string): string => `/webclient/#kitchen/import/${encodeURIComponent(draftId)}`;
/** D-402 slice E4c — a saved recipe in Kitchen, where changes to it continue (D-333). */
export const kitchenRecipePath = (recipeId: string): string => `/webclient/#kitchen/recipe/${encodeURIComponent(recipeId)}`;

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
  /** D-402 slice A3 — what the owner should look at before saving a draft Recued compiled: where
   *  each setting came from, a step to fill in, a secret asked for at each run. Only a compiled
   *  draft has notes, and its origin is no caller's, so they are never on an MCP result. */
  notes?: string[];
  /** D-402 slice A3 — what a compiled draft was made from. */
  made_from?: KitchenDraftMadeFrom;
}
/** D-333 — a saved recipe, at the version that changes in progress began from. */
export interface KitchenWorkBase { recipe_id: string; version: number }
/** D-402 slice A3 — a request in the owner's chat, or an AI app's job (`recued_startJob`). */
export type KitchenDraftMadeFrom =
  | { kind: 'chat_request'; session_id: string; turn_id: string }
  | { kind: 'ai_app_job'; job_id: string };
/** D-402 slice A3 — the origins of a draft Recued compiled (`recued:chat`, `recued:job:<token>`).
 *  No caller's own, so no AI app can list, read or change one: an app that wants changes makes a
 *  draft of its own. */
export const KITCHEN_COMPILED_ORIGIN_PREFIX = 'recued:';
export const kitchenCompiledOrigin = (made_from: KitchenDraftMadeFrom, mcp_token_id?: string): string =>
  made_from.kind === 'chat_request' ? `${KITCHEN_COMPILED_ORIGIN_PREFIX}chat`
    : `${KITCHEN_COMPILED_ORIGIN_PREFIX}job:${mcp_token_id ?? 'unknown'}`;
/** D-402 slice A3 — the most notes a compiled draft keeps, and the longest one. */
export const KITCHEN_DRAFT_MAX_NOTES = 50;
export const KITCHEN_DRAFT_NOTE_MAX_CHARS = 500;
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
