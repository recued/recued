/** D-119 Phase 3 + 7 — top-bar avatar slot.
 *
 *  The avatar is the entry point to the per-account Global page.
 *  Phase 3 stubbed the click to `open-account` / `open-signin`;
 *  Phase 7 routes the signed-in case to the sidebar-mounted Global
 *  page (`open-global-page` action). Signed-out callers still
 *  deep-link to options sign-in — there's no account state to show
 *  yet.
 *
 *  Two visual states:
 *    - signed in    → filled avatar glyph, hover tooltip = email,
 *                     click → `open-global-page`
 *    - signed out   → outlined avatar glyph, hover tooltip =
 *                     "Sign in to publish recipes", click → `open-signin`
 *
 *  The slot is always present so the top-bar layout stays stable across
 *  auth state changes.
 *
 *  Pure module. */

import { e } from '../template.js';

export interface AvatarState {
  /** Signed-in user, or `null` when anonymous. The email is only used
   *  for the hover tooltip; we never render it inside the avatar
   *  itself (the full email chip lives on the Global page). */
  user: { id: string; email: string } | null;
}

export const renderAvatar = (state: AvatarState): string => {
  if (!state.user) {
    return `
      <button type="button"
        class="top-bar-avatar top-bar-avatar--signed-out"
        data-action="open-signin"
        aria-label="Sign in to publish recipes"
        title="Sign in to publish recipes">
        <span class="top-bar-avatar-glyph" aria-hidden="true">👤</span>
      </button>
    `;
  }
  const email = state.user.email;
  const tooltip = `${email} — Profile & Global Settings`;
  const initial = email.charAt(0).toUpperCase() || '·';
  return `
    <button type="button"
      class="top-bar-avatar top-bar-avatar--signed-in"
      data-action="open-global-page"
      aria-label="${e(tooltip)}"
      title="${e(tooltip)}">
      <span class="top-bar-avatar-glyph" aria-hidden="true">${e(initial)}</span>
    </button>
  `;
};
