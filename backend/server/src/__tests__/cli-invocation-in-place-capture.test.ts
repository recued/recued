/** In-place `output_capture` — `CliOutputCaptureSpec.from_input_arg`.
 *
 *  For a tool that EDITS its input and offers no output path (`officecli batch`,
 *  `ruff --fix`, in-place `ocrmypdf`) there is no engine-owned `dir_arg` to bind:
 *  the produced file IS the materialized input. These tests drive a real
 *  `node -e` subprocess that rewrites the file it is handed, and assert the four
 *  properties the design rests on:
 *
 *    1. the edited copy is captured (and the CAS/temp carriers both work);
 *    2. the caller's stored record is never the thing edited — the tool only
 *       ever sees the engine's throwaway copy;
 *    3. a `temp` capture SURVIVES the materialize wrapper's cleanup (it is
 *       copied into run-scratch, not aliased into the about-to-be-swept dir);
 *    4. the passthrough lane (a literal local path) is REFUSED, because the
 *       whole posture depends on the written path being engine-chosen.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';

const execPath = process.execPath;
const tmpInDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('recued-cli-in-'));

const FILE_REF = `file:${'a'.repeat(32)}`;

/** Appends to the file it is given — an in-place editor. */
const EDIT_SCRIPT =
  `const fs=require('fs');`
  + `fs.writeFileSync(process.argv[1],fs.readFileSync(process.argv[1],'utf8')+'-EDITED');`;

/** Deletes its input instead of editing it — the "tool renamed/removed" case. */
const DELETE_SCRIPT = `require('fs').unlinkSync(process.argv[1]);`;

const inPlaceBinding = (storage?: 'cas' | 'temp') => ({
  kind: 'cli_invocation' as const,
  argv_template: [execPath, '-e', EDIT_SCRIPT, '{source}'],
  shape: 'ref' as const,
  ...(storage ? { storage } : {}),
  exit_code_handling: 'zero_is_success' as const,
  output_capture: { from_input_arg: 'source', mime_type: 'text/plain' },
  input_materialize: { kind: 'file_ref' as const, arg: 'source' },
});

const call = (binding: unknown, args: Record<string, unknown>) => ({
  slug: 'officecli',
  operation_key: 'document.template_fill',
  operation_id: 'recued-core/document.template_fill',
  args,
  timeout_ms: 5_000,
  binding,
  stepMeta: { run_id: 'run-in-place-1' },
}) as unknown as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0];

const readFileBytes = async (recordId: string) => {
  expect(recordId).toBe(FILE_REF);
  return {
    bytes: Buffer.from('ORIGINAL', 'utf8'),
    filename: 'template.txt',
    mime_type: 'text/plain',
  };
};

describe('cli_invocation in-place output_capture', () => {
  it('captures the edited materialized copy into the CAS', async () => {
    const ingested: Array<{ bytes: Buffer; filename: string; mime_type: string }> = [];
    const exec = createCliInvocationExecutor({
      readFileBytes,
      ingestToolOutput: async (input) => {
        ingested.push(input as { bytes: Buffer; filename: string; mime_type: string });
        return { record_id: 'file:out' };
      },
    });

    const result = await exec(call(inPlaceBinding('cas'), { source: FILE_REF })) as {
      file_ref: string; filename: string; mime_type: string;
    };

    expect(result.file_ref).toBe('file:out');
    expect(result.mime_type).toBe('text/plain');
    // The cli saw the ORIGINAL bytes and its edit is what got ingested.
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.bytes.toString('utf8')).toBe('ORIGINAL-EDITED');
    // ...and the materialize temp dir is gone afterwards.
    expect(tmpInDirs()).toEqual([]);
  });

  it('temp capture survives the materialize cleanup (copied into run-scratch)', async () => {
    const exec = createCliInvocationExecutor({ readFileBytes });

    const result = await exec(call(inPlaceBinding('temp'), { source: FILE_REF })) as {
      file_ref: { backing: string; path: string; filename: string; mime_type: string };
    };

    expect(result.file_ref.backing).toBe('temp');
    // ⛔ The property that fails if the temp arm aliases the materialized path:
    // the input dir is swept in the wrapper's `finally`, so a ref pointing into
    // it would be dangling by the time the next step reads it.
    expect(existsSync(result.file_ref.path)).toBe(true);
    expect(readFileSync(result.file_ref.path, 'utf8')).toBe('ORIGINAL-EDITED');
    expect(result.file_ref.path.startsWith(tmpdir())
      && result.file_ref.path.includes('recued-cli-in-')).toBe(false);
    expect(tmpInDirs()).toEqual([]);
  });

  it('REFUSES the passthrough lane — a literal local path is not engine-chosen', async () => {
    // The input that would DO THE THING if the guard were gone: a caller-named
    // path the tool would write to and this op would then ingest from.
    const victimDir = mkdtempSync(join(tmpdir(), 'in-place-victim-'));
    const victim = join(victimDir, 'caller-owned.txt');
    writeFileSync(victim, 'CALLER OWNED');

    const exec = createCliInvocationExecutor({
      readFileBytes,
      ingestToolOutput: async () => ({ record_id: 'file:out' }),
    });

    await expect(exec(call(inPlaceBinding('cas'), { source: victim })))
      .rejects.toThrow(/requires a data\.file ref/);
    // The refusal happens BEFORE the spawn — the caller's file is untouched.
    expect(readFileSync(victim, 'utf8')).toBe('CALLER OWNED');
  });

  it('copies a TempFileRef rather than editing the prior step\'s run-scratch file', async () => {
    const priorDir = mkdtempSync(join(tmpdir(), 'in-place-prior-'));
    const priorPath = join(priorDir, 'prior.txt');
    writeFileSync(priorPath, 'PRIOR');

    const exec = createCliInvocationExecutor({
      readFileBytes,
      ingestToolOutput: async (input) => {
        expect((input as { bytes: Buffer }).bytes.toString('utf8')).toBe('PRIOR-EDITED');
        return { record_id: 'file:out' };
      },
    });

    await exec(call(inPlaceBinding('cas'), {
      source: { backing: 'temp', path: priorPath, mime_type: 'text/plain', filename: 'prior.txt' },
    }));

    // ⛔ The prior step may still hold this ref. An in-place editor that took the
    // pass-by-path shortcut would have rewritten it underneath them.
    expect(readFileSync(priorPath, 'utf8')).toBe('PRIOR');
    expect(tmpInDirs()).toEqual([]);
  });

  it('fails loud when the tool removes its input instead of editing it', async () => {
    const exec = createCliInvocationExecutor({
      readFileBytes,
      ingestToolOutput: async () => ({ record_id: 'file:out' }),
    });

    await expect(exec(call({
      ...inPlaceBinding('cas'),
      argv_template: [execPath, '-e', DELETE_SCRIPT, '{source}'],
    }, { source: FILE_REF }))).rejects.toThrow(/missing after the run/);
  });

  it('rejects captured bytes that are not a ZIP container for an OOXML mime', async () => {
    const exec = createCliInvocationExecutor({
      readFileBytes,
      ingestToolOutput: async () => ({ record_id: 'file:out' }),
    });

    await expect(exec(call({
      ...inPlaceBinding('cas'),
      output_capture: {
        from_input_arg: 'source',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    }, { source: FILE_REF }))).rejects.toThrow(/invalid OOXML bytes/);
  });
});
