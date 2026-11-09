/** D-156 P6 / D-169 P0 Slice 2B — Bridge pair-code-input host.
 *
 *  Bridge-surface mirror of [[apps/webclient/src/auth/pair-code-input-host]].
 *  Same 3-field form (Server address + optional Pairing code + optional
 *  24-word Recovery key), same `/auth/pair` submit shape, same closed-
 *  list error taxonomy. Unlike the webclient's, this host never sends the
 *  request itself: the service worker does (DD#7), and wraps the realm
 *  bearer through a `WebclientTokenStore` before writing, matching the
 *  webclient's passport-fetch → wrap → write path. The side panel never
 *  sees the bearer.
 *
 *  Per D-156 spec § "Browser bridge — touch lightly": the bridge gets
 *  the same `renderDevicesPage` + 3-field pair form lifted from
 *  ui-shared. No bridge-specific pair UX — the host's behaviour is
 *  identical to the webclient's modulo the stable DOM ids.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Stable DOM ids are `bridge-pair-...` prefixed (vs the
 *  webclient's `webclient-pair-...`). The host element is a slot the
 *  side panel renders while the bridge is unpaired; the prefix keeps the
 *  test assertions + future Settings inspector unambiguous when bridge +
 *  webclient renderers ship side-by-side in the same monorepo.
 *
 *  DD#2 — Pure `submitPairCodeInput` is a verbatim port of the
 *  webclient's — the wire shape (`POST /auth/pair` with `{ code? }`,
 *  `{ recoveryKey }`, or both) is identical for both surfaces. A
 *  future cleanup slice could lift this to `@recued/ui-shared/account`
 *  alongside the recovery primitives; for D-156 P6 we keep it local
 *  to match the webclient's structure (mirror-port, no premature
 *  abstraction).
 *
 *  DD#3 — The pure `submitBridgePairCodeInput` is what the worker calls.
 *  The host persists nothing and holds no secret: it sends what the user
 *  typed to the worker and renders the outcome.
 *
 *  DD#4 — Event wiring uses ONE delegated `input` + ONE delegated
 *  `click` + ONE delegated `submit` listener at the root. Same shape
 *  as the webclient host so the same string-innerHTML fake-DOM test
 *  helper drives both. The side panel's CSP forbids inline scripts
 *  (`script-src 'self'`) but delegated handlers attached via
 *  `addEventListener` are unaffected.
 *
 *  DD#5 — `splashElement` semantics are preserved from the webclient
 *  ergonomically — the option name "splash" no longer matches the
 *  side panel's slot, but renaming would diverge the API needlessly. The
 *  host accepts any HTMLElement; the side panel passes its slot directly.
 *
 *  DD#6 — ⛔ AN ACCEPTED PAIRING IS FINISHED, NEVER SENT AGAIN.
 *  `/auth/pair` spends the single-use code the moment it says yes, so
 *  from then on the server's reply is the only way left to finish. The
 *  worker holds that reply (`worker-pairing.ts`) before setup runs; when
 *  setup fails, this host shows "Finish pairing", which asks the worker to
 *  finish with the held reply and never posts the code. It used to post it
 *  again: the server answered `invalid_code`, the copy blamed the code,
 *  and a Chrome Web Store reviewer — who has no way to get another —
 *  rejected 0.0.1 (2026-10-09). The webclient learned this first (its
 *  `pendingPairResult`). "Start over" drops the held reply, which costs a
 *  new code, and the form says so.
 *
 *  DD#7 — ⛔ THE WORKER PAIRS; THE SIDE PANEL ASKS. `/auth/pair` spends
 *  the code before it answers — 5.4 s against the review server — and
 *  0.0.1 posted it from a popup, which Chrome closes the moment it loses
 *  focus: one click lost the reply, leaving the code spent and the bridge
 *  unpaired. The pair form now lives in the side panel, which stays open
 *  on a click elsewhere, and the worker still sends the request, because
 *  the panel can be closed too. Every mount starts by asking the worker
 *  where pairing stands, and shows one screen for each answer: the form
 *  (unpaired), "Pairing…" with a spinner (an attempt is running — shown
 *  the moment Pair is clicked, and to a panel reopened mid-attempt),
 *  "Finish pairing" (accepted, not set up), and "Paired". A paired bridge
 *  never gets the form; the panel replaces this host with its paired
 *  sections as soon as the stored pair appears.
 */

import { isValidRecoveryKey } from '@recued/crypto';
import { recoveryGrid } from '@recued/ui-shared/primitives';
import {
  distributeTokens,
  fromRecoveryWords,
  toRecoveryWords,
} from '@recued/ui-shared/recovery-words';
import {
  PAIR_SERVER_ERROR_COPY,
  PAIR_SERVER_REFUSED_COPY,
  PAIR_SERVER_SAID_LABEL,
  describePairServerError,
  type PairServerErrorCode,
} from '@recued/ui-shared/pairing';
import { e } from '@recued/ui-shared/template';
import { BRIDGE_PAIR_COMPLETION_ERROR_COPY } from './pair-completion.js';
import { isInsecurePublicServerUrl } from './server-url-security.js';
import type {
  BridgePairOutcome,
  BridgePairStartInput,
  BridgePairStatus,
} from './worker-pairing.js';

// ════════════════════════════════════════════════════════════════
// Stable DOM ids — tests + future bridge inspectors read these.
// ════════════════════════════════════════════════════════════════

export const BRIDGE_PAIR_CODE_INPUT_FORM_ID = 'bridge-pair-code-input-form';
export const BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID = 'bridge-pair-code-input-server-url';
export const BRIDGE_PAIR_CODE_INPUT_CODE_ID = 'bridge-pair-code-input-code';
export const BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID = 'bridge-pair-code-input-submit';
export const BRIDGE_PAIR_CODE_INPUT_STATUS_ID = 'bridge-pair-code-input-status';
/** D-212 — the RAW code the server sent, when it is not one Recued maps.
 *  Carried for support ("what did your server actually say?"); the copy the
 *  user reads never contains it. */
