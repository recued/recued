/** M5 S3.2 — pre-pair "Restore from backup" orchestrator (the boot-layer
 *  state machine).
 *
 *  S3 lets a FRESH webclient (no pair state) restore a backup as its FIRST
 *  action, so a user migrating to a new server/browser never has to
 *  pair-then-restore. The pair host's 3rd `restore` collect-mode (S3.3) gathers
 *  the inputs — server URL + console pairing code + the archive's 24-word
 *  recovery key + the `.recued.archive` file — and hands them here. This module
 *  drives the locked leaf sequence and emits state for the splash progress UI:
 *
 *    code-only /auth/pair → finalize (persist the bearer) → open a bearer-authed
 *    restore channel → upload + stage the archive → import dry-run (VALIDATE the
 *    archive key) → preview → confirm → commit → stash the rebind bearer →
 *    hand off to the full bootstrap (reconnects into the restored app).
 *
 *  ── The footgun fix: validate-before-seal ─────────────────────────────────
 *
 *  A wrong archive key sealing a bogus realm is killed by pairing CODE-ONLY (no
 *  recoveryKey to `/auth/pair` ⇒ the server stays UNENROLLED) and validating the
 *  archive key in the dry-run BEFORE any commit. The realm seals ONLY via the
 *  archive's own sentinel at a successful commit (server-side S3.1). So a wrong
 *  key bounces back to collect with the server still pristine — nothing is
 *  consumed irreversibly. ONE key (the archive's) is used for upload/validate +
 *  decrypt; it is NEVER sent to `/auth/pair`.
 *
 *  ── Resume-aware retry ────────────────────────────────────────────────────
 *
 *  The recoverable errors all bounce to `collect` (re-input), but a naive retry
 *  would re-POST `/auth/pair` (the one-shot pairing code may already be spent)
 *  or re-upload a multi-GB archive. So the machine remembers what is already
 *  done across `submit` calls:
 *    - `paired` — skip pair+finalize once `webclient_token` is persisted
 *      (re-running `finalizePairCodeSuccess` would also trip its already-paired
 *      entrance guard).
 *    - `issued` — if `/auth/pair` succeeded but `finalize` did NOT, the retry
 *      resumes at finalize with the SAME issued bearer (no second `/auth/pair`).
 *    - `stagedName` + `uploadedFileId` — skip upload when the same file is
 *      already staged (a wrong-key retry re-validates only).
 *
 *  ── Lightweight, NOT the full bootstrap ───────────────────────────────────
 *
 *  This runs BETWEEN finalize and the full app bootstrap. It uses its OWN
 *  bearer-authed WS (a short-lived `RestoreChannel`) for the `server.archive.*`
 *  control plane — an unenrolled, code-only-paired webclient is allowed those
 *  rpc methods (the server's `PRE_ENROLLMENT_ALLOWED_RPC_METHODS` gate; webclients
 *  are bearer-only and never `register`). On a committed restore it closes that
 *  channel and calls `onRestored()`, which the boot layer (S3.4) wires to
 *  `runBootstrapWithPairFallback` — the global reconnect re-pairs with the
 *  stashed rebind bearer into the restored realm.
 *
 *  ── Decoupling for tests ──────────────────────────────────────────────────
 *
 *  The state machine (`createRestoreOnboarding`) is pure over an injected
 *  `RestoreOps` side-effect boundary, so every transition is testable against a
 *  fake. `createBrowserRestoreOps` is the production wiring (ws-client + rpc +
 *  archive upload/import + rebind stash), and `createBrowserRestoreOnboarding`
 *  composes both for S3.4. */

import type {
  ArchiveImportRebind,
  ArchiveManifest,
  ArchiveRealmRelation,
  ArchiveSchemaCompat,
} from '@recued/contracts';
import type { Upload } from '@recued/ui-shared';

