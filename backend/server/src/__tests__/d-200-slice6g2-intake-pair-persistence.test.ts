import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  paidDocumentDirectCheckoutSellerAssociation,
  receptionPairBinding,
  type IntakeFormConfig,
  type ReceptionFormPairBinding,
  type RecipeDefinition,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import {
  createInMemoryIntakeFormNonceStore,
  createIntakeFormPacketHandler,
  createIntakeFormSubmitHandler,
} from '../ports/reception/handlers/intake-form.js';
import {
  resolveReceptionIntakeRecipePair,
  type ReceptionIntakeRecipePairResolution,
} from '../ports/reception/intake-recipe-pair.js';
import { deriveReceptionIntakeRecipePairBinding } from '../reception-intake-recipe-pair-derivation.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import type { ReceptionEndpointContext } from '../ports/reception/redacted-packet.js';
import {
  createReceptionFormSubmissionStore,
} from '../storage/reception-form-store.js';
import {
  createReceptionIntakeRecipePairStore,
  ReceptionIntakeRecipePairStoreError,
} from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-direct-checkout';
const FORM_DEFINITION_ID = 'research-brief-v1';

const formConfig = (): IntakeFormConfig => ({
  display_name: 'Commission one research brief',
  success_message: 'Request received.',
  form_definition: {
    form_definition_id: FORM_DEFINITION_ID,
    fields: [
      { name: 'product', type: 'text', label: 'Product', required: true },
      { name: 'amount_minor', type: 'number', label: 'Price', required: true },
      {
        name: 'currency',
        type: 'enum',
        label: 'Currency',
        required: true,
        values: ['usd', 'eur'],
      },
      { name: 'brief', type: 'textarea', label: 'Brief', required: true },
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
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

const recipe = (ttl = 300): RecipeDefinition => ({
  recipe_id: 'research-brief-checkout',
  version: 3,
  ttl,
  metadata: {
    name: 'Research brief checkout',
    description: 'Validates one intake into one checkout item.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
});

const binding = (
  config: IntakeFormConfig = formConfig(),
  savedRecipe: RecipeDefinition = recipe(),
): ReceptionFormPairBinding => {
  const result = receptionPairBinding({
    form_config: config,
    recipe: savedRecipe,
    seller_offer_id: paidDocumentDirectCheckoutSellerAssociation(savedRecipe),
  });
  if (result === null) throw new Error('test fixture did not produce a pair binding');
  return result;
};

const buildDb = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return db;
};

describe('D-200 Slice 6g.2 intake pair registry and source resolution', () => {
  it('persists one exact pair per endpoint and preserves its creation clock on rebind', () => {
    const db = buildDb();
    const store = createReceptionIntakeRecipePairStore(db);
    const firstBinding = binding();
    const changedBinding = binding(formConfig(), recipe(301));

    expect(store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: firstBinding,
      now: NOW,
    })).toEqual({
      endpoint_id: ENDPOINT_ID,
      binding: firstBinding,
      created_at: NOW,
      updated_at: NOW,
      contract_id: null,
    });
    expect(store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: changedBinding,
      now: NOW + 1_000,
    })).toEqual({
      endpoint_id: ENDPOINT_ID,
      binding: changedBinding,
      created_at: NOW,
      updated_at: NOW + 1_000,
      contract_id: null,
    });
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(changedBinding);
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).not.toHaveProperty('seller_offer_id');
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).not.toHaveProperty('pack_slug');
    expect(store.compareAndDelete({
      endpoint_id: ENDPOINT_ID,
      expected_status: 'ready',
      expected_updated_at: NOW + 1_000,
      expected_pair_revision: changedBinding.pair_revision,
    })).toMatchObject({ kind: 'deleted', prior: { binding: changedBinding } });
    expect(store.compareAndDelete({
      endpoint_id: ENDPOINT_ID,
      expected_status: 'ready',
      expected_updated_at: NOW + 1_000,
      expected_pair_revision: changedBinding.pair_revision,
    })).toEqual({ kind: 'unchanged' });
  });

  it('round-trips a v2 pair-pinned Seller association without expanding pair authority', () => {
    const db = buildDb();
    const store = createReceptionIntakeRecipePairStore(db);
    const associatedRecipe = recipe();
    associatedRecipe.metadata.paid_document_direct_checkout = {
      version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
      stripe_connection_name: 'stripe-primary',
      success_url: 'https://owner.example/checkout/success',
      cancel_url: 'https://owner.example/checkout/cancel',
      expiry_window_ms: 30 * 60 * 1_000,
      template_file_ref: `file:${'a'.repeat(32)}`,
      seller_offer_id: 'research-brief.fulfilled',
    };
    const associated = binding(formConfig(), associatedRecipe);

    expect(associated).toMatchObject({
      version: 2,
      seller_offer_id: 'research-brief.fulfilled',
    });
    expect(store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: associated,
      now: NOW,
    }).binding).toEqual(associated);
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(associated);
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).not.toHaveProperty('seller_offer');
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).not.toHaveProperty('amount_minor');
  });

  it('lists every valid pair for recipe-mutation invalidation without trusting corrupt rows', () => {
    const db = buildDb();
    const store = createReceptionIntakeRecipePairStore(db);
    const shared = binding();
    const other = binding(formConfig(), {
      ...recipe(),
      recipe_id: 'another-checkout-recipe',
    });
    store.upsert({ endpoint_id: 'endpoint-b', binding: shared, now: NOW });
    store.upsert({ endpoint_id: 'endpoint-a', binding: shared, now: NOW });
    store.upsert({ endpoint_id: 'endpoint-other', binding: other, now: NOW });
    store.upsert({ endpoint_id: 'endpoint-corrupt', binding: shared, now: NOW });
    db.prepare(`
      UPDATE reception_intake_recipe_pair SET binding_blob = '{'
      WHERE endpoint_id = 'endpoint-corrupt'
    `).run();

    expect(store.listByRecipeId(shared.recipe_id).map((pair) => pair.endpoint_id))
      .toEqual(['endpoint-a', 'endpoint-b']);
    expect(store.listByRecipeId(other.recipe_id).map((pair) => pair.endpoint_id))
      .toEqual(['endpoint-other']);
    expect(store.listByRecipeId('not canonical')).toEqual([]);
  });

  it('rejects invalid or backwards-clock writes before mutating the durable row', () => {
    const db = buildDb();
    const store = createReceptionIntakeRecipePairStore(db);
    const firstBinding = binding();
    store.upsert({ endpoint_id: ENDPOINT_ID, binding: firstBinding, now: NOW });

    expect(() => store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: binding(formConfig(), recipe(301)),
      now: NOW - 1,
    })).toThrow(expect.objectContaining({
      name: 'ReceptionIntakeRecipePairStoreError',
      code: 'invalid_input',
    }));
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(firstBinding);

    const newerBinding = binding(formConfig(), recipe(301));
    store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: newerBinding,
      now: NOW + 1_000,
    });
    expect(() => store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: firstBinding,
      now: NOW + 500,
    })).toThrow(expect.objectContaining({
      name: 'ReceptionIntakeRecipePairStoreError',
      code: 'invalid_input',
    }));
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(newerBinding);

    expect(() => store.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: { ...firstBinding, pair_revision: 'caller-shaped' },
      now: NOW + 1_001,
    })).toThrow(ReceptionIntakeRecipePairStoreError);
    expect(store.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(newerBinding);
  });

  it('fails closed when persisted binding bytes or duplicate columns drift', () => {
    const db = buildDb();
    const store = createReceptionIntakeRecipePairStore(db);
    store.upsert({ endpoint_id: ENDPOINT_ID, binding: binding(), now: NOW });

    db.prepare(`
      UPDATE reception_intake_recipe_pair
         SET form_definition_id = 'different-form'
       WHERE endpoint_id = ?
    `).run(ENDPOINT_ID);
    expect(() => store.findByEndpoint(ENDPOINT_ID)).toThrow(
      expect.objectContaining({ code: 'invalid_stored_binding' }),
    );

    db.prepare(`
      UPDATE reception_intake_recipe_pair
         SET binding_blob = '{'
       WHERE endpoint_id = ?
    `).run(ENDPOINT_ID);
    expect(() => store.findByEndpoint(ENDPOINT_ID)).toThrow(
      expect.objectContaining({ code: 'invalid_stored_binding' }),
    );
  });

  it('distinguishes absent generic forms from corrupt, missing, or drifted pairs', () => {
    const db = buildDb();
    const store = createReceptionIntakeRecipePairStore(db);
    const config = formConfig();
    const savedRecipe = recipe();
    const resolve = (
      currentConfig: IntakeFormConfig,
      currentRecipe: RecipeDefinition | null,
    ) => resolveReceptionIntakeRecipePair({
      endpoint_id: ENDPOINT_ID,
      form_config: currentConfig,
      store,
      getRecipe: () => currentRecipe,
      deriveBinding: deriveReceptionIntakeRecipePairBinding,
    });

    expect(resolve(config, savedRecipe)).toEqual({ kind: 'unpaired' });
    const exactBinding = binding(config, savedRecipe);
    store.upsert({ endpoint_id: ENDPOINT_ID, binding: exactBinding, now: NOW });
    expect(resolve(config, savedRecipe)).toEqual({
      kind: 'ready',
      binding: exactBinding,
      // D-207 slice 2c — the resolver already reads the recipe to prove the stored
      // binding still matches, so it also reports whether that recipe RENDERS.
      // This fixture's recipe declares no output, so its response carries nothing
      // and D-149's silence on a rejected submission still holds for it.
      renders_response: false,
    });
    expect(resolve({ ...config, display_name: 'Changed form' }, savedRecipe)).toEqual({
      kind: 'stale',
    });
    expect(resolve(config, recipe(301))).toEqual({ kind: 'stale' });
    expect(resolve(config, null)).toEqual({ kind: 'stale' });

    db.prepare(`
      UPDATE reception_intake_recipe_pair SET binding_blob = 'not-json'
       WHERE endpoint_id = ?
    `).run(ENDPOINT_ID);
    expect(resolve(config, savedRecipe)).toEqual({ kind: 'stale' });
  });
});

