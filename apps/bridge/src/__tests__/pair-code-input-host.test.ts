/** D-156 P6 — Bridge pair-code-input host tests.
 *
 *  Mirror of `apps/webclient/src/__tests__/d-156-phase-3-pair-code-
 *  input-host.test.ts`, retargeted at the bridge surface. Covers:
 *
 *    - submitBridgePairCodeInput pure function
 *      • client-side guards (no URL / no input / invalid BIP39)
 *      • mode plumbing (code-only / recovery-only / both)
 *      • server success parsing (token / serverId)
 *      • server error mapping (closed-list + fallthrough)
 *      • transport failure
 *
 *    - mountBridgePairCodeInputHost, over the REAL pairing session
 *      (`createBridgeWorkerPairing`) the service worker runs — in memory,
 *      against a fake single-use `/auth/pair`
 *      • render → field IDs present, after the worker answers "unpaired"
 *      • deeplink seed pre-fill (server URL + pairing code)
 *      • disabled gating (URL empty / recovery < 24 words / submitting)
 *      • field updates via delegated input events
 *      • paste fan-out into the 24-word grid
 *      • submit → success → "Paired"
 *      • submit → server error → inline copy + data-error
 *      • DD#6 finishing an accepted pairing; DD#7 a side panel that closes
 *        or reopens mid-pair, or opens on a paired bridge
 *      • dispose detaches listeners + clears DOM
 *
 *  The pair form runs under node-side vitest (no jsdom) — same
 *  string-innerHTML fake-DOM helper the webclient suite uses. The
 *  bridge's stable IDs are prefixed `bridge-pair-...`; the helper
 *  parameterises on those constants so the helper is symmetric with
 *  the webclient version.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';

import {
  mountBridgePairCodeInputHost,
  submitBridgePairCodeInput,
  type BridgePairingClient,
  BRIDGE_PAIR_CODE_INPUT_ERROR_COPY,
  BRIDGE_PAIR_CODE_INPUT_GET_RECUED_ID,
  RECUED_GET_STARTED_URL,
  BRIDGE_PAIR_CODE_INPUT_FORM_ID,
  BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID,
  BRIDGE_PAIR_CODE_INPUT_CODE_ID,
  BRIDGE_PAIR_CODE_INPUT_STATUS_ID,
  BRIDGE_PAIR_CODE_INPUT_SERVER_CODE_ATTR,
  BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID,
  BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID,
  BRIDGE_PAIR_CODE_INPUT_RECOVERY_PREFIX,
  BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR,
} from '../pairing/pair-code-input-host.js';
import {
  createBridgeWorkerPairing,
  type BridgeWorkerPairing,
} from '../pairing/worker-pairing.js';
import type { BridgePairFinalizeResult } from '../pairing/pair-completion.js';
import type {
  BridgeAcceptedPair,
  BridgePendingPairStore,
} from '../pairing/pending-pair-store.js';
import {
  PAIR_SERVER_ERROR_COPY,
  PAIR_SERVER_REFUSED_COPY,
  PAIR_SERVER_SAID_LABEL,
} from '@recued/ui-shared/pairing';

// ════════════════════════════════════════════════════════════════
// String-innerHTML fake DOM
// ════════════════════════════════════════════════════════════════

interface FakeButton {
  id: string;
  disabled: boolean;
  textContent: string;
  dataset: Record<string, string>;
}

interface FakeStatus {
  id: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
}

const makeFakeSplash = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  let submitBtn: FakeButton | null = null;
  let statusEl: FakeStatus | null = null;
  let recoveryCounter: { textContent: string } | null = null;

  const decodeHtml = (s: string): string =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

  const reparseFromHtml = (): void => {
    submitBtn = null;
    statusEl = null;
    recoveryCounter = null;
    if (html.includes(`id="${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID}"`)) {
      const disabled = new RegExp(
        `<button[^>]*id="${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID}"[^>]*\\sdisabled`,
      ).test(html);
      // The label's text, without markup: "Finishing…" carries a spinner.
      const labelMatch = html.match(
        new RegExp(
          `<button[^>]*id="${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID}"[^>]*>([\\s\\S]*?)</button>`,
        ),
      );
      submitBtn = {
        id: BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID,
        disabled,
        textContent: labelMatch ? labelMatch[1].replace(/<[^>]*>/g, '').trim() : '',
        dataset: { action: 'bridge-pair-code-input-submit' },
      };
    }
    if (html.includes(`id="${BRIDGE_PAIR_CODE_INPUT_STATUS_ID}"`)) {
      const errorMatch = html.match(
        new RegExp(
          `<p\\s+id="${BRIDGE_PAIR_CODE_INPUT_STATUS_ID}"[^>]*\\sdata-error="([^"]*)"[^>]*>([^<]*)</p>`,
        ),
      );
      const status: FakeStatus = {
        id: BRIDGE_PAIR_CODE_INPUT_STATUS_ID,
        className: errorMatch ? 'pair-code-input-error' : 'pair-code-input-status',
        textContent: errorMatch ? decodeHtml(errorMatch[2]) : '',
        dataset: errorMatch ? { error: errorMatch[1] } : {},
      };
      (status as unknown as { removeAttribute?: (k: string) => void }).removeAttribute = (
        k: string,
      ): void => {
        if (k === 'data-error') delete status.dataset.error;
      };
      statusEl = status;
    }
    const counterMatch = html.match(
      /class="field-hint rx-recovery-word-count">\s*([^<]*?)\s*<\/p>/,
    );
    if (counterMatch) {
      recoveryCounter = { textContent: counterMatch[1].trim() };
    }
  };

  const splash = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      reparseFromHtml();
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      listeners[evt]?.delete(fn);
    },
    contains: () => true,
    querySelector: (selector: string) => {
      if (selector === `#${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID}`) return submitBtn;
      if (selector === `#${BRIDGE_PAIR_CODE_INPUT_STATUS_ID}`) return statusEl;
      if (selector === '.rx-recovery-word-count') return recoveryCounter;
      return null;
    },
  } as unknown as HTMLElement;

  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };

  return {
    splash,
    getHtml: () => html,
    getSubmitBtn: () => submitBtn,
    getStatus: () => statusEl,
    getRecoveryCounter: () => recoveryCounter,
    listenerCount: () =>
      Object.values(listeners).reduce((total, set) => total + set.size, 0),
    fireField: (kind: 'server-url' | 'pairing-code', value: string): void => {
      const fieldEl = {
        getAttribute: (name: string) =>
          name === 'data-bridge-pair-code-input-field' ? kind : null,
        value,
      };
      const target = {
        closest: (selector: string) => {
          if (selector === '[data-bridge-pair-code-input-field]') return fieldEl;
          return null;
        },
      };
      fire('input', target);
    },
    fireRecoveryWord: (index: number, value: string): void => {
      const fieldEl = {
        getAttribute: (name: string) =>
          name === 'data-bridge-pair-code-input-recovery-field' ? 'recovery-word' : null,
        value,
        dataset: { index: String(index) },
      };
      const target = {
        closest: (selector: string) => {
          if (selector === '[data-bridge-pair-code-input-recovery-field]') return fieldEl;
          return null;
        },
      };
      fire('input', target);
    },
    fireSubmitClick: (disabledOverride?: boolean): void => {
      const btn = submitBtn;
      if (!btn) throw new Error('submit button not rendered yet');
      const target = {
        closest: (selector: string) => {
          if (selector === '[data-action="bridge-pair-code-input-submit"]') {
            return { disabled: disabledOverride ?? btn.disabled };
          }
          return null;
        },
      };
      fire('click', target);
    },
    fireSubmit: (): void => {
      const target = { closest: () => null };
      fire('submit', target);
    },
    fireStartOverClick: (): void => {
      const target = {
        closest: (selector: string) =>
          selector === '[data-action="bridge-pair-code-input-start-over"]'
            ? { disabled: false }
            : null,
      };
      fire('click', target);
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Pure submit
// ════════════════════════════════════════════════════════════════

const realRecoveryKey = generateRecoveryKey().mnemonic;

const buildFakeFetch = (
  status: number,
  jsonBody: unknown,
): typeof fetch & { calls: Array<{ url: string; body: unknown }> } => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const parsedBody = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url: String(url), body: parsedBody });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    } as unknown as Response;
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
};

describe('submitBridgePairCodeInput — client-side guards', () => {
  it('rejects empty server URL with pair_code_input_no_server_url', async () => {
    const result = await submitBridgePairCodeInput({ serverUrl: '   ', code: 'ABC12345' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_no_server_url');
  });

  it('rejects when neither code nor recovery key is supplied', async () => {
    const result = await submitBridgePairCodeInput({ serverUrl: 'http://localhost:3001' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_no_input');
  });

  it('rejects invalid BIP39 recovery key before any fetch fires', async () => {
    const fetchFake = vi.fn();
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey:
        'not a real mnemonic just twenty four words long enough to fill the slots zebra alpha bravo cake delta echo',
      fetch: fetchFake as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_invalid_recovery_key');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('F2 — rejects a PUBLIC http:// server BEFORE any /auth/pair fetch (no plaintext bearer)', async () => {
    const fetchFake = vi.fn();
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://server.example:3001',
      code: 'ABC12345',
      fetch: fetchFake as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_insecure_server_url');
    // The pairing code + the bearer it would return never crossed the wire.
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('F2 — allows a public https:// server + LAN/loopback http:// to fetch', async () => {
    for (const serverUrl of [
      'https://server.example:3001',
      'http://localhost:3001',
      'http://192.168.1.10:3001',
    ]) {
      const fetchFake = buildFakeFetch(200, { token: 'tok' });
      const result = await submitBridgePairCodeInput({ serverUrl, code: 'ABC12345', fetch: fetchFake });
      expect(result.ok).toBe(true); // passed the F2 gate + completed the pair POST
      expect(fetchFake.calls).toHaveLength(1);
    }
  });
});

describe('submitBridgePairCodeInput — request shape (3 modes)', () => {
  it('code-only: posts { code } and nothing else', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-A', message: 'ok' });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001/',
      code: 'ABC12345',
      fetch: fetchFake,
    });
    expect(result.ok).toBe(true);
    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0].url).toBe('http://localhost:3001/auth/pair');
    expect(fetchFake.calls[0].body).toEqual({
      code: 'ABC12345',
      clientKind: 'bridge',
    });
  });

  it('recovery-key-only: posts { recoveryKey }', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-B' });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(true);
    expect(fetchFake.calls[0].body).toEqual({
      recoveryKey: realRecoveryKey,
      clientKind: 'bridge',
    });
  });

  it('both: posts { code, recoveryKey, instanceId, displayName }', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-C' });
    await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      code: 'XYZ98765',
      recoveryKey: realRecoveryKey,
      instanceId: 'iid-bridge',
      displayName: 'Recued Bridge @ Chrome',
      fetch: fetchFake,
    });
    expect(fetchFake.calls[0].body).toEqual({
      code: 'XYZ98765',
      recoveryKey: realRecoveryKey,
      instanceId: 'iid-bridge',
      displayName: 'Recued Bridge @ Chrome',
      clientKind: 'bridge',
    });
  });

  it('preserves serverId from response when present', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-D', serverId: 'srv-42' });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.serverId).toBe('srv-42');
  });

  it('preserves canonical token fields from response when present', async () => {
    const passport = { identity: { server_public_key: 'P' } };
    const fetchFake = buildFakeFetch(200, {
      token: 'legacy-alias',
      token_id: 'server-token-id',
      bearer: 'server-bearer',
      passport,
    });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe('server-bearer');
    expect(result.token_id).toBe('server-token-id');
    expect(result.bearer).toBe('server-bearer');
    expect(result.passport).toBe(passport);
  });
});

describe('submitBridgePairCodeInput — server errors', () => {
  it('maps invalid_code to the closed-list error', async () => {
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'invalid_code', message: 'Invalid, expired, or already-used pairing code' },
    });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      code: 'WRONG999',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_code');
      expect(result.detail).toMatch(/Invalid/);
    }
  });

  it('maps recovery_key_invalid to the closed-list error', async () => {
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'keys differ' },
    });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('recovery_key_invalid');
  });

  it('maps server_not_configured to the closed-list error', async () => {
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'server_not_configured', message: 'no recovery check store' },
    });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('server_not_configured');
  });

  // D-212 tail #6 — was `pair_code_input_server_unknown_error`, whose copy
  // sends the user to "Check the URL". The URL is the one thing that is not
  // wrong: the request reached the right server and it answered in the right
  // shape. The server's own message now travels with the result.
  it('carries the server’s own message through on an unmapped code', async () => {
    const fetchFake = buildFakeFetch(500, {
      error: { code: 'totally_made_up', message: 'whoops' },
    });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('pair_code_input_server_refused');
      expect(result.detail).toBe('whoops');
      expect(result.serverSaid).toBe('whoops');
      expect(result.serverCode).toBe('totally_made_up');
      expect(BRIDGE_PAIR_CODE_INPUT_ERROR_COPY[result.error]).not.toMatch(/check the url/i);
    }
  });

  it('falls through to pair_code_input_server_unknown_error on 200 with no token', async () => {
    const fetchFake = buildFakeFetch(200, { not_a_token: 'oh' });
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('pair_code_input_server_unknown_error');
      expect(result.detail).toMatch(/missing realm token/);
    }
  });

  it('surfaces pair_code_input_transport_failed when fetch throws', async () => {
    const fetchFake = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3001');
    }) as unknown as typeof fetch;
    const result = await submitBridgePairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('pair_code_input_transport_failed');
      expect(result.detail).toMatch(/ECONNREFUSED/);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Mount — DOM host, over the worker's pairing session
// ════════════════════════════════════════════════════════════════

/** A `/auth/pair` that behaves like the real one: the code works ONCE, and
 *  every later post of it is refused `invalid_code` — what a Chrome Web Store
 *  reviewer read on their retry (2026-10-09). A fake that accepted the code
 *  twice could not tell the bug from the fix. */
