/** Recovery-key setup state machine + renderer.
 *
 *  Five user-visible stages (plus idle):
 *
 *    idle        — nothing in flight. Default state.
 *    writing     — key has been generated, user is copying it onto
 *                  paper. The generated key is held in memory here
 *                  ONLY. Never persisted, never shown again.
 *    challenging — user clicked "I've written it down"; they must
 *                  re-type the 24 words. Matches the generated key
 *                  → proceed. Doesn't match → error, stay here.
 *    wrapping    — deriving the KEK and building the check blob.
 *                  Short stage; exists so the UI can show a spinner
 *                  during the ~1s PBKDF2.
 *    finalizing  — active when the host wired an `onCompleted`
 *                  callback (e.g. the setup-then-pair flow). The
 *                  check is already stored at this point; we're now
 *                  running the host's follow-on op (POST /auth/pair,
 *                  encrypt the bundle, etc.) before we wipe the key
 *                  + transition to `done`.
 *    done        — check blob persisted. The generated key is wiped
 *                  from memory. User has successfully enrolled.
 *
 *  On any success, the user-facing key is held only transiently
 *  (writing + challenging stages) and is wiped once persistence
 *  completes (done) or the flow is abandoned (reset).
 *
 *  The reducer + handlers are pure over a supplied RecoveryCheckStorage
 *  + a generate/validate/derive crypto seam, so tests inject their own.
 *
 *  Lifted from the extension's `recovery/setup.ts` + `recovery/render.ts`
 *  at `c222acac^`. */

import { generateRecoveryKey, isValidRecoveryKey } from '@recued/crypto';

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
  buildRecoveryKeyCheck,
  verifyRecoveryKeyCheck,
} from './recovery-check-crypto.js';
import {
  type RecoveryCheckStorage,
  writeRecoveryCheck,
} from './recovery-check-store.js';

// ────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────

export type RecoverySetupStage =
  | 'idle'
  | 'writing'
  | 'challenging'
  | 'wrapping'
  | 'finalizing'
  | 'done';

export interface RecoverySetupSlice {
  stage: RecoverySetupStage;
  /** The generated 24-word phrase. Present only during writing +
   *  challenging; wiped on done/reset. Never hits storage. */
  generatedKey: string | null;
  /** Live-typed challenge entry (the canonical joined form). The
   *  renderer splits into 24 slots; paste fans out via the shared
   *  distributeTokens helper from the recovery-grid primitive. */
  challengeEntry: string;
  /** Optional server-pair URL — when filled alongside the recovery
   *  key challenge, the host's onCompleted callback uses these to
   *  pair a server with the just-verified key in one shot. Empty
   *  string = "don't pair, just set up the recovery key". */
  pairServerUrl: string;
  /** Optional server-pair code — must be non-empty alongside
   *  pairServerUrl for the host to attempt the pair. */
  pairServerCode: string;
  /** User-visible error from the last attempt. Cleared on any
   *  successful transition. */
  error: string | null;
}

export const initialRecoverySetupSlice = (): RecoverySetupSlice => ({
  stage: 'idle',
  generatedKey: null,
  challengeEntry: '',
  pairServerUrl: '',
  pairServerCode: '',
  error: null,
});

// ────────────────────────────────────────────────────────────────
// Reducers — pure transitions
// ────────────────────────────────────────────────────────────────

export const keyGenerated = (mnemonic: string): Partial<RecoverySetupSlice> => ({
  stage: 'writing',
  generatedKey: mnemonic,
  challengeEntry: '',
  error: null,
});

export const ackWritten = (): Partial<RecoverySetupSlice> => ({
  stage: 'challenging',
  challengeEntry: '',
  error: null,
});

export const challengeEntryChanged = (value: string): Partial<RecoverySetupSlice> => ({
  challengeEntry: value,
  error: null,
});

/** Bind the optional Server URL field on the challenge stage. The
 *  host's onCompleted callback decides whether to actually use it
 *  (typically: when both URL and code are non-empty). */