import {
  PAIR_CODE_INPUT_ERROR_COPY,
  submitPairCodeInput,
  type PairCodeInputCommitResult,
} from './pair-code-input-host.js';
import {
  finalizePairCodeSuccess,
  PAIR_CODE_SUCCESS_ERROR_COPY,
  type PairCodeSuccessOptions,
  type PairCodeSuccessResult,
} from './pair-code-success.js';
import {
  createWebclientPairPassportInvoker,
  type PairPassportInvoker,
} from './pair-passport-invoker.js';
import {
  createBrowserWebclientTransport,
  WEBCLIENT_WS_SUBPROTOCOL,
} from '../realtime/browser-transport.js';
import {
  createWebclientWsClient,
  type WebclientWsClient,
  type WebclientWsTransport,
} from '../realtime/ws-client.js';
import { createWebclientRpcConn } from '../realtime/rpc-conn.js';
import type {
  ArchiveImportCaller,
  ArchiveUploadFile,
  ArchiveUploadFn,
} from '../settings/archive-backup-panel.js';
import { createArchiveRebindStash } from '../settings/archive-rebind-stash.js';
import { createArchiveUpload } from '../settings/archive-upload.js';
import type {
  WebclientLocalStore,
  WebclientProfileStore,
} from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Public state + inputs
// ════════════════════════════════════════════════════════════════

/** What the collect form (S3.3) gathers and hands to `submit`. On a recoverable
 *  retry the form re-submits these — the machine uses its `paired` / `stagedName`
 *  memory to skip steps already done, so only the corrected field actually
 *  matters (e.g. a wrong-key retry re-uses the staged upload + paired bearer and
 *  only re-validates with the new `archiveKey`). */
export interface RestoreOnboardingInputs {
  /** Server URL the user typed (CLI-printed). Code-only pairing target. */
  serverUrl: string;
  /** Pairing code from the server terminal. */
  code: string;
  /** The archive's 24-word recovery key — used for upload/validate/decrypt,
   *  NEVER sent to `/auth/pair`. */
  archiveKey: string;
  /** The picked `.recued.archive`. Only read during the upload step. */
  file: ArchiveUploadFile;
}

export type RestoreOnboardingPhase =
  | 'collect' // waiting for (re-)input — the splash shows the pair-host form
  | 'pairing' // code-only /auth/pair + finalize in flight
  | 'uploading' // chunking + staging the archive
  | 'validating' // import dry-run (proves the archive key)
  | 'preview' // manifest shown; confirm available unless `blocked`
  | 'restoring' // committing import in flight
  | 'done' // committed; handed off to the full bootstrap
  | 'fatal'; // unrecoverable (e.g. a non-empty target that can't happen fresh)

/** Which step bounced us back to `collect`, so the UI can focus the right
 *  field. `null` for a non-field error (e.g. couldn't open the channel). */
export type RestoreOnboardingErrorStage = 'pairing' | 'upload' | 'validate' | null;

/** One immutable snapshot the UI renders. `phase` discriminates which of the
 *  per-phase fields are meaningful (`upload` in `uploading`; `manifest` / `realm`
 *  / `schemaCompat` / `blocked` in `preview`; `error` / `errorStage` in
 *  `collect` + `fatal`). */
export interface RestoreOnboardingState {
  phase: RestoreOnboardingPhase;
  /** User-facing copy for a `collect` / `fatal` state; null otherwise (and on
   *  the very first `collect`, before any attempt). */
  error: string | null;
  errorStage: RestoreOnboardingErrorStage;
  /** Byte progress while `uploading`. */
  upload: { sent: number; total: number };
  /** Dry-run result, shown while `preview`. */
  manifest: ArchiveManifest | null;
  realm: ArchiveRealmRelation | null;
  schemaCompat: ArchiveSchemaCompat | null;
  /** `preview` only — true when the backup needs a newer server
   *  (`schema_compat.status === 'archive_too_new'`): render the upgrade message
   *  and BLOCK confirm/commit. */
  blocked: boolean;
}

const initialState = (): RestoreOnboardingState => ({
  phase: 'collect',
  error: null,
  errorStage: null,
  upload: { sent: 0, total: 0 },
  manifest: null,
  realm: null,
  schemaCompat: null,
  blocked: false,
});

// ════════════════════════════════════════════════════════════════
// Side-effect boundary (the seam the state machine is pure over)
// ════════════════════════════════════════════════════════════════

/** The short-lived bearer-authed WS the orchestrator drives the restore over.
 *  Built once (post-pair) and reused for upload + validate + commit; closed on a
 *  committed restore (the server restarts) and on dispose. */
export interface RestoreChannel {
  /** Chunk + stage the archive over `/ws/archive-upload`; returns a cancel fn. */
  upload: ArchiveUploadFn;
  /** `server.archive.import` — dry-run (validate) and commit. */
  importArchive: ArchiveImportCaller;
  /** Tear down the ws + rpc. Idempotent. */
  close(): Promise<void>;
}

/** The irreversible operations the state machine sequences. Production wires
 *  `createBrowserRestoreOps`; tests inject a fake to exercise each transition. */