const buildSingleUseServer = (code: string, reply: Record<string, unknown>) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let spent = false;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : {};
    calls.push({ url: String(url), body });
    const accept = !spent && body.code === code;
    if (accept) spent = true;
    return {
      ok: accept,
      status: accept ? 200 : 401,
      json: async () =>
        accept
          ? reply
          : {
              error: {
                code: 'invalid_code',
                message: 'Invalid, expired, or already-used pairing code',
              },
            },
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

/** A pending store that REMEMBERS, the way session storage outlives the
 *  worker's idle shutdown. `saved` is what a restarted worker reads. */
const buildRememberingStore = () => {
  let saved: BridgeAcceptedPair | null = null;
  const store: BridgePendingPairStore & { readonly saved: BridgeAcceptedPair | null } = {
    get saved() {
      return saved;
    },
    load: async () => saved,
    save: async (pending) => {
      saved = { ...pending };
    },
    clear: async () => {
      saved = null;
    },
  };
  return store;
};

const PAIR_URL = 'https://review.example';
const PAIR_CODE = 'ABC12345';
const PASSPORT = { identity: { server_public_key: 'PUBKEY', current_handle: '' } };
// The shape a current server answers with: the bearer twice (legacy `token`
// + canonical `bearer`), its own token id, and the passport inline.
const SERVER_REPLY = {
  token: 'bearer-1',
  token_id: 'tok-id-1',
  bearer: 'bearer-1',
  passport: PASSPORT,
};
const ACCEPTED: BridgeAcceptedPair = {
  serverUrl: PAIR_URL,
  token: 'bearer-1',
  token_id: 'tok-id-1',
  passport: PASSPORT,
  instanceId: 'inst-1',
};
const SETUP_FAILED: BridgePairFinalizeResult = {
  ok: false,
  error: 'pair_completion_persist_failed',
  detail: 'token-store wrap: OperationError',
};
const HANDOFF_REASON =
  "Recued couldn't save the sign-in in this browser (token-store wrap: OperationError)";
const SET_UP: BridgePairFinalizeResult = {
  ok: true,
  server_url: 'wss://review.example/ws',
  token_id: 'tok-id-1',
};

/** A fetch that fails the test if anything posts. */
const fetchThatMustNotRun = (() => {
  throw new Error('/auth/pair must not be posted here');
}) as unknown as typeof fetch;

/** The service worker's pairing session, in memory: the real orchestrator
 *  over a fake server and a fake finalize that "writes" the paired state, so
 *  a later `status()` reads paired the way storage would. The worker outlives
 *  every mount in a test, as it outlives a side panel that closes. */
const buildWorker = (
  options: {
    fetch?: typeof fetch;
    finalize?: (accepted: BridgeAcceptedPair) => Promise<BridgePairFinalizeResult>;
    store?: BridgePendingPairStore;
    paired?: boolean;
  } = {},
) => {
  let paired = options.paired ?? false;
  const finalize = vi.fn(async (accepted: BridgeAcceptedPair) => {
    const result = await (options.finalize ?? (async () => SET_UP))(accepted);
    if (result.ok) paired = true;
    return result;
  });
  const onPaired = vi.fn(async () => undefined);
  const worker = createBridgeWorkerPairing({
    submit: (o) => submitBridgePairCodeInput({ ...o, fetch: options.fetch ?? fetchThatMustNotRun }),
    finalize,
    readPaired: async () => (paired ? { serverUrl: 'wss://review.example/ws' } : null),
    ...(options.store ? { pendingStore: options.store } : {}),
    onPaired,
    mintInstanceId: () => 'inst-1',
  });
  return { worker, finalize, onPaired };
};

/** Mounts the host over a worker and waits for its first answer. */
const mountOver = async (
  pairing: BridgePairingClient | BridgeWorkerPairing,
  extra: { seed?: { serverUrl?: string; pairingCode?: string } } = {},
) => {
  const fake = makeFakeSplash();
  const host = mountBridgePairCodeInputHost({
    splashElement: fake.splash,
    pairing,
    ...(extra.seed ? { seed: extra.seed } : {}),
  });
  await host.ready;
  return { fake, host };
};

describe('mountBridgePairCodeInputHost — initial render', () => {
  it('asks the worker first, showing no form until it answers', () => {
    const fake = makeFakeSplash();
    const never: BridgePairingClient = {
      status: () => new Promise(() => undefined),
      wait: async () => null,
      start: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      finish: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      abandon: async () => ({ ok: false }),
    };
    mountBridgePairCodeInputHost({ splashElement: fake.splash, pairing: never });
    expect(fake.getHtml()).toContain('Checking this bridge…');
    expect(fake.getHtml()).not.toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
  });

  it('renders the form id + 3 fields + status + submit once the worker says unpaired', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    const html = fake.getHtml();
    expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
    expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID}"`);
    expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_CODE_ID}"`);
    expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_STATUS_ID}"`);
    expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID}"`);
    for (let i = 0; i < 24; i++) {
      expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_RECOVERY_PREFIX}-${i}"`);
    }
  });

  it('shows the form when the worker cannot be asked', async () => {
    const broken: BridgePairingClient = {
      status: async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      wait: async () => null,
      start: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      finish: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      abandon: async () => ({ ok: false }),
    };
    const { fake } = await mountOver(broken);
    expect(fake.getHtml()).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
  });

  it('submit button starts disabled with no URL + no recovery key', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
  });

  it('explains the disabled gate as pairing fields are completed', async () => {
    const { fake, host } = await mountOver(buildWorker().worker);
    expect(fake.getHtml()).toContain('Enter your server address to continue.');

    host.setFieldValue('serverUrl', 'http://localhost:3001');
    expect(fake.getHtml()).toContain('Enter the pairing code from your server to continue.');

    host.setFieldValue(
      'recoveryKey',
      realRecoveryKey.split(/\s+/).slice(0, 23).join(' '),
    );
    expect(fake.getHtml()).toContain('1 recovery word remaining.');

    host.setFieldValue('recoveryKey', realRecoveryKey);
    expect(fake.getHtml()).toMatch(
      new RegExp(`id="${BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID}"[^>]*><\\/p>`),
    );
  });

  it('uses the bridge-specific button copy ("Pair this bridge")', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    // The bridge form renders "Pair this bridge" (vs the webclient's
    // "Pair this browser") so the panel copy reads naturally.
    expect(fake.getHtml()).toContain('Pair this bridge');
    expect(fake.getHtml()).toContain('class="pair-code-input-title"');
  });

  it('names the address field "Server address", as the webclient\'s form does', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    const html = fake.getHtml();
    expect(html).toContain(`<label for="${BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID}">Server address</label>`);
    expect(html).toContain('enter your server address and');
    // 0.0.3's store-review note quoted "Server URL", so the label waited for
    // that release; the note for the next version quotes this one.
    expect(html).not.toMatch(/server URL/i);
  });
});

