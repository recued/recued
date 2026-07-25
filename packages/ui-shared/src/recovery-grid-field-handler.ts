/** Recovery-grid field-event handler factory.
 *
 *  Five grids in the extension share an identical input-event shape:
 *  whitespace-paste detection fans a phrase across slots (re-render +
 *  auto-focus the next empty slot); a plain single-slot keystroke
 *  mutates state in place (no re-render, so the user's caret stays
 *  put) and live-updates the submit button's `disabled` flag plus the
 *  "N of 24 words entered." counter via direct DOM writes.
 *
 *  Before this factory, each of the five attribute handlers carried
 *  ~35 lines of the same logic with different state paths and submit
 *  targets. The factory takes a per-grid `config` + shared `deps` and
 *  returns a `FieldHandler` that drops straight into
 *  `attachFieldHandlers`'s map.
 *
 *  The deps split mirrors the host's own state model:
 *    - `setState(patch)` — merge + re-render (paste path only).
 *    - `patchState(patch)` — merge WITHOUT re-render (single-slot
 *      path). Typically implemented as `state = { ...state, ...patch }`
 *      in the host module. The re-render skip is what preserves caret
 *      position on every keystroke.
 */

import {
  distributeTokens,
  fromRecoveryWords,
  toRecoveryWords,
} from './recovery-words.js';
import type { FieldHandler } from './field-dispatcher.js';

export interface RecoveryGridFieldHandlerDeps<S> {
  /** Read the latest state. Called each input event — callers typically
   *  close over a module-scoped `let state` binding. */
  getState: () => S;
  /** Merge + re-render. Used on the whitespace-paste path so all 24
   *  slots repaint with the fanned-out words. */
  setState: (patch: Partial<S>) => void;
  /** Merge WITHOUT re-render. Used on single-slot keystrokes so the
   *  input keeps focus/caret. Typically `(p) => { state = {...state, ...p} }`
   *  in the host; factory never touches state directly. */
  patchState: (patch: Partial<S>) => void;
  /** Root element for DOM queries (submit button + counter + next
   *  empty slot after a paste). Returns null during teardown. */
  getRoot: () => HTMLElement | null;
}

export interface RecoveryGridFieldHandlerConfig<S> {
  /** `data-{fieldName}` attribute name (no `data-` prefix). Must match
   *  the attribute `attachFieldHandlers` mounts the handler under. */
  fieldName: string;
  /** Expected value of the `data-{fieldName}` attribute. Edits whose
   *  attribute value differs are ignored (defensive — the attach
   *  mechanism already filters by attribute name). */
  fieldValue: string;
  /** Read the joined 24-word string out of state. */
  readKey: (state: S) => string;
  /** Build the patch that writes the new joined key (and clears any
   *  related error). Applied via setState (paste) and patchState
   *  (single slot). */
  buildPatch: (key: string) => Partial<S>;
  /** `data-action` of the submit button — focus target once all 24
   *  slots fill, and the button whose `disabled` flag syncs per edit. */
  submitAction: string;
  /** Slot input `id` prefix — each slot is `{idPrefix}-{i}`. The paste
   *  path focuses the first-remaining empty slot by id. */
  idPrefix: string;
  /** CSS selector for the `<p>` that shows the "N of 24 words
   *  entered." count. Scope with an ancestor class when multiple grids
   *  can coexist on the page (e.g.
   *  `.sync-import-recover .rx-recovery-word-count`). */
  counterSelector: string;
  /** Optional extra `disabled` predicate — returns true if the submit
   *  button should stay disabled even at 24 filled words. The pair
   *  form uses this to require URL + pairing-code alongside the key. */
  extraDisabled?: (state: S) => boolean;
}

export const createRecoveryGridFieldHandler = <S>(
  config: RecoveryGridFieldHandlerConfig<S>,
  deps: RecoveryGridFieldHandlerDeps<S>,
): FieldHandler => (el) => {
  if (el.getAttribute(`data-${config.fieldName}`) !== config.fieldValue) return;
  const idx = parseInt(el.dataset.index ?? '-1', 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= 24) return;

  const input = el as HTMLInputElement;
  const raw = input.value;
  const state = deps.getState();

  if (/\s/.test(raw)) {
    const tokens = raw.split(/\s+/).filter((w) => w.length > 0);
    const current = toRecoveryWords(config.readKey(state));
    const next = distributeTokens(current, tokens, idx);
    deps.setState(config.buildPatch(fromRecoveryWords(next)));
    setTimeout(() => {
      const root = deps.getRoot();
      if (!root) return;
      const emptyIdx = next.findIndex((w) => w.length === 0);
      if (emptyIdx === -1) {
        root.querySelector<HTMLButtonElement>(`[data-action="${config.submitAction}"]`)?.focus();
      } else {
        root.querySelector<HTMLInputElement>(`#${config.idPrefix}-${emptyIdx}`)?.focus();
      }
    }, 0);
    return;
  }

  const words = toRecoveryWords(config.readKey(state));
  words[idx] = raw.trim().toLowerCase();
  deps.patchState(config.buildPatch(fromRecoveryWords(words)));

  const filled = words.filter((w) => w.length > 0).length;
  const root = deps.getRoot();
  if (root) {
    const submitBtn = root.querySelector<HTMLButtonElement>(`[data-action="${config.submitAction}"]`);
    if (submitBtn) {
      const extra = config.extraDisabled?.(deps.getState()) ?? false;
      submitBtn.disabled = filled < 24 || extra;
    }
    const counter = root.querySelector<HTMLElement>(config.counterSelector);
    if (counter) counter.textContent = `${filled} of 24 words entered.`;
  }
};
