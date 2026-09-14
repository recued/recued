/** D-178 — Settings → Updates page acceptance.
 *
 *  Drives `mountUpdatesPage` through a fake Document (the webclient's per-test
 *  fake-DOM pattern) with injected rpc callers. Covers the check → available →
 *  apply (+ major force) flow, the mode toggle (incl. env-lock), rollback, the
 *  availability callback that drives the rail badge, the periodic poll, and
 *  dispose. */

import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';

import type {
  ReleaseCheckResponse,
  UpdateApplyResponse,
  UpdateMode,
  UpdateModeStatus,
  UpdateRollbackArgs,
  UpdateRollbackResponse,
} from '@recued/contracts';
import type {
  ServerUpdateReceiptVerificationState,
} from '@recued/ui-shared';

import {
  createCredentialRotationServerUpdateContinuity,
} from '../connections/credential-rotation-server-update-continuity.js';
import type {
  CredentialRotationOwnershipLease,
  CredentialRotationTabConvergence,
  CredentialRotationTabHint,
  ServerUpdateTabProgress,
} from '../connections/credential-rotation-tab-convergence.js';
import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import {
  UPDATES_CREDENTIAL_RETRY_ATTR,
  UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR,
  UPDATES_CREDENTIAL_RETRY_IDENTITY_ATTR,
  UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR,
  UPDATES_CREDENTIAL_RETRY_RETURN_ATTR,
  UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
  UPDATES_APPLY_BTN_ATTR,
  UPDATES_APPLY_RESULT_ATTR,
  UPDATES_ROLLOUT_NOTICE_ATTR,
  UPDATES_ROLLOUT_CONFIRM_ATTR,
  UPDATES_AVAILABLE_ATTR,
  UPDATES_CHECK_BTN_ATTR,
  UPDATES_ERROR_ATTR,
  UPDATES_FORCE_APPLY_BTN_ATTR,
  UPDATES_MODE_SELECT_ATTR,
  UPDATES_PAGE_STATE_ATTR,
  UPDATES_ROLLBACK_BTN_ATTR,
  UPDATES_ROLLBACK_RESULT_ATTR,
  UPDATES_RECEIPT_DIAGNOSTIC_ATTR,
  UPDATES_RECEIPT_DIAGNOSTIC_COPY_ATTR,
  UPDATES_RECEIPT_BASELINE_ATTR,
  UPDATES_RECEIPT_CLOSURE_CANCEL_ATTR,
  UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR,
  UPDATES_RECEIPT_CLOSURE_FINISH_ATTR,
  UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR,
  UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR,
  UPDATES_RECEIPT_RECOVERY_ATTR,
  UPDATES_RECEIPT_RETRY_ATTR,
  UPDATES_STATUS_ATTR,
  UPDATES_TAB_PROGRESS_ATTR,
  UPDATES_TAB_PROGRESS_PRIVACY_ATTR,
  UPDATES_TAB_PROGRESS_STATUS_ATTR,
  UPDATES_VERSION_ATTR,
  mountUpdatesPage,
} from '../settings/updates-page.js';

// ── fake DOM (per-test pattern; only the APIs the page touches) ──────
interface FE {
  tagName: string;
  textContent: string;
  className: string;
  value: string;
  children: FE[];
  parent: FE | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(e: unknown) => void>>;
  focused: boolean;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FE): FE;
  removeChild(c: FE): FE;
  readonly firstChild: FE | null;
  remove(): void;
  addEventListener(n: string, f: (e: unknown) => void): void;
  removeEventListener(n: string, f: (e: unknown) => void): void;
  focus(): void;
}

const mk = (tag: string): FE => {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const children: FE[] = [];
  const el: FE = {
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    value: '',
    children,
    parent: null,
    attrs,
    listeners,
    focused: false,
    setAttribute: (k, v) => {
      attrs.set(k, v);
    },
    removeAttribute: (k) => {
      attrs.delete(k);
    },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (c) => {
      children.push(c);
      c.parent = el;
      return c;
    },
    removeChild: (c) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      c.parent = null;
      return c;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent !== null) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    },
    addEventListener: (n, f) => {
      const arr = listeners.get(n) ?? [];
      arr.push(f);
      listeners.set(n, arr);
    },
    removeEventListener: (n, f) => {
      const arr = listeners.get(n);
      if (arr === undefined) return;
      const i = arr.indexOf(f);
      if (i >= 0) arr.splice(i, 1);
    },
    focus: () => {
      el.focused = true;
    },
  };
  return el;
};

const fakeDoc = (): Document =>
  ({ createElement: (t: string) => mk(t) }) as unknown as Document;

