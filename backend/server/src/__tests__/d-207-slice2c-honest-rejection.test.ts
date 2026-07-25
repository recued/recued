/** D-207 slice 2c — a rendering door tells the truth about a rejection.
 *
 *  ## The collision
 *
 *  D-149 answers a SPAM or DOMAIN-REJECTED submission with the success page, on
 *  purpose (`intake-form-render.ts`: *"the success page must stay byte-shaped the
 *  same across outcomes so the substrate does not fingerprint honeypot / domain
 *  detection"*). That trade is sound when the response carries nothing: the lie
 *  costs no one anything, and it stops a bot from binary-searching the honeypot
 *  by comparing two submissions.
 *
 *  D-207 slice 1c spent a session on the opposite principle: a thank-you page is
 *  a CLAIM, and a public form must never make it falsely.
 *
 *  ## The resolution
 *
 *  The fingerprint is a property of SILENT rejection, not of the honeypot. On a
 *  form whose recipe RENDERS, the bot already knows it was rejected — the
 *  checkout button it did not get IS the tell — so the silence is spent whatever
 *  we do, and its only remaining victim is a human: the visitor whose email
 *  domain was bounced, or the real person whose password manager filled a field
 *  they could not see. On those forms rejection becomes honest. Everywhere else
 *  D-149's silence still works and is left exactly as it was.
 *
 *  Note the shape of that rule: it is a FACT about the form, derived from the
 *  recipe with the same `recipeOutputSections` the engine uses to build
 *  `output.render`. Not a toggle anyone has to remember to set. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, it, expect } from 'vitest';
import {
  receptionPairBinding,
  recipeOutputSections,
  type IntakeFormConfig,
  type RecipeDefinition,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import {
  createInMemoryIntakeFormNonceStore,
  createIntakeFormPacketHandler,
  createIntakeFormSubmitHandler,
  intakeFormSubmitResponse,
  INTAKE_FORM_DOMAIN_REJECTED_MESSAGE,
  INTAKE_FORM_NOT_PROCESSED_MESSAGE,
} from '../ports/reception/handlers/intake-form.js';
import { resolveReceptionIntakeRecipePair } from '../ports/reception/intake-recipe-pair.js';
import { deriveReceptionIntakeRecipePairBinding } from '../reception-intake-recipe-pair-derivation.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import type { ReceptionEndpointContext } from '../ports/reception/redacted-packet.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const sees = (over: {
  disposition?: Parameters<typeof intakeFormSubmitResponse>[0]['disposition'];
  processing_outcome?: Parameters<typeof intakeFormSubmitResponse>[0]['processing_outcome'];
  pair_renders_response?: boolean;
} = {}) => intakeFormSubmitResponse({
  disposition: null,
  processing_outcome: 'pending',
  pair_renders_response: false,
  ...over,
});

describe('a form whose response carries NOTHING keeps D-149 silence', () => {
  // Every intake form in existence today. If any of these moved, slice 2c broke
  // the anti-fingerprint guarantee instead of scoping it.
  it.each(['spam', 'rejected_domain'] as const)(
    'answers %s with the success page — the bot gets no signal, as before',
    (processing_outcome) => {
      expect(sees({ processing_outcome, pair_renders_response: false }))
        .toEqual({ kind: 'success' });
    },
  );

  it('answers an accepted submission with the success page', () => {
    expect(sees({ processing_outcome: 'pending' })).toEqual({ kind: 'success' });
  });
});

describe('a form whose recipe RENDERS tells the truth', () => {
  it('tells a domain-rejected HUMAN, and tells them something they can act on', () => {
    const seen = sees({ processing_outcome: 'rejected_domain', pair_renders_response: true });
    expect(seen).toEqual({
      kind: 'rejected',
      status: 400,
      message: INTAKE_FORM_DOMAIN_REJECTED_MESSAGE,
    });
    // Actionable: a different address, or a human to contact. Not a dead end.
    expect(INTAKE_FORM_DOMAIN_REJECTED_MESSAGE).toContain('contact us');
  });

  it('tells a honeypot-tripped visitor WITHOUT telling them why', () => {
    const seen = sees({ processing_outcome: 'spam', pair_renders_response: true });
    expect(seen).toEqual({
      kind: 'rejected',
      status: 400,
      message: INTAKE_FORM_NOT_PROCESSED_MESSAGE,
    });
    // A bot must learn nothing here it did not already have. The message names
    // no field, no honeypot, no rule.
    expect(INTAKE_FORM_NOT_PROCESSED_MESSAGE.toLowerCase()).not.toContain('honeypot');
    expect(INTAKE_FORM_NOT_PROCESSED_MESSAGE.toLowerCase()).not.toContain('spam');
    expect(INTAKE_FORM_NOT_PROCESSED_MESSAGE.toLowerCase()).not.toContain('bot');
  });

  it('rejects with 400, not 503 — WE did not fail, we did not take it', () => {
    // 503 is reserved for "the run refused" / "the provider was down", where the
    // visitor's details ARE recorded and the owner can pick it up. A rejection is
    // a different claim and must not borrow that status.
    const rejected = sees({ processing_outcome: 'spam', pair_renders_response: true });
    const weFailed = sees({ disposition: 'refused', processing_outcome: 'pending' });
    expect(rejected).toMatchObject({ status: 400 });
    expect(weFailed).toEqual({ kind: 'error', status: 503 });
  });

  it('still says thank-you for an ACCEPTED submission — rendering changes nothing there', () => {
    expect(sees({ processing_outcome: 'pending', pair_renders_response: true }))
      .toEqual({ kind: 'success' });
  });

  it('still says thank-you for a HELD run — parked at the gate is not rejected', () => {
    // An anonymous actor is pinned to the `read` ceiling, so EVERY write a public
    // form performs holds. That is the common outcome, not an edge case, and the
    // submission is durable: "we got it, we'll be in touch" is TRUE.
    expect(sees({
      disposition: 'held',
      processing_outcome: 'pending',
      pair_renders_response: true,
    })).toEqual({ kind: 'success' });
  });

});

describe('"does this recipe render" is the ENGINE\'s rule, not a second one', () => {
  // If this answer ever disagreed with the answer the engine gives when it builds
  // `output.render`, the rule would fire on the wrong forms — silently, and in the
  // direction of lying to someone. So it is literally the same function.
  const withOutput = (output: unknown) => ({ output } as unknown as RecipeDefinition);

  it('a recipe with render blocks renders', () => {
    expect(recipeOutputSections(withOutput({
      render: [{ type: 'link_button', source: 'step.checkout' }],
    })).length).toBeGreaterThan(0);
  });

  it('a recipe with NO output does not', () => {
    expect(recipeOutputSections(withOutput(undefined))).toEqual([]);
    expect(recipeOutputSections(withOutput({}))).toEqual([]);
  });

  it('a legacy `sidebar`-only recipe DOES render — the engine renders it too', () => {
    // The engine falls back to the legacy alias, so if we did not, a legacy paired
    // recipe would render a checkout button while we still told a bounced visitor
    // "Submission received".
    expect(recipeOutputSections(withOutput({
      sidebar: [{ type: 'text', source: 'step.msg' }],
    })).length).toBe(1);
  });

  it('an EMPTY `render: []` beats a populated `sidebar` — the precedence a rewrite gets wrong', () => {
    // `Array.isArray([])` is true, so `render` present AT ALL means the author
    // moved off the legacy alias. An empty one means "renders nothing", not "fall
    // back to sidebar". Get this backwards and the rule fires on a form whose
    // response is in fact empty.
    expect(recipeOutputSections(withOutput({
      render: [],
      sidebar: [{ type: 'text', source: 'step.msg' }],
    }))).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end, through the REAL submit handler
// ────────────────────────────────────────────────────────────────
//
// The decision above is pure. What it does NOT prove is that the handler ever
// computes `pair_renders_response` and hands it over — a decision function wired
// to a hardcoded `false` passes every test above. So drive the real POST.

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-intake-render';
const FORM_DEFINITION_ID = 'lead-capture-v1';

const formConfig = (honeypot: boolean): IntakeFormConfig => ({
  display_name: 'Talk to us',
  success_message: 'Request received.',
  form_definition: {
    form_definition_id: FORM_DEFINITION_ID,
    fields: [
      { name: 'company', type: 'text', label: 'Company', required: true },
      ...(honeypot
        ? [{ name: 'website', type: 'text' as const, label: 'Website', required: false }]
        : []),
    ],
  },
  submission_processing_rule: {
    // D-210 A.8 slice 2b step 3 — a D-200 pair mints no destination entity: the
    // response row IS the paid deliverable. That used to be spelled as an
    // ABSENT target_kind; absent is no longer a value, so it is spelled
    // explicitly now. `reception-pair-binding` requires exactly this.
    target_kind: 'form_response',
    fields_to_include_in_target: [],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: honeypot ? ['website'] : [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

/** `renders` decides the ONLY thing under test: does this recipe's response carry
 *  anything? A lead-capture recipe that hands the visitor a "Book a call" button
 *  renders; one that just files the lead does not. */
