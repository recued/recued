/** D-241 P4 — a SYNCED vendor document reaches a converter.
 *
 *  ⛔ **The gap was one branch, not a missing capability.** A File Source syncs
 *  metadata; the bytes stay at the vendor behind a `file:remote:*` id, and the
 *  per-vendor byte resolvers that fetch them have shipped since D-192 (three
 *  read channels already use them). But the cli executor's ONLY byte dep —
 *  `readFileBytes`, built in `wire-execute-deps.ts` — was
 *  `inboundFileCollection.readBytes`, which refuses anything that is not a CAS
 *  blob. So `input_materialize` could hand markitdown / docling / libreoffice a
 *  downloaded file and never a synced one.
 *
 *  🔑 A converter wants BYTES ON A PATH, not a CAS record. That is why this is a
 *  route, not a new op: `resolveRemoteFileBytes` already returns the same
 *  `{ bytes, mime_type, filename }` the CAS read does, already enforces
 *  `REMOTE_FILE_READ_MAX_BYTES`, and already falls back to the mirror `meta` for
 *  the filename — which is where the extension every converter dispatches on
 *  comes from.
 *
 *  ── WHAT THIS DRIVES ──────────────────────────────────────────────────────
 *
 *  The REAL `composeExecuteDeps` → the REAL `cliInvocationExecutor` → a REAL
 *  subprocess that reads the materialized temp file. Only the two edges are
 *  faked (the mirror store and the vendor's bytes), because everything between
 *  them is the thing under test. A test that stubbed `readFileBytes` — as the
 *  sibling `cli-invocation-input-materialize` suite does, correctly, for its own
 *  question — would pass identically before and after this change: the stub IS
 *  the seam that was broken.
 *  ([[feedback_two_suites_stubbing_the_same_boundary_cover_everything_but_the_join]])
 *
 *  ⚠ **SHARED TMPDIR SURFACE — this file materializes through the REAL boot
 *  composer, so its `recued-cli-in-*` dirs land in `os.tmpdir()` and it cannot
 *  inject a root of its own** (`composeExecuteDeps` builds the executor; a
 *  tempRoot knob on the boot path would be a test seam in production wiring).
 *  That is safe now: the three suites that used to assert on the GLOBAL temp
 *  surface — `cli-invocation-input-materialize`, `cli-invocation-in-place-capture`,
 *  `cli-invocation-output-capture` — each own a `TEMP_ROOT` they pass to the
 *  executor, so nothing reads `os.tmpdir()` globally any more. Before that they
 *  red EACH OTHER under `pool: 'threads'` with this file absent.
 *  ⛔ If a future suite needs isolation, inject `tempRoot`; do NOT set
 *  `process.env.TMPDIR` — the pool is THREADS, so that redirects every
 *  concurrently-running suite's `tmpdir()` mid-flight and turns one flake into
 *  many. */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RpcError } from '@recued/contracts';

import {
  composeExecuteDeps,
  type ComposeExecuteDepsDeps,
} from '../composition/bin/wire-execute-deps.js';
import { remoteFileRecordId } from '../file-view-resolver.js';
import type { InboundFileCollection } from '../collections/file/inbound-file-collection.js';
import type { RemoteFileReadDeps } from '../collections/file/remote-file-byte-resolver.js';

/** A Dropbox File Source scope: `CONNECTION_SOURCE_ID(provider, name, 'file')`. */
const SCOPE = 'dropbox.work.file';
const TARGET = 'id:AAAA1111';
const REMOTE_REF = remoteFileRecordId(SCOPE, TARGET);
const CAS_REF = `file:${'a'.repeat(32)}`;

const VENDOR_BYTES = Buffer.from('THE SYNCED DOCUMENT, FETCHED FROM THE VENDOR');
const CAS_BYTES = Buffer.from('A LOCALLY DOWNLOADED FILE');

/** Reads the materialized source (argv[1]) and copies it where the test can see
 *  it (argv[2]) — the subprocess proves what actually landed on disk. */
