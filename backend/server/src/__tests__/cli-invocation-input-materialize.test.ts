/** SMB-finance wedge slice 3 — `CliMethodBinding.input_materialize`.
 *
 *  A cli op that declares `input_materialize` (docling's `source`) and whose arg
 *  value is a `data.file.received` record_id (`file:<32 hex>`) has that ref
 *  resolved to a throwaway temp file the cli reads; a NON-file_ref value (a local
 *  path — the manual lane) passes through unchanged. The temp dir is removed in a
 *  `finally`. These tests drive a real `node -e` subprocess; `readFileBytes` is a
 *  spy. Cleanup is asserted by the absence of any leftover `recued-cli-in-*` dir. */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';

const execPath = process.execPath;
const tmpInDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('recued-cli-in-'));

const FILE_REF = `file:${'a'.repeat(32)}`;
const FILE_REF_B = `file:${'b'.repeat(32)}`;

// Reads the materialized source file (argv[1]) and copies its bytes to a
// test-controlled destination (argv[2]) — proving the cli saw the materialized
// content. (Deliberately NOT output_capture, to keep this test off the shared
// `recued-cli-out-*` tmpdir surface the sibling output-capture suite snapshots.)
const COPY_SCRIPT =
  `const fs=require('fs');` +
  `fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1]));`;
const CONCAT_SCRIPT =
  `const fs=require('fs');` +
  `const args=process.argv.slice(1);` +
  `const dest=args.pop();` +
  `fs.writeFileSync(dest,args.map((p)=>fs.readFileSync(p,'utf8')).join('|'));`;

const dests: string[] = [];
const newDest = (): string => {
  const d = join(mkdtempSync(join(tmpdir(), 'd3-materialize-dest-')), 'copy.bin');
  dests.push(d);
  return d;
};

afterEach(() => { dests.splice(0); });

const copyBinding = () => ({
  kind: 'cli_invocation' as const,
  argv_template: [execPath, '-e', COPY_SCRIPT, '{source}', '{dest}'],
  exit_code_handling: 'zero_is_success' as const,
  input_materialize: { kind: 'file_ref' as const, arg: 'source' },
});

const concatArrayBinding = () => ({
  kind: 'cli_invocation' as const,
  argv_template: [execPath, '-e', CONCAT_SCRIPT, { expand_arg: 'sources' }, '{dest}'],
  exit_code_handling: 'zero_is_success' as const,
  input_materialize: { kind: 'file_ref_array' as const, arg: 'sources', min_items: 2, max_items: 2 },
});

const call = (binding: unknown, args: Record<string, unknown>) => ({
  slug: 'docling',
  operation_key: 'document.to_markdown',
  operation_id: 'recued-core/document.to_markdown',
  args,
  timeout_ms: 5_000,
  binding,
  stepMeta: { run_id: 'run-1' },
}) as unknown as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0];

