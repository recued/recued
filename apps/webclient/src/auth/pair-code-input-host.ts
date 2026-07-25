/** D-156 P3 — Pair-code-input-host.
 *
 *  Composes the 3-field pair form (Server URL + optional Pairing
 *  code + required 24-word recovery key) that submits to the
 *  server's `/auth/pair` endpoint (the D-121 P5 entry path). Replaces
 *  the D-148 § A.2.1 pair-blob substrate per
 *  [[d-156-pair-substrate-retirement-pending-design]]: the receiver
 *  of a pair invite is always a webclient or bridge, surfaces where
 *  typing the 3 short values is trivial.
 *
 *  Shipped in P3 as a self-contained module; the bootstrap wiring
 *  (deeplink seed + flag-gated mount) lands in P4 alongside the
 *  `/pair` query-route parser.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — The form composes `recoveryGrid` from
 *  `@recued/ui-shared/primitives` directly, NOT
 *  `renderRecoveryKeyEntry` from `@recued/ui-shared/account`.
 *  `renderRecoveryKeyEntry` verifies the typed key against a
 *  local sealed `recued.recovery.check` sentinel — but the pair
 *  receiver is freshly-unpaired and has no local sentinel; the
 *  server is the authority. (D-156 P1 round-4 P2 deferral rationale.)
 *  Client-side validation is limited to a BIP39 checksum.
 *
 *  DD#2 — Pairing code is OPTIONAL. Per Q5 resolution in the design
 *  draft: recovery key is ALWAYS required, pairing code only for the
 *  first pair on an un-enrolled server. The server's `/auth/pair`
 *  endpoint enforces the same shape (`code` or `recoveryKey` must be
 *  present; `code` is required only when the realm has no recovery
 *  sentinel yet). Submit stays disabled until URL + 24 words; the
 *  code field is independent of the disabled gate.
 *
 *  DD#3 — On success, `onPaired` receives `{ serverUrl, token,
 *  serverId?, recoveryKey }`. The host itself persists nothing; the
 *  caller decides whether to wrap the bearer through the token
 *  store, seed `pair_metadata`, or kick off a passport-fetch to
 *  fill `server_public_key` + `cert_pin_state`. P5's
 *  devices-page-mount + the bootstrap re-entry path will own the
 *  IDB writes.
 *
 *  DD#4 — `submitPairCodeInput` is exposed as a pure function so the
 *  caller (and tests) can drive the network call without the DOM.
 *  Never throws — every parse / transport / server-error path
 *  surfaces as a tagged result.
 *
 *  DD#5 — Event wiring uses ONE delegated `input` listener at the
 *  root + ONE delegated `click` listener (matches the launch-wizard
 *  / reception-authoring pattern). Per-element listener attach via
 *  `attachFieldHandlers` would require the test's fake DOM to
 *  implement `querySelectorAll` — the existing webclient fake-DOM
 *  helper only mocks `closest()` + delegated dispatch. The
 *  recovery-grid input handling (paste fan-out + per-slot update)
 *  is replicated inline rather than reusing
 *  `createRecoveryGridFieldHandler`, which is hard-coded to the
 *  per-element attach API.
 *
 *  DD#6 — The "generate a new recovery key" first-run flow is a MODE
 *  toggle inside this form, NOT `renderRecoverySetup` from
 *  `@recued/ui-shared/account`. Two reasons it doesn't fit here: (a)
 *  its `includeOptionalPair` UX frames pairing as an optional,
 *  collapsed `<details>` — but at first run pairing is the whole point
 *  and the code/URL must be prominent; (b) it persists a local PBKDF2
 *  `recued.recovery.check` sentinel, which the pair receiver
 *  deliberately does NOT keep (DD#1 — the server is the authority).
 *  So the mint → write-down → re-type-to-confirm stages are inlined
 *  (reusing `generateRecoveryKey` + `recoveryGrid`), and the confirmed
 *  GENERATED key flows through the same `doSubmit` → `/auth/pair`
 *  enroll path as a typed key. Keeping ONE submit path means the
 *  cross-tab finalize lock + preflight cover both modes for free.
 */

import { generateRecoveryKey, isValidRecoveryKey } from '@recued/crypto';
import { recoveryGrid } from '@recued/ui-shared/primitives';
import {
  distributeTokens,
  fromRecoveryWords,
  toRecoveryWords,
} from '@recued/ui-shared/recovery-words';
import { e } from '@recued/ui-shared/template';

import {
  type PairFinalizeLockProvider,
  withPairFinalizeLock,
} from './pair-code-success.js';
import type { ArchiveUploadFile } from '../settings/archive-backup-panel.js';

// ════════════════════════════════════════════════════════════════
// Stable DOM ids — tests + Settings → Privacy inspector read these.
// ════════════════════════════════════════════════════════════════

const SPLASH_ID = 'webclient-boot-splash-message';
export const PAIR_CODE_INPUT_FORM_ID = 'webclient-pair-code-input-form';
export const PAIR_CODE_INPUT_SERVER_URL_ID = 'webclient-pair-code-input-server-url';
export const PAIR_CODE_INPUT_CODE_ID = 'webclient-pair-code-input-code';
export const PAIR_CODE_INPUT_SUBMIT_ID = 'webclient-pair-code-input-submit';
export const PAIR_CODE_INPUT_STATUS_ID = 'webclient-pair-code-input-status';
const PAIR_CODE_INPUT_REQUIREMENT_ID = 'webclient-pair-code-input-requirement';
export const PAIR_CODE_INPUT_RECOVERY_PREFIX = 'webclient-pair-code-input-recovery';

const PAIR_CODE_INPUT_FIELD_NAME = 'pair-code-input-field';
const PAIR_CODE_INPUT_RECOVERY_FIELD_NAME = 'pair-code-input-recovery-field';
const PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE = 'recovery-word';
const PAIR_CODE_INPUT_SUBMIT_ACTION = 'pair-code-input-submit';

// First-run "generate a new recovery key" flow (the launch-grade gap:
// on a fresh, un-enrolled server nothing else hands the user a phrase,
// so the webclient must mint + reveal it here, then enroll it via the
// SAME /auth/pair POST). Delivered as a recovery-key MODE toggle inside
// the existing form so there is ONE lock-protected submit path —
// `enter` is the unchanged default (re-pair / existing key); `generate`
// adds the mint → write-down → re-type-to-confirm sub-flow.
const PAIR_CODE_INPUT_MODE_ENTER_ACTION = 'pair-code-input-mode-enter';
const PAIR_CODE_INPUT_MODE_GENERATE_ACTION = 'pair-code-input-mode-generate';
const PAIR_CODE_INPUT_GENERATE_ACTION = 'pair-code-input-generate';
const PAIR_CODE_INPUT_GENERATE_ACK_ACTION = 'pair-code-input-generate-ack';
const PAIR_CODE_INPUT_GENERATE_RESTART_ACTION = 'pair-code-input-generate-restart';

// M5 S3.3 — the third recovery-source mode: restore a `.recued.archive`
// backup as this browser's FIRST action (the no-pair-then-restore migration
// path). This mode is a COLLECT surface only — it gathers the server URL +
// pairing code + the archive's 24-word recovery key + the picked file and
// hands them to `onRestoreSubmit`. The multi-step restore (pair → upload →
// validate → preview → commit) is driven by the boot-layer orchestrator
// (`restore-onboarding.ts`), which lives where the token / local stores are.
const PAIR_CODE_INPUT_MODE_RESTORE_ACTION = 'pair-code-input-mode-restore';
const PAIR_CODE_INPUT_RESTORE_FILE_NAME = 'pair-code-input-restore-file';
export const PAIR_CODE_INPUT_RESTORE_FILE_ID =
  'webclient-pair-code-input-restore-file';

