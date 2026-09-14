/** Blocking handoff for a sibling-tab server-profile switch.
 *
 * The durable active-profile pointer is origin-wide, while an already-mounted
 * shell is still connected to the server it booted with. Once those identities
 * diverge, leaving the old shell interactive risks mixing server-specific work
 * with credential writes aimed at the new profile. This overlay pauses the old
 * shell, keeps any Chat draft in memory only, and makes the discard boundary
 * explicit before the tab reloads against the durable target.
 */

import {
  isInFlightServerSwitchWorkState,
  serverSwitchWorkStateHasChatDraft,
  type ServerSwitchWorkState,
} from './server-switcher.js';
import type { ServerSwitchActiveWork } from './server-switch-work-tracker.js';

export const SERVER_SWITCH_CONVERGENCE_ATTR =
  'data-recued-server-switch-convergence';
export const SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR =
  'data-recued-server-switch-convergence-dialog';
export const SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR =
  'data-recued-server-switch-convergence-draft';
export const SERVER_SWITCH_CONVERGENCE_COPY_ATTR =
  'data-recued-server-switch-convergence-copy';
export const SERVER_SWITCH_CONVERGENCE_CHECK_ATTR =
  'data-recued-server-switch-convergence-check';
export const SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR =
  'data-recued-server-switch-convergence-commit';
export const SERVER_SWITCH_CONVERGENCE_ERROR_ATTR =
  'data-recued-server-switch-convergence-error';
export const SERVER_SWITCH_CONVERGENCE_STATUS_ATTR =
  'data-recued-server-switch-convergence-status';
export const SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ATTR =
  'data-recued-server-switch-convergence-active-work';
export const SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ITEM_ATTR =
  'data-recued-server-switch-convergence-active-work-item';
export const SERVER_SWITCH_CONVERGENCE_STYLES_MARKER =
  'data-recued-server-switch-convergence-styles';

export const SERVER_SWITCH_CONVERGENCE_STYLES = `
[${SERVER_SWITCH_CONVERGENCE_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 180;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: max(16px, env(safe-area-inset-top)) 16px
    max(16px, env(safe-area-inset-bottom));
  background: rgba(24, 33, 36, .48);
}
[${SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR}] {
  box-sizing: border-box;
  width: min(560px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--recued-border, rgba(127,127,127,.35));
  border-radius: 14px;
  background: var(--recued-surface, #fff);
  color: var(--recued-text, #172226);
  box-shadow: 0 24px 64px rgba(0, 0, 0, .24);
}
[${SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR}] h2 {
  margin: 0 0 8px;
  font-size: 20px;
  line-height: 1.25;
}
[${SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR}] p {
  margin: 0 0 12px;
  line-height: 1.5;
}
[${SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR}] .recued-switch-convergence-identity {
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--recued-surface-subtle, rgba(127,127,127,.09));
  overflow-wrap: anywhere;
}
[${SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ATTR}] {
  display: grid;
  gap: 6px;
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}
[${SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ITEM_ATTR}] {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--recued-surface-subtle, rgba(127,127,127,.09));
  font-size: 13px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR}] {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  margin: 4px 0 10px;
  padding: 10px 12px;
  resize: vertical;
  border: 1px solid var(--recued-border, rgba(127,127,127,.4));
  border-radius: 8px;
  background: var(--recued-surface, #fff);
  color: inherit;
  font: inherit;
}
[${SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR}] .recued-switch-convergence-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
[${SERVER_SWITCH_CONVERGENCE_COPY_ATTR}],
[${SERVER_SWITCH_CONVERGENCE_CHECK_ATTR}],
[${SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR}] {
  min-height: 44px;
  padding: 8px 14px;
  border: 1px solid var(--recued-border, rgba(127,127,127,.45));
  border-radius: 9px;
  background: var(--recued-surface, #fff);
  color: inherit;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
[${SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR}] {
  border-color: var(--recued-accent, #315cbd);
  background: var(--recued-accent, #315cbd);
  color: var(--recued-on-accent, #fff);
}
[${SERVER_SWITCH_CONVERGENCE_COPY_ATTR}]:focus-visible,
[${SERVER_SWITCH_CONVERGENCE_CHECK_ATTR}]:focus-visible,
[${SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR}]:focus-visible,
[${SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR}]:focus-visible {
  outline: 2px solid var(--recued-accent, #315cbd);
  outline-offset: 2px;
}
[${SERVER_SWITCH_CONVERGENCE_ERROR_ATTR}] {
  color: var(--recued-danger, #b3261e);
  font-weight: 600;
}
[${SERVER_SWITCH_CONVERGENCE_STATUS_ATTR}] {
  min-height: 1.5em;
  color: var(--recued-muted, #5f6b70);
  font-size: 13px;
}
@media (prefers-color-scheme: dark) {
  [${SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR}],
  [${SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR}],
  [${SERVER_SWITCH_CONVERGENCE_COPY_ATTR}],
  [${SERVER_SWITCH_CONVERGENCE_CHECK_ATTR}] {
    background: var(--recued-surface, #172226);
    color: var(--recued-text, #eef4f6);
  }
}
`;

