/** D-151 — non-intake config templates in the Reception
 *  Templates gallery: the projection (`config-templates.ts`) +
 *  the mount rendering / "Use template" dispatch
 *  (`templates-mount.ts`). The mount drives through the same
 *  DOM-free fake-host pattern the D-149 intake mount test uses. */

import { describe, expect, it, vi } from 'vitest';
import {
  SCHEDULING_LINK_TEMPLATE_REFS,
  RECEPTION_PAGE_TEMPLATE_REFS,
  DROP_LINK_TEMPLATE_REFS,
  APPROVAL_LINK_TEMPLATE_REFS,
  RECEPTION_CONFIG_TEMPLATE_REFS,
  type ReceptionConfigTemplate,
} from '@recued/contracts';

import {
  buildReceptionConfigTemplateCardModel,
  buildReceptionConfigTemplatesBrowserModel,
  receptionConfigTemplateAuthoringSeed,
} from '../reception/config-templates.js';
import { mountTemplatesBrowser } from '../reception/templates-mount.js';

// ── Fixtures ──────────────────────────────────────────────────────

const schedulingTemplate = (
  ref: string,
  name: string,
): ReceptionConfigTemplate =>
  ({
    template_ref: ref,
    kind: 'scheduling_link',
    version: '1.0.0',
    name,
    description: `${name} — a booking front door.`,
    config: {
      duration_options_minutes: [15, 30],
      available_window_definition: {
        tz: 'America/New_York',
        explicit_windows: [
          { day_of_week: 1, start_minute: 540, end_minute: 1020 },
          { day_of_week: 2, start_minute: 540, end_minute: 1020 },
        ],
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
      max_bookings_per_day: 4,
      on_booking: {
        create_calendar_event: true,
        create_commitment_entity: true,
      },
    },
  }) as unknown as ReceptionConfigTemplate;

const pageTemplate = (ref: string, name: string): ReceptionConfigTemplate =>
  ({
    template_ref: ref,
    kind: 'reception_page',
    version: '1.0.0',
    name,
    description: `${name} — a contact page.`,
    config: {
      display_overrides: {
        tagline: 'Reach me here.',
        tz_label: 'Eastern Time (US)',
        preferred_contact_methods: ['email', 'phone'],
      },
      sections_enabled: { contact_card: true, contact_methods: true },
      linked_endpoints: {},
    },
  }) as unknown as ReceptionConfigTemplate;

const dropTemplate = (ref: string, name: string): ReceptionConfigTemplate =>
  ({
    template_ref: ref,
    kind: 'drop_link',
    version: '1.0.0',
    name,
    description: `${name} — a file inbox.`,
    config: {
      link_kind: 'repeated',
      size_cap_bytes: 26214400,
      allowed_mime_types: ['application/pdf', 'image/png', 'text/plain'],
      expiry_days: 14,
      max_uploads_per_endpoint_per_day: 50,
      required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
      on_upload: {
        create_data_file_entity: true,
        auto_attach_to_contact: false,
      },
    },
  }) as unknown as ReceptionConfigTemplate;

const approvalTemplate = (ref: string, name: string): ReceptionConfigTemplate =>
  ({
    template_ref: ref,
    kind: 'approval_link',
    version: '1.0.0',
    name,
    description: `${name} — a single-use action.`,
    config: {
      action_kind: 'pick_time',
      prompt: 'Pick the time that works.',
      context_raw: { summary: 'Time slots awaiting a pick.' },
      options: [
        { id: 'morning', label: 'Morning' },
        { id: 'afternoon', label: 'Afternoon' },
      ],
      visitor_field_constraints: { name: 'optional', email: 'optional' },
      expiry_days: 14,
      on_action: {
        target_id: 'replace-with-the-item-id',
        on_approve_action: 'create_commitment',
      },
    },
  }) as unknown as ReceptionConfigTemplate;

// ── DOM-free fake host (click delegation) ─────────────────────────

const makeFakeHost = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      listeners[evt]?.delete(fn);
    },
    contains: () => true,
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
  };
};

// ══════════════════════════════════════════════════════════════════
// Projection
// ══════════════════════════════════════════════════════════════════

