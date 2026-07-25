/** D-192 — `source_dependencies` declaration validator (Slice 1). Shape gates for
 *  the input-dependency graph that `create_if_not_picked` resolves: unique refs,
 *  list_op + id/label, create_op ⇔ create_name_arg, `arg_from` top-down (no
 *  cycles), non-empty `binds` against declared ops, and resolve↔op-role pairing.
 *  See D-192. */

import { describe, expect, it } from 'vitest';
import { validateWorkEntitySources } from '../validate-work-entity-sources.js';

/** A valid read_write task declaration (ops list+read+create) wrapped in the
 *  minimal catalog manifest the validator needs. Only `source_dependencies` is
 *  varied per case; `validateOne` returns the error-severity paths. */
const baseDecl = (): Record<string, unknown> => ({
  kind: 'task',
  source_id_template: 'v.${connection_id}.task',
  source_kind: 'connection',
  contract_source: {
    kind: 'openapi', surface: 'surfaces.api.openapi_source',
    url: 'u', sha256: 'a'.repeat(64), operations: ['task.search', 'task.read', 'task.create'],
  },
  remote: { entity: 'task', id: 'id', version: { kind: 'updated_at', field: 'updated' }, hash_fields: ['title'] },
  ops: { list: 'task.search', read: 'task.read', create: 'task.create' },
  op_bindings: { read: { id_arg: 'task_id' } },
  sync: { mode: 'read_write', depth: 'meta', tombstones: 'none', list_scope: 'filtered', stale_after_ms: 3_600_000 },
  read_resolution: {
    default: 'local_rich_meta', remote_when: ['field_missing'],
    wild_query: { remote_fanout: 'bounded_targeted', max_sources: 3, max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow' },
  },
  projection: { canonical: { title: 'title', state: 'status' } },
  writable_fields: ['title', 'state'],
  write_policy: {
    conditional_write: 'none',
    stale_write: 'manual_merge', field_conflicts: 'manual_merge',
  },
});

const validateOne = (deps: unknown): string[] => {
  const decl = baseDecl();
  decl.source_dependencies = deps;
  const errors: string[] = [];
  validateWorkEntitySources(
    {
      work_entity_sources: [decl],
      surfaces: {
        api: {
          openapi_source: { url: 'u', sha256: 'a'.repeat(64) },
          executes: {
            'task.search': { kind: 'rest', method: 'GET', path_template: '/tasks' },
            'task.read': { kind: 'rest', method: 'GET', path_template: '/tasks/{{task_id}}' },
            'task.create': { kind: 'rest', method: 'POST', path_template: '/tasks' },
          },
        },
      },
    } as unknown as Record<string, unknown>,
    (severity, _code, path) => { if (severity === 'error') errors.push(path); },
  );
  // keep only source_dependencies paths so an unrelated base regression is loud
  // but doesn't mask which dep gate fired.
  return errors.filter((p) => p.includes('source_dependencies'));
};

const WORKSPACE = {
  ref: 'workspace', list_op: 'workspace.search', id_field: 'gid', label_field: 'name',
  binds: [{ op: 'list', arg: 'query.workspace' }], resolve: 'persist',
};
const TEAM_CREATE = {
  ref: 'team', list_op: 'team.search', id_field: 'id', label_field: 'name',
  create_op: 'team.create', create_name_arg: 'name',
  binds: [{ op: 'create', arg: 'teamId' }], resolve: 'prompt',
};

describe('D-192 validator — source_dependencies', () => {
  it('accepts a persist list-scope dependency (Asana workspace)', () => {
    expect(validateOne([WORKSPACE])).toEqual([]);
  });

  it('accepts a prompt create dependency with a create op (Linear team)', () => {
    expect(validateOne([TEAM_CREATE])).toEqual([]);
  });

  it('accepts a chained parent→child dependency (workspace → project)', () => {
    const project = {
      ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
      arg_from: [{ dependency: 'workspace', arg: 'query.workspace' }],
      binds: [{ op: 'list', arg: 'query.project' }], resolve: 'persist',
    };
    expect(validateOne([WORKSPACE, project])).toEqual([]);
  });

  it('rejects a duplicate ref', () => {
    expect(validateOne([WORKSPACE, { ...WORKSPACE }]).some((p) => p.endsWith('[1].ref'))).toBe(true);
  });

  it('rejects a missing list_op / id_field / label_field', () => {
    const errs = validateOne([{ ref: 'workspace', binds: [{ op: 'list', arg: 'x' }], resolve: 'persist' }]);
    expect(errs.some((p) => p.endsWith('.list_op'))).toBe(true);
    expect(errs.some((p) => p.endsWith('.id_field'))).toBe(true);
    expect(errs.some((p) => p.endsWith('.label_field'))).toBe(true);
  });

  it('rejects a create_op without a create_name_arg', () => {
    const dep = { ...TEAM_CREATE, create_name_arg: undefined };
    expect(validateOne([dep]).some((p) => p.endsWith('.create_name_arg'))).toBe(true);
  });

  it('rejects a create_name_arg without a create_op (dead config)', () => {
    const dep = { ...WORKSPACE, create_name_arg: 'name' };
    expect(validateOne([dep]).some((p) => p.endsWith('.create_name_arg'))).toBe(true);
  });

  it('rejects arg_from that references a later / unknown dependency (forward ref)', () => {
    // project declared BEFORE workspace → its arg_from ref is not yet seen.
    const project = {
      ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
      arg_from: [{ dependency: 'workspace', arg: 'query.workspace' }],
      binds: [{ op: 'list', arg: 'query.project' }], resolve: 'persist',
    };
    expect(validateOne([project, WORKSPACE]).some((p) => p.includes('arg_from[0].dependency'))).toBe(true);
  });

  it('rejects empty binds', () => {
    expect(validateOne([{ ...WORKSPACE, binds: [] }]).some((p) => p.endsWith('.binds'))).toBe(true);
  });

  it('rejects a bind op not declared in ops', () => {
    // 'update' is a valid slot but this Source declares no update op.
    const dep = { ...TEAM_CREATE, binds: [{ op: 'update', arg: 'x' }] };
    expect(validateOne([dep]).some((p) => p.includes('.binds[0].op'))).toBe(true);
  });

  it('rejects a persist dep that binds only a write op (unresolvable headless)', () => {
    const dep = { ...WORKSPACE, binds: [{ op: 'create', arg: 'x' }], resolve: 'persist' };
    expect(validateOne([dep]).some((p) => p.endsWith('.resolve'))).toBe(true);
  });

  it('rejects a prompt dep that binds only a read op', () => {
    const dep = { ...TEAM_CREATE, binds: [{ op: 'list', arg: 'x' }], resolve: 'prompt' };
    expect(validateOne([dep]).some((p) => p.endsWith('.resolve'))).toBe(true);
  });

  it('rejects an invalid resolve mode', () => {
    expect(validateOne([{ ...WORKSPACE, resolve: 'auto' }]).some((p) => p.endsWith('.resolve'))).toBe(true);
  });

  // When the manifest declares the ops (risk tiers present), the list_op MUST be a
  // read — the grant substrate auto-admits it, so a write would over-grant.
  const validateWithOps = (dep: unknown, listOpRisk: string): string[] => {
    const errors: string[] = [];
    validateWorkEntitySources(
      {
        work_entity_sources: [{ ...baseDecl(), source_dependencies: [dep] }],
        operations: {
          'team.search': { risk_tier: 'read' },
          'team.create': { risk_tier: listOpRisk },
        },
        surfaces: {
          api: {
            openapi_source: { url: 'u', sha256: 'a'.repeat(64) },
            executes: { 'task.search': { kind: 'rest', method: 'GET', path_template: '/tasks' } },
          },
        },
      } as unknown as Record<string, unknown>,
      (severity, _code, path) => { if (severity === 'error') errors.push(path); },
    );
    return errors.filter((p) => p.includes('source_dependencies'));
  };

  it('rejects a source_dependency whose list_op is a WRITE op (grant over-grant guard)', () => {
    const dep = {
      ref: 'team', list_op: 'team.create', id_field: 'id', label_field: 'name',
      binds: [{ op: 'create', arg: 'teamId' }], resolve: 'prompt',
    };
    expect(validateWithOps(dep, 'write').some((p) => p.endsWith('source_dependencies[0].list_op'))).toBe(true);
  });

  it('accepts a read-tier list_op when the manifest declares it (no false positive)', () => {
    const dep = {
      ref: 'team', list_op: 'team.search', id_field: 'id', label_field: 'name',
      binds: [{ op: 'create', arg: 'teamId' }], resolve: 'prompt',
    };
    expect(validateWithOps(dep, 'read').some((p) => p.endsWith('.list_op'))).toBe(false);
  });
});
