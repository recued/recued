/** D-219 item 2b — a learned case becomes a DRAFT recipe, authored by the
 *  owner's own model.
 *
 *  The pipeline is the owner's: **authoring brief + the case's steps + the
 *  owner's prompt → the owner's LLM → recipe JSON → the Kitchen → validate and
 *  save.** Nothing here saves anything; the Kitchen is where a person decides.
 *
 *  ⛔ **THIS IS AUTHORING, NOT TRANSLATION, AND THE DIFFERENCE IS THE WHOLE
 *  DESIGN.** An audit of all eleven Tier-1 chat tools found none of them is a
 *  wrapper over a kernel op: `mail.search` fans out across every mail collection
 *  behind a read-grant fence and takes no `slug`, while `core.mail.email.search`
 *  takes exactly one `slug`. There is no mapping to compile, and a table that
 *  pretended otherwise would silently drop a fence or narrow a fan-out at
 *  `success: true`.
 *
 *  A model authoring against the live op vocabulary has no such problem — it
 *  picks ops that achieve the OUTCOME — but it inherits the same hazard if the
 *  prompt lets it believe the recorded tool names are steps. Hence the framing
 *  below: the sequence is presented as EVIDENCE OF WHAT HAPPENED, never as a
 *  spec, and the vocabulary it may draw from is stated separately and derived
 *  from what this server actually has.
 *
 *  ⚠ And it is why the Kitchen review is load-bearing rather than ceremony: the
 *  authored recipe is genuinely a DIFFERENT artifact from the turn it was
 *  learned from, not a replay of it.
 */

import {
  KERNEL_OP_REGISTRY,
  RECIPE_DRAFT_CONFIRMATION,
  type ExecutionCaseLearnedEntry,
  type IngredientManifest,
  type RecipeDefinition,
} from '@recued/contracts';

/** The `ai-generate` shape, so a draft routes through the SAME adapters, quota
 *  and slot resolution as every other AI call the owner pays for. Nothing here
 *  is recipe-specific except the template label: authoring is one long
 *  text-in / text-out call. */
export { RECIPE_DRAFT_CONFIRMATION };

/** ⛔ `ai-extract`, NOT `ai-generate`, and the difference is load-bearing.
 *
 *  `ai-generate` contracts `{ "content": "<text>" }` and its validator rejects
 *  anything else. A recipe is a large JSON DOCUMENT, so that shape forces the
 *  model to JSON-encode a whole document as a string INSIDE json — and it
 *  complies unreliably: live runs on 2026-07-29 failed
 *  `AI_OUTPUT_INVALID — provider returned invalid JSON for the contracted
 *  schema` on 2 of 4 attempts, each after a full 70–120s call the owner paid
 *  for. Instructing it harder is not a fix; the shape is simply wrong for the
 *  payload.
 *
 *  `ai-extract` is the one contract whose validator accepts ANY object
 *  (`parse.ts` — "any shape — fields come from input, not fixed"), and its
 *  system prompt states the object's keys. That matches what this call
 *  actually is: the recipe IS the object, and the REAL validator is
 *  `parseRecipe` downstream — which is what the design intended all along.
 *
 *  ⚠ Same adapters, quota and slot resolution either way; only the output
 *  contract changes. */
export const RECIPE_DRAFT_MANIFEST: IngredientManifest = {
  slug: 'ai-extract',
  name: 'AI Field Extractor',
  description: 'Extracts requested structured fields from the input data.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'extraction'],
  input: {
    'llm.data': null,
    'llm.fields': null,
  },
  output: { extracted: 'dynamic_fields_per_llm_fields_input' },
} as IngredientManifest;

/** The recipe's top-level keys, handed to `ai-extract` as `llm.fields` so its
 *  system prompt names the object the model must return. ⛔ Keep in step with
 *  the Shape block in the brief — they describe the same object and the model
 *  is shown both. */
export const RECIPE_DRAFT_FIELDS = [
  'recipe_id', 'version', 'ttl', 'metadata', 'variables', 'steps', 'output',
] as const;

/** Bounded so one authoring call cannot become an unbounded prompt. The op
 *  vocabulary is the large part and it grows with every kernel op added. */
