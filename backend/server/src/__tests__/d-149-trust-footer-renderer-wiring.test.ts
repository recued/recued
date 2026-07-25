/** D-149 P12 § A.20.7 follow-on — Public Trust Footer renderer wiring.
 *
 *  P12 shipped `buildTrustFooter` as a pure substrate builder; this
 *  suite covers the follow-on leg that wires it into the six visitor
 *  renderers via the `trust-footer.ts` resolver. Covers:
 *
 *    - `buildReceptionTrustFooterFromToggle` — § A.20.7 default-on
 *      semantics (absent toggle ⇒ enabled), faithful pass-through to
 *      the contracts `buildTrustFooter`, per-mode copy.
 *    - `resolveReceptionTrustFooter` — reads the per-server toggle off
 *      the reception_page singleton (absent singleton ⇒ default-on).
 *    - All 6 visitor renderers emit a `<p class="rcp-trust-footer">`
 *      block when `trust_footer` is a non-null string, and omit it when
 *      `null` / absent.
 *    - The pre-escaped footer string is interpolated VERBATIM — a
 *      string already carrying `&#39;` is not double-encoded.
 *    - Placeholder renderers NEVER emit the trust footer — fresh-install
 *      / corrupt-config surfaces stay byte-identical (§ Must Hold I-1
 *      no-fingerprint baseline). */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildTrustFooter,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  type ReceptionPageConfig,
  type TrustFooterDeploymentMode,
} from '@recued/contracts';
import {
  buildReceptionTrustFooterFromToggle,
  resolveReceptionTrustFooter,
} from '../ports/reception/handlers/trust-footer.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  renderReceptionPageHtml,
  renderReceptionPagePlaceholderHtml,
  type ReceptionPageRenderInput,
} from '../ports/reception/handlers/reception-page-render.js';
import {
  renderSchedulingLinkHtml,
  renderSchedulingLinkPlaceholderHtml,
  type SchedulingLinkRenderInput,
} from '../ports/reception/handlers/scheduling-link-render.js';
import {
  renderIntakeFormHtml,
  renderIntakeFormPlaceholderHtml,
  type IntakeFormRenderInput,
} from '../ports/reception/handlers/intake-form-render.js';
import {
  renderDropLinkHtml,
  renderDropLinkPlaceholderHtml,
  type DropLinkRenderInput,
} from '../ports/reception/handlers/drop-link-render.js';
import {
  renderApprovalLinkHtml,
  renderApprovalLinkPlaceholderHtml,
  type ApprovalLinkRenderInput,
} from '../ports/reception/handlers/approval-link-render.js';
import {
  renderStatusLinkHtml,
  renderStatusLinkPlaceholderHtml,
  type StatusLinkRenderInput,
} from '../ports/reception/handlers/status-link-render.js';

// ────────────────────────────────────────────────────────────────
// Minimal render-input fixtures (one per kind)
// ────────────────────────────────────────────────────────────────

const receptionPageInput = (trust_footer: string | null): ReceptionPageRenderInput => ({
  display_name: 'Mary',
  tagline: 'Reach me here',
  tz_label: 'America/New_York',
  preferred_contact_methods: ['email'],
  cta_buttons: [],
  trust_footer,
});

const schedulingInput = (trust_footer: string | null): SchedulingLinkRenderInput => ({
  display_name: 'Mary',
  tz_label: 'America/New_York',
  free_windows: [],
  duration_options: [30],
  slots: [],
  required_visitor_fields: {
    name: 'omit',
    email: 'omit',
    topic: 'omit',
    phone: 'omit',
    notes: 'omit',
  },
  min_advance_notice_hours: 2,
  max_lead_time_days: 30,
  endpoint_id: 'ep-sched',
  bearer_secret: 'tok-sched',
  form_nonce: 'nonce-sched',
  active_duration_minutes: 30,
  trust_footer,
});

const intakeInput = (trust_footer: string | null): IntakeFormRenderInput => ({
  display_name: 'Mary',
  fields: [],
  honeypot_fields: [],
  visitor_email_requirement: 'omit',
  submit_button_label: 'Send',
  endpoint_id: 'ep-intake',
  bearer_secret: 'tok-intake',
  form_nonce: 'nonce-intake',
  trust_footer,
});