const find = (root: FE, attr: string): FE | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.children) {
    const hit = find(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};
/** Real-DOM-style aggregate text (the fake keeps textContent per-node). */
const allText = (root: FE): string =>
  root.textContent + root.children.map(allText).join('');
const fire = (el: FE, name: string): void => {
  for (const f of el.listeners.get(name) ?? []) f({});
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

const sharedServerUpdateTabs = (supportsOwnership = true) => {
  let progress: ServerUpdateTabProgress | null = null;
  let ownerHeld = false;
  const listeners = new Set<(hint: CredentialRotationTabHint) => void>();
  const publish = (
    next: Omit<ServerUpdateTabProgress, 'startedAt'> | null,
  ): void => {
    progress = next === null
      ? null
      : {
          ...next,
          startedAt: progress?.operation === next.operation
            ? progress.startedAt
            : 100,
        };
    for (const listener of [...listeners]) {
      listener({
        type: 'server_update_progress',
        progress: progress === null ? null : { ...progress },
      });
    }
  };
  const endpoint = (): NonNullable<
    Parameters<typeof mountUpdatesPage>[0]['serverUpdateTabConvergence']
  > => ({
    supportsServerUpdateOwnership: supportsOwnership,
    async claimServerUpdateOwnership() {
      if (ownerHeld) return null;
      ownerHeld = true;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          ownerHeld = false;
        },
      } satisfies CredentialRotationOwnershipLease;
    },
    readServerUpdateProgress: () =>
      progress === null ? null : { ...progress },
    notifyServerUpdateProgress: publish,
    async clearServerUpdateProgress(expected) {
      if (
        progress === null
        || progress.phase !== expected.phase
        || progress.operation !== expected.operation
        || progress.startedAt !== expected.startedAt
        || progress.operationId !== expected.operationId
      ) return false;
      publish(null);
      return true;
    },
    reconcileServerUpdateProgress: async () =>
      progress === null ? null : { ...progress },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    first: endpoint(),
    second: endpoint(),
    publish,
    read: () => progress === null ? null : { ...progress },
    listenerCount: () => listeners.size,
  };
};

const AVAILABLE: ReleaseCheckResponse = {
  status: 'update-available',
  current_version: '26.7.3',
  channel: 'stable',
  available: {
    version: '26.8.0',
    migration: true,
    is_major: false,
    below_min_supported: false,
    in_rollout_cohort: true,
    auto_apply_eligible: true,
    notes_url: 'https://recued.com/notes',
  },
};
const UP_TO_DATE: ReleaseCheckResponse = {
  status: 'up-to-date',
  current_version: '26.8.0',
  channel: 'stable',
};
const MODE_AUTO: UpdateModeStatus = {
  mode: 'auto',
  source: 'default',
  env_locked: false,
  channel_default: 'auto',
};

const host = (): { el: FE; asHost: HTMLElement } => {
  const el = mk('div');
  return { el, asHost: el as unknown as HTMLElement };
};

describe('mountUpdatesPage', () => {
  it('elects one update tab and makes siblings passive through apply and restart', async () => {
    const tabs = sharedServerUpdateTabs();
    const firstHost = host();
    const secondHost = host();
    const apply = deferred<UpdateApplyResponse>();
    const ownerApply = vi.fn(() => apply.promise);
    const siblingApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({
      status: 'busy',
    }));
    const connectedStatus = {
      status: () => 'connected' as const,
      onStatus: () => () => undefined,
    };
    const first = mountUpdatesPage({
      host: firstHost.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: ownerApply,
      serverUpdateTabConvergence: tabs.first,
    });
    const second = mountUpdatesPage({
      host: secondHost.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: siblingApply,
      serverUpdateTabConvergence: tabs.second,
      serverConnectionStatus: connectedStatus,
    });
    await flush();

    fire(find(firstHost.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();

    expect(ownerApply).toHaveBeenCalledOnce();
    // ⚠ THE LATCH CARRIES A RECEIPT FROM THE START NOW. It used to be stamped
    // only once the reply came back, which is why a lost reply left this tab
    // holding a latch that named nothing.
    expect(tabs.read()).toEqual({
      phase: 'applying',
      operation: 'update',
      startedAt: 100,
      operationId: expect.any(String),
    });
    expect(find(
      firstHost.el,
      UPDATES_TAB_PROGRESS_STATUS_ATTR,
    )?.textContent).toMatch(/this tab is applying.*other open Recued tabs/i);
    const siblingProgress = find(secondHost.el, UPDATES_TAB_PROGRESS_ATTR)!;
    expect(siblingProgress.hasAttribute('hidden')).toBe(false);
    expect(siblingProgress.getAttribute('aria-busy')).toBe('true');
    expect(find(
      siblingProgress,
      UPDATES_TAB_PROGRESS_STATUS_ATTR,
    )?.textContent).toMatch(/open Recued tab.*duplicate request/i);
    expect(find(
      siblingProgress,
      UPDATES_TAB_PROGRESS_PRIVACY_ATTR,
    )?.textContent).toMatch(/keys.*addresses.*raw errors/i);
    expect(find(
      secondHost.el,
      UPDATES_APPLY_BTN_ATTR,
    )?.hasAttribute('disabled')).toBe(true);
    expect(find(
      secondHost.el,
      UPDATES_CHECK_BTN_ATTR,
    )?.hasAttribute('disabled')).toBe(true);

    // A scripted click on the disabled sibling control still cannot reach RPC.
    fire(find(secondHost.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(siblingApply).not.toHaveBeenCalled();

    apply.resolve({
      status: 'restarting',
      operation_id: 'apply-receipt',
    });
    await flush();
    expect(tabs.read()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 100,
      operationId: 'apply-receipt',
    });
    // ⚠ These pinned the INTERNAL vocabulary — "server-issued restart receipt",
    // "update result" — which is precisely what the three-state rewrite removed:
    // an owner has no idea what a receipt is, and the screen said nothing was
    // needed while nothing progressed. Assert the state the tab is IN, in the
    // words it now uses, rather than the machinery it used to narrate.
    expect(find(
      siblingProgress,
      UPDATES_TAB_PROGRESS_STATUS_ATTR,
    )?.textContent).toMatch(/reconnected.*checking that the update finished/i);
    expect(siblingProgress.children[0]?.textContent)
      .toMatch(/confirming the update/i);
    expect(siblingApply).not.toHaveBeenCalled();

    tabs.publish(null);
    await flush();
    expect(siblingProgress.hasAttribute('hidden')).toBe(true);
    expect(find(
      secondHost.el,
      UPDATES_CHECK_BTN_ATTR,
    )?.hasAttribute('disabled')).toBe(false);

    first.dispose();
    second.dispose();
    expect(tabs.listenerCount()).toBe(0);
  });

  it('turns receipt uncertainty into bounded retry and a privacy-safe admin handoff', async () => {
    const tabs = sharedServerUpdateTabs();
    tabs.publish({
      phase: 'awaiting_reconnect',
      operation: 'update',
      operationId: 'opaque-receipt-never-render',
    });
    let verification: ServerUpdateReceiptVerificationState | null = {
      phase: 'waiting',
      operation: 'update',
      startedAt: 100,
      reason: 'temporary_failure',
    };
    const listeners = new Set<(
      next: ServerUpdateReceiptVerificationState | null,
    ) => void>();
    const retry = vi.fn();
    const reviewClosure = vi.fn();
    const cancelClosureReview = vi.fn();
    const closeUnresolved = vi.fn();
    const finishClosure = vi.fn();
    const dismissCompletion = vi.fn();
    const verifier = {
      read: () => verification === null ? null : { ...verification },
      retry,
      reviewClosure,
      cancelClosureReview,
      closeUnresolved,
      finishClosure,
      dismissCompletion,
      subscribe(listener: (
        next: ServerUpdateReceiptVerificationState | null,
      ) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const setVerification = (
      next: ServerUpdateReceiptVerificationState,
    ): void => {
      verification = next;
      for (const listener of [...listeners]) listener({ ...next });
    };
    const writer = vi.fn(async (_value: string) => undefined);
    const h = host();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      serverUpdateTabConvergence: tabs.first,
      serverConnectionStatus: {
        status: () => 'connected',
        onStatus: () => () => undefined,
      },
      serverUpdateReceiptVerification: verifier,
      serverUpdateReceiptDiagnosticContext: {
        serverUrl: 'https://home.example:8443/private?token=secret',
      },
      serverUpdateReceiptDiagnosticWriter: writer,
    });
    await flush();

    const recovery = find(h.el, UPDATES_RECEIPT_RECOVERY_ATTR)!;
    // ⛔⛔ THE NORMAL PATH SHOWS NO RECOVERY PANEL AT ALL. `waiting` and
    // `checking` are Recued confirming the operation and retrying on its own —
    // an ordinary update used to surface a panel about "receipts" here, so the
    // machinery for a rare case sat on the common one. It appears only once
    // something genuinely needs the owner.
    expect(recovery.hasAttribute('hidden')).toBe(true);
    // ⛔ NO MANUAL RETRY WHILE THE AUTOMATIC ONE IS RUNNING. This used to click
    // the button here and assert it fired — which kept passing after the button
    // was hidden, because `hidden` does not stop a programmatic click. A test
    // that presses what a person cannot see asserts nothing about the product.
    expect(find(recovery, UPDATES_RECEIPT_RETRY_ATTR)?.hasAttribute('hidden'))
      .toBe(true);
    expect(retry).not.toHaveBeenCalled();

    setVerification({
      phase: 'checking',
      operation: 'update',
      startedAt: 100,
    });
    // Still the normal path: Recued is checking, nobody is needed.
    expect(recovery.hasAttribute('hidden')).toBe(true);

    setVerification({
      phase: 'retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'temporary_failure',
    });
    expect(recovery.getAttribute('aria-busy')).toBeNull();
    expect(allText(recovery)).toMatch(/automatic retries stopped/i);
    // …and NOW the manual retry is the only way forward, so it is visible and
    // it works. This is the pair: hidden while automatic, offered once that stops.
    expect(find(recovery, UPDATES_RECEIPT_RETRY_ATTR)?.hasAttribute('hidden'))
      .toBe(false);
    fire(find(recovery, UPDATES_RECEIPT_RETRY_ATTR)!, 'click');
    expect(retry).toHaveBeenCalledOnce();
    expect(find(h.el, UPDATES_TAB_PROGRESS_ATTR)?.getAttribute('aria-busy'))
      .toBe('false');
    expect(find(
      recovery,
      UPDATES_RECEIPT_DIAGNOSTIC_ATTR,
    )?.hasAttribute('hidden')).toBe(false);
    expect(allText(recovery)).toMatch(
      /receipt status could not be read after bounded checks/i,
    );

    setVerification({
      phase: 'unknown',
      operation: 'update',
      startedAt: 100,
      reason: 'operation_mismatch',
    });
    const diagnostic = find(recovery, UPDATES_RECEIPT_DIAGNOSTIC_ATTR)!;
    expect(diagnostic.hasAttribute('hidden')).toBe(false);
    expect(allText(diagnostic)).toContain('home.example:8443');
    expect(allText(diagnostic)).toMatch(/different operation/i);
    expect(allText(diagnostic)).not.toMatch(
      /opaque-receipt-never-render|\/private|token=secret/i,
    );
    fire(find(diagnostic, UPDATES_RECEIPT_DIAGNOSTIC_COPY_ATTR)!, 'click');
    await flush();
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0]?.[0]).not.toMatch(
      /opaque-receipt-never-render|\/private|token=secret/i,
    );

    setVerification({
      phase: 'unknown',
      operation: 'update',
      startedAt: 100,
      reason: 'unknown_receipt',
    });
    const reviewButton = find(
      recovery,
      UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR,
    )!;
    expect(reviewButton.hasAttribute('hidden')).toBe(false);
    fire(reviewButton, 'click');
    expect(reviewClosure).toHaveBeenCalledOnce();

    setVerification({
      phase: 'reviewing_closure',
      operation: 'update',
      startedAt: 100,
      reason: 'unknown_receipt',
    });
    const review = find(recovery, UPDATES_RECEIPT_CLOSURE_REVIEW_ATTR)!;
    expect(review.hasAttribute('hidden')).toBe(false);
    expect(allText(review)).toMatch(
      /refuse while any server update is active.*closed unresolved.*not.*succeeded/is,
    );
    expect(allText(review)).toMatch(/does not repeat or undo/i);
    fire(find(review, UPDATES_RECEIPT_CLOSURE_CANCEL_ATTR)!, 'click');
    expect(cancelClosureReview).toHaveBeenCalledOnce();
    fire(find(review, UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR)!, 'click');
    expect(closeUnresolved).toHaveBeenCalledOnce();

    setVerification({
      phase: 'closing',
      operation: 'update',
      startedAt: 100,
    });
    expect(recovery.getAttribute('aria-busy')).toBe('true');
    expect(allText(recovery)).toMatch(/checking.*no update is under way/i);

    setVerification({
      phase: 'closed',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    });
    expect(recovery.getAttribute('aria-busy')).toBeNull();
    expect(allText(recovery)).toMatch(
      /durably closed.*did not claim.*succeeded or failed/i,
    );
    const finish = find(recovery, UPDATES_RECEIPT_CLOSURE_FINISH_ATTR)!;
    expect(finish.hasAttribute('hidden')).toBe(false);
    expect(finish.textContent).toBe('Check how the server is');
    fire(finish, 'click');
    expect(finishClosure).toHaveBeenCalledOnce();

    setVerification({
      phase: 'checking_baseline',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    });
    expect(recovery.getAttribute('aria-busy')).toBe('true');
    expect(finish.textContent).toBe('Checking how the server is…');
    expect(finish.hasAttribute('disabled')).toBe(true);

    setVerification({
      phase: 'baseline_retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'baseline_unavailable',
    });
    expect(recovery.getAttribute('aria-busy')).toBeNull();
    expect(finish.textContent).toBe('Check how the server is again');
    expect(allText(recovery)).toMatch(/current server state is not confirmed/i);
    expect(allText(recovery)).toMatch(
      /current server state could not be read after closure/i,
    );

    setVerification({
      phase: 'baseline_confirmed',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'fetch-failed',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    const baseline = find(recovery, UPDATES_RECEIPT_BASELINE_ATTR)!;
    expect(baseline.hasAttribute('hidden')).toBe(false);
    expect(allText(baseline)).toMatch(/running 26\.8\.1.*stable channel/i);
    expect(allText(baseline)).toMatch(
      /cannot reach the update service.*github-main.*no credential verification.*original update result is still unknown/is,
    );
    expect(finish.textContent).toBe('Finish recovery');
    fire(finish, 'click');
    expect(finishClosure).toHaveBeenCalledTimes(2);

    setVerification({
      phase: 'baseline_confirmed',
      operation: 'update',
      startedAt: 100,
      reason: 'finish_unavailable',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'fetch-failed',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    expect(finish.textContent).toBe('Retry finish recovery');
    expect(allText(recovery)).toMatch(
      /browser could not finish tidying up.*does not contact the server.*repeat/i,
    );
    fire(finish, 'click');
    expect(finishClosure).toHaveBeenCalledTimes(3);
    expect(allText(recovery)).not.toMatch(
      /opaque-receipt-never-render|\/private|token=secret/i,
    );

    setVerification({
      phase: 'completed',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'fetch-failed',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    expect(recovery.getAttribute('data-phase')).toBe('completed');
    expect(allText(recovery)).toMatch(
      /all sorted.*controls work again.*one-off note.*gone after a reload.*original update.*unknown/is,
    );
    expect(find(h.el, UPDATES_VERSION_ATTR)?.textContent)
      .toBe('Current version 26.8.1 · stable channel');
    expect(finish.textContent).toBe('Dismiss confirmation');
    fire(finish, 'click');
    expect(dismissCompletion).toHaveBeenCalledOnce();

    mount.dispose();
    expect(listeners.size).toBe(0);
  });

  it('finishes into the exact connection once without replaying an automatic return', async () => {
    const status = {
      status: () => 'connected' as const,
      onStatus: () => () => undefined,
    };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    const target = { kind: 'api' as const, name: 'github-main' };
    continuity.begin(target);
    let verification: ServerUpdateReceiptVerificationState = {
      phase: 'baseline_confirmed',
      operation: 'rollback',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          ...target,
          activity: 'idle',
        },
      },
    };
    const listeners = new Set<(
      next: ServerUpdateReceiptVerificationState | null,
    ) => void>();
    const finishClosure = vi.fn();
    const verifier = {
      read: () => ({ ...verification }),
      retry: vi.fn(),
      reviewClosure: vi.fn(),
      cancelClosureReview: vi.fn(),
      closeUnresolved: vi.fn(),
      finishClosure,
      dismissCompletion: vi.fn(),
      subscribe(listener: (
        next: ServerUpdateReceiptVerificationState | null,
      ) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const publish = (
      next: ServerUpdateReceiptVerificationState,
    ): void => {
      verification = next;
      continuity.observeServerUpdateVerification(next);
      for (const listener of [...listeners]) listener({ ...next });
    };
    const onReturn = vi.fn();
    const firstHost = host();
    const first = mountUpdatesPage({
      host: firstHost.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      credentialRotationServerUpdateContinuity: continuity,
      serverUpdateReceiptVerification: verifier,
      onReturnToCredentialRotationRetry: onReturn,
    });
    await flush();

    const finish = find(
      firstHost.el,
      UPDATES_RECEIPT_CLOSURE_FINISH_ATTR,
    )!;
    expect(finish.textContent).toBe(
      'Finish and go back to api/github-main',
    );
    verification = {
      ...verification,
      reason: 'finish_unavailable',
    };
    for (const listener of [...listeners]) listener({ ...verification });
    expect(finish.textContent).toBe(
      'Try finishing again and go back to api/github-main',
    );
    expect(allText(find(
      firstHost.el,
      UPDATES_RECEIPT_RECOVERY_ATTR,
    )!)).toMatch(
      /try finishing again and go back to api\/github-main.*does not contact the server or repeat/i,
    );
    fire(finish, 'click');
    expect(finishClosure).toHaveBeenCalledOnce();
    expect(onReturn).not.toHaveBeenCalled();

    publish({
      ...verification,
      phase: 'finishing',
      reason: 'server_closed_unresolved',
    });
    expect(onReturn).not.toHaveBeenCalled();
    publish({
      ...verification,
      phase: 'completed',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          ...target,
          activity: 'idle',
        },
      },
    });
    expect(onReturn).toHaveBeenCalledOnce();
    expect(onReturn).toHaveBeenCalledWith(target);
    expect(finish.textContent).toBe('Return to api/github-main');
    expect(find(
      firstHost.el,
      UPDATES_CREDENTIAL_RETRY_ATTR,
    )?.hasAttribute('hidden')).toBe(true);
    first.dispose();

    // A remounted/passive surface may render the still-live memory snapshot,
    // but it cannot infer that this tab requested an automatic return.
    const passiveHost = host();
    const passive = mountUpdatesPage({
      host: passiveHost.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      credentialRotationServerUpdateContinuity: continuity,
      serverUpdateReceiptVerification: verifier,
      onReturnToCredentialRotationRetry: onReturn,
    });
    await flush();
    expect(onReturn).toHaveBeenCalledOnce();
    const explicitReturn = find(
      passiveHost.el,
      UPDATES_RECEIPT_CLOSURE_FINISH_ATTR,
    )!;
    expect(explicitReturn.textContent).toBe('Return to api/github-main');
    fire(explicitReturn, 'click');
    expect(onReturn).toHaveBeenCalledTimes(2);

    continuity.markStillUnsupported(target, {
      status: 'not-configured',
      current_version: '26.8.1',
      channel: 'stable',
    });
    expect(explicitReturn.textContent).toBe('Dismiss confirmation');
    expect(find(
      passiveHost.el,
      UPDATES_CREDENTIAL_RETRY_ATTR,
    )?.hasAttribute('hidden')).toBe(false);
    fire(explicitReturn, 'click');
    expect(verifier.dismissCompletion).toHaveBeenCalledOnce();
    expect(onReturn).toHaveBeenCalledTimes(2);
    passive.dispose();
    continuity.dispose();
  });

  it('retires shared progress when apply defers before the restart boundary', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const status = {
      status: () => 'connected' as const,
      onStatus: () => () => undefined,
    };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin({ kind: 'api', name: 'github-main' });
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({
      status: 'deferred',
      detail: 'waiting for idle',
    }));
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply,
      credentialRotationServerUpdateContinuity: continuity,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();

    expect(runApply).toHaveBeenCalledOnce();
    expect(tabs.read()).toBeNull();
    expect(continuity.read()?.phase).toBe('guide');
    expect(find(h.el, UPDATES_TAB_PROGRESS_ATTR)?.hasAttribute('hidden'))
      .toBe(true);
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent)
      .toMatch(/busy.*did not start.*try again.*idle/i);

    mount.dispose();
    continuity.dispose();
  });

  // ⛔⛔ THE CONSENT NAMED NO RELEASE. The card is rendered from one `update.check`
  // and the server re-fetches the feed on apply, so an unbound "yes" — `force`
  // above all, which means "I read the notes for THIS major version" — could be
  // spent on a release published in between.
  it('binds the apply to the release the card actually showed', async () => {
    const h = host();
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'applying' }));
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => ({
        ...AVAILABLE,
        available: { ...AVAILABLE.available!, release_identity: 'edge:26.8.0' },
      }),
      runApply,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    // ⚠ ECHOED, NOT REBUILT: the card says `stable` and version 26.8.0, and the
    // identity is `edge:26.8.0` — an edge install resolving a stable release.
    // A client that assembled the token from what it renders would mismatch.
    expect(runApply).toHaveBeenCalledWith(
      expect.objectContaining({ expected_release_identity: 'edge:26.8.0' }),
    );
    // ⛔⛔ AND IT ASKS TO BE HELD TO THAT BINDING. Every consent field is enforced
    // only when SUPPLIED, so the hole is a claim going MISSING — which is what a
    // client regression looks like. `strict` turns a future regression here into
    // a server refusal instead of a silent unbound apply.
    expect(runApply).toHaveBeenCalledWith(expect.objectContaining({ strict: true }));
    mount.dispose();
  });

  // ⚠ An older SERVER omits the identity from its check. The client then sends no
  // binding and the apply behaves exactly as it did before the field existed —
  // there is no deploy order to rely on when the client is always-newest.
  it('sends no binding when the server did not name the release', async () => {
    const h = host();
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'applying' }));
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(runApply).toHaveBeenCalledWith(
      expect.not.objectContaining({ expected_release_identity: expect.anything() }),
    );
    // ⛔ AND NO `strict` EITHER — THE PAIR TRAVELS TOGETHER. Asking to be held to
    // a binding we did not send is a request the server must refuse, so claiming
    // strictness here would be a self-inflicted block on an owner's update.
    expect(runApply).toHaveBeenCalledWith(
      expect.not.objectContaining({ strict: expect.anything() }),
    );
    mount.dispose();
  });

  it('re-reads the card and disarms the confirmation when the review went stale', async () => {
    const h = host();
    const runCheck = vi.fn(async (): Promise<ReleaseCheckResponse> => ({
      ...AVAILABLE,
      available: { ...AVAILABLE.available!, release_identity: 'stable:26.8.0' },
    }));
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck,
      runApply: async () => ({ status: 'review-stale', to_version: '26.8.1' }),
    });
    await flush();
    expect(runCheck).toHaveBeenCalledOnce();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    // ⛔ The offer changed under the card, so it is re-read rather than retried:
    // re-arming would carry a major-bump "yes" onto notes nobody has seen.
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent ?? '')
      .toMatch(/newer release was published/i);
    mount.dispose();
  });

  // ⛔⛔ THE RECEIPT IS THE POINT OF THE LATCH. `applying` returns at once and the
  // run continues for minutes; the id used to arrive only on the terminal bus
  // event, i.e. only to a tab still listening — so leaving the page left a latch
  // that named no operation and nothing that could ever ask what became of it.
  it('latches the receipt as soon as the server accepts, and keeps it across dispose', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: () => apply.promise,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    apply.resolve({ status: 'applying', operation_id: 'op-7' });
    await flush();
    expect(tabs.read()).toMatchObject({ phase: 'applying', operationId: 'op-7' });

    // The card invites the owner to leave. Doing so must not delete the only
    // pointer to a run that is still going — for this tab or any sibling.
    mount.dispose();
    await flush();
    expect(tabs.read()).toMatchObject({ phase: 'applying', operationId: 'op-7' });
  });

  // …and the pre-receipt shape is unchanged: nothing can answer for a latch that
  // names no operation, so leaving still retires it rather than wedging the
  // Update button behind a run nobody can resolve.
  it('still retires a receipt-free latch on dispose', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: () => apply.promise,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    apply.resolve({ status: 'applying' });   // an older server: no receipt
    await flush();
    mount.dispose();
    await flush();
    expect(tabs.read()).toBeNull();
  });

  it('cannot clear a newer sibling lineage after a no-lock fallback refusal', async () => {
    const tabs = sharedServerUpdateTabs(false);
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: () => apply.promise,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read()).toMatchObject({
      phase: 'applying',
      operation: 'update',
    });

    // Browsers without Web Locks retain the server's authoritative duplicate
    // gate. If another lineage wins meanwhile, this tab's refusal may settle
    // only the exact progress object it originally published.
    tabs.publish({ phase: 'applying', operation: 'rollback' });
    apply.resolve({ status: 'deferred' });
    await flush();

    expect(tabs.read()).toEqual({
      phase: 'applying',
      operation: 'rollback',
      startedAt: 100,
    });
    mount.dispose();
  });

  it('publishes the accepted restart even when the owner leaves Updates mid-request', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    const runApply = vi.fn(() => apply.promise);
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(runApply).toHaveBeenCalledOnce();
    mount.dispose();

    apply.resolve({ status: 'restarting' });
    await flush();
    expect(tabs.read()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 100,
    });
    expect(tabs.listenerCount()).toBe(0);
  });

  it('releases ownership on dispose before acceptance and cannot resurrect a terminal latch', async () => {
    const releases: string[] = [];
    const tabs = sharedServerUpdateTabs();
    const spied = {
      ...tabs.first,
      async claimServerUpdateOwnership() {
        const lease = await tabs.first.claimServerUpdateOwnership();
        if (lease === null) return null;
        return { release: () => { releases.push('released'); lease.release(); } };
      },
    };
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: () => apply.promise,
      serverUpdateTabConvergence: spied,
    });
    await flush();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    const owned = tabs.read();
    expect(owned).toMatchObject({ phase: 'applying', operation: 'update' });

    mount.dispose();
    expect(releases, 'dispose owns the lease even before the rpc reply').toEqual(['released']);
    // Bootstrap outlives the route and settles the terminal globally.
    tabs.publish(null);

    apply.resolve({ status: 'applying', operation_id: owned!.operationId! });
    await flush();
    expect(tabs.read(), 'a late acceptance cannot recreate terminal progress').toBeNull();
    expect(releases, 'the late reply cannot park an already released lease').toEqual(['released']);
  });

  it('refreshes version evidence once after this tab settles an accepted restart', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const initialCheck = deferred<ReleaseCheckResponse>();
    const runCheck = vi.fn<() => Promise<ReleaseCheckResponse>>()
      .mockImplementationOnce(() => initialCheck.promise)
      .mockResolvedValue(UP_TO_DATE);
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();
    expect(runCheck).toHaveBeenCalledOnce();

    tabs.publish({
      phase: 'awaiting_reconnect',
      operation: 'update',
    });
    tabs.publish(null);
    await flush();
    expect(runCheck).toHaveBeenCalledOnce();

    // If an older check was still in flight, wait for it and then run exactly
    // one causally-later read instead of racing two version results.
    initialCheck.resolve(AVAILABLE);
    await flush();
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(find(h.el, UPDATES_VERSION_ATTR)?.textContent)
      .toContain('26.8.0');

    // A repeated idle hint is not another restart proof.
    tabs.publish(null);
    await flush();
    expect(runCheck).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('converges rollback ownership into the same restart observer state', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const rollback = deferred<UpdateRollbackResponse>();
    const runRollback = vi.fn((_args: UpdateRollbackArgs) => rollback.promise);
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runRollback,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR)!, 'click');
    await flush();
    expect(runRollback).toHaveBeenCalledOnce();
    const requestedReceipt = runRollback.mock.calls[0]?.[0]?.operation_id;
    expect(requestedReceipt).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(tabs.read()).toMatchObject({
      phase: 'applying',
      operation: 'rollback',
      operationId: requestedReceipt,
    });

    rollback.resolve({
      status: 'rolled-back',
      operation_id: 'rollback-receipt',
      restored_snapshot: true,
    });
    await flush();
    expect(tabs.read()).toMatchObject({
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      operationId: 'rollback-receipt',
    });
    expect(find(
      h.el,
      UPDATES_TAB_PROGRESS_STATUS_ATTR,
    )?.textContent).toMatch(/rollback.*reconnect/i);
    mount.dispose();
  });

  it('releases rollback ownership on dispose and cannot resurrect cleared progress', async () => {
    const releases: string[] = [];
    const tabs = sharedServerUpdateTabs();
    const spied = {
      ...tabs.first,
      async claimServerUpdateOwnership() {
        const lease = await tabs.first.claimServerUpdateOwnership();
        if (lease === null) return null;
        return { release: () => { releases.push('released'); lease.release(); } };
      },
    };
    const h = host();
    const rollback = deferred<UpdateRollbackResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runRollback: () => rollback.promise,
      serverUpdateTabConvergence: spied,
    });
    await flush();

    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR)!, 'click');
    await flush();
    expect(releases, 'the in-flight rollback must still own its lease').toEqual([]);

    mount.dispose();
    expect(releases, 'route disposal releases before the rpc can return').toEqual(['released']);
    // Bootstrap outlives the route and proves this receipt terminal. The old
    // route no longer owns anything it may recreate when its rpc finally lands.
    tabs.publish(null);

    rollback.resolve({ status: 'rolled-back', restored_snapshot: false });
    await flush();
    expect(releases, 'the late rpc completion must not release twice').toEqual(['released']);
    expect(tabs.read(), 'the late rollback reply must not recreate terminal progress').toBeNull();
  });

  it('does not let a disposed rollback reply overwrite a successor operation', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const rollback = deferred<UpdateRollbackResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runRollback: () => rollback.promise,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read()).toMatchObject({ phase: 'applying', operation: 'rollback' });

    mount.dispose();
    tabs.publish(null);
    tabs.publish({
      phase: 'applying',
      operation: 'update',
      operationId: 'successor-operation',
    });

    rollback.resolve({
      status: 'rolled-back',
      operation_id: 'late-rollback-receipt',
      restored_snapshot: false,
    });
    await flush();
    expect(tabs.read()).toEqual({
      phase: 'applying',
      operation: 'update',
      operationId: 'successor-operation',
      startedAt: 100,
    });
  });

  it('lets a disposed rollback reply refine only its still-owned applying lineage', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const rollback = deferred<UpdateRollbackResponse>();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runRollback: () => rollback.promise,
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR)!, 'click');
    await flush();
    const owned = tabs.read();
    expect(owned).toMatchObject({ phase: 'applying', operation: 'rollback' });

    mount.dispose();
    rollback.resolve({
      status: 'rolled-back',
      operation_id: '00000000-0000-4000-8000-000000000002',
      restored_snapshot: false,
    });
    await flush();
    expect(tabs.read()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      operationId: '00000000-0000-4000-8000-000000000002',
      startedAt: owned!.startedAt,
    });
  });

  it('⛔ keeps the caller-reserved rollback receipt when the reply is lost', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    let receiptAtDispatch: string | undefined;
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runRollback: async (args) => {
        receiptAtDispatch = tabs.read()?.operationId;
        expect(args.operation_id).toBe(receiptAtDispatch);
        throw new RpcError('connection_lost', 'the restart closed the socket', 0);
      },
      serverUpdateTabConvergence: tabs.first,
    });
    await flush();

    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR)!, 'click');
    await flush();

    expect(receiptAtDispatch).toMatch(/^[0-9a-f-]{36}$/i);
    expect(tabs.read()).toMatchObject({
      phase: 'applying',
      operation: 'rollback',
      operationId: receiptAtDispatch,
    });
    mount.dispose();
  });

  it('keeps the exact credential retry through update restart and returns only after reconnect', async () => {
    const h = host();
    let connection: WebclientConnectionStatus = 'connected';
    const statusListeners = new Set<(
      status: WebclientConnectionStatus,
    ) => void>();
    const serverConnectionStatus = {
      status: () => connection,
      onStatus: (listener: (status: WebclientConnectionStatus) => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
    };
    const setConnection = (next: WebclientConnectionStatus): void => {
      connection = next;
      for (const listener of [...statusListeners]) listener(next);
    };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: serverConnectionStatus.status,
      onStatus: serverConnectionStatus.onStatus,
      now: () => 100,
    });
    continuity.begin({ kind: 'api', name: 'github-main' });
    const onReturnToCredentialRotationRetry = vi.fn();
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({
      status: 'restarting',
    }));
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply,
      credentialRotationServerUpdateContinuity: continuity,
      serverConnectionStatus,
      onReturnToCredentialRotationRetry,
    });
    await flush();
    expect(continuity.read()?.baselineVersion).toBe('26.7.3');

    const card = find(h.el, UPDATES_CREDENTIAL_RETRY_ATTR)!;
    expect(card.hasAttribute('hidden')).toBe(false);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_IDENTITY_ATTR)?.textContent)
      .toBe('api/github-main');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/come back and let it check for itself/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/keep this tab open/i);

    continuity.observeServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
      startedAt: 101,
    });
    expect(find(h.el, UPDATES_CHECK_BTN_ATTR)?.hasAttribute('disabled'))
      .toBe(true);
    fire(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!, 'click');
    fire(find(card, UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR)!, 'click');
    expect(onReturnToCredentialRotationRetry).not.toHaveBeenCalled();
    expect(continuity.read()?.name).toBe('github-main');
    continuity.observeServerUpdateProgress(null);

    // A return click asks the router to navigate, but does not consume the
    // durable pointer before that route is known to have mounted.
    fire(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!, 'click');
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledWith({
      kind: 'api',
      name: 'github-main',
    });
    expect(continuity.read()?.name).toBe('github-main');

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(continuity.read()?.phase).toBe('awaiting_reconnect');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.hasAttribute('disabled'))
      .toBe(true);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.getAttribute('aria-label'))
      .toMatch(/waiting.*server/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/waiting.*restart/i);

    setConnection('reconnecting');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/server is restarting/i);
    setConnection('connected');
    expect(continuity.read()?.phase).toBe('ready');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.hasAttribute('disabled'))
      .toBe(false);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/the server is back/i);

    fire(find(card, UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR)!, 'click');
    expect(continuity.read()).toBeNull();
    expect(card.hasAttribute('hidden')).toBe(true);
    expect(find(h.el, UPDATES_VERSION_ATTR)?.focused).toBe(true);
    m.dispose();
    continuity.dispose();
    expect(statusListeners.size).toBe(0);
  });

  it('observes an owned exact-return check without offering a duplicate, then resumes after interruption', async () => {
    const h = host();
    const listeners = new Set<(status: WebclientConnectionStatus) => void>();
    const serverConnectionStatus = {
      status: () => 'connected' as const,
      onStatus: (listener: (status: WebclientConnectionStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: serverConnectionStatus.status,
      onStatus: serverConnectionStatus.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    expect(continuity.beginExactReturn(target)).toBe(true);
    const onReturnToCredentialRotationRetry = vi.fn();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      credentialRotationServerUpdateContinuity: continuity,
      serverConnectionStatus,
      onReturnToCredentialRotationRetry,
    });
    await flush();

    const card = find(h.el, UPDATES_CREDENTIAL_RETRY_ATTR)!;
    const returnButton = find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!;
    const dismissButton = find(card, UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR)!;
    expect(card.getAttribute('data-phase')).toBe('checking_return');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(card.children[0]?.textContent).toBe('Checking the key');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/will not start a duplicate check/i);
    expect(returnButton.textContent).toBe('Checking…');
    expect(returnButton.hasAttribute('disabled')).toBe(true);
    expect(returnButton.getAttribute('aria-label')).toMatch(
      /already running under connections/i,
    );
    expect(dismissButton.hasAttribute('disabled')).toBe(true);
    fire(returnButton, 'click');
    fire(dismissButton, 'click');
    expect(onReturnToCredentialRotationRetry).not.toHaveBeenCalled();
    expect(continuity.read()).not.toBeNull();

    continuity.interruptExactReturn(target);
    expect(card.hasAttribute('aria-busy')).toBe(false);
    expect(card.children[0]?.textContent).toBe('Carry on checking the key');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/stopped before Recued finished its checks/i);
    expect(returnButton.textContent).toBe('Carry on checking');
    expect(returnButton.hasAttribute('disabled')).toBe(false);
    expect(dismissButton.hasAttribute('disabled')).toBe(false);
    fire(returnButton, 'click');
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledOnce();
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledWith(target);

    mount.dispose();
    continuity.dispose();
  });

  it('offers a clean-editor resume without replaying the completed server receipt', async () => {
    const h = host();
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: () => 'connected',
      onStatus: () => () => undefined,
      now: () => 100,
    });
    continuity.begin(target);
    expect(continuity.beginExactReturn(target)).toBe(true);
    expect(continuity.markExactEditorReady(target)).toBe(true);
    continuity.observeServerUpdateVerification({
      phase: 'completed',
      operation: 'update',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          ...target,
          activity: 'idle',
        },
      },
    });
    const onReturnToCredentialRotationRetry = vi.fn();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      credentialRotationServerUpdateContinuity: continuity,
      serverConnectionStatus: {
        status: () => 'connected',
        onStatus: () => () => undefined,
      },
      onReturnToCredentialRotationRetry,
    });
    await flush();

    const card = find(h.el, UPDATES_CREDENTIAL_RETRY_ATTR)!;
    const returnButton = find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!;
    expect(card.getAttribute('data-phase')).toBe('editor_ready');
    expect(card.children[0]?.textContent).toBe(
      'Carry on replacing the key',
    );
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/clean editor.*closed before any field changed/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/No key.*no\s+receipt was kept/i);
    expect(returnButton.textContent).toBe('Reopen the fresh editor');
    expect(allText(card)).not.toMatch(/recovery finished|running 26\.8\.1/i);

    fire(returnButton, 'click');
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledOnce();
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledWith(target);
    mount.dispose();
    continuity.dispose();
  });

  it('keeps a repeated-support diagnosis visible without sending the owner through the same guide', async () => {
    const h = host();
    const listeners = new Set<(status: WebclientConnectionStatus) => void>();
    const serverConnectionStatus = {
      status: () => 'connected' as const,
      onStatus: (listener: (status: WebclientConnectionStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const stored = new Map<string, string>();
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
        removeItem: (key) => {
          stored.delete(key);
        },
      },
      scopeId: 'profile-a',
      status: serverConnectionStatus.status,
      onStatus: serverConnectionStatus.onStatus,
      now: () => 100,
    });
    const target = { kind: 'api' as const, name: 'github-main' };
    continuity.begin(target);
    continuity.recordServerCheck(target, AVAILABLE);
    continuity.markStillUnsupported(target, UP_TO_DATE);
    const onReturnToCredentialRotationRetry = vi.fn();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      credentialRotationServerUpdateContinuity: continuity,
      serverConnectionStatus,
      onReturnToCredentialRotationRetry,
    });
    await flush();

    const card = find(h.el, UPDATES_CREDENTIAL_RETRY_ATTR)!;
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/still cannot do the safety check/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/run the check again/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/safe notes about the server version and update/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.textContent)
      .toBe('Check the server again');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.getAttribute('aria-label'))
      .toMatch(/check the server features again/i);
    fire(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!, 'click');
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledWith(target);
    expect(continuity.read()?.phase).toBe('triage');

    m.dispose();
    continuity.dispose();
  });

  it('turns sibling-confirmed support into an explicit one-shot continuation on the current Updates page', async () => {
    const h = host();
    const listeners = new Set<(status: WebclientConnectionStatus) => void>();
    const serverConnectionStatus = {
      status: () => 'connected' as const,
      onStatus: (listener: (status: WebclientConnectionStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: serverConnectionStatus.status,
      onStatus: serverConnectionStatus.onStatus,
      now: () => 100,
    });
    const target = { kind: 'api' as const, name: 'github-main' };
    continuity.begin(target);
    continuity.markStillUnsupported(target, UP_TO_DATE);
    const onReturnToCredentialRotationRetry = vi.fn();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      credentialRotationServerUpdateContinuity: continuity,
      serverConnectionStatus,
      onReturnToCredentialRotationRetry,
    });
    await flush();

    expect(continuity.markCapabilityResolvedElsewhere(target)).toBe(true);
    const card = find(h.el, UPDATES_CREDENTIAL_RETRY_ATTR)!;
    expect(card.getAttribute('data-phase')).toBe('resolved_elsewhere');
    expect(card.children[0]?.textContent).toBe('The key check is ready');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/look-only check says.*stayed on Server Updates/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/kept only in this tab and is gone after a reload/i);
    const continueButton = find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!;
    expect(continueButton.textContent).toBe('Continue in this tab');
    expect(continueButton.getAttribute('aria-label')).toMatch(
      /carry on checking the new key for api\/github-main/i,
    );
    expect(onReturnToCredentialRotationRetry).not.toHaveBeenCalled();

    fire(continueButton, 'click');
    expect(onReturnToCredentialRotationRetry).toHaveBeenCalledWith(target);
    expect(continuity.read()?.phase).toBe('ready');
    expect(continuity.isDurable()).toBe(false);

    fire(find(card, UPDATES_CREDENTIAL_RETRY_DISMISS_ATTR)!, 'click');
    expect(continuity.read()).toBeNull();
    expect(card.hasAttribute('hidden')).toBe(true);
    m.dispose();
    continuity.dispose();
  });

  it('checks on mount → up-to-date renders status + clears availability', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => UP_TO_DATE);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, onAvailabilityChanged });
    await flush();
    expect(find(h.el, UPDATES_PAGE_STATE_ATTR)?.getAttribute(UPDATES_PAGE_STATE_ATTR)).toBe('checked');
    expect(find(h.el, UPDATES_STATUS_ATTR)?.textContent).toMatch(/latest/i);
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(true);
    expect(find(h.el, UPDATES_CHECK_BTN_ATTR)?.className)
      .toContain('rx-btn-secondary');
    expect(find(h.el, UPDATES_ROLLBACK_BTN_ATTR)?.className)
      .toContain('rx-btn-danger');
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });

  it('guards only unresolved writes and keeps their initiating controls truthful', async () => {
    const h = host();
    const modeWrite = deferred<UpdateModeStatus>();
    const apply = deferred<UpdateApplyResponse>();
    const rollback = deferred<UpdateRollbackResponse>();
    const runSetMode = vi.fn(() => modeWrite.promise);
    const runApply = vi.fn(() => apply.promise);
    const runRollback = vi.fn(() => rollback.promise);
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runGetMode: async () => MODE_AUTO,
      runSetMode,
      runApply,
      runRollback,
    });
    await flush();
    expect(m.hasInFlightWork()).toBe(false);

    const mode = find(h.el, UPDATES_MODE_SELECT_ATTR)!;
    mode.value = 'off';
    fire(mode, 'change');
    await flush();
    expect(m.hasInFlightWork()).toBe(true);
    expect(mode.value).toBe('off');
    expect(mode.hasAttribute('disabled')).toBe(false);
    expect(mode.getAttribute('aria-disabled')).toBe('true');
    expect(mode.getAttribute('aria-busy')).toBe('true');
    mode.value = 'auto';
    fire(mode, 'change');
    expect(mode.value).toBe('off');
    expect(runSetMode).toHaveBeenCalledTimes(1);

    modeWrite.resolve({ ...MODE_AUTO, mode: 'off', source: 'user' });
    await flush();
    expect(m.hasInFlightWork()).toBe(false);
    expect(mode.value).toBe('off');
    expect(mode.getAttribute('aria-disabled')).toBeNull();
    expect(mode.getAttribute('aria-busy')).toBeNull();

    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    const pendingApply = find(h.el, UPDATES_APPLY_BTN_ATTR)!;
    expect(m.hasInFlightWork()).toBe(true);
    expect(pendingApply.hasAttribute('disabled')).toBe(false);
    expect(pendingApply.getAttribute('aria-disabled')).toBe('true');
    expect(pendingApply.getAttribute('aria-busy')).toBe('true');
    fire(pendingApply, 'click');
    expect(runApply).toHaveBeenCalledTimes(1);

    apply.resolve({ status: 'deferred' });
    await flush();
    expect(m.hasInFlightWork()).toBe(false);

    const rollbackButton = find(h.el, UPDATES_ROLLBACK_BTN_ATTR)!;
    fire(rollbackButton, 'click');
    await flush();
    expect(m.hasInFlightWork()).toBe(true);
    expect(rollbackButton.hasAttribute('disabled')).toBe(false);
    expect(rollbackButton.getAttribute('aria-disabled')).toBe('true');
    expect(rollbackButton.getAttribute('aria-busy')).toBe('true');
    fire(rollbackButton, 'click');
    expect(runRollback).toHaveBeenCalledTimes(1);

    rollback.resolve({ status: 'refused' });
    await flush();
    expect(m.hasInFlightWork()).toBe(false);
    expect(rollbackButton.getAttribute('aria-disabled')).toBeNull();
    expect(rollbackButton.getAttribute('aria-busy')).toBeNull();
    m.dispose();
  });

  it('does not classify availability or mode reads as guarded work', async () => {
    const h = host();
    const check = deferred<ReleaseCheckResponse>();
    const mode = deferred<UpdateModeStatus>();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: () => check.promise,
      runGetMode: () => mode.promise,
    });
    expect(m.getState().phase).toBe('checking');
    expect(m.hasInFlightWork()).toBe(false);
    m.dispose();
  });

  it('update-available → shows version + fires availability true; apply → restarting', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => AVAILABLE);
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'restarting' }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply, onAvailabilityChanged });
    await flush();
    const avail = find(h.el, UPDATES_AVAILABLE_ATTR);
    expect(avail?.hasAttribute('hidden')).toBe(false);
    expect(allText(avail as FE)).toContain('26.8.0');
    expect(find(h.el, UPDATES_APPLY_BTN_ATTR)?.className)
      .toContain('rx-btn-primary');
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(true);
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR) as FE, 'click');
    await flush();
    // ⚠ The receipt now rides every apply — see 'an apply whose reply may never
    // arrive'. What this arm cares about is that nothing ELSE was sent.
    expect(runApply).toHaveBeenCalledWith({ operation_id: expect.any(String) });
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent).toMatch(/restart/i);
    m.dispose();
  });

  it('docker-baked shows the signed image@digest and no misleading in-place apply button', async () => {
    const h = host();
    const pullRef = `registry.example/recued/server@sha256:${'a'.repeat(64)}`;
    const runCheck = vi.fn(async (): Promise<ReleaseCheckResponse> => ({
      ...AVAILABLE,
      docker: {
        artifact: 'docker-baked',
        version: '26.8.0',
        release_identity: 'stable:26.8.0',
        image: 'registry.example/recued/server',
        digest: `sha256:${'a'.repeat(64)}`,
        pull_ref: pullRef,
        notes_url: 'https://recued.com/notes',
      },
    }));
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'not-applicable' }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply });
    await flush();

    expect(find(h.el, 'data-update-docker-pull-ref')?.textContent).toBe(pullRef);
    expect(find(h.el, UPDATES_APPLY_BTN_ATTR)).toBeNull();
    expect(runApply).not.toHaveBeenCalled();
    m.dispose();
  });

  it('major update: apply returns major-blocked → a force button applies with { force: true }', async () => {
    const h = host();
    const runCheck = vi.fn(async (): Promise<ReleaseCheckResponse> => ({
      ...AVAILABLE,
      available: { ...AVAILABLE.available!, is_major: true },
    }));
    const runApply = vi.fn(
      async (_a: { force?: boolean }): Promise<UpdateApplyResponse> => ({ status: 'restarting' }),
    );
    // first apply → major-blocked (surfaces the force button); the force apply
    // falls through to the default → restarting.
    runApply.mockResolvedValueOnce({ status: 'major-blocked' });
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR) as FE, 'click');
    await flush();
    expect(runApply).toHaveBeenNthCalledWith(1, { operation_id: expect.any(String) });
    const forceBtn = find(h.el, UPDATES_FORCE_APPLY_BTN_ATTR);
    expect(forceBtn).not.toBeNull();
    expect(forceBtn?.className).toContain('rx-btn-danger');
    fire(forceBtn as FE, 'click');
    await flush();
    // ⚠ AND A FRESH RECEIPT ON THE SECOND ATTEMPT. The first apply was refused,
    // so nothing is running under its id; reusing it would be refused by the
    // server as an id already in use.
    expect(runApply).toHaveBeenNthCalledWith(2, { force: true, operation_id: expect.any(String) });
    m.dispose();
  });

  it('mode: getMode populates the select; change calls setMode', async () => {
    const h = host();
    const runGetMode = vi.fn(async () => MODE_AUTO);
    const runSetMode = vi.fn(async (a: { mode: UpdateMode }): Promise<UpdateModeStatus> => ({
      ...MODE_AUTO,
      mode: a.mode,
      source: 'user',
    }));
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runGetMode,
      runSetMode,
    });
    await flush();
    const sel = find(h.el, UPDATES_MODE_SELECT_ATTR) as FE;
    expect(sel.value).toBe('auto');
    expect(sel.hasAttribute('disabled')).toBe(false);
    expect(sel.parent?.tagName).toBe('LABEL');
    expect(allText(sel.parent!)).toContain('When updates are available');
    sel.value = 'off';
    fire(sel, 'change');
    await flush();
    expect(runSetMode).toHaveBeenCalledWith({ mode: 'off' });
    m.dispose();
  });

  it('env-locked mode disables the select', async () => {
    const h = host();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runGetMode: async (): Promise<UpdateModeStatus> => ({
        mode: 'off',
        source: 'env',
        env_locked: true,
        channel_default: 'auto',
      }),
      runSetMode: async (a) => ({ mode: a.mode, source: 'env', env_locked: true, channel_default: 'auto' }),
    });
    await flush();
    expect(find(h.el, UPDATES_MODE_SELECT_ATTR)?.hasAttribute('disabled')).toBe(true);
    m.dispose();
  });

  it('rollback renders the result + snapshot note', async () => {
    const h = host();
    const runRollback = vi.fn(async (): Promise<UpdateRollbackResponse> => ({
      status: 'rolled-back',
      restored_snapshot: true,
    }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck: async () => UP_TO_DATE, runRollback });
    await flush();
    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR) as FE, 'click');
    await flush();
    const res = find(h.el, UPDATES_ROLLBACK_RESULT_ATTR);
    expect(res?.hasAttribute('hidden')).toBe(false);
    expect(res?.textContent).toMatch(/snapshot/i);
    m.dispose();
  });

  it('startPoll drives a re-check; dispose cancels it', async () => {
    const h = host();
    const cancel = vi.fn();
    let pollCb: (() => void) | null = null;
    const startPoll = vi.fn((cb: () => void) => {
      pollCb = cb;
      return cancel;
    });
    const runCheck = vi.fn(async () => UP_TO_DATE);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, startPoll, pollIntervalMs: 1000 });
    await flush();
    expect(startPoll).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(runCheck).toHaveBeenCalledTimes(1);
    (pollCb as unknown as () => void)();
    await flush();
    expect(runCheck).toHaveBeenCalledTimes(2);
    m.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a check failure surfaces an error + clears availability', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => {
        throw new Error('feed down');
      },
      onAvailabilityChanged,
    });
    await flush();
    expect(find(h.el, UPDATES_PAGE_STATE_ATTR)?.getAttribute(UPDATES_PAGE_STATE_ATTR)).toBe('error');
    expect(find(h.el, UPDATES_ERROR_ATTR)?.hasAttribute('hidden')).toBe(false);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });

  it('keeps a manual Check focused, focusable, and single-flight while reading', async () => {
    const h = host();
    const pending = deferred<ReleaseCheckResponse>();
    const runCheck = vi.fn<() => Promise<ReleaseCheckResponse>>()
      .mockResolvedValueOnce(UP_TO_DATE)
      .mockImplementationOnce(() => pending.promise);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck });
    await flush();

    const check = find(h.el, UPDATES_CHECK_BTN_ATTR)!;
    check.focus();
    fire(check, 'click');
    await flush();
    expect(check.textContent).toBe('Checking…');
    expect(check.hasAttribute('disabled')).toBe(false);
    expect(check.getAttribute('aria-disabled')).toBe('true');
    expect(check.getAttribute('aria-busy')).toBe('true');
    expect(check.focused).toBe(true);
    fire(check, 'click');
    fire(check, 'click');
    expect(runCheck).toHaveBeenCalledTimes(2);

    pending.resolve(UP_TO_DATE);
    await flush();
    expect(check.hasAttribute('disabled')).toBe(false);
    expect(check.getAttribute('aria-disabled')).toBeNull();
    expect(check.getAttribute('aria-busy')).toBeNull();
    expect(check.focused).toBe(true);
    m.dispose();
  });

  it('a failed re-check hides the stale available card + clears the badge (F1)', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => AVAILABLE);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, onAvailabilityChanged });
    await flush();
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(false);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(true);
    runCheck.mockRejectedValueOnce(new Error('feed down'));
    await m.refresh();
    await flush();
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(true);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });

  it('an apply proving no installable update hides the card + clears the badge (F2)', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => AVAILABLE);
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'not-available' }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply, onAvailabilityChanged });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR) as FE, 'click');
    await flush();
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent).toMatch(/no installable update/i);
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(true);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });
});