export const BRIDGE_PAIR_CODE_INPUT_SERVER_CODE_ATTR =
  'data-recued-bridge-pair-code-input-server-code';
export const BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID =
  'bridge-pair-code-input-requirement';
export const BRIDGE_PAIR_CODE_INPUT_RECOVERY_PREFIX = 'bridge-pair-code-input-recovery';
/** DD#6 — the way out of an accepted pairing that will not finish. */
export const BRIDGE_PAIR_CODE_INPUT_START_OVER_ID = 'bridge-pair-code-input-start-over';
/** Where someone with no Recued yet learns to install it (2026-11-04). The store sent 138 installs
 *  of the Bridge in its first days and recued.com saw none of them: the pair form asked for a
 *  server address and a code that a newcomer has no way to get, and named nowhere to get them. */
export const RECUED_GET_STARTED_URL = 'https://recued.com/docs/getting-started/';
export const BRIDGE_PAIR_CODE_INPUT_GET_RECUED_ID = 'bridge-pair-code-input-get-recued';
/** DD#7 — marks the spinner shown while the worker waits for the server. */
export const BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR = 'data-recued-bridge-pair-waiting';

const BRIDGE_PAIR_CODE_INPUT_FIELD_NAME = 'bridge-pair-code-input-field';
const BRIDGE_PAIR_CODE_INPUT_RECOVERY_FIELD_NAME = 'bridge-pair-code-input-recovery-field';
const BRIDGE_PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE = 'recovery-word';
const BRIDGE_PAIR_CODE_INPUT_SUBMIT_ACTION = 'bridge-pair-code-input-submit';
const BRIDGE_PAIR_CODE_INPUT_START_OVER_ACTION = 'bridge-pair-code-input-start-over';

// ════════════════════════════════════════════════════════════════
// Error codes + copy
// ════════════════════════════════════════════════════════════════

/** Client-side errors — the form / pure submit caught these BEFORE
 *  a server reply was parsed (or in the place of a reply). */
export type BridgePairCodeInputClientErrorCode =
  | 'pair_code_input_no_server_url'
  | 'pair_code_input_insecure_server_url'
  | 'pair_code_input_no_input'
  | 'pair_code_input_invalid_recovery_key'
  | 'pair_code_input_transport_failed'
  | 'pair_code_input_server_unknown_error'
  | 'pair_code_input_server_refused'
  /** DD#6 — the server accepted the code but setup did not finish.
   *  Retryable without a new code. */
  | 'pair_code_input_handoff_failed'
  /** DD#6 — setup failed in a way finishing again cannot fix, so the
   *  accepted pairing was dropped. */
  | 'pair_code_input_handoff_final'
  /** DD#6 — "Finish pairing" found no accepted pairing to finish (a browser
   *  restart empties it). */
  | 'pair_code_input_handoff_lost'
  /** DD#7 — the worker could not be reached, or failed unexpectedly. */
  | 'pair_code_input_worker_failed'
  /** 2026-11-03 — the server stopped accepting this bridge's sign-in (close 4003 / 4401), so the
   *  worker unpaired it (`sign-in-refusal-store.ts`). */
  | 'pair_code_input_sign_in_refused'
  /** 2026-11-04 — the owner disconnected this bridge and its server could not be told, so the
   *  server still lists it under Devices. */
  | 'pair_code_input_disconnected_untold';

/** Server-side errors — `/auth/pair` codes this client holds TAILORED
 *  copy for, DERIVED from `@recued/ui-shared/pairing`.
 *
 *  ⚠ It used to be a hand-copied "closed list" of four, identical to the
 *  webclient's and identically four codes behind the server. A copied
 *  vocabulary rots and a subset still typechecks, so nothing caught it;
 *  what the user got was "check the URL" for four failures the URL had
 *  nothing to do with. Unrecognised codes now surface as
 *  `pair_code_input_server_refused` with the server's own message. */
export type BridgePairCodeInputServerErrorCode = PairServerErrorCode;

export type BridgePairCodeInputErrorCode =
  | BridgePairCodeInputClientErrorCode
  | BridgePairCodeInputServerErrorCode;

/** User-facing copy for every documented error code. Tests assert
 *  the structured `data-error` value on the status element; this map
 *  is what renders to the human. */
export const BRIDGE_PAIR_CODE_INPUT_ERROR_COPY: Readonly<
  Record<BridgePairCodeInputErrorCode, string>
> = {
  pair_code_input_no_server_url: 'Enter the URL your recued-server is reachable at.',
  pair_code_input_insecure_server_url:
    'A public server must use https:// — a plaintext http:// address would expose your pairing code and bearer. Use https:// (or http:// only for localhost / your LAN).',
  pair_code_input_no_input:
    'Enter your 24-word recovery key, or a pairing code from the server terminal, or both.',
  pair_code_input_invalid_recovery_key:
    "That doesn't look like a valid 24-word recovery key. Check for typos or missing words.",
  pair_code_input_transport_failed:
    "Couldn't reach your recued-server. Check the URL and that the server is running, then try again.",
  // Reserved for a reply that isn't shaped like a recued-server's at all
  // (non-JSON / no realm token) — there, "check the URL" is right.
  pair_code_input_server_unknown_error:
    'The server returned an unexpected response. Check the URL and try again.',
  pair_code_input_server_refused: PAIR_SERVER_REFUSED_COPY,
  // ⛔ Never "reload and try again" here — and never "check the code". The code
  // is already spent; the one thing that helps is finishing with what the server
  // sent back, which is what the button does.
  pair_code_input_handoff_failed:
    "This bridge didn't finish setting up. Select Finish pairing to try again. You don't need a new pairing code.",
  // Rendered only as a fallback: the specific reason is the copy.
  pair_code_input_handoff_final:
    "This bridge couldn't finish pairing, and trying again won't change that.",
  pair_code_input_handoff_lost:
    "This bridge no longer has the pairing your server accepted, so it can't finish it. Pair again with a new code from your server.",
  // Rendered only as a fallback: `workerFailedCopy` adds what went wrong.
  pair_code_input_worker_failed:
    "Recued Bridge's background service didn't respond. Try again in a moment.",
  pair_code_input_sign_in_refused:
    'Your server stopped accepting this bridge, so it was unpaired. That happens when the bridge is removed from the server\'s devices, or the server is reset. Pair it again with a new code from your server.',
  pair_code_input_disconnected_untold:
    'This bridge is disconnected, but your server could not be reached to be told, so it still lists this bridge under Devices. Remove it there, or pair this bridge again with a new code from your server.',
  // Spread, not restated — restating it is what let this drift.
  ...PAIR_SERVER_ERROR_COPY,
};

