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
  removeBootSplashWrapper,
  runBootstrapWithPairFallback,
  setSplashMessage,
  type PairFallbackBootstrapDeps,
} from '../boot/pair-fallback-bootstrap.js';
import type { WebclientWsTransport } from '../realtime/ws-client.js';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import {
  type WebclientHandle,
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
const FAILED_COPY =
  'Recued failed to start. Check the browser console for details, or contact your server admin.';
const REAUTH_RECOVERY_FAILED_COPY =
  'Recued could not restart pairing after a server identity change. Reload to re-pair.';

interface FakeElement extends HTMLElement {
  childList: FakeElement[];
}

interface FakeSplashControl {
  splash: HTMLElement;
  getText(): string;
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
    querySelector: () => null,
  } as unknown as HTMLElement;

  return {
    splash,
    getText: () => textContent,
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
  });

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

const makeWebclientHandle = (): WebclientHandle =>
  ({
    activeRoute: () => 'reception',
    receptionShell: () => ({}),
    conn: () => ({}),
    settingsRoute: () => null,
    certPinStateWatcher: () => null,
    dispose: vi.fn(async () => undefined),
  }) as unknown as WebclientHandle;

const makeMountedPairHandle = (events?: string[]): MountedPairCodeInputHost => ({
  dispose: vi.fn(() => {
    events?.push('codeHandle.dispose');
  }),
  submit: vi.fn(async () => undefined),
  setFieldValue: vi.fn(),
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
  });

  it('returns failed, leaves the pair host unmounted, and writes failure copy for generic bootstrap errors', async () => {
    const dom = makeFakeDocument();
    const deps = makeDeps(dom);
    mockState.bootstrapWebclient.mockRejectedValueOnce(new Error('boom'));

    const outcome = await runBootstrapWithPairFallback(deps);

    expect(outcome).toEqual({ kind: 'failed' });
    expect(mockState.mountPairCodeInputHost).not.toHaveBeenCalled();
    expect(dom.getMessageText()).toBe(FAILED_COPY);
  });
});

describe('D-169 P1.5 NEXT-#1 onAfterPair teardown timing', () => {
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
      'bootstrap:second:start',
      'bootstrap:second:resolve',
      `removeChild:${SPLASH_WRAPPER_ID}`,
    ]);
  });

  it('keeps the splash wrapper and shows failure copy when re-entry bootstrap fails', async () => {
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
    expect(dom.getMessageText()).toBe(FAILED_COPY);
  });

  it('keeps the splash wrapper and mounts a fresh pair form when re-entry is still unpaired', async () => {
    const events: string[] = [];
    const dom = makeFakeDocument({ events });
    const deps = makeDeps(dom, buildUnpairedStore());
    nextPairHandleFactory = () => makeMountedPairHandle(events);
    mockState.bootstrapWebclient
      .mockRejectedValueOnce(new WebclientUnpairedError('initially unpaired'))
      .mockRejectedValueOnce(new WebclientUnpairedError('still unpaired'));
    const options = await mountUnpairedPairForm(deps);

    await options.onAfterPair?.();

    expect(pairHandles()[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(mockState.mountPairCodeInputHost).toHaveBeenCalledTimes(2);
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
    const deps = makeDeps(dom);
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
