/** D-220 Slice A2c — the two `reception.endpoint.create` gates over an intake
 *  form's field set, plus the `preview_draft` advisory.
 *
 *  ## Why create is a gate at all
 *
 *  There is NO endpoint-update rpc — a form's config is immutable after create,
 *  so revoke-and-recreate is the only way to edit one. That makes `create` the
 *  single mutation point, and it is tractable in a way the reactive-arming path
 *  is not: at create there is no armed state to destroy, so a refusal costs the
 *  owner an action they had not completed rather than silently disarming
 *  something that worked.
 *
 *  ## The two gates, and the severity line between them
 *
 *  - **One id, one LIVE form.** `form_definition_id` is owner-typed free text
 *    with no uniqueness anywhere, and a `form_response.accepted` trigger filters
 *    on the id ALONE — so two live forms claiming one id both fire it, and the
 *    second form's differently-named answers read as nothing. Revoked endpoints
 *    are excluded on purpose: reusing the id after revoke IS the edit path.
 *  - **Does this form still feed what is armed on its id?** The reverse of the
 *    bind-time check. Only a `this_form`-scoped trigger with a REQUIRED-field
 *    breakage blocks; `all_forms` and `this_form_filtered` are advisory, because
 *    one recipe must not veto every future form and a narrower filter may never
 *    fire here at all.
 *
 *  Each gate is tested by the case it REFUSES *and* the case it PERMITS — a gate
 *  proven only by its refusal is indistinguishable from a blanket one.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RpcError,
  type IntakeFormConfig,
  type PacketDeclaration,
  type RecipeDefinition,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import { createPreviewHashStore } from '../ports/reception/preview-hash.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import {
  handleReceptionEndpointCreate,
  handleReceptionEndpointPreviewDraft,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { StoredRecipe } from '../types.js';

const NOW = 1_700_000_000_000;
const FORM_ID = 'job-intake-v1';
const CALLER = { instance_id: 'inst-a2c' };

const auditLog = (): { auditLog: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return {
    auditLog: {
      append: async () => {},
      logActivity: async (entry: ActivityEntry) => { rows.push(entry); },
      listActivities: async () => rows.slice(),
    } as unknown as AuditLogStore,
    rows,
  };
};

/** One armed reactive clone as it would sit in SQLite. `where` decides the scope
 *  the gate reads: exactly-this-form, this-form-plus-a-filter, or all forms. */
const armedRecipe = (input: {
  readonly recipe_id: string;
  readonly requires_form_fields?: unknown;
  readonly where?: Record<string, unknown>;
  readonly on?: string;
}): StoredRecipe => {
  const recipe: Record<string, unknown> = {
    recipe_id: input.recipe_id,
    version: 1,
    ttl: 0,
    metadata: {
      name: input.recipe_id,
      description: 'An armed reactive clone that reads named answers.',
      author: 'local',
      supported_platforms: [],
      ...(input.requires_form_fields === undefined
        ? {}
        : { requires_form_fields: input.requires_form_fields }),
    },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { render: [] },
    event_triggers: [{
      on: input.on ?? 'form_response.accepted',
      ...(input.where === undefined ? {} : { where: input.where }),
    }],
  };
  return {
    recipe_id: input.recipe_id,
    publisher_id: 'local',
    version: 1,
    recipe_hash: 'h',
    recipe_json: JSON.stringify(recipe),
    source: 'pair-sync',
    installed_at: NOW - 1_000,
    pack_slug: null,
  };
};

const buildEnv = (stored: StoredRecipe[] = [], withRecipeStore = true) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const { auditLog: log, rows } = auditLog();
  const rowsRef = [...stored];
  const recipeStore = {
    get: (id: string) => {
      const row = rowsRef.find((r) => r.recipe_id === id);
      return row === undefined ? null : (JSON.parse(row.recipe_json) as RecipeDefinition);
    },
    listStored: () => rowsRef.slice(),
  } as unknown as RecipeStore;
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xab)),
    getShareBaseUrl: () => 'https://owner.recued.cloud',
    auditLog: log,
    broadcast: () => {},
    now: () => NOW,
    ...(withRecipeStore ? { getRecipeStore: () => recipeStore } : {}),
  };
  return { deps, store, rows, rowsRef };
};

