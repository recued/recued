/** M5 S3.3 — `mountPairCodeInputHost` restore (3rd) collect-mode.
 *
 *  The restore tab reuses the host's server-URL + pairing-code fields + the
 *  24-word recovery grid (for the BACKUP's key), adds a file picker, and on
 *  submit hands the inputs to `onRestoreSubmit` WITHOUT pairing — the boot-layer
 *  orchestrator drives the multi-step restore. These tests pin: tab visibility
 *  gated on `onRestoreSubmit`; the submit gate (URL + code + file + 24 BIP39
 *  words); the hand-off shape; the footgun invariant (the archive key never
 *  reaches the `/auth/pair` POST — `fetch` is never called); the Codex folds
 *  (mode coercion when un-wired, empty-FileList clearing); the seed-file
 *  retention; and the bounce notice + focus. Same string-innerHTML fake-DOM
 *  discipline as the D-156 host tests (node env, no jsdom). */

import { describe, expect, it, vi } from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';

import {
  mountPairCodeInputHost,
  PAIR_CODE_INPUT_RECOVERY_PREFIX,
  PAIR_CODE_INPUT_SUBMIT_ID,
  type PairCodeInputRestoreInputs,
} from './pair-code-input-host.js';

const MODE_RESTORE_ACTION = 'pair-code-input-mode-restore';
const MODE_ENTER_ACTION = 'pair-code-input-mode-enter';
const RESTORE_FILE_SELECTOR = '[data-pair-code-input-restore-file]';
const ARCHIVE_KEY = generateRecoveryKey().mnemonic;

interface FakeFile {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  slice: () => { arrayBuffer: () => Promise<ArrayBuffer> };
}

const fakeFile = (name = 'backup.recued.archive'): FakeFile => ({
  name,
  size: 4096,
  type: 'application/octet-stream',
  lastModified: 111,
  slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
});

// ════════════════════════════════════════════════════════════════
// Fake splash DOM
// ════════════════════════════════════════════════════════════════

const makeFakeSplash = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const focusCalls: string[] = [];

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
    // The host queries `#submit` / `#status` / `.rx-recovery-word-count` for its
    // in-place syncs (null → skipped; full re-renders carry the real state) and
    // `#<id>` for focus (return a spy so a bounce focus is observable).
    querySelector: (selector: string) => {
      if (selector === `#${PAIR_CODE_INPUT_SUBMIT_ID}`) return null;
      if (selector === '#webclient-pair-code-input-status') return null;
      if (selector === '.rx-recovery-word-count') return null;
      if (selector.startsWith('#')) {
        return {
          focus: () => {
            focusCalls.push(selector);
          },
        };
      }
      return null;
    },
  } as unknown as HTMLElement;

  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };

  return {
    el,
    getHtml: () => html,
    focusCalls,
    listenerCount: () =>
      Object.values(listeners).reduce((total, set) => total + set.size, 0),
    fireAction: (action: string): void =>
      fire('click', {
        closest: (selector: string) =>
          selector === `[data-action="${action}"]` ? { disabled: false } : null,
      }),
    fireFileChange: (file: FakeFile | null): void => {
      const files = file ? { length: 1, 0: file } : { length: 0 };
      const fileEl = { files };
      fire('change', {
        closest: (selector: string) =>
          selector === RESTORE_FILE_SELECTOR ? fileEl : null,
      });
    },
    fireRecoveryPaste: (joined: string): void =>
      fire('input', {
        closest: (selector: string) =>
          selector === '[data-pair-code-input-recovery-field]'
            ? { value: joined, dataset: { index: '0' } }
            : null,
      }),
  };
};

const submitDisabled = (html: string): boolean =>
  new RegExp(`<button[^>]*id="${PAIR_CODE_INPUT_SUBMIT_ID}"[^>]*\\sdisabled`).test(html);

/** Drive a restore mount to a fully-valid state (restore mode + URL + code +
 *  file + 24 words), returning the handle + splash + the onRestoreSubmit spy. */