export const RECIPE_DRAFT_MAX_OPS = 200;
export const RECIPE_DRAFT_MAX_OP_SUMMARY = 160;
/** ⚠ The owner's instruction is the ONE unbounded string a caller controls, and
 *  it is neither aliased nor length-checked upstream. It is not aliased on
 *  purpose — it is typed deliberately into an authoring box, and aliasing "the
 *  finance folder" would make it useless — but unbounded it is a prompt-size and
 *  cost lever reachable from any paired client, not just the panel. */
export const RECIPE_DRAFT_MAX_INSTRUCTION = 2_000;
/** Per recipe example, after shape projection. A pathological recipe should not
 *  be able to crowd out the brief. */
export const RECIPE_DRAFT_MAX_EXAMPLE_BYTES = 4_000;

/** ⛔ Hand-written, and deliberately about SHAPE only.
 *
 *  Everything that is a VOCABULARY — which ops exist, what they take — is
 *  derived from the live registries instead, because a hand-copied vocabulary
 *  rots against the thing it describes and this codebase has paid for that
 *  repeatedly. What cannot be derived is how a recipe is put together, so that
 *  is what this says, and nothing else. */
export const RECIPE_AUTHORING_SHAPE_BRIEF = [
  // ⛔ THE OUTPUT INSTRUCTION MUST AGREE WITH `RECIPE_DRAFT_MANIFEST`. This
  // rode `ai-generate` once, whose contract is `{"content": "<text>"}` — two
  // contradictory instructions in one prompt, and live drafts died at
  // `AI_OUTPUT_INVALID` on half of all attempts after a full 70–120s call.
  // The manifest is now `ai-extract` (any-shape validator), so the recipe
  // object itself is the answer. Read the manifest's comment before changing
  // either — they are one decision in two files.
  'You are writing ONE Recued recipe as JSON.',
  'Return the recipe object itself as your entire answer.',
  '',
  '⛔ THE POINT OF A RECIPE IS TO BE RUN AGAIN. It is not a transcript of what',
  'happened once; it is the reusable version of it. So parameterise anything',
  'the owner would reasonably need to change between runs — a recipient, a',
  'folder, a search term, a date range, a threshold — and leave literal only',
  'what is genuinely fixed for every run.',
  '',
  'Shape:',
  '{',
  '  "recipe_id": "kebab-case-id",',
  '  "version": 1,',
  '  "ttl": 300,',
  // ⚠ `tags` is in the shape because the validator asks for it and the model
  // writes exactly what this block shows — omit it here and every draft comes
  // back carrying a `tags_missing` warning the owner then has to clear by hand.
  '  "metadata": { "name": "...", "description": "...", "author": "local",',
  '                "tags": ["<domain>", "<function>", "<entity>"],',
  '                "supported_platforms": [] },',
  // ⚠ `label` + `type` are both MANDATORY on the object form since D-222 —
  // an object variable missing either refuses install as
  // `variable_hint_invalid`, and the label is additionally what marks the
  // variable as one the owner is ASKED for at invocation (a bare default means
  // "tuning constant, do not ask"). Every parameter this brief tells the model
  // to extract is an input, so every one of them is labeled.
  //
  // ⛔ This block said `"required": true` until 2026-07-30. `required` is NOT a
  // ValueHint member — `optional` is, and its absence already means required.
  // Nothing reads `required`, and `validateValueHint` had no unknown-key fence,
  // so it validated clean and did nothing: 1,968 dead occurrences across 1,133
  // shipped recipes, which this brief was the active source of. Omit the field
  // for a required variable; write `"optional": true` for a skippable one.
  '  "variables": { "<name>": { "type": "string", "label": "..." } },',
  '  "steps": [ { "id": "step_id", "op": "<op id>", "args": { ... } } ],',
  '  "output": { "render": [] }',
  '}',
  '',
  'Rules:',
  '- Steps run IN ORDER. A later step reads an earlier one as',
  '  "{{step.<earlier_id>.<field>}}".',
  '- Every parameter is a VARIABLE, referenced as "{{config.<name>}}".',
  '  ⛔ Never carry a specific value across from the one run you were shown.',
  '  It happened once; that does not make it the owner\'s standing choice.',
  '- Use ONLY op ids from the list below. Do not invent one, and do not use a',
  '  chat tool name as an op.',
  '- Prefer the fewest steps that achieve the outcome.',
  // ⚠ Violated live on the first REVISION (2026-07-29): dropping the email step
  // left `{{config.calendar_slug}}` referenced with no declaration, and the
  // validator rejected the whole revision. The general "every parameter is a
  // variable" rule above does not say the two blocks must AGREE, and a revision
  // is exactly where they drift.
  '- Every "{{config.<name>}}" you reference MUST be declared in "variables",',
  '  and every declared variable must be referenced. When revising, add or',
  '  remove declarations to match the steps you changed.',
  // ⚠ The shape block shows `"render": []` and said nothing more, so the model
  // filled it with strings and the validator rejected the draft outright
  // (`output.render[0]: output section must be an object`) after a 98s call.
  // Leaving it empty is also the honest default: how a result is DISPLAYED is
  // a presentation choice the owner makes in the Kitchen, not something to
  // infer from one past turn.
  '- Leave "output": { "render": [] } EMPTY. Do not put strings in it.',
  '- A variable is required by default. Add "optional": true to make one',
  '  skippable. There is no "required" field — do not write one.',
  // ⚠ D-221 Records. The op list below carries arg KEYS with values nulled, so a
  // model sees `expected_version: null` and nothing that says what belongs
  // there. Reading only the schema, the obvious move is to echo the row's own
  // `_record.version` — which is WRONG in a way nothing catches: the store's
  // check is three-way (row version AND the namespace's ready version), so an
  // echo agrees with itself and cannot catch the case the assertion exists for,
  // a queued v1 run waking after a v2 upgrade. This is judgment a schema cannot
  // carry, which is exactly the category this brief owns. (The author of THIS
  // comment made the same mistake from the same information.)
  '- If an op takes "expected_version" and "expected_revision" (a Records',
  '  write), pass "expected_revision" from the record you just read',
  '  ("{{step.<read>.record._record.revision}}") but write "expected_version"',
  '  as the LITERAL pack version the op belongs to. Never echo',
  '  "_record.version" into it — an echo always agrees with itself and proves',
  '  nothing.',
  '- If an op accepts an "id" you may supply, derive it deterministically from',
  '  the inputs so a re-run is a replay rather than a duplicate. A generated id',
  '  is not replay-safe.',
].join('\n');

