/** D-149 § A.20.3 follow-on — Visitor Receipt POST-success-surface wiring.
 *
 *  P12 shipped `buildVisitorReceipt` + `validateVisitorReceiptConfig` as
 *  pure substrate; this suite covers the follow-on leg that wires the
 *  receipt into the four POST success surfaces (scheduling `/book`,
 *  intake submit, drop upload, approval consume). Covers:
 *
 *    - The four per-kind config validators delegate an optional
 *      `visitor_receipt` field to `validateVisitorReceiptConfig`
 *      (absent ⇒ no failure; a present-but-malformed value ⇒ the
 *      kind's `visitor_receipt_invalid` code).
 *    - `resolveVisitorReceipt` — absent / disabled config ⇒ `null`;
 *      enabled ⇒ a built receipt; the `privacy_footer` slot resolves
 *      the § A.20.7 trust footer (or `null` with no deployment mode).
 *    - `renderVisitorReceiptBlock` — `null` ⇒ `''`; a built receipt ⇒
 *      the `.rcp-receipt` section with the reference id + submitted-at
 *      + the verbatim field echo; the pre-escaped privacy footer is
 *      interpolated VERBATIM (not double-encoded); hostile field values
 *      are html-escaped.
 *    - The four `render*SuccessHtml` renderers emit the receipt block
 *      when a receipt is present + omit it (keeping the brand footer)
 *      when `null`. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  validateApprovalLinkConfig,
  validateDropLinkConfig,
  validateIntakeFormConfig,
  validateSchedulingLinkConfig,
  type ApprovalLinkConfig,
  type DropLinkConfig,
  type IntakeFormConfig,
  type ReceptionPageConfig,
  type SchedulingLinkConfig,
  type VisitorReceipt,
} from '@recued/contracts';
import {
  renderVisitorReceiptBlock,
  resolveVisitorReceipt,
} from '../ports/reception/handlers/visitor-receipt.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { renderSchedulingLinkSuccessHtml } from '../ports/reception/handlers/scheduling-link-render.js';
import { renderIntakeFormSuccessHtml } from '../ports/reception/handlers/intake-form-render.js';
import { renderDropLinkSuccessHtml } from '../ports/reception/handlers/drop-link-render.js';
import { renderApprovalLinkSuccessHtml } from '../ports/reception/handlers/approval-link-render.js';

// ────────────────────────────────────────────────────────────────
// Valid per-kind config fixtures (mirrors d-149-phase-{5,6,7,8} tests)
// ────────────────────────────────────────────────────────────────

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

const goodApproval: ApprovalLinkConfig = {
  display_name: 'Mary',
  action_kind: 'pick_time',
  prompt: 'Please pick a time that works for you.',
  context_raw: { summary: 'Meeting about Q3 plans.' },
  options: [
    { id: 'opt_a', label: '9am Mon' },
    { id: 'opt_b', label: '2pm Tue' },
  ],
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 7,
  on_action: {
    target_id: 'proposal-123',
    // The VALID baseline every test here builds on. It moved to
    // `create_commitment` when `mark_resolved` stopped being an acceptable
    // WRITE (its effect seam is unwired, so the visitor's answer would reach
    // nobody). These tests are about validity acceptance and receipt wiring,
    // not about which action is supported — so the FIXTURE moves and the
    // expectations stay.
    on_approve_action: 'create_commitment',
  },
};

// ────────────────────────────────────────────────────────────────
// Config validator delegation — the optional visitor_receipt field
// ────────────────────────────────────────────────────────────────

type LooseValidator = (config: unknown) => ReadonlyArray<{ code: string }>;

const validatorCases: ReadonlyArray<{
  kind: string;
  validate: LooseValidator;
  base: object;
}> = [
  {
    kind: 'scheduling_link',
    validate: validateSchedulingLinkConfig as LooseValidator,
    base: goodScheduling,
  },
  {
    kind: 'intake_form',
    validate: validateIntakeFormConfig as LooseValidator,
    base: goodIntake,
  },
  {
    kind: 'drop_link',
    validate: validateDropLinkConfig as LooseValidator,
    base: goodDrop,
  },
  {
    kind: 'approval_link',
    validate: validateApprovalLinkConfig as LooseValidator,
    base: goodApproval,
  },
];

const withReceipt = (base: object, visitor_receipt: unknown): unknown => ({
  ...base,
  visitor_receipt,
});

describe('D-149 § A.20.3 — per-kind config validators delegate visitor_receipt', () => {
  for (const { kind, validate, base } of validatorCases) {
    it(`${kind}: base config (no visitor_receipt) validates clean`, () => {
      expect(validate(base)).toEqual([]);
    });

    it(`${kind}: a valid visitor_receipt ({ enabled: true }) validates clean`, () => {
      expect(validate(withReceipt(base, { enabled: true }))).toEqual([]);
    });

    it(`${kind}: a valid visitor_receipt with an explicit via validates clean`, () => {
      expect(validate(withReceipt(base, { enabled: true, via: 'email' }))).toEqual([]);
      expect(validate(withReceipt(base, { enabled: false, via: 'page' }))).toEqual([]);
    });

    it(`${kind}: a non-boolean enabled ⇒ visitor_receipt_invalid`, () => {
      const failures = validate(withReceipt(base, { enabled: 'yes' }));
      expect(failures.some((f) => f.code === 'visitor_receipt_invalid')).toBe(true);
    });

    it(`${kind}: an unknown via ⇒ visitor_receipt_invalid`, () => {
      const failures = validate(withReceipt(base, { enabled: true, via: 'sms' }));
      expect(failures.some((f) => f.code === 'visitor_receipt_invalid')).toBe(true);
    });

    it(`${kind}: a non-object visitor_receipt ⇒ visitor_receipt_invalid`, () => {
      const failures = validate(withReceipt(base, 'nope'));
      expect(failures.some((f) => f.code === 'visitor_receipt_invalid')).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────
// resolveVisitorReceipt
// ────────────────────────────────────────────────────────────────

/** Minimal fake — `resolveVisitorReceipt` reaches the store only
 *  through `resolveReceptionTrustFooter`, which touches just
 *  `loadReceptionPageConfigForSettings`. */
