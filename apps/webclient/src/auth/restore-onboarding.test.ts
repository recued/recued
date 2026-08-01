/** M5 S3.2 — `createRestoreOnboarding` state-machine transitions.
 *
 *  The orchestrator is pure over an injected `RestoreOps` side-effect boundary,
 *  so every leaf transition is driven against a configurable fake — no real WS,
 *  no real `/auth/pair`. These pin: the forward path (pair → upload → validate →
 *  preview → commit → done), the recoverable bounces (bad code / channel / upload
 *  / wrong-key), the terminal states (already-paired / server-changed / a
 *  non-empty target), the resume memory (no re-POST after a finalize failure, no
 *  re-upload on a wrong-key retry), the commit semantics (a real socket drop is
 *  success; a timeout is NOT), the schema-too-new gate, and the footgun invariant
 *  (the archive key NEVER reaches pairCode; only `importArchive`). */

import { describe, expect, it, vi } from 'vitest';
import type { ArchiveImportRebind, ArchiveManifest } from '@recued/contracts';

import {
  PAIR_CODE_INPUT_ERROR_COPY,
} from './pair-code-input-host.js';
import { PAIR_CODE_SUCCESS_ERROR_COPY } from './pair-code-success.js';
import {
  createBrowserRestoreOps,
  createRestoreOnboarding,
  RESTORE_ONBOARDING_COPY,
  type RestoreChannel,
  type RestoreOnboardingInputs,
  type RestoreOnboardingState,
  type RestoreOps,
} from './restore-onboarding.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type {
  ArchiveImportCaller,
  ArchiveUploadFile,
  ArchiveUploadFn,
} from '../settings/archive-backup-panel.js';

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const MANIFEST: ArchiveManifest = {
  format_version: 1,
  schema_version: 1,
  exported_at: '2026-06-25T00:00:00.000Z',
  record_count: 42,
  tables: { data_mail: 42 },
  includes_blobs: true,
  includes_passport: true,
};

const REBIND: ArchiveImportRebind = {
  token_id: 'tok-new',
  bearer: 'bearer-new',
  instance_id: 'inst-new',
};

const fakeFile = (
  name = 'backup.recued.archive',
  size = 4096,
  lastModified = 111,
): ArchiveUploadFile => ({
  name,
  size,
  type: 'application/octet-stream',
  lastModified,
  slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
});

const INPUTS = (over: Partial<RestoreOnboardingInputs> = {}): RestoreOnboardingInputs => ({
  serverUrl: 'http://alice.example:3001',
  code: 'pair-code-123',
  archiveKey: 'word1 word2 word3 word4',
  file: fakeFile(),
  ...over,
});

/** An rpc-style error: `.code` for the code classifiers + an Error message for
 *  the `ARCHIVE_INVALID_SIGNATURE` marker. */
const rpcErr = (code: string, message = code): Error & { code: string } =>
  Object.assign(new Error(message), { code });

type ImportResult = Awaited<ReturnType<ArchiveImportCaller>>;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ════════════════════════════════════════════════════════════════
// Fake RestoreOps
// ════════════════════════════════════════════════════════════════

type PairResult = Awaited<ReturnType<RestoreOps['pairCode']>>;
type FinalizeResult = Awaited<ReturnType<RestoreOps['finalize']>>;
type UploadMode = 'auto-done' | 'auto-error' | 'manual';

interface FakeOps {
  ops: RestoreOps;
  // Recorders
  pairCodeCalls: Array<{ serverUrl: string; code: string }>;
  finalizeCalls: Array<{ serverUrl: string; token: string; token_id?: string }>;
  openChannelCalls: number;
  uploadFiles: ArchiveUploadFile[];
  importCalls: Parameters<ArchiveImportCaller>[0][];
  stashCalls: ArchiveImportRebind[];
  channelClosed: number;
  uploadCancelled: number;
  lastUploadReq: Parameters<ArchiveUploadFn>[0] | null;
  // Knobs
  pairResult: PairResult;
  finalizeResult: FinalizeResult;
  openChannelImpl: () => Promise<RestoreChannel>;
  uploadMode: UploadMode;
  uploadStagedName: string;
  uploadErrorMessage: string;
  dryImpl: (args: Parameters<ArchiveImportCaller>[0]) => Promise<ImportResult>;
  commitImpl: (args: Parameters<ArchiveImportCaller>[0]) => Promise<ImportResult>;
}