const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const stop = flat.search(/\.\s/u);
  const cut = stop > 0 ? flat.slice(0, stop + 1) : flat;
  return cut.length > RECIPE_DRAFT_MAX_OP_SUMMARY
    ? `${cut.slice(0, RECIPE_DRAFT_MAX_OP_SUMMARY - 1)}…`
    : cut;
};

/** ⛔ DERIVED, never a list. The ops a server has are a fact about that server —
 *  its kernel registry plus whatever packs the owner installed — and a model
 *  told about an op that is not there authors a recipe that cannot run. The
 *  input keys come from the same manifest the dispatcher reads, so the argument
 *  names cannot drift from what the op accepts. */
export const buildRecipeAuthoringVocabulary = (
  manifests: readonly IngredientManifest[],
  ops: readonly { op: string; backing_slug?: string; risk: string }[] =
    KERNEL_OP_REGISTRY,
): string => {
  const bySlug = new Map(manifests.map((manifest) => [manifest.slug, manifest]));
  const lines: string[] = [];
  for (const entry of ops) {
    if (lines.length >= RECIPE_DRAFT_MAX_OPS) break;
    // A native op has no backing ingredient and is not recipe-runnable, so
    // offering it would be offering something the engine cannot lower.
    if (!entry.backing_slug) continue;
    const manifest = bySlug.get(entry.backing_slug);
    if (!manifest) continue;
    const args = Object.keys(manifest.input ?? {}).join(', ');
    lines.push(
      `- ${entry.op} (${entry.risk})`
      + `${args ? ` args: ${args}` : ''}`
      + ` — ${firstSentence(manifest.description ?? '')}`,
    );
  }
  return lines.join('\n');
};

