/** D-207 slice 1c — THE DOOR IS HUNG.
 *
 *  The prior session BUILT the door — `deriveRecipeCapability`, `mintDoorContract`,
 *  `buildReceptionContractSnapshot`, `bindReceptionDoor`, `createReceptionRecipeRunner` —
 *  and every one of those modules was tested. None of them was CALLED. Nothing wrote
 *  `pair.contract_id`, no handler reached the runner, and the bind rpc minted nothing. A
 *  public form still ran exactly what D-200 shipped.
 *
 *  This file tests the COMPOSITION, which is the only thing that was missing: does the rpc
 *  the owner actually calls mint a door, and does the submit the visitor actually makes run
 *  through it? Every module test in this decision could stay green while the answer to both
 *  was no.
 *
 *  ## The acceptance, in one line
 *
 *  A LEAD-CAPTURE recipe — no Stripe, no offer, no payment code anywhere in its path — binds
 *  to a public intake form and runs gated on submit. That is the whole of D-207: D-200's
 *  door could only ever open for a recipe shaped like a payment, because its safety WAS its
 *  narrowness. This one opens for any recipe whose authority can be honestly described.
 *
 *  Spec: D-207 §5.1 / §5.2 / §5.3. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type {
  ContractDefinition,
  IntakeFormConfig,
  RecipeDefinition,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';

import {
  handleReceptionIntakeRecipePairBind,
  handleReceptionIntakeRecipePairClear,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import {
  resolveReceptionDoorContractId,
  type ReceptionDoorBindDeps,
} from '../reception-door-bind.js';
import { composeReceptionRecipeRunnerAdapter } from '../reception-recipe-runner-adapter.js';
import type { ReceptionRecipeRunner } from '../reception-recipe-runner.js';
import { sealFormSubmissionField } from '../ports/reception/form-pii.js';
import type { RecipeStore } from '../recipe-store.js';
import { createPreviewHashStore } from '../ports/reception/preview-hash.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { FormSubmissionStore } from '../storage/reception-form-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-lead-capture';
const FORM_DEFINITION_ID = 'lead-capture-v1';
const RECIPE_ID = 'lead-capture-to-crm';
const CALLER = { instance_id: 'paired-owner-client' };
const PII_KEY = new Uint8Array(32).fill(7);

/** A public intake form. Nothing about it is commerce — no price field, no currency. */
const formConfig = (): IntakeFormConfig => ({
  display_name: 'Get in touch',
  success_message: 'Thanks — we will be in touch.',
  form_definition: {
    form_definition_id: FORM_DEFINITION_ID,
    fields: [
      { name: 'company', type: 'text', label: 'Company', required: true },
      { name: 'note', type: 'textarea', label: 'How can we help?', required: true },
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

const recipe = (
  steps: Record<string, unknown>[],
  version = 1,
  variables: Record<string, unknown> = {},
): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version,
  ttl: 300,
  metadata: {
    name: 'Lead capture → CRM',
    description: 'Files a public enquiry as a CRM contact.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables,
  prefetch_steps: [],
  steps,
  output: { render: [] },
} as unknown as RecipeDefinition);

/** The acceptance recipe. One op, and it is not a payment. */
const LEAD_CAPTURE_STEPS = [
  { id: 'file_lead', op: 'core.crm.contact.create' },
];
const CRM_VARIABLES = {
  crm: { type: 'connection', label: 'CRM account', default: '' },
};

const buildAuditLog = (): { auditLog: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return {
    rows,
    auditLog: {
      logActivity: async (entry: ActivityEntry) => { rows.push(entry); },
    } as unknown as AuditLogStore,
  };
};

const harness = () => {
  // ⚠ The clock MOVES. A frozen clock made two different writes stamp the same `updated_at`
  // and hid a real bug: the door mint used to bump the pair's `updated_at` — the BINDING's
  // concurrency token — so the bind's own post-write currency check saw a "changed" pair and
  // 409'd. Under a constant clock the two stamps coincided and every assertion passed. A
  // fixture whose values collide cannot catch a field-confusion bug.
  let clock = NOW;
  const now = () => (clock += 1);

  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const endpoints = createPublicEndpointRegistryStore(db);
  // The REAL pair store — so `setContractId` actually persists and the dispatch hop
  // (`reception_id → pair → contract_id`) is exercised against SQLite, not a map.
  const pairs = createReceptionIntakeRecipePairStore(db);
  const { auditLog, rows } = buildAuditLog();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  const savedRecipes = new Map<string, RecipeDefinition>();
  savedRecipes.set(RECIPE_ID, recipe(LEAD_CAPTURE_STEPS, 1, CRM_VARIABLES));

  endpoints.create({
    endpoint_id: ENDPOINT_ID,
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: FORM_DEFINITION_ID,
      },
    },
    bearer_secret_hmac: Buffer.alloc(32, 0x44),
    created_at: NOW - 1_000,
    created_by_client_id: CALLER.instance_id,
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1_000,
    metadata: formConfig() as unknown as Readonly<Record<string, unknown>>,
  });

  // The contract substrate, faked at the IO boundary only — the mint / diff / consent logic
  // under test is the real `bindReceptionDoor`.
  const definitions = new Map<string, ContractDefinition>();
  const grants: { contract_id: string; key: string }[] = [];
  let seq = 0;
  const doorBindDeps: ReceptionDoorBindDeps = {
    pairStore: pairs,
    definitionStore: {
      mint: (i: Record<string, unknown>) => {
        const d = {
          contract_id: `door_${++seq}`,
          status: 'active',
          minted_at: NOW,
          ...i,
        } as unknown as ContractDefinition;
        definitions.set(d.contract_id, d);
        return d;
      },
      get: (id: string) => definitions.get(id) ?? null,
      revoke: (id: string) => {
        const d = definitions.get(id);
        if (!d) return null;
        const revoked = { ...d, revoked_at: NOW } as ContractDefinition;
        definitions.set(id, revoked);
        return revoked;
      },
    } as unknown as ContractDefinitionStore,
    grantEntryStore: {
      set: (contract_id: string, key: string) => { grants.push({ contract_id, key }); },
    } as unknown as ContractGrantEntryStore,
    now,
    resolveConfig: () => ({ crm: 'crm-primary' }),
    resolveDoorRecipe: (input) => ({
      ok: true,
      recipe: {
        ...input,
        steps: input.steps.map((step) => 'op' in step && step.op === 'core.crm.contact.create'
          ? {
              id: step.id,
              ingredient: 'crm-catalog',
              connection: '{{config.crm}}',
              input: {
                operation: 'contact.create',
                args: 'args' in step ? step.args ?? {} : {},
              },
            }
          : step),
      },
    }),
    resolveOp: (slug, operation) =>
      slug === 'crm-catalog' && operation === 'contact.create'
        ? ['core.crm.contact.create']
        : [],
    resolveIngredientKind: () => 'connection',
  };

  const deps: ReceptionRpcDeps = {
    getStore: () => endpoints,
    getPreviewStore: () => createPreviewHashStore(),
    getPepper: () => Buffer.alloc(32, 0x55),
    getShareBaseUrl: () => 'https://owner.example',
    getIntakeRecipePairStore: () => pairs,
    getRecipeStore: () => ({
      get: (id: string) => savedRecipes.get(id) ?? null,
    }) as RecipeStore,
    getDoorBindDeps: () => doorBindDeps,
    auditLog,
    broadcast: (e) => broadcasts.push(e),
    now,
  };

  return { db, deps, pairs, definitions, grants, rows, broadcasts, savedRecipes };
};

const bind = (h: ReturnType<typeof harness>, opts: {
  confirm?: boolean;
  expected_updated_at?: number | null;
} = {}) =>
  handleReceptionIntakeRecipePairBind(
    h.deps,
    {
      endpoint_id: ENDPOINT_ID,
      recipe_id: RECIPE_ID,
      expected_updated_at: opts.expected_updated_at ?? null,
      ...(opts.confirm === undefined ? {} : { confirm_capability: opts.confirm }),
    },
    CALLER,
  );

// ────────────────────────────────────────────────────────────────────────────────────────
// The bind rpc mints the door — the hop that did not exist
// ────────────────────────────────────────────────────────────────────────────────────────

describe('D-207 slice 1c — the bind rpc HANGS the door', () => {
  it('ACCEPTANCE: a lead-capture recipe (no payment code) binds to a public form and gets a door', async () => {
    const h = harness();

    // The first bind is the consent moment: this form could not reach ANY op before, so
    // every op in the closure is `added`. The owner is shown the list — that list IS the
    // prompt — and nothing is minted until they accept.
    const first = await bind(h);
    expect(first.door).toEqual({
      status: 'needs_consent',
      added: [
        'connection:crm-primary',
        'core.crm.contact.create',
        'ingredient:crm-catalog',
      ],
      removed: [],
      operation_ids: ['core.crm.contact.create'],
    });
    // And until they do, the door is SHUT. Not "open pending" — shut: with no contract_id a
    // dispatch floors to PUBLIC_CONTRACT_ID, which grants nothing.
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)?.contract_id).toBeNull();
    expect(h.definitions.size).toBe(0);

    const confirmed = await bind(h, {
      confirm: true,
      expected_updated_at: first.pair.updated_at,
    });
    expect(confirmed.door).toMatchObject({
      status: 'bound',
      contract_id: 'door_1',
      operation_ids: ['core.crm.contact.create'],
      unchanged: false,
    });

    // The pair now carries the door — this is the ONLY route from a visitor's dispatch back
    // to its authority, because `mint()` generates the id and it cannot be re-derived.
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)?.contract_id).toBe('door_1');
    expect(resolveReceptionDoorContractId(ENDPOINT_ID, { pairStore: h.pairs })).toBe('door_1');

    // The grant rows are what the Gateway will actually read. No grant, no run.
    expect(h.grants.map((g) => g.key)).toContain('core.crm.contact.create');

    // No payment code anywhere in this path.
    const minted = h.definitions.get('door_1');
    expect(minted?.scope.connection_names).toEqual(['crm-primary']);
    expect(JSON.stringify(minted)).not.toMatch(/stripe|checkout|offer|payment/i);
  });

  it('the mint is AUDITED even when the pair itself did not move', async () => {
    const h = harness();
    const first = await bind(h);
    const before = h.rows.length;

    // The confirm re-sends the identical recipe, so the PAIR is `unchanged` — and this is
    // the normal consent flow, not an edge case. Auditing only on a pair change would leave
    // the one write that opened this form to the internet with no audit row at all.
    const confirmed = await bind(h, {
      confirm: true,
      expected_updated_at: first.pair.updated_at,
    });
    expect(confirmed.outcome).toBe('unchanged');
    expect(h.rows.length).toBeGreaterThan(before);
    expect(h.rows.at(-1)?.detail).toContain('door=bound');
    expect(h.rows.at(-1)?.detail).toContain('contract_id=door_1');
  });

  it('a re-bind that changes nothing does NOT re-mint, and does not re-prompt', async () => {
    const h = harness();
    const first = await bind(h);
    const bound = await bind(h, { confirm: true, expected_updated_at: first.pair.updated_at });
    expect(bound.door).toMatchObject({ status: 'bound', unchanged: false });

    const again = await bind(h, { expected_updated_at: bound.pair.updated_at });
    // No consent prompt (nothing widened) and no new contract. A prompt that fires on every
    // cosmetic re-bind trains the owner to click through without reading.
    expect(again.door).toMatchObject({ status: 'bound', contract_id: 'door_1', unchanged: true });
    expect(h.definitions.size).toBe(1);
  });

  it('WIDENING asks again; the door is not silently re-minted with the new op', async () => {
    const h = harness();
    const first = await bind(h);
    const bound = await bind(h, { confirm: true, expected_updated_at: first.pair.updated_at });

    // The owner edits the recipe: it now also SENDS MAIL to the lead. That is new authority
    // handed to the anonymous public, and it must be consented to by name.
    h.savedRecipes.set(RECIPE_ID, recipe(
      [...LEAD_CAPTURE_STEPS, { id: 'reply', op: 'core.mail.send' }],
      2,
      CRM_VARIABLES,
    ));

    const widened = await bind(h, { expected_updated_at: bound.pair.updated_at });
    expect(widened.door).toMatchObject({
      status: 'needs_consent',
      added: ['core.mail.send'],
    });
    // Still the OLD door until they accept. The form keeps working; it just cannot send mail.
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)?.contract_id).toBe('door_1');
  });

  it('NARROWING does not ask — removing an op is already safe', async () => {
    const h = harness();
    const first = await bind(h);
    const bound = await bind(h, { confirm: true, expected_updated_at: first.pair.updated_at });

    h.savedRecipes.set(RECIPE_ID, recipe([{ id: 'nothing', transform: 'coalesce', values: [1] }], 2));
    const narrowed = await bind(h, { expected_updated_at: bound.pair.updated_at });

    // Re-minted (the closure moved) but never PROMPTED — the public can do strictly less.
    expect(narrowed.door).toMatchObject({ status: 'bound', unchanged: false, operation_ids: [] });
    expect(narrowed.door.status === 'bound' && narrowed.door.contract_id).toBe('door_2');
  });

  it('a recipe whose dispatch is not knowable is REFUSED at bind — never at fire', async () => {
    const h = harness();
    // `run-ingredient` chooses its target at runtime, so no honest closure exists. Admitting
    // it would produce a public form that looks live and hard-denies every submission, with
    // the VISITOR eating a failure the owner could have been told about here. This is the
    // kernel recipe's real shape — a templated `ingredient` over a declared config var.
    h.savedRecipes.set(RECIPE_ID, recipe(
      [{ id: 'dyn', ingredient: '{{config.ingredient_slug}}', input: '{{config.input}}' }],
      1,
      {
        ingredient_slug: null,
        input: { label: 'Ingredient input', type: 'json', default: {} },
      },
    ));

    const refused = await bind(h);
    expect(refused.door).toMatchObject({ status: 'refused', reason: 'dynamic_dispatch', step_id: 'dyn' });
    expect(h.definitions.size).toBe(0);
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)?.contract_id).toBeNull();
  });

  it('a server that cannot mint a door REFUSES the bind rather than saving a dead form', async () => {
    const h = harness();
    const deps: ReceptionRpcDeps = { ...h.deps };
    delete (deps as { getDoorBindDeps?: unknown }).getDoorBindDeps;

    await expect(handleReceptionIntakeRecipePairBind(
      deps,
      { endpoint_id: ENDPOINT_ID, recipe_id: RECIPE_ID, expected_updated_at: null },
      CALLER,
    )).rejects.toMatchObject({ code: 'not_configured', status: 503 });

    // Nothing written. The alternative — a saved pair with no door — is a public form that
    // looks live and kills every submission.
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)).toBeNull();
  });

  it('clearing the pair RETIRES the door — a revoked door grants nothing', async () => {
    const h = harness();
    const first = await bind(h);
    const bound = await bind(h, { confirm: true, expected_updated_at: first.pair.updated_at });
    expect(h.definitions.get('door_1')).not.toHaveProperty('revoked_at');

    await handleReceptionIntakeRecipePairClear(
      h.deps,
      {
        endpoint_id: ENDPOINT_ID,
        expected_status: 'ready',
        expected_updated_at: bound.pair.updated_at,
        expected_pair_revision: bound.pair.binding.pair_revision,
      },
      CALLER,
    );

    expect(h.definitions.get('door_1')).toHaveProperty('revoked_at');
    expect(h.rows.at(-1)?.detail).toContain('door_retired=true');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// The submit path reaches the runner — the hop that did not exist
// ────────────────────────────────────────────────────────────────────────────────────────

describe('D-207 slice 1c — the visitor submit reaches the gated runner', () => {
  const submissionRow = async (overrides: Record<string, unknown> = {}) => {
    const sealed = await sealFormSubmissionField({
      key: PII_KEY,
      endpoint_id: ENDPOINT_ID,
      submission_id: 'sub_1',
      field: 'submission_blob',
      plaintext: JSON.stringify({
        visitor_email: 'lead@example.com',
        fields: { company: 'Acme', note: 'Please call' },
      }),
    });
    return {
      submission_id: 'sub_1',
      endpoint_id: ENDPOINT_ID,
      submission_blob_encrypted: sealed,
      ...overrides,
    };
  };

  const adapterHarness = async (
    outcome: Awaited<ReturnType<ReceptionRecipeRunner['run']>>,
    rowOverrides: Record<string, unknown> = {},
  ) => {
    const row = await submissionRow(rowOverrides);
    const run = vi.fn(async () => outcome);
    const adapter = composeReceptionRecipeRunnerAdapter({
      runner: { run } as unknown as ReceptionRecipeRunner,
      submissionStore: {
        findById: () => row,
      } as unknown as Pick<FormSubmissionStore, 'findById'>,
      getFormSubmissionPiiKey: () => PII_KEY,
    });
    return { adapter, run };
  };

  it('SOURCE-DERIVES the endpoint and the fields from the durable row, not the request', async () => {
    const { adapter, run } = await adapterHarness({ kind: 'completed', output: { render: [], sidebar: [] } });

    await adapter({
      submission_id: 'sub_1',
      // A crafted form_config cannot redirect the run: nothing here reaches the runner.
      form_config: formConfig(),
    });

    // The endpoint comes from the ROW — so a POST cannot point the run at another form's
    // door — and the fields come from the sealed blob, so it cannot substitute what was
    // persisted and audited.
    expect(run).toHaveBeenCalledWith({
      endpoint_id: ENDPOINT_ID,
      submission_id: 'sub_1',
      submission: { company: 'Acme', note: 'Please call' },
    });
  });

  it('a COMPLETED run is a success page; a HELD run is a success page; a FAILED run is not', async () => {
    // The recipe finished. Nothing is outstanding — the thank-you is TRUE.
    // D-207 slice 2 — `completed` now carries the run's resolved `output.render`
    // blocks (this recipe declares none, so they are empty and the page is the
    // plain thank-you it always was).
    const done = await adapterHarness({ kind: 'completed', output: { render: [], sidebar: [] } });
    await expect(done.adapter({ submission_id: 'sub_1', form_config: formConfig() }))
      .resolves.toEqual({ kind: 'completed', render: [] });

    // Parked at the D-157 gate. An anonymous actor is pinned to the `read` ceiling, so EVERY
    // write a public form performs lands here. The submission is durable and the owner will
    // review it: "we got it, we'll be in touch" is also TRUE.
    const held = await adapterHarness({ kind: 'held' });
    await expect(held.adapter({ submission_id: 'sub_1', form_config: formConfig() }))
      .resolves.toEqual({ kind: 'held' });

    // The visitor was promised something and is not getting it. They MUST be told.
    const failed = await adapterHarness({ kind: 'failed', errors: [new Error('nope')] });
    await expect(failed.adapter({ submission_id: 'sub_1', form_config: formConfig() }))
      .resolves.toEqual({ kind: 'refused' });
  });

  it('NO DOOR stands aside — it is not a success, and the caller must fall through', async () => {
    const { adapter } = await adapterHarness({ kind: 'no_door' });
    await expect(adapter({ submission_id: 'sub_1', form_config: formConfig() }))
      .resolves.toEqual({ kind: 'no_door' });
  });

  it('an unreadable blob REFUSES — it never runs the recipe on an empty submission', async () => {
    // A locked vault, a rotated key, a tampered ciphertext. Running the recipe anyway would
    // hand it a blank set of fields: a lead-capture would quietly file an empty contact and
    // the visitor would be thanked for it.
    const { adapter, run } = await adapterHarness(
      { kind: 'completed', output: { render: [], sidebar: [] } },
      { submission_blob_encrypted: 'not-a-valid-ciphertext' },
    );
    await expect(adapter({ submission_id: 'sub_1', form_config: formConfig() }))
      .resolves.toEqual({ kind: 'refused' });
    expect(run).not.toHaveBeenCalled();
  });
});