const okPair: PairResult = {
  ok: true,
  token: 'cleartext-bearer',
  token_id: 'tok-1',
  passport: { identity: { server_public_key: 'spki' } },
};
const okFinalize: FinalizeResult = {
  ok: true,
  server_url: 'wss://alice.example:3001/ws',
  server_public_key: 'spki',
  token_id: 'tok-1',
  pair_metadata: {
    paired_at: 1,
    server_passport_fingerprint: 'spki',
    server_handle_at_pair: 'alice',
  },
};

const buildFakeOps = (): FakeOps => {
  const f: FakeOps = {
    ops: undefined as unknown as RestoreOps,
    pairCodeCalls: [],
    finalizeCalls: [],
    openChannelCalls: 0,
    uploadFiles: [],
    importCalls: [],
    stashCalls: [],
    channelClosed: 0,
    uploadCancelled: 0,
    lastUploadReq: null,
    pairResult: okPair,
    finalizeResult: okFinalize,
    openChannelImpl: undefined as unknown as () => Promise<RestoreChannel>,
    uploadMode: 'auto-done',
    uploadStagedName: 'exports/staged-archive.recued.archive',
    uploadErrorMessage: 'the connection was lost.',
    dryImpl: async () => ({ manifest: MANIFEST, restored_at: null, realm: 'same' }),
    commitImpl: async () => ({
      manifest: MANIFEST,
      restored_at: 123,
      realm: 'same',
      rebind: REBIND,
    }),
  };

  const upload: ArchiveUploadFn = (req) => {
    f.lastUploadReq = req;
    f.uploadFiles.push(req.file);
    if (f.uploadMode === 'auto-done') {
      queueMicrotask(() =>
        req.onDone({ staged_name: f.uploadStagedName, size_bytes: req.file.size }),
      );
    } else if (f.uploadMode === 'auto-error') {
      queueMicrotask(() => req.onError(f.uploadErrorMessage));
    }
    return () => {
      f.uploadCancelled += 1;
    };
  };

  const importArchive: ArchiveImportCaller = (args) => {
    f.importCalls.push(args);
    return args.dry_run ? f.dryImpl(args) : f.commitImpl(args);
  };

  const channel: RestoreChannel = {
    upload,
    importArchive,
    close: async () => {
      f.channelClosed += 1;
    },
  };

  f.openChannelImpl = async () => channel;

  f.ops = {
    pairCode: async (inputs) => {
      f.pairCodeCalls.push(inputs);
      return f.pairResult;
    },
    finalize: async (args) => {
      const rec: { serverUrl: string; token: string; token_id?: string } = {
        serverUrl: args.serverUrl,
        token: args.token,
      };
      if (args.token_id !== undefined) rec.token_id = args.token_id;
      f.finalizeCalls.push(rec);
      return f.finalizeResult;
    },
    openChannel: async () => {
      f.openChannelCalls += 1;
      return f.openChannelImpl();
    },
    stashRebind: async (rebind) => {
      f.stashCalls.push(rebind);
    },
  };

  return f;
};

/** Drive the machine to `preview` against an all-happy fake, returning the
 *  harness + handle + a state log. */
const drivenToPreview = async (
  over: Partial<RestoreOnboardingInputs> = {},
): Promise<{
  f: FakeOps;
  onboarding: ReturnType<typeof createRestoreOnboarding>;
  states: RestoreOnboardingState[];
  restoredCalls: () => number;
}> => {
  const f = buildFakeOps();
  let restored = 0;
  const onboarding = createRestoreOnboarding({
    ops: f.ops,
    onRestored: () => {
      restored += 1;
    },
  });
  const states: RestoreOnboardingState[] = [];
  onboarding.subscribe((s) => states.push(s));
  await onboarding.submit(INPUTS(over));
  return { f, onboarding, states, restoredCalls: () => restored };
};