export interface RestoreOps {
  /** Code-only `/auth/pair` (no recoveryKey ⇒ the server stays unenrolled). */
  pairCode(inputs: {
    serverUrl: string;
    code: string;
  }): Promise<PairCodeInputCommitResult>;
  /** Persist the 5 IDB pair fields ⇒ now paired (the channel can unwrap the
   *  bearer). */
  finalize(args: {
    serverUrl: string;
    token: string;
    token_id?: string;
    passport?: unknown;
  }): Promise<PairCodeSuccessResult>;
  /** Build the bearer-authed restore channel (post-pair). */
  openChannel(): Promise<RestoreChannel>;
  /** S2b — re-wrap the rebind bearer a committing import returns so the
   *  post-restart reconnect re-pairs seamlessly. Best-effort (never throws by
   *  contract). */
  stashRebind(rebind: ArchiveImportRebind): Promise<void>;
}

export interface RestoreOnboardingDeps {
  ops: RestoreOps;
  /** Hand-off on a committed restore. S3.4 wires this to
   *  `runBootstrapWithPairFallback`. */
  onRestored: () => void | Promise<void>;
}

/** The handle the boot layer drives + the UI subscribes to. */
export interface RestoreOnboarding {
  getState(): RestoreOnboardingState;
  /** Subscribe to state changes; returns an unsubscribe fn. */
  subscribe(listener: (state: RestoreOnboardingState) => void): () => void;
  /** Start — or retry — the flow with the collected inputs. Idempotent while a
   *  step is in flight (re-entrancy guarded). */
  submit(inputs: RestoreOnboardingInputs): Promise<void>;
  /** Confirm the preview ⇒ commit. No-op unless `phase === 'preview' && !blocked`. */
  confirm(): Promise<void>;
  /** Tear down the channel + listeners. Idempotent. */
  dispose(): Promise<void>;
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

/** User-facing copy the splash surface renders. Pair / finalize failures reuse
 *  the existing `PAIR_CODE_INPUT_ERROR_COPY` / `PAIR_CODE_SUCCESS_ERROR_COPY`
 *  maps; the strings here cover the restore-specific steps. */
export const RESTORE_ONBOARDING_COPY = {
  channel_failed:
    'Paired with your server, but Recued couldn’t open the restore connection. Check that the server is running and try again.',
  upload_failed: 'Upload failed:',
  wrong_key:
    "That recovery key doesn’t match this backup. Check your written copy and try again.",
  validate_failed: 'Could not read the backup:',
  target_not_empty:
    'This server already holds data, so it can’t be restored into from this screen. Use Settings → Backup & Recovery on the existing server instead.',
  realm_mismatch:
    'This backup belongs to a different server identity and can’t be restored onto this one from here.',
  schema_too_new:
    'This backup was made by a newer version of Recued than this server runs. Upgrade this server, then restore.',
  restore_failed: 'The restore failed:',
  already_paired:
    'Another tab or window finished pairing this browser to a server while this restore was open. Reload to continue.',
  server_changed:
    'This browser already paired with a different server during this restore. Reload to restore onto another server.',
} as const;

/** The dry-run + commit import both decrypt the archive server-side, which can
 *  outlast the default 30s rpc budget for a multi-GB backup. A generous budget
 *  lets the call wait for the real response (success) or an actual socket drop
 *  (the server restarted ⇒ success) rather than a premature `timeout` that
 *  `isServerRestartDrop` (correctly) refuses to read as a commit. */
export const RESTORE_IMPORT_TIMEOUT_MS = 900_000;

// ════════════════════════════════════════════════════════════════
// Error classifiers (mirror the archive-backup-panel's private helpers)
// ════════════════════════════════════════════════════════════════

const errorCodeOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

const messageOf = (err: unknown): string =>
  humanizeRpcError(err);

/** A valid-shape-but-WRONG archive key surfaces as `ARCHIVE_INVALID_SIGNATURE`
 *  in the error MESSAGE (the WS dispatcher maps the plain Error to wire code
 *  `internal`), so the marker lives in the message, not the code. */
const isWrongKeyError = (err: unknown): boolean =>
  /ARCHIVE_INVALID_SIGNATURE/.test(messageOf(err));

/** Codes the rpc-conn rejects with when the socket actually DROPS / the conn is
 *  torn down — i.e. the server-restart drop after a committing import (the
 *  response raced the drain). Treated as "committed; restarting", never an error.
 *
 *  Deliberately EXCLUDES `timeout`. The commit carries a generous
 *  `RESTORE_IMPORT_TIMEOUT_MS` budget, so a timeout means the server is genuinely
 *  wedged — the client deadline expiring does NOT prove the destructive db swap
 *  happened. (The shipped backup panel folds `timeout` into "assume committed"
 *  because it uses the default 30s budget + leans on an existing reconnect loop;
 *  the pre-pair onboarding flow can't make that assumption — a premature timeout
 *  would hand the bootstrap an un-restored, still-unenrolled server.) */
const isServerRestartDrop = (err: unknown): boolean => {
  const code = errorCodeOf(err);
  return (
    code === 'transport' ||
    code === 'transport_disposed' ||
    code === 'webclient_reauth_required'
  );
};

/** S3.1 — a `not_enrolled` target that isn't empty rejects 409
 *  `archive_restore_target_not_empty`. Can't happen on a genuinely fresh server
 *  (every user-data write is gated pre-enrollment) ⇒ fatal. */
const isTargetNotEmptyError = (err: unknown): boolean =>
  errorCodeOf(err) === 'archive_restore_target_not_empty';

/** A cross-realm archive rejects 403 `archive_realm_mismatch`. Can't happen on a
 *  pre-pair restore (the archive seals the realm via its own sentinel) ⇒ fatal. */
const isRealmMismatchError = (err: unknown): boolean =>
  errorCodeOf(err) === 'archive_realm_mismatch';

/** S3.0 — committing a newer-schema archive onto an older server rejects 409
 *  `archive_schema_too_new`. The preview normally blocks this first; this is the
 *  commit-time backstop. */
const isSchemaTooNewError = (err: unknown): boolean =>
  errorCodeOf(err) === 'archive_schema_too_new';

// ════════════════════════════════════════════════════════════════
// State machine
// ════════════════════════════════════════════════════════════════

/** A stable id for "is this the file we already staged?" — used to skip a
 *  re-upload on a wrong-key retry while still re-uploading when the user picks a
 *  different file. */
const fileIdOf = (file: ArchiveUploadFile): string =>
  `${file.name}:${file.size}:${file.lastModified}`;

/** Compare-form for the pairing target — trim + lowercase + strip trailing
 *  slashes. Fail-safe toward "changed": a same-server URL retyped with different
 *  whitespace/case still matches, two genuinely different URLs don't, and a
 *  false "changed" only costs a reload (never a wrong-server restore). */
const normalizeServerUrlForCompare = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\/+$/, '');

