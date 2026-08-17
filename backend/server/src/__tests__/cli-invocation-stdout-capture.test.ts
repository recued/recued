/** STDOUT `output_capture` — `CliOutputCaptureSpec.from_stdout`.
 *
 *  🔑 THE GAP THIS CLOSES. A tool that only PRINTS — csvgrep, ripgrep, jq,
 *  dasel, csvcut, sqlite3 — has no output path for `dir_arg` to bind and never
 *  edits its input, so it could not declare `shape: 'ref'` at all. And a VALUE
 *  shape is refused alongside `input_materialize` (D-185 Slice 3), because
 *  captured stdout could echo a warehouse file's bytes into an op-step value.
 *  Between the two, **no filter could read a warehouse file**: searching one
 *  meant pulling the whole thing through recipe step state, base64 + text +
 *  parsed rows resident at once. The executor's own ceiling error even advised
 *  "declare shape:'ref' for large output" — advice such an op had no way to take.
 *
 *  ⛔ THE POSTURE IS UNCHANGED, which is the argument for the arm existing. The
 *  bytes go to a path the ENGINE chose and return only as a Gateway-gated
 *  `file_ref`; they never enter a value and the path is never handed back.
 *  That is exactly the `dir_arg` trade. Contrast a DETACHED job, which also
 *  redirects stdout to a file and is REFUSED alongside `input_materialize` —
 *  because it RETURNS its `log_path`. Capturing is safe; handing back the path
 *  is not, and these tests pin the difference.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';

const execPath = process.execPath;

/** ⛔ This suite owns its temp root — asserting a GLOBAL temp dir is empty is a
 *  coin flip against any sibling test that materializes concurrently. Same
 *  lesson the in-place suite records. */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'cli-stdout-root-'));
const strayDirs = (): string[] =>
  readdirSync(TEMP_ROOT).filter((n) => n.startsWith('recued-cli-'));

const FILE_REF = `file:${'b'.repeat(32)}`;

/** A stdout-only filter: reads the file it is given, prints matching lines.
 *  This is csvgrep's shape — it writes NOTHING and takes no output path. */
const GREP_SCRIPT =
  `const fs=require('fs');`
  + `const rows=fs.readFileSync(process.argv[1],'utf8').split('\\n');`
  + `process.stdout.write(rows.filter((r,i)=>i===0||r.includes(process.argv[2])).join('\\n'));`;

/** Prints far more than the ceiling, to force the guard. */
const FLOOD_SCRIPT = `process.stdout.write('x'.repeat(Number(process.argv[1])));`;

const CSV = 'Name,Email\nAcme,ops@acme.test\nGlobex,hi@globex.test';

const stdoutBinding = (storage?: 'cas' | 'temp') => ({
  kind: 'cli_invocation' as const,
  argv_template: [execPath, '-e', GREP_SCRIPT, '{source}', '{match}'],
  shape: 'ref' as const,
  ...(storage ? { storage } : {}),
  exit_code_handling: 'zero_is_success' as const,
  output_capture: { from_stdout: true, mime_type: 'text/csv', filename: 'matched.csv' },
  input_materialize: { kind: 'file_ref' as const, arg: 'source' },
});

const call = (binding: unknown, args: Record<string, unknown>) => ({
  slug: 'csvgrep',
  operation_key: 'csv.search',
  operation_id: 'recued-core/csv.search',
  args,
  timeout_ms: 10_000,
  binding,
  stepMeta: { run_id: 'run-stdout-1' },
}) as unknown as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0];

const readFileBytes = async (recordId: string) => {
  expect(recordId).toBe(FILE_REF);
  return { bytes: Buffer.from(CSV, 'utf8'), filename: 'people.csv', mime_type: 'text/csv' };
};