/** ⛔ THE FRAMING IS THE SAFETY PROPERTY.
 *
 *  `tool_sequence` holds CHAT TOOL names. A model that reads them as step names
 *  will either emit JSON `parseRecipe` rejects — harmless — or reach for the op
 *  whose name looks closest, which is the failure that does not announce
 *  itself: `mail.search` is a fenced fan-out over every mailbox and
 *  `core.mail.email.search` is one mailbox by slug, so the "obvious" mapping
 *  silently narrows the work and drops a read fence.
 *
 *  So the sequence is labelled as evidence and the instruction is explicit
 *  about what it is not. */
export interface RecipeDraftPromptInput {
  entry: ExecutionCaseLearnedEntry;
  /** ⛔ The ALIASED request, never `request_shape.intent_facets`. The facets are
   *  normalized derivatives of the RAW prompt and carry names verbatim — the
   *  D-167 egress test proves it (`email delphine rowntree` →
   *  `email cap_pii.Person1`). An empty string is the fail-closed outcome from
   *  `aliasCasePromptForAuthoring`; the draft then proceeds from shape alone. */
  aliasedRequest: string;
  /** The SHAPE of any recipe this flow ran — step ids and ops, with every
   *  literal argument value stripped. See {@link recipeShapeExample}. */
  recipes: ReadonlyArray<{ recipe_id: string; json: string }>;
  ownerPrompt: string;
  vocabulary: string;
  /** D-219 — the draft being REFINED, as the owner currently has it in the
   *  Kitchen (their hand edits included), for a second pass.
   *
   *  ⛔ SHAPE-STRIPPED like `recipes`, and for the same reason: by the time the
   *  owner refines, they may have typed a real address or folder into an arg,
   *  and sending it back would egress a literal the first pass was careful to
   *  keep out. The model needs the STRUCTURE it produced, not their data. */
  previousDraft?: string;
}

export const buildRecipeDraftPrompt = (
  input: RecipeDraftPromptInput,
): string => {
  const flow = input.entry.flows[0];
  return [
    RECIPE_AUTHORING_SHAPE_BRIEF,
    '',
    'Available ops:',
    input.vocabulary,
    ...(input.recipes.length > 0
      ? [
          '',
          'The SHAPE of a recipe this flow ran. Argument values are removed —'
          + ' this shows you how steps are composed, not what to put in them:',
          // ⛔ The recipe's ID is NOT sent. The owner names recipes, so
          // `email-alice-medical-results` is owner text and a name adds nothing
          // the shape does not already say. Numbered instead, which is all a
          // second example needs to be told apart from the first.
          ...input.recipes.map((recipe, index) =>
            `--- example ${index + 1} ---\n${recipe.json}`),
        ]
      : []),
    '',
    // ⛔ NEUTRAL FRAMING, DELIBERATELY. This said "as EVIDENCE of the outcome
    // they wanted" — but a case is admitted on ANY owner-typed verdict, so the
    // flow shown here is as likely to be one the owner REJECTED. Asserting it
    // was wanted, and then instructing "achieve the same OUTCOME", told the
    // model to reproduce the route that failed. That is precisely the hazard
    // `d-219-execution-case-precedent.test.ts` calls THE SAFETY PROPERTY — "the
    // substrate teaching back the mistake it recorded" — reintroduced one layer
    // down. The verdict line was always present; the header talked over it.
    'What happened once, and how it turned out:',
    `- they asked for: ${input.aliasedRequest || '(not recorded)'}`,
    ...(flow
      ? [
          // ⛔ "involved", NOT "then". This line used to join the steps with
          // ' then ', which asserted an execution order the substrate never
          // observed — steps batched into one round were ordered by an
          // `activity_id` tie-break — and a recipe drafted from an invented
          // order encodes a step dependency the run never had, in an artifact
          // the owner keeps. The ops are the durable fact; the order is for the
          // authoring model to derive from the request.
          `- Recued's answer involved these ops: ${
            flow.tools_that_may_be_needed.join(', ')}`,
          '  (listed, not sequenced — the order they ran in was not recorded)',
          `- afterwards: ${flow.outcome.join(' ')}`,
        ]
      : []),
    '',
    // ⛔ The model has the verdict in front of it, so it does not need the
    // server to classify polarity — it needs to be told the request is the
    // goal and the route is only evidence. Covers correction / undo / failed
    // check as well as outright rejection.
    '⛔ THE REQUEST IS THE GOAL — NOT THE ROUTE. If "afterwards" says the owner'
    + ' rejected, corrected or undid that result, or that a check found it had'
    + ' not worked, then that route is what NOT to repeat: write the recipe that'
    + ' achieves what they ASKED for, and do not reproduce the steps that'
    + ' failed. The route is only EVIDENCE; it is worth following only when the'
    + ' outcome was positive.',
    '',
    '⛔ Those are CHAT TOOL names, not op ids, and they are NOT the steps to'
    + ' write. They tell you what the owner was trying to achieve. Choose ops'
    + ' from the list above that achieve what the REQUEST asked for — the op'
    + ' that merely looks similarly named is often a narrower operation.',
    '',
    // ⛔ A REFINEMENT PASS IS A REVISION, NOT A FRESH ATTEMPT. Without this the
    // second call re-derives from the same evidence and the owner's correction
    // reads as a brand-new brief — they lose the structure they were happy with
    // and get a different recipe to review from scratch.
    ...(input.previousDraft !== undefined
      ? [
          'You already wrote this draft, and the owner is asking you to REVISE'
          + ' it. Argument values are stripped — keep the steps that are right,'
          + ' change what the instruction below asks for, and do not start over:',
          input.previousDraft,
          '',
        ]
      : []),
    // ⛔ LAST, and it OUTRANKS the recorded turn. The owner typed this after
    // reading the outcome above, so where the two disagree they are the later
    // and better-informed source — most obviously when the turn was rejected
    // and this says what should have happened instead.
    'What the owner wants this recipe to do — this OVERRIDES the recorded turn'
    + ' wherever the two disagree:',
    input.ownerPrompt.trim().slice(0, RECIPE_DRAFT_MAX_INSTRUCTION)
      || '(no further instruction — follow the request above)',
  ].join('\n');
};

