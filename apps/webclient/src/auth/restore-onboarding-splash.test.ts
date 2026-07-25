/** M5 S3.3 — `mountRestoreOnboardingSplash` per-phase rendering.
 *
 *  The splash surface is a pure view over the S3.2 orchestrator: it subscribes
 *  to a `RestoreOnboarding` handle and renders one screen per phase. These tests
 *  drive a FAKE onboarding handle (a settable state + a listener set + confirm/
 *  dispose spies) against a string-innerHTML fake DOM with delegated `click`
 *  (the same node-env discipline as the pair-host tests — no jsdom).
 *
 *  Pinned: the per-phase `data-restore-phase` marker + key content; the upload
 *  progress %; the two-tap confirm (arm → commit); the schema-too-new BLOCK
 *  (message + Cancel, NO confirm); the collect-bounce delegation to
 *  `mountCollectForm` + its disposal when a progress phase takes the element
 *  back; the fatal Reload; Cancel → dispose + reload; and listener teardown. */

import { describe, expect, it, vi } from 'vitest';
import type { ArchiveManifest } from '@recued/contracts';

import type {
  RestoreOnboarding,
  RestoreOnboardingState,
} from './restore-onboarding.js';
import {
  mountRestoreOnboardingSplash,
  type RestoreCollectHandle,
  type RestoreCollectNotice,
} from './restore-onboarding-splash.js';

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const MANIFEST: ArchiveManifest = {
  format_version: 1,
  schema_version: 3,
  exported_at: '2026-06-25T00:00:00.000Z',
  record_count: 1234,
  tables: { data_mail: 1000, data_contact: 234 },
  includes_blobs: true,
  includes_passport: false,
};

const baseState = (
  over: Partial<RestoreOnboardingState> = {},
): RestoreOnboardingState => ({
  phase: 'pairing',
  error: null,
  errorStage: null,
  upload: { sent: 0, total: 0 },
  manifest: null,
  realm: null,
  schemaCompat: null,
  blocked: false,
  ...over,
});

// ════════════════════════════════════════════════════════════════
// Fake onboarding handle
// ════════════════════════════════════════════════════════════════

const makeFakeOnboarding = (initial: RestoreOnboardingState) => {
  let state = initial;
  const listeners = new Set<(s: RestoreOnboardingState) => void>();
  const confirm = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const handle: RestoreOnboarding = {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    submit: async () => {},
    confirm,
    dispose,
  };
  return {
    handle,
    confirm,
    dispose,
    emit: (next: RestoreOnboardingState) => {
      state = next;
      for (const fn of [...listeners]) fn(state);
    },
    listenerCount: () => listeners.size,
  };
};

// ════════════════════════════════════════════════════════════════
// Fake splash element (string innerHTML + delegated click)
// ════════════════════════════════════════════════════════════════

const makeFakeSplash = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const el = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      listeners[evt]?.delete(fn);
    },
  } as unknown as HTMLElement;

  const fireClick = (action: string): void => {
    const target = {
      closest: (selector: string) =>
        selector === `[data-action="${action}"]` ? {} : null,
    };
    for (const fn of [...(listeners.click ?? [])]) {
      fn({ target, type: 'click' } as unknown as Event);
    }
  };

  return {
    el,
    getHtml: () => html,
    fireClick,
    clickListenerCount: () => listeners.click?.size ?? 0,
  };
};

const phaseOf = (html: string): string | null => {
  const m = html.match(/data-restore-phase="([^"]*)"/);
  return m ? m[1] : null;
};

const makeCollectSeam = () => {
  const dispose = vi.fn();
  const notices: RestoreCollectNotice[] = [];
  const mountCollectForm = vi.fn((notice: RestoreCollectNotice): RestoreCollectHandle => {
    notices.push(notice);
    return { dispose };
  });
  return { mountCollectForm, dispose, notices };
};

const mountWith = (
  initial: RestoreOnboardingState,
  overrides: Partial<{
    onReload: () => void;
    collect: ReturnType<typeof makeCollectSeam>;
  }> = {},
) => {
  const splash = makeFakeSplash();
  const onb = makeFakeOnboarding(initial);
  const collect = overrides.collect ?? makeCollectSeam();
  const onReload = overrides.onReload ?? vi.fn();
  const mounted = mountRestoreOnboardingSplash({
    splashElement: splash.el,
    onboarding: onb.handle,
    mountCollectForm: collect.mountCollectForm,
    onReload,
    document: undefined,
  });
  return { splash, onb, collect, onReload, mounted };
};

