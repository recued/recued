/** D-219 item 2b — a learned case becomes a DRAFT recipe the owner reviews.
 *
 *  The pipeline is authoring, not translation: brief + case + owner prompt →
 *  the owner's model → recipe JSON → the Kitchen. These tests pin the
 *  MECHANISM deterministically — the framing the model receives, what happens
 *  to malformed output, and that nothing is ever saved.
 *
 *  ⚠ WHAT THEY DO NOT TEST: whether a real model writes a GOOD recipe. That is
 *  an empirical question about a live model and belongs to a bench run, not to
 *  a stubbed one. A stub that returned a hand-written perfect recipe would be
 *  pre-deciding exactly the thing under question.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  MCP_RESERVED_RPC_PREFIXES,
  MCP_TOOL_CATALOG,
  type IngredientManifest,
} from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { handleExecutionCaseDraftRecipe } from '../chat-handler.js';
import {
  buildRecipeAuthoringVocabulary,
  buildRecipeDraftPrompt,
  draftRecipeForCase,
  draftRecipeFromCase,
  extractRecipeJson,
  recipeShapeExample,
  stripDraftAutomation,
  DRAFT_ALLOWED_FIELDS,
  RECIPE_DRAFT_FIELDS,
  RECIPE_AUTHORING_SHAPE_BRIEF,
  RECIPE_DRAFT_CONFIRMATION,
  RECIPE_DRAFT_MAX_OPS,
  type CaseRecipeDraftDeps,
  type RecipeDraftDeps,
} from '../execution-case-recipe-draft.js';

const entry = () => ({
  case_id: 'case_one',
  request: ['send the quarterly report'],
  flows: [{
    tools_that_may_be_needed: ['file.search', 'mail.send'],
    outcome: ['You confirmed this was right.'],
  }],
  shown_to_model: true,
  request_observations: 2,
  last_seen_at: 1_000,
});

/** The real validator, wrapped to the injected shape. */
const realParse: RecipeDraftDeps['parse'] = (value) => {
  const result = parseRecipe(value);
  return result.ok
    ? { ok: true, recipe: result.recipe, issues: result.issues }
    : { ok: false, issues: result.issues };
};

const vocabulary = () =>
  buildRecipeAuthoringVocabulary(KERNEL_MANIFESTS, KERNEL_OP_REGISTRY);

describe('D-219 — the vocabulary the model may draw from', () => {
  it('is DERIVED from the live registries, not a hand-written list', async () => {
    // ⛔ A model told about an op this server does not have authors a recipe
    // that cannot run, and a hand-copied list rots against the registry it
    // describes. Asserted by picking a real op out of the registry and
    // requiring it to appear — not by matching a literal this test also owns.
    const text = vocabulary();
    const backed = KERNEL_OP_REGISTRY.filter((op) => op.backing_slug);
    expect(backed.length).toBeGreaterThan(0);
    const sample = backed[0]!;
    expect(text).toContain(sample.op);
    // …and its ARGUMENT NAMES come from the same manifest the dispatcher reads,
    // so they cannot drift from what the op actually accepts.
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === sample.backing_slug);
    for (const key of Object.keys(manifest?.input ?? {}).slice(0, 2)) {
      expect(text).toContain(key);
    }
  });

  it('omits every op with no backing ingredient', async () => {
    // A native op is a grant handle, not something the engine can lower into a
    // recipe step — offering it would offer something that cannot run.
    //
    // ⚠ TWO THINGS EXCLUDE THEM AND NEITHER IS SEPARATELY PROVABLE. The
    // explicit `if (!entry.backing_slug) continue` states the intent, and the
    // manifest lookup underneath rejects the same rows anyway (`bySlug.get
    // (undefined)` finds nothing). Mutating either alone leaves this green —
    // measured, not assumed. The guard is kept for the intent; the assertion
    // below is on the OUTCOME, which is the part that must hold however it is
    // enforced.
    const native = KERNEL_OP_REGISTRY.filter((op) => !op.backing_slug);
    // Non-vacuity: there really are native ops to exclude. Without this the
    // loop below asserts nothing the day the registry has none.
    expect(native.length).toBeGreaterThan(0);
    const text = vocabulary();
    for (const op of native) expect(text).not.toContain(`${op.op} (`);
  });

  it('is bounded, so one authoring call cannot become an unbounded prompt', () => {
    const many: IngredientManifest[] = Array.from(
      { length: RECIPE_DRAFT_MAX_OPS + 50 },
      (_unused, index) => ({
        slug: `slug-${index}`, name: `n${index}`, description: 'does a thing.',
        author: 'test', kind: 'kernel', category: 'data', risk_tier: 'read',
        version: 1, tags: [], input: {}, output: {},
      } as unknown as IngredientManifest),
    );
    const ops = many.map((manifest, index) => ({
      op: `core.test.op${index}`, backing_slug: manifest.slug, risk: 'read',
    }));
    expect(buildRecipeAuthoringVocabulary(many, ops).split('\n'))
      .toHaveLength(RECIPE_DRAFT_MAX_OPS);
  });
});