/** DD#6 — the status line for a failed setup, with the reason. The reason
 *  reads after a colon, so a trailing full stop is dropped rather than
 *  doubled. */
const handoffFailedCopy = (rawReason: string): string => {
  const reason = rawReason.trim().replace(/[.!]+$/, '');
  return reason.length > 0
    ? `This bridge didn't finish setting up: ${reason}. Select Finish pairing to try again. You don't need a new pairing code.`
    : BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_handoff_failed;
};

/** DD#7 — the worker did not answer, or broke. */
const workerFailedCopy = (detail: string): string => {
  const what = detail.trim().replace(/[.!]+$/, '');
  return what.length > 0
    ? `Recued Bridge's background service didn't respond (${what}). Try again in a moment.`
    : BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_worker_failed;
};

// ════════════════════════════════════════════════════════════════
// Pure submit
// ════════════════════════════════════════════════════════════════

/** A server-supplied error code, but only if it is CODE-SHAPED.
 *
 *  ⚠ This string comes from an unauthenticated host at the pairing screen.
 *  It is escaped wherever it renders, but an attribute is a poor place for
 *  arbitrary text, and a "code" that is a paragraph is not a code. Anything
 *  that does not match is dropped rather than shown — the human-readable
 *  half already travels through `serverSaid`, quoted and attributed. */
const codeShaped = (raw: string | undefined): string | null =>
  raw !== undefined && /^[a-z0-9_]{1,64}$/i.test(raw) ? raw : null;

export interface BridgePairCodeInputCommitOptions {
  /** Server URL the form posts against. `/auth/pair` is appended. */
  serverUrl: string;
  /** Pairing code — optional once the realm is enrolled. */
  code?: string;
  /** 24-word recovery key, when the user typed one. A pairing code alone
   *  is a complete pair. */
  recoveryKey?: string;
  /** Instance id the server stamps on the token it issues and on its
   *  `paired_instances` row. The worker always sends one: without it the
   *  server cannot resolve the bridge's identity, and every rpc that needs
   *  a registered client (`events.subscribe` among them) refuses it. */
  instanceId?: string;
  /** Optional human-readable device label. Bridge callers typically
   *  pass something like "Chrome on macOS". */
  displayName?: string;
  /** Fetch seam — the worker's own `fetch` in production, a fake in tests.
   *  Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export type BridgePairCodeInputCommitResult =
  | {
      ok: true;
      /** Long-lived realm bearer returned by `/auth/pair`. */
      token: string;
      /** Durable server-issued client token id returned by `/auth/pair`. */
      token_id?: string;
      /** Cleartext bearer returned once by `/auth/pair`. */
      bearer?: string;
      /** Optional passport projection returned by `/auth/pair`. */
      passport?: unknown;
      /** Optional server id (returned when the server was configured
       *  with one). */
      serverId?: string;
    }
  | {
      ok: false;
      error: BridgePairCodeInputErrorCode;
      detail?: string;
      /** The server's own message, sanitized + quotable, when it refused
       *  with a code this client has no tailored copy for. Present ONLY
       *  with `pair_code_input_server_refused`. */
      serverSaid?: string;
      /** The raw code the server sent, when unmapped — for `data-error`
       *  + support conversations. */
      serverCode?: string;
    };

const normalizeServerUrl = (raw: string): string => raw.trim().replace(/\/$/, '');


/** Submit the form contents to `/auth/pair`. Never throws — every
 *  parse / transport / server-error path surfaces as a tagged result.
 *  The DOM host wraps this with state + inline error rendering;
 *  callers can also invoke it directly. */
