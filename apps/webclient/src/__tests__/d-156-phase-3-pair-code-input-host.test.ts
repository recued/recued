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
  PAIR_CODE_INPUT_STYLES,
  PAIR_CODE_INPUT_FORM_ID,
  PAIR_CODE_INPUT_SERVER_URL_ID,
  PAIR_CODE_INPUT_CODE_ID,
  PAIR_CODE_INPUT_STATUS_ID,
  PAIR_CODE_INPUT_SERVER_CODE_ATTR,
  PAIR_CODE_INPUT_SUBMIT_ID,
  PAIR_CODE_INPUT_RECOVERY_PREFIX,
  PAIR_CODE_INPUT_REAUTH_NOTICE_ATTR,
  PAIR_CODE_INPUT_RECOVERY_HELP_ATTR,
  PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR,
  PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR,
  PAIR_CODE_INPUT_RECOVERY_STOP_ATTR,
  PAIR_CODE_INPUT_RECOVERY_STOP_REENTRY_ATTR,
  PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR,
  PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ATTR,
  PAIR_CODE_INPUT_REPLACEMENT_CONFIRMED_ATTR,
  PAIR_CODE_INPUT_REPLACEMENT_NOT_FRESH_ATTR,
  PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_ATTR,
  PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_SUMMARY_ATTR,
  PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_STATUS_ATTR,
  PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ATTR,
  PAIR_CODE_INPUT_CHANGE_SERVER_ACTION,
  PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION,
  PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION,
  PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION,
  PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION,
  PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION,
  PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION,
  PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION,
  PAIR_CODE_INPUT_CONFIRM_REPLACEMENT_SERVER_ACTION,
  PAIR_CODE_INPUT_EDIT_REPLACEMENT_SERVER_ACTION,
  PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION,
  PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR,
  PAIR_CODE_INPUT_TAKEOVER_READY_ATTR,
  PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR,
  PAIR_CODE_INPUT_SUCCESSION_ATTR,
  PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR,
  PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR,
  PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR,
  PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR,
  PAIR_CODE_INPUT_RESTART_AFTER_INTERRUPTION_ACTION,
  PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY,
  PAIR_CODE_INPUT_REPLACEMENT_ALREADY_ENROLLED_COPY,
  type PairCodeInputCommitResult,
} from '../auth/pair-code-input-host.js';
import type { PairFinalizeLockProvider } from '../auth/pair-code-success.js';
import {
  PAIR_SERVER_ERROR_COPY,
  PAIR_SERVER_REFUSED_COPY,
  PAIR_SERVER_SAID_LABEL,
} from '@recued/ui-shared/pairing';

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
  focus(options?: FocusOptions): void;
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
  let recoveryCorrectionEl: { id: string; focus(): void } | null = null;
  let recoveryStopEl: { id: string; focus(): void } | null = null;
  let recoveryDiagnosticSummaryEl: { focus(): void } | null = null;
  let recoveryDiagnosticCopyEl: { focus(): void } | null = null;
  let recoveryDiagnosticStatusEl: { focus(): void } | null = null;
  let recoveryHelpEl: {
    open: boolean;
    setAttribute(name: string, value: string): void;
    querySelector(selector: string): { focus(): void } | null;
  } | null = null;
  let activeElement: unknown = null;
  const submitFocus = vi.fn();
  const recoveryFocus = vi.fn();
  const recoveryCorrectionFocus = vi.fn();
  const recoveryStopFocus = vi.fn();
  const recoveryDiagnosticSummaryFocus = vi.fn();
  const recoveryDiagnosticCopyFocus = vi.fn();
  const recoveryDiagnosticStatusFocus = vi.fn();
  const recoveryHelpSummaryFocus = vi.fn();
  const serverFocus = vi.fn();
  const serverSelect = vi.fn();
  const bootPendingRemove = vi.fn();

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
    recoveryCorrectionEl = null;
    recoveryStopEl = null;
    recoveryDiagnosticSummaryEl = null;
    recoveryDiagnosticCopyEl = null;
    recoveryDiagnosticStatusEl = null;
    recoveryHelpEl = null;
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
        focus: (options?: FocusOptions) => {
          activeElement = submitBtn;
          submitFocus(options);
        },
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
    if (html.includes(` ${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR}`)) {
      recoveryCorrectionEl = {
        id: 'webclient-pair-code-input-recovery-correction',
        focus: () => {
          activeElement = recoveryCorrectionEl;
          recoveryCorrectionFocus();
        },
      };
    }
    if (html.includes(` ${PAIR_CODE_INPUT_RECOVERY_STOP_ATTR}`)) {
      recoveryStopEl = {
        id: 'webclient-pair-code-input-recovery-stop',
        focus: () => {
          activeElement = recoveryStopEl;
          recoveryStopFocus();
        },
      };
    }
    if (html.includes(` ${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_SUMMARY_ATTR}`)) {
      recoveryDiagnosticSummaryEl = {
        focus: () => {
          activeElement = recoveryDiagnosticSummaryEl;
          recoveryDiagnosticSummaryFocus();
        },
      };
    }
    if (html.includes(
      `data-action="${PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION}"`,
    )) {
      recoveryDiagnosticCopyEl = {
        focus: () => {
          activeElement = recoveryDiagnosticCopyEl;
          recoveryDiagnosticCopyFocus();
        },
      };
    }
    if (html.includes(` ${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_STATUS_ATTR}`)) {
      recoveryDiagnosticStatusEl = {
        focus: () => {
          activeElement = recoveryDiagnosticStatusEl;
          recoveryDiagnosticStatusFocus();
        },
      };
    }
    if (html.includes(` ${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}`)) {
      const summary = { focus: recoveryHelpSummaryFocus };
      recoveryHelpEl = {
        open: false,
        setAttribute: (name: string) => {
          if (name === 'open' && recoveryHelpEl) recoveryHelpEl.open = true;
        },
        querySelector: (selector: string) =>
          selector === 'summary' ? summary : null,
      };
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
    closest: (selector: string) => selector === '[data-recued-boot-pending]'
      ? { removeAttribute: bootPendingRemove }
      : null,
    contains: (candidate: unknown) => candidate === activeElement,
    querySelector: (selector: string) => {
      if (selector === `#${PAIR_CODE_INPUT_SUBMIT_ID}`) return submitBtn;
      if (selector === `#${PAIR_CODE_INPUT_STATUS_ID}`) return statusEl;
      if (selector === '.rx-recovery-word-count') return recoveryCounter;
      if (selector === '#webclient-pair-code-input-recovery-correction') {
        return recoveryCorrectionEl;
      }
      if (selector === '#webclient-pair-code-input-recovery-stop') {
        return recoveryStopEl;
      }
      if (selector === `[${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_SUMMARY_ATTR}]`) {
        return recoveryDiagnosticSummaryEl;
      }
      if (selector === `[${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_STATUS_ATTR}]`) {
        return recoveryDiagnosticStatusEl;
      }
      if (selector === `[data-action="${PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION}"]`) {
        return recoveryDiagnosticCopyEl;
      }
      if (selector === `[${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}]`) {
        return recoveryHelpEl;
      }
      if (selector === `#${PAIR_CODE_INPUT_RECOVERY_PREFIX}-0`) {
        return { focus: recoveryFocus };
      }
      if (selector === `#${PAIR_CODE_INPUT_SERVER_URL_ID}`) {
        return { focus: serverFocus, select: serverSelect };
      }
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
    document: {
      get activeElement() {
        return activeElement;
      },
    } as unknown as Document,
    getHtml: () => html,
    getSubmitBtn: () => submitBtn,
    getStatus: () => statusEl,
    getRecoveryCounter: () => recoveryCounter,
    getRecoveryFocus: () => recoveryFocus,
    getRecoveryCorrectionFocus: () => recoveryCorrectionFocus,
    getRecoveryStopFocus: () => recoveryStopFocus,
    getRecoveryDiagnosticSummaryFocus: () => recoveryDiagnosticSummaryFocus,
    getRecoveryDiagnosticCopyFocus: () => recoveryDiagnosticCopyFocus,
    getRecoveryDiagnosticStatusFocus: () => recoveryDiagnosticStatusFocus,
    getRecoveryHelpSummaryFocus: () => recoveryHelpSummaryFocus,
    isRecoveryCorrectionFocused: () => activeElement === recoveryCorrectionEl,
    isRecoveryStopFocused: () => activeElement === recoveryStopEl,
    isRecoveryHelpOpen: () => recoveryHelpEl?.open === true,
    getServerFocus: () => serverFocus,
    getServerSelect: () => serverSelect,
    getBootPendingRemove: () => bootPendingRemove,
    getSubmitFocus: () => submitFocus,
    focusSubmit: () => submitBtn?.focus(),
    isSubmitFocused: () => activeElement === submitBtn,
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

/** FIFO stand-in for the browser's same-origin exclusive Web Lock. Sharing one
 * instance between mounted hosts makes their submit callbacks contend exactly
 * as sibling tabs do, while keeping the winner deterministic for assertions. */
const buildExclusivePairLock = (): PairFinalizeLockProvider => {
  let tail: Promise<void> = Promise.resolve();
  return {
    request<T>(
      _name: string,
      _options: { mode: 'exclusive' },
      callback: () => Promise<T>,
    ): Promise<T> {
      const run = tail.then(
        () => callback(),
        () => callback(),
      );
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
};

/** Minimal complete capability set for tests focused on the earlier takeover
 * stages rather than owner-loss election itself. A null claim means another
 * tab would retain the successor lease if the bounded owner timer fired. */
const recoverySuccessorTestSeams = () => ({
  claimRecoverySuccessor: async () => null,
  onRecoverySuccessorChosen: () => undefined,
});

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
    if (!result.ok) {
      expect(result.error).toBe('pair_code_input_invalid_recovery_key');
      expect(PAIR_CODE_INPUT_ERROR_COPY[result.error]).toContain(
        'do not form a valid recovery key',
      );
      expect(PAIR_CODE_INPUT_ERROR_COPY[result.error]).not.toContain(
        'does not match this server',
      );
    }
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

  it('removes grouping whitespace from a pasted pairing code', async () => {
    const fetchFake = buildFakeFetch(200, { token: 'tok-spaced' });
    const result = await submitPairCodeInput({
      serverUrl: 'http://localhost:3001',
      code: '  ABCD  12\t34\n',
      fetch: fetchFake,
    });

    expect(result.ok).toBe(true);
    expect(fetchFake.calls[0].body).toEqual({
      code: 'ABCD1234',
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

  // D-212 tail #6 — this used to assert `pair_code_input_server_unknown_error`,
  // whose copy tells the user to "Check the URL and try again". The URL is
  // exactly what is NOT wrong here: the request reached the right server and
  // it answered in the right shape. An unmapped code now carries the server's
  // own message through instead.
  it('carries the server’s own message through on an unmapped code', async () => {
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
      expect(result.error).toBe('pair_code_input_server_refused');
      expect(result.detail).toBe('whoops');
      expect(result.serverSaid).toBe('whoops');
      expect(result.serverCode).toBe('totally_made_up');
      expect(PAIR_CODE_INPUT_ERROR_COPY[result.error]).not.toMatch(/check the url/i);
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
  it('keeps pairing inputs full-sized on desktop and narrow screens', () => {
    expect(PAIR_CODE_INPUT_STYLES).toMatch(
      /\.pair-code-input-form input\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(PAIR_CODE_INPUT_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.pair-code-input-form input,[\s\S]*?\{[^}]*min-height:\s*44px;/s,
    );
  });

  it('keeps recovery-generation actions full-sized', () => {
    expect(PAIR_CODE_INPUT_STYLES).toMatch(
      /\.pair-code-input-secondary-btn\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(PAIR_CODE_INPUT_STYLES).toMatch(
      /\.pair-code-input-linkbtn\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(PAIR_CODE_INPUT_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.pair-code-input-secondary-btn,[\s\S]*?\.pair-code-input-linkbtn\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

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

  it('confirms a same-origin resume, locks its URL, and advances to recovery', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        pairingCode: 'PAIR5678',
        sameOriginResume: true,
      },
      onPaired: () => undefined,
    });

    expect(fake.getHtml()).toContain(
      ` ${PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ATTR}`,
    );
    expect(fake.getHtml()).toContain('Secure address carried over');
    expect(fake.getHtml()).toContain(
      "Recued will pair with this page's own address:",
    );
    expect(fake.getHtml()).toContain('Your pairing code is ready too.');
    expect(fake.getHtml()).toContain('(carried over)');
    expect(fake.getHtml()).toContain(
      'Changing servers also clears any pairing code.',
    );
    expect(fake.getHtml()).not.toContain('Enter its URL');
    expect(fake.getHtml()).toMatch(
      new RegExp(
        `id="${PAIR_CODE_INPUT_SERVER_URL_ID}"[\\s\\S]*?readonly[\\s\\S]*?aria-describedby="webclient-pair-code-input-secure-resume-notice"`,
      ),
    );
    expect(fake.getRecoveryFocus()).toHaveBeenCalledOnce();

    fake.fireAction(PAIR_CODE_INPUT_CHANGE_SERVER_ACTION);
    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ATTR,
    );
    expect(fake.getHtml()).not.toMatch(
      new RegExp(
        `id="${PAIR_CODE_INPUT_SERVER_URL_ID}"[\\s\\S]*?readonly`,
      ),
    );
    expect(fake.getHtml()).toContain(
      'value="https://alice.recued.cloud:8443"',
    );
    expect(fake.getHtml()).toContain(`id="${PAIR_CODE_INPUT_CODE_ID}"`);
    expect(fake.getHtml()).not.toContain('value="PAIR5678"');
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getServerSelect()).toHaveBeenCalledOnce();
  });
});

describe('mountPairCodeInputHost — guided reauthorization', () => {
  it('turns a valid-but-rejected recovery key into a focused correction loop', async () => {
    const fake = makeFakeSplash();
    const recoveryDiagnosticWriter = vi.fn(async (_summary: string) => undefined);
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      fetch: fetchFake,
      recoveryDiagnosticWriter,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR,
    );
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR);
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_HELP_ATTR);

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(fake.getStatus()?.dataset.error).toBe('recovery_key_invalid');
    expect(fake.getHtml()).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR}`,
    );
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR);
    expect(fake.getHtml()).toContain('Check the server and recovery key');
    expect(fake.getHtml()).toContain(
      'The 24 words passed Recued’s format check.',
    );
    expect(fake.getHtml()).toContain(
      '<code>https://alice.recued.cloud:8443</code>',
    );
    expect(fake.getHtml()).toContain(
      'A fresh pairing code cannot make a different recovery key match.',
    );
    expect(fake.getHtml()).toContain(
      `data-action="${PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION}"`,
    );
    expect(fake.getHtml()).toContain(
      `data-action="${PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION}"`,
    );
    expect(fake.getHtml()).toContain(
      `data-action="${PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION}"`,
    );
    expect(fake.getRecoveryCorrectionFocus()).toHaveBeenCalledOnce();
    expect(fake.isRecoveryCorrectionFocused()).toBe(true);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain(
      'Review the server address or re-enter the recovery key before retrying.',
    );
    expect(recoveryValuesFromHtml(fake.getHtml()).join(' ')).toBe(
      realRecoveryKey,
    );

    // A fresh one-time code cannot repair a key mismatch, so editing it must
    // not dismiss the actual problem or imply that the form is corrected.
    fake.fireField('pairing-code', 'FRESH-CODE');
    expect(fake.getStatus()?.dataset.error).toBe('recovery_key_invalid');
    expect(fake.getHtml()).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR}`,
    );
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    await handle.submit();
    expect(fetchFake.calls).toHaveLength(1);

    fake.fireAction(PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION);
    expect(fake.isRecoveryHelpOpen()).toBe(true);
    expect(fake.getRecoveryHelpSummaryFocus()).toHaveBeenCalledOnce();
    expect(recoveryValuesFromHtml(fake.getHtml()).join(' ')).toBe(
      realRecoveryKey,
    );

    fake.fireAction(PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION);
    expect(fake.getHtml()).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR}`,
    );
    expect(fake.getStatus()?.dataset.error).toBe('recovery_key_invalid');
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getServerSelect()).toHaveBeenCalledOnce();
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(recoveryValuesFromHtml(fake.getHtml()).join(' ')).toBe(
      realRecoveryKey,
    );

    fake.fireField('server-url', 'https://alice.recued.cloud:8443');
    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR,
    );
    expect(fake.getStatus()?.dataset.error).toBeUndefined();
    expect(fake.getSubmitBtn()?.disabled).toBe(false);

    await handle.submit();
    expect(fetchFake.calls).toHaveLength(2);
    expect(fake.isRecoveryCorrectionFocused()).toBe(true);
    expect(fake.getHtml()).toContain(` ${PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR}`);
    expect(fake.getHtml()).toContain('Wrong server or wrong saved key?');
    expect(fake.getHtml()).toContain(
      'Recued has now received 2 rejections for format-valid 24-word entries in this tab.',
    );
    expect(fake.getHtml()).toContain(
      'This address matches the scheme, hostname, and port this browser used before recovery:',
    );
    expect(fake.getHtml()).toContain('Check the server');
    expect(fake.getHtml()).toContain('Check the saved key');
    expect(fake.getHtml()).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_ATTR}`,
    );
    expect(fake.getHtml()).toContain(
      'Details to share with the server owner',
    );
    expect(fake.getHtml()).toContain(
      'Format-valid key rejections in this tab: 2',
    );
    expect(fake.getHtml()).toContain(
      'Previously paired server origin: https://alice.recued.cloud:8443',
    );
    expect(fake.getHtml()).not.toContain(
      `data-action="${PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION}"`,
    );
    expect(recoveryDiagnosticWriter).not.toHaveBeenCalled();

    fake.fireAction(PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION);
    await vi.waitFor(() => {
      expect(recoveryDiagnosticWriter).toHaveBeenCalledOnce();
      expect(fake.getHtml()).toContain(
        'Safe diagnostic copied. Nothing was sent automatically.',
      );
    });
    const copiedDiagnostic = recoveryDiagnosticWriter.mock.calls[0]?.[0] ?? '';
    expect(copiedDiagnostic).toContain(
      'Latest server origin tried: https://alice.recued.cloud:8443',
    );
    expect(copiedDiagnostic).toContain(
      'Origin comparison: matches previously paired origin',
    );
    expect(copiedDiagnostic).not.toContain(realRecoveryKey);
    expect(copiedDiagnostic).not.toContain('FRESH-CODE');
    expect(fake.getRecoveryDiagnosticStatusFocus()).toHaveBeenCalledOnce();
    expect(fake.getRecoveryDiagnosticCopyFocus()).toHaveBeenCalledOnce();
    fake.getRecoveryFocus().mockClear();

    fake.fireAction(PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION);
    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR,
    );
    expect(recoveryValuesFromHtml(fake.getHtml())).toEqual(
      Array.from({ length: 24 }, () => ''),
    );
    expect(fake.getRecoveryFocus()).toHaveBeenCalledOnce();
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    handle.dispose();
  });

  it('stops safely when no usable original key remains and resumes only by an explicit path', async () => {
    const fake = makeFakeSplash();
    const recoveryDiagnosticWriter = vi.fn(async (_summary: string) => undefined);
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const serverUrl = 'https://alice.recued.cloud:8443/private?session=local';
    const pairingCode = 'PAIR-SECRET';
    const onRecoveryCheckpointChange = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: { serverUrl, pairingCode },
      reauthRecovery: { chatDraftPreserved: true },
      fetch: fetchFake,
      recoveryDiagnosticWriter,
      onRecoveryCheckpointChange,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();
    handle.setFieldValue('serverUrl', serverUrl);
    await handle.submit();
    expect(fake.getHtml()).toContain(` ${PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR}`);
    expect(fake.getHtml()).toContain(
      '>I confirmed the server — I can’t find the key</button>',
    );

    fake.fireAction(PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION);
    expect(onRecoveryCheckpointChange).toHaveBeenLastCalledWith('safe_stop');

    const pausedHtml = fake.getHtml();
    expect(pausedHtml).toContain(` ${PAIR_CODE_INPUT_RECOVERY_STOP_ATTR}`);
    expect(pausedHtml).toContain('Recovery paused safely');
    expect(pausedHtml).toContain('Ask the person who manages this server');
    expect(pausedHtml).toContain(
      'No pairing request is running, and this tab will not send another one unless you explicitly resume.',
    );
    expect(pausedHtml).toContain(
      '<code>https://alice.recued.cloud:8443</code>',
    );
    expect(pausedHtml).toContain('Confirmed server origin');
    expect(pausedHtml).toContain(
      'This shareable origin omits any path or sign-in details.',
    );
    expect(pausedHtml).toContain(
      'The rejected recovery words and pairing code were cleared from this form.',
    );
    expect(pausedHtml).toContain(
      'Your exact page and unsent Chat draft are still held here.',
    );
    expect(pausedHtml).toContain(
      'Do not generate a replacement key, guess words, or keep retrying.',
    );
    expect(pausedHtml).toContain(
      `data-action="${PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION}"`,
    );
    expect(pausedHtml).toContain(
      `data-action="${PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION}"`,
    );
    expect(pausedHtml).toMatch(
      /class="pair-code-input-fields" hidden aria-hidden="true"/,
    );
    expect(pausedHtml).toMatch(
      /class="pair-code-input-actions" hidden aria-hidden="true"/,
    );
    expect(pausedHtml).toMatch(
      new RegExp(`${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_ATTR}[^>]*open`),
    );
    expect(recoveryValuesFromHtml(pausedHtml)).toEqual(
      Array.from({ length: 24 }, () => ''),
    );
    expect(pausedHtml).not.toContain(pairingCode);
    expect(pausedHtml).not.toContain('/private');
    expect(pausedHtml).not.toContain('session=local');
    expect(fake.getRecoveryStopFocus()).toHaveBeenCalledOnce();
    expect(fake.isRecoveryStopFocused()).toBe(true);
    expect(fetchFake.calls).toHaveLength(2);
    expect(recoveryDiagnosticWriter).not.toHaveBeenCalled();

    // Hidden controls and the public test seam are both inert while paused;
    // the stop is stateful, not merely explanatory copy over a live form.
    handle.setFieldValue('pairingCode', 'SHOULD-NOT-STICK');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();
    expect(fetchFake.calls).toHaveLength(2);
    expect(fake.getHtml()).not.toContain('SHOULD-NOT-STICK');
    expect(recoveryValuesFromHtml(fake.getHtml())).toEqual(
      Array.from({ length: 24 }, () => ''),
    );

    fake.fireAction(PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION);
    await vi.waitFor(() => {
      expect(recoveryDiagnosticWriter).toHaveBeenCalledOnce();
      expect(fake.getHtml()).toContain(
        'Safe owner handoff copied. Nothing was sent automatically.',
      );
    });
    const ownerHandoff = recoveryDiagnosticWriter.mock.calls[0]?.[0] ?? '';
    expect(ownerHandoff).toContain(
      'Requested owner check: confirm this server origin and whether the server was replaced or reset; do not request the recovery key',
    );
    expect(ownerHandoff).toContain(
      'Latest server origin tried: https://alice.recued.cloud:8443',
    );
    expect(ownerHandoff).not.toContain(realRecoveryKey);
    expect(ownerHandoff).not.toContain(pairingCode);
    expect(ownerHandoff).not.toContain('/private');
    expect(ownerHandoff).not.toContain('session=local');

    fake.fireAction(PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION);
    expect(onRecoveryCheckpointChange).toHaveBeenLastCalledWith(
      'replacement_server',
    );
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_STOP_ATTR);
    expect(fake.getHtml()).toContain('Review the current server');
    expect(fake.getHtml()).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR}`,
    );
    expect(fake.getHtml()).toContain('Use a fresh code from the current server');
    expect(fake.getHtml()).toContain(
      'The recovery-key step stays hidden until you review the server.',
    );
    expect(fake.getHtml()).not.toContain(`value="${serverUrl}"`);
    expect(fake.getHtml()).not.toContain(pairingCode);
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getServerSelect()).toHaveBeenCalledOnce();
    expect(fake.getSubmitBtn()?.disabled).toBe(true);

    handle.setFieldValue('serverUrl', serverUrl);
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();
    expect(fetchFake.calls).toHaveLength(2);
    expect(recoveryValuesFromHtml(fake.getHtml())).toEqual(
      Array.from({ length: 24 }, () => ''),
    );
    expect(fake.getHtml()).not.toContain(realRecoveryKey);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    handle.dispose();
  });

  it('re-enters a safe stop without restoring inputs, rejection details, or a draft', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, {
      token: 'must-not-be-reached',
    });
    const onRecoveryCheckpointChange = vi.fn();
    const serverSecret =
      'https://operator:secret@old.recued.cloud/private?token=old';
    const codeSecret = 'STALE-CODE';
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: { serverUrl: serverSecret, pairingCode: codeSecret },
      reauthRecovery: {
        chatDraftPreserved: false,
        recoveryReentry: true,
        safeStopReentry: true,
      },
      fetch: fetchFake,
      onRecoveryCheckpointChange,
      onPaired: () => undefined,
    });

    const pausedHtml = fake.getHtml();
    expect(pausedHtml).toContain(` ${PAIR_CODE_INPUT_RECOVERY_STOP_ATTR}`);
    expect(pausedHtml).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_STOP_REENTRY_ATTR}`,
    );
    expect(pausedHtml).toContain('Recovery still paused');
    expect(pausedHtml).toContain('What did the server owner confirm?');
    expect(pausedHtml).toContain('No recovery material was restored');
    expect(pausedHtml).toContain(
      'Leaving this page or reloading ended any in-memory Chat draft.',
    );
    expect(pausedHtml).toContain('The server changed or was reset');
    expect(pausedHtml).not.toContain(PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_ATTR);
    expect(pausedHtml).not.toContain(PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR);
    expect(pausedHtml).not.toContain('Format-valid key rejections');
    expect(pausedHtml).not.toContain(serverSecret);
    expect(pausedHtml).not.toContain('old.recued.cloud');
    expect(pausedHtml).not.toContain(codeSecret);
    expect(recoveryValuesFromHtml(pausedHtml)).toEqual(
      Array.from({ length: 24 }, () => ''),
    );
    expect(fake.getRecoveryStopFocus()).toHaveBeenCalledOnce();
    expect(fake.isRecoveryStopFocused()).toBe(true);

    await handle.submit();
    expect(fetchFake.calls).toHaveLength(0);

    fake.fireAction(PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION);
    const resumedHtml = fake.getHtml();
    expect(onRecoveryCheckpointChange).toHaveBeenCalledOnce();
    expect(onRecoveryCheckpointChange).toHaveBeenCalledWith('unresolved');
    expect(resumedHtml).not.toContain(PAIR_CODE_INPUT_RECOVERY_STOP_ATTR);
    expect(resumedHtml).toContain(
      ` ${PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR}`,
    );
    expect(resumedHtml).toContain('Original key ready');
    expect(resumedHtml).toContain(
      'Enter the current server address, then enter its original 24-word key',
    );
    expect(resumedHtml).not.toContain(serverSecret);
    expect(resumedHtml).not.toContain(codeSecret);
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    handle.dispose();
  });

  it('reviews an admin-confirmed replacement before creating a fresh key and reports verified context', async () => {
    const fake = makeFakeSplash();
    const freshRecoveryKey = generateRecoveryKey().mnemonic;
    const fetchFake = buildFakeFetch(200, {
      token: 'replacement-bearer',
      token_id: 'replacement-token-id',
      serverId: 'replacement-server-id',
    });
    const onPaired = vi
      .fn()
      .mockRejectedValueOnce(new Error('replacement browser save stopped'))
      .mockResolvedValueOnce(undefined);
    const onAfterPair = vi.fn(async () => undefined);
    const onRecoveryCheckpointChange = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: {
        serverUrl: 'https://old.example/private',
        pairingCode: 'STALE-OLD-CODE',
      },
      reauthRecovery: {
        chatDraftPreserved: false,
        recoveryReentry: true,
        replacementServerReentry: true,
      },
      generate: () => freshRecoveryKey,
      fetch: fetchFake,
      onRecoveryCheckpointChange,
      onPaired,
      onAfterPair,
    });

    expect(fake.getHtml()).toContain('Review the current server');
    expect(fake.getHtml()).toContain('Use a fresh code from the current server');
    expect(fake.getHtml()).not.toContain('old.example');
    expect(fake.getHtml()).not.toContain('STALE-OLD-CODE');
    expect(fake.getHtml()).not.toContain(realRecoveryKey);
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    expect(fake.getHtml()).not.toContain(realRecoveryKey);

    const enteredAddress =
      'https://operator:secret@current.example:9443/private?token=hidden';
    handle.setFieldValue('serverUrl', enteredAddress);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain(
      'Enter a fresh pairing code from the current server terminal.',
    );
    handle.setFieldValue('pairingCode', 'FRESH-CODE-1');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);

    // Editing the destination invalidates its code so details from two
    // different servers cannot be reviewed together.
    handle.setFieldValue('serverUrl', `${enteredAddress}&changed=1`);
    expect(fake.getHtml()).not.toContain('FRESH-CODE-1');
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    handle.setFieldValue('pairingCode', 'FRESH-CODE-2');
    await handle.submit();

    const reviewHtml = fake.getHtml();
    expect(fetchFake.calls).toHaveLength(0);
    expect(reviewHtml).toContain(` ${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ATTR}`);
    expect(reviewHtml).toContain('Confirm this is the current server');
    expect(reviewHtml).toContain('<code>https://current.example:9443</code>');
    expect(reviewHtml).toContain(
      'Pairing does not restore missing data.',
    );
    expect(reviewHtml).toContain(
      'Recued verifies and saves the server’s signed identity',
    );
    expect(reviewHtml).not.toContain('operator');
    expect(reviewHtml).not.toContain('secret');
    expect(reviewHtml).not.toContain('/private');
    expect(reviewHtml).not.toContain('FRESH-CODE-2');
    expect(reviewHtml).not.toContain(realRecoveryKey);

    fake.fireAction(PAIR_CODE_INPUT_CONFIRM_REPLACEMENT_SERVER_ACTION);
    const confirmedHtml = fake.getHtml();
    expect(onRecoveryCheckpointChange).toHaveBeenLastCalledWith(
      'replacement_server',
    );
    expect(confirmedHtml).toContain(
      ` ${PAIR_CODE_INPUT_REPLACEMENT_CONFIRMED_ATTR}`,
    );
    expect(confirmedHtml).toContain('Fresh start confirmed for this server');
    expect(confirmedHtml).toContain(
      'The old server’s key cannot be entered in this path',
    );
    expect(confirmedHtml).toContain('Generate a new recovery key');
    expect(confirmedHtml).not.toContain('FRESH-CODE-2');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);

    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    handle.setFieldValue('recoveryKey', freshRecoveryKey);
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0]?.url).toBe(
      'https://current.example:9443/auth/pair',
    );
    expect(fetchFake.calls[0]?.body).toMatchObject({
      code: 'FRESH-CODE-2',
      recoveryKey: freshRecoveryKey,
    });
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://current.example:9443',
      recoveryKey: freshRecoveryKey,
      recoveryContext: 'fresh_replacement',
    }));
    expect(fake.getHtml()).toContain('Finish saving server access');
    expect(fake.getSubmitBtn()?.textContent).toBe('Finish saving access');
    expect(fake.getHtml()).toContain(
      'The current server accepted the fresh pairing code.',
    );
    expect(fake.getHtml()).toContain(
      'any visible retry finishes only this browser’s save',
    );
    expect(fake.getHtml()).toContain(
      'The new recovery key already belongs to this server.',
    );
    expect(fake.getHtml()).toContain(
      'Recued will not send the pairing request again.',
    );
    expect(fake.getHtml()).not.toContain(
      'A fresh pairing code from that server is ready',
    );

    await handle.submit();
    expect(fetchFake.calls).toHaveLength(1);
    expect(onPaired).toHaveBeenCalledTimes(2);
    expect(onPaired.mock.calls[1]?.[0]).toEqual(onPaired.mock.calls[0]?.[0]);
    expect(onAfterPair).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('uses an administrator-confirmed restored-realm key directly from review', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, {
      token: 'restored-realm-bearer',
      token_id: 'restored-realm-token-id',
    });
    const onPaired = vi.fn();
    const onRecoveryCheckpointChange = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      reauthRecovery: {
        chatDraftPreserved: false,
        recoveryReentry: true,
        replacementServerReentry: true,
      },
      fetch: fetchFake,
      onRecoveryCheckpointChange,
      onPaired,
    });

    handle.setFieldValue('serverUrl', 'https://restored.example:9443');
    handle.setFieldValue('pairingCode', 'RESTORED-CODE');
    await handle.submit();
    expect(fake.getHtml()).toContain(
      `data-action="${PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION}"`,
    );
    expect(fake.getHtml()).toContain('Use a confirmed existing key');
    expect(fetchFake.calls).toHaveLength(0);

    fake.fireAction(PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION);
    const existingKeyHtml = fake.getHtml();
    expect(onRecoveryCheckpointChange).toHaveBeenLastCalledWith(
      'replacement_server',
    );
    expect(existingKeyHtml).toContain('Verify the current server');
    expect(existingKeyHtml).toContain('Use only this current server’s key');
    expect(existingKeyHtml).toContain('Current server recovery key');
    expect(existingKeyHtml).not.toContain('Generate a new recovery key');
    expect(fake.getRecoveryFocus()).toHaveBeenCalledOnce();

    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0]?.url).toBe(
      'https://restored.example:9443/auth/pair',
    );
    expect(fetchFake.calls[0]?.body).toMatchObject({
      code: 'RESTORED-CODE',
      recoveryKey: realRecoveryKey,
    });
    expect(onPaired).toHaveBeenCalledWith(expect.not.objectContaining({
      recoveryContext: 'fresh_replacement',
    }));
    handle.dispose();
  });

  it('stops a fresh-server branch when the current server is already enrolled', async () => {
    const fake = makeFakeSplash();
    const freshRecoveryKey = generateRecoveryKey().mnemonic;
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'realm already bound' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      reauthRecovery: {
        chatDraftPreserved: false,
        recoveryReentry: true,
        replacementServerReentry: true,
      },
      generate: () => freshRecoveryKey,
      fetch: fetchFake,
      onPaired: () => undefined,
    });

    handle.setFieldValue('serverUrl', 'https://current.example:9443');
    handle.setFieldValue('pairingCode', 'FRESH-CODE');
    await handle.submit();
    fake.fireAction(PAIR_CODE_INPUT_CONFIRM_REPLACEMENT_SERVER_ACTION);
    fake.fireAction('pair-code-input-generate');
    fake.fireAction('pair-code-input-generate-ack');
    handle.setFieldValue('recoveryKey', freshRecoveryKey);
    await handle.submit();

    const stoppedHtml = fake.getHtml();
    expect(stoppedHtml).toContain(
      ` ${PAIR_CODE_INPUT_REPLACEMENT_NOT_FRESH_ATTR}`,
    );
    expect(stoppedHtml).toContain(PAIR_CODE_INPUT_REPLACEMENT_ALREADY_ENROLLED_COPY);
    expect(stoppedHtml).toContain('This server is already set up');
    expect(stoppedHtml).toContain('I have this server’s existing key');
    expect(stoppedHtml).not.toContain(freshRecoveryKey);

    fake.fireAction(PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION);
    expect(fake.getHtml()).toContain('Use only this current server’s key');
    expect(recoveryValuesFromHtml(fake.getHtml())).toEqual(
      Array.from({ length: 24 }, () => ''),
    );
    handle.dispose();
  });

  it('triages a changed server separately and shares no recovery material', async () => {
    const fake = makeFakeSplash();
    const recoveryDiagnosticWriter = vi.fn(async (_summary: string) => {
      throw new Error('clipboard denied');
    });
    const fetchFake = buildFakeFetch(401, {
      error: {
        code: 'recovery_key_invalid',
        message: 'RAW SERVER DETAIL MUST STAY LOCAL',
      },
    });
    const previouslyPairedAddress =
      'https://alice.recued.cloud:8443/private?session=saved#route';
    const currentAddress =
      'https://operator:password@other.recued.cloud:9443/private?token=current#route';
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: { serverUrl: previouslyPairedAddress },
      reauthRecovery: { chatDraftPreserved: true },
      fetch: fetchFake,
      recoveryDiagnosticWriter,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();
    fake.fireField('server-url', currentAddress);
    fake.fireField('pairing-code', 'PAIR-SECRET');
    await handle.submit();

    const html = fake.getHtml();
    expect(html).toContain(` ${PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR}`);
    expect(html).toContain(
      'This form is trying <code>https://other.recued.cloud:9443</code>',
    );
    expect(html).toContain(
      'this browser previously used <code>https://alice.recued.cloud:8443</code>',
    );
    expect(html).toContain('The scheme, hostname, or port is different.');
    expect(html).toContain(
      'Using the previously paired address keeps the 24 words here and clears the pairing code because codes belong to one server.',
    );
    expect(html).toContain(
      `data-action="${PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION}"`,
    );

    fake.fireAction(PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION);
    await vi.waitFor(() => {
      expect(recoveryDiagnosticWriter).toHaveBeenCalledOnce();
      expect(fake.getHtml()).toContain('Copy is unavailable here.');
    });
    const shared = recoveryDiagnosticWriter.mock.calls[0]?.[0] ?? '';
    expect(shared).toContain(
      'Latest server origin tried: https://other.recued.cloud:9443',
    );
    expect(shared).toContain(
      'Previously paired server origin: https://alice.recued.cloud:8443',
    );
    expect(shared).toContain(
      'Origin comparison: differs from previously paired origin',
    );
    expect(shared).not.toContain('operator');
    expect(shared).not.toContain('password');
    expect(shared).not.toContain('/private');
    expect(shared).not.toContain('session=saved');
    expect(shared).not.toContain('token=current');
    expect(shared).not.toContain('PAIR-SECRET');
    expect(shared).not.toContain(realRecoveryKey);
    expect(shared).not.toContain('RAW SERVER DETAIL MUST STAY LOCAL');
    expect(fake.getRecoveryDiagnosticStatusFocus()).toHaveBeenCalledOnce();
    expect(fake.getRecoveryDiagnosticSummaryFocus()).toHaveBeenCalledOnce();

    fake.fireAction(PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION);
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR);
    expect(fake.getStatus()?.dataset.error).toBeUndefined();
    expect(fake.getHtml()).toContain(`value="${previouslyPairedAddress}"`);
    expect(fake.getHtml()).not.toContain('value="PAIR-SECRET"');
    expect(recoveryValuesFromHtml(fake.getHtml()).join(' ')).toBe(
      realRecoveryKey,
    );
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getServerSelect()).toHaveBeenCalledOnce();
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    handle.dispose();
  });

  it('drops a stale diagnostic copy receipt after correction resumes', async () => {
    const fake = makeFakeSplash();
    let releaseWriter!: () => void;
    let writerSettled = false;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const recoveryDiagnosticWriter = vi.fn(async (_summary: string) => {
      await writerGate;
      writerSettled = true;
    });
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const serverUrl = 'https://alice.recued.cloud:8443';
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: { serverUrl },
      reauthRecovery: { chatDraftPreserved: true },
      fetch: fetchFake,
      recoveryDiagnosticWriter,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();
    handle.setFieldValue('serverUrl', serverUrl);
    await handle.submit();
    expect(fake.getHtml()).toContain(` ${PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR}`);

    fake.fireAction(PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION);
    expect(recoveryDiagnosticWriter).toHaveBeenCalledOnce();
    expect(fake.getHtml()).toContain('Copying the reviewed summary…');

    // Correction invalidates the reviewed summary while the clipboard is
    // pending. Its later completion must not announce success against the
    // corrected form or the next rejection's newly generated diagnostic.
    fake.fireField('server-url', serverUrl);
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR);
    releaseWriter();
    await vi.waitFor(() => expect(writerSettled).toBe(true));
    await Promise.resolve();
    expect(fake.getHtml()).not.toContain('Safe diagnostic copied.');

    await handle.submit();
    expect(fetchFake.calls).toHaveLength(3);
    expect(fake.getHtml()).toContain(
      'Format-valid key rejections in this tab: 3',
    );
    expect(fake.getHtml()).toContain('Copy safe diagnostic');
    expect(fake.getHtml()).not.toContain('Safe diagnostic copied.');
    handle.dispose();
  });

  it('resumes a lost recovery document without restoring secrets or stale wait copy', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      reauthRecovery: {
        chatDraftPreserved: false,
        recoveryReentry: true,
      },
      onPaired: () => undefined,
    });

    const html = fake.getHtml();
    expect(html).toContain(` ${PAIR_CODE_INPUT_REAUTH_NOTICE_ATTR}`);
    expect(html).toContain('Recovery resumed in this tab');
    expect(html).toContain('You do not need to wait for that page.');
    expect(html).toContain(
      'The exact page you were returning to is still selected.',
    );
    expect(html).toContain(
      'Pairing details are not restored',
    );
    expect(html).toContain(
      're-enter any missing server address, pairing code, and recovery key',
    );
    expect(html).toContain(` ${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}`);
    expect(html).toContain(
      'Start with the server address, then enter your existing 24-word recovery key.',
    );
    expect(html).toContain('Need help finding these details?');
    expect(html).toContain('<code>recued pair</code>');
    expect(html).toContain('Prefer one beginning with <code>https://</code>');
    expect(html).toContain(
      '<code>http://localhost</code> address is only for reconnecting on that same computer',
    );
    expect(html).toContain('does not save a readable copy of those words');
    expect(html).toContain('fresh pairing code cannot replace the key');
    expect(html).toContain(
      'Stop here instead of generating a new one for this server.',
    );
    expect(html).toContain('ask where the recovery key was saved');
    expect(html).toContain(
      'Never send the key through support, email, or Chat.',
    );
    expect(html).not.toContain('another tab is reconnecting');
    expect(html).not.toContain('Waiting for other tab');
    expect(html).not.toContain('Generate a new one');
    expect(html).not.toContain('Restore a backup');
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getBootPendingRemove()).toHaveBeenCalledWith(
      'data-recued-boot-pending',
    );
    expect(fake.getSubmitBtn()?.textContent).toContain(
      'Reconnect this browser',
    );
  });

  it('explains the interruption, preserves return context, and narrows the ceremony to an existing key', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      onPaired: () => undefined,
      onRestoreSubmit: () => undefined,
    });

    const html = fake.getHtml();
    expect(html).toContain(` ${PAIR_CODE_INPUT_REAUTH_NOTICE_ATTR}`);
    expect(html).toContain('Reconnect this browser');
    expect(html).toContain('Saved access needs attention');
    expect(html).toContain(
      'Your current page and unsent Chat draft are held in this tab.',
    );
    expect(html).toContain('<code>recued pair</code>');
    expect(html).not.toContain(PAIR_CODE_INPUT_RECOVERY_HELP_ATTR);
    expect(html).toContain('value="https://alice.recued.cloud:8443"');
    expect(html).toContain('(only if your server asks)');
    expect(html).not.toContain('Generate a new one');
    expect(html).not.toContain('Restore a backup');
    expect(fake.getSubmitBtn()?.textContent).toContain(
      'Reconnect this browser',
    );
  });

  it('explains a completed local-credential reset without blaming the server', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: {
        chatDraftPreserved: false,
        reason: 'local_credentials_unreadable',
      },
      onPaired: () => undefined,
    });

    const html = fake.getHtml();
    expect(html).toContain('Unreadable local access cleared');
    expect(html).toContain(
      'This browser could not unlock its saved sign-in',
    );
    expect(html).toContain('only that local access record');
    expect(html).toContain('Work stored on your server was not deleted.');
    expect(html).not.toContain(
      "Your server no longer accepts this browser's saved access",
    );
  });

  it('explains an interrupted local setup without presenting first-run choices', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: {
        chatDraftPreserved: false,
        reason: 'local_credentials_incomplete',
      },
      onPaired: () => undefined,
    });

    const html = fake.getHtml();
    expect(html).toContain('Incomplete browser setup cleared');
    expect(html).toContain(
      'A previous setup stopped before every local access detail was saved.',
    );
    expect(html).toContain('Work stored on your server was not deleted.');
    expect(html).not.toContain('Generate a new one');
    expect(html).not.toContain('Restore a backup');
    expect(html).not.toContain(
      "Your server no longer accepts this browser's saved access",
    );
  });

  it('explains a sibling-tab credential change without blaming the server', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: {
        chatDraftPreserved: true,
        reason: 'credentials_changed_elsewhere',
      },
      onPaired: () => undefined,
    });

    const html = fake.getHtml();
    expect(html).toContain('Saved access changed in another tab');
    expect(html).toContain(
      'Another Recued tab cleared or replaced this browser’s saved access.',
    );
    expect(html).toContain(
      'Your current page and unsent Chat draft are held in this tab.',
    );
    expect(html).not.toContain(
      "Your server no longer accepts this browser's saved access",
    );
  });

  it('explains when sibling access changes during startup recovery', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: {
        chatDraftPreserved: true,
        reason: 'startup_credentials_changed_elsewhere',
      },
      onPaired: () => undefined,
    });

    const html = fake.getHtml();
    expect(html).toContain('Access changed while this tab was recovering');
    expect(html).toContain(
      'cleared or replaced the saved access this startup retry was using',
    );
    expect(html).toContain(
      'stopped that stale retry before it could open your page',
    );
    expect(html).toContain(
      'Your current page and unsent Chat draft are held in this tab.',
    );
    expect(html).not.toContain('Pairing is still complete');
    expect(html).not.toContain(
      "Your server no longer accepts this browser's saved access",
    );
  });

  it('keeps a partially entered guided reconnect concise while a sibling finishes', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        pairingCode: 'USED-ONCE',
      },
      reauthRecovery: {
        chatDraftPreserved: true,
        reason: 'credentials_changed_elsewhere',
      },
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    handle.showInterruptedCredentialTransition();

    const html = fake.getHtml();
    expect(html).toContain('Another tab is reconnecting');
    expect(html).toContain(
      'return to your current page and unsent Chat draft automatically when the other tab finishes',
    );
    expect(html).toContain('Your recovery-key entry stays here');
    expect(html).not.toContain('value="USED-ONCE"');
    expect(recoveryValuesFromHtml(html).join(' ')).toBe(realRecoveryKey);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getSubmitBtn()?.textContent).toBe('Waiting for other tab…');
    handle.dispose();
  });

  it('turns a stalled guided sibling into an explicit fresh takeover', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'takeover-bearer' });
    const onPaired = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        pairingCode: 'USED-ONCE',
      },
      reauthRecovery: {
        chatDraftPreserved: true,
        reason: 'credentials_changed_elsewhere',
      },
      siblingTakeoverDelayMs: 20,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      ...recoverySuccessorTestSeams(),
      fetch: fetchFake,
      onPaired,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.showInterruptedCredentialTransition();

    await handle.submit();
    expect(fetchFake.calls).toHaveLength(0);
    expect(fake.getHtml()).toContain('Another tab is reconnecting');
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_TAKEOVER_READY_ATTR);
    expect(fake.getSubmitBtn()?.disabled).toBe(true);

    await vi.waitFor(() => {
      expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_TAKEOVER_READY_ATTR);
    });
    expect(fake.getHtml()).toContain('The other tab is taking longer');
    expect(fake.getHtml()).toContain(
      'Recued lets only one continue and returns the others automatically',
    );
    expect(fake.getHtml()).toContain(
      'recovery key, current page, and unsent Chat draft stay here',
    );
    expect(recoveryValuesFromHtml(fake.getHtml()).join(' ')).toBe(
      realRecoveryKey,
    );
    expect(fake.getHtml()).not.toContain('value="USED-ONCE"');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    expect(fake.getSubmitBtn()?.textContent).toBe('Reconnect in this tab');
    expect(fake.getHtml()).toContain(
      'aria-describedby="webclient-pair-code-input-interrupted-notice"',
    );

    handle.setFieldValue('pairingCode', 'FRESH123');
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0]?.body).toMatchObject({
      code: 'FRESH123',
      recoveryKey: realRecoveryKey,
    });
    expect(onPaired).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('asks for one-tab-only recovery when safe cross-tab coordination is unavailable', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      siblingTakeoverSignalsAvailable: false,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.showInterruptedCredentialTransition();

    expect(fake.getHtml()).toContain('continue in this tab only');
    expect(fake.getHtml()).toContain(
      'cannot safely choose between simultaneous reconnect attempts',
    );
    expect(fake.getHtml()).not.toContain(
      'Recued lets only one continue and returns the others automatically',
    );
    handle.showSiblingTakeoverNeedsAttention();
    expect(fake.getHtml()).toContain(
      'continue in just one open reconnect tab and keep the others idle',
    );
    expect(fake.getHtml()).not.toContain(
      'Recued will choose one open tab to continue',
    );
    handle.dispose();
  });

  it('does not promise deterministic succession without an atomic claimant', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      onTakeoverNeedsAttention: vi.fn(),
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.showInterruptedCredentialTransition();

    expect(fake.getHtml()).toContain('continue in this tab only');
    expect(fake.getHtml()).toContain(
      'cannot safely choose between simultaneous reconnect attempts',
    );
    expect(fake.getHtml()).not.toContain(
      'Recued lets only one continue and returns the others automatically',
    );
    handle.dispose();
  });

  it('makes a lock-owning preflight failure the one recovery owner', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'must-not-post' });
    const onTakeoverNeedsAttention = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      recoveryOwnerHeartbeatMs: null,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => {
        throw new Error('saved access could not be read');
      },
      ...recoverySuccessorTestSeams(),
      fetch: fetchFake,
      onTakeoverNeedsAttention,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.showInterruptedCredentialTransition();
    handle.setFieldValue('pairingCode', 'PREFLIGHT-OWNER');

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(0);
    expect(onTakeoverNeedsAttention).toHaveBeenCalledOnce();
    expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR);
    expect(fake.getHtml()).toContain('This tab needs attention');
    expect(fake.getHtml()).toContain(
      'data-error="pair_code_input_server_unknown_error"',
    );
    expect(fake.getStatus()?.textContent).toContain(
      'Pre-pair check failed: saved access could not be read',
    );
    expect(fake.getSubmitBtn()?.textContent).toBe('Retry in this tab');

    handle.disableSiblingTakeoverCoordination();
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR);
    expect(fake.getHtml()).toContain('continue in this tab only');
    expect(fake.getSubmitBtn()?.textContent).toBe('Reconnect in this tab');
    handle.dispose();
  });

  it('lets one simultaneous ready takeover reconnect while the contender adopts it', async () => {
    const winnerFake = makeFakeSplash();
    const contenderFake = makeFakeSplash();
    const winnerFetch = buildFakeFetch(200, { token: 'winner-bearer' });
    const contenderFetch = buildFakeFetch(200, { token: 'must-not-post' });
    const lockProvider = buildExclusivePairLock();
    let pairDurable = false;
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winnerOnPaired = vi.fn(async () => {
      await winnerGate;
      pairDurable = true;
    });
    const contenderOnPaired = vi.fn(async () => {
      pairDurable = true;
    });
    const winnerAfterPair = vi.fn(async () => undefined);
    const contenderAfterPair = vi.fn(async () => undefined);
    const sharedOptions = {
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      lockProvider,
      preflightCheck: async () => ({ alreadyPaired: pairDurable }),
      ...recoverySuccessorTestSeams(),
    } as const;
    const winner = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: winnerFake.splash,
      fetch: winnerFetch,
      onPaired: winnerOnPaired,
      onAfterPair: winnerAfterPair,
    });
    const contender = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: contenderFake.splash,
      fetch: contenderFetch,
      onPaired: contenderOnPaired,
      onAfterPair: contenderAfterPair,
    });
    for (const [handle, code] of [
      [winner, 'FRESH-WINNER'],
      [contender, 'FRESH-CONTENDER'],
    ] as const) {
      handle.setFieldValue('recoveryKey', realRecoveryKey);
      handle.showInterruptedCredentialTransition();
      handle.setFieldValue('pairingCode', code);
    }

    const winnerSubmission = winner.submit();
    const contenderSubmission = contender.submit();

    await vi.waitFor(() => {
      expect(winnerFetch.calls).toHaveLength(1);
      expect(winnerFake.getHtml()).toContain(
        PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR,
      );
    });
    expect(winnerFake.getSubmitBtn()?.textContent).toBe(
      'Reconnecting from this tab…',
    );
    expect(winnerFake.getHtml()).toContain('This tab is reconnecting');
    expect(winnerFake.getHtml()).toContain('aria-busy="true"');
    expect(winnerFake.getHtml()).toContain('aria-disabled="true"');
    expect(contenderFetch.calls).toHaveLength(0);
    expect(contenderFake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR,
    );
    expect(contenderFake.getSubmitBtn()?.textContent).toBe(
      'Choosing one tab…',
    );
    expect(contenderFake.getHtml()).toContain('Choosing one tab safely');
    expect(contenderFake.getHtml()).toContain(
      'return automatically without sending its pairing code',
    );
    expect(contenderFake.getHtml()).toContain('aria-busy="true"');
    expect(contenderFake.getHtml()).toContain('aria-disabled="true"');

    releaseWinner();
    await Promise.all([winnerSubmission, contenderSubmission]);

    expect(winnerFetch.calls).toHaveLength(1);
    expect(winnerFetch.calls[0]?.body).toMatchObject({
      code: 'FRESH-WINNER',
      recoveryKey: realRecoveryKey,
    });
    expect(contenderFetch.calls).toHaveLength(0);
    expect(winnerOnPaired).toHaveBeenCalledOnce();
    expect(contenderOnPaired).not.toHaveBeenCalled();
    expect(winnerAfterPair).toHaveBeenCalledOnce();
    expect(contenderAfterPair).toHaveBeenCalledOnce();
    winner.dispose();
    contender.dispose();
  });

  it('yields a failed owner retry as soon as its queued successor acquires the lock', async () => {
    const failedFake = makeFakeSplash();
    const successorFake = makeFakeSplash();
    const lockProvider = buildExclusivePairLock();
    let pairDurable = false;
    let releaseFailedRequest!: () => void;
    let releaseSuccessorRequest!: () => void;
    const failedRequestGate = new Promise<void>((resolve) => {
      releaseFailedRequest = resolve;
    });
    const successorRequestGate = new Promise<void>((resolve) => {
      releaseSuccessorRequest = resolve;
    });
    const events: string[] = [];
    const failedFetch = vi.fn(async (): Promise<Response> => {
      events.push('failed.fetch');
      await failedRequestGate;
      return {
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'recovery_key_invalid', message: 'mismatch' },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const successorFetch = vi.fn(async (): Promise<Response> => {
      events.push('successor.fetch');
      await successorRequestGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'successor-bearer' }),
      } as Response;
    }) as unknown as typeof fetch;
    let failed!: ReturnType<typeof mountPairCodeInputHost>;
    const failedTakeoverStarted = vi.fn(() => {
      events.push('failed.started');
    });
    const successorTakeoverStarted = vi.fn(() => {
      events.push('successor.started');
      failed.showSiblingTakeoverStarted();
    });
    const sharedOptions = {
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      lockProvider,
      preflightCheck: async () => {
        events.push('preflight');
        return { alreadyPaired: pairDurable };
      },
      ...recoverySuccessorTestSeams(),
    } as const;
    failed = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: failedFake.splash,
      document: failedFake.document,
      fetch: failedFetch,
      onTakeoverStarted: failedTakeoverStarted,
      onPaired: () => undefined,
    });
    const successor = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: successorFake.splash,
      fetch: successorFetch,
      onTakeoverStarted: successorTakeoverStarted,
      onPaired: () => {
        pairDurable = true;
      },
    });
    for (const [handle, code] of [
      [failed, 'FAILED-OWNER'],
      [successor, 'QUEUED-SUCCESSOR'],
    ] as const) {
      handle.setFieldValue('recoveryKey', realRecoveryKey);
      handle.showInterruptedCredentialTransition();
      handle.setFieldValue('pairingCode', code);
    }
    failedFake.focusSubmit();

    const failedSubmission = failed.submit();
    await vi.waitFor(() => expect(failedFetch).toHaveBeenCalledOnce());
    const successorSubmission = successor.submit();
    expect(successorFetch).not.toHaveBeenCalled();

    releaseFailedRequest();
    await vi.waitFor(() => {
      expect(successorFetch).toHaveBeenCalledOnce();
      expect(failedFake.getHtml()).toContain(PAIR_CODE_INPUT_SUCCESSION_ATTR);
    });

    expect(failedTakeoverStarted).toHaveBeenCalledOnce();
    expect(successorTakeoverStarted).toHaveBeenCalledOnce();
    expect(events.indexOf('successor.started')).toBeLessThan(
      events.indexOf('successor.fetch'),
    );
    expect(successorFake.getHtml()).toContain(
      PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR,
    );
    expect(failedFake.getHtml()).toContain('Another tab is continuing');
    expect(failedFake.getHtml()).toContain(
      'waiting so it will not send or save the same access twice',
    );
    expect(failedFake.getHtml()).toContain('your retry returns here');
    expect(failedFake.getHtml()).not.toContain(
      'data-error="recovery_key_invalid"',
    );
    expect(failedFake.getSubmitBtn()?.textContent).toBe(
      'Continuing in another tab…',
    );
    expect(failedFake.getHtml()).toContain('aria-busy="true"');
    expect(failedFake.getHtml()).toContain('aria-disabled="true"');
    expect(failedFake.isSubmitFocused()).toBe(true);

    await failed.submit();
    expect(failedFetch).toHaveBeenCalledOnce();
    releaseSuccessorRequest();
    await Promise.all([failedSubmission, successorSubmission]);
    expect(pairDurable).toBe(true);
    failed.dispose();
    successor.dispose();
  });

  it('restores the exact failed retry when an announced successor also stalls', async () => {
    vi.useFakeTimers();
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      siblingSuccessionDelayMs: 20,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    try {
      handle.setFieldValue('recoveryKey', realRecoveryKey);
      handle.showInterruptedCredentialTransition();
      handle.setFieldValue('pairingCode', 'FAILED-OWNER');

      await handle.submit();
      expect(fake.getHtml()).toContain('data-error="recovery_key_invalid"');

      handle.showSiblingTakeoverStarted();
      expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_SUCCESSION_ATTR);
      expect(fake.getHtml()).not.toContain(
        'data-error="recovery_key_invalid"',
      );
      expect(fake.getSubmitBtn()?.textContent).toBe(
        'Continuing in another tab…',
      );

      await vi.advanceTimersByTimeAsync(15);
      // A later server-accepted hint means the successor is still making
      // progress. Renew the bounded wait instead of resurfacing this retry.
      handle.showSiblingPairAccepted();
      await vi.advanceTimersByTimeAsync(10);
      expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_SUCCESSION_ATTR);

      await vi.advanceTimersByTimeAsync(11);
      expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_SUCCESSION_ATTR);
      expect(fake.getHtml()).toContain('data-error="recovery_key_invalid"');
      expect(fake.getSubmitBtn()?.textContent).toBe('Reconnect in this tab');
      expect(recoveryValuesFromHtml(fake.getHtml()).join(' ')).toBe(
        realRecoveryKey,
      );
    } finally {
      handle.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the final failure in one recovery tab until that owner stalls', async () => {
    vi.useFakeTimers();
    const ownerFake = makeFakeSplash();
    const siblingFake = makeFakeSplash();
    const lockProvider = buildExclusivePairLock();
    const ownerFetch = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const siblingFetch = buildFakeFetch(200, { token: 'must-not-post' });
    let sibling!: ReturnType<typeof mountPairCodeInputHost>;
    const onTakeoverNeedsAttention = vi.fn(() => {
      sibling.showSiblingTakeoverNeedsAttention();
    });
    const sharedOptions = {
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      siblingRecoveryOwnerDelayMs: 20,
      recoveryOwnerHeartbeatMs: 5,
      lockProvider,
      preflightCheck: async () => ({ alreadyPaired: false }),
      claimRecoverySuccessor: async () => ({ release: vi.fn() }),
      onRecoverySuccessorChosen: () => undefined,
    } as const;
    const owner = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: ownerFake.splash,
      fetch: ownerFetch,
      onTakeoverNeedsAttention,
      onPaired: () => undefined,
    });
    sibling = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: siblingFake.splash,
      fetch: siblingFetch,
      onPaired: () => undefined,
    });

    try {
      for (const [handle, code] of [
        [owner, 'FINAL-FAILED-OWNER'],
        [sibling, 'PASSIVE-SIBLING'],
      ] as const) {
        handle.setFieldValue('recoveryKey', realRecoveryKey);
        handle.showInterruptedCredentialTransition();
        handle.setFieldValue('pairingCode', code);
      }

      await owner.submit();

      expect(onTakeoverNeedsAttention).toHaveBeenCalledOnce();
      expect(ownerFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR,
      );
      expect(ownerFake.getHtml()).toContain('This tab needs attention');
      expect(ownerFake.getHtml()).toContain(
        'only one retry to manage',
      );
      expect(ownerFake.getHtml()).toContain(
        'data-error="recovery_key_invalid"',
      );
      expect(ownerFake.getSubmitBtn()?.textContent).toBe('Retry in this tab');

      expect(siblingFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR,
      );
      expect(siblingFake.getHtml()).toContain(
        'Continue in the tab that needs attention',
      );
      expect(siblingFake.getHtml()).toContain(
        'only tab offering a retry',
      );
      expect(siblingFake.getSubmitBtn()?.textContent).toBe(
        'Waiting for recovery tab…',
      );
      expect(siblingFake.getHtml()).toContain('aria-disabled="true"');
      expect(siblingFake.getHtml()).not.toContain(
        'data-error="recovery_key_invalid"',
      );

      await sibling.submit();
      expect(siblingFetch.calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(21);
      expect(onTakeoverNeedsAttention.mock.calls.length).toBeGreaterThan(1);
      expect(siblingFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR,
      );

      // Polling can keep rediscovering the original partial write after all
      // contenders have failed. That is not fresh progress and must neither
      // dislodge the owner nor extend the passive tab's bounded fallback.
      owner.showInterruptedCredentialTransition();
      sibling.showInterruptedCredentialTransition();
      expect(ownerFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR,
      );
      expect(siblingFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR,
      );

      const heartbeatCount = onTakeoverNeedsAttention.mock.calls.length;
      owner.dispose();
      await vi.advanceTimersByTimeAsync(21);
      expect(onTakeoverNeedsAttention).toHaveBeenCalledTimes(heartbeatCount);
      expect(siblingFake.getHtml()).not.toContain(
        PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR,
      );
      expect(siblingFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR,
      );
      expect(siblingFake.getHtml()).toContain('Recovery moved to this tab');
      expect(siblingFake.getSubmitBtn()?.textContent).toBe(
        'Continue recovery here',
      );
      expect(recoveryValuesFromHtml(siblingFake.getHtml()).join(' ')).toBe(
        realRecoveryKey,
      );
    } finally {
      owner.dispose();
      sibling.dispose();
      vi.useRealTimers();
    }
  });

  it('makes a still-open prior owner yield to an atomically chosen successor', async () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      recoveryOwnerHeartbeatMs: null,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      ...recoverySuccessorTestSeams(),
      fetch: buildFakeFetch(401, {
        error: { code: 'recovery_key_invalid', message: 'mismatch' },
      }),
      onTakeoverNeedsAttention: vi.fn(),
      onPaired: () => undefined,
    });
    try {
      handle.setFieldValue('recoveryKey', realRecoveryKey);
      handle.showInterruptedCredentialTransition();
      handle.setFieldValue('pairingCode', 'PRIOR-OWNER');
      await handle.submit();
      expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR);
      expect(fake.getSubmitBtn()?.textContent).toBe('Retry in this tab');

      // Background throttling can delay a live owner's heartbeat long enough
      // for siblings to elect a successor. The explicit chosen signal is then
      // authoritative and removes the stale owner's action immediately.
      handle.showSiblingRecoverySuccessorChosen();
      expect(fake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR,
      );
      expect(fake.getHtml()).not.toContain(
        'data-error="recovery_key_invalid"',
      );
      expect(fake.getSubmitBtn()?.textContent).toBe(
        'Waiting for recovery tab…',
      );
    } finally {
      handle.dispose();
    }
  });

  it('elects one recovery successor and deterministically hands off again if it closes', async () => {
    vi.useFakeTimers();
    const firstFake = makeFakeSplash();
    const secondFake = makeFakeSplash();
    let leaseHeld = false;
    const claimRecoverySuccessor = vi.fn(async () => {
      if (leaseHeld) return null;
      leaseHeld = true;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          leaseHeld = false;
        },
      };
    });
    let first!: ReturnType<typeof mountPairCodeInputHost>;
    let second!: ReturnType<typeof mountPairCodeInputHost>;
    const firstChosen = vi.fn(() => {
      second.showSiblingRecoverySuccessorChosen();
    });
    const secondChosen = vi.fn(() => {
      first.showSiblingRecoverySuccessorChosen();
    });
    const sharedOptions = {
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      siblingRecoveryOwnerDelayMs: 20,
      recoveryOwnerHeartbeatMs: 5,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      claimRecoverySuccessor,
      onPaired: () => undefined,
    } as const;
    first = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: firstFake.splash,
      fetch: buildFakeFetch(200, { token: 'first-token' }),
      onRecoverySuccessorChosen: firstChosen,
    });
    second = mountPairCodeInputHost({
      ...sharedOptions,
      splashElement: secondFake.splash,
      fetch: buildFakeFetch(200, { token: 'second-token' }),
      onRecoverySuccessorChosen: secondChosen,
    });

    try {
      for (const [handle, code] of [
        [first, 'FIRST-RETAINED'],
        [second, 'SECOND-RETAINED'],
      ] as const) {
        handle.setFieldValue('recoveryKey', realRecoveryKey);
        handle.showInterruptedCredentialTransition();
        handle.setFieldValue('pairingCode', code);
        handle.showSiblingTakeoverNeedsAttention();
      }

      await vi.advanceTimersByTimeAsync(21);

      expect(leaseHeld).toBe(true);
      expect(firstFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR,
      );
      expect(firstFake.getHtml()).toContain('Recovery moved to this tab');
      expect(firstFake.getHtml()).toContain('only safe successor');
      expect(firstFake.getSubmitBtn()?.textContent).toBe(
        'Continue recovery here',
      );
      expect(firstFake.getSubmitBtn()?.disabled).toBe(false);
      expect(firstFake.getSubmitFocus()).toHaveBeenCalled();

      expect(secondFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR,
      );
      expect(secondFake.getHtml()).toContain(
        'Recovery continued in another tab',
      );
      expect(secondFake.getHtml()).toContain('remains safely paused');
      expect(secondFake.getSubmitBtn()?.textContent).toBe(
        'Waiting for recovery tab…',
      );
      expect(secondFake.getHtml()).toContain('aria-disabled="true"');
      second.showSiblingTakeoverNeedsAttention();
      expect(secondFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR,
      );
      expect(secondFake.getHtml()).toContain(
        'Recovery continued in another tab',
      );
      expect(recoveryValuesFromHtml(secondFake.getHtml()).join(' ')).toBe(
        realRecoveryKey,
      );
      expect(firstChosen).toHaveBeenCalled();
      expect(secondChosen).not.toHaveBeenCalled();

      // A delayed heartbeat from the departed owner, or even a duplicate
      // successor announcement, cannot dislodge the tab holding the atomic
      // lease and briefly expose two actions.
      first.showSiblingTakeoverNeedsAttention();
      first.showSiblingRecoverySuccessorChosen();
      expect(firstFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR,
      );
      expect(firstFake.getSubmitBtn()?.textContent).toBe(
        'Continue recovery here',
      );

      first.dispose();
      expect(leaseHeld).toBe(false);
      await vi.advanceTimersByTimeAsync(21);

      expect(secondFake.getHtml()).toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR,
      );
      expect(secondFake.getHtml()).not.toContain(
        PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR,
      );
      expect(secondFake.getSubmitBtn()?.textContent).toBe(
        'Continue recovery here',
      );
      expect(secondChosen).toHaveBeenCalled();
      expect(leaseHeld).toBe(true);
      expect(recoveryValuesFromHtml(secondFake.getHtml()).join(' ')).toBe(
        realRecoveryKey,
      );

      await second.submit();
      expect(leaseHeld).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the chosen takeover action focused when the server rejects it', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(401, {
      error: { code: 'recovery_key_invalid', message: 'mismatch' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: null,
      lockProvider: buildExclusivePairLock(),
      preflightCheck: async () => ({ alreadyPaired: false }),
      ...recoverySuccessorTestSeams(),
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.showInterruptedCredentialTransition();
    handle.setFieldValue('pairingCode', 'FRESH-REJECTED');
    fake.focusSubmit();
    fake.getSubmitFocus().mockClear();

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(fake.getStatus()?.dataset.error).toBe('recovery_key_invalid');
    expect(fake.getSubmitBtn()?.textContent).toBe('Retry in this tab');
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR);
    expect(fake.getHtml()).not.toContain('aria-busy="true"');
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR);
    expect(fake.isSubmitFocused()).toBe(false);
    expect(fake.isRecoveryCorrectionFocused()).toBe(true);
    expect(fake.getRecoveryCorrectionFocus()).toHaveBeenCalledOnce();
    expect(fake.getSubmitFocus()).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it('adopts a late sibling completion before a ready takeover can post', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'must-not-be-used' });
    const onPaired = vi.fn();
    const onAfterPair = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      // Immediate only for this deterministic unit case: production waits for
      // the ordinary persistence window before exposing the same action.
      siblingTakeoverDelayMs: null,
      fetch: fetchFake,
      preflightCheck: async () => ({ alreadyPaired: true }),
      onPaired,
      onAfterPair,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.showInterruptedCredentialTransition();

    expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_TAKEOVER_READY_ATTR);
    expect(fake.getSubmitBtn()?.textContent).toBe('Reconnect in this tab');
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(0);
    expect(onPaired).not.toHaveBeenCalled();
    expect(onAfterPair).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('turns a sibling partial write into takeover copy and clears its stale code', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        pairingCode: 'USED-ONCE',
      },
      onPaired: () => undefined,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    handle.showInterruptedCredentialTransition();

    const html = fake.getHtml();
    expect(html).toContain(PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR);
    expect(html).toContain('Another tab is saving access');
    expect(html).toContain('cleared the old one-time code');
    expect(html).not.toContain('value="USED-ONCE"');
    expect(recoveryValuesFromHtml(html).join(' ')).toBe(realRecoveryKey);
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
  });

  it('keeps a same-origin cold repair editable without a dangling description', () => {
    const fake = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
      },
      reauthRecovery: {
        chatDraftPreserved: false,
        reason: 'local_credentials_incomplete',
      },
      onPaired: () => undefined,
    });

    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ATTR,
    );
    expect(fake.getHtml()).toContain(
      `data-action="${PAIR_CODE_INPUT_CHANGE_SERVER_ACTION}"`,
    );
    expect(fake.getHtml()).not.toContain(
      'aria-describedby="webclient-pair-code-input-secure-resume-notice"',
    );
    fake.fireAction(PAIR_CODE_INPUT_CHANGE_SERVER_ACTION);
    expect(fake.getServerFocus()).toHaveBeenCalledOnce();
    expect(fake.getServerSelect()).toHaveBeenCalledOnce();
  });

  it('returns through the guided handoff when another tab completed the repair first', async () => {
    const fake = makeFakeSplash();
    const fetchFake = vi.fn();
    const onPaired = vi.fn();
    const onAfterPair = vi.fn(async () => undefined);
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      fetch: fetchFake as unknown as typeof fetch,
      preflightCheck: async () => ({ alreadyPaired: true }),
      onPaired,
      onAfterPair,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();

    expect(fetchFake).not.toHaveBeenCalled();
    expect(onPaired).not.toHaveBeenCalled();
    expect(onAfterPair).toHaveBeenCalledTimes(1);
    expect(fake.getStatus()?.dataset.error).toBeUndefined();
  });

  it('keeps the explicit already-paired stop for a generic first-pair form', async () => {
    const fake = makeFakeSplash();
    const fetchFake = vi.fn();
    const onAfterPair = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      fetch: fetchFake as unknown as typeof fetch,
      preflightCheck: async () => ({ alreadyPaired: true }),
      onPaired: vi.fn(),
      onAfterPair,
    });
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();

    expect(fetchFake).not.toHaveBeenCalled();
    expect(onAfterPair).not.toHaveBeenCalled();
    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_already_paired',
    );
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

  it('compacts a pairing code pasted with grouping whitespace', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });

    fake.fireField('pairing-code', ' AB CD\t12 34 ');
    // Force a normal render after the delegated input so the assertion reads
    // the host's retained state rather than the fake input object.
    handle.setFieldValue('serverUrl', 'http://localhost:3001');

    expect(fake.getHtml()).toMatch(
      /id="webclient-pair-code-input-code"[\s\S]*?value="ABCD1234"/,
    );
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

  it('retries an interrupted local finalize without a second pairing request', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, {
      token: 'one-time-bearer',
      token_id: 'tok-interrupted',
    });
    const onPaired = vi
      .fn()
      .mockRejectedValueOnce(new Error(
        "Pairing succeeded, but Recued couldn't save the credentials to local storage. Reload and try again.",
      ))
      .mockResolvedValueOnce(undefined);
    const onPairAccepted = vi.fn();
    const onAfterPair = vi.fn(async () => undefined);
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPairAccepted,
      onPaired,
      onAfterPair,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.setFieldValue('pairingCode', 'ONE-TIME');

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(onPairAccepted).toHaveBeenCalledOnce();
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onAfterPair).not.toHaveBeenCalled();
    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_finalize_interrupted',
    );
    expect(fake.getStatus()?.textContent).not.toContain('Reload');
    expect(fake.getStatus()?.textContent).toContain(
      "Recued couldn't save the credentials to local storage",
    );
    expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR);
    expect(fake.getHtml()).toContain('data-local-finalize-retry');
    expect(fake.getHtml()).toContain('will not contact the pairing endpoint again');
    expect(fake.getSubmitBtn()?.textContent).toBe('Finish saving access');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    expect(fake.getHtml()).toMatch(
      /id="webclient-pair-code-input-server-url"[\s\S]*?disabled/,
    );

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(onPairAccepted).toHaveBeenCalledOnce();
    expect(onPaired).toHaveBeenCalledTimes(2);
    expect(onPaired.mock.calls[1]?.[0]).toEqual(onPaired.mock.calls[0]?.[0]);
    expect(onAfterPair).toHaveBeenCalledTimes(1);
  });

  it('keeps the in-memory response recoverable when the retry lock is interrupted', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'held-bearer' });
    const onPaired = vi
      .fn()
      .mockRejectedValueOnce(new Error('first local save stopped'))
      .mockResolvedValueOnce(undefined);
    let lockAttempt = 0;
    const lockProvider: PairFinalizeLockProvider = {
      request: async (_name, _options, callback) => {
        lockAttempt += 1;
        if (lockAttempt === 2) {
          throw new Error('tab temporarily lost lock coordination');
        }
        return callback();
      },
    };
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      lockProvider,
      onPaired,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_finalize_interrupted',
    );
    expect(fake.getStatus()?.textContent).toContain(
      'still will not send another pairing request',
    );
    expect(fake.getSubmitBtn()?.textContent).toBe('Finish saving access');
    expect(fake.getSubmitBtn()?.disabled).toBe(false);

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(onPaired).toHaveBeenCalledTimes(2);
  });

  it('adopts a sibling completion while a local finalize retry is queued', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'one-time-bearer' });
    let siblingCompleted = false;
    const onPaired = vi.fn(async () => {
      throw new Error('first local write stopped');
    });
    const onAfterPair = vi.fn(async () => undefined);
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      preflightCheck: async () => ({ alreadyPaired: siblingCompleted }),
      onPaired,
      onAfterPair,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);

    await handle.submit();
    siblingCompleted = true;
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onAfterPair).toHaveBeenCalledTimes(1);
  });

  it('stops a racing sibling POST once, clears its code, then takes over by recovery key', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'takeover-bearer' });
    const onPaired = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      preflightCheck: async () => ({
        alreadyPaired: false,
        interrupted: true,
      }),
      onPaired,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.setFieldValue('pairingCode', 'POSSIBLY-USED');

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(0);
    expect(onPaired).not.toHaveBeenCalled();
    expect(fake.getHtml()).toContain(PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR);
    expect(fake.getHtml()).not.toContain('value="POSSIBLY-USED"');
    expect(fake.getRecoveryFocus()).toHaveBeenCalled();
    expect(fake.getSubmitBtn()?.disabled).toBe(false);

    await handle.submit();

    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0]?.body).not.toHaveProperty('code');
    expect(fetchFake.calls[0]?.body).toMatchObject({
      recoveryKey: realRecoveryKey,
    });
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('discards a failed response and never reuses its one-time code', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(200, { token: 'first-bearer' });
    const onPaired = vi
      .fn()
      .mockRejectedValueOnce(new Error('local save remains unavailable'))
      .mockResolvedValueOnce(undefined);
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    handle.setFieldValue('pairingCode', 'USED-ONCE');

    await handle.submit();
    fake.fireAction(PAIR_CODE_INPUT_RESTART_AFTER_INTERRUPTION_ACTION);

    expect(fake.getHtml()).not.toContain('data-local-finalize-retry');
    expect(fake.getHtml()).toContain('data-local-finalize-restarted');
    expect(fake.getHtml()).toContain('Ready for a fresh pairing attempt');
    expect(fake.getHtml()).not.toContain('Another tab is saving access');
    expect(fake.getSubmitBtn()?.textContent).toBe('Pair this device');
    await handle.submit();

    expect(fetchFake.calls).toHaveLength(2);
    expect(fetchFake.calls[0]?.body).toMatchObject({ code: 'USED-ONCE' });
    expect(fetchFake.calls[1]?.body).not.toHaveProperty('code');
    expect(fetchFake.calls[1]?.body).toMatchObject({
      recoveryKey: realRecoveryKey,
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
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain(
      'Review the server address or re-enter the recovery key before retrying.',
    );
  });

  it('keeps a malformed recovery key actionable until its words change', async () => {
    const fake = makeFakeSplash();
    const fetchFake = vi.fn();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      document: fake.document,
      fetch: fetchFake as unknown as typeof fetch,
      onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue(
      'recoveryKey',
      Array.from({ length: 24 }, () => 'abandon').join(' '),
    );

    await handle.submit();

    expect(fetchFake).not.toHaveBeenCalled();
    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_invalid_recovery_key',
    );
    expect(fake.getStatus()?.textContent).toContain(
      'do not form a valid recovery key',
    );
    expect(fake.getRecoveryFocus()).toHaveBeenCalledOnce();
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    expect(fake.getHtml()).toContain(
      'Correct the recovery key before retrying.',
    );
    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR,
    );

    fake.fireField('pairing-code', 'FRESH-CODE');
    fake.fireField('server-url', 'http://localhost:3002');
    expect(fake.getStatus()?.dataset.error).toBe(
      'pair_code_input_invalid_recovery_key',
    );
    expect(fake.getSubmitBtn()?.disabled).toBe(true);
    await handle.submit();
    expect(fetchFake).not.toHaveBeenCalled();

    fake.fireRecoveryWord(0, 'ability');
    expect(fake.getStatus()?.dataset.error).toBeUndefined();
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
    handle.dispose();
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
    expect(fake.getSubmitBtn()?.disabled).toBe(false);
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
    expect(fake.getHtml()).not.toContain(
      PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR,
    );
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_RECOVERY_HELP_ATTR);
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
  it('dispose clears typed pairing secrets, the splash, and listeners', () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      onPaired: () => undefined,
    });
    const firstRecoveryWord = realRecoveryKey.split(' ')[0];
    handle.setFieldValue('pairingCode', 'STALE999');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    expect(fake.getHtml()).toContain('STALE999');
    expect(fake.getHtml()).toContain(`value="${firstRecoveryWord}"`);
    expect(fake.listenerCount()).toBeGreaterThan(0);
    handle.dispose();
    expect(fake.getHtml()).toBe('');
    expect(fake.getHtml()).not.toContain('STALE999');
    expect(fake.getHtml()).not.toContain(`value="${firstRecoveryWord}"`);
    expect(fake.listenerCount()).toBe(0);
  });

  it('does not let a pending sibling-takeover timer revive a retired form', async () => {
    const fake = makeFakeSplash();
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      seed: { serverUrl: 'https://alice.recued.cloud:8443' },
      reauthRecovery: { chatDraftPreserved: true },
      siblingTakeoverDelayMs: 10,
      onPaired: () => undefined,
    });
    handle.showInterruptedCredentialTransition();
    expect(fake.getHtml()).toContain('Waiting for other tab…');

    handle.dispose();
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));

    expect(fake.getHtml()).toBe('');
    expect(fake.getHtml()).not.toContain(PAIR_CODE_INPUT_TAKEOVER_READY_ATTR);
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
  // ⚠ This used to be a HAND-LISTED array of 9 codes calling itself "every
  // documented code" — the same shape as the bug D-212 tail #6 fixed. It
  // passed while the map had grown past it, because a subset always does.
  // It now walks the map itself and pins the SPREAD instead.
  it('every code in the map has copy', () => {
    const entries = Object.entries(PAIR_CODE_INPUT_ERROR_COPY);
    expect(entries.length).toBeGreaterThan(0);
    for (const [code, copy] of entries) {
      expect(copy, `no copy for ${code}`).toBeTruthy();
      expect(copy.trim().length, `blank copy for ${code}`).toBeGreaterThan(0);
    }
  });

  it('takes the server half from the shared vocabulary rather than restating it', () => {
    // The drift this closes: the webclient and the Bridge each restated the
    // server codes, and each fell four behind. Asserting the values MATCH
    // (not merely exist) is what makes a future divergent edit fail here.
    for (const [code, copy] of Object.entries(PAIR_SERVER_ERROR_COPY)) {
      expect(
        PAIR_CODE_INPUT_ERROR_COPY[code as keyof typeof PAIR_CODE_INPUT_ERROR_COPY],
        `${code} diverged from the shared map`,
      ).toBe(copy);
    }
    // …and the spread did not clobber the client half on its way in.
    expect(PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_no_server_url).toBeTruthy();
    expect(PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_server_refused).toBeTruthy();
  });
});

