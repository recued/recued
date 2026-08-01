import { describe, expect, it, vi } from 'vitest';

import {
  STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR,
  STARTUP_FAILURE_DIAGNOSTIC_ATTR,
  STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR,
  STARTUP_FAILURE_DIAGNOSTIC_SUMMARY_ATTR,
  STARTUP_FAILURE_DIAGNOSTIC_STATUS_ATTR,
  STARTUP_FAILURE_TRIAGE_ACTION_ATTR,
  STARTUP_FAILURE_TRIAGE_ATTR,
  STARTUP_FAILURE_TRIAGE_RELOAD_ATTR,
  STARTUP_FAILURE_TRIAGE_STATUS_ATTR,
  buildStartupDiagnosticSummary,
  classifyStartupFailure,
  mountStartupFailureTriage,
  recoverStartupTaskWithTriage,
  type MountedStartupFailureTriage,
} from './startup-failure-triage.js';

interface FakeTriageDom {
  readonly document: Document;
  readonly getHtml: () => string;
  readonly actionFocus: ReturnType<typeof vi.fn>;
  readonly statusFocus: ReturnType<typeof vi.fn>;
  readonly diagnosticFocus: ReturnType<typeof vi.fn>;
  readonly diagnosticCopyFocus: ReturnType<typeof vi.fn>;
  readonly diagnosticSummaryFocus: ReturnType<typeof vi.fn>;
  readonly diagnosticStatusFocus: ReturnType<typeof vi.fn>;
  readonly fireAction: (attribute: string) => void;
  readonly fireReload: () => void;
  readonly listenerCount: () => number;
}

