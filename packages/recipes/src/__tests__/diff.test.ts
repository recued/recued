import { describe, it, expect } from 'vitest';
import { diffRecipes, changeCount } from '../diff.js';

// ────────────────────────────────────────────────────────────────
// Minimal recipe builder
// ────────────────────────────────────────────────────────────────

const base = () => ({
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Deal Risk',
    description: 'A test recipe fixture.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['deal', 'risk'],
  },
  variables: {
    threshold: 7,
    verbose: true,
  },
  prefetch_steps: [
    { id: 'deal', ingredient: 'deal-reader-hubspot', input: {} },
  ],
  steps: [
    { id: 's1', transform: 'template', template: 'hi' },
    { id: 's2', transform: 'template', template: 'bye' },
  ],
  output: {
    sidebar: [{ type: 'summary', source: 'step.s1' }],
  },
});

// ────────────────────────────────────────────────────────────────
// Equality
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — equality', () => {
  it('identical recipes → equal true, no changes', () => {
    const diff = diffRecipes(base(), base());
    expect(diff.equal).toBe(true);
    expect(changeCount(diff)).toBe(0);
    expect(diff.hash_before).toBe(diff.hash_after);
  });

  it('equal when keys are reordered (canonical form is stable)', () => {
    const b = base();
    const reordered = {
      version: b.version,
      output: b.output,
      steps: b.steps,
      prefetch_steps: b.prefetch_steps,
      recipe_id: b.recipe_id,
      variables: b.variables,
      metadata: b.metadata,
      ttl: b.ttl,
    };
    const diff = diffRecipes(b, reordered);
    expect(diff.equal).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Top-level fields
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — top_level', () => {
  it('ttl changed → top_level entry with before/after', () => {
    const b = base();
    const a = { ...b, ttl: 600 };
    const diff = diffRecipes(b, a);
    expect(diff.equal).toBe(false);
    expect(diff.top_level).toEqual([
      { path: 'ttl', before: 300, after: 600 },
    ]);
  });

  it('version bumped → top_level entry', () => {
    const b = base();
    const a = { ...b, version: 2 };
    const diff = diffRecipes(b, a);
    expect(diff.top_level[0]).toEqual({ path: 'version', before: 1, after: 2 });
  });

  it('trigger added → top_level entry', () => {
    const b = base();
    const a = { ...b, trigger: ['app.hubspot.com/deals/*'] };
    const diff = diffRecipes(b, a);
    expect(diff.top_level.length).toBe(1);
    expect(diff.top_level[0].path).toBe('trigger');
    expect(diff.top_level[0].before).toBeUndefined();
    expect(diff.top_level[0].after).toEqual(['app.hubspot.com/deals/*']);
  });

  it('recipe_id changed → top_level entry', () => {
    const b = base();
    const a = { ...b, recipe_id: 'detect-deal-risk-salesforce' };
    const diff = diffRecipes(b, a);
    expect(diff.top_level.some((c) => c.path === 'recipe_id')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Metadata
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — metadata', () => {
  it('name changed → metadata entry', () => {
    const b = base();
    const a = { ...b, metadata: { ...b.metadata, name: 'Deal Risk v2' } };
    const diff = diffRecipes(b, a);
    expect(diff.metadata).toEqual([
      { path: 'metadata.name', before: 'Deal Risk', after: 'Deal Risk v2' },
    ]);
  });

  it('tag added → metadata entry with full array diff', () => {
    const b = base();
    const a = { ...b, metadata: { ...b.metadata, tags: ['deal', 'risk', 'new-tag'] } };
    const diff = diffRecipes(b, a);
    expect(diff.metadata[0].path).toBe('metadata.tags');
    expect(diff.metadata[0].before).toEqual(['deal', 'risk']);
    expect(diff.metadata[0].after).toEqual(['deal', 'risk', 'new-tag']);
  });

  it('tag order changed → metadata entry (arrays are ordered)', () => {
    const b = base();
    const a = { ...b, metadata: { ...b.metadata, tags: ['risk', 'deal'] } };
    const diff = diffRecipes(b, a);
    expect(diff.metadata.length).toBe(1);
    expect(diff.metadata[0].path).toBe('metadata.tags');
  });

  it('custom metadata field changed → metadata entry via catch-all sweep', () => {
    const b = base();
    const a = { ...b, metadata: { ...b.metadata, custom_x: 'value' } };
    const diff = diffRecipes(b, a);
    expect(diff.metadata.some((c) => c.path === 'metadata.custom_x')).toBe(true);
  });

  it('metadata entries are sorted by path', () => {
    const b = base();
    const a = {
      ...b,
      metadata: {
        ...b.metadata,
        name: 'New Name',
        author: 'new-author',
        description: 'New description.',
      },
    };
    const diff = diffRecipes(b, a);
    const paths = diff.metadata.map((c) => c.path);
    expect(paths).toEqual([...paths].sort());
  });
});

// ────────────────────────────────────────────────────────────────
// Variables
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — variables', () => {
  it('variable added → added list', () => {
    const b = base();
    const a = { ...b, variables: { ...b.variables, new_var: 42 } };
    const diff = diffRecipes(b, a);
    expect(diff.variables.added).toEqual(['new_var']);
    expect(diff.variables.removed).toEqual([]);
    expect(diff.variables.modified).toEqual([]);
  });

  it('variable removed → removed list', () => {
    const b = base();
    const { verbose: _e, ...rest } = b.variables;
    const a = { ...b, variables: rest };
    const diff = diffRecipes(b, a);
    expect(diff.variables.removed).toEqual(['verbose']);
  });

  it('variable value changed → modified with before/after', () => {
    const b = base();
    const a = { ...b, variables: { ...b.variables, threshold: 14 } };
    const diff = diffRecipes(b, a);
    expect(diff.variables.modified).toEqual([
      { name: 'threshold', before: 7, after: 14 },
    ]);
  });

  it('handles simultaneous add/remove/modify in one diff', () => {
    const b = base();
    const a = {
      ...b,
      variables: {
        threshold: 14, // modified
        new_var: 99,   // added
        // verbose removed
      },
    };
    const diff = diffRecipes(b, a);
    expect(diff.variables.added).toEqual(['new_var']);
    expect(diff.variables.removed).toEqual(['verbose']);
    expect(diff.variables.modified.length).toBe(1);
    expect(diff.variables.modified[0].name).toBe('threshold');
  });

  it('variables lists are sorted for determinism', () => {
    const b = base();
    const a = {
      ...b,
      variables: { threshold: 7, verbose: true, z_var: 1, a_var: 2 },
    };
    const diff = diffRecipes(b, a);
    expect(diff.variables.added).toEqual(['a_var', 'z_var']);
  });
});

// ────────────────────────────────────────────────────────────────
// Steps — added / removed / modified / reordered
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — steps', () => {
  it('step added → added list', () => {
    const b = base();
    const a = {
      ...b,
      steps: [
        ...b.steps,
        { id: 's3', transform: 'template', template: 'new' },
      ],
    };
    const diff = diffRecipes(b, a);
    expect(diff.steps.added).toEqual([
      { id: 's3', phase: 'sequential', index: 2 },
    ]);
    expect(diff.steps.removed).toEqual([]);
  });

  it('step removed → removed list', () => {
    const b = base();
    const a = { ...b, steps: [b.steps[0]] };
    const diff = diffRecipes(b, a);
    expect(diff.steps.removed).toEqual([
      { id: 's2', phase: 'sequential', index: 1 },
    ]);
  });

  it('step content modified → modified list (content change wins over reorder)', () => {
    const b = base();
    const a = {
      ...b,
      steps: [
        { id: 's1', transform: 'template', template: 'CHANGED' },
        b.steps[1],
      ],
    };
    const diff = diffRecipes(b, a);
    expect(diff.steps.modified).toEqual([
      { id: 's1', phase: 'sequential', before_index: 0, after_index: 0 },
    ]);
    expect(diff.steps.reordered).toEqual([]);
  });

  it('step reordered without content change → reordered list', () => {
    const b = base();
    const a = { ...b, steps: [b.steps[1], b.steps[0]] }; // swap s1 and s2
    const diff = diffRecipes(b, a);
    expect(diff.steps.reordered.length).toBe(2);
    expect(diff.steps.modified).toEqual([]);
  });

  it('step modified AND moved → classified as modified (not reordered)', () => {
    const b = base();
    const a = {
      ...b,
      steps: [
        b.steps[1], // s2 first now
        { id: 's1', transform: 'template', template: 'MODIFIED' }, // s1 moved + modified
      ],
    };
    const diff = diffRecipes(b, a);
    expect(diff.steps.modified.length).toBe(1);
    expect(diff.steps.modified[0]).toMatchObject({
      id: 's1',
      before_index: 0,
      after_index: 1,
    });
    // s2 moved from 1 to 0 without content change → reordered
    expect(diff.steps.reordered.length).toBe(1);
    expect(diff.steps.reordered[0].id).toBe('s2');
  });

  it('prefetch step added is tagged phase "prefetch"', () => {
    const b = base();
    const a = {
      ...b,
      prefetch_steps: [
        ...b.prefetch_steps,
        { id: 'contacts', ingredient: 'contacts-reader-hubspot', input: {} },
      ],
    };
    const diff = diffRecipes(b, a);
    expect(diff.steps.added).toEqual([
      { id: 'contacts', phase: 'prefetch', index: 1 },
    ]);
  });

  it('step added in both prefetch and sequential → both appear', () => {
    const b = base();
    const a = {
      ...b,
      prefetch_steps: [
        ...b.prefetch_steps,
        { id: 'extra_fetch', ingredient: 'x', input: {} },
      ],
      steps: [
        ...b.steps,
        { id: 'extra_step', transform: 'template', template: 'x' },
      ],
    };
    const diff = diffRecipes(b, a);
    expect(diff.steps.added.map((s) => s.id).sort()).toEqual(['extra_fetch', 'extra_step']);
  });

  it('steps list is sorted (prefetch before sequential, then by index)', () => {
    const b = base();
    const a = {
      ...b,
      prefetch_steps: [
        b.prefetch_steps[0],
        { id: 'p2', ingredient: 'x', input: {} },
      ],
      steps: [
        ...b.steps,
        { id: 's3', transform: 'template', template: 'x' },
      ],
    };
    const diff = diffRecipes(b, a);
    // All three added (p2, s3)
    expect(diff.steps.added[0].phase).toBe('prefetch');
  });
});

