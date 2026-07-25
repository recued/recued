/** D-156 P3 — Pair-code-input-host.
 *
 *  Covers the new 3-field pair form that replaces the D-148 § A.2.1
 *  pair-blob substrate. The pure submit function is tested against a
 *  fake `fetch` exercising the three documented modes (code-only,
 *  recovery-key-only, both); the DOM host is tested against a
 *  string-innerHTML fake DOM that wires delegated `input` / `click`
 *  via `closest()`. Same shape as the launch-wizard / reception-
 *  authoring mount tests.
 *
 *  Suite layout:
 *    - submitPairCodeInput pure function
 *      • client-side guards (no URL / no input / invalid BIP39)
 *      • mode plumbing (code-only / recovery-only / both)
 *      • server success parsing (token / serverId)
 *      • server error mapping (closed-list + fallthrough)
 *      • transport failure
 *
 *    - mountPairCodeInputHost
 *      • render → field IDs present
 *      • deeplink seed pre-fill (server URL + pairing code)
 *      • disabled gating (URL empty / recovery < 24 words / submitting)
 *      • field updates via delegated input events
 *      • paste fan-out into the 24-word grid
 *      • submit → success → onPaired
 *      • submit → server error → inline copy + data-error
 *      • dispose detaches listeners + clears DOM
 */

import { describe, it, expect, vi } from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';

import {
  mountPairCodeInputHost,
  submitPairCodeInput,
  PAIR_CODE_INPUT_ERROR_COPY,
  PAIR_CODE_INPUT_FORM_ID,
  PAIR_CODE_INPUT_SERVER_URL_ID,
  PAIR_CODE_INPUT_CODE_ID,
  PAIR_CODE_INPUT_STATUS_ID,
  PAIR_CODE_INPUT_SUBMIT_ID,
  PAIR_CODE_INPUT_RECOVERY_PREFIX,
  PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY,
  type PairCodeInputCommitResult,
} from '../auth/pair-code-input-host.js';

// ════════════════════════════════════════════════════════════════
// String-innerHTML fake DOM
// ════════════════════════════════════════════════════════════════
//
// The webclient runs vitest under the node environment — no jsdom.
// The mount host's delegated dispatcher needs `addEventListener` /
// `removeEventListener` on the splash, `closest()` on event targets,
// and `querySelector` on the splash (for the disabled-state sync +
// recovery counter). Per the launch-wizard / reception-authoring
// mount tests, we mock just those surfaces.

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
  // Track the currently-rendered button/status nodes so
  // `querySelector` returns mutable references. Re-rendered HTML
  // refreshes these from the latest string.
  let submitBtn: FakeButton | null = null;
  let statusEl: FakeStatus | null = null;
  let recoveryCounter: { textContent: string } | null = null;

  // Decode the handful of HTML entities `e()` produces so test
  // assertions can compare against the original copy strings.
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
    if (html.includes(`id="${PAIR_CODE_INPUT_SUBMIT_ID}"`)) {
      const disabled = new RegExp(
        `<button[^>]*id="${PAIR_CODE_INPUT_SUBMIT_ID}"[^>]*\\sdisabled`,
      ).test(html);
      const labelMatch = html.match(
        new RegExp(
          `<button[^>]*id="${PAIR_CODE_INPUT_SUBMIT_ID}"[^>]*>([^<]*)</button>`,
        ),
      );
      submitBtn = {
        id: PAIR_CODE_INPUT_SUBMIT_ID,
        disabled,
        textContent: labelMatch ? labelMatch[1] : '',
        dataset: { action: 'pair-code-input-submit' },
      };
    }
    if (html.includes(`id="${PAIR_CODE_INPUT_STATUS_ID}"`)) {
      const errorMatch = html.match(
        new RegExp(
          `<p\\s+id="${PAIR_CODE_INPUT_STATUS_ID}"[^>]*\\sdata-error="([^"]*)"[^>]*>([^<]*)</p>`,
        ),
      );
      const status: FakeStatus = {
        id: PAIR_CODE_INPUT_STATUS_ID,
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
      if (selector === `#${PAIR_CODE_INPUT_SUBMIT_ID}`) return submitBtn;
      if (selector === `#${PAIR_CODE_INPUT_STATUS_ID}`) return statusEl;
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
        getAttribute: (name: string) => (name === 'data-pair-code-input-field' ? kind : null),
        value,
      };
      const target = {
        closest: (selector: string) => {
          if (selector === '[data-pair-code-input-field]') return fieldEl;
          return null;
        },
      };
      fire('input', target);
    },
    fireRecoveryWord: (index: number, value: string): void => {
      const fieldEl = {
        getAttribute: (name: string) =>
          name === 'data-pair-code-input-recovery-field' ? 'recovery-word' : null,
        value,
        dataset: { index: String(index) },
      };
      const target = {
        closest: (selector: string) => {
          if (selector === '[data-pair-code-input-recovery-field]') return fieldEl;
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
          if (selector === '[data-action="pair-code-input-submit"]') {
            return {
              disabled: disabledOverride ?? btn.disabled,
            };
          }
          return null;
        },
      };
      fire('click', target);
    },
    /** Simulate the natural form-submit signal (Enter inside the
     *  form). The Codex 2026-05-18 P3 Minor #1 fold wires a `submit`
     *  listener at the splash root. */
    fireSubmit: (): void => {
      const target = { closest: () => null };
      fire('submit', target);
    },
    /** Fire a delegated click whose target resolves ONLY the given
     *  `data-action` selector (never the submit selector), driving the
     *  generate-mode mode-toggle + stage buttons. */
    fireAction: (action: string): void => {
      const selectorForAction = `[data-action="${action}"]`;
      const target = {
        closest: (selector: string) =>
          selector === selectorForAction ? { disabled: false } : null,
      };
      fire('click', target);
    },
  };
};