const decl = (form_definition_id = FORM_ID): PacketDeclaration => ({
  packet_kind: 'intake_form_packet',
  source_query_ref: { kind: 'reception_form_definition', form_definition_id },
});

const JOB_FIELDS: IntakeFormConfig['form_definition']['fields'] = [
  { name: 'item_description', type: 'textarea', label: 'What you brought in', required: true },
  { name: 'contact_name', type: 'text', label: 'Your name', required: false },
];

const config = (
  fields: IntakeFormConfig['form_definition']['fields'] = JOB_FIELDS,
  form_definition_id = FORM_ID,
): IntakeFormConfig => ({
  display_name: 'Drop-off',
  form_definition: { form_definition_id, fields },
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

const NEEDS_ITEM = [
  { name: 'item_description', type: 'textarea', required: true },
  { name: 'contact_name', type: 'text', required: false },
];

/** preview → create, the real two-step flow (create validates the preview hash). */
const publish = async (
  deps: ReceptionRpcDeps,
  cfg: IntakeFormConfig,
): Promise<{ endpoint_id: string }> => {
  const metadata = cfg as unknown as Record<string, unknown>;
  const packet_declaration = decl(cfg.form_definition.form_definition_id);
  const preview = await handleReceptionEndpointPreviewDraft(
    deps,
    { kind: 'intake_form', packet_declaration, metadata },
    CALLER,
  );
  return handleReceptionEndpointCreate(
    deps,
    {
      kind: 'intake_form',
      packet_declaration,
      metadata,
      preview_hash: preview.preview_hash,
    },
    CALLER,
  );
};

const refusal = async (fn: () => Promise<unknown>): Promise<RpcError> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError, got a resolved call');
};

// ────────────────────────────────────────────────────────────────
// Gate 3 — one id, one live form
// ────────────────────────────────────────────────────────────────

describe('D-220 A2c — a live form_definition_id cannot be claimed twice', () => {
  let env: ReturnType<typeof buildEnv>;
  beforeEach(() => { env = buildEnv(); });

  it('publishes the first form on an id', async () => {
    await expect(publish(env.deps, config())).resolves.toMatchObject({
      endpoint_id: expect.any(String) as unknown as string,
    });
  });

  it('⛔ refuses a SECOND live form claiming the same id', async () => {
    const first = await publish(env.deps, config());
    const error = await refusal(() => publish(env.deps, config()));
    expect(error.code).toBe('form_definition_id_already_live');
    expect(error.status).toBe(409);
    expect(error.details?.conflicting_endpoint_id).toBe(first.endpoint_id);
    // Only the first endpoint exists.
    expect(env.store.list().filter((e) => e.revoked_at === null)).toHaveLength(1);
  });

  it('PERMITS reuse after revoke — that is the only edit path a form has', async () => {
    const first = await publish(env.deps, config());
    env.store.revoke({ endpoint_id: first.endpoint_id, now: NOW + 1, reason: 'editing' });
    // The revoked row is STILL IN THE REGISTRY — the gate has to skip it on
    // purpose rather than inherit a list() default that happens to hide it.
    expect(env.store.list({ include_revoked: true })).toHaveLength(1);
    expect(env.store.list({ include_revoked: true })[0]!.revoked_at).not.toBeNull();
    // Same id, a changed field set: this is "editing the form", and it must work.
    await expect(publish(env.deps, config([
      ...JOB_FIELDS,
      { name: 'preferred_contact', type: 'text', label: 'How to reach you', required: false },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('PERMITS a different id alongside a live one', async () => {
    await publish(env.deps, config());
    await expect(publish(env.deps, config(JOB_FIELDS, 'other-form-v1')))
      .resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });
});

// ────────────────────────────────────────────────────────────────
// Gate 1 — does this form still feed the recipes armed on its id?
// ────────────────────────────────────────────────────────────────

describe('D-220 A2c — create refuses a form that breaks an armed recipe', () => {
  const armed = (over: Parameters<typeof armedRecipe>[0] = { recipe_id: 'open-job' }) =>
    armedRecipe({ requires_form_fields: NEEDS_ITEM, where: { form_definition_id: FORM_ID }, ...over });

  it('⛔ refuses when the form omits a REQUIRED answer the armed recipe reads', async () => {
    const env = buildEnv([armed()]);
    const error = await refusal(() => publish(env.deps, config([
      { name: 'what_they_brought', type: 'textarea', label: 'Item', required: true },
    ])));
    expect(error.code).toBe('form_contract_breaks_armed_recipe');
    expect(error.status).toBe(409);
    expect(error.message).toContain('open-job');
    expect(error.message).toContain('item_description');
    // Nothing created.
    expect(env.store.list()).toHaveLength(0);
  });

  it('PERMITS a form that satisfies the armed recipe', async () => {
    const env = buildEnv([armed()]);
    await expect(publish(env.deps, config())).resolves.toMatchObject({
      endpoint_id: expect.any(String) as unknown as string,
    });
  });

  it('PERMITS a form missing only an OPTIONAL declared answer', async () => {
    const env = buildEnv([armed()]);
    await expect(publish(env.deps, config([
      { name: 'item_description', type: 'textarea', label: 'Item', required: true },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('PERMITS a form breaking a recipe armed on a DIFFERENT id', async () => {
    const env = buildEnv([armed({
      recipe_id: 'open-job',
      where: { form_definition_id: 'some-other-form' },
    })]);
    await expect(publish(env.deps, config([
      { name: 'unrelated', type: 'text', label: 'Anything', required: false },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('PERMITS despite an ALL-FORMS armed recipe — one recipe must not veto every future form', async () => {
    // ⛔ THE severity line. An unscoped trigger with a required-field contract is
    // a contradiction for its author to resolve; refusing here would make every
    // subsequent form on the server unpublishable.
    const env = buildEnv([armedRecipe({
      recipe_id: 'reads-every-form',
      requires_form_fields: NEEDS_ITEM,
    })]);
    await expect(publish(env.deps, config([
      { name: 'unrelated', type: 'text', label: 'Anything', required: false },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('⛔ REFUSES despite a FILTERED armed recipe — an extra filter narrows, it does not exempt', async () => {
    // ⚠ Inverted after adversarial review (Codex, 2026-07-29): a runtime event
    // carries both routing fields, so a form-naming trigger fires with certainty
    // on the responses its filter matches.
    const env = buildEnv([armed({
      recipe_id: 'open-job',
      where: { form_definition_id: FORM_ID, endpoint_id: 'ep-somewhere-else' },
    })]);
    const error = await refusal(() => publish(env.deps, config([
      { name: 'unrelated', type: 'text', label: 'Anything', required: false },
    ])));
    expect(error.code).toBe('form_contract_breaks_armed_recipe');
    expect(env.store.list()).toHaveLength(0);
  });

  it('PERMITS when the armed recipe declares nothing — the pre-D-220 shape', async () => {
    const env = buildEnv([armedRecipe({
      recipe_id: 'undeclared',
      where: { form_definition_id: FORM_ID },
    })]);
    await expect(publish(env.deps, config([
      { name: 'unrelated', type: 'text', label: 'Anything', required: false },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('ignores a trigger that is not a form-response trigger', async () => {
    const env = buildEnv([armedRecipe({
      recipe_id: 'mail-watcher',
      requires_form_fields: NEEDS_ITEM,
      on: 'mail.received',
      where: { form_definition_id: FORM_ID },
    })]);
    await expect(publish(env.deps, config([
      { name: 'unrelated', type: 'text', label: 'Anything', required: false },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('skips a corrupt stored row rather than blocking the owner from publishing', async () => {
    const corrupt: StoredRecipe = { ...armed(), recipe_id: 'corrupt', recipe_json: '{not json' };
    const env = buildEnv([corrupt, armed()]);
    // The valid sibling still refuses — one bad row neither blocks nor blinds.
    const error = await refusal(() => publish(env.deps, config([
      { name: 'what_they_brought', type: 'textarea', label: 'Item', required: true },
    ])));
    expect(error.code).toBe('form_contract_breaks_armed_recipe');
  });

  it('publishes with no recipe store wired — there is nothing to conflict with', async () => {
    const env = buildEnv([], false);
    await expect(publish(env.deps, config([
      { name: 'unrelated', type: 'text', label: 'Anything', required: false },
    ]))).resolves.toMatchObject({ endpoint_id: expect.any(String) as unknown as string });
  });

  it('checks intake forms only — another kind is untouched by both gates', async () => {
    const env = buildEnv([armed()]);
    const packet_declaration: PacketDeclaration = {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    };
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'scheduling_link',
        packet_declaration,
        metadata: {
          display_name: 'Owner',
          duration_options_minutes: [30],
          available_window_definition: {
            tz: 'America/New_York',
            explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
          },
          required_visitor_fields: {
            name: 'required', email: 'required', topic: 'optional', phone: 'omit', notes: 'optional',
          },
          min_advance_notice_hours: 1,
          max_lead_time_days: 30,
          max_bookings_per_day: 0,
          on_booking: { create_calendar_event: true, create_commitment_entity: false },
        } as unknown as Record<string, unknown>,
      },
      CALLER,
    );
    // A scheduling link has no authored fields, so neither gate can apply.
    expect(preview.form_contract_advisories).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Gate 2 — the advisory, one step earlier
// ────────────────────────────────────────────────────────────────

describe('D-220 A2c — preview_draft reports what create would do', () => {
  const preview = (deps: ReceptionRpcDeps, cfg: IntakeFormConfig) =>
    handleReceptionEndpointPreviewDraft(
      deps,
      {
        kind: 'intake_form',
        packet_declaration: decl(cfg.form_definition.form_definition_id),
        metadata: cfg as unknown as Record<string, unknown>,
      },
      CALLER,
    );

  it('marks a blocking conflict blocks_create: true, agreeing with the gate', async () => {
    const env = buildEnv([armedRecipe({
      recipe_id: 'open-job',
      requires_form_fields: NEEDS_ITEM,
      where: { form_definition_id: FORM_ID },
    })]);
    const broken = config([
      { name: 'what_they_brought', type: 'textarea', label: 'Item', required: true },
    ]);
    const result = await preview(env.deps, broken);
    expect(result.form_contract_advisories).toHaveLength(1);
    expect(result.form_contract_advisories![0]).toMatchObject({
      recipe_id: 'open-job',
      scope: 'this_form',
      blocks_create: true,
    });
    // And create really does refuse — the advisory is not a guess about the gate.
    await expect(refusal(() => publish(env.deps, broken)))
      .resolves.toMatchObject({ code: 'form_contract_breaks_armed_recipe' });
  });

  it('reports an ALL-FORMS conflict as advisory — one recipe must not veto every future form', async () => {
    // Only `all_forms` is advisory now. Resolving it would mean comparing the
    // contract against every live form, and refusing on it would make each new
    // form unpublishable because one unscoped recipe wants a field.
    const env = buildEnv([
      armedRecipe({ recipe_id: 'reads-every-form', requires_form_fields: NEEDS_ITEM }),
    ]);
    const cfg = config([{ name: 'unrelated', type: 'text', label: 'Anything', required: false }]);
    const result = await preview(env.deps, cfg);
    expect(result.form_contract_advisories).toHaveLength(1);
    expect(result.form_contract_advisories![0]).toMatchObject({
      recipe_id: 'reads-every-form', scope: 'all_forms', blocks_create: false,
    });
    // ⛔ Advisory only: the publish still succeeds.
    await expect(publish(env.deps, cfg)).resolves.toMatchObject({
      endpoint_id: expect.any(String) as unknown as string,
    });
  });

  it('a FILTERED conflict is reported as blocks_create: true, agreeing with the gate', async () => {
    const env = buildEnv([armedRecipe({
      recipe_id: 'filtered',
      requires_form_fields: NEEDS_ITEM,
      where: { form_definition_id: FORM_ID, endpoint_id: 'ep-elsewhere' },
    })]);
    const cfg = config([{ name: 'unrelated', type: 'text', label: 'Anything', required: false }]);
    const result = await preview(env.deps, cfg);
    expect(result.form_contract_advisories![0]).toMatchObject({
      scope: 'this_form_filtered', blocks_create: true,
    });
  });

  it('omits the field entirely when nothing conflicts', async () => {
    const env = buildEnv([armedRecipe({
      recipe_id: 'open-job',
      requires_form_fields: NEEDS_ITEM,
      where: { form_definition_id: FORM_ID },
    })]);
    const result = await preview(env.deps, config());
    expect(result.form_contract_advisories).toBeUndefined();
  });
});