describe('2026-11-04 — someone with no Recued yet is told where to get it', () => {
  it('the form links to installing Recued, in a new tab', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    const html = fake.getHtml();
    expect(html).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_GET_RECUED_ID}"`);
    expect(html).toContain(`href="${RECUED_GET_STARTED_URL}"`);
    expect(html).toMatch(/<a href="[^"]+" target="_blank" rel="noopener noreferrer">Install Recued first<\/a>/);
    // Before the line for someone who already runs it.
    expect(html.indexOf(BRIDGE_PAIR_CODE_INPUT_GET_RECUED_ID)).toBeLessThan(html.indexOf('recued pair'));
  });

  it('a paired bridge does not show it', async () => {
    const { fake } = await mountOver(buildWorker({ paired: true }).worker);
    expect(fake.getHtml()).not.toContain(BRIDGE_PAIR_CODE_INPUT_GET_RECUED_ID);
  });
});

describe('mountBridgePairCodeInputHost — deeplink seed', () => {
  it('pre-fills the Server address + Pairing code from seed', async () => {
    const { fake } = await mountOver(buildWorker().worker, {
      seed: { serverUrl: 'https://alice.recued.cloud', pairingCode: 'SEED1234' },
    });
    const html = fake.getHtml();
    expect(html).toContain('value="https://alice.recued.cloud"');
    expect(html).toContain('value="SEED1234"');
  });
});