/** ⛔ A STORED RECIPE IS NOT SAFE TO SHOW A MODEL VERBATIM.
 *
 *  Sending one raw was the largest hole in the first version of this feature: a
 *  `RecipeDefinition` may carry arbitrary string defaults and literal step
 *  arguments, so a recipe the owner edited to hard-code `alice@acme.com` would
 *  put that address in the prompt UNALIASED — the request beside it goes through
 *  the whole egress boundary, and this went around it.
 *
 *  ⚠ The fix is not to alias it. The example exists to teach how steps are
 *  COMPOSED, which is exactly the part with no values in it, so projecting to
 *  shape removes the exposure at the root rather than masking it — and it is the
 *  same "shape, not values" rule the rest of this module is built on.
 *
 *  Argument KEYS are kept: they tell the model what an op takes. Values become
 *  `null`, whatever they were. */
export const recipeShapeExample = (recipe: unknown): string | undefined => {
  if (recipe === null || typeof recipe !== 'object') return undefined;
  const row = recipe as Record<string, unknown>;
  // ⛔⛔ STEP IDS ARE OWNER TEXT, AND THEY USED TO GO OUT VERBATIM. A Codex audit
  // on 2026-07-29 found it: nulling every argument VALUE is not "shape only"
  // while `id` survives, because the owner names steps — and on a REFINE pass
  // they have just been editing this recipe in the Kitchen, so a step called
  // `email-alice-medical-results` egresses intact.
  //
  // Replaced with ordinals. ⚠ And that is the WHOLE leak: `{{step.<id>.field}}`
  // references live in argument VALUES, which are already nulled, so no
  // reference ever survives this projection — the example shows ids, ops and
  // arg keys and no wiring at all. (An earlier version of this fix rewrote
  // references too; that was dead code against a body with none.)
  const ids = new Map<string, string>();
  const steps = Array.isArray(row.steps) ? row.steps : [];
  let ordinal = 0;
  for (const value of steps) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' && !ids.has(id)) {
      ordinal += 1;
      ids.set(id, `step_${ordinal}`);
    }
  }
  const step = (value: unknown): Record<string, unknown> | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const entry = value as Record<string, unknown>;
    const args = entry.args;
    return {
      ...(typeof entry.id === 'string'
        ? { id: ids.get(entry.id) ?? 'step' }
        : {}),
      ...(typeof entry.op === 'string' ? { op: entry.op } : {}),
      ...(typeof entry.ingredient === 'string'
        ? { ingredient: entry.ingredient }
        : {}),
      // ⚠ Argument KEYS are kept, and that is deliberate: they come from the
      // OP's schema, not from anything the owner typed, and they are what tell
      // the model which slots an op has. Values are always null.
      ...(args !== null && typeof args === 'object' && !Array.isArray(args)
        ? {
            args: Object.fromEntries(
              Object.keys(args as Record<string, unknown>)
                .map((key) => [key, null]),
            ),
          }
        : {}),
    };
  };
  const projected = steps.flatMap((value) => {
    const one = step(value);
    return one ? [one] : [];
  });
  if (projected.length === 0) return undefined;
  return JSON.stringify({ steps: projected }, null, 2);
};