// ════════════════════════════════════════════════════════════════
// Error codes + copy
// ════════════════════════════════════════════════════════════════

/** Client-side errors — the form / pure submit caught these BEFORE
 *  a server reply was parsed (or in the place of a reply). */
export type PairCodeInputClientErrorCode =
  | 'pair_code_input_no_server_url'
  | 'pair_code_input_no_input'
  | 'pair_code_input_invalid_recovery_key'
  | 'pair_code_input_transport_failed'
  | 'pair_code_input_server_unknown_error'
  | 'pair_code_input_already_paired';

/** Server-side errors — the `/auth/pair` endpoint's closed-list error
 *  codes (see `backend/server/src/server.ts:473`). Surfaced verbatim
 *  so the copy map can render targeted user-facing strings. */
export type PairCodeInputServerErrorCode =
  | 'invalid_code'
  | 'recovery_key_invalid'
  | 'bad_request'
  | 'server_not_configured';

export type PairCodeInputErrorCode =
  | PairCodeInputClientErrorCode
  | PairCodeInputServerErrorCode;

/** User-facing copy for every documented error code. Tests assert
 *  the structured `data-error` value on the status element; this map
 *  is what renders to the human. */
export const PAIR_CODE_INPUT_ERROR_COPY: Readonly<Record<PairCodeInputErrorCode, string>> = {
  pair_code_input_no_server_url: 'Enter the URL your recued-server is reachable at.',
  pair_code_input_no_input:
    'Enter your 24-word recovery key, or a pairing code from the server terminal, or both.',
  pair_code_input_invalid_recovery_key:
    "That doesn't look like a valid 24-word recovery key. Check for typos or missing words.",
  pair_code_input_transport_failed:
    "Couldn't reach your recued-server. Check the URL and that the server is running, then try again.",
  pair_code_input_server_unknown_error:
    'The server returned an unexpected response. Check the URL and try again.',
  pair_code_input_already_paired:
    'Another tab finished pairing while this form was open. Reload to use the existing pair, or clear this browser from Settings to pair a new server.',
  invalid_code:
    'That pairing code is invalid, expired, or already used. Refresh it from the server terminal.',
  recovery_key_invalid:
    "That recovery key doesn't match the one your server has on file. Re-check your written copy and re-enter.",
  bad_request: 'The server rejected the request. Re-check the fields and try again.',
  server_not_configured:
    'The server is missing its recovery-key check store. Ask your admin to run `recued-server pair` first.',
};

/** Generate-mode override for `recovery_key_invalid`. A freshly-minted
 *  key that the server rejects as a mismatch means the realm is ALREADY
 *  enrolled (every later pair only VERIFIES) — so the user wanted the
 *  enter path, not generate. Steer them there instead of the generic
 *  "check your written copy" copy, which makes no sense for a key we
 *  just generated. */
export const PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY =
  "This server already has a recovery key. Enter your existing 24-word key below to connect.";

// ════════════════════════════════════════════════════════════════
// Pure submit
// ════════════════════════════════════════════════════════════════

