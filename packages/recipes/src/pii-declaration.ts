/** `no_hash_before_ai` — an AI recipe that declares no PII handling at all. One
 *  definition for the validator (`validate/quality.ts`) and the quality precheck, so
 *  the two cannot drift. The validator's reaches authors: the Kitchen editor
 *  (`recipe.validate` returns every finding) and a drafted recipe's issue list.
 *  ⚠ Not a model: `recued_saveRecipe` returns only errors, plus the PII posture from
 *  `validateRecipePii` (this line said otherwise until 2026-10-06).
 *
 *  ⛔ It used to count only `hash_replace` and the step-level `pii_fields` list, and
 *  told authors to add one of those. Both replace a value WHOLE with an opaque token,
 *  so free text named there reaches the model unreadable (decisions-log, the D-167
 *  amendments of 2026-10-06), and a recipe protected by `llm.pii_fields` or a
 *  `pii-protect` bracket was still told it had nothing. The code keeps its name: it is
 *  a stable identifier, and the message is what teaches. */

type Step = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Any form a step can declare PII handling in: a `pii-protect` bracket, an
 *  `llm.pii_fields` map (an ingredient step's `input` or an op-step's `args`), the
 *  step-level `pii_fields` list, or a `hash_replace` transform. */
export const declaresPiiHandling = (steps: readonly Step[]): boolean =>
  steps.some((step) =>
    step.transform === 'pii-protect'
    || step.transform === 'hash_replace'
    || (Array.isArray(step.pii_fields) && step.pii_fields.length > 0)
    || [step.input, step.args].some((payload) => isRecord(payload) && payload['llm.pii_fields'] != null));

export const NO_PII_DECLARATION_DETAIL =
  'recipe has AI steps but declares no PII handling — if they receive personal data, tag it in the '
  + "AI step's llm.pii_fields (an identifier kind for names and emails, content for free text), or "
  + 'bracket it with pii-protect / pii-restore where llm.pii_fields does not reach (ai-prompt, '
  + 'ai-compare); on a server, auto-PII adds tags only for the fields it can classify';
