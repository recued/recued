/** Recovery surface for the narrow gap after browser credentials are durable
 * but before the first paired application shell mounts successfully.
 *
 * Pairing is already complete at this point. This host therefore offers only
 * an application-startup retry: it never collects a recovery key, pairing
 * code, or server address, and it never owns a pairing success receipt. */

export const POST_PAIR_STARTUP_RECOVERY_ATTR =
  'data-recued-post-pair-startup-recovery';
export const POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR =
  'data-recued-post-pair-startup-recovery-action';
export const POST_PAIR_STARTUP_RECOVERY_STATUS_ATTR =
  'data-recued-post-pair-startup-recovery-status';
const POST_PAIR_STARTUP_RECOVERY_TITLE_ID =
  'webclient-post-pair-startup-recovery-title';
const POST_PAIR_STARTUP_RECOVERY_SAFE_ID =
  'webclient-post-pair-startup-recovery-safe';
const POST_PAIR_STARTUP_RECOVERY_CONTEXT_ID =
  'webclient-post-pair-startup-recovery-context';
const POST_PAIR_STARTUP_RECOVERY_STYLES_MARKER =
  'data-recued-post-pair-startup-recovery-styles';
const SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';

export const POST_PAIR_STARTUP_RETRY_ERROR_COPY =
  'Recued still could not open with your saved sign-in. Check that this tab is online, and that your browser lets this address save data. Then try again. You do not need to pair this browser again.';

const STYLES = `
.post-pair-startup-recovery {
  box-sizing: border-box;
  width: min(540px, calc(100vw - 32px));
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--fg) 10%, transparent);
  text-align: left;
}
.post-pair-startup-recovery-kicker {
  margin: 0 0 5px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.post-pair-startup-recovery h2 {
  margin: 0;
  color: var(--fg);
  font-size: 22px;
  line-height: 1.2;
}
.post-pair-startup-recovery-summary,
.post-pair-startup-recovery-context {
  margin: 10px 0 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
.post-pair-startup-recovery-safe {
  margin: 16px 0;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  font-size: 12.5px;
  line-height: 1.5;
}
.post-pair-startup-recovery-safe strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fg);
}
.post-pair-startup-recovery-actions { margin-top: 18px; }
.post-pair-startup-recovery button {
  min-height: 44px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 9px 14px;
  background: var(--accent);
  color: var(--accent-contrast, #fff);
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.post-pair-startup-recovery button:disabled {
  opacity: .64;
  cursor: default;
}
.post-pair-startup-recovery button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.post-pair-startup-recovery-status {
  margin: 13px 0 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.post-pair-startup-recovery-status.is-error {
  color: var(--danger, #b42318);
}
@media (max-width: 360px) {
  .post-pair-startup-recovery {
    width: calc(100vw - 20px);
    padding: 17px 15px;
  }
  .post-pair-startup-recovery button { width: 100%; }
}
`;

type StartupRecoveryPhase = 'idle' | 'busy' | 'handoff' | 'error';

export interface MountPostPairStartupRecoveryOptions {
  /** A guided reconnect carries stronger return-to-work continuity than a
   * first pair, but both use the same credential-free startup retry. */
  readonly reconnect: boolean;
  /** True when the in-memory recovery snapshot is protecting an unsent draft. */
  readonly draftPreserved: boolean;
  /** Copy distinction only; sibling credentials remain verified from storage. */
  readonly completedInAnotherTab: boolean;
  readonly onRetry: () => Promise<void>;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
}

export interface MountedPostPairStartupRecovery {
  readonly retry: () => Promise<void>;
  /** Remove listeners and clear this host's contents. */
  readonly dispose: () => void;
  /** Remove listeners while preserving a replacement surface mounted into the
   * same splash slot (for example, a genuinely required pair form). */
  readonly detach: () => void;
}

const resolveDocument = (doc?: Document): Document | undefined =>
  doc ?? (globalThis as { document?: Document }).document;

