/** D-219 item 2b — carrying an AI-written draft from Settings to the Kitchen.
 *
 *  The form-response seed route needs no stash: its draft is REBUILT from the
 *  route's own form id, deterministically, so a refresh reproduces it. An
 *  AI-written draft cannot be rebuilt without spending the owner's model quota
 *  again, so the recipe itself has to travel.
 *
 *  It travels in `sessionStorage`, which is the right lifetime by construction:
 *  survives a refresh (losing an expensive draft to a stray reload would be the
 *  worst small failure this feature has), dies with the tab, never syncs, never
 *  reaches the server.
 *
 *  ⛔ **ONE SLOT, not a collection.** The flow generates one draft and goes to
 *  review it; a keyed pool would accumulate expensive JSON in storage with no
 *  natural moment to prune it. Writing a new draft replaces the old one, which
 *  is bounded without a policy.
 *
 *  ⛔ **The key must MATCH to read.** A stale `#kitchen/new/execution-case/<key>`
 *  in history must not open whatever draft happens to be in the slot now — that
 *  would show the owner a recipe for a different case under a URL naming this
 *  one.
 */

export const EXECUTION_CASE_DRAFT_SLOT = 'recued.kitchen.execution-case-draft';

/** The subset of `Storage` this needs. Injected so a test drives it without a
 *  DOM, and so a host with no storage degrades instead of throwing. */
export interface ExecutionCaseDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StashedExecutionCaseDraft {
  draft_key: string;
  case_id: string;
  recipe: unknown;
  /** False when the owner's request could not be safely aliased and was
   *  therefore withheld from the authoring model — the draft is likely thinner
   *  and the Kitchen says so. */
  request_aliased: boolean;
}

/** 128 bits of a browser-grade RNG. ⛔ Not `Date.now()` or a counter: the key is
 *  what stops a stale route opening the current slot, so it must not be
 *  guessable from the route that produced it. */
export const createExecutionCaseDraftKey = (): string => {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new Error('execution-case draft keys require secure random values');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** ⚠ Fails SOFT and returns null. A storage that is full, disabled or throwing
 *  (private mode, a quota'd origin) must not lose the owner the turn they just
 *  paid for with a thrown error — the caller shows the failure instead. */
export const stashExecutionCaseDraft = (
  storage: ExecutionCaseDraftStorage | null | undefined,
  input: Omit<StashedExecutionCaseDraft, 'draft_key'>,
): string | null => {
  if (!storage) return null;
  try {
    const draft_key = createExecutionCaseDraftKey();
    storage.setItem(
      EXECUTION_CASE_DRAFT_SLOT,
      JSON.stringify({ ...input, draft_key } satisfies StashedExecutionCaseDraft),
    );
    return draft_key;
  } catch {
    return null;
  }
};

/** Reads WITHOUT removing: a refresh must reopen the same draft rather than
 *  land on an empty editor, and the draft is worthless once the tab closes
 *  anyway. */
export const readExecutionCaseDraft = (
  storage: ExecutionCaseDraftStorage | null | undefined,
  draft_key: string,
): StashedExecutionCaseDraft | null => {
  if (!storage) return null;
  let parsed: unknown;
  try {
    const raw = storage.getItem(EXECUTION_CASE_DRAFT_SLOT);
    if (raw === null) return null;
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const row = parsed as Partial<StashedExecutionCaseDraft>;
  // ⛔ The key gate. A stale route must not open a draft written for a
  // different case since.
  if (row.draft_key !== draft_key) return null;
  if (typeof row.case_id !== 'string' || row.recipe === undefined) return null;
  return {
    draft_key,
    case_id: row.case_id,
    recipe: row.recipe,
    request_aliased: row.request_aliased !== false,
  };
};

export const clearExecutionCaseDraft = (
  storage: ExecutionCaseDraftStorage | null | undefined,
): void => {
  try {
    storage?.removeItem(EXECUTION_CASE_DRAFT_SLOT);
  } catch {
    // Nothing depends on the clear succeeding; the slot is overwritten on the
    // next stash and dies with the tab regardless.
  }
};