export interface PairCodeInputCommitOptions {
  /** Server URL the form posts against. `/auth/pair` is appended. */
  serverUrl: string;
  /** Pairing code — optional once the realm is enrolled. */
  code?: string;
  /** 24-word recovery key. The form always passes one; the pure
   *  function tolerates absence so callers can submit code-only for
   *  legacy / scripted flows. */
  recoveryKey?: string;
  /** Optional instance id stamped on the server's `paired_instances`
   *  row. Defaults absent — the server treats this as an anonymous
   *  pair. */
  instanceId?: string;
  /** Optional human-readable device label. */
  displayName?: string;
  /** Test seam — overrides `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export type PairCodeInputCommitResult =
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
      error: PairCodeInputErrorCode;
      detail?: string;
    };

const normalizeServerUrl = (raw: string): string => raw.trim().replace(/\/$/, '');

const isKnownServerErrorCode = (s: string): s is PairCodeInputServerErrorCode =>
  s === 'invalid_code' ||
  s === 'recovery_key_invalid' ||
  s === 'bad_request' ||
  s === 'server_not_configured';

/** Submit the form contents to `/auth/pair`. Never throws — every
 *  parse / transport / server-error path surfaces as a tagged result.
 *  The DOM host wraps this with state + inline error rendering;
 *  callers can also invoke it directly. */
export const submitPairCodeInput = async (
  options: PairCodeInputCommitOptions,
): Promise<PairCodeInputCommitResult> => {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? '');
  if (serverUrl.length === 0) {
    return { ok: false, error: 'pair_code_input_no_server_url' };
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
  body.clientKind = 'webclient';

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
    const out: PairCodeInputCommitResult = { ok: true, token: r.token };
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

  const errBlock = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const errCode = errBlock && typeof errBlock.code === 'string' ? errBlock.code : '';
  const errMsg = errBlock && typeof errBlock.message === 'string' ? errBlock.message : '';
  if (isKnownServerErrorCode(errCode)) {
    const out: PairCodeInputCommitResult = { ok: false, error: errCode };
    if (errMsg) out.detail = errMsg;
    return out;
  }
  return {
    ok: false,
    error: 'pair_code_input_server_unknown_error',
    detail: errMsg || `HTTP ${res.status}`,
  };
};

// ════════════════════════════════════════════════════════════════
// DOM host
// ════════════════════════════════════════════════════════════════

export interface PairCodeInputDeeplinkSeed {
  /** Pre-fill the Server URL field. P4 wires this from `?url=…`. */
  serverUrl?: string;
  /** Pre-fill the Pairing code field. P4 wires this from `?code=…`. */
  pairingCode?: string;
}

export interface PairCodeInputSuccess {
  /** Server URL the user typed (verbatim — the host's caller is
   *  responsible for normalizing if it persists). */
  serverUrl: string;
  /** Long-lived bearer returned by `/auth/pair`. */
  token: string;
  /** Durable server-issued client token id returned by `/auth/pair`. */
  token_id?: string;
  /** Optional passport projection returned by `/auth/pair`. */
  passport?: unknown;
  /** Optional server id (returned when the server was configured
   *  with one). */
  serverId?: string;
  /** The recovery key the user typed. Surfaced so the caller can
   *  seed a local sentinel for future re-pair flows; the host itself
   *  never persists it. */
  recoveryKey: string;
}

/** M5 S3.3 — what the `restore` collect-mode hands to `onRestoreSubmit`. The
 *  boot-layer orchestrator (`restore-onboarding.ts`) drives the rest. Mirrors
 *  `RestoreOnboardingInputs` field-for-field (kept structural rather than a
 *  shared import so the host stays free of an orchestrator dependency — the
 *  orchestrator already imports the pure submit from here). */
export interface PairCodeInputRestoreInputs {
  serverUrl: string;
  code: string;
  /** The archive's 24-word recovery key — used by the orchestrator for
   *  upload/validate/decrypt, NEVER sent to `/auth/pair`. */
  archiveKey: string;
  file: ArchiveUploadFile;
}

/** Which restore-mode field a bounce notice should focus on (re-)mount.
 *  `null` for a non-field error (e.g. the restore channel couldn't open).
 *  S3.4 maps the orchestrator's `RestoreOnboardingErrorStage` onto this. */
export type PairRestoreFocusField =
  | 'serverUrl'
  | 'pairingCode'
  | 'archiveKey'
  | 'file'
  | null;

export interface MountPairCodeInputHostOptions {
  /** Slot the form renders into. The webclient main typically passes
   *  `document.getElementById(SPLASH_ID)`. */
  splashElement?: HTMLElement;
  /** Document seam (tests). */
  document?: Document;
  /** Deeplink pre-fills. */
  seed?: PairCodeInputDeeplinkSeed;
  /** Optional instance id forwarded to `/auth/pair`. */
  instanceId?: string;
  /** Optional display name forwarded to `/auth/pair`. */
  displayName?: string;
  /** Test seam — overrides `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Invoked INSIDE the pair-finalize lock, after a successful
   *  `/auth/pair`. Production wires this to
   *  `finalizePairCodeSuccess` so the persistence runs while the lock
   *  is held; the wider post-pair lifecycle (dispose + bootstrap
   *  restart) belongs in `onAfterPair`. A throw from `onPaired`
   *  surfaces in the form's inline status (`Paired, but startup
   *  failed: …`) and PREVENTS `onAfterPair` from running. */
  onPaired: (result: PairCodeInputSuccess) => void | Promise<void>;
  /** Optional — invoked OUTSIDE the lock, only if `onPaired` resolved
   *  without throwing. Production puts UI teardown (form dispose,
   *  splash unmount) + recursive bootstrap restart here so the lock
   *  isn't held across the (potentially-long) post-pair bootstrap
   *  work. Codex 2026-05-28 trust-boundary fold P2 — narrows the
   *  lock to cover only preflight + submit + onPaired persistence
   *  (the "minimum critical section" Codex flagged in P1 — the
   *  earlier shape held the lock through `runBootstrapWithPairFallback`,
   *  which would leave queued tabs waiting on the full app bootstrap
   *  instead of letting them preflight against the now-populated
   *  webclient_token). */
  onAfterPair?: () => void | Promise<void>;
  /** Cross-tab single-flight lock provider — wraps preflight + submit
   *  + onPaired so the `/auth/pair` POST itself is serialised across
   *  tabs. Production wires `globalThis.navigator.locks`; tests
   *  inject a fake; pass `null` explicitly to opt out (e.g.
   *  environments without `navigator.locks` + a test that wants to
   *  assert un-locked behavior). Default: null — callers must opt in.
   *
   *  Lifted out of [[pair-code-success]] (Codex 2026-05-28 trust-
   *  boundary fold) — finalizePairCodeSuccess's own lock would only
   *  protect the post-/auth/pair persistence; the loser tab could
   *  still consume a one-shot pairing code or recovery-key first-pair
   *  sentinel before queueing on the lock. Holding the lock from
   *  before-submit through after-finalize closes that window. */
  lockProvider?: PairFinalizeLockProvider | null;
  /** Pre-flight check that runs INSIDE the lock, BEFORE
   *  `submitPairCodeInput` POSTs `/auth/pair`. Returns
   *  `{ alreadyPaired: true }` when the store already has a populated
   *  `webclient_token` — the host short-circuits with the
   *  `pair_code_input_already_paired` error. Production wires this to
   *  `await localStore.get('webclient_token') !== null`; tests inject
   *  a fake. Optional — when absent, the host skips the pre-flight
   *  + relies on `finalizePairCodeSuccess`'s entrance guard alone
   *  (which still protects the persistence, just not the network
   *  POST). */
  preflightCheck?: () => Promise<{ alreadyPaired: boolean }>;
  /** Test seam — overrides the BIP39 generator used by the "generate a
   *  new recovery key" mode. Production uses `@recued/crypto`'s
   *  `generateRecoveryKey`; tests inject a deterministic phrase so they
   *  can re-type it into the confirm grid. */
  generate?: () => string;
  /** M5 S3.3 — invoked INSTEAD of `onPaired`/`onAfterPair` when the user
   *  submits in `restore` mode. The host hands off the collected inputs and
   *  does NOT pair itself — the boot-layer orchestrator owns the multi-step
   *  restore. Absent ⇒ the restore tab is hidden (the host is pair-only). */
  onRestoreSubmit?: (inputs: PairCodeInputRestoreInputs) => void | Promise<void>;
  /** M5 S3.3 — the recovery-source mode the form opens in. Defaults to
   *  `enter`. S3.4 mounts a `collect` bounce directly in `restore` so the
   *  re-input lands on the right tab. */
  initialRecoveryMode?: PairRecoveryMode;
  /** M5 S3.3 — a restore-bounce notice to render on (re-)mount: the
   *  orchestrator's user-facing error copy + which field to focus. Only
   *  meaningful in `restore` mode. */
  restoreNotice?: { message: string; focus: PairRestoreFocusField };
  /** M5 S3.3 — pre-select a previously-picked archive on a `restore` bounce
   *  re-mount. A `<input type=file>` can't be programmatically pre-filled, so
   *  the boot layer retains the `File` across the bounce and re-seeds it here
   *  (shown as "selected", with a Change affordance) — a wrong-key retry then
   *  only re-enters the key, never re-picks the multi-GB file. */
  restoreSeedFile?: ArchiveUploadFile;
  /** M5 S3.4 — render the form as restore-ONLY: force `restore` mode + HIDE the
   *  enter/generate/restore mode toggle. Used for a bounce re-mount, where the
   *  user is mid-restore (already code-paired + an archive staged) — switching
   *  to a normal pair would be incoherent and would reach the boot layer's
   *  no-op restore `onPaired`. The only ways forward are fix-and-resubmit or
   *  reload. Only effective when `onRestoreSubmit` is wired (else ignored). */
  restoreOnly?: boolean;
}

export interface MountedPairCodeInputHost {
  /** Synchronous teardown — clears the form DOM + detaches listeners. */
  dispose(): void;
  /** Test affordance — drive the commit path without a click event. */
  submit(): Promise<void>;
  /** Test affordance — programmatic field write (mirrors a user
   *  keystroke / paste). For `recoveryKey` a whitespace-containing
   *  value triggers paste-style distribute across the 24 slots. */
  setFieldValue(
    field: 'serverUrl' | 'pairingCode' | 'recoveryKey',
    value: string,
  ): void;
}

/** `enter` = type an existing 24-word key (re-pair / added device —
 *  the unchanged default). `generate` = mint a fresh key for a
 *  first-run, un-enrolled server. `restore` (S3.3) = collect the inputs to
 *  restore a `.recued.archive` backup as this browser's first action. */
type PairRecoveryMode = 'enter' | 'generate' | 'restore';

/** Sub-stages of the `generate` mode. `start` = before minting (the
 *  "Generate" CTA); `writing` = the 24 words are shown read-only for
 *  the user to copy down; `challenging` = re-type-to-confirm grid. */
type PairGenerateStage = 'start' | 'writing' | 'challenging';

interface PairCodeInputState {
  serverUrl: string;
  pairingCode: string;
  /** In `enter` mode: the key being typed. In `generate`/`challenging`:
   *  the re-typed confirmation of the generated key. */
  recoveryWords: string[];
  submitting: boolean;
  error: { copy: string; code: PairCodeInputErrorCode } | null;
  recoveryMode: PairRecoveryMode;
  /** The freshly-minted phrase (generate mode only). Held in memory
   *  through writing + challenging; the user never sees it again once
   *  pairing commits. Null in enter mode / before minting. */
  generatedKey: string | null;
  generateStage: PairGenerateStage;
  /** S3.3 restore mode — the picked `.recued.archive` (or a seeded retained
   *  file on a bounce re-mount). Null until the user picks one. */
  restoreFile: ArchiveUploadFile | null;
  /** S3.3 restore mode — the picked file's display name (kept separate from
   *  `restoreFile` so a re-render can show "selected: …" without relying on
   *  the un-pre-fillable `<input type=file>` value). */
  restoreFileName: string;
  /** S3.3 restore mode — a bounce notice (the orchestrator's error copy)
   *  rendered in the status slot. Null on a fresh first entry. */
  restoreNotice: string | null;
  /** S3.3 — whether the restore tab is offered at all (the caller wired
   *  `onRestoreSubmit`). Pair-only hosts hide the tab. */
  restoreEnabled: boolean;
  /** S3.4 — restore-ONLY (a bounce re-mount): force restore mode + hide the
   *  mode toggle. Implies `restoreEnabled`. */
  restoreOnly: boolean;
}

/** Canonical comparison form — lowercase, single-spaced, trimmed. Lets
 *  a user who re-types "Abandon  Ability" still match the generated
 *  "abandon ability". Mirrors the @recued/crypto recovery normalize. */
const normalizeRecoveryKey = (s: string): string =>
  s.trim().replace(/\s+/g, ' ').toLowerCase();

interface DelegatedEventTarget {
  closest?(selector: string): HTMLElement | null;
}

// ════════════════════════════════════════════════════════════════
// Stylesheet (visual-UX review V1)
//
// The webclient pairing form is the user's FIRST screen, but its
// `.pair-code-input-*` classes were only ever styled in the bridge's
// static `popup.html` — never in the webclient — and the pre-route
// pairing path injects no `PRIMITIVE_STYLES`. So the first screen
// rendered as browser-default inputs + an unstyled 24-cell grid,
// centered in the boot splash. This self-scoped sheet (drawn from the
// shell's light/dark tokens in index.html) makes it a proper card.
// Injected on mount, idempotent, and a no-op in non-DOM test envs.
// ════════════════════════════════════════════════════════════════

const PAIR_CODE_INPUT_STYLES_MARKER = 'data-recued-pair-code-input-styles';

const PAIR_CODE_INPUT_STYLES = `
.pair-code-input-form {
  width: min(420px, calc(100vw - 32px));
  margin: 0 auto;
  text-align: left;
}
.pair-code-input-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 650;
  color: var(--fg);
}
.pair-code-input-help {
  margin: 0 0 16px;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.45;
}
.pair-code-input-help code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--surface-sunk);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}
.pair-code-input-form .form-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 14px;
}
.pair-code-input-form .form-row > label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.pair-code-input-optional {
  font-weight: 400;
  color: var(--fg-muted);
}
.pair-code-input-form input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}
.pair-code-input-form input:focus {
  outline: none;
  border-color: var(--accent);
}
.pair-code-input-form input:disabled { opacity: 0.6; }
.pair-code-input-recovery .field-hint {
  margin: 0 0 8px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.4;
}
.pair-code-input-form .rx-recovery-words {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px 5px;
}
.pair-code-input-form .rx-recovery-word {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.pair-code-input-form .rx-recovery-word label {
  font-size: 9px;
  color: var(--fg-muted);
  min-width: 14px;
  text-align: right;
}
.pair-code-input-form .rx-recovery-words input {
  text-align: center;
  padding: 5px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.pair-code-input-form .rx-recovery-word-count {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--fg-muted);
}
.pair-code-input-status {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--fg-muted);
  min-height: 1em;
}
.pair-code-input-requirement {
  margin: 0 0 8px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.35;
}
.pair-code-input-requirement:empty {
  display: none;
}
.pair-code-input-error {
  margin: 10px 0 0;
  padding: 8px 10px;
  background: var(--danger-weak);
  color: var(--danger);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.pair-code-input-actions {
  margin-top: 16px;
}
.pair-code-input-actions button {
  width: 100%;
  padding: 9px 12px;
  font: inherit;
  font-weight: 600;
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  cursor: pointer;
}
.pair-code-input-actions button:disabled {
  opacity: 0.55;
  cursor: default;
}
.pair-code-input-mode {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.pair-code-input-mode-btn {
  flex: 1;
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.pair-code-input-mode-btn.is-active {
  color: var(--fg);
  border-color: var(--accent);
  background: var(--surface-sunk);
}
.pair-code-input-mode-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.pair-code-input-generate-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
}
.pair-code-input-secondary-btn {
  padding: 8px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.pair-code-input-linkbtn {
  padding: 4px 0;
  font: inherit;
  font-size: 12px;
  color: var(--fg-muted);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: underline;
}
.pair-code-input-generate-warn {
  color: var(--fg);
}
.pair-code-input-restore-file {
  margin: 0 0 12px;
}
.pair-code-input-restore-file input[type='file'] {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 12px;
  color: var(--fg);
}
.pair-code-input-restore-file-name {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--fg-muted);
}
.pair-code-input-form .rx-recovery-words-readonly {
  margin-top: 4px;
}
.pair-code-input-form .rx-recovery-word-readonly span {
  flex: 1;
  min-width: 0;
  padding: 5px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-sunk);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

const ensurePairCodeInputStyles = (doc: Document): void => {
  try {
    const head = doc.head;
    if (!head || typeof doc.createElement !== 'function') return;
    if (head.querySelector?.(`style[${PAIR_CODE_INPUT_STYLES_MARKER}]`)) return;
    const style = doc.createElement('style');
    style.setAttribute(PAIR_CODE_INPUT_STYLES_MARKER, '');
    style.textContent = PAIR_CODE_INPUT_STYLES;
    head.appendChild(style);
  } catch {
    /* minimal/non-DOM fake-doc env (tests) — styling is non-essential to logic */
  }
};

export const mountPairCodeInputHost = (
  options: MountPairCodeInputHostOptions,
): MountedPairCodeInputHost => {
  const doc = options.document ?? globalThis.document;
  ensurePairCodeInputStyles(doc);
  const splashEl =
    options.splashElement ??
    (doc.getElementById(SPLASH_ID) as HTMLElement | null) ??
    null;
  if (!splashEl) {
    throw new Error(
      'pair-code-input-host: splash element not found; pass splashElement explicitly',
    );
  }

  const restoreEnabled = options.onRestoreSubmit !== undefined;
  // S3.4 — restore-ONLY is only meaningful when restore is wired.
  const restoreOnly = restoreEnabled && options.restoreOnly === true;
  // Codex S3.3 fold — `restoreEnabled` gates the tab AND the initial mode. A
  // caller that asks to open in `restore` without wiring `onRestoreSubmit`
  // would otherwise land on a fillable form whose submit silently no-ops (the
  // tab is hidden, but the body still renders). Coerce back to `enter` so the
  // form is never stuck in an un-submittable mode. restore-only forces restore.
  const initialMode: PairRecoveryMode = restoreOnly
    ? 'restore'
    : options.initialRecoveryMode === 'restore' && !restoreEnabled
      ? 'enter'
      : options.initialRecoveryMode ?? 'enter';

  let state: PairCodeInputState = {
    serverUrl: options.seed?.serverUrl ?? '',
    pairingCode: options.seed?.pairingCode ?? '',
    recoveryWords: toRecoveryWords(''),
    submitting: false,
    error: null,
    recoveryMode: initialMode,
    generatedKey: null,
    generateStage: 'start',
    restoreFile: options.restoreSeedFile ?? null,
    restoreFileName: options.restoreSeedFile?.name ?? '',
    restoreNotice: options.restoreNotice?.message ?? null,
    restoreEnabled,
    restoreOnly,
  };
  const generateImpl = options.generate ?? (() => generateRecoveryKey().mnemonic);
  let disposed = false;
  /** S3.3 — a one-shot field to focus after the first render (a restore
   *  bounce re-mount lands the cursor on the field the orchestrator flagged).
   *  Cleared once applied so later keystroke re-renders don't steal focus. */
  let pendingFocus: PairRestoreFocusField =
    initialMode === 'restore' ? options.restoreNotice?.focus ?? null : null;

  const applyPendingFocus = (): void => {
    if (pendingFocus === null) return;
    const focusId =
      pendingFocus === 'serverUrl'
        ? `#${PAIR_CODE_INPUT_SERVER_URL_ID}`
        : pendingFocus === 'pairingCode'
          ? `#${PAIR_CODE_INPUT_CODE_ID}`
          : pendingFocus === 'file'
            ? `#${PAIR_CODE_INPUT_RESTORE_FILE_ID}`
            : `#${PAIR_CODE_INPUT_RECOVERY_PREFIX}-0`; // 'archiveKey' → first slot
    pendingFocus = null;
    try {
      const el = splashEl.querySelector?.(focusId) as
        | { focus?: () => void }
        | null;
      el?.focus?.();
    } catch {
      /* best-effort — non-DOM fake env (tests) has no real focusable nodes */
    }
  };

  const render = (): void => {
    if (disposed) return;
    splashEl.innerHTML = renderForm(state);
    applyPendingFocus();
  };

  const setState = (patch: Partial<PairCodeInputState>): void => {
    state = { ...state, ...patch };
    render();
  };

  // ── Delegated `input` listener ───────────────────────────────
  //
  // Dispatch:
  //   data-{PAIR_CODE_INPUT_FIELD_NAME}="server-url"   → state.serverUrl
  //   data-{PAIR_CODE_INPUT_FIELD_NAME}="pairing-code" → state.pairingCode
  //   data-{PAIR_CODE_INPUT_RECOVERY_FIELD_NAME}="recovery-word"
  //                                                     → state.recoveryWords
  //
  // The recovery branch replicates the
  // `createRecoveryGridFieldHandler` paste-fan-out + per-slot
  // update logic inline. Per-slot single-character edits do NOT
  // re-render (preserves caret position); whitespace-containing
  // input (paste of all 24 words) triggers a full re-render so
  // every slot repaints with its fanned-out word.
  const onInput = (event: Event): void => {
    const target = event.target as (HTMLInputElement & DelegatedEventTarget) | null;
    if (!target) return;
    const fieldEl = target.closest?.(`[data-${PAIR_CODE_INPUT_FIELD_NAME}]`) as
      | (HTMLInputElement & { dataset?: DOMStringMap })
      | null;
    const recoveryEl = target.closest?.(`[data-${PAIR_CODE_INPUT_RECOVERY_FIELD_NAME}]`) as
      | (HTMLInputElement & { dataset?: DOMStringMap })
      | null;

    if (fieldEl) {
      const kind = fieldEl.getAttribute(`data-${PAIR_CODE_INPUT_FIELD_NAME}`);
      const value = fieldEl.value ?? '';
      if (kind === 'server-url') {
        state = { ...state, serverUrl: value, error: null, restoreNotice: null };
        clearStatusInPlace();
        syncSubmitDisabled();
        return;
      }
      if (kind === 'pairing-code') {
        state = { ...state, pairingCode: value, error: null, restoreNotice: null };
        clearStatusInPlace();
        // Generate mode gates submit on the pairing code (first-pair
        // always needs one), so re-sync the disabled state — otherwise
        // typing the code last leaves the button stuck disabled. A no-op
        // for enter mode, where the code doesn't affect the gate.
        syncSubmitDisabled();
        return;
      }
    }
    if (recoveryEl) {
      const raw = recoveryEl.value ?? '';
      const idx = parseInt(recoveryEl.dataset?.index ?? '-1', 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= 24) return;
      if (/\s/.test(raw)) {
        const tokens = raw.split(/\s+/).filter((w) => w.length > 0);
        const current = state.recoveryWords;
        const next = distributeTokens(current, tokens, idx);
        setState({ recoveryWords: next, error: null, restoreNotice: null });
        return;
      }
      const words = [...state.recoveryWords];
      words[idx] = raw.trim().toLowerCase();
      state = {
        ...state,
        recoveryWords: words,
        error: null,
        restoreNotice: null,
      };
      clearStatusInPlace();
      syncSubmitDisabled();
      syncRecoveryCounter();
    }
  };

  // ── Generate-mode transitions ────────────────────────────────
  //
  // Switching modes / (re)starting generation always wipes
  // `recoveryWords` so a half-typed entry never leaks across the
  // toggle, and wipes `generatedKey` so a stale phrase can't be
  // submitted. A full re-render repaints the recovery section.
  const switchRecoveryMode = (mode: PairRecoveryMode): void => {
    if (state.submitting || state.recoveryMode === mode) return;
    // S3.4 — a restore-only form (a bounce re-mount) has no mode toggle; refuse
    // any stray switch so it stays pinned to restore.
    if (state.restoreOnly) return;
    // Restore mode is only reachable when the caller wired `onRestoreSubmit`
    // (its tab is otherwise hidden) — refuse a stray switch into it so the form
    // can't enter an un-submittable mode.
    if (mode === 'restore' && !state.restoreEnabled) return;
    // A user-driven toggle starts fresh — wipe every recovery-source field so
    // a half-typed key / generated phrase / picked file never leaks across the
    // switch. (The seeded `restoreSeedFile` is for a bounce re-mount, NOT a
    // toggle, so dropping it here is correct.)
    setState({
      recoveryMode: mode,
      recoveryWords: toRecoveryWords(''),
      generatedKey: null,
      generateStage: 'start',
      restoreFile: null,
      restoreFileName: '',
      restoreNotice: null,
      error: null,
    });
  };

  // ── Delegated `change` listener — the `<input type=file>` picker ──
  //
  // File inputs fire `change` on selection (not the `input` the text fields
  // use), so the restore-mode picker gets its own delegated handler. Re-render
  // on pick so the "selected: …" line + submit gate update; the input itself
  // resets to empty (browsers forbid pre-filling it) but `restoreFile` retains
  // the picked `File` for the handoff.
  const onChange = (event: Event): void => {
    const target = event.target as (HTMLInputElement & DelegatedEventTarget) | null;
    if (!target) return;
    const fileEl = target.closest?.(`[data-${PAIR_CODE_INPUT_RESTORE_FILE_NAME}]`) as
      | (HTMLInputElement & { files?: { length: number; [i: number]: File } | null })
      | null;
    if (!fileEl) return;
    const picked =
      fileEl.files && fileEl.files.length > 0 ? fileEl.files[0] : null;
    if (picked) {
      setState({
        restoreFile: picked as unknown as ArchiveUploadFile,
        restoreFileName: picked.name,
        restoreNotice: null,
        error: null,
      });
    } else {
      // Codex S3.3 fold — a `change` carrying an EMPTY FileList is an honest
      // "no file selected" signal (a native picker CANCEL fires no change at
      // all, so this never clobbers a kept selection). Clear so the displayed
      // "Selected: …" line + the submit gate stay truthful. No-op when already
      // empty.
      if (state.restoreFile !== null) {
        setState({ restoreFile: null, restoreFileName: '' });
      }
    }
  };

  const startGenerate = (): void => {
    if (state.submitting || state.recoveryMode !== 'generate') return;
    setState({
      generatedKey: generateImpl(),
      generateStage: 'writing',
      recoveryWords: toRecoveryWords(''),
      error: null,
    });
  };

  const ackGenerateWritten = (): void => {
    if (state.submitting || state.generateStage !== 'writing') return;
    setState({
      generateStage: 'challenging',
      recoveryWords: toRecoveryWords(''),
      error: null,
    });
  };

  const restartGenerate = (): void => {
    if (state.submitting) return;
    setState({
      generatedKey: null,
      generateStage: 'start',
      recoveryWords: toRecoveryWords(''),
      error: null,
    });
  };

  // ── Delegated `click` listener ───────────────────────────────
  //
  // Submit keeps its own exact-selector `closest` (the existing test
  // fakes a target that only answers that selector); the generate-mode
  // actions are checked after, each with their own selector.
  const onClick = (event: Event): void => {
    const target = event.target as DelegatedEventTarget | null;
    if (!target) return;
    const submitBtn = target.closest?.(
      `[data-action="${PAIR_CODE_INPUT_SUBMIT_ACTION}"]`,
    ) as HTMLButtonElement | null;
    if (submitBtn) {
      if (submitBtn.disabled) return;
      void doSubmit();
      return;
    }
    if (target.closest?.(`[data-action="${PAIR_CODE_INPUT_MODE_ENTER_ACTION}"]`)) {
      switchRecoveryMode('enter');
      return;
    }
    if (target.closest?.(`[data-action="${PAIR_CODE_INPUT_MODE_GENERATE_ACTION}"]`)) {
      switchRecoveryMode('generate');
      return;
    }
    if (target.closest?.(`[data-action="${PAIR_CODE_INPUT_MODE_RESTORE_ACTION}"]`)) {
      switchRecoveryMode('restore');
      return;
    }
    if (target.closest?.(`[data-action="${PAIR_CODE_INPUT_GENERATE_ACTION}"]`)) {
      startGenerate();
      return;
    }
    if (target.closest?.(`[data-action="${PAIR_CODE_INPUT_GENERATE_ACK_ACTION}"]`)) {
      ackGenerateWritten();
      return;
    }
    if (target.closest?.(`[data-action="${PAIR_CODE_INPUT_GENERATE_RESTART_ACTION}"]`)) {
      restartGenerate();
      return;
    }
  };

  // ── `submit` listener — covers Enter-press inside the form ───
  // (Codex 2026-05-18 P3 Minor fold #1.) The form's submit button
  // is `type="button"` so a stray Enter never reloads the page; this
  // listener catches the natural form-submit signal and routes it
  // through the same disabled-aware `doSubmit` path the click
  // listener uses.
  const onSubmit = (event: Event): void => {
    event.preventDefault?.();
    if (isSubmitBlocked(state)) return;
    void doSubmit();
  };

  splashEl.addEventListener('input', onInput);
  splashEl.addEventListener('change', onChange);
  splashEl.addEventListener('click', onClick);
  splashEl.addEventListener('submit', onSubmit);

  const syncSubmitDisabled = (): void => {
    const btn = splashEl.querySelector?.(
      `#${PAIR_CODE_INPUT_SUBMIT_ID}`,
    ) as HTMLButtonElement | null;
    const reason = submitBlockedReason(state);
    if (btn) {
      btn.disabled = reason !== null;
      if (reason) btn.setAttribute?.('title', reason);
      else btn.removeAttribute?.('title');
    }
    syncSubmitRequirement(reason);
  };

  const syncRecoveryCounter = (): void => {
    const filled = state.recoveryWords.filter((w) => w.length > 0).length;
    const counter = splashEl.querySelector?.('.rx-recovery-word-count') as
      | HTMLElement
      | null;
    if (counter) counter.textContent = `${filled} of 24 words entered.`;
  };

  const syncSubmitRequirement = (reason = submitBlockedReason(state)): void => {
    const requirement = splashEl.querySelector?.(
      `#${PAIR_CODE_INPUT_REQUIREMENT_ID}`,
    ) as HTMLElement | null;
    if (requirement) requirement.textContent = reason ?? '';
  };

  // (Codex 2026-05-18 P3 Minor fold #2.) Per-slot keystroke handlers
  // mutate `state.error` to null without invoking `render()` (so the
  // caret doesn't jump on every keystroke). Without an in-place
  // clear, a stale "recovery_key_invalid" copy stays visible after
  // the user starts correcting. Clear the status element directly.
  const clearStatusInPlace = (): void => {
    const status = splashEl.querySelector?.(
      `#${PAIR_CODE_INPUT_STATUS_ID}`,
    ) as HTMLElement | null;
    if (!status) return;
    if (status.textContent !== '') status.textContent = '';
    if ((status as { className?: string }).className !== 'pair-code-input-status') {
      (status as { className?: string }).className = 'pair-code-input-status';
    }
    status.removeAttribute?.('data-error');
  };

  const doSubmit = async (): Promise<void> => {
    if (disposed) return;
    if (isSubmitBlocked(state)) return;

    // S3.3 restore mode — DON'T pair here. Hand the collected inputs to the
    // boot-layer orchestrator, which owns the multi-step restore (pair-only,
    // upload, validate, preview, commit). The submit gate guarantees the
    // file + 24-word archive key + code + URL are all present, but coalesce
    // defensively. After the handoff the boot layer disposes this host and
    // mounts the splash progress surface, so the `submitting` flag here just
    // blocks a double-fire in the (sync) window before that teardown.
    if (state.recoveryMode === 'restore') {
      if (!options.onRestoreSubmit || state.restoreFile === null) return;
      const file = state.restoreFile;
      setState({ submitting: true, error: null, restoreNotice: null });
      try {
        await options.onRestoreSubmit({
          serverUrl: state.serverUrl,
          code: state.pairingCode.trim(),
          archiveKey: fromRecoveryWords(state.recoveryWords),
          file,
        });
      } catch (err) {
        if (disposed) return;
        setState({
          submitting: false,
          restoreNotice: `Could not start the restore: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    setState({ submitting: true, error: null });

    // Codex 2026-05-28 trust-boundary fold (P2-narrowed) — the lock
    // wraps only preflight + submit + onPaired (the persistence-critical
    // section). `onAfterPair` runs OUTSIDE the lock so the queued
    // tabs can preflight against the freshly-written webclient_token
    // without waiting on the post-pair bootstrap restart. The loser
    // tab queues on `recued.webclient.pair-finalize`; finalize callers
    // downstream of `options.onPaired` MUST pass `lockProvider: null`
    // to avoid re-entrant deadlock (Web Locks queue same-name same-
    // mode requests, so a second acquire from inside the held lock
    // never resolves).
    let pairSucceeded = false;
    await withPairFinalizeLock(options.lockProvider ?? null, async () => {
      if (disposed) return;
      // Pre-flight inside the lock so a winning tab's persistence is
      // visible to the loser's pre-flight read. Skipping when the
      // caller didn't wire one — the inner finalizePairCodeSuccess
      // still guards against the post-/auth/pair race; this only
      // protects the pre-/auth/pair window.
      if (options.preflightCheck) {
        let preflight: { alreadyPaired: boolean };
        try {
          preflight = await options.preflightCheck();
        } catch (err) {
          if (disposed) return;
          setState({
            submitting: false,
            error: {
              copy: `Pre-pair check failed: ${err instanceof Error ? err.message : String(err)}`,
              code: 'pair_code_input_server_unknown_error',
            },
          });
          return;
        }
        if (disposed) return;
        if (preflight.alreadyPaired) {
          setState({
            submitting: false,
            error: {
              copy: PAIR_CODE_INPUT_ERROR_COPY.pair_code_input_already_paired,
              code: 'pair_code_input_already_paired',
            },
          });
          return;
        }
      }

      // In generate mode the key to enroll is the freshly-minted
      // phrase (the gate guarantees the re-typed words match it); in
      // enter mode it's the typed words. `generatedKey` is non-null at
      // this point in generate mode (submit is gated on `challenging` +
      // a non-null match), but coalesce defensively.
      const recoveryKeyToSubmit =
        state.recoveryMode === 'generate'
          ? state.generatedKey ?? ''
          : fromRecoveryWords(state.recoveryWords);

      const result = await submitPairCodeInput({
        serverUrl: state.serverUrl,
        ...(state.pairingCode.trim().length > 0
          ? { code: state.pairingCode.trim() }
          : {}),
        recoveryKey: recoveryKeyToSubmit,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (disposed) return;
      if (!result.ok) {
        // A generated key the server rejects as a mismatch = the realm
        // is already enrolled. Drop the now-useless generated phrase and
        // flip to the enter path so the user can type their existing key
        // — leaving the obsolete phrase in the challenge grid would be
        // both confusing and pointlessly resubmittable.
        const alreadyEnrolled =
          result.error === 'recovery_key_invalid' &&
          state.recoveryMode === 'generate';
        setState({
          submitting: false,
          error: {
            copy: alreadyEnrolled
              ? PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY
              : PAIR_CODE_INPUT_ERROR_COPY[result.error],
            code: result.error,
          },
          ...(alreadyEnrolled
            ? {
                recoveryMode: 'enter' as const,
                generatedKey: null,
                generateStage: 'start' as const,
                recoveryWords: toRecoveryWords(''),
              }
            : {}),
        });
        return;
      }
      try {
        await options.onPaired({
          serverUrl: state.serverUrl,
          token: result.token,
          ...(result.token_id !== undefined ? { token_id: result.token_id } : {}),
          ...(result.passport !== undefined ? { passport: result.passport } : {}),
          ...(result.serverId !== undefined ? { serverId: result.serverId } : {}),
          recoveryKey: recoveryKeyToSubmit,
        });
        pairSucceeded = true;
      } catch (err) {
        if (disposed) return;
        setState({
          submitting: false,
          error: {
            copy: `Paired, but startup failed: ${err instanceof Error ? err.message : String(err)}`,
            code: 'pair_code_input_server_unknown_error',
          },
        });
      }
    });

    // Outside the lock — queued tabs can now preflight against the
    // freshly-written webclient_token. The post-pair UI teardown +
    // recursive bootstrap restart belong here. Skipped on pair failure
    // (onPaired threw inside the lock, error rendered above).
    if (pairSucceeded && options.onAfterPair && !disposed) {
      try {
        await options.onAfterPair();
      } catch (err) {
        if (disposed) return;
        setState({
          submitting: false,
          error: {
            copy: `Paired, but post-pair startup failed: ${err instanceof Error ? err.message : String(err)}`,
            code: 'pair_code_input_server_unknown_error',
          },
        });
      }
    }
  };

  render();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      splashEl.removeEventListener('input', onInput);
      splashEl.removeEventListener('change', onChange);
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
      else state = { ...state, recoveryWords: toRecoveryWords(value), error: null };
      render();
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════

const isSubmitBlocked = (s: PairCodeInputState): boolean => {
  return submitBlockedReason(s) !== null;
};

const submitBlockedReason = (s: PairCodeInputState): string | null => {
  if (s.submitting) return 'Pairing is in progress.';
  const filled = s.recoveryWords.filter((w) => w.length > 0).length;

  if (s.recoveryMode === 'restore') {
    if (s.serverUrl.trim().length === 0) {
      return 'Enter the server URL to continue.';
    }
    // A fresh server is restored into via code-only pairing, which always
    // needs the console pairing code.
    if (s.pairingCode.trim().length === 0) {
      return 'Enter the pairing code from your server console to continue.';
    }
    if (s.restoreFile === null) {
      return 'Choose the backup file to restore.';
    }
    if (filled < 24) {
      return `Enter the backup's 24-word recovery key to continue (${filled}/24 words).`;
    }
    // BIP39-check before the (potentially multi-GB) upload: the orchestrator
    // uploads BEFORE it validates the key, so catching an obvious typo here
    // saves a wasted round-trip. A valid-but-wrong key still bounces at the
    // server-side dry-run.
    if (!isValidRecoveryKey(fromRecoveryWords(s.recoveryWords))) {
      return "That doesn't look like a valid 24-word recovery key — check for typos or missing words.";
    }
    return null;
  }

  if (s.recoveryMode === 'generate') {
    if (s.serverUrl.trim().length === 0) {
      return 'Enter the server URL to continue.';
    }
    if (s.generateStage !== 'challenging' || !s.generatedKey) {
      return 'Generate your recovery key and confirm it to continue.';
    }
    // First-pair enrollment always needs the console pairing code.
    if (s.pairingCode.trim().length === 0) {
      return 'Enter the pairing code from your server console to continue.';
    }
    if (filled < 24) {
      return `Re-enter your written recovery key to confirm (${filled}/24 words).`;
    }
    if (normalizeRecoveryKey(fromRecoveryWords(s.recoveryWords)) !==
        normalizeRecoveryKey(s.generatedKey)) {
      return "The re-typed words don't match — check your written copy.";
    }
    return null;
  }

  // enter mode (unchanged)
  if (s.serverUrl.trim().length === 0) {
    return 'Enter the server URL and paste the 24-word recovery key to continue.';
  }
  if (filled < 24) {
    return `Paste the 24-word recovery key to continue (${filled}/24 words).`;
  }
  return null;
};

// ════════════════════════════════════════════════════════════════
// HTML template
// ════════════════════════════════════════════════════════════════

const renderForm = (state: PairCodeInputState): string => {
  const disabledReason = submitBlockedReason(state);
  const disabled = disabledReason !== null;
  const isRestore = state.recoveryMode === 'restore';
  const submitLabel = isRestore
    ? state.submitting
      ? 'Starting restore…'
      : 'Restore this backup'
    : state.submitting
      ? 'Pairing…'
      : 'Pair this device';
  // The status slot keeps a stable id across modes so the focus/sync helpers
  // (and tests) find it. A restore bounce surfaces the orchestrator's copy via
  // `restoreNotice` (styled like an error, but carrying no `data-error` code —
  // it isn't one of the pure-submit error codes).
  const statusBlock = state.error
    ? `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-error" data-error="${e(state.error.code)}">${e(state.error.copy)}</p>`
    : isRestore && state.restoreNotice
      ? `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-error" data-restore-notice>${e(state.restoreNotice)}</p>`
      : `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-status"></p>`;

  const recoveryBody =
    state.recoveryMode === 'generate'
      ? renderGenerateBody(state)
      : isRestore
        ? renderRestoreBody(state)
        : renderEnterBody(state);

  return `
    <form id="${e(PAIR_CODE_INPUT_FORM_ID)}" class="pair-code-input-form" novalidate>
      <h2 class="pair-code-input-title">${isRestore ? 'Restore a backup' : 'Pair this browser'}</h2>
      <p class="pair-code-input-help">
        ${isRestore
          ? "Restore a Recued backup onto a fresh server. Enter the server's URL and pairing code, choose your backup file, then enter the backup's 24-word recovery key."
          : "Connect this browser to your recued-server. Enter its URL, then enter your existing recovery key — or generate a new one if you're setting the server up for the first time."}
      </p>

      <div class="form-row">
        <label for="${e(PAIR_CODE_INPUT_SERVER_URL_ID)}">Server URL</label>
        <input id="${e(PAIR_CODE_INPUT_SERVER_URL_ID)}"
          type="url"
          data-${e(PAIR_CODE_INPUT_FIELD_NAME)}="server-url"
          value="${e(state.serverUrl)}"
          placeholder="https://your-server.recued.cloud"
          autocomplete="off"
          ${state.submitting ? 'disabled' : ''} />
      </div>

      <div class="form-row">
        <label for="${e(PAIR_CODE_INPUT_CODE_ID)}">
          Pairing code ${isRestore
            ? '<span class="pair-code-input-optional">(from server terminal)</span>'
            : '<span class="pair-code-input-optional">(optional — first pair only)</span>'}
        </label>
        <input id="${e(PAIR_CODE_INPUT_CODE_ID)}"
          type="text"
          data-${e(PAIR_CODE_INPUT_FIELD_NAME)}="pairing-code"
          value="${e(state.pairingCode)}"
          placeholder="From server terminal"
          autocomplete="off"
          style="text-transform:uppercase; letter-spacing:0.15em; font-family:monospace"
          ${state.submitting ? 'disabled' : ''} />
      </div>

      <div class="form-row form-row-recovery">
        <label>${isRestore ? "Backup's recovery key" : 'Recovery key'}</label>
        ${state.restoreOnly ? '' : renderRecoveryModeToggle(state)}
        <div class="pair-code-input-recovery">
          ${recoveryBody}
        </div>
      </div>

      ${statusBlock}

      <div class="pair-code-input-actions">
        <p id="${e(PAIR_CODE_INPUT_REQUIREMENT_ID)}" class="pair-code-input-requirement">${e(disabledReason ?? '')}</p>
        <button id="${e(PAIR_CODE_INPUT_SUBMIT_ID)}"
          type="button"
          data-action="${e(PAIR_CODE_INPUT_SUBMIT_ACTION)}"
          ${disabledReason ? `title="${e(disabledReason)}"` : ''}
          ${disabled ? 'disabled' : ''}>${e(submitLabel)}</button>
      </div>
    </form>
  `;
};

// ── Recovery-key source toggle + per-mode bodies ─────────────────

const MODE_TOGGLE_ACTION: Record<PairRecoveryMode, string> = {
  enter: PAIR_CODE_INPUT_MODE_ENTER_ACTION,
  generate: PAIR_CODE_INPUT_MODE_GENERATE_ACTION,
  restore: PAIR_CODE_INPUT_MODE_RESTORE_ACTION,
};

const renderRecoveryModeToggle = (state: PairCodeInputState): string => {
  const dis = state.submitting ? 'disabled' : '';
  const tab = (mode: PairRecoveryMode, label: string): string => {
    const active = state.recoveryMode === mode;
    return `<button type="button"
      class="pair-code-input-mode-btn${active ? ' is-active' : ''}"
      data-action="${e(MODE_TOGGLE_ACTION[mode])}"
      aria-pressed="${active ? 'true' : 'false'}"
      ${dis}>${e(label)}</button>`;
  };
  return `
    <div class="pair-code-input-mode" role="group" aria-label="Recovery key source">
      ${tab('enter', 'I have a recovery key')}
      ${tab('generate', 'Generate a new one')}
      ${state.restoreEnabled ? tab('restore', 'Restore a backup') : ''}
    </div>
  `;
};

const renderRestoreBody = (state: PairCodeInputState): string => `
  <p class="field-hint">
    Restore a <code>.recued.archive</code> backup onto this fresh server. Choose
    the file, then enter the 24-word recovery key the backup was sealed with — it
    decrypts the archive and is never sent to the server's pairing endpoint.
  </p>
  <div class="pair-code-input-restore-file">
    <input id="${e(PAIR_CODE_INPUT_RESTORE_FILE_ID)}"
      type="file"
      data-${e(PAIR_CODE_INPUT_RESTORE_FILE_NAME)}
      accept=".archive,application/octet-stream"
      ${state.submitting ? 'disabled' : ''} />
    ${state.restoreFileName
      ? `<p class="pair-code-input-restore-file-name" data-restore-file-name>Selected: ${e(state.restoreFileName)}</p>`
      : ''}
  </div>
  ${recoveryGrid({
    words: state.recoveryWords,
    fieldName: PAIR_CODE_INPUT_RECOVERY_FIELD_NAME,
    fieldValue: PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE,
    idPrefix: PAIR_CODE_INPUT_RECOVERY_PREFIX,
    disabled: state.submitting,
  })}
`;

const renderEnterBody = (state: PairCodeInputState): string => `
  <p class="field-hint">
    Enter the 24-word recovery key. Every pair confirms this key against your
    server's sealed verifier — never the key itself.
  </p>
  ${recoveryGrid({
    words: state.recoveryWords,
    fieldName: PAIR_CODE_INPUT_RECOVERY_FIELD_NAME,
    fieldValue: PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE,
    idPrefix: PAIR_CODE_INPUT_RECOVERY_PREFIX,
    disabled: state.submitting,
  })}
`;

const renderGenerateBody = (state: PairCodeInputState): string => {
  switch (state.generateStage) {
    case 'start':
      return renderGenerateStart();
    case 'writing':
      return renderGenerateWriting(state);
    case 'challenging':
      return renderGenerateChallenge(state);
  }
};

const renderGenerateStart = (): string => `
  <p class="field-hint">
    First time setting up this server? Generate a 24-word recovery key. It's the
    only way to recover your encrypted data if you lose this device — nobody,
    including Recued, can recover it for you.
  </p>
  <div class="pair-code-input-generate-actions">
    <button type="button"
      class="pair-code-input-secondary-btn"
      data-action="${e(PAIR_CODE_INPUT_GENERATE_ACTION)}">Generate a new recovery key</button>
  </div>
`;

const renderGenerateWriting = (state: PairCodeInputState): string => {
  const key = state.generatedKey;
  if (!key) {
    return `
      <p class="field-hint">
        No key generated yet.
        <button type="button" class="pair-code-input-linkbtn"
          data-action="${e(PAIR_CODE_INPUT_GENERATE_ACTION)}">Generate one</button>.
      </p>
    `;
  }
  const cells = key.split(/\s+/).map((w, i) => `
    <div class="rx-recovery-word rx-recovery-word-readonly">
      <label>${i + 1}</label>
      <span>${e(w)}</span>
    </div>
  `).join('');
  return `
    <p class="field-hint pair-code-input-generate-warn">
      Write these 24 words on paper and store them somewhere safe. This is the
      only time they're shown — do not share them. We'll ask you to re-type them
      next to confirm.
    </p>
    <div class="rx-recovery-words rx-recovery-words-readonly">
      ${cells}
    </div>
    <div class="pair-code-input-generate-actions">
      <button type="button"
        class="pair-code-input-linkbtn"
        data-action="${e(PAIR_CODE_INPUT_GENERATE_RESTART_ACTION)}">Start over</button>
      <button type="button"
        class="pair-code-input-secondary-btn"
        data-action="${e(PAIR_CODE_INPUT_GENERATE_ACK_ACTION)}">I've written it down — continue</button>
    </div>
  `;
};

const renderGenerateChallenge = (state: PairCodeInputState): string => `
  <p class="field-hint">
    Type the 24 words from your paper copy to confirm you saved them correctly.
    Paste into any box to fan the phrase out across the rest.
  </p>
  ${recoveryGrid({
    words: state.recoveryWords,
    fieldName: PAIR_CODE_INPUT_RECOVERY_FIELD_NAME,
    fieldValue: PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE,
    idPrefix: PAIR_CODE_INPUT_RECOVERY_PREFIX,
    disabled: state.submitting,
  })}
  <div class="pair-code-input-generate-actions">
    <button type="button"
      class="pair-code-input-linkbtn"
      data-action="${e(PAIR_CODE_INPUT_GENERATE_RESTART_ACTION)}">Start over</button>
  </div>
`;