const recoveryValuesFromHtml = (html: string): string[] =>
  Array.from({ length: 24 }, (_, i) => {
    const match = html.match(
      new RegExp(`id="${PAIR_CODE_INPUT_RECOVERY_PREFIX}-${i}"[\\s\\S]*?value="([^"]*)"`),
    );
    return match ? match[1] : '';
  });

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

describe('submitPairCodeInput — client-side guards', () => {
  it('rejects empty server URL with pair_code_input_no_server_url', async () => {
    const result = await submitPairCodeInput({ serverUrl: '   ', code: 'ABC12345' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_no_server_url');
  });

  it('rejects when neither code nor recovery key is supplied', async () => {
    const result = await submitPairCodeInput({ serverUrl: 'http://localhost:3001' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_no_input');
  });

  it('rejects invalid BIP39 recovery key before any fetch fires', async () => {
    const fetchFake = vi.fn();
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: 'not a real mnemonic just twenty four words long enough to fill the slots zebra alpha bravo cake delta echo',
      fetch: fetchFake as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pair_code_input_invalid_recovery_key');
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

describe('submitPairCodeInput — request shape (3 modes)', () => {
  it('code-only: posts code with canonical webclient kind', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-A', message: 'ok' });
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001/',  // trailing slash is normalised
      code: 'ABC12345',
      fetch: fetchFake,
    });
    expect(result.ok).toBe(true);
    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0].url).toBe('http://localhost:3001/auth/pair');
    expect(fetchFake.calls[0].body).toEqual({
      code: 'ABC12345',
      clientKind: 'webclient',
    });
  });

  it('recovery-key-only: posts { recoveryKey }', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-B' });
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(true);
    expect(fetchFake.calls[0].body).toEqual({
      recoveryKey: realRecoveryKey,
      clientKind: 'webclient',
    });
  });

  it('both: posts { code, recoveryKey } (first-pair enrollment shape)', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-C' });
    await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      code: 'XYZ98765',
      recoveryKey: realRecoveryKey,
      instanceId: 'iid-1',
      displayName: 'MacBook',
      fetch: fetchFake,
    });
    expect(fetchFake.calls[0].body).toEqual({
      code: 'XYZ98765',
      recoveryKey: realRecoveryKey,
      instanceId: 'iid-1',
      displayName: 'MacBook',
      clientKind: 'webclient',
    });
  });

  it('preserves serverId from response when present', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-D', serverId: 'srv-42' });
    const result = await submitPairCodeInput({
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
    const result = await submitPairCodeInput({
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

describe('submitPairCodeInput — server errors', () => {
  it('maps invalid_code to the closed-list error', async () => {
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'invalid_code', message: 'Invalid, expired, or already-used pairing code' },
    });
    const result = await submitPairCodeInput({
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
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('recovery_key_invalid');
  });

  it('maps bad_request to the closed-list error', async () => {
    const fetchFake = buildFakeFetch(400, {
      error: { code: 'bad_request', message: 'code is required for the first pair on this server' },
    });
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('bad_request');
  });

  it('falls through to pair_code_input_server_unknown_error on an unknown code', async () => {
    const fetchFake = buildFakeFetch(500, {
      error: { code: 'totally_made_up', message: 'whoops' },
    });
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      recoveryKey: realRecoveryKey,
      fetch: fetchFake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('pair_code_input_server_unknown_error');
      expect(result.detail).toBe('whoops');
    }
  });

  it('falls through to pair_code_input_server_unknown_error on a 200 with no token', async () => {
    const fetchFake = buildFakeFetch(200, { not_a_token: 'oh' });
    const result = await submitPairCodeInput({
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
    const result = await submitPairCodeInput({
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
// Mount — DOM host
// ════════════════════════════════════════════════════════════════

describe('mountPairCodeInputHost — initial render', () => {
  it('renders the form id + 3 fields + status + submit', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    const html = fake.getHtml();
    expect(html).toContain(`id="${PAIR_CODE_INPUT_FORM_ID}"`);
    expect(html).toContain(`id="${PAIR_CODE_INPUT_SERVER_URL_ID}"`);
    expect(html).toContain(`id="${PAIR_CODE_INPUT_CODE_ID}"`);
    expect(html).toContain(`id="${PAIR_CODE_INPUT_STATUS_ID}"`);
    expect(html).toContain(`id="${PAIR_CODE_INPUT_SUBMIT_ID}"`);
    // 24 recovery slots — assert all index ids rendered.
    for (let i = 0; i < 24; i++) {
      expect(html).toContain(`id="${PAIR_CODE_INPUT_RECOVERY_PREFIX}-${i}"`);
    }
  });

  it('submit button starts disabled (no URL, no recovery key)', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getSubmitBtn()?.textContent).toContain('Pair this device');
    expect(fake.getHtml()).toContain(
      'Enter the server URL and paste the 24-word recovery key to continue.',
    );
  });

  it('throws when no splash element is supplied or discoverable', () => {
    const doc = { getElementById: () => null } as unknown as Document;
    expect(() =>
      mountPairCodeInputHost({
        document: doc,
        onPaired: () => undefined,
      }),
    ).toThrow(/splash element not found/);
  });
});

describe('mountPairCodeInputHost — deeplink seed', () => {
  it('pre-fills server URL + pairing code from seed', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'http://192.168.1.10:3001', pairingCode: 'ABC12345' },
      onPaired: () => undefined,
    });
    expect(fake.getHtml()).toContain('value="http://192.168.1.10:3001"');
    expect(fake.getHtml()).toContain('value="ABC12345"');
  });
});

describe('mountPairCodeInputHost — submit gating', () => {
  it('enables submit only after URL + 24 words present', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    // URL only — still disabled.
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain('Paste the 24-word recovery key to continue (0/24 words).');
    // 24 words — submit becomes enabled.
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    expect(fake.getHtml()).not.toContain('to continue');
    // Wipe URL — back to disabled.
    handle.setFieldValue('serverUrl', '');
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
  });
});

describe('mountPairCodeInputHost — field events', () => {
  it('input event on server-url updates state + the disabled gate', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    // Disabled because URL is empty.
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    // Simulate user typing into the server URL input — delegated input.
    fake.fireField('server-url', 'http://localhost:3001');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
  });

  it('input event on a single recovery slot updates that slot only (no re-render)', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    fake.fireRecoveryWord(0, 'apple');
    // No whitespace → no re-render; but the counter (which the host
    // updates directly) reflects the new state.
    expect(fake.getRecoveryCounter()?.textContent).toBe('1 of 24 words entered.');
  });

  it('whitespace-containing input pastes all 24 words across the grid', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    fake.fireRecoveryWord(0, realRecoveryKey);
    // After paste, all 24 slots filled — submit becomes the only
    // gate (URL still missing here, so submit still disabled).
    const html = fake.getHtml();
    const words = realRecoveryKey.split(/\s+/).filter((w) => w.length > 0);
    for (let i = 0; i < 24; i++) {
      expect(html).toContain(`id="${PAIR_CODE_INPUT_RECOVERY_PREFIX}-${i}"`);
      expect(html).toContain(`value="${words[i]}"`);
    }
  });

  it('does not let late-slot typing inflate earlier empty recovery slots', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    for (let i = 0; i < 20; i++) {
      fake.fireRecoveryWord(i, `word${i + 1}`);
    }

    for (const partial of ['a', 'ab', 'abc', 'abcd']) {
      fake.fireRecoveryWord(23, partial);
    }

    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getRecoveryCounter()?.textContent).toBe('21 of 24 words entered.');

    // Force a render. Pre-fix, the collapsed string state re-rendered
    // slot 24's incremental prefixes into slots 21-23.
    handle.setFieldValue('pairingCode', 'ABC12345');
    const values = recoveryValuesFromHtml(fake.getHtml());
    expect(values.slice(20, 23)).toEqual(['', '', '']);
    expect(values[23]).toBe('abcd');
  });
});

