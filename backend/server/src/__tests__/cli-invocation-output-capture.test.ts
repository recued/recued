/** Document-toolkit — `CliMethodBinding.output_capture` capture path.
 *
 *  A foreground cli op that declares `output_capture` runs into an
 *  engine-managed throwaway temp dir under the OS temp root, then the executor
 *  ingests the single produced file as a `data.file` ref (`result.file_ref`)
 *  and removes the temp dir in a `finally` — on success AND on failure. These
 *  tests drive the real subprocess (`node -e`) like the sibling executor suite;
 *  the ingest sink is a spy. Cleanup is asserted by the absence of any leftover
 *  `recued-cli-out-*` dir in the OS temp root. */

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  createCliInvocationExecutor,
  type ToolOutputIngestInput,
} from '../cli-invocation-executor.js';

const execPath = process.execPath;
const tmpCaptureDirs = (): string[] =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('recued-cli-out-'));

// A node one-liner that writes the named files into the engine-injected output
// dir (always the LAST argv token) and prints that dir to stdout.
const writeFilesScript = (files: Array<[string, string]>): string =>
  `const fs=require('fs'),p=require('path');const d=process.argv.at(-1);` +
  files.map(([n, c]) => `fs.writeFileSync(p.join(d,${JSON.stringify(n)}),${JSON.stringify(c)});`).join('') +
  `process.stdout.write(d);`;

const captureBinding = (script: string, extra: Record<string, unknown> = {}) => ({
  kind: 'cli_invocation' as const,
  argv_template: [execPath, '-e', script, '{output_dir}'],
  shape: 'ref' as const,
  storage: 'cas' as const,
  exit_code_handling: 'zero_is_success' as const,
  output_capture: { dir_arg: 'output_dir', mime_type: 'text/markdown' },
  ...extra,
});

const call = (binding: unknown, stepMeta?: unknown) => ({
  slug: 'docling',
  operation_key: 'document.to_markdown',
  operation_id: 'recued-core/document.to_markdown',
  args: { source: '/in/invoice.pdf' },
  timeout_ms: 5_000,
  binding,
  ...(stepMeta ? { stepMeta } : {}),
}) as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0];

