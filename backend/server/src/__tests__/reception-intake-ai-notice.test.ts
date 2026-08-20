/** The visitor is told when the form they are filling in runs AI on it.
 *
 *  WHY THIS EXISTS. A public reception door that runs AI already requires a
 *  recorded owner opt-in: `analyzeReceptionRecipeCost` classifies every step,
 *  `receptionDoorExecutionPolicy` mints `allow_ai` from that profile at bind
 *  time, and `receptionDoorPolicyAdmits` re-checks it on every submit — a door
 *  whose policy does not admit AI fails the run outright. So the OWNER has
 *  consented, twice over.
 *
 *  Nothing told the VISITOR. The consent gate was built as a COST fence — a
 *  public form that burns tokens on every passer-by — and cost is the owner's
 *  problem, so the person actually handing over their text was never in its
 *  frame. This is the missing half: one sentence, on the form, driven by the
 *  same analysis the runner uses.
 *
 *  ⛔ THE ABSENT CASES CARRY THE WEIGHT HERE. A notice that renders
 *  unconditionally would pass any "is it shown" assertion while being a lie on
 *  every non-AI form — and a form that cries AI is one an operator will want
 *  switched off, which is how a disclosure surface dies. Each negative below is
 *  a distinct way the flag can be wrong.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  receptionPairBinding,
  type IntakeFormConfig,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  renderIntakeFormHtml,
  type IntakeFormRenderInput,
} from '../ports/reception/handlers/intake-form-render.js';
import { resolveReceptionIntakeRecipePair } from '../ports/reception/intake-recipe-pair.js';
import { deriveReceptionIntakeRecipePairBinding } from '../reception-intake-recipe-pair-derivation.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const NOTICE = 'This form uses AI to process what you send.';

const intakeInput = (
  overrides: Partial<IntakeFormRenderInput> = {},
): IntakeFormRenderInput => ({
  display_name: 'Mary',
  fields: [],
  honeypot_fields: [],
  visitor_email_requirement: 'optional',
  submit_button_label: 'Submit',
  endpoint_id: 'ep-intake',
  bearer_secret: 'tok-intake',
  form_nonce: 'nonce-intake',
  trust_footer: null,
  ...overrides,
});

describe('reception intake — the AI notice', () => {
  it('renders when the bound recipe runs AI', () => {
    const html = renderIntakeFormHtml(intakeInput({ uses_ai: true }));
    expect(html).toContain(NOTICE);
  });

  it('⛔ is ABSENT on a form whose recipe runs no AI', () => {
    expect(renderIntakeFormHtml(intakeInput({ uses_ai: false }))).not.toContain(NOTICE);
  });

  it('⛔ is ABSENT when the flag is not supplied at all', () => {
    // Every caller that predates this field, and any future renderer that
    // forgets to pass it, must produce the form it produced before — silence,
    // not a claim about AI nobody asked it to make.
    expect(renderIntakeFormHtml(intakeInput())).not.toContain(NOTICE);
  });

  it('sits INSIDE the form and BEFORE the submit button', () => {
    // Placement is the requirement, not presence. "At the latest at the time of
    // the first interaction" means the visitor must meet it while deciding to
    // send — not below the fold in the footer, after the decision is made.
    const html = renderIntakeFormHtml(intakeInput({ uses_ai: true }));
    const notice = html.indexOf(NOTICE);
    const submit = html.indexOf('<button type="submit"');
    const formClose = html.indexOf('</form>');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(submit);
    expect(notice).toBeLessThan(formClose);
    expect(html.indexOf('<form')).toBeLessThan(notice);
  });

  it('⛔ is NOT part of the trust footer, which an operator can switch off', () => {
    // The trust footer is a per-server block with its own toggle. If the notice
    // rode inside it, turning off a "Powered by" line would silently withdraw a
    // disclosure about AI — two unrelated decisions welded to one switch.
    const html = renderIntakeFormHtml(intakeInput({ uses_ai: true, trust_footer: null }));
    expect(html).toContain(NOTICE);
    expect(html).not.toContain('rcp-trust-footer');
  });

  it('survives a form that has no fields and no trust footer', () => {
    const html = renderIntakeFormHtml(intakeInput({ uses_ai: true }));
    expect(html).toContain('rcp-ai-notice');
  });
});

// ────────────────────────────────────────────────────────────────
// The DERIVATION — where the flag is born.
//
// ⛔ THE RENDER TESTS ABOVE WOULD ALL PASS IF NOTHING EVER SET `uses_ai` TO
// TRUE. They prove the notice CAN render, not that it EVER does. These drive the
// real resolver against a real store with a real recipe, so the flag has to
// survive the same path the visitor's request takes.
// ────────────────────────────────────────────────────────────────

const ENDPOINT_ID = 'ep-ai-notice';
const NOW = 1_700_000_000_000;

const formConfig = (): IntakeFormConfig => ({
  display_name: 'Talk to us',
  success_message: 'Request received.',
  form_definition: {
    form_definition_id: 'fd-ai-notice',
    fields: [{ name: 'company', type: 'text', label: 'Company', required: true }],
  },
  submission_processing_rule: {
    target_kind: 'form_response',
    fields_to_include_in_target: [],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

/** `op` is the whole variable: one AI step vs one non-AI step, everything else
 *  byte-identical, so a differing verdict can only have come from the op. */
const recipeWithOp = (op: string): RecipeDefinition => ({
  recipe_id: 'intake-handler',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Intake handler',
    description: 'Handles an intake submission.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'handle', op }],
  output: { render: [] },
} as unknown as RecipeDefinition);

const resolveFor = (op: string) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const config = formConfig();
  const recipe = recipeWithOp(op);
  const store = createReceptionIntakeRecipePairStore(db);
  const bound = receptionPairBinding({
    form_config: config,
    recipe,
    seller_offer_id: null,
  });
  if (bound === null) throw new Error('fixture produced no binding');
  store.upsert({ endpoint_id: ENDPOINT_ID, binding: bound, now: NOW });
  return resolveReceptionIntakeRecipePair({
    endpoint_id: ENDPOINT_ID,
    form_config: config,
    store,
    getRecipe: () => recipe,
    deriveBinding: deriveReceptionIntakeRecipePairBinding,
  });
};

describe('reception intake — uses_ai is derived from the bound recipe', () => {
  it('⛔ TRUE for a recipe that runs a core.ai.* step', () => {
    const resolution = resolveFor('core.ai.classify');
    expect(resolution.kind).toBe('ready');
    if (resolution.kind !== 'ready') return;
    expect(resolution.uses_ai).toBe(true);
  });

  it('FALSE for an otherwise identical recipe with a non-AI step', () => {
    const resolution = resolveFor('core.crm.contact.create');
    expect(resolution.kind).toBe('ready');
    if (resolution.kind !== 'ready') return;
    expect(resolution.uses_ai).toBe(false);
  });

  it('⛔ THE JOIN: the derived flag reaches the rendered page', () => {
    // The two halves are separately correct and could still not be connected —
    // the defect this whole session kept finding. Drive derivation into render.
    const ai = resolveFor('core.ai.classify');
    const plain = resolveFor('core.crm.contact.create');
    if (ai.kind !== 'ready' || plain.kind !== 'ready') throw new Error('unready');
    const html = (uses_ai: boolean): string =>
      renderIntakeFormHtml(intakeInput({ uses_ai }));
    expect(html(ai.uses_ai)).toContain(NOTICE);
    expect(html(plain.uses_ai)).not.toContain(NOTICE);
  });
});
