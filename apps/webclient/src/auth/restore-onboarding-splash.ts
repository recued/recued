/** M5 S3.3 — the splash progress/preview surface for the pre-pair "Restore
 *  from backup" flow.
 *
 *  This is the VIEW over the S3.2 orchestrator (`restore-onboarding.ts`): it
 *  subscribes to the `RestoreOnboarding` handle and renders one screen per
 *  phase into the boot splash —
 *
 *    pairing / validating / restoring → a status line
 *    uploading                        → a byte-progress bar
 *    preview                          → the archive manifest + a two-tap
 *                                       confirm (or, when the backup needs a
 *                                       newer server, an upgrade block + Cancel)
 *    done                             → a transitional "starting Recued…"
 *    fatal                            → the terminal error + a Reload affordance
 *    collect (a recoverable bounce)   → re-mount the pair-host restore form via
 *                                       the injected `mountCollectForm` seam
 *
 *  ── Why the collect form is a seam, not inline ────────────────────────────
 *
 *  The COLLECT form is the pair-host's `restore` mode (`pair-code-input-host.ts`)
 *  — it owns the field rendering, the file picker, and the `onRestoreSubmit`
 *  hand-off. The boot layer (S3.4) is the only place with the token / local
 *  stores the orchestrator needs, so it wires `mountCollectForm` to mount the
 *  pair host (re-seeding the retained file + the bounce notice). This surface
 *  just delegates on a `collect` bounce and disposes that handle before it takes
 *  the splash element back for a progress phase (so the pair host's delegated
 *  listeners never leak onto the shared element).
 *
 *  Pure over its injected seams (`mountCollectForm`, `onReload`, `document`) so
 *  every phase render is testable against a fake orchestrator + a string-
 *  innerHTML fake DOM — the same discipline as `pair-code-input-host`. */

import { e } from '@recued/ui-shared/template';

import {
  RESTORE_ONBOARDING_COPY,
  type RestoreOnboarding,
  type RestoreOnboardingErrorStage,
  type RestoreOnboardingState,
} from './restore-onboarding.js';

// ════════════════════════════════════════════════════════════════
// Stable DOM ids + actions — tests read these.
// ════════════════════════════════════════════════════════════════

export const RESTORE_SPLASH_ROOT_ID = 'webclient-restore-splash';
export const RESTORE_SPLASH_CONFIRM_ID = 'webclient-restore-splash-confirm';
export const RESTORE_SPLASH_CANCEL_ID = 'webclient-restore-splash-cancel';
export const RESTORE_SPLASH_RELOAD_ID = 'webclient-restore-splash-reload';
export const RESTORE_SPLASH_PROGRESS_ID = 'webclient-restore-splash-progress';

const RESTORE_SPLASH_CONFIRM_ACTION = 'restore-splash-confirm';
const RESTORE_SPLASH_CANCEL_ACTION = 'restore-splash-cancel';
const RESTORE_SPLASH_RELOAD_ACTION = 'restore-splash-reload';

// ════════════════════════════════════════════════════════════════
// Public surface
// ════════════════════════════════════════════════════════════════

/** A recoverable bounce back to `collect`: the orchestrator's user-facing copy
 *  + which step bounced. S3.4 maps `stage` onto a pair-host focus field. */
export interface RestoreCollectNotice {
  message: string;
  stage: RestoreOnboardingErrorStage;
}

/** Handle the splash disposes when it leaves a `collect` bounce. */
export interface RestoreCollectHandle {
  dispose(): void;
}

export interface RestoreOnboardingSplashDeps {
  /** The boot splash slot — shared with the pair host on a `collect` bounce. */
  splashElement: HTMLElement;
  /** The S3.2 orchestrator. The surface subscribes + drives `confirm`/`dispose`. */
  onboarding: RestoreOnboarding;
  /** Re-mount the collect form (pair-host restore mode) on a `collect` bounce.
   *  S3.4 wires this; returns a disposable. */
  mountCollectForm: (notice: RestoreCollectNotice) => RestoreCollectHandle;
  /** Reload affordance for the terminal `fatal` phase + the preview Cancel.
   *  S3.4 wires `globalThis.location.reload()`. */
  onReload: () => void;
  /** Document seam (tests). */
  document?: Document;
}

