import { describe, expect, it, vi } from 'vitest';
import type { WebclientLocalStorage } from '@recued/contracts';

import {
  COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR,
  COLD_START_CREDENTIAL_REPAIR_ATTR,
  COLD_START_CREDENTIAL_REPAIR_ERROR_COPY,
  COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR,
  COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR,
  announceColdStartCredentialCheck,
  inspectColdStartCredentials,
  mountColdStartCredentialRepairHost,
  startColdStartCredentialRepair,
} from './cold-start-credential-repair.js';
import { readCompleteStoredPair } from './stored-pair-state.js';
import { WebclientReauthRequiredError } from '../realtime/ws-client.js';
import {
  createInMemoryWebclientLocalStore,
  type WebclientLocalStore,
} from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { PairFallbackBootstrapDeps } from './pair-fallback-bootstrap.js';
import type { PairTabConvergenceHint } from './pair-tab-convergence.js';

const TOKEN = {
  token_id: 'tok-cold-start',
  ciphertext_b64: 'ciphertext-cold-start',
  iv_b64: 'iv-cold-start',
  issued_at: 1_700_000_000,
};

const pairedStore = (
  overrides: Partial<WebclientLocalStorage> = {},
): WebclientLocalStore =>
  createInMemoryWebclientLocalStore({
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-old',
    webclient_token: TOKEN,
    pair_metadata: {
      paired_at: 1_700_000_000,
      server_passport_fingerprint: 'fp-old',
      server_handle_at_pair: 'alice',
      instance_id: 'browser-old',
    },
    cert_pin_state: null,
    ...overrides,
  });

const tokenStore = (
  unwrap: WebclientTokenStore['unwrap'],
): WebclientTokenStore => ({
  wrap: vi.fn(async () => TOKEN),
  unwrap,
});

interface FakeRepairDom {
  readonly document: Document;
  readonly splash: HTMLElement;
  readonly getHtml: () => string;
  readonly repairFocus: ReturnType<typeof vi.fn>;
  readonly statusFocus: ReturnType<typeof vi.fn>;
  readonly fireAction: (attribute: string) => void;
}

const fakeRepairDom = (): FakeRepairDom => {
  let html = '';
  const listeners = new Set<(event: Event) => void>();
  const repairFocus = vi.fn();
  const statusFocus = vi.fn();
  const repairNode = { focus: repairFocus };
  const statusNode = { focus: statusFocus };
  const splash = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    textContent: '',
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'click') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === 'click') listeners.delete(listener);
    },
    querySelector: (selector: string) => {
      if (selector === `[${COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR}]`) {
        return repairNode;
      }
      if (selector === `[${COLD_START_CREDENTIAL_REPAIR_STATUS_ATTR}]`) {
        return statusNode;
      }
      return null;
    },
  } as unknown as HTMLElement;
  let styleNode: {
    setAttribute: (name: string, value: string) => void;
    textContent: string;
  } | null = null;
  const head = {
    querySelector: () => styleNode,
    appendChild: (node: typeof styleNode) => {
      styleNode = node;
      return node;
    },
  };
  const document = {
    head,
    createElement: () => ({
      setAttribute: vi.fn(),
      textContent: '',
    }),
    getElementById: (id: string) =>
      id === 'webclient-boot-splash-message' ? splash : null,
  } as unknown as Document;
  return {
    document,
    splash,
    getHtml: () => html,
    repairFocus,
    statusFocus,
    fireAction: (attribute) => {
      for (const listener of [...listeners]) {
        listener({
          target: {
            closest: (selector: string) =>
              selector === `[${attribute}]` ? {} : null,
          },
          preventDefault: vi.fn(),
        } as unknown as Event);
      }
    },
  };
};

describe('announceColdStartCredentialCheck', () => {
  it('announces only the wait, then restores the message host semantics', () => {
    const attributes = new Map<string, string>([['role', 'alert']]);
    const actions: string[] = [];
    let textContent = 'Loading…';
    const message = {
      get textContent() {
        return textContent;
      },
      set textContent(value: string) {
        textContent = value;
        actions.push(`text:${value}`);
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
        actions.push(`attribute:${name}=${value}`);
      },
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
    } as unknown as HTMLElement;
    const document = {
      getElementById: (id: string) =>
        id === 'webclient-boot-splash-message' ? message : null,
    } as unknown as Document;

    const stop = announceColdStartCredentialCheck(document);

    expect(message.textContent).toBe('Checking saved access…');
    expect([...attributes]).toEqual([
      ['role', 'status'],
      ['aria-live', 'polite'],
      ['aria-atomic', 'true'],
    ]);
    expect(actions.slice(0, 4)).toEqual([
      'attribute:role=status',
      'attribute:aria-live=polite',
      'attribute:aria-atomic=true',
      'text:Checking saved access…',
    ]);

    stop();
    expect(attributes).toEqual(new Map([['role', 'alert']]));

    const fail = announceColdStartCredentialCheck(document);
    fail('error');
    expect([...attributes]).toEqual([
      ['role', 'alert'],
      ['aria-live', 'assertive'],
      ['aria-atomic', 'true'],
    ]);
  });
});