// ════════════════════════════════════════════════════════════════
// Per-phase rendering
// ════════════════════════════════════════════════════════════════

describe('mountRestoreOnboardingSplash — status phases', () => {
  it('renders pairing / validating / restoring / done status screens', () => {
    const { splash, onb } = mountWith(baseState({ phase: 'pairing' }));
    expect(phaseOf(splash.getHtml())).toBe('pairing');
    expect(splash.getHtml()).toContain('Pairing with your server');

    onb.emit(baseState({ phase: 'validating' }));
    expect(phaseOf(splash.getHtml())).toBe('validating');

    onb.emit(baseState({ phase: 'restoring' }));
    expect(phaseOf(splash.getHtml())).toBe('restoring');
    expect(splash.getHtml()).toContain('restart');

    onb.emit(baseState({ phase: 'done' }));
    expect(phaseOf(splash.getHtml())).toBe('done');
    expect(splash.getHtml()).toContain('starting Recued');
  });

  it('renders the upload progress bar with a clamped percentage', () => {
    const { splash, onb } = mountWith(
      baseState({ phase: 'uploading', upload: { sent: 0, total: 0 } }),
    );
    // total 0 → 0% (no divide-by-zero)
    expect(splash.getHtml()).toContain('data-restore-progress="0"');

    onb.emit(baseState({ phase: 'uploading', upload: { sent: 50, total: 200 } }));
    expect(splash.getHtml()).toContain('data-restore-progress="25"');
    expect(splash.getHtml()).toContain('25% uploaded');

    onb.emit(baseState({ phase: 'uploading', upload: { sent: 999, total: 200 } }));
    expect(splash.getHtml()).toContain('data-restore-progress="100"');
  });
});

// ════════════════════════════════════════════════════════════════
// Preview + two-tap confirm
// ════════════════════════════════════════════════════════════════

