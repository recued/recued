/** Recovery-key entry primitive + renderer — shared by every "enter
 *  your already-set-up recovery key" flow (export, server pair,
 *  recover-pair).
 *
 *  Different lifecycle from `recovery-setup.ts`: this primitive
 *  doesn't generate, doesn't show, doesn't challenge — the user just
 *  types their existing key, we validate it locally (BIP39 checksum +
 *  match against the stored `recovery_key_check`), then hand the key
 *  to a caller-supplied `onSubmit` callback that does the real work
 *  (pair, export, recover, etc.).
 *
 *  Like setup, we never persist the key. It lives in memory only for
 *  the duration of the entry → submit cycle.
 *
 *  Lifted from the extension's `recovery/entry.ts` + `recovery/entry-render.ts`
 *  at `c222acac^`. */

import { isValidRecoveryKey } from '@recued/crypto';

import { e } from '../template.js';
import {
  actionBar,
  button,
  inlineError,
  panel,
  recoveryGrid,
} from '../primitives/index.js';
import { toRecoveryWords } from '../recovery-words.js';

import {
  deriveKekFromRecoveryKey,
  verifyRecoveryKeyCheck,
} from './recovery-check-crypto.js';
import {
  type RecoveryCheckStorage,
  readRecoveryCheck,
} from './recovery-check-store.js';

// ────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────

export type RecoveryKeyEntryStage =
  | 'idle'
  | 'entering'
  | 'verifying'
  | 'submitting'
  | 'done';

export interface RecoveryKeyEntrySlice {
  stage: RecoveryKeyEntryStage;
  /** Live-typed entry — joined-string canonical form, same shape as
   *  the recovery-grid primitive's pasted input. The renderer splits
   *  to 24 slots; paste fans out via the shared distributeTokens
   *  helper. */
  entry: string;
  /** Surfaced error: BIP39 invalid, doesn't match local check, submit
   *  callback failed. Cleared on any successful transition. */
  error: string | null;
}

export const initialRecoveryKeyEntrySlice = (): RecoveryKeyEntrySlice => ({
  stage: 'idle',
  entry: '',
  error: null,
});

// ────────────────────────────────────────────────────────────────
// Reducers
// ────────────────────────────────────────────────────────────────

export const entryStarted = (): Partial<RecoveryKeyEntrySlice> => ({
  stage: 'entering',
  entry: '',
  error: null,
});

export const entryChanged = (value: string): Partial<RecoveryKeyEntrySlice> => ({
  entry: value,
  error: null,
});

export const verifyingStarted = (): Partial<RecoveryKeyEntrySlice> => ({
  stage: 'verifying',
  error: null,
});

export const submittingStarted = (): Partial<RecoveryKeyEntrySlice> => ({
  stage: 'submitting',
  error: null,
});

export const entryFailed = (message: string): Partial<RecoveryKeyEntrySlice> => ({
  stage: 'entering',
  error: message,
});

export const entryDone = (): Partial<RecoveryKeyEntrySlice> => ({
  ...initialRecoveryKeyEntrySlice(),
  stage: 'done',
});

export const entryReset = (): Partial<RecoveryKeyEntrySlice> => ({
  ...initialRecoveryKeyEntrySlice(),
});

// ────────────────────────────────────────────────────────────────
// Crypto seam — injected so tests stay deterministic
// ────────────────────────────────────────────────────────────────

export interface RecoveryEntryCrypto {
  isValid(mnemonic: string): boolean;
  deriveKek(mnemonic: string): Promise<CryptoKey>;
  verifyCheck(kek: CryptoKey, check: string): Promise<boolean>;
}

export const defaultRecoveryEntryCrypto: RecoveryEntryCrypto = {
  isValid: (m) => isValidRecoveryKey(m),
  deriveKek: (m) => deriveKekFromRecoveryKey(m),
  verifyCheck: (k, c) => verifyRecoveryKeyCheck(k, c),
};

// ────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────

export interface RecoveryKeyEntryDeps {
  getSlice: () => RecoveryKeyEntrySlice;
  setState: (patch: Partial<RecoveryKeyEntrySlice>) => void;
  /** Storage holding the local `recovery_key_check` blob. Always
   *  required — entry is for "use the key you already set up", and
   *  the verify step is what catches typos client-side before
   *  shipping the key to the server / encryption pipeline. */
  storage: RecoveryCheckStorage;
  /** Required: invoked after the key has passed local verification.
   *  Caller does the real operation (pair, export, recover) and
   *  returns. On resolve → 'done'. On reject → 'entering' with the
   *  error message surfaced. */
  onSubmit: (recoveryKey: string) => Promise<void>;
  /** Crypto override for tests. */
  crypto?: RecoveryEntryCrypto;
}

export interface RecoveryKeyEntryHandlers {
  start(): void;
  setEntry(value: string): void;
  submit(): Promise<void>;
  cancel(): void;
}

const normalize = (s: string): string =>
  s.trim().replace(/\s+/g, ' ').toLowerCase();

