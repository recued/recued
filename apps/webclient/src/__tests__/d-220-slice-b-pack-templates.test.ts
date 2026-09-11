/** D-220 Slice B — pack-shipped intake templates in the Templates browser.
 *
 *  Covers the pack half of `reception-templates.ts` (card + browser model
 *  with provenance) and the gallery mount's pack section: the card renders
 *  with its `pack:` ref + pack marker + "From <pack>" line, third-party
 *  copy is escaped on the way into markup, "Use template" on a pack card
 *  fires the SAME action + kind a Foundation card does (so the host's seed
 *  resolver is the one place that knows which cache a ref lives in), the
 *  section is absent when no pack shipped anything, and a stored template
 *  the server could not admit is SAID in a note rather than dropped.
 *
 *  Same no-jsdom fake-host convention as the sibling gallery tests. */

import { describe, expect, it, vi } from 'vitest';
import type {
  PackIntakeFormTemplate,
  PackReceptionTemplateListing,
  PackReceptionTemplateUnavailable,
} from '@recued/contracts';

import {
  buildIntakeFormFormModel,
  buildPackIntakeFormTemplateCardModel,
  buildPackIntakeFormTemplatesBrowserModel,
  useIntakeFormTemplate,
} from '../settings/reception-templates.js';
import { mountTemplatesBrowser } from '../settings/reception-templates-mount.js';
import { seedWorkingConfig } from '../settings/reception-authoring-mount.js';

// ── Fixtures ──────────────────────────────────────────────────────

const PACK_REF = 'pack:recued-core/job-status-board/intake/drop_off' as const;