// ════════════════════════════════════════════════════════════════
// Forward path
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — forward path', () => {
  it('initial state is collect with no error', () => {
    const f = buildFakeOps();
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    expect(onboarding.getState()).toMatchObject({ phase: 'collect', error: null });
  });

  it('submit drives pairing → uploading → validating → preview', async () => {
    const { onboarding, states, f } = await drivenToPreview();
    expect(onboarding.getState().phase).toBe('preview');
    expect(onboarding.getState().manifest).toEqual(MANIFEST);
    expect(onboarding.getState().realm).toBe('same');
    expect(onboarding.getState().blocked).toBe(false);
    // The leaf order is observable through the emitted phases.
    const phases = states.map((s) => s.phase);
    expect(phases).toEqual(
      expect.arrayContaining(['pairing', 'uploading', 'validating', 'preview']),
    );
    expect(f.pairCodeCalls).toHaveLength(1);
    expect(f.finalizeCalls).toHaveLength(1);
    expect(f.openChannelCalls).toBe(1);
    expect(f.uploadFiles).toHaveLength(1);
  });

  it('confirm commits → done, stashes the rebind, hands off to onRestored', async () => {
    const { onboarding, f, restoredCalls } = await drivenToPreview();
    await onboarding.confirm();
    expect(onboarding.getState().phase).toBe('done');
    expect(f.importCalls.filter((c) => c.dry_run === false)).toHaveLength(1);
    expect(f.stashCalls).toEqual([REBIND]);
    expect(restoredCalls()).toBe(1);
    // The (now-dead) channel is closed before handing off.
    expect(f.channelClosed).toBeGreaterThanOrEqual(1);
  });

  it('footgun: the archive key reaches importArchive, NEVER pairCode', async () => {
    const { f } = await drivenToPreview();
    // pairCode only ever saw the server URL + pairing code.
    expect(f.pairCodeCalls[0]).toEqual({
      serverUrl: 'http://alice.example:3001',
      code: 'pair-code-123',
    });
    // The archive key flowed only into the dry-run import as recoveryKey.
    expect(f.importCalls[0]).toMatchObject({
      recoveryKey: 'word1 word2 word3 word4',
      dry_run: true,
      path: 'exports/staged-archive.recued.archive',
    });
  });

  it('emits progress while uploading', async () => {
    const f = buildFakeOps();
    f.uploadMode = 'manual';
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    const p = onboarding.submit(INPUTS());
    await flush();
    expect(onboarding.getState().phase).toBe('uploading');
    f.lastUploadReq?.onProgress(2048, 4096);
    expect(onboarding.getState().upload).toEqual({ sent: 2048, total: 4096 });
    f.lastUploadReq?.onDone({ staged_name: 'exports/x', size_bytes: 4096 });
    await p;
    expect(onboarding.getState().phase).toBe('preview');
  });
});