describe('mountPairCodeInputHost — submit flow', () => {
  it('successful submit invokes onPaired with the structured success result', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'realm-bearer-xyz', serverId: 'srv-1' });
    let captured: unknown = null;
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      instanceId: 'test-iid',
      displayName: 'Test device',
      fetch: fetchFake,
      onPaired: (r) => {
        captured = r;
      },
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.setFieldValue('pairingCode', 'ABC12345');
    await handle.submit();
    expect(captured).toEqual({
      serverUrl: 'http://localhost:3001',
      token: 'realm-bearer-xyz',
      serverId: 'srv-1',
      recoveryKey: realRecoveryKey,
    });
    expect(fetchFake.calls[0].body).toEqual({
      code: 'ABC12345',
      recoveryKey: realRecoveryKey,
      instanceId: 'test-iid',
      displayName: 'Test device',
      clientKind: 'webclient',
    });
  });

  it('preserves slot 24 when slots 21-23 are completed after it', async () => {
    const words = realRecoveryKey.split(/\s+/).filter((w) => w.length > 0);
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'tok-out-of-order' });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => undefined,
    });

    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    for (let i = 0; i < 20; i++) {
      fake.fireRecoveryWord(i, words[i]);
    }
    fake.fireRecoveryWord(23, words[23]);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);

    fake.fireRecoveryWord(20, words[20]);
    fake.fireRecoveryWord(21, words[21]);
    fake.fireRecoveryWord(22, words[22]);
    expect(fake.getSubmitBtn()?.disabled).toBe(false);

    await handle.submit();
    expect(fetchFake.calls[0].body).toMatchObject({
      recoveryKey: realRecoveryKey,
    });
  });

  it('server error surfaces inline copy + structured data-error', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();
    const status = fake.getStatus();
    expect(status?.dataset.error).toBe('recovery_key_invalid');
    expect(status?.textContent).toBe(PAIR_CODE_INPUT_ERROR_COPY.recovery_key_invalid);
    expect(fake.getSubmitBtn()?.disabled).toBe(false);  // re-enabled for retry
  });

  it('transport failure renders the transport-failed copy', async () => {
    const fake = makeFakeSplash();
    const fetchFake = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();
    const status = fake.getStatus();
    expect(status?.dataset.error).toBe('pair_code_input_transport_failed');
  });

  it('clicking the submit button drives the commit via delegated dispatch', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'tok' });
    let firedCount = 0;
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => {
        firedCount++;
      },
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    fake.fireSubmitClick();
    // Submit is async — wait one microtask for the fetch + onPaired.
    await new Promise((resolve) => setImmediate(resolve));
    expect(firedCount).toBe(1);
  });

  it('submit is a no-op when disabled (URL or recovery missing)', async () => {
    const fake = makeFakeSplash();
    const fetchFake = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake as unknown as typeof fetch,
      onPaired: () => undefined,
    });
    // Submit fires while disabled — no fetch.
    await handle.submit();
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('Enter-press inside the form drives submit via the delegated submit listener', async () => {
    // Codex 2026-05-18 P3 Minor fold #1 — natural-key Enter inside
    // the form should NOT reload the page, but SHOULD route through
    // the same disabled-aware doSubmit the click handler does.
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'tok-enter' });
    let firedCount = 0;
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => {
        firedCount++;
      },
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    fake.fireSubmit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(firedCount).toBe(1);
  });

  it('submit listener is a no-op when the form would otherwise be disabled', () => {
    // Enter-press while URL or recovery missing → no fetch.
    const fake = makeFakeSplash();
    const fetchFake = vi.fn();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake as unknown as typeof fetch,
      onPaired: () => undefined,
    });
    fake.fireSubmit();
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('user-edit after a server error clears the inline error in place', async () => {
    // Codex 2026-05-18 P3 Minor fold #2 — once a server error
    // surfaces, the next keystroke should clear the stale copy
    // without waiting for a full re-render.
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();
    expect(fake.getStatus()?.textContent).toBe(
      PAIR_CODE_INPUT_ERROR_COPY.recovery_key_invalid,
    );
    expect(fake.getStatus()?.dataset.error).toBe('recovery_key_invalid');
    // User starts correcting the URL — error clears in place.
    fake.fireField('server-url', 'http://localhost:3002');
    expect(fake.getStatus()?.textContent).toBe('');
    expect(fake.getStatus()?.dataset.error).toBeUndefined();
  });
});

