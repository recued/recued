/** D-185 Slice 2 — `storage: 'temp'` cli output backing + the `input_materialize`
 *  temp-ref branch.
 *
 *  A `storage: 'temp'` output_capture op leaves its produced file at a run-scoped
 *  path and surfaces a `TempFileRef` (NOT a CAS record_id string) — the file
 *  SURVIVES the call (the next step consumes it by ref) and is reclaimed only
 *  when the run-scratch root is swept at run end. The default (`storage` omitted)
 *  stays `cas`. A downstream `input_materialize` arg carrying a temp ref is the
 *  ffmpeg→whisper pipe: the path is substituted directly, no CAS read. These
 *  tests drive a real `node -e` subprocess; the ingest sink is a spy. */

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCliInvocationExecutor,
  type ToolOutputIngestInput,
} from '../cli-invocation-executor.js';
import { cleanupRunScratch, runScratchRoot } from '../execution/run-scratch.js';
import { isTempFileRef, type TempFileRef } from '@recued/contracts';

const execPath = process.execPath;

const runIds: string[] = [];
const freshRun = (label: string): string => {
  const id = `d185-cli-${label}-${runIds.length}`;
  runIds.push(id);
  return id;
};
afterEach(() => {
  for (const id of runIds.splice(0)) cleanupRunScratch(id);
});

// Writes a fixed-name file into the engine-injected output dir (the LAST argv
// token) — the by-value media-cli shape (ffmpeg `{out_dir}/audio.mp3`).
const writeOneScript = (name: string, content: string): string =>
  `const fs=require('fs'),p=require('path');const d=process.argv.at(-1);` +
  `fs.writeFileSync(p.join(d,${JSON.stringify(name)}),${JSON.stringify(content)});`;

const tempBinding = (script: string, mime = 'audio/mpeg') => ({
  kind: 'cli_invocation' as const,
  argv_template: [execPath, '-e', script, '{out_dir}'],
  shape: 'ref' as const,
  storage: 'temp' as const,
  exit_code_handling: 'zero_is_success' as const,
  output_capture: { dir_arg: 'out_dir', mime_type: mime },
});

const call = (binding: unknown, run_id: string | undefined, args: Record<string, unknown> = {}) => ({
  slug: 'ffmpeg',
  operation_key: 'media.extract_audio',
  operation_id: 'recued-core/media.extract_audio',
  args,
  timeout_ms: 5_000,
  binding,
  ...(run_id !== undefined ? { stepMeta: { run_id } } : {}),
}) as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0];