export const mountPostPairStartupRecovery = (
  options: MountPostPairStartupRecoveryOptions,
): MountedPostPairStartupRecovery => {
  const doc = resolveDocument(options.document);
  const splash = options.splashElement
    ?? doc?.getElementById(SPLASH_MESSAGE_ID)
    ?? null;
  if (splash === null) {
    throw new Error('post-pair startup recovery: splash element not found');
  }
  if (
    doc?.head?.querySelector?.(
      `style[${POST_PAIR_STARTUP_RECOVERY_STYLES_MARKER}]`,
    ) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(POST_PAIR_STARTUP_RECOVERY_STYLES_MARKER, '');
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  let disposed = false;
  let phase: StartupRecoveryPhase = 'idle';
  let focusActionAfterRender = true;

  const contextCopy = options.draftPreserved
    ? 'Your page and the Chat message you had not sent are still here. Keep this tab open, then try starting again.'
    : options.reconnect
      ? 'Your page is still here. Try starting again to go back to where you were.'
      : 'The page you opened is still chosen in this tab. Try starting again to carry on.';
  const summaryCopy = options.completedInAnotherTab
    ? options.reconnect
      ? 'Another tab reconnected this browser. Your sign-in is ready, but this tab hit a problem while opening Recued.'
      : 'Another tab saved the sign-in for this browser. The sign-in is ready, but this tab hit a problem while opening Recued.'
    : options.reconnect
      ? 'This browser saved the new sign-in, but Recued hit a problem going back to your work.'
      : 'This browser saved your sign-in, but Recued hit a problem while opening.';
  const kickerCopy = options.completedInAnotherTab
    ? 'Sign-in saved in another tab'
    : 'Sign-in saved';
  const titleCopy = options.completedInAnotherTab
    ? 'Finish opening this tab'
    : 'Recued could not finish opening';
  const safeHeadingCopy = options.completedInAnotherTab
    ? 'This browser is already paired.'
    : 'You do not need to pair this browser again.';
  const actionCopy = options.completedInAnotherTab
    ? 'Try opening this tab again'
    : 'Try opening Recued again';
  const busyActionCopy = options.completedInAnotherTab
    ? 'Opening this tab…'
    : 'Opening Recued…';
  const busyStatusCopy = options.completedInAnotherTab
    ? 'Opening this tab with your saved sign-in…'
    : 'Opening Recued with your saved sign-in…';

  const render = (): void => {
    if (disposed) return;
    const busy = phase === 'busy' || phase === 'handoff';
    const status = phase === 'busy'
      ? `<p class="post-pair-startup-recovery-status" data-recued-post-pair-startup-recovery-status role="status" tabindex="-1">${busyStatusCopy}</p>`
      : phase === 'handoff'
        ? '<p class="post-pair-startup-recovery-status" data-recued-post-pair-startup-recovery-status role="status" tabindex="-1">Saved access is ready. Opening your page…</p>'
        : phase === 'error'
          ? `<p class="post-pair-startup-recovery-status is-error" ${POST_PAIR_STARTUP_RECOVERY_STATUS_ATTR} role="alert">${POST_PAIR_STARTUP_RETRY_ERROR_COPY}</p>`
          : `<p class="post-pair-startup-recovery-status" ${POST_PAIR_STARTUP_RECOVERY_STATUS_ATTR} aria-live="polite"></p>`;
    splash.innerHTML = `
      <section class="post-pair-startup-recovery" ${POST_PAIR_STARTUP_RECOVERY_ATTR} role="region" aria-labelledby="${POST_PAIR_STARTUP_RECOVERY_TITLE_ID}" aria-busy="${busy}">
        <p class="post-pair-startup-recovery-kicker">${kickerCopy}</p>
        <h2 id="${POST_PAIR_STARTUP_RECOVERY_TITLE_ID}">${titleCopy}</h2>
        <p class="post-pair-startup-recovery-summary">${summaryCopy}</p>
        <div class="post-pair-startup-recovery-safe" id="${POST_PAIR_STARTUP_RECOVERY_SAFE_ID}">
          <strong>${safeHeadingCopy}</strong>
          Retrying opens only this tab with the access already saved here. It does not resend a pairing code or recovery key.
        </div>
        <p class="post-pair-startup-recovery-context" id="${POST_PAIR_STARTUP_RECOVERY_CONTEXT_ID}">${contextCopy}</p>
        <div class="post-pair-startup-recovery-actions">
          <button type="button" ${POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR} aria-describedby="${POST_PAIR_STARTUP_RECOVERY_SAFE_ID} ${POST_PAIR_STARTUP_RECOVERY_CONTEXT_ID}" ${busy ? 'disabled' : ''}>${busy ? busyActionCopy : actionCopy}</button>
        </div>
        ${status}
      </section>
    `;
    if (busy) {
      (splash.querySelector?.(
        `[${POST_PAIR_STARTUP_RECOVERY_STATUS_ATTR}]`,
      ) as HTMLElement | null)?.focus?.();
    } else if (focusActionAfterRender) {
      focusActionAfterRender = false;
      (splash.querySelector?.(
        `[${POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR}]`,
      ) as HTMLElement | null)?.focus?.();
    }
  };

  const retry = async (): Promise<void> => {
    if (disposed || phase === 'busy' || phase === 'handoff') return;
    phase = 'busy';
    render();
    try {
      await options.onRetry();
      if (disposed) return;
      phase = 'handoff';
      render();
    } catch {
      if (disposed) return;
      phase = 'error';
      focusActionAfterRender = true;
      render();
    }
  };

  const onClick = (event: Event): void => {
    const target = event.target as {
      closest?: (selector: string) => unknown;
    } | null;
    if (!target?.closest?.(`[${POST_PAIR_STARTUP_RECOVERY_ACTION_ATTR}]`)) {
      return;
    }
    event.preventDefault();
    void retry();
  };
  const detach = (): void => {
    if (disposed) return;
    disposed = true;
    splash.removeEventListener('click', onClick);
  };

  splash.addEventListener('click', onClick);
  render();

  return {
    retry,
    detach,
    dispose: () => {
      if (disposed) return;
      detach();
      splash.innerHTML = '';
    },
  };
};