const setupValidRestore = () => {
  const splash = makeFakeSplash();
  const onRestoreSubmit = vi.fn(async (_: PairCodeInputRestoreInputs) => {});
  const fetchSpy = vi.fn();
  const host = mountPairCodeInputHost({
    splashElement: splash.el,
    onPaired: async () => {},
    onRestoreSubmit,
    initialRecoveryMode: 'restore',
    fetch: fetchSpy as unknown as typeof fetch,
  });
  host.setFieldValue('serverUrl', 'http://alice.example:3001');
  host.setFieldValue('pairingCode', 'PAIRCODE1');
  splash.fireFileChange(fakeFile());
  host.setFieldValue('recoveryKey', ARCHIVE_KEY);
  return { splash, host, onRestoreSubmit, fetchSpy };
};

// ════════════════════════════════════════════════════════════════
// Tab visibility + mode coercion (Codex fold 1)
// ════════════════════════════════════════════════════════════════

describe('restore mode — tab visibility + coercion', () => {
  it('shows the restore tab only when onRestoreSubmit is wired', () => {
    const withSeam = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: withSeam.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
    });
    expect(withSeam.getHtml()).toContain(`data-action="${MODE_RESTORE_ACTION}"`);

    const without = makeFakeSplash();
    mountPairCodeInputHost({ splashElement: without.el, onPaired: async () => {} });
    expect(without.getHtml()).not.toContain(`data-action="${MODE_RESTORE_ACTION}"`);
  });

  it('coerces initialRecoveryMode=restore to enter when onRestoreSubmit is absent', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      initialRecoveryMode: 'restore',
    });
    // The enter body (its hint) renders; no restore file picker.
    expect(splash.getHtml()).not.toContain('type="file"');
    expect(splash.getHtml()).toContain('Pair this browser');
  });

  it('switching to restore mode renders the file picker + archive-key grid', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
    });
    splash.fireAction(MODE_RESTORE_ACTION);
    const html = splash.getHtml();
    expect(html).toContain('type="file"');
    expect(html).toContain('Restore a backup');
    expect(html).toContain(`id="${PAIR_CODE_INPUT_RECOVERY_PREFIX}-0"`);
  });
});

// ════════════════════════════════════════════════════════════════
// Submit gate
// ════════════════════════════════════════════════════════════════

describe('restore mode — submit gate', () => {
  it('stays disabled until URL + code + file + 24 valid words are present', () => {
    const splash = makeFakeSplash();
    const host = mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      initialRecoveryMode: 'restore',
    });
    expect(submitDisabled(splash.getHtml())).toBe(true);

    host.setFieldValue('serverUrl', 'http://alice.example:3001');
    expect(submitDisabled(splash.getHtml())).toBe(true); // no code/file/key yet

    host.setFieldValue('pairingCode', 'PAIRCODE1');
    splash.fireFileChange(fakeFile());
    expect(submitDisabled(splash.getHtml())).toBe(true); // no key yet

    host.setFieldValue('recoveryKey', ARCHIVE_KEY);
    expect(submitDisabled(splash.getHtml())).toBe(false);
  });

  it('rejects a 24-word-but-invalid-BIP39 key (gate stays disabled)', () => {
    const splash = makeFakeSplash();
    const host = mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      initialRecoveryMode: 'restore',
    });
    host.setFieldValue('serverUrl', 'http://alice.example:3001');
    host.setFieldValue('pairingCode', 'PAIRCODE1');
    splash.fireFileChange(fakeFile());
    // 24 real wordlist words, but a deliberately-broken BIP39 checksum
    // (24x 'zoo' fails validateMnemonic).
    host.setFieldValue('recoveryKey', Array(24).fill('zoo').join(' '));
    expect(submitDisabled(splash.getHtml())).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// Hand-off + footgun invariant
// ════════════════════════════════════════════════════════════════