export const submitBridgePairCodeInput = async (
  options: BridgePairCodeInputCommitOptions,
): Promise<BridgePairCodeInputCommitResult> => {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? '');
  if (serverUrl.length === 0) {
    return { ok: false, error: 'pair_code_input_no_server_url' };
  }
  // D-169 bridge security hunt, F2 — refuse a PUBLIC host over plaintext BEFORE
  // any network I/O, so the pairing code + the long-lived bearer it returns
  // never cross the open internet in the clear (the WS dial enforces the same
  // posture via `normaliseServerUrlToWs`). Plaintext to a host the internet
  // cannot route to (loopback / RFC1918 / link-local / CGNAT / `.local`)
  // stays allowed for no-TLS home/LAN self-host.
  if (isInsecurePublicServerUrl(serverUrl)) {
    return { ok: false, error: 'pair_code_input_insecure_server_url' };
  }
  const code = options.code?.trim() ?? '';
  const recoveryKey = options.recoveryKey?.trim() ?? '';
  if (!code && !recoveryKey) {
    return { ok: false, error: 'pair_code_input_no_input' };
  }
  if (recoveryKey && !isValidRecoveryKey(recoveryKey)) {
    return { ok: false, error: 'pair_code_input_invalid_recovery_key' };
  }

  const body: Record<string, string> = {};
  if (code) body.code = code;
  if (recoveryKey) body.recoveryKey = recoveryKey;
  if (options.instanceId) body.instanceId = options.instanceId;
  if (options.displayName) body.displayName = options.displayName;
  body.clientKind = 'bridge';

  const fetchImpl = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${serverUrl}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: 'pair_code_input_transport_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false,
      error: 'pair_code_input_server_unknown_error',
      detail: `HTTP ${res.status} (non-JSON response)`,
    };
  }

  if (res.ok) {
    const r = parsed as {
      token?: unknown;
      token_id?: unknown;
      bearer?: unknown;
      passport?: unknown;
      serverId?: unknown;
    };
    if (typeof r.token !== 'string' || r.token.length === 0) {
      return {
        ok: false,
        error: 'pair_code_input_server_unknown_error',
        detail: 'response missing realm token',
      };
    }
    const out: BridgePairCodeInputCommitResult = { ok: true, token: r.token };
    if (typeof r.token_id === 'string' && r.token_id.length > 0) {
      out.token_id = r.token_id;
    }
    if (typeof r.bearer === 'string' && r.bearer.length > 0) {
      out.bearer = r.bearer;
      out.token = r.bearer;
    }
    if (r.passport !== undefined) {
      out.passport = r.passport;
    }
    if (typeof r.serverId === 'string' && r.serverId.length > 0) {
      out.serverId = r.serverId;
    }
    return out;
  }

  const errBlock = (parsed as { error?: { code?: unknown; message?: unknown } } | null)
    ?.error;
  const errCode = errBlock && typeof errBlock.code === 'string' ? errBlock.code : '';
  const errMsg = errBlock && typeof errBlock.message === 'string' ? errBlock.message : '';
  const presented = describePairServerError(errCode, errMsg);
  if (presented.tailored) {
    const out: BridgePairCodeInputCommitResult = {
      ok: false,
      error: presented.code as PairServerErrorCode,
    };
    if (errMsg) out.detail = errMsg;
    return out;
  }
  // A properly-shaped refusal with a code we don't map. The URL reached
  // the right server, so "check the URL" would be a lie; carry the
  // server's own words instead.
  const refused: BridgePairCodeInputCommitResult = {
    ok: false,
    error: 'pair_code_input_server_refused',
    detail: errMsg || `HTTP ${res.status}`,
  };
  if (presented.serverSaid) refused.serverSaid = presented.serverSaid;
  if (errCode) refused.serverCode = errCode;
  return refused;
};

// ════════════════════════════════════════════════════════════════
// DOM host
// ════════════════════════════════════════════════════════════════

export interface BridgePairCodeInputDeeplinkSeed {
  /** Pre-fill the Server address field. */
  serverUrl?: string;
  /** Pre-fill the Pairing code field. */
  pairingCode?: string;
}

/** DD#7 — the service worker does the pairing; the side panel asks it.
 *  Production sends these as `recued.bridge.pair` messages
 *  (`pairing-client.ts`); tests drive the same orchestrator in memory. None
 *  of these should reject — a client that cannot reach the worker answers
 *  `{ ok: false, kind: 'error' }` — but the host copes if one does. */
export interface BridgePairingClient {
  status(): Promise<BridgePairStatus>;
  wait(): Promise<BridgePairOutcome | null>;
  start(input: BridgePairStartInput): Promise<BridgePairOutcome>;
  finish(): Promise<BridgePairOutcome>;
  abandon(): Promise<{ ok: boolean }>;
}

export interface MountBridgePairCodeInputHostOptions {
  /** Slot the form renders into. */
  splashElement: HTMLElement;
  /** Document seam (tests). */
  document?: Document;
  /** Deeplink pre-fills. */
  seed?: BridgePairCodeInputDeeplinkSeed;
  /** Device label sent with the pair ("Chrome on Windows"). */
  displayName?: string;
  /** The worker's pairing session (DD#7). */
  pairing: BridgePairingClient;
}

export interface MountedBridgePairCodeInputHost {
  /** Synchronous teardown — clears the form DOM + detaches listeners. */
  dispose(): void;
  /** Test affordance — drive Pair (or Finish pairing) without a click. */
  submit(): Promise<void>;
  /** Test affordance — programmatic field write (mirrors a user
   *  keystroke / paste). For `recoveryKey` a whitespace-containing
   *  value triggers paste-style distribute across the 24 slots. */
  setFieldValue(
    field: 'serverUrl' | 'pairingCode' | 'recoveryKey',
    value: string,
  ): void;
  /** Resolves once the worker's answer to "where does pairing stand?" has
   *  been rendered. */
  ready: Promise<void>;
}

/** DD#7 — which screen the host shows. Only `form` takes input. */
type BridgePairView = 'checking' | 'form' | 'pairing' | 'finish' | 'paired' | 'success';

interface BridgePairCodeInputState {
  view: BridgePairView;
  serverUrl: string;
  pairingCode: string;
  recoveryKey: string;
  submitting: boolean;
  error: {
    copy: string;
    code: BridgePairCodeInputErrorCode;
    /** The raw code the server sent, when unmapped. Rendered as an
     *  attribute for support, never as copy. */
    serverCode?: string;
    /** D-212 tail #6 — the server's own message, quoted + attributed
     *  beneath `copy`. Its own field, never concatenated: at the pairing
     *  screen the host is unauthenticated and its words must not read as
     *  Recued's. */
    serverSaid?: string;
  } | null;
  /** The server the pairing / finish / paired / success screens name. */
  shownServer: string;
}

