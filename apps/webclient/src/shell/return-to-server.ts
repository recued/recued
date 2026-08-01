/** "Back to <server>" — the way out of an abandoned add-a-server attempt.
 *
 *  ── Why it has to exist ─────────────────────────────────────────────────
 *  Adding a server means leaving the shell: the pair form owns the whole
 *  page, and the account menu that got you here is gone with it. Without a
 *  return, an owner who changes their mind is stranded on a pairing screen
 *  with no route back to the server that still works — which is the exact
 *  dead end this feature set was built to remove, reintroduced one step
 *  further along. So the entry point and this control ship together; the menu
 *  does not render "Add another server…" unless a caller can offer the way
 *  back.
 *
 *  ── What it is ──────────────────────────────────────────────────────────
 *  One button, appended beside the pair form rather than inside it, so the
 *  pairing component stays untouched. It renders only when the roster holds a
 *  server other than the attempt in progress — with nothing to return to,
 *  a back button is a lie.
 */

import type { WebclientServerProfile } from '@recued/contracts';
import { validLastConnectedAt } from '../storage/server-profiles.js';

export const RETURN_TO_SERVER_ATTR = 'data-recued-return-to-server';

export interface MountReturnToServerOptions {
  /** Element the control is appended to (the boot splash slot). */
  host: HTMLElement;
  document?: Document;
  /** The roster. Pending records (no URL) are the attempt in progress and are
   *  never offered as a destination. */
  profiles: ReadonlyArray<WebclientServerProfile>;
  /** Chosen destination — the caller persists the switch and reloads. */
  onReturn: (id: string) => void;
}

export interface ReturnToServerMount {
  /** True iff a control was actually rendered. */
  rendered(): boolean;
  dispose(): void;
}

export const RETURN_TO_SERVER_STYLES = `
[${RETURN_TO_SERVER_ATTR}] {
  display: block;
  margin: 16px auto 0;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid var(--recued-border, rgba(127,127,127,0.35));
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[${RETURN_TO_SERVER_ATTR}]:hover { background: var(--recued-surface-hover, rgba(127,127,127,0.12)); }
`;

/** Pick the server to return to: the most recently connected one that is not
 *  a pending attempt. Most-recent rather than first because the roster is
 *  insertion-ordered, and the server you were last on is the one you meant. */
const returnTarget = (
  profiles: ReadonlyArray<WebclientServerProfile>,
): WebclientServerProfile | null => {
  const connectable = profiles.filter(
    (p) => typeof p.server_url === 'string' && p.server_url.length > 0,
  );
  if (connectable.length === 0) return null;
  return [...connectable].sort(
    (a, b) => (validLastConnectedAt(b) ?? 0) - (validLastConnectedAt(a) ?? 0),
  )[0] ?? null;
};

export const mountReturnToServer = (
  opts: MountReturnToServerOptions,
): ReturnToServerMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReturnToServer: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const target = returnTarget(opts.profiles);
  if (target === null) {
    // Nothing paired but the attempt itself — a first pairing, where "back"
    // has no meaning. Render nothing rather than a button that cannot work.
    return { rendered: () => false, dispose: () => undefined };
  }

  const button = doc.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute(RETURN_TO_SERVER_ATTR, '');
  button.textContent = `← Back to ${target.label}`;
  button.setAttribute(
    'aria-label',
    `Cancel adding a server and return to ${target.label}`,
  );
  button.addEventListener('click', () => opts.onReturn(target.id));
  opts.host.appendChild(button);

  let disposed = false;
  return {
    rendered: () => true,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        opts.host.removeChild(button);
      } catch {
        /* already detached (splash torn down first) — best-effort */
      }
    },
  };
};