describe('cli_invocation output_capture', () => {
  it('ingests the produced file as result.file_ref, merges base fields, and cleans the temp dir', async () => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:abc123' };
      },
    });
    const before = tmpCaptureDirs();

    const result = (await exec(
      call(captureBinding(writeFilesScript([['invoice.md', 'PARSED MD']])), { run_id: 'run-1' }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      mode: 'foreground',
      exit_code: 0,
      file_ref: 'file:abc123',
      filename: 'invoice.md',
      mime_type: 'text/markdown',
    });
    expect(result.content_sha256).toBeUndefined();
    expect(result.size_bytes).toBeUndefined();
    expect(ingested).toHaveLength(1);
    expect(ingested[0].bytes.toString('utf8')).toBe('PARSED MD');
    expect(ingested[0].filename).toBe('invoice.md');
    expect(ingested[0].mime_type).toBe('text/markdown');
    // Per-ingest identity seed includes the content hash: fixed output names
    // stay crash-idempotent for equal bytes without aliasing foreach outputs.
    expect(ingested[0].source_id).toBe(
      `run-1:recued-core/document.to_markdown:invoice.md:${createHash('sha256').update('PARSED MD').digest('hex')}`,
    );
    // D-185 Slice 3 — a shape:'ref' op discards stdout (content flows via file_ref).
    expect(result.stdout).toBeUndefined();
    // The engine-managed temp dir is removed after capture (no leftover).
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('selects the file matching the declared mime extension, ignoring sidecars', async () => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:md' };
      },
    });

    const result = (await exec(
      call(captureBinding(writeFilesScript([['invoice.md', 'MD'], ['page-1.png', 'PNGBYTES']]))),
    )) as Record<string, unknown>;

    expect(result.file_ref).toBe('file:md');
    expect(result.filename).toBe('invoice.md');
    expect(ingested[0].bytes.toString('utf8')).toBe('MD');
  });

  it('accepts a PDF envelope, returns exact hash/size evidence, and ingests it once', async () => {
    const pdf = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n';
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:pdf' };
      },
    });

    const result = (await exec(call(captureBinding(
      writeFilesScript([['document.pdf', pdf]]),
      { output_capture: { dir_arg: 'output_dir', mime_type: 'application/pdf' } },
    )))) as Record<string, unknown>;

    expect(result).toMatchObject({
      file_ref: 'file:pdf',
      filename: 'document.pdf',
      mime_type: 'application/pdf',
      content_sha256: createHash('sha256').update(pdf).digest('hex'),
      size_bytes: Buffer.byteLength(pdf),
    });
    expect(ingested).toHaveLength(1);
    expect(ingested[0].bytes.toString('latin1')).toBe(pdf);
  });

  it.each([
    ['missing envelope', 'not a pdf'],
    ['missing EOF marker', '%PDF-1.7\nbody only'],
    ['missing header', 'body\n%%EOF\n'],
    ['EOF marker outside the final 1,024 bytes', `%PDF-1.7\n%%EOF\n${'x'.repeat(1_025)}`],
  ])('rejects a .pdf with %s before CAS ingest and cleans the temp dir', async (_label, bytes) => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:must-not-exist' };
      },
    });
    const before = tmpCaptureDirs();

    await expect(exec(call(captureBinding(
      writeFilesScript([['document.pdf', bytes]]),
      { output_capture: { dir_arg: 'output_dir', mime_type: 'application/pdf' } },
    )))).rejects.toMatchObject({
      cli_failure: expect.objectContaining({ reason: 'bad_output' }),
    });
    expect(ingested).toHaveLength(0);
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('keys a fixed output filename by content within one run and reuses the identity for equal bytes', async () => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: `file:${input.source_id}` };
      },
    });
    const bindingFor = (content: string) => captureBinding(
      writeFilesScript([['document.md', content]]),
    );
    const meta = { run_id: 'run-foreach' };

    await exec(call(bindingFor('FIRST'), meta));
    await exec(call(bindingFor('SECOND'), meta));
    await exec(call(bindingFor('FIRST'), meta));

    const firstHash = createHash('sha256').update('FIRST').digest('hex');
    const secondHash = createHash('sha256').update('SECOND').digest('hex');
    expect(ingested.map((entry) => entry.source_id)).toEqual([
      `run-foreach:recued-core/document.to_markdown:document.md:${firstHash}`,
      `run-foreach:recued-core/document.to_markdown:document.md:${secondHash}`,
      `run-foreach:recued-core/document.to_markdown:document.md:${firstHash}`,
    ]);
  });

  // Media-toolkit by-value cli packs (ffmpeg / imagemagick) declare a media
  // output mime; the CAPTURE_MIME_EXT additions let the executor select the
  // produced file by extension so a stray sidecar in the temp dir can't be
  // mis-captured (ffmpeg/imagemagick write a single fixed-name file, but the
  // ext filter is the deterministic guard).
  it.each([
    ['audio/mpeg', 'audio.mp3'],
    ['audio/wav', 'clip.wav'],
    ['image/png', 'image.png'],
    ['image/jpeg', 'photo.jpg'],
    ['image/webp', 'pic.webp'],
  ])('selects the %s output file by extension, ignoring a sidecar', async (mime, produced) => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:media' };
      },
    });

    const result = (await exec(
      call(
        captureBinding(writeFilesScript([[produced, 'MEDIABYTES'], ['ffmpeg2pass-0.log', 'LOG']]), {
          output_capture: { dir_arg: 'output_dir', mime_type: mime },
        }),
      ),
    )) as Record<string, unknown>;

    expect(result.file_ref).toBe('file:media');
    expect(result.filename).toBe(produced);
    expect(result.mime_type).toBe(mime);
    expect(ingested[0].filename).toBe(produced);
    expect(ingested[0].mime_type).toBe(mime);
    expect(ingested[0].bytes.toString('utf8')).toBe('MEDIABYTES');
  });

  // The actual media-pack invocation shape: a FIXED-NAME file inside the
  // engine-managed temp dir via a partial-token argv (ffmpeg `{out_dir}/audio.mp3`,
  // magick `{out_dir}/image.png`). The engine injects args[dir_arg]=tempDir, so
  // `{out_dir}/audio.mp3` resolves to <tempDir>/audio.mp3 — the cli writes exactly
  // there and capture finds it. (The docling/whisper path lets the tool auto-name
  // into the dir; this proves the fixed-path variant ffmpeg/imagemagick rely on.)
  it('captures a fixed-name file written via a partial-token {out_dir}/file argv', async () => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:fixed' };
      },
    });
    const before = tmpCaptureDirs();
    // Write to the exact last argv path (the resolved <tempDir>/audio.mp3), not
    // into a dir — this is what ffmpeg/magick do.
    const writeToLastArg =
      `const fs=require('fs');fs.writeFileSync(process.argv.at(-1),'MP3BYTES');`;

    const result = (await exec(
      call({
        kind: 'cli_invocation',
        argv_template: [execPath, '-e', writeToLastArg, '{out_dir}/audio.mp3'],
        shape: 'ref',
        storage: 'cas',
        exit_code_handling: 'zero_is_success',
        output_capture: { dir_arg: 'out_dir', mime_type: 'audio/mpeg' },
      }),
    )) as Record<string, unknown>;

    expect(result.file_ref).toBe('file:fixed');
    expect(result.filename).toBe('audio.mp3');
    expect(result.mime_type).toBe('audio/mpeg');
    expect(ingested[0].filename).toBe('audio.mp3');
    expect(ingested[0].bytes.toString('utf8')).toBe('MP3BYTES');
    // Temp dir cleaned up afterward.
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('falls back to run id "cli" in the source_id when no stepMeta run id is present', async () => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:x' };
      },
    });

    await exec(call(captureBinding(writeFilesScript([['invoice.md', 'MD']]))));

    expect(ingested[0].source_id).toBe(
      `cli:recued-core/document.to_markdown:invoice.md:${createHash('sha256').update('MD').digest('hex')}`,
    );
  });

  it('fails closed when output_capture is declared but no ingestor is wired', async () => {
    const exec = createCliInvocationExecutor(); // no ingestToolOutput
    const before = tmpCaptureDirs();

    await expect(
      exec(call(captureBinding(writeFilesScript([['invoice.md', 'MD']])))),
    ).rejects.toThrow(/no tool-output ingestor/);
    // The check precedes mkdtemp — no temp dir is created.
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('removes the temp dir when the cli exits non-zero (cleanup on failure)', async () => {
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:never' }),
    });
    const before = tmpCaptureDirs();

    await expect(
      exec(call(captureBinding(`${writeFilesScript([['invoice.md', 'MD']])};process.exit(3)`))),
    ).rejects.toThrow(/code 3/);
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('rejects (and cleans up) when the cli succeeds but produces no matching file', async () => {
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:never' }),
    });
    const before = tmpCaptureDirs();

    await expect(
      exec(call(captureBinding('process.exit(0)'))),
    ).rejects.toThrow(/produced no/);
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('rejects (and cleans up) when more than one matching file is produced', async () => {
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:never' }),
    });
    const before = tmpCaptureDirs();

    await expect(
      exec(call(captureBinding(writeFilesScript([['a.md', 'A'], ['b.md', 'B']])))),
    ).rejects.toThrow(/expected one/);
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('rejects (and cleans up) when the produced file exceeds the size cap', async () => {
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:never' }),
      outputCaptureMaxBytes: 4,
    });
    const before = tmpCaptureDirs();

    await expect(
      exec(call(captureBinding(writeFilesScript([['invoice.md', 'WAY TOO LONG']])))),
    ).rejects.toThrow(/over the 4-byte cap/);
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('rejects a binding that combines detached with output_capture (foreground-only guard)', async () => {
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async () => ({ record_id: 'file:never' }),
    });
    const before = tmpCaptureDirs();

    await expect(
      exec(call({
        kind: 'cli_invocation',
        argv_template: [execPath, '-e', 'process.exit(0)', '{output_dir}'],
        shape: 'ref',
        storage: 'cas',
        exit_code_handling: 'zero_is_success',
        output_capture: { dir_arg: 'output_dir', mime_type: 'text/markdown' },
        detached: { mode: 'runtime_managed', completion: { exit_pattern: '{result_dir}/x.exit.{code}' } },
      })),
    ).rejects.toThrow(/foreground-only/);
    expect(tmpCaptureDirs()).toEqual(before);
  });

  it('engine-injects the output dir, overriding any recipe-supplied dir_arg value', async () => {
    const ingested: ToolOutputIngestInput[] = [];
    const exec = createCliInvocationExecutor({
      ingestToolOutput: async (input) => {
        ingested.push(input);
        return { record_id: 'file:ok' };
      },
    });

    // The recipe passes a bogus output_dir; the executor MUST override it with
    // its managed temp dir (the script writes to argv.at(-1) = the injected dir).
    const result = (await exec({
      slug: 'docling',
      operation_key: 'document.to_markdown',
      operation_id: 'recued-core/document.to_markdown',
      args: { source: '/in/x.pdf', output_dir: '/nonexistent/evil' },
      timeout_ms: 5_000,
      binding: captureBinding(writeFilesScript([['x.md', 'OK']])),
    } as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0])) as Record<string, unknown>;

    // The capture succeeding (file_ref + the produced bytes) IS the proof the
    // executor overrode the recipe's bogus output_dir: had it honoured
    // '/nonexistent/evil', the script's write would have ENOENT'd and no file
    // would have been captured. (shape:'ref' discards stdout, so we can no longer
    // read the injected dir back off result.stdout — the capture is the proof.)
    expect(result.file_ref).toBe('file:ok');
    expect(ingested[0].bytes.toString('utf8')).toBe('OK');
  });
});
