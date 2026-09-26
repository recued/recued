/** D-289 — pack-shipped saved Data views.
 *
 *  A pack manifest may carry `contents[]` entries of `type: 'saved_view'`
 *  (validated in full by `parseBulkPackManifest`). This module is the server
 *  half of their lifecycle, and it deliberately does NOT copy the shape of its
 *  nearest sibling.
 *
 *  ⛔ WHY NOT REPLACE-CLEAN, WHICH `pack-reception-templates.ts` USES. That
 *  module drops every row the previous manifest wrote and re-inserts, so a
 *  template the new manifest no longer ships cannot linger. It is safe there
 *  because a template row carries NOTHING THE OWNER AUTHORED. A saved view
 *  does: `hidden`, `alert` and `review` are the owner's, and a blind replace
 *  would un-hide a view they dismissed and reset a review mark, on every
 *  reinstall, with no way for them to tell it from a fresh view. So the sync
 *  below re-asserts pack-owned fields IN PLACE and retires only what the
 *  manifest dropped.
 *
 *  ⛔ WHY THE VIEWS LIVE IN `saved_data_views` AND NOT THE CONTRACT STORE.
 *  Reception templates are read by one surface, so a contract row suits them.
 *  A view is read by the Data list, `data_views.get`, the alert evaluator and
 *  the review mark — four consumers that already speak `SavedDataView`. Storing
 *  pack views anywhere else would fork every one of them, and the fork would
 *  show up as "alerts work on my views but not the pack's".
 */
import { sha256Hex } from '@recued/crypto';
import {
  type PackContentRef,
  type PackSavedViewContentRef,
  type SavedDataViewPackRef,
} from '@recued/contracts';

/** The stable id of a pack view.
 *
 *  ⛔ DETERMINISTIC, BECAUSE THE OWNER'S STATE HANGS OFF IT. `hidden`, the
 *  alert and the review mark are keyed by view id; a fresh `randomUUID()` per
 *  install would silently discard all three on every pack update, which is the
 *  same defect as replace-clean wearing a different hat.
 *
 *  ⚠ UUID-SHAPED, NOT A UUID. The saved-view id validator is
 *  `/^view_[a-f0-9-]{36}$/`, so 8-4-4-4-12 hex satisfies every existing
 *  consumer and no URL, route or store needed widening to admit these. It
 *  carries no version/variant nibbles — nothing parses a view id as a real
 *  UUID today, and anything that starts must not be pointed at these.
 *
 *  ⚠ NAME IS PART OF IDENTITY. Renaming a view in a later pack version mints a
 *  new one and retires the old, taking the owner's state with it. The contract
 *  ref says so at the field; the alternative — an author-chosen opaque id — is
 *  invisible in the UI and drifts from the name that IS the UI. */
export const packSavedViewId = (
  pack: SavedDataViewPackRef,
  name: string,
): string => {
  // NUL separators so ('a','bc') and ('ab','c') cannot collide.
  const digest = sha256Hex(
    `saved_view\u0000${pack.publisher}\u0000${pack.slug}\u0000${name.trim()}`,
  );
  return `view_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`
    + `-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

export const isSavedViewContent = (
  content: PackContentRef,
): content is PackSavedViewContentRef => content.type === 'saved_view';

/** The pack views one manifest declares, in manifest order. */
export const packSavedViewsFrom = (
  contents: readonly PackContentRef[],
): PackSavedViewContentRef[] => contents.filter(isSavedViewContent);