describe('2026-11-03 — a server that stopped accepting this bridge', () => {
  it('the form says why it is back, with that server\'s address typed in', async () => {
    const refused: BridgePairingClient = {
      status: async () => ({ state: 'unpaired', refused: { serverUrl: 'https://review.example' } }),
      wait: async () => null,
      start: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      finish: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      abandon: async () => ({ ok: false }),
    };
    const { fake } = await mountOver(refused);
    expect(fake.getHtml()).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
    expect(fake.getHtml()).toContain('value="https://review.example"');
    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_sign_in_refused');
    expect(fake.getStatus()?.textContent).toBe(BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_sign_in_refused);
  });

  it('a plain unpaired bridge shows the form with no reason', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    expect(fake.getStatus()?.dataset.error).toBeUndefined();
  });

  it('2026-11-04 — disconnected while its server could not be told: the form says the server still lists it', async () => {
    const disconnected: BridgePairingClient = {
      status: async () => ({ state: 'unpaired', disconnected: { serverUrl: 'https://review.example' } }),
      wait: async () => null,
      start: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      finish: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      abandon: async () => ({ ok: false }),
    };
    const { fake } = await mountOver(disconnected);
    expect(fake.getHtml()).toContain('value="https://review.example"');
    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_disconnected_untold');
    expect(fake.getStatus()?.textContent).toBe(BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_disconnected_untold);
    expect(fake.getStatus()?.textContent).toContain('still lists this bridge under Devices');
  });
});

