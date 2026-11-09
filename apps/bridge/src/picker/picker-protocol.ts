/** "Watch this element" picker — message protocol (brick 2).
 *
 *  The injected picker content script (picker-content-entry.ts) runs in
 *  the page's isolated world and delivers its outcome back to the service
 *  worker via `chrome.runtime.sendMessage`. Brick 3 adds the SW-side
 *  listener that forwards `picked` to `triggers.createElementWatch`.
 *
 *  Pure constants/types only — NO DOM references — so the SW bundle can
 *  import the message shape without pulling in the overlay's `document`
 *  side effects. */

export const PICKER_RESULT_MESSAGE_TYPE = 'recued.bridge.picker.result' as const;

/** The user picked an element and confirmed. */
export interface PickerPickedResult {
  readonly status: 'picked';
  /** The chosen (possibly user-edited) CSS selector. Non-empty; may
   *  contain spaces (`>` combinators / `:nth-of-type`). */
  readonly selector: string;
  /** `location.href` of the picked page. Brick 3 derives the Chrome
   *  match-pattern url (the watch's first half) from this. */
  readonly page_url: string;
  /** What the matched element shows at confirm time (a form field's value,
   *  else its `innerText`) — a preview of what the watch will read. `null`
   *  when the selector matched nothing or the field is protected. */
  readonly sample_text: string | null;
}

/** The user dismissed the picker (Cancel / Escape) without choosing. */
export interface PickerCancelledResult {
  readonly status: 'cancelled';
}

export type PickerResult = PickerPickedResult | PickerCancelledResult;

export interface PickerResultMessage {
  readonly type: typeof PICKER_RESULT_MESSAGE_TYPE;
  readonly result: PickerResult;
}

/** A selector usable as a dom-watch target: non-empty once trimmed and
 *  free of `{{` — a literal `{{` is rejected as a template ref by the
 *  dom-watch sugar validator (packages/contracts/src/trigger-sugar.ts),
 *  so the picker must never emit one (the field is user-editable). The
 *  overlay gates Confirm on this, and the message guard re-checks it so a
 *  forged/garbled result can't reach brick 3's rpc. */
export const isUsablePickedSelector = (selector: string): boolean => {
  const trimmed = selector.trim();
  return trimmed.length > 0 && !trimmed.includes('{{');
};

/** Narrow an arbitrary `chrome.runtime.onMessage` payload to a picker
 *  result message. Brick 3's SW listener uses this. */
export const isPickerResultMessage = (message: unknown): message is PickerResultMessage => {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { type?: unknown; result?: unknown };
  if (m.type !== PICKER_RESULT_MESSAGE_TYPE) return false;
  const r = m.result as { status?: unknown } | null | undefined;
  if (typeof r !== 'object' || r === null) return false;
  if (r.status === 'cancelled') return true;
  if (r.status !== 'picked') return false;
  const picked = r as { selector?: unknown; page_url?: unknown; sample_text?: unknown };
  return (
    typeof picked.selector === 'string' &&
    isUsablePickedSelector(picked.selector) &&
    typeof picked.page_url === 'string' &&
    (picked.sample_text === null || typeof picked.sample_text === 'string')
  );
};