// ════════════════════════════════════════════════════════════════
// Recoverable bounces → collect
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — recoverable bounces', () => {
  it('a bad pairing code bounces to collect (pairing stage), keeps no issued bearer', async () => {
    const f = buildFakeOps();
    f.pairResult = { ok: false, error: 'invalid_code' };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      errorStage: 'pairing',
      error: PAIR_CODE_INPUT_ERROR_COPY.invalid_code,
    });
    // A retry must re-POST /auth/pair (nothing was issued).
    f.pairResult = okPair;
    await onboarding.submit(INPUTS());
    expect(f.pairCodeCalls).toHaveLength(2);
    expect(onboarding.getState().phase).toBe('preview');
  });

  it('a channel-open failure bounces to collect, retry re-opens', async () => {
    const f = buildFakeOps();
    let fail = true;
    f.openChannelImpl = async () => {
      if (fail) throw new Error('ws down');
      return {
        upload: ((req) => {
          queueMicrotask(() =>
            req.onDone({ staged_name: 'exports/x', size_bytes: req.file.size }),
          );
          return () => {};
        }) as ArchiveUploadFn,
        importArchive: (async () => ({
          manifest: MANIFEST,
          restored_at: null,
          realm: 'same',
        })) as ArchiveImportCaller,
        close: async () => {},
      };
    };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      error: RESTORE_ONBOARDING_COPY.channel_failed,
    });
    fail = false;
    await onboarding.submit(INPUTS());
    // Pairing was NOT redone; the channel was re-opened.
    expect(f.pairCodeCalls).toHaveLength(1);
    expect(f.openChannelCalls).toBe(2);
    expect(onboarding.getState().phase).toBe('preview');
  });

  it('an upload failure bounces to collect (upload stage), retry re-uploads', async () => {
    const f = buildFakeOps();
    f.uploadMode = 'auto-error';
    f.uploadErrorMessage = 'the file is too large.';
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      errorStage: 'upload',
    });
    expect(onboarding.getState().error).toContain('the file is too large.');
    f.uploadMode = 'auto-done';
    await onboarding.submit(INPUTS());
    // Pairing skipped; upload retried (the prior upload never staged anything).
    expect(f.pairCodeCalls).toHaveLength(1);
    expect(f.uploadFiles).toHaveLength(2);
    expect(onboarding.getState().phase).toBe('preview');
  });

  it('a wrong archive key at validate bounces pristine; retry skips pair AND upload', async () => {
    const f = buildFakeOps();
    f.dryImpl = async () => {
      throw rpcErr('internal', 'derive failed: ARCHIVE_INVALID_SIGNATURE');
    };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      errorStage: 'validate',
      error: RESTORE_ONBOARDING_COPY.wrong_key,
    });
    // Server pristine — NO commit was ever attempted.
    expect(f.importCalls.every((c) => c.dry_run === true)).toBe(true);
    // Retry with the corrected key — same file, so skip pair + upload, re-validate.
    f.dryImpl = async () => ({ manifest: MANIFEST, restored_at: null, realm: 'same' });
    await onboarding.submit(INPUTS({ archiveKey: 'right key here now' }));
    expect(f.pairCodeCalls).toHaveLength(1);
    expect(f.uploadFiles).toHaveLength(1);
    expect(f.importCalls.filter((c) => c.dry_run === true)).toHaveLength(2);
    expect(onboarding.getState().phase).toBe('preview');
  });

  it('a generic validate failure bounces to collect with the failure message', async () => {
    const f = buildFakeOps();
    f.dryImpl = async () => {
      throw rpcErr('internal', 'kaboom');
    };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState().phase).toBe('collect');
    expect(onboarding.getState().error).toContain('kaboom');
  });
});

// ════════════════════════════════════════════════════════════════
// Resume memory — no re-POST after a finalize failure
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — resume after finalize failure', () => {
  it('keeps the issued bearer; retry resumes at finalize without a second /auth/pair', async () => {
    const f = buildFakeOps();
    f.finalizeResult = { ok: false, error: 'pair_code_success_passport_failed' };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      errorStage: 'pairing',
      error: PAIR_CODE_SUCCESS_ERROR_COPY.pair_code_success_passport_failed,
    });
    expect(f.pairCodeCalls).toHaveLength(1);
    expect(f.finalizeCalls).toHaveLength(1);
    // Retry — the one-shot code is NOT re-POSTed; finalize is re-attempted.
    f.finalizeResult = okFinalize;
    await onboarding.submit(INPUTS());
    expect(f.pairCodeCalls).toHaveLength(1);
    expect(f.finalizeCalls).toHaveLength(2);
    expect(onboarding.getState().phase).toBe('preview');
  });
});