describe('mountBridgePairCodeInputHost — field updates', () => {
  it('typing in Server address re-evaluates submit disabled gate', async () => {
    const { fake, host } = await mountOver(buildWorker().worker);
    fake.fireField('server-url', 'http://localhost:3001');
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    host.setFieldValue('recoveryKey', realRecoveryKey);
    fake.fireField('server-url', 'http://localhost:3001');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
  });

  it('paste of all 24 words into one slot fans out across the grid', async () => {
    const { fake } = await mountOver(buildWorker().worker);
    fake.fireRecoveryWord(0, realRecoveryKey);
    expect(fake.getRecoveryCounter()?.textContent).toBe('24 of 24 words entered.');
  });
});

/** ⛔ THE PATH EVERY REVIEWER AND EVERY ADDED DEVICE TAKES, THROUGH THE BUTTON.
 *  `submitBridgePairCodeInput` always accepted a code alone; the button in front
 *  of it did not enable until 24 recovery words were typed. Every earlier test
 *  either called the pure function or `submit`, so none met the disabled button —
 *  these type into the fields and click, the way a person does. */
describe('mountBridgePairCodeInputHost — a pairing code alone pairs', () => {
  it('enables Pair with a server URL and a code, no recovery key', async () => {
    const { fake, host } = await mountOver(buildWorker().worker);
    fake.fireField('server-url', 'http://localhost:3001');
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    // Typed, the way a person does — the code's input handler has to re-run the
    // gate, and before this fix it did not (URL-then-code stayed disabled).
    fake.fireField('pairing-code', 'ABC12345');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    // Rendered fresh, no requirement is left standing. (The fake DOM shows the
    // in-place requirement update only on a full render.)
    host.setFieldValue('pairingCode', 'ABC12345');
    expect(fake.getHtml()).toMatch(
      new RegExp(`id="${BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID}"[^>]*><\\/p>`),
    );
  });

  it('still blocks Pair on a partly typed recovery key, code or not', async () => {
    // Sent as typed, a partial key is refused as invalid — so finish it or clear it.
    const { fake, host } = await mountOver(buildWorker().worker);
    fake.fireField('server-url', 'http://localhost:3001');
    fake.fireField('pairing-code', 'ABC12345');
    host.setFieldValue('recoveryKey', realRecoveryKey.split(/\s+/).slice(0, 23).join(' '));
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain('1 recovery word remaining.');
  });

  it('clicking Pair with only a code posts { code, instanceId } and pairs', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-code-only', serverId: 'srv-7' });
    const w = buildWorker({ fetch: fetchFake });
    const { fake } = await mountOver(w.worker);
    fake.fireField('server-url', 'http://localhost:3001');
    fake.fireField('pairing-code', 'ABC12345');
    fake.fireSubmitClick();
    await vi.waitFor(() => expect(fake.getHtml()).toContain('data-paired'));
    // The instance id is what lets the server resolve this bridge on every
    // connection; without one, `events.subscribe` refused it.
    expect(fetchFake.calls[0].body).toEqual({
      code: 'ABC12345',
      instanceId: 'inst-1',
      clientKind: 'bridge',
    });
    expect(w.finalize.mock.calls[0][0]).toEqual({
      serverUrl: 'http://localhost:3001',
      token: 'tok-code-only',
      serverId: 'srv-7',
      instanceId: 'inst-1',
    });
  });
});

describe('mountBridgePairCodeInputHost — submit lifecycle', () => {
  it('success path sends the recovery key to the server only, then says Paired', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-bridge', serverId: 'srv-99' });
    const w = buildWorker({ fetch: fetchFake });
    const { fake, host } = await mountOver(w.worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();
    expect((fetchFake.calls[0].body as { recoveryKey?: string }).recoveryKey).toBe(realRecoveryKey);
    expect(w.finalize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(w.finalize.mock.calls[0][0])).not.toContain(realRecoveryKey);
    expect(fake.getHtml()).toContain('data-paired');
    expect(fake.getHtml()).toContain('localhost:3001');
    expect(fake.getHtml()).toContain('Connecting to your server…');
    // The worker started its paired runtime before the form heard "paired".
    expect(w.onPaired).toHaveBeenCalledTimes(1);
  });

  it('switches to the Pairing… screen, spinner and server named, the moment Pair is clicked', async () => {
    let answer!: (r: Response) => void;
    const slow = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const { fake, host } = await mountOver(buildWorker({ fetch: slow }).worker);
    host.setFieldValue('serverUrl', PAIR_URL);
    host.setFieldValue('pairingCode', PAIR_CODE);
    const submitting = host.submit();
    // Synchronously — before the worker has even posted.
    const waiting = fake.getHtml();
    expect(waiting).toContain('<h2 class="pair-code-input-title">Pairing…</h2>');
    expect(waiting).toContain(BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR);
    expect(waiting).toContain('Waiting for <code>review.example</code> to answer.');
    expect(waiting).toContain('Pairing carries on if you close this panel.');
    // Nothing to type into, and no button to send the code twice.
    expect(waiting).not.toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
    expect(fake.getSubmitBtn()).toBeNull();
    // The worker checks for a paired bridge and a held reply before it posts.
    await vi.waitFor(() => expect(typeof answer).toBe('function'));
    answer({ ok: true, status: 200, json: async () => SERVER_REPLY } as unknown as Response);
    await submitting;
    expect(fake.getHtml()).toContain('data-paired');
    expect(fake.getHtml()).not.toContain(BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR);
  });

  it('server error renders inline copy + structured data-error', async () => {
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'keys differ' },
    });
    const { fake, host } = await mountOver(buildWorker({ fetch: fetchFake }).worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();
    expect(fake.getStatus()?.dataset.error).toBe('recovery_key_invalid');
    expect(fake.getStatus()?.textContent).toBe(
      BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.recovery_key_invalid,
    );
    // The waiting screen gave way to the form, filled in as it was.
    expect(fake.getHtml()).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
    expect(fake.getHtml()).toContain('value="http://localhost:3001"');
    expect(fake.getHtml()).not.toContain(BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR);
  });

  it('a worker that cannot be reached is reported, and the code is kept', async () => {
    const unreachable: BridgePairingClient = {
      status: async () => ({ state: 'unpaired' }),
      wait: async () => null,
      start: async () => ({
        ok: false,
        kind: 'error',
        detail: 'Could not establish connection. Receiving end does not exist.',
      }),
      finish: async () => ({ ok: false, kind: 'error', detail: 'unused' }),
      abandon: async () => ({ ok: false }),
    };
    const { fake, host } = await mountOver(unreachable);
    host.setFieldValue('serverUrl', PAIR_URL);
    host.setFieldValue('pairingCode', PAIR_CODE);
    await host.submit();
    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_worker_failed');
    expect(fake.getStatus()?.textContent).toBe(
      "Recued Bridge's background service didn't respond (Could not establish connection. Receiving end does not exist). Try again in a moment.",
    );
    expect(fake.getHtml()).toContain(`value="${PAIR_CODE}"`);
  });

  it('dispose detaches listeners + clears the splash', async () => {
    const { fake, host } = await mountOver(buildWorker().worker);
    expect(fake.listenerCount()).toBeGreaterThan(0);
    host.dispose();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.getHtml()).toBe('');
  });
});