describe('D-200 Slice 6g.2 nonce and submission pair stamping', () => {
  it('round-trips an immutable pair stamp once while generic nonces remain unpaired', () => {
    const store = createInMemoryIntakeFormNonceStore();
    const exactBinding = binding();
    const nonce = store.issue(ENDPOINT_ID, NOW, exactBinding);

    (exactBinding as { recipe_version: number }).recipe_version = 999;
    const stamp = store.consume(ENDPOINT_ID, nonce, NOW + 1);
    expect(stamp?.pair_binding?.recipe_version).toBe(3);
    expect(store.consume(ENDPOINT_ID, nonce, NOW + 2)).toBeNull();

    const generic = store.issue(ENDPOINT_ID, NOW);
    expect(store.consume(ENDPOINT_ID, generic, NOW)).toEqual({ pair_binding: null });
    const expired = store.issue(ENDPOINT_ID, NOW);
    expect(store.consume(ENDPOINT_ID, expired, NOW + 30 * 60 * 1_000 + 1)).toBeNull();
  });

  it('persists the exact pair in server-owned metadata without exposing it as caller metadata', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    const exactBinding = binding();
    const row = store.insert({
      submission_id: 'submission-paired',
      endpoint_id: ENDPOINT_ID,
      form_definition_id: FORM_DEFINITION_ID,
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: 'AAAA',
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
      pair_binding: exactBinding,
      metadata: { definition_snapshot: formConfig().form_definition },
    });

    expect(row.pair_binding).toEqual(exactBinding);
    expect(row.metadata).toEqual({ definition_snapshot: formConfig().form_definition });
    expect(row.metadata).not.toHaveProperty('paid_document_direct_checkout_pair');
    const raw = db.prepare(`
      SELECT metadata_blob FROM reception_form_submission WHERE submission_id = ?
    `).get('submission-paired') as { metadata_blob: string };
    expect(JSON.parse(raw.metadata_blob)).toMatchObject({
      paid_document_direct_checkout_pair: exactBinding,
    });

    const generic = store.insert({
      submission_id: 'submission-generic',
      endpoint_id: 'ep-generic',
      form_definition_id: 'generic-v1',
      submitted_at: NOW + 1,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
    });
    expect(generic.pair_binding).toBeNull();
  });

  it('rejects pair-key injection and malformed stored pair metadata', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    const base = {
      submission_id: 'submission-rejected',
      endpoint_id: ENDPOINT_ID,
      form_definition_id: FORM_DEFINITION_ID,
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending' as const,
    };

    expect(() => store.insert({
      ...base,
      metadata: { paid_document_direct_checkout_pair: binding() },
    })).toThrow(/server-owned/);
    expect(() => store.insert({
      ...base,
      pair_binding: {
        ...binding(),
        pair_revision: 'not-authority',
      },
    })).toThrow(/invalid/);
    expect(() => store.insert({
      ...base,
      pair_binding: {
        ...binding(),
        form_definition_id: 'different-form',
      },
    })).toThrow(/does not match form_definition_id/);

    store.insert({ ...base, submission_id: 'submission-corrupt' });
    db.prepare(`
      UPDATE reception_form_submission SET metadata_blob = ?
       WHERE submission_id = 'submission-corrupt'
    `).run(JSON.stringify({ paid_document_direct_checkout_pair: { version: 1 } }));
    expect(() => store.findById('submission-corrupt')).toThrow(/invalid or mismatched/);

    db.prepare(`
      UPDATE reception_form_submission SET metadata_blob = ?
       WHERE submission_id = 'submission-corrupt'
    `).run(JSON.stringify({
      paid_document_direct_checkout_pair: {
        ...binding(),
        form_definition_id: 'different-form',
      },
    }));
    expect(() => store.findById('submission-corrupt')).toThrow(/invalid or mismatched/);

    db.prepare(`
      UPDATE reception_form_submission SET metadata_blob = '{'
       WHERE submission_id = 'submission-corrupt'
    `).run();
    expect(() => store.findById('submission-corrupt')).toThrow(/invalid metadata/);
  });
});

