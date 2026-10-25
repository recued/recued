/** A way off the pair form, to a server this browser can still use.
 *
 *  ── Why it has to exist ─────────────────────────────────────────────────
 *  Two things put the pair form in charge of the whole page: "Add another
 *  server…" opens a pending attempt, and a server that rejects this browser
 *  lands on "Reconnect this browser". Either way the account menu that could
 *  switch servers is gone with the shell. Without this control an owner with
 *  other working servers is stranded on a pairing screen with no route to
 *  them — the exact dead end the server switcher was built to remove. So the
 *  menu does not render "Add another server…" unless a caller can offer the
 *  way back. That attempt is saved, so every new tab opens on the pair form
 *  too until the owner pairs or leaves here.
 *
 *  ── What it is ──────────────────────────────────────────────────────────
 *  One button in a bar at the TOP of the boot splash, above the brand, as
 *  wide as the pair form's column so it lines up with the form's left edge:
 *  "← Back to <server>" when an add is open, "Use <server> instead" otherwise.
 *
 *  ⛔ It lives OUTSIDE the slot the pair form renders into, and that is
 *  load-bearing. The form redraws by replacing its slot's whole `innerHTML`
 *  on every state change, so this control — first appended INSIDE that slot,
 *  below the form — disappeared the first time the owner chose "Make a new
 *  one", and before that it sat under the 24 recovery-word boxes, below the
 *  fold. Both left the owner with no visible way back (found 2026-10-23).
 *
 *  It offers the most recently connected OTHER server this browser still
 *  holds a sign-in for. Never the active record — on a reconnect that is the
 *  very server being repaired, and the reload landed on the same form — and
 *  never a record without a sign-in, which only leads to another pair form.
 *
 *  ── Leaving with an unsent Chat message ──────────────────────────────────
 *  A server switch never moves an unsent Chat message, and every switch says
 *  so before it happens. The reconnect page holds its message in memory, out
 *  of sight, so when there is one the button opens the Account switch's
 *  review first — with the message in a read-only box and "Copy draft", as
 *  the handoff in other tabs does.
 */

import type { WebclientServerProfile } from '@recued/contracts';
import { validLastConnectedAt } from '../storage/server-profiles.js';

export const RETURN_TO_SERVER_ATTR = 'data-recued-return-to-server';
export const RETURN_TO_SERVER_BAR_ATTR = 'data-recued-return-to-server-bar';
export const RETURN_TO_SERVER_STATUS_ATTR = 'data-recued-return-to-server-status';
export const RETURN_TO_SERVER_REVIEW_ATTR = 'data-recued-return-to-server-review';
export const RETURN_TO_SERVER_DRAFT_ATTR = 'data-recued-return-to-server-draft';
export const RETURN_TO_SERVER_COPY_ATTR = 'data-recued-return-to-server-copy';
export const RETURN_TO_SERVER_COMMIT_ATTR = 'data-recued-return-to-server-commit';
export const RETURN_TO_SERVER_CANCEL_ATTR = 'data-recued-return-to-server-cancel';

const REVIEW_TITLE_ID = 'recued-return-to-server-review-title';
const REVIEW_CONSEQUENCE_ID = 'recued-return-to-server-review-consequence';
const REVIEW_DRAFT_ID = 'recued-return-to-server-review-draft';
const DRAFT_COPY_TIMEOUT_MS = 5_000;

export interface MountReturnToServerOptions {
  /** The boot splash wrapper. The bar becomes its FIRST child — above the
   *  brand, and outside the slot the pair form redraws. */
  host: HTMLElement;
  document?: Document;
  /** The roster. Only other records with an address and a sign-in are ever
   *  offered as a destination. */
  profiles: ReadonlyArray<WebclientServerProfile>;
  /** The roster's active id: the attempt or reconnect in progress. */
  activeId: string | null;
  /** The page is "Reconnect this browser". Its rejected server's record was
   *  replaced by a pending one, so the roster alone reads like an add. */
  reconnecting?: boolean;
  /** An unsent Chat message the page holds in memory. Switching loses it, so
   *  the owner reviews that first. `text` is empty when only a reply or an
   *  attachment is held. */
  unsentChat?: { readonly text: string };
  /** Chosen destination — the caller persists the switch and reloads. A
   *  rejection gives the controls back so the owner can try again. */
  onReturn: (id: string) => void | Promise<void>;
  /** "Copy draft" seam; defaults to the browser clipboard. */
  writeClipboard?: (text: string) => Promise<void>;
}

export interface ReturnToServerMount {
  /** True iff a control was actually rendered. */
  rendered(): boolean;
  dispose(): void;
}