type UploadOutcome =
  | { ok: true; staged_name: string }
  | { ok: false; error: string };

export const createRestoreOnboarding = (
  deps: RestoreOnboardingDeps,
): RestoreOnboarding => {
  const { ops, onRestored } = deps;

  let state = initialState();
  const listeners = new Set<(state: RestoreOnboardingState) => void>();

  // ── Progress through the once-only / expensive steps (resume memory) ──
  let paired = false;
  /** Compare-form of the `serverUrl` we paired+finalized to. Binds the resume
   *  memory to its target so a later submit with a DIFFERENT server (or an
   *  `already_paired` finalize whose persisted pair is some OTHER tab's server)
   *  can't silently restore against the wrong, stale-from-local-storage server. */
  let pairedServerUrl: string | null = null;
  /** A successful `/auth/pair` whose `finalize` hasn't landed yet — kept so a
   *  retry resumes at finalize instead of re-POSTing (and re-consuming) the code. */
  let issued: (PairCodeInputCommitResult & { ok: true }) | null = null;
  let channel: RestoreChannel | null = null;
  let stagedName: string | null = null;
  let uploadedFileId: string | null = null;
  let lastInputs: RestoreOnboardingInputs | null = null;

  // ── Lifecycle ──
  let running = false; // re-entrancy guard for submit/confirm
  let disposed = false;
  let uploadCancel: (() => void) | null = null;
  /** Resolver for an in-flight `runUpload` — `dispose` settles it so the
   *  awaiting `submit` unblocks (the upload seam's cancel settles SILENTLY, never
   *  firing onError/onDone, so the promise would otherwise hang forever). */
  let pendingUploadResolve: ((outcome: UploadOutcome) => void) | null = null;

  const emit = (): void => {
    for (const listener of listeners) listener(state);
  };

  const setState = (patch: Partial<RestoreOnboardingState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  const toCollect = (
    errorStage: RestoreOnboardingErrorStage,
    error: string,
  ): void =>
    setState({
      phase: 'collect',
      error,
      errorStage,
      manifest: null,
      realm: null,
      schemaCompat: null,
      blocked: false,
    });

  const toFatal = (error: string): void =>
    setState({ phase: 'fatal', error, errorStage: null });

  const toPreview = (
    manifest: ArchiveManifest,
    realm: ArchiveRealmRelation,
    schemaCompat: ArchiveSchemaCompat | null,
  ): void =>
    setState({
      phase: 'preview',
      error: null,
      errorStage: null,
      manifest,
      realm,
      schemaCompat,
      blocked: schemaCompat?.status === 'archive_too_new',
    });

  const closeChannel = async (): Promise<void> => {
    const ch = channel;
    channel = null;
    if (ch !== null) {
      try {
        await ch.close();
      } catch {
        /* idempotent best-effort — the server may already have dropped us */
      }
    }
  };

  /** Wrap the callback-style upload seam in a promise + capture the cancel fn so
   *  `dispose` can abort an in-flight upload. */
  const runUpload = (
    ch: RestoreChannel,
    file: ArchiveUploadFile,
  ): Promise<UploadOutcome> =>
    new Promise<UploadOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: UploadOutcome): void => {
        if (settled) return;
        settled = true;
        uploadCancel = null;
        pendingUploadResolve = null;
        resolve(outcome);
      };
      pendingUploadResolve = settle;
      uploadCancel = ch.upload({
        file,
        onProgress: (sent, total) => {
          if (disposed || state.phase !== 'uploading') return;
          setState({ upload: { sent, total } });
        },
        onError: (message) => settle({ ok: false, error: message }),
        onDone: (result) => settle({ ok: true, staged_name: result.staged_name }),
      });
    });

  /** The restore committed (resolved with a rebind, or the restart raced the
   *  response). Stash the rebind, mark done, close the (dead) channel, hand off. */
  const finishRestore = async (
    rebind: ArchiveImportRebind | null,
  ): Promise<void> => {
    if (rebind !== null) {
      try {
        await ops.stashRebind(rebind);
      } catch {
        // Best-effort by contract — a failed stash degrades to the pre-S2b
        // re-pair on the bootstrap's reconnect. Never let it block the handoff.
      }
    }
    if (disposed) return;
    setState({ phase: 'done', error: null, errorStage: null });
    await closeChannel();
    try {
      await onRestored();
    } catch (err) {
      // `runBootstrapWithPairFallback` owns its own failure surface (the splash
      // copy); a throw here is unexpected but must not crash the handoff.
      console.error('restore-onboarding: onRestored handoff failed', err);
    }
  };

  const submit = async (inputs: RestoreOnboardingInputs): Promise<void> => {
    if (disposed || running || state.phase === 'done') return;
    // Once paired, the channel + import resolve the target from local storage —
    // so a retry MUST be for the SAME server we paired to. A different URL means
    // the user wants to restore a different server (can't, this browser is now
    // bound) → terminal: reload to start over.
    if (
      paired &&
      pairedServerUrl !== null &&
      normalizeServerUrlForCompare(inputs.serverUrl) !== pairedServerUrl
    ) {
      lastInputs = inputs;
      toFatal(RESTORE_ONBOARDING_COPY.server_changed);
      return;
    }
    running = true;
    lastInputs = inputs;
    try {
      // 1. Pair + finalize (once). Resume at finalize when a prior attempt got a
      //    bearer but failed to persist — do NOT re-POST /auth/pair.
      if (!paired) {
        setState({ phase: 'pairing', error: null, errorStage: null });
        if (issued === null) {
          const pr = await ops.pairCode({
            serverUrl: inputs.serverUrl,
            code: inputs.code,
          });
          if (disposed) return;
          if (!pr.ok) {
            toCollect('pairing', PAIR_CODE_INPUT_ERROR_COPY[pr.error]);
            return;
          }
          issued = pr;
        }
        const fr = await ops.finalize({
          serverUrl: inputs.serverUrl,
          token: issued.token,
          ...(issued.token_id !== undefined ? { token_id: issued.token_id } : {}),
          ...(issued.passport !== undefined ? { passport: issued.passport } : {}),
        });
        if (disposed) return;
        if (!fr.ok) {
          // `already_paired` means local storage already holds SOME pair — and
          // (since this orchestrator guards re-finalize behind `paired`) it isn't
          // ours: another tab/session paired this browser, possibly to a
          // DIFFERENT server. Opening the channel would target that stale pair,
          // so refuse — terminal, reload to use the existing pair.
          if (fr.error === 'pair_code_success_already_paired') {
            toFatal(RESTORE_ONBOARDING_COPY.already_paired);
            return;
          }
          // Keep `issued` so the retry resumes at finalize (no second
          // /auth/pair — the code may already be spent).
          toCollect('pairing', PAIR_CODE_SUCCESS_ERROR_COPY[fr.error]);
          return;
        }
        paired = true;
        pairedServerUrl = normalizeServerUrlForCompare(inputs.serverUrl);
        issued = null;
      }

      // 2. Open the bearer-authed restore channel (once).
      if (channel === null) {
        try {
          channel = await ops.openChannel();
        } catch {
          if (disposed) return;
          toCollect(null, RESTORE_ONBOARDING_COPY.channel_failed);
          return;
        }
        if (disposed) {
          await closeChannel();
          return;
        }
      }

      // 3. Upload + stage the archive. Skip when the same file is already
      //    staged (a wrong-key retry only re-validates).
      const fileId = fileIdOf(inputs.file);
      let path: string;
      if (stagedName !== null && fileId === uploadedFileId) {
        path = stagedName;
      } else {
        setState({
          phase: 'uploading',
          error: null,
          errorStage: null,
          upload: { sent: 0, total: inputs.file.size },
        });
        const up = await runUpload(channel, inputs.file);
        if (disposed) return;
        if (!up.ok) {
          toCollect('upload', `${RESTORE_ONBOARDING_COPY.upload_failed} ${up.error}`);
          return;
        }
        stagedName = up.staged_name;
        uploadedFileId = fileId;
        path = up.staged_name;
      }

      // 4. Validate — the dry-run proves the archive key BEFORE any commit. A
      //    wrong key bounces to collect with the server still pristine.
      setState({ phase: 'validating', error: null, errorStage: null });
      let dry: Awaited<ReturnType<ArchiveImportCaller>>;
      try {
        dry = await channel.importArchive({
          path,
          recoveryKey: inputs.archiveKey,
          dry_run: true,
        });
      } catch (err) {
        if (disposed) return;
        if (isWrongKeyError(err)) {
          toCollect('validate', RESTORE_ONBOARDING_COPY.wrong_key);
        } else if (isTargetNotEmptyError(err)) {
          toFatal(RESTORE_ONBOARDING_COPY.target_not_empty);
        } else if (isRealmMismatchError(err)) {
          toFatal(RESTORE_ONBOARDING_COPY.realm_mismatch);
        } else {
          toCollect(
            'validate',
            `${RESTORE_ONBOARDING_COPY.validate_failed} ${messageOf(err)}`,
          );
        }
        return;
      }
      if (disposed) return;
      toPreview(dry.manifest, dry.realm, dry.schema_compat ?? null);
    } finally {
      running = false;
    }
  };

  const confirm = async (): Promise<void> => {
    if (disposed || running) return;
    if (state.phase !== 'preview' || state.blocked) return;
    // Defensive — preview is only reachable once these are set.
    if (channel === null || stagedName === null || lastInputs === null) return;
    const path = stagedName;
    const key = lastInputs.archiveKey;
    const ch = channel;
    running = true;
    try {
      setState({ phase: 'restoring', error: null, errorStage: null });
      let result: Awaited<ReturnType<ArchiveImportCaller>>;
      try {
        result = await ch.importArchive({
          path,
          recoveryKey: key,
          dry_run: false,
        });
      } catch (err) {
        if (disposed) return;
        // ★ The committing import restarts the server, so the WS drops right
        //   after the response. An actual socket-drop rejection = the response
        //   raced the drain — the restore committed. Success (no rebind to
        //   stash). A `timeout` is deliberately NOT in this set (see
        //   `isServerRestartDrop`): with the long commit budget it means a
        //   genuine wedge, which falls through to the recoverable error below.
        if (isServerRestartDrop(err)) {
          await finishRestore(null);
          return;
        }
        // The old (fresh, unenrolled) db is intact for every pre-commit
        // rejection — route back to collect so the user can retry. A re-submit
        // skips pair + upload and re-validates, so e.g. a schema-too-new backstop
        // re-renders the blocked preview.
        if (isSchemaTooNewError(err)) {
          toCollect('validate', RESTORE_ONBOARDING_COPY.schema_too_new);
        } else if (isWrongKeyError(err)) {
          toCollect('validate', RESTORE_ONBOARDING_COPY.wrong_key);
        } else if (isTargetNotEmptyError(err)) {
          toFatal(RESTORE_ONBOARDING_COPY.target_not_empty);
        } else if (isRealmMismatchError(err)) {
          toFatal(RESTORE_ONBOARDING_COPY.realm_mismatch);
        } else {
          toCollect(
            'validate',
            `${RESTORE_ONBOARDING_COPY.restore_failed} ${messageOf(err)}`,
          );
        }
        return;
      }
      if (disposed) return;
      await finishRestore(result.rebind ?? null);
    } finally {
      running = false;
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (uploadCancel !== null) {
      try {
        uploadCancel();
      } catch {
        /* cancel is best-effort */
      }
      uploadCancel = null;
    }
    // Unblock an awaiting `runUpload` — the seam's cancel above settles silently.
    if (pendingUploadResolve !== null) {
      pendingUploadResolve({ ok: false, error: 'disposed' });
      pendingUploadResolve = null;
    }
    await closeChannel();
    listeners.clear();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit,
    confirm,
    dispose,
  };
};

