import { describe, expect, it } from 'vitest';
import type { CliArgvTemplateEntry, CliMethodBinding, CompositionIngredient, PackOperationRow } from '@recued/contracts';
import { validateComposition } from '../index.js';

const cliBind = (
  argvTemplate: CliArgvTemplateEntry[],
  extra: Partial<CliMethodBinding> = {},
) => ({
  kind: 'cli_invocation' as const,
  argv_template: argvTemplate,
  exit_code_handling: 'zero_is_success' as const,
  ...extra,
});

const methodBind = () => ({
  kind: 'method_call' as const,
  method_name: 'container.list',
});

// The declared launched binary defaults to argv[0] (the realistic shape — every
// shipped cli pack sets cli.entry_point === argv_template[0]); a test exercising
// the argv[0]↔tool pin passes `toolOverride` to force a mismatch.
const cliComposition = (
  argvTemplate: CliArgvTemplateEntry[],
  bindExtra: Partial<CliMethodBinding> = {},
  rowExtra: Partial<PackOperationRow> = {},
  toolOverride?: string,
): CompositionIngredient => {
  const firstArgv = argvTemplate[0];
  const tool = toolOverride ?? (typeof firstArgv === 'string' ? firstArgv : undefined) ?? 'docker';
  return {
  schema_version: 1,
  slug: 'docker-cli',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'docker-cli',
      kind: 'cli',
      cli: {
        tool,
        probe: [tool, 'version'],
        package_ref: `system_binary:${tool}`,
        entry_point: tool,
      },
    },
  ],
  operations: [
    {
      op: 'container.list',
      ingredient: 'docker-cli',
      risk: 'read',
      approval: 'never',
      bind: cliBind(argvTemplate, bindExtra) as unknown as PackOperationRow['bind'],
      description: 'List Docker containers.',
      ...rowExtra,
    },
  ],
  };
};

const methodComposition = (): CompositionIngredient => ({
  ...cliComposition(['docker', 'ps']),
  operations: [
    {
      ...cliComposition(['docker', 'ps']).operations[0],
      bind: {
        ...methodBind(),
        argv_template: ['python', '-c', '{code}'],
      } as unknown as PackOperationRow['bind'],
    },
  ],
});

const issuesWithCode = (result: { issues: Array<{ code: string }> }, code: string) =>
  result.issues.filter((issue) => issue.code === code);

