import { describe, expect, it, vi } from 'vitest';

import {
  POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR,
  POST_PAIR_STARTUP_RECOVERY_ATTR,
  POST_PAIR_STARTUP_RECOVERY_STATUS_ATTR,
  POST_PAIR_STARTUP_RETRY_ERROR_COPY,
  mountPostPairStartupRecovery,
} from './post-pair-startup-recovery.js';

interface FakeRecoveryDom {
  readonly document: Document;
  readonly getHtml: () => string;
  readonly actionFocus: ReturnType<typeof vi.fn>;
  readonly statusFocus: ReturnType<typeof vi.fn>;
  readonly fireAction: () => void;
  readonly listenerCount: () => number;
}

const fakeRecoveryDom = (): FakeRecoveryDom => {
  let html = '';
  const listeners = new Set<(event: Event) => void>();
  const actionFocus = vi.fn();
  const statusFocus = vi.fn();
  const splash = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'click') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'click') listeners.delete(listener);
    },
    querySelector: (selector: string) => {
      if (selector === `[${POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR}]`) {
        return { focus: actionFocus };
      }
      if (selector === `[${POST_PAIR_STARTUP_RECOVERY_STATUS_ATTR}]`) {
        return { focus: statusFocus };
      }
      return null;
    },
  } as unknown as HTMLElement;
  let styleNode: unknown = null;
  const document = {
    head: {
      querySelector: () => styleNode,
      appendChild: (node: unknown) => {
        styleNode = node;
        return node;
      },
    },
    createElement: () => ({
      setAttribute: vi.fn(),
      textContent: '',
    }),
    getElementById: (id: string) =>
      id === 'webclient-boot-splash-message' ? splash : null,
  } as unknown as Document;

  return {
    document,
    getHtml: () => html,
    actionFocus,
    statusFocus,
    fireAction: () => {
      for (const listener of [...listeners]) {
        listener({
          target: {
            closest: (selector: string) =>
              selector === `[${POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR}]`
                ? {}
                : null,
          },
          preventDefault: vi.fn(),
        } as unknown as Event);
      }
    },
    listenerCount: () => listeners.size,
  };
};

describe('mountPostPairStartupRecovery', () => {
  it('makes durable access and protected work explicit without offering pairing', () => {
    const dom = fakeRecoveryDom();
    mountPostPairStartupRecovery({
      document: dom.document,
      reconnect: true,
      draftPreserved: true,
      completedInAnotherTab: false,
      onRetry: async () => undefined,
    });

    expect(dom.getHtml()).toContain(POST_PAIR_STARTUP_RECOVERY_ATTR);
    expect(dom.getHtml()).toContain('Sign-in saved');
    expect(dom.getHtml()).toContain(
      'You do not need to pair this browser again.',
    );
    expect(dom.getHtml()).toContain('page and the Chat message you had not sent');
    expect(dom.getHtml()).toContain('Try opening Recued again');
    expect(dom.getHtml()).toContain('aria-busy="false"');
    expect(dom.getHtml()).not.toContain('<form');
    expect(dom.getHtml()).not.toContain('<input');
    expect(dom.getHtml()).not.toContain('recued pair');
    expect(dom.getHtml()).toContain(
      `aria-describedby="webclient-post-pair-startup-recovery-safe webclient-post-pair-startup-recovery-context"`,
    );
    expect(dom.actionFocus).toHaveBeenCalledOnce();
  });

  it('distinguishes sibling completion without claiming its receipt', () => {
    const dom = fakeRecoveryDom();
    mountPostPairStartupRecovery({
      document: dom.document,
      reconnect: false,
      draftPreserved: false,
      completedInAnotherTab: true,
      onRetry: async () => undefined,
    });

    expect(dom.getHtml()).toContain('Sign-in saved in another tab');
    expect(dom.getHtml()).toContain('Finish opening this tab');
    expect(dom.getHtml()).toContain('Another tab saved the sign-in');
    expect(dom.getHtml()).toContain('This browser is already paired.');
    expect(dom.getHtml()).toContain('page you opened is still chosen');
    expect(dom.getHtml()).toContain('Try opening this tab again');
    expect(dom.getHtml()).not.toContain('Browser paired');
    expect(dom.getHtml()).not.toContain('Reconnected');
  });

  it('announces one in-flight startup attempt and blocks duplicate retries', async () => {
    const dom = fakeRecoveryDom();
    let finishRetry = (): void => undefined;
    const pendingRetry = new Promise<void>((resolve) => {
      finishRetry = () => resolve();
    });
    const onRetry = vi.fn(() => pendingRetry);
    const host = mountPostPairStartupRecovery({
      document: dom.document,
      reconnect: true,
      draftPreserved: false,
      completedInAnotherTab: false,
      onRetry,
    });

    const firstAttempt = host.retry();
    const duplicateAttempt = host.retry();

    expect(onRetry).toHaveBeenCalledOnce();
    expect(dom.getHtml()).toContain('aria-busy="true"');
    expect(dom.getHtml()).toContain('Opening Recued…');
    expect(dom.getHtml()).toContain('disabled');
    expect(dom.statusFocus).toHaveBeenCalledOnce();

    finishRetry();
    await Promise.all([firstAttempt, duplicateAttempt]);
  });

  it('announces a failed startup-only retry and keeps the action reusable', async () => {
    const dom = fakeRecoveryDom();
    const onRetry = vi.fn()
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValueOnce(undefined);
    const host = mountPostPairStartupRecovery({
      document: dom.document,
      reconnect: true,
      draftPreserved: false,
      completedInAnotherTab: false,
      onRetry,
    });

    await host.retry();

    expect(dom.getHtml()).toContain(POST_PAIR_STARTUP_RETRY_ERROR_COPY);
    expect(dom.getHtml()).toContain('role="alert"');
    expect(dom.getHtml()).toContain('Try opening Recued again');
    expect(dom.actionFocus).toHaveBeenCalledTimes(2);

    await host.retry();

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(dom.getHtml()).toContain('Saved access is ready');
    expect(dom.statusFocus).toHaveBeenCalled();
  });

  it('detaches without clearing a replacement surface', () => {
    const dom = fakeRecoveryDom();
    const onRetry = vi.fn(async () => undefined);
    const host = mountPostPairStartupRecovery({
      document: dom.document,
      reconnect: false,
      draftPreserved: false,
      completedInAnotherTab: false,
      onRetry,
    });
    const rendered = dom.getHtml();

    host.detach();
    dom.fireAction();

    expect(dom.getHtml()).toBe(rendered);
    expect(dom.listenerCount()).toBe(0);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
