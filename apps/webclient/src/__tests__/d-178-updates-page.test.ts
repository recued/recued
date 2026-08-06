/** D-178 — Settings → Updates page acceptance.
 *
 *  Drives `mountUpdatesPage` through a fake Document (the webclient's per-test
 *  fake-DOM pattern) with injected rpc callers. Covers the check → available →
 *  apply (+ major force) flow, the mode toggle (incl. env-lock), rollback, the
 *  availability callback that drives the rail badge, the periodic poll, and
 *  dispose. */

import { describe, expect, it, vi } from 'vitest';

import type {
  ReleaseCheckResponse,
  UpdateApplyResponse,
  UpdateMode,
  UpdateModeStatus,
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
    expect(tabs.read()).toEqual({
      phase: 'applying',
      operation: 'update',
      startedAt: 100,
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
    )?.textContent).toMatch(/credentials.*endpoints.*raw errors/i);
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
    expect(find(
      siblingProgress,
      UPDATES_TAB_PROGRESS_STATUS_ATTR,
    )?.textContent).toMatch(/connected.*server-issued restart receipt/i);
    expect(siblingProgress.children[0]?.textContent)
      .toMatch(/checking update result/i);
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
    expect(recovery.hasAttribute('hidden')).toBe(false);
    expect(recovery.getAttribute('data-phase')).toBe('waiting');
    expect(recovery.getAttribute('aria-busy')).toBe('true');
    expect(allText(recovery)).toMatch(/retry automatically.*never repeats/i);
    fire(find(recovery, UPDATES_RECEIPT_RETRY_ATTR)!, 'click');
    expect(retry).toHaveBeenCalledOnce();

    setVerification({
      phase: 'checking',
      operation: 'update',
      startedAt: 100,
    });
    expect(recovery.hasAttribute('hidden')).toBe(false);
    expect(recovery.getAttribute('data-phase')).toBe('checking');
    expect(find(recovery, UPDATES_RECEIPT_RETRY_ATTR)?.textContent)
      .toBe('Checking receipt…');
    expect(find(
      recovery,
      UPDATES_RECEIPT_RETRY_ATTR,
    )?.hasAttribute('disabled')).toBe(true);

    setVerification({
      phase: 'retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'temporary_failure',
    });
    expect(recovery.getAttribute('aria-busy')).toBeNull();
    expect(allText(recovery)).toMatch(/automatic retries stopped/i);
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
    expect(allText(recovery)).toMatch(/verifying no release transition is active/i);

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
    expect(finish.textContent).toBe('Confirm current server state');
    fire(finish, 'click');
    expect(finishClosure).toHaveBeenCalledOnce();

    setVerification({
      phase: 'checking_baseline',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    });
    expect(recovery.getAttribute('aria-busy')).toBe('true');
    expect(finish.textContent).toBe('Confirming current state…');
    expect(finish.hasAttribute('disabled')).toBe(true);

    setVerification({
      phase: 'baseline_retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'baseline_unavailable',
    });
    expect(recovery.getAttribute('aria-busy')).toBeNull();
    expect(finish.textContent).toBe('Retry current-state check');
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
      /release feed is unreachable.*github-main.*no credential verification.*original update outcome remains unknown/is,
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
      /browser could not retire the exact recovery latch.*does not contact the server.*repeat/i,
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
      /recovery finished.*controls are available again.*one-shot.*will not replay.*original update.*unknown/is,
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
      'Finish and return to api/github-main',
    );
    verification = {
      ...verification,
      reason: 'finish_unavailable',
    };
    for (const listener of [...listeners]) listener({ ...verification });
    expect(finish.textContent).toBe(
      'Retry finish and return to api/github-main',
    );
    expect(allText(find(
      firstHost.el,
      UPDATES_RECEIPT_RECOVERY_ATTR,
    )!)).toMatch(
      /retry finish and return to api\/github-main.*does not contact the server or repeat/i,
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
    const runRollback = vi.fn(() => rollback.promise);
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
    expect(tabs.read()).toMatchObject({
      phase: 'applying',
      operation: 'rollback',
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
      .toMatch(/authoritative check/i);
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
      .toMatch(/server reconnected/i);

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
    expect(card.children[0]?.textContent).toBe('Credential check underway');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/will not start a duplicate check/i);
    expect(returnButton.textContent).toBe('Check underway…');
    expect(returnButton.hasAttribute('disabled')).toBe(true);
    expect(returnButton.getAttribute('aria-label')).toMatch(
      /already underway in connections/i,
    );
    expect(dismissButton.hasAttribute('disabled')).toBe(true);
    fire(returnButton, 'click');
    fire(dismissButton, 'click');
    expect(onReturnToCredentialRotationRetry).not.toHaveBeenCalled();
    expect(continuity.read()).not.toBeNull();

    continuity.interruptExactReturn(target);
    expect(card.hasAttribute('aria-busy')).toBe(false);
    expect(card.children[0]?.textContent).toBe('Resume credential check');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/interrupted before both authoritative reads finished/i);
    expect(returnButton.textContent).toBe('Resume exact check');
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
      'Resume credential replacement',
    );
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/clean editor.*closed before any field changed/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/no credential.*recovery receipt was stored/i);
    expect(returnButton.textContent).toBe('Resume clean editor');
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
      .toMatch(/still lacks.*safe preflight/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/run the capability check again/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/privacy-safe server version\/update evidence/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.textContent)
      .toBe('Check server again');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.getAttribute('aria-label'))
      .toMatch(/check the server capability again/i);
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
    expect(card.children[0]?.textContent).toBe('Credential check is ready');
    expect(find(card, UPDATES_CREDENTIAL_RETRY_STATUS_ATTR)?.textContent)
      .toMatch(/fresh, read-only check confirmed.*stayed on server updates/i);
    expect(find(card, UPDATES_CREDENTIAL_RETRY_PRIVACY_ATTR)?.textContent)
      .toMatch(/one-time confirmation.*will not replay after reload/i);
    const continueButton = find(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)!;
    expect(continueButton.textContent).toBe('Continue in this tab');
    expect(continueButton.getAttribute('aria-label')).toMatch(
      /continue.*api\/github-main.*this tab/i,
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
    expect(runApply).toHaveBeenCalledWith({});
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent).toMatch(/restart/i);
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
    expect(runApply).toHaveBeenNthCalledWith(1, {});
    const forceBtn = find(h.el, UPDATES_FORCE_APPLY_BTN_ATTR);
    expect(forceBtn).not.toBeNull();
    expect(forceBtn?.className).toContain('rx-btn-danger');
    fire(forceBtn as FE, 'click');
    await flush();
    expect(runApply).toHaveBeenNthCalledWith(2, { force: true });
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