export interface ServerSwitchConvergenceIdentity {
  readonly id: string;
  readonly label: string;
  readonly serverUrl: string;
}

export interface ServerSwitchConvergenceState {
  readonly source: ServerSwitchConvergenceIdentity;
  readonly target: ServerSwitchConvergenceIdentity;
  readonly workState: ServerSwitchWorkState;
  /** Exact actions still owned by the source-server boot. */
  readonly activeWork?: ReadonlyArray<ServerSwitchActiveWork>;
  /** Kept in this mount only; never written to storage or moved to the target. */
  readonly chatDraft?: string;
  readonly error?: string;
  readonly status?: string;
}

export interface MountServerSwitchConvergenceOptions {
  readonly portal: HTMLElement;
  readonly background: HTMLElement;
  readonly state: ServerSwitchConvergenceState;
  readonly document?: Document;
  readonly onContinue: (
    targetProfileId: string,
    reviewedWorkState: ServerSwitchWorkState,
    reviewedActiveWork?: ReadonlyArray<ServerSwitchActiveWork>,
  ) => void | Promise<void>;
  /** Re-read the durable target and source-route activity without leaving.
   * null means the server choice returned to this tab's source. */
  readonly onCheck?: (
    targetProfileId: string,
  ) => ServerSwitchConvergenceState
    | null
    | Promise<ServerSwitchConvergenceState | null>;
  readonly writeClipboard?: (text: string) => Promise<void>;
}

export interface ServerSwitchConvergenceMount {
  update(state: ServerSwitchConvergenceState): void;
  dispose(): void;
}

const errorCopy = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'This tab could not change servers. Try again.';

const identityCopy = (identity: ServerSwitchConvergenceIdentity): string =>
  identity.serverUrl.trim().length > 0
    ? `${identity.label} (${identity.serverUrl})`
    : identity.label;

