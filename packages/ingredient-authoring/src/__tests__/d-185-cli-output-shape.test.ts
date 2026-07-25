import { describe, expect, it } from 'vitest';
import type { CliMethodBinding, CompositionIngredient, PackOperationRow } from '@recued/contracts';
import { validateComposition } from '../index.js';

/** A single-op cli composition over `ollama run`-style stdout output. */
const cliComposition = (
  bindExtra: Partial<CliMethodBinding> = {},
  argvTemplate: string[] = ['gh', 'api', '{path}'],
): CompositionIngredient => ({
  schema_version: 1,
  slug: 'gh-cli',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'gh-cli',
      kind: 'cli',
      cli: {
        tool: 'gh',
        probe: ['gh', '--version'],
        package_ref: 'system_binary:gh',
        entry_point: 'gh',
      },
    },
  ],
  operations: [
    {
      op: 'api.get',
      ingredient: 'gh-cli',
      risk: 'read',
      approval: 'never',
      bind: {
        kind: 'cli_invocation',
        argv_template: argvTemplate,
        exit_code_handling: 'zero_is_success',
        ...bindExtra,
      } as unknown as PackOperationRow['bind'],
      description: 'A gh api call.',
    },
  ],
});

const issuesWithCode = (result: { issues: Array<{ code: string }> }, code: string) =>
  result.issues.filter((issue) => issue.code === code);

describe('D-185 — cli output shape validator', () => {
  it('accepts shape: json (a value-stdout op)', () => {
    const result = validateComposition(cliComposition({ shape: 'json' }));
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_output_shape'))).toEqual([]);
  });

  it('accepts an omitted shape (exit-code-only) — no gate fires', () => {
    const result = validateComposition(cliComposition());
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_output_shape'))).toEqual([]);
  });

  it('rejects an unknown shape value', () => {
    const result = validateComposition(
      cliComposition({ shape: 'yaml' as unknown as CliMethodBinding['shape'] }),
    );
    expect(issuesWithCode(result, 'composition_cli_output_shape_invalid')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects shape: ref without an output_capture (no file backing to hand a ref)', () => {
    const result = validateComposition(cliComposition({ shape: 'ref' }));
    expect(issuesWithCode(result, 'composition_cli_output_shape_ref_capture')).toHaveLength(1);
  });

  it('accepts shape: ref WITH an output_capture (the file-output path)', () => {
    const result = validateComposition(
      cliComposition(
        {
          shape: 'ref',
          output_capture: { dir_arg: 'out_dir', mime_type: 'text/markdown' },
        },
        ['docling', '{source}', '--output', '{out_dir}'],
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_output_shape_ref_capture')).toHaveLength(0);
    expect(issuesWithCode(result, 'composition_cli_output_capture_shape')).toHaveLength(0);
  });

  it('D-185 Slice 3 — rejects an output_capture op that does NOT declare shape: ref (content isolation)', () => {
    // A value shape (or omitted) alongside output_capture would capture stdout
    // AND produce a file — leaking content into op-step values.
    const result = validateComposition(
      cliComposition(
        { shape: 'text', output_capture: { dir_arg: 'out_dir', mime_type: 'text/plain' } },
        ['t', '{out_dir}'],
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_output_capture_shape')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });
});

const refComposition = (storage: unknown) =>
  cliComposition(
    {
      shape: 'ref',
      storage: storage as CliMethodBinding['storage'],
      output_capture: { dir_arg: 'out_dir', mime_type: 'audio/mpeg' },
    },
    ['ffmpeg', '-i', '{source}', '{out_dir}/audio.mp3'],
  );

describe('D-185 — cli output storage validator', () => {
  it('accepts storage: temp / cas on a ref-producing (output_capture) op', () => {
    for (const storage of ['temp', 'cas'] as const) {
      const result = validateComposition(refComposition(storage));
      expect(result.issues.filter((i) => i.code.startsWith('composition_cli_output_storage'))).toEqual([]);
    }
  });

  it('accepts an omitted storage (defaults temp) — no gate fires', () => {
    const result = validateComposition(refComposition(undefined));
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_output_storage'))).toEqual([]);
  });

  it('rejects an unknown storage value', () => {
    const result = validateComposition(refComposition('disk'));
    expect(issuesWithCode(result, 'composition_cli_output_storage_invalid')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects storage on a stdout op with no output_capture (storage describes a file backing)', () => {
    const result = validateComposition(cliComposition({ storage: 'temp' }));
    expect(issuesWithCode(result, 'composition_cli_output_storage_no_capture')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });
});