const dropInput = (trust_footer: string | null): DropLinkRenderInput => ({
  display_name: 'Mary',
  visitor_name_requirement: 'omit',
  visitor_email_requirement: 'omit',
  visitor_description_requirement: 'omit',
  submit_button_label: 'Upload',
  size_cap_bytes: 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  endpoint_id: 'ep-drop',
  bearer_secret: 'tok-drop',
  form_nonce: 'nonce-drop',
  trust_footer,
});

const approvalInput = (trust_footer: string | null): ApprovalLinkRenderInput => ({
  display_name: 'Mary',
  action_kind: 'answer_question',
  prompt: 'Please respond',
  context_summary: '',
  visitor_field_constraints: { name: 'optional', email: 'optional' },
  expiry_display: 'Expires in 7 days',
  submit_button_label: 'Submit',
  endpoint_id: 'ep-approve',
  bearer_secret: 'tok-approve',
  form_nonce: 'nonce-approve',
  trust_footer,
});

const statusInput = (trust_footer: string | null): StatusLinkRenderInput => ({
  display_name: 'Mary',
  projection_kind: 'custom',
  visible_fields: { title: 'Project Alpha', summary: 'On track' },
  last_updated_at_relative: '2 hours ago',
  updates_visible: true,
  comments_enabled: false,
  trust_footer,
});

/** Drive every configured renderer with a given `trust_footer` value so
 *  the emit / omit assertions stay DRY across all six kinds. */
const renderAllConfigured = (trust_footer: string | null): ReadonlyArray<{
  kind: string;
  html: string;
}> => [
  { kind: 'reception_page', html: renderReceptionPageHtml(receptionPageInput(trust_footer)) },
  { kind: 'scheduling_link', html: renderSchedulingLinkHtml(schedulingInput(trust_footer)) },
  { kind: 'intake_form', html: renderIntakeFormHtml(intakeInput(trust_footer)) },
  { kind: 'drop_link', html: renderDropLinkHtml(dropInput(trust_footer)) },
  { kind: 'approval_link', html: renderApprovalLinkHtml(approvalInput(trust_footer)) },
  { kind: 'status_link', html: renderStatusLinkHtml(statusInput(trust_footer)) },
];

// ────────────────────────────────────────────────────────────────
// buildReceptionTrustFooterFromToggle (pure helper)
// ────────────────────────────────────────────────────────────────