export const mountServerSwitchConvergence = (
  opts: MountServerSwitchConvergenceOptions,
): ServerSwitchConvergenceMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountServerSwitchConvergence: no document available');
  }
  if (
    doc.head !== undefined
    && doc.head.querySelector(
      `style[${SERVER_SWITCH_CONVERGENCE_STYLES_MARKER}]`,
    ) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(SERVER_SWITCH_CONVERGENCE_STYLES_MARKER, '');
    style.textContent = SERVER_SWITCH_CONVERGENCE_STYLES;
    doc.head.appendChild(style);
  }

  const overlay = doc.createElement('div');
  overlay.setAttribute(SERVER_SWITCH_CONVERGENCE_ATTR, '');
  const dialog = doc.createElement('section');
  dialog.setAttribute(SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR, '');
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('tabindex', '-1');
  overlay.appendChild(dialog);
  const returnFocus = doc.activeElement as HTMLElement | null | undefined;
  const obscured = new Map<HTMLElement, boolean>();
  for (const child of Array.from(opts.portal.children)) {
    const element = child as HTMLElement;
    if (element === overlay) continue;
    obscured.set(element, element.hasAttribute('inert'));
    element.setAttribute('inert', '');
  }
  if (!obscured.has(opts.background)) {
    obscured.set(opts.background, opts.background.hasAttribute('inert'));
    opts.background.setAttribute('inert', '');
  }
  opts.portal.appendChild(overlay);
  let state = opts.state;
  let busy: 'checking' | 'switching' | null = null;
  // A durable target can change while a status check/reload preflight awaits
  // IndexedDB. Any external update invalidates that older completion so it
  // cannot repaint a stale destination or error over the newer review.
  let actionRevision = 0;
  let disposed = false;
  let focusables: HTMLElement[] = [];
  let focusAfterRender: HTMLElement | null = null;
  let statusNode: HTMLElement | null = null;

  const focus = (element: HTMLElement | null | undefined): void => {
    if (element == null || typeof element.focus !== 'function') return;
    try {
      element.focus({ preventScroll: true });
    } catch {
      /* fake/detached DOM — modal semantics remain intact */
    }
  };

  const render = (): void => {
    while (dialog.firstChild !== null) dialog.removeChild(dialog.firstChild);
    focusables = [];

    const titleId = 'recued-server-switch-convergence-title';
    const identityId = 'recued-server-switch-convergence-identity';
    const detailId = 'recued-server-switch-convergence-detail';
    const boundaryId = 'recued-server-switch-convergence-boundary';
    const activeWorkId = 'recued-server-switch-convergence-active-work';
    const renderedActiveWork = state.activeWork ?? [];
    const resultReadyOnly = renderedActiveWork.length > 0
      && renderedActiveWork.every((work) => work.phase === 'result_ready');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute(
      'aria-describedby',
      [
        identityId,
        detailId,
        ...(renderedActiveWork.length > 0 ? [activeWorkId] : []),
        boundaryId,
      ].join(' '),
    );
    if (busy !== null) dialog.setAttribute('aria-busy', 'true');
    else dialog.removeAttribute('aria-busy');

    const title = doc.createElement('h2');
    title.setAttribute('id', titleId);
    title.textContent = 'Server changed in another tab';
    dialog.appendChild(title);

    const identity = doc.createElement('p');
    identity.setAttribute('id', identityId);
    identity.className = 'recued-switch-convergence-identity';
    identity.textContent =
      `This tab is still showing ${identityCopy(state.source)}. `
      + `Another tab selected ${identityCopy(state.target)}.`;
    dialog.appendChild(identity);

    const detail = doc.createElement('p');
    detail.setAttribute('id', detailId);
    detail.textContent = state.workState === 'chat_draft'
      ? 'The Chat message you have not sent is only in this tab. Copy it if you need it. Recued will never move it to another server on its own.'
      : state.workState === 'unsaved_changes'
        ? 'You have unsaved changes on the first server. Recued paused this tab so they cannot get mixed up with another server.'
        : state.workState === 'in_flight_with_chat_draft'
          ? resultReadyOnly
            ? 'There is a result waiting on the first server, and a Chat message you have not sent. If you leave now, the result stays there and the message is lost.'
            : 'The first server is still working, and you have a Chat message you have not sent. Check how it is going before you switch. Leaving now cannot finish or stop the work, and the message is lost.'
          : state.workState === 'in_flight_with_unsaved_changes'
            ? resultReadyOnly
              ? 'There is a result waiting on the first server, and this tab may have unsaved changes. If you leave now, the result stays there and anything unsaved is lost.'
              : 'The first server is still working, and this tab may have unsaved changes. Check how it is going before you switch. Leaving now cannot finish or stop work that may already have reached it.'
            : state.workState === 'in_flight'
              ? resultReadyOnly
                ? 'There is a result waiting on the first server. If you leave now, it stays there.'
                : 'The first server is still working. Check how it is going before you switch. Leaving now cannot finish or stop work that may already have reached it.'
              : 'Recued paused this tab so two servers’ things could not get mixed up.';
    dialog.appendChild(detail);

    if (renderedActiveWork.length > 0) {
      const activeWork = doc.createElement('ul');
      activeWork.setAttribute(SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ATTR, '');
      activeWork.setAttribute('id', activeWorkId);
      activeWork.setAttribute('aria-label', 'Work and results on the first server');
      for (const work of renderedActiveWork) {
        const item = doc.createElement('li');
        item.setAttribute(SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ITEM_ATTR, '');
        item.setAttribute('data-work-id', work.id);
        item.textContent = work.label;
        activeWork.appendChild(item);
      }
      dialog.appendChild(activeWork);
    }

    if (
      serverSwitchWorkStateHasChatDraft(state.workState)
      && state.chatDraft !== undefined
    ) {
      const label = doc.createElement('label');
      label.setAttribute('for', 'recued-server-switch-convergence-draft');
      label.textContent = 'A Chat message you have not sent';
      dialog.appendChild(label);
      const draft = doc.createElement('textarea');
      draft.setAttribute('id', 'recued-server-switch-convergence-draft');
      draft.setAttribute(SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR, '');
      draft.setAttribute('readonly', '');
      draft.value = state.chatDraft;
      dialog.appendChild(draft);
      focusables.push(draft);
    }

    const boundary = doc.createElement('p');
    boundary.setAttribute('id', boundaryId);
    boundary.textContent = isInFlightServerSwitchWorkState(state.workState)
      ? 'Whatever happened stays on the first server. Go back and check before you try again. This tab will only reopen the same safe place.'
      : 'Chats, records, runs and links belong to one server and stay there. This tab will only reopen the same safe place.';
    dialog.appendChild(boundary);

    if (state.error !== undefined) {
      const error = doc.createElement('p');
      error.setAttribute(SERVER_SWITCH_CONVERGENCE_ERROR_ATTR, '');
      error.setAttribute('role', 'alert');
      error.setAttribute('tabindex', '-1');
      error.textContent = state.error;
      dialog.appendChild(error);
      focusAfterRender = error;
    }

    const status = doc.createElement('p');
    status.setAttribute(SERVER_SWITCH_CONVERGENCE_STATUS_ATTR, '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = state.status ?? '';
    dialog.appendChild(status);
    statusNode = status;

    const actions = doc.createElement('div');
    actions.className = 'recued-switch-convergence-actions';
    if (
      serverSwitchWorkStateHasChatDraft(state.workState)
      && state.chatDraft !== undefined
    ) {
      const copy = doc.createElement('button');
      copy.setAttribute('type', 'button');
      copy.setAttribute(SERVER_SWITCH_CONVERGENCE_COPY_ATTR, '');
      copy.textContent = 'Copy draft';
      if (busy !== null) copy.setAttribute('disabled', '');
      copy.addEventListener('click', () => {
        if (busy !== null) return;
        const write = opts.writeClipboard
          ?? (doc.defaultView?.navigator?.clipboard?.writeText
            ? (text: string) => doc.defaultView!.navigator.clipboard.writeText(text)
            : undefined);
        if (write === undefined) {
          status.textContent = 'Select the message above and copy it yourself.';
          focus(focusables[0] ?? null);
          return;
        }
        void write(state.chatDraft ?? '').then(
          () => { status.textContent = 'Copied. It is still not saved on the new server.'; },
          () => {
            status.textContent = 'Couldn’t copy automatically. Select the message above and copy it yourself.';
            focus(focusables[0] ?? null);
          },
        );
      });
      actions.appendChild(copy);
      focusables.push(copy);
    }

    if (
      isInFlightServerSwitchWorkState(state.workState)
      && opts.onCheck !== undefined
    ) {
      const check = doc.createElement('button');
      check.setAttribute('type', 'button');
      check.setAttribute(SERVER_SWITCH_CONVERGENCE_CHECK_ATTR, '');
      check.textContent = busy === 'checking' ? 'Checking…' : 'Check status';
      if (busy !== null) check.setAttribute('disabled', '');
      check.addEventListener('click', () => {
        if (busy !== null || disposed) return;
        const requestedTarget = state.target.id;
        const revision = ++actionRevision;
        busy = 'checking';
        state = {
          ...state,
          error: undefined,
          status: 'Checking the first server…',
        };
        render();
        void Promise.resolve()
          .then(() => opts.onCheck?.(requestedTarget) ?? null)
          .then((nextState) => {
            if (
              disposed
              || revision !== actionRevision
              || nextState === null
            ) return;
            busy = null;
            state = nextState;
            render();
          })
          .catch((error: unknown) => {
            if (disposed || revision !== actionRevision) return;
            busy = null;
            const { status: _status, ...prior } = state;
            state = { ...prior, error: errorCopy(error) };
            render();
          });
      });
      actions.appendChild(check);
      focusables.push(check);
    }

    const commit = doc.createElement('button');
    commit.setAttribute('type', 'button');
    commit.setAttribute(SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR, '');
    commit.textContent = busy === 'switching'
      ? 'Switching…'
      : busy === 'checking'
        ? 'Checking…'
        : state.workState === 'chat_draft'
          ? 'Switch, and lose the message'
          : state.workState === 'unsaved_changes'
            ? 'Switch, and lose the changes'
            : isInFlightServerSwitchWorkState(state.workState)
              ? resultReadyOnly
                ? 'Switch, and look later'
                : 'Switch, and check later'
              : 'Reload this tab';
    if (busy !== null) commit.setAttribute('disabled', '');
    commit.addEventListener('click', () => {
      if (busy !== null || disposed) return;
      const requestedTarget = state.target.id;
      const reviewedWorkState = state.workState;
      const reviewedActiveWork = state.activeWork ?? [];
      const revision = ++actionRevision;
      busy = 'switching';
      state = { ...state, error: undefined };
      render();
      void Promise.resolve()
        .then(() => reviewedActiveWork.length > 0
          ? opts.onContinue(
              requestedTarget,
              reviewedWorkState,
              reviewedActiveWork,
            )
          : opts.onContinue(requestedTarget, reviewedWorkState))
        .catch((error: unknown) => {
          if (disposed || revision !== actionRevision) return;
          busy = null;
          state = { ...state, error: errorCopy(error) };
          render();
        });
    });
    actions.appendChild(commit);
    focusables.push(commit);
    dialog.appendChild(actions);

    const nextFocus = focusAfterRender
      ?? (busy !== null ? dialog : focusables[0])
      ?? dialog;
    focusAfterRender = null;
    focus(nextFocus);
  };

  const docEvents = doc as unknown as {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  };
  const onKeydown = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === 'Escape') {
      keyEvent.preventDefault();
      if (statusNode !== null) {
        statusNode.textContent =
          'Finish changing servers before you go back.';
      }
      return;
    }
    if (keyEvent.key !== 'Tab') return;
    if (busy !== null) {
      keyEvent.preventDefault();
      focus(dialog);
      return;
    }
    const active = doc.activeElement as HTMLElement | null;
    const current = active === null ? -1 : focusables.indexOf(active);
    const next = keyEvent.shiftKey
      ? current <= 0 ? focusables.length - 1 : current - 1
      : current < 0 || current >= focusables.length - 1 ? 0 : current + 1;
    keyEvent.preventDefault();
    focus(focusables[next] ?? dialog);
  };
  docEvents.addEventListener?.('keydown', onKeydown);
  render();

  return {
    update(nextState) {
      if (disposed) return;
      actionRevision += 1;
      state = nextState;
      busy = null;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      actionRevision += 1;
      docEvents.removeEventListener?.('keydown', onKeydown);
      for (const [element, wasInert] of obscured) {
        if (!wasInert) element.removeAttribute('inert');
      }
      try {
        opts.portal.removeChild(overlay);
      } catch {
        overlay.remove();
      }
      focus(returnFocus);
    },
  };
};