describe('D-151 — buildReceptionConfigTemplatesBrowserModel', () => {
  it('projects cards in canonical ref order regardless of supply order', () => {
    const supplied = [
      pageTemplate(RECEPTION_PAGE_TEMPLATE_REFS[0]!, 'Page A'),
      schedulingTemplate(SCHEDULING_LINK_TEMPLATE_REFS[0]!, 'Sched A'),
    ];
    const model = buildReceptionConfigTemplatesBrowserModel({ templates: supplied });
    // Scheduling refs come first in RECEPTION_CONFIG_TEMPLATE_REFS order.
    expect(model.cards[0]?.template_ref).toBe(SCHEDULING_LINK_TEMPLATE_REFS[0]);
    expect(model.cards[1]?.template_ref).toBe(RECEPTION_PAGE_TEMPLATE_REFS[0]);
    expect(model.total).toBe(2);
  });

  it('surfaces missing refs + is_complete honestly', () => {
    const model = buildReceptionConfigTemplatesBrowserModel({
      templates: [schedulingTemplate(SCHEDULING_LINK_TEMPLATE_REFS[0]!, 'Only one')],
    });
    expect(model.is_complete).toBe(false);
    expect(model.is_empty).toBe(false);
    // All-but-one closed-list ref is missing.
    expect(model.missing_refs.length).toBe(RECEPTION_CONFIG_TEMPLATE_REFS.length - 1);
  });

  it('reports is_empty for no templates', () => {
    const model = buildReceptionConfigTemplatesBrowserModel({ templates: [] });
    expect(model.is_empty).toBe(true);
    expect(model.total).toBe(0);
  });
});

describe('D-151 — buildReceptionConfigTemplateCardModel summaries', () => {
  it('derives a scheduling summary (durations · days/week · email)', () => {
    const card = buildReceptionConfigTemplateCardModel(
      schedulingTemplate(SCHEDULING_LINK_TEMPLATE_REFS[0]!, 'Intro'),
    );
    expect(card.kind).toBe('scheduling_link');
    expect(card.kind_label).toBe('Scheduling link');
    expect(card.summary_label).toBe('15 / 30 min · 2 days/week · email required');
  });

  it('derives a page summary (sections · contact methods)', () => {
    const card = buildReceptionConfigTemplateCardModel(
      pageTemplate(RECEPTION_PAGE_TEMPLATE_REFS[0]!, 'Contact'),
    );
    expect(card.kind).toBe('reception_page');
    expect(card.kind_label).toBe('Contact page');
    expect(card.summary_label).toBe('2 sections · email, phone');
  });

  it('derives a drop summary (file categories · size · link kind) with deduped mime categories', () => {
    const card = buildReceptionConfigTemplateCardModel(
      dropTemplate(DROP_LINK_TEMPLATE_REFS[0]!, 'Document request'),
    );
    expect(card.kind).toBe('drop_link');
    expect(card.kind_label).toBe('Drop link');
    // application/pdf → PDF, image/png → images, text/plain → text (no dup).
    expect(card.summary_label).toBe('PDF, images, text · 25 MB max · reusable');
  });

  it('derives an approval summary (action · options · expiry)', () => {
    const card = buildReceptionConfigTemplateCardModel(
      approvalTemplate(APPROVAL_LINK_TEMPLATE_REFS[0]!, 'Pick a time'),
    );
    expect(card.kind).toBe('approval_link');
    expect(card.kind_label).toBe('Approval link');
    expect(card.summary_label).toBe('Pick a time · 2 options · 14-day');
  });
});