// ════════════════════════════════════════════════════════════════
// Production wiring — browser RestoreOps
// ════════════════════════════════════════════════════════════════

export interface BrowserRestoreOpsEnv {
  localStore: WebclientLocalStore;
  /** Roster selector paired with `localStore`. The boot restore path forwards
   *  it into pair finalization so a restored server becomes an explicit
   *  profile selection rather than relying on a `server_url` write hook. */
  profileStore?: Pick<WebclientProfileStore, 'ensureProfile'>;
  tokenStore: WebclientTokenStore;
  /** The paired instance id sent to `/auth/pair` (so the bearer carries
   *  `metadata.instance_id` — required by the WS socket gate) + persisted into
   *  `pair_metadata`. */
  instanceId: string;
  // ── Test seams (production defaults below) ──
  /** Override `globalThis.fetch` for the `/auth/pair` POST. */
  fetch?: typeof fetch;
  /** Fresh WS transport per restore-channel open. Default
   *  `createBrowserWebclientTransport`. */
  transportFactory?: () => WebclientWsTransport;
  /** One-shot `passport.fetch` invoker for finalize. Default built over a fresh
   *  browser transport. */
  invokePassportFetch?: PairPassportInvoker;
}

/** Build the production `RestoreOps` — code-only `/auth/pair`, `finalize`, the
 *  bearer-authed channel (ws-client + rpc + archive upload/import), and the
 *  rebind stash. The channel mirrors `webclient-bootstrap`'s archive wiring (the
 *  same `resolveBearer` unwrap + `/ws/archive-upload` connect), but stands up its
 *  own short-lived ws-client because it runs BEFORE the full bootstrap. */