export interface MountedRestoreOnboardingSplash {
  /** View teardown — unsubscribe + drop the click listener + dispose a mounted
   *  collect form. Does NOT dispose the orchestrator (S3.4 owns its lifecycle)
   *  and does NOT clobber the last-rendered DOM (so a `done` hand-off keeps its
   *  "starting Recued…" copy until the bootstrap mounts). */
  dispose(): void;
}

interface DelegatedEventTarget {
  closest?(selector: string): HTMLElement | null;
}

// ════════════════════════════════════════════════════════════════
// Stylesheet (mirrors the pair host's self-scoped injection)
// ════════════════════════════════════════════════════════════════

const RESTORE_SPLASH_STYLES_MARKER = 'data-recued-restore-splash-styles';

const RESTORE_SPLASH_STYLES = `
.restore-splash {
  width: min(420px, calc(100vw - 32px));
  margin: 0 auto;
  text-align: left;
}
.restore-splash-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 650;
  color: var(--fg);
}
.restore-splash-detail {
  margin: 0 0 8px;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.45;
}
.restore-splash-progress-track {
  height: 8px;
  border-radius: 999px;
  background: var(--surface-sunk);
  overflow: hidden;
  margin: 4px 0 8px;
}
.restore-splash-progress-bar {
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
}
.restore-splash-manifest {
  margin: 0 0 12px;
  padding: 10px 12px;
  list-style: none;
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg);
  line-height: 1.6;
}
.restore-splash-manifest li { margin: 0; }
.restore-splash-realm {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--fg-muted);
}
.restore-splash-error {
  margin: 0 0 12px;
  padding: 8px 10px;
  background: var(--danger-weak);
  color: var(--danger);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.restore-splash-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.restore-splash-actions button {
  flex: 1;
  padding: 9px 12px;
  font: inherit;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
}
.restore-splash-confirm {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
}
.restore-splash-confirm.is-armed {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--on-accent, #fff);
}
.restore-splash-secondary {
  background: var(--surface-sunk);
  color: var(--fg);
  border: 1px solid var(--border);
}
`;

