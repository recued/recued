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
import {
  PAIR_SERVER_ERROR_COPY,
  PAIR_SERVER_REFUSED_COPY,
  PAIR_SERVER_SAID_LABEL,
  describePairServerError,
  type PairServerErrorCode,
} from '@recued/ui-shared/pairing';
import { e } from '@recued/ui-shared/template';

import {
  type PairFinalizeLockProvider,
  withPairFinalizeLock,
} from './pair-code-success.js';
import type { ArchiveUploadFile } from '../settings/archive-backup-panel.js';
import {
  isCertainlyBlockedServerAddress,
  readPageProtocol,
} from '../net/insecure-origin.js';

// ════════════════════════════════════════════════════════════════
// Stable DOM ids — tests + Settings → Privacy inspector read these.
// ════════════════════════════════════════════════════════════════

const SPLASH_ID = 'webclient-boot-splash-message';
const BOOT_PENDING_SELECTOR = '[data-recued-boot-pending]';
export const PAIR_CODE_INPUT_FORM_ID = 'webclient-pair-code-input-form';
export const PAIR_CODE_INPUT_SERVER_URL_ID = 'webclient-pair-code-input-server-url';
/** Live warning under the Server URL field for an address this browser will
 *  certainly refuse. Toggled in place by `syncInsecureAddressHint` — typing in
 *  that field does NOT re-render (caret preservation), so a template-only hint
 *  would show the previous keystroke's verdict. */
export const PAIR_CODE_INPUT_INSECURE_ADDRESS_ID = 'pair-code-input-insecure-address';
export const PAIR_CODE_INPUT_CODE_ID = 'webclient-pair-code-input-code';
export const PAIR_CODE_INPUT_SUBMIT_ID = 'webclient-pair-code-input-submit';
export const PAIR_CODE_INPUT_STATUS_ID = 'webclient-pair-code-input-status';
const PAIR_CODE_INPUT_TITLE_ID = 'webclient-pair-code-input-title';
const PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ID =
  'webclient-pair-code-input-secure-resume-notice';
const PAIR_CODE_INPUT_CHANGE_SERVER_NOTE_ID =
  'webclient-pair-code-input-change-server-note';
export const PAIR_CODE_INPUT_REAUTH_NOTICE_ATTR =
  'data-recued-pair-code-input-reauth-notice';
export const PAIR_CODE_INPUT_RECOVERY_HELP_ATTR =
  'data-recued-pair-code-input-recovery-help';
export const PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR =
  'data-recued-pair-code-input-recovery-correction';
export const PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR =
  'data-recued-pair-code-input-recovery-triage';
export const PAIR_CODE_INPUT_RECOVERY_STOP_ATTR =
  'data-recued-pair-code-input-recovery-stop';
export const PAIR_CODE_INPUT_RECOVERY_STOP_REENTRY_ATTR =
  'data-recued-pair-code-input-recovery-stop-reentry';
export const PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR =
  'data-recued-pair-code-input-recovery-resume-notice';
export const PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ATTR =
  'data-recued-pair-code-input-replacement-review';
export const PAIR_CODE_INPUT_REPLACEMENT_CONFIRMED_ATTR =
  'data-recued-pair-code-input-replacement-confirmed';
export const PAIR_CODE_INPUT_REPLACEMENT_NOT_FRESH_ATTR =
  'data-recued-pair-code-input-replacement-not-fresh';
export const PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_ATTR =
  'data-recued-pair-code-input-recovery-diagnostic';
export const PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_SUMMARY_ATTR =
  'data-recued-pair-code-input-recovery-diagnostic-summary';
export const PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_STATUS_ATTR =
  'data-recued-pair-code-input-recovery-diagnostic-status';
export const PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ATTR =
  'data-recued-pair-code-input-secure-resume-notice';
/** D-212 — the RAW code the server sent, when it is not one Recued maps.
 *  Carried for support ("what did your server actually say?"); the copy the
 *  user reads never contains it. */
export const PAIR_CODE_INPUT_SERVER_CODE_ATTR =
  'data-recued-pair-code-input-server-code';
const PAIR_CODE_INPUT_REQUIREMENT_ID = 'webclient-pair-code-input-requirement';
const PAIR_CODE_INPUT_RESTART_NOTE_ID =
  'webclient-pair-code-input-restart-note';
const PAIR_CODE_INPUT_RECOVERY_CORRECTION_ID =
  'webclient-pair-code-input-recovery-correction';
const PAIR_CODE_INPUT_RECOVERY_CORRECTION_TITLE_ID =
  'webclient-pair-code-input-recovery-correction-title';
const PAIR_CODE_INPUT_RECOVERY_CORRECTION_CONTEXT_ID =
  'webclient-pair-code-input-recovery-correction-context';
const PAIR_CODE_INPUT_RECOVERY_TRIAGE_IDENTITY_ID =
  'webclient-pair-code-input-recovery-triage-identity';
const PAIR_CODE_INPUT_RECOVERY_TRIAGE_SERVER_TITLE_ID =
  'webclient-pair-code-input-recovery-triage-server-title';
const PAIR_CODE_INPUT_RECOVERY_TRIAGE_KEY_TITLE_ID =
  'webclient-pair-code-input-recovery-triage-key-title';
const PAIR_CODE_INPUT_RECOVERY_STOP_ID =
  'webclient-pair-code-input-recovery-stop';
const PAIR_CODE_INPUT_RECOVERY_STOP_TITLE_ID =
  'webclient-pair-code-input-recovery-stop-title';
const PAIR_CODE_INPUT_RECOVERY_STOP_CONTEXT_ID =
  'webclient-pair-code-input-recovery-stop-context';
const PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ID =
  'webclient-pair-code-input-replacement-review';
const PAIR_CODE_INPUT_REPLACEMENT_REVIEW_TITLE_ID =
  'webclient-pair-code-input-replacement-review-title';
const PAIR_CODE_INPUT_REPLACEMENT_REVIEW_CONTEXT_ID =
  'webclient-pair-code-input-replacement-review-context';
const PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_PRIVACY_ID =
  'webclient-pair-code-input-recovery-diagnostic-privacy';
export const PAIR_CODE_INPUT_RECOVERY_PREFIX = 'webclient-pair-code-input-recovery';

const PAIR_CODE_INPUT_FIELD_NAME = 'pair-code-input-field';
const PAIR_CODE_INPUT_RECOVERY_FIELD_NAME = 'pair-code-input-recovery-field';
const PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE = 'recovery-word';
const PAIR_CODE_INPUT_SUBMIT_ACTION = 'pair-code-input-submit';
export const PAIR_CODE_INPUT_CHANGE_SERVER_ACTION =
  'pair-code-input-change-server';
export const PAIR_CODE_INPUT_RESTART_AFTER_INTERRUPTION_ACTION =
  'pair-code-input-restart-after-interruption';
export const PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION =
  'pair-code-input-review-rejected-server';
export const PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION =
  'pair-code-input-reenter-rejected-key';
export const PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION =
  'pair-code-input-find-rejected-key';
export const PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION =
  'pair-code-input-use-saved-server';
export const PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION =
  'pair-code-input-copy-recovery-diagnostic';
export const PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION =
  'pair-code-input-resume-recovery-key';
export const PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION =
  'pair-code-input-resume-server-review';
export const PAIR_CODE_INPUT_CONFIRM_REPLACEMENT_SERVER_ACTION =
  'pair-code-input-confirm-replacement-server';
export const PAIR_CODE_INPUT_EDIT_REPLACEMENT_SERVER_ACTION =
  'pair-code-input-edit-replacement-server';
export const PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION =
  'pair-code-input-use-replacement-existing-key';
export const PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR =
  'data-recued-pair-code-input-interrupted-notice';
export const PAIR_CODE_INPUT_TAKEOVER_READY_ATTR =
  'data-recued-pair-code-input-takeover-ready';
/** Present only after this tab owns the exclusive pair-finalize lock and its
 * durable preflight confirms that no sibling already completed. It lets the
 * visible state distinguish the one tab actually reconnecting from contenders
 * that are still waiting to adopt its result. */
export const PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR =
  'data-recued-pair-code-input-takeover-owner';
/** Present on tabs that yielded after a queued contender acquired the shared
 * finalize lock. The successor owns the active attempt; this tab keeps its
 * exact retry material in memory but does not invite a competing request. */
export const PAIR_CODE_INPUT_SUCCESSION_ATTR =
  'data-recued-pair-code-input-succession';
/** Marks the one failed takeover tab that owns the actionable recovery UI. */
export const PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR =
  'data-recued-pair-code-input-recovery-owner';
/** Marks sibling tabs yielding their retained retries to that recovery owner. */
export const PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR =
  'data-recued-pair-code-input-recovery-owner-elsewhere';
/** Marks the one survivor atomically chosen after the prior recovery owner
 * closes or stops renewing its lease. */
export const PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR =
  'data-recued-pair-code-input-recovery-successor';
/** Marks tabs staying passive while the chosen recovery successor is live. */
export const PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR =
  'data-recued-pair-code-input-recovery-successor-elsewhere';
const PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ID =
  'webclient-pair-code-input-interrupted-notice';
const DEFAULT_SIBLING_TAKEOVER_DELAY_MS = 5_000;
const DEFAULT_SIBLING_SUCCESSION_DELAY_MS = 5_000;
const DEFAULT_SIBLING_RECOVERY_OWNER_DELAY_MS = 10_000;
const DEFAULT_RECOVERY_OWNER_HEARTBEAT_MS = 2_500;

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
  /** The browser refused the request before it left: an `http://` server
   *  address entered on an `https://` page. Distinct from
   *  `pair_code_input_transport_failed` because "check the URL and that the
   *  server is running" is the WRONG advice — the URL may be exactly right and
   *  the server running fine. */
  | 'pair_code_input_blocked_by_browser'
  | 'pair_code_input_server_unknown_error'
  | 'pair_code_input_server_refused'
  | 'pair_code_input_already_paired'
  | 'pair_code_input_finalize_interrupted';

/** Server-side errors — `/auth/pair` codes this client holds TAILORED
 *  copy for, sourced from `@recued/ui-shared/pairing` so the webclient
 *  and the Bridge popup cannot drift apart again.
 *
 *  ⚠ NOT a closed list of what the endpoint can return, and it must not
 *  be read as one. The old hand-copied version claimed to be exactly
 *  that (citing a `server.ts` line that had since moved) while sitting
 *  four codes behind; anything it missed was reported to the user as
 *  "check the URL", which was wrong in every one of those four cases.
 *  Unrecognised codes now travel as `pair_code_input_server_refused`
 *  with the server's own message attached. */
export type PairCodeInputServerErrorCode = PairServerErrorCode;

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
    'All 24 words are present, but they do not form a valid recovery key. Check for a misspelled, missing, or duplicated word.',
  pair_code_input_transport_failed:
    "Couldn't reach your recued-server. Check the URL and that the server is running, then try again.",
  pair_code_input_blocked_by_browser:
    'This browser blocked the request: this page is secure (https) but that '
    + 'server address is not. Open the webclient from the server itself — its '
    + 'own address ending in /webclient/ — or give the server a domain and '
    + 'certificate and use its https address.',
  // Reserved for a reply that isn't shaped like a recued-server's at all
  // (non-JSON, or a 200 with no realm token) — there, "check the URL" is
  // genuinely the right advice. A server that answered with a proper
  // error block gets `pair_code_input_server_refused` instead.
  pair_code_input_server_unknown_error:
    'The server returned an unexpected response. Check the URL and try again.',
  pair_code_input_server_refused: PAIR_SERVER_REFUSED_COPY,
  pair_code_input_already_paired:
    'Another tab finished pairing while this form was open. Reload to use the existing pair, or clear this browser from Settings to pair a new server.',
  pair_code_input_finalize_interrupted:
    'The server paired this browser, but saving access here was interrupted.',
  // The server half is SPREAD, not restated. Restating it is what let the
  // webclient and the Bridge drift from each other and from the server.
  ...PAIR_SERVER_ERROR_COPY,
};

/** Generate-mode override for `recovery_key_invalid`. A freshly-minted
 *  key that the server rejects as a mismatch means the realm is ALREADY
 *  enrolled (every later pair only VERIFIES) — so the user wanted the
 *  enter path, not generate. Steer them there instead of the generic
 *  "check your written copy" copy, which makes no sense for a key we
 *  just generated. */
export const PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY =
  "This server already has a recovery key. Enter your existing 24-word key below to connect.";
export const PAIR_CODE_INPUT_REPLACEMENT_ALREADY_ENROLLED_COPY =
  'This current server is already set up, so Recued did not replace its recovery key. Confirm with its administrator before entering the existing key that belongs to this server.';

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

const interruptedFinalizeCopy = (error: unknown): string => {
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/^Pairing succeeded,\s*but\s*/i, '')
    .replace(/\s*Reload and try again\.?\s*$/i, '')
    .replace(/[.!]\s*$/, '')
    .trim();
  return `${detail.length > 0
    ? `Saving access here was interrupted: ${detail}.`
    : 'Saving access here was interrupted.'} Try again below. Recued will finish the browser save without sending another pairing request.`;
};

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
      /** The server's own message, sanitized + quotable, when it refused
       *  with a code this client has no tailored copy for. Present ONLY
       *  with `pair_code_input_server_refused`; the host renders it
       *  attributed. */
      serverSaid?: string;
      /** The raw code the server sent, when it wasn't one we map. Kept
       *  for the `data-error` attribute + support conversations — a user
       *  reading "your server refused" can still name what it said. */
      serverCode?: string;
    };

const normalizeServerUrl = (raw: string): string => raw.trim().replace(/\/$/, '');

/** Pairing codes are generated as one compact token, but terminals, password
 * managers, and messages commonly group short codes with spaces. Whitespace
 * is never part of the server-issued secret, so discard it at the webclient
 * boundary while leaving every non-whitespace character for the server's
 * authoritative comparison. */
const normalizePairingCode = (raw: string): string => raw.replace(/\s+/g, '');

/** Server identity that is safe to show or share during unauthenticated
 * recovery. Origin deliberately drops user-info, paths, query parameters,
 * and fragments while retaining the scheme, host, and non-default port the
 * user needs to distinguish two Recued servers. */
const safeServerOrigin = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
};

type RecoveryDiagnosticCopyState = 'idle' | 'copied' | 'unavailable';

interface PairCodeInputRenderContext {
  readonly recoveryKeyRejectionCount: number;
  /** Trusted only for guided reauth: the address this mount was seeded with
   * before the person could edit the form. Never populated from a pair link. */
  readonly previouslyPairedServerUrl: string | null;
  readonly recoveryDiagnosticCopyState: RecoveryDiagnosticCopyState;
  readonly recoveryDiagnosticCopyInFlight: boolean;
}