export const createBrowserRestoreOps = (
  env: BrowserRestoreOpsEnv,
): RestoreOps => {
  const transportFactory =
    env.transportFactory ?? (() => createBrowserWebclientTransport());
  const invokePassportFetch =
    env.invokePassportFetch ??
    createWebclientPairPassportInvoker({ transportFactory });

  const pairCode: RestoreOps['pairCode'] = (inputs) =>
    submitPairCodeInput({
      serverUrl: inputs.serverUrl,
      code: inputs.code,
      instanceId: env.instanceId,
      // Code-only — NO recoveryKey, so the server stays unenrolled.
      ...(env.fetch !== undefined ? { fetch: env.fetch } : {}),
    });

  const finalize: RestoreOps['finalize'] = (args) => {
    const opts: PairCodeSuccessOptions = {
      serverUrl: args.serverUrl,
      bearer: args.token,
      localStore: env.localStore,
      ...(env.profileStore !== undefined
        ? { profileStore: env.profileStore }
        : {}),
      tokenStore: env.tokenStore,
      invokePassportFetch,
      instanceId: env.instanceId,
      // lockProvider omitted ⇒ finalize resolves the default cross-tab lock.
    };
    if (args.token_id !== undefined) opts.token_id = args.token_id;
    if (args.passport !== undefined) opts.passport = args.passport;
    return finalizePairCodeSuccess(opts);
  };

  const openChannel: RestoreOps['openChannel'] = async () => {
    // Hydrate the freshly-persisted pair state (finalize wrote the WS-form
    // server_url + server_public_key + webclient_token).
    const serverUrl = await env.localStore.get('server_url');
    const serverPublicKey = await env.localStore.get('server_public_key');
    const token = await env.localStore.get('webclient_token');
    if (serverUrl === null || serverPublicKey === null || token === null) {
      throw new Error('restore-onboarding: pair state missing after finalize');
    }
    const aad: WebclientTokenAad = {
      token_id: token.token_id,
      server_url: serverUrl,
      server_public_key: serverPublicKey,
    };
    // Re-unwrap the bearer per call (mirrors webclient-bootstrap DD#2 — never
    // cache plaintext). The structured `<token_id>.<plaintext>` shape is what
    // the server's `parseStructuredBearer` verifies at socket upgrade.
    const resolveBearer = async (): Promise<string> => {
      const current = (await env.localStore.get('webclient_token')) ?? token;
      const plaintext = await env.tokenStore.unwrap(current, {
        ...aad,
        token_id: current.token_id,
      });
      return `${current.token_id}.${plaintext}`;
    };

    const transport = transportFactory();
    const ws: WebclientWsClient = createWebclientWsClient({
      transport,
      resolveServerUrl: async () =>
        (await env.localStore.get('server_url')) ?? serverUrl,
      resolveBearer,
    });
    try {
      await ws.connect();
    } catch (err) {
      // A failed connect can leave the ws-client queueing a reconnect — tear it
      // down so a channel-open failure doesn't leak a zombie socket loop.
      await ws.disconnect().catch(() => undefined);
      throw err;
    }
    const rpcConn = createWebclientRpcConn({ ws });

    const importArchive: ArchiveImportCaller = (importArgs) =>
      // Generous budget — the server decrypts the archive before responding, so
      // the default 30s rpc timeout would spuriously fire on a large backup and
      // (for the commit) read as a destructive-success it can't prove.
      rpcConn.call('server.archive.import', importArgs, {
        timeout: RESTORE_IMPORT_TIMEOUT_MS,
      });

    const upload: ArchiveUploadFn = createArchiveUpload({
      // Dedicated binary `/ws/archive-upload` socket (mirrors the bootstrap's
      // archive-upload connect): pinned `…/ws` rewritten, fresh bearer per open,
      // `binaryType='arraybuffer'`.
      connect: async () => {
        const bearer = await resolveBearer();
        const current = (await env.localStore.get('server_url')) ?? serverUrl;
        const base = current.replace(/\/ws(?=$|\?)/, '/ws/archive-upload');
        const separator = base.includes('?') ? '&' : '?';
        const url = `${base}${separator}token=${encodeURIComponent(bearer)}`;
        const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
        if (WsCtor === undefined) {
          throw new Error('restore-onboarding: globalThis.WebSocket unavailable');
        }
        const sock = new WsCtor(url, WEBCLIENT_WS_SUBPROTOCOL);
        sock.binaryType = 'arraybuffer';
        await new Promise<void>((resolve, reject) => {
          sock.addEventListener('open', () => resolve());
          sock.addEventListener('error', () =>
            reject(new Error('archive-upload ws failed to open')),
          );
        });
        return sock as unknown as Upload.UploadSocket;
      },
      callers: {
        create: (createArgs) =>
          rpcConn.call('server.archive.upload.create', createArgs),
        probe: (probeArgs) =>
          rpcConn.call('server.archive.upload.probe', probeArgs),
        finalize: (finalizeArgs) =>
          rpcConn.call('server.archive.upload.finalize', finalizeArgs),
        delete: (deleteArgs) =>
          rpcConn.call('server.archive.upload.delete', deleteArgs),
      },
    });

    const close = async (): Promise<void> => {
      rpcConn.dispose();
      await ws.disconnect();
    };

    return { upload, importArchive, close };
  };

  const stashRebind = createArchiveRebindStash({
    localStore: env.localStore,
    tokenStore: env.tokenStore,
  });

  return { pairCode, finalize, openChannel, stashRebind };
};

// ════════════════════════════════════════════════════════════════
// S3.4 convenience — compose the machine over the browser ops
// ════════════════════════════════════════════════════════════════

export interface BrowserRestoreOnboardingOptions extends BrowserRestoreOpsEnv {
  /** Hand-off on a committed restore (S3.4 wires `runBootstrapWithPairFallback`). */
  onRestored: () => void | Promise<void>;
}

/** One-call wiring for the boot layer: the state machine over the production
 *  browser `RestoreOps`. */
export const createBrowserRestoreOnboarding = (
  opts: BrowserRestoreOnboardingOptions,
): RestoreOnboarding =>
  createRestoreOnboarding({
    ops: createBrowserRestoreOps(opts),
    onRestored: opts.onRestored,
  });