describe('cli_invocation stdout output_capture', () => {
  it('captures what the tool PRINTED into the CAS', async () => {
    const ingested: Array<{ bytes: Buffer; filename: string; mime_type: string }> = [];
    const exec = createCliInvocationExecutor({
      tempRoot: TEMP_ROOT,
      readFileBytes,
      ingestToolOutput: async (input) => {
        ingested.push(input as { bytes: Buffer; filename: string; mime_type: string });
        return { record_id: 'file:matched' };
      },
    });

    const result = await exec(call(stdoutBinding('cas'), {
      source: FILE_REF, match: 'globex',
    })) as { file_ref: string; mime_type: string; stdout?: unknown };

    expect(result.file_ref).toBe('file:matched');
    expect(result.mime_type).toBe('text/csv');
    // The tool read the materialized warehouse file and its PRINT was ingested —
    // header kept, one matching row.
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.bytes.toString('utf8')).toBe('Name,Email\nGlobex,hi@globex.test');
    expect(ingested[0]!.filename).toBe('matched.csv');
  });

  /** ⛔⛔ THE ISOLATION PROPERTY, and the reason a value shape is refused here.
   *  The captured bytes must NOT also appear as a readable value — otherwise
   *  this arm would be the very echo channel D-185 Slice 3 closed. */
  it('never puts the captured bytes into an op-step value', async () => {
    const exec = createCliInvocationExecutor({
      tempRoot: TEMP_ROOT,
      readFileBytes,
      ingestToolOutput: async () => ({ record_id: 'file:matched' }),
    });

    const result = await exec(call(stdoutBinding('cas'), {
      source: FILE_REF, match: 'acme',
    })) as Record<string, unknown>;

    expect(result.stdout).toBeUndefined();
    // And nothing anywhere in the result echoes the file's content.
    expect(JSON.stringify(result)).not.toContain('ops@acme.test');
    expect(JSON.stringify(result)).not.toContain('Acme');
  });

  it('carries the print through the temp backing too, and cleans up after itself', async () => {
    const exec = createCliInvocationExecutor({ tempRoot: TEMP_ROOT, readFileBytes });

    const result = await exec(call(stdoutBinding('temp'), {
      source: FILE_REF, match: 'globex',
    })) as { file_ref: { backing: string; path: string; filename: string } };

    expect(result.file_ref.backing).toBe('temp');
    // ⛔ The output dir is removed in a `finally`, so a ref aliasing it would be
    // dangling by the time the next step reads it — it must be copied out.
    expect(existsSync(result.file_ref.path)).toBe(true);
    expect(readFileSync(result.file_ref.path, 'utf8')).toBe('Name,Email\nGlobex,hi@globex.test');
    expect(strayDirs()).toEqual([]);
  });

  /** ⚠ There is no produced file to inspect afterwards, so the ceiling has to be
   *  enforced AS the bytes arrive — otherwise an unbounded print fills the data
   *  dir before anyone can object. */
  it('stops a tool that prints past the ceiling, and says why', async () => {
    const exec = createCliInvocationExecutor({
      tempRoot: TEMP_ROOT,
      outputCaptureMaxBytes: 1024,
      ingestToolOutput: async () => ({ record_id: 'file:never' }),
    });

    await expect(exec(call({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', FLOOD_SCRIPT, '{size}'],
      shape: 'ref',
      storage: 'cas',
      exit_code_handling: 'zero_is_success',
      output_capture: { from_stdout: true, mime_type: 'text/plain', filename: 'flood.txt' },
    }, { size: '200000' }))).rejects.toThrow(/exceeded the 1024-byte capture ceiling/u);

    // ⛔ And the reason survives. The ceiling SIGKILLs the child, so without the
    // sink failure being reported ahead of the exit code the owner is told the
    // tool crashed — and goes to investigate the wrong thing entirely.
    expect(strayDirs()).toEqual([]);
  });

  it('works without an input_materialize at all', async () => {
    const exec = createCliInvocationExecutor({
      tempRoot: TEMP_ROOT,
      ingestToolOutput: async (input) => {
        expect((input as { bytes: Buffer }).bytes.toString('utf8')).toBe('hello');
        return { record_id: 'file:plain' };
      },
    });

    const result = await exec(call({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', `process.stdout.write('hello');`],
      shape: 'ref',
      storage: 'cas',
      exit_code_handling: 'zero_is_success',
      output_capture: { from_stdout: true, mime_type: 'text/plain', filename: 'out.txt' },
    }, {})) as { file_ref: string };

    expect(result.file_ref).toBe('file:plain');
  });
});