describe('D-219 — the framing the model receives', () => {
  it('⛔ presents the tool sequence as EVIDENCE, never as steps', async () => {
    // ⛔⛔ THE SAFETY PROPERTY OF THE PROMPT. The field holds CHAT TOOL
    // names, and an audit of all eleven found none is a wrapper over an op —
    // `mail.search` is a fenced fan-out over every mailbox, `core.mail.email
    // .search` is one mailbox by slug. A model that reads the sequence as step
    // names reaches for the closest-looking op and silently narrows the work.
    const prompt = buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: 'run this every Monday', vocabulary: 'OPS',
      aliasedRequest: 'email pii.Person1 the quarterly report', recipes: [],
    });
    expect(prompt).toContain('EVIDENCE');
    expect(prompt).toContain('are NOT the steps to write');
    expect(prompt).toContain('CHAT TOOL names, not op ids');
    // The sequence is still there — the model needs it to infer the outcome.
    expect(prompt).toContain('file.search, mail.send');
    expect(prompt).toContain('run this every Monday');
  });

  it('⛔ a REFINEMENT is framed as a revision, not a fresh attempt', async () => {
    // Without this the second call re-derives from the same evidence and the
    // owner's correction reads as a brand-new brief: they lose the structure
    // they were happy with and get a different recipe to review from scratch.
    const prompt = buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: 'only my own meetings', vocabulary: 'OPS',
      aliasedRequest: 'list my meetings', recipes: [],
      previousDraft: '{"recipe_id":"v1","steps":[{"id":"a","op":"core.data.calendar.list"}]}',
    });
    expect(prompt).toContain('asking you to REVISE');
    expect(prompt).toContain('do not start over');
    expect(prompt).toContain('"recipe_id":"v1"');

    // ⚠ The permitting witness: a FIRST pass must not carry revise framing, or
    // every draft would be told to preserve a structure it never produced.
    const first = buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: '', vocabulary: 'OPS',
      aliasedRequest: 'list my meetings', recipes: [],
    });
    expect(first).not.toContain('asking you to REVISE');
  });

  it('⛔ STRIPS argument values from the draft being refined', async () => {
    // ⛔⛔ THE EGRESS HOLE A REFINE PASS OPENS. The first pass is careful never
    // to send a literal; by the time the owner refines, they may have typed a
    // real address into a variable's default or an arg — and handing their
    // editor state back verbatim would egress exactly what the first pass
    // protected. Same stripper as the worked example.
    const generated: string[] = [];
    await draftRecipeForCase({
      generate: async (p: string) => { generated.push(p); return '{}'; },
      parse: realParse,
      loadEntry: async () => entry(),
      loadOrigin: async () => undefined,
      aliasRequest: async () => ({ prompt: '', aliased: false }),
      loadRecipeShape: () => undefined,
      vocabulary: () => 'OPS',
    } as never, {
      case_id: 'case_one',
      ownerPrompt: 'send it to me instead',
      previousRecipe: {
        recipe_id: 'r', version: 1, ttl: 300,
        metadata: { name: 'R', description: '', author: '', supported_platforms: [] },
        variables: {},
        steps: [{
          id: 'send', op: 'core.mail.send',
          args: { to: 'alice@acme.example', subject: 'Q3 numbers' },
        }],
        output: { render: [] },
      },
    });
    expect(generated).toHaveLength(1);
    expect(generated[0]).not.toContain('alice@acme.example');
    expect(generated[0]).not.toContain('Q3 numbers');
    // …and the STRUCTURE still arrives, or the refinement is worthless.
    expect(generated[0]).toContain('core.mail.send');
  });

  it('⛔ the owner instruction OUTRANKS the recorded turn', async () => {
    // ⛔ The owner types this AFTER reading the outcome, so it is the later and
    // better-informed source. It matters most on a REJECTED case: the recorded
    // turn says what went wrong, and this says what should happen instead — a
    // model weighing them equally would split the difference and reproduce half
    // the failure. Stated as precedence rather than left to inference.
    const prompt = buildRecipeDraftPrompt({
      entry: {
        ...entry(),
        flows: [{
          tools_that_may_be_needed: ['calendar.search'],
          outcome: ['You rejected the result.'],
        }],
      },
      ownerPrompt: 'only my own meetings, not the whole team',
      vocabulary: 'OPS',
      aliasedRequest: 'list my meetings', recipes: [],
    });
    expect(prompt).toContain('only my own meetings, not the whole team');
    expect(prompt).toContain('OVERRIDES the recorded turn');
    // ⚠ Ordering is the mechanism: the instruction is LAST, so recency favours
    // it. A prompt that stated precedence but buried the instruction mid-way
    // would pass a contains-check and lose the effect.
    expect(prompt.trimEnd().endsWith('only my own meetings, not the whole team'))
      .toBe(true);
  });

  it('⛔ never presents a REJECTED route as the outcome the owner wanted', async () => {
    // ⛔⛔ THE SAFETY PROPERTY, ONE LAYER DOWN. A case is admitted on ANY
    // owner-typed verdict, so the flow in this prompt is as likely to be one the
    // owner REJECTED as one they accepted — `d-219-execution-case-precedent`
    // keeps rejections precisely so the substrate cannot teach back the mistake
    // it recorded. This prompt used to open "as EVIDENCE of the outcome they
    // wanted" and then say "achieve the same OUTCOME", which talked straight
    // over the verdict line and pointed the model at reproducing the failure.
    const rejected = {
      ...entry(),
      flows: [{
        tools_that_may_be_needed: ['calendar.search', 'contact.search'],
        outcome: ['You rejected the result.'],
      }],
    };
    const prompt = buildRecipeDraftPrompt({
      entry: rejected, ownerPrompt: '', vocabulary: 'OPS',
      aliasedRequest: 'list my meetings for the fortnight', recipes: [],
    });
    // The verdict reaches the model...
    expect(prompt).toContain('You rejected the result.');
    // ...and is not contradicted by a header calling it what they wanted.
    expect(prompt).not.toContain('EVIDENCE of the outcome they wanted');
    expect(prompt).not.toContain('achieve the same OUTCOME');
    // ...and the model is told which of the two to follow.
    expect(prompt).toContain('THE REQUEST IS THE GOAL');
    expect(prompt).toContain('what NOT to repeat');

    // ⚠ The permitting witness: the same instruction must still be present for
    // an ACCEPTED case, or this passes against a prompt that simply refuses to
    // use any recorded route.
    const accepted = buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: '', vocabulary: 'OPS',
      aliasedRequest: 'send the quarterly report', recipes: [],
    });
    expect(accepted).toContain('You confirmed this was right.');
    expect(accepted).toContain('file.search, mail.send');
  });

  it('⛔ tells the model not to bake in a value from one past run', async () => {
    // Acceptance #47 restated at the authoring layer: one observation becoming
    // a standing preference is the "always CC Alice" error. The case carries no
    // arguments at all, so the only way a literal could appear is the model
    // inventing one — and the brief forbids it and names the alternative.
    expect(RECIPE_AUTHORING_SHAPE_BRIEF)
      .toContain('Never carry a specific value across from the one run');
    expect(RECIPE_AUTHORING_SHAPE_BRIEF)
      .toContain('does not make it the owner\'s standing choice');
    expect(RECIPE_AUTHORING_SHAPE_BRIEF).toContain('{{config.');
  });

  it('⛔ tells the model the point is REUSE, not a transcript', async () => {
    // ⛔⛔ THIS REPLACED TWO EARLIER ATTEMPTS, BOTH OF WHICH LEAKED MECHANISM
    // INTO THE PROMPT. The first described an alias SHAPE (`pii.<something>`)
    // and missed two of the three alias families outright. The second
    // enumerated the exact substituted tokens — correct, but it taught the
    // model about Recued's PII substrate to get at a conclusion it should
    // reach anyway.
    //
    // One rule covers every case: the recipe exists to be RUN AGAIN, so
    // parameterise what varies. A recipient falls out of that exactly as a
    // folder or a date range does, with no notion of "sensitive" involved. A
    // model that cannot apply it will not produce a valid recipe anyway.
    expect(RECIPE_AUTHORING_SHAPE_BRIEF)
      .toContain('THE POINT OF A RECIPE IS TO BE RUN AGAIN');
    expect(RECIPE_AUTHORING_SHAPE_BRIEF).toContain('parameterise anything');
    expect(RECIPE_AUTHORING_SHAPE_BRIEF).toContain('{{config.');
    // ⛔ And no PII vocabulary reaches the model at all.
    const prompt = buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: '', vocabulary: 'OPS', recipes: [],
      aliasedRequest: 'email m1@d1.invalid about d2.invalid for pii.Person1',
    });
    expect(prompt.toLowerCase()).not.toContain('placeholder');
    expect(prompt.toLowerCase()).not.toContain('personal data');
    // The aliased request still reaches it verbatim — the model just reads it
    // as the request, which is all it needs.
    expect(prompt).toContain('email m1@d1.invalid about d2.invalid');
    // …and the RAW facets never do.
    expect(prompt).not.toContain(entry().request[0]!);
  });


  it('includes a recipe this flow actually ran, as a worked example', async () => {
    // A recipe the owner already has is the best possible example: real, valid,
    // and written in the exact vocabulary the model must produce.
    const prompt = buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: '', vocabulary: 'OPS', aliasedRequest: 'x',
      // ⚠ A REALISTIC shape json: `recipeShapeExample` emits `{steps}` only, so
      // the real path never carries the recipe's id inside the body either. The
      // old fixture hand-wrote the id into the json, which would have made the
      // egress assertion below unfalsifiable.
      recipes: [{ recipe_id: 'weekly-digest', json: '{"steps":[{"id":"step_1"}]}' }],
    });
    // ⛔ The example is NUMBERED, not named. The owner names recipes, so the id
    // is owner text and it used to go out verbatim in this header.
    expect(prompt).toContain('--- example 1 ---');
    expect(prompt).not.toContain('weekly-digest');
    expect(prompt).toContain('{"steps":[{"id":"step_1"}]}');
    // …and the section is absent entirely when the flow ran none.
    expect(buildRecipeDraftPrompt({
      entry: entry(), ownerPrompt: '', vocabulary: 'OPS', aliasedRequest: 'x', recipes: [],
    })).not.toContain('already ran');
  });

  it('survives a case with no flow and no owner instruction', async () => {
    const prompt = buildRecipeDraftPrompt({
      entry: { ...entry(), flows: [], request: [] },
      ownerPrompt: '   ',
      vocabulary: 'OPS',
      aliasedRequest: '',
      recipes: [],
    });
    expect(prompt).toContain('(not recorded)');
    expect(prompt).toContain('(no further instruction');
  });
});

