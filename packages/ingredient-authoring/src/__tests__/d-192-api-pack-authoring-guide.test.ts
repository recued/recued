/** internal design notes — the guide's own example, executed.
 *
 *  A documentation example that has never been run is a `hand_written` authority: it looks
 *  authoritative, nothing validates it, and it rots silently. This suite is the validation
 *  loop. The composition below is transcribed VERBATIM from the guide (§1 / §2 / §4) and run
 *  through the REAL publish gate, the REAL composition validator and the REAL Source
 *  validator. **If the guide drifts from the code, this goes red.**
 *
 *  It has already earned its keep: the first draft of the guide omitted
 *  `read_resolution.wild_query` — which is REQUIRED, not optional
 *  (`work-entity-sources.ts:502`) — so the example it told authors to copy would have failed
 *  `WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID` on their first publish.
 *
 *  ⚠ If you change the guide's example, change it HERE too. They are one artifact. */

import { describe, expect, it } from 'vitest';
import { BULK_PACK_INSTALL_PERMISSION, parseBulkPackManifest } from '@recued/contracts';
import { validateRecipe } from '@recued/recipes';
import { validateWorkEntitySources } from '@recued/ingredients/validate-work-entity-sources.js';

import { decomposeComposition } from '../decomposer.js';
import { validateComposition } from '../validators.js';

/** ⬇ VERBATIM from internal design notes §2 + §4. */
const guideComposition = (): Record<string, any> => ({
  schema_version: 1,
  slug: 'acme-catalog',
  catalog_kind: 'official',

  // ── Table A — what you can talk to ──────────────────────────────────────────
  ingredients: [{
    slug: 'acme-catalog',
    kind: 'http',
    http: { base: 'https://api.acme.example', connection: 'acme', result_path: 'items' },
  }],

  // ── Table B — what a recipe can call ────────────────────────────────────────
  operations: [
    {
      op: 'task.list', ingredient: 'acme-catalog',
      risk: 'read', approval: 'never', idempotency: 'safe',
      description: 'List my open Acme tasks.',
      bind: { kind: 'rest', method: 'GET', path_template: '/v1/tasks', static_query: { limit: '100' } },
      result_path: 'items',
      cache_ttl_ms: 60_000,
    },
    {
      op: 'task.read', ingredient: 'acme-catalog',
      risk: 'read', approval: 'never', idempotency: 'safe',
      description: 'Read one Acme task.',
      bind: { kind: 'rest', method: 'GET', path_template: '/v1/tasks/{{task_id}}' },
    },
  ],

  // ── Optional — a synced Source. NOTE: no `contract_source`, no catalog pin. ──
  work_entity_sources: [{
    kind: 'task',
    source_id_template: 'acme.${connection_id}.task',
    source_label_template: 'Acme tasks (${connection_name})',
    source_kind: 'connection',
    remote: {
      entity: 'task', id: 'id',
      version: { kind: 'updated_at', field: 'updated_at' },
      hash_fields: ['title', 'state', 'due_at'],
    },
    ops: { list: 'task.list', read: 'task.read' },
    op_bindings: { read: { id_arg: 'task_id' } },
    sync: {
      mode: 'read_only', depth: 'meta',
      tombstones: 'none', list_scope: 'filtered',
      stale_after_ms: 3_600_000,
    },
    read_resolution: {
      default: 'local_rich_meta',
      remote_when: ['field_missing', 'source_stale', 'complete_body_required',
        'current_remote_required', 'write_preflight'],
      wild_query: {
        remote_fanout: 'bounded_targeted',
        max_sources: 3,
        max_remote_records: 10,
        on_exceeds_cap: 'ask_to_narrow',
      },
    },
    projection: {
      canonical: { title: 'title', state: 'state' },
      preview: { body: { field: 'description', max_chars: 800 } },
      extension: { detail_fidelity: 'preview' },
    },
  }],
});

/** ⬇ VERBATIM from internal design notes §1. */
const guidePack = (): Record<string, unknown> => ({
  manifest_version: 2,
  artifact_type: 'pack',
  pack_kind: 'app_pack',
  slug: 'acme-tasks',
  publisher: 'your-publisher-id',
  name: 'Acme Tasks',
  description: 'Sync and act on Acme tasks.',
  version: 1,
  recipes: [],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:acme'],
  contents: [{ type: 'composition', composition: guideComposition() }],
});

const compositionErrors = (c: Record<string, unknown>) =>
  (validateComposition as (b: unknown, o?: unknown) => { issues: Array<{ severity: string; code: string }> })(
    c, { recipeValidator: validateRecipe },
  ).issues.filter((i) => i.severity === 'error');