const fakeReq = (
  method: 'GET' | 'POST',
  body?: string,
): IncomingMessage => {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
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
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    write(chunk: string | Buffer) {
      chunks.push(chunk);
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(chunk);
    },
    get body() {
      return chunks.map((chunk) => chunk.toString()).join('');
    },
  } as unknown as ServerResponse & { readonly body: string };
  return res;
};

const endpoint: ReceptionEndpointContext = {
  endpoint_id: ENDPOINT_ID,
  kind: 'intake_form_packet',
};

const registry = (config: IntakeFormConfig) => ({
  findById: (endpointId: string) => endpointId === ENDPOINT_ID
    ? { metadata: config }
    : null,
});

describe('D-200 Slice 6g.2 public intake pair identity', () => {
  it('stamps the exact render-time pair into the persisted submission', async () => {
    const db = buildDb();
    const submissionStore = createReceptionFormSubmissionStore(db);
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    const exactBinding = binding(config, recipe());
    const resolvePair = (): ReceptionIntakeRecipePairResolution => ({
      kind: 'ready',
      binding: exactBinding,
      renders_response: false,
    });
    const order: string[] = [];
    const auditCalls: Array<{ detail: string }> = [];
    const getHandler = createIntakeFormPacketHandler({
      getStore: () => registry(config) as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const getRes = fakeRes();
    await getHandler(fakeReq('GET'), getRes, endpoint);
    expect(getRes.statusCode).toBe(200);
    const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
    expect(nonce).toBeTruthy();

    const submitHandler = createIntakeFormSubmitHandler({
      getStore: () => registry(config) as never,
      getSubmissionStore: () => ({
        countWithinWindow: submissionStore.countWithinWindow,
        insert: (input: Parameters<typeof submissionStore.insert>[0]) => {
          const inserted = submissionStore.insert(input);
          order.push('insert');
          return inserted;
        },
      }) as never,
      getFormNonceStore: () => nonceStore,
      getFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(
        new Uint8Array(32).fill(0x6e),
      ),
      auditLog: {
        logActivity: async (input: { detail: string }) => {
          order.push('audit');
          auditCalls.push(input);
        },
      } as unknown as AuditLogStore,
      resolveRecipePair: resolvePair,
      coordinatePairedRun: async (input) => {
        order.push('claim');
        expect(input.form_config).toEqual(config);
        expect(submissionStore.findById(input.submission_id)).toMatchObject({
          processing_outcome: 'pending',
          pair_binding: exactBinding,
        });
        return { kind: 'completed' as const, render: [] };
      },
      now: () => NOW,
    });
    const body = new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: 'visitor@example.com',
      product: 'One brief',
      amount_minor: '12500',
      currency: 'usd',
      brief: 'Research this market.',
    }).toString();
    const postRes = fakeRes();
    await submitHandler(fakeReq('POST', body), postRes, endpoint);

    // D-207 slice 3c — 200, not 303. The only thing that ever redirected was D-200's
    // coordinator, and it is gone: under ruling (C) the product is a `link_button` rendered
    // INTO the page, so the run completes and the page carries it. What this test is really
    // about survives untouched — the exact render-time pair is stamped into the durable row,
    // and the insert lands BEFORE the run.
    expect(postRes.statusCode).toBe(200);
    const rows = submissionStore.listPendingForEndpoint(ENDPOINT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pair_binding).toEqual(exactBinding);
    expect(order).toEqual(['insert', 'claim', 'audit']);
    expect(JSON.parse(auditCalls[0]!.detail)).toMatchObject({
      paired_run: 'completed',
    });
    // D-210 WS2 — a D-200 paired submission is NOT logged at submit. Its
    // `form_response` is the paid deliverable and is written only after the
    // approve-time payment gate admits it; logging it here would hand the
    // owner the goods before the provider confirmed payment.
  });

  it('keeps a paired row durable and reports unavailable when the post-insert claim throws', async () => {
    const db = buildDb();
    const submissionStore = createReceptionFormSubmissionStore(db);
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    const exactBinding = binding(config, recipe());
    const resolvePair = (): ReceptionIntakeRecipePairResolution => ({
      kind: 'ready',
      binding: exactBinding,
      renders_response: false,
    });
    const getHandler = createIntakeFormPacketHandler({
      getStore: () => registry(config) as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const getRes = fakeRes();
    await getHandler(fakeReq('GET'), getRes, endpoint);
    const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
    const auditDetails: string[] = [];
    const submitHandler = createIntakeFormSubmitHandler({
      getStore: () => registry(config) as never,
      getSubmissionStore: () => submissionStore,
      getFormNonceStore: () => nonceStore,
      getFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(
        new Uint8Array(32).fill(0x6e),
      ),
      auditLog: {
        logActivity: async (input: { detail: string }) => {
          auditDetails.push(input.detail);
        },
      } as unknown as AuditLogStore,
      resolveRecipePair: resolvePair,
      coordinatePairedRun: async (input) => {
        expect(submissionStore.findById(input.submission_id)).not.toBeNull();
        throw new Error('shared store unavailable');
      },
      now: () => NOW,
    });
    const postRes = fakeRes();
    await submitHandler(fakeReq('POST', new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: 'visitor@example.com',
      product: 'One brief',
      amount_minor: '12500',
      currency: 'usd',
      brief: 'Research this market.',
    }).toString()), postRes, endpoint);

    // D-207 slice 1c — INVERTED. This asserted 200 (the success page) when the coordinator
    // THREW. That was the silent-success-page bug, tested in: a visitor on a paid form was
    // told "thank you, we got your submission" and was never asked to pay, because a store
    // (or provider) outage looked exactly like a completed submission.
    //
    // The submission stays durable and the audit row still records `unavailable` — those
    // were always right. What changes is what the VISITOR is told: they were promised a
    // checkout, they are not getting one, and only they can act on that.
    expect(postRes.statusCode).toBe(503);
    expect(submissionStore.listPendingForEndpoint(ENDPOINT_ID)).toHaveLength(1);
    expect(JSON.parse(auditDetails[0]!)).toMatchObject({
      paired_run: 'unavailable',
    });
  });

  it('fails a ready paired POST before persistence when no claim adapter is composed', async () => {
    const db = buildDb();
    const submissionStore = createReceptionFormSubmissionStore(db);
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    const exactBinding = binding(config, recipe());
    const resolvePair = (): ReceptionIntakeRecipePairResolution => ({
      kind: 'ready',
      binding: exactBinding,
      renders_response: false,
    });
    const getHandler = createIntakeFormPacketHandler({
      getStore: () => registry(config) as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const getRes = fakeRes();
    await getHandler(fakeReq('GET'), getRes, endpoint);
    const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
    const submitHandler = createIntakeFormSubmitHandler({
      getStore: () => registry(config) as never,
      getSubmissionStore: () => submissionStore,
      getFormNonceStore: () => nonceStore,
      getFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(
        new Uint8Array(32).fill(0x6e),
      ),
      auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const postRes = fakeRes();
    await submitHandler(fakeReq('POST', new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: 'visitor@example.com',
      product: 'One brief',
      amount_minor: '12500',
      currency: 'usd',
      brief: 'Research this market.',
    }).toString()), postRes, endpoint);

    expect(postRes.statusCode).toBe(503);
    expect(postRes.body).toContain('Checkout is temporarily unavailable');
    expect(submissionStore.listPendingForEndpoint(ENDPOINT_ID)).toEqual([]);
  });

  it('does not invoke the D-200 claim seam for an ordinary unpaired form', async () => {
    const db = buildDb();
    const submissionStore = createReceptionFormSubmissionStore(db);
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    const resolvePair = (): ReceptionIntakeRecipePairResolution => ({ kind: 'unpaired' });
    let claimCalls = 0;
    const getHandler = createIntakeFormPacketHandler({
      getStore: () => registry(config) as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const getRes = fakeRes();
    await getHandler(fakeReq('GET'), getRes, endpoint);
    const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
    const submitHandler = createIntakeFormSubmitHandler({
      getStore: () => registry(config) as never,
      getSubmissionStore: () => submissionStore,
      getFormNonceStore: () => nonceStore,
      getFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(
        new Uint8Array(32).fill(0x6e),
      ),
      auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
      resolveRecipePair: resolvePair,
      coordinatePairedRun: async () => {
        claimCalls += 1;
        return { kind: 'completed' as const, render: [] };
      },
      now: () => NOW,
    });
    const postRes = fakeRes();
    await submitHandler(fakeReq('POST', new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: 'visitor@example.com',
      product: 'One brief',
      amount_minor: '12500',
      currency: 'usd',
      brief: 'Research this market.',
    }).toString()), postRes, endpoint);

    expect(postRes.statusCode).toBe(200);
    expect(claimCalls).toBe(0);
    expect(submissionStore.listPendingForEndpoint(ENDPOINT_ID)[0])
      .toMatchObject({ pair_binding: null });
    // ⚠ RE-POINTED 2026-07-20 (D-210 audit finding 3a). This was the positive
    // control for the paired tests' negative one — deliberately asserting that
    // SOMETHING was written at submit, so a change that stopped writing
    // altogether could not pass by making every "must not log" assertion
    // trivially true. That control did its job: this line is what caught the
    // write being moved. ⇒ [[a_reduction_is_faked_by_doing_less]]
    //
    // Nothing is written to `form_response` at submit any more — approve is the
    // door (A.1). The anti-vacuity role splits in two, and neither half is lost:
    //   - at THIS layer, the assertion above that the submission row exists with
    //     `pair_binding: null` proves the handler really ran and reached here;
    //   - the WRITE itself is pinned at its new home, `form-response-promotion.test.ts`
    //     ("writes the canonical row for an UNPAIRED form_response approval"),
    //     alongside the destination discrimination that moved with it.
  });

  it('does not invoke the D-200 claim seam for paired spam or rejected-domain rows', async () => {
    for (const expectedOutcome of ['spam', 'rejected_domain'] as const) {
      const db = buildDb();
      const submissionStore = createReceptionFormSubmissionStore(db);
      const nonceStore = createInMemoryIntakeFormNonceStore();
      const base = formConfig();
      const config: IntakeFormConfig = expectedOutcome === 'spam'
        ? {
            ...base,
            form_definition: {
              ...base.form_definition,
              fields: [
                ...base.form_definition.fields,
                { name: 'website', type: 'text', label: 'Website', required: false },
              ],
            },
            anti_spam: { ...base.anti_spam, honeypot_fields: ['website'] },
          }
        : {
            ...base,
            anti_spam: {
              ...base.anti_spam,
              known_domain_allowlist: ['allowed.example'],
            },
          };
      const exactBinding = binding(config, recipe());
      const resolvePair = (): ReceptionIntakeRecipePairResolution => ({
        kind: 'ready',
        binding: exactBinding,
        renders_response: false,
      });
      const getHandler = createIntakeFormPacketHandler({
        getStore: () => registry(config) as never,
        getFormNonceStore: () => nonceStore,
        resolveRecipePair: resolvePair,
        now: () => NOW,
      });
      const getRes = fakeRes();
      await getHandler(fakeReq('GET'), getRes, endpoint);
      const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
      let insertedOutcome: string | null = null;
      let claimCalls = 0;
      const submitHandler = createIntakeFormSubmitHandler({
        getStore: () => registry(config) as never,
        getSubmissionStore: () => ({
          countWithinWindow: submissionStore.countWithinWindow,
          insert: (input: Parameters<typeof submissionStore.insert>[0]) => {
            const inserted = submissionStore.insert(input);
            insertedOutcome = inserted.processing_outcome;
            return inserted;
          },
        }) as never,
        getFormNonceStore: () => nonceStore,
        getFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(
          new Uint8Array(32).fill(0x6e),
        ),
        auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
        resolveRecipePair: resolvePair,
        coordinatePairedRun: async () => {
          claimCalls += 1;
          return { kind: 'completed' as const, render: [] };
        },
        now: () => NOW,
      });
      const body = new URLSearchParams({
        form_nonce: nonce!,
        visitor_email: expectedOutcome === 'rejected_domain'
          ? 'visitor@blocked.example'
          : 'visitor@example.com',
        product: 'One brief',
        amount_minor: '12500',
        currency: 'usd',
        brief: 'Research this market.',
        ...(expectedOutcome === 'spam' ? { website: 'bot.example' } : {}),
      }).toString();
      const postRes = fakeRes();
      await submitHandler(fakeReq('POST', body), postRes, endpoint);

      expect(postRes.statusCode).toBe(200);
      expect(insertedOutcome).toBe(expectedOutcome);
      expect(claimCalls).toBe(0);
    }
  });

  it('fails closed before persistence when pair state changes after render', async () => {
    const db = buildDb();
    const submissionStore = createReceptionFormSubmissionStore(db);
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    let resolution: ReceptionIntakeRecipePairResolution = {
      kind: 'ready',
      binding: binding(config, recipe()),
      renders_response: false,
    };
    const resolvePair = () => resolution;
    const getHandler = createIntakeFormPacketHandler({
      getStore: () => registry(config) as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const getRes = fakeRes();
    await getHandler(fakeReq('GET'), getRes, endpoint);
    const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
    expect(nonce).toBeTruthy();

    resolution = { kind: 'stale' };
    const submitHandler = createIntakeFormSubmitHandler({
      getStore: () => registry(config) as never,
      getSubmissionStore: () => submissionStore,
      getFormNonceStore: () => nonceStore,
      getFormSubmissionPiiKey: () => new Uint8Array(32).fill(0x6e),
      auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const body = new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: 'visitor@example.com',
      product: 'One brief',
      amount_minor: '12500',
      currency: 'usd',
      brief: 'Research this market.',
    }).toString();
    const postRes = fakeRes();
    await submitHandler(fakeReq('POST', body), postRes, endpoint);

    expect(postRes.statusCode).toBe(409);
    expect(postRes.body).toContain('changed after it was opened');
    expect(submissionStore.listPendingForEndpoint(ENDPOINT_ID)).toEqual([]);
  });

  it('rechecks after async sealing and refuses a pair changed just before insert', async () => {
    const db = buildDb();
    const submissionStore = createReceptionFormSubmissionStore(db);
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    const exactBinding = binding(config, recipe());
    let currentConfig = config;
    let resolveCalls = 0;
    const resolvePair = (input: {
      readonly form_config: IntakeFormConfig;
    }): ReceptionIntakeRecipePairResolution => {
      resolveCalls += 1;
      const result: ReceptionIntakeRecipePairResolution =
        input.form_config.display_name === config.display_name
        ? { kind: 'ready', binding: exactBinding, renders_response: false }
        : { kind: 'stale' };
      if (resolveCalls === 2) {
        currentConfig = { ...config, display_name: 'Changed during sealing' };
      }
      return result;
    };
    const mutableRegistry = () => ({
      findById: (endpointId: string) => endpointId === ENDPOINT_ID
        ? { metadata: currentConfig }
        : null,
    });
    const getHandler = createIntakeFormPacketHandler({
      getStore: () => mutableRegistry() as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: resolvePair,
      now: () => NOW,
    });
    const getRes = fakeRes();
    await getHandler(fakeReq('GET'), getRes, endpoint);
    const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
    expect(nonce).toBeTruthy();

    const submitHandler = createIntakeFormSubmitHandler({
      getStore: () => mutableRegistry() as never,
      getSubmissionStore: () => submissionStore,
      getFormNonceStore: () => nonceStore,
      getFormSubmissionPiiKey: () => new Uint8Array(32).fill(0x6e),
      auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
      resolveRecipePair: resolvePair,
      coordinatePairedRun: async () => ({ kind: 'refused' }),
      now: () => NOW,
    });
    const body = new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: 'visitor@example.com',
      product: 'One brief',
      amount_minor: '12500',
      currency: 'usd',
      brief: 'Research this market.',
    }).toString();
    const postRes = fakeRes();
    await submitHandler(fakeReq('POST', body), postRes, endpoint);

    expect(resolveCalls).toBe(3);
    expect(postRes.statusCode).toBe(409);
    expect(submissionStore.listPendingForEndpoint(ENDPOINT_ID)).toEqual([]);
  });

  it('does not render a configured pair whose source snapshots are stale', async () => {
    const nonceStore = createInMemoryIntakeFormNonceStore();
    const config = formConfig();
    const handler = createIntakeFormPacketHandler({
      getStore: () => registry(config) as never,
      getFormNonceStore: () => nonceStore,
      resolveRecipePair: () => ({ kind: 'stale' }),
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET'), res, endpoint);

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('not currently accepting');
    expect(res.body).not.toContain('name="form_nonce"');
  });
});