interface DelegatedEventTarget {
  closest?(selector: string): HTMLElement | null;
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs a client call; a rejection becomes the `error` outcome. */
const settle = async <T>(
  call: () => Promise<T>,
): Promise<T | { ok: false; kind: 'error'; detail: string }> => {
  try {
    return await call();
  } catch (err) {
    return { ok: false, kind: 'error', detail: describeError(err) };
  }
};

export const mountBridgePairCodeInputHost = (
  options: MountBridgePairCodeInputHostOptions,
): MountedBridgePairCodeInputHost => {
  const splashEl = options.splashElement;
  if (!splashEl) {
    throw new Error(
      'bridge-pair-code-input-host: splashElement is required',
    );
  }
  const pairing = options.pairing;

  let state: BridgePairCodeInputState = {
    view: 'checking',
    serverUrl: options.seed?.serverUrl ?? '',
    pairingCode: options.seed?.pairingCode ?? '',
    recoveryKey: '',
    submitting: false,
    error: null,
    shownServer: '',
  };
  let disposed = false;

  const render = (): void => {
    if (disposed) return;
    splashEl.innerHTML = renderView(state);
  };

  const setState = (patch: Partial<BridgePairCodeInputState>): void => {
    state = { ...state, ...patch };
    render();
  };

  // ── Delegated `input` listener ───────────────────────────────
  const onInput = (event: Event): void => {
    const target = event.target as (HTMLInputElement & DelegatedEventTarget) | null;
    if (!target) return;
    const fieldEl = target.closest?.(`[data-${BRIDGE_PAIR_CODE_INPUT_FIELD_NAME}]`) as
      | (HTMLInputElement & { dataset?: DOMStringMap })
      | null;
    const recoveryEl = target.closest?.(
      `[data-${BRIDGE_PAIR_CODE_INPUT_RECOVERY_FIELD_NAME}]`,
    ) as (HTMLInputElement & { dataset?: DOMStringMap }) | null;

    if (fieldEl) {
      const kind = fieldEl.getAttribute(`data-${BRIDGE_PAIR_CODE_INPUT_FIELD_NAME}`);
      const value = fieldEl.value ?? '';
      if (kind === 'server-url') {
        state = { ...state, serverUrl: value, error: null };
        clearStatusInPlace();
        syncSubmitState();
        return;
      }
      if (kind === 'pairing-code') {
        state = { ...state, pairingCode: value, error: null };
        clearStatusInPlace();
        // The code alone can enable Pair now, so typing it must re-run the gate
        // — without this, URL-then-code left the button disabled.
        syncSubmitState();
        return;
      }
    }
    if (recoveryEl) {
      const raw = recoveryEl.value ?? '';
      const idx = parseInt(recoveryEl.dataset?.index ?? '-1', 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= 24) return;
      if (/\s/.test(raw)) {
        const tokens = raw.split(/\s+/).filter((w) => w.length > 0);
        const current = toRecoveryWords(state.recoveryKey);
        const next = distributeTokens(current, tokens, idx);
        setState({ recoveryKey: fromRecoveryWords(next), error: null });
        return;
      }
      const words = toRecoveryWords(state.recoveryKey);
      words[idx] = raw.trim().toLowerCase();
      state = {
        ...state,
        recoveryKey: fromRecoveryWords(words),
        error: null,
      };
      clearStatusInPlace();
      syncSubmitState();
      syncRecoveryCounter();
    }
  };

  // ── Delegated `click` listener — submit / finish, start over ─────
  const onClick = (event: Event): void => {
    const target = event.target as DelegatedEventTarget | null;
    if (!target) return;
    const startOver = target.closest?.(
      `[data-action="${BRIDGE_PAIR_CODE_INPUT_START_OVER_ACTION}"]`,
    ) as HTMLButtonElement | null;
    if (startOver) {
      if (!startOver.disabled) void doStartOver();
      return;
    }
    const btn = target.closest?.(
      `[data-action="${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ACTION}"]`,
    ) as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.disabled) return;
    void doSubmit();
  };

  // ── `submit` listener — covers Enter-press inside the form ───
  const onSubmit = (event: Event): void => {
    event.preventDefault?.();
    if (state.view !== 'form' || isSubmitBlocked(state)) return;
    void doSubmit();
  };

  splashEl.addEventListener('input', onInput);
  splashEl.addEventListener('click', onClick);
  splashEl.addEventListener('submit', onSubmit);

  const syncSubmitState = (): void => {
    const btn = splashEl.querySelector?.(
      `#${BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID}`,
    ) as HTMLButtonElement | null;
    if (btn) btn.disabled = isSubmitBlocked(state);
    const requirement = splashEl.querySelector?.(
      `#${BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID}`,
    ) as HTMLElement | null;
    if (requirement) requirement.textContent = submitBlockedReason(state) ?? '';
  };

  const syncRecoveryCounter = (): void => {
    const filled = toRecoveryWords(state.recoveryKey).filter((w) => w.length > 0).length;
    const counter = splashEl.querySelector?.('.rx-recovery-word-count') as
      | HTMLElement
      | null;
    if (counter) counter.textContent = `${filled} of 24 words entered.`;
  };

  const clearStatusInPlace = (): void => {
    const status = splashEl.querySelector?.(
      `#${BRIDGE_PAIR_CODE_INPUT_STATUS_ID}`,
    ) as HTMLElement | null;
    if (!status) return;
    if (status.textContent !== '') status.textContent = '';
    if ((status as { className?: string }).className !== 'pair-code-input-status') {
      (status as { className?: string }).className = 'pair-code-input-status';
    }
    status.removeAttribute?.('data-error');
  };