// ────────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — output', () => {
  it('output section added → output entry', () => {
    const b = base();
    const a = {
      ...b,
      output: {
        sidebar: [
          ...b.output.sidebar,
          { type: 'text', source: 'step.s2' },
        ],
      },
    };
    const diff = diffRecipes(b, a);
    expect(diff.output.length).toBe(1);
    expect(diff.output[0].path).toBe('output');
  });

  it('output unchanged → empty output list', () => {
    const b = base();
    const a = { ...b, ttl: 600 }; // unrelated change
    const diff = diffRecipes(b, a);
    expect(diff.output).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────

describe('diffRecipes — edge cases', () => {
  it('null before + valid after → everything looks added', () => {
    const diff = diffRecipes(null, base());
    expect(diff.equal).toBe(false);
    expect(diff.steps.added.length).toBeGreaterThan(0);
    expect(diff.variables.added.length).toBe(2);
  });

  it('valid before + null after → everything looks removed', () => {
    const diff = diffRecipes(base(), null);
    expect(diff.equal).toBe(false);
    expect(diff.steps.removed.length).toBeGreaterThan(0);
    expect(diff.variables.removed.length).toBe(2);
  });

  it('both null → equal (both hash identically)', () => {
    const diff = diffRecipes(null, null);
    expect(diff.equal).toBe(true);
  });

  it('malformed before (string) → treated as empty', () => {
    const diff = diffRecipes('not-an-object', base());
    expect(diff.equal).toBe(false);
    expect(diff.steps.added.length).toBe(3); // 1 prefetch + 2 sequential
  });

  it('missing steps array → treated as empty', () => {
    const b = { recipe_id: 'x', version: 1, ttl: 60, metadata: {} };
    const a = {
      ...b,
      steps: [{ id: 's1', transform: 'template', template: 'x' }],
    };
    const diff = diffRecipes(b, a);
    expect(diff.steps.added.length).toBe(1);
  });

  it('duplicate step ids in same phase → only first counted', () => {
    const b = base();
    const a = {
      ...b,
      steps: [
        ...b.steps,
        { id: 's1', transform: 'template', template: 'dupe' }, // dup of existing s1
      ],
    };
    const diff = diffRecipes(b, a);
    // The dup is silently skipped by the indexer, so s1 is unchanged
    expect(diff.steps.added).toEqual([]);
    expect(diff.steps.modified).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// changeCount convenience
// ────────────────────────────────────────────────────────────────

describe('changeCount', () => {
  it('zero for equal recipes', () => {
    expect(changeCount(diffRecipes(base(), base()))).toBe(0);
  });

  it('sums all categories', () => {
    const b = base();
    const a = {
      ...b,
      ttl: 600, // top_level +1
      metadata: { ...b.metadata, name: 'New' }, // metadata +1
      variables: { threshold: 14, new_var: 99 }, // added +1, removed +1 (verbose), modified +1
      steps: [
        { id: 's1', transform: 'template', template: 'MOD' }, // modified +1
        { id: 's3', transform: 'template', template: 'new' }, // added +1
        // s2 removed → +1
      ],
    };
    const diff = diffRecipes(b, a);
    expect(changeCount(diff)).toBe(
      1 + 1 + 1 + 1 + 1 + 1 + 1 + 1, // 8 total
    );
  });
});
