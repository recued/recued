/** D-151 P2 — `reception.compose.propose` RPC handler.
 *
 *  First production caller of `executeRecuedRequest`: intent-first
 *  Compose runs empty memory/enrichment consults, one `ai.synthesize`,
 *  captures the proposal via result sink, and returns the
 *  `ProposedEndpointConfig` instead of the durable plan. */

import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSE_CONTRACT_VERSION,
  REDACTED_USER_REQUEST_MARKER,
  RpcError,
  type ProposedEndpointConfig,
  type RecuedPlan,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { AISynthesizeAdapter, AISynthesizeRequest } from '@recued/middleware/primitives/index.js';
import {
  createReceptionComposePrimitiveRegistry,
  handleReceptionComposePropose,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const NOW = 1_765_000_000_000;

const buildProposal = (
  overrides: Partial<ProposedEndpointConfig> = {},
): ProposedEndpointConfig => ({
  version: COMPOSE_CONTRACT_VERSION,
  kind: 'intake_form',
  title: 'Baby shower RSVP',
  description: 'Collect RSVPs for the baby shower.',
  form_definition: {
    form_definition_id: 'fd_baby_shower_rsvp',
    fields: [
      {
        name: 'guest_name',
        type: 'text',
        label: 'Guest name',
        required: true,
        visitor_pii_class: 'visitor_name',
      },
      {
        name: 'guest_email',
        type: 'email',
        label: 'Email',
        required: true,
        visitor_pii_class: 'visitor_email',
      },
      {
        name: 'rsvp',
        type: 'enum',
        label: 'RSVP',
        required: true,
        values: ['Yes', 'No', 'Maybe'],
      },
    ],
    submit_button_label: 'Send RSVP',
    success_message: 'Thanks for responding.',
  },
  expiry_policy: { mode: 'rolling', rolling_days: 14 },
  exposure_intent: 'public_anonymous',
  source_path: 'intent',
  source_intent_text: 'placeholder',
  ai_trace_redacted: {
    version: COMPOSE_CONTRACT_VERSION,
    source_path: 'intent',
    detected_slots: { subject: 'baby shower' },
    selected_kind: 'intake_form',
    selection_reason_short: 'An RSVP form matches the request.',
  },
  ...overrides,
});

const buildDeps = (
  adapter: AISynthesizeAdapter,
  persisted: RecuedPlan[] = [],
): ReceptionRpcDeps => ({
  getStore: vi.fn() as never,
  getPreviewStore: vi.fn() as never,
  getPepper: vi.fn() as never,
  getShareBaseUrl: () => 'https://alice.recued.cloud',
  auditLog: {} as AuditLogStore,
  broadcast: vi.fn(),
  now: () => NOW,
  composePropose: {
    registry: createReceptionComposePrimitiveRegistry(adapter),
    persist: async (plan) => {
      persisted.push(plan);
    },
    now: () => NOW,
    mintRequestId: () => 'compose:req-1',
    mintId: (() => {
      let n = 0;
      return () => `compose-call-${++n}`;
    })(),
  },
});

describe('D-151 P2 — reception.compose.propose', () => {
  it('runs empty consults + one ai.synthesize through executeRecuedRequest and returns the captured config', async () => {
    const captured: AISynthesizeRequest[] = [];
    const persisted: RecuedPlan[] = [];
    const adapter: AISynthesizeAdapter = {
      synthesize: async (request) => {
        captured.push(request);
        return {
          response: JSON.stringify(buildProposal()),
          events: [],
          provider: 'openai',
          model_id: 'gpt-test',
          total_tokens: 123,
        };
      },
    };
    const deps = buildDeps(adapter, persisted);

    const result = await handleReceptionComposePropose(
      deps,
      { intent_text: '  Collect RSVPs for a baby shower  ' },
      { instance_id: 'client-A' },
    );

    expect(result.kind).toBe('intake_form');
    expect(result.source_path).toBe('intent');
    expect(result.source_intent_text).toBe('Collect RSVPs for a baby shower');
    expect(result.ai_trace_redacted?.source_path).toBe('intent');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      tier: 'fast',
      pool_policy: 'free_then_byok',
      max_tokens: 1_400,
    });
    expect(captured[0]!.packet).toMatchObject({
      task: 'reception_endpoint_proposal',
      intent_text: 'Collect RSVPs for a baby shower',
      allowed_kinds: ['reception_page', 'scheduling_link', 'intake_form'],
      disallowed_kinds: ['status_link', 'drop_link', 'approval_link'],
      safety_matrices: expect.arrayContaining([
        expect.objectContaining({ template_ref: 'compose.intent.intake_form' }),
      ]),
    });
    expect(captured[0]!.packet).not.toHaveProperty('warehouse_rows');

    // D-210 WS2 — an unconstrained composed intake defaults to LOG-ONLY, so its
    // safety matrix must name NO `processing_target` at all. Asserted by key
    // absence rather than by `objectContaining`, which cannot distinguish "the
    // key is gone" from "the key is there holding `undefined`" — and only the
    // former is what the model is handed.
    const intakeMatrix = (
      captured[0]!.packet as { safety_matrices: ReadonlyArray<{ template_ref: string }> }
    ).safety_matrices.find((m) => m.template_ref === 'compose.intent.intake_form');
    expect(intakeMatrix).toBeDefined();
    expect(Object.hasOwn(intakeMatrix as object, 'processing_target')).toBe(false);

    // D-210 Phase C — and NO `notification_defaults`, anywhere in the packet.
    // ⛔ This is not tidiness. The matrix is an AI *input*, so the field made an
    // author-time template state RUN-TIME attention ("notifies on submit, via
    // the webclient inbox"). After Phase C the D-157 gate holds every non-spam
    // submission regardless, `inbox_fanout_mode` picks the surface, and the
    // D-158 block owns the channels — so the claim was not merely unused, it
    // was FALSE. A stale claim told to a model on every compose call is the
    // same failure class as a stale doc told to an author.
    const packet = captured[0]!.packet as {
      safety_matrices: ReadonlyArray<object>;
      template_catalog: ReadonlyArray<{ safety_matrix: object }>;
    };
    for (const m of packet.safety_matrices) {
      expect(Object.hasOwn(m, 'notification_defaults')).toBe(false);
    }
    // The catalog carries a SECOND copy of every matrix — a re-add there would
    // reach the model just as surely.
    for (const t of packet.template_catalog) {
      expect(Object.hasOwn(t.safety_matrix, 'notification_defaults')).toBe(false);
    }

    expect(persisted).toHaveLength(1);
    const plan = persisted[0]!;
    expect(plan.status).toBe('completed');
    expect(plan.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    expect(plan.omitted_context).toEqual([
      {
        source_ref: 'warehouse.*',
        reason_code: 'privacy_class',
        reason_detail: 'compose_intent_proposal_excludes_warehouse_context',
        content_stored: false,
      },
    ]);
    expect(plan.primitive_calls.map((call) => call.primitive)).toEqual([
      'memory.recall',
      'enrichment.lookup',
      'ai.synthesize',
    ]);
    expect(plan.primitive_calls.filter((call) => call.primitive === 'ai.synthesize')).toHaveLength(1);
  });

  it('keeps the compose-preview capacity fallback fail-closed when real deps are absent', async () => {
    const adapter: AISynthesizeAdapter = {
      synthesize: async () => ({
        response: JSON.stringify(buildProposal()),
        events: [],
        provider: 'openai',
        model_id: 'gpt-test',
      }),
    };
    const registry = createReceptionComposePrimitiveRegistry(adapter);

    const result = await registry.get('capacity_spec').execute(
      {
        spec: {
          capacities: [{ kind: 'bridge_online' }],
          remediations: {
            bridge_online: {
              action: 'show_bridge_install_prompt',
              user_facing_copy: 'Install the bridge.',
            },
          },
        },
      },
      {
        run_id: 'compose-preview-capacity',
        now: () => NOW,
        mint_call_id: () => 'compose-capacity-call-1',
      },
    );

    expect(result.call.status).toBe('capacity_gap');
    expect(result.result.walk_result.ok).toBe(false);
    if (!result.result.walk_result.ok) {
      expect(result.result.walk_result.gap.kind).toBe('bridge_online');
    }
  });

  it('uses the catalog booking matrix for a template-first source_template_ref', async () => {
    const adapter: AISynthesizeAdapter = {
      synthesize: async () => ({
        response: JSON.stringify(
          buildProposal({
            kind: 'scheduling_link',
            title: 'Book a meeting',
            form_definition: undefined,
            scheduling: {
              duration_options_minutes: [30],
              available_window_definition: {
                tz: 'America/Los_Angeles',
                explicit_windows: [
                  { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
                ],
              },
              required_visitor_fields: {
                phone: 'required',
              },
            },
            source_template_ref: 'app/recued-core/booking',
          }),
        ),
        events: [],
        provider: 'openai',
        model_id: 'gpt-test',
      }),
    };

    await expect(
      handleReceptionComposePropose(
        buildDeps(adapter),
        { intent_text: 'Set up a booking link' },
        { instance_id: 'client-A' },
      ),
    ).rejects.toMatchObject({
      code: 'compose_compile_error',
      status: 422,
      details: {
        kind: 'safety_matrix_violation',
        template_ref: 'app/recued-core/booking',
        violation: expect.stringContaining('visitor phone'),
      },
    });
  });

  it('fails closed when a source_template_ref is unknown instead of falling back by kind', async () => {
    const persisted: RecuedPlan[] = [];
    const adapter: AISynthesizeAdapter = {
      synthesize: async () => ({
        response: JSON.stringify(
          buildProposal({
            source_template_ref: 'app/recued-core/unknown-template',
          }),
        ),
        events: [],
        provider: 'openai',
        model_id: 'gpt-test',
      }),
    };

    await expect(
      handleReceptionComposePropose(
        buildDeps(adapter, persisted),
        { intent_text: 'Collect RSVPs' },
        { instance_id: 'client-A' },
      ),
    ).rejects.toMatchObject({
      code: 'compose_proposal_invalid',
      status: 422,
      details: { source_template_ref: 'app/recued-core/unknown-template' },
    });
    expect(persisted[0]?.status).toBe('cancelled_malformed_ai');
    expect(persisted[0]?.failure_class).toBe('synthesis');
  });

  it('keeps intent-first proposals on the kind-default matrix when no source_template_ref is present', async () => {
    const persisted: RecuedPlan[] = [];
    const adapter: AISynthesizeAdapter = {
      synthesize: async () => ({
        response: JSON.stringify(
          buildProposal({
            form_definition: {
              form_definition_id: 'fd_open_house',
              fields: [
                {
                  name: 'guest_name',
                  type: 'text',
                  label: 'Guest name',
                  required: true,
                  visitor_pii_class: 'visitor_name',
                },
                {
                  name: 'guest_email',
                  type: 'email',
                  label: 'Email',
                  required: true,
                  visitor_pii_class: 'visitor_email',
                },
                {
                  name: 'guest_count',
                  type: 'number',
                  label: 'Guest count',
                  required: false,
                },
              ],
            },
          }),
        ),
        events: [],
        provider: 'openai',
        model_id: 'gpt-test',
      }),
    };

    const result = await handleReceptionComposePropose(
      buildDeps(adapter, persisted),
      { intent_text: 'Collect open house RSVPs' },
      { instance_id: 'client-A' },
    );

    expect(result.source_template_ref).toBeUndefined();
    expect(result.form_definition?.fields.map((field) => field.name)).toContain('guest_count');
    expect(persisted[0]?.status).toBe('completed');
  });

  it('rejects status_link proposals from the intent path at v1.0 and persists a cancelled plan', async () => {
    const persisted: RecuedPlan[] = [];
    const adapter: AISynthesizeAdapter = {
      synthesize: async () => ({
        response: JSON.stringify(
          buildProposal({
            kind: 'status_link',
            status_projection: {
              projection_kind: 'commitment_summary',
              source_ref: { kind: 'data.commitment', commitment_id: 'commitment-1' },
            },
            expiry_policy: { mode: 'rolling', rolling_days: 7 },
          }),
        ),
        events: [],
        provider: 'openai',
        model_id: 'gpt-test',
      }),
    };

    await expect(
      handleReceptionComposePropose(
        buildDeps(adapter, persisted),
        { intent_text: 'Share task status' },
        { instance_id: 'client-A' },
      ),
    ).rejects.toMatchObject({
      code: 'compose_proposal_invalid',
      status: 422,
    } satisfies Partial<RpcError>);
    expect(persisted[0]?.status).toBe('cancelled_malformed_ai');
    expect(persisted[0]?.failure_class).toBe('synthesis');
  });

  it('surfaces safety-matrix compile failures as compose_compile_error', async () => {
    const adapter: AISynthesizeAdapter = {
      synthesize: async () => ({
        response: JSON.stringify(
          buildProposal({
            form_definition: {
              form_definition_id: 'fd_bad',
              fields: [
                {
                  name: 'password',
                  type: 'password',
                  label: 'Password',
                  required: true,
                },
              ],
            },
          }),
        ),
        events: [],
        provider: 'openai',
        model_id: 'gpt-test',
      }),
    };

    await expect(
      handleReceptionComposePropose(
        buildDeps(adapter),
        { intent_text: 'Collect RSVPs' },
        { instance_id: 'client-A' },
      ),
    ).rejects.toMatchObject({
      code: 'compose_compile_error',
      status: 422,
    } satisfies Partial<RpcError>);
  });

  it('returns a typed unavailable error when the compose proposal substrate is not wired', async () => {
    await expect(
      handleReceptionComposePropose(
        { ...buildDeps({ synthesize: vi.fn() }), composePropose: undefined },
        { intent_text: 'Collect RSVPs' },
        { instance_id: 'client-A' },
      ),
    ).rejects.toMatchObject({
      code: 'compose_ai_unavailable',
      status: 503,
    } satisfies Partial<RpcError>);
  });
});
