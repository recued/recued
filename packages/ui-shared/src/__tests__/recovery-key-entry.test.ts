/** Recovery-key entry primitive tests — happy path, every failure
 *  branch, and the verify-against-stored-check semantics.
 *
 *  Ported from `apps/extension/src/recovery/__tests__/entry.test.ts`
 *  at `c222acac^`. */

import { describe, it, expect } from 'vitest';
import {
  initialRecoveryKeyEntrySlice,
  createRecoveryKeyEntryHandlers,
  renderRecoveryKeyEntry,
  type RecoveryKeyEntrySlice,
  type RecoveryEntryCrypto,
} from '../account/recovery-key-entry.js';
import {
  writeRecoveryCheck,
  type RecoveryCheckStorage,
} from '../account/recovery-check-store.js';

const KEY =
  'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
  'account accuse achieve acid acoustic acquire across act action actor actress actual';
const WRONG_KEY =
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo ' +
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo';

const mkStorage = (): RecoveryCheckStorage & { _backing: Map<string, unknown> } => {
  const backing = new Map<string, unknown>();
  return {
    _backing: backing,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) backing.delete(k);
    },
  };
};

const mkStateStore = (initial: RecoveryKeyEntrySlice = initialRecoveryKeyEntrySlice()) => {
  let slice = { ...initial };
  return {
    getSlice: () => slice,
    setState: (patch: Partial<RecoveryKeyEntrySlice>) => { slice = { ...slice, ...patch }; },
  };
};

const mkFakeCrypto = (overrides: Partial<RecoveryEntryCrypto> = {}): RecoveryEntryCrypto => ({
  isValid: () => true,
  deriveKek: async () => ({} as CryptoKey),
  verifyCheck: async () => true,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────

describe('createRecoveryKeyEntryHandlers — happy path', () => {
  it('start → setEntry → submit calls onSubmit with the verified key', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    await writeRecoveryCheck(storage, 'check-blob');
    const submitted: string[] = [];
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async (key) => { submitted.push(key); },
      crypto: mkFakeCrypto(),
    });

    h.start();
    expect(store.getSlice().stage).toBe('entering');

    h.setEntry(KEY);
    expect(store.getSlice().entry).toBe(KEY);

    await h.submit();
    expect(submitted).toEqual([KEY.toLowerCase()]);
    expect(store.getSlice().stage).toBe('done');
    expect(store.getSlice().entry).toBe('');
  });

  it('normalizes whitespace + case before passing to onSubmit', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    await writeRecoveryCheck(storage, 'check-blob');
    const submitted: string[] = [];
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async (key) => { submitted.push(key); },
      crypto: mkFakeCrypto(),
    });

    h.start();
    h.setEntry(`  Abandon  Ability   Able about above absent absorb abstract absurd abuse access accident
account accuse achieve acid acoustic acquire across act action actor actress actual  `);
    await h.submit();
    expect(submitted[0]).toBe(KEY); // lowercased + collapsed
  });
});

// ────────────────────────────────────────────────────────────────
// Failure branches
// ────────────────────────────────────────────────────────────────

describe('submit — invalid input', () => {
  it('BIP39 invalid → error, no kek derivation, no onSubmit call', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    await writeRecoveryCheck(storage, 'check-blob');
    let submitted = false;
    const crypto = mkFakeCrypto({ isValid: () => false });
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async () => { submitted = true; },
      crypto,
    });

    h.start();
    h.setEntry('bogus');
    await h.submit();

    expect(store.getSlice().stage).toBe('entering');
    expect(store.getSlice().error).toMatch(/typos|valid 24-word/);
    expect(submitted).toBe(false);
  });

  it('no local check enrolled → clear "set up first" error', async () => {
    const store = mkStateStore();
    const storage = mkStorage(); // empty
    let submitted = false;
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async () => { submitted = true; },
      crypto: mkFakeCrypto(),
    });

    h.start();
    h.setEntry(KEY);
    await h.submit();

    expect(store.getSlice().stage).toBe('entering');
    expect(store.getSlice().error).toMatch(/No recovery key is set up/);
    expect(submitted).toBe(false);
  });

  it('verify mismatch (wrong key) → clear "doesn\'t match" error, no onSubmit', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    await writeRecoveryCheck(storage, 'check-blob');
    let submitted = false;
    const crypto = mkFakeCrypto({ verifyCheck: async () => false });
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async () => { submitted = true; },
      crypto,
    });

    h.start();
    h.setEntry(WRONG_KEY);
    await h.submit();

    expect(store.getSlice().stage).toBe('entering');
    expect(store.getSlice().error).toMatch(/doesn'?t match/);
    expect(submitted).toBe(false);
  });

  it('onSubmit throws → error surfaces, stage returns to entering, entry wiped', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    await writeRecoveryCheck(storage, 'check-blob');
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async () => { throw new Error('pair failed'); },
      crypto: mkFakeCrypto(),
    });

    h.start();
    h.setEntry(KEY);
    await h.submit();

    expect(store.getSlice().stage).toBe('entering');
    expect(store.getSlice().error).toBe('pair failed');
    // Wipe `entry` even when onSubmit fails post-verification — the
    // key has already done its job and shouldn't sit in UI state
    // ready to re-render into the 24-slot grid on the next paint.
    expect(store.getSlice().entry).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// Guards + cancel