describe('mountRestoreOnboardingSplash — preview', () => {
  const preview = baseState({
    phase: 'preview',
    manifest: MANIFEST,
    realm: 'same',
    schemaCompat: { status: 'ok', server_schema_version: 3 },
    blocked: false,
  });

  it('renders the manifest summary + a confirm/cancel pair', () => {
    const { splash } = mountWith(preview);
    const html = splash.getHtml();
    expect(phaseOf(html)).toBe('preview');
    expect(html).toContain('1,234 records');
    expect(html).toContain('across 2 tables');
    expect(html).toContain('2026-06-25');
    expect(html).toContain('Includes files: yes');
    expect(html).toContain('Includes identity passport: no');
    expect(html).toContain('Archive format v1');
    expect(html).toContain('data-action="restore-splash-confirm"');
    expect(html).toContain('data-action="restore-splash-cancel"');
  });

  it('two-tap confirm: first tap arms, second tap commits', () => {
    const { splash, onb } = mountWith(preview);
    expect(splash.getHtml()).toContain('Restore this backup');

    splash.fireClick('restore-splash-confirm'); // arm
    expect(onb.confirm).not.toHaveBeenCalled();
    expect(splash.getHtml()).toContain('Tap again to restore');
    expect(splash.getHtml()).toContain('is-armed');

    splash.fireClick('restore-splash-confirm'); // commit
    expect(onb.confirm).toHaveBeenCalledTimes(1);
  });

  it('leaving preview resets the armed flag', () => {
    const { splash, onb } = mountWith(preview);
    splash.fireClick('restore-splash-confirm'); // arm
    expect(splash.getHtml()).toContain('is-armed');
    // A bounce back to a fresh preview (e.g. re-validated) is not armed.
    onb.emit(baseState({ phase: 'restoring' }));
    onb.emit(preview);
    expect(splash.getHtml()).not.toContain('is-armed');
    expect(splash.getHtml()).toContain('Restore this backup');
  });

  it('blocked (schema_too_new) preview shows the upgrade block + Cancel only', () => {
    const { splash, onb } = mountWith(
      baseState({
        phase: 'preview',
        manifest: MANIFEST,
        realm: 'same',
        schemaCompat: { status: 'archive_too_new', server_schema_version: 2 },
        blocked: true,
      }),
    );
    const html = splash.getHtml();
    expect(phaseOf(html)).toBe('preview');
    expect(html).toContain('schema v2');
    expect(html).toContain('data-action="restore-splash-cancel"');
    // No confirm affordance when blocked.
    expect(html).not.toContain('data-action="restore-splash-confirm"');
    // Tapping the (absent) confirm action does nothing.
    splash.fireClick('restore-splash-confirm');
    expect(onb.confirm).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// Collect bounce → mountCollectForm seam
// ════════════════════════════════════════════════════════════════

describe('mountRestoreOnboardingSplash — collect bounce', () => {
  it('initial collect (error null) renders a placeholder, NOT the form', () => {
    const { splash, collect } = mountWith(baseState({ phase: 'collect', error: null }));
    expect(phaseOf(splash.getHtml())).toBe('collect');
    expect(collect.mountCollectForm).not.toHaveBeenCalled();
  });

  it('a collect bounce (error set) delegates to mountCollectForm with the notice', () => {
    const { onb, collect } = mountWith(baseState({ phase: 'pairing' }));
    onb.emit(
      baseState({
        phase: 'collect',
        error: 'That recovery key does not match this backup.',
        errorStage: 'validate',
      }),
    );
    expect(collect.mountCollectForm).toHaveBeenCalledTimes(1);
    expect(collect.notices[0]).toEqual({
      message: 'That recovery key does not match this backup.',
      stage: 'validate',
    });
  });

  it('does not re-mount the form while staying in the same bounce', () => {
    const bounce = baseState({ phase: 'collect', error: 'x', errorStage: 'pairing' });
    const { onb, collect } = mountWith(baseState({ phase: 'pairing' }));
    onb.emit(bounce);
    onb.emit(bounce); // a redundant re-emit must not double-mount
    expect(collect.mountCollectForm).toHaveBeenCalledTimes(1);
  });

  it('disposes the collect form when a progress phase takes the element back', () => {
    const { onb, collect } = mountWith(baseState({ phase: 'pairing' }));
    onb.emit(baseState({ phase: 'collect', error: 'x', errorStage: 'pairing' }));
    expect(collect.dispose).not.toHaveBeenCalled();
    onb.emit(baseState({ phase: 'pairing' }));
    expect(collect.dispose).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════
// Fatal + cancel + lifecycle
// ════════════════════════════════════════════════════════════════

describe('mountRestoreOnboardingSplash — fatal + cancel + lifecycle', () => {
  it('fatal renders the error + a Reload that calls onReload', () => {
    const onReload = vi.fn();
    const { splash } = mountWith(
      baseState({ phase: 'fatal', error: 'This browser already paired elsewhere.' }),
      { onReload },
    );
    const html = splash.getHtml();
    expect(phaseOf(html)).toBe('fatal');
    expect(html).toContain('This browser already paired elsewhere.');
    expect(html).toContain('data-action="restore-splash-reload"');
    splash.fireClick('restore-splash-reload');
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('Cancel disposes the orchestrator then reloads', async () => {
    const onReload = vi.fn();
    const { splash, onb } = mountWith(
      baseState({ phase: 'preview', manifest: MANIFEST, realm: 'same', blocked: false }),
      { onReload },
    );
    splash.fireClick('restore-splash-cancel');
    await Promise.resolve();
    await Promise.resolve();
    expect(onb.dispose).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('dispose() unsubscribes + detaches the click listener', () => {
    const { splash, onb, mounted } = mountWith(baseState({ phase: 'pairing' }));
    expect(onb.listenerCount()).toBe(1);
    expect(splash.clickListenerCount()).toBe(1);
    mounted.dispose();
    expect(onb.listenerCount()).toBe(0);
    expect(splash.clickListenerCount()).toBe(0);
    // A post-dispose emit is ignored (unsubscribed) — the listener set is empty
    // so nothing throws.
    onb.emit(baseState({ phase: 'done' }));
  });

  it('dispose() also disposes a mounted collect form', () => {
    const { onb, collect, mounted } = mountWith(baseState({ phase: 'pairing' }));
    onb.emit(baseState({ phase: 'collect', error: 'x', errorStage: 'validate' }));
    expect(collect.dispose).not.toHaveBeenCalled();
    mounted.dispose();
    expect(collect.dispose).toHaveBeenCalledTimes(1);
  });
});