describe('D-219 — what comes back from the model', () => {
  const good = {
    recipe_id: 'send-quarterly-report',
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Send the quarterly report',
      description: 'Drafted from a turn you confirmed.',
      author: 'local',
      supported_platforms: [],
    },
    variables: {},
    steps: [],
    output: { render: [] },
  };

  it('extracts JSON a model wrapped in prose and a fence', () => {
    expect(extractRecipeJson(
      `Sure! Here's the recipe:\n\`\`\`json\n{"a":1}\n\`\`\`\nHope that helps.`,
    )).toEqual({ a: 1 });
    expect(extractRecipeJson('no json here')).toBeNull();
    expect(extractRecipeJson('{ not valid }')).toBeNull();
  });

  it('validates through the REAL parser and returns the draft', async () => {
    // ⛔ The real `parseRecipe`, not a shape check here. A stub would let this
    // pass on a draft the Kitchen would then reject.
    const generate = vi.fn(async () => JSON.stringify(good));
    const result = await draftRecipeFromCase(
      { generate, parse: realParse },
      {
        entry: entry(), ownerPrompt: '', vocabulary: vocabulary(),
        aliasedRequest: 'do the thing', recipes: [],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.recipe.recipe_id).toBe('send-quarterly-report');
  });

  it('returns the validator\'s issues rather than throwing', async () => {
    // The owner asked for a recipe. "Here is what is wrong with what your model
    // wrote" is a better answer than a failure with nothing to look at.
    const result = await draftRecipeFromCase(
      {
        generate: async () => JSON.stringify({ recipe_id: 'x' }),
        parse: realParse,
      },
      {
        entry: entry(), ownerPrompt: '', vocabulary: vocabulary(),
        aliasedRequest: 'do the thing', recipes: [],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid_recipe');
    expect(result.ok === false && result.issues.length).toBeGreaterThan(0);
  });

  it('distinguishes "no JSON at all" from "JSON that is not a recipe"', async () => {
    const result = await draftRecipeFromCase(
      { generate: async () => 'I cannot help with that.', parse: realParse },
      {
        entry: entry(), ownerPrompt: '', vocabulary: vocabulary(),
        aliasedRequest: 'do the thing', recipes: [],
      },
    );
    expect(result.ok === false && result.reason).toBe('no_json');
  });

  it('⛔ NEVER saves — it returns a draft and nothing else', async () => {
    // The Kitchen is where a person decides. There is no store on the deps at
    // all, which is the structural version of this claim: this module could not
    // persist a recipe if it wanted to.
    const deps: RecipeDraftDeps = {
      generate: async () => JSON.stringify(good),
      parse: realParse,
    };
    expect(Object.keys(deps).sort()).toEqual(['generate', 'parse']);
    const result = await draftRecipeFromCase(
      deps,
      {
        entry: entry(), ownerPrompt: '', vocabulary: '',
        aliasedRequest: 'do the thing', recipes: [],
      },
    );
    expect(result.ok).toBe(true);
  });
});

describe('D-219 — the composed path, case id in and draft out', () => {
  const origin = {
    session_id: 's1',
    root_request: 'email Delphine the quarterly report',
    recipes: [{ recipe_id: 'weekly-digest', recipe_hash: 'hash-1' }],
  };
  const good = JSON.stringify({
    recipe_id: 'r', version: 1, ttl: 300,
    metadata: {
      name: 'R', description: 'd', author: 'local', supported_platforms: [],
    },
    variables: {}, steps: [], output: { render: [] },
  });

  const composed = (over: Partial<CaseRecipeDraftDeps> = {}) => {
    const generate = vi.fn(async (_prompt: string) => good);
    const deps: CaseRecipeDraftDeps = {
      generate,
      parse: realParse,
      loadEntry: async () => entry(),
      loadOrigin: async () => origin,
      aliasRequest: async () =>
        ({ prompt: 'email pii.Person1 the quarterly report', aliased: true }),
      loadRecipeShape: () => '{"steps":[{"id":"a","op":"core.mail.send"}]}',
      vocabulary: () => 'OPS',
      ...over,
    };
    return { deps, generate };
  };

  it('sends the ALIASED request and never the raw one', async () => {
    // ⛔ The whole PII position in one assertion: what reaches the model is what
    // the aliaser returned, and the owner's real words are absent.
    const { deps, generate } = composed();
    const out = await draftRecipeForCase(deps, { case_id: 'c', ownerPrompt: '' });
    expect(out.ok).toBe(true);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain('email pii.Person1 the quarterly report');
    expect(prompt).not.toContain('Delphine');
  });

  it('⛔ DROPS the request when aliasing could not be established', async () => {
    // Fail-closed, carried through the composition: `aliased: false` means we
    // could not tell which spans are personal, so the request is not sent at
    // all. The draft proceeds from the tool shape and the owner's instruction.
    const { deps, generate } = composed({
      aliasRequest: async () => ({ prompt: '', aliased: false }),
    });
    const out = await draftRecipeForCase(deps, { case_id: 'c', ownerPrompt: 'x' });
    expect(out.ok && out.request_aliased).toBe(false);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).not.toContain('Delphine');
    expect(prompt).toContain('(not recorded)');
    // …and the rest of the input is still there, so a failure degrades rather
    // than blocks.
    expect(prompt).toContain('file.search, mail.send');
  });

  it('drops the request when the case has no origin session either', async () => {
    const { deps, generate } = composed({ loadOrigin: async () => undefined });
    await draftRecipeForCase(deps, { case_id: 'c', ownerPrompt: '' });
    expect(generate.mock.calls[0]![0]).toContain('(not recorded)');
  });

  it('includes a recipe the flow ran, and skips one the owner no longer has', async () => {
    const { generate } = composed();
    await draftRecipeForCase(
      composed().deps, { case_id: 'c', ownerPrompt: '' },
    );
    const present = composed();
    await draftRecipeForCase(present.deps, { case_id: 'c', ownerPrompt: '' });
    const sent = present.generate.mock.calls[0]![0];
    expect(sent).toContain('--- example 1 ---');
    // Same egress guard on the composed path, where the id is read off a real
    // recipe reference rather than a fixture.
    expect(sent).not.toContain('weekly-digest');

    const gone = composed({ loadRecipeShape: () => undefined });
    await draftRecipeForCase(gone.deps, { case_id: 'c', ownerPrompt: '' });
    expect(gone.generate.mock.calls[0]![0]).not.toContain('weekly-digest');
    expect(generate).toBeDefined();
  });

  it('reports an unknown case without calling the model', async () => {
    const { deps, generate } = composed({ loadEntry: async () => undefined });
    const out = await draftRecipeForCase(deps, { case_id: 'nope', ownerPrompt: '' });
    expect(out).toEqual({ ok: false, reason: 'unknown_case', issues: [] });
    // ⛔ No model call, so an unknown id cannot spend the owner's quota.
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('D-219 — what the owner is told before it runs', () => {
  it('names the cost, the draft-ness, and the review — not just "please wait"', async () => {
    // ⛔ Three things are true and none are obvious from a button: it spends
    // model quota, it is slow, and what comes back is a FIRST attempt whose
    // review is the step that makes it safe. A confirmation that promised only
    // a delay would set the wrong expectation about the last two.
    //
    // Shipped from the server so a surface cannot quietly soften it — the same
    // reason the governance notice on a card is a constant rather than a
    // string each renderer writes.
    expect(RECIPE_DRAFT_CONFIRMATION).toContain('quota');
    expect(RECIPE_DRAFT_CONFIRMATION).toContain('slow');
    expect(RECIPE_DRAFT_CONFIRMATION).toContain('FIRST DRAFT');
    expect(RECIPE_DRAFT_CONFIRMATION).toContain('fill in the variables');
    // ⛔ And that nothing is saved without them, which is what makes the review
    // a real gate rather than a suggestion.
    expect(RECIPE_DRAFT_CONFIRMATION).toContain('Nothing is saved until you save');
  });
});

describe('D-219 — the rpc surface', () => {
  it('drafts through the wired dep and never saves', async () => {
    // ⛔ Drives the HANDLER, not the module underneath it. A call site is not a
    // wired seam: the composer could build a perfect draft path and never
    // reach it from the rpc.
    const draft = vi.fn(async (_input: { case_id: string; prompt: string }) => ({
      ok: true as const,
      recipe: { recipe_id: 'r' } as never,
      issues: [],
      request_aliased: true,
    }));
    const out = await handleExecutionCaseDraftRecipe(
      { executionCaseDraftRecipe: draft } as never,
      { case_id: 'case_one', prompt: 'every Monday' },
    );
    expect(draft.mock.calls[0]![0])
      .toEqual({ case_id: 'case_one', prompt: 'every Monday' });
    expect(out.ok).toBe(true);
    expect(out.request_aliased).toBe(true);
  });

  it('⚠ an unusable draft is an ANSWER, not an rpc failure', async () => {
    // The owner asked for a recipe. The validator's findings are a better
    // answer than a thrown error with nothing to look at — and the Kitchen can
    // show them. Only an UNWIRED surface throws.
    const out = await handleExecutionCaseDraftRecipe(
      {
        executionCaseDraftRecipe: async () => ({
          ok: false as const,
          reason: 'invalid_recipe' as const,
          issues: ['steps: required'],
        }),
      } as never,
      { case_id: 'c' },
    );
    expect(out).toEqual({
      ok: false, reason: 'invalid_recipe', issues: ['steps: required'],
    });
  });

  it('refuses a missing case_id, and an unwired surface', async () => {
    await expect(handleExecutionCaseDraftRecipe(
      { executionCaseDraftRecipe: async () => ({ ok: true } as never) } as never,
      { case_id: '  ' },
    )).rejects.toThrow(/case_id/u);
    await expect(handleExecutionCaseDraftRecipe({} as never, { case_id: 'c' }))
      .rejects.toThrow(/not wired/u);
  });

  it('⛔ is OFF the MCP surface — an agent cannot draft against the owner', async () => {
    // The `chat.execution.` reserved prefix carries it, so this asserts the
    // OUTCOME rather than restating the prefix list: an MCP agent authoring
    // recipes from the owner's own recorded turns is exactly the
    // channel-isolation invariant that prefix exists for.
    expect(MCP_TOOL_CATALOG as readonly string[])
      .not.toContain('chat.execution.draft_recipe');
    expect(MCP_RESERVED_RPC_PREFIXES.some((prefix) =>
      'chat.execution.draft_recipe'.startsWith(prefix))).toBe(true);
  });
});

describe('D-219 — a stored recipe is not safe to show a model verbatim', () => {
  it('⛔ strips literal argument VALUES, keeping the shape', async () => {
    // ⛔⛔ THE BIGGEST HOLE CODEX CONFIRMED. A RecipeDefinition may carry
    // arbitrary string defaults and literal step arguments, so a recipe the
    // owner edited to hard-code an address would put it in the prompt
    // UNALIASED — while the request beside it goes through the whole egress
    // boundary. This path went around it.
    //
    // ⚠ The fix is projection, not aliasing: the example teaches how steps are
    // COMPOSED, which is exactly the part with no values in it.
    const shape = recipeShapeExample({
      recipe_id: 'weekly-digest',
      metadata: { name: 'Weekly digest', description: 'to alice@acme.com' },
      variables: { who: { type: 'string', default: 'alice@acme.com' } },
      steps: [
        { id: 'find', op: 'core.mail.email.search', args: { slug: 'work', query: 'from:alice@acme.com' } },
        { id: 'send', op: 'core.mail.send', args: { to: 'alice@acme.com' } },
      ],
    })!;
    expect(shape).not.toContain('alice');
    expect(shape).not.toContain('acme');
    // …and the SHAPE survives: ops, step ids, and the argument KEYS, which are
    // what tell the model what an op takes.
    expect(shape).toContain('core.mail.email.search');
    expect(shape).toContain('"to"');
    expect(shape).toContain('"slug"');
    expect(JSON.parse(shape).steps[1].args.to).toBeNull();
  });

  it('returns nothing for a recipe with no steps to show', () => {
    expect(recipeShapeExample({ recipe_id: 'x', steps: [] })).toBeUndefined();
    expect(recipeShapeExample(null)).toBeUndefined();
    expect(recipeShapeExample('not a recipe')).toBeUndefined();
  });
});

describe('D-219 — a machine-written draft arrives INERT', () => {
  const armed = {
    recipe_id: 'r', version: 1, ttl: 300,
    metadata: { name: 'R', description: 'd', author: 'local', supported_platforms: [] },
    variables: {}, steps: [], output: { render: [] },
    auto_run: { interval_ms: 60_000 },
    event_triggers: [{ on: 'data.mail.**.created' }],
    // ⛔ EVERY executable top-level field, not just the two the old fixture had.
    // `trigger` and `on_failure` were MISSED by the denylist for exactly this
    // reason: the loop below cannot fail on a field the fixture never carries.
    trigger: ['https://example.invalid/hook'],
    on_failure: { recipe_id: 'installed-handler' },
    trigger_steps: [],
    webhook_triggers: [{ binding: 'b' }],
    webhook_requirements: [{ binding: 'b' }],
    vault_hints: { token: 'secret' },
  } as never;

  it('⛔ strips auto_run and triggers, and SAYS it did', async () => {
    // ⛔⛔ `auto_run` with no `trigger_steps` means ALWAYS FIRE, and the Kitchen
    // editor renders webhooks, event_triggers, prefetch steps and steps — but
    // NOT auto_run. So a draft carrying it shows a manual-looking recipe, saves
    // the whole object, and the scheduler arms it on the next refresh. A review
    // cannot refuse what it does not display.
    //
    // That is reachable by someone else's text: a case's request may quote a
    // forwarded mail or a pasted document.
    const result = stripDraftAutomation(armed);
    // ⛔ Asserted as an EXACT list, not a loop over the projector's own
    // vocabulary. The old test looped `AUTOMATION_FIELDS` and so passed
    // vacuously for `trigger` and `on_failure`, which it never put in the
    // fixture — that is how both survived a review that "checked the strip".
    expect(result.removed).toEqual([
      'auto_run', 'event_triggers', 'on_failure', 'trigger', 'trigger_steps',
      'vault_hints', 'webhook_requirements', 'webhook_triggers',
    ]);
    // ⚠ `on_failure` is the one with teeth: it fires ANOTHER installed recipe
    // when this one fails, and the Kitchen renders no section for it.
    expect(Object.hasOwn(result.recipe as object, 'on_failure')).toBe(false);
    expect(Object.hasOwn(result.recipe as object, 'trigger')).toBe(false);
    // …and the permitting witness: everything reviewable SURVIVES, or an
    // allowlist that dropped the recipe itself would pass the checks above.
    for (const field of ['recipe_id', 'version', 'ttl', 'metadata', 'variables',
      'steps', 'output']) {
      expect(Object.hasOwn(result.recipe as object, field)).toBe(true);
    }
  });

  it('⛔ drops a field NOBODY has listed — the allowlist is the point', async () => {
    // The whole reason for inverting: a field added to `RecipeDefinition` later
    // must be excluded by DEFAULT. A denylist admits every future field
    // silently, which is how `trigger` and `on_failure` got in.
    const withFuture = {
      ...(armed as Record<string, unknown>),
      some_future_executable_field: { fires: true },
    };
    const result = stripDraftAutomation(withFuture as never);
    expect(result.removed).toContain('some_future_executable_field');
    expect(Object.hasOwn(result.recipe as object, 'some_future_executable_field'))
      .toBe(false);
  });

  it('the allowlist covers every key the BRIEF asks the model for', async () => {
    // ⛔ Ties the projector to the prompt. If the brief gains a field and this
    // does not, the model is told to produce something that is then stripped
    // back out — a silent contradiction the owner would see as a bad draft.
    for (const field of RECIPE_DRAFT_FIELDS) {
      expect(DRAFT_ALLOWED_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('reports the removal to the owner through the draft issues', async () => {
    const { deps } = (() => {
      // ⚠ ONLY `auto_run`. Every other executable field the fixture carries
      // fails `parseRecipe` for its own reasons (a webhook trigger with no
      // requirement, an `on_failure` naming an uninstalled recipe), and an
      // invalid draft would mask the strip this test is about.
      const withAutoRun = { ...(armed as Record<string, unknown>) };
      for (const field of ['event_triggers', 'trigger', 'on_failure',
        'trigger_steps', 'webhook_triggers', 'webhook_requirements',
        'vault_hints']) delete withAutoRun[field];
      const generate = vi.fn(async (_p: string) => JSON.stringify(withAutoRun));
      return { deps: {
        generate, parse: realParse,
        loadEntry: async () => entry(),
        loadOrigin: async () => undefined,
        aliasRequest: async () => ({ prompt: '', aliased: false }),
        loadRecipeShape: () => undefined,
        vocabulary: () => 'OPS',
      } as CaseRecipeDraftDeps };
    })();
    const out = await draftRecipeForCase(deps, { case_id: 'c', ownerPrompt: '' });
    // ⚠ Deterministic on purpose: a branch-either-way assertion would pass
    // without ever reaching the strip.
    expect(out.ok).toBe(true);
    expect(out.ok && out.issues.join(' ')).toContain('arrives inert');
    expect(out.ok && Object.hasOwn(out.recipe as object, 'auto_run')).toBe(false);
  });

  it('leaves a draft with no automation untouched, and adds no note', async () => {
    // The permitting witness: without it this passes against a build that
    // announces a removal on every draft, training the owner to skip the line.
    const clean = { ...(armed as Record<string, unknown>) };
    for (const field of ['auto_run', 'event_triggers', 'trigger', 'on_failure',
      'trigger_steps', 'webhook_triggers', 'webhook_requirements',
      'vault_hints']) delete clean[field];
    const result = stripDraftAutomation(clean as never);
    expect(result.removed).toEqual([]);
  });
});

describe('D-219 — the shape projector emits no owner text', () => {
  it('⛔⛔ ORDINALISES step ids — they are owner text', async () => {
    // ⛔⛔ Nulling argument VALUES is not "shape only" while `id` survives: the
    // owner names steps, and on a REFINE pass they have just been editing this
    // recipe in the Kitchen. A Codex audit on 2026-07-29 found step ids going
    // out verbatim.
    //
    // ⚠ And ids are the ONLY leak here: `{{step.<id>.field}}` references live in
    // argument VALUES, which are already nulled, so no reference survives the
    // projection at all.
    const shape = recipeShapeExample({
      recipe_id: 'r',
      steps: [
        { id: 'find-alice-medical-results', op: 'core.contact.resolve',
          args: { alias: 'ALICE' } },
        { id: 'mail-it', op: 'core.mail.send',
          args: { to: '{{step.find-alice-medical-results.email}}' } },
      ],
    })!;
    expect(shape).not.toContain('find-alice-medical-results');
    expect(shape).not.toContain('mail-it');
    expect(shape).toContain('"id": "step_1"');
    expect(shape).toContain('"id": "step_2"');
    // ⚠ No reference of ANY form survives — the value carrying it is nulled.
    expect(shape).not.toContain('{{step.');
    // ⚠ Permitting witnesses: the ops and the arg KEYS still go, or the example
    // teaches the model nothing. Keys come from op schemas, not owner text.
    expect(shape).toContain('core.contact.resolve');
    expect(shape).toContain('"alias": null');
    expect(shape).toContain('"to": null');
    // …and no VALUE survives.
    expect(shape).not.toContain('ALICE');
  });

  it('ordinals are per-step and stable, even when one id prefixes another', async () => {
    const shape = recipeShapeExample({
      steps: [
        { id: 'send', op: 'core.mail.send', args: {} },
        { id: 'send-later', op: 'core.mail.send', args: { after: 'x' } },
      ],
    })!;
    expect(shape).toContain('"id": "step_1"');
    expect(shape).toContain('"id": "step_2"');
    expect(shape).not.toContain('send-later');
    expect(shape).not.toContain('"id": "send"');
  });
});