describe('inspectColdStartCredentials', () => {
  it('continues for a healthy strict pair and verifies the exact AAD', async () => {
    const unwrap = vi.fn(async () => 'bearer');
    const result = await inspectColdStartCredentials({
      localStore: pairedStore(),
      tokenStore: tokenStore(unwrap),
    });

    expect(result).toEqual({
      kind: 'continue',
      healthyPairAvailable: true,
    });
    expect(unwrap).toHaveBeenCalledWith(TOKEN, {
      token_id: TOKEN.token_id,
      server_url: 'wss://alice.recued.cloud:8443/ws',
      server_public_key: 'spki-old',
    });
  });

  it('classifies non-empty incomplete state and preserves its server hint', async () => {
    const unwrap = vi.fn(async () => 'bearer');
    const result = await inspectColdStartCredentials({
      localStore: pairedStore({ webclient_token: null }),
      tokenStore: tokenStore(unwrap),
    });

    expect(result).toEqual({
      kind: 'partial',
      partial: {
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
        instanceId: 'browser-old',
        presentFields: [
          'server_url',
          'server_public_key',
          'pair_metadata',
        ],
      },
    });
    expect(unwrap).not.toHaveBeenCalled();
  });

  it('keeps an entirely empty store on the ordinary first-pair path', async () => {
    const unwrap = vi.fn(async () => 'bearer');
    const result = await inspectColdStartCredentials({
      localStore: createInMemoryWebclientLocalStore(),
      tokenStore: tokenStore(unwrap),
    });

    expect(result).toEqual({ kind: 'continue' });
    expect(unwrap).not.toHaveBeenCalled();
  });

  it('treats metadata-only residue and empty strict strings as partial', async () => {
    const metadataOnly = await inspectColdStartCredentials({
      localStore: pairedStore({
        server_url: null,
        webclient_token: null,
        server_public_key: null,
      }),
      tokenStore: tokenStore(async () => 'bearer'),
    });
    const emptyUrl = await inspectColdStartCredentials({
      localStore: pairedStore({ server_url: '' }),
      tokenStore: tokenStore(async () => 'bearer'),
    });

    expect(metadataOnly).toEqual({
      kind: 'partial',
      partial: {
        serverUrl: null,
        instanceId: 'browser-old',
        presentFields: ['pair_metadata'],
      },
    });
    expect(emptyUrl).toMatchObject({
      kind: 'partial',
      partial: {
        serverUrl: null,
        // A pending profile projects its unusable empty URL as null, but the
        // remaining strict-generation fields still prove this is damaged
        // saved access rather than first-run onboarding.
        presentFields: [
          'webclient_token',
          'server_public_key',
          'pair_metadata',
        ],
      },
    });
  });

  it('waits for an in-flight sibling-tab pair before classifying residue', async () => {
    const localStore = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    const request = vi.fn(
      async (_name: unknown, _options: unknown, callback: unknown) => {
        await localStore.set('server_public_key', 'spki-fresh');
        await localStore.set('webclient_token', TOKEN);
        return (callback as () => Promise<unknown>)();
      },
    );
    const unwrap = vi.fn(async () => 'bearer');

    const result = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(unwrap),
      pairLockProvider: { request } as unknown as NonNullable<
        PairFallbackBootstrapDeps['pairLockProvider']
      >,
    });

    expect(result).toEqual({
      kind: 'continue',
      healthyPairAvailable: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(unwrap).toHaveBeenCalledTimes(1);
  });

  it('rechecks a suspicious snapshot when pair completion lands during the read', async () => {
    const underlying = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    let reads = 0;
    const listeners = new Set<(hint: PairTabConvergenceHint) => void>();
    const unsubscribe = vi.fn();
    const localStore: WebclientLocalStore = {
      async get(key) {
        const value = await underlying.get(key);
        reads += 1;
        if (reads === 5) {
          await underlying.set('server_public_key', 'spki-fresh');
          await underlying.set('webclient_token', TOKEN);
          for (const listener of [...listeners]) listener('pair_complete');
        }
        return value;
      },
      set: underlying.set.bind(underlying),
      remove: underlying.remove.bind(underlying),
      inspect: underlying.inspect.bind(underlying),
      clear: underlying.clear.bind(underlying),
    };
    const result = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'bearer'),
      credentialConvergence: {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            unsubscribe();
          };
        },
      },
      // A captured signal must skip this budget rather than flashing repair.
      settleMs: 10_000,
      pairLockProvider: null,
    });

    expect(result).toEqual({
      kind: 'continue',
      healthyPairAvailable: true,
      pairCompletedInAnotherTab: true,
    });
    expect(reads).toBe(10);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(0);
  });

  it('marks a replacement that becomes healthy during unreadable-state settling as sibling-owned', async () => {
    const localStore = pairedStore();
    let unwrapAttempts = 0;
    const result = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => {
        unwrapAttempts += 1;
        if (unwrapAttempts === 1) {
          await localStore.set('server_public_key', 'spki-sibling');
          await localStore.set('webclient_token', {
            token_id: 'tok-sibling',
            ciphertext_b64: 'ciphertext-sibling',
            iv_b64: 'iv-sibling',
            issued_at: 1_700_000_001,
          });
          throw new WebclientReauthRequiredError('old key unavailable');
        }
        return 'sibling-bearer';
      }),
      credentialConvergence: null,
      settleMs: 1,
      pairLockProvider: null,
    });

    expect(result).toEqual({
      kind: 'continue',
      healthyPairAvailable: true,
      pairCompletedInAnotherTab: true,
    });
    expect(unwrapAttempts).toBe(2);
  });

  it('keeps a same-generation transient unlock as this tab reload recovery', async () => {
    let unwrapAttempts = 0;
    const result = await inspectColdStartCredentials({
      localStore: pairedStore(),
      tokenStore: tokenStore(async () => {
        unwrapAttempts += 1;
        if (unwrapAttempts === 1) {
          throw new WebclientReauthRequiredError('key still opening');
        }
        return 'recovered-bearer';
      }),
      credentialConvergence: null,
      settleMs: 1,
      pairLockProvider: null,
    });

    expect(result).toEqual({
      kind: 'continue',
      healthyPairAvailable: true,
    });
    expect(unwrapAttempts).toBe(2);
  });

  it('bounds a true partial-state recheck and still returns guided repair', async () => {
    const underlying = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    let reads = 0;
    const localStore: WebclientLocalStore = {
      async get(key) {
        reads += 1;
        return underlying.get(key);
      },
      set: underlying.set.bind(underlying),
      remove: underlying.remove.bind(underlying),
      inspect: underlying.inspect.bind(underlying),
      clear: underlying.clear.bind(underlying),
    };

    const result = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
      credentialConvergence: null,
      settleMs: 1,
      pairLockProvider: null,
    });

    expect(result.kind).toBe('partial');
    expect(reads).toBe(10);
  });

  it('does not delay or re-read a stable empty first-run state', async () => {
    const underlying = createInMemoryWebclientLocalStore();
    let reads = 0;
    const localStore: WebclientLocalStore = {
      async get(key) {
        reads += 1;
        return underlying.get(key);
      },
      set: underlying.set.bind(underlying),
      remove: underlying.remove.bind(underlying),
      inspect: underlying.inspect.bind(underlying),
      clear: underlying.clear.bind(underlying),
    };

    const result = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
      credentialConvergence: null,
      settleMs: 10_000,
      pairLockProvider: null,
    });

    expect(result).toEqual({ kind: 'continue' });
    expect(reads).toBe(5);
  });

  it('keeps startup observer setup and teardown strictly advisory', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const unavailable = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
      credentialConvergence: {
        subscribe() {
          throw new Error('BroadcastChannel unavailable');
        },
      },
      settleMs: 10_000,
      pairLockProvider: null,
    });
    const teardownFailure = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
      credentialConvergence: {
        subscribe() {
          return () => {
            throw new Error('observer already closed');
          };
        },
      },
      settleMs: 10_000,
      pairLockProvider: null,
    });

    expect(unavailable).toEqual({ kind: 'continue' });
    expect(teardownFailure).toEqual({ kind: 'continue' });
  });

  it('returns the trusted complete pair only for a typed unreadable credential', async () => {
    const result = await inspectColdStartCredentials({
      localStore: pairedStore(),
      tokenStore: tokenStore(async () => {
        throw new WebclientReauthRequiredError('local key mismatch');
      }),
    });

    expect(result.kind).toBe('unreadable');
    if (result.kind === 'unreadable') {
      expect(result.pair.serverUrl).toBe(
        'wss://alice.recued.cloud:8443/ws',
      );
      expect(result.pair.version).toMatchObject({
        tokenId: TOKEN.token_id,
        instanceId: 'browser-old',
      });
    }
  });

  it('keeps non-credential boot failures loud', async () => {
    await expect(
      inspectColdStartCredentials({
        localStore: pairedStore(),
        tokenStore: tokenStore(async () => {
          throw new Error('IndexedDB transaction failed');
        }),
      }),
    ).rejects.toThrow('IndexedDB transaction failed');
  });
});