describe('D-212 tail #6 — an unmapped server code reaches the user', () => {
  it('quotes the server in its own attributed element, outside Recued’s sentence', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'realm_sealed_for_maintenance', message: 'Back at 14:00 UTC.' },
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
    expect(status?.dataset.error).toBe('pair_code_input_server_refused');
    // Recued's sentence says only that the server refused …
    expect(status?.textContent).toBe(PAIR_SERVER_REFUSED_COPY);
    expect(status?.textContent).not.toContain('14:00');
    expect(status?.textContent).not.toMatch(/check the url/i);
    // … and the server's words live in their OWN element, labelled.
    const html = fake.splash.innerHTML;
    expect(html).toContain('data-server-said');
    expect(html).toContain(PAIR_SERVER_SAID_LABEL);
    expect(html).toContain('Back at 14:00 UTC.');
  });

  it('renders tailored copy with NO quoted server message', async () => {
    // `instance_revoked` is one of the four that used to render as "check
    // the URL". It now has Recued's own words — and must not also quote the
    // raw server text underneath them.
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(403, {
      error: { code: 'instance_revoked', message: 'this instance was previously revoked' },
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
    expect(status?.dataset.error).toBe('instance_revoked');
    expect(status?.textContent).toBe(PAIR_CODE_INPUT_ERROR_COPY.instance_revoked);
    expect(status?.textContent).not.toMatch(/check the url/i);
    expect(fake.splash.innerHTML).not.toContain('data-server-said');
  });

  it('carries the raw server code as an attribute, never as copy', async () => {
    // The field was assigned and read by nobody — a declaration with nothing
    // behind it. It exists for support ("what did your server actually
    // say?"), so it has to reach the DOM; it must not reach the sentence.
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'realm_sealed_for_maintenance', message: 'Back at 14:00.' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash, fetch: fetchFake, onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();

    expect(fake.splash.innerHTML).toContain(
      `${PAIR_CODE_INPUT_SERVER_CODE_ATTR}="realm_sealed_for_maintenance"`,
    );
    // Recued's own sentence stays free of it.
    expect(fake.getStatus()?.textContent).not.toContain('realm_sealed');
  });

  it('drops a server code that is not code-shaped', async () => {
    // ⚠ Unauthenticated text. A "code" that is a paragraph is not a code, and
    // an attribute is a poor place for arbitrary input even escaped.
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(503, {
      error: { code: 'a code with spaces and <angle> brackets', message: 'x' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash, fetch: fetchFake, onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();

    expect(fake.splash.innerHTML).not.toContain(PAIR_CODE_INPUT_SERVER_CODE_ATTR);
    // …and the refusal still renders.
    expect(fake.getStatus()?.dataset.error).toBe('pair_code_input_server_refused');
  });

  it('adds no server-code attribute for a code Recued maps', async () => {
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(403, {
      error: { code: 'instance_revoked', message: 'revoked' },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash, fetch: fetchFake, onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();
    expect(fake.splash.innerHTML).not.toContain(PAIR_CODE_INPUT_SERVER_CODE_ATTR);
  });

  it('escapes what the unauthenticated host sent', async () => {
    // Pairing runs before any trust exists — the quoted text is attacker-
    // controllable if the user was pointed at a hostile URL.
    const fake = makeFakeSplash();
    const fetchFake = buildFakeFetch(500, {
      error: {
        code: 'weird',
        message: '<img src=x onerror=alert(1)>"escape me"',
      },
    });
    const handle = mountPairCodeInputHost({
      splashElement: fake.splash,
      fetch: fetchFake,
      onPaired: () => undefined,
    });
    handle.setFieldValue('serverUrl', 'http://localhost:3001');
    handle.setFieldValue('recoveryKey', realRecoveryKey);
    await handle.submit();

    const html = fake.splash.innerHTML;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('onerror=alert(1)>"');
  });
});

// silence unused-var lint on the type import — the assertion is in
// the test bodies, but TS sees it as type-only.
const _typeRef: PairCodeInputCommitResult | null = null;
void _typeRef;
