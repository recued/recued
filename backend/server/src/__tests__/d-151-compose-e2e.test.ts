/** D-151 — Compose golden-scenario E2E conformance.
 *
 *  Drives the four named Compose templates through:
 *  reception.compose.propose -> compileProposedEndpointConfig ->
 *  reception.endpoint.preview_draft -> reception.endpoint.create.
 *  Only the leaf AI response is deterministic; compile/preview/create
 *  are the real handlers used by paired clients.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_TEMPLATE_SAFETY_MATRIX,
  COMPOSE_CONTRACT_VERSION,
  CONTACT_FORM_TEMPLATE_SAFETY_MATRIX,
  PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX,
  RSVP_TEMPLATE_SAFETY_MATRIX,
  compileProposedEndpointConfig,
  isCompileError,
  type ProposedEndpointConfig,
  type ReceptionEndpointCreateInput,
  type ReceptionEndpointPreviewInput,
  type ReceptionEndpointKind,
  type TemplateSafetyMatrix,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import type { AISynthesizeAdapter } from '@recued/middleware/primitives/index.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createPreviewHashStore,
  type PreviewHashStore,
} from '../ports/reception/preview-hash.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import {
  createReceptionComposePrimitiveRegistry,
  handleReceptionComposePropose,
  handleReceptionEndpointCreate,
  handleReceptionEndpointPreviewDraft,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const NOW = Date.UTC(2026, 5, 2, 12, 0, 0);
const CALLER = { instance_id: 'client-A' };

interface ComposeScenario {
  readonly name: string;
  readonly intent_text: string;
  readonly template_ref: string;
  readonly matrix: TemplateSafetyMatrix;
  readonly expected_kind: ReceptionEndpointKind;
  readonly proposed: ProposedEndpointConfig;
}

const baseProposal = (
  overrides: Partial<ProposedEndpointConfig> &
    Pick<ProposedEndpointConfig, 'kind' | 'title' | 'source_template_ref'>,
): ProposedEndpointConfig => ({
  version: COMPOSE_CONTRACT_VERSION,
  description: 'Visitor-facing draft',
  expiry_policy: { mode: 'rolling', rolling_days: 30 },
  exposure_intent: 'public_anonymous',
  source_path: 'template',
  ...overrides,
});

const composeScenarios: ReadonlyArray<ComposeScenario> = [
  {
    name: 'booking',
    intent_text: 'Create a booking link for 30 and 60 minute meetings',
    template_ref: 'app/recued-core/booking',
    matrix: BOOKING_TEMPLATE_SAFETY_MATRIX,
    expected_kind: 'scheduling_link',
    proposed: baseProposal({
      kind: 'scheduling_link',
      title: 'Book a meeting',
      source_template_ref: 'app/recued-core/booking',
      expiry_policy: { mode: 'rolling', rolling_days: 90 },
      scheduling: {
        duration_options_minutes: [30, 60],
        available_window_definition: {
          tz: 'America/Los_Angeles',
          explicit_windows: [
            { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
          ],
        },
      },
    }),
  },
  {
    name: 'rsvp',
    intent_text: 'Collect RSVPs for a baby shower',
    template_ref: 'app/recued-core/rsvp',
    matrix: RSVP_TEMPLATE_SAFETY_MATRIX,
    expected_kind: 'intake_form',
    proposed: baseProposal({
      kind: 'intake_form',
      title: 'Baby shower RSVP',
      source_template_ref: 'app/recued-core/rsvp',
      expiry_policy: { mode: 'rolling', rolling_days: 14 },
      form_definition: {
        form_definition_id: 'fd_baby_shower_rsvp',
        submit_button_label: 'Send RSVP',
        success_message: 'Thanks for responding.',
        fields: [
          {
            name: 'guest_name',
            type: 'text',
            label: 'Guest name',
            required: true,
            visitor_pii_class: 'visitor_name',
          },
          {
            name: 'email',
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
            values: ['yes', 'no', 'maybe'],
          },
          {
            name: 'dietary_notes',
            type: 'textarea',
            label: 'Dietary notes',
            required: false,
          },
        ],
      },
    }),
  },
  {
    name: 'photo-share',
    intent_text: 'Create a page where guests can find the shared photo album',
    template_ref: 'app/recued-core/photo-share',
    matrix: PHOTO_SHARE_TEMPLATE_SAFETY_MATRIX,
    expected_kind: 'reception_page',
    proposed: baseProposal({
      kind: 'reception_page',
      title: 'Share photos',
      description: 'Album links and viewing details.',
      source_template_ref: 'app/recued-core/photo-share',
      page_layout: {
        display_overrides: {
          tagline: 'Album links and viewing details.',
          tz_label: 'Pacific time',
          preferred_contact_methods: ['email'],
        },
        sections_enabled: {
          contact_card: true,
          contact_methods: true,
          custom_links: true,
        },
        custom_links: [
          { label: 'Photo album', url: 'https://photos.example.test/album' },
        ],
      },
    }),
  },
  {
    name: 'contact-form',
    intent_text: 'Create a contact form for project inquiries',
    template_ref: 'app/recued-core/contact-form',
    matrix: CONTACT_FORM_TEMPLATE_SAFETY_MATRIX,
    expected_kind: 'intake_form',
    proposed: baseProposal({
      kind: 'intake_form',
      title: 'Contact me',
      source_template_ref: 'app/recued-core/contact-form',
      form_definition: {
        form_definition_id: 'fd_contact_form',
        submit_button_label: 'Send message',
        success_message: 'Thanks, I will reply soon.',
        fields: [
          {
            name: 'full_name',
            type: 'text',
            label: 'Full name',
            required: true,
            visitor_pii_class: 'visitor_name',
          },
          {
            name: 'email',
            type: 'email',
            label: 'Email',
            required: true,
            visitor_pii_class: 'visitor_email',
          },
          {
            name: 'topic',
            type: 'enum',
            label: 'Topic',
            required: true,
            values: ['question', 'project', 'other'],
          },
          {
            name: 'message',
            type: 'textarea',
            label: 'Message',
            required: true,
          },
        ],
      },
    }),
  },
] as const;

const buildDeps = (
  proposed: ProposedEndpointConfig,
): {
  readonly deps: ReceptionRpcDeps;
  readonly store: PublicEndpointRegistryStore;
  readonly previewStore: PreviewHashStore;
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const aiAdapter: AISynthesizeAdapter = {
    synthesize: async () => ({
      response: JSON.stringify(proposed),
      events: [],
      provider: 'openai',
      model_id: 'gpt-deterministic-test',
      total_tokens: 1,
    }),
  };
  let callId = 0;
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xd1)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: () => {},
    now: () => NOW,
    composePropose: {
      registry: createReceptionComposePrimitiveRegistry(aiAdapter),
      now: () => NOW,
      mintRequestId: () => 'compose:req-e2e',
      mintId: () => `compose-call-${++callId}`,
    },
  };
  return { deps, store, previewStore };
};

const expectCompiledCreateInput = (
  result: ReturnType<typeof compileProposedEndpointConfig>,
): ReceptionEndpointCreateInput => {
  expect(isCompileError(result)).toBe(false);
  if (isCompileError(result)) {
    throw new Error(`expected create input, got ${result.kind}`);
  }
  return result;
};

const previewInputFromCompiled = (
  compiled: ReceptionEndpointCreateInput,
): ReceptionEndpointPreviewInput => {
  if (compiled.expires_at === null) {
    throw new Error('D-151 golden fixtures should compile to bounded preview inputs');
  }
  return {
    kind: compiled.kind,
    packet_declaration: compiled.packet_declaration,
    ...(compiled.expires_at !== undefined ? { expires_at: compiled.expires_at } : {}),
    ...(compiled.metadata !== undefined ? { metadata: compiled.metadata } : {}),
  };
};

const persistedJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const proposeAndCompile = async (
  scenario: ComposeScenario,
): Promise<{
  readonly deps: ReceptionRpcDeps;
  readonly store: PublicEndpointRegistryStore;
  readonly proposed: ProposedEndpointConfig;
  readonly compiled: ReceptionEndpointCreateInput;
}> => {
  const { deps, store } = buildDeps(scenario.proposed);
  const proposed = await handleReceptionComposePropose(
    deps,
    { intent_text: scenario.intent_text },
    CALLER,
  );
  expect(proposed.source_template_ref).toBe(scenario.template_ref);

  const compiled = expectCompiledCreateInput(
    compileProposedEndpointConfig(proposed, scenario.matrix, { now: NOW }),
  );
  expect(compiled.kind).toBe(scenario.expected_kind);
  return { deps, store, proposed, compiled };
};

describe('D-151 — Compose golden-scenario E2E conformance', () => {
  it.each(composeScenarios)(
    '$name compiles, previews, and creates through the real reception chain',
    async (scenario) => {
      const { deps, store, compiled } = await proposeAndCompile(scenario);

      const previewInput = previewInputFromCompiled(compiled);
      const preview = await handleReceptionEndpointPreviewDraft(deps, previewInput, CALLER);
      expect(preview.preview_hash.length).toBeGreaterThan(0);

      const createInput: ReceptionEndpointCreateInput = {
        ...compiled,
        preview_hash: preview.preview_hash,
      };
      const created = await handleReceptionEndpointCreate(deps, createInput, CALLER);
      const row = store.findById(created.endpoint_id);

      expect(created.enabled).toBe(false);
      expect(row).toMatchObject({
        endpoint_id: created.endpoint_id,
        kind: compiled.kind,
        packet_declaration: compiled.packet_declaration,
        expires_at: compiled.expires_at,
        metadata: persistedJson(compiled.metadata),
        enabled: false,
        created_by_client_id: CALLER.instance_id,
      });
    },
  );

  it('rejects an over-collecting named-template variant as safety_matrix_violation', async () => {
    const overCollecting = baseProposal({
      kind: 'intake_form',
      title: 'Contact me',
      source_template_ref: 'app/recued-core/contact-form',
      form_definition: {
        form_definition_id: 'fd_bad_contact_form',
        fields: [
          {
            name: 'full_name',
            type: 'text',
            label: 'Full name',
            required: true,
            visitor_pii_class: 'visitor_name',
          },
          {
            name: 'email',
            type: 'email',
            label: 'Email',
            required: true,
            visitor_pii_class: 'visitor_email',
          },
          {
            name: 'address',
            type: 'textarea',
            label: 'Address',
            required: true,
            visitor_pii_class: 'visitor_address',
          },
        ],
      },
    });
    const { deps } = buildDeps(overCollecting);

    await expect(
      handleReceptionComposePropose(
        deps,
        { intent_text: 'Create a contact form that asks for an address' },
        CALLER,
      ),
    ).rejects.toMatchObject({
      code: 'compose_compile_error',
      status: 422,
      details: {
        kind: 'safety_matrix_violation',
        template_ref: 'app/recued-core/contact-form',
      },
    });
  });

  it('rejects create when the compiled config is tampered after preview', async () => {
    const scenario = composeScenarios[0]!;
    const { deps, compiled } = await proposeAndCompile(scenario);
    const preview = await handleReceptionEndpointPreviewDraft(
      deps,
      previewInputFromCompiled(compiled),
      CALLER,
    );

    await expect(
      handleReceptionEndpointCreate(
        deps,
        {
          ...compiled,
          metadata: {
            ...compiled.metadata,
            display_name: 'Tampered meeting title',
          },
          preview_hash: preview.preview_hash,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({
      code: 'preview_hash_mismatch',
    });
  });
});