describe('D-212 tail #6 — an unmapped server code reaches the user', () => {
  it('quotes the server in its own attributed element, outside Recued’s sentence', async () => {
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'realm_sealed_for_maintenance', message: 'Back at 14:00 UTC.' },
    });
    const { fake, host } = await mountOver(buildWorker({ fetch: fetchFake }).worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();

    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_server_refused');
    // Recued's sentence claims only that the server refused …
    expect(fake.getStatus()?.textContent).toBe(PAIR_SERVER_REFUSED_COPY);
    expect(fake.getStatus()?.textContent).not.toMatch(/check the url/i);
    // … the server's words are its own, labelled element.
    expect(fake.getHtml()).toContain('data-server-said');
    expect(fake.getHtml()).toContain(PAIR_SERVER_SAID_LABEL);
    expect(fake.getHtml()).toContain('Back at 14:00 UTC.');
  });

  it('renders tailored copy for a code the old hand-list missed, with no quote', async () => {
    const fetchFake = buildFakeFetch(409, {
      error: { code: 'realm_directory_conflict', message: 'D212_REALM_WOULD_ORPHAN_SIBLING' },
    });
    const { fake, host } = await mountOver(buildWorker({ fetch: fetchFake }).worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();

    expect(fake.getStatus()?.dataset.error).toBe('realm_directory_conflict');
    expect(fake.getStatus()?.textContent).toBe(
      BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.realm_directory_conflict,
    );
    expect(fake.getHtml()).not.toContain('data-server-said');
    expect(fake.getHtml()).not.toContain('D212_');
  });

  it('escapes what the unauthenticated host sent', async () => {
    const fetchFake = buildFakeFetch(500, {
      error: { code: 'weird', message: '<img src=x onerror=alert(1)>' },
    });
    const { fake, host } = await mountOver(buildWorker({ fetch: fetchFake }).worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();

    expect(fake.getHtml()).not.toContain('<img src=x');
    expect(fake.getHtml()).toContain('&lt;img src=x');
  });

  it('takes the server half from the shared vocabulary rather than restating it', () => {
    for (const [code, copy] of Object.entries(PAIR_SERVER_ERROR_COPY)) {
      expect(
        BRIDGE_PAIR_CODE_INPUT_ERROR_COPY[
          code as keyof typeof BRIDGE_PAIR_CODE_INPUT_ERROR_COPY
        ],
        `${code} diverged from the shared map`,
      ).toBe(copy);
    }
    expect(BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_insecure_server_url).toBeTruthy();
    expect(BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_server_refused).toBeTruthy();
  });
});

describe('D-212 — the raw server code reaches support, never the copy', () => {
  it('renders a code-shaped identifier as an attribute', async () => {
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'realm_sealed_for_maintenance', message: 'Back at 14:00.' },
    });
    const { fake, host } = await mountOver(buildWorker({ fetch: fetchFake }).worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();

    expect(fake.getHtml()).toContain(
      `${BRIDGE_PAIR_CODE_INPUT_SERVER_CODE_ATTR}="realm_sealed_for_maintenance"`,
    );
    expect(fake.getStatus()?.textContent).not.toContain('realm_sealed');
  });

  it('drops one that is not code-shaped', async () => {
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'not a code <at> all', message: 'x' },
    });
    const { fake, host } = await mountOver(buildWorker({ fetch: fetchFake }).worker);
    host.setFieldValue('serverUrl', 'http://localhost:3001');
    host.setFieldValue('recoveryKey', realRecoveryKey);
    await host.submit();

    expect(fake.getHtml()).not.toContain(BRIDGE_PAIR_CODE_INPUT_SERVER_CODE_ATTR);
    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_server_refused');
  });
});

// ════════════════════════════════════════════════════════════════
// DD#6 — an accepted pairing is finished, never sent again
// ════════════════════════════════════════════════════════════════