/** ⛔ A MACHINE-WRITTEN DRAFT ARRIVES INERT.
 *
 *  `auto_run` with no `trigger_steps` means "always fire" — and the Kitchen
 *  editor renders webhooks, `event_triggers`, prefetch steps and ordinary steps,
 *  but NOT `auto_run`. So a draft carrying it shows the owner a manual-looking
 *  recipe, saves the whole object, and the scheduler arms it on the next
 *  refresh. The review that is supposed to make this feature safe cannot refuse
 *  what it does not display.
 *
 *  That matters most because a case's request is not necessarily the owner's own
 *  words — it may quote a forwarded mail or a pasted document — so the authoring
 *  prompt is reachable by someone else's text. Arming is therefore never
 *  inherited from a draft; the owner adds it deliberately in the editor, where
 *  the control is visible.
 *
 *  ⏭ The renderer's blind spot is its own defect and is NOT fixed here: any
 *  hand-authored recipe with `auto_run` is equally invisible. Stripping at this
 *  seam removes the path this feature opened, not the underlying gap. */
/** ⛔⛔ AN ALLOWLIST, NOT A DENYLIST — and that inversion IS the fix.
 *
 *  This was `AUTOMATION_FIELDS = [auto_run, trigger_steps, event_triggers,
 *  webhook_triggers]`, and a Codex audit on 2026-07-29 found it MISSING two
 *  executable fields that exist on `RecipeDefinition`: `trigger` (URL
 *  triggering) and `on_failure` (binds ANOTHER installed recipe to fire when
 *  this one fails). The Kitchen renders neither, so a prompt-injected
 *  `on_failure` was invisible to the review and persisted on save.
 *
 *  ⚠ The old test could not catch it: it looped `for (const field of
 *  AUTOMATION_FIELDS) expect(!hasOwn(recipe, field))`, which passes VACUOUSLY
 *  for any field the fixture happens not to carry. A denylist iterated by its
 *  own test agrees with itself.
 *
 *  So the projector now keeps EXACTLY what the authoring brief asks the model
 *  for and drops everything else, which means a field added to
 *  `RecipeDefinition` later is excluded by DEFAULT rather than silently
 *  admitted. Every drop is reported to the owner through the draft issues.
 *
 *  ⛔ Keep in step with `RECIPE_DRAFT_FIELDS` and the Shape block in the brief —
 *  a test asserts this covers every key the brief declares. */
export const DRAFT_ALLOWED_FIELDS = [
  'recipe_id',
  'version',
  'ttl',
  'metadata',
  'variables',
  // ⚠ Not in `RECIPE_DRAFT_FIELDS` (the model is not asked for it) but kept
  // because the editor NORMALISES it in, so a round-trip through the Kitchen
  // must not report it as a removal.
  'prefetch_steps',
  'steps',
  'output',
] as const;