const ensureRestoreSplashStyles = (doc: Document): void => {
  try {
    const head = doc.head;
    if (!head || typeof doc.createElement !== 'function') return;
    if (head.querySelector?.(`style[${RESTORE_SPLASH_STYLES_MARKER}]`)) return;
    const style = doc.createElement('style');
    style.setAttribute(RESTORE_SPLASH_STYLES_MARKER, '');
    style.textContent = RESTORE_SPLASH_STYLES;
    head.appendChild(style);
  } catch {
    /* minimal/non-DOM fake-doc env (tests) — styling is non-essential */
  }
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountRestoreOnboardingSplash = (
  deps: RestoreOnboardingSplashDeps,
): MountedRestoreOnboardingSplash => {
  const { splashElement, onboarding, mountCollectForm, onReload } = deps;
  const doc = deps.document ?? globalThis.document;
  ensureRestoreSplashStyles(doc);

  let disposed = false;
  /** The pair-host restore form while on a `collect` bounce; null otherwise. */
  let collectHandle: RestoreCollectHandle | null = null;
  /** Two-tap confirm — surface-local (not orchestrator state). First tap arms,
   *  second commits; reset whenever the phase leaves `preview`. */
  let armed = false;
  /** Last orchestrator state, so the arm tap can re-render the same phase. */
  let current: RestoreOnboardingState = onboarding.getState();

  const teardownCollectForm = (): void => {
    if (collectHandle !== null) {
      try {
        collectHandle.dispose();
      } catch {
        /* best-effort */
      }
      collectHandle = null;
    }
  };

  const paint = (s: RestoreOnboardingState): void => {
    if (disposed) return;
    current = s;
    if (s.phase !== 'preview') armed = false;

    // A recoverable bounce (`collect` WITH an error) re-shows the pair-host
    // restore form. The initial `collect` (error null, before the first submit)
    // is transient — render a neutral placeholder rather than a redundant
    // re-mount, since S3.4 calls `submit` immediately after mounting us.
    if (s.phase === 'collect' && s.error !== null) {
      if (collectHandle === null) {
        collectHandle = mountCollectForm({ message: s.error, stage: s.errorStage });
      }
      return;
    }

    // Every phase the surface owns the DOM for — drop a mounted collect form
    // first so the pair host's listeners don't leak onto the splash element.
    teardownCollectForm();
    splashElement.innerHTML = renderPhase(s, armed);
  };

  // ── Delegated click listener (confirm / cancel / reload) ──
  const onClick = (event: Event): void => {
    const target = event.target as DelegatedEventTarget | null;
    if (!target) return;
    if (target.closest?.(`[data-action="${RESTORE_SPLASH_CONFIRM_ACTION}"]`)) {
      // Two-tap: arm on the first click, commit on the second.
      if (!armed) {
        armed = true;
        paint(current);
      } else {
        armed = false;
        void onboarding.confirm();
      }
      return;
    }
    if (target.closest?.(`[data-action="${RESTORE_SPLASH_CANCEL_ACTION}"]`)) {
      void cancel();
      return;
    }
    if (target.closest?.(`[data-action="${RESTORE_SPLASH_RELOAD_ACTION}"]`)) {
      onReload();
      return;
    }
  };

  const cancel = async (): Promise<void> => {
    // Back out of a restore: tear the orchestrator down (closes its channel +
    // abandons the staged upload server-side) and reload to start over.
    try {
      await onboarding.dispose();
    } catch {
      /* best-effort */
    }
    if (!disposed) onReload();
  };

  splashElement.addEventListener('click', onClick);
  const unsubscribe = onboarding.subscribe(paint);
  paint(onboarding.getState());

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      teardownCollectForm();
      splashElement.removeEventListener('click', onClick);
      // Intentionally leave the last-rendered DOM in place (see interface doc).
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Per-phase HTML
// ════════════════════════════════════════════════════════════════

const wrap = (phase: string, inner: string): string => `
  <div id="${e(RESTORE_SPLASH_ROOT_ID)}" class="restore-splash" data-restore-phase="${e(phase)}">
    ${inner}
  </div>
`;

const statusScreen = (phase: string, title: string, detail?: string): string =>
  wrap(
    phase,
    `<h2 class="restore-splash-title">${e(title)}</h2>${
      detail ? `<p class="restore-splash-detail">${e(detail)}</p>` : ''
    }`,
  );

const renderPhase = (s: RestoreOnboardingState, armed: boolean): string => {
  switch (s.phase) {
    case 'collect':
      // Only the initial (error-null) collect reaches here — the bounce path is
      // handled by the collect-form seam before render.
      return statusScreen('collect', 'Preparing restore…');
    case 'pairing':
      return statusScreen('pairing', 'Pairing with your server…');
    case 'uploading':
      return renderUploading(s);
    case 'validating':
      return statusScreen(
        'validating',
        'Checking your backup…',
        'Verifying the recovery key and reading the backup.',
      );
    case 'preview':
      return renderPreview(s, armed);
    case 'restoring':
      return statusScreen(
        'restoring',
        'Restoring your backup…',
        'Writing your data. Your server will restart when it finishes.',
      );
    case 'done':
      return statusScreen('done', 'Restore complete — starting Recued…');
    case 'fatal':
      return renderFatal(s);
  }
};

const renderUploading = (s: RestoreOnboardingState): string => {
  const { sent, total } = s.upload;
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((sent / total) * 100))) : 0;
  return wrap(
    'uploading',
    `
    <h2 class="restore-splash-title">Uploading your backup…</h2>
    <div class="restore-splash-progress-track">
      <div id="${e(RESTORE_SPLASH_PROGRESS_ID)}"
        class="restore-splash-progress-bar"
        data-restore-progress="${pct}"
        style="width:${pct}%"></div>
    </div>
    <p class="restore-splash-detail">${pct}% uploaded</p>
  `,
  );
};

