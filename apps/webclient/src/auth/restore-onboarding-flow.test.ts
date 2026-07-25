/** M5 S3.4 — `startRestoreOnboarding` flow controller.
 *
 *  The controller is pure over an injected seam boundary, so the glue logic —
 *  build orchestrator → mount splash → submit → bounce-rewire → restored →
 *  re-bootstrap — is driven against fakes (no real WS / DOM / orchestrator).
 *  Pinned: the first submit reaches the orchestrator; a `collect` bounce
 *  re-submit reuses the SAME orchestrator (no second build); the bounce
 *  re-mount re-seeds the retained file + server/code + the mapped focus; the
 *  retained inputs advance on each re-submit; and the committed-restore hand-off
 *  drops the splash ONLY on a mounted re-bootstrap. */

import { describe, expect, it, vi } from 'vitest';

import type { PairCodeInputRestoreInputs } from './pair-code-input-host.js';
import type { ArchiveUploadFile } from '../settings/archive-backup-panel.js';
import type {
  RestoreOnboarding,
  RestoreOnboardingState,
} from './restore-onboarding.js';
import type {
  MountedRestoreOnboardingSplash,
  RestoreCollectHandle,
  RestoreCollectNotice,
} from './restore-onboarding-splash.js';
import {
  focusForStage,
  startRestoreOnboarding,
  STAGE_TO_FOCUS,
  type RestoreCollectFormArgs,
  type RestoreSplashFactoryArgs,
} from './restore-onboarding-flow.js';

// ════════════════════════════════════════════════════════════════
// Fixtures + fakes
// ════════════════════════════════════════════════════════════════

const fakeFile = (name = 'backup.recued.archive'): ArchiveUploadFile => ({
  name,
  size: 4096,
  type: 'application/octet-stream',
  lastModified: 111,
  slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
});

const INPUTS = (over: Partial<PairCodeInputRestoreInputs> = {}): PairCodeInputRestoreInputs => ({
  serverUrl: 'http://alice.example:3001',
  code: 'PAIRCODE1',
  archiveKey: 'word1 word2 word3',
  file: fakeFile(),
  ...over,
});

const makeFakeOnboarding = () => {
  const submit = vi.fn(async (_: PairCodeInputRestoreInputs) => {});
  const dispose = vi.fn(async () => {});
  const handle: RestoreOnboarding = {
    getState: () => ({ phase: 'collect' }) as RestoreOnboardingState,
    subscribe: () => () => {},
    submit,
    confirm: async () => {},
    dispose,
  };
  return { handle, submit, dispose };
};

const makeHarness = (over: { reBootstrapKind?: string } = {}) => {
  const onboarding = makeFakeOnboarding();
  let capturedOnRestored: (() => void | Promise<void>) | null = null;
  let capturedSplashArgs: RestoreSplashFactoryArgs | null = null;
  const collectArgs: RestoreCollectFormArgs[] = [];
  const collectHandleDispose = vi.fn();
  const splashDispose = vi.fn();
  const reBootstrap = vi.fn(async () => ({ kind: over.reBootstrapKind ?? 'mounted' }));
  const onReload = vi.fn();
  const dropSplash = vi.fn();

  const buildOnboarding = vi.fn((onRestored: () => void | Promise<void>) => {
    capturedOnRestored = onRestored;
    return onboarding.handle;
  });
  const mountSplash = vi.fn((args: RestoreSplashFactoryArgs): MountedRestoreOnboardingSplash => {
    capturedSplashArgs = args;
    return { dispose: splashDispose };
  });
  const mountRestoreCollectForm = vi.fn((args: RestoreCollectFormArgs): RestoreCollectHandle => {
    collectArgs.push(args);
    return { dispose: collectHandleDispose };
  });

  const splashElement = {} as HTMLElement;
  const deps = {
    splashElement,
    buildOnboarding,
    mountSplash,
    mountRestoreCollectForm,
    reBootstrap,
    onReload,
    dropSplash,
  };

  return {
    deps,
    onboarding,
    buildOnboarding,
    mountSplash,
    mountRestoreCollectForm,
    reBootstrap,
    onReload,
    dropSplash,
    splashDispose,
    collectHandleDispose,
    collectArgs,
    splashElement,
    fireRestored: () => capturedOnRestored?.(),
    triggerBounce: (notice: RestoreCollectNotice) =>
      capturedSplashArgs?.mountCollectForm(notice),
    splashArgs: () => capturedSplashArgs,
  };
};

// ════════════════════════════════════════════════════════════════
// Stage → focus mapping
// ════════════════════════════════════════════════════════════════

describe('focusForStage', () => {
  it('maps each bounce stage onto a pair-host field; null → null', () => {
    expect(focusForStage('pairing')).toBe('pairingCode');
    expect(focusForStage('upload')).toBe('file');
    expect(focusForStage('validate')).toBe('archiveKey');
    expect(focusForStage(null)).toBeNull();
    expect(STAGE_TO_FOCUS).toEqual({
      pairing: 'pairingCode',
      upload: 'file',
      validate: 'archiveKey',
    });
  });
});

// ════════════════════════════════════════════════════════════════
// First submit
// ════════════════════════════════════════════════════════════════