describe('mountPairCodeInputHost — generate mode (R26.4 first-run recovery key)', () => {
  // A real, valid 24-word phrase the deterministic `generate` seam mints,
  // plus a DIFFERENT valid phrase for the mismatch case.
  const KNOWN = generateRecoveryKey().mnemonic;
  const OTHER = generateRecoveryKey().mnemonic;

  const mountGenerate = (
    fetchFake?: typeof fetch,
    onPaired?: (r: unknown) => void,
  ) => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      instanceId: 'iid-g',
      displayName: 'New device',
      ...(fetchFake ? { fetch: fetchFake } : {}),
      generate: () => KNOWN,
      onPaired: onPaired ?? (() => undefined),
    });
    return { fake, handle };
  };

  it('defaults to enter mode (the existing grid + hint render)', () => {
    const { fake } = mountGenerate();
    expect(fake.getHtml()).toContain('Every pair confirms this key');
    // The mode toggle is present with both options.
    expect(fake.getHtml()).toContain('I have a recovery key');
    expect(fake.getHtml()).toContain('Generate a new one');
  });

  it('switching to generate mode shows the Generate CTA (start stage)', () => {
    const { fake } = mountGenerate();
    fake.fireAction('pair-code-input-mode-generate');
    expect(fake.getHtml()).toContain('Generate a new recovery key');
    expect(fake.getHtml()).toContain('First time setting up this server?');
  });

  it('generate → writing reveals the 24 generated words read-only', () => {
    const { fake } = mountGenerate();
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    const html = fake.getHtml();
    expect(html).toContain('rx-recovery-words-readonly');
    expect(html).toContain("I've written it down — continue");
    // Every generated word is shown once.
    for (const w of KNOWN.split(/\s+/)) {
      expect(html).toContain(`<span>${w}</span>`);
    }
  });

  it('writing → ack reveals the re-type challenge grid', () => {
    const { fake } = mountGenerate();
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    const html = fake.getHtml();
    expect(html).toContain('Type the 24 words from your paper copy');
    // The editable challenge grid is rendered (24 slots).
    expect(html).toContain(`id="${PAIR_CODE_INPUT_RECOVERY_PREFIX}-0"`);
  });

  it('gates submit through generate stages: server URL → confirm → code → match', () => {
    const { fake, handle } = mountGenerate();
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('pairingCode', 'CODE1234');
    fake.fireAction('pair-code-input-mode-generate');
    // start stage: must generate + confirm first.
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain('Generate your recovery key and confirm it to continue.');
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    // challenging, nothing re-typed yet.
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain('Re-enter your written recovery key to confirm (0/24 words).');
    // matching re-type → enabled.
    handle.setFieldValue('recoveryKey', KNOWN);
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
  });

  it('a mismatched re-type keeps submit disabled with the mismatch reason', () => {
    const { fake, handle } = mountGenerate();
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('pairingCode', 'CODE1234');
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    handle.setFieldValue('recoveryKey', OTHER); // 24 valid words, but != KNOWN
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain('re-typed words');
  });

  it('successful generate-pair submits the GENERATED key + reports it to onPaired', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'gen-bearer', serverId: 'srv-g' });
    let captured: unknown = null;
    const { fake, handle } = mountGenerate(fetchFake, (r) => {
      captured = r;
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('pairingCode', 'CODE1234');
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    handle.setFieldValue('recoveryKey', KNOWN);
    await handle.submit();
    expect(fetchFake.calls[0].body).toEqual({
      code: 'CODE1234',
      recoveryKey: KNOWN,
      instanceId: 'iid-g',
      displayName: 'New device',
      clientKind: 'webclient',
    });
    expect(captured).toEqual({
      serverUrl: 'http://localhost:3001',
      token: 'gen-bearer',
      serverId: 'srv-g',
      recoveryKey: KNOWN,
    });
  });

  it('re-enables submit when the pairing code is typed LAST (codex HIGH fold)', () => {
    const { fake, handle } = mountGenerate();
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    handle.setFieldValue('recoveryKey', KNOWN);
    // URL + matching re-type present, but no pairing code yet → disabled.
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain('Enter the pairing code from your server console to continue.');
    // Type the code last via the delegated input — must re-sync the gate.
    fake.fireField('pairing-code', 'CODE1234');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
  });

  it('already-enrolled rejection auto-switches to enter mode + wipes the generated phrase (codex MEDIUM fold)', async () => {
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'realm already bound' },
    });
    const { fake, handle } = mountGenerate(fetchFake);
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('pairingCode', 'CODE1234');
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    handle.setFieldValue('recoveryKey', KNOWN);
    await handle.submit();
    // Steering copy + closed-list code preserved.
    const status = fake.getStatus();
    expect(status?.dataset.error).toBe('recovery_key_invalid');
    expect(status?.textContent).toBe(PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY);
    // Flipped to enter mode (the enter-grid hint is back) …
    expect(fake.getHtml()).toContain('Every pair confirms this key');
    // … and the obsolete generated phrase is gone from the grid.
    expect(recoveryValuesFromHtml(fake.getHtml()).every((v) => v === '')).toBe(true);
  });

  it('switching back to enter mode wipes the generated state (no leaked words)', () => {
    const { fake } = mountGenerate();
    fake.fireAction('pair-code-input-mode-generate');
    fake.fireAction('pair-code-input-generate');
    // The generated words are visible in writing stage.
    expect(fake.getHtml()).toContain('rx-recovery-words-readonly');
    fake.fireAction('pair-code-input-mode-enter');
    const html = fake.getHtml();
    expect(html).not.toContain('rx-recovery-words-readonly');
    for (const w of KNOWN.split(/\s+/)) {
      expect(html).not.toContain(`<span>${w}</span>`);
    }
  });
});