const buildRecoveryKeyRejectionDiagnostic = (
  attemptCount: number,
  currentServerUrl: string,
  previouslyPairedServerUrl: string | null,
): string => {
  const currentOrigin = safeServerOrigin(currentServerUrl) ?? 'unavailable';
  const previousOrigin = previouslyPairedServerUrl === null
    ? null
    : safeServerOrigin(previouslyPairedServerUrl);
  const originComparison = previousOrigin === null
    ? 'unavailable'
    : currentOrigin === previousOrigin
      ? 'matches previously paired origin'
      : 'differs from previously paired origin';
  return [
    'Recued recovery-key mismatch',
    `Format-valid key rejections in this tab: ${attemptCount}`,
    `Latest server origin tried: ${currentOrigin}`,
    `Previously paired server origin: ${previousOrigin ?? 'unavailable in this recovery form'}`,
    `Origin comparison: ${originComparison}`,
    'Server response code: recovery_key_invalid',
    'Requested owner check: confirm this server origin and whether the server was replaced or reset; do not request the recovery key',
    'Excluded: recovery key, pairing code, page route, Chat draft, bearer, and raw server text',
  ].join('\n');
};

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
  const code = normalizePairingCode(options.code ?? '');
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
    // A blocked request and an unreachable server are the same exception here —
    // the browser reports a mixed-content refusal exactly like a dead host — so
    // the address combination is the only evidence available. Checked ONLY on
    // failure: Chrome permits a loopback dial from an https page, and a working
    // setup must never be warned at.
    if (isCertainlyBlockedServerAddress(serverUrl, readPageProtocol())) {
      return {
        ok: false,
        error: 'pair_code_input_blocked_by_browser',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
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
  const presented = describePairServerError(errCode, errMsg);
  if (presented.tailored) {
    const out: PairCodeInputCommitResult = {
      ok: false,
      error: presented.code as PairServerErrorCode,
    };
    if (errMsg) out.detail = errMsg;
    return out;
  }
  // The server answered in the right shape and said no with a code we
  // don't map. That is NOT "an unexpected response, check the URL" — the
  // URL reached the right server. Carry its own words through instead.
  const refused: PairCodeInputCommitResult = {
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

export interface PairCodeInputDeeplinkSeed {
  /** Trusted in-process prefill only. The URL parser rejects query URLs. */
  serverUrl?: string;
  /** Pre-fill the Pairing code field. P4 wires this from `?code=…`. */
  pairingCode?: string;
  /** The server URL was derived from this page's own secure origin after the
   * insecure-context handoff. Never populate this from a query URL. */
  sameOriginResume?: boolean;
}

export type PairCodeInputReauthReason =
  | 'server_rejected'
  | 'credentials_changed_elsewhere'
  | 'startup_credentials_changed_elsewhere'
  | 'local_credentials_incomplete'
  | 'local_credentials_unreadable';

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
  /** Present only when the explicit replaced/reset-server ceremony created a
   * new key after the person reviewed the current origin and fresh code. */
  recoveryContext?: 'fresh_replacement';
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

type PairCodeInputFocusTarget =
  | PairRestoreFocusField
  | 'submit'
  | 'recoveryCorrection'
  | 'recoveryStop'
  | 'recoveryDiagnosticCopy'
  | 'recoveryDiagnosticStatus'
  | 'recoveryDiagnosticSummary'
  | 'replacementReview'
  | 'generateRecoveryKey';

export interface MountPairCodeInputHostOptions {
  /** Slot the form renders into. The webclient main typically passes
   *  `document.getElementById(SPLASH_ID)`. */
  splashElement?: HTMLElement;
  /** Document seam (tests). */
  document?: Document;
  /** Safe pair-entry pre-fills (CLI code and trusted in-process origin). */
  seed?: PairCodeInputDeeplinkSeed;
  /** Guided in-process re-pair mode. Keeps the trusted server URL prefilled,
   * removes first-run generate/restore choices, and explains what will return
   * after the existing recovery key is verified. */
  reauthRecovery?: {
    readonly chatDraftPreserved: boolean;
    readonly reason?: PairCodeInputReauthReason;
    /** This document was restored after its prior guided-recovery document
     * ended. No pairing input or work snapshot crossed that boundary; the
     * current URL is the exact-route authority. */
    readonly recoveryReentry?: true;
    /** A deliberate missing-key stop crossed a document boundary. Only this
     * credential-free state and the current route survived; all prior pairing
     * input, rejection history, and owner diagnostic were discarded. */
    readonly safeStopReentry?: true;
    /** The prior document had already entered the administrator-confirmed
     * replacement/reset path. Only that constant intent survived; the current
     * server address, code, key, and review choice must be entered again. */
    readonly replacementServerReentry?: true;
  };
  /** Optional instance id forwarded to `/auth/pair`. */
  instanceId?: string;
  /** Optional display name forwarded to `/auth/pair`. */
  displayName?: string;
  /** Test seam — overrides `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Clipboard seam for the repeated recovery-key rejection diagnostic.
   * The summary contains only server origins, the local attempt count, and a
   * fixed response code — never recovery words, pairing codes, route, draft,
   * bearer, or raw server text. Production resolves the browser clipboard. */
  recoveryDiagnosticWriter?: (summary: string) => Promise<void>;
  /** Credential-free recovery lifecycle. Callers may persist only one of
   * these constant checkpoints; no form value, server identity, or diagnostic
   * is passed through this seam. */
  onRecoveryCheckpointChange?: (
    checkpoint: 'unresolved' | 'safe_stop' | 'replacement_server',
  ) => void;
  /** Invoked INSIDE the pair-finalize lock, after a successful
   *  `/auth/pair`. Production wires this to
   *  `finalizePairCodeSuccess` so the persistence runs while the lock
   *  is held; the wider post-pair lifecycle (dispose + bootstrap
   *  restart) belongs in `onAfterPair`. A throw from `onPaired` keeps
   *  the successful server response in this host's memory so the user
   *  can retry ONLY local persistence without posting `/auth/pair`
   *  again; it also prevents `onAfterPair` from running. */
  onPaired: (result: PairCodeInputSuccess) => void | Promise<void>;
  /** Optional credential-free lifecycle hint, invoked once immediately after
   *  a fresh `/auth/pair` success and before local finalization. It must not
   *  persist/transport `result`; production uses it only to scrub the consumed
   *  code and tell sibling forms to wait or take over. */
  onPairAccepted?: () => void;
  /** Optional credential-free lifecycle hint invoked by a guided takeover
   * after it owns the exclusive lock and durable preflight confirms no sibling
   * has completed, but before it contacts `/auth/pair`. Production uses this
   * to make a failed prior owner and passive contenders visibly yield. */
  onTakeoverStarted?: () => void;
  /** Optional credential-free lifecycle hint invoked when a coordinated
   * takeover owns the lock but its request/finalize attempt fails. Siblings
   * can yield their retries to this tab without receiving the error detail. */
  onTakeoverNeedsAttention?: () => void;
  /** Attempt an atomic, non-blocking claim after the visible recovery owner's
   * heartbeat expires. A returned lease is held while this tab offers the one
   * successor retry; null leaves it passive to try again later. */
  claimRecoverySuccessor?: () => Promise<{ release(): void } | null>;
  /** Credential-free signal/heartbeat that this tab won the recovery-owner
   * succession lease. Error and retry material remain tab-local. */
  onRecoverySuccessorChosen?: () => void;
  /** Whether lifecycle hints can reach siblings immediately and the browser
   * can atomically elect a successor. Poll-only/lock-limited convergence stays
   * safe for durable adoption, but cannot promise one visible recovery owner
   * through owner loss. Defaults to true, but coordinated UI also requires
   * both recovery-successor callbacks above. */
  siblingTakeoverSignalsAvailable?: boolean;
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
  preflightCheck?: () => Promise<{
    alreadyPaired: boolean;
    /** A server-success write began but the strict triple is incomplete.
     *  The host aborts a normal submit once, clears any stale one-time code,
     *  and presents the recovery-key takeover before another POST. */
    interrupted?: boolean;
  }>;
  /** How long a guided re-pair waits after a sibling transition before its
   * primary action becomes an explicit safe takeover. The default is long
   * enough for ordinary local persistence but bounded so an abandoned tab
   * cannot leave this form looking stuck. `null` skips the wait and offers
   * takeover immediately; tests may provide a shorter deterministic delay. */
  siblingTakeoverDelayMs?: number | null;
  /** How long a yielded tab waits for the named successor before restoring
   * its retained retry controls. Durable preflight still prevents duplicate
   * completion if the successor finishes at the boundary. */
  siblingSuccessionDelayMs?: number;
  /** How long a sibling yields to the tab holding the latest actionable
   * takeover error before restoring a safe local takeover. */
  siblingRecoveryOwnerDelayMs?: number;
  /** How often the live recovery owner renews its credential-free claim.
   * `null` disables renewal for deterministic timeout tests. */
  recoveryOwnerHeartbeatMs?: number | null;
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
  /** Credential-free sibling hint. Durable storage remains authoritative;
   *  this only explains why a still-usable form may need to take over. */
  showInterruptedCredentialTransition(): void;
  /** Credential-free hint that another tab has just received a successful
   * server pairing response. Unlike a repeated partial-store observation,
   * this is fresh progress and may supersede a retained recovery owner. */
  showSiblingPairAccepted(): void;
  /** Credential-free hint that a queued contender now owns the shared lock.
   * Retains this tab's failed response/error while temporarily yielding its
   * retry action to the successor. */
  showSiblingTakeoverStarted(): void;
  /** Credential-free hint that another tab now owns the actionable recovery
   * error. Retains this tab's exact retry while yielding its controls. */
  showSiblingTakeoverNeedsAttention(): void;
  /** Credential-free hint that the prior owner disappeared and another tab
   * atomically became the sole recovery successor. */
  showSiblingRecoverySuccessorChosen(): void;
  /** Downgrade to one-tab-only recovery when the optional sibling signal
   * listener cannot be established after mount. */
  disableSiblingTakeoverCoordination(): void;
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
type PairRecoveryResumeOutcome = 'key_found' | 'server_changed' | null;
type ReplacementServerStage =
  | 'details'
  | 'review'
  | 'fresh_key'
  | 'not_fresh'
  | 'existing_key'
  | null;

interface PairCodeInputState {
  serverUrl: string;
  pairingCode: string;
  /** True only for the secure-access handoff's live-origin prefill. */
  sameOriginResume: boolean;
  /** In `enter` mode: the key being typed. In `generate`/`challenging`:
   *  the re-typed confirmation of the generated key. */
  recoveryWords: string[];
  /** The person confirmed the server but has no usable original key. This is
   * a deliberate local stop: sensitive inputs are wiped and no pair request
   * can run until they explicitly resume one of the correction paths. */
  recoveryPaused: boolean;
  /** Distinguishes a live owner handoff (whose reviewed origin remains only in
   * this document) from a credential-free re-entry after that document ended. */
  recoveryPausedFromReentry: boolean;
  /** Contextual guidance after an explicit safe-stop exit. */
  recoveryResumeOutcome: PairRecoveryResumeOutcome;
  /** Explicit replaced/reset-server ceremony. Recovery material is not
   * accepted until the current origin + fresh code review is complete. */
  replacementServerStage: ReplacementServerStage;
  /** Survives a local-finalize interruption after the fresh realm accepted its
   * newly generated key, so the eventual receipt still reports that outcome. */
  replacementServerFreshStart: boolean;
  submitting: boolean;
  error: {
    copy: string;
    code: PairCodeInputErrorCode;
    /** The raw code the server sent, when unmapped. Rendered as an
     *  attribute for support, never as copy. */
    serverCode?: string;
    /** D-212 tail #6 — the server's own message, quoted + attributed
     *  beneath `copy` when the server refused with a code we don't map.
     *  Kept as its own field, never concatenated into `copy`: at the
     *  pairing screen nothing has authenticated that host yet, so its
     *  words must not read as Recued's. */
    serverSaid?: string;
  } | null;
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
  /** Forced re-pair is an existing-key ceremony, never first-run enrollment
   * or archive restore. It also drives honest reconnect-specific copy. */
  reauthOnly: boolean;
  /** `/auth/pair` succeeded, but `onPaired` did not finish. The matching
   *  bearer response lives only in the mount closure, never in DOM/storage. */
  finalizePending: boolean;
  /** A server-accepted transition now needs local recovery guidance. The
   *  companion flags distinguish held-response, explicit-restart, and sibling
   *  takeover copy while this form remains safely usable. */
  interruptedTransition: boolean;
  /** A guided sibling transition has exceeded its ordinary persistence
   * window. The form may now offer an explicit local takeover; the shared
   * lock + durable preflight remain authoritative when the user submits. */
  siblingTakeoverReady: boolean;
  /** True only when this mount has both pieces needed to promise one winner:
   * an exclusive cross-tab lock and a durable inside-lock preflight. Older
   * environments remain usable but must tell people to continue in one tab. */
  siblingTakeoverCoordinationAvailable: boolean;
  /** This ready takeover owns the shared finalize lock and passed durable
   * preflight. Only this tab may contact `/auth/pair`; simultaneous contenders
   * remain in the choosing state until they can adopt the resulting pair. */
  siblingTakeoverOwnsAttempt: boolean;
  /** A queued contender acquired the shared lock after this tab failed or
   * waited. Suppress this tab's retry until that successor completes or its
   * bounded succession window expires. */
  siblingSuccessionInProgress: boolean;
  /** This failed takeover tab owns the one visible recovery action. */
  takeoverRecoveryOwner: boolean;
  /** This owner was selected after the previous owner's heartbeat expired. */
  takeoverRecoverySuccessor: boolean;
  /** Another tab owns the current recovery action; this tab stays passive. */
  siblingRecoveryOwnerElsewhere: boolean;
  /** The remote owner is a selected successor, rather than the tab that
   * produced the latest failed attempt. */
  siblingRecoverySuccessorElsewhere: boolean;
  /** The owner explicitly discarded this tab's held response after a local
   *  finalize failure. Keep that recovery copy distinct from sibling copy. */
  finalizeRestarted: boolean;
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

export const PAIR_CODE_INPUT_STYLES = `
.pair-code-input-form {
  width: min(420px, calc(100vw - 32px));
  margin: 0 auto;
  text-align: left;
}
.pair-code-input-form [hidden] {
  display: none !important;
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
.pair-code-input-recovery-help {
  margin: -4px 0 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font-size: 12.5px;
  line-height: 1.45;
}
.pair-code-input-recovery-help summary {
  box-sizing: border-box;
  min-height: 44px;
  padding: 12px 13px;
  cursor: pointer;
  font-weight: 650;
}
.pair-code-input-recovery-help summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.pair-code-input-recovery-help[open] summary {
  border-bottom: 1px solid var(--border);
}
.pair-code-input-recovery-help-body {
  display: grid;
  gap: 10px;
  padding: 12px 13px 13px;
}
.pair-code-input-recovery-help-body p {
  margin: 0;
}
.pair-code-input-recovery-help-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.pair-code-input-reauth-notice,
.pair-code-input-secure-resume-notice,
.pair-code-input-interrupted-notice {
  display: grid;
  gap: 5px;
  margin: 0 0 16px;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: 9px;
  background: var(--surface-sunk);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--fg);
  font-size: 12.5px;
  line-height: 1.45;
}
.pair-code-input-reauth-notice strong,
.pair-code-input-secure-resume-notice strong,
.pair-code-input-interrupted-notice strong {
  font-size: 13px;
}
.pair-code-input-reauth-notice p,
.pair-code-input-secure-resume-notice p,
.pair-code-input-interrupted-notice p {
  margin: 0;
}
.pair-code-input-interrupted-notice {
  border-color: color-mix(in srgb, var(--warning, #9a6700) 42%, var(--border));
  background: color-mix(in srgb, var(--warning, #9a6700) 9%, var(--surface));
}
.pair-code-input-secure-resume-notice code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
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
  min-height: 36px;
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
.pair-code-input-form input[readonly] {
  background: var(--surface-sunk);
  color: var(--fg-muted);
}
.pair-code-input-form input:disabled { opacity: 0.6; }
.pair-code-input-change-server {
  align-self: flex-start;
  min-height: 36px;
  margin: 1px 0 0;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}
.pair-code-input-change-server:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.pair-code-input-change-server:disabled {
  opacity: 0.6;
  cursor: default;
}
.pair-code-input-change-server-note {
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.35;
}
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
.pair-code-input-recovery-correction {
  margin: 10px 0 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.pair-code-input-recovery-correction:focus {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.pair-code-input-recovery-correction strong {
  display: block;
  margin-bottom: 4px;
  color: var(--fg);
}
.pair-code-input-recovery-correction h3,
.pair-code-input-recovery-correction h4 {
  margin: 0;
  color: var(--fg);
  font-size: inherit;
}
.pair-code-input-recovery-correction h3 {
  margin-bottom: 4px;
  font-size: 14px;
}
.pair-code-input-recovery-correction p {
  margin: 0;
}
.pair-code-input-recovery-correction code {
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.pair-code-input-recovery-correction ol {
  margin: 8px 0 0;
  padding-left: 20px;
}
.pair-code-input-recovery-correction li + li {
  margin-top: 4px;
}
.pair-code-input-recovery-triage-identity {
  margin-top: 9px !important;
  padding: 8px 9px;
  border-left: 3px solid var(--accent);
  background: var(--surface);
  color: var(--fg);
}
.pair-code-input-recovery-triage-paths {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.pair-code-input-recovery-triage-path {
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 6px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
}
.pair-code-input-recovery-triage-path .pair-code-input-recovery-correction-actions {
  align-self: end;
  margin-top: 3px;
}
.pair-code-input-recovery-correction-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 11px;
}
.pair-code-input-recovery-correction-actions button {
  min-height: 44px;
  padding: 8px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.pair-code-input-recovery-correction-actions button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.pair-code-input-recovery-correction-actions button:disabled {
  cursor: default;
  opacity: 0.65;
}
.pair-code-input-recovery-diagnostic {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  color: var(--fg-muted);
}
.pair-code-input-recovery-diagnostic summary {
  box-sizing: border-box;
  min-height: 44px;
  padding: 11px 0 8px;
  color: var(--fg);
  cursor: pointer;
  font-weight: 650;
}
.pair-code-input-recovery-diagnostic summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.pair-code-input-recovery-diagnostic-body {
  display: grid;
  gap: 8px;
  padding-bottom: 2px;
}
.pair-code-input-recovery-diagnostic pre {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  margin: 0;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.pair-code-input-recovery-diagnostic-status {
  min-height: 1em;
}
.pair-code-input-recovery-diagnostic-status.is-error {
  color: var(--danger);
}
.pair-code-input-recovery-stop {
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--accent);
  border-radius: 9px;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.pair-code-input-recovery-stop:focus {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.pair-code-input-recovery-stop h3,
.pair-code-input-recovery-stop h4 {
  margin: 0;
  color: var(--fg);
}
.pair-code-input-recovery-stop h3 {
  margin-bottom: 4px;
  font-size: 15px;
}
.pair-code-input-recovery-stop h4 {
  margin-top: 13px;
  font-size: 13px;
}
.pair-code-input-recovery-stop p {
  margin: 0;
}
.pair-code-input-recovery-stop-state {
  display: grid;
  gap: 5px;
  margin-top: 11px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
}
.pair-code-input-recovery-stop-state strong,
.pair-code-input-recovery-stop-state code {
  color: var(--fg);
}
.pair-code-input-recovery-stop-state code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.pair-code-input-recovery-stop ol {
  margin: 8px 0 0;
  padding-left: 20px;
}
.pair-code-input-recovery-stop li + li {
  margin-top: 5px;
}
.pair-code-input-recovery-stop-warning {
  margin-top: 11px !important;
  padding: 9px 10px;
  border-left: 3px solid var(--border-strong);
  background: var(--surface);
}
.pair-code-input-recovery-stop-warning strong {
  color: var(--fg);
}
.pair-code-input-recovery-stop-actions {
  padding-top: 2px;
  border-top: 1px solid var(--border);
}
/* D-212 tail #6 — the quoted server message. Deliberately NOT the danger
   block above: that block is Recued speaking, this is an unauthenticated
   host being quoted, and they must not look like one sentence. Muted,
   monospace-quoted, its own margin. */
.pair-code-input-server-said {
  margin: 6px 0 0;
  padding: 6px 10px;
  border-left: 2px solid var(--border-strong);
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.pair-code-input-server-said-label {
  font-weight: 600;
}
.pair-code-input-actions {
  margin-top: 16px;
}
.pair-code-input-actions button {
  width: 100%;
  min-height: 44px;
  padding: 9px 12px;
  font: inherit;
  font-weight: 600;
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  cursor: pointer;
}
.pair-code-input-actions button:disabled,
.pair-code-input-actions button[aria-disabled="true"] {
  opacity: 0.55;
  cursor: default;
}
.pair-code-input-actions .pair-code-input-restart-after-interruption {
  min-height: 44px;
  margin-top: 9px;
  color: var(--fg);
  background: var(--surface);
  border-color: var(--border);
}
.pair-code-input-restart-note {
  margin: 6px 2px 0;
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
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
  min-height: 36px;
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
  min-height: 36px;
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
@media (max-width: 520px) {
  .pair-code-input-form input,
  .pair-code-input-secondary-btn,
  .pair-code-input-linkbtn {
    min-height: 44px;
  }
}
@media (max-width: 340px) {
  .pair-code-input-recovery-triage-paths {
    grid-template-columns: 1fr;
  }
  .pair-code-input-recovery-correction-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .pair-code-input-recovery-correction-actions button {
    width: 100%;
  }
  .pair-code-input-form .rx-recovery-words {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px 8px;
  }
  .pair-code-input-form .rx-recovery-word label {
    min-width: 16px;
  }
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
  // The fast-refresh wrapper starts hidden for 160ms to avoid a Loading flash.
  // Once an interactive pair form replaces that placeholder it must be visible
  // and focusable immediately; browsers reject focus inside a hidden ancestor.
  (splashEl.closest?.(BOOT_PENDING_SELECTOR) as HTMLElement | null)
    ?.removeAttribute('data-recued-boot-pending');

  const reauthOnly = options.reauthRecovery !== undefined;
  const restoreEnabled = !reauthOnly && options.onRestoreSubmit !== undefined;
  // S3.4 — restore-ONLY is only meaningful when restore is wired.
  const restoreOnly = restoreEnabled && options.restoreOnly === true;
  // Codex S3.3 fold — `restoreEnabled` gates the tab AND the initial mode. A
  // caller that asks to open in `restore` without wiring `onRestoreSubmit`
  // would otherwise land on a fillable form whose submit silently no-ops (the
  // tab is hidden, but the body still renders). Coerce back to `enter` so the
  // form is never stuck in an un-submittable mode. restore-only forces restore.
  const initialMode: PairRecoveryMode = reauthOnly
    ? 'enter'
    : restoreOnly
      ? 'restore'
      : options.initialRecoveryMode === 'restore' && !restoreEnabled
        ? 'enter'
        : options.initialRecoveryMode ?? 'enter';

  const safeStopReentryRequested =
    options.reauthRecovery?.safeStopReentry === true;
  const replacementServerReentryRequested =
    options.reauthRecovery?.replacementServerReentry === true;
  const privateRecoveryReentry =
    safeStopReentryRequested || replacementServerReentryRequested;
  const seededServerUrl = privateRecoveryReentry
    ? ''
    : options.seed?.serverUrl ?? '';
  const previouslyPairedServerUrl = reauthOnly && seededServerUrl.trim().length > 0
    ? seededServerUrl.trim()
    : null;
  let state: PairCodeInputState = {
    serverUrl: seededServerUrl,
    pairingCode: privateRecoveryReentry
      ? ''
      : normalizePairingCode(options.seed?.pairingCode ?? ''),
    sameOriginResume:
      options.seed?.sameOriginResume === true
      && seededServerUrl.trim().length > 0,
    recoveryWords: toRecoveryWords(''),
    recoveryPaused: safeStopReentryRequested,
    recoveryPausedFromReentry: safeStopReentryRequested,
    recoveryResumeOutcome: replacementServerReentryRequested
      ? 'server_changed'
      : null,
    replacementServerStage: replacementServerReentryRequested
      ? 'details'
      : null,
    replacementServerFreshStart: false,
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
    reauthOnly,
    finalizePending: false,
    interruptedTransition: false,
    siblingTakeoverReady: false,
    siblingTakeoverCoordinationAvailable:
      options.lockProvider !== null
      && options.lockProvider !== undefined
      && options.preflightCheck !== undefined
      && options.siblingTakeoverSignalsAvailable !== false
      && options.claimRecoverySuccessor !== undefined
      && options.onRecoverySuccessorChosen !== undefined,
    siblingTakeoverOwnsAttempt: false,
    siblingSuccessionInProgress: false,
    takeoverRecoveryOwner: false,
    takeoverRecoverySuccessor: false,
    siblingRecoveryOwnerElsewhere: false,
    siblingRecoverySuccessorElsewhere: false,
    finalizeRestarted: false,
  };
  const generateImpl = options.generate ?? (() => generateRecoveryKey().mnemonic);
  let disposed = false;
  // A successful `/auth/pair` response can contain a one-time bearer. Keep it
  // only in this mount closure while local persistence is retried. Putting it
  // in state would make it too easy for a future template/debug serializer to
  // expose it; dropping it would force a second pairing request.
  let pendingPairResult: PairCodeInputSuccess | null = null;
  let siblingTakeoverTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;
  let siblingSuccessionTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;
  let siblingRecoveryOwnerTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;
  let recoveryOwnerHeartbeatTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;
  let recoverySuccessorClaimInFlight = false;
  let recoverySuccessorLease: { release(): void } | null = null;
  // Rejection history is deliberately mount-local. It improves a correction
  // loop in this tab without persisting recovery activity or correlating it
  // across reloads/tabs. The diagnostic itself never receives the words.
  let recoveryKeyRejectionCount = 0;
  let recoveryDiagnosticCopyState: RecoveryDiagnosticCopyState = 'idle';
  let recoveryDiagnosticCopyInFlight = false;
  let recoveryDiagnosticRevision = 0;
  const invalidateRecoveryDiagnostic = (): void => {
    recoveryDiagnosticRevision += 1;
    recoveryDiagnosticCopyState = 'idle';
    recoveryDiagnosticCopyInFlight = false;
  };
  const notifyRecoveryCheckpointChange = (
    checkpoint: 'unresolved' | 'safe_stop' | 'replacement_server',
  ): void => {
    try {
      options.onRecoveryCheckpointChange?.(checkpoint);
    } catch {
      // Continuity is best-effort. A denied storage channel must never trap
      // the live form or expose recovery material through an error path.
    }
  };
  /** S3.3 — a one-shot field to focus after the first render (a restore
   *  bounce re-mount lands the cursor on the field the orchestrator flagged).
   *  Cleared once applied so later keystroke re-renders don't steal focus. */
  let pendingFocus: PairCodeInputFocusTarget = state.recoveryPaused
    ? 'recoveryStop'
    : state.replacementServerStage === 'details'
      ? 'serverUrl'
      : reauthOnly
        ? state.serverUrl.trim().length > 0
          ? 'archiveKey'
          : 'serverUrl'
        : initialMode === 'restore'
          ? options.restoreNotice?.focus ?? null
          : state.sameOriginResume
            ? 'archiveKey'
            : null;
  const applyPendingFocus = (): void => {
    if (pendingFocus === null) return;
    const focusField = pendingFocus;
    const focusSelector =
      focusField === 'serverUrl'
        ? `#${PAIR_CODE_INPUT_SERVER_URL_ID}`
        : focusField === 'replacementReview'
          ? `#${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ID}`
          : focusField === 'generateRecoveryKey'
            ? `[data-action="${PAIR_CODE_INPUT_GENERATE_ACTION}"]`
            : focusField === 'submit'
              ? `#${PAIR_CODE_INPUT_SUBMIT_ID}`
              : focusField === 'recoveryCorrection'
                ? `#${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ID}`
                : focusField === 'recoveryStop'
                  ? `#${PAIR_CODE_INPUT_RECOVERY_STOP_ID}`
                  : focusField === 'recoveryDiagnosticCopy'
                    ? `[data-action="${PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION}"]`
                    : focusField === 'recoveryDiagnosticStatus'
                      ? `[${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_STATUS_ATTR}]`
                      : focusField === 'recoveryDiagnosticSummary'
                        ? `[${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_SUMMARY_ATTR}]`
                        : focusField === 'pairingCode'
                          ? `#${PAIR_CODE_INPUT_CODE_ID}`
                          : focusField === 'file'
                            ? `#${PAIR_CODE_INPUT_RESTORE_FILE_ID}`
                            : `#${PAIR_CODE_INPUT_RECOVERY_PREFIX}-0`; // 'archiveKey' → first slot
    pendingFocus = null;
    try {
      const el = splashEl.querySelector?.(focusSelector) as
        | { focus?: () => void; select?: () => void }
        | null;
      el?.focus?.();
      if (focusField === 'serverUrl') el?.select?.();
    } catch {
      /* best-effort — non-DOM fake env (tests) has no real focusable nodes */
    }
  };

  const render = (): void => {
    if (disposed) return;
    const recoveryHelpWasOpen = (
      splashEl.querySelector?.(
        `[${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}]`,
      ) as HTMLDetailsElement | null
    )?.open === true;
    splashEl.innerHTML = renderForm(state, options.reauthRecovery, {
      recoveryKeyRejectionCount,
      previouslyPairedServerUrl,
      recoveryDiagnosticCopyState,
      recoveryDiagnosticCopyInFlight,
    });
    if (recoveryHelpWasOpen) {
      (
        splashEl.querySelector?.(
          `[${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}]`,
        ) as HTMLDetailsElement | null
      )?.setAttribute('open', '');
    }
    applyPendingFocus();
    syncInsecureAddressHint();
  };

  const setState = (patch: Partial<PairCodeInputState>): void => {
    state = { ...state, ...patch };
    render();
  };

  const setStatePreservingActiveField = (
    patch: Partial<PairCodeInputState>,
  ): void => {
    const active = doc?.activeElement as
      | (HTMLElement & {
          selectionStart?: number | null;
          selectionEnd?: number | null;
          setSelectionRange?: (start: number, end: number) => void;
        })
      | null
      | undefined;
    const activeId = active?.id && splashEl.contains?.(active)
      ? active.id
      : null;
    const selectionStart = active?.selectionStart;
    const selectionEnd = active?.selectionEnd;
    setState(patch);
    if (activeId === null) return;
    try {
      const replacement = splashEl.querySelector?.(`#${activeId}`) as
        | (HTMLElement & {
            setSelectionRange?: (start: number, end: number) => void;
          })
        | null;
      replacement?.focus?.({ preventScroll: true });
      if (
        typeof selectionStart === 'number'
        && typeof selectionEnd === 'number'
      ) {
        replacement?.setSelectionRange?.(selectionStart, selectionEnd);
      }
    } catch {
      /* best-effort focus/caret continuity in minimal DOM environments */
    }
  };

  const clearSiblingTakeoverTimer = (): void => {
    if (siblingTakeoverTimer === null) return;
    globalThis.clearTimeout(siblingTakeoverTimer);
    siblingTakeoverTimer = null;
  };

  const clearSiblingSuccessionTimer = (): void => {
    if (siblingSuccessionTimer === null) return;
    globalThis.clearTimeout(siblingSuccessionTimer);
    siblingSuccessionTimer = null;
  };

  const scheduleSiblingSuccessionFallback = (): void => {
    clearSiblingSuccessionTimer();
    const delay = options.siblingSuccessionDelayMs
      ?? DEFAULT_SIBLING_SUCCESSION_DELAY_MS;
    siblingSuccessionTimer = globalThis.setTimeout(() => {
      siblingSuccessionTimer = null;
      if (disposed || !state.siblingSuccessionInProgress) return;
      setStatePreservingActiveField({
        siblingSuccessionInProgress: false,
        ...(state.reauthOnly
          && state.interruptedTransition
          && !state.finalizePending
          && !state.finalizeRestarted
          ? { siblingTakeoverReady: true }
          : {}),
      });
    }, Math.max(0, delay));
    // Node-backed unit runners should not stay alive for a browser UX timer.
    (siblingSuccessionTimer as unknown as { unref?: () => void }).unref?.();
  };

  const clearSiblingRecoveryOwnerTimer = (): void => {
    if (siblingRecoveryOwnerTimer === null) return;
    globalThis.clearTimeout(siblingRecoveryOwnerTimer);
    siblingRecoveryOwnerTimer = null;
  };

  const releaseRecoverySuccessorLease = (): void => {
    const lease = recoverySuccessorLease;
    recoverySuccessorLease = null;
    try {
      lease?.release();
    } catch {
      // The UI has already yielded. Browser teardown also releases Web Locks,
      // so a defensive provider failure cannot make this tab actionable again.
    }
  };

  const makeLocalRecoveryReady = (): void => {
    setStatePreservingActiveField({
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
      ...(state.reauthOnly
        && state.interruptedTransition
        && !state.finalizePending
        && !state.finalizeRestarted
        ? { siblingTakeoverReady: true }
        : {}),
    });
  };

  const electRecoverySuccessor = async (): Promise<void> => {
    if (
      disposed
      || recoverySuccessorClaimInFlight
      || !state.siblingRecoveryOwnerElsewhere
    ) return;
    if (options.claimRecoverySuccessor === undefined) {
      // Direct/legacy integrations cannot atomically coordinate owner loss.
      // Preserve the established safe one-tab fallback instead of leaving the
      // only surviving form permanently blocked.
      makeLocalRecoveryReady();
      return;
    }

    recoverySuccessorClaimInFlight = true;
    let lease: { release(): void } | null = null;
    try {
      lease = await options.claimRecoverySuccessor();
    } catch {
      // A transient Web Locks failure is not permission to expose several
      // retries. Stay passive and make another bounded non-blocking attempt.
    } finally {
      recoverySuccessorClaimInFlight = false;
    }
    if (disposed || !state.siblingRecoveryOwnerElsewhere) {
      try {
        lease?.release();
      } catch {
        /* browser teardown releases the underlying lock */
      }
      return;
    }
    if (lease === null) {
      scheduleSiblingRecoveryOwnerFallback();
      return;
    }

    releaseRecoverySuccessorLease();
    recoverySuccessorLease = lease;
    pendingFocus = 'submit';
    setState({
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
      takeoverRecoveryOwner: true,
      takeoverRecoverySuccessor: true,
      ...(state.reauthOnly
        && state.interruptedTransition
        && !state.finalizePending
        && !state.finalizeRestarted
        ? { siblingTakeoverReady: true }
        : {}),
    });
    try {
      options.onRecoverySuccessorChosen?.();
    } catch {
      // The atomic lease is authoritative. Heartbeats and durable polling can
      // repair a transient sibling notification failure.
    }
    scheduleRecoveryOwnerHeartbeat();
  };

  const scheduleSiblingRecoveryOwnerFallback = (): void => {
    clearSiblingRecoveryOwnerTimer();
    const delay = options.siblingRecoveryOwnerDelayMs
      ?? DEFAULT_SIBLING_RECOVERY_OWNER_DELAY_MS;
    siblingRecoveryOwnerTimer = globalThis.setTimeout(() => {
      siblingRecoveryOwnerTimer = null;
      if (disposed || !state.siblingRecoveryOwnerElsewhere) return;
      void electRecoverySuccessor();
    }, Math.max(0, delay));
    (siblingRecoveryOwnerTimer as unknown as { unref?: () => void }).unref?.();
  };

  const clearRecoveryOwnerHeartbeatTimer = (): void => {
    if (recoveryOwnerHeartbeatTimer === null) return;
    globalThis.clearTimeout(recoveryOwnerHeartbeatTimer);
    recoveryOwnerHeartbeatTimer = null;
  };

  const emitRecoveryOwnerHeartbeat = (): void => {
    try {
      if (state.takeoverRecoverySuccessor) {
        options.onRecoverySuccessorChosen?.();
      } else {
        options.onTakeoverNeedsAttention?.();
      }
    } catch {
      // This tab's rendered failure remains authoritative. A later heartbeat
      // can repair a transient notification failure without exposing detail.
    }
  };

  const scheduleRecoveryOwnerHeartbeat = (): void => {
    clearRecoveryOwnerHeartbeatTimer();
    if (
      (state.takeoverRecoverySuccessor
        ? options.onRecoverySuccessorChosen === undefined
        : options.onTakeoverNeedsAttention === undefined)
      || options.recoveryOwnerHeartbeatMs === null
    ) return;
    const delay = options.recoveryOwnerHeartbeatMs
      ?? DEFAULT_RECOVERY_OWNER_HEARTBEAT_MS;
    recoveryOwnerHeartbeatTimer = globalThis.setTimeout(() => {
      recoveryOwnerHeartbeatTimer = null;
      if (disposed || !state.takeoverRecoveryOwner) return;
      emitRecoveryOwnerHeartbeat();
      scheduleRecoveryOwnerHeartbeat();
    }, Math.max(1, delay));
    (recoveryOwnerHeartbeatTimer as unknown as { unref?: () => void })
      .unref?.();
  };

  const scheduleSiblingTakeover = (): void => {
    if (!state.reauthOnly) return;
    clearSiblingTakeoverTimer();
    const delay = options.siblingTakeoverDelayMs
      ?? DEFAULT_SIBLING_TAKEOVER_DELAY_MS;
    if (options.siblingTakeoverDelayMs === null) {
      setStatePreservingActiveField({ siblingTakeoverReady: true });
      return;
    }
    siblingTakeoverTimer = globalThis.setTimeout(() => {
      siblingTakeoverTimer = null;
      if (
        disposed
        || !state.interruptedTransition
        || state.finalizePending
        || state.finalizeRestarted
      ) return;
      setStatePreservingActiveField({ siblingTakeoverReady: true });
    }, Math.max(0, delay));
    // Node-backed unit runners should not stay alive for a browser UX timer.
    (siblingTakeoverTimer as unknown as { unref?: () => void }).unref?.();
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
    if (isPairEditingDisabled(state)) return;
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
        if (
          state.replacementServerStage !== null
          && state.replacementServerStage !== 'details'
        ) return;
        const wasSameOriginResume = state.sameOriginResume;
        const replacementServerChanged =
          state.replacementServerStage === 'details'
          && value !== state.serverUrl;
        const correctingRejectedKey = isRecoveryKeyRejection(state);
        if (correctingRejectedKey) invalidateRecoveryDiagnostic();
        const malformedKeyError = isMalformedRecoveryKeyError(state)
          ? state.error
          : null;
        const patch: Partial<PairCodeInputState> = {
          serverUrl: value,
          ...(replacementServerChanged
            ? { pairingCode: '' }
            : {}),
          sameOriginResume: false,
          ...(wasSameOriginResume ? { pairingCode: '' } : {}),
          error: malformedKeyError,
          restoreNotice: null,
        };
        if (
          wasSameOriginResume
          || correctingRejectedKey
          || replacementServerChanged
        ) {
          setStatePreservingActiveField(patch);
          return;
        }
        state = { ...state, ...patch };
        if (malformedKeyError === null) clearStatusInPlace();
        syncSubmitDisabled();
        syncInsecureAddressHint();
        return;
      }
      if (kind === 'pairing-code') {
        if (
          state.replacementServerStage !== null
          && state.replacementServerStage !== 'details'
        ) return;
        const pairingCode = normalizePairingCode(value);
        if (pairingCode !== value) {
          const selectionStart = fieldEl.selectionStart;
          const selectionEnd = fieldEl.selectionEnd;
          fieldEl.value = pairingCode;
          if (
            typeof selectionStart === 'number'
            && typeof selectionEnd === 'number'
          ) {
            fieldEl.setSelectionRange?.(
              normalizePairingCode(value.slice(0, selectionStart)).length,
              normalizePairingCode(value.slice(0, selectionEnd)).length,
            );
          }
        }
        const recoveryKeyError = isRecoveryKeyCorrectionError(state)
          ? state.error
          : null;
        state = {
          ...state,
          pairingCode,
          error: recoveryKeyError,
          restoreNotice: null,
        };
        if (recoveryKeyError === null) clearStatusInPlace();
        // Generate mode gates submit on the pairing code (first-pair
        // always needs one), so re-sync the disabled state — otherwise
        // typing the code last leaves the button stuck disabled. A no-op
        // for enter mode, where the code doesn't affect the gate.
        syncSubmitDisabled();
        return;
      }
    }
    if (recoveryEl) {
      if (
        state.replacementServerStage === 'details'
        || state.replacementServerStage === 'review'
        || state.replacementServerStage === 'not_fresh'
        || (
          state.replacementServerStage === 'fresh_key'
          && state.generateStage !== 'challenging'
        )
      ) return;
      const raw = recoveryEl.value ?? '';
      const idx = parseInt(recoveryEl.dataset?.index ?? '-1', 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= 24) return;
      if (/\s/.test(raw)) {
        if (isRecoveryKeyRejection(state)) invalidateRecoveryDiagnostic();
        const tokens = raw.split(/\s+/).filter((w) => w.length > 0);
        const current = state.recoveryWords;
        const next = distributeTokens(current, tokens, idx);
        setStatePreservingActiveField({
          recoveryWords: next,
          error: null,
          restoreNotice: null,
        });
        return;
      }
      const words = [...state.recoveryWords];
      words[idx] = raw.trim().toLowerCase();
      if (isRecoveryKeyRejection(state)) {
        invalidateRecoveryDiagnostic();
        setStatePreservingActiveField({
          recoveryWords: words,
          error: null,
          restoreNotice: null,
        });
        return;
      }
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
    if (
      isPairEditingDisabled(state)
      || state.recoveryMode === mode
    ) return;
    if (state.reauthOnly) return;
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
    recoveryKeyRejectionCount = 0;
    invalidateRecoveryDiagnostic();
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
    if (isPairEditingDisabled(state)) return;
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
    if (
      isPairEditingDisabled(state)
      || state.recoveryMode !== 'generate'
    ) return;
    setState({
      generatedKey: generateImpl(),
      generateStage: 'writing',
      recoveryWords: toRecoveryWords(''),
      error: null,
    });
  };

  const ackGenerateWritten = (): void => {
    if (
      isPairEditingDisabled(state)
      || state.generateStage !== 'writing'
    ) return;
    setState({
      generateStage: 'challenging',
      recoveryWords: toRecoveryWords(''),
      error: null,
    });
  };

  const restartGenerate = (): void => {
    if (isPairEditingDisabled(state)) return;
    setState({
      generatedKey: null,
      generateStage: 'start',
      recoveryWords: toRecoveryWords(''),
      error: null,
    });
  };

  const restartAfterInterruptedFinalize = (): void => {
    if (
      state.submitting
      || state.siblingSuccessionInProgress
      || state.siblingRecoveryOwnerElsewhere
      || !state.finalizePending
    ) return;
    const recoveryKey = pendingPairResult?.recoveryKey
      ?? fromRecoveryWords(state.recoveryWords);
    // A one-time code may already have been consumed by the successful
    // server request. Discard it, retain the user's recovery key, and move to
    // the recovery-key path so a fresh request never silently replays it.
    pendingPairResult = null;
    pendingFocus = 'archiveKey';
    clearRecoveryOwnerHeartbeatTimer();
    releaseRecoverySuccessorLease();
    setState({
      pairingCode: '',
      recoveryMode: 'enter',
      recoveryWords: toRecoveryWords(recoveryKey),
      generatedKey: null,
      generateStage: 'start',
      finalizePending: false,
      interruptedTransition: true,
      siblingTakeoverReady: false,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: false,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: false,
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
      finalizeRestarted: true,
      error: null,
    });
  };

  const copyRecoveryDiagnostic = async (): Promise<void> => {
    if (
      disposed
      || recoveryKeyRejectionCount < 2
      || state.recoveryPausedFromReentry
      || (!state.recoveryPaused && !isRecoveryKeyRejection(state))
      || recoveryDiagnosticCopyInFlight
    ) return;
    const summary = buildRecoveryKeyRejectionDiagnostic(
      recoveryKeyRejectionCount,
      state.serverUrl,
      previouslyPairedServerUrl,
    );
    const revision = recoveryDiagnosticRevision;
    recoveryDiagnosticCopyState = 'idle';
    recoveryDiagnosticCopyInFlight = true;
    pendingFocus = 'recoveryDiagnosticStatus';
    render();

    let copyState: RecoveryDiagnosticCopyState;
    try {
      if (options.recoveryDiagnosticWriter !== undefined) {
        await options.recoveryDiagnosticWriter(summary);
      } else {
        const navigatorLike = doc?.defaultView?.navigator
          ?? (globalThis as { navigator?: Navigator }).navigator;
        const clipboard = navigatorLike?.clipboard;
        if (typeof clipboard?.writeText !== 'function') {
          throw new Error('recovery diagnostic clipboard unavailable');
        }
        await clipboard.writeText(summary);
      }
      copyState = 'copied';
    } catch {
      copyState = 'unavailable';
    }

    if (revision !== recoveryDiagnosticRevision) return;
    recoveryDiagnosticCopyInFlight = false;
    if (
      disposed
      || recoveryKeyRejectionCount < 2
      || state.recoveryPausedFromReentry
      || (!state.recoveryPaused && !isRecoveryKeyRejection(state))
      || buildRecoveryKeyRejectionDiagnostic(
        recoveryKeyRejectionCount,
        state.serverUrl,
        previouslyPairedServerUrl,
      ) !== summary
    ) return;
    recoveryDiagnosticCopyState = copyState;
    pendingFocus = copyState === 'unavailable'
      ? 'recoveryDiagnosticSummary'
      : 'recoveryDiagnosticCopy';
    render();
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
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION}"]`,
      )
    ) {
      void copyRecoveryDiagnostic();
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION}"]`,
      )
    ) {
      if (!state.recoveryPaused) return;
      invalidateRecoveryDiagnostic();
      pendingFocus = state.serverUrl.trim().length > 0
        ? 'archiveKey'
        : 'serverUrl';
      notifyRecoveryCheckpointChange('unresolved');
      setState({
        recoveryPaused: false,
        recoveryPausedFromReentry: false,
        recoveryResumeOutcome: 'key_found',
        replacementServerStage: null,
        replacementServerFreshStart: false,
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION}"]`,
      )
    ) {
      if (!state.recoveryPaused) return;
      invalidateRecoveryDiagnostic();
      pendingFocus = 'serverUrl';
      notifyRecoveryCheckpointChange('replacement_server');
      setState({
        serverUrl: '',
        pairingCode: '',
        recoveryPaused: false,
        recoveryPausedFromReentry: false,
        recoveryResumeOutcome: 'server_changed',
        replacementServerStage: 'details',
        replacementServerFreshStart: false,
        recoveryMode: 'enter',
        recoveryWords: toRecoveryWords(''),
        generatedKey: null,
        generateStage: 'start',
        sameOriginResume: false,
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_CONFIRM_REPLACEMENT_SERVER_ACTION}"]`,
      )
    ) {
      if (
        state.replacementServerStage !== 'review'
        || isPairEditingDisabled(state)
      ) return;
      state.recoveryWords.fill('');
      pendingFocus = 'generateRecoveryKey';
      notifyRecoveryCheckpointChange('replacement_server');
      setState({
        replacementServerStage: 'fresh_key',
        replacementServerFreshStart: true,
        recoveryMode: 'generate',
        recoveryWords: toRecoveryWords(''),
        generatedKey: null,
        generateStage: 'start',
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_EDIT_REPLACEMENT_SERVER_ACTION}"]`,
      )
    ) {
      if (
        state.replacementServerStage === null
        || state.submitting
        || state.finalizePending
      ) return;
      state.recoveryWords.fill('');
      pendingPairResult = null;
      pendingFocus = 'serverUrl';
      notifyRecoveryCheckpointChange('replacement_server');
      setState({
        pairingCode: '',
        recoveryWords: toRecoveryWords(''),
        replacementServerStage: 'details',
        replacementServerFreshStart: false,
        recoveryMode: 'enter',
        generatedKey: null,
        generateStage: 'start',
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION}"]`,
      )
    ) {
      if (
        (
          state.replacementServerStage !== 'review'
          && state.replacementServerStage !== 'not_fresh'
        )
        || isPairEditingDisabled(state)
      ) return;
      state.recoveryWords.fill('');
      pendingFocus = 'archiveKey';
      notifyRecoveryCheckpointChange('replacement_server');
      setState({
        recoveryWords: toRecoveryWords(''),
        replacementServerStage: 'existing_key',
        replacementServerFreshStart: false,
        recoveryMode: 'enter',
        generatedKey: null,
        generateStage: 'start',
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION}"]`,
      )
    ) {
      if (
        recoveryKeyRejectionCount < 2
        || !isRecoveryKeyRejection(state)
        || isPairEditingDisabled(state)
        || previouslyPairedServerUrl === null
      ) return;
      invalidateRecoveryDiagnostic();
      pendingFocus = 'serverUrl';
      setState({
        serverUrl: previouslyPairedServerUrl,
        pairingCode: '',
        sameOriginResume: false,
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION}"]`,
      )
    ) {
      if (!isRecoveryKeyRejection(state) || isPairEditingDisabled(state)) return;
      const wasSameOriginResume = state.sameOriginResume;
      pendingFocus = 'serverUrl';
      setState({
        sameOriginResume: false,
        ...(wasSameOriginResume ? { pairingCode: '' } : {}),
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION}"]`,
      )
    ) {
      if (!isRecoveryKeyRejection(state) || isPairEditingDisabled(state)) return;
      // This is the one correction action that deliberately discards the
      // rejected phrase. Mutate the old array first so this mount does not
      // retain a second live reference to sensitive recovery material.
      state.recoveryWords.fill('');
      invalidateRecoveryDiagnostic();
      pendingFocus = 'archiveKey';
      setState({
        recoveryWords: toRecoveryWords(''),
        error: null,
      });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION}"]`,
      )
    ) {
      if (!isRecoveryKeyRejection(state) || isPairEditingDisabled(state)) return;
      if (recoveryKeyRejectionCount >= 2) {
        // A confirmed dead end must not leave rejected secrets sitting in a
        // dormant form. Mutate the live array before replacing it, drop the
        // one-time code, and relinquish any recovery-owner coordination held
        // by this tab. The reviewed diagnostic contains origins only.
        state.recoveryWords.fill('');
        pendingPairResult = null;
        clearSiblingTakeoverTimer();
        clearSiblingSuccessionTimer();
        clearSiblingRecoveryOwnerTimer();
        clearRecoveryOwnerHeartbeatTimer();
        releaseRecoverySuccessorLease();
        invalidateRecoveryDiagnostic();
        pendingFocus = 'recoveryStop';
        // Arm the credential-free stop before rendering it. If this document's
        // DOM fails during the transition, the next load must still recover to
        // the safe checkpoint instead of a generic blank reconnect.
        notifyRecoveryCheckpointChange('safe_stop');
        setState({
          pairingCode: '',
          recoveryWords: toRecoveryWords(''),
          recoveryPaused: true,
          recoveryPausedFromReentry: false,
          recoveryResumeOutcome: null,
          replacementServerStage: null,
          replacementServerFreshStart: false,
          generatedKey: null,
          error: null,
          submitting: false,
          finalizePending: false,
          interruptedTransition: false,
          siblingTakeoverReady: false,
          siblingTakeoverOwnsAttempt: false,
          siblingSuccessionInProgress: false,
          takeoverRecoveryOwner: false,
          takeoverRecoverySuccessor: false,
          siblingRecoveryOwnerElsewhere: false,
          siblingRecoverySuccessorElsewhere: false,
          finalizeRestarted: false,
        });
        return;
      }
      const help = splashEl.querySelector?.(
        `[${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}]`,
      ) as HTMLDetailsElement | null;
      if (!help) return;
      help.open = true;
      try {
        (help.querySelector?.('summary') as HTMLElement | null)?.focus?.();
      } catch {
        /* best-effort focus in minimal/non-DOM test environments */
      }
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_CHANGE_SERVER_ACTION}"]`,
      )
    ) {
      if (
        state.submitting
        || state.finalizePending
        || state.siblingSuccessionInProgress
        || state.siblingRecoveryOwnerElsewhere
        || !state.sameOriginResume
      ) return;
      pendingFocus = 'serverUrl';
      setState({ sameOriginResume: false, pairingCode: '' });
      return;
    }
    if (
      target.closest?.(
        `[data-action="${PAIR_CODE_INPUT_RESTART_AFTER_INTERRUPTION_ACTION}"]`,
      )
    ) {
      restartAfterInterruptedFinalize();
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

  /** Toggle the insecure-address warning without re-rendering. Mirrors
   *  `syncSubmitDisabled`: the server-url field updates state in place to keep
   *  the caret, so anything derived from it has to be synced the same way or it
   *  reports the value from one keystroke ago. */
  const syncInsecureAddressHint = (): void => {
    const hint = splashEl.querySelector?.(
      `#${PAIR_CODE_INPUT_INSECURE_ADDRESS_ID}`,
    ) as HTMLElement | null;
    if (!hint) return;
    if (isCertainlyBlockedServerAddress(state.serverUrl, readPageProtocol())) {
      hint.removeAttribute?.('hidden');
    } else {
      hint.setAttribute?.('hidden', '');
    }
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

  const showInterruptedCredentialTransition = (): void => {
    if (disposed || state.recoveryPaused) return;
    if (state.interruptedTransition) return;
    clearSiblingSuccessionTimer();
    const generatedTakeover = state.recoveryMode === 'generate';
    const patch: Partial<PairCodeInputState> = {
      interruptedTransition: true,
      siblingTakeoverReady: false,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: false,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: false,
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
      finalizeRestarted: false,
      // Another tab accepted a server pairing response (or a partial write
      // proves it did), so any one-time code on this form may be consumed.
      pairingCode: '',
      error: null,
      ...(generatedTakeover
        ? {
            // A different tab's server response enrolled ITS generated key,
            // not the phrase minted in this tab. Ask for that existing key.
            recoveryMode: 'enter' as const,
            generatedKey: null,
            generateStage: 'start' as const,
            recoveryWords: toRecoveryWords(''),
          }
        : {}),
    };
    if (generatedTakeover) setState(patch);
    else setStatePreservingActiveField(patch);
    scheduleSiblingTakeover();
    if (generatedTakeover) {
      pendingFocus = 'archiveKey';
      applyPendingFocus();
    }
  };

  const showSiblingPairAccepted = (): void => {
    if (disposed || state.recoveryPaused) return;
    if (!state.interruptedTransition) {
      showInterruptedCredentialTransition();
      return;
    }
    if (state.siblingSuccessionInProgress) {
      // The successor progressed from owning the attempt to a server-accepted
      // response. Renew the same bounded wait so this tab does not re-offer
      // its retained retry while the other tab is still saving locally.
      scheduleSiblingSuccessionFallback();
      return;
    }
    if (
      state.takeoverRecoveryOwner
      || state.siblingRecoveryOwnerElsewhere
    ) {
      if (isRecoveryKeyRejection(state)) pendingFocus = 'submit';
      clearSiblingRecoveryOwnerTimer();
      clearRecoveryOwnerHeartbeatTimer();
      releaseRecoverySuccessorLease();
      setStatePreservingActiveField({
        takeoverRecoveryOwner: false,
        takeoverRecoverySuccessor: false,
        siblingRecoveryOwnerElsewhere: false,
        siblingRecoverySuccessorElsewhere: false,
        siblingTakeoverReady: false,
        siblingTakeoverOwnsAttempt: false,
        siblingSuccessionInProgress: true,
      });
      scheduleSiblingSuccessionFallback();
    }
  };

  const showSiblingTakeoverStarted = (): void => {
    // A tab already waiting for the lock is itself a contender. Let it keep
    // the honest queued state: if the announced owner fails, this tab may be
    // the next successor; if it succeeds, durable preflight retires this one.
    if (disposed || state.submitting || state.recoveryPaused) return;
    if (!state.interruptedTransition) {
      showInterruptedCredentialTransition();
      if (disposed) return;
    }
    clearSiblingTakeoverTimer();
    clearSiblingRecoveryOwnerTimer();
    clearRecoveryOwnerHeartbeatTimer();
    releaseRecoverySuccessorLease();
    if (isRecoveryKeyRejection(state)) pendingFocus = 'submit';
    setStatePreservingActiveField({
      siblingTakeoverReady: false,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: true,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: false,
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
    });
    scheduleSiblingSuccessionFallback();
  };

  const showSiblingTakeoverNeedsAttention = (): void => {
    // A contender already queued on the shared lock may be the next owner.
    // Keep that honest choosing state; its later start/failure signal will
    // supersede the owner that just failed.
    if (
      disposed
      || state.submitting
      || state.recoveryPaused
      || (state.takeoverRecoverySuccessor && recoverySuccessorLease !== null)
    ) return;
    if (state.siblingRecoveryOwnerElsewhere) {
      // Heartbeat renewal extends the lease without replacing the live region
      // or re-announcing the same instruction to assistive technology.
      scheduleSiblingRecoveryOwnerFallback();
      return;
    }
    if (!state.interruptedTransition) {
      showInterruptedCredentialTransition();
      if (disposed) return;
    }
    clearSiblingTakeoverTimer();
    clearSiblingSuccessionTimer();
    clearRecoveryOwnerHeartbeatTimer();
    releaseRecoverySuccessorLease();
    if (isRecoveryKeyRejection(state)) pendingFocus = 'submit';
    setStatePreservingActiveField({
      siblingTakeoverReady: false,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: false,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: false,
      siblingRecoveryOwnerElsewhere: true,
      siblingRecoverySuccessorElsewhere: false,
    });
    scheduleSiblingRecoveryOwnerFallback();
  };

  const showSiblingRecoverySuccessorChosen = (): void => {
    if (
      disposed
      || state.submitting
      || state.recoveryPaused
      || (state.takeoverRecoverySuccessor && recoverySuccessorLease !== null)
    ) return;
    if (
      state.siblingRecoveryOwnerElsewhere
      && state.siblingRecoverySuccessorElsewhere
    ) {
      // Renew the selected successor's lease without replaying its live-region
      // announcement or disturbing the field currently focused in this tab.
      scheduleSiblingRecoveryOwnerFallback();
      return;
    }
    if (!state.interruptedTransition) {
      showInterruptedCredentialTransition();
      if (disposed) return;
    }
    clearSiblingTakeoverTimer();
    clearSiblingSuccessionTimer();
    clearRecoveryOwnerHeartbeatTimer();
    releaseRecoverySuccessorLease();
    if (isRecoveryKeyRejection(state)) pendingFocus = 'submit';
    setStatePreservingActiveField({
      siblingTakeoverReady: false,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: false,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: false,
      siblingRecoveryOwnerElsewhere: true,
      siblingRecoverySuccessorElsewhere: true,
    });
    scheduleSiblingRecoveryOwnerFallback();
  };

  const disableSiblingTakeoverCoordination = (): void => {
    if (
      disposed
      || state.recoveryPaused
      || !state.siblingTakeoverCoordinationAvailable
    ) return;
    clearSiblingTakeoverTimer();
    clearSiblingSuccessionTimer();
    clearSiblingRecoveryOwnerTimer();
    clearRecoveryOwnerHeartbeatTimer();
    releaseRecoverySuccessorLease();
    setStatePreservingActiveField({
      siblingTakeoverCoordinationAvailable: false,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: false,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: false,
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
      ...(state.reauthOnly
        && state.interruptedTransition
        && !state.finalizePending
        && !state.finalizeRestarted
        ? { siblingTakeoverReady: true }
        : {}),
    });
  };

  const doSubmit = async (): Promise<void> => {
    if (disposed) return;
    if (isSubmitBlocked(state)) return;

    if (state.replacementServerStage === 'details') {
      // This is a local review boundary, not a network probe. The current
      // origin and presence of a fresh terminal code are shown without ever
      // rendering the code itself; `/auth/pair` remains untouched until the
      // person explicitly confirms the fresh-start consequence.
      pendingFocus = 'replacementReview';
      setState({
        // Pair against exactly the reviewed origin. Drop user-info, paths,
        // queries, and fragments before recovery material is ever created so
        // a visually identical review cannot later submit somewhere else.
        serverUrl: safeServerOrigin(state.serverUrl) ?? state.serverUrl.trim(),
        replacementServerStage: 'review',
        error: null,
      });
      return;
    }
    if (
      state.replacementServerStage === 'review'
      || state.replacementServerStage === 'not_fresh'
    ) return;

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
          code: normalizePairingCode(state.pairingCode),
          archiveKey: fromRecoveryWords(state.recoveryWords),
          file,
        });
      } catch (err) {
        if (disposed) return;
        pendingFocus = 'submit';
        setState({
          submitting: false,
          restoreNotice: `Could not start the restore: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    const finalizeRetry = pendingPairResult !== null;
    const readySiblingTakeover =
      state.reauthOnly
      && state.interruptedTransition
      && state.siblingTakeoverReady
      && !finalizeRetry;
    const recoverySuccessorAttempt =
      state.takeoverRecoverySuccessor
      && recoverySuccessorLease !== null;
    const submittingPatch: Partial<PairCodeInputState> = {
      submitting: true,
      siblingTakeoverOwnsAttempt: false,
      siblingSuccessionInProgress: false,
      takeoverRecoveryOwner: false,
      takeoverRecoverySuccessor: recoverySuccessorAttempt,
      siblingRecoveryOwnerElsewhere: false,
      siblingRecoverySuccessorElsewhere: false,
      error: null,
    };
    clearSiblingSuccessionTimer();
    clearSiblingRecoveryOwnerTimer();
    clearRecoveryOwnerHeartbeatTimer();
    // A simultaneous contender may wait on the exclusive browser lock for a
    // perceptible interval. Keep keyboard focus on the replacement primary
    // button while its label changes instead of dropping it onto the document.
    if (readySiblingTakeover) {
      setStatePreservingActiveField(submittingPatch);
    } else {
      setState(submittingPatch);
    }
    const setAttemptResultState = (
      patch: Partial<PairCodeInputState>,
      preserveActiveField = true,
    ): void => {
      if (readySiblingTakeover && preserveActiveField) {
        setStatePreservingActiveField(patch);
      } else {
        setState(patch);
      }
    };
    const coordinatedTakeoverAttempt =
      readySiblingTakeover
      && state.siblingTakeoverCoordinationAvailable;
    const coordinatedRecoveryAttempt =
      coordinatedTakeoverAttempt || recoverySuccessorAttempt;
    const notifyTakeoverNeedsAttention = (): void => {
      if (!coordinatedRecoveryAttempt) return;
      emitRecoveryOwnerHeartbeat();
      scheduleRecoveryOwnerHeartbeat();
    };

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
    try {
      await withPairFinalizeLock(options.lockProvider ?? null, async () => {
        if (disposed) return;
        // Pre-flight inside the lock so a winning tab's persistence is
        // visible to the loser's pre-flight read. Skipping when the
        // caller didn't wire one — the inner finalizePairCodeSuccess
        // still guards against the post-/auth/pair race; this only
        // protects the pre-/auth/pair window.
        if (options.preflightCheck) {
          let preflight: {
            alreadyPaired: boolean;
            interrupted?: boolean;
          };
          try {
            preflight = await options.preflightCheck();
          } catch (err) {
            if (disposed) return;
            if (finalizeRetry) pendingFocus = 'submit';
            setAttemptResultState({
              submitting: false,
              takeoverRecoveryOwner: coordinatedRecoveryAttempt,
              error: {
                copy: finalizeRetry
                  ? `Could not check this browser's saved access before finishing: ${err instanceof Error ? err.message : String(err)}. Try again; the successful pairing response is still held in this tab.`
                  : `Pre-pair check failed: ${err instanceof Error ? err.message : String(err)}`,
                code: finalizeRetry
                  ? 'pair_code_input_finalize_interrupted'
                  : 'pair_code_input_server_unknown_error',
              },
            });
            notifyTakeoverNeedsAttention();
            return;
          }
          if (disposed) return;
          if (
            preflight.interrupted === true
            && !finalizeRetry
            && !state.interruptedTransition
          ) {
            showInterruptedCredentialTransition();
            pendingFocus = 'archiveKey';
            setState({ submitting: false });
            return;
          }
          if (preflight.alreadyPaired) {
            // Two open tabs can receive the same reauth signal and queue on the
            // pair lock. If another tab repaired the shared browser store first,
            // this tab must re-bootstrap from that winning state instead of
            // asking for a reload: reload would discard the exact Chat draft
            // held only in this tab's recovery closure. Generic first-pair flows
            // keep the explicit already-paired error below.
            if ((state.reauthOnly || finalizeRetry) && options.onAfterPair) {
              pendingPairResult = null;
              pairSucceeded = true;
              return;
            }
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

        // A ready sibling takeover does not become the visible winner merely
        // because its button was pressed. Mark it only after this callback
        // owns the exclusive browser lock and durable preflight has confirmed
        // that no other tab already completed. Simultaneous contenders stay
        // on the honest "choosing one tab" state while queued, then adopt the
        // winner without posting their fresh code.
        if (
          readySiblingTakeover
          && state.siblingTakeoverCoordinationAvailable
        ) {
          setStatePreservingActiveField({ siblingTakeoverOwnsAttempt: true });
          try {
            options.onTakeoverStarted?.();
          } catch {
            // The lock and durable preflight are authoritative. A missing
            // cross-tab hint must not turn the chosen owner's safe attempt
            // into a failure; siblings still reconcile by focus/poll.
          }
        }

        let paired = pendingPairResult;
        if (paired === null) {
          // In generate mode the key to enroll is the freshly-minted phrase
          // (the gate guarantees the re-typed words match it); in enter mode
          // it's the typed words. A local-finalize retry skips this entire
          // block, including `/auth/pair`, and reuses the in-memory result.
          const recoveryKeyToSubmit =
            state.recoveryMode === 'generate'
              ? state.generatedKey ?? ''
              : fromRecoveryWords(state.recoveryWords);

          const result = await submitPairCodeInput({
            serverUrl: state.serverUrl,
            ...(state.pairingCode.trim().length > 0
              ? { code: normalizePairingCode(state.pairingCode) }
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
            const replacementServerAlreadyEnrolled =
              alreadyEnrolled
              && state.replacementServerStage === 'fresh_key';
            const guidedRecoveryRejection =
              result.error === 'recovery_key_invalid'
              && state.recoveryMode === 'enter';
            const malformedRecoveryKey =
              result.error === 'pair_code_input_invalid_recovery_key'
              && state.recoveryMode === 'enter';
            if (guidedRecoveryRejection) {
              invalidateRecoveryDiagnostic();
              recoveryKeyRejectionCount += 1;
              pendingFocus = 'recoveryCorrection';
            }
            else if (replacementServerAlreadyEnrolled) {
              pendingFocus = 'replacementReview';
            }
            else if (malformedRecoveryKey) pendingFocus = 'archiveKey';
            setAttemptResultState({
              submitting: false,
              siblingTakeoverOwnsAttempt: false,
              takeoverRecoveryOwner: coordinatedRecoveryAttempt,
              error: {
                copy: replacementServerAlreadyEnrolled
                  ? PAIR_CODE_INPUT_REPLACEMENT_ALREADY_ENROLLED_COPY
                  : alreadyEnrolled
                    ? PAIR_CODE_INPUT_GENERATE_ALREADY_ENROLLED_COPY
                  : PAIR_CODE_INPUT_ERROR_COPY[result.error],
                code: result.error,
                // Only ever set on the refused path (the pure submit attaches
                // it there and nowhere else), so tailored copy can never end
                // up quoting a raw server string underneath itself.
                ...(result.serverSaid ? { serverSaid: result.serverSaid } : {}),
                ...(result.serverCode ? { serverCode: result.serverCode } : {}),
              },
              ...(alreadyEnrolled
                ? {
                    recoveryMode: 'enter' as const,
                    ...(replacementServerAlreadyEnrolled
                      ? {
                          replacementServerStage: 'not_fresh' as const,
                          replacementServerFreshStart: false,
                        }
                      : {}),
                    generatedKey: null,
                    generateStage: 'start' as const,
                    recoveryWords: toRecoveryWords(''),
                  }
                : {}),
            }, !guidedRecoveryRejection && !malformedRecoveryKey);
            notifyTakeoverNeedsAttention();
            return;
          }
          paired = {
            serverUrl: state.serverUrl,
            token: result.token,
            ...(result.token_id !== undefined ? { token_id: result.token_id } : {}),
            ...(result.passport !== undefined ? { passport: result.passport } : {}),
            ...(result.serverId !== undefined ? { serverId: result.serverId } : {}),
            recoveryKey: recoveryKeyToSubmit,
            ...(state.replacementServerFreshStart
              ? { recoveryContext: 'fresh_replacement' as const }
              : {}),
          };
          // Set before invoking the local finalizer: a throw at any point after
          // the server success must leave the exact response available for a
          // local-only retry. It is cleared on finalize, restart, or disposal.
          pendingPairResult = paired;
          if (state.replacementServerStage !== null) {
            // The server has accepted and consumed the reviewed one-time code.
            // Keep it out of any local-save error surface that may render next;
            // the held response contains everything finalization needs.
            state = { ...state, pairingCode: '' };
          }
          try {
            options.onPairAccepted?.();
          } catch {
            // The server response is already authoritative. URL cleanup and
            // sibling hints are best-effort and cannot convert it to failure.
          }
        }
        try {
          await options.onPaired(paired);
          pendingPairResult = null;
          pairSucceeded = true;
        } catch (err) {
          if (disposed) return;
          pendingFocus = 'submit';
          setState({
            submitting: false,
            finalizePending: true,
            interruptedTransition: true,
            siblingTakeoverOwnsAttempt: false,
            takeoverRecoveryOwner: coordinatedRecoveryAttempt,
            finalizeRestarted: false,
            error: {
              copy: interruptedFinalizeCopy(err),
              code: 'pair_code_input_finalize_interrupted',
            },
          });
          notifyTakeoverNeedsAttention();
        }
      });
    } catch (err) {
      if (disposed) return;
      pendingFocus = 'submit';
      setAttemptResultState({
        submitting: false,
        siblingTakeoverOwnsAttempt: false,
        takeoverRecoveryOwner: coordinatedRecoveryAttempt,
        error: {
          copy: finalizeRetry
            ? `Could not resume the browser save: ${err instanceof Error ? err.message : String(err)}. Try again; Recued still will not send another pairing request.`
            : `Could not coordinate pairing in this browser: ${err instanceof Error ? err.message : String(err)}. Try again.`,
          code: finalizeRetry
            ? 'pair_code_input_finalize_interrupted'
            : 'pair_code_input_server_unknown_error',
        },
      });
      notifyTakeoverNeedsAttention();
      return;
    }

    // Outside the lock — queued tabs can now preflight against the
    // freshly-written webclient_token. The post-pair UI teardown +
    // recursive bootstrap restart belong here. Skipped on pair failure
    // (onPaired threw inside the lock, error rendered above).
    if (pairSucceeded) {
      // Durable credentials, not a later UI restart, end recovery ownership.
      // Release here so a missing/throwing `onAfterPair` cannot strand the
      // successor Web Lock and block future recovery tabs for this origin.
      clearRecoveryOwnerHeartbeatTimer();
      releaseRecoverySuccessorLease();
    }
    if (pairSucceeded && options.onAfterPair && !disposed) {
      try {
        await options.onAfterPair();
      } catch (err) {
        if (disposed) return;
        setAttemptResultState({
          submitting: false,
          siblingTakeoverOwnsAttempt: false,
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
      // Best-effort memory hygiene for a form retired by sibling completion.
      // JavaScript strings cannot be guaranteed-zeroized, but mutating the
      // live word array and dropping every sensitive reference prevents this
      // long-lived mount closure from retaining typed/generated recovery
      // material, a pairing code, a held bearer response, or a restore file.
      state.recoveryWords.fill('');
      invalidateRecoveryDiagnostic();
      state = {
        ...state,
        pairingCode: '',
        recoveryWords: toRecoveryWords(''),
        recoveryPaused: false,
        recoveryPausedFromReentry: false,
        recoveryResumeOutcome: null,
        replacementServerStage: null,
        replacementServerFreshStart: false,
        generatedKey: null,
        restoreFile: null,
        restoreFileName: '',
        restoreNotice: null,
        error: null,
        submitting: false,
        finalizePending: false,
        interruptedTransition: false,
        siblingTakeoverReady: false,
        siblingTakeoverOwnsAttempt: false,
        siblingSuccessionInProgress: false,
        takeoverRecoveryOwner: false,
        takeoverRecoverySuccessor: false,
        siblingRecoveryOwnerElsewhere: false,
        siblingRecoverySuccessorElsewhere: false,
        finalizeRestarted: false,
      };
      pendingPairResult = null;
      pendingFocus = null;
      clearSiblingTakeoverTimer();
      clearSiblingSuccessionTimer();
      clearSiblingRecoveryOwnerTimer();
      clearRecoveryOwnerHeartbeatTimer();
      releaseRecoverySuccessorLease();
      splashEl.removeEventListener('input', onInput);
      splashEl.removeEventListener('change', onChange);
      splashEl.removeEventListener('click', onClick);
      splashEl.removeEventListener('submit', onSubmit);
      splashEl.innerHTML = '';
    },
    submit: doSubmit,
    setFieldValue: (field, value) => {
      if (disposed || isPairEditingDisabled(state)) return;
      if (field === 'serverUrl') {
        if (
          state.replacementServerStage !== null
          && state.replacementServerStage !== 'details'
        ) return;
        const wasSameOriginResume = state.sameOriginResume;
        if (isRecoveryKeyRejection(state)) invalidateRecoveryDiagnostic();
        state = {
          ...state,
          serverUrl: value,
          ...(state.replacementServerStage === 'details'
            && value !== state.serverUrl
            ? { pairingCode: '' }
            : {}),
          sameOriginResume: false,
          ...(wasSameOriginResume ? { pairingCode: '' } : {}),
          error: isMalformedRecoveryKeyError(state) ? state.error : null,
        };
      }
      else if (field === 'pairingCode') {
        if (
          state.replacementServerStage !== null
          && state.replacementServerStage !== 'details'
        ) return;
        state = {
          ...state,
          pairingCode: normalizePairingCode(value),
          error: isRecoveryKeyCorrectionError(state) ? state.error : null,
        };
      } else {
        if (
          state.replacementServerStage === 'details'
          || state.replacementServerStage === 'review'
          || state.replacementServerStage === 'not_fresh'
          || (
            state.replacementServerStage === 'fresh_key'
            && state.generateStage !== 'challenging'
          )
        ) return;
        if (isRecoveryKeyRejection(state)) invalidateRecoveryDiagnostic();
        state = { ...state, recoveryWords: toRecoveryWords(value), error: null };
      }
      render();
    },
    showInterruptedCredentialTransition,
    showSiblingPairAccepted,
    showSiblingTakeoverStarted,
    showSiblingTakeoverNeedsAttention,
    showSiblingRecoverySuccessorChosen,
    disableSiblingTakeoverCoordination,
  };
};

// ════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════

const isSubmitBlocked = (s: PairCodeInputState): boolean => {
  return submitBlockedReason(s) !== null;
};

const isPairEditingDisabled = (s: PairCodeInputState): boolean =>
  s.submitting
  || s.finalizePending
  || s.siblingSuccessionInProgress
  || s.siblingRecoveryOwnerElsewhere
  || s.recoveryPaused;

const isRecoveryKeyRejection = (s: PairCodeInputState): boolean =>
  s.recoveryMode === 'enter'
  && s.error?.code === 'recovery_key_invalid'
  // Generate mode uses the same server code to mean "this realm is already
  // enrolled", then intentionally clears its newly-created phrase while it
  // switches to enter mode. Do not mislabel that blank landing as a rejected
  // entered key; the guided correction loop applies only while the submitted
  // phrase is still present.
  && s.recoveryWords.every((word) => word.length > 0);

const isMalformedRecoveryKeyError = (s: PairCodeInputState): boolean =>
  s.recoveryMode === 'enter'
  && s.error?.code === 'pair_code_input_invalid_recovery_key';

const isRecoveryKeyCorrectionError = (s: PairCodeInputState): boolean =>
  isRecoveryKeyRejection(s) || isMalformedRecoveryKeyError(s);

const submitBlockedReason = (s: PairCodeInputState): string | null => {
  if (s.recoveryPaused) {
    return 'Recovery is paused. Return with the original recovery key or review the server address before trying again.';
  }
  if (s.replacementServerStage === 'details') {
    if (s.serverUrl.trim().length === 0) {
      return 'Enter the current server URL to continue.';
    }
    if (safeServerOrigin(s.serverUrl) === null) {
      return 'Enter a full http:// or https:// server URL from the current server.';
    }
    if (s.pairingCode.trim().length === 0) {
      return 'Enter a fresh pairing code from the current server terminal.';
    }
    return null;
  }
  if (s.replacementServerStage === 'review') {
    return 'Confirm the reviewed current server or change its details.';
  }
  if (s.replacementServerStage === 'not_fresh') {
    return 'Confirm that you have this current server’s existing recovery key, or review a different server.';
  }
  if (s.siblingRecoveryOwnerElsewhere) {
    if (!s.siblingTakeoverCoordinationAvailable) {
      return 'Continue in the tab showing the reconnect error. If it stops, use only one remaining reconnect tab.';
    }
    return s.siblingRecoverySuccessorElsewhere
      ? 'Recued chose another open tab to continue recovery. This tab will stay paused unless that successor stops responding.'
      : 'Continue in the tab showing the reconnect error. Recued will choose one safe successor if that tab stops responding.';
  }
  if (s.siblingSuccessionInProgress) {
    return 'Another tab is reconnecting now. This tab will restore its retry if that attempt stops.';
  }
  if (s.submitting) {
    if (s.finalizePending) return 'Browser access is being saved.';
    if (
      s.reauthOnly
      && s.interruptedTransition
      && s.siblingTakeoverReady
      && !s.finalizeRestarted
    ) {
      return !s.siblingTakeoverCoordinationAvailable
        ? 'This tab is checking saved access and reconnecting. Keep other reconnect forms idle.'
        : s.siblingTakeoverOwnsAttempt
        ? 'This tab is reconnecting and saving browser access.'
        : 'Recued is choosing one reconnecting tab and checking shared browser access.';
    }
    return s.reauthOnly
      ? 'Reconnection is in progress.'
      : 'Pairing is in progress.';
  }
  // The successful server response already contains everything the local
  // finalizer needs. Do not gate its retry on editable form fields.
  if (s.finalizePending) return null;
  if (
    s.reauthOnly
    && s.interruptedTransition
    && !s.siblingTakeoverReady
    && !s.finalizeRestarted
  ) {
    return 'Waiting for the other tab. Recued will offer a safe takeover if it does not finish.';
  }
  if (isRecoveryKeyRejection(s)) {
    return 'Review the server address or re-enter the recovery key before retrying.';
  }
  if (isMalformedRecoveryKeyError(s)) {
    return 'Correct the recovery key before retrying.';
  }
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
      return 'All 24 words are present, but they do not form a valid recovery key. Check for a misspelled, missing, or duplicated word.';
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

const renderForm = (
  state: PairCodeInputState,
  reauthRecovery: MountPairCodeInputHostOptions['reauthRecovery'] | undefined,
  context: PairCodeInputRenderContext,
): string => {
  const disabledReason = submitBlockedReason(state);
  const disabled = disabledReason !== null;
  const editingDisabled = isPairEditingDisabled(state);
  const isRestore = state.recoveryMode === 'restore';
  const siblingTakeover =
    state.reauthOnly
    && state.interruptedTransition
    && !state.finalizePending
    && !state.finalizeRestarted;
  const siblingSuccession = state.siblingSuccessionInProgress;
  const recoveryOwnerHere = state.takeoverRecoveryOwner;
  const recoverySuccessorHere = state.takeoverRecoverySuccessor;
  const recoveryOwnerElsewhere = state.siblingRecoveryOwnerElsewhere;
  const recoverySuccessorElsewhere =
    state.siblingRecoverySuccessorElsewhere;
  const showRecoveryCorrection =
    isRecoveryKeyRejection(state)
    && !siblingSuccession
    && !recoveryOwnerElsewhere;
  const showRepeatedRecoveryTriage =
    showRecoveryCorrection
    && context.recoveryKeyRejectionCount >= 2;
  const safeStopReentry =
    state.recoveryPaused && state.recoveryPausedFromReentry;
  const replacementServerDetails =
    state.replacementServerStage === 'details';
  const replacementServerReviewing =
    state.replacementServerStage === 'review'
    || state.replacementServerStage === 'not_fresh';
  const replacementRecoveryReady =
    state.replacementServerStage === 'fresh_key'
    || state.replacementServerStage === 'existing_key';
  const replacementFreshKey =
    state.replacementServerStage === 'fresh_key';
  const replacementCodeAccepted =
    replacementRecoveryReady && state.pairingCode.trim().length === 0;
  // Keep the clicked primary in the tab order during potentially-perceptible
  // cross-tab lock contention. `aria-disabled` communicates the blocked state
  // while delegated submit guards still make repeat activation a no-op.
  const focusableTakeoverProgress =
    siblingSuccession
    || recoveryOwnerElsewhere
    || (siblingTakeover
      && state.siblingTakeoverReady
      && state.submitting);
  const coordinatedSiblingTakeover =
    siblingTakeover
    && state.siblingTakeoverCoordinationAvailable;
  let submitLabel: string;
  if (recoveryOwnerElsewhere) {
    submitLabel = 'Waiting for recovery tab…';
  } else if (siblingSuccession) {
    submitLabel = 'Continuing in another tab…';
  } else if (state.finalizePending) {
    submitLabel = state.submitting
      ? 'Saving access…'
      : 'Finish saving access';
  } else if (state.replacementServerStage === 'details') {
    submitLabel = 'Review current server';
  } else if (state.replacementServerStage === 'fresh_key') {
    submitLabel = state.submitting
      ? 'Verifying current server…'
      : 'Pair with this fresh server';
  } else if (state.replacementServerStage === 'existing_key') {
    submitLabel = state.submitting
      ? 'Verifying current server…'
      : 'Verify and pair current server';
  } else if (isRestore) {
    submitLabel = state.submitting
      ? 'Starting restore…'
      : 'Restore this backup';
  } else if (state.submitting) {
    submitLabel = siblingTakeover && state.siblingTakeoverReady
      ? !coordinatedSiblingTakeover
        ? 'Reconnecting from this tab…'
        : state.siblingTakeoverOwnsAttempt
        ? 'Reconnecting from this tab…'
        : 'Choosing one tab…'
      : state.reauthOnly
        ? 'Reconnecting…'
        : 'Pairing…';
  } else if (recoveryOwnerHere) {
    submitLabel = recoverySuccessorHere
      ? 'Continue recovery here'
      : 'Retry in this tab';
  } else if (siblingTakeover) {
    submitLabel = state.siblingTakeoverReady
      ? 'Reconnect in this tab'
      : 'Waiting for other tab…';
  } else {
    submitLabel = state.reauthOnly
      ? 'Reconnect this browser'
      : 'Pair this device';
  }
  // The status slot keeps a stable id across modes so the focus/sync helpers
  // (and tests) find it. A restore bounce surfaces the orchestrator's copy via
  // `restoreNotice` (styled like an error, but carrying no `data-error` code —
  // it isn't one of the pure-submit error codes).
  // D-212 tail #6 — the server's own words, quoted UNDER Recued's, with an
  // explicit attribution label. Its own element (`data-server-said`) so a
  // reader — and a test — can tell whose sentence is whose; at the pairing
  // screen the host is unauthenticated, so an unattributed merge would let
  // it put instructions in Recued's mouth. `e()` escapes, as everywhere in
  // this template.
  const serverSaidBlock =
    state.error?.serverSaid
      ? `<p class="pair-code-input-server-said" data-server-said><span class="pair-code-input-server-said-label">${e(PAIR_SERVER_SAID_LABEL)}</span> <q>${e(state.error.serverSaid)}</q></p>`
      : '';
  const rawServerCode = codeShaped(state.error?.serverCode);
  const serverCodeAttr = rawServerCode
    ? ` ${PAIR_CODE_INPUT_SERVER_CODE_ATTR}="${e(rawServerCode)}"`
    : '';
  const statusBlock = siblingSuccession || recoveryOwnerElsewhere
    ? `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-status"></p>`
    : state.error
    ? `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-error" data-error="${e(state.error.code)}"${serverCodeAttr}>${e(state.error.copy)}</p>${serverSaidBlock}`
    : isRestore && state.restoreNotice
      ? `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-error" data-restore-notice>${e(state.restoreNotice)}</p>`
      : `<p id="${e(PAIR_CODE_INPUT_STATUS_ID)}" role="status" class="pair-code-input-status"></p>`;
  const currentServerOrigin = safeServerOrigin(state.serverUrl);
  const previouslyPairedServerOrigin =
    context.previouslyPairedServerUrl === null
      ? null
      : safeServerOrigin(context.previouslyPairedServerUrl);
  const exactSavedAddressDiffers =
    context.previouslyPairedServerUrl !== null
    && normalizeServerUrl(context.previouslyPairedServerUrl)
      !== normalizeServerUrl(state.serverUrl);
  const repeatedIdentityCopy = previouslyPairedServerOrigin === null
    ? 'This recovery form has no previously paired server address it can safely compare. Confirm the intended address on the computer running Recued.'
    : currentServerOrigin === previouslyPairedServerOrigin
      ? exactSavedAddressDiffers
        ? `The scheme, hostname, and port match the server this browser used before recovery: <code>${e(previouslyPairedServerOrigin)}</code>. The full address is different, so restoring the previously paired address can rule out a path or spelling difference.`
        : `This address matches the scheme, hostname, and port this browser used before recovery: <code>${e(previouslyPairedServerOrigin)}</code>. If the server was replaced or reset at that address, its original saved key may no longer match.`
      : `This form is trying <code>${e(currentServerOrigin ?? 'an unrecognized address')}</code>, but this browser previously used <code>${e(previouslyPairedServerOrigin)}</code>. The scheme, hostname, or port is different.`;
  const showRecoveryDiagnostic =
    showRepeatedRecoveryTriage
    || (state.recoveryPaused && !state.recoveryPausedFromReentry);
  const recoveryDiagnostic = showRecoveryDiagnostic
    ? buildRecoveryKeyRejectionDiagnostic(
        context.recoveryKeyRejectionCount,
        state.serverUrl,
        context.previouslyPairedServerUrl,
      )
    : '';
  const recoveryDiagnosticStatus = context.recoveryDiagnosticCopyInFlight
    ? 'Copying the reviewed summary…'
    : context.recoveryDiagnosticCopyState === 'copied'
      ? state.recoveryPaused
        ? 'Safe owner handoff copied. Nothing was sent automatically.'
        : 'Safe diagnostic copied. Nothing was sent automatically.'
      : context.recoveryDiagnosticCopyState === 'unavailable'
        ? 'Copy is unavailable here. The safe summary is focused so you can select and copy it manually.'
        : '';
  const recoveryDiagnosticCopyLabel = context.recoveryDiagnosticCopyInFlight
    ? 'Copying…'
    : context.recoveryDiagnosticCopyState === 'copied'
      ? state.recoveryPaused
        ? 'Copy owner handoff again'
        : 'Copy diagnostic again'
      : state.recoveryPaused
        ? 'Copy safe owner handoff'
        : 'Copy safe diagnostic';
  const recoveryDiagnosticPanel = !showRecoveryDiagnostic
    ? ''
    : `<details class="pair-code-input-recovery-diagnostic" ${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_ATTR} aria-busy="${context.recoveryDiagnosticCopyInFlight}"${state.recoveryPaused || context.recoveryDiagnosticCopyInFlight || context.recoveryDiagnosticCopyState !== 'idle' ? ' open' : ''}>
        <summary>${state.recoveryPaused ? 'Safe details for the server owner' : 'Details to share with the server owner'}</summary>
        <div class="pair-code-input-recovery-diagnostic-body">
          <p id="${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_PRIVACY_ID}">Nothing is sent automatically. Review before sharing. This includes only server origins, this tab’s attempt count, the fixed response code, and the requested owner check; it leaves out the recovery key, pairing code, page, Chat draft, credentials, and raw server text.</p>
          <pre ${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_SUMMARY_ATTR} tabindex="0" aria-label="Privacy-safe recovery diagnostic summary">${e(recoveryDiagnostic)}</pre>
          <div class="pair-code-input-recovery-correction-actions">
            <button type="button" data-action="${PAIR_CODE_INPUT_COPY_RECOVERY_DIAGNOSTIC_ACTION}" aria-describedby="${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_PRIVACY_ID}" ${context.recoveryDiagnosticCopyInFlight ? 'disabled' : ''}>${recoveryDiagnosticCopyLabel}</button>
          </div>
          <p class="pair-code-input-recovery-diagnostic-status${context.recoveryDiagnosticCopyState === 'unavailable' ? ' is-error' : ''}" ${PAIR_CODE_INPUT_RECOVERY_DIAGNOSTIC_STATUS_ATTR} role="status" aria-live="polite" tabindex="-1">${recoveryDiagnosticStatus}</p>
        </div>
      </details>`;
  const recoveryCorrection = !showRecoveryCorrection
    ? ''
    : showRepeatedRecoveryTriage
      ? `<section id="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ID}" class="pair-code-input-recovery-correction is-triage" ${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR} ${PAIR_CODE_INPUT_RECOVERY_TRIAGE_ATTR} role="region" tabindex="-1" aria-labelledby="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_TITLE_ID}" aria-describedby="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_CONTEXT_ID} ${PAIR_CODE_INPUT_RECOVERY_TRIAGE_IDENTITY_ID}">
          <h3 id="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_TITLE_ID}">Wrong server or wrong saved key?</h3>
          <p id="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_CONTEXT_ID}">Recued has now received ${context.recoveryKeyRejectionCount} rejections for format-valid 24-word entries in this tab. The latest response came from <code>${e(currentServerOrigin ?? state.serverUrl.trim())}</code>. It cannot tell which side is wrong.</p>
          <p id="${PAIR_CODE_INPUT_RECOVERY_TRIAGE_IDENTITY_ID}" class="pair-code-input-recovery-triage-identity">${repeatedIdentityCopy}</p>
          <div class="pair-code-input-recovery-triage-paths">
            <section class="pair-code-input-recovery-triage-path" aria-labelledby="${PAIR_CODE_INPUT_RECOVERY_TRIAGE_SERVER_TITLE_ID}">
              <h4 id="${PAIR_CODE_INPUT_RECOVERY_TRIAGE_SERVER_TITLE_ID}">Check the server</h4>
              <p>On the computer running the intended server, run <code>recued pair</code>. Compare the full scheme, hostname, and port. If someone else manages it, ask them to confirm only that address — never send them your recovery key.${exactSavedAddressDiffers ? ' Using the previously paired address keeps the 24 words here and clears the pairing code because codes belong to one server.' : ''}</p>
              <div class="pair-code-input-recovery-correction-actions">
                <button type="button" data-action="${PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION}">Review server address</button>
                ${exactSavedAddressDiffers
                  ? `<button type="button" data-action="${PAIR_CODE_INPUT_USE_SAVED_SERVER_ACTION}">Use previously paired address</button>`
                  : ''}
              </div>
            </section>
            <section class="pair-code-input-recovery-triage-path" aria-labelledby="${PAIR_CODE_INPUT_RECOVERY_TRIAGE_KEY_TITLE_ID}">
              <h4 id="${PAIR_CODE_INPUT_RECOVERY_TRIAGE_KEY_TITLE_ID}">Check the saved key</h4>
              <p>Use the original 24 words saved when that server was first set up. A key from another server cannot work here, and a fresh pairing code does not replace it.</p>
              <div class="pair-code-input-recovery-correction-actions">
                <button type="button" data-action="${PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION}">Paste recovery key again</button>
                <button type="button" data-action="${PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION}">I confirmed the server — I can’t find the key</button>
              </div>
            </section>
          </div>
          ${recoveryDiagnosticPanel}
        </section>`
      : `<section id="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ID}" class="pair-code-input-recovery-correction" ${PAIR_CODE_INPUT_RECOVERY_CORRECTION_ATTR} role="group" tabindex="-1" aria-labelledby="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_TITLE_ID}" aria-describedby="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_CONTEXT_ID}">
          <strong id="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_TITLE_ID}">Check the server and recovery key</strong>
          <p id="${PAIR_CODE_INPUT_RECOVERY_CORRECTION_CONTEXT_ID}">The 24 words passed Recued’s format check. The address you entered, <code>${e(state.serverUrl.trim())}</code>, did not accept this key. A fresh pairing code cannot make a different recovery key match.</p>
          <ol>
            <li>Confirm this is the same server whose recovery key you saved.</li>
            <li>Paste all 24 words again from that saved copy and check their order.</li>
          </ol>
          <div class="pair-code-input-recovery-correction-actions">
            <button type="button" data-action="${PAIR_CODE_INPUT_REVIEW_REJECTED_SERVER_ACTION}">Review server address</button>
            <button type="button" data-action="${PAIR_CODE_INPUT_REENTER_REJECTED_KEY_ACTION}">Paste recovery key again</button>
            <button type="button" data-action="${PAIR_CODE_INPUT_FIND_REJECTED_KEY_ACTION}">I can’t find the key</button>
          </div>
        </section>`;

  const pausedWorkCopy = reauthRecovery === undefined
    ? 'Keep this tab open if you plan to return with the original key.'
    : reauthRecovery.chatDraftPreserved
      ? 'Keep this tab open. Your exact page and unsent Chat draft are still held here.'
      : 'Keep this tab open. Your exact page is still held here.';
  const recoveryStop = !state.recoveryPaused
    ? ''
    : safeStopReentry
      ? `<section id="${PAIR_CODE_INPUT_RECOVERY_STOP_ID}" class="pair-code-input-recovery-stop" ${PAIR_CODE_INPUT_RECOVERY_STOP_ATTR} ${PAIR_CODE_INPUT_RECOVERY_STOP_REENTRY_ATTR} role="region" tabindex="-1" aria-labelledby="${PAIR_CODE_INPUT_RECOVERY_STOP_TITLE_ID}" aria-describedby="${PAIR_CODE_INPUT_RECOVERY_STOP_CONTEXT_ID}">
          <h3 id="${PAIR_CODE_INPUT_RECOVERY_STOP_TITLE_ID}">What did the server owner confirm?</h3>
          <p id="${PAIR_CODE_INPUT_RECOVERY_STOP_CONTEXT_ID}">Recovery is still paused. No pairing request is running, and nothing will be sent until you choose a confirmed outcome.</p>
          <div class="pair-code-input-recovery-stop-state">
            <strong>No recovery material was restored</strong>
            <p>This return kept only the safe-stop state and the exact page selected in the address bar. It did not carry over a server address, pairing code, recovery key, rejection count, or diagnostic.</p>
            <p>Leaving this page or reloading ended any in-memory Chat draft. Recued did not store that draft or any pairing material to recreate this screen.</p>
          </div>
          <h4>Continue from the owner’s answer</h4>
          <ol>
            <li>If the original 24-word key was found, enter the current server address and that key yourself in this browser.</li>
            <li>If the server was replaced or reset, start with its current address and use only recovery material that belongs to that current server.</li>
            <li>If neither is true, leave recovery paused and return to the server owner. Do not guess or generate a replacement key for the old server.</li>
          </ol>
          <p class="pair-code-input-recovery-stop-warning"><strong>This screen cannot infer the owner’s answer.</strong> Choose only the outcome they confirmed; otherwise leave this tab paused.</p>
          <div class="pair-code-input-recovery-correction-actions pair-code-input-recovery-stop-actions">
            <button type="button" data-action="${PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION}">I found the original key</button>
            <button type="button" data-action="${PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION}">The server changed or was reset</button>
          </div>
        </section>`
      : `<section id="${PAIR_CODE_INPUT_RECOVERY_STOP_ID}" class="pair-code-input-recovery-stop" ${PAIR_CODE_INPUT_RECOVERY_STOP_ATTR} role="region" tabindex="-1" aria-labelledby="${PAIR_CODE_INPUT_RECOVERY_STOP_TITLE_ID}" aria-describedby="${PAIR_CODE_INPUT_RECOVERY_STOP_CONTEXT_ID}">
          <h3 id="${PAIR_CODE_INPUT_RECOVERY_STOP_TITLE_ID}">Ask the person who manages this server</h3>
          <p id="${PAIR_CODE_INPUT_RECOVERY_STOP_CONTEXT_ID}">Recovery is paused. No pairing request is running, and this tab will not send another one unless you explicitly resume.</p>
          <div class="pair-code-input-recovery-stop-state">
            <strong>Confirmed server origin</strong>
            <code>${e(currentServerOrigin ?? 'Origin unavailable — review the address locally')}</code>
            <p>This shareable origin omits any path or sign-in details. The rejected recovery words and pairing code were cleared from this form. Work stored on the server was not changed.</p>
            <p>${e(pausedWorkCopy)}</p>
          </div>
          <h4>What the server owner can safely check</h4>
          <ol>
            <li>Confirm this scheme, hostname, and port, and whether the server was replaced or reset.</li>
            <li>Help locate the original 24-word recovery key saved when this server was set up. The person who has it should enter it only in this browser, never include it in the handoff.</li>
            <li>If that original key is unavailable, keep this recovery stopped. Decide how to proceed with the server owner outside this form.</li>
          </ol>
          <p class="pair-code-input-recovery-stop-warning"><strong>Do not generate a replacement key, guess words, or keep retrying.</strong> A server owner can confirm the address and whether the server was reset or replaced, but Recued cannot reveal or bypass the original key.</p>
          ${recoveryDiagnosticPanel}
          <div class="pair-code-input-recovery-correction-actions pair-code-input-recovery-stop-actions">
            <button type="button" data-action="${PAIR_CODE_INPUT_RESUME_RECOVERY_KEY_ACTION}">I found the original key</button>
            <button type="button" data-action="${PAIR_CODE_INPUT_RESUME_SERVER_REVIEW_ACTION}">The server changed or was reset</button>
          </div>
        </section>`;
  const recoveryResumeNotice = state.recoveryResumeOutcome === null
    ? ''
    : state.recoveryResumeOutcome === 'key_found'
      ? `<div class="pair-code-input-reauth-notice" ${PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR} role="status" aria-live="polite" aria-atomic="true">
          <strong>Original key ready</strong>
          <p>${state.serverUrl.trim().length > 0
            ? 'The reviewed server address is still here. Enter the original 24-word key in this browser; add a fresh pairing code only if that server asks for one.'
            : 'Enter the current server address, then enter its original 24-word key in this browser. Add a fresh pairing code only if that server asks for one.'}</p>
          <p>Nothing from the owner handoff was submitted automatically. Reconnecting will return to the exact page still selected in this tab.</p>
        </div>`
      : replacementServerDetails
        ? `<div class="pair-code-input-reauth-notice" ${PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR} role="status" aria-live="polite" aria-atomic="true">
            <strong>Use a fresh code from the current server</strong>
            <p>The previous address, one-time code, and recovery key were cleared. On the current server, run <code>recued pair</code>, then enter one address it shows and the fresh code from that same terminal.</p>
            <p>The recovery-key step stays hidden until you review the server. Starting fresh will not restore data from the previous server.</p>
          </div>`
        : replacementRecoveryReady
          ? `<div class="pair-code-input-reauth-notice" ${PAIR_CODE_INPUT_RECOVERY_RESUME_NOTICE_ATTR} ${PAIR_CODE_INPUT_REPLACEMENT_CONFIRMED_ATTR} role="status" aria-live="polite" aria-atomic="true">
              <strong>${replacementFreshKey
                ? 'Fresh start confirmed for this server'
                : 'Use only this current server’s key'}</strong>
              <p>Current server origin: <code>${e(currentServerOrigin ?? 'Origin unavailable')}</code>. ${replacementCodeAccepted
                ? 'The current server accepted the fresh pairing code. It was discarded and will not be sent again; any visible retry finishes only this browser’s save.'
                : 'A fresh pairing code from that server is ready and remains hidden.'}</p>
              <p>${replacementFreshKey
                ? replacementCodeAccepted
                  ? 'The new recovery key already belongs to this server. Keep its saved paper copy; this retry will not create another key or restore data from the previous server.'
                  : 'Create and save a new recovery key for this current server. The old server’s key cannot be entered in this path, and data from the previous server is not restored.'
                : replacementCodeAccepted
                  ? 'The current server accepted its confirmed recovery key. This retry will not contact the pairing endpoint again.'
                  : 'Enter the existing recovery key its administrator confirmed belongs to this current server. Do not reuse the old server’s key merely because the address looks familiar.'}</p>
              <button type="button" class="pair-code-input-change-server" data-action="${PAIR_CODE_INPUT_EDIT_REPLACEMENT_SERVER_ACTION}" ${editingDisabled ? 'disabled' : ''}>Review different server details</button>
            </div>`
          : '';
  const replacementServerReview = state.replacementServerStage === 'review'
    ? `<section id="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ID}" class="pair-code-input-recovery-stop pair-code-input-replacement-review" ${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ATTR} role="region" tabindex="-1" aria-labelledby="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_TITLE_ID}" aria-describedby="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_CONTEXT_ID}">
        <h3 id="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_TITLE_ID}">Confirm this is the current server</h3>
        <p id="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_CONTEXT_ID}">Nothing has been sent yet. Review the destination and the fresh-start consequence before Recued creates recovery material.</p>
        <div class="pair-code-input-recovery-stop-state">
          <strong>Current server origin</strong>
          <code>${e(currentServerOrigin ?? 'Origin unavailable')}</code>
          <p>A fresh pairing code was entered from this server’s terminal. The code stays hidden here and will be sent only after you finish saving a new recovery key.</p>
        </div>
        <h4>What starting fresh means</h4>
        <ol>
          <li>A familiar hostname can still point to a different server after a replacement or reset.</li>
          <li>Choosing <strong>Start fresh</strong> creates a new recovery key for the current server. An existing key cannot be entered in that path.</li>
          <li>Pairing does not restore missing data. You will see only data already on this server or restored separately by its administrator.</li>
          <li>After pairing, Recued verifies and saves the server’s signed identity, then returns to the exact page selected in this tab.</li>
        </ol>
        <p class="pair-code-input-recovery-stop-warning"><strong>Start fresh only if the server owner confirmed a brand-new server setup.</strong> If the administrator restored the previous setup, use only the existing recovery key they confirmed belongs to this server.</p>
        <div class="pair-code-input-recovery-correction-actions pair-code-input-recovery-stop-actions">
          <button type="button" data-action="${PAIR_CODE_INPUT_CONFIRM_REPLACEMENT_SERVER_ACTION}">Start fresh on this server</button>
          <button type="button" data-action="${PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION}">Use a confirmed existing key</button>
          <button type="button" data-action="${PAIR_CODE_INPUT_EDIT_REPLACEMENT_SERVER_ACTION}">Change server details</button>
        </div>
      </section>`
    : state.replacementServerStage === 'not_fresh'
      ? `<section id="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_ID}" class="pair-code-input-recovery-stop pair-code-input-replacement-review" ${PAIR_CODE_INPUT_REPLACEMENT_NOT_FRESH_ATTR} role="region" tabindex="-1" aria-labelledby="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_TITLE_ID}" aria-describedby="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_CONTEXT_ID}">
          <h3 id="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_TITLE_ID}">This server is already set up</h3>
          <p id="${PAIR_CODE_INPUT_REPLACEMENT_REVIEW_CONTEXT_ID}">The current server rejected the newly generated key because it already has a recovery key. Recued cleared the unused generated words and did not consume the fresh pairing code.</p>
          <div class="pair-code-input-recovery-stop-state">
            <strong>Current server origin</strong>
            <code>${e(currentServerOrigin ?? 'Origin unavailable')}</code>
            <p>Ask its administrator which existing recovery key belongs to this current server. Do not assume the previous server’s key is correct.</p>
          </div>
          <div class="pair-code-input-recovery-correction-actions pair-code-input-recovery-stop-actions">
            <button type="button" data-action="${PAIR_CODE_INPUT_USE_REPLACEMENT_EXISTING_KEY_ACTION}">I have this server’s existing key</button>
            <button type="button" data-action="${PAIR_CODE_INPUT_EDIT_REPLACEMENT_SERVER_ACTION}">Review a different server</button>
          </div>
        </section>`
      : '';

  const recoveryBody =
    state.recoveryMode === 'generate'
      ? renderGenerateBody(state)
      : isRestore
        ? renderRestoreBody(state)
        : renderEnterBody(state);
  let reauthNoticeHeading = 'Saved access needs attention';
  let reauthNoticeBody =
    "Your server no longer accepts this browser's saved access. This can happen after access is revoked or the server identity changes. Reconnecting does not delete work stored on your server.";
  if (reauthRecovery?.recoveryReentry === true) {
    reauthNoticeHeading = 'Recovery resumed in this tab';
    reauthNoticeBody =
      'The earlier recovery page closed before this browser reconnected. You do not need to wait for that page. Work stored on your server was not changed.';
  } else if (reauthRecovery?.reason === 'local_credentials_unreadable') {
    reauthNoticeHeading = 'Unreadable local access cleared';
    reauthNoticeBody =
      'This browser could not unlock its saved sign-in, so Recued removed only that local access record and started a secure reconnect. Work stored on your server was not deleted.';
  } else if (reauthRecovery?.reason === 'local_credentials_incomplete') {
    reauthNoticeHeading = 'Incomplete browser setup cleared';
    reauthNoticeBody =
      'A previous setup stopped before every local access detail was saved. Recued cleared only that incomplete browser record and started a clean reconnect. Work stored on your server was not deleted.';
  } else if (reauthRecovery?.reason === 'credentials_changed_elsewhere') {
    reauthNoticeHeading = 'Saved access changed in another tab';
    reauthNoticeBody =
      'Another Recued tab cleared or replaced this browser’s saved access. This tab stopped using the old session. Work stored on your server was not deleted.';
  } else if (
    reauthRecovery?.reason === 'startup_credentials_changed_elsewhere'
  ) {
    reauthNoticeHeading = 'Access changed while this tab was recovering';
    reauthNoticeBody =
      'Another Recued tab cleared or replaced the saved access this startup retry was using. Recued stopped that stale retry before it could open your page. Work stored on your server was not deleted.';
  }
  const reauthNotice =
    reauthRecovery === undefined
      || state.interruptedTransition
      || state.recoveryPaused
      || state.recoveryResumeOutcome !== null
    ? ''
    : `<div class="pair-code-input-reauth-notice" ${PAIR_CODE_INPUT_REAUTH_NOTICE_ATTR} role="status" aria-live="polite" aria-atomic="true">
        <strong>${e(reauthNoticeHeading)}</strong>
        <p>${e(reauthNoticeBody)}</p>
        <p>${reauthRecovery.recoveryReentry === true
          ? 'The exact page you were returning to is still selected. Pairing details are not restored; re-enter any missing server address, pairing code, and recovery key, then reconnect to return.'
          : `${reauthRecovery.chatDraftPreserved
            ? 'Your current page and unsent Chat draft are held in this tab.'
            : 'Your current page is held in this tab.'} Keep this tab open, then reconnect to return where you left off.`}</p>
      </div>`;
  const interruptedTakeoverLead = isRestore
    ? 'Another tab started saving this browser\'s access. This tab will continue automatically if it finishes. If that tab stopped, you can safely restart this restore here; your selected backup and archive key stay ready.'
    : reauthRecovery !== undefined
      ? `Keep this tab open. It will return to your current page${reauthRecovery.chatDraftPreserved ? ' and unsent Chat draft' : ''} automatically when the other tab finishes.`
      : 'Another tab started saving this browser\'s access. This tab will continue automatically if it finishes. If that tab stopped, you can safely take over here with the recovery key already tied to the server.';
  const interruptedTakeoverNext = isRestore
    ? `Recued cleared the old one-time code so it cannot be replayed. Work on your server is unchanged, and this tab's selected backup is still waiting. Get a fresh pairing code to continue.`
    : reauthRecovery !== undefined
      ? 'The old one-time code is cleared. Your recovery-key entry stays here and work on your server is unchanged; get a fresh code only if the other tab stops.'
      : `Recued cleared the old one-time code so it cannot be replayed. Work on your server is unchanged, and this tab's current page is still waiting. Get a fresh code only if the server asks for one.`;
  const stalledSiblingLead = !state.siblingTakeoverCoordinationAvailable
    ? state.submitting
      ? 'This tab is checking saved access and reconnecting. Keep any other reconnect form idle until it finishes.'
      : 'You can reconnect safely here, but continue in this tab only. This browser cannot safely choose between simultaneous reconnect attempts.'
    : state.submitting
      ? state.siblingTakeoverOwnsAttempt
        ? 'This tab passed the shared-access check and is reconnecting. If it succeeds, other open tabs will adopt its saved access without sending their pairing codes.'
        : 'Recued is choosing one reconnecting tab. If another tab finishes first, this tab will return automatically without sending its pairing code.'
      : 'You can keep waiting or reconnect safely here. If you do the same in another tab, Recued lets only one continue and returns the others automatically.';
  const stalledSiblingNext = state.siblingTakeoverOwnsAttempt
    ? `Keep this tab open. Your recovery key, current page${reauthRecovery?.chatDraftPreserved ? ', and unsent Chat draft' : ''} stay here until reconnecting finishes.`
    : `Your recovery key, current page${reauthRecovery?.chatDraftPreserved ? ', and unsent Chat draft' : ''} stay here. Add a fresh pairing code only if your server asks, then choose Reconnect in this tab.`;
  const successionLead =
    'A reconnect you already started in another tab is continuing now.';
  const successionNext = reauthRecovery !== undefined
    ? `This tab is waiting so it will not send or save the same access twice. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} stay here. If the other tab stops, your retry returns here.`
    : 'This tab is waiting so it will not send or save the same access twice. If the other tab stops, your retry returns here.';
  const recoveryOwnerNext = reauthRecovery !== undefined
    ? `Review the message below, make any needed correction, then retry here. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} remain in this tab.`
    : 'Review the message below, make any needed correction, then retry here.';
  const remoteRecoveryOwnerNext =
    !state.siblingTakeoverCoordinationAvailable
      ? reauthRecovery !== undefined
        ? `Keep this tab open. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} remain here. If the other tab stops, continue in just one open reconnect tab and keep the others idle.`
        : 'Keep this tab open. If the other tab stops, continue in just one open reconnect tab and keep the others idle.'
      : reauthRecovery !== undefined
        ? `Keep this tab open. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} remain here. If the other tab closes or stops responding, Recued will choose one open tab to continue.`
        : 'Keep this tab open. If the other tab closes or stops responding, Recued will choose one open tab to continue.';
  const recoverySuccessorNext = state.finalizePending
    ? reauthRecovery !== undefined
      ? `This tab still holds the successful server response. Finish saving access here; Recued will not contact the pairing endpoint again. Your current page${reauthRecovery.chatDraftPreserved ? ' and unsent Chat draft remain' : ' remains'} ready.`
      : 'This tab still holds the successful server response. Finish saving access here; Recued will not contact the pairing endpoint again.'
    : reauthRecovery !== undefined
      ? `Review the retained message below, make any needed correction, then retry here. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} remain in this tab.`
      : 'Review the retained message below, make any needed correction, then retry here.';
  const remoteRecoverySuccessorNext =
    !state.siblingTakeoverCoordinationAvailable
      ? reauthRecovery !== undefined
        ? `Keep this tab open. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} remain here. If the chosen tab also stops, continue in just one open reconnect tab.`
        : 'Keep this tab open. If the chosen tab also stops, continue in just one open reconnect tab.'
      : reauthRecovery !== undefined
        ? `Keep this tab open. Your recovery key, current page${reauthRecovery.chatDraftPreserved ? ', and unsent Chat draft' : ''} remain here. If the chosen tab also stops, Recued will choose another open tab.`
        : 'Keep this tab open. If the chosen tab also stops, Recued will choose another open tab.';
  const interruptedNotice = recoveryOwnerElsewhere
    ? `<div id="${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ID}" class="pair-code-input-interrupted-notice" ${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR} ${PAIR_CODE_INPUT_RECOVERY_OWNER_ELSEWHERE_ATTR}${recoverySuccessorElsewhere ? ` ${PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ELSEWHERE_ATTR}` : ''} role="status" aria-live="polite" aria-atomic="true">
        <strong>${recoverySuccessorElsewhere ? 'Recovery continued in another tab' : 'Continue in the tab that needs attention'}</strong>
        <p>${recoverySuccessorElsewhere ? 'The previous recovery tab stopped responding. Recued chose one open tab to continue, so this tab remains safely paused.' : 'Another reconnect tab has the latest error and is the only tab offering a retry.'}</p>
        <p>${e(recoverySuccessorElsewhere ? remoteRecoverySuccessorNext : remoteRecoveryOwnerNext)}</p>
      </div>`
    : recoveryOwnerHere
      ? `<div id="${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ID}" class="pair-code-input-interrupted-notice" ${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR} ${PAIR_CODE_INPUT_RECOVERY_OWNER_ATTR}${recoverySuccessorHere ? ` ${PAIR_CODE_INPUT_RECOVERY_SUCCESSOR_ATTR}` : ''} role="status" aria-live="polite" aria-atomic="true">
          <strong>${recoverySuccessorHere ? 'Recovery moved to this tab' : 'This tab needs attention'}</strong>
          <p>${recoverySuccessorHere ? 'The previous recovery tab stopped responding. Recued chose this tab as the only safe successor.' : 'The other reconnect tabs are waiting, so there is only one retry to manage.'}</p>
          <p>${e(recoverySuccessorHere ? recoverySuccessorNext : recoveryOwnerNext)}</p>
        </div>`
    : siblingSuccession
    ? `<div id="${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ID}" class="pair-code-input-interrupted-notice" ${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR} ${PAIR_CODE_INPUT_SUCCESSION_ATTR} role="status" aria-live="polite" aria-atomic="true">
        <strong>Another tab is continuing</strong>
        <p>${e(successionLead)}</p>
        <p>${e(successionNext)}</p>
      </div>`
    : !state.interruptedTransition
    ? ''
    : state.finalizePending
      ? `<div class="pair-code-input-interrupted-notice" ${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR} data-local-finalize-retry role="status" aria-live="polite" aria-atomic="true">
          <strong>Server pairing is complete</strong>
          <p>This tab still has the successful response in memory. Finish saving access here; Recued will not contact the pairing endpoint again.</p>
          <p>Work on your server is unchanged. Keep this tab open; your current page${reauthRecovery?.chatDraftPreserved ? ' and unsent Chat draft are' : ' is'} still waiting for you.</p>
        </div>`
      : state.finalizeRestarted
        ? `<div class="pair-code-input-interrupted-notice" ${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR} data-local-finalize-restarted role="status" aria-live="polite" aria-atomic="true">
            <strong>Ready for a fresh pairing attempt</strong>
            <p>Recued discarded this tab's interrupted response, kept your recovery key, and cleared the old one-time code so it cannot be replayed.</p>
            <p>Pair again below. Work on your server is unchanged; get a fresh code only if the server asks for one.</p>
          </div>`
        : `<div id="${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ID}" class="pair-code-input-interrupted-notice" ${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ATTR}${siblingTakeover && state.siblingTakeoverReady ? ` ${PAIR_CODE_INPUT_TAKEOVER_READY_ATTR}` : ''}${siblingTakeover && state.siblingTakeoverOwnsAttempt ? ` ${PAIR_CODE_INPUT_TAKEOVER_OWNER_ATTR}` : ''} role="status" aria-live="polite" aria-atomic="true">
            <strong>${siblingTakeover && state.siblingTakeoverReady
              ? state.submitting
                ? !coordinatedSiblingTakeover
                  ? 'This tab is reconnecting'
                  : state.siblingTakeoverOwnsAttempt
                  ? 'This tab is reconnecting'
                  : 'Choosing one tab safely'
                : 'The other tab is taking longer'
              : reauthRecovery !== undefined
                ? 'Another tab is reconnecting'
                : 'Another tab is saving access'}</strong>
            <p>${e(siblingTakeover && state.siblingTakeoverReady
              ? stalledSiblingLead
              : interruptedTakeoverLead)}</p>
            <p>${e(siblingTakeover && state.siblingTakeoverReady
              ? stalledSiblingNext
              : interruptedTakeoverNext)}</p>
          </div>`;
  const secureResumeProgress = isRestore
    ? state.pairingCode.trim().length > 0
      ? 'Your pairing code is ready too. Choose your backup and enter its recovery key.'
      : 'Add the pairing code, choose your backup, and enter its recovery key.'
    : state.recoveryMode === 'generate'
      ? state.pairingCode.trim().length > 0
        ? 'Your pairing code is ready too. Generate and save your recovery key to continue.'
        : 'Generate and save your recovery key; add a pairing code if your server asks for one.'
      : state.pairingCode.trim().length > 0
        ? 'Your pairing code is ready too. Continue with your recovery key.'
        : 'Continue with your recovery key; add a pairing code only if your server asks for one.';
  const secureResumeNotice =
    reauthRecovery === undefined
      && !state.recoveryPaused
      && state.serverUrl.trim().length > 0
      && state.sameOriginResume
      ? `<div id="${PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ID}" class="pair-code-input-secure-resume-notice" ${PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ATTR} role="status" aria-live="polite" aria-atomic="true">
          <strong>Secure address carried over</strong>
          <p>You do not need to enter the server URL again. Recued will pair with this page's own address: <code>${e(state.serverUrl)}</code>. Any different server address embedded in the link is ignored.</p>
          <p>${secureResumeProgress}</p>
        </div>`
      : '';
  const recoveryMaterialHelp =
    !state.recoveryPaused
      && state.replacementServerStage === null
      && (reauthRecovery?.recoveryReentry === true || showRecoveryCorrection)
      ? `<details class="pair-code-input-recovery-help" ${PAIR_CODE_INPUT_RECOVERY_HELP_ATTR}>
          <summary>Need help finding these details?</summary>
          <div class="pair-code-input-recovery-help-body">
            <p><strong>Server address or pairing code.</strong> On the computer running Recued, run <code>recued pair</code>. It shows the current server addresses and creates a fresh, time-limited code. Choose an address you recognize. Prefer one beginning with <code>https://</code>; an <code>http://localhost</code> address is only for reconnecting on that same computer. Enter the code only if the server asks for it.</p>
            <p><strong>Recovery key.</strong> Use the same 24-word key saved when this server was first set up. Recued does not save a readable copy of those words, so it cannot show them again, and a fresh pairing code cannot replace the key.</p>
            <p><strong>Still missing the key?</strong> Stop here instead of generating a new one for this server. Check the paper or password-manager copy saved during setup. If someone else set up the server, ask where the recovery key was saved. Never send the key through support, email, or Chat.</p>
          </div>
        </details>`
      : '';

  return `
    <form id="${e(PAIR_CODE_INPUT_FORM_ID)}" class="pair-code-input-form" aria-labelledby="${e(PAIR_CODE_INPUT_TITLE_ID)}"${state.submitting || siblingSuccession ? ' aria-busy="true"' : ''} novalidate>
      <h2 id="${e(PAIR_CODE_INPUT_TITLE_ID)}" class="pair-code-input-title">${state.recoveryPaused
        ? safeStopReentry
          ? 'Recovery still paused'
          : 'Recovery paused safely'
        : state.replacementServerStage !== null
          ? state.finalizePending
            ? 'Finish saving server access'
            : state.replacementServerStage === 'fresh_key'
              ? 'Set up the current server'
              : state.replacementServerStage === 'existing_key'
                ? 'Verify the current server'
                : 'Review the current server'
        : isRestore
          ? 'Restore a backup'
          : state.reauthOnly
            ? 'Reconnect this browser'
            : 'Pair this browser'}</h2>
      ${reauthNotice}
      ${interruptedNotice}
      ${secureResumeNotice}
      <p class="pair-code-input-help">
        ${state.recoveryPaused
          ? safeStopReentry
            ? 'This tab returned to the safe stop without restoring the sensitive details that led there. Continue only from a server owner’s confirmed answer.'
            : 'You confirmed the server address, but it rejected repeated complete 24-word entries and no usable original key was available. Share only the reviewed owner handoff below.'
          : state.replacementServerStage === 'details'
            ? 'Enter the current server address and a fresh code from that same server. Recued keeps recovery material out of this step.'
            : state.replacementServerStage === 'review'
              ? 'Check the current origin and what a fresh start can—and cannot—recover.'
              : state.replacementServerStage === 'fresh_key'
                ? replacementCodeAccepted
                  ? 'Pairing succeeded and the current server identity is ready. Finish saving that access in this browser; Recued will not send the pairing request again.'
                  : 'Create a new recovery key for the current server. Pairing verifies and saves this server’s identity; it does not restore data from the previous server.'
                : state.replacementServerStage === 'not_fresh'
                  ? 'The current server already has a recovery key. Continue only with a key its administrator confirms belongs here.'
                  : state.replacementServerStage === 'existing_key'
                    ? replacementCodeAccepted
                      ? 'Pairing succeeded with this server’s confirmed recovery key. Finish saving that access in this browser; Recued will not send the pairing request again.'
                      : 'Enter only the existing recovery key confirmed for this current server. The fresh code and reviewed origin remain fixed for this attempt.'
          : isRestore
            ? state.sameOriginResume
              ? "Restore a Recued backup onto this secure server. Its address is ready; check the pairing code, choose your backup file, then enter the backup's 24-word recovery key."
              : "Restore a Recued backup onto a fresh server. Enter the server's URL and pairing code, choose your backup file, then enter the backup's 24-word recovery key."
            : state.reauthOnly
              ? reauthRecovery?.recoveryReentry === true
                ? 'Start with the server address, then enter your existing 24-word recovery key. Add a pairing code only if your server asks for one.'
                : 'Enter your existing 24-word recovery key. If you need a fresh pairing code, run <code>recued pair</code> on your server.'
              : state.sameOriginResume
                ? "Finish pairing with your existing recovery key — or generate a new one if you're setting the server up for the first time."
                : "Connect this browser to your recued-server. Enter its URL, then enter your existing recovery key — or generate a new one if you're setting the server up for the first time."}
      </p>
      ${recoveryResumeNotice}
      ${recoveryMaterialHelp}

      <div class="pair-code-input-fields"${state.recoveryPaused || replacementServerReviewing ? ' hidden aria-hidden="true"' : ''}>
      <div class="form-row"${state.replacementServerStage !== null && !replacementServerDetails ? ' hidden aria-hidden="true"' : ''}>
        <label for="${e(PAIR_CODE_INPUT_SERVER_URL_ID)}">Server URL${state.sameOriginResume
          ? ' <span class="pair-code-input-optional">(this secure page)</span>'
          : ''}</label>
        <input id="${e(PAIR_CODE_INPUT_SERVER_URL_ID)}"
          type="url"
          data-${e(PAIR_CODE_INPUT_FIELD_NAME)}="server-url"
          value="${e(state.recoveryPaused || (state.replacementServerStage !== null && !replacementServerDetails) ? '' : state.serverUrl)}"
          placeholder="https://your-server.recued.cloud"
          autocomplete="off"
          ${reauthRecovery?.recoveryReentry === true
            && state.serverUrl.trim().length === 0
            && !editingDisabled
            ? 'autofocus'
            : ''}
          ${state.sameOriginResume
            ? `readonly${state.reauthOnly
              ? ''
              : ` aria-describedby="${PAIR_CODE_INPUT_SECURE_RESUME_NOTICE_ID}"`}`
            : ''}
          ${editingDisabled || (state.replacementServerStage !== null && !replacementServerDetails) ? 'disabled' : ''} />
        <p class="field-hint pair-code-input-insecure-address" id="${PAIR_CODE_INPUT_INSECURE_ADDRESS_ID}"${
          isCertainlyBlockedServerAddress(state.serverUrl, readPageProtocol()) ? '' : ' hidden'
        }>This page is secure (https) and that server address is not, so this browser will refuse the connection. Open the webclient from the server itself — its own address ending in /webclient/ — or give the server a domain and certificate.</p>
        ${state.sameOriginResume
          ? `<button type="button" class="pair-code-input-change-server" data-action="${PAIR_CODE_INPUT_CHANGE_SERVER_ACTION}" aria-describedby="${PAIR_CODE_INPUT_CHANGE_SERVER_NOTE_ID}" ${editingDisabled ? 'disabled' : ''}>Use a different server address</button>
            <span id="${PAIR_CODE_INPUT_CHANGE_SERVER_NOTE_ID}" class="pair-code-input-change-server-note">Changing servers also clears any pairing code.</span>`
          : ''}
      </div>

      <div class="form-row"${state.replacementServerStage !== null && !replacementServerDetails ? ' hidden aria-hidden="true"' : ''}>
        <label for="${e(PAIR_CODE_INPUT_CODE_ID)}">
          Pairing code ${isRestore
            ? '<span class="pair-code-input-optional">(from server terminal)</span>'
            : replacementServerDetails
              ? '<span class="pair-code-input-optional">(fresh from current server terminal)</span>'
              : state.reauthOnly
                ? '<span class="pair-code-input-optional">(only if your server asks)</span>'
              : state.sameOriginResume
                ? state.pairingCode.trim().length > 0
                  ? '<span class="pair-code-input-optional">(carried over)</span>'
                  : '<span class="pair-code-input-optional">(only if your server asks)</span>'
                : '<span class="pair-code-input-optional">(optional — first pair only)</span>'}
        </label>
        <input id="${e(PAIR_CODE_INPUT_CODE_ID)}"
          type="text"
          data-${e(PAIR_CODE_INPUT_FIELD_NAME)}="pairing-code"
          value="${e(state.replacementServerStage !== null && !replacementServerDetails ? '' : state.pairingCode)}"
          placeholder="From server terminal"
          autocomplete="off"
          style="text-transform:uppercase; letter-spacing:0.15em; font-family:monospace"
          ${editingDisabled || (state.replacementServerStage !== null && !replacementServerDetails) ? 'disabled' : ''} />
      </div>

      <div class="form-row form-row-recovery"${state.replacementServerStage !== null && !replacementRecoveryReady ? ' hidden aria-hidden="true"' : ''}>
        <label>${isRestore
          ? "Backup's recovery key"
          : replacementFreshKey
            ? 'New recovery key for this server'
            : state.replacementServerStage === 'existing_key'
              ? 'Current server recovery key'
              : 'Recovery key'}</label>
        ${state.restoreOnly || state.reauthOnly
          ? ''
          : renderRecoveryModeToggle(state)}
        <div class="pair-code-input-recovery">
          ${state.replacementServerStage !== null && !replacementRecoveryReady ? '' : recoveryBody}
        </div>
      </div>
      </div>

      ${state.recoveryPaused ? '' : statusBlock}
      ${recoveryCorrection}
      ${recoveryStop}
      ${replacementServerReview}

      <div class="pair-code-input-actions"${state.recoveryPaused || replacementServerReviewing ? ' hidden aria-hidden="true"' : ''}>
        <p id="${e(PAIR_CODE_INPUT_REQUIREMENT_ID)}" class="pair-code-input-requirement">${e(disabledReason ?? '')}</p>
        <button id="${e(PAIR_CODE_INPUT_SUBMIT_ID)}"
          type="button"
          data-action="${e(PAIR_CODE_INPUT_SUBMIT_ACTION)}"
          ${siblingTakeover || siblingSuccession || recoveryOwnerHere || recoveryOwnerElsewhere ? `aria-describedby="${PAIR_CODE_INPUT_INTERRUPTED_NOTICE_ID}"` : ''}
          ${disabledReason ? `title="${e(disabledReason)}"` : ''}
          ${focusableTakeoverProgress
            ? 'aria-disabled="true"'
            : disabled
              ? 'disabled'
              : ''}>${e(submitLabel)}</button>
        ${state.finalizePending && !siblingSuccession && !recoveryOwnerElsewhere
          ? `<button type="button" class="pair-code-input-restart-after-interruption" data-action="${PAIR_CODE_INPUT_RESTART_AFTER_INTERRUPTION_ACTION}" aria-describedby="${PAIR_CODE_INPUT_RESTART_NOTE_ID}" ${state.submitting ? 'disabled' : ''}>Pair again with the recovery key</button>
            <p id="${PAIR_CODE_INPUT_RESTART_NOTE_ID}" class="pair-code-input-restart-note">Use this only if saving keeps failing. Recued will discard the in-memory response and clear the old one-time code.</p>`
          : ''}
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
  const dis = isPairEditingDisabled(state) ? 'disabled' : '';
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
      ${isPairEditingDisabled(state) ? 'disabled' : ''} />
    ${state.restoreFileName
      ? `<p class="pair-code-input-restore-file-name" data-restore-file-name>Selected: ${e(state.restoreFileName)}</p>`
      : ''}
  </div>
  ${recoveryGrid({
    words: state.recoveryWords,
    fieldName: PAIR_CODE_INPUT_RECOVERY_FIELD_NAME,
    fieldValue: PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE,
    idPrefix: PAIR_CODE_INPUT_RECOVERY_PREFIX,
    disabled: isPairEditingDisabled(state),
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
    disabled: isPairEditingDisabled(state),
  })}
`;

const renderGenerateBody = (state: PairCodeInputState): string => {
  switch (state.generateStage) {
    case 'start':
      return renderGenerateStart(state);
    case 'writing':
      return renderGenerateWriting(state);
    case 'challenging':
      return renderGenerateChallenge(state);
  }
};

const renderGenerateStart = (state: PairCodeInputState): string => `
  <p class="field-hint">
    ${state.replacementServerFreshStart
      ? 'Generate a new 24-word recovery key for this current server. It protects only this new server setup and does not recover data from the previous server.'
      : "First time setting up this server? Generate a 24-word recovery key. It's the only way to recover your encrypted data if you lose this device — nobody, including Recued, can recover it for you."}
  </p>
  <div class="pair-code-input-generate-actions">
    <button type="button"
      class="pair-code-input-secondary-btn"
      data-action="${e(PAIR_CODE_INPUT_GENERATE_ACTION)}"
      ${isPairEditingDisabled(state) ? 'disabled' : ''}>Generate a new recovery key</button>
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
      ${state.replacementServerFreshStart
        ? "Write this current server's 24 words on paper and store them separately from any old-server key. This is the only time they're shown — do not share them."
        : "Write these 24 words on paper and store them somewhere safe. This is the only time they're shown — do not share them. We'll ask you to re-type them next to confirm."}
    </p>
    <div class="rx-recovery-words rx-recovery-words-readonly">
      ${cells}
    </div>
    <div class="pair-code-input-generate-actions">
      <button type="button"
        class="pair-code-input-linkbtn"
        data-action="${e(PAIR_CODE_INPUT_GENERATE_RESTART_ACTION)}"
        ${isPairEditingDisabled(state) ? 'disabled' : ''}>Start over</button>
      <button type="button"
        class="pair-code-input-secondary-btn"
        data-action="${e(PAIR_CODE_INPUT_GENERATE_ACK_ACTION)}"
        ${isPairEditingDisabled(state) ? 'disabled' : ''}>I've written it down — continue</button>
    </div>
  `;
};

const renderGenerateChallenge = (state: PairCodeInputState): string => `
  <p class="field-hint">
    ${state.replacementServerFreshStart
      ? "Type the 24 new words from this current server's paper copy. This confirms the new key you just saved, not any key from the previous server."
      : 'Type the 24 words from your paper copy to confirm you saved them correctly. Paste into any box to fan the phrase out across the rest.'}
  </p>
  ${recoveryGrid({
    words: state.recoveryWords,
    fieldName: PAIR_CODE_INPUT_RECOVERY_FIELD_NAME,
    fieldValue: PAIR_CODE_INPUT_RECOVERY_FIELD_VALUE,
    idPrefix: PAIR_CODE_INPUT_RECOVERY_PREFIX,
    disabled: isPairEditingDisabled(state),
  })}
  <div class="pair-code-input-generate-actions">
    <button type="button"
      class="pair-code-input-linkbtn"
      data-action="${e(PAIR_CODE_INPUT_GENERATE_RESTART_ACTION)}"
      ${isPairEditingDisabled(state) ? 'disabled' : ''}>Start over</button>
  </div>
`;
