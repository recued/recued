import { describe, expect, it } from 'vitest';
import { validatePackStructure } from '../validators.js';

const base = (hints: unknown[], connection: string) => ({
  manifest_version: 2, artifact_type: 'pack', pack_kind: 'app_pack',
  slug: 'acme-tasks', publisher: 'third-party', name: 'Acme', description: 'x',
  version: 1, recipes: [], requires: ['install_bulk_pack'], tags: ['pack:acme'],
  connection_hints: hints,
  contents: [{
    type: 'composition',
    composition: {
      schema_version: 1, slug: 'acme-catalog', catalog_kind: 'official',
      ingredients: [{ slug: 'acme-catalog', kind: 'http',
        http: { base: 'https://api.acme.example', connection } }],
      operations: [{ op: 'task.list', ingredient: 'acme-catalog', risk: 'read',
        approval: 'never', idempotency: 'safe', description: 'List tasks.',
        bind: { kind: 'rest', method: 'GET', path_template: '/v1/tasks' } }],
    },
  }],
});
const codes = (p: unknown) => validatePackStructure(p)
  .filter((i) => i.severity === 'error').map((i) => i.code);

describe('D-223 — a hint must target a connection the pack actually uses', () => {
  it('admits a hint whose connection an ingredient names (the permitting case)', () => {
    const hint = { connection: 'acme', values: { 'config.base_url': 'https://api.acme.example' } };
    expect(codes(base([hint], 'acme'))).not.toContain('pack_connection_hint_connection_unused');
  });

  it('refuses a hint for a connection no ingredient uses', () => {
    // Refused rather than dropped: silently ignoring it reads to the author as
    // an accepted declaration, and the hint would then never appear.
    const hint = { connection: 'github', values: { 'config.base_url': 'https://api.acme.example' } };
    expect(codes(base([hint], 'acme'))).toContain('pack_connection_hint_connection_unused');
  });
});