  /** Shows how a `start` or `finish` ended. */
  const applyOutcome = (outcome: BridgePairOutcome): void => {
    if (outcome.ok) {
      setState({
        view: 'success',
        submitting: false,
        error: null,
        pairingCode: '',
        shownServer: outcome.serverUrl,
      });
      return;
    }
    switch (outcome.kind) {
      case 'refused':
        setState({
          view: 'form',
          submitting: false,
          error: {
            copy: BRIDGE_PAIR_CODE_INPUT_ERROR_COPY[outcome.error],
            code: outcome.error,
            ...(outcome.serverSaid ? { serverSaid: outcome.serverSaid } : {}),
            ...(outcome.serverCode ? { serverCode: outcome.serverCode } : {}),
          },
        });
        return;
      case 'accepted':
        // DD#6 — the code is spent; the only way on is to finish.
        setState({
          view: 'finish',
          submitting: false,
          pairingCode: '',
          serverUrl: outcome.serverUrl,
          shownServer: outcome.serverUrl,
          error: outcome.reason
            ? {
                copy: handoffFailedCopy(
                  `${BRIDGE_PAIR_COMPLETION_ERROR_COPY[outcome.reason]}${
                    outcome.detail ? ` (${outcome.detail})` : ''
                  }`,
                ),
                code: 'pair_code_input_handoff_failed',
              }
            : null,
        });
        return;
      case 'final':
        setState({
          view: 'form',
          submitting: false,
          pairingCode: '',
          error: {
            copy: BRIDGE_PAIR_COMPLETION_ERROR_COPY[outcome.error],
            code: 'pair_code_input_handoff_final',
          },
        });
        return;
      case 'busy':
        setState({
          view: 'pairing',
          submitting: false,
          error: null,
          shownServer: outcome.serverUrl || state.serverUrl,
        });
        void followInFlight();
        return;
      case 'paired':
        setState({ view: 'paired', submitting: false, error: null, shownServer: outcome.serverUrl });
        return;
      case 'nothing_to_finish':
        setState({
          view: 'form',
          submitting: false,
          pairingCode: '',
          error: {
            copy: BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_handoff_lost,
            code: 'pair_code_input_handoff_lost',
          },
        });
        return;
      case 'error':
        setState({
          view: state.view === 'finish' ? 'finish' : 'form',
          submitting: false,
          error: { copy: workerFailedCopy(outcome.detail), code: 'pair_code_input_worker_failed' },
        });
        return;
    }
  };

  /** A panel opened mid-attempt: wait out the one the worker is running. */
  const followInFlight = async (): Promise<void> => {
    const outcome = await settle(() => pairing.wait());
    if (disposed) return;
    if (outcome === null) {
      await applyStatus();
      return;
    }
    applyOutcome(outcome);
  };

  /** DD#7 — every mount starts from what the worker says, so a paired
   *  bridge never shows the pair form. */
  const applyStatus = async (): Promise<void> => {
    let status: BridgePairStatus;
    try {
      status = await pairing.status();
    } catch {
      status = { state: 'unpaired' };
    }
    if (disposed) return;
    switch (status.state) {
      case 'pairing':
        setState({
          view: 'pairing',
          shownServer: status.serverUrl || state.serverUrl,
          ...(status.serverUrl ? { serverUrl: status.serverUrl } : {}),
        });
        void followInFlight();
        return;
      case 'accepted':
        setState({
          view: 'finish',
          serverUrl: status.serverUrl,
          shownServer: status.serverUrl,
          pairingCode: '',
        });
        return;
      case 'paired':
        setState({ view: 'paired', shownServer: status.serverUrl });
        return;
      case 'unpaired':
        // Unpaired because the server refused it, or disconnected without telling the server: say
        // so, with its address typed in.
        setState(status.refused
          ? {
            view: 'form',
            serverUrl: status.refused.serverUrl,
            error: {
              copy: BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_sign_in_refused,
              code: 'pair_code_input_sign_in_refused',
            },
          }
          : status.disconnected
            ? {
              view: 'form',
              serverUrl: status.disconnected.serverUrl,
              error: {
                copy: BRIDGE_PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_disconnected_untold,
                code: 'pair_code_input_disconnected_untold',
              },
            }
            : { view: 'form' });
        return;
      default: {
        // A state this host does not know (an older worker would not send
        // one; the client rejects them) — the form is the safe screen.
        const _exhaustive: never = status;
        void _exhaustive;
        setState({ view: 'form' });
      }
    }
  };

  const doSubmit = async (): Promise<void> => {
    if (disposed || state.submitting) return;
    if (state.view === 'finish') {
      await doFinish();
      return;
    }
    if (state.view !== 'form' || isSubmitBlocked(state)) return;
    // The waiting screen from the first moment: the server can take seconds,
    // and a form that only greys out reads as stuck. What was typed stays in
    // `state`, so a refusal brings the form back filled in.
    setState({ view: 'pairing', submitting: true, error: null, shownServer: state.serverUrl });
    const code = state.pairingCode.trim();
    const recoveryKey = state.recoveryKey.trim();
    const outcome = await settle(() =>
      pairing.start({
        serverUrl: state.serverUrl,
        ...(code.length > 0 ? { code } : {}),
        ...(recoveryKey.length > 0 ? { recoveryKey } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
      }),
    );
    if (disposed) return;
    applyOutcome(outcome);
  };

  /** DD#6 — finish with the reply the worker holds; the code is never sent
   *  again. */
  const doFinish = async (): Promise<void> => {
    if (disposed || state.submitting || state.view !== 'finish') return;
    setState({ submitting: true, error: null });
    const outcome = await settle(() => pairing.finish());
    if (disposed) return;
    applyOutcome(outcome);
  };

  /** DD#6 — drop an accepted pairing that will not finish. The server keeps
   *  the device it issued (Settings → Devices can remove it); this bridge
   *  pairs again from the start, with a new code. */
  const doStartOver = async (): Promise<void> => {
    if (disposed || state.submitting || state.view !== 'finish') return;
    setState({ submitting: true, error: null });
    const result = await settle(() => pairing.abandon());
    if (disposed) return;
    if ('kind' in result) {
      setState({
        submitting: false,
        error: { copy: workerFailedCopy(result.detail), code: 'pair_code_input_worker_failed' },
      });
      return;
    }
    if (!result.ok) {
      // An attempt is running after all — show it rather than the form.
      setState({ submitting: false });
      await applyStatus();
      return;
    }
    setState({ view: 'form', submitting: false, pairingCode: '', error: null });
  };

  render();
  const ready = applyStatus();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      splashEl.removeEventListener('input', onInput);
      splashEl.removeEventListener('click', onClick);
      splashEl.removeEventListener('submit', onSubmit);
      splashEl.innerHTML = '';
    },
    submit: doSubmit,
    setFieldValue: (field, value) => {
      if (disposed) return;
      if (field === 'serverUrl') state = { ...state, serverUrl: value, error: null };
      else if (field === 'pairingCode')
        state = { ...state, pairingCode: value, error: null };
      else state = { ...state, recoveryKey: value, error: null };
      render();
    },
    ready,
  };
};

