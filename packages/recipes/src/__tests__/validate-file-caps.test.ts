/** Phase 7 (D-110) — install-time file caps validator tests. */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  validateFileInstanceCaps,
  type FileInstanceCaps,
} from '../validate-file-caps.js';

const inst = (
  slug: string,
  overrides: Partial<{
    write: 'yes' | 'no';
    delete: 'yes' | 'no';
    auth_state: FileInstanceCaps['auth_state'];
  }> = {},
): FileInstanceCaps => ({
  slug,
  caps: {
    read: 'yes',
    write: overrides.write ?? 'yes',
    delete: overrides.delete ?? 'yes',
    watch: 'realtime',
    mirror: 'optional',
    auth: 'none',
    path_style: 'posix',
  },
  auth_state: overrides.auth_state ?? 'healthy',
});

const recipe = (
  steps: Array<{ id: string; ingredient: string; input: Record<string, unknown> }>,
): RecipeDefinition => ({
  recipe_id: 't',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'test',
    description: '',
    author: 'test',
    supported_platforms: [],
    tags: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: steps.map((s) => ({ id: s.id, ingredient: s.ingredient, input: s.input })) as never,
  output: { sidebar: [] },
});

describe('validateFileInstanceCaps (Phase 7 / D-110)', () => {
  it('returns no issues for recipes without file mutations', async () => {
    const r = recipe([
      { id: 's1', ingredient: 'file-list', input: { slug: 'mydir' } },
      { id: 's2', ingredient: 'ai-summarize', input: {} },
    ]);
    const issues = await validateFileInstanceCaps(r, () => [inst('mydir')]);
    expect(issues).toHaveLength(0);
  });

  it('passes when caps match file-write requirement', async () => {
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: { target: 'mydir', path: 'out.txt' } },
    ]);
    const issues = await validateFileInstanceCaps(r, () => [inst('mydir', { write: 'yes' })]);
    expect(issues).toHaveLength(0);
  });

  it('errors when caps.write is no', async () => {
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: { target: 'readonly', path: 'out.txt' } },
    ]);
    const issues = await validateFileInstanceCaps(r, () => [inst('readonly', { write: 'no' })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].code).toBe('file_capability_denied');
    expect(issues[0].instance).toBe('readonly');
  });

  it('warns when the target instance is not enrolled', async () => {
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: { target: 'ghost', path: 'x' } },
    ]);
    const issues = await validateFileInstanceCaps(r, () => []);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].code).toBe('file_instance_unknown');
  });

  it('errors on missing target field', async () => {
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: { path: 'out.txt' } },
    ]);
    const issues = await validateFileInstanceCaps(r, () => [inst('mydir')]);
    expect(issues[0].code).toBe('file_missing_target');
    expect(issues[0].severity).toBe('error');
  });

  it('ignores inherited file ingredient discriminators', async () => {
    const inheritedStep = Object.create({
      id: 'write',
      ingredient: 'file-write',
      input: { target: 'readonly', path: 'out.txt' },
    });
    const r = {
      ...recipe([]),
      steps: [inheritedStep],
    } as unknown as RecipeDefinition;

    const issues = await validateFileInstanceCaps(r, () => [inst('readonly', { write: 'no' })]);

    expect(issues).toHaveLength(0);
  });

  it('treats inherited target fields as missing', async () => {
    const inheritedInput = Object.create({ target: 'mydir' });
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: inheritedInput },
    ]);

    const issues = await validateFileInstanceCaps(r, () => [inst('mydir')]);

    expect(issues[0].code).toBe('file_missing_target');
    expect(issues[0].severity).toBe('error');
  });

  it('validates both source and destination for file-move', async () => {
    const r = recipe([
      {
        id: 'mv',
        ingredient: 'file-move',
        input: {
          from_slug: 'downloads',
          from_path: 'a.txt',
          to_slug: 'archive',
          to_path: 'b.txt',
        },
      },
    ]);

    // Source needs delete, destination needs write. Happy path.
    let issues = await validateFileInstanceCaps(r, () => [
      inst('downloads'),
      inst('archive'),
    ]);
    expect(issues).toHaveLength(0);

    // Source without delete — error.
    issues = await validateFileInstanceCaps(r, () => [
      inst('downloads', { delete: 'no' }),
      inst('archive'),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].instance).toBe('downloads');

    // Destination without write — error.
    issues = await validateFileInstanceCaps(r, () => [
      inst('downloads'),
      inst('archive', { write: 'no' }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].instance).toBe('archive');
  });

  it('warns on degraded auth_state but does not reject', async () => {
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: { target: 'mydir', path: 'x' } },
    ]);
    const issues = await validateFileInstanceCaps(r, () => [
      inst('mydir', { auth_state: 'expired' }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].code).toBe('file_instance_degraded');
  });

  it('ignores placeholder refs (dynamic at runtime)', async () => {
    const r = recipe([
      { id: 'write', ingredient: 'file-write', input: { target: '{{config.target}}', path: 'x' } },
    ]);
    const issues = await validateFileInstanceCaps(r, () => []);
    expect(issues).toHaveLength(0);
  });
});
