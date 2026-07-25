/** D-149 P12 § A.20.1 — Reception Launch Wizard integration test.
 *
 *  Acceptance (§ P12): "Launch Wizard creates 3 endpoints in <10min
 *  from fresh-install (CI integration test)." This drives the substrate
 *  planner end-to-end: `buildLaunchWizardPlan` → the reception_page
 *  singleton upsert + per-draft `preview_draft` → `create` — through the
 *  SAME live rpc handlers a paired client would call. On a fresh
 *  (empty) registry the wizard provisions exactly: the reception_page
 *  singleton + a scheduling_link + an intake_form (= 3 endpoints), and
 *  4 when the optional drop_link step is included.
 *
 *  The "<10min" goal is a UX target, not a CI assertion — what the test
 *  pins is that the plan is ONE drivable sequence with no manual
 *  intervention between steps. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import {
  buildLaunchWizardPlan,
  validateLaunchWizardInput,
  type DropLinkConfig,
  type IntakeFormConfig,
  type LaunchWizardInput,
  type ReceptionEndpointCreateInput,
  type ReceptionPageConfig,
  type SchedulingLinkConfig,
} from '@recued/contracts';
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
  handleReceptionEndpointCreate,
  handleReceptionEndpointPreviewDraft,
  handleReceptionPageUpsert,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const NOW = 1_700_000_000_000;
const CALLER = { instance_id: 'client_1' };

const buildAuditLog = (): AuditLogStore => {
  const rows: ActivityEntry[] = [];
  return {
    append: async () => {},
    listRecent: async () => [],
    listByRecipe: async () => [],
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => ({ entries: [], activities: [] }),
    size: async () => 0,
    clearAll: async () => {},
    listActivities: async () => rows.slice(),
    exportActivities: async () => rows.slice(),
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    logActivity: async (entry: ActivityEntry) => {
      rows.push(entry);
    },
  } as unknown as AuditLogStore;
};

const buildDeps = (): { deps: ReceptionRpcDeps; store: PublicEndpointRegistryStore } => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore: PreviewHashStore = createPreviewHashStore();
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xc1)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog: buildAuditLog(),
    broadcast: (_event: ReceptionBroadcastEvent) => {},
    now: () => NOW,
  };
  return { deps, store };
};

const goodReceptionPage: ReceptionPageConfig = {
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Reach me here',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: [],
  },
  sections_enabled: {},
  linked_endpoints: {},
};

const goodScheduling: SchedulingLinkConfig = {
  display_name: 'Mary Smith',
  duration_options_minutes: [30, 60],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
};

const goodIntake: IntakeFormConfig = {
  display_name: 'Mary Smith',
  form_definition: {
    form_definition_id: 'fd_client_inquiry_v1',
    fields: [{ name: 'your_name', type: 'text', label: 'Your name', required: true }],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
};

const goodDrop: DropLinkConfig = {
  display_name: 'Mary Smith',
  link_kind: 'repeated',
  size_cap_bytes: 10 * 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: { name: 'required', email: 'required', description: 'optional' },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
};

const wizardInput = (over: Partial<LaunchWizardInput> = {}): LaunchWizardInput => ({
  current_exposure_profile: 'public_webhooks_and_clients',
  reception_page: goodReceptionPage,
  scheduling_link: goodScheduling,
  intake_form: goodIntake,
  ...over,
});

/** Drive a wizard plan through the live rpc surface — the page upsert
 *  then a `preview_draft → create` round-trip per endpoint draft. */
const runWizardPlan = async (
  deps: ReceptionRpcDeps,
  input: LaunchWizardInput,
): Promise<void> => {
  const plan = buildLaunchWizardPlan(input, NOW);
  await handleReceptionPageUpsert(deps, plan.page_upsert, CALLER);
  for (const draft of plan.endpoint_drafts) {
    const previewInput = {
      kind: draft.kind,
      packet_declaration: draft.packet_declaration,
      metadata: draft.metadata,
      ...(draft.expires_at !== undefined ? { expires_at: draft.expires_at } : {}),
    };
    const preview = await handleReceptionEndpointPreviewDraft(deps, previewInput, CALLER);
    const createInput: ReceptionEndpointCreateInput = {
      ...previewInput,
      preview_hash: preview.preview_hash,
    };
    await handleReceptionEndpointCreate(deps, createInput, CALLER);
  }
};

describe('D-149 P12 § A.20.1 — Launch Wizard end-to-end (fresh install)', () => {
  it('the wizard input validates clean', () => {
    expect(validateLaunchWizardInput(wizardInput())).toEqual([]);
  });

  it('provisions exactly 3 endpoints from a fresh registry (page + scheduling + intake)', async () => {
    const { deps, store } = buildDeps();
    // Fresh install — registry is empty.
    expect(store.list({ include_revoked: true })).toHaveLength(0);
    expect(store.loadReceptionPageSingleton()).toBeNull();

    await runWizardPlan(deps, wizardInput());

    // The reception_page singleton is now configured.
    expect(store.loadReceptionPageSingleton()).not.toBeNull();
    // One scheduling_link + one intake_form created.
    expect(store.list({ kind: 'scheduling_link' })).toHaveLength(1);
    expect(store.list({ kind: 'intake_form' })).toHaveLength(1);
    // 3 endpoints total — the singleton + the two link-style rows.
    expect(store.list({ include_revoked: true })).toHaveLength(3);
  });

  it('every wizard-created endpoint is default-off (§ Must Hold I-1)', async () => {
    const { deps, store } = buildDeps();
    await runWizardPlan(deps, wizardInput());
    for (const ep of store.list({ kind: 'scheduling_link' })) {
      expect(ep.enabled).toBe(false);
    }
    for (const ep of store.list({ kind: 'intake_form' })) {
      expect(ep.enabled).toBe(false);
    }
  });

  it('provisions 4 endpoints when the optional drop_link step is included', async () => {
    const { deps, store } = buildDeps();
    await runWizardPlan(deps, wizardInput({ drop_link: goodDrop }));
    expect(store.list({ kind: 'drop_link' })).toHaveLength(1);
    expect(store.list({ include_revoked: true })).toHaveLength(4);
    // The drop_link endpoint carries a bounded expiry (30-day ceiling).
    const dropEp = store.list({ kind: 'drop_link' })[0]!;
    expect(dropEp.expires_at).toBe(NOW + goodDrop.expiry_days * 24 * 60 * 60 * 1000);
  });

  it('the scheduling + intake endpoints are long-lived (expires_at null)', async () => {
    const { deps, store } = buildDeps();
    await runWizardPlan(deps, wizardInput());
    expect(store.list({ kind: 'scheduling_link' })[0]!.expires_at).toBeNull();
    expect(store.list({ kind: 'intake_form' })[0]!.expires_at).toBeNull();
  });
});