export const pairServerUrlChanged = (value: string): Partial<RecoverySetupSlice> => ({
  pairServerUrl: value,
  error: null,
});

/** Bind the optional Pairing Code field on the challenge stage. */
export const pairServerCodeChanged = (value: string): Partial<RecoverySetupSlice> => ({
  pairServerCode: value,
  error: null,
});

export const challengeFailed = (message: string): Partial<RecoverySetupSlice> => ({
  stage: 'challenging',
  error: message,
});

export const wrappingStarted = (): Partial<RecoverySetupSlice> => ({
  stage: 'wrapping',
  error: null,
});

/** Transition between wrap-success and `done` when an `onCompleted`
 *  hook is wired. Lets the renderer show "Encrypting + finalizing…"
 *  instead of "Sealing your recovery check…". */
export const finalizingStarted = (): Partial<RecoverySetupSlice> => ({
  stage: 'finalizing',
  error: null,
});

export const setupCompleted = (): Partial<RecoverySetupSlice> => ({
  ...initialRecoverySetupSlice(),
  stage: 'done',
});

export const setupReset = (): Partial<RecoverySetupSlice> => ({
  ...initialRecoverySetupSlice(),
});

// ────────────────────────────────────────────────────────────────
// Crypto seam — injected so tests don't run real PBKDF2 + bip39
// ────────────────────────────────────────────────────────────────

export interface RecoveryCrypto {
  /** Generate a fresh 24-word mnemonic. Defaults to @recued/crypto's
   *  BIP39 generator. */
  generate(): string;
  /** Validate a user-supplied mnemonic (word count + words in list
   *  + checksum). Defaults to @recued/crypto's BIP39 checker. */
  isValid(mnemonic: string): boolean;
  /** Derive the KEK from a normalized mnemonic. Defaults to the
   *  PBKDF2-based recovery-check KDF — same shape as the original
   *  bundle-crypto path so any host that previously stored a check
   *  via that code path round-trips bit-identically here. */
  deriveKek(mnemonic: string): Promise<CryptoKey>;
  /** Build the AEAD check blob over the fixed sentinel. */
  buildCheck(kek: CryptoKey): Promise<string>;
  /** Verify a candidate KEK unwraps the stored check. Used as the
   *  post-store sanity check so we catch silent corruption. */
  verifyCheck(kek: CryptoKey, check: string): Promise<boolean>;
}

export const defaultRecoveryCrypto: RecoveryCrypto = {
  generate() {
    return generateRecoveryKey().mnemonic;
  },
  isValid(mnemonic) {
    return isValidRecoveryKey(mnemonic);
  },
  deriveKek(mnemonic) {
    return deriveKekFromRecoveryKey(mnemonic);
  },
  buildCheck(kek) {
    return buildRecoveryKeyCheck(kek);
  },
  verifyCheck(kek, check) {
    return verifyRecoveryKeyCheck(kek, check);
  },
};

// ────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────

export interface RecoverySetupHandlerDeps {
  getSlice: () => RecoverySetupSlice;
  setState: (patch: Partial<RecoverySetupSlice>) => void;
  storage: RecoveryCheckStorage;
  /** Override for tests. Defaults to the real crypto stack. */
  crypto?: RecoveryCrypto;
  /** Optional: invoked after the check is stored, with the user's
   *  just-verified recovery key still in memory. Lets a caller
   *  (e.g. the pair flow) consume the key for an immediate follow-on
   *  operation, without requiring the user to type it again. The
   *  handler awaits this; only after it resolves does the key get
   *  wiped + the stage flips to `done`. On reject, the key is wiped
   *  anyway and the error surfaces — the check is already saved, so
   *  the user can retry the follow-on op via whatever surface
   *  triggered the setup. */
  onCompleted?: (recoveryKey: string) => Promise<void>;
}