const recipe = (renders: boolean): RecipeDefinition => ({
  recipe_id: 'lead-capture',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Lead capture',
    description: 'Files a lead.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  // The render section's `source` must name a real step, or the pair binding
  // refuses the recipe outright — which is the pair substrate doing its job, and
  // would have made this fixture prove nothing.
  steps: [{ id: 'file_lead', op: 'core.crm.contact.create' }],
  output: {
    render: renders ? [{ type: 'link_button', source: 'step.file_lead' }] : [],
  },
} as unknown as RecipeDefinition);

const fakeReq = (method: 'GET' | 'POST', body?: string): IncomingMessage => {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = `/reception/intake/${ENDPOINT_ID}?t=test-bearer`;
  req.headers.host = 'localhost';
  if (method === 'POST') {
    req.headers.origin = 'http://localhost';
    req.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
  }
  return req;
};

const fakeRes = () => {
  const chunks: Array<string | Buffer> = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    getHeader() { return undefined; },
    write(chunk: string | Buffer) { chunks.push(chunk); },
    end(chunk?: string | Buffer) { if (chunk !== undefined) chunks.push(chunk); },
    get body() { return chunks.map(String).join(''); },
  };
  return res as unknown as ServerResponse & { body: string };
};

/** POST once and report what the visitor was actually sent. */
const submit = async (input: {
  readonly renders: boolean;
  readonly honeypot: boolean;
  readonly email: string;
}) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const config = formConfig(input.honeypot);
  const savedRecipe = recipe(input.renders);
  const pairStore = createReceptionIntakeRecipePairStore(db);
  const bound = receptionPairBinding({
    form_config: config,
    recipe: savedRecipe,
    seller_offer_id: null,
  });
  if (bound === null) throw new Error('fixture produced no binding');
  pairStore.upsert({ endpoint_id: ENDPOINT_ID, binding: bound, now: NOW });

  // The REAL resolver — not a stub. It is what derives `renders_response` from the
  // recipe, so stubbing it here would test nothing.
  const resolveRecipePair = (args: {
    endpoint_id: string;
    form_config: IntakeFormConfig;
  }) => resolveReceptionIntakeRecipePair({
    endpoint_id: args.endpoint_id,
    form_config: args.form_config,
    store: pairStore,
    getRecipe: () => savedRecipe,
    deriveBinding: deriveReceptionIntakeRecipePairBinding,
  });

  const registry = { findById: (id: string) => id === ENDPOINT_ID ? { metadata: config } : null };
  const endpoint: ReceptionEndpointContext = {
    endpoint_id: ENDPOINT_ID,
    kind: 'intake_form_packet',
  };
  const nonceStore = createInMemoryIntakeFormNonceStore();

  const getRes = fakeRes();
  await createIntakeFormPacketHandler({
    getStore: () => registry as never,
    getFormNonceStore: () => nonceStore,
    resolveRecipePair,
    now: () => NOW,
  })(fakeReq('GET'), getRes, endpoint);
  const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];

  const submissionStore = createReceptionFormSubmissionStore(db);
  // D-210 WS2 — record whether the canonical log was written at submit. Every
  // form here is PAIRED, so the answer must be "no" on all three paths; a
  // recorder rather than a no-op store is what makes that checkable.
  const formResponseWrites: string[] = [];
  const postRes = fakeRes();
  await createIntakeFormSubmitHandler({
    getStore: () => registry as never,
    getSubmissionStore: () => submissionStore as never,
    getFormResponseStore: () => ({
      accept: (accepted: { submission_id: string }) => {
        formResponseWrites.push(accepted.submission_id);
        return { status: 'created', response: { submission_id: accepted.submission_id } };
      },
    }) as never,
    getFormNonceStore: () => nonceStore,
    getFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(
      new Uint8Array(32).fill(0x6e),
    ),
    auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
    resolveRecipePair,
    // The paired recipe never runs on spam / rejected_domain — the coordinator is
    // gated on `pending` — so its absence here is faithful to those paths.
    coordinatePairedRun: async () => ({ kind: 'completed' as const, render: [] }),
    now: () => NOW,
  })(
    fakeReq('POST', new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: input.email,
      company: 'Acme',
      ...(input.honeypot ? { website: 'bot.example' } : {}),
    }).toString()),
    postRes,
    endpoint,
  );

  return {
    status: postRes.statusCode,
    body: postRes.body,
    outcome: (db.prepare('SELECT processing_outcome FROM reception_form_submission LIMIT 1')
      .get() as { processing_outcome: string } | undefined)?.processing_outcome,
    form_response_writes: formResponseWrites.length,
  };
};