// ────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('submit before start is a no-op', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    let submitted = false;
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async () => { submitted = true; },
      crypto: mkFakeCrypto(),
    });

    h.setEntry(KEY);
    await h.submit();
    expect(store.getSlice().stage).toBe('idle');
    expect(submitted).toBe(false);
  });

  it('cancel from any stage clears the slice', () => {
    const store = mkStateStore({
      stage: 'entering',
      entry: 'leaking',
      error: 'something',
    });
    const storage = mkStorage();
    const h = createRecoveryKeyEntryHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      onSubmit: async () => {},
      crypto: mkFakeCrypto(),
    });

    h.cancel();
    expect(store.getSlice()).toEqual(initialRecoveryKeyEntrySlice());
  });
});

// ────────────────────────────────────────────────────────────────
// Renderer (smoke — full coverage tied to caller wiring)
// ────────────────────────────────────────────────────────────────

describe('renderRecoveryKeyEntry', () => {
  it('emits 24 indexed inputs + the supplied submit/cancel actions', () => {
    const html = renderRecoveryKeyEntry({
      slice: { stage: 'entering', entry: '', error: null },
      title: 'Enter your key',
      body: 'Body copy',
      submitLabel: 'Use it',
      submitAction: 'do-submit',
      cancelAction: 'do-cancel',
      dataField: 'recovery-entry-field',
      idPrefix: 'recovery-entry',
    });
    for (let i = 0; i < 24; i++) {
      expect(html).toContain(`data-index="${i}"`);
    }
    const slotCount = (html.match(/data-recovery-entry-field="entry-word"/g) ?? []).length;
    expect(slotCount).toBe(24);
    expect(html).toContain('data-action="do-submit"');
    expect(html).toContain('data-action="do-cancel"');
    expect(html).toContain('Enter your key');
    expect(html).toContain('Body copy');
    expect(html).toContain('Use it');
  });

  it('renders nothing on idle / done — host owns the wrapping container', () => {
    const idle = renderRecoveryKeyEntry({
      slice: { stage: 'idle', entry: '', error: null },
      title: '', body: '', submitLabel: '',
      submitAction: 'a', cancelAction: 'b',
      dataField: 'f', idPrefix: 'p',
    });
    expect(idle).toBe('');
    const done = renderRecoveryKeyEntry({
      slice: { stage: 'done', entry: '', error: null },
      title: '', body: '', submitLabel: '',
      submitAction: 'a', cancelAction: 'b',
      dataField: 'f', idPrefix: 'p',
    });
    expect(done).toBe('');
  });

  it('disables submit until 24 words + during verifying/submitting', () => {
    const empty = renderRecoveryKeyEntry({
      slice: { stage: 'entering', entry: '', error: null },
      title: '', body: '', submitLabel: '',
      submitAction: 'do-submit', cancelAction: 'do-cancel',
      dataField: 'f', idPrefix: 'p',
    });
    expect(empty).toMatch(/data-action="do-submit"[^>]* disabled/);

    const verifying = renderRecoveryKeyEntry({
      slice: { stage: 'verifying', entry: KEY, error: null },
      title: '', body: '', submitLabel: '',
      submitAction: 'do-submit', cancelAction: 'do-cancel',
      dataField: 'f', idPrefix: 'p',
    });
    expect(verifying).toMatch(/data-action="do-submit"[^>]* disabled/);
    expect(verifying).toContain('Verifying…');
  });
});