describe('D-178 — staged rollout is stated on the card', () => {
  /** ⛔ The card said NOTHING about cohort membership, so an owner clicking
   *  Update could not know they were taking a release the fleet had not been
   *  given yet. The spec calls that bypass "an EXPLICIT, confirmed, audited
   *  act"; this is the explicit half. */
  it('says so, with the percentage, when this server is OUTSIDE the cohort', async () => {
    const h = host();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => ({
        ...AVAILABLE,
        available: { ...AVAILABLE.available!, in_rollout_cohort: false, rollout_pct: 40 },
      }),
    });
    await flush();
    const notice = find(h.el, UPDATES_ROLLOUT_NOTICE_ATTR);
    expect(notice?.textContent).toMatch(/staged rollout \(40%\)/);
    expect(notice?.textContent).toMatch(/not in the cohort yet/);
    mount.dispose();
  });

  it('stays quiet when this server IS in the cohort', async () => {
    const h = host();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
    });
    await flush();
    // A LOCATOR, not a text search: this fake DOM does not aggregate
    // textContent, so asserting against the container would pass vacuously.
    expect(find(h.el, UPDATES_ROLLOUT_NOTICE_ATTR)).toBeNull();
    mount.dispose();
  });

  it('an OLDER server that omits rollout_pct still says the honest half', async () => {
    // Rendering "undefined%" would be worse than saying less.
    const h = host();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => ({
        ...AVAILABLE,
        available: { ...AVAILABLE.available!, in_rollout_cohort: false },
      }),
    });
    await flush();
    const notice = find(h.el, UPDATES_ROLLOUT_NOTICE_ATTR);
    expect(notice?.textContent).toMatch(/staged rollout/);
    expect(notice?.textContent).not.toMatch(/undefined/);
    mount.dispose();
  });
});