describe('D-185 Slice 2 — storage: temp cli output', () => {
  it('surfaces a TempFileRef under the run-scratch root and the file SURVIVES the call', async () => {
    const id = freshRun('survives');
    // No ingest sink wired — a temp op never touches the CAS.
    const exec = createCliInvocationExecutor({});
    const result = (await exec(
      call(tempBinding(writeOneScript('audio.mp3', 'AUDIO BYTES')), id),
    )) as Record<string, unknown>;

    const ref = result.file_ref;
    expect(isTempFileRef(ref)).toBe(true);
    const temp = ref as TempFileRef;
    expect(temp).toMatchObject({ backing: 'temp', mime_type: 'audio/mpeg', filename: 'audio.mp3' });
    expect(temp.path.startsWith(runScratchRoot(id))).toBe(true);
    // The produced file is NOT removed when the call returns (the next step
    // consumes it) — only the run-end sweep reclaims it.
    expect(existsSync(temp.path)).toBe(true);

    cleanupRunScratch(id);
    expect(existsSync(temp.path)).toBe(false); // run-end sweep removes it
  });

  it('does NOT ingest to the CAS for a temp op (the ingest sink is never called)', async () => {
    const id = freshRun('no-ingest');
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:should-not-happen' };
      },
    });
    const result = (await exec(
      call(tempBinding(writeOneScript('audio.mp3', 'X')), id),
    )) as Record<string, unknown>;
    expect(ingested).toHaveLength(0);
    expect(isTempFileRef(result.file_ref)).toBe(true);
  });

  it("storage: 'cas' ⇒ a bare record_id string (CAS ingest, the kept-artifact opt-in)", async () => {
    const id = freshRun('cas-explicit');
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:cas123' }),
    });
    const casBinding = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', writeOneScript('out.md', 'MD'), '{out_dir}'],
      shape: 'ref' as const,
      storage: 'cas' as const,
      exit_code_handling: 'zero_is_success' as const,
      output_capture: { dir_arg: 'out_dir', mime_type: 'text/markdown' },
    };
    const result = (await exec(call(casBinding, id))) as Record<string, unknown>;
    expect(result.file_ref).toBe('file:cas123');
    expect(isTempFileRef(result.file_ref)).toBe(false);
  });

  it('content isolation (D-185 Slice 3) — an output_capture op NEVER captures stdout, even with a value shape', async () => {
    // The validators reject output_capture + a value shape, but the executor is
    // defense-in-depth: a malformed binding that slips through produces ONLY a
    // file_ref, never also result.stdout (which would leak the file content).
    const id = freshRun('iso');
    const exec = createCliInvocationExecutor({});
    // Writes the produced file AND echoes content to stdout.
    const script =
      `const fs=require('fs'),p=require('path');const d=process.argv.at(-1);` +
      `fs.writeFileSync(p.join(d,'audio.mp3'),'BYTES');process.stdout.write('LEAKED CONTENT');`;
    const malformed = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', script, '{out_dir}'],
      shape: 'text' as const, // a value shape ALONGSIDE output_capture (malformed)
      storage: 'temp' as const,
      exit_code_handling: 'zero_is_success' as const,
      output_capture: { dir_arg: 'out_dir', mime_type: 'audio/mpeg' },
    };
    const result = (await exec(call(malformed, id))) as Record<string, unknown>;
    expect(isTempFileRef(result.file_ref)).toBe(true); // the ref is produced
    expect(result.stdout).toBeUndefined(); // but stdout is NOT captured (no leak)
  });

  it('storage OMITTED ⇒ temp (D-185 Slice 3 framework default — throwaway baseline)', async () => {
    const id = freshRun('temp-default');
    // No ingest sink + no storage on the binding: the default is temp, so the
    // op surfaces a TempFileRef (never touches the CAS).
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:should-not-happen' }),
    });
    const omittedStorage = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', writeOneScript('audio.mp3', 'X'), '{out_dir}'],
      shape: 'ref' as const,
      exit_code_handling: 'zero_is_success' as const,
      output_capture: { dir_arg: 'out_dir', mime_type: 'audio/mpeg' },
    };
    const result = (await exec(call(omittedStorage, id))) as Record<string, unknown>;
    expect(isTempFileRef(result.file_ref)).toBe(true);
  });

  it('fails closed: storage: temp without a run scope (no run_id)', async () => {
    const exec = createCliInvocationExecutor({});
    await expect(
      exec(call(tempBinding(writeOneScript('audio.mp3', 'X')), undefined)),
    ).rejects.toThrow(/requires a run scope/);
  });

  it('still fails loud when a temp op produces no matching file', async () => {
    const id = freshRun('empty');
    const exec = createCliInvocationExecutor({});
    // Declares audio/mpeg but writes a .txt — no match.
    await expect(
      exec(call(tempBinding(writeOneScript('notes.txt', 'X')), id)),
    ).rejects.toThrow(/produced no mp3 file/);
  });
});

describe('D-185 Slice 2 — input_materialize temp-ref branch (the local pipe)', () => {
  // Copies the materialized source (argv[1]) to a dest (argv[2]) — proving the
  // cli read the temp ref's path directly, with NO CAS read.
  const COPY_SCRIPT =
    `const fs=require('fs');fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1]));`;

  it('substitutes a temp ref path directly into the cli arg — no readFileBytes call', async () => {
    const id = freshRun('materialize-temp');
    // Stage a real temp file under the run root (as a prior temp op would).
    const { allocateRunScratchDir } = await import('../execution/run-scratch.js');
    const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = allocateRunScratchDir(id);
    const srcPath = join(dir, 'audio.mp3');
    writeFileSync(srcPath, 'PIPED AUDIO');
    const dest = join(mkdtempSync(join(tmpdir(), 'd185-pipe-dest-')), 'copy.bin');

    let readCalled = false;
    const exec = createCliInvocationExecutor({
      readFileBytes: async () => {
        readCalled = true;
        return { bytes: Buffer.from('x'), mime_type: 'text/plain', filename: 'x' };
      },
    });
    const tempRef: TempFileRef = { backing: 'temp', path: srcPath, mime_type: 'audio/mpeg', filename: 'audio.mp3' };
    const binding = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', COPY_SCRIPT, '{source}', '{dest}'],
      exit_code_handling: 'zero_is_success' as const,
      input_materialize: { kind: 'file_ref' as const, arg: 'source' },
    };

    await exec(call(binding, id, { source: tempRef, dest }));

    expect(readCalled).toBe(false); // temp path used directly, no CAS read
    expect(readFileSync(dest).toString('utf8')).toBe('PIPED AUDIO');
  });
});