describe('mountColdStartCredentialRepairHost', () => {
  it('renders an accessible, honest repair choice and focuses the primary action', () => {
    const dom = fakeRepairDom();
    const onReload = vi.fn();
    mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'unreadable',
      serverUrl: 'wss://alice.recued.cloud:8443/ws',
      onRepair: async () => undefined,
      onReload,
    });

    const html = dom.getHtml();
    expect(html).toContain(COLD_START_CREDENTIAL_REPAIR_ATTR);
    expect(html).toContain('role="region"');
    expect(html).toContain('Reconnect this browser');
    expect(html).toContain('Your server data is not being cleared.');
    expect(html).toContain('Connections, Chat history, and other work');
    expect(html).toContain('another tab is reconnecting now');
    expect(html).toContain('keep this page open');
    expect(html).toContain('https://alice.recued.cloud:8443');
    expect(html).not.toContain('wss://alice.recued.cloud');
    expect(html).toContain('Clear local access and reconnect');
    expect(dom.repairFocus).toHaveBeenCalledTimes(1);

    dom.fireAction(COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('explains interrupted setup without pretending a missing server hint survived', () => {
    const dom = fakeRepairDom();
    mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'partial',
      serverUrl: null,
      onRepair: async () => undefined,
    });

    const html = dom.getHtml();
    expect(html).toContain('Browser setup was interrupted');
    expect(html).toContain('Finish reconnecting this browser');
    expect(html).toContain('incomplete saved sign-in');
    expect(html).toContain('Clear incomplete setup and reconnect');
    expect(html).toContain('Not available — enter it again');
    expect(html).not.toContain('Previously connected server:');
    expect(dom.repairFocus).toHaveBeenCalledTimes(1);
  });

  it('turns a restored unfinished repair into one immediate local continuation', () => {
    const dom = fakeRepairDom();
    mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'partial',
      serverUrl: 'wss://alice.recued.cloud:8443/ws',
      recoveryReentry: true,
      onRepair: async () => undefined,
    });

    const html = dom.getHtml();
    expect(html).toContain('Recovery resumed');
    expect(html).toContain('Continue recovering this browser');
    expect(html).toContain('You do not need to wait for the earlier page.');
    expect(html).toContain('exact page you were returning to is still selected');
    expect(html).toContain('pairing codes and recovery keys were not restored');
    expect(html).toContain('Have the existing recovery key ready.');
    expect(html).toContain('a fresh pairing code is not a substitute');
    expect(html).toContain('stop here before clearing local access');
    expect(html).toContain('Continue recovery here');
    expect(html).toContain(
      `${COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR} aria-describedby="webclient-cold-start-credential-repair-consequence webclient-cold-start-credential-repair-material"`,
    );
    expect(html).not.toContain('another tab is still finishing');
    expect(dom.repairFocus).toHaveBeenCalledOnce();
  });

  it('keeps a restored safe stop paused without displaying damaged saved context', () => {
    const dom = fakeRepairDom();
    mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'partial',
      serverUrl: 'wss://operator:secret@old.recued.cloud/private?token=old',
      recoveryReentry: true,
      safeStopReentry: true,
      onRepair: async () => undefined,
    });

    const html = dom.getHtml();
    expect(html).toContain('Recovery is still paused');
    expect(html).toContain(
      'Repair local access, then return to the safe stop',
    );
    expect(html).toContain(
      'no server address, pairing code, recovery key, rejection history, diagnostic, or Chat draft was restored',
    );
    expect(html).toContain('The owner checkpoint stays paused.');
    expect(html).toContain(
      'Clear local access and return to safe stop',
    );
    expect(html).toContain(
      'choose only what the server owner confirmed',
    );
    expect(html).toContain(
      'If the current server has no usable recovery key, leave recovery stopped.',
    );
    expect(html).not.toContain(
      'Enter your existing 24-word recovery key.',
    );
    expect(html).toContain(
      'Not restored — the owner-outcome checkpoint remains paused.',
    );
    expect(html).not.toContain('old.recued.cloud');
    expect(html).not.toContain('operator:secret');
    expect(dom.repairFocus).toHaveBeenCalledOnce();
  });

  it('resumes fresh-server verification without restoring prior server material', () => {
    const dom = fakeRepairDom();
    mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'partial',
      serverUrl: 'wss://operator:secret@old.recued.cloud/private?token=old',
      recoveryReentry: true,
      replacementServerReentry: true,
      onRepair: async () => undefined,
    });

    const html = dom.getHtml();
    expect(html).toContain('Fresh-server verification resumed');
    expect(html).toContain(
      'Repair local access, then verify the current server',
    );
    expect(html).toContain(
      'the current server address, fresh pairing code, generated recovery key, and review choice were not restored',
    );
    expect(html).toContain(
      'It does not restore data from the previous server',
    );
    expect(html).toContain(
      'Current server address:<span>Not restored — enter it again before verification.',
    );
    expect(html).toContain(
      'Recued will verify its signed identity only after pairing succeeds',
    );
    expect(html).toContain(
      'Review the current server origin and the data-continuity warning before creating a new recovery key.',
    );
    expect(html).toContain('Clear local access and verify current server');
    expect(html).not.toContain('old.recued.cloud');
    expect(html).not.toContain('operator:secret');
    expect(html).not.toContain('token=old');
    expect(dom.repairFocus).toHaveBeenCalledOnce();
  });

  it('acknowledges a failed explicit reload for either repair reason', () => {
    for (const reason of ['unreadable', 'partial'] as const) {
      const dom = fakeRepairDom();
      const onReload = vi.fn();
      mountColdStartCredentialRepairHost({
        document: dom.document,
        reason,
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
        onRepair: async () => undefined,
        onReload,
        reloadAttempted: true,
      });

      const html = dom.getHtml();
      expect(html).toContain(
        'This tab reloaded, but this browser’s saved access still needs repair.',
      );
      expect(html).toContain('exact page you opened is still selected');
      expect(html).toContain(
        `${COLD_START_CREDENTIAL_REPAIR_ACTION_ATTR} aria-describedby="webclient-cold-start-credential-repair-consequence webclient-cold-start-credential-repair-context"`,
      );
      expect(html).toContain(
        `${COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR} aria-describedby="webclient-cold-start-credential-repair-context"`,
      );
      expect(dom.repairFocus).toHaveBeenCalledTimes(1);

      dom.fireAction(COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR);
      expect(onReload).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the surface retryable and honest when the local reset fails', async () => {
    const dom = fakeRepairDom();
    const onRepair = vi.fn(async () => {
      throw new Error('key-store clear failed');
    });
    const host = mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'unreadable',
      serverUrl: 'https://alice.recued.cloud:8443',
      onRepair,
    });

    await host.repair();

    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(dom.getHtml()).toContain('role="alert"');
    expect(dom.getHtml()).toContain(COLD_START_CREDENTIAL_REPAIR_ERROR_COPY);
    expect(dom.getHtml()).toContain('Clear local access and reconnect');
    expect(dom.repairFocus).toHaveBeenCalledTimes(2);
  });

  it('serializes repeated confirmation while the reset is in flight', async () => {
    const dom = fakeRepairDom();
    const onReload = vi.fn();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onRepair = vi.fn(() => pending);
    const host = mountColdStartCredentialRepairHost({
      document: dom.document,
      reason: 'unreadable',
      serverUrl: 'https://alice.recued.cloud:8443',
      onRepair,
      onReload,
    });

    const first = host.repair();
    const second = host.repair();
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(dom.getHtml()).toContain('aria-disabled="true"');
    expect(dom.statusFocus).toHaveBeenCalled();
    dom.fireAction(COLD_START_CREDENTIAL_RELOAD_ACTION_ATTR);
    expect(onReload).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(dom.getHtml()).toContain('Opening the secure reconnect');
  });
});