describe('D-170 N.8 CLI argv_template guards', () => {
  const evalFlagCases: Array<[string, string]> = [
    ['bash', '-c'],
    ['sh', '-c'],
    ['zsh', '-c'],
    ['python', '-c'],
    ['python', '-'],
    ['python3', '-c'],
    ['python3', '-'],
    ['node', '-e'],
    ['node', '-'],
    ['deno', '-e'],
    ['deno', '-'],
    ['perl', '-e'],
    ['perl', '-'],
    ['php', '-r'],
    ['ruby', '-e'],
    ['ruby', '-E'],
    ['ruby', '-'],
  ];

  for (const [interpreter, flag] of evalFlagCases) {
    it(`rejects ${interpreter} ${flag} code execution argv templates`, () => {
      const result = validateComposition(cliComposition([interpreter, flag, '{code}']));
      const issues = issuesWithCode(result, 'composition_cli_code_hole');

      expect(result.valid).toBe(false);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: 'error' });
    });
  }

  it('rejects interpreter script-path holes where a locked script token is required', () => {
    for (const argvTemplate of [
      ['python3', '{anyfile}'],
      ['awk', '{prog}'],
      ['python', '-u', '{anyfile}'],
      ['awk', '-f', '{progfile}'],
      ['node', '--require', '{module}'],
    ]) {
      const result = validateComposition(cliComposition(argvTemplate));
      const issues = issuesWithCode(result, 'composition_cli_code_hole');

      expect(result.valid).toBe(false);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: 'error' });
    }
  });

  it('allows interpreter invocations with a fixed script and data holes', () => {
    const result = validateComposition(cliComposition(['python', 'fixedscript.py', '{dataHole}']));

    expect(result.valid).toBe(true);
    expect(issuesWithCode(result, 'composition_cli_code_hole')).toEqual([]);
  });

  it('allows fixed binaries with data args', () => {
    const result = validateComposition(cliComposition(['docker', 'ps']));

    expect(result.valid).toBe(true);
    expect(issuesWithCode(result, 'composition_cli_code_hole')).toEqual([]);
  });

  it('rejects a templated argv[0] command (a call-time hole would choose the binary)', () => {
    for (const argvTemplate of [['{cmd}', '--version'], ['{{tool}}', 'run'], ['pre{cmd}', 'x']]) {
      const result = validateComposition(cliComposition(argvTemplate));
      expect(result.valid).toBe(false);
      expect(issuesWithCode(result, 'composition_cli_command_hole')).toHaveLength(1);
    }
  });

  it('rejects argv[0] that does not equal the declared binary (entry_point)', () => {
    // Declared launched binary is 'docker' but the command token is 'curl' —
    // the grant authorizes docker, not an arbitrary command.
    const result = validateComposition(cliComposition(['curl', 'http://x'], {}, {}, 'docker'));
    expect(result.valid).toBe(false);
    expect(issuesWithCode(result, 'composition_cli_command_tool_mismatch')).toHaveLength(1);
  });

  it('allows argv[0] that equals the declared binary', () => {
    const result = validateComposition(cliComposition(['docling', '{source}', '--to', 'md'], {}, {
      editable_args: [{ key: 'source', type: 'string', label: 'Source', required: true }],
    }, 'docling'));
    expect(result.valid).toBe(true);
    expect(issuesWithCode(result, 'composition_cli_command_hole')).toEqual([]);
    expect(issuesWithCode(result, 'composition_cli_command_tool_mismatch')).toEqual([]);
  });

  it('allows cli cwd as a single target-affecting runtime arg token', () => {
    const result = validateComposition(cliComposition(
      ['vitest', 'run', '{target_path}'],
      { cwd: { arg: '{project_dir}' } },
      {
        editable_args: [
          { key: 'project_dir', type: 'string', label: 'Project directory', required: true, affects_target: true },
          { key: 'target_path', type: 'string', label: 'Target path', required: true, affects_target: true },
        ],
      },
      'vitest',
    ));

    expect(result.valid).toBe(true);
    expect(issuesWithCode(result, 'composition_cli_cwd_shape')).toEqual([]);
    expect(issuesWithCode(result, 'composition_cli_cwd_arg')).toEqual([]);
    expect(issuesWithCode(result, 'composition_cli_cwd_target_arg')).toEqual([]);
  });

  it('rejects cli cwd that is not a single target-affecting runtime arg token', () => {
    const freeform = validateComposition(cliComposition(
      ['vitest', 'run'],
      { cwd: { arg: '/tmp/{project_dir}' } },
      {
        editable_args: [{ key: 'project_dir', type: 'string', label: 'Project directory', required: true, affects_target: true }],
      },
      'vitest',
    ));
    expect(issuesWithCode(freeform, 'composition_cli_cwd_arg')).toHaveLength(1);
    expect(freeform.valid).toBe(false);

    const nonTarget = validateComposition(cliComposition(
      ['vitest', 'run'],
      { cwd: { arg: '{project_dir}' } },
      {
        editable_args: [{ key: 'project_dir', type: 'string', label: 'Project directory', required: true }],
      },
      'vitest',
    ));
    expect(issuesWithCode(nonTarget, 'composition_cli_cwd_target_arg')).toHaveLength(1);
    expect(nonTarget.valid).toBe(false);
  });

  it('allows runtime-managed detached CLI jobs with fixed argv and marker completion', () => {
    const result = validateComposition(cliComposition(
      ['codex', 'exec', '--cd', '{repo_dir}', '{task}'],
      {
        kind: 'cli_invocation',
        detached: {
          mode: 'runtime_managed',
          completion: {
            kind: 'marker_file',
            exit_pattern: '{result_dir}/{key}.exit.{code}',
            log_pattern: '{result_dir}/{key}.log',
          },
          cancel: {
            kind: 'process_group',
            pid_pattern: '{result_dir}/{key}.pid',
          },
        },
      },
      {
        // Marker-path template args must be human-visible at the approval
        // surface (composition_cli_detached_ref_not_target_editable).
        editable_args: [
          { key: 'result_dir', type: 'string', label: 'Result directory', required: true, affects_target: true },
          { key: 'key', type: 'string', label: 'Result marker key', required: true, affects_target: true },
        ],
      },
    ));

    expect(result.valid).toBe(true);
    expect(issuesWithCode(result, 'composition_cli_code_hole')).toEqual([]);
    expect(issuesWithCode(result, 'composition_cli_streaming_lint')).toEqual([]);
  });

  it('warns on streaming and long foreground argv tokens without blocking validation', () => {
    const result = validateComposition(cliComposition(['docker', 'logs', '--follow']));
    const issues = issuesWithCode(result, 'composition_cli_streaming_lint');

    expect(result.valid).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warn' });
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('does not scan non-cli_invocation bindings', () => {
    // The cli argv / output / input scans are gated on a `cli_invocation` bind;
    // a `method_call` bind (an interpreter argv_template embedded in it notwith-
    // standing) is never scanned.
    const result = validateComposition(methodComposition());

    expect(issuesWithCode(result, 'composition_cli_code_hole')).toEqual([]);
    expect(issuesWithCode(result, 'composition_cli_streaming_lint')).toEqual([]);
  });
});

