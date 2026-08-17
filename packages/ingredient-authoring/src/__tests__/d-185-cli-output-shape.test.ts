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
      editable_args: [
        // ⚠ `'string'`, not `'file_ref'`. `ArgEditField.type` is `MetaFieldType`
        // (string | number | boolean | datetime | json) — `file_ref` lives in
        // OperationArgType / ValueHint, never here. The arg's type is incidental
        // to what this file asserts (CLI output shape).
        { key: 'source', type: 'string', label: 'Source file', required: true, affects_target: true },
        { key: 'match', type: 'string', label: 'Match', required: true, affects_target: true },
      ],
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

/** A cli composition whose op MATERIALIZES a warehouse file and captures what
 *  the tool printed — the csvgrep / ripgrep / jq shape. */
const stdoutCapture = (
  captureExtra: Record<string, unknown> = {},
  bindExtra: Partial<CliMethodBinding> = {},
): CompositionIngredient =>
  cliComposition(
    {
      shape: 'ref',
      input_materialize: { kind: 'file_ref', arg: 'source' },
      output_capture: {
        from_stdout: true,
        mime_type: 'text/csv',
        filename: 'matched.csv',
        ...captureExtra,
      },
      ...bindExtra,
    } as Partial<CliMethodBinding>,
    // argv[0] must be the ingredient's declared binary, and the materialize arg
    // must be caller-supplied (hence declared in editable_args) — both are
    // pre-existing rules this arm does not change.
    ['gh', 'search', '{match}', '{source}'],
  );

describe('stdout output_capture — the arm that lets a printing tool read a warehouse file', () => {
  /** 🔑 Before this arm, a tool that only prints could not declare `shape: 'ref'`
   *  (no output path for `dir_arg`, no edited input for `from_input_arg`) and a
   *  VALUE shape is refused alongside `input_materialize` — so NO filter could
   *  read a warehouse file at all. */
  it('accepts a materializing op that captures its print', () => {
    const result = validateComposition(stdoutCapture());
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  /** ⛔ The tool printed, so it named nothing. Without a filename the ingested
   *  record carries no extension, and every downstream converter that dispatches
   *  on one silently fails to classify it. */
  it('requires a filename, because the tool supplies none', () => {
    const result = validateComposition(stdoutCapture({ filename: undefined }));
    expect(issuesWithCode(result, 'composition_cli_output_capture_stdout_filename')).toHaveLength(1);
  });

  it('refuses a non-literal from_stdout', () => {
    const result = validateComposition(stdoutCapture({ from_stdout: 'yes' }));
    expect(issuesWithCode(result, 'composition_cli_output_capture_stdout_flag')).toHaveLength(1);
  });

  /** Exactly one arm. Declaring two leaves it ambiguous which file is the result,
   *  and the executor discriminates on one key. */
  it.each([['dir_arg', { dir_arg: 'out' }], ['from_input_arg', { from_input_arg: 'source' }]])(
    'refuses from_stdout alongside %s',
    (_label, extra) => {
      const result = validateComposition(stdoutCapture(extra));
      expect(issuesWithCode(result, 'composition_cli_output_capture_stdout_exclusive')).toHaveLength(1);
    },
  );

  /** ⛔⛔ THE REFUSALS THIS ARM MUST NOT WEAKEN. A value shape would put the
   *  materialized file's bytes into an op-step value (the D-185 Slice 3 echo
   *  channel), and a detached job RETURNS its `log_path` — which is exactly why
   *  capturing stdout to a gated file_ref is safe while logging it to a
   *  recipe-visible path is not. */
  it('still refuses a VALUE shape on a materializing op', () => {
    const result = validateComposition(stdoutCapture({}, { shape: 'text' }));
    expect(issuesWithCode(result, 'composition_cli_input_materialize_stdout')).toHaveLength(1);
    expect(issuesWithCode(result, 'composition_cli_output_capture_shape')).toHaveLength(1);
  });

  it('still refuses a detached job', () => {
    // ⚠ `'runtime_managed'` is now the ONLY CliDetachedMode — c2f9bc3ae removed
    // `'supervised'` in the same commit that wrote this case. Refusing a
    // CURRENTLY-VALID detached mode is the stronger assertion anyway: refusing
    // one the union no longer admits would prove nothing about the gate.
    const result = validateComposition(stdoutCapture({}, {
      detached: { mode: 'runtime_managed', completion: { kind: 'marker_file', exit_pattern: 'x' } },
    } as Partial<CliMethodBinding>));
    expect(issuesWithCode(result, 'composition_cli_output_capture_detached')).toHaveLength(1);
    expect(issuesWithCode(result, 'composition_cli_input_materialize_detached')).toHaveLength(1);
  });

  /** ⚠ A stdout capture needs no argv token — that is the point. The `dir_arg`
   *  arm's token requirement must not leak onto it. */
  it('requires no output token in argv', () => {
    const result = validateComposition(stdoutCapture());
    expect(issuesWithCode(result, 'composition_cli_output_capture_dir_arg')).toEqual([]);
  });
});
