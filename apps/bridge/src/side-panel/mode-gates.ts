/** What the side panel SHOWS at each per-bridge notification mode.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE THE ANSWER WAS GUESSED WRONG TWICE IN A ROW, in
 *  opposite directions. First: "the modes gate OS notifications only, the panel
 *  renders regardless". Then, over-correcting off a comment in
 *  `service-worker-bootstrap.ts` that says the panel gates "its approval-card
 *  rendering" on the mode: "with approval off the panel shows nothing". Neither
 *  is true. `bridge_mode.approval` decides whether the rows are ANSWERABLE, and
 *  `bridge_mode.notification` swaps the notifications body for an opt-in card —
 *  in both cases the section stays VISIBLE, because "nothing silently
 *  disappears" is an owner decision recorded at each call site.
 *
 *  🔑 THE DECISION IS EXTRACTED FROM THE RENDERING ON PURPOSE. This repo has no
 *  jsdom or happy-dom and its DOM tests are hand-rolled fake-document doubles
 *  whose own comments record their blind spots ("has no `style`"). A shim big
 *  enough to render `views.ts` plus `@recued/ui-shared/approval-card` would make
 *  the SHIM the thing under test — and the fidelity of that shim is exactly the
 *  question. So the branch choice is a pure function, exhaustively testable with
 *  no DOM, and `views.ts` consumes it rather than restating it.
 *
 *  ⚠ WHAT THIS DOES AND DOES NOT PROVE. It pins WHICH branch each mode selects.
 *  It says nothing about the pixels: only a real extension against a real server
 *  proves the rendered result. That check is deliberately still open. */

/** Which body the approvals section shows.
 *
 *  ⚠ `interactive` requires BOTH an item and an answer handler. The handler is
 *  present only when this bridge holds `bridge_mode.approval` — absent, the
 *  rows still render, read-only. */
export type ApprovalsBody =
  | 'error'
  | 'loading'
  /** No items, and this bridge answers approvals: nothing waits (2026-11-04).
   *  Before, this said to enable Approval mode, already on, which read as a
   *  fault once approvals led the panel. */
  | 'empty'
  /** No items, and this bridge does not answer approvals. The copy names the
   *  remedy, which is why a reviewer with the mode off is not left guessing:
   *  "Enable Approval mode in Settings → Notifications to opt in." */
  | 'empty-opt-in'
  /** Items, no handler → visible but not answerable. */
  | 'read-only'
  /** Items + handler → answerable cards. */
  | 'interactive';

export const approvalsBody = (input: {
  error: string | null | undefined;
  itemCount: number;
  loading: boolean;
  /** True iff this bridge holds `bridge_mode.approval`. */
  canAnswer: boolean;
}): ApprovalsBody => {
  if (input.error) return 'error';
  if (input.itemCount === 0) return input.loading ? 'loading' : input.canAnswer ? 'empty' : 'empty-opt-in';
  return input.canAnswer ? 'interactive' : 'read-only';
};

/** Which body the notifications section shows.
 *
 *  ⚠ `off` is NOT a hidden section. The renderer keeps the section visible and
 *  substitutes an opt-in card; live items and load errors are suppressed while
 *  off, so an error must not out-rank the mode. */
export type NotificationsBody = 'off' | 'error' | 'loading' | 'empty' | 'items';

export const notificationsBody = (input: {
  /** `bridge_mode.notification`. Undefined ⇒ render normally: the renderer
   *  default. The mount always passes it explicitly, and it is `false` until the
   *  self-scoped mode fetch lands — fail-closed. */
  enabled: boolean | undefined;
  error: string | null | undefined;
  itemCount: number;
  loading: boolean;
}): NotificationsBody => {
  // ⛔ THE MODE OUT-RANKS EVERYTHING, INCLUDING AN ERROR. While off, "live
  // items / load errors are suppressed — nothing surfaces here"; letting an
  // error through would leak the very traffic the mode is meant to withhold.
  if (input.enabled === false) return 'off';
  if (input.error) return 'error';
  if (input.itemCount === 0) return input.loading ? 'loading' : 'empty';
  return 'items';
};

/** Whether the active-executions rows carry control buttons.
 *
 *  ⚠ Same gate as the approvals handler and the same fallback: absent → "the
 *  section renders a read-only mirror (no buttons)". */
export const activeRowsAreControllable = (input: { canControl: boolean }): boolean =>
  input.canControl;

/** The two flags a bridge holds, as the server reports them.
 *
 *  ⚠ `null` — the caller is not a recognised paired bridge — is BOTH-OFF, not
 *  "unknown". The panel is fail-closed by design: no interactive card unless the
 *  server affirmatively reports approval ON. */
export const bridgeModeFlags = (
  modes: { notification: boolean; approval: boolean } | null | undefined,
): { notification: boolean; approval: boolean } => ({
  notification: modes?.notification === true,
  approval: modes?.approval === true,
});