describe('D-178 — an out-of-cohort update must be CONFIRMED, not just disclosed', () => {
  /** The card disclosed the rollout and the ledger recorded the bypass, but the
   *  first ordinary "Update now" click still went straight through — so the
   *  spec's "explicit, CONFIRMED, audited" was only ever two of three. */
  const outOfCohort = {
    ...AVAILABLE,
    available: { ...AVAILABLE.available!, in_rollout_cohort: false, rollout_pct: 40 },
  };

  it('the FIRST click arms and does not apply', async () => {
    const h = host();
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'restarting' }));
    const mount = mountUpdatesPage({
      host: h.asHost, document: fakeDoc(), runCheck: async () => outOfCohort, runApply,
    });
    await flush();
    const btn = find(h.el, UPDATES_APPLY_BTN_ATTR)!;
    expect(btn.hasAttribute(UPDATES_ROLLOUT_CONFIRM_ATTR), 'armed state on the button').toBe(true);
    fire(btn, 'click');
    await flush();
    expect(runApply, 'the first click must not install').not.toHaveBeenCalled();
    mount.dispose();
  });

  it('the SECOND click installs', async () => {
    const h = host();
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'restarting' }));
    const mount = mountUpdatesPage({
      host: h.asHost, document: fakeDoc(), runCheck: async () => outOfCohort, runApply,
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(runApply).toHaveBeenCalledOnce();
    mount.dispose();
  });

  it('an IN-cohort update still installs on the first click', async () => {
    // The confirm must not become a tax on the ordinary path.
    const h = host();
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'restarting' }));
    const mount = mountUpdatesPage({
      host: h.asHost, document: fakeDoc(), runCheck: async () => AVAILABLE, runApply,
    });
    await flush();
    const btn = find(h.el, UPDATES_APPLY_BTN_ATTR)!;
    expect(btn.hasAttribute(UPDATES_ROLLOUT_CONFIRM_ATTR)).toBe(false);
    fire(btn, 'click');
    await flush();
    expect(runApply).toHaveBeenCalledOnce();
    mount.dispose();
  });
});