export const RETURN_TO_SERVER_STYLES = `
[${RETURN_TO_SERVER_BAR_ATTR}] {
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  margin: 16px auto 0;
  text-align: left;
}
[${RETURN_TO_SERVER_BAR_ATTR}] button {
  min-height: 44px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(127,127,127,0.35));
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[${RETURN_TO_SERVER_BAR_ATTR}] button:hover:not(:disabled) {
  background: var(--surface-subtle, rgba(127,127,127,0.12));
}
[${RETURN_TO_SERVER_BAR_ATTR}] button:focus-visible,
[${RETURN_TO_SERVER_REVIEW_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${RETURN_TO_SERVER_BAR_ATTR}] button:disabled { cursor: progress; opacity: 0.7; }
[${RETURN_TO_SERVER_REVIEW_ATTR}] {
  padding: 12px 14px;
  border: 1px solid var(--border, rgba(127,127,127,0.35));
  border-radius: 12px;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.45;
}
[${RETURN_TO_SERVER_REVIEW_ATTR}] p { margin: 0 0 8px; }
[${RETURN_TO_SERVER_REVIEW_ATTR}] label { display: block; margin: 0 0 4px; font-weight: 600; }
[${RETURN_TO_SERVER_DRAFT_ATTR}] {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  border: 1px solid var(--border, rgba(127,127,127,0.35));
  border-radius: 8px;
  background: var(--surface-sunk, transparent);
  color: inherit;
  font: inherit;
  resize: vertical;
}
[${RETURN_TO_SERVER_REVIEW_ATTR}] .recued-return-to-server-title { font-weight: 650; }
[${RETURN_TO_SERVER_REVIEW_ATTR}] .recued-return-to-server-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
[${RETURN_TO_SERVER_BAR_ATTR}] [${RETURN_TO_SERVER_COMMIT_ATTR}] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent, #fff);
}
[${RETURN_TO_SERVER_STATUS_ATTR}] { margin: 6px 0 0; font-size: 12.5px; color: var(--fg-muted); }
[${RETURN_TO_SERVER_STATUS_ATTR}]:empty { display: none; }
`;

const hasAddress = (profile: WebclientServerProfile): boolean =>
  typeof profile.server_url === 'string' && profile.server_url.length > 0;

const hasSignIn = (profile: WebclientServerProfile): boolean =>
  profile.webclient_token !== null && profile.webclient_token !== undefined;

/** Pick the destination: the most recently connected other server with a
 *  sign-in, or null. Most-recent rather than first because the roster is
 *  insertion-ordered, and the server you were last on is the one you meant. */