describe('D-151 — receptionConfigTemplateAuthoringSeed', () => {
  it('blanks an approval_link placeholder target_id so the form opens for deliberate entry', () => {
    const seed = receptionConfigTemplateAuthoringSeed(
      approvalTemplate(APPROVAL_LINK_TEMPLATE_REFS[0]!, 'Pick a time'),
    );
    expect(seed.kind).toBe('approval_link');
    if (seed.kind !== 'approval_link') return;
    expect(seed.config.on_action.target_id).toBe('');
    // The rest of the config carries through verbatim.
    expect(seed.config.action_kind).toBe('pick_time');
    expect(seed.config.display_name).toBe('');
  });

  it('passes a drop_link seed through with a blank display_name', () => {
    const seed = receptionConfigTemplateAuthoringSeed(
      dropTemplate(DROP_LINK_TEMPLATE_REFS[0]!, 'Document request'),
    );
    expect(seed.kind).toBe('drop_link');
    if (seed.kind !== 'drop_link') return;
    expect(seed.config.display_name).toBe('');
    expect(seed.config.link_kind).toBe('repeated');
  });

  it('passes a scheduling_link seed through with a blank display_name', () => {
    const seed = receptionConfigTemplateAuthoringSeed(
      schedulingTemplate(SCHEDULING_LINK_TEMPLATE_REFS[0]!, 'Intro'),
    );
    expect(seed.kind).toBe('scheduling_link');
    if (seed.kind !== 'scheduling_link') return;
    expect(seed.config.display_name).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
// Mount — render + dispatch
// ══════════════════════════════════════════════════════════════════

describe('D-151 — mountTemplatesBrowser config templates', () => {
  it('renders scheduling + contact-page sections with cards', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      configTemplates: [
        schedulingTemplate(SCHEDULING_LINK_TEMPLATE_REFS[0]!, 'Intro call'),
        pageTemplate(RECEPTION_PAGE_TEMPLATE_REFS[0]!, 'Personal page'),
      ],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    expect(out).toContain('Scheduling links');
    expect(out).toContain('Contact pages');
    expect(out).toContain('Intro call');
    expect(out).toContain('Personal page');
    // The summary line + a kind-stamped Use button.
    expect(out).toContain('15 / 30 min · 2 days/week · email required');
    expect(out).toContain(`data-template-ref="${SCHEDULING_LINK_TEMPLATE_REFS[0]}"`);
    expect(out).toContain('data-kind="scheduling_link"');
    expect(out).toContain('data-kind="reception_page"');
    mount.dispose();
  });

  it('renders drop + approval sections with kind-stamped cards', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      configTemplates: [
        dropTemplate(DROP_LINK_TEMPLATE_REFS[0]!, 'Document request'),
        approvalTemplate(APPROVAL_LINK_TEMPLATE_REFS[0]!, 'Pick a time'),
      ],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    expect(out).toContain('Drop links');
    expect(out).toContain('Approval links');
    expect(out).toContain('Document request');
    expect(out).toContain('Pick a time');
    expect(out).toContain('PDF, images, text · 25 MB max · reusable');
    expect(out).toContain('Pick a time · 2 options · 14-day');
    expect(out).toContain('data-kind="drop_link"');
    expect(out).toContain('data-kind="approval_link"');
    mount.dispose();
  });

  it('an approval "Use template" click fires onUseTemplate with the ref + kind', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const ref = APPROVAL_LINK_TEMPLATE_REFS[0]!;
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      configTemplates: [approvalTemplate(ref, 'Pick a time')],
      onUseTemplate,
      onClose: vi.fn(),
    });
    click({ action: 'reception-template-use', templateRef: ref, kind: 'approval_link' });
    expect(onUseTemplate).toHaveBeenCalledWith(ref, 'approval_link');
    mount.dispose();
  });

  it('a config "Use template" click fires onUseTemplate with the ref + kind then closes', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const onClose = vi.fn();
    const ref = SCHEDULING_LINK_TEMPLATE_REFS[0]!;
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      configTemplates: [schedulingTemplate(ref, 'Intro call')],
      onUseTemplate,
      onClose,
    });
    click({ action: 'reception-template-use', templateRef: ref, kind: 'scheduling_link' });
    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    expect(onUseTemplate).toHaveBeenCalledWith(ref, 'scheduling_link');
    expect(onClose).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('renders no config sections when no config templates are supplied', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      configTemplates: [],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    expect(out).not.toContain('Scheduling links');
    expect(out).not.toContain('Contact pages');
    // A fully-empty gallery still shows the not-installed empty state.
    expect(out).toContain('Foundation pack may not be installed');
    mount.dispose();
  });

  it('surfaces a config partial-load note only when some-but-not-all loaded', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      configTemplates: [schedulingTemplate(SCHEDULING_LINK_TEMPLATE_REFS[0]!, 'One')],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    expect(getHtml()).toContain(
      `1 of ${RECEPTION_CONFIG_TEMPLATE_REFS.length} Foundation-pack config templates loaded.`,
    );
    mount.dispose();
  });
});