const renderPreview = (s: RestoreOnboardingState, armed: boolean): string => {
  // schema-too-new — mirror the backup panel's `archive_too_new` block: the
  // upgrade message + a Cancel-only action (no confirm, no commit).
  if (s.blocked) {
    const detail = s.schemaCompat
      ? ` (this server: schema v${s.schemaCompat.server_schema_version})`
      : '';
    return wrap(
      'preview',
      `
      <h2 class="restore-splash-title">This backup needs a newer server</h2>
      <p class="restore-splash-error" role="status">${e(RESTORE_ONBOARDING_COPY.schema_too_new)}${e(detail)}</p>
      <div class="restore-splash-actions">
        <button id="${e(RESTORE_SPLASH_CANCEL_ID)}" type="button"
          class="restore-splash-secondary"
          data-action="${e(RESTORE_SPLASH_CANCEL_ACTION)}">Cancel</button>
      </div>
    `,
    );
  }

  const confirmLabel = armed ? 'Tap again to restore' : 'Restore this backup';
  return wrap(
    'preview',
    `
    <h2 class="restore-splash-title">Restore this backup?</h2>
    ${renderManifest(s)}
    ${renderRealm(s)}
    <p class="restore-splash-detail">
      This writes the backup into your fresh server, then restarts it.
    </p>
    <div class="restore-splash-actions">
      <button id="${e(RESTORE_SPLASH_CONFIRM_ID)}" type="button"
        class="restore-splash-confirm${armed ? ' is-armed' : ''}"
        aria-pressed="${armed ? 'true' : 'false'}"
        data-action="${e(RESTORE_SPLASH_CONFIRM_ACTION)}">${e(confirmLabel)}</button>
      <button id="${e(RESTORE_SPLASH_CANCEL_ID)}" type="button"
        class="restore-splash-secondary"
        data-action="${e(RESTORE_SPLASH_CANCEL_ACTION)}">Cancel</button>
    </div>
  `,
  );
};

const renderManifest = (s: RestoreOnboardingState): string => {
  const m = s.manifest;
  if (m === null) return '';
  const tableCount = Object.keys(m.tables).length;
  const tableWord = tableCount === 1 ? 'table' : 'tables';
  return `
    <ul class="restore-splash-manifest" data-restore-manifest>
      <li>${e(m.record_count.toLocaleString())} records across ${tableCount} ${tableWord}</li>
      <li>Backed up ${e(m.exported_at)}</li>
      <li>Includes files: ${m.includes_blobs ? 'yes' : 'no'}</li>
      <li>Includes identity passport: ${m.includes_passport ? 'yes' : 'no'}</li>
      <li>Archive format v${e(String(m.format_version))}</li>
    </ul>
  `;
};

const renderRealm = (s: RestoreOnboardingState): string => {
  // A pre-pair restore is always same-realm (the archive seals the realm via
  // its own sentinel; a cross-realm archive is caught as a fatal at validate
  // before preview). Render the relation for completeness + defensively flag a
  // `cross` that somehow reached here.
  if (s.realm === 'cross') {
    return `<p class="restore-splash-realm">This backup belongs to a different server identity.</p>`;
  }
  return `<p class="restore-splash-realm">This backup will set this server's identity.</p>`;
};

const renderFatal = (s: RestoreOnboardingState): string =>
  wrap(
    'fatal',
    `
    <h2 class="restore-splash-title">Restore couldn’t continue</h2>
    <p class="restore-splash-error" role="status">${e(
      s.error ?? 'The restore could not continue. Reload to start over.',
    )}</p>
    <div class="restore-splash-actions">
      <button id="${e(RESTORE_SPLASH_RELOAD_ID)}" type="button"
        class="restore-splash-secondary"
        data-action="${e(RESTORE_SPLASH_RELOAD_ACTION)}">Reload</button>
    </div>
  `,
  );