describe('END TO END — the handler really computes it and really hands it over', () => {
  it('a NON-rendering paired form still answers spam with 200 success (D-149, untouched)', async () => {
    const seen = await submit({ renders: false, honeypot: true, email: 'bot@example.com' });
    expect(seen.outcome).toBe('spam');
    expect(seen.status).toBe(200);
    expect(seen.body).toContain('Submission received');
  });

  it('a RENDERING paired form answers spam with an honest 400', async () => {
    const seen = await submit({ renders: true, honeypot: true, email: 'bot@example.com' });
    // The row is still durable — the owner keeps seeing it. Only what the VISITOR
    // is told changed.
    expect(seen.outcome).toBe('spam');
    expect(seen.status).toBe(400);
    expect(seen.body).not.toContain('Submission received');
    expect(seen.body).toContain('couldn’t process this submission');
  });

  it('a RENDERING paired form still says thank-you when the submission is ACCEPTED', async () => {
    const seen = await submit({ renders: true, honeypot: false, email: 'lead@example.com' });
    expect(seen.outcome).toBe('pending');
    expect(seen.status).toBe(200);
    expect(seen.body).toContain('Submission received');
  });

  // D-210 WS2 — the submit-time canonical log skips PAIRED submissions, on
  // every outcome. Asserted across all three paths together because the
  // exclusion is on the binding, not on the outcome: an `accepted` paired row
  // is the case most likely to be "fixed" into logging by someone reading the
  // rule as "log everything that isn't spam".
  it('never writes the canonical log at submit for a PAIRED form, on any outcome', async () => {
    const spam = await submit({ renders: false, honeypot: true, email: 'bot@example.com' });
    const rejected = await submit({ renders: true, honeypot: true, email: 'bot@example.com' });
    const accepted = await submit({ renders: true, honeypot: false, email: 'lead@example.com' });
    expect(accepted.outcome).toBe('pending');
    expect([spam, rejected, accepted].map((s) => s.form_response_writes)).toEqual([0, 0, 0]);
  });
});