export const stripDraftAutomation = (
  recipe: RecipeDefinition,
): { recipe: RecipeDefinition; removed: string[] } => {
  const row = { ...recipe } as Record<string, unknown>;
  const allowed = new Set<string>(DRAFT_ALLOWED_FIELDS);
  const removed = Object.keys(row).filter((field) =>
    !allowed.has(field) && row[field] !== undefined);
  for (const field of removed) delete row[field];
  // Sorted so the owner-facing note is stable regardless of key order in what
  // the model returned.
  removed.sort();
  return { recipe: row as unknown as RecipeDefinition, removed };
};

/** Models wrap JSON in prose, fences, or both. Extract the outermost object
 *  rather than trusting the whole response to parse. */
export const extractRecipeJson = (text: string): unknown | null => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
};

export type RecipeDraftResult =
  | { ok: true; recipe: RecipeDefinition; issues: string[] }
  | { ok: false; reason: 'no_json' | 'invalid_recipe'; issues: string[] };

export interface RecipeDraftDeps {
  /** The owner's model — the same `executeLLM` seam the AI producers use, so a
   *  draft costs whatever the owner's free-pool / BYOK routing costs. */
  generate(prompt: string): Promise<string>;
  /** `parseRecipe`, injected so this module does not reach into the recipe
   *  package and so a test cannot accidentally assert against a stub of the
   *  validator that decides the thing under test. */
  parse(value: unknown): {
    ok: boolean;
    recipe?: RecipeDefinition;
    issues: ReadonlyArray<{ path?: string; message: string; severity: string }>;
  };
}

/** ⛔ NEVER SAVES, and returns the draft rather than an id for that reason. The
 *  owner reviews it in the Kitchen, where validating and saving are exactly the
 *  manual authoring path — no separate blessing for a machine-written recipe. */
export const draftRecipeFromCase = async (
  deps: RecipeDraftDeps,
  input: RecipeDraftPromptInput,
): Promise<RecipeDraftResult> => {
  const text = await deps.generate(buildRecipeDraftPrompt(input));
  const value = extractRecipeJson(text);
  if (value === null) return { ok: false, reason: 'no_json', issues: [] };
  const parsed = deps.parse(value);
  // ⛔ ERRORS FIRST. `parseRecipe` returns warnings and errors in ONE list, and
  // only errors decide `ok` — so the first entry of the raw list is routinely a
  // harmless advisory. The panel shows `issues[0]`, which meant a live draft
  // that failed on a real error was reported to the owner as
  // "not a valid recipe: metadata.tags: tags not set — add for marketplace
  // discovery": a WARNING, presented as the reason, with the actual blocker
  // nowhere on screen. Seen 2026-07-29. Stable sort, so ordering within a
  // severity is untouched and the full list still travels.
  const severityRank = (severity: string): number =>
    severity === 'error' ? 0 : severity === 'warn' ? 1 : 2;
  const issues = [...parsed.issues]
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) =>
      severityRank(a.issue.severity) - severityRank(b.issue.severity)
      || a.index - b.index)
    .map(({ issue }) =>
      issue.path ? `${issue.path}: ${issue.message}` : issue.message);
  // ⚠ The REAL validator decides, not a shape check here. A draft that fails it
  // is returned as issues rather than as a thrown error: the owner asked for a
  // recipe, and "here is what is wrong with what your model wrote" is a better
  // answer than a failure with nothing to look at.
  if (!parsed.ok || !parsed.recipe) {
    return { ok: false, reason: 'invalid_recipe', issues };
  }
  return { ok: true, recipe: parsed.recipe, issues };
};

// ════════════════════════════════════════════════════════════════
// The composed path — case id in, draft out
// ════════════════════════════════════════════════════════════════

export interface CaseRecipeDraftDeps extends RecipeDraftDeps {
  /** The learned case, as the OWNER sees it — the same projection the panel
   *  lists, so what they pressed the button on is what the model receives. */
  loadEntry(case_id: string): Promise<ExecutionCaseLearnedEntry | undefined>;
  /** The case's own session and raw request, off its source observations. This
   *  is `session_id`'s FIRST consumer: slice 5 recorded it (V14) and the spec
   *  noted "nothing reads it yet". */
  loadOrigin(case_id: string): Promise<{
    session_id: string;
    root_request: string;
    recipes: ReadonlyArray<{ recipe_id: string; recipe_hash: string }>;
  } | undefined>;
  /** ⛔ Returns `aliased: false` when it could not establish which spans are
   *  personal, and the request is then DROPPED rather than sent raw. */
  aliasRequest(input: { session_id: string; prompt: string }): Promise<{
    prompt: string;
    aliased: boolean;
  }>;
  /** The SHAPE of a recipe the flow ran — values stripped — and only when the
   *  stored recipe still hashes to what ran. */
  loadRecipeShape(
    ref: { recipe_id: string; recipe_hash: string },
  ): string | undefined;
  vocabulary(): string;
}