const fakeTriageDom = (): FakeTriageDom => {
  let html = '';
  const listeners = new Set<(event: Event) => void>();
  const actionFocus = vi.fn();
  const statusFocus = vi.fn();
  const diagnosticFocus = vi.fn();
  const diagnosticCopyFocus = vi.fn();
  const diagnosticSummaryFocus = vi.fn();
  const diagnosticStatusFocus = vi.fn();
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
      if (selector === `[${STARTUP_FAILURE_TRIAGE_ACTION_ATTR}]`) {
        return { focus: actionFocus };
      }
      if (selector === `[${STARTUP_FAILURE_TRIAGE_STATUS_ATTR}]`) {
        return { focus: statusFocus };
      }
      if (selector === `[${STARTUP_FAILURE_DIAGNOSTIC_ATTR}]`) {
        return { focus: diagnosticFocus };
      }
      if (selector === `[${STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR}]`) {
        return { focus: diagnosticCopyFocus };
      }
      if (selector === `[${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY_ATTR}]`) {
        return { focus: diagnosticSummaryFocus };
      }
      if (selector === `[${STARTUP_FAILURE_DIAGNOSTIC_STATUS_ATTR}]`) {
        return { focus: diagnosticStatusFocus };
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

  const fireAction = (attribute: string): void => {
    for (const listener of [...listeners]) {
      listener({
        target: {
          closest: (selector: string) =>
            selector === `[${attribute}]` ? {} : null,
        },
        preventDefault: vi.fn(),
      } as unknown as Event);
    }
  };

  return {
    document,
    getHtml: () => html,
    actionFocus,
    statusFocus,
    diagnosticFocus,
    diagnosticCopyFocus,
    diagnosticSummaryFocus,
    diagnosticStatusFocus,
    fireAction,
    fireReload: () => fireAction(STARTUP_FAILURE_TRIAGE_RELOAD_ATTR),
    listenerCount: () => listeners.size,
  };
};

describe('classifyStartupFailure', () => {
  it('keeps an explicit storage failure distinct even while offline', () => {
    expect(classifyStartupFailure(
      Object.assign(new Error('raw platform detail'), {
        name: 'SecurityError',
      }),
      false,
    )).toBe('storage');
  });

  it('uses the browser offline signal without treating online as proof', () => {
    expect(classifyStartupFailure(new Error('unexpected'), false))
      .toBe('offline');
    expect(classifyStartupFailure(new Error('unexpected'), true))
      .toBe('unknown');
  });

  it('recognizes explicit server and transport failures', () => {
    expect(classifyStartupFailure(
      Object.assign(new Error('raw'), { code: 'server_offline' }),
      true,
    )).toBe('server_unreachable');
    expect(classifyStartupFailure(
      new Error('webclient.browser-transport: WS error before open'),
      true,
    )).toBe('server_unreachable');
  });

  it('leaves unrelated errors honestly unknown', () => {
    expect(classifyStartupFailure(
      new TypeError('route composer assertion'),
      true,
    )).toBe('unknown');
  });
});

describe('buildStartupDiagnosticSummary', () => {
  it('keeps only closed-list observations and a sanitized server host', () => {
    const summary = buildStartupDiagnosticSummary({
      kind: 'server_unreachable',
      attemptCount: 2,
      online: true,
      savedAccessVerified: true,
      serverUrl:
        'wss://owner:PAIR-SECRET@Alice.Recued.Cloud:8443/ws/private?code=PAIR5678#chat/draft',
      capturedAt: new Date('2026-07-27T21:00:00.000Z'),
    });

    expect(summary).toContain('Captured: 2026-07-27T21:00:00.000Z');
    expect(summary).toContain('Failure category: Server unreachable');
    expect(summary).toContain('Startup attempts in this tab: 2');
    expect(summary).toContain('Browser network signal: Online hint');
    expect(summary).toContain('Saved browser access: Verified present');
    expect(summary).toContain('Server host: alice.recued.cloud:8443');
    expect(summary).toContain('Webclient shell: webclient-shell-v7');
    expect(summary).toContain(
      'The server host and any port shown above are included',
    );
    expect(summary).toContain(
      'URL paths, query parameters, and fragments are not included',
    );
    expect(summary).not.toContain('owner');
    expect(summary).not.toContain('PAIR-SECRET');
    expect(summary).not.toContain('PAIR5678');
    expect(summary).not.toContain('/ws/private');
    expect(summary).not.toContain('#chat/draft');
  });

  it('fails closed for invalid host, attempt, and clock inputs', () => {
    const summary = buildStartupDiagnosticSummary({
      kind: 'unknown',
      attemptCount: Number.NaN,
      online: null,
      savedAccessVerified: false,
      serverUrl: 'javascript:do-not-render',
      capturedAt: new Date(Number.NaN),
    });

    expect(summary).toContain('Captured: Unavailable');
    expect(summary).toContain('Startup attempts in this tab: 1');
    expect(summary).toContain('Browser network signal: Unavailable');
    expect(summary).toContain('Server host: Unavailable');
    expect(summary).not.toContain('do-not-render');
  });

  it('labels reload-carried attempt counts as a conservative lower bound', () => {
    const summary = buildStartupDiagnosticSummary({
      kind: 'server_unreachable',
      attemptCount: 2,
      attemptCountIsLowerBound: true,
      online: true,
      savedAccessVerified: true,
      capturedAt: new Date('2026-07-27T21:00:00.000Z'),
    });

    expect(summary).toContain('Startup attempts in this tab: At least 2');
    expect(summary).not.toContain('Startup attempts in this tab: 2\n');
  });
});

describe('mountStartupFailureTriage', () => {
  it('explains a server failure without exposing internals or changing access', () => {
    const dom = fakeTriageDom();
    const reload = vi.fn();
    mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(
        new Error('rpc raw token=do-not-render'),
        { code: 'server_offline' },
      ),
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: false,
      online: () => true,
      onRetry: async () => undefined,
      onReload: reload,
    });

    expect(dom.getHtml()).toContain(STARTUP_FAILURE_TRIAGE_ATTR);
    expect(dom.getHtml()).toContain('Startup needs attention');
    expect(dom.getHtml()).toContain('Recued can’t reach your server');
    expect(dom.getHtml()).toContain('Your saved access is still here.');
    expect(dom.getHtml()).toContain('does not clear saved access');
    expect(dom.getHtml()).toContain('send another pairing request');
    expect(dom.getHtml()).toContain('exact page you opened');
    expect(dom.getHtml()).toContain(STARTUP_FAILURE_TRIAGE_RELOAD_ATTR);
    expect(dom.getHtml()).toContain(
      'aria-describedby="webclient-startup-failure-triage-safety webclient-startup-failure-triage-context"',
    );
    expect(dom.getHtml()).not.toContain(
      STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR,
    );
    expect(dom.getHtml()).not.toContain('do-not-render');
    expect(dom.getHtml()).not.toContain('server_offline');
    expect(dom.getHtml()).toContain('aria-busy="false"');
    expect(dom.actionFocus).toHaveBeenCalledOnce();

    dom.fireReload();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('acknowledges a failed explicit reload and exposes safe diagnosis immediately', () => {
    const dom = fakeTriageDom();
    mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(
        new Error('raw reload failure token=DO-NOT-RENDER'),
        { code: 'server_offline' },
      ),
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: false,
      reloadAttempted: true,
      online: () => true,
      diagnosticServerUrl: 'wss://alice.recued.cloud:8443/ws',
      onRetry: async () => undefined,
    });

    expect(dom.getHtml()).toContain('Startup still needs attention');
    expect(dom.getHtml()).toContain(
      'This tab reloaded, but startup still did not finish.',
    );
    expect(dom.getHtml()).toContain('exact page you opened is still selected');
    expect(dom.getHtml()).toContain(
      STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR,
    );
    expect(dom.getHtml()).not.toContain('DO-NOT-RENDER');
    expect(dom.actionFocus).toHaveBeenCalledOnce();

    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR);

    expect(dom.getHtml()).toContain(
      'Startup attempts in this tab: At least 2',
    );
    expect(dom.getHtml()).toContain(
      'Server host: alice.recued.cloud:8443',
    );
  });

  it('keeps sibling-completed access explicit through repeated startup triage', async () => {
    const dom = fakeTriageDom();
    let finishRetry = (): void => undefined;
    const pendingRetry = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const host = mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(new Error('raw sibling retry failure'), {
        code: 'server_offline',
      }),
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: true,
      completedInAnotherTab: true,
      online: () => true,
      onRetry: () => pendingRetry,
    });

    expect(dom.getHtml()).toContain('Access saved in another tab');
    expect(dom.getHtml()).toContain(
      'Another tab already finished saving secure access',
    );
    expect(dom.getHtml()).toContain('Pairing is still complete.');
    expect(dom.getHtml()).toContain('Only this tab is retrying startup.');
    expect(dom.getHtml()).toContain(
      'completed pairing does not need to be repeated',
    );
    expect(dom.getHtml()).toContain(
      STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR,
    );
    expect(dom.getHtml()).not.toContain(STARTUP_FAILURE_TRIAGE_RELOAD_ATTR);
    expect(dom.getHtml()).not.toContain('raw sibling retry failure');

    const retry = host.retry();

    expect(dom.getHtml()).toContain(
      'Trying this tab again with the access already saved',
    );
    expect(dom.getHtml()).toContain('disabled');

    finishRetry();
    await retry;
  });

  it('protects an unsent draft from reload actions and retry advice', async () => {
    const dom = fakeTriageDom();
    const host = mountStartupFailureTriage({
      document: dom.document,
      initialFailure: new Error('unknown startup fault'),
      savedAccessVerified: true,
      draftPreserved: true,
      repeated: true,
      online: () => true,
      onRetry: async () => {
        throw new Error('still unknown');
      },
    });

    expect(dom.getHtml()).toContain('Startup still needs attention');
    expect(dom.getHtml()).toContain('exact page and unsent Chat draft');
    expect(dom.getHtml()).not.toContain(STARTUP_FAILURE_TRIAGE_RELOAD_ATTR);

    await host.retry();

    expect(dom.getHtml()).toContain('Keep this tab open');
    expect(dom.getHtml()).not.toContain('reload this tab');
    expect(dom.getHtml()).toContain(STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR);
  });

  it('previews and copies only the reviewable diagnostic summary', async () => {
    const dom = fakeTriageDom();
    const writer = vi.fn(async (_summary: string) => undefined);
    mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(
        new Error('raw token=DO-NOT-COPY draft=PRIVATE-DRAFT'),
        { code: 'server_offline' },
      ),
      savedAccessVerified: true,
      draftPreserved: true,
      repeated: true,
      online: () => true,
      diagnosticServerUrl:
        'wss://owner:PAIR-SECRET@Alice.Recued.Cloud:8443/ws?code=PAIR5678#chat/session/chat_1',
      diagnosticNow: () => new Date('2026-07-27T21:00:00.000Z'),
      diagnosticWriter: writer,
      onRetry: async () => undefined,
    });

    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR);

    expect(dom.getHtml()).toContain(STARTUP_FAILURE_DIAGNOSTIC_ATTR);
    expect(dom.getHtml()).toContain('Nothing is sent automatically');
    expect(dom.getHtml()).toContain('Server host: alice.recued.cloud:8443');
    expect(dom.getHtml()).toContain('Startup attempts in this tab: 2');
    expect(dom.getHtml()).not.toContain('DO-NOT-COPY');
    expect(dom.getHtml()).not.toContain('PRIVATE-DRAFT');
    expect(dom.getHtml()).not.toContain('PAIR-SECRET');
    expect(dom.getHtml()).not.toContain('PAIR5678');
    expect(dom.diagnosticFocus).toHaveBeenCalledOnce();

    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR);

    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    expect(dom.diagnosticStatusFocus).toHaveBeenCalledOnce();
    const copied = writer.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('Recued startup diagnostic');
    expect(copied).toContain('Server host: alice.recued.cloud:8443');
    expect(copied).not.toContain('DO-NOT-COPY');
    await vi.waitFor(() => {
      expect(dom.getHtml()).toContain(
        'Safe diagnostic copied. Paste it into your support conversation',
      );
    });
    expect(dom.getHtml()).toContain(STARTUP_FAILURE_DIAGNOSTIC_STATUS_ATTR);
    expect(dom.diagnosticCopyFocus).toHaveBeenCalledOnce();
  });

  it('keeps the visible summary usable when clipboard access is unavailable', async () => {
    const dom = fakeTriageDom();
    mountStartupFailureTriage({
      document: dom.document,
      initialFailure: new Error('unknown'),
      savedAccessVerified: false,
      draftPreserved: false,
      repeated: true,
      online: () => null,
      diagnosticNow: () => new Date('2026-07-27T21:00:00.000Z'),
      onRetry: async () => undefined,
    });

    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR);
    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR);

    await vi.waitFor(() => {
      expect(dom.getHtml()).toContain(
        'Copy is unavailable here. The summary is focused',
      );
    });
    expect(dom.getHtml()).toContain('tabindex="0"');
    expect(dom.diagnosticSummaryFocus).toHaveBeenCalledOnce();
  });

  it('does not attach a stale copy receipt to a refreshed failure summary', async () => {
    const dom = fakeTriageDom();
    let finishWrite: (() => void) | null = null;
    const writer = vi.fn(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const host = mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(new Error('first raw failure'), {
        code: 'server_offline',
      }),
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: true,
      online: () => true,
      diagnosticWriter: writer,
      onRetry: async () => undefined,
    });

    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR);
    dom.fireAction(STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR);

    expect(dom.getHtml()).toContain('Copying the reviewed summary');
    expect(dom.getHtml()).toContain('aria-busy="true"');
    expect(dom.diagnosticStatusFocus).toHaveBeenCalledOnce();

    host.showFailure(Object.assign(new Error('second raw failure'), {
      name: 'InvalidStateError',
    }));

    expect(dom.getHtml()).toContain(
      'Failure category: Browser storage read failed',
    );
    expect(dom.getHtml()).toMatch(
      new RegExp(`${STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR}[^>]*disabled`),
    );

    (finishWrite as (() => void) | null)?.();

    await vi.waitFor(() => {
      expect(dom.getHtml()).not.toMatch(
        new RegExp(`${STARTUP_FAILURE_DIAGNOSTIC_COPY_ATTR}[^>]*disabled`),
      );
    });
    expect(dom.getHtml()).not.toContain('Safe diagnostic copied');
  });

  it('does not claim saved access exists when a precheck could not verify it', () => {
    const dom = fakeTriageDom();
    mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(new Error('raw'), {
        code: 'server_offline',
      }),
      savedAccessVerified: false,
      draftPreserved: false,
      repeated: false,
      completedInAnotherTab: true,
      online: () => true,
      onRetry: async () => undefined,
    });

    expect(dom.getHtml()).toContain(
      'Recued has not cleared your saved access.',
    );
    expect(dom.getHtml()).not.toContain(
      'saved browser access is available',
    );
    expect(dom.getHtml()).not.toContain('Access saved in another tab');
    expect(dom.getHtml()).not.toContain('Pairing is still complete.');
  });

  it('respects an explicitly unknown online hint', () => {
    const dom = fakeTriageDom();
    Object.assign(dom.document, {
      readyState: 'complete',
      defaultView: { navigator: { onLine: false } },
    });
    mountStartupFailureTriage({
      document: dom.document,
      initialFailure: new Error('unexpected startup fault'),
      savedAccessVerified: false,
      draftPreserved: false,
      repeated: false,
      online: () => null,
      onRetry: async () => undefined,
    });

    expect(dom.getHtml()).toContain('Recued couldn’t finish opening');
    expect(dom.getHtml()).not.toContain('This browser appears offline');
  });

  it('restores cold-load focus without overriding a deliberate focus move', () => {
    const dom = fakeTriageDom();
    let onLoad: (() => void) | null = null;
    const removeEventListener = vi.fn();
    Object.assign(dom.document, {
      readyState: 'loading',
      defaultView: {
        addEventListener: (
          type: string,
          listener: () => void,
        ) => {
          if (type === 'load') onLoad = listener;
        },
        removeEventListener,
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
        clearTimeout: vi.fn(),
      },
    });
    const host = mountStartupFailureTriage({
      document: dom.document,
      initialFailure: new Error('unknown'),
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: false,
      onRetry: async () => undefined,
    });

    expect(dom.actionFocus).toHaveBeenCalledOnce();
    (onLoad as (() => void) | null)?.();
    expect(dom.actionFocus).toHaveBeenCalledTimes(2);

    Object.assign(dom.document, {
      activeElement: { id: 'user-selected-control' },
      body: {},
      documentElement: {},
    });
    (onLoad as (() => void) | null)?.();
    expect(dom.actionFocus).toHaveBeenCalledTimes(2);

    host.detach();
    expect(removeEventListener).toHaveBeenCalled();
  });

  it('updates the diagnosis after a failed retry and remains reusable', async () => {
    const dom = fakeTriageDom();
    const onFailure = vi.fn();
    const onRetry = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('idb request rejected'), {
        name: 'InvalidStateError',
      }))
      .mockResolvedValueOnce(undefined);
    const host = mountStartupFailureTriage({
      document: dom.document,
      initialFailure: Object.assign(new Error('raw'), {
        code: 'server_offline',
      }),
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: false,
      online: () => true,
      onRetry,
      onFailure,
    });

    expect(dom.getHtml()).not.toContain(
      STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR,
    );

    await host.retry();

    expect(dom.getHtml()).toContain('Browser storage interrupted startup');
    expect(dom.getHtml()).toContain('role="alert"');
    expect(onFailure).toHaveBeenCalledWith(
      expect.any(Error),
      'storage',
    );
    expect(dom.getHtml()).toContain('Startup still needs attention');
    expect(dom.getHtml()).toContain(STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR);
    expect(dom.actionFocus).toHaveBeenCalledTimes(2);

    await host.retry();

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(dom.getHtml()).toContain('Startup is ready');
    expect(dom.statusFocus).toHaveBeenCalled();
  });

  it('detaches without clearing a replacement pair surface', () => {
    const dom = fakeTriageDom();
    const host = mountStartupFailureTriage({
      document: dom.document,
      initialFailure: new Error('unknown'),
      savedAccessVerified: false,
      draftPreserved: false,
      repeated: false,
      onRetry: async () => undefined,
    });
    const rendered = dom.getHtml();

    host.detach();

    expect(dom.getHtml()).toBe(rendered);
    expect(dom.listenerCount()).toBe(0);
  });
});