const sourceErrors = (c: Record<string, any>) => {
  const catalog = (decomposeComposition as any)[c.schema_version as number](c).catalog;
  const out: string[] = [];
  (validateWorkEntitySources as any)(catalog, (sev: string, code: string) => {
    if (sev === 'error') out.push(code);
  });
  return out;
};

describe('the API pack authoring guide — the guide validates', () => {
  it('the pack envelope passes the REAL publish gate', () => {
    const parsed = parseBulkPackManifest(guidePack()) as { ok: boolean };

    expect(parsed.ok).toBe(true);
  });

  it('the composition passes validateComposition — which now runs at BOTH publish and install', () => {
    expect(compositionErrors(guideComposition())).toEqual([]);
  });

  it('the synced Source validates with NO contract_source and NO catalog pin (the ratified rule)', () => {
    const c = guideComposition();

    // The whole point of the authority ladder: a vendor that publishes no OpenAPI is
    // authorable. Neither the declaration nor the catalog carries a pin here.
    expect(c.work_entity_sources[0].contract_source).toBeUndefined();
    expect(c.ingredients[0].http.openapi_source).toBeUndefined();

    expect(sourceErrors(c)).toEqual([]);
  });

  // ⚠ The trap the guide calls out in §4, pinned. `read_resolution.wild_query` is REQUIRED
  // (`work-entity-sources.ts:502` — not optional), and the guide's FIRST DRAFT omitted it.
  // An author copying that draft would have failed on their first publish. If someone
  // "simplifies" the guide's example by dropping this block again, this test says so.
  it('DROPPING read_resolution.wild_query breaks it — the guide says REQUIRED, and means it', () => {
    const c = guideComposition();
    delete c.work_entity_sources[0].read_resolution.wild_query;

    expect(sourceErrors(c)).toContain('WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID');
  });
});

/** §8b — the recipes a pack ships.
 *
 *  §8b exists because the guide previously said NOTHING about `output`, and a vendor session
 *  authoring against it shipped eight recipes whose entire detail block was `output.content`
 *  — a key the validator has no concept of, so it is not rejected, it is SILENT. The guide
 *  now tells authors the opposite. Same rule as above: a documentation example nothing
 *  executes is a `hand_written` authority, so §8b's example is run here.
 *
 *  ⚠ If you change §8b's example, change it HERE too. They are one artifact. */
const guideOutputRecipe = (output: unknown) => ({
  recipe_id: 'guide-8b-output',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Guide §8b output',
    description: 'The api-pack guide §8b output example, executed against the real validator.',
    author: 'recued-core',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'after', transform: 'concat', values: ['ok'] },
    { id: 'card', transform: 'to_summary', fields: [{ label: 'Order', value: '{{step.after}}' }] },
  ],
  output,
});

const recipeErrors = (output: unknown): string[] =>
  validateRecipe(guideOutputRecipe(output) as never)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);

describe('the API pack authoring guide §8b — output.render', () => {
  it('the §8b example validates VERBATIM', () => {
    // ⬇ VERBATIM from §8b.
    expect(
      recipeErrors({
        render: [
          { type: 'summary', source: 'step.card' },
          { type: 'json', source: 'step.after.result', label: 'Updated order' },
        ],
      }),
    ).toEqual([]);
  });

  it('`markdown` is NOT a kind — the guide says so, and the gate agrees', () => {
    // The trap §8b names: 24 shipped sections authored `markdown`, which would have failed
    // here the moment they were moved into `render`. AI prose is `ai_analysis`.
    expect(recipeErrors({ render: [{ type: 'markdown', source: 'step.after' }] }))
      .toContain('output_section_type_invalid');
    expect(recipeErrors({ render: [{ type: 'ai_analysis', source: 'step.after' }] }))
      .toEqual([]);
  });

  it('`output.content` is REJECTED — the fence landed, so the guide no longer carries this alone', () => {
    // This assertion used to be `.toEqual([])`, pinning the SILENCE: a `content` block passed
    // validation clean and rendered nowhere, which is why §8b had to warn about it in prose.
    // It was written to go red the moment `output_unknown_key` shipped — and it did. The rule
    // is now enforced where it belongs, and the prose is a courtesy rather than the only
    // guard. Both halves of the old trap now fail loudly:
    expect(recipeErrors({ render: [{ type: 'summary', source: 'step.card' }], content: [
      { type: 'json', title: 'Updated order', source: 'step.after.result' },
    ] })).toContain('output_unknown_key');
    expect(recipeErrors({ render: [
      { type: 'json', source: 'step.after.result', title: 'Updated order' },
    ] })).toContain('output_section_unknown_key');
  });
});