const fakeStore = (
  config: ReturnType<PublicEndpointRegistryStore['loadReceptionPageConfigForSettings']>,
): PublicEndpointRegistryStore =>
  ({
    loadReceptionPageConfigForSettings: () => config,
  }) as unknown as PublicEndpointRegistryStore;

describe('D-149 § A.20.3 — resolveVisitorReceipt', () => {
  it('absent per-endpoint config ⇒ null (receipts are opt-in)', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore(null),
      receptionDeploymentMode: 'byo_ddns',
      config: undefined,
      reference_id: 'ref-1',
      submitted_at: 1_000,
      endpoint_kind: 'intake_form',
      fields_echo: [],
    });
    expect(receipt).toBeNull();
  });

  it('config with enabled: false ⇒ null', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore(null),
      receptionDeploymentMode: 'byo_ddns',
      config: { enabled: false },
      reference_id: 'ref-1',
      submitted_at: 1_000,
      endpoint_kind: 'intake_form',
      fields_echo: [],
    });
    expect(receipt).toBeNull();
  });

  it('enabled config ⇒ a built receipt with via defaulting to page', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore(null),
      receptionDeploymentMode: 'byo_ddns',
      config: { enabled: true },
      reference_id: 'ref-abc',
      submitted_at: 1_700_000_000_000,
      endpoint_kind: 'scheduling_link',
      fields_echo: [{ label: 'Name', value: 'Sam' }],
    });
    expect(receipt).not.toBeNull();
    expect(receipt?.reference_id).toBe('ref-abc');
    expect(receipt?.submitted_at).toBe(1_700_000_000_000);
    expect(receipt?.endpoint_kind).toBe('scheduling_link');
    expect(receipt?.via).toBe('page');
    expect(receipt?.fields_echo).toEqual([{ label: 'Name', value: 'Sam' }]);
  });

  it('config via: email is carried onto the built receipt', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore(null),
      receptionDeploymentMode: 'byo_ddns',
      config: { enabled: true, via: 'email' },
      reference_id: 'ref-1',
      submitted_at: 1_000,
      endpoint_kind: 'drop_link',
      fields_echo: [],
    });
    expect(receipt?.via).toBe('email');
  });

  it('no deployment mode ⇒ privacy_footer is null', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore({ trust_footer_enabled: true } as ReceptionPageConfig),
      receptionDeploymentMode: undefined,
      config: { enabled: true },
      reference_id: 'ref-1',
      submitted_at: 1_000,
      endpoint_kind: 'intake_form',
      fields_echo: [],
    });
    expect(receipt?.privacy_footer).toBeNull();
  });

  it('deployment mode + footer-on singleton ⇒ privacy_footer carries the trust footer', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore({ trust_footer_enabled: true } as ReceptionPageConfig),
      receptionDeploymentMode: 'byo_ddns',
      config: { enabled: true },
      reference_id: 'ref-1',
      submitted_at: 1_000,
      endpoint_kind: 'intake_form',
      fields_echo: [],
    });
    expect(receipt?.privacy_footer).not.toBeNull();
    expect(receipt?.privacy_footer).toContain("served directly by this user's own Recued server");
  });

  it('deployment mode + footer-off singleton ⇒ privacy_footer is null', () => {
    const receipt = resolveVisitorReceipt({
      store: fakeStore({ trust_footer_enabled: false } as ReceptionPageConfig),
      receptionDeploymentMode: 'byo_ddns',
      config: { enabled: true },
      reference_id: 'ref-1',
      submitted_at: 1_000,
      endpoint_kind: 'intake_form',
      fields_echo: [],
    });
    expect(receipt?.privacy_footer).toBeNull();
  });

  it('resolves the footer through a real registry store', () => {
    const db = new Database(':memory:');
    try {
      ensureReceptionSchema(db);
      const store = createPublicEndpointRegistryStore(db);
      store.upsertReceptionPageSingleton({
        config: {
          display_overrides: {},
          sections_enabled: {},
          linked_endpoints: {},
          trust_footer_enabled: true,
        } as unknown as ReceptionPageConfig,
        now: 1_000,
        actor_instance_id: 'inst-test',
      });
      const receipt = resolveVisitorReceipt({
        store,
        receptionDeploymentMode: 'pro_cloud',
        config: { enabled: true },
        reference_id: 'ref-1',
        submitted_at: 1_000,
        endpoint_kind: 'approval_link',
        fields_echo: [],
      });
      expect(receipt?.privacy_footer).toContain('Recued cloud only relays the DNS record.');
    } finally {
      db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// renderVisitorReceiptBlock
// ────────────────────────────────────────────────────────────────

const makeReceipt = (over: Partial<VisitorReceipt> = {}): VisitorReceipt => ({
  reference_id: 'ref-xyz',
  submitted_at: 1_700_000_000_000,
  endpoint_kind: 'intake_form',
  fields_echo: [
    { label: 'Name', value: 'Sam Carter' },
    { label: 'Topic', value: 'Project kickoff' },
  ],
  privacy_footer: null,
  via: 'page',
  // D-240 — non-optional on a BUILT receipt so every reader gets an explicit
  // `null` rather than a missing key. These tests are about the receipt block's
  // rendering, so the fixture names the no-viewback case and the expectations
  // are unchanged; the link's own rendering is covered in the D-240 suite.
  lookup_path: null,
  ...over,
});

describe('D-149 § A.20.3 — renderVisitorReceiptBlock', () => {
  it('null / undefined receipt ⇒ empty string', () => {
    expect(renderVisitorReceiptBlock(null)).toBe('');
    expect(renderVisitorReceiptBlock(undefined)).toBe('');
  });

  it('a built receipt renders the .rcp-receipt section with ref id + submitted-at', () => {
    const html = renderVisitorReceiptBlock(makeReceipt());
    expect(html).toContain('class="rcp-section rcp-receipt"');
    expect(html).toContain('Reference ID:');
    expect(html).toContain('<code>ref-xyz</code>');
    expect(html).toContain(new Date(1_700_000_000_000).toISOString());
  });

  it('renders each field echo as a dt/dd pair', () => {
    const html = renderVisitorReceiptBlock(makeReceipt());
    expect(html).toContain('<dl class="rcp-receipt-fields">');
    expect(html).toContain('<dt>Name</dt><dd>Sam Carter</dd>');
    expect(html).toContain('<dt>Topic</dt><dd>Project kickoff</dd>');
  });

  it('omits the <dl> when fields_echo is empty', () => {
    const html = renderVisitorReceiptBlock(makeReceipt({ fields_echo: [] }));
    expect(html).toContain('rcp-receipt');
    expect(html).not.toContain('rcp-receipt-fields');
  });

  it('html-escapes the reference id + field labels + values (no markup injection)', () => {
    const html = renderVisitorReceiptBlock(
      makeReceipt({
        reference_id: '<id>',
        fields_echo: [{ label: '<lbl>', value: "<script>alert('x')</script>" }],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;id&gt;');
    expect(html).toContain('&lt;lbl&gt;');
  });

  it('interpolates the pre-escaped privacy footer VERBATIM (no double-encoding)', () => {
    // `buildTrustFooter` html-escapes the display name, so a footer
    // string can already carry `&#39;`. The block must interpolate it
    // verbatim — re-escaping would yield `&amp;#39;`.
    const html = renderVisitorReceiptBlock(
      makeReceipt({ privacy_footer: "Served by O&#39;Brien's Recued." }),
    );
    expect(html).toContain('<p class="rcp-trust-footer">');
    expect(html).toContain('&#39;');
    expect(html).not.toContain('&amp;#39;');
  });

  it('omits the trust-footer block when privacy_footer is null', () => {
    const html = renderVisitorReceiptBlock(makeReceipt({ privacy_footer: null }));
    expect(html).not.toContain('rcp-trust-footer');
  });
});

// ────────────────────────────────────────────────────────────────
// Success-renderer integration — emit / omit across all 4 POST kinds
// ────────────────────────────────────────────────────────────────

const renderAllSuccess = (
  receipt: VisitorReceipt | null,
): ReadonlyArray<{ kind: string; html: string }> => [
  {
    kind: 'scheduling_link',
    html: renderSchedulingLinkSuccessHtml({
      display_name: 'Mary',
      tz_label: 'UTC',
      success_message: 'Booked.',
      slot_display_label: 'Mon 9am',
      receipt,
    }),
  },
  {
    kind: 'intake_form',
    html: renderIntakeFormSuccessHtml({
      display_name: 'Mary',
      success_message: 'Received.',
      receipt,
    }),
  },
  {
    kind: 'drop_link',
    html: renderDropLinkSuccessHtml({
      display_name: 'Mary',
      success_message: 'Uploaded.',
      receipt,
    }),
  },
  {
    kind: 'approval_link',
    html: renderApprovalLinkSuccessHtml({
      display_name: 'Mary',
      success_message: 'Recorded.',
      receipt,
    }),
  },
];

describe('D-149 § A.20.3 — success renderers emit the receipt block when present', () => {
  it('every POST success renderer emits the .rcp-receipt section', () => {
    const receipt = makeReceipt({ privacy_footer: "Served by Mary's Recued." });
    for (const { kind, html } of renderAllSuccess(receipt)) {
      expect(html, kind).toContain('class="rcp-section rcp-receipt"');
      expect(html, kind).toContain('<code>ref-xyz</code>');
      expect(html, kind).toContain('<dt>Name</dt><dd>Sam Carter</dd>');
      expect(html, kind).toContain('rcp-trust-footer');
      // the substrate brand footer still renders alongside the receipt
      expect(html, kind).toContain('Powered by Recued');
    }
  });
});

describe('D-149 § A.20.3 — success renderers omit the receipt block when null', () => {
  it('every POST success renderer omits the .rcp-receipt section when receipt is null', () => {
    for (const { kind, html } of renderAllSuccess(null)) {
      expect(html, kind).not.toContain('rcp-receipt');
      // the brand footer is still emitted (success page is unchanged)
      expect(html, kind).toContain('Powered by Recued');
    }
  });
});