describe('startRestoreOnboarding — first submit', () => {
  it('builds one orchestrator, mounts the splash, and submits the first inputs', () => {
    const h = makeHarness();
    const first = INPUTS();
    startRestoreOnboarding(h.deps, first);

    expect(h.buildOnboarding).toHaveBeenCalledTimes(1);
    expect(h.mountSplash).toHaveBeenCalledTimes(1);
    expect(h.splashArgs()?.splashElement).toBe(h.splashElement);
    expect(h.splashArgs()?.onboarding).toBe(h.onboarding.handle);
    expect(h.splashArgs()?.onReload).toBe(h.deps.onReload);
    expect(h.onboarding.submit).toHaveBeenCalledTimes(1);
    expect(h.onboarding.submit).toHaveBeenCalledWith(first);
  });

  it('mounts the splash BEFORE submitting (so the first phase emit is caught)', () => {
    const h = makeHarness();
    const order: string[] = [];
    h.mountSplash.mockImplementation((args) => {
      order.push('mountSplash');
      return { dispose: h.splashDispose, _args: args } as unknown as MountedRestoreOnboardingSplash;
    });
    h.onboarding.submit.mockImplementation(async () => {
      order.push('submit');
    });
    startRestoreOnboarding(h.deps, INPUTS());
    expect(order).toEqual(['mountSplash', 'submit']);
  });
});

// ════════════════════════════════════════════════════════════════
// Bounce re-mount + same-orchestrator resume
// ════════════════════════════════════════════════════════════════

describe('startRestoreOnboarding — collect bounce', () => {
  it('re-mounts the collect form with the retained file + server/code + mapped focus', () => {
    const h = makeHarness();
    const first = INPUTS({ serverUrl: 'http://bob.example:9000', code: 'CODE9' });
    startRestoreOnboarding(h.deps, first);

    h.triggerBounce({ message: 'Wrong key.', stage: 'validate' });
    expect(h.mountRestoreCollectForm).toHaveBeenCalledTimes(1);
    const args = h.collectArgs[0];
    expect(args.message).toBe('Wrong key.');
    expect(args.focus).toBe('archiveKey');
    expect(args.seedFile).toBe(first.file);
    expect(args.seedInputs).toEqual({ serverUrl: 'http://bob.example:9000', code: 'CODE9' });
  });

  it('a bounce re-submit reuses the SAME orchestrator (no second build)', () => {
    const h = makeHarness();
    startRestoreOnboarding(h.deps, INPUTS());
    h.triggerBounce({ message: 'Wrong key.', stage: 'validate' });

    const corrected = INPUTS({ archiveKey: 'corrected key words' });
    void h.collectArgs[0].onRestoreSubmit(corrected);

    expect(h.buildOnboarding).toHaveBeenCalledTimes(1); // NOT rebuilt
    expect(h.onboarding.submit).toHaveBeenCalledTimes(2);
    expect(h.onboarding.submit).toHaveBeenLastCalledWith(corrected);
  });

  it('advances the retained inputs — a second bounce re-seeds the corrected file', () => {
    const h = makeHarness();
    startRestoreOnboarding(h.deps, INPUTS({ file: fakeFile('first.archive') }));

    // First bounce → user re-picks a different file + re-submits.
    h.triggerBounce({ message: 'Upload failed.', stage: 'upload' });
    const corrected = INPUTS({ file: fakeFile('second.archive') });
    void h.collectArgs[0].onRestoreSubmit(corrected);

    // Second bounce → must re-seed the NEWLY-picked file, not the first.
    h.triggerBounce({ message: 'Wrong key.', stage: 'validate' });
    expect(h.collectArgs[1].seedFile.name).toBe('second.archive');
  });
});

// ════════════════════════════════════════════════════════════════
// Committed-restore hand-off
// ════════════════════════════════════════════════════════════════

describe('startRestoreOnboarding — onRestored hand-off', () => {
  it('drops the splash + wrapper when the re-bootstrap mounts', async () => {
    const h = makeHarness({ reBootstrapKind: 'mounted' });
    startRestoreOnboarding(h.deps, INPUTS());
    await h.fireRestored();
    expect(h.reBootstrap).toHaveBeenCalledTimes(1);
    expect(h.splashDispose).toHaveBeenCalledTimes(1);
    expect(h.dropSplash).toHaveBeenCalledTimes(1);
  });

  it('keeps the splash when the re-bootstrap re-enters the pair form (not mounted)', async () => {
    const h = makeHarness({ reBootstrapKind: 'pair-form' });
    startRestoreOnboarding(h.deps, INPUTS());
    await h.fireRestored();
    expect(h.reBootstrap).toHaveBeenCalledTimes(1);
    expect(h.splashDispose).not.toHaveBeenCalled();
    expect(h.dropSplash).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// Handle
// ════════════════════════════════════════════════════════════════

describe('startRestoreOnboarding — handle', () => {
  it('dispose() tears down the splash surface', () => {
    const h = makeHarness();
    const handle = startRestoreOnboarding(h.deps, INPUTS());
    handle.dispose();
    expect(h.splashDispose).toHaveBeenCalledTimes(1);
  });
});