export interface RecoverySetupHandlers {
  /** Begin the flow. Generates a fresh key, transitions to `writing`. */
  start(): void;
  /** User acknowledged they wrote the key down. Moves to challenge. */
  ackWritten(): void;
  /** Live-type binding for the challenge input. */
  setChallengeEntry(value: string): void;
  /** Submit the typed challenge. Validates BIP39, compares to the
   *  generated key, then wraps + stores the check. On success the
   *  generated key is wiped from state. */
  submitChallenge(): Promise<void>;
  /** Abandon the flow from any stage. Wipes the generated key. */
  reset(): void;
}

/** Normalize to the canonical comparison form — lowercase, single
 *  spaces, trimmed. Matches the KDF's normalize so a user who types
 *  "Abandon  Ability …" still matches the generated "abandon ability …"
 *  form. */
const normalize = (s: string): string =>
  s.trim().replace(/\s+/g, ' ').toLowerCase();

export const createRecoverySetupHandlers = (
  deps: RecoverySetupHandlerDeps,
): RecoverySetupHandlers => {
  const crypto = deps.crypto ?? defaultRecoveryCrypto;

  const start = (): void => {
    const mnemonic = crypto.generate();
    deps.setState(keyGenerated(mnemonic));
  };

  const ackWrittenHandler = (): void => {
    // Only meaningful from the `writing` stage. Silently no-op
    // otherwise so a double-click can't derail the flow.
    if (deps.getSlice().stage !== 'writing') return;
    deps.setState(ackWritten());
  };

  const setChallengeEntry = (value: string): void => {
    deps.setState(challengeEntryChanged(value));
  };

  const submitChallenge = async (): Promise<void> => {
    const slice = deps.getSlice();
    if (slice.stage !== 'challenging' || !slice.generatedKey) return;

    const entered = normalize(slice.challengeEntry);
    const generated = normalize(slice.generatedKey);

    // Client-side defense: BIP39 checksum catches single-word typos
    // even before we compare against the generated key. Gives a
    // clearer error than "doesn't match" when a word is misspelled.
    if (!crypto.isValid(entered)) {
      deps.setState(
        challengeFailed(
          'That does not look like a 24-word recovery key. Check for typing mistakes or missing words.',
        ),
      );
      return;
    }

    if (entered !== generated) {
      deps.setState(
        challengeFailed(
          'That does not match the key Recued just made. Check what you wrote down.',
        ),
      );
      return;
    }

    // Key verified — wrap + store.
    deps.setState(wrappingStarted());
    try {
      const kek = await crypto.deriveKek(entered);
      const check = await crypto.buildCheck(kek);

      // Round-trip sanity: derive + verify before persisting. Rules
      // out the astronomically-unlikely case where the KEK derivation
      // is non-deterministic due to some platform bug.
      const ok = await crypto.verifyCheck(kek, check);
      if (!ok) {
        deps.setState(
          challengeFailed(
            'Recued could not check its own work. Try again.',
          ),
        );
        return;
      }

      await writeRecoveryCheck(deps.storage, check);

      // Optional follow-on op (pair, register, etc.) — runs with the
      // entered key still in memory. Caller awaits, then we wipe +
      // transition. On failure we land in a terminal `done`-with-error
      // state: the check IS saved, so setup itself succeeded; only
      // the follow-up failed. We wipe the key material (no business
      // sitting in UI state) and land in `done` (NOT `challenging`)
      // because the challenge form without a `generatedKey` would
      // re-render but every submit would silently no-op, leaving the
      // user typing into a dead form. Retry of the follow-up is the
      // caller's concern via whatever surface triggered the setup.
      if (deps.onCompleted) {
        deps.setState(finalizingStarted());
        try {
          await deps.onCompleted(entered);
        } catch (err) {
          deps.setState({
            ...initialRecoverySetupSlice(),
            stage: 'done',
            error: `Setup saved, but the follow-up step failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }

      deps.setState(setupCompleted());
    } catch (err) {
      deps.setState(
        challengeFailed(
          `Could not store the recovery check: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  };

  const reset = (): void => {
    deps.setState(setupReset());
  };

  return {
    start,
    ackWritten: ackWrittenHandler,
    setChallengeEntry,
    submitChallenge,
    reset,
  };
};

// ────────────────────────────────────────────────────────────────
// Renderer — pure over RecoverySetupSlice
// ────────────────────────────────────────────────────────────────

export interface RecoverySetupRenderOptions {
  /** When true, the challenging stage exposes optional Server URL +
   *  Pairing Code inputs below the 24-slot grid. The host's
   *  `onCompleted` callback consumes those values to pair the server
   *  with the just-verified recovery key. Default false — keeps
   *  surfaces that don't want the pair UX (e.g. an export-only flow)
   *  free of clutter. */
  includeOptionalPair?: boolean;
}

export const renderRecoverySetup = (
  slice: RecoverySetupSlice,
  opts: RecoverySetupRenderOptions = {},
): string => {
  switch (slice.stage) {
    case 'idle':
      return renderIdle();
    case 'writing':
      return renderWriting(slice);
    case 'challenging':
      return renderChallenging(slice, opts);
    case 'wrapping':
      return renderWrapping('Sealing your recovery check…');
    case 'finalizing':
      return renderWrapping('Encrypting + finalizing…');
    case 'done':
      return renderDone(slice);
  }
};

const renderIdle = (): string => panel({
  tone: 'info',
  title: 'Protect your data with a recovery key',
  extraClass: 'rx-recovery-flow',
  body: `
    <p>
      Your recovery key is a 24-word phrase that unlocks your data if
      you lose this device. Nobody — including Recued — can recover
      it for you. Set one up now and write it on paper.
    </p>
    ${actionBar({
      extraClass: 'rx-recovery-actions',
      align: 'end',
      children: [
        button({
          label: 'Set up recovery key',
          variant: 'primary',
          size: 'xs',
          action: 'recovery-setup-start',
        }),
      ],
    })}
  `,
});

const renderWriting = (slice: RecoverySetupSlice): string => {
  const key = slice.generatedKey;
  if (!key) {
    return panel({
      tone: 'warn',
      body: '<p>Missing generated key — please cancel and try again.</p>',
    });
  }
  const words = key.split(/\s+/);
  const grid = words.map((w, i) => `
    <div class="rx-recovery-word rx-recovery-word-readonly">
      <label>${i + 1}</label>
      <span>${e(w)}</span>
    </div>
  `).join('');

  return panel({
    tone: 'warn',
    title: 'Write down this recovery key',
    extraClass: 'rx-recovery-flow',
    body: `
      <p>
        This is the <strong>only way</strong> to recover your data if
        you lose this device or forget your password. Write it on
        paper, store it somewhere safe, and do NOT share it.
      </p>
      <div class="rx-recovery-words rx-recovery-words-readonly">
        ${grid}
      </div>
      <p class="field-hint">
        We'll ask you to re-type it on the next screen to confirm you
        saved it correctly.
      </p>
      ${actionBar({
        extraClass: 'rx-recovery-actions',
        bordered: true,
        align: 'end',
        children: [
          button({
            label: 'Cancel',
            size: 'xs',
            action: 'recovery-setup-cancel',
          }),
          button({
            label: 'I\'ve written it down — continue',
            variant: 'primary',
            size: 'xs',
            action: 'recovery-setup-ack-written',
          }),
        ],
      })}
    `,
  });
};

const renderChallenging = (
  slice: RecoverySetupSlice,
  opts: RecoverySetupRenderOptions,
): string => {
  const words = toRecoveryWords(slice.challengeEntry);
  const filled = words.filter((w) => w.length > 0).length;

  return panel({
    tone: 'info',
    title: 'Confirm your recovery key',
    extraClass: 'rx-recovery-flow',
    body: `
      <p>
        Type the 24 words from your paper copy to confirm you saved
        them correctly. Case-insensitive. Paste into any box to fan
        the phrase out across the rest.
      </p>
      ${recoveryGrid({
        words,
        fieldName: 'recovery-field',
        fieldValue: 'challenge-word',
        idPrefix: 'rx-recovery-word',
      })}
      ${opts.includeOptionalPair ? renderOptionalPairFields(slice) : ''}
      ${slice.error ? inlineError(slice.error) : ''}
      ${actionBar({
        extraClass: 'rx-recovery-actions',
        bordered: true,
        align: 'end',
        children: [
          button({
            label: 'Cancel',
            size: 'xs',
            action: 'recovery-setup-cancel',
          }),
          button({
            label: 'Confirm and save',
            variant: 'primary',
            size: 'xs',
            action: 'recovery-setup-submit',
            disabled: filled < 24,
          }),
        ],
      })}
    `,
  });
};

/** Optional "pair a server now" fields, embedded inside the challenge
 *  stage. Wrapped in a `<details>` so users who don't have a server
 *  ready see only the summary line, not a 2-input form they have to
 *  scroll past. Both fields must be non-empty for the host's
 *  onCompleted to attempt the pair — leaving either blank skips the
 *  pair entirely (setup completes as if no pair info was given).
 *
 *  Open by default when EITHER field already has content, so a host
 *  that pre-populates them (e.g. from a deep link) doesn't make the
 *  user click the disclosure to see what they typed. */
const renderOptionalPairFields = (slice: RecoverySetupSlice): string => {
  const open = slice.pairServerUrl.length > 0 || slice.pairServerCode.length > 0;
  return `
    <details class="rx-recovery-optional-pair" ${open ? 'open' : ''}>
      <summary>Pair a server now (optional)</summary>
      <p class="field-hint">
        Have a recued-server running? Enter its URL and the pairing
        code from its console — we'll seed the recovery key into the
        server in the same step.
      </p>
      <div class="form-row">
        <label for="rx-recovery-pair-url">Server URL</label>
        <input id="rx-recovery-pair-url"
          type="url"
          data-recovery-pair-field="server-url"
          value="${e(slice.pairServerUrl)}"
          placeholder="http://localhost:7717"
          autocomplete="off" />
      </div>
      <div class="form-row">
        <label for="rx-recovery-pair-code">Pairing code</label>
        <input id="rx-recovery-pair-code"
          type="text"
          data-recovery-pair-field="server-code"
          value="${e(slice.pairServerCode)}"
          placeholder="From server terminal"
          autocomplete="off"
          style="text-transform:uppercase; letter-spacing:0.15em; font-family:monospace" />
      </div>
    </details>
  `;
};

const renderWrapping = (label: string): string => panel({
  tone: 'neutral',
  compact: true,
  extraClass: 'rx-recovery-flow',
  role: 'status',
  body: `<p>${label}</p>`,
});

const renderDone = (slice: RecoverySetupSlice): string => {
  // When the follow-up step failed after the recovery check was
  // already saved, we land in `done` with an error preserved. Render
  // a warning variant so the user understands both (a) the key is
  // safely set up and (b) the follow-on action (pair, export, etc.)
  // needs to be retried from the surface that triggered it.
  if (slice.error) {
    return panel({
      tone: 'warn',
      title: 'Recovery key saved — follow-up failed',
      extraClass: 'rx-recovery-flow',
      body: `
        <p>${e(slice.error)}</p>
        <p>
          Your recovery key is safely stored on this device. Retry
          the follow-up step from the surface that triggered this
          setup, or dismiss this view.
        </p>
        ${actionBar({
          extraClass: 'rx-recovery-actions',
          align: 'end',
          children: [
            button({
              label: 'Dismiss',
              variant: 'primary',
              size: 'xs',
              action: 'recovery-setup-dismiss',
            }),
          ],
        })}
      `,
    });
  }
  return panel({
    tone: 'info',
    title: 'Recovery key saved',
    extraClass: 'rx-recovery-flow',
    body: `
      <p>
        Your recovery key is set up. We've stored a verifier so we can
        confirm the key later — not the key itself. Keep your paper copy
        safe; it's the only way in if you lose this device.
      </p>
      ${actionBar({
        extraClass: 'rx-recovery-actions',
        align: 'end',
        children: [
          button({
            label: 'Done',
            variant: 'primary',
            size: 'xs',
            action: 'recovery-setup-dismiss',
          }),
        ],
      })}
    `,
  });
};