describe('mountPairCodeInputHost — dispose', () => {
  it('dispose clears the splash + detaches listeners', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    expect(fake.listenerCount()).toBeGreaterThan(0);
    handle.dispose();
    expect(fake.getHtml()).toBe('');
    expect(fake.listenerCount()).toBe(0);
  });

  it('post-dispose setFieldValue is a no-op', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    handle.dispose();
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    expect(fake.getHtml()).toBe('');
  });
});

describe('error copy map coverage', () => {
  it('PAIR_CODE_INPUT_ERROR_COPY covers every documented code', () => {
    // Tripwire — if a new error code is added to PairCodeInputErrorCode,
    // this assertion forces the copy table to be updated.
    const codes: Array<keyof typeof PAIR_CODE_INPUT_ERROR_COPY> = [
      'pair_code_input_no_server_url',
      'pair_code_input_no_input',
      'pair_code_input_invalid_recovery_key',
      'pair_code_input_transport_failed',
      'pair_code_input_server_unknown_error',
      'invalid_code',
      'recovery_key_invalid',
      'bad_request',
      'server_not_configured',
    ];
    for (const code of codes) {
      expect(PAIR_CODE_INPUT_ERROR_COPY[code]).toBeTruthy();
    }
  });
});

// silence unused-var lint on the type import — the assertion is in
// the test bodies, but TS sees it as type-only.
const _typeRef: PairCodeInputCommitResult | null = null;
void _typeRef;