describe('D-257 — an async apply must not leak or latch shared ownership', () => {
  /** ⛔ BOTH OF THESE WERE MINE, FROM THE WIRING THAT MADE THE APPLY ASYNC. */

  it('a terminal NON-RESTART event clears the lineage the page owns', async () => {
    // ⛔ It used to call `clearServerUpdateProgress(null)` — and that helper
    // ignores a null expected value BY DESIGN, since it clears only a lineage it
    // can prove is its own. So the call released nothing and the shared progress
    // stayed latched until a later reconciliation or a tab shutdown.
    const tabs = sharedServerUpdateTabs();
    const h = host();
    let emit: ((e: { phase: string; status?: string; detail?: string }) => void) | null = null;
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: async (): Promise<UpdateApplyResponse> => ({ status: 'applying' }),
      serverUpdateTabConvergence: tabs.first,
      updateProgress: { subscribe: (cb) => { emit = cb as typeof emit; return () => {}; } },
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read(), 'the apply owns a lineage while it runs').not.toBeNull();

    emit!({ phase: 'result', status: 'stage-failed', detail: 'disk full' });
    await flush();
    expect(tabs.read(), 'the terminal event must release it').toBeNull();
    mount.dispose();
  });

  // ⛔⛔⛔ THE TERMINAL CAN BEAT THE ACCEPTANCE. `update.apply` starts the run and
  // only THEN returns `applying`, so a refusal `runApply` reaches immediately —
  // `busy`, `deferred`, `insufficient-storage` — resolves into the broadcast while
  // the rpc reply is still being dispatched. Probed against the real handler:
  // `["emit:busy", "rpc:applying"]`. The page then put `applying` back over the
  // top of the terminal it had already handled.
  it('a terminal that arrives BEFORE the acceptance wins', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    let emit: ((e: {
      phase: string;
      status?: string;
      detail?: string;
      operation_id?: string;
    }) => void) | undefined;
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: () => apply.promise,
      serverUpdateTabConvergence: tabs.first,
      updateProgress: { subscribe: (cb) => { emit = cb as typeof emit; return () => {}; } },
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();

    // The run ends on the bus first…
    emit!({ phase: 'result', status: 'busy', operation_id: 'op-9' });
    await flush();
    // …and only then does the rpc answer with its acceptance.
    apply.resolve({ status: 'applying', operation_id: 'op-9' });
    await flush();

    // ⛔ THE REFUSAL MUST STILL BE THE ANSWER ON SCREEN. Overwriting it left the
    // owner watching "Updating…" over a run that had already declined.
    expect(
      find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent ?? '',
      'the terminal must not be overwritten by the later acceptance',
    ).toMatch(/already in progress/i);
    // …and nothing may stay latched for a run that is over: no durable lineage,
    // and the button usable again.
    expect(tabs.read(), 'no latch may survive a run that already ended').toBeNull();
    expect(
      find(h.el, UPDATES_APPLY_BTN_ATTR)?.getAttribute('aria-busy') ?? null,
      'the button must not be left mid-flight',
    ).toBeNull();
    mount.dispose();
  });

  // ⚠ THE ORDINARY ORDER IS UNCHANGED: acceptance first, terminal later. Without
  // this arm the fix above could be "ignore the acceptance" and still look right.
  it('the acceptance still wins when it arrives first', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const apply = deferred<UpdateApplyResponse>();
    let emit: ((e: { phase: string; status?: string; operation_id?: string }) => void) | undefined;
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: () => apply.promise,
      serverUpdateTabConvergence: tabs.first,
      updateProgress: { subscribe: (cb) => { emit = cb as typeof emit; return () => {}; } },
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();

    apply.resolve({ status: 'applying', operation_id: 'op-10' });
    await flush();
    // Accepted and still running: the latch carries the receipt.
    expect(tabs.read()).toMatchObject({ phase: 'applying', operationId: 'op-10' });

    emit!({ phase: 'result', status: 'restarting', operation_id: 'op-10' });
    await flush();
    expect(tabs.read()).toMatchObject({ phase: 'awaiting_reconnect', operationId: 'op-10' });
    mount.dispose();
  });

  it('ignores a terminal receipt belonging to a different client operation', async () => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    let emit: ((e: { phase: string; status?: string; operation_id?: string }) => void) | undefined;
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: async () => ({ status: 'applying', operation_id: 'owned-op' }),
      serverUpdateTabConvergence: tabs.first,
      updateProgress: { subscribe: (cb) => { emit = cb as typeof emit; return () => {}; } },
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read()).toMatchObject({ phase: 'applying', operationId: 'owned-op' });

    emit!({ phase: 'result', status: 'busy', operation_id: 'other-op' });
    await flush();
    expect(tabs.read()).toMatchObject({ phase: 'applying', operationId: 'owned-op' });
    expect(find(h.el, UPDATES_APPLY_BTN_ATTR)?.getAttribute('aria-busy')).toBe('true');

    emit!({ phase: 'result', status: 'stage-failed', operation_id: 'owned-op' });
    await flush();
    expect(tabs.read()).toBeNull();
    expect(find(h.el, UPDATES_APPLY_BTN_ATTR)?.getAttribute('aria-busy')).toBeNull();
    mount.dispose();
  });

  it('dispose releases a lease still held by an in-flight apply', async () => {
    // The owner navigates away mid-update. The lease was parked for a terminal
    // event that will now never be handled, and convergence then saw its OWN held
    // lock and could not reconcile it — blocking sibling tabs.
    //
    // ⚠ ASSERTED WITH A SPY ON THE LEASE ITSELF. Two earlier versions of this arm
    // watched `tabs.read()` and then a re-claim, and BOTH passed with the release
    // removed — the progress is cleared by a different line, and the double's
    // ownership flag was being freed by something else in the teardown. Watching
    // `release()` is the only thing that cannot be satisfied by accident.
    const releases: string[] = [];
    const tabs = sharedServerUpdateTabs();
    const spied = {
      ...tabs.first,
      async claimServerUpdateOwnership() {
        const lease = await tabs.first.claimServerUpdateOwnership();
        if (lease === null) return null;
        return { release: () => { releases.push('released'); lease.release(); } };
      },
    };
    const h = host();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply: async (): Promise<UpdateApplyResponse> => ({ status: 'applying' }),
      serverUpdateTabConvergence: spied,
      updateProgress: { subscribe: () => () => {} },
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(releases, 'an async apply PARKS its lease rather than releasing it').toEqual([]);

    mount.dispose();
    await flush();
    expect(releases, 'disposal must release the parked lease').toEqual(['released']);
  });
});