export const createRecoveryKeyEntryHandlers = (
  deps: RecoveryKeyEntryDeps,
): RecoveryKeyEntryHandlers => {
  const crypto = deps.crypto ?? defaultRecoveryEntryCrypto;

  const start = (): void => {
    deps.setState(entryStarted());
  };

  const setEntry = (value: string): void => {
    deps.setState(entryChanged(value));
  };

  const submit = async (): Promise<void> => {
    const slice = deps.getSlice();
    if (slice.stage !== 'entering') return;
    const normalized = normalize(slice.entry);

    // Stage 1: BIP39 checksum — catches single-word typos with a
    // clearer error than "doesn't match" before we touch the KDF.
    if (!crypto.isValid(normalized)) {
      deps.setState(
        entryFailed(
          'That does not look like a 24-word recovery key. Check for typing mistakes or missing words.',
        ),
      );
      return;
    }

    // Stage 2: verify against local check — the device knows what
    // the right key looks like (from setup or import enrollment).
    deps.setState(verifyingStarted());
    let storedCheck: string | null;
    try {
      storedCheck = await readRecoveryCheck(deps.storage);
    } catch {
      storedCheck = null;
    }
    if (!storedCheck) {
      // No local check enrolled — the entry primitive shouldn't be
      // mounted in this case (caller should have routed to setup
      // instead). Surface a clear error rather than silently passing.
      deps.setState(
        entryFailed(
          'This device has no recovery key yet. Set one up first.',
        ),
      );
      return;
    }
    let kek: CryptoKey;
    try {
      kek = await crypto.deriveKek(normalized);
    } catch (err) {
      deps.setState(
        entryFailed(
          `Could not derive the recovery key: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    const ok = await crypto.verifyCheck(kek, storedCheck);
    if (!ok) {
      deps.setState(
        entryFailed(
          'That does not match the key on this device. Check what you wrote down and type it again.',
        ),
      );
      return;
    }

    // Stage 3: hand the key to the caller. They do the real work
    // (pair, export, recover); we just orchestrate the lifecycle.
    deps.setState(submittingStarted());
    try {
      await deps.onSubmit(normalized);
      deps.setState(entryDone());
    } catch (err) {
      // Wipe `entry` on post-verification submit failure — the key
      // has already done its job (verified + handed to onSubmit), so
      // there's no reason to keep all 24 words sitting in UI state
      // for the next render of the grid. The error surfaces above
      // the cleared grid so the user can retype + retry if they
      // want, or navigate away.
      deps.setState({
        ...entryFailed(err instanceof Error ? err.message : String(err)),
        entry: '',
      });
    }
  };

  const cancel = (): void => {
    deps.setState(entryReset());
  };

  return { start, setEntry, submit, cancel };
};

// ────────────────────────────────────────────────────────────────
// Renderer — pure over RecoveryKeyEntrySlice + caller-supplied
// presentation context. Lets the same widget power "enter to pair",
// "enter to export", "enter to recover" — the surface text is the
// only thing that differs between contexts.
// ────────────────────────────────────────────────────────────────

export interface RecoveryKeyEntryRenderProps {
  slice: RecoveryKeyEntrySlice;
  /** Card title, e.g. "Enter your recovery key to pair" / "Enter your
   *  recovery key to export". */
  title: string;
  /** Lead paragraph above the slot grid. Plain text; HTML-escaped. */
  body: string;
  /** Submit button label, e.g. "Pair now" / "Encrypt + download". */
  submitLabel: string;
  /** Data-action attribute names for the submit and cancel buttons.
   *  Lets the host distinguish "I'm submitting a pair entry" from
   *  "I'm submitting an export entry" via a single dispatcher. */
  submitAction: string;
  cancelAction: string;
  /** Data-attribute name to bind each slot's input. The webclient
   *  uses `recovery-field`; another surface can use a different name
   *  to avoid collisions if a second entry component is open in the
   *  same DOM. */
  dataField: string;
  /** Slot id prefix — `${prefix}-${index}` becomes the input id, so
   *  each entry component on a page has unique ids. */
  idPrefix: string;
}

export const renderRecoveryKeyEntry = (props: RecoveryKeyEntryRenderProps): string => {
  const slice = props.slice;
  if (slice.stage === 'idle' || slice.stage === 'done') return '';

  const submitting = slice.stage === 'submitting' || slice.stage === 'verifying';
  const words = toRecoveryWords(slice.entry);
  const filled = words.filter((w) => w.length > 0).length;

  return panel({
    tone: 'info',
    title: props.title,
    extraClass: 'rx-recovery-flow rx-recovery-entry',
    body: `
      <p>${e(props.body)}</p>
      ${recoveryGrid({
        words,
        fieldName: props.dataField,
        fieldValue: 'entry-word',
        idPrefix: props.idPrefix,
        disabled: submitting,
      })}
      ${slice.error ? inlineError(slice.error) : ''}
      ${slice.stage === 'verifying' ? '<p class="field-hint">Verifying…</p>' : ''}
      ${slice.stage === 'submitting' ? '<p class="field-hint">Working…</p>' : ''}
      ${actionBar({
        extraClass: 'rx-recovery-actions',
        bordered: true,
        align: 'end',
        children: [
          button({
            label: 'Cancel',
            size: 'xs',
            action: props.cancelAction,
            disabled: submitting,
          }),
          button({
            label: props.submitLabel,
            variant: 'primary',
            size: 'xs',
            action: props.submitAction,
            disabled: filled < 24 || submitting,
          }),
        ],
      })}
    `,
  });
};