describe('DD#6 — an accepted pairing is finished, never sent again', () => {
  it('a failed setup offers Finish pairing, and finishing never posts the spent code', async () => {
    const server = buildSingleUseServer(PAIR_CODE, SERVER_REPLY);
    let attempts = 0;
    const w = buildWorker({
      fetch: server.fetch,
      finalize: async () => (++attempts === 1 ? SETUP_FAILED : SET_UP),
    });
    const { fake } = await mountOver(w.worker);
    fake.fireField('server-url', PAIR_URL);
    fake.fireField('pairing-code', PAIR_CODE);
    fake.fireSubmitClick();
    await vi.waitFor(() =>
      expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_handoff_failed'),
    );

    const status = fake.getStatus()?.textContent ?? '';
    expect(status).toBe(
      `This bridge didn't finish setting up: ${HANDOFF_REASON}. Select Finish pairing to try again. You don't need a new pairing code.`,
    );
    expect(status).not.toMatch(/reload/i);
    // It offers to finish, with no field left to retype a spent code into.
    expect(fake.getSubmitBtn()?.textContent).toBe('Finish pairing');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    expect(fake.getHtml()).not.toContain(`id="${BRIDGE_PAIR_CODE_INPUT_CODE_ID}"`);
    expect(fake.getHtml()).toContain(PAIR_URL);

    fake.fireSubmitClick();
    await vi.waitFor(() => expect(fake.getHtml()).toContain('data-paired'));
    // The single-use server saw the code exactly once. Before DD#6 the retry
    // posted it again and got back the `invalid_code` the reviewer read.
    expect(server.calls).toHaveLength(1);
    expect(w.finalize.mock.calls[0][0]).toEqual(ACCEPTED);
    expect(w.finalize.mock.calls[1][0]).toEqual(ACCEPTED);
  });

  it('a reopened panel finishes the held pairing without the code or the recovery key', async () => {
    const store = buildRememberingStore();
    const server = buildSingleUseServer(PAIR_CODE, SERVER_REPLY);
    let attempts = 0;
    const w = buildWorker({
      fetch: server.fetch,
      store,
      finalize: async () => (++attempts === 1 ? SETUP_FAILED : SET_UP),
    });
    const first = await mountOver(w.worker);
    // Both fields, so the test can prove the recovery key is NOT what is held.
    first.host.setFieldValue('serverUrl', PAIR_URL);
    first.host.setFieldValue('pairingCode', PAIR_CODE);
    first.host.setFieldValue('recoveryKey', realRecoveryKey);
    await first.host.submit();
    expect(first.fake.getStatus()?.dataset.error).toBe('pair_code_input_handoff_failed');
    expect(store.saved).toEqual(ACCEPTED);
    // The whole phrase, not a word: a single BIP39 word ("review", "public")
    // can turn up in this JSON by chance and would make the check flaky.
    expect(JSON.stringify(store.saved)).not.toContain(realRecoveryKey);

    // The panel is closed and opened again: a NEW mount, over the same
    // worker.
    first.host.dispose();
    const second = await mountOver(w.worker);
    expect(second.fake.getSubmitBtn()?.textContent).toBe('Finish pairing');
    expect(second.fake.getHtml()).toContain(PAIR_URL);

    second.fake.fireSubmitClick();
    await vi.waitFor(() => expect(second.fake.getHtml()).toContain('data-paired'));
    expect(w.finalize).toHaveBeenCalledTimes(2);
    expect(server.calls).toHaveLength(1);
    // Finished — nothing left for a third mount to pick up.
    expect(store.saved).toBeNull();
  });

  it('Start over drops the held pairing and brings the code form back', async () => {
    const store = buildRememberingStore();
    const server = buildSingleUseServer(PAIR_CODE, SERVER_REPLY);
    const w = buildWorker({ fetch: server.fetch, store, finalize: async () => SETUP_FAILED });
    const { fake } = await mountOver(w.worker);
    fake.fireField('server-url', PAIR_URL);
    fake.fireField('pairing-code', PAIR_CODE);
    fake.fireSubmitClick();
    await vi.waitFor(() => expect(fake.getSubmitBtn()?.textContent).toBe('Finish pairing'));
    expect(fake.getHtml()).toContain('Starting over means pairing again with a new code');

    fake.fireStartOverClick();
    await vi.waitFor(() => expect(fake.getSubmitBtn()?.textContent).toBe('Pair this bridge'));
    expect(fake.getHtml()).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_CODE_ID}"`);
    // The spent code is not offered back; the URL the user typed is kept.
    expect(fake.getHtml()).not.toContain(PAIR_CODE);
    expect(fake.getHtml()).toContain(`value="${PAIR_URL}"`);
    expect(store.saved).toBeNull();

    // And a panel opened after starting over asks for a code, not to finish.
    const reopened = await mountOver(w.worker);
    expect(reopened.fake.getSubmitBtn()?.textContent).toBe('Pair this bridge');
  });

  it('a final setup error drops the pairing instead of offering a retry', async () => {
    const store = buildRememberingStore();
    const server = buildSingleUseServer(PAIR_CODE, SERVER_REPLY);
    const w = buildWorker({
      fetch: server.fetch,
      store,
      finalize: async () => ({ ok: false, error: 'pair_completion_invalid_server_url' }),
    });
    const { fake } = await mountOver(w.worker);
    fake.fireField('server-url', PAIR_URL);
    fake.fireField('pairing-code', PAIR_CODE);
    fake.fireSubmitClick();
    await vi.waitFor(() =>
      expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_handoff_final'),
    );
    expect(fake.getStatus()?.textContent).toBe(
      "Recued couldn't turn that server address into a connection. Pair again with the address your server prints and a new pairing code.",
    );
    expect(fake.getSubmitBtn()?.textContent).toBe('Pair this bridge');
    expect(store.saved).toBeNull();
  });

  it('Finish pairing with nothing held (a browser restart emptied it) says so', async () => {
    const store = buildRememberingStore();
    const server = buildSingleUseServer(PAIR_CODE, SERVER_REPLY);
    const w = buildWorker({ fetch: server.fetch, store, finalize: async () => SETUP_FAILED });
    const { fake } = await mountOver(w.worker);
    fake.fireField('server-url', PAIR_URL);
    fake.fireField('pairing-code', PAIR_CODE);
    fake.fireSubmitClick();
    await vi.waitFor(() => expect(fake.getSubmitBtn()?.textContent).toBe('Finish pairing'));

    // Chrome restarted: session storage and the worker are both gone. A
    // panel still showing "Finish pairing" now talks to a fresh worker.
    await store.clear();
    const fresh = buildWorker({ fetch: fetchThatMustNotRun, store });
    const { fake: after } = await mountOver(fresh.worker);
    expect(after.getSubmitBtn()?.textContent).toBe('Pair this bridge');

    const stale = await mountOver({ ...fresh.worker, status: async () => ({ state: 'accepted', serverUrl: PAIR_URL }) });
    stale.fake.fireSubmitClick();
    await vi.waitFor(() =>
      expect(stale.fake.getStatus()?.dataset.error).toBe('pair_code_input_handoff_lost'),
    );
    expect(stale.fake.getSubmitBtn()?.textContent).toBe('Pair this bridge');
  });
});