const mkPackTemplate = (override: Partial<PackIntakeFormTemplate> = {}): PackIntakeFormTemplate => ({
  template_ref: PACK_REF,
  version: '1.0.0',
  name: 'Job drop-off',
  description: 'Take in a repair job.',
  form_definition: {
    form_definition_id: 'fd_job_status_board_drop_off_v1',
    fields: [
      { name: 'item_description', type: 'textarea', label: 'What needs doing?', required: true },
      { name: 'contact_name', type: 'text', label: 'Your name', required: false },
      { name: 'website', type: 'text', label: 'Website', required: false },
    ],
  },
  required_visitor_fields: { email: 'required' },
  submission_processing_rule: {
    target_kind: 'form_response',
    fields_to_include_in_target: ['item_description', 'contact_name'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam_defaults: {
    honeypot_fields: ['website'],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  ...override,
});

const mkListing = (override: Partial<PackReceptionTemplateListing> = {}): PackReceptionTemplateListing => ({
  template: mkPackTemplate(),
  pack_slug: 'job-status-board',
  publisher: 'recued-core',
  pack_name: 'Job Status Board',
  pack_version: 4,
  ...override,
});

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

// ── Model ─────────────────────────────────────────────────────────

describe('D-220 Slice B — pack template card + browser model', () => {
  it('projects the intake card under the pack ref and adds provenance', () => {
    const card = buildPackIntakeFormTemplateCardModel(mkListing());
    expect(card.template_ref).toBe(PACK_REF);
    expect(card.name).toBe('Job drop-off');
    expect(card.pack_slug).toBe('job-status-board');
    expect(card.publisher).toBe('recued-core');
    expect(card.provenance_label).toBe('From Job Status Board (v4)');
    // The shared projection: honeypot excluded from the visitor field set.
    expect(card.collected.visitor_field_count).toBe(2);
    expect(card.collected.honeypot_field_count).toBe(1);
    expect(card.collected.required_field_count).toBe(1);
    expect(card.target_kind).toBe('form_response');
  });

  it('omits the version suffix when the row carries no readable version', () => {
    const card = buildPackIntakeFormTemplateCardModel(mkListing({ pack_version: 0 }));
    expect(card.provenance_label).toBe('From Job Status Board');
  });

  it('dedups a duplicate ref last-wins and carries unavailable rows through', () => {
    const unavailable: PackReceptionTemplateUnavailable[] = [
      { template_ref: 'pack:recued-core/queue-desk/intake/join', pack_slug: 'queue-desk', reason: 'pack_template_forbidden_field_name' },
    ];
    const model = buildPackIntakeFormTemplatesBrowserModel({
      listings: [mkListing(), mkListing({ template: mkPackTemplate({ name: 'Newer' }) })],
      unavailable,
    });
    expect(model.total).toBe(1);
    expect(model.cards[0]?.name).toBe('Newer');
    expect(model.is_empty).toBe(false);
    expect(model.unavailable).toEqual(unavailable);
  });

  it('is empty with no listings even when a note is pending', () => {
    const model = buildPackIntakeFormTemplatesBrowserModel({
      listings: [],
      unavailable: [{ template_ref: PACK_REF, pack_slug: 'job-status-board', reason: 'pack_template_target_kind' }],
    });
    expect(model.is_empty).toBe(true);
    expect(model.unavailable).toHaveLength(1);
  });

  it('the authoring seed keeps template_version and user_only_field_names (audit: both were dropped before create)', () => {
    const result = useIntakeFormTemplate(
      mkPackTemplate({ form_definition: {
        form_definition_id: 'fd_x', user_only_field_names: ['internal_note'],
        fields: [{ name: 'item_description', type: 'textarea', label: 'What needs doing?', required: true }],
      } }),
      { display_name: 'Ana' },
    );
    if (!result.ok) throw new Error(result.code);
    const working = seedWorkingConfig('intake_form', result.config) as {
      template_version?: unknown;
      form_definition?: { user_only_field_names?: unknown };
    };
    expect(working.template_version).toBe('1.0.0');
    expect(working.form_definition?.user_only_field_names).toEqual(['internal_note']);
  });

  it('owner-only field names are an editable repeater in the intake model, and blank rows are dropped on apply', () => {
    const config = useIntakeFormTemplate(
      mkPackTemplate({ form_definition: {
        form_definition_id: 'fd_x', user_only_field_names: ['internal_note', 'lead_source'],
        fields: [{ name: 'item_description', type: 'textarea', label: 'What needs doing?', required: true }],
      } }),
      { display_name: 'Ana' },
    );
    if (!config.ok) throw new Error(config.code);
    const model = buildIntakeFormFormModel(config.config);
    expect(model.user_only_field_names.control).toBe('repeater');
    expect(model.user_only_field_names.key).toBe('form_definition.user_only_field_names');
    expect(model.user_only_field_names.rows).toEqual(['internal_note', 'lead_source']);
    // A blank row the owner left behind is not a field name.
    const working = seedWorkingConfig('intake_form', {
      ...config.config,
      form_definition: { ...config.config.form_definition, user_only_field_names: ['internal_note', '   ', ''] },
    }) as { form_definition?: { user_only_field_names?: unknown } };
    expect(working.form_definition?.user_only_field_names).toEqual(['internal_note']);
  });

  it('the "Use template" bridge accepts a pack template and stamps its ref on the seed', () => {
    const result = useIntakeFormTemplate(mkPackTemplate(), { display_name: 'Ana' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.template_ref).toBe(PACK_REF);
    expect(result.config.form_definition.form_definition_id).toBe('fd_job_status_board_drop_off_v1');
  });
});

// ── Mount ─────────────────────────────────────────────────────────

describe('D-220 Slice B — mountTemplatesBrowser: the pack section', () => {
  it('renders a pack card with its ref, pack marker, provenance line, and section title', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      packTemplates: [mkListing()],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    expect(out).toContain('From your installed packs');
    expect(out).toContain(`data-template-ref="${PACK_REF}"`);
    expect(out).toContain('data-pack-slug="job-status-board"');
    expect(out).toContain('Job drop-off');
    expect(out).toContain('From Job Status Board (v4)');
    // A pack card is a card, not the "nothing loaded" empty state.
    expect(out).not.toContain('Foundation pack may not be installed');
    mount.dispose();
  });

  it('renders no pack section when no pack shipped a template', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    expect(getHtml()).not.toContain('From your installed packs');
    expect(getHtml()).not.toContain('could not be loaded');
    mount.dispose();
  });

  it('escapes third-party pack copy on the way into markup', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      packTemplates: [mkListing({
        pack_name: 'Evil <img src=x onerror=alert(1)>',
        template: mkPackTemplate({ name: '<b>Bold</b> drop-off', description: 'x" onmouseover="y' }),
      })],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<b>Bold</b>');
    expect(out).toContain('&lt;b&gt;Bold&lt;/b&gt; drop-off');
    expect(out).toContain('From Evil &lt;img src=x onerror=alert(1)&gt; (v4)');
    mount.dispose();
  });

  it('"Use template" on a pack card fires the same action + kind as a Foundation card', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const onClose = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      packTemplates: [mkListing()],
      onUseTemplate,
      onClose,
    });
    click({ action: 'reception-template-use', templateRef: PACK_REF, kind: 'intake_form' });
    expect(onUseTemplate).toHaveBeenCalledWith(PACK_REF, 'intake_form');
    expect(onClose).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('says which stored pack template the server could not admit, instead of dropping it', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      packTemplates: [],
      packTemplatesUnavailable: [
        { template_ref: 'pack:recued-core/queue-desk/intake/join', pack_slug: 'queue-desk', reason: 'pack_template_forbidden_field_name' },
      ],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    expect(out).toContain('1 pack template could not be loaded');
    expect(out).toContain('pack:recued-core/queue-desk/intake/join (pack_template_forbidden_field_name)');
    // No cards ⇒ no section, but the note still renders.
    expect(out).not.toContain('From your installed packs');
    mount.dispose();
  });
});