describe('restore mode — hand-off', () => {
  it('submit hands the inputs to onRestoreSubmit and NEVER calls /auth/pair', async () => {
    const { host, onRestoreSubmit, fetchSpy } = setupValidRestore();
    await host.submit();
    expect(fetchSpy).not.toHaveBeenCalled(); // archive key never POSTed
    expect(onRestoreSubmit).toHaveBeenCalledTimes(1);
    expect(onRestoreSubmit.mock.calls[0][0]).toEqual({
      serverUrl: 'http://alice.example:3001',
      code: 'PAIRCODE1',
      archiveKey: ARCHIVE_KEY,
      file: expect.objectContaining({ name: 'backup.recued.archive' }),
    });
  });

  it('does not hand off while the gate is unsatisfied', async () => {
    const splash = makeFakeSplash();
    const onRestoreSubmit = vi.fn(async () => {});
    const host = mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit,
      initialRecoveryMode: 'restore',
    });
    host.setFieldValue('serverUrl', 'http://alice.example:3001');
    // no code / file / key
    await host.submit();
    expect(onRestoreSubmit).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// File picker (Codex fold 2) + seed-file retention
// ════════════════════════════════════════════════════════════════

describe('restore mode — file picker', () => {
  it('an empty FileList change clears a previously-picked file', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      initialRecoveryMode: 'restore',
    });
    splash.fireFileChange(fakeFile('chosen.recued.archive'));
    expect(splash.getHtml()).toContain('Selected: chosen.recued.archive');
    splash.fireFileChange(null); // empty selection
    expect(splash.getHtml()).not.toContain('Selected:');
  });

  it('restoreSeedFile pre-populates the picked file across a bounce re-mount', async () => {
    const splash = makeFakeSplash();
    const onRestoreSubmit = vi.fn(async (_: PairCodeInputRestoreInputs) => {});
    const host = mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit,
      initialRecoveryMode: 'restore',
      restoreSeedFile: fakeFile('retained.recued.archive'),
    });
    expect(splash.getHtml()).toContain('Selected: retained.recued.archive');
    // Only the key needs re-entering — no re-pick.
    host.setFieldValue('serverUrl', 'http://alice.example:3001');
    host.setFieldValue('pairingCode', 'PAIRCODE1');
    host.setFieldValue('recoveryKey', ARCHIVE_KEY);
    await host.submit();
    expect(onRestoreSubmit).toHaveBeenCalledTimes(1);
    expect(onRestoreSubmit.mock.calls[0][0].file).toEqual(
      expect.objectContaining({ name: 'retained.recued.archive' }),
    );
  });
});

// ════════════════════════════════════════════════════════════════
// Bounce notice + focus
// ════════════════════════════════════════════════════════════════

describe('restore mode — bounce notice', () => {
  it('renders the restoreNotice message + focuses the flagged field', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      initialRecoveryMode: 'restore',
      restoreNotice: { message: 'That recovery key does not match.', focus: 'archiveKey' },
    });
    expect(splash.getHtml()).toContain('data-restore-notice');
    expect(splash.getHtml()).toContain('That recovery key does not match.');
    // 'archiveKey' focuses the first recovery slot.
    expect(splash.focusCalls).toContain(`#${PAIR_CODE_INPUT_RECOVERY_PREFIX}-0`);
  });

  it('clears the notice as the user edits the key', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      initialRecoveryMode: 'restore',
      restoreNotice: { message: 'Wrong key.', focus: 'archiveKey' },
    });
    expect(splash.getHtml()).toContain('data-restore-notice');
    splash.fireRecoveryPaste(ARCHIVE_KEY); // paste re-renders
    expect(splash.getHtml()).not.toContain('data-restore-notice');
  });
});

// ════════════════════════════════════════════════════════════════
// restoreOnly (S3.4 — bounce re-mount)
// ════════════════════════════════════════════════════════════════

describe('restore mode — restoreOnly (bounce re-mount)', () => {
  it('forces restore mode + HIDES the whole mode toggle', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      restoreOnly: true,
    });
    const html = splash.getHtml();
    // restore body present...
    expect(html).toContain('type="file"');
    expect(html).toContain('Restore a backup');
    // ...but no mode toggle at all (no enter/generate/restore tabs).
    expect(html).not.toContain(`data-action="${MODE_ENTER_ACTION}"`);
    expect(html).not.toContain(`data-action="${MODE_RESTORE_ACTION}"`);
  });

  it('refuses a stray mode switch (stays restore)', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      onRestoreSubmit: async () => {},
      restoreOnly: true,
    });
    splash.fireAction(MODE_ENTER_ACTION); // no toggle rendered, but fire anyway
    // Still in restore mode (file picker still present).
    expect(splash.getHtml()).toContain('type="file"');
  });

  it('ignores restoreOnly when onRestoreSubmit is not wired (no inert form)', () => {
    const splash = makeFakeSplash();
    mountPairCodeInputHost({
      splashElement: splash.el,
      onPaired: async () => {},
      restoreOnly: true, // but no onRestoreSubmit
    });
    // Falls back to a normal (enter) pair form — no restore file picker.
    expect(splash.getHtml()).not.toContain('type="file"');
    expect(splash.getHtml()).toContain('Pair this browser');
  });
});