// ════════════════════════════════════════════════════════════════
// DD#7 — the worker pairs; the side panel asks
// ════════════════════════════════════════════════════════════════

describe('DD#7 — a panel that closes, reopens, or opens on a paired bridge', () => {
  it('⛔ closing the panel while the server answers does not lose the pairing', async () => {
    // The 0.0.1 rejection: its popup posted, closed during the ~5 s reply,
    // and lost it — the code spent, the bridge unpaired, the retry refused.
    // The side panel survives a click elsewhere, but can still be closed.
    const server = buildSingleUseServer(PAIR_CODE, SERVER_REPLY);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowServer = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(url, init);
      await gate; // the server has spent the code; its answer is in flight
      return response;
    }) as typeof fetch;
    const w = buildWorker({ fetch: slowServer });
    const first = await mountOver(w.worker);
    first.host.setFieldValue('serverUrl', PAIR_URL);
    first.host.setFieldValue('pairingCode', PAIR_CODE);
    void first.host.submit();
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    first.host.dispose(); // the user closes the panel mid-request

    release();
    await vi.waitFor(() => expect(w.finalize).toHaveBeenCalledTimes(1));
    expect(w.finalize.mock.calls[0][0]).toEqual(ACCEPTED);

    const reopened = await mountOver(w.worker);
    expect(reopened.fake.getHtml()).toContain('This bridge is paired');
    expect(reopened.fake.getHtml()).not.toContain(`id="${BRIDGE_PAIR_CODE_INPUT_CODE_ID}"`);
    expect(server.calls).toHaveLength(1);
  });

  it('a panel reopened during the request follows it to the end', async () => {
    let answer!: (r: Response) => void;
    const slow = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const w = buildWorker({ fetch: slow });
    const first = await mountOver(w.worker);
    first.host.setFieldValue('serverUrl', PAIR_URL);
    first.host.setFieldValue('pairingCode', PAIR_CODE);
    void first.host.submit();
    first.host.dispose();

    const reopened = await mountOver(w.worker);
    expect(reopened.fake.getHtml()).toContain('<h2 class="pair-code-input-title">Pairing…</h2>');
    expect(reopened.fake.getHtml()).toContain('review.example');
    expect(reopened.fake.getHtml()).toContain(BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR);
    // Nothing to send the (possibly spent) code with.
    expect(reopened.fake.getSubmitBtn()).toBeNull();
    expect(reopened.fake.getHtml()).not.toContain(`id="${BRIDGE_PAIR_CODE_INPUT_CODE_ID}"`);

    await vi.waitFor(() => expect(typeof answer).toBe('function'));
    answer({ ok: true, status: 200, json: async () => SERVER_REPLY } as unknown as Response);
    await vi.waitFor(() => expect(reopened.fake.getHtml()).toContain('data-paired'));
  });

  it('a panel reopened during the request shows the refusal it ended in', async () => {
    let answer!: (r: Response) => void;
    const slow = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const w = buildWorker({ fetch: slow });
    const first = await mountOver(w.worker);
    first.host.setFieldValue('serverUrl', PAIR_URL);
    first.host.setFieldValue('pairingCode', 'WRONG123');
    void first.host.submit();
    first.host.dispose();

    const reopened = await mountOver(w.worker);
    await vi.waitFor(() => expect(typeof answer).toBe('function'));
    answer({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'invalid_code', message: 'Invalid' } }),
    } as unknown as Response);
    await vi.waitFor(() => expect(reopened.fake.getStatus()?.dataset.error).toBe('invalid_code'));
    expect(reopened.fake.getHtml()).toContain(`id="${BRIDGE_PAIR_CODE_INPUT_CODE_ID}"`);
  });

  it('a paired bridge never shows the pair form, nor anything to send a code with', async () => {
    // The panel replaces this host with its paired sections as soon as it
    // reads the stored pair; until then, a spent code must not be asked for.
    const w = buildWorker({ paired: true });
    const { fake } = await mountOver(w.worker);
    expect(fake.getHtml()).toContain('This bridge is paired');
    expect(fake.getHtml()).toContain('review.example');
    expect(fake.getHtml()).not.toContain(`id="${BRIDGE_PAIR_CODE_INPUT_FORM_ID}"`);
    expect(fake.getSubmitBtn()).toBeNull();
  });

  it('Pair on a bridge that turned out to be paired shows it paired, and posts nothing', async () => {
    const w = buildWorker({ paired: false, fetch: fetchThatMustNotRun });
    const { fake, host } = await mountOver({
      ...w.worker,
      start: async () => ({ ok: false, kind: 'paired', serverUrl: 'wss://review.example/ws' }),
    });
    host.setFieldValue('serverUrl', PAIR_URL);
    host.setFieldValue('pairingCode', PAIR_CODE);
    await host.submit();
    expect(fake.getHtml()).toContain('This bridge is paired');
  });

  it('a second Pair while one runs follows the first instead of posting again', async () => {
    let answer!: (r: Response) => void;
    let posts = 0;
    const slow = (() => {
      posts += 1;
      return new Promise<Response>((r) => (answer = r));
    }) as unknown as typeof fetch;
    const w = buildWorker({ fetch: slow });
    const first = await mountOver(w.worker);
    first.host.setFieldValue('serverUrl', PAIR_URL);
    first.host.setFieldValue('pairingCode', PAIR_CODE);
    void first.host.submit();

    // A panel in another window (or this one, reopened) — with a form, as
    // if the worker had not been asked in time.
    const second = await mountOver({ ...w.worker, status: async () => ({ state: 'unpaired' }) });
    second.host.setFieldValue('serverUrl', PAIR_URL);
    second.host.setFieldValue('pairingCode', PAIR_CODE);
    void second.host.submit();
    await vi.waitFor(() =>
      expect(second.fake.getHtml()).toContain('<h2 class="pair-code-input-title">Pairing…</h2>'),
    );
    answer({ ok: true, status: 200, json: async () => SERVER_REPLY } as unknown as Response);
    await vi.waitFor(() => expect(second.fake.getHtml()).toContain('data-paired'));
    expect(posts).toBe(1);
  });
});