// ════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════

const isSubmitBlocked = (s: BridgePairCodeInputState): boolean => {
  return s.submitting || submitBlockedReason(s) !== null;
};

const submitBlockedReason = (s: BridgePairCodeInputState): string | null => {
  if (s.submitting) return null;
  // Only the form takes input; finishing needs nothing typed (DD#6).
  if (s.view !== 'form') return null;
  if (s.serverUrl.trim().length === 0) {
    return 'Enter your server address to continue.';
  }
  // ⛔ A PAIRING CODE ALONE IS A COMPLETE PAIR. `/auth/pair` takes a code, a
  // recovery key, or both, and `submitBridgePairCodeInput` sends whichever is
  // filled in — but this gate, ported from the webclient form, demanded all 24
  // words before Pair would enable. A bridge joining an enrolled server, which
  // is every reviewer and every added device, could not pair with the code the
  // server had just printed. Its tests called `submit` directly, so they never
  // met the disabled button (found 2026-10-05, pairing a real build).
  const filled = toRecoveryWords(s.recoveryKey).filter((w) => w.length > 0).length;
  // A partly typed key would be sent and refused as invalid: finish it or clear it.
  if (filled > 0 && filled < 24) {
    const remaining = 24 - filled;
    return `${remaining} recovery word${remaining === 1 ? '' : 's'} remaining.`;
  }
  if (filled === 0 && s.pairingCode.trim().length === 0) {
    return 'Enter the pairing code from your server to continue.';
  }
  return null;
};

/** The host a screen names: `wss://review.recued.com/ws` and
 *  `https://review.recued.com` both read "review.recued.com". */
const serverLabel = (raw: string): string => {
  const trimmed = raw.trim();
  try {
    const host = new URL(trimmed).host;
    if (host.length > 0) return host;
  } catch {
    /* not a full URL — fall through */
  }
  return trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '') || trimmed;
};

// ════════════════════════════════════════════════════════════════
// HTML templates
// ════════════════════════════════════════════════════════════════

const renderView = (state: BridgePairCodeInputState): string => {
  switch (state.view) {
    case 'checking':
      return renderChecking();
    case 'form':
      return renderForm(state);
    case 'pairing':
      return renderPairing(state);
    case 'finish':
      return renderFinish(state);
    case 'paired':
      return renderPaired(state);
    case 'success':
      return renderSuccess(state);
    default: {
      const _exhaustive: never = state.view;
      void _exhaustive;
      return renderForm(state);
    }
  }
};

const statusBlockFor = (state: BridgePairCodeInputState): string =>
  state.error
    ? `<p id="${e(BRIDGE_PAIR_CODE_INPUT_STATUS_ID)}" role="alert" class="pair-code-input-error" data-error="${e(state.error.code)}">${e(state.error.copy)}</p>`
    : `<p id="${e(BRIDGE_PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-status"></p>`;

const renderForm = (state: BridgePairCodeInputState): string => {
  const words = toRecoveryWords(state.recoveryKey);
  const disabled = isSubmitBlocked(state);
  const requirementText = submitBlockedReason(state) ?? '';
  // D-212 tail #6 — the server's own words, quoted UNDER Recued's with an
  // explicit label + its own element. The bridge pairs against an
  // unauthenticated host exactly as the webclient does, so the same
  // attribution rule applies here.
  const serverSaidBlock =
    state.error?.serverSaid
      ? `<p class="pair-code-input-server-said" data-server-said><span class="pair-code-input-server-said-label">${e(PAIR_SERVER_SAID_LABEL)}</span> <q>${e(state.error.serverSaid)}</q></p>`
      : '';
  const rawServerCode = codeShaped(state.error?.serverCode);
  const serverCodeAttr = rawServerCode
    ? ` ${BRIDGE_PAIR_CODE_INPUT_SERVER_CODE_ATTR}="${e(rawServerCode)}"`
    : '';
  const statusBlock = state.error
    ? `<p id="${e(BRIDGE_PAIR_CODE_INPUT_STATUS_ID)}" role="alert" class="pair-code-input-error" data-error="${e(state.error.code)}"${serverCodeAttr}>${e(state.error.copy)}</p>${serverSaidBlock}`
    : `<p id="${e(BRIDGE_PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-status"></p>`;

  return `
    <form id="${e(BRIDGE_PAIR_CODE_INPUT_FORM_ID)}" class="pair-code-input-form" novalidate>
      <h2 class="pair-code-input-title">Pair this bridge</h2>
      <p class="pair-code-input-get-recued" id="${e(BRIDGE_PAIR_CODE_INPUT_GET_RECUED_ID)}">
        No Recued yet? It is free, and runs on your own computer or server.
        <a href="${e(RECUED_GET_STARTED_URL)}" target="_blank" rel="noopener noreferrer">Install Recued first</a>,
        then come back to pair this bridge.
      </p>
      <p class="pair-code-input-help" id="bridge-pair-code-input-help">
        Run <code>recued pair</code> on your server, then enter your server address and
        the pairing code it prints.
      </p>

      <div class="form-row">
        <label for="${e(BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID)}">Server address</label>
        <input id="${e(BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID)}"
          type="url"
          data-${e(BRIDGE_PAIR_CODE_INPUT_FIELD_NAME)}="server-url"
          value="${e(state.serverUrl)}"
          placeholder="http://localhost:3001"
          aria-describedby="bridge-pair-code-input-help"
          autocomplete="off"
          ${state.submitting ? 'disabled' : ''} />
      </div>

      <div class="form-row">
        <label for="${e(BRIDGE_PAIR_CODE_INPUT_CODE_ID)}">
          Pairing code
        </label>
        <input id="${e(BRIDGE_PAIR_CODE_INPUT_CODE_ID)}"
          type="text"
          data-${e(BRIDGE_PAIR_CODE_INPUT_FIELD_NAME)}="pairing-code"
          value="${e(state.pairingCode)}"
          placeholder="From server terminal"
          class="pair-code-input-code"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          ${state.submitting ? 'disabled' : ''} />
      </div>

      <fieldset class="form-row form-row-recovery">
        <legend>Recovery key <span class="pair-code-input-optional">(optional)</span></legend>
        <div class="pair-code-input-recovery">
          <p class="field-hint">
            Leave this empty when you have a pairing code. If you enter it, your server
            checks it against its sealed verifier; this bridge never stores it.
          </p>
          ${recoveryGrid({
            words,
            fieldName: BRIDGE_PAIR_CODE_INPUT_RECOVERY_FIELD_NAME,
            fieldValue: BRIDGE_PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE,
            idPrefix: BRIDGE_PAIR_CODE_INPUT_RECOVERY_PREFIX,
            disabled: state.submitting,
          })}
        </div>
      </fieldset>

      ${statusBlock}

      <div class="pair-code-input-actions">
        <p id="${e(BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID)}"
          class="pair-code-input-requirement" role="status" aria-live="polite">${e(requirementText)}</p>
        <button id="${e(BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID)}"
          type="button"
          data-action="${e(BRIDGE_PAIR_CODE_INPUT_SUBMIT_ACTION)}"
          aria-describedby="${e(BRIDGE_PAIR_CODE_INPUT_REQUIREMENT_ID)}"
          ${disabled ? 'disabled' : ''}>Pair this bridge</button>
      </div>
    </form>
  `;
};