/** ⛔⛔ THE RECEIPT HAS TO EXIST BEFORE THE REQUEST DOES.
 *
 *  The server reserves an operation id before starting work so a caller that goes
 *  away can ask `update.operation_status` what became of it — but that id
 *  travelled only on the REPLY. A socket lost between acceptance and the reply
 *  left the update running and this tab holding an ID-LESS latch, which the catch
 *  then cleared. The one case the reservation exists for was the one it could not
 *  serve. */
describe('an apply whose reply may never arrive', () => {
  const mountWith = (runApply: Parameters<typeof mountUpdatesPage>[0]['runApply']) => {
    const tabs = sharedServerUpdateTabs();
    const h = host();
    const mount = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => AVAILABLE,
      runApply,
      serverUpdateTabConvergence: tabs.first,
    });
    return { tabs, h, mount };
  };

  it('⛔ LATCHES a receipt BEFORE the call, so an unanswered send is still nameable', async () => {
    let latchedAtCallTime: string | undefined;
    const { tabs, h } = mountWith(async (args) => {
      // Read the latch from INSIDE the call: this is the instant a socket can
      // drop, and what is on the latch here is all a later tab would ever have.
      latchedAtCallTime = tabs.read()?.operationId;
      expect(args.operation_id, 'and the same receipt goes on the wire').toBe(latchedAtCallTime);
      return { status: 'applying', operation_id: args.operation_id };
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(latchedAtCallTime, 'the latch named nothing until the reply came back')
      .toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("⛔ KEEPS the receipt when the outcome is IN DOUBT — the apply may be running", async () => {
    // `in_doubt` is minted for exactly this: dispatched, then the connection
    // dropped before its reply. Clearing here throws away the only handle on a
    // running update.
    const { tabs, h } = mountWith(async () => {
      throw new RpcError('connection_lost', 'the connection dropped', 0);
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read()?.operationId, 'a later tab must still be able to ask about this run')
      .toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('and DROPS it when the server actually answered — the arm that proves the above', async () => {
    // A real per-operation error came back through the dispatcher, so the server
    // decided and no run began. Keeping the latch would park the UI on a receipt
    // naming nothing.
    const { tabs, h } = mountWith(async () => {
      throw new RpcError('invalid_args', 'nope', 400);
    });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read(), 'no run started, so no receipt is owed').toBeNull();
  });

  it('⛔ TAKES OURS BACK OFF when the server answered without a receipt', async () => {
    // An `applying` with no `operation_id` means the server is too old to have
    // read the field, so the id we minted names NOTHING there. Keeping it would
    // be worse than the bug being fixed: a later tab would resolve a receipt the
    // server never issued, get `unknown`, and be walked through the closure flow
    // for an update that is running perfectly well.
    const { tabs, h } = mountWith(async () => ({ status: 'applying' }));
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(tabs.read(), 'the latch survives — the run is still going').not.toBeNull();
    expect(
      tabs.read()?.operationId,
      'but it must not claim a receipt this server never issued',
    ).toBeUndefined();
  });

  it("⛔ takes the REPLY's id when it differs — an older server minted its own", async () => {
    const SERVER_ID = '99999999-8888-4777-8666-555555555555';
    const { tabs, h } = mountWith(async () => ({ status: 'applying', operation_id: SERVER_ID }));
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR)!, 'click');
    await flush();
    expect(
      tabs.read()?.operationId,
      'ours names nothing on a server too old to read the field',
    ).toBe(SERVER_ID);
  });
});
