/** D-169 P1.5 NEXT-#1 — pair-fallback onAfterPair teardown regression tests.
 *
 *  Guards the onAfterPair teardown timing fix: dispose the completed pair
 *  form, show transitional startup copy, re-enter bootstrap, and remove the
 *  cold-start splash only after the re-entry actually mounts. This also
 *  covers the two folded Codex findings: cold-start splash removal on paired
 *  boot, and ensure-slot resilience when a later unpaired entry happens
 *  after the original splash was already removed.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  WebclientLocalKey,
  WebclientLocalStorage,
} from '@recued/contracts';

import type {
  MountPairCodeInputHostOptions,
  MountedPairCodeInputHost,
} from '../auth/pair-code-input-host.js';
import {
  PAIR_SUCCESS_RETURN_RECEIPT_COPY,
  REPLACEMENT_SERVER_RETURN_RECEIPT_COPY,
  STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
  STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
  queueStartupRecoveryForNextAttempt,
  removeBootSplashWrapper,
  pairFormServerUrlFromStored,
  runBootstrapWithPairFallback,
  setSplashMessage,
  type PairFallbackBootstrapDeps,
} from '../boot/pair-fallback-bootstrap.js';
import type { WebclientWsTransport } from '../realtime/ws-client.js';
import {
  createInMemoryWebclientLocalStore,
  type WebclientLocalStore,
  type WebclientProfileAwareStore,
} from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type {
  PairRecoverySuccessorLease,
  PairTabConvergence,
  PairTabConvergenceHint,
} from '../boot/pair-tab-convergence.js';
import {
  POST_PAIR_STARTUP_RECOVERY_ATTR,
  type MountPostPairStartupRecoveryOptions,
  type MountedPostPairStartupRecovery,
} from '../boot/post-pair-startup-recovery.js';
import {
  STARTUP_FAILURE_TRIAGE_ATTR,
  type MountedStartupFailureTriage,
  type MountStartupFailureTriageOptions,
} from '../boot/startup-failure-triage.js';
import {
  STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  type StartupReloadRecoveryStorage,
} from '../boot/startup-reload-recovery.js';
import {
  type WebclientHandle,
  type WebclientRecoverySnapshot,
  WebclientUnpairedError,
} from '../webclient-bootstrap.js';

type WebclientBootstrapModule = typeof import('../webclient-bootstrap.js');

const mockState = vi.hoisted(() => ({
  bootstrapWebclient: vi.fn(),
  mountPairCodeInputHost: vi.fn(),
  mountOptions: [] as unknown[],
  pairHandles: [] as unknown[],
  // M5 S3.4 — the restore flow controller is mocked so the boot arm's
  // `onRestoreSubmit` wiring is observable without standing up a real
  // orchestrator / splash / WS. Params typed `unknown` so `.mock.calls`
  // indexing typechecks under tsconfig.test.json.
  startRestoreOnboarding: vi.fn(
    (_deps: unknown, _inputs: unknown): { dispose: () => void } => ({
      dispose: vi.fn(),
    }),
  ),
}));

vi.mock('../webclient-bootstrap.js', async (importActual) => {
  const actual = await importActual<WebclientBootstrapModule>();
  return {
    ...actual,
    bootstrapWebclient: mockState.bootstrapWebclient,
  };
});

vi.mock('../auth/pair-code-input-host.js', () => ({
  mountPairCodeInputHost: mockState.mountPairCodeInputHost,
}));

vi.mock('../auth/restore-onboarding-flow.js', () => ({
  startRestoreOnboarding: mockState.startRestoreOnboarding,
}));

const SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';
const SPLASH_WRAPPER_ID = 'webclient-boot-splash';
const STARTING_COPY = 'Pairing complete — starting Recued…';
const REAUTH_RECOVERY_FAILED_COPY =
  'Recued could not restart pairing after a server identity change. Reload to re-pair.';

interface FakeElement extends HTMLElement {
  childList: FakeElement[];
}

interface FakeSplashControl {
  splash: HTMLElement;
  getText(): string;
  getHtml(): string;
  textWrites(): string[];
}

const makeFakeElement = (tag = 'div'): FakeElement => {
  const childList: FakeElement[] = [];
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    childList,
    appendChild: ((child: FakeElement): FakeElement => {
      childList.push(child);
      (child as unknown as { parentNode: FakeElement }).parentNode =
        el as unknown as FakeElement;
      return child;
    }) as unknown as HTMLElement['appendChild'],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
  };
  return el as unknown as FakeElement;
};

const makeFakeSplash = (events?: string[]): FakeSplashControl => {
  let html = '';
  let textContent = '';
  const textWrites: string[] = [];
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const attributes = new Map<string, string>();
  const focus = vi.fn(() => events?.push('splash:focus'));

  const splash = {
    id: SPLASH_MESSAGE_ID,
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    get textContent() {
      return textContent;
    },
    set textContent(value: string | null) {
      textContent = value ?? '';
      textWrites.push(textContent);
      events?.push(`splash:${textContent}`);
    },
    addEventListener: (event: string, listener: (event: Event) => void) => {
      (listeners[event] ??= new Set()).add(listener);
    },
    removeEventListener: (event: string, listener: (event: Event) => void) => {
      listeners[event]?.delete(listener);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    focus,
    querySelector: () => null,
  } as unknown as HTMLElement;

  return {
    splash,
    getText: () => textContent,
    getHtml: () => html,
    textWrites: () => textWrites.slice(),
  };
};

interface FakeDomFixture {
  document: Document;
  root: HTMLElement;
  message: HTMLElement | null;
  wrapper: HTMLElement | null;
  createdElements: FakeElement[];
  appendedRoots: HTMLElement[];
  createElement: ReturnType<typeof vi.fn>;
  rootAppendChild: ReturnType<typeof vi.fn>;
  removeWrapperChild: ReturnType<typeof vi.fn>;
  getMessageText(): string;
  getMessageHtml(): string;
  messageTextWrites(): string[];
}

const registerTree = (
  registry: Map<string, HTMLElement>,
  el: HTMLElement,
): void => {
  if (el.id) registry.set(el.id, el);
  for (const child of (el as unknown as { childList?: HTMLElement[] }).childList ?? []) {
    registerTree(registry, child);
  }
};

const makeFakeDocument = (
  options: {
    messagePresent?: boolean;
    wrapperPresent?: boolean;
    events?: string[];
  } = {},
): FakeDomFixture => {
  const messagePresent = options.messagePresent ?? true;
  const wrapperPresent = options.wrapperPresent ?? true;
  const registry = new Map<string, HTMLElement>();
  const createdElements: FakeElement[] = [];
  const appendedRoots: HTMLElement[] = [];
  const messageControl = messagePresent ? makeFakeSplash(options.events) : null;
  const message = messageControl?.splash ?? null;

  if (message) registry.set(SPLASH_MESSAGE_ID, message);

  const wrapper = wrapperPresent ? makeFakeElement('div') : null;
  const removeWrapperChild = vi.fn((child: HTMLElement): HTMLElement => {
    options.events?.push(`removeChild:${child.id}`);
    registry.delete(child.id);
    if (child === message) registry.delete(SPLASH_MESSAGE_ID);
    (child as unknown as { parentNode: null }).parentNode = null;
    return child;
  });
  if (wrapper) {
    wrapper.id = SPLASH_WRAPPER_ID;
    (wrapper as unknown as { parentNode: { removeChild: typeof removeWrapperChild } }).parentNode = {
      removeChild: removeWrapperChild,
    };
    registry.set(SPLASH_WRAPPER_ID, wrapper);
  }

  const createElement = vi.fn((tag: string): FakeElement => {
    const el = makeFakeElement(tag);
    createdElements.push(el);
    return el;
  });
  const rootAppendChild = vi.fn((child: HTMLElement): HTMLElement => {
    appendedRoots.push(child);
    (child as unknown as { parentNode: HTMLElement }).parentNode = root;
    registerTree(registry, child);
    return child;
  });
  const root = {
    ...makeFakeElement('div'),
    appendChild: rootAppendChild as unknown as HTMLElement['appendChild'],
  } as unknown as HTMLElement;

  const document = {
    getElementById: vi.fn((id: string): HTMLElement | null => registry.get(id) ?? null),
    createElement,
  } as unknown as Document;

  return {
    document,
    root,
    message,
    wrapper,
    createdElements,
    appendedRoots,
    createElement,
    rootAppendChild,
    removeWrapperChild,
    getMessageText: () => messageControl?.getText() ?? '',
    getMessageHtml: () => messageControl?.getHtml() ?? '',
    messageTextWrites: () => messageControl?.textWrites() ?? [],
  };
};

const sampleToken = () => ({
  token_id: 'tok-d169-onafterpair',
  ciphertext_b64: 'ciphertext',
  iv_b64: 'iv',
  issued_at: 1_700_000_000,
});

const buildPairedStore = (
  overrides?: Partial<WebclientLocalStorage>,
): WebclientLocalStore => {
  const data: Partial<WebclientLocalStorage> = {
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-base64',
    webclient_token: sampleToken(),
    pair_metadata: {
      paired_at: 1_700_000_000,
      server_passport_fingerprint: 'fp',
      server_handle_at_pair: 'alice',
    },
    cert_pin_state: null,
    ...overrides,
  };
  return {
    async get<K extends WebclientLocalKey>(key: K) {
      return (data[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
      (data as Record<string, unknown>)[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
    async inspect() {
      return {
        server_url: data.server_url ?? null,
        webclient_token: data.webclient_token ?? null,
        server_public_key: data.server_public_key ?? null,
        pair_metadata: data.pair_metadata ?? null,
        cert_pin_state: data.cert_pin_state ?? null,
      };
    },
    async clear() {
      for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
    },
  };
};

const buildUnpairedStore = (): WebclientLocalStore =>
  buildPairedStore({
    server_url: null,
    webclient_token: null,
    server_public_key: null,
    pair_metadata: null,
    cert_pin_state: null,
  });

const buildMultiProfileStore = async (): Promise<{
  store: WebclientProfileAwareStore;
  sourceId: string;
  targetId: string;
}> => {
  const store = createInMemoryWebclientLocalStore({
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-source',
    webclient_token: sampleToken(),
    pair_metadata: {
      paired_at: 1_700_000_000,
      server_passport_fingerprint: 'fp-source',
      server_handle_at_pair: 'alice',
    },
    cert_pin_state: null,
  });
  const sourceId = await store.activeProfileId();
  if (sourceId === null) throw new Error('source profile was not created');
  const targetId = await store.ensureProfile('wss://office.recued.cloud:9443/ws');
  await store.set('server_public_key', 'spki-target');
  await store.set('webclient_token', {
    ...sampleToken(),
    token_id: 'tok-target',
    ciphertext_b64: 'ciphertext-target',
    iv_b64: 'iv-target',
  });
  await store.set('pair_metadata', {
    paired_at: 1_700_000_100,
    server_passport_fingerprint: 'fp-target',
    server_handle_at_pair: 'office',
  });
  await store.switchProfile(sourceId);
  return { store, sourceId, targetId };
};

const buildFakeTokenStore = (): WebclientTokenStore => ({
  async wrap() {
    throw new Error('wrap not used by pair-fallback bootstrap tests');
  },
  async unwrap() {
    throw new Error('unwrap not used by pair-fallback bootstrap tests');
  },
});

const buildFakeTransport = (): WebclientWsTransport => ({
  async open() {
    throw new Error('open not used by pair-fallback bootstrap tests');
  },
  async close() {
    throw new Error('close not used by pair-fallback bootstrap tests');
  },
  async send() {
    throw new Error('send not used by pair-fallback bootstrap tests');
  },
  onMessage() {
    return () => undefined;
  },
  onState() {
    return () => undefined;
  },
});

const makePairTabConvergence = () => {
  const listeners = new Set<(hint: PairTabConvergenceHint) => void>();
  const notifyPairComplete = vi.fn();
  const notifyCredentialStateChanged = vi.fn();
  const notifyActiveServerProfileChanged = vi.fn();
  const notifyPairTransitionStarted = vi.fn();
  const notifyPairTakeoverStarted = vi.fn();
  const notifyPairTakeoverNeedsAttention = vi.fn();
  const notifyPairRecoverySuccessorChosen = vi.fn();
  const claimPairRecoverySuccessor = vi
    .fn<() => Promise<PairRecoverySuccessorLease | null>>(async () => null);
  const close = vi.fn(() => listeners.clear());
  const convergence: PairTabConvergence = {
    supportsImmediateSignals: true,
    supportsRecoverySuccessorElection: true,
    notifyPairComplete,
    notifyCredentialStateChanged,
    notifyActiveServerProfileChanged,
    notifyPairTransitionStarted,
    notifyPairTakeoverStarted,
    notifyPairTakeoverNeedsAttention,
    notifyPairRecoverySuccessorChosen,
    claimPairRecoverySuccessor,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
  return {
    convergence,
    notifyPairComplete,
    notifyCredentialStateChanged,
    notifyActiveServerProfileChanged,
    notifyPairTransitionStarted,
    notifyPairTakeoverStarted,
    notifyPairTakeoverNeedsAttention,
    notifyPairRecoverySuccessorChosen,
    claimPairRecoverySuccessor,
    close,
    emit: (hint: PairTabConvergenceHint = 'reconcile') => {
      for (const listener of [...listeners]) listener(hint);
    },
    listenerCount: () => listeners.size,
  };
};

const makePostPairStartupRecovery = () => {
  let options: MountPostPairStartupRecoveryOptions | null = null;
  const dispose = vi.fn();
  const detach = vi.fn();
  const factory = vi.fn((next: MountPostPairStartupRecoveryOptions) => {
    options = next;
    const handle: MountedPostPairStartupRecovery = {
      retry: next.onRetry,
      dispose,
      detach,
    };
    return handle;
  });
  return {
    factory,
    dispose,
    detach,
    options: () => options,
  };
};

const makeStartupFailureTriage = () => {
  let options: MountStartupFailureTriageOptions | null = null;
  const dispose = vi.fn();
  const detach = vi.fn();
  const showFailure = vi.fn();
  const factory = vi.fn((next: MountStartupFailureTriageOptions) => {
    options = next;
    const handle: MountedStartupFailureTriage = {
      retry: next.onRetry,
      showFailure,
      dispose,
      detach,
    };
    return handle;
  });
  return {
    factory,
    dispose,
    detach,
    showFailure,
    options: () => options,
  };
};

const populateCompletePair = async (
  localStore: WebclientLocalStore,
): Promise<void> => {
  await localStore.set('pair_metadata', {
    paired_at: 1_700_000_001,
    server_passport_fingerprint: 'spki-sibling',
    server_handle_at_pair: 'alice',
    instance_id: 'browser-sibling-winner',
  });
  await localStore.set('cert_pin_state', null);
  await localStore.set('server_url', 'wss://alice.recued.cloud:8443/ws');
  await localStore.set('server_public_key', 'spki-sibling');
  await localStore.set('webclient_token', {
    token_id: 'tok-sibling-winner',
    ciphertext_b64: 'ciphertext-sibling',
    iv_b64: 'iv-sibling',
    issued_at: 1_700_000_001,
  });
};

const makeWebclientHandle = (
  recoverySnapshot: WebclientRecoverySnapshot = { returnHash: '#chat' },
  serverProfileId: string | null = null,
): WebclientHandle =>
  ({
    activeRoute: () => 'reception',
    receptionShell: () => ({}),
    conn: () => ({}),
    settingsRoute: () => null,
    certPinStateWatcher: () => null,
    serverProfileId: () => serverProfileId,
    requestServerProfileConvergence: vi.fn(),
    refreshServerProfiles: vi.fn(),
    captureRecoverySnapshot: vi.fn(() => recoverySnapshot),
    dispose: vi.fn(async () => undefined),
  }) as unknown as WebclientHandle;

const makeMountedPairHandle = (events?: string[]): MountedPairCodeInputHost => ({
  dispose: vi.fn(() => {
    events?.push('codeHandle.dispose');
  }),
  submit: vi.fn(async () => undefined),
  setFieldValue: vi.fn(),
  showInterruptedCredentialTransition: vi.fn(),
  showSiblingPairAccepted: vi.fn(),
  showSiblingTakeoverStarted: vi.fn(),
  showSiblingTakeoverNeedsAttention: vi.fn(),
  showSiblingRecoverySuccessorChosen: vi.fn(),
  disableSiblingTakeoverCoordination: vi.fn(),
});

let nextPairHandleFactory:
  | ((options: MountPairCodeInputHostOptions) => MountedPairCodeInputHost)
  | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  mockState.bootstrapWebclient.mockReset();
  mockState.mountPairCodeInputHost.mockReset();
  mockState.startRestoreOnboarding.mockReset();
  mockState.startRestoreOnboarding.mockReturnValue({ dispose: vi.fn() });
  mockState.mountOptions.length = 0;
  mockState.pairHandles.length = 0;
  nextPairHandleFactory = null;
  mockState.mountPairCodeInputHost.mockImplementation(
    (options: MountPairCodeInputHostOptions) => {
      mockState.mountOptions.push(options);
      const handle = nextPairHandleFactory
        ? nextPairHandleFactory(options)
        : makeMountedPairHandle();
      mockState.pairHandles.push(handle);
      return handle;
    },
  );
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
});

const mountOptions = (): MountPairCodeInputHostOptions[] =>
  mockState.mountOptions as MountPairCodeInputHostOptions[];

const pairHandles = (): MountedPairCodeInputHost[] =>
  mockState.pairHandles as MountedPairCodeInputHost[];

const makeDeps = (
  dom: FakeDomFixture,
  localStore: WebclientLocalStore = buildPairedStore(),
): PairFallbackBootstrapDeps => ({
  root: dom.root,
  localStore,
  tokenStore: buildFakeTokenStore(),
  transport: buildFakeTransport() as PairFallbackBootstrapDeps['transport'],
  handleRef: { current: null },
  cryptoKeysWiper: async () => undefined,
  document: dom.document,
});

const mountUnpairedPairForm = async (
  deps: PairFallbackBootstrapDeps,
): Promise<MountPairCodeInputHostOptions> => {
  const outcome = await runBootstrapWithPairFallback(deps);
  expect(outcome).toEqual({ kind: 'pair-form' });
  expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
  const options = mountOptions()[0];
  expect(options?.onAfterPair).toEqual(expect.any(Function));
  return options!;
};

describe('D-169 P1.5 NEXT-#1 pair-fallback outcome contract', () => {
  it('returns mounted and stores the bootstrap handle when bootstrapWebclient resolves', async () => {
    const dom = makeFakeDocument();
    const deps = makeDeps(dom);
    const handle = makeWebclientHandle();
    mockState.bootstrapWebclient.mockResolvedValueOnce(handle);

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'mounted' });
    expect(deps.handleRef.current).toBe(handle);
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
  });

  it('lands reload-time sibling convergence silently on the exact mounted route', async () => {
    const dom = makeFakeDocument();
    const focus = vi.fn();
    const contentRoot = {
      tagName: 'MAIN',
      focus,
      contains: vi.fn(() => false),
      hasAttribute: vi.fn(() => true),
      setAttribute: vi.fn(),
    } as unknown as HTMLElement;
    vi.mocked(dom.root.querySelector).mockReturnValue(contentRoot);
    const replaceUrl = vi.fn();
    const deps: PairFallbackBootstrapDeps = Object.freeze({
      ...makeDeps(dom),
      silentCredentialConvergence: true,
      currentUrl: () =>
        'https://app.recued.test/webclient/?keep=exact%20route&code=USED-CODE#connections',
      replaceUrl,
    });
    const handle = makeWebclientHandle();
    const laterHandle = makeWebclientHandle();
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(handle)
      .mockResolvedValueOnce(laterHandle);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'mounted',
    });

    expect(mockState.bootstrapWebclient.mock.calls[0]?.[0]).toMatchObject({
      suppressInitialConnectedReceipt: true,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[0]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://app.recued.test/webclient/?keep=exact%20route#connections',
    );
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(deps.silentCredentialConvergence).toBe(true);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'mounted',
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('confirms an explicit startup retry after a sibling-owned guided return fails', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const replacement = makeWebclientHandle();
    const startupFailure = new Error('sibling return startup failed');
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        pairCompletedInAnotherTab: true,
      },
      postPairStartupRecoveryFactory: recovery.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(startupFailure)
      .mockResolvedValueOnce(replacement);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: startupFailure,
    });
    expect(mockState.bootstrapWebclient.mock.calls[0]?.[0]).toMatchObject({
      suppressInitialConnectedReceipt: true,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[0]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(recovery.options()).toMatchObject({
      reconnect: true,
      draftPreserved: false,
      completedInAnotherTab: true,
    });
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();

    await recovery.options()?.onRetry();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(recovery.dispose).toHaveBeenCalledOnce();
  });

  it('keeps reload-time sibling convergence on startup-only recovery when opening fails', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const replacement = makeWebclientHandle();
    const startupFailure = new Error('cold sibling landing failed');
    const deps: PairFallbackBootstrapDeps = Object.freeze({
      ...makeDeps(dom),
      silentCredentialConvergence: true,
      postPairStartupRecoveryFactory: recovery.factory,
    });
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(startupFailure)
      .mockResolvedValueOnce(replacement);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: startupFailure,
    });

    expect(recovery.options()).toMatchObject({
      reconnect: false,
      draftPreserved: false,
      completedInAnotherTab: true,
    });
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(deps.silentCredentialConvergence).toBe(true);

    await recovery.options()?.onRetry();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
  });

  it('escalates a failed sibling startup retry without looping back to pairing', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const triage = makeStartupFailureTriage();
    const initialFailure = new Error('sibling landing failed');
    const repeatedFailure = Object.assign(
      new Error('server unavailable after explicit retry'),
      { code: 'server_offline' },
    );
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        pairCompletedInAnotherTab: true,
        chatDraft: {
          text: 'Keep this sibling-tab draft.',
          protected: true,
          modelSourceId: null,
        },
      },
      postPairStartupRecoveryFactory: recovery.factory,
      startupFailureTriageFactory: triage.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(initialFailure)
      .mockRejectedValueOnce(repeatedFailure);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: initialFailure,
    });
    await recovery.options()?.onRetry();

    expect(recovery.factory).toHaveBeenCalledOnce();
    expect(recovery.detach).toHaveBeenCalledOnce();
    expect(triage.options()).toMatchObject({
      initialFailure: repeatedFailure,
      savedAccessVerified: true,
      draftPreserved: true,
      repeated: true,
      completedInAnotherTab: true,
    });
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
  });

  it('automatically replaces sibling triage with guided re-pair when access disappears', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const recovery = makePostPairStartupRecovery();
    const triage = makeStartupFailureTriage();
    const triageTabs = makePairTabConvergence();
    const replacement = makeWebclientHandle();
    const pairLockRequest = vi.fn(
      async (_name: unknown, _options: unknown, callback: unknown) =>
        (callback as () => Promise<unknown>)(),
    );
    const replaceHash = vi.fn();
    let guardActive = true;
    const release = vi.fn(() => {
      guardActive = false;
    });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      pairLockProvider: {
        request: pairLockRequest,
      } as unknown as NonNullable<
        PairFallbackBootstrapDeps['pairLockProvider']
      >,
      currentHash: () => '#chat/session/chat_1',
      replaceHash,
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        pairCompletedInAnotherTab: true,
        chatDraft: {
          text: 'Keep this sibling recovery draft.',
          protected: true,
          modelSourceId: null,
        },
        draftGuard: {
          release,
          isActive: () => guardActive,
        },
      },
      postPairStartupRecoveryFactory: recovery.factory,
      startupFailureTriageFactory: triage.factory,
      credentialTabConvergenceFactory: vi
        .fn<() => PairTabConvergence | null>()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(triageTabs.convergence)
        .mockReturnValue(null),
      pairTabConvergenceFactory: null,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new Error('sibling landing failed'))
      .mockRejectedValueOnce(new Error('explicit retry still failed'))
      .mockRejectedValueOnce(
        new WebclientUnpairedError('saved access disappeared'),
      )
      .mockResolvedValueOnce(replacement);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: expect.any(Error),
    });
    await recovery.options()?.onRetry();
    await vi.waitFor(() => {
      expect(triageTabs.listenerCount()).toBe(1);
      expect(pairLockRequest).toHaveBeenCalledTimes(2);
    });

    // Broadcasts are only hints. A stale/same-generation event must leave the
    // verified triage and its observer in place until the durable record
    // actually changes.
    triageTabs.emit('credential_state_changed');
    await vi.waitFor(() => {
      expect(pairLockRequest).toHaveBeenCalledTimes(3);
    });
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(2);
    expect(triageTabs.listenerCount()).toBe(1);
    expect(triageTabs.close).not.toHaveBeenCalled();

    await localStore.clear();
    triageTabs.emit('credential_state_changed');

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    });
    expect(triage.detach).toHaveBeenCalledOnce();
    expect(triage.dispose).not.toHaveBeenCalled();
    expect(triageTabs.close).toHaveBeenCalledOnce();
    expect(mountOptions()[0]).toMatchObject({
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: {
        chatDraftPreserved: true,
        reason: 'startup_credentials_changed_elsewhere',
      },
    });
    expect(mockState.bootstrapWebclient.mock.calls[2]?.[0]).toMatchObject({
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        pairCompletedInAnotherTab: true,
        chatDraft: { text: 'Keep this sibling recovery draft.' },
        reason: 'startup_credentials_changed_elsewhere',
      },
      initialConnectedReceiptCopy:
        STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
    });
    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(release).not.toHaveBeenCalled();

    await populateCompletePair(localStore);
    await mountOptions()[0]?.onAfterPair?.();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.bootstrapWebclient.mock.calls[3]?.[0]).toMatchObject({
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        chatDraft: { text: 'Keep this sibling recovery draft.' },
        reason: 'startup_credentials_changed_elsewhere',
        pairCompletedInAnotherTab: false,
      },
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[3]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(
      mockState.bootstrapWebclient.mock.calls[3]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('automatically adopts replacement access from sibling triage without pairing', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const recovery = makePostPairStartupRecovery();
    const triage = makeStartupFailureTriage();
    const triageTabs = makePairTabConvergence();
    const replacement = makeWebclientHandle();
    const release = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        pairCompletedInAnotherTab: true,
        chatDraft: {
          text: 'Keep this draft through replacement access.',
          protected: true,
          modelSourceId: null,
        },
        draftGuard: {
          release,
          isActive: () => true,
        },
      },
      postPairStartupRecoveryFactory: recovery.factory,
      startupFailureTriageFactory: triage.factory,
      credentialTabConvergenceFactory: vi
        .fn<() => PairTabConvergence | null>()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(triageTabs.convergence)
        .mockReturnValue(null),
      pairTabConvergenceFactory: null,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new Error('sibling landing failed'))
      .mockRejectedValueOnce(new Error('explicit retry still failed'))
      .mockResolvedValueOnce(replacement);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: expect.any(Error),
    });
    await recovery.options()?.onRetry();
    await vi.waitFor(() => {
      expect(triageTabs.listenerCount()).toBe(1);
    });

    await populateCompletePair(localStore);
    triageTabs.emit('pair_complete');

    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(triage.dispose).toHaveBeenCalledOnce();
    expect(triage.detach).not.toHaveBeenCalled();
    expect(triageTabs.close).toHaveBeenCalledOnce();
    expect(mockState.bootstrapWebclient.mock.calls[2]?.[0]).toMatchObject({
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        pairCompletedInAnotherTab: true,
        chatDraft: { text: 'Keep this draft through replacement access.' },
        reason: 'startup_credentials_changed_elsewhere',
      },
      initialConnectedReceiptCopy:
        STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
    });
    expect(release).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('cleans a stale pair entry after an already-paired cold boot without replaying its receipt', async () => {
    const dom = makeFakeDocument();
    const replaceUrl = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      deeplinkSeed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
        pairingCode: 'PAIR5678',
      },
      currentUrl: () =>
        'https://alice.recued.cloud/webclient/?keep=a%20b&code=PAIR5678&recued_pair_resume=same-origin#chat/session/chat_1',
      replaceUrl,
    };
    mockState.bootstrapWebclient.mockResolvedValueOnce(makeWebclientHandle());

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'mounted',
    });

    expect(replaceUrl).toHaveBeenCalledOnce();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );
    expect(
      mockState.bootstrapWebclient.mock.calls[0]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
  });

  it('delivers the post-pair receipt once without mutating frozen caller-owned deps', async () => {
    const dom = makeFakeDocument();
    const deps: PairFallbackBootstrapDeps = Object.freeze({
      ...makeDeps(dom),
      postPairReceiptCopy: PAIR_SUCCESS_RETURN_RECEIPT_COPY,
    });
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(makeWebclientHandle())
      .mockResolvedValueOnce(makeWebclientHandle());

    await runBootstrapWithPairFallback(deps);
    await runBootstrapWithPairFallback(deps);

    expect(
      mockState.bootstrapWebclient.mock.calls[0]?.[0]
        .initialConnectedReceiptCopy,
    ).toBe(PAIR_SUCCESS_RETURN_RECEIPT_COPY);
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(deps.postPairReceiptCopy).toBe(PAIR_SUCCESS_RETURN_RECEIPT_COPY);
  });

  it('verifies and adopts a sibling-tab pair at this tab exact clean route without a receipt', async () => {
    const dom = makeFakeDocument();
    const localStore = buildUnpairedStore();
    const pairTabs = makePairTabConvergence();
    let currentUrl =
      'https://alice.recued.cloud/webclient/?keep=a%20b&code=PAIR5678&recued_pair_resume=same-origin#chat/session/chat_1';
    const replaceUrl = vi.fn((target: string) => {
      currentUrl = target;
    });
    const replaceHash = vi.fn();
    const replacement = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      deeplinkSeed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
        pairingCode: 'PAIR5678',
      },
      currentUrl: () => currentUrl,
      replaceUrl,
      currentHash: () => '#chat/session/chat_1',
      replaceHash,
      postPairReceiptCopy: 'Stale receipt must not cross tabs.',
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'pair-form',
    });
    expect(pairTabs.listenerCount()).toBe(1);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    expect(mountOptions()[0]?.siblingTakeoverSignalsAvailable).toBe(true);

    // A completion hint alone is never authority. The durable store is still
    // empty, so the current form and its locally entered material stay intact.
    pairTabs.emit();
    await Promise.resolve();
    await Promise.resolve();
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(
      pairHandles()[0]?.showInterruptedCredentialTransition,
    ).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);

    // A partial durable write is enough to retire a possibly consumed code,
    // but not enough to retire the form or attempt startup.
    await localStore.set('server_url', 'wss://alice.recued.cloud:8443/ws');
    pairTabs.emit();
    await Promise.resolve();
    await Promise.resolve();
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(
        pairHandles()[0]?.showInterruptedCredentialTransition,
      ).toHaveBeenCalled();
    });
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);

    await populateCompletePair(localStore);
    pairTabs.emit();
    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    expect(pairTabs.notifyPairComplete).not.toHaveBeenCalled();
    expect(pairTabs.close).toHaveBeenCalledOnce();
    expect(pairTabs.listenerCount()).toBe(0);
    expect(replaceUrl).toHaveBeenCalledOnce();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );
    expect(replaceHash).not.toHaveBeenCalled();
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('offers startup-only recovery when a sibling pair is durable but this tab cannot open', async () => {
    const dom = makeFakeDocument();
    const localStore = buildUnpairedStore();
    const pairTabs = makePairTabConvergence();
    const recovery = makePostPairStartupRecovery();
    const replacement = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      pairTabConvergenceFactory: () => pairTabs.convergence,
      postPairStartupRecoveryFactory: recovery.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new Error('sibling return startup failed'))
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'pair-form',
    });
    await populateCompletePair(localStore);
    pairTabs.emit();
    await vi.waitFor(() => {
      expect(recovery.factory).toHaveBeenCalledOnce();
    });

    expect(recovery.options()).toMatchObject({
      reconnect: false,
      draftPreserved: false,
      completedInAnotherTab: true,
    });
    expect(dom.message?.getAttribute('role')).toBeNull();
    expect(dom.message?.getAttribute('aria-live')).toBeNull();
    expect(dom.message?.getAttribute('aria-atomic')).toBeNull();
    expect(dom.message?.getAttribute('tabindex')).toBeNull();
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).not.toHaveBeenCalled();

    await recovery.options()?.onRetry();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    expect(mockState.bootstrapWebclient.mock.calls[2]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[2]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(recovery.dispose).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('waits for the pairing lock before adopting a sibling durable generation', async () => {
    const dom = makeFakeDocument();
    const localStore = buildUnpairedStore();
    const pairTabs = makePairTabConvergence();
    const replacement = makeWebclientHandle();
    let releaseSecondRead = (): void => undefined;
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    let requestCount = 0;
    let firstReadComplete = false;
    const pairLockRequest = vi.fn(
      async (_name: unknown, _options: unknown, callback: unknown) => {
        requestCount += 1;
        if (requestCount === 2) await secondReadGate;
        const result = await (callback as () => Promise<unknown>)();
        if (requestCount === 1) firstReadComplete = true;
        return result;
      },
    );
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      pairLockProvider: {
        request: pairLockRequest,
      } as unknown as NonNullable<
        PairFallbackBootstrapDeps['pairLockProvider']
      >,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'pair-form',
    });
    await vi.waitFor(() => expect(firstReadComplete).toBe(true));

    await populateCompletePair(localStore);
    pairTabs.emit('pair_complete');
    await vi.waitFor(() => expect(pairLockRequest).toHaveBeenCalledTimes(2));

    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);

    releaseSecondRead();
    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledOnce();
    expect(pairTabs.close).toHaveBeenCalledOnce();
  });

  it('signals a partial finalize and keeps sibling forms as explicit takeover paths', async () => {
    const dom = makeFakeDocument();
    const localStore = createInMemoryWebclientLocalStore();
    const originalEnsureProfile = localStore.ensureProfile.bind(localStore);
    let interruptWrite = true;
    localStore.ensureProfile = async (serverUrl): Promise<string> => {
      const id = await originalEnsureProfile(serverUrl);
      if (interruptWrite) {
        interruptWrite = false;
        throw new Error('simulated tab interruption');
      }
      return id;
    };
    const tokenStore: WebclientTokenStore = {
      async wrap({ token_id }) {
        return { ...sampleToken(), token_id };
      },
      async unwrap() {
        return 'unused-bearer';
      },
    };
    const pairTabs = makePairTabConvergence();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      profileStore: localStore,
      tokenStore,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const options = await mountUnpairedPairForm(deps);
    options.onPairAccepted?.();
    await expect(options.onPaired({
      serverUrl: 'https://alice.recued.cloud:8443',
      token: 'successful-server-bearer',
      token_id: 'tok-interrupted',
      passport: {
        identity: {
          server_public_key: 'spki-interrupted',
          current_handle: 'alice',
        },
        network: {},
      },
      recoveryKey: `${Array(23).fill('abandon').join(' ')} art`,
    })).rejects.toThrow('credentials to local storage');

    expect(pairTabs.notifyPairTransitionStarted).toHaveBeenCalledOnce();
    expect(pairTabs.notifyCredentialStateChanged).not.toHaveBeenCalled();
    expect(await localStore.inspect()).toMatchObject({
      server_url: 'wss://alice.recued.cloud:8443/ws',
      server_public_key: null,
      webclient_token: null,
    });
    pairTabs.emit();
    await vi.waitFor(() => {
      expect(
        pairHandles()[0]?.showInterruptedCredentialTransition,
      ).toHaveBeenCalled();
    });
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
  });

  it('retires a consumed code in every open form as soon as a sibling server accepts pairing', async () => {
    const dom = makeFakeDocument();
    const pairTabs = makePairTabConvergence();
    let currentUrl =
      'https://alice.recued.cloud/webclient/?keep=a%20b&code=PAIR5678&recued_pair_resume=same-origin#chat/session/chat_1';
    const replaceUrl = vi.fn((target: string) => {
      currentUrl = target;
    });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      currentUrl: () => currentUrl,
      replaceUrl,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const options = await mountUnpairedPairForm(deps);
    options.onPairAccepted?.();

    expect(pairTabs.notifyPairTransitionStarted).toHaveBeenCalledOnce();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );

    pairTabs.emit('pair_transition_started');
    expect(
      pairHandles()[0]?.showSiblingPairAccepted,
    ).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
  });

  it('makes failed and passive forms yield when a queued takeover owns the lock', async () => {
    const dom = makeFakeDocument();
    const pairTabs = makePairTabConvergence();
    let currentUrl =
      'https://alice.recued.cloud/webclient/?code=STALE-CODE#chat/session/chat_1';
    const replaceUrl = vi.fn((target: string) => {
      currentUrl = target;
    });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      currentUrl: () => currentUrl,
      replaceUrl,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const options = await mountUnpairedPairForm(deps);
    options.onTakeoverStarted?.();

    expect(pairTabs.notifyPairTakeoverStarted).toHaveBeenCalledOnce();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/#chat/session/chat_1',
    );

    pairTabs.emit('pair_takeover_started');
    expect(
      pairHandles()[0]?.showSiblingTakeoverStarted,
    ).toHaveBeenCalledOnce();
    expect(
      pairHandles()[0]?.showInterruptedCredentialTransition,
    ).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
  });

  it('keeps sibling retries passive when the latest takeover needs attention', async () => {
    const dom = makeFakeDocument();
    const pairTabs = makePairTabConvergence();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const options = await mountUnpairedPairForm(deps);
    options.onTakeoverNeedsAttention?.();

    expect(
      pairTabs.notifyPairTakeoverNeedsAttention,
    ).toHaveBeenCalledOnce();
    pairTabs.emit('pair_takeover_needs_attention');
    expect(
      pairHandles()[0]?.showSiblingTakeoverNeedsAttention,
    ).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
  });

  it('wires atomic recovery succession and its passive-sibling handoff', async () => {
    const dom = makeFakeDocument();
    const pairTabs = makePairTabConvergence();
    const lease = { release: vi.fn() };
    pairTabs.claimPairRecoverySuccessor.mockResolvedValueOnce(lease);
    let currentUrl =
      'https://alice.recued.cloud/webclient/?code=STALE-CODE#chat/session/chat_1';
    const replaceUrl = vi.fn((target: string) => {
      currentUrl = target;
    });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      currentUrl: () => currentUrl,
      replaceUrl,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const options = await mountUnpairedPairForm(deps);
    await expect(options.claimRecoverySuccessor?.()).resolves.toBe(lease);
    expect(pairTabs.claimPairRecoverySuccessor).toHaveBeenCalledOnce();

    options.onRecoverySuccessorChosen?.();
    expect(
      pairTabs.notifyPairRecoverySuccessorChosen,
    ).toHaveBeenCalledOnce();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/#chat/session/chat_1',
    );

    pairTabs.emit('pair_recovery_successor_chosen');
    expect(
      pairHandles()[0]?.showSiblingRecoverySuccessorChosen,
    ).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
  });

  it('retires a guided form into an accessible exact-work handoff when a sibling wins before submit', async () => {
    const dom = makeFakeDocument();
    const focus = vi.fn();
    const contentRoot = {
      tagName: 'MAIN',
      focus,
      contains: vi.fn(() => false),
      hasAttribute: vi.fn(() => true),
      setAttribute: vi.fn(),
    } as unknown as HTMLElement;
    vi.mocked(dom.root.querySelector).mockReturnValue(contentRoot);
    const localStore = buildUnpairedStore();
    const pairTabs = makePairTabConvergence();
    const replacement = makeWebclientHandle();
    let releaseReplacement = (): void => undefined;
    const replacementGate = new Promise<WebclientHandle>((resolve) => {
      releaseReplacement = () => resolve(replacement);
    });
    const replaceHash = vi.fn();
    const recovery = {
      returnHash: '#chat/session/chat_1',
      chatDraft: {
        text: 'Keep this tab-specific draft.',
        protected: true,
        modelSourceId: null,
      },
    } as const;
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      reauthRecovery: recovery,
      replaceHash,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockReturnValueOnce(replacementGate);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'pair-form',
    });
    await populateCompletePair(localStore);
    pairTabs.emit();
    await vi.waitFor(() => {
      expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(2);
    });

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledOnce();
    expect(dom.getMessageText()).toBe(
      'Another tab finished reconnecting — returning to your unsent Chat draft…',
    );
    expect(dom.message?.getAttribute('role')).toBe('status');
    expect(dom.message?.getAttribute('aria-live')).toBe('polite');
    expect(dom.message?.getAttribute('aria-atomic')).toBe('true');
    expect(dom.message?.getAttribute('tabindex')).toBe('-1');
    expect(dom.message?.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(pairTabs.notifyPairComplete).not.toHaveBeenCalled();

    releaseReplacement();
    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });

    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      reauthRecovery: {
        ...recovery,
        pairCompletedInAnotherTab: true,
      },
      suppressInitialConnectedReceipt: true,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(dom.message?.getAttribute('role')).toBeNull();
    expect(dom.message?.getAttribute('aria-live')).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('keeps a queued guided-repair loser silent after preflight sees the sibling pair', async () => {
    const dom = makeFakeDocument();
    const localStore = buildUnpairedStore();
    const replacement = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      reauthRecovery: { returnHash: '#connections' },
      replaceHash: vi.fn(),
      pairTabConvergenceFactory: null,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'pair-form',
    });
    expect(mountOptions()[0]?.siblingTakeoverSignalsAvailable).toBe(false);
    await populateCompletePair(localStore);
    const recoveryForm = mountOptions()[0]!;
    await expect(recoveryForm.preflightCheck?.()).resolves.toEqual({
      alreadyPaired: true,
    });
    await recoveryForm.onAfterPair?.();

    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      reauthRecovery: {
        returnHash: '#connections',
        pairCompletedInAnotherTab: true,
      },
      suppressInitialConnectedReceipt: true,
    });
    expect(dom.getMessageText()).toBe(
      'Another tab finished reconnecting — returning to your page…',
    );
  });

  it('closes the missed-broadcast race by reconciling immediately after subscribing', async () => {
    const dom = makeFakeDocument();
    const pairTabs = makePairTabConvergence();
    const replacement = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildPairedStore()),
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('stale unpaired read'))
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'pair-form',
    });
    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });

    expect(pairTabs.notifyPairComplete).not.toHaveBeenCalled();
    expect(pairTabs.close).toHaveBeenCalledOnce();
    expect(pairHandles()[0]?.dispose).toHaveBeenCalledOnce();
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
  });

  it('keeps the pair form usable when the optional sibling listener fails', async () => {
    const dom = makeFakeDocument();
    const close = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      pairTabConvergenceFactory: () => ({
        supportsImmediateSignals: true,
        supportsRecoverySuccessorElection: false,
        notifyPairComplete: vi.fn(),
        notifyCredentialStateChanged: vi.fn(),
        notifyActiveServerProfileChanged: vi.fn(),
        notifyPairTransitionStarted: vi.fn(),
        notifyPairTakeoverStarted: vi.fn(),
        notifyPairTakeoverNeedsAttention: vi.fn(),
        notifyPairRecoverySuccessorChosen: vi.fn(),
        claimPairRecoverySuccessor: vi.fn(async () => null),
        subscribe: () => {
          throw new Error('BroadcastChannel listener rejected');
        },
        close,
      }),
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'pair-form',
    });

    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    expect(pairHandles()[0]?.dispose).not.toHaveBeenCalled();
    expect(
      pairHandles()[0]?.disableSiblingTakeoverCoordination,
    ).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'webclient: pair-tab listener unavailable',
      expect.any(Error),
    );
  });

  it('threads currentInstanceId from pair_metadata.instance_id into bootstrapWebclient (D-151 Devices "This device")', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore({
      pair_metadata: {
        paired_at: 1_700_000_000,
        server_passport_fingerprint: 'fp',
        server_handle_at_pair: 'alice',
        instance_id: 'wc-instance-42',
      },
    });
    const deps = makeDeps(dom, localStore);
    mockState.bootstrapWebclient.mockResolvedValueOnce(makeWebclientHandle());

    await runBootstrapWithPairFallback(deps);

    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
    expect(mockState.bootstrapWebclient.mock.calls[0][0]).toMatchObject({
      currentInstanceId: 'wc-instance-42',
    });
  });

  it('omits currentInstanceId when pair_metadata carries no instance_id (pre-D-151 pair state)', async () => {
    const dom = makeFakeDocument();
    // buildPairedStore's default pair_metadata has no instance_id.
    const deps = makeDeps(dom);
    mockState.bootstrapWebclient.mockResolvedValueOnce(makeWebclientHandle());

    await runBootstrapWithPairFallback(deps);

    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
    expect(
      mockState.bootstrapWebclient.mock.calls[0][0].currentInstanceId,
    ).toBeUndefined();
  });

  it('passes enableDevicesPage:true into bootstrapWebclient (D-156 — Devices page live in prod boot)', async () => {
    const dom = makeFakeDocument();
    const deps = makeDeps(dom);
    mockState.bootstrapWebclient.mockResolvedValueOnce(makeWebclientHandle());

    await runBootstrapWithPairFallback(deps);

    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
    expect(mockState.bootstrapWebclient.mock.calls[0][0]).toMatchObject({
      enableDevicesPage: true,
    });
  });

  it('forwards a UA-derived displayName into mountPairCodeInputHost (D-156 — device label not "unknown device")', async () => {
    // Stub a known UA so the assertion proves the wiring forwards the
    // *derived* label, not just a constant fallback (Codex LOW fold).
    const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      'navigator',
    );
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'MacIntel',
      },
    });
    try {
      const dom = makeFakeDocument();
      const deps = makeDeps(dom, buildUnpairedStore());
      mockState.bootstrapWebclient.mockRejectedValueOnce(
        new WebclientUnpairedError('webclient_token missing'),
      );

      const outcome = await runBootstrapWithPairFallback(deps);

      expect(outcome).toEqual({ kind: 'pair-form' });
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
      expect(mountOptions()[0]?.displayName).toBe('Chrome on macOS');
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        Reflect.deleteProperty(globalThis as object, 'navigator');
      }
    }
  });

  it('returns pair-form and mounts the pair-code host when bootstrapWebclient throws WebclientUnpairedError', async () => {
    const dom = makeFakeDocument();
    const deps = makeDeps(dom, buildUnpairedStore());
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('webclient_token missing'),
    );

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'pair-form' });
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    expect(mountOptions()[0]?.onAfterPair).toEqual(expect.any(Function));
    expect(mountOptions()[0]?.onPaired).toEqual(expect.any(Function));
    expect(mountOptions()[0]?.preflightCheck).toEqual(expect.any(Function));
    expect(mountOptions()[0]).toHaveProperty('lockProvider');
    expect(mountOptions()[0]?.siblingTakeoverSignalsAvailable).toBe(false);
  });

  it('keeps only a constant recovery marker until the restored reconnect mounts', async () => {
    const dom = makeFakeDocument();
    const values = new Map<string, string>();
    const recoveryReentryStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        recoveryReentry: true,
      },
      recoveryReentryStorage,
    };
    const handle = makeWebclientHandle();
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(
        new WebclientUnpairedError('webclient_token missing'),
      )
      .mockResolvedValueOnce(handle);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'pair-form',
    });

    expect([...values.values()]).toEqual(['1']);
    expect([...values.keys()]).toEqual([
      'recued.webclient.recovery-reentry.v1',
    ]);
    expect(mountOptions()[0]?.reauthRecovery).toEqual({
      chatDraftPreserved: false,
      recoveryReentry: true,
    });

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'mounted',
    });
    expect(values.size).toBe(0);
    expect(deps.handleRef.current).toBe(handle);
  });

  it('restores a safe stop as one constant without seeding its prior server or code', async () => {
    const dom = makeFakeDocument();
    const values = new Map<string, string>();
    const priorServer =
      'wss://operator:secret@old.recued.cloud/private?token=old';
    const staleCode = 'STALE-PAIR-CODE';
    const recoveryReentryStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        recoveryReentry: true,
        safeStopReentry: true,
        serverUrl: priorServer,
      },
      deeplinkSeed: {
        serverUrl: 'https://injected.example',
        pairingCode: staleCode,
      },
      recoveryReentryStorage,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('webclient_token missing'),
    );

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'pair-form',
    });

    expect([...values.entries()]).toEqual([
      ['recued.webclient.recovery-reentry.v1', '2'],
    ]);
    expect(mountOptions()[0]?.seed).toBeUndefined();
    expect(mountOptions()[0]?.reauthRecovery).toEqual({
      chatDraftPreserved: false,
      recoveryReentry: true,
      safeStopReentry: true,
    });
    expect(mountOptions()[0]?.onRecoveryCheckpointChange).toEqual(
      expect.any(Function),
    );

    mountOptions()[0]?.onRecoveryCheckpointChange?.('unresolved');
    expect([...values.values()]).toEqual(['1']);
    mountOptions()[0]?.onRecoveryCheckpointChange?.('safe_stop');
    expect([...values.values()]).toEqual(['2']);
    mountOptions()[0]?.onRecoveryCheckpointChange?.('replacement_server');
    expect([...values.values()]).toEqual(['3']);
    expect([...values.values()].join(' ')).not.toContain(priorServer);
    expect([...values.values()].join(' ')).not.toContain(staleCode);

    // Once the current server accepts pairing, even a rare post-pair unpaired
    // race must return to an ordinary blank reconnect rather than create a
    // second fresh key or replay the replacement review.
    mountOptions()[0]?.onPairAccepted?.();
    expect([...values.values()]).toEqual(['1']);
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('post-pair credentials not visible yet'),
    );
    await mountOptions()[0]?.onAfterPair?.();
    expect(mountOptions()).toHaveLength(2);
    expect(mountOptions()[1]?.reauthRecovery).toEqual({
      chatDraftPreserved: false,
      recoveryReentry: true,
    });
    expect([...values.values()]).toEqual(['1']);
  });

  it('keeps recovery armed when app startup fails before a form can mount', async () => {
    const dom = makeFakeDocument();
    const values = new Map<string, string>();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        recoveryReentry: true,
      },
      recoveryReentryStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      },
    };
    const failure = new Error('startup stopped before pairing mounted');
    mockState.bootstrapWebclient.mockRejectedValueOnce(failure);

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: failure,
    });

    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect([...values.entries()]).toEqual([
      ['recued.webclient.recovery-reentry.v1', '1'],
    ]);
  });

  it('reuses a rescued device identity during local-only credential repair', async () => {
    const dom = makeFakeDocument();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        reason: 'local_credentials_incomplete',
        instanceId: 'browser-rescued',
      },
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('webclient_token missing'),
    );

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'pair-form' });
    expect(mountOptions()[0]?.instanceId).toBe('browser-rescued');
  });

  it('returns the failure and mounts non-destructive cold-start triage', async () => {
    const dom = makeFakeDocument();
    const deps = makeDeps(dom);
    const failure = new Error('boom');
    mockState.bootstrapWebclient.mockRejectedValueOnce(failure);

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'failed', error: failure });
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(dom.getMessageHtml()).toContain(STARTUP_FAILURE_TRIAGE_ATTR);
    expect(dom.getMessageHtml()).toContain('Startup needs attention');
    expect(dom.getMessageHtml()).toContain(
      'Your saved access is still here.',
    );
    expect(dom.getMessageHtml()).not.toContain('boom');
  });

  it('scrubs a consumed pair entry before cold-start recovery can reload it', async () => {
    const dom = makeFakeDocument();
    const replaceUrl = vi.fn();
    const triage = makeStartupFailureTriage();
    const failure = new Error('startup stopped');
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      deeplinkSeed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
        pairingCode: 'PAIR5678',
      },
      currentUrl: () =>
        'https://alice.recued.cloud/webclient/?keep=a%20b&code=PAIR5678&recued_pair_resume=same-origin#chat/session/chat_1',
      replaceUrl,
      startupFailureTriageFactory: triage.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new WebclientUnpairedError('access disappeared'));

    await expect(runBootstrapWithPairFallback(deps)).resolves.toEqual({
      kind: 'failed',
      error: failure,
    });

    expect(replaceUrl).toHaveBeenCalledOnce();
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );

    await triage.options()?.onRetry();

    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    expect(mountOptions()[0]?.seed).toEqual({
      serverUrl: 'https://alice.recued.cloud:8443',
      sameOriginResume: true,
    });
    expect(mountOptions()[0]?.seed).not.toHaveProperty('pairingCode');
    expect(triage.detach).toHaveBeenCalledOnce();
  });

  it('confirms a successful cold-start retry without replaying an old receipt', async () => {
    const dom = makeFakeDocument();
    const triage = makeStartupFailureTriage();
    const diagnosticWriter = vi.fn(async (_summary: string) => undefined);
    const diagnosticNow = () => new Date('2026-07-27T21:00:00.000Z');
    const replacement = makeWebclientHandle();
    const initialFailure = Object.assign(new Error('raw server detail'), {
      code: 'server_offline',
    });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      startupFailureTriageFactory: triage.factory,
      startupOnlineStatus: () => true,
      startupDiagnosticWriter: diagnosticWriter,
      startupDiagnosticNow: diagnosticNow,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(initialFailure)
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'failed',
      error: initialFailure,
    });
    expect(triage.options()).toMatchObject({
      initialFailure,
      savedAccessVerified: true,
      draftPreserved: false,
      repeated: false,
      diagnosticServerUrl: 'wss://alice.recued.cloud:8443/ws',
      diagnosticWriter,
      diagnosticNow,
    });

    await triage.options()?.onRetry();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(triage.dispose).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('arms reload continuity only after the explicit startup reload action', async () => {
    const dom = makeFakeDocument();
    const triage = makeStartupFailureTriage();
    const reload = vi.fn();
    const stored = new Map<string, string>();
    const startupReloadRecoveryStorage: StartupReloadRecoveryStorage = {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => {
        stored.delete(key);
      },
    };
    const initialFailure = new Error('private raw startup detail');
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      startupFailureTriageFactory: triage.factory,
      startupReload: reload,
      startupReloadRecoveryStorage,
    };
    mockState.bootstrapWebclient.mockRejectedValueOnce(initialFailure);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'failed',
      error: initialFailure,
    });
    expect(stored.size).toBe(0);
    expect(reload).not.toHaveBeenCalled();

    triage.options()?.onReload?.();

    expect(reload).toHaveBeenCalledOnce();
    expect([...stored.entries()]).toEqual([
      [STARTUP_RELOAD_RECOVERY_SESSION_KEY, '1'],
    ]);
    expect([...stored.values()].join(' ')).not.toContain(
      'private raw startup detail',
    );
  });

  it('turns one failed full-page recovery into repeated triage without replaying it', async () => {
    const dom = makeFakeDocument();
    const triage = makeStartupFailureTriage();
    const reloadFailure = Object.assign(
      new Error('private reload failure'),
      { code: 'server_offline' },
    );
    const ordinaryFailure = new Error('later ordinary failure');
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      startupFailureTriageFactory: triage.factory,
      startupOnlineStatus: () => true,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(reloadFailure)
      .mockRejectedValueOnce(ordinaryFailure);
    queueStartupRecoveryForNextAttempt(deps, 'reload');

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'failed',
      error: reloadFailure,
    });
    expect(triage.options()).toMatchObject({
      initialFailure: reloadFailure,
      savedAccessVerified: true,
      repeated: true,
      reloadAttempted: true,
    });
    expect(mockState.bootstrapWebclient.mock.calls[0]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
    });
    expect(deps.handleRef.current).toBeNull();

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'failed',
      error: ordinaryFailure,
    });
    expect(triage.options()).toMatchObject({
      initialFailure: ordinaryFailure,
      repeated: false,
      reloadAttempted: false,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
  });
});

describe('D-169 P1.5 NEXT-#1 onAfterPair teardown timing', () => {
  it('scrubs consumed pair inputs and hands a one-shot success receipt to the mounted return page', async () => {
    const dom = makeFakeDocument();
    const replaceUrl = vi.fn();
    const pairTabs = makePairTabConvergence();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      deeplinkSeed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
        pairingCode: 'PAIR5678',
      },
      currentUrl: () =>
        'https://alice.recued.cloud:8443/webclient/?chat=session&code=PAIR%205678&recued_pair_resume=same-origin#chat/session/chat_1',
      replaceUrl,
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(makeWebclientHandle());
    const options = await mountUnpairedPairForm(deps);

    expect(replaceUrl).not.toHaveBeenCalled();
    await options.onAfterPair?.();

    expect(replaceUrl).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud:8443/webclient/?chat=session#chat/session/chat_1',
    );
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: PAIR_SUCCESS_RETURN_RECEIPT_COPY,
    });
    expect(pairTabs.notifyPairComplete).toHaveBeenCalledOnce();
    expect(pairTabs.close).toHaveBeenCalledOnce();
  });

  it('confirms a fresh replacement only after its passport identity is durable', async () => {
    const dom = makeFakeDocument();
    const localStore = createInMemoryWebclientLocalStore();
    const ensureProfile = vi.spyOn(localStore, 'ensureProfile');
    const setField = vi.spyOn(localStore, 'set');
    const tokenStore: WebclientTokenStore = {
      async wrap({ token_id }) {
        return { ...sampleToken(), token_id };
      },
      async unwrap() {
        return 'unused-bearer';
      },
    };
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      profileStore: localStore,
      tokenStore,
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        recoveryReentry: true,
        replacementServerReentry: true,
      },
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(makeWebclientHandle());
    const options = await mountUnpairedPairForm(deps);

    options.onPairAccepted?.();
    await options.onPaired({
      serverUrl: 'https://replacement.recued.cloud:9443',
      token: 'replacement-bearer',
      token_id: 'tok-replacement',
      passport: {
        identity: {
          server_public_key: 'spki-replacement-verified',
          current_handle: 'harbor',
        },
        network: {},
      },
      recoveryKey: `${Array(23).fill('abandon').join(' ')} art`,
      recoveryContext: 'fresh_replacement',
    });
    await options.onAfterPair?.();

    expect(await localStore.inspect()).toMatchObject({
      server_url: 'wss://replacement.recued.cloud:9443/ws',
      server_public_key: 'spki-replacement-verified',
      webclient_token: { token_id: 'tok-replacement' },
      pair_metadata: {
        server_passport_fingerprint: 'spki-replacement-verified',
        server_handle_at_pair: 'harbor',
      },
    });
    expect(ensureProfile).toHaveBeenCalledWith(
      'wss://replacement.recued.cloud:9443/ws',
    );
    expect(setField.mock.calls.some(([key]) => key === 'server_url')).toBe(false);
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: REPLACEMENT_SERVER_RETURN_RECEIPT_COPY,
    });
  });

  it('does not call an administrator-confirmed restored setup a fresh pairing', async () => {
    const dom = makeFakeDocument();
    const localStore = buildUnpairedStore();
    const tokenStore: WebclientTokenStore = {
      async wrap({ token_id }) {
        return { ...sampleToken(), token_id };
      },
      async unwrap() {
        return 'unused-bearer';
      },
    };
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      tokenStore,
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        recoveryReentry: true,
        replacementServerReentry: true,
      },
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(makeWebclientHandle());
    const options = await mountUnpairedPairForm(deps);

    options.onPairAccepted?.();
    await options.onPaired({
      serverUrl: 'https://restored.recued.cloud:9443',
      token: 'restored-bearer',
      token_id: 'tok-restored',
      passport: {
        identity: {
          server_public_key: 'spki-restored-verified',
          current_handle: 'harbor',
        },
        network: {},
      },
      recoveryKey: `${Array(23).fill('abandon').join(' ')} art`,
    });
    await options.onAfterPair?.();

    expect(await localStore.inspect()).toMatchObject({
      server_url: 'wss://restored.recued.cloud:9443/ws',
      server_public_key: 'spki-restored-verified',
      pair_metadata: {
        server_passport_fingerprint: 'spki-restored-verified',
      },
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
  });

  it('uses history replacement in production without discarding existing history state', async () => {
    const dom = makeFakeDocument();
    const historyState = { shell: 'chat-session' };
    const replaceState = vi.fn();
    Object.assign(dom.document, {
      defaultView: {
        location: {
          href: 'https://alice.example/webclient/?code=PAIR5678&keep=a%20b#connections',
        },
        history: { state: historyState, replaceState },
      } as unknown as Window,
    });
    const deps = makeDeps(dom, buildUnpairedStore());
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockResolvedValueOnce(makeWebclientHandle());
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(
      historyState,
      '',
      'https://alice.example/webclient/?keep=a%20b#connections',
    );
  });

  it('disposes the old form, writes transitional copy, re-enters bootstrap, then removes the splash after a mounted re-entry', async () => {
    const events: string[] = [];
    const dom = makeFakeDocument({ events });
    const deps = makeDeps(dom, buildUnpairedStore());
    const handle = makeWebclientHandle();
    nextPairHandleFactory = () => makeMountedPairHandle(events);
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockImplementationOnce(async () => {
        events.push('bootstrap:second:start');
        await Promise.resolve();
        events.push('bootstrap:second:resolve');
        return handle;
      });
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(deps.handleRef.current).toBe(handle);
    expect(dom.removeWrapperChild).toHaveBeenCalledTimes(1);
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
    expect(events).toEqual([
      'codeHandle.dispose',
      `splash:${STARTING_COPY}`,
      'splash:focus',
      'bootstrap:second:start',
      'bootstrap:second:resolve',
      `removeChild:${SPLASH_WRAPPER_ID}`,
    ]);
  });

  it('keeps the splash wrapper and offers startup-only recovery when re-entry bootstrap fails', async () => {
    const events: string[] = [];
    const dom = makeFakeDocument({ events });
    const deps = makeDeps(dom, buildUnpairedStore());
    nextPairHandleFactory = () => makeMountedPairHandle(events);
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new Error('boom'));
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(dom.removeWrapperChild).not.toHaveBeenCalled();
    expect(dom.getMessageHtml()).toContain(POST_PAIR_STARTUP_RECOVERY_ATTR);
    expect(dom.getMessageHtml()).toContain('Secure access saved');
    expect(dom.getMessageHtml()).toContain(
      'You do not need to pair this browser again.',
    );
  });

  it('replaces a failed first-pair receipt with one startup recovery confirmation', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const replacement = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      postPairStartupRecoveryFactory: recovery.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new Error('first app startup failed'))
      .mockResolvedValueOnce(replacement);
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(recovery.factory).toHaveBeenCalledOnce();
    expect(recovery.options()).toMatchObject({
      reconnect: false,
      draftPreserved: false,
      completedInAnotherTab: false,
    });
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();

    await recovery.options()?.onRetry();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(3);
    expect(mockState.bootstrapWebclient.mock.calls[2]?.[0]).toMatchObject({
      initialConnectedReceiptCopy: STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[2]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(
      mockState.bootstrapWebclient.mock.calls[2]?.[0]
        .initialConnectedReceiptCopy,
    ).not.toBe(PAIR_SUCCESS_RETURN_RECEIPT_COPY);
    expect(recovery.dispose).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('upgrades a repeated reconnect startup failure to cause-aware triage', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const triage = makeStartupFailureTriage();
    const localStore = buildUnpairedStore();
    const replacement = makeWebclientHandle();
    const release = vi.fn();
    const repeatedFailure = Object.assign(new Error('raw server detail'), {
      code: 'server_offline',
    });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        serverUrl: 'wss://previous.recued.cloud:8443/ws',
        chatDraft: {
          text: 'Keep this unsent draft.',
          protected: true,
          modelSourceId: null,
        },
        draftGuard: {
          release,
          isActive: () => true,
        },
      },
      postPairStartupRecoveryFactory: recovery.factory,
      startupFailureTriageFactory: triage.factory,
      startupOnlineStatus: () => true,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new Error('first return startup failed'))
      .mockRejectedValueOnce(repeatedFailure)
      .mockResolvedValueOnce(replacement);
    const options = await mountUnpairedPairForm(deps);
    await populateCompletePair(localStore);

    await options.onAfterPair?.();
    await recovery.options()?.onRetry();

    expect(recovery.detach).toHaveBeenCalledOnce();
    expect(triage.options()).toMatchObject({
      initialFailure: repeatedFailure,
      savedAccessVerified: true,
      draftPreserved: true,
      repeated: true,
      diagnosticServerUrl: 'wss://alice.recued.cloud:8443/ws',
    });
    expect(release).not.toHaveBeenCalled();

    await triage.options()?.onRetry();

    expect(deps.handleRef.current).toBe(replacement);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(4);
    expect(mockState.bootstrapWebclient.mock.calls[3]?.[0]).toMatchObject({
      initialConnectedReceiptCopy:
        STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[3]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(triage.dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);
  });

  it('holds the exact reconnect work through a failed startup and its retry', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const replacement = makeWebclientHandle();
    const release = vi.fn();
    const replaceHash = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        chatDraft: {
          text: 'Keep this unsent draft.',
          protected: true,
          modelSourceId: null,
        },
        draftGuard: {
          release,
          isActive: () => true,
        },
      },
      replaceHash,
      postPairStartupRecoveryFactory: recovery.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new Error('return startup failed'))
      .mockResolvedValueOnce(replacement);
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(recovery.options()).toMatchObject({
      reconnect: true,
      draftPreserved: true,
      completedInAnotherTab: false,
    });
    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(release).not.toHaveBeenCalled();

    await recovery.options()?.onRetry();

    expect(replaceHash).toHaveBeenCalledTimes(2);
    expect(mockState.bootstrapWebclient.mock.calls[2]?.[0]).toMatchObject({
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        chatDraft: { text: 'Keep this unsent draft.' },
      },
      initialConnectedReceiptCopy:
        STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[2]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it('hands off to one fresh pair form if saved access disappears before retry', async () => {
    const dom = makeFakeDocument();
    const recovery = makePostPairStartupRecovery();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      postPairStartupRecoveryFactory: recovery.factory,
    };
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new Error('first app startup failed'))
      .mockRejectedValueOnce(
        new WebclientUnpairedError('saved access disappeared'),
      );
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();
    await recovery.options()?.onRetry();

    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(2);
    expect(recovery.detach).toHaveBeenCalledOnce();
    expect(recovery.dispose).not.toHaveBeenCalled();
    expect(dom.removeWrapperChild).not.toHaveBeenCalled();
  });

  it('keeps the splash wrapper and mounts a fresh pair form when re-entry is still unpaired', async () => {
    const events: string[] = [];
    const dom = makeFakeDocument({ events });
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildUnpairedStore()),
      deeplinkSeed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
        pairingCode: 'PAIR5678',
      },
    };
    nextPairHandleFactory = () => makeMountedPairHandle(events);
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new WebclientUnpairedError('still unpaired'));
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(2);
    expect(mountOptions()[0]?.seed).toMatchObject({
      pairingCode: 'PAIR5678',
    });
    expect(mountOptions()[1]?.seed).toEqual({
      serverUrl: 'https://alice.recued.cloud:8443',
      sameOriginResume: true,
    });
    expect(dom.removeWrapperChild).not.toHaveBeenCalled();
  });
});

describe('D-169 P1.5 NEXT-#1 ensureBootSplashSlot resilience', () => {
  it('uses the existing splash message element without recreating the splash when it is present', async () => {
    const dom = makeFakeDocument({ messagePresent: true, wrapperPresent: true });
    const deps = makeDeps(dom, buildUnpairedStore());
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'pair-form' });
    expect(dom.createElement).not.toHaveBeenCalled();
    expect(mountOptions()[0]?.splashElement).toBe(dom.message);
  });

  it('recreates the splash slot under root and passes the recreated message element when the splash is absent', async () => {
    const dom = makeFakeDocument({ messagePresent: false, wrapperPresent: false });
    const deps = makeDeps(dom, buildUnpairedStore());
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('initially unpaired'),
    );

    const outcome = await runBootstrapWithPairFallback(deps);

    const recreatedWrapper = dom.appendedRoots[0];
    const recreatedMessage = dom.createdElements.find(
      (el) => el.id === SPLASH_MESSAGE_ID,
    );
    expect(outcome).toEqual({ kind: 'pair-form' });
    expect(dom.createElement).toHaveBeenCalled();
    expect(dom.rootAppendChild).toHaveBeenCalledTimes(1);
    expect(recreatedWrapper?.id).toBe(SPLASH_WRAPPER_ID);
    expect(mountOptions()[0]?.splashElement).toBe(recreatedMessage);
  });
});

describe('D-169 P1.5 NEXT-#1 splash helpers', () => {
  it('removeBootSplashWrapper removes the wrapper through parentNode.removeChild and is null-safe', () => {
    const dom = makeFakeDocument({ wrapperPresent: true });

    removeBootSplashWrapper(dom.document);

    expect(dom.removeWrapperChild).toHaveBeenCalledTimes(1);
    expect(dom.removeWrapperChild).toHaveBeenCalledWith(dom.wrapper);

    const absentDoc = {
      getElementById: vi.fn(() => null),
    } as unknown as Document;
    expect(() => removeBootSplashWrapper(absentDoc)).not.toThrow();
    expect(absentDoc.getElementById).toHaveBeenCalledWith(SPLASH_WRAPPER_ID);
  });

  it('setSplashMessage sets message textContent and is null-safe', () => {
    const dom = makeFakeDocument({ messagePresent: true });

    setSplashMessage('Starting test copy', dom.document);

    expect(dom.getMessageText()).toBe('Starting test copy');
    expect(dom.messageTextWrites()).toEqual(['Starting test copy']);

    const absentDoc = {
      getElementById: vi.fn(() => null),
    } as unknown as Document;
    expect(() => setSplashMessage('No element', absentDoc)).not.toThrow();
    expect(absentDoc.getElementById).toHaveBeenCalledWith(SPLASH_MESSAGE_ID);
  });
});

describe('D-169 P1.5 NEXT-#1 reauth recovery error surfacing (finding #2b)', () => {
  it('surfaces a failed reauth recovery via splash copy instead of leaking an unhandled rejection', async () => {
    const dom = makeFakeDocument();
    const pairTabs = makePairTabConvergence();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      pairTabConvergenceFactory: () => pairTabs.convergence,
    };
    const handle = makeWebclientHandle();
    // First boot mounts (capturing onReauthRequired); the recovery
    // re-entry then hits the unpaired branch, where we force the
    // pair-form mount to throw so `runBootstrapWithPairFallback`
    // rejects → `recoverFromReauthRequired` rejects → the wiring's
    // `.catch` must surface copy rather than leak the rejection.
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(handle)
      .mockRejectedValueOnce(new WebclientUnpairedError('identity rotated'));
    nextPairHandleFactory = () => {
      throw new Error('pair-form mount blew up');
    };

    const firstOutcome = await runBootstrapWithPairFallback(deps);
    expect(firstOutcome).toEqual({ kind: 'mounted' });

    const firstCallOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onReauthRequired?: () => void }
      | undefined;
    expect(firstCallOptions?.onReauthRequired).toEqual(expect.any(Function));

    // Fire-and-forget like the bootstrap does — must NOT throw synchronously.
    expect(() => firstCallOptions?.onReauthRequired?.()).not.toThrow();
    // Flush the async recovery chain (dispose → wipe keys → re-enter → reject → catch).
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.getMessageText()).toBe(REAUTH_RECOVERY_FAILED_COPY);
    expect(consoleErrorSpy).toHaveBeenCalled();
    // Recovery nulls the handle ref before re-entering; the failed
    // re-entry never installs a replacement.
    expect(deps.handleRef.current).toBeNull();
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(pairTabs.close).toHaveBeenCalledOnce();
  });
});

describe('guided reauthorization return-to-work journey', () => {
  it('converts the trusted websocket endpoint into the pair form origin', () => {
    expect(
      pairFormServerUrlFromStored('wss://alice.recued.cloud:8443/ws'),
    ).toBe('https://alice.recued.cloud:8443');
    expect(pairFormServerUrlFromStored('ws://127.0.0.1:3001/ws')).toBe(
      'http://127.0.0.1:3001',
    );
    expect(pairFormServerUrlFromStored('https://already.example')).toBe(
      'https://already.example',
    );
  });

  it('defers an initial-handshake reauth signal until the rejected handle can be disposed', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const deps = makeDeps(dom, localStore);
    const rejectedHandle = makeWebclientHandle();
    mockState.bootstrapWebclient
      .mockImplementationOnce(async (options: unknown) => {
        (options as { onReauthRequired?: () => void }).onReauthRequired?.();
        return rejectedHandle;
      })
      .mockRejectedValueOnce(new WebclientUnpairedError('bearer rejected'));

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'pair-form' });
    expect(rejectedHandle.dispose).toHaveBeenCalledTimes(1);
    expect(deps.handleRef.current).toBeNull();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(2);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    expect(await localStore.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
  });

  it('turns a sibling credential clear into one guided recovery with exact work context', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const mountedTabs = makePairTabConvergence();
    const recovery = {
      returnHash: '#chat/session/chat_1',
      chatDraft: {
        text: 'Keep the incident follow-up draft in this tab.',
        protected: true,
        modelSourceId: null,
      },
    } as const;
    const original = makeWebclientHandle(recovery);
    const credentialFactory = vi
      .fn<() => PairTabConvergence | null>()
      .mockReturnValueOnce(mountedTabs.convergence)
      .mockReturnValue(null);
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      currentHash: () => '#connections',
      credentialTabConvergenceFactory: credentialFactory,
      pairTabConvergenceFactory: null,
    };
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new WebclientUnpairedError('credentials cleared'));

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await localStore.clear();
    mountedTabs.emit();

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    });
    expect(original.captureRecoverySnapshot).toHaveBeenCalledTimes(1);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(deps.handleRef.current).toBeNull();
    expect(mountedTabs.close).toHaveBeenCalledOnce();
    expect(mountedTabs.listenerCount()).toBe(0);
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      reauthRecovery: {
        ...recovery,
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
        reason: 'credentials_changed_elsewhere',
      },
    });
    expect(mountOptions()[0]).toMatchObject({
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: {
        chatDraftPreserved: true,
        reason: 'credentials_changed_elsewhere',
      },
    });
  });

  it('adopts a sibling credential generation at the exact route without replaying its receipt', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const mountedTabs = makePairTabConvergence();
    const recovery = {
      returnHash: '#chat/session/chat_1',
      chatDraft: {
        text: 'Keep this tab draft through the sibling re-pair.',
        protected: true,
        modelSourceId: null,
      },
    } as const;
    const original = makeWebclientHandle(recovery);
    const replacement = makeWebclientHandle();
    const replaceHash = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      replaceHash,
      credentialTabConvergenceFactory: vi
        .fn<() => PairTabConvergence | null>()
        .mockReturnValueOnce(mountedTabs.convergence)
        .mockReturnValue(null),
    };
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await populateCompletePair(localStore);
    mountedTabs.emit();

    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(mountedTabs.close).toHaveBeenCalledOnce();
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      reauthRecovery: {
        ...recovery,
        pairCompletedInAnotherTab: true,
      },
      suppressInitialConnectedReceipt: true,
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[1]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
  });

  it('broadcasts an intentional Privacy clear but leaves its explicit result receipt in place', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      credentialTabConvergenceFactory: () => mountedTabs.convergence,
    };
    mockState.bootstrapWebclient.mockResolvedValueOnce(original);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    // Let the initial subscribe-race reconciliation establish its baseline.
    await Promise.resolve();
    await Promise.resolve();
    await localStore.clear();
    const firstCallOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onPrivacyCredentialsCleared?: () => void }
      | undefined;
    firstCallOptions?.onPrivacyCredentialsCleared?.();
    mountedTabs.emit();
    await Promise.resolve();

    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(mountedTabs.close).toHaveBeenCalledOnce();
    expect(mountedTabs.listenerCount()).toBe(0);
    expect(original.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
  });

  it('broadcasts a durable Account profile change and refreshes a sibling roster', async () => {
    const dom = makeFakeDocument();
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildPairedStore()),
      credentialTabConvergenceFactory: () => mountedTabs.convergence,
    };
    mockState.bootstrapWebclient.mockResolvedValueOnce(original);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    const firstCallOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onServerProfilesChanged?: () => void }
      | undefined;

    firstCallOptions?.onServerProfilesChanged?.();
    mountedTabs.emit('credential_state_changed');
    await Promise.resolve();

    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(original.refreshServerProfiles).toHaveBeenCalledOnce();
    // The action's bootstrap owns the subsequent active-profile reload. Keep
    // this channel alive until shell disposal so the signal is not lost.
    expect(mountedTabs.close).not.toHaveBeenCalled();
    expect(original.dispose).not.toHaveBeenCalled();
  });

  it('routes a sibling active-profile change to safe shell convergence, not credential recovery', async () => {
    const dom = makeFakeDocument();
    const profiles = await buildMultiProfileStore();
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle(
      {
        returnHash: '#chat/session/source-chat',
        chatDraft: {
          text: 'source-only draft',
          protected: true,
          modelSourceId: null,
        },
      },
      profiles.sourceId,
    );
    const requestConvergence = vi.mocked(
      original.requestServerProfileConvergence,
    );
    let firstOptions:
      | { onActiveServerProfileChanged?: () => void }
      | undefined;
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, profiles.store),
      profileStore: profiles.store,
      credentialTabConvergenceFactory: () => mountedTabs.convergence,
    };
    mockState.bootstrapWebclient.mockImplementationOnce(async (options) => {
      firstOptions = options as typeof firstOptions;
      return original;
    });

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await vi.waitFor(() => {
      expect(requestConvergence).toHaveBeenCalledWith(profiles.sourceId);
    });
    requestConvergence.mockClear();

    await profiles.store.switchProfile(profiles.targetId);
    firstOptions?.onActiveServerProfileChanged?.();
    expect(mountedTabs.notifyActiveServerProfileChanged).toHaveBeenCalledOnce();
    mountedTabs.emit('active_server_profile_changed');

    // The detail-free hint pauses the shell synchronously, before either the
    // shell or pair host has completed its durable target read.
    expect(requestConvergence).toHaveBeenCalledWith();

    await vi.waitFor(() => {
      expect(requestConvergence).toHaveBeenCalledWith(profiles.targetId);
    });
    expect(mountedTabs.notifyCredentialStateChanged).not.toHaveBeenCalled();
    expect(original.captureRecoverySnapshot).not.toHaveBeenCalled();
    expect(original.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledOnce();
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
  });

  it('re-checks the profile pointer when a switch lands during projected credential reads', async () => {
    const dom = makeFakeDocument();
    const profiles = await buildMultiProfileStore();
    let switchOnNextFieldRead = false;
    const racingLocalStore: WebclientLocalStore = {
      ...profiles.store,
      async get(key) {
        if (switchOnNextFieldRead) {
          switchOnNextFieldRead = false;
          await profiles.store.switchProfile(profiles.targetId);
        }
        return profiles.store.get(key);
      },
    };
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle(
      {
        returnHash: '#chat/session/source-chat',
        chatDraft: {
          text: 'never rescue this across profiles',
          protected: true,
          modelSourceId: null,
        },
      },
      profiles.sourceId,
    );
    const requestConvergence = vi.mocked(
      original.requestServerProfileConvergence,
    );
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, racingLocalStore),
      profileStore: profiles.store,
      credentialTabConvergenceFactory: () => mountedTabs.convergence,
    };
    mockState.bootstrapWebclient.mockResolvedValueOnce(original);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await vi.waitFor(() => {
      expect(requestConvergence).toHaveBeenCalledWith(profiles.sourceId);
    });
    requestConvergence.mockClear();

    switchOnNextFieldRead = true;
    mountedTabs.emit('credential_state_changed');

    await vi.waitFor(() => {
      expect(requestConvergence).toHaveBeenCalledWith(profiles.targetId);
    });
    expect(original.captureRecoverySnapshot).not.toHaveBeenCalled();
    expect(original.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledOnce();
  });

  it('does not let an in-flight reconcile replace the intentional Privacy-clear receipt', async () => {
    const dom = makeFakeDocument();
    const backingStore = buildPairedStore();
    let holdReads = false;
    let releaseReads = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const localStore: WebclientLocalStore = {
      ...backingStore,
      async get(key) {
        if (holdReads) await readGate;
        return backingStore.get(key);
      },
    };
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle();
    let firstOptions: { onPrivacyCredentialsCleared?: () => void } | undefined;
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      credentialTabConvergenceFactory: () => mountedTabs.convergence,
    };
    mockState.bootstrapWebclient.mockImplementationOnce(async (options) => {
      firstOptions = options as typeof firstOptions;
      // The immediate subscribe-race reconciliation starts after bootstrap
      // resolves, so hold exactly that read in flight.
      holdReads = true;
      return original;
    });

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await localStore.clear();
    firstOptions?.onPrivacyCredentialsCleared?.();
    releaseReads();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(mountedTabs.close).toHaveBeenCalledOnce();
    expect(original.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
  });

  it('keeps the sibling signal alive through the shell disposal that performs a rejected-session wipe', async () => {
    const dom = makeFakeDocument();
    const mountedTabs = makePairTabConvergence();
    const credentialFactory = vi
      .fn<() => PairTabConvergence | null>()
      .mockReturnValueOnce(mountedTabs.convergence)
      .mockReturnValue(null);
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, buildPairedStore()),
      credentialTabConvergenceFactory: credentialFactory,
      pairTabConvergenceFactory: null,
    };
    let firstOptions:
      | { onReauthRequired?: () => void; onSessionDispose?: () => void }
      | undefined;
    const original = makeWebclientHandle();
    vi.mocked(original.dispose).mockImplementation(async () => {
      firstOptions?.onSessionDispose?.();
    });
    mockState.bootstrapWebclient
      .mockImplementationOnce(async (options: unknown) => {
        firstOptions = options as typeof firstOptions;
        return original;
      })
      .mockRejectedValueOnce(new WebclientUnpairedError('bearer rejected'));

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    firstOptions?.onReauthRequired?.();

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    });
    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(mountedTabs.close).toHaveBeenCalledOnce();
    expect(original.dispose).toHaveBeenCalledOnce();
  });

  it('wipes a rejected bearer when only its local encrypted envelope changed', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle();
    let firstOptions: { onReauthRequired?: () => void } | undefined;
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      credentialTabConvergenceFactory: vi
        .fn<() => PairTabConvergence | null>()
        .mockReturnValueOnce(mountedTabs.convergence)
        .mockReturnValue(null),
      pairTabConvergenceFactory: null,
    };
    mockState.bootstrapWebclient
      .mockImplementationOnce(async (options) => {
        firstOptions = options as typeof firstOptions;
        return original;
      })
      .mockRejectedValueOnce(new WebclientUnpairedError('bearer rejected'));

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await localStore.set('webclient_token', {
      ...sampleToken(),
      ciphertext_b64: 'same-bearer-new-envelope',
      iv_b64: 'same-bearer-new-iv',
    });
    firstOptions?.onReauthRequired?.();

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    });
    expect(await localStore.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(original.dispose).toHaveBeenCalledOnce();
  });

  it('still fans out a fail-safe wipe when credential inspection throws', async () => {
    const dom = makeFakeDocument();
    const backingStore = buildPairedStore();
    let rejectReads = false;
    const localStore: WebclientLocalStore = {
      ...backingStore,
      async get(key) {
        if (rejectReads) throw new Error('credential read unavailable');
        return backingStore.get(key);
      },
    };
    const removeSpy = vi.spyOn(localStore, 'remove');
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle();
    let firstOptions: { onReauthRequired?: () => void } | undefined;
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      credentialTabConvergenceFactory: vi
        .fn<() => PairTabConvergence | null>()
        .mockReturnValueOnce(mountedTabs.convergence)
        .mockReturnValue(null),
      pairTabConvergenceFactory: null,
    };
    mockState.bootstrapWebclient
      .mockImplementationOnce(async (options) => {
        firstOptions = options as typeof firstOptions;
        return original;
      })
      .mockRejectedValueOnce(new WebclientUnpairedError('bearer rejected'));

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    rejectReads = true;
    firstOptions?.onReauthRequired?.();

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledOnce();
    });
    expect(removeSpy).toHaveBeenCalledTimes(5);
    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(await backingStore.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
  });

  it('does not remount for equivalent envelope bytes or this tab own token rotation', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const mountedTabs = makePairTabConvergence();
    const original = makeWebclientHandle();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      credentialTabConvergenceFactory: () => mountedTabs.convergence,
    };
    mockState.bootstrapWebclient.mockResolvedValueOnce(original);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    await Promise.resolve();
    await Promise.resolve();
    await localStore.set('webclient_token', {
      ...sampleToken(),
      ciphertext_b64: 'equivalent-sibling-envelope',
      iv_b64: 'equivalent-sibling-iv',
    });
    mountedTabs.emit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.handleRef.current).toBe(original);
    expect(original.dispose).not.toHaveBeenCalled();

    const rotated = {
      token_id: 'tok-rotated-in-this-tab',
      ciphertext_b64: 'rotated-ciphertext',
      iv_b64: 'rotated-iv',
      issued_at: 1_700_000_100,
    };
    await localStore.set('webclient_token', rotated);
    const firstOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onTokenRotated?: (record: typeof rotated) => void }
      | undefined;
    firstOptions?.onTokenRotated?.(rotated);
    mountedTabs.emit();
    await Promise.resolve();
    await Promise.resolve();

    expect(mountedTabs.notifyCredentialStateChanged).toHaveBeenCalledOnce();
    expect(deps.handleRef.current).toBe(original);
    expect(original.dispose).not.toHaveBeenCalled();
    expect(mockState.bootstrapWebclient).toHaveBeenCalledTimes(1);
  });

  it('adopts a newer pair instead of letting a delayed tab wipe it', async () => {
    const dom = makeFakeDocument();
    const localStore = buildPairedStore();
    const original = makeWebclientHandle({
      returnHash: '#chat/session/chat_1',
      chatDraft: {
        text: 'Keep this tab-specific draft.',
        protected: true,
        modelSourceId: null,
      },
    });
    const replacement = makeWebclientHandle();
    const pairLockRequest = vi.fn(
      async (_name: unknown, _options: unknown, callback: unknown) =>
        (callback as () => Promise<unknown>)(),
    );
    const replaceHash = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      pairLockProvider: {
        request: pairLockRequest,
      } as unknown as NonNullable<
        PairFallbackBootstrapDeps['pairLockProvider']
      >,
      replaceHash,
    };
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    // Another tab finishes re-pairing while this tab is backgrounded but
    // before its queued reauth callback runs.
    await localStore.set('server_public_key', 'spki-fresh');
    await localStore.set('pair_metadata', {
      paired_at: 1_700_000_001,
      server_passport_fingerprint: 'fp-fresh',
      server_handle_at_pair: 'alice',
      instance_id: 'browser-fresh',
    });
    await localStore.set('webclient_token', {
      token_id: 'tok-fresh',
      ciphertext_b64: 'ciphertext-fresh',
      iv_b64: 'iv-fresh',
      issued_at: 1_700_000_001,
    });

    const firstCallOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onReauthRequired?: () => void }
      | undefined;
    firstCallOptions?.onReauthRequired?.();

    await vi.waitFor(() => {
      expect(deps.handleRef.current).toBe(replacement);
    });
    expect(pairLockRequest).toHaveBeenCalledTimes(1);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(await localStore.inspect()).toMatchObject({
      server_url: 'wss://alice.recued.cloud:8443/ws',
      server_public_key: 'spki-fresh',
      webclient_token: {
        token_id: 'tok-fresh',
        ciphertext_b64: 'ciphertext-fresh',
      },
      pair_metadata: {
        instance_id: 'browser-fresh',
      },
    });
    expect(mockState.bootstrapWebclient.mock.calls[1]?.[0]).toMatchObject({
      currentInstanceId: 'browser-fresh',
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        chatDraft: {
          text: 'Keep this tab-specific draft.',
        },
        pairCompletedInAnotherTab: true,
      },
      suppressInitialConnectedReceipt: true,
    });
  });

  it('wipes rejected credentials but guides re-pair and returns the exact page and Chat draft', async () => {
    const dom = makeFakeDocument();
    let beforeUnloadListener: ((event: BeforeUnloadEvent) => void) | null = null;
    const recoveryView = {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === 'beforeunload') {
          beforeUnloadListener = listener as (event: BeforeUnloadEvent) => void;
        }
      }),
      removeEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === 'beforeunload' && listener === beforeUnloadListener) {
          beforeUnloadListener = null;
        }
      }),
    };
    Object.assign(dom.document, {
      defaultView: recoveryView as unknown as Window,
    });
    const localStore = buildPairedStore({
      pair_metadata: {
        paired_at: 1_700_000_000,
        server_passport_fingerprint: 'fp',
        server_handle_at_pair: 'alice',
        instance_id: 'browser-instance-42',
      },
    });
    const recovery = {
      returnHash: '#chat/session/chat_1',
      chatDraft: {
        text: 'Draft the customer follow-up before sending.',
        protected: true,
        modelSourceId: null,
      },
    } as const;
    const original = makeWebclientHandle(recovery);
    const replacement = makeWebclientHandle();
    const replaceHash = vi.fn();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom, localStore),
      currentHash: () => '#connections',
      replaceHash,
      // Model a shell originally mounted by a successful normal pair. Its
      // generic receipt must not leak into a later guided reauthorization.
      postPairReceiptCopy: PAIR_SUCCESS_RETURN_RECEIPT_COPY,
    };
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new WebclientUnpairedError('bearer rejected'))
      .mockResolvedValueOnce(replacement);

    expect(await runBootstrapWithPairFallback(deps)).toEqual({
      kind: 'mounted',
    });
    const firstCallOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onReauthRequired?: () => void }
      | undefined;
    firstCallOptions?.onReauthRequired?.();

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    });
    expect(original.captureRecoverySnapshot).toHaveBeenCalledTimes(1);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(deps.handleRef.current).toBeNull();
    expect(await localStore.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });

    const recoveryForm = mountOptions()[0]!;
    expect(recoveryForm.seed).toEqual({
      serverUrl: 'https://alice.recued.cloud:8443',
    });
    expect(recoveryForm.instanceId).toEqual(expect.any(String));
    expect(recoveryForm.instanceId).not.toBe('browser-instance-42');
    expect(recoveryForm.reauthRecovery).toEqual({
      chatDraftPreserved: true,
    });
    expect(recoveryView.addEventListener).toHaveBeenCalledWith(
      'beforeunload',
      expect.any(Function),
    );
    const beforeUnloadEvent = {
      preventDefault: vi.fn(),
      returnValue: undefined,
    } as unknown as BeforeUnloadEvent;
    const activeBeforeUnloadListener = beforeUnloadListener as
      | ((event: BeforeUnloadEvent) => void)
      | null;
    activeBeforeUnloadListener?.(beforeUnloadEvent);
    expect(beforeUnloadEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(beforeUnloadEvent.returnValue).toBe('');

    await recoveryForm.onAfterPair?.();

    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(mockState.bootstrapWebclient.mock.calls[2]?.[0]).toMatchObject({
      reauthRecovery: {
        ...recovery,
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
      },
    });
    expect(
      mockState.bootstrapWebclient.mock.calls[2]?.[0]
        .initialConnectedReceiptCopy,
    ).toBeUndefined();
    expect(
      mockState.bootstrapWebclient.mock.calls[2]?.[0]
        .suppressInitialConnectedReceipt,
    ).toBeUndefined();
    expect(deps.handleRef.current).toBe(replacement);
    expect(dom.getMessageText()).toBe(
      'Reconnected — returning to your unsent Chat draft…',
    );
    expect(recoveryView.removeEventListener).toHaveBeenCalledWith(
      'beforeunload',
      expect.any(Function),
    );
    expect(beforeUnloadListener).toBeNull();
  });

  it('still reaches guided re-pair when optional work-context capture fails', async () => {
    const dom = makeFakeDocument();
    const deps: PairFallbackBootstrapDeps = {
      ...makeDeps(dom),
      currentHash: () => '#logs/run-42',
    };
    const original = makeWebclientHandle();
    vi.mocked(original.captureRecoverySnapshot).mockImplementation(() => {
      throw new Error('route snapshot unavailable');
    });
    mockState.bootstrapWebclient
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new WebclientUnpairedError('bearer rejected'));

    await runBootstrapWithPairFallback(deps);
    const firstCallOptions = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      | { onReauthRequired?: () => void }
      | undefined;
    firstCallOptions?.onReauthRequired?.();

    await vi.waitFor(() => {
      expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(1);
    });
    expect(mountOptions()[0]?.reauthRecovery).toEqual({
      chatDraftPreserved: false,
    });
    expect(mountOptions()[0]?.seed).toEqual({
      serverUrl: 'https://alice.recued.cloud:8443',
    });
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'webclient: reauth work-context capture failed',
      expect.any(Error),
    );
  });
});

describe('M5 S3.4 restore wiring', () => {
  it('wires onRestoreSubmit; invoking it disposes the form + starts the restore flow', async () => {
    const dom = makeFakeDocument();
    const deps = makeDeps(dom, buildUnpairedStore());
    mockState.bootstrapWebclient.mockRejectedValueOnce(
      new WebclientUnpairedError('webclient_token missing'),
    );

    const outcome = await runBootstrapWithPairFallback(deps);
    expect(outcome).toEqual({ kind: 'pair-form' });

    const options = mountOptions()[0];
    expect(options?.onRestoreSubmit).toEqual(expect.any(Function));
    // restoreOnly is NOT set on the FIRST (live) pair form — it keeps all tabs.
    expect(options?.restoreOnly).toBeUndefined();

    const firstInputs = {
      serverUrl: 'http://alice.example:3001',
      code: 'PAIRCODE1',
      archiveKey: 'word1 word2 word3',
      file: {
        name: 'backup.recued.archive',
        size: 1,
        type: 'application/octet-stream',
        lastModified: 1,
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
      },
    };
    await options!.onRestoreSubmit!(firstInputs);

    // The live pair form is torn down before the splash surface takes the slot.
    expect(pairHandles()[0]?.dispose).toHaveBeenCalledTimes(1);
    // The flow controller is started with the collected inputs + a splash element
    // + the full set of production seams.
    expect(mockState.startRestoreOnboarding).toHaveBeenCalledTimes(1);
    const [flowDeps, passedInputs] = mockState.startRestoreOnboarding.mock.calls[0];
    expect(passedInputs).toBe(firstInputs);
    expect((flowDeps as { splashElement: unknown }).splashElement).toBe(dom.message);
    expect(flowDeps).toMatchObject({
      buildOnboarding: expect.any(Function),
      mountSplash: expect.any(Function),
      mountRestoreCollectForm: expect.any(Function),
      reBootstrap: expect.any(Function),
      onReload: expect.any(Function),
      dropSplash: expect.any(Function),
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// Server-profile forwarding
// ══════════════════════════════════════════════════════════════════
//
// `profileStore` is what lets the shell mount the server switcher. It is
// threaded entry → pair-fallback → bootstrap, and an option that is accepted
// at one layer but dropped at the next fails silently: the switcher simply
// never appears, with nothing to read as broken. These pin the hand-off.

describe('runBootstrapWithPairFallback: profileStore forwarding', () => {
  const fakeProfileStore = {
    listProfiles: async () => [],
    activeProfileId: async () => null,
    ensureProfile: async () => 'p1',
    switchProfile: async () => undefined,
    renameProfile: async () => null,
    removeProfile: async () => undefined,
    noteProfileConnected: async () => undefined,
    beginNewProfile: async () => undefined,
  } as PairFallbackBootstrapDeps['profileStore'];

  it('forwards the profile store through to bootstrapWebclient', async () => {
    const dom = makeFakeDocument();
    const handle = makeWebclientHandle();
    mockState.bootstrapWebclient.mockResolvedValueOnce(handle);

    await runBootstrapWithPairFallback({
      ...makeDeps(dom),
      profileStore: fakeProfileStore,
    });

    const passed = mockState.bootstrapWebclient.mock.calls[0]?.[0] as
      { profileStore?: unknown } | undefined;
    expect(passed?.profileStore).toBe(fakeProfileStore);
  });

  it('omits the key entirely when the caller has no roster', async () => {
    // Absent rather than `undefined`: the bootstrap gates the switcher mount
    // on the property being supplied, and an explicit `undefined` under
    // exactOptionalPropertyTypes is a different thing from an absent key.
    const dom = makeFakeDocument();
    const handle = makeWebclientHandle();
    mockState.bootstrapWebclient.mockResolvedValueOnce(handle);

    await runBootstrapWithPairFallback(makeDeps(dom));

    const passed = mockState.bootstrapWebclient.mock.calls[0]?.[0] as object;
    expect(Object.hasOwn(passed, 'profileStore')).toBe(false);
  });
});