describe('startColdStartCredentialRepair', () => {
  const pairLock = () => {
    const request = vi.fn(
      async (_name: unknown, _options: unknown, callback: unknown) =>
        (callback as () => Promise<unknown>)(),
    );
    return {
      request,
      provider: { request } as unknown as NonNullable<
        PairFallbackBootstrapDeps['pairLockProvider']
      >,
    };
  };

  it('scrubs stale pair inputs before a restored cold repair can reuse them', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    const health = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
    });
    expect(health.kind).toBe('partial');
    if (health.kind !== 'partial') return;
    const replaceUrl = vi.fn();
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper: async () => undefined,
      credentialStoreWiper: () => localStore.clear(),
      target: { kind: 'partial', partial: health.partial },
      returnHash: '#chat/session/chat_1',
      recoveryReentry: true,
      recoveryReentryStorage: null,
      deeplinkSeed: { pairingCode: 'STALE-CODE' },
      currentUrl: () =>
        'https://alice.recued.cloud/webclient/?keep=a%20b&code=STALE-CODE&recued_pair_resume=same-origin#chat/session/chat_1',
      replaceUrl,
      pairLockProvider: null,
      runBootstrap,
    });

    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );
    await host.repair();
    expect(runBootstrap).toHaveBeenCalledOnce();
    expect(runBootstrap.mock.calls[0]?.[0]).toMatchObject({
      recoveryReentryStorage: null,
      reauthRecovery: {
        returnHash: '#chat/session/chat_1',
        recoveryReentry: true,
      },
    });
    expect(runBootstrap.mock.calls[0]?.[0].deeplinkSeed).toBeUndefined();
  });

  it('hands a repaired safe stop back without its stored server or stale pair seed', async () => {
    const dom = fakeRepairDom();
    const oldServer = 'wss://alice.recued.cloud:8443/private?token=old';
    const localStore = pairedStore({
      server_url: oldServer,
      webclient_token: null,
      server_public_key: null,
    });
    const health = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
    });
    expect(health.kind).toBe('partial');
    if (health.kind !== 'partial') return;
    const recoveryValues = new Map<string, string>();
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper: async () => undefined,
      credentialStoreWiper: () => localStore.clear(),
      target: { kind: 'partial', partial: health.partial },
      returnHash: '#chat/session/chat_1',
      recoveryReentry: true,
      safeStopReentry: true,
      recoveryReentryStorage: {
        getItem: (key) => recoveryValues.get(key) ?? null,
        setItem: (key, value) => {
          recoveryValues.set(key, value);
        },
        removeItem: (key) => {
          recoveryValues.delete(key);
        },
      },
      deeplinkSeed: { pairingCode: 'STALE-CODE' },
      currentUrl: () =>
        'https://alice.recued.cloud/webclient/?code=STALE-CODE#chat/session/chat_1',
      replaceUrl: vi.fn(),
      pairLockProvider: null,
      runBootstrap,
    });

    expect(dom.getHtml()).not.toContain('alice.recued.cloud:8443');
    await host.repair();

    expect([...recoveryValues.entries()]).toEqual([
      ['recued.webclient.recovery-reentry.v1', '2'],
    ]);
    expect(runBootstrap).toHaveBeenCalledOnce();
    const deps = runBootstrap.mock.calls[0]?.[0];
    expect(deps?.deeplinkSeed).toBeUndefined();
    expect(deps?.reauthRecovery).toMatchObject({
      returnHash: '#chat/session/chat_1',
      recoveryReentry: true,
      safeStopReentry: true,
    });
    expect(deps?.reauthRecovery).not.toHaveProperty('serverUrl');
    expect(deps?.reauthRecovery).not.toHaveProperty('instanceId');
  });

  it('hands interrupted replacement verification back to a blank marker-three checkpoint', async () => {
    const dom = fakeRepairDom();
    const oldServer =
      'wss://operator:secret@old.recued.cloud/private?token=old';
    const localStore = pairedStore({
      server_url: oldServer,
      webclient_token: null,
      server_public_key: null,
    });
    const health = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
    });
    expect(health.kind).toBe('partial');
    if (health.kind !== 'partial') return;
    const recoveryValues = new Map<string, string>();
    const replaceUrl = vi.fn();
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper: async () => undefined,
      credentialStoreWiper: () => localStore.clear(),
      target: { kind: 'partial', partial: health.partial },
      returnHash: '#chat/session/chat_1',
      recoveryReentry: true,
      replacementServerReentry: true,
      recoveryReentryStorage: {
        getItem: (key) => recoveryValues.get(key) ?? null,
        setItem: (key, value) => {
          recoveryValues.set(key, value);
        },
        removeItem: (key) => {
          recoveryValues.delete(key);
        },
      },
      deeplinkSeed: {
        serverUrl: 'https://stale.example/private',
        pairingCode: 'STALE-CODE',
      },
      currentUrl: () =>
        'https://alice.recued.cloud/webclient/?keep=a%20b&code=STALE-CODE&recued_pair_resume=same-origin#chat/session/chat_1',
      replaceUrl,
      pairLockProvider: null,
      runBootstrap,
    });

    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );
    expect(dom.getHtml()).not.toContain('old.recued.cloud');
    expect(dom.getHtml()).not.toContain('STALE-CODE');
    await host.repair();

    expect([...recoveryValues.entries()]).toEqual([
      ['recued.webclient.recovery-reentry.v1', '3'],
    ]);
    expect(runBootstrap).toHaveBeenCalledOnce();
    const deps = runBootstrap.mock.calls[0]?.[0];
    expect(deps?.deeplinkSeed).toBeUndefined();
    expect(deps?.reauthRecovery).toMatchObject({
      returnHash: '#chat/session/chat_1',
      recoveryReentry: true,
      replacementServerReentry: true,
    });
    expect(deps?.reauthRecovery).not.toHaveProperty('serverUrl');
    expect(deps?.reauthRecovery).not.toHaveProperty('instanceId');
  });

  it('clears interrupted local state and preserves its trusted reconnect context', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    const health = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
    });
    expect(health.kind).toBe('partial');
    if (health.kind !== 'partial') return;
    const resetOrder: string[] = [];
    const cryptoKeysWiper = vi.fn(async () => {
      resetOrder.push('crypto-key');
    });
    const credentialStoreWiper = vi.fn(async () => {
      resetOrder.push('local-store');
      await localStore.clear();
    });
    const onCredentialsRemoved = vi.fn(() => {
      resetOrder.push('sibling-signal');
    });
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const recoveryReentryValues = new Map<string, string>();
    const recoveryReentryStorage = {
      getItem: (key: string) => recoveryReentryValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value === '1') resetOrder.push('recovery-marker');
        recoveryReentryValues.set(key, value);
      },
      removeItem: (key: string) => {
        recoveryReentryValues.delete(key);
      },
    };
    const lock = pairLock();
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper,
      credentialStoreWiper,
      onCredentialsRemoved,
      target: { kind: 'partial', partial: health.partial },
      returnHash: '#chat/session/chat_1',
      deeplinkSeed: { pairingCode: 'PAIR5678' },
      recoveryReentryStorage,
      pairLockProvider: lock.provider,
      runBootstrap,
    });

    await host.repair();

    expect(resetOrder).toEqual([
      'recovery-marker',
      'crypto-key',
      'local-store',
      'sibling-signal',
    ]);
    expect(onCredentialsRemoved).toHaveBeenCalledOnce();
    expect(await localStore.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
    expect(runBootstrap.mock.calls[0]?.[0]).toMatchObject({
      pairLockProvider: lock.provider,
      recoveryReentryStorage,
      reauthRecovery: {
        reason: 'local_credentials_incomplete',
        returnHash: '#chat/session/chat_1',
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
        instanceId: 'browser-old',
      },
      deeplinkSeed: { pairingCode: 'PAIR5678' },
    });
    expect([...recoveryReentryValues.entries()]).toEqual([
      ['recued.webclient.recovery-reentry.v1', '1'],
    ]);
  });

  it('adopts a complete pair written by another tab over partial residue', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    const health = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
    });
    expect(health.kind).toBe('partial');
    if (health.kind !== 'partial') return;
    const cryptoKeysWiper = vi.fn(async () => undefined);
    const credentialStoreWiper = vi.fn(async () => localStore.clear());
    const onCredentialsRemoved = vi.fn();
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'mounted' as const,
      }),
    );
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper,
      credentialStoreWiper,
      onCredentialsRemoved,
      target: { kind: 'partial', partial: health.partial },
      returnHash: '#connections',
      pairLockProvider: pairLock().provider,
      runBootstrap,
    });
    await localStore.set('server_public_key', 'spki-fresh');
    await localStore.set('webclient_token', {
      token_id: 'tok-fresh',
      ciphertext_b64: 'ciphertext-fresh',
      iv_b64: 'iv-fresh',
      issued_at: 1_700_000_001,
    });

    await host.repair();

    expect(cryptoKeysWiper).not.toHaveBeenCalled();
    expect(credentialStoreWiper).not.toHaveBeenCalled();
    expect(onCredentialsRemoved).not.toHaveBeenCalled();
    expect(runBootstrap).toHaveBeenCalledTimes(1);
    expect((await localStore.get('webclient_token'))?.token_id).toBe(
      'tok-fresh',
    );
  });

  it('automatically retires a stale partial repair when another tab finishes saving', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore({
      webclient_token: null,
      server_public_key: null,
    });
    const health = await inspectColdStartCredentials({
      localStore,
      tokenStore: tokenStore(async () => 'unused'),
    });
    expect(health.kind).toBe('partial');
    if (health.kind !== 'partial') return;
    const listeners = new Set<(hint: PairTabConvergenceHint) => void>();
    const close = vi.fn(() => listeners.clear());
    const credentialConvergence = {
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
      subscribe: vi.fn((listener: (hint: PairTabConvergenceHint) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      close,
    };
    const cryptoKeysWiper = vi.fn(async () => undefined);
    const credentialStoreWiper = vi.fn(async () => localStore.clear());
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'mounted' as const,
      }),
    );
    const removeSplash = vi.fn();
    const replaceHash = vi.fn();
    const replaceUrl = vi.fn();
    startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper,
      credentialStoreWiper,
      credentialConvergence,
      target: { kind: 'partial', partial: health.partial },
      returnHash: '#chat/session/chat_1',
      deeplinkSeed: { pairingCode: 'USED-CODE' },
      pairLockProvider: pairLock().provider,
      replaceHash,
      currentUrl: () =>
        'https://alice.recued.cloud/webclient/?keep=a%20b&code=USED-CODE&recued_pair_resume=same-origin#chat/session/chat_1',
      replaceUrl,
      runBootstrap,
      removeSplash,
    });
    await Promise.resolve();
    await localStore.set('server_public_key', 'spki-fresh');
    await localStore.set('webclient_token', {
      token_id: 'tok-fresh',
      ciphertext_b64: 'ciphertext-fresh',
      iv_b64: 'iv-fresh',
      issued_at: 1_700_000_001,
    });

    for (const listener of [...listeners]) listener('pair_complete');

    await vi.waitFor(() => {
      expect(runBootstrap).toHaveBeenCalledTimes(1);
    });
    expect(cryptoKeysWiper).not.toHaveBeenCalled();
    expect(credentialStoreWiper).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(replaceHash).toHaveBeenCalledWith('#chat/session/chat_1');
    expect(replaceUrl).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/?keep=a%20b#chat/session/chat_1',
    );
    expect(runBootstrap.mock.calls[0]?.[0]).toMatchObject({
      reauthRecovery: {
        reason: 'local_credentials_incomplete',
        returnHash: '#chat/session/chat_1',
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
        instanceId: 'browser-old',
        pairCompletedInAnotherTab: true,
      },
    });
    expect(runBootstrap.mock.calls[0]?.[0].deeplinkSeed).toBeUndefined();
    expect(removeSplash).toHaveBeenCalledWith(dom.document);
  });

  it('clears only the unreadable pair and key, then opens reason-aware guided pairing', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore();
    const unreadablePair = await readCompleteStoredPair(localStore);
    expect(unreadablePair).not.toBeNull();
    const resetOrder: string[] = [];
    const originalClear = localStore.clear.bind(localStore);
    const clearSpy = vi.spyOn(localStore, 'clear').mockImplementation(async () => {
      resetOrder.push('local-store');
      await originalClear();
    });
    const cryptoKeysWiper = vi.fn(async () => {
      resetOrder.push('crypto-key');
    });
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const lock = pairLock();
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper,
      credentialStoreWiper: () => clearSpy(),
      target: { kind: 'unreadable', pair: unreadablePair! },
      returnHash: '#chat/session/chat_1',
      deeplinkSeed: { pairingCode: 'PAIR1234' },
      pairLockProvider: lock.provider,
      runBootstrap,
    });

    await host.repair();

    expect(lock.request).toHaveBeenCalledTimes(1);
    expect(cryptoKeysWiper).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(resetOrder).toEqual(['crypto-key', 'local-store']);
    expect(await localStore.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
    expect(dom.getHtml()).toBe('');
    expect(runBootstrap).toHaveBeenCalledTimes(1);
    expect(runBootstrap.mock.calls[0]?.[0]).toMatchObject({
      pairLockProvider: lock.provider,
      reauthRecovery: {
        reason: 'local_credentials_unreadable',
        returnHash: '#chat/session/chat_1',
        serverUrl: 'wss://alice.recued.cloud:8443/ws',
        instanceId: 'browser-old',
      },
      deeplinkSeed: { pairingCode: 'PAIR1234' },
    });
  });

  it('keeps the complete pair available when the key wipe fails', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore();
    const unreadablePair = await readCompleteStoredPair(localStore);
    expect(unreadablePair).not.toBeNull();
    const clearSpy = vi.spyOn(localStore, 'clear');
    const credentialStoreWiper = vi.fn(async () => clearSpy());
    const resetError = new Error('crypto key store is blocked');
    const cryptoKeysWiper = vi.fn(async () => {
      throw resetError;
    });
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const onRepairError = vi.fn();
    const lock = pairLock();
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper,
      credentialStoreWiper,
      target: { kind: 'unreadable', pair: unreadablePair! },
      returnHash: '#chat',
      pairLockProvider: lock.provider,
      runBootstrap,
      onRepairError,
    });

    await host.repair();

    expect(onRepairError).toHaveBeenCalledWith(resetError);
    expect(credentialStoreWiper).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(runBootstrap).not.toHaveBeenCalled();
    expect((await localStore.get('webclient_token'))?.token_id).toBe(
      TOKEN.token_id,
    );
    expect(await localStore.get('server_url')).toBe(
      'wss://alice.recued.cloud:8443/ws',
    );
    expect(dom.getHtml()).toContain(COLD_START_CREDENTIAL_REPAIR_ERROR_COPY);
  });

  it('does not enter pairing when the credential-store transaction aborts', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore();
    const unreadablePair = await readCompleteStoredPair(localStore);
    expect(unreadablePair).not.toBeNull();
    const resetError = new Error('credential-store transaction aborted');
    const credentialStoreWiper = vi.fn(async () => {
      throw resetError;
    });
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'pair-form' as const,
      }),
    );
    const onRepairError = vi.fn();
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper: vi.fn(async () => undefined),
      credentialStoreWiper,
      target: { kind: 'unreadable', pair: unreadablePair! },
      returnHash: '#chat',
      pairLockProvider: pairLock().provider,
      runBootstrap,
      onRepairError,
    });

    await host.repair();

    expect(onRepairError).toHaveBeenCalledWith(resetError);
    expect(runBootstrap).not.toHaveBeenCalled();
    expect(dom.getHtml()).toContain(COLD_START_CREDENTIAL_REPAIR_ERROR_COPY);
  });

  it('adopts a newer cross-tab pair without clearing it or its key', async () => {
    const dom = fakeRepairDom();
    const localStore = pairedStore();
    const unreadablePair = await readCompleteStoredPair(localStore);
    expect(unreadablePair).not.toBeNull();
    const cryptoKeysWiper = vi.fn(async () => undefined);
    const runBootstrap = vi.fn(
      async (_deps: PairFallbackBootstrapDeps) => ({
        kind: 'mounted' as const,
      }),
    );
    const removeSplash = vi.fn();
    const replaceHash = vi.fn();
    const lock = pairLock();
    const host = startColdStartCredentialRepair({
      root: {} as HTMLElement,
      document: dom.document,
      localStore,
      tokenStore: tokenStore(async () => 'fresh-bearer'),
      transport: {} as PairFallbackBootstrapDeps['transport'],
      handleRef: { current: null },
      cryptoKeysWiper,
      credentialStoreWiper: vi.fn(async () => localStore.clear()),
      target: { kind: 'unreadable', pair: unreadablePair! },
      returnHash: '#connections',
      pairLockProvider: lock.provider,
      runBootstrap,
      removeSplash,
      replaceHash,
    });
    await localStore.set('webclient_token', {
      token_id: 'tok-fresh',
      ciphertext_b64: 'ciphertext-fresh',
      iv_b64: 'iv-fresh',
      issued_at: 1_700_000_001,
    });
    await localStore.set('server_public_key', 'spki-fresh');
    await localStore.set('pair_metadata', {
      paired_at: 1_700_000_001,
      server_passport_fingerprint: 'fp-fresh',
      server_handle_at_pair: 'alice',
      instance_id: 'browser-fresh',
    });

    await host.repair();

    expect(cryptoKeysWiper).not.toHaveBeenCalled();
    expect((await localStore.get('webclient_token'))?.token_id).toBe(
      'tok-fresh',
    );
    expect(runBootstrap).toHaveBeenCalledTimes(1);
    expect(removeSplash).toHaveBeenCalledWith(dom.document);
    expect(replaceHash).toHaveBeenCalledWith('#connections');
  });
});