describe('document-toolkit — output_capture binding guards', () => {
  const DOCLING_ARGV = ['docling', '{source}', '--to', 'md', '--output', '{output_dir}'];
  const FILE_REF_CAPTURE = { dir_arg: 'output_dir', mime_type: 'text/markdown' };

  it('accepts a well-formed file_ref output_capture (shape: ref, engine-managed dir_arg token)', () => {
    const result = validateComposition(
      cliComposition(
        DOCLING_ARGV,
        { shape: 'ref', output_capture: FILE_REF_CAPTURE },
        { editable_args: [{ key: 'source', type: 'string', label: 'Source', required: true }] },
      ),
    );
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_output_capture'))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('D-185 Slice 3 — rejects an output_capture op that is not shape: ref (a value shape leaks content via stdout)', () => {
    const result = validateComposition(
      cliComposition(DOCLING_ARGV, {
        shape: 'text',
        output_capture: FILE_REF_CAPTURE,
      }),
    );
    expect(issuesWithCode(result, 'composition_cli_output_capture_shape')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects a dir_arg with no matching {token} in argv_template', () => {
    const result = validateComposition(
      cliComposition(DOCLING_ARGV, {
        shape: 'ref',
        output_capture: { ...FILE_REF_CAPTURE, dir_arg: 'nope' },
      }),
    );
    expect(issuesWithCode(result, 'composition_cli_output_capture_dir_arg')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects a dir_arg that is also a user-supplied editable_arg (engine owns the output path)', () => {
    const result = validateComposition(
      cliComposition(
        DOCLING_ARGV,
        { shape: 'ref', output_capture: FILE_REF_CAPTURE },
        { editable_args: [{ key: 'output_dir', type: 'string', label: 'Out', required: true }] },
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_output_capture_dir_arg_editable')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects output_capture combined with a detached job spec (foreground-only)', () => {
    const result = validateComposition(
      cliComposition(DOCLING_ARGV, {
        shape: 'ref',
        output_capture: FILE_REF_CAPTURE,
        detached: {
          mode: 'runtime_managed',
          completion: { exit_pattern: '{result_dir}/done.exit.{code}' },
        },
      } as Partial<CliMethodBinding>),
    );
    expect(issuesWithCode(result, 'composition_cli_output_capture_detached')).toHaveLength(1);
  });

  it('rejects an empty mime_type', () => {
    const result = validateComposition(
      cliComposition(DOCLING_ARGV, {
        shape: 'ref',
        output_capture: { ...FILE_REF_CAPTURE, mime_type: '' },
      }),
    );
    expect(issuesWithCode(result, 'composition_cli_output_capture_mime')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });
});

describe('SMB-finance slice 3 — input_materialize binding guards', () => {
  const DOCLING_ARGV = ['docling', '{source}', '--to', 'md', '--output', '{output_dir}'];
  const FILE_REF_CAPTURE = { dir_arg: 'output_dir', mime_type: 'text/markdown' };
  const MATERIALIZE = { kind: 'file_ref' as const, arg: 'source' };
  const SOURCE_ARG = { editable_args: [{ key: 'source', type: 'string' as const, label: 'Source', required: true }] };

  it('accepts a well-formed file_ref input_materialize (argv token + editable_arg + shape: ref)', () => {
    const result = validateComposition(
      cliComposition(
        DOCLING_ARGV,
        { shape: 'ref', input_materialize: MATERIALIZE, output_capture: FILE_REF_CAPTURE },
        SOURCE_ARG,
      ),
    );
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_input_materialize'))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a non-file_ref materialize kind', () => {
    const result = validateComposition(
      cliComposition(
        DOCLING_ARGV,
        { input_materialize: { ...MATERIALIZE, kind: 'path' } } as unknown as Partial<CliMethodBinding>,
        SOURCE_ARG,
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_input_materialize_kind')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('D-185 Slice 3 — rejects input_materialize with a value shape (the materialized bytes could echo via stdout)', () => {
    const result = validateComposition(
      cliComposition(
        DOCLING_ARGV,
        { input_materialize: MATERIALIZE, shape: 'text' },
        SOURCE_ARG,
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_input_materialize_stdout')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects an arg with no matching {token} in argv_template', () => {
    const result = validateComposition(
      cliComposition(
        ['docling', '--to', 'md'],
        { input_materialize: MATERIALIZE },
        SOURCE_ARG,
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_input_materialize_arg')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects an arg that is NOT a declared editable_arg (the input is caller-supplied)', () => {
    const result = validateComposition(
      cliComposition(DOCLING_ARGV, { input_materialize: MATERIALIZE }),
    );
    expect(issuesWithCode(result, 'composition_cli_input_materialize_arg_editable')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('rejects materialize arg colliding with the engine-owned output_capture dir_arg', () => {
    const result = validateComposition(
      cliComposition(
        ['docling', '{output_dir}'],
        {
          shape: 'ref',
          input_materialize: { kind: 'file_ref' as const, arg: 'output_dir' },
          output_capture: FILE_REF_CAPTURE,
        },
        { editable_args: [{ key: 'output_dir', type: 'string' as const, label: 'Out', required: true }] },
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_input_materialize_dir_arg_collision')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('D-172 I-4 — rejects input_materialize combined with a detached job spec (foreground-only; a detached log re-opens the stderr content-echo channel)', () => {
    const result = validateComposition(
      cliComposition(
        DOCLING_ARGV,
        {
          shape: 'ref',
          input_materialize: MATERIALIZE,
          output_capture: FILE_REF_CAPTURE,
          detached: {
            mode: 'runtime_managed',
            completion: { exit_pattern: '{result_dir}/done.exit.{code}' },
          },
        } as Partial<CliMethodBinding>,
        SOURCE_ARG,
      ),
    );
    expect(issuesWithCode(result, 'composition_cli_input_materialize_detached')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('D-189 accepts bounded file_ref_array materialization through typed argv expansion', () => {
    const result = validateComposition(
      cliComposition(
        ['pdfunite', { expand_arg: 'sources' }, '{out_dir}/merged.pdf'],
        {
          shape: 'ref',
          input_materialize: { kind: 'file_ref_array', arg: 'sources', min_items: 2, max_items: 2 },
          output_capture: { dir_arg: 'out_dir', mime_type: 'application/pdf' },
        },
        {
          args: [{ key: 'sources', type: 'file_ref[]', affects_target: true }],
          editable_args: [{ key: 'sources', type: 'string' as const, label: 'Sources', required: true }],
        },
        'pdfunite',
      ),
    );

    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_argv_expand'))).toEqual([]);
    expect(result.issues.filter((i) => i.code.startsWith('composition_cli_input_materialize'))).toEqual([]);
  });

  it('D-189 rejects typed argv expansion without matching file_ref_array materialization', () => {
    const result = validateComposition(
      cliComposition(
        ['pdfunite', { expand_arg: 'sources' }, '{out_dir}/merged.pdf'],
        {
          shape: 'ref',
          output_capture: { dir_arg: 'out_dir', mime_type: 'application/pdf' },
        },
        {
          editable_args: [{ key: 'sources', type: 'string' as const, label: 'Sources', required: true }],
        },
        'pdfunite',
      ),
    );

    expect(issuesWithCode(result, 'composition_cli_argv_expand_materialize')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('D-189 rejects scalar file_ref materialization wired to an expand_arg entry', () => {
    const result = validateComposition(
      cliComposition(
        ['pdfunite', { expand_arg: 'sources' }, '{out_dir}/merged.pdf'],
        {
          shape: 'ref',
          input_materialize: { kind: 'file_ref', arg: 'sources' },
          output_capture: { dir_arg: 'out_dir', mime_type: 'application/pdf' },
        },
        {
          editable_args: [{ key: 'sources', type: 'string' as const, label: 'Sources', required: true }],
        },
        'pdfunite',
      ),
    );

    expect(issuesWithCode(result, 'composition_cli_argv_expand_materialize')).toHaveLength(1);
    expect(issuesWithCode(result, 'composition_cli_input_materialize_arg')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('D-189 rejects file_ref_array bounds above the runtime cap', () => {
    const result = validateComposition(
      cliComposition(
        ['pdfunite', { expand_arg: 'sources' }, '{out_dir}/merged.pdf'],
        {
          shape: 'ref',
          input_materialize: { kind: 'file_ref_array', arg: 'sources', min_items: 1, max_items: 33 },
          output_capture: { dir_arg: 'out_dir', mime_type: 'application/pdf' },
        },
        {
          editable_args: [{ key: 'sources', type: 'string' as const, label: 'Sources', required: true }],
        },
        'pdfunite',
      ),
    );

    expect(issuesWithCode(result, 'composition_cli_input_materialize_bounds')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });
});