const returnTarget = (
  profiles: ReadonlyArray<WebclientServerProfile>,
  activeId: string | null,
): WebclientServerProfile | null => {
  const usable = profiles.filter(
    (p) => p.id !== activeId && hasAddress(p) && hasSignIn(p),
  );
  if (usable.length === 0) return null;
  return [...usable].sort(
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

  const target = returnTarget(opts.profiles, opts.activeId);
  if (target === null) {
    // Nothing else this browser can use — a first pairing, or every other
    // server needs pairing too. Render nothing rather than a button that
    // only leads to another pair form.
    return { rendered: () => false, dispose: () => undefined };
  }

  const name = target.label;
  const active = opts.profiles.find((p) => p.id === opts.activeId);
  const goingBack = opts.reconnecting !== true
    && (active === undefined || !hasAddress(active));
  const label = goingBack ? `← Back to ${name}` : `Use ${name} instead`;

  const bar = doc.createElement('div');
  bar.setAttribute(RETURN_TO_SERVER_BAR_ATTR, '');
  const button = doc.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute(RETURN_TO_SERVER_ATTR, '');
  // Named by what it says, like every other "← Back to …" in the app. ⛔ A
  // separate "Cancel adding a server and return to …" name hid the words on
  // the button from voice control and screen readers.
  button.textContent = label;
  const status = doc.createElement('p');
  status.setAttribute(RETURN_TO_SERVER_STATUS_ATTR, '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  bar.appendChild(button);
  bar.appendChild(status);

  let disposed = false;
  let returning = false;
  let review: HTMLElement | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Hand the destination to the caller. A rejection gives every control
   *  back, restores its words, and says the switch did not happen. */
  const switchServer = (
    controls: ReadonlyArray<HTMLButtonElement>,
    restore: () => void,
    failure: string,
  ): void => {
    returning = true;
    status.textContent = '';
    for (const control of controls) control.disabled = true;
    void (async () => {
      try {
        await opts.onReturn(target.id);
      } catch (err) {
        console.error('webclient: return to server failed', err);
        returning = false;
        for (const control of controls) control.disabled = false;
        restore();
        if (!disposed) status.textContent = failure;
      }
    })();
  };

  const closeReview = (): void => {
    if (review === null || returning) return;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = null;
    bar.removeChild(review);
    review = null;
    status.textContent = '';
    button.hidden = false;
    button.focus();
  };

  const openReview = (text: string): void => {
    const panel = doc.createElement('div');
    panel.setAttribute(RETURN_TO_SERVER_REVIEW_ATTR, '');
    panel.setAttribute('role', 'group');
    panel.setAttribute('tabindex', '-1');
    panel.setAttribute('aria-labelledby', REVIEW_TITLE_ID);
    panel.setAttribute('aria-describedby', REVIEW_CONSEQUENCE_ID);
    const title = doc.createElement('p');
    title.setAttribute('id', REVIEW_TITLE_ID);
    title.className = 'recued-return-to-server-title';
    title.textContent = `Switch to ${name}?`;
    panel.appendChild(title);
    // The Account switch's words for the same boundary, verbatim.
    const consequence = doc.createElement('p');
    consequence.setAttribute('id', REVIEW_CONSEQUENCE_ID);
    consequence.textContent = `The Chat message you have not sent is only in this tab. Switching loses it. It will never be sent to, or saved on, ${name}.`;
    panel.appendChild(consequence);

    const actions = doc.createElement('div');
    actions.className = 'recued-return-to-server-actions';
    const controls: HTMLButtonElement[] = [];
    let draft: HTMLTextAreaElement | null = null;
    if (text.length > 0) {
      const draftLabel = doc.createElement('label');
      draftLabel.setAttribute('for', REVIEW_DRAFT_ID);
      draftLabel.textContent = 'A Chat message you have not sent';
      panel.appendChild(draftLabel);
      draft = doc.createElement('textarea');
      draft.setAttribute('id', REVIEW_DRAFT_ID);
      draft.setAttribute(RETURN_TO_SERVER_DRAFT_ATTR, '');
      draft.setAttribute('readonly', '');
      draft.value = text;
      panel.appendChild(draft);
      const copy = doc.createElement('button');
      copy.setAttribute('type', 'button');
      copy.setAttribute(RETURN_TO_SERVER_COPY_ATTR, '');
      copy.textContent = 'Copy draft';
      const field = draft;
      let copyPending = false;
      copy.addEventListener('click', () => {
        if (returning || copyPending) return;
        copyPending = true;
        copy.setAttribute('aria-busy', 'true');
        status.textContent = 'Copying the message…';
        let settled = false;
        const finish = (copied: boolean): void => {
          if (settled) return;
          settled = true;
          if (copyTimer !== null) clearTimeout(copyTimer);
          copyTimer = null;
          copyPending = false;
          copy.removeAttribute('aria-busy');
          if (disposed || review !== panel) return;
          if (copied) {
            status.textContent = `Copied. It is still not saved on ${name}.`;
            return;
          }
          let selected = false;
          try {
            field.focus();
            field.setSelectionRange(0, field.value.length);
            selected = true;
          } catch {
            /* the message stays in the box for manual selection */
          }
          status.textContent = selected
            ? 'Recued could not copy it. The message is selected, so you can copy it yourself.'
            : 'Recued could not copy it. Select the message above and copy it yourself.';
        };
        let write = opts.writeClipboard;
        if (write === undefined) {
          const clipboard = doc.defaultView?.navigator?.clipboard;
          if (typeof clipboard?.writeText === 'function') {
            write = (value) => clipboard.writeText(value);
          }
        }
        if (write === undefined) {
          finish(false);
          return;
        }
        copyTimer = setTimeout(() => finish(false), DRAFT_COPY_TIMEOUT_MS);
        try {
          void Promise.resolve(write(text)).then(
            () => finish(true),
            () => finish(false),
          );
        } catch {
          finish(false);
        }
      });
      actions.appendChild(copy);
      controls.push(copy);
    }

    const commit = doc.createElement('button');
    commit.setAttribute('type', 'button');
    commit.setAttribute(RETURN_TO_SERVER_COMMIT_ATTR, '');
    commit.textContent = 'Switch server';
    const cancel = doc.createElement('button');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute(RETURN_TO_SERVER_CANCEL_ATTR, '');
    cancel.textContent = 'Cancel';
    controls.push(commit, cancel);
    commit.addEventListener('click', () => {
      if (returning) return;
      commit.textContent = 'Switching…';
      switchServer(
        controls,
        () => { commit.textContent = 'Switch server'; },
        'Couldn’t switch servers. Your message is still here; try again.',
      );
    });
    cancel.addEventListener('click', closeReview);
    panel.addEventListener('keydown', (event: Event) => {
      if ((event as KeyboardEvent).key !== 'Escape' || returning) return;
      event.preventDefault();
      closeReview();
    });
    actions.appendChild(commit);
    actions.appendChild(cancel);
    panel.appendChild(actions);

    review = panel;
    button.hidden = true;
    bar.insertBefore(panel, status);
    panel.focus();
  };

  button.addEventListener('click', () => {
    if (returning || review !== null) return;
    if (opts.unsentChat !== undefined) {
      openReview(opts.unsentChat.text);
      return;
    }
    button.textContent = goingBack
      ? `Going back to ${name}…`
      : `Switching to ${name}…`;
    switchServer(
      [button],
      () => { button.textContent = label; },
      goingBack
        ? `Couldn’t go back to ${name}. Try again.`
        : `Couldn’t switch to ${name}. Try again.`,
    );
  });
  opts.host.insertBefore(bar, opts.host.firstChild);

  return {
    rendered: () => true,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = null;
      try {
        opts.host.removeChild(bar);
      } catch {
        /* already detached (splash torn down first) — best-effort */
      }
    },
  };
};
