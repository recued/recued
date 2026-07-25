/** M5 S3.4 — the restore-onboarding flow controller.
 *
 *  Glues the S3.3 surfaces to the S3.2 orchestrator. When the user submits the
 *  pair host's `restore` collect-mode, the boot layer disposes that form and
 *  calls `startRestoreOnboarding` here: it builds the orchestrator, mounts the
 *  splash progress/preview surface, and kicks off the restore. Between attempts
 *  it owns the retained inputs (so a `collect` bounce re-mounts the collect form
 *  with the picked file + last server/code re-seeded, and the corrected re-submit
 *  resumes the SAME orchestrator — never a second /auth/pair or re-upload), and
 *  on a committed restore it re-enters the full bootstrap + drops the splash.
 *
 *  Pure over an injected seam boundary (`RestoreOnboardingFlowDeps`) so the
 *  control flow — build → mount → submit → bounce-rewire → restored → rebootstrap
 *  — is unit-testable against fakes, with the production wiring (the real
 *  orchestrator / splash / pair-host re-mount / bootstrap re-entry) supplied by
 *  `boot/pair-fallback-bootstrap.ts`. */

import type { ArchiveUploadFile } from '../settings/archive-backup-panel.js';
import type {
  PairCodeInputRestoreInputs,
  PairRestoreFocusField,
} from './pair-code-input-host.js';
import type { RestoreOnboarding, RestoreOnboardingErrorStage } from './restore-onboarding.js';
import type {
  MountedRestoreOnboardingSplash,
  RestoreCollectHandle,
  RestoreCollectNotice,
} from './restore-onboarding-splash.js';

/** Map the orchestrator's bounce stage onto the pair-host field to focus on the
 *  re-mounted collect form. `null` (e.g. a channel-open failure) focuses
 *  nothing. */
export const STAGE_TO_FOCUS: Record<
  Exclude<RestoreOnboardingErrorStage, null>,
  PairRestoreFocusField
> = {
  pairing: 'pairingCode',
  upload: 'file',
  validate: 'archiveKey',
};

export const focusForStage = (stage: RestoreOnboardingErrorStage): PairRestoreFocusField =>
  stage === null ? null : STAGE_TO_FOCUS[stage];

/** Everything the production layer hands the collect-form re-mounter for a
 *  bounce. The boot layer maps these onto `mountPairCodeInputHost` restore-mode
 *  (restoreOnly) options. */
export interface RestoreCollectFormArgs {
  /** The orchestrator's user-facing bounce copy. */
  message: string;
  /** Which field to focus (already mapped from the stage). */
  focus: PairRestoreFocusField;
  /** The archive to re-seed (a `<input type=file>` can't be pre-filled). */
  seedFile: ArchiveUploadFile;
  /** The server URL + pairing code to re-seed the text fields. */
  seedInputs: { serverUrl: string; code: string };
  /** Re-submit handler — the controller wires this to resume the SAME
   *  orchestrator with the corrected inputs. */
  onRestoreSubmit: (inputs: PairCodeInputRestoreInputs) => void | Promise<void>;
}

export interface RestoreSplashFactoryArgs {
  splashElement: HTMLElement;
  onboarding: RestoreOnboarding;
  mountCollectForm: (notice: RestoreCollectNotice) => RestoreCollectHandle;
  onReload: () => void;
}

export interface RestoreOnboardingFlowDeps {
  /** The boot splash slot (shared with the re-mounted collect form). */
  splashElement: HTMLElement;
  /** Build the orchestrator, threading the committed-restore hand-off.
   *  Production: `createBrowserRestoreOnboarding({ ..., onRestored })`. */
  buildOnboarding: (onRestored: () => void | Promise<void>) => RestoreOnboarding;
  /** Mount the splash progress/preview surface. Production:
   *  `mountRestoreOnboardingSplash`. */
  mountSplash: (args: RestoreSplashFactoryArgs) => MountedRestoreOnboardingSplash;
  /** Re-mount the pair host restore-mode (restoreOnly) collect form for a
   *  bounce. Production: `mountPairCodeInputHost`. */
  mountRestoreCollectForm: (args: RestoreCollectFormArgs) => RestoreCollectHandle;
  /** Re-enter the full bootstrap after a committed restore. Production:
   *  `() => runBootstrapWithPairFallback(deps)`. Only `kind === 'mounted'`
   *  matters here (the reception route owns the root → drop the splash). */
  reBootstrap: () => Promise<{ kind: string }>;
  /** Reload affordance (fatal phase + preview Cancel). Production:
   *  `() => globalThis.location?.reload()`. */
  onReload: () => void;
  /** Drop the boot-splash wrapper once a re-bootstrap mounted. Production:
   *  `() => removeBootSplashWrapper(document)`. */
  dropSplash: () => void;
}

/** Handle returned for symmetry/cleanup — disposes the splash surface (which
 *  disposes a mounted collect form + unsubscribes). The flow normally
 *  self-terminates (a committed restore drops the splash; a fatal reloads), so
 *  the boot layer doesn't need to hold this, but it keeps teardown explicit +
 *  testable. */
export interface RestoreOnboardingFlowHandle {
  dispose(): void;
}

/** Start (or resume across the process) a restore. Called once per restore
 *  attempt — the FIRST submit from the boot pair form. */
export const startRestoreOnboarding = (
  deps: RestoreOnboardingFlowDeps,
  firstInputs: PairCodeInputRestoreInputs,
): RestoreOnboardingFlowHandle => {
  // Retained across bounces so a re-mounted collect form re-seeds the picked
  // file + last server/code, and the corrected re-submit resumes the SAME
  // orchestrator (its resume memory skips the already-done pair + upload).
  let lastInputs = firstInputs;
  let splash: MountedRestoreOnboardingSplash | null = null;

  // Committed-restore hand-off: re-enter the full bootstrap; once it actually
  // mounts the reception route, tear the splash surface + wrapper down. On a
  // re-entry pair-form / failure the splash stays (it hosts the live surface).
  const onRestored = async (): Promise<void> => {
    const outcome = await deps.reBootstrap();
    if (outcome.kind === 'mounted') {
      splash?.dispose();
      deps.dropSplash();
    }
  };

  const onboarding = deps.buildOnboarding(onRestored);

  const mountCollectForm = (notice: RestoreCollectNotice): RestoreCollectHandle =>
    deps.mountRestoreCollectForm({
      message: notice.message,
      focus: focusForStage(notice.stage),
      seedFile: lastInputs.file,
      seedInputs: { serverUrl: lastInputs.serverUrl, code: lastInputs.code },
      onRestoreSubmit: (next) => {
        lastInputs = next;
        // Resume the SAME orchestrator — never rebuild it (that would re-pair /
        // re-upload). Fire-and-forget: the splash renders the resumed phases.
        void onboarding.submit(next);
      },
    });

  // Mount the splash BEFORE submitting so it catches the first phase emit. Its
  // initial render is the orchestrator's `collect` (error null) → a transient
  // placeholder; the submit immediately advances it to `pairing`.
  splash = deps.mountSplash({
    splashElement: deps.splashElement,
    onboarding,
    mountCollectForm,
    onReload: deps.onReload,
  });

  void onboarding.submit(firstInputs);

  return {
    dispose: () => {
      splash?.dispose();
    },
  };
};