/** DD#7 — while the worker asks itself where pairing stands. Brief: the
 *  answer is in memory or storage. */
const renderChecking = (): string => `
    <div class="pair-code-input-form">
      <p id="${e(BRIDGE_PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-help">Checking this bridge…</p>
    </div>
  `;

const spinner = (): string =>
  `<span class="pair-code-input-spinner" ${BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR} aria-hidden="true"></span>`;

/** DD#7 — the worker is waiting for the server: from the moment Pair is
 *  clicked, and for a panel opened mid-attempt. No way to send the code
 *  again — it may already be spent. */
const renderPairing = (state: BridgePairCodeInputState): string => `
    <div class="pair-code-input-form" aria-busy="true">
      <h2 class="pair-code-input-title">Pairing…</h2>
      <p class="pair-code-input-waiting" role="status">
        ${spinner()}
        <span>Waiting for <code>${e(serverLabel(state.shownServer))}</code> to answer.</span>
      </p>
      <p class="pair-code-input-help" id="bridge-pair-code-input-help">
        This can take a few seconds. Pairing carries on if you close this panel.
      </p>
      ${statusBlockFor(state)}
    </div>
  `;

/** DD#6 — the view for an accepted pairing whose setup has not finished.
 *  No fields: the code is spent and the server URL has already answered, so
 *  the only choices are to finish or to start over. It keeps the form, status
 *  and submit ids, so inspectors and tests read it the same way. */
const renderFinish = (state: BridgePairCodeInputState): string => {
  const submitLabel = state.submitting ? `${spinner()}Finishing…` : 'Finish pairing';
  return `
    <form id="${e(BRIDGE_PAIR_CODE_INPUT_FORM_ID)}" class="pair-code-input-form" novalidate>
      <h2 class="pair-code-input-title">Finish pairing</h2>
      <p class="pair-code-input-help" id="bridge-pair-code-input-help">
        Your server at <code>${e(state.serverUrl)}</code> accepted the pairing code,
        so that code can't be used again. Finish setting up this bridge to start
        using it.
      </p>

      ${statusBlockFor(state)}

      <div class="pair-code-input-actions">
        <button id="${e(BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID)}"
          type="button"
          data-action="${e(BRIDGE_PAIR_CODE_INPUT_SUBMIT_ACTION)}"
          ${state.submitting ? 'disabled' : ''}>${submitLabel}</button>
        <button id="${e(BRIDGE_PAIR_CODE_INPUT_START_OVER_ID)}"
          type="button"
          class="pair-code-input-start-over"
          data-action="${e(BRIDGE_PAIR_CODE_INPUT_START_OVER_ACTION)}"
          aria-describedby="bridge-pair-code-input-start-over-hint"
          ${state.submitting ? 'disabled' : ''}>Start over</button>
        <p id="bridge-pair-code-input-start-over-hint" class="pair-code-input-start-over-hint">
          Starting over means pairing again with a new code from your server.
        </p>
      </div>
    </form>
  `;
};

/** DD#7 — the worker says this bridge is paired while the panel still
 *  showed it unpaired. Never a pair form, which would ask for a spent code;
 *  the panel swaps in its paired sections as soon as it reads the pair. */
const renderPaired = (state: BridgePairCodeInputState): string => `
    <div class="pair-code-input-form">
      <h2 class="pair-code-input-title">This bridge is paired</h2>
      <p class="pair-code-input-help" id="bridge-pair-code-input-help">
        It's paired with <code>${e(serverLabel(state.shownServer))}</code>.
      </p>
    </div>
  `;

/** DD#7 — paired just now. The worker is connecting to the server; the
 *  panel replaces this with its sections, which say when it is connected. */
const renderSuccess = (state: BridgePairCodeInputState): string => `
    <div class="pair-code-input-form">
      <h2 class="pair-code-input-title">Paired</h2>
      <p id="${e(BRIDGE_PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-help" data-paired>
        This bridge is paired with <code>${e(serverLabel(state.shownServer))}</code>.
        Connecting to your server…
      </p>
    </div>
  `;