export type CaseRecipeDraftOutcome =
  | { ok: true; recipe: RecipeDefinition; issues: string[]; request_aliased: boolean }
  /** ⛔ `already_running` is NOT a bad draft, and separating it is the whole
   *  point of the member. It reported as `invalid_recipe` until a live run on
   *  2026-07-29, so the owner pressing twice was told "Your AI's draft was not
   *  a valid recipe" — blaming the model for a concurrency guard and implying
   *  the fix was a clearer instruction, when the fix is to wait. */
  | {
      ok: false;
      reason: 'unknown_case' | 'no_json' | 'invalid_recipe' | 'already_running';
      issues: string[];
    };

/** ⛔ MANUAL, and that is the contract with the owner: nothing here runs unless
 *  they press. No turn, no schedule and no housekeeping cycle reaches this — a
 *  model call against their quota, on their own recorded words, is theirs to
 *  initiate. */
export const draftRecipeForCase = async (
  deps: CaseRecipeDraftDeps,
  input: {
    case_id: string;
    ownerPrompt: string;
    /** The draft the owner is refining, verbatim from their editor. Stripped to
     *  shape here — never sent as given. */
    previousRecipe?: unknown;
  },
): Promise<CaseRecipeDraftOutcome> => {
  const entry = await deps.loadEntry(input.case_id);
  if (!entry) return { ok: false, reason: 'unknown_case', issues: [] };
  const origin = await deps.loadOrigin(input.case_id);
  const aliased = origin
    ? await deps.aliasRequest({
        session_id: origin.session_id,
        prompt: origin.root_request,
      })
    // No origin means no session to establish the aliasing against. Same
    // direction as a failed harvest: draft from shape, never from raw text.
    : { prompt: '', aliased: false };
  const recipes = (origin?.recipes ?? []).flatMap((ref) => {
    // ⛔ SHAPE ONLY, and only when it is still the recipe that RAN. `loadRecipe`
    // resolves by id, and a recipe the owner has since edited is a different
    // thing under the same name — presenting v2 as "what this flow ran" is a
    // false statement to the model as well as a fresh egress surface.
    const json = deps.loadRecipeShape(ref);
    return json && json.length <= RECIPE_DRAFT_MAX_EXAMPLE_BYTES
      ? [{ recipe_id: ref.recipe_id, json }]
      : [];
  });
  const result = await draftRecipeFromCase(deps, {
    entry,
    aliasedRequest: aliased.prompt,
    recipes,
    ownerPrompt: input.ownerPrompt,
    // ⛔ Through the SAME stripper as the worked example. The owner may have
    // typed a real address into an arg before pressing refine; the model needs
    // the structure back, not their data.
    ...(input.previousRecipe !== undefined
      ? (() => {
          const shape = recipeShapeExample(input.previousRecipe);
          return shape !== undefined
            && shape.length <= RECIPE_DRAFT_MAX_EXAMPLE_BYTES
            ? { previousDraft: shape }
            : {};
        })()
      : {}),
    vocabulary: deps.vocabulary(),
  });
  if (!result.ok) return result;
  // ⛔ Arming is never inherited from a machine-written draft.
  const stripped = stripDraftAutomation(result.recipe);
  return {
    ...result,
    recipe: stripped.recipe,
    issues: stripped.removed.length > 0
      ? [
          ...result.issues,
          `Removed ${stripped.removed.join(', ')} — a drafted recipe arrives`
          + ' inert. Add scheduling or triggers yourself once you have read it.',
        ]
      : result.issues,
    request_aliased: aliased.aliased,
  };
};
