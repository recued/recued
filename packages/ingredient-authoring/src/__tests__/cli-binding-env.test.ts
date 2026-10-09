/** `cli_invocation` `env` — the environment variables an op pins for its
 *  process. A closed list (`CLI_BINDING_ENV_NAMES`), because a variable can
 *  make the pinned binary load other code or find another binary — reopening,
 *  from outside argv, what the argv[0] pin closes. Refused at authoring AND by
 *  the catalog validator, which is all a directly-published pack meets. */

import { describe, expect, it } from 'vitest';
import { CLI_BINDING_ENV_NAMES, type CliMethodBinding, type CompositionIngredient, type PackOperationRow } from '@recued/contracts';
import { validateComposition } from '../index.js';

const composition = (bindExtra: Record<string, unknown>): CompositionIngredient => ({
  schema_version: 1,
  slug: 'opencode-cli',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'opencode-cli',
      kind: 'cli',
      cli: {
        tool: 'opencode',
        probe: ['opencode', '--version'],
        package_ref: 'system_binary:opencode',
        entry_point: 'opencode',
      },
    },
  ],
  operations: [
    {
      op: 'opencode.models',
      ingredient: 'opencode-cli',
      risk: 'read',
      approval: 'never',
      bind: {
        kind: 'cli_invocation',
        argv_template: ['opencode', 'models'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        ...bindExtra,
      } as Partial<CliMethodBinding> as unknown as PackOperationRow['bind'],
      description: 'List the models opencode can use.',
    },
  ],
});

const codes = (bindExtra: Record<string, unknown>) =>
  validateComposition(composition(bindExtra)).issues.filter((i) => i.severity === 'error');

const authoring = (bindExtra: Record<string, unknown>, code: string) =>
  codes(bindExtra).filter((i) => i.code === code);

const catalog = (bindExtra: Record<string, unknown>) =>
  codes(bindExtra).filter((i) => i.code === 'CATALOG_BINDING_INVALID' && i.message.includes(' env '));

describe('cli_invocation env — pinned environment variables', () => {
  it('accepts every member of the closed list with a literal value', () => {
    const env = Object.fromEntries(CLI_BINDING_ENV_NAMES.map((name) => [name, name === 'OPENCODE_PERMISSION' ? '{"edit":"deny"}' : '1']));
    expect(codes({ env })).toEqual([]);
  });

  it('accepts a binding that pins nothing', () => {
    expect(codes({})).toEqual([]);
  });

  /** ⛔ Each of these would let the pinned binary run code the pack chose
   *  outside argv, or find another binary on PATH. */
  it.each([
    'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'PYTHONPATH', 'BASH_ENV', 'GIT_SSH_COMMAND',
    'opencode_disable_project_config', 'OPENCODE_CONFIG',
  ])('refuses %s', (name) => {
    const env = { [name]: '1' };
    expect(authoring({ env }, 'composition_cli_env_name')).toHaveLength(1);
    expect(catalog({ env })).toHaveLength(1);
  });

  it.each([
    ['a number', 1],
    ['an object', { deny: true }],
    ['a NUL byte', 'a\0b'],
    ['an over-long value', 'x'.repeat(4097)],
  ])('refuses %s as a value', (_label, value) => {
    const env = { OPENCODE_PERMISSION: value };
    expect(authoring({ env }, 'composition_cli_env_value')).toHaveLength(1);
    expect(catalog({ env })).toHaveLength(1);
  });

  it.each([
    ['an empty object', {}],
    ['an array', ['OPENCODE_DISABLE_PROJECT_CONFIG=1']],
    ['a string', 'OPENCODE_DISABLE_PROJECT_CONFIG=1'],
    ['null', null],
  ])('refuses %s as env', (_label, env) => {
    expect(authoring({ env }, 'composition_cli_env_shape')).toHaveLength(1);
    expect(catalog({ env })).toHaveLength(1);
  });

  /** A supervised daemon starts on a path that does not apply them, and an op
   *  that pinned them must not run without them. */
  it('refuses env on a detached job', () => {
    const detached = {
      env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
      shape: undefined,
      detached: { mode: 'runtime_managed', completion: { kind: 'marker_file', exit_pattern: '{result_dir}/job.exit.{code}' } },
    };
    expect(authoring(detached, 'composition_cli_env_detached')).toHaveLength(1);
    expect(catalog(detached)).toHaveLength(1);
  });
});