describe('recoverStartupTaskWithTriage', () => {
  it('keeps a pre-shell task behind one card until an in-place retry succeeds', async () => {
    const dom = fakeTriageDom();
    const retryFailure = Object.assign(new Error('idb request rejected'), {
      name: 'InvalidStateError',
    });
    const task = vi.fn()
      .mockRejectedValueOnce(retryFailure)
      .mockResolvedValueOnce('ready');
    const onFailure = vi.fn();
    const mounted: { current: MountedStartupFailureTriage | null } = {
      current: null,
    };

    const result = recoverStartupTaskWithTriage({
      document: dom.document,
      initialFailure: new Error('initial read failed'),
      task,
      savedAccessVerified: false,
      repeated: true,
      reloadAttempted: true,
      online: () => true,
      onFailure,
      mountHost: (options) => {
        const host = mountStartupFailureTriage(options);
        mounted.current = host;
        return host;
      },
    });

    expect(dom.getHtml()).toContain(
      'This tab reloaded, but startup still did not finish.',
    );
    expect(dom.getHtml()).toContain(
      STARTUP_FAILURE_DIAGNOSTIC_ACTION_ATTR,
    );

    await mounted.current?.retry();
    expect(onFailure).toHaveBeenLastCalledWith(
      retryFailure,
      'storage',
    );

    await mounted.current?.retry();

    await expect(result).resolves.toBe('ready');
    expect(task).toHaveBeenCalledTimes(2);
    expect(dom.getHtml()).toContain(
      'Saved access check complete. Continuing startup…',
    );
    expect(dom.listenerCount()).toBe(0);
  });
});