// ════════════════════════════════════════════════════════════════
// Terminal states
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — terminal states', () => {
  it('an already_paired finalize result is terminal (fatal), NOT silently accepted', async () => {
    const f = buildFakeOps();
    f.finalizeResult = { ok: false, error: 'pair_code_success_already_paired' };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'fatal',
      error: RESTORE_ONBOARDING_COPY.already_paired,
    });
    // Must NOT have opened a channel against the stale (foreign) pair.
    expect(f.openChannelCalls).toBe(0);
  });

  it('changing the server after pairing is terminal (fatal), with no re-pair', async () => {
    const { onboarding, f } = await drivenToPreview();
    await onboarding.submit(INPUTS({ serverUrl: 'http://bob.example:3001' }));
    expect(onboarding.getState()).toMatchObject({
      phase: 'fatal',
      error: RESTORE_ONBOARDING_COPY.server_changed,
    });
    expect(f.pairCodeCalls).toHaveLength(1);
  });

  it('a same-server retry with only a trailing-slash difference does NOT false-fatal', async () => {
    const { onboarding } = await drivenToPreview({ serverUrl: 'http://alice.example:3001' });
    await onboarding.submit(INPUTS({ serverUrl: 'http://alice.example:3001/' }));
    expect(onboarding.getState().phase).toBe('preview');
  });

  it('a non-empty target at validate is terminal (fatal)', async () => {
    const f = buildFakeOps();
    f.dryImpl = async () => {
      throw rpcErr('archive_restore_target_not_empty', 'not empty');
    };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'fatal',
      error: RESTORE_ONBOARDING_COPY.target_not_empty,
    });
  });

  it('a cross-realm mismatch at validate is terminal (fatal)', async () => {
    const f = buildFakeOps();
    f.dryImpl = async () => {
      throw rpcErr('archive_realm_mismatch', 'cross realm');
    };
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({
      phase: 'fatal',
      error: RESTORE_ONBOARDING_COPY.realm_mismatch,
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Schema-too-new gate
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — schema gate', () => {
  it('a schema_too_new dry-run yields a BLOCKED preview; confirm is a no-op', async () => {
    const f = buildFakeOps();
    f.dryImpl = async () => ({
      manifest: MANIFEST,
      restored_at: null,
      realm: 'same',
      schema_compat: { status: 'archive_too_new', server_schema_version: 1 },
    });
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.submit(INPUTS());
    expect(onboarding.getState()).toMatchObject({ phase: 'preview', blocked: true });
    await onboarding.confirm();
    // Blocked — no commit fired, still on the preview.
    expect(f.importCalls.some((c) => c.dry_run === false)).toBe(false);
    expect(onboarding.getState().phase).toBe('preview');
  });

  it('a schema_too_new commit backstop bounces to collect with upgrade copy', async () => {
    const { onboarding, f } = await drivenToPreview();
    f.commitImpl = async () => {
      throw rpcErr('archive_schema_too_new', 'too new');
    };
    await onboarding.confirm();
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      error: RESTORE_ONBOARDING_COPY.schema_too_new,
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Commit semantics
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — commit semantics', () => {
  for (const code of ['transport', 'transport_disposed', 'webclient_reauth_required']) {
    it(`a '${code}' drop after commit is SUCCESS (server restarted), no rebind`, async () => {
      const { onboarding, f, restoredCalls } = await drivenToPreview();
      f.commitImpl = async () => {
        throw rpcErr(code, 'socket dropped');
      };
      await onboarding.confirm();
      expect(onboarding.getState().phase).toBe('done');
      expect(f.stashCalls).toHaveLength(0);
      expect(restoredCalls()).toBe(1);
    });
  }

  it('a commit timeout is NOT treated as success — bounces to a recoverable error', async () => {
    const { onboarding, f, restoredCalls } = await drivenToPreview();
    f.commitImpl = async () => {
      throw rpcErr('timeout', 'deadline');
    };
    await onboarding.confirm();
    expect(onboarding.getState().phase).toBe('collect');
    expect(onboarding.getState().error).toContain(RESTORE_ONBOARDING_COPY.restore_failed);
    expect(restoredCalls()).toBe(0);
  });

  it('a wrong-key commit rejection bounces to collect (not a false success)', async () => {
    const { onboarding, f, restoredCalls } = await drivenToPreview();
    f.commitImpl = async () => {
      throw rpcErr('internal', 'ARCHIVE_INVALID_SIGNATURE');
    };
    await onboarding.confirm();
    expect(onboarding.getState()).toMatchObject({
      phase: 'collect',
      error: RESTORE_ONBOARDING_COPY.wrong_key,
    });
    expect(restoredCalls()).toBe(0);
  });

  it('a commit that resolves WITHOUT a rebind still completes (stash skipped)', async () => {
    const { onboarding, f, restoredCalls } = await drivenToPreview();
    f.commitImpl = async () => ({ manifest: MANIFEST, restored_at: 9, realm: 'same' });
    await onboarding.confirm();
    expect(onboarding.getState().phase).toBe('done');
    expect(f.stashCalls).toHaveLength(0);
    expect(restoredCalls()).toBe(1);
  });

  it('a failed rebind stash never blocks the handoff', async () => {
    const f = buildFakeOps();
    let restored = 0;
    const onboarding = createRestoreOnboarding({
      ops: { ...f.ops, stashRebind: async () => { throw new Error('idb down'); } },
      onRestored: () => { restored += 1; },
    });
    await onboarding.submit(INPUTS());
    await onboarding.confirm();
    expect(onboarding.getState().phase).toBe('done');
    expect(restored).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// Lifecycle + guards
// ════════════════════════════════════════════════════════════════

describe('restore-onboarding — lifecycle + guards', () => {
  it('dispose during an in-flight upload resolves submit (no hang) + cancels', async () => {
    const f = buildFakeOps();
    f.uploadMode = 'manual';
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    const p = onboarding.submit(INPUTS());
    await flush();
    expect(onboarding.getState().phase).toBe('uploading');
    await onboarding.dispose();
    // The awaiting submit unblocks rather than hanging forever.
    await expect(p).resolves.toBeUndefined();
    expect(f.uploadCancelled).toBe(1);
    expect(f.channelClosed).toBeGreaterThanOrEqual(1);
  });

  it('confirm is a no-op outside a (non-blocked) preview', async () => {
    const f = buildFakeOps();
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    await onboarding.confirm(); // phase is collect
    expect(onboarding.getState().phase).toBe('collect');
    expect(f.importCalls).toHaveLength(0);
  });

  it('submit after done is ignored', async () => {
    const { onboarding, f } = await drivenToPreview();
    await onboarding.confirm();
    expect(onboarding.getState().phase).toBe('done');
    await onboarding.submit(INPUTS());
    expect(onboarding.getState().phase).toBe('done');
    expect(f.pairCodeCalls).toHaveLength(1);
  });

  it('subscribe receives every transition; unsubscribe stops delivery', async () => {
    const f = buildFakeOps();
    const onboarding = createRestoreOnboarding({ ops: f.ops, onRestored: () => {} });
    const seen: string[] = [];
    const unsub = onboarding.subscribe((s) => seen.push(s.phase));
    await onboarding.submit(INPUTS());
    expect(seen).toContain('pairing');
    expect(seen[seen.length - 1]).toBe('preview');
    unsub();
    const before = seen.length;
    await onboarding.confirm();
    expect(seen).toHaveLength(before);
  });
});

describe('restore-onboarding — browser boot wiring', () => {
  it('selects the restored server through ensureProfile, not a server_url field write', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const ensureProfile = vi.spyOn(localStore, 'ensureProfile');
    const setField = vi.spyOn(localStore, 'set');
    const tokenStore: WebclientTokenStore = {
      async wrap({ token_id, bearer }) {
        return {
          token_id,
          ciphertext_b64: `wrapped:${bearer}`,
          iv_b64: 'iv',
          issued_at: 1_700_000_000,
        };
      },
      async unwrap() {
        throw new Error('unwrap not exercised by restore finalization');
      },
    };
    const ops = createBrowserRestoreOps({
      localStore,
      profileStore: localStore,
      tokenStore,
      instanceId: 'restore-browser-1',
      invokePassportFetch: async () => {
        throw new Error('passport.fetch should not run');
      },
    });

    const result = await ops.finalize({
      serverUrl: 'https://restore.example:8443',
      token: 'restore-bearer',
      token_id: 'restore-token-1',
      passport: {
        identity: {
          server_public_key: 'restore-spki',
          current_handle: 'alice',
        },
        network: {},
      },
    });

    expect(result.ok).toBe(true);
    expect(ensureProfile).toHaveBeenCalledWith(
      'wss://restore.example:8443/ws',
    );
    expect(setField.mock.calls.some(([key]) => key === 'server_url')).toBe(false);
    expect(await localStore.inspect()).toMatchObject({
      server_url: 'wss://restore.example:8443/ws',
      server_public_key: 'restore-spki',
      webclient_token: { token_id: 'restore-token-1' },
    });
  });
});