const COPY_SCRIPT =
  `const fs=require('fs');`
  + `fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1]));`;

const dest = (): string =>
  join(mkdtempSync(join(tmpdir(), 'd241-materialize-')), 'copy.bin');

const copyBinding = () => ({
  kind: 'cli_invocation' as const,
  argv_template: [process.execPath, '-e', COPY_SCRIPT, '{source}', '{dest}'],
  exit_code_handling: 'zero_is_success' as const,
  input_materialize: { kind: 'file_ref' as const, arg: 'source' },
});

/** The inbound CAS collection, faked at exactly the two behaviours that matter:
 *  it answers for a CAS id and REFUSES a remote one — the real refusal at
 *  `inbound-file-collection.ts:450`, which is correct and stays. */
const inboundCollection = (reads: string[]): InboundFileCollection =>
  ({
    readBytes: async (record_id: string) => {
      reads.push(record_id);
      if (record_id !== CAS_REF) {
        throw new Error(
          `data.file.received.readBytes: record '${record_id}' is not a CAS blob (remote refs resolve through the file_meta_ref read path)`,
        );
      }
      return { bytes: CAS_BYTES, mime_type: 'application/pdf', filename: 'downloaded.pdf' };
    },
    ingest: vi.fn(),
    get: vi.fn(),
  }) as unknown as InboundFileCollection;

const remoteDeps = (
  fetchBytes: () => Promise<{ bytes: Buffer; mime_type?: string; filename?: string }>,
  seen: string[],
): RemoteFileReadDeps =>
  ({
    fileMetaStore: {
      get: (scope: string, target_id: string) =>
        scope === SCOPE && target_id === TARGET
          ? {
              meta: {
                provider: 'dropbox',
                remote_id: TARGET,
                filename: 'quarterly-report.docx',
                mime_type:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                size: VENDOR_BYTES.length,
              },
            }
          : null,
    },
    resolveConnection: async (name: string) => {
      seen.push(name);
      return { kind: 'bearer', token: 'dropbox-token' };
    },
    byteResolvers: {
      dropbox: async () => fetchBytes(),
    },
  }) as unknown as RemoteFileReadDeps;

const baseDeps = (
  overrides: Partial<ComposeExecuteDepsDeps>,
): ComposeExecuteDepsDeps =>
  ({
    recipeStore: { get: vi.fn(() => null), ids: vi.fn(() => []) },
    executorConfig: { manifests: {} },
    baseVault: {},
    serverInstanceId: 'server-1',
    serverDisplayName: 'Server One',
    eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), replay: vi.fn(() => []) },
    getExecuteDeps: vi.fn(() => undefined),
    ...overrides,
  }) as unknown as ComposeExecuteDepsDeps;

/** The composed executor, with its presence asserted rather than assumed — an
 *  unwired one would otherwise surface as a confusing `undefined is not a
 *  function` four tests deep. */
const runCli = (bundle: ReturnType<typeof composeExecuteDeps>) => {
  const exec = bundle.executeDeps.cliInvocationExecutor;
  if (exec === undefined) throw new Error('composeExecuteDeps wired no cli executor');
  return exec;
};

const call = (args: Record<string, unknown>) =>
  ({
    slug: 'markitdown',
    operation_key: 'document.to_markdown',
    operation_id: 'recued-core/document.to_markdown',
    args,
    timeout_ms: 10_000,
    binding: copyBinding(),
    stepMeta: { run_id: 'run-d241' },
  }) as never;