describe('D-149 P12 § A.20.7 — buildReceptionTrustFooterFromToggle', () => {
  it('default-on: absent toggle resolves to the enabled footer string', () => {
    const out = buildReceptionTrustFooterFromToggle({
      trust_footer_enabled: undefined,
      deployment_mode: 'byo_ddns',
    });
    expect(out).not.toBeNull();
    expect(out).toContain("served directly by this user's own Recued server");
  });

  it('explicit true resolves to the enabled footer string', () => {
    const out = buildReceptionTrustFooterFromToggle({
      trust_footer_enabled: true,
      deployment_mode: 'byo_ddns',
    });
    expect(out).not.toBeNull();
  });

  it('explicit false suppresses the footer (returns null)', () => {
    const out = buildReceptionTrustFooterFromToggle({
      trust_footer_enabled: false,
      deployment_mode: 'byo_ddns',
    });
    expect(out).toBeNull();
  });

  it('is a faithful pass-through to the contracts buildTrustFooter', () => {
    for (const mode of ['byo_ddns', 'pro_cloud'] as TrustFooterDeploymentMode[]) {
      const wrapped = buildReceptionTrustFooterFromToggle({
        trust_footer_enabled: true,
        deployment_mode: mode,
      });
      const direct = buildTrustFooter({ enabled: true, deployment_mode: mode });
      expect(wrapped).toBe(direct);
    }
  });

  it('pro_cloud copy names the cloud DNS relay; byo_ddns copy does not', () => {
    const proCloud = buildReceptionTrustFooterFromToggle({
      trust_footer_enabled: true,
      deployment_mode: 'pro_cloud',
    });
    const byoDdns = buildReceptionTrustFooterFromToggle({
      trust_footer_enabled: true,
      deployment_mode: 'byo_ddns',
    });
    expect(proCloud).toContain('Recued cloud only relays the DNS record.');
    expect(byoDdns).toContain('No third-party services involved.');
    expect(byoDdns).not.toContain('Recued cloud');
  });

  it('copy is fully substrate-fixed — carries no per-endpoint name or markup', () => {
    const out = buildReceptionTrustFooterFromToggle({
      trust_footer_enabled: true,
      deployment_mode: 'byo_ddns',
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain('<'); // no interpolation ⇒ no injection surface
    expect(out).not.toContain("'s server"); // no possessive endpoint name
  });
});

// ────────────────────────────────────────────────────────────────
// resolveReceptionTrustFooter (reads the singleton toggle)
// ────────────────────────────────────────────────────────────────

/** Minimal fake — `resolveReceptionTrustFooter` only touches
 *  `loadReceptionPageConfigForSettings` (the ungated settings reader). */
const fakeStore = (
  config: ReturnType<PublicEndpointRegistryStore['loadReceptionPageConfigForSettings']>,
): PublicEndpointRegistryStore =>
  ({
    loadReceptionPageConfigForSettings: () => config,
  }) as unknown as PublicEndpointRegistryStore;

describe('D-149 P12 § A.20.7 — resolveReceptionTrustFooter', () => {
  it('absent singleton config ⇒ default-on (returns the footer string)', () => {
    const out = resolveReceptionTrustFooter({
      store: fakeStore(null),
      deployment_mode: 'byo_ddns',
    });
    expect(out).not.toBeNull();
    expect(out).toContain("served directly by this user's own Recued server");
  });

  it('singleton config without the toggle ⇒ default-on', () => {
    const out = resolveReceptionTrustFooter({
      store: fakeStore({} as ReceptionPageConfig),
      deployment_mode: 'byo_ddns',
    });
    expect(out).not.toBeNull();
  });

  it('singleton config with trust_footer_enabled: false ⇒ null', () => {
    const out = resolveReceptionTrustFooter({
      store: fakeStore({ trust_footer_enabled: false } as ReceptionPageConfig),
      deployment_mode: 'byo_ddns',
    });
    expect(out).toBeNull();
  });

  it('singleton config with trust_footer_enabled: true ⇒ footer string', () => {
    const out = resolveReceptionTrustFooter({
      store: fakeStore({ trust_footer_enabled: true } as ReceptionPageConfig),
      deployment_mode: 'pro_cloud',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Recued cloud only relays the DNS record.');
  });
});

// ────────────────────────────────────────────────────────────────
// Codex review fold — opt-out honoured when the front-door is disabled
// ────────────────────────────────────────────────────────────────

/** Build a real registry store over an in-memory SQLite db, seeded
 *  with the reception_page singleton carrying the given
 *  `trust_footer_enabled` value. The minimal config blob satisfies the
 *  loader's `display_overrides` shape check. */
const realStoreWithSingleton = (
  trust_footer_enabled: boolean,
): { store: PublicEndpointRegistryStore; close: () => void } => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  store.upsertReceptionPageSingleton({
    config: {
      display_overrides: {},
      sections_enabled: {},
      linked_endpoints: {},
      trust_footer_enabled,
    } as unknown as ReceptionPageConfig,
    now: 1_000,
    actor_instance_id: 'inst-test',
  });
  return { store, close: () => db.close() };
};

describe('D-149 P12 § A.20.7 — Codex fold: opt-out survives a disabled front-door page', () => {
  it('loadReceptionPageConfigForSettings is ungated; loadReceptionPageSingleton is not', () => {
    const { store, close } = realStoreWithSingleton(false);
    try {
      store.disable(RECEPTION_PAGE_SINGLETON_ENDPOINT_ID, 2_000);
      // The renderable-front-door loader gates on enable → null (the
      // reception_page handler renders the placeholder — correct).
      expect(store.loadReceptionPageSingleton()).toBeNull();
      // The settings reader does NOT gate → still yields the operator's
      // saved config (the regression Codex flagged).
      const settingsConfig = store.loadReceptionPageConfigForSettings();
      expect(settingsConfig).not.toBeNull();
      expect(settingsConfig?.trust_footer_enabled).toBe(false);
    } finally {
      close();
    }
  });

  it('an explicit trust_footer_enabled: false is honoured on link kinds after the front-door is disabled', () => {
    const { store, close } = realStoreWithSingleton(false);
    try {
      store.disable(RECEPTION_PAGE_SINGLETON_ENDPOINT_ID, 2_000);
      const footer = resolveReceptionTrustFooter({
        store,
        deployment_mode: 'byo_ddns',
      });
      // Pre-fold this returned the default-on footer string because the
      // disabled singleton read as `null` ⇒ toggle absent ⇒ default-on.
      expect(footer).toBeNull();
    } finally {
      close();
    }
  });

  it('a disabled front-door with the footer enabled still resolves it for link kinds', () => {
    const { store, close } = realStoreWithSingleton(true);
    try {
      store.disable(RECEPTION_PAGE_SINGLETON_ENDPOINT_ID, 2_000);
      const footer = resolveReceptionTrustFooter({
        store,
        deployment_mode: 'pro_cloud',
      });
      expect(footer).not.toBeNull();
      expect(footer).toContain('Recued cloud only relays the DNS record.');
    } finally {
      close();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Renderer integration — emit / omit across all 6 kinds
// ────────────────────────────────────────────────────────────────

describe('D-149 P12 § A.20.7 — renderer wiring (emit when present)', () => {
  const footer = "This page is served directly by this user's own Recued server.";

  it('every configured renderer emits the trust-footer block when present', () => {
    for (const { kind, html } of renderAllConfigured(footer)) {
      expect(html, kind).toContain('<p class="rcp-trust-footer">');
      expect(html, kind).toContain(footer);
      // the brand line still renders alongside the trust block
      expect(html, kind).toContain('Powered by Recued');
    }
  });
});

describe('D-149 P12 § A.20.7 — renderer wiring (omit when null / absent)', () => {
  it('every configured renderer omits the trust-footer block when null', () => {
    for (const { kind, html } of renderAllConfigured(null)) {
      expect(html, kind).not.toContain('rcp-trust-footer');
      // the existing brand footer is still emitted
      expect(html, kind).toContain('Powered by Recued');
    }
  });

  it('reception_page omits the block when trust_footer is entirely absent', () => {
    // exactOptionalPropertyTypes: omit the key rather than pass undefined
    const { trust_footer: _omitted, ...rest } = receptionPageInput(null);
    void _omitted;
    const html = renderReceptionPageHtml(rest);
    expect(html).not.toContain('rcp-trust-footer');
  });
});

describe('D-149 P12 § A.20.7 — footer string is interpolated verbatim', () => {
  it('the renderer emits the footer string verbatim (no re-escaping)', () => {
    // The footer is built upstream and must reach the visitor byte-for-byte;
    // re-escaping would double-encode any entity it carries. Feed a string
    // with an HTML entity and assert the renderer neither drops nor
    // double-encodes it.
    const footer = "Served directly — no third party. &#39;verbatim&#39;";
    for (const { kind, html } of renderAllConfigured(footer)) {
      expect(html, kind).toContain(footer);
      expect(html, kind).not.toContain('&amp;#39;');
    }
  });
});

describe('D-149 P12 § A.20.7 — placeholders never carry the trust footer', () => {
  it('no placeholder renderer emits the trust-footer block (§ Must Hold I-1)', () => {
    const placeholders: ReadonlyArray<{ kind: string; html: string }> = [
      { kind: 'reception_page', html: renderReceptionPagePlaceholderHtml('UTC') },
      { kind: 'scheduling_link', html: renderSchedulingLinkPlaceholderHtml('UTC') },
      { kind: 'intake_form', html: renderIntakeFormPlaceholderHtml() },
      { kind: 'drop_link', html: renderDropLinkPlaceholderHtml() },
      { kind: 'approval_link', html: renderApprovalLinkPlaceholderHtml() },
      { kind: 'status_link', html: renderStatusLinkPlaceholderHtml() },
    ];
    for (const { kind, html } of placeholders) {
      expect(html, kind).not.toContain('rcp-trust-footer');
      // placeholder still carries the substrate brand footer
      expect(html, kind).toContain('Powered by Recued');
    }
  });
});