describe('cli_invocation input_materialize', () => {
  it('materializes a file_ref arg to a temp file the cli reads, then cleans up', async () => {
    const reads: string[] = [];
    const exec = createCliInvocationExecutor({
      readFileBytes: async (record_id) => {
        reads.push(record_id);
        return { bytes: Buffer.from('FILE REF BYTES'), mime_type: 'application/pdf', filename: 'invoice.pdf' };
      },
    });
    const before = tmpInDirs();
    const dest = newDest();

    await exec(call(copyBinding(), { source: FILE_REF, dest }));

    expect(reads).toEqual([FILE_REF]);
    // The cli read the materialized temp file and copied its bytes out.
    expect(readFileSync(dest).toString('utf8')).toBe('FILE REF BYTES');
    // the input temp dir is removed in a finally
    expect(tmpInDirs()).toEqual(before);
  });

  it('materializes a content-pinned CAS ref only when the exact bytes match', async () => {
    const bytes = Buffer.from('PINNED FILE REF BYTES');
    const reads: string[] = [];
    const exec = createCliInvocationExecutor({
      readFileBytes: async (record_id) => {
        reads.push(record_id);
        return { bytes, mime_type: 'application/pdf', filename: 'invoice.pdf' };
      },
    });
    const before = tmpInDirs();
    const dest = newDest();

    await exec(call(copyBinding(), {
      source: {
        backing: 'cas',
        record_id: FILE_REF,
        content_sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      dest,
    }));

    expect(reads).toEqual([FILE_REF]);
    expect(readFileSync(dest)).toEqual(bytes);
    expect(tmpInDirs()).toEqual(before);
  });

  it('refuses content-pin drift before spawning the cli', async () => {
    const reads: string[] = [];
    const exec = createCliInvocationExecutor({
      readFileBytes: async (record_id) => {
        reads.push(record_id);
        return {
          bytes: Buffer.from('CHANGED BYTES'),
          mime_type: 'application/pdf',
          filename: 'invoice.pdf',
        };
      },
    });
    const before = tmpInDirs();
    const dest = newDest();

    await expect(exec(call(copyBinding(), {
      source: {
        backing: 'cas',
        record_id: FILE_REF,
        content_sha256: 'a'.repeat(64),
      },
      dest,
    }))).rejects.toThrow(/content pin mismatch/);

    expect(reads).toEqual([FILE_REF]);
    expect(existsSync(dest)).toBe(false);
    expect(tmpInDirs()).toEqual(before);
  });

  it('refuses a non-closed content-pin carrier before reading or spawning', async () => {
    let readCalled = false;
    const exec = createCliInvocationExecutor({
      readFileBytes: async () => {
        readCalled = true;
        return { bytes: Buffer.from('x'), mime_type: 'application/pdf', filename: 'x.pdf' };
      },
    });
    const before = tmpInDirs();
    const dest = newDest();

    await expect(exec(call(copyBinding(), {
      source: {
        backing: 'cas',
        record_id: FILE_REF,
        content_sha256: 'a'.repeat(64),
        untrusted_path: '/tmp/bypass',
      },
      dest,
    }))).rejects.toThrow(/must resolve to a scalar/);

    expect(readCalled).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(tmpInDirs()).toEqual(before);
  });

  it('passes a NON-file_ref source through unchanged (manual local-path lane — no materialize)', async () => {
    let readCalled = false;
    const exec = createCliInvocationExecutor({
      readFileBytes: async () => {
        readCalled = true;
        return { bytes: Buffer.from('x'), mime_type: 'text/plain', filename: 'x' };
      },
    });
    const noopBinding = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', 'process.exit(0)', '{source}'],
      exit_code_handling: 'zero_is_success' as const,
      input_materialize: { kind: 'file_ref' as const, arg: 'source' },
    };
    const before = tmpInDirs();
    await exec(call(noopBinding, { source: '/local/path/to/invoice.pdf' }));
    expect(readCalled).toBe(false);
    expect(tmpInDirs()).toEqual(before); // no input temp dir created
  });

  it('D-189 materializes a file_ref array in order and expands it as argv elements', async () => {
    const reads: string[] = [];
    const exec = createCliInvocationExecutor({
      readFileBytes: async (record_id) => {
        reads.push(record_id);
        return record_id === FILE_REF
          ? { bytes: Buffer.from('LEFT'), mime_type: 'text/plain', filename: 'left.txt' }
          : { bytes: Buffer.from('RIGHT'), mime_type: 'text/plain', filename: 'right.txt' };
      },
    });
    const before = tmpInDirs();
    const dest = newDest();

    await exec(call(concatArrayBinding(), { sources: [FILE_REF, FILE_REF_B], dest }));

    expect(reads).toEqual([FILE_REF, FILE_REF_B]);
    expect(readFileSync(dest).toString('utf8')).toBe('LEFT|RIGHT');
    expect(tmpInDirs()).toEqual(before);
  });

  it('D-189 enforces file_ref array item bounds at runtime', async () => {
    const exec = createCliInvocationExecutor({});

    await expect(exec(call(concatArrayBinding(), { sources: ['/tmp/one.txt'], dest: newDest() })))
      .rejects.toThrow(/below min_items 2/);
  });

  it('fails closed when a file_ref must be materialized but no file reader is wired', async () => {
    const exec = createCliInvocationExecutor({}); // no readFileBytes
    await expect(exec(call(copyBinding(), { source: FILE_REF, dest: newDest() }))).rejects.toThrow(/no file reader is wired/);
  });

  // D-172 I-4 file-egress — a materialize op reads Gateway-gated CAS bytes into the
  // subprocess via the UNGATED internal reader. The validators forbid it a value
  // stdout shape so stdout can't echo the bytes; stderr is the symmetric channel.
  // ffmpeg/imagemagick/verbose parsers write input-derived content to stderr on a
  // SUCCESS exit, so the executor must NOT surface a materialize op's raw stderr
  // into the (actor-readable) op-step value — else an actor with the cli-op grant
  // but no `data-file-read` exfiltrates content via `{{step.<id>.stderr}}`.
  it('suppresses stderr from the op-step value for an input_materialize op (no content echo)', async () => {
    const exec = createCliInvocationExecutor({
      readFileBytes: async () => ({
        bytes: Buffer.from('TOP SECRET FILE CONTENT'),
        mime_type: 'application/pdf',
        filename: 'secret.pdf',
      }),
    });
    // exit-code-only op (no value shape — the validator-permitted materialize shape)
    // whose subprocess copies the materialized input straight to STDERR and exits 0.
    const leakToStderr =
      `const fs=require('fs');` +
      `process.stderr.write('LEAK:'+fs.readFileSync(process.argv[1]).toString());`;
    const binding = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', leakToStderr, '{source}'],
      exit_code_handling: 'zero_is_success' as const,
      input_materialize: { kind: 'file_ref' as const, arg: 'source' },
    };
    const result = (await exec(call(binding, { source: FILE_REF }))) as Record<string, unknown>;
    // The op ran (read the materialized bytes) and succeeded …
    expect(result.exit_code).toBe(0);
    // … but its stderr — which carried the file content — never reaches the value.
    expect(result.stderr).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('TOP SECRET FILE CONTENT');
  });

  it('still surfaces stderr for a NON-materialize op (suppression is scoped, not blanket)', async () => {
    const exec = createCliInvocationExecutor({});
    const binding = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', `process.stderr.write('diagnostic line');`],
      exit_code_handling: 'zero_is_success' as const,
    };
    const result = (await exec(call(binding, {}))) as Record<string, unknown>;
    expect(result.stderr).toBe('diagnostic line');
  });

  it('refuses a detached + input_materialize op (a detached log would re-open the stderr channel)', async () => {
    const exec = createCliInvocationExecutor({
      readFileBytes: async () => ({ bytes: Buffer.from('x'), mime_type: 'text/plain', filename: 'x' }),
    });
    const binding = {
      kind: 'cli_invocation' as const,
      argv_template: [execPath, '-e', 'process.exit(0)', '{source}'],
      exit_code_handling: 'zero_is_success' as const,
      input_materialize: { kind: 'file_ref' as const, arg: 'source' },
      detached: { completion: { exit_pattern: '{root}/done' } },
    };
    await expect(exec(call(binding, { source: FILE_REF, root: mkdtempSync(join(tmpdir(), 'd172-det-')) })))
      .rejects.toThrow(/foreground-only/);
  });
});