describe('the cli byte reader routes a mirrored vendor file to its resolver', () => {
  it('materializes a file:remote:* id from the vendor, not from the CAS', async () => {
    const casReads: string[] = [];
    const connections: string[] = [];
    const bundle = composeExecuteDeps(baseDeps({
      inboundFileCollection: inboundCollection(casReads),
      getRemoteFileReadDeps: () =>
        remoteDeps(async () => ({ bytes: VENDOR_BYTES }), connections),
    }));
    const out = dest();

    await runCli(bundle)(call({ source: REMOTE_REF, dest: out }));

    // The subprocess read the vendor's bytes off a real temp path.
    expect(readFileSync(out)).toEqual(VENDOR_BYTES);
    // ⛔ The CAS collection was never asked — its refusal is the boundary this
    // routes AROUND, not one it now punches through.
    expect(casReads).toEqual([]);
    // The connection name is recovered from the Source scope, so the fetch is
    // authenticated the same way the mirror walk was.
    expect(connections).toEqual(['work']);
  });

  it('still materializes a CAS id through the inbound collection', async () => {
    const casReads: string[] = [];
    const bundle = composeExecuteDeps(baseDeps({
      inboundFileCollection: inboundCollection(casReads),
      getRemoteFileReadDeps: () => remoteDeps(async () => ({ bytes: VENDOR_BYTES }), []),
    }));
    const out = dest();

    await runCli(bundle)(call({ source: CAS_REF, dest: out }));

    expect(readFileSync(out)).toEqual(CAS_BYTES);
    expect(casReads).toEqual([CAS_REF]);
  });

  /** ⛔ A boot with no file-source stores (the standalone MCP context) must
   *  REFUSE a remote id, never materialize an empty file — an empty temp file is
   *  a converter reading zero bytes and reporting success. */
  it('refuses a remote id when no remote reader is wired', async () => {
    const casReads: string[] = [];
    const bundle = composeExecuteDeps(baseDeps({
      inboundFileCollection: inboundCollection(casReads),
    }));

    await expect(
      runCli(bundle)(call({ source: REMOTE_REF, dest: dest() })),
    ).rejects.toThrow(/no remote byte reader is wired/u);
    expect(casReads).toEqual([]);
  });

  /** ⛔⛔ THE JOIN, and it is the one every test above is blind to. The three
   *  drives hand `getRemoteFileReadDeps` to `composeExecuteDeps` themselves, so
   *  they prove the composer USES it and say nothing about whether BOOT PASSES
   *  IT. Deleting that one line from `compose-execution-context.ts` left all of
   *  them green — verified by mutation — and the field is optional, so it fails
   *  CLOSED and silently: every converter simply goes back to refusing synced
   *  files, which is the exact bug this slice fixes.
   *
   *  A source read rather than a drive, because composing the real execution
   *  context needs a whole `AppContext`. It is scoped to the
   *  `composeExecuteDeps` call — the SAME bundle also goes to
   *  `composeExecutorConfig` earlier in the file for the `data-file-read`
   *  channel, and a whole-file `toContain` would be satisfied by that one alone.
   *  ([[feedback_two_suites_stubbing_the_same_boundary_cover_everything_but_the_join]]) */
  it('is wired at boot, not only in these tests', () => {
    const source = readFileSync(
      join(__dirname, '..', 'serve', 'compose-execution-context.ts'),
      'utf8',
    );
    const marker = source.indexOf('composeExecuteDeps({');
    expect(marker, 'composeExecuteDeps call not found — this pin has gone stale').toBeGreaterThan(0);
    expect(
      source.slice(marker),
      'compose-execution-context no longer passes getRemoteFileReadDeps to composeExecuteDeps, '
      + 'so the cli reader silently loses its remote branch and every synced document '
      + 'stops reaching a converter — with nothing failing.',
    ).toContain('getRemoteFileReadDeps: app.getRemoteFileReadDeps');
  });

  /** ⛔ A per-row permanent gap (Notion's data-source property files) must
   *  surface as the resolver's own structured failure. */
  it('propagates a resolver refusal instead of writing an empty temp file', async () => {
    const bundle = composeExecuteDeps(baseDeps({
      inboundFileCollection: inboundCollection([]),
      getRemoteFileReadDeps: () =>
        remoteDeps(async () => {
          throw new RpcError('remote_unresolvable', 'no re-resolvable block', 422);
        }, []),
    }));

    await expect(
      runCli(bundle)(call({ source: REMOTE_REF, dest: dest() })),
    ).rejects.toThrow(/no re-resolvable block/u);
  });
});
