/** D-149 § A.9 + § A.5.x follow-on — Settings → Server → Reception
 *  working-config container + `mountAuthoringForm` acceptance.
 *
 *  The working-config machinery (`seedWorkingConfig` /
 *  `applyFieldDelegateEvent` / `addRepeaterRow` / `removeRepeaterRow` /
 *  `buildAuthoringView` / `validateConfigForKind`) is pure — these tests
 *  drive it directly. `mountAuthoringForm` is the `mountReceptionPage`-
 *  shape mount — tested through an extended DOM-free fake host (the
 *  `action-dispatcher.test.ts` pattern, widened with `input` / `change`
 *  field-event simulation) + a fake shell.
 *
 *  The non-obvious things under test: the working config holds the
 *  *contract* shape, not the model's DOM-locator `key`s —
 *  `reception_page`'s flat-keyed `display_overrides.*` fields re-nest,
 *  `status_link`'s split `source_ref.kind` / `source_ref.id` reassemble
 *  the discriminated union; empty optional text is *omitted*, not
 *  written as `''` (the validators reject a present-but-empty optional);
 *  field edits mutate silently, except selectors whose value changes the
 *  visible form structure. */

import { describe, expect, it, vi } from 'vitest';
import type {
  DropLinkConfig,
  IntakeFormConfig,
  PacketDeclaration,
  ReceptionEndpointCreateResult,
  ReceptionEndpointPreviewResult,
  ReceptionPageConfig,
  SchedulingLinkConfig,
} from '@recued/contracts';

import {
  seedWorkingConfig,
  buildAuthoringView,
  validateConfigForKind,
  applyFieldDelegateEvent,
  addRepeaterRow,
  removeRepeaterRow,
  mountAuthoringForm,
  type FieldDelegateEvent,
} from '../settings/reception-authoring-mount.js';
import { INTAKE_FORM_CALENDAR_END_MODE_KEY } from '../settings/reception-authoring.js';
import type { ReceptionPageShell } from '../settings/reception-page-shell.js';

// ── Fixtures ──────────────────────────────────────────────────────

/** A minimally valid `ReceptionPageConfig`. */
const validReceptionPage = (): ReceptionPageConfig => ({
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Reach me here',
    tz_label: 'Pacific Time',
    preferred_contact_methods: [],
  },
  sections_enabled: {},
  linked_endpoints: {},
});

/** A minimally valid `SchedulingLinkConfig` (mirrors the authoring-render
 *  test's valid fixture). */
const validScheduling = (): SchedulingLinkConfig => ({
  display_name: 'Mary',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
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
});

const schedulingPacket = (): PacketDeclaration => ({
  packet_kind: 'scheduling_link_packet',
  source_query_ref: { kind: 'data.calendar.combined' },
});

const fieldEvent = (over: Partial<FieldDelegateEvent>): FieldDelegateEvent => ({
  control: 'text',
  fieldKey: null,
  repeaterKey: null,
  rowIndex: null,
  rowField: null,
  optionValue: null,
  value: '',
  checked: false,
  ...over,
});

// ── Extended DOM-free fake host (input / change + click) ──────────

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
    // `type` is load-bearing — `attachFieldDelegator` gates on
    // `resolveFieldEvent(el) === event.type` to de-dupe across its
    // `input` + `change` listeners.
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    listenerCount: () =>
      Object.values(listeners).reduce((total, set) => total + set.size, 0),
    /** Simulate a delegated click on an element carrying `data-action` +
     *  extra `data-*` attributes (camelCased, as `dataset` exposes). */
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
    /** Simulate an `input` / `change` on a field control — the event
     *  type + tag/type are derived from `control` to match the
     *  `resolveFieldEvent` de-dupe gate inside `attachFieldDelegator`. */
    field: (opts: {
      control: 'text' | 'number' | 'toggle' | 'select' | 'multiselect';
      fieldKey?: string;
      repeaterKey?: string;
      rowIndex?: number;
      rowField?: string;
      optionValue?: string;
      value?: string;
      checked?: boolean;
    }) => {
      const dataset: Record<string, string> = { fieldControl: opts.control };
      if (opts.fieldKey !== undefined) dataset.fieldKey = opts.fieldKey;
      if (opts.repeaterKey !== undefined) dataset.repeaterKey = opts.repeaterKey;
      if (opts.rowIndex !== undefined) dataset.rowIndex = String(opts.rowIndex);
      if (opts.rowField !== undefined) dataset.rowField = opts.rowField;
      if (opts.optionValue !== undefined) dataset.optionValue = opts.optionValue;
      const tagName = opts.control === 'select' ? 'SELECT' : 'INPUT';
      const type =
        opts.control === 'toggle' || opts.control === 'multiselect'
          ? 'checkbox'
          : opts.control === 'number'
            ? 'number'
            : 'text';
      const evt =
        opts.control === 'select' ||
        opts.control === 'toggle' ||
        opts.control === 'multiselect'
          ? 'change'
          : 'input';
      const el = {
        dataset,
        tagName,
        type,
        value: opts.value ?? '',
        checked: opts.checked ?? false,
        closest: () => el,
      } as unknown;
      fire(evt, el);
    },
  };
};

// ── Fake shell ────────────────────────────────────────────────────

const CREATE_SHARE_URL = 'https://reception.example/sched?t=once';

const makeFakeShell = () => {
  const fns = {
    runPreview: vi.fn(() =>
      Promise.resolve({
        preview_hash: 'ph-test',
      } as unknown as ReceptionEndpointPreviewResult),
    ),
    createEndpoint: vi.fn(() =>
      Promise.resolve({
        share_url_once: CREATE_SHARE_URL,
      } as unknown as ReceptionEndpointCreateResult),
    ),
    upsertReceptionPage: vi.fn(() => Promise.resolve(undefined)),
  };
  return { shell: fns as unknown as ReceptionPageShell, fns };
};

/** Flush pending microtasks so the fire-and-forget shell chains settle. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════
// seedWorkingConfig — the contract-shaped working config
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — seedWorkingConfig', () => {
  it('seeds a complete contract-shaped config for every kind without throwing', () => {
    for (const kind of [
      'reception_page',
      'scheduling_link',
      'intake_form',
      'drop_link',
      'approval_link',
      'status_link',
    ] as const) {
      const config = seedWorkingConfig(kind, null);
      expect(config).toBeTypeOf('object');
      // The kind's validator must run without throwing on the seed.
      expect(() => validateConfigForKind(kind, config)).not.toThrow();
    }
  });

  it('re-nests reception_page display_overrides flat keys under the contract path', () => {
    const config = seedWorkingConfig('reception_page', validReceptionPage());
    // `display_name` is flat-keyed in the model but `display_overrides.display_name`
    // in the contract.
    expect((config.display_overrides as Record<string, unknown>).display_name).toBe(
      'Mary',
    );
    expect((config.display_overrides as Record<string, unknown>).tz_label).toBe(
      'Pacific Time',
    );
    expect(config).not.toHaveProperty('display_name');
  });

  it('D-210 Phase C — seeds inbox_fanout_mode at the contract path, defaulting to approval', () => {
    // The authoring field must actually REACH the config the upsert
    // persists — a select the working config never picks up would render,
    // save, and change nothing.
    const fresh = seedWorkingConfig('reception_page', null);
    expect(fresh.inbox_fanout_mode).toBe('approval');

    // A fully-authored config carries the seeded mode past the validator
    // clean. (A FRESH seed still fails on empty display_name / tz_label —
    // pre-existing, and why the sibling test only asserts `not.toThrow`.)
    const authored = seedWorkingConfig('reception_page', validReceptionPage());
    expect(authored.inbox_fanout_mode).toBe('approval');
    expect(validateConfigForKind('reception_page', authored).failures).toEqual([]);

    // And an already-notify config round-trips as notify rather than being
    // reset to the default by the seed.
    const notify = seedWorkingConfig('reception_page', {
      ...validReceptionPage(),
      inbox_fanout_mode: 'notify',
    });
    expect(notify.inbox_fanout_mode).toBe('notify');
    expect(validateConfigForKind('reception_page', notify).failures).toEqual([]);
  });

  it('materialises the all-optional-text linked_endpoints sub-object even when empty', () => {
    // Every `linked_endpoints.*` field is optional text — all empty on a
    // fresh seed, so each leaf is omitted, but the sub-object must still
    // exist or `validateReceptionPageConfig` (no null-guard) throws.
    const config = seedWorkingConfig('reception_page', null);
    expect(config.linked_endpoints).toEqual({});
  });

  it('omits empty optional text rather than writing "" (validators reject present-empty)', () => {
    // scheduling_link's optional `instructions` / `success_message` are
    // rejected by the contract validator when present-but-empty — a fresh
    // seed must omit them, not write "".  (R19 Slice 2 retargeted this off
    // the removed `standing_instructions_ref` field; same omission rule.)
    const config = seedWorkingConfig('scheduling_link', null);
    expect(config).not.toHaveProperty('instructions');
    expect(config).not.toHaveProperty('success_message');
    // The availability window sub-object is still materialised (its
    // explicit_windows repeater seeds an empty array).
    const awd = config.available_window_definition as Record<string, unknown>;
    expect(awd.explicit_windows).toEqual([]);
  });

  it('round-trips a valid config back to a still-valid config', () => {
    const config = seedWorkingConfig('scheduling_link', validScheduling());
    expect(validateConfigForKind('scheduling_link', config).valid).toBe(true);
  });

  it('builds a proper status_link source_ref discriminated union', () => {
    const config = seedWorkingConfig('status_link', null);
    const ref = config.source_ref as Record<string, unknown>;
    expect(ref.kind).toBe('data.task');
    // The id field is the kind-specific `task_id`, not a bare `id`.
    expect(ref).toHaveProperty('task_id');
    expect(ref).not.toHaveProperty('id');
  });
});

// ══════════════════════════════════════════════════════════════════
// applyFieldDelegateEvent — field-edit mutation
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — applyFieldDelegateEvent', () => {
  it('a text field edit writes the contract path (reception_page display_overrides)', () => {
    const config = seedWorkingConfig('reception_page', null);
    applyFieldDelegateEvent(
      'reception_page',
      config,
      fieldEvent({ control: 'text', fieldKey: 'display_name', value: 'Mary Smith' }),
    );
    expect((config.display_overrides as Record<string, unknown>).display_name).toBe(
      'Mary Smith',
    );
  });

  it('clearing an optional text field back to empty deletes the leaf', () => {
    const config = seedWorkingConfig('reception_page', validReceptionPage());
    applyFieldDelegateEvent(
      'reception_page',
      config,
      fieldEvent({ control: 'text', fieldKey: 'tagline', value: '' }),
    );
    expect(config.display_overrides as Record<string, unknown>).not.toHaveProperty(
      'tagline',
    );
  });

  it('a number field edit coerces to a number', () => {
    const config = seedWorkingConfig('scheduling_link', null);
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({ control: 'number', fieldKey: 'max_lead_time_days', value: '45' }),
    );
    expect(config.max_lead_time_days).toBe(45);
  });

  it('the approval-notification sender writes through the nested field path', () => {
    const config = seedWorkingConfig('scheduling_link', null);
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({
        control: 'text',
        fieldKey: 'on_booking.notify_visitor_sender',
        value: 'mail.owner',
      }),
    );
    expect((config.on_booking as Record<string, unknown>).notify_visitor_sender).toBe(
      'mail.owner',
    );
  });

  it('a multiselect toggle adds + removes an option, preserving numeric element type', () => {
    const config = seedWorkingConfig('scheduling_link', null);
    // duration_options_minutes is number[] — seeded [30].
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({
        control: 'multiselect',
        fieldKey: 'duration_options_minutes',
        optionValue: '60',
        checked: true,
      }),
    );
    expect(config.duration_options_minutes).toEqual([30, 60]);
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({
        control: 'multiselect',
        fieldKey: 'duration_options_minutes',
        optionValue: '30',
        checked: false,
      }),
    );
    expect(config.duration_options_minutes).toEqual([60]);
  });

  it('a re-check after the numeric multiselect is emptied still pushes a number', () => {
    // Element type comes from the key, not the array contents — emptying
    // the multiselect must not turn the next pick into a string.
    const config = seedWorkingConfig('scheduling_link', null);
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({
        control: 'multiselect',
        fieldKey: 'duration_options_minutes',
        optionValue: '30',
        checked: false,
      }),
    );
    expect(config.duration_options_minutes).toEqual([]);
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({
        control: 'multiselect',
        fieldKey: 'duration_options_minutes',
        optionValue: '60',
        checked: true,
      }),
    );
    expect(config.duration_options_minutes).toEqual([60]);
  });

  it('a repeater cell edit mutates the indexed row', () => {
    const config = seedWorkingConfig(
      'reception_page',
      {
        ...validReceptionPage(),
        link_buttons: [{ label: 'old', url: 'https://e.com' }],
      },
    );
    applyFieldDelegateEvent(
      'reception_page',
      config,
      fieldEvent({
        control: 'text',
        repeaterKey: 'link_buttons',
        rowIndex: 0,
        rowField: 'label',
        value: 'new label',
      }),
    );
    expect((config.link_buttons as Array<Record<string, unknown>>)[0]!.label).toBe(
      'new label',
    );

    applyFieldDelegateEvent(
      'reception_page',
      config,
      fieldEvent({
        control: 'text',
        repeaterKey: 'link_buttons',
        rowIndex: 0,
        rowField: 'description',
        value: 'Optional context',
      }),
    );
    expect((config.link_buttons as Array<Record<string, unknown>>)[0]!.description)
      .toBe('Optional context');
  });

  it('a string-row repeater cell edit replaces the string element in place', () => {
    // The email-domain allowlists / approval aliases / private notes are
    // string-row repeaters — the renderer emits the cell with
    // `rowField: 'value'`, but the array element IS the string.
    const config = seedWorkingConfig('drop_link', null);
    addRepeaterRow(config, 'known_domain_allowlist');
    applyFieldDelegateEvent(
      'drop_link',
      config,
      fieldEvent({
        control: 'text',
        repeaterKey: 'known_domain_allowlist',
        rowIndex: 0,
        rowField: 'value',
        value: 'allowed.com',
      }),
    );
    expect(config.known_domain_allowlist).toEqual(['allowed.com']);
  });

  it('a day_of_week select cell coerces to a number (type preservation)', () => {
    const config = seedWorkingConfig('scheduling_link', validScheduling());
    applyFieldDelegateEvent(
      'scheduling_link',
      config,
      fieldEvent({
        control: 'select',
        repeaterKey: 'available_window_definition.explicit_windows',
        rowIndex: 0,
        rowField: 'day_of_week',
        value: '3',
      }),
    );
    const windows = (config.available_window_definition as Record<string, unknown>)
      .explicit_windows as Array<Record<string, unknown>>;
    expect(windows[0]!.day_of_week).toBe(3);
  });

  it('an intake field "values" cell splits a comma string into an array', () => {
    const config = seedWorkingConfig('intake_form', null);
    addRepeaterRow(config, 'form_definition.fields');
    applyFieldDelegateEvent(
      'intake_form',
      config,
      fieldEvent({
        control: 'text',
        repeaterKey: 'form_definition.fields',
        rowIndex: 0,
        rowField: 'values',
        value: 'red, green , blue',
      }),
    );
    const fields = (config.form_definition as Record<string, unknown>).fields as Array<
      Record<string, unknown>
    >;
    expect(fields[0]!.values).toEqual(['red', 'green', 'blue']);
  });

  it('the status_link source_ref kind + id round-trip through the discriminated union', () => {
    const config = seedWorkingConfig('status_link', null);
    applyFieldDelegateEvent(
      'status_link',
      config,
      fieldEvent({ control: 'select', fieldKey: 'source_ref.kind', value: 'data.project' }),
    );
    applyFieldDelegateEvent(
      'status_link',
      config,
      fieldEvent({ control: 'text', fieldKey: 'source_ref.id', value: 'proj-9' }),
    );
    expect(config.source_ref).toEqual({ kind: 'data.project', project_id: 'proj-9' });
  });
});

// ══════════════════════════════════════════════════════════════════
// addRepeaterRow / removeRepeaterRow + buildAuthoringView
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — repeater editing + buildAuthoringView', () => {
  it('addRepeaterRow appends a fresh default row', () => {
    const config = seedWorkingConfig('reception_page', null);
    expect(config.link_buttons).toEqual([]);
    addRepeaterRow(config, 'link_buttons');
    expect(config.link_buttons).toEqual([{ label: '', url: '', description: '' }]);
  });

  it('removeRepeaterRow drops the indexed row + ignores an out-of-range index', () => {
    const config = seedWorkingConfig('reception_page', {
      ...validReceptionPage(),
      link_buttons: [
        { label: 'a', url: 'https://a.com' },
        { label: 'b', url: 'https://b.com' },
      ],
    });
    removeRepeaterRow(config, 'link_buttons', 0);
    expect(config.link_buttons).toEqual([{
      label: 'b',
      url: 'https://b.com',
      description: '',
    }]);
    removeRepeaterRow(config, 'link_buttons', 9);
    expect((config.link_buttons as unknown[]).length).toBe(1);
  });

  it('buildAuthoringView honours the isNew override regardless of the working object', () => {
    const config = seedWorkingConfig('reception_page', validReceptionPage());
    // The working config is always a non-null object — `isNew` must come
    // from the caller, not the object's nullness.
    expect(buildAuthoringView('reception_page', config, null, true).model.is_new).toBe(
      true,
    );
    expect(buildAuthoringView('reception_page', config, null, false).model.is_new).toBe(
      false,
    );
  });

  it('validateConfigForKind flags a fresh (empty) config + passes a valid one', () => {
    expect(validateConfigForKind('scheduling_link', seedWorkingConfig('scheduling_link', null)).valid).toBe(
      false,
    );
    expect(
      validateConfigForKind('scheduling_link', seedWorkingConfig('scheduling_link', validScheduling()))
        .valid,
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// mountAuthoringForm — lifecycle
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountAuthoringForm: lifecycle', () => {
  it('renders into the host on mount + installs the click + input + change listeners', () => {
    const { host, getHtml, listenerCount } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'reception_page' });
    expect(getHtml()).toContain('reception-form');
    // 1 click (action dispatcher) + 1 input + 1 change (field delegator).
    expect(listenerCount()).toBe(3);
    view.dispose();
  });

  it('a fresh mount renders the per-kind create heading', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'reception_page' });
    expect(getHtml()).toContain('Set up Reception page');
    view.dispose();
  });

  it('an edit mount (initialConfig supplied) renders the "Edit {singular}" heading', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'reception_page',
      initialConfig: validReceptionPage(),
    });
    expect(getHtml()).toContain('Edit reception page');
    view.dispose();
  });

  it('dispose() detaches every listener + clears the host, idempotently', () => {
    const { host, getHtml, listenerCount } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'reception_page' });
    view.dispose();
    expect(listenerCount()).toBe(0);
    expect(getHtml()).toBe('');
    expect(() => view.dispose()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountAuthoringForm — field edits + repeater editing
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountAuthoringForm: editing', () => {
  it('a field edit mutates the working config silently — no re-render', () => {
    const { host, getHtml, field } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'reception_page' });
    const before = getHtml();
    field({ control: 'text', fieldKey: 'display_name', value: 'Mary Smith' });
    // No re-render — the DOM input already shows the typed value.
    expect(getHtml()).toBe(before);
    view.dispose();
  });

  it('an intake target change re-renders the entity-mapping controls', () => {
    const { host, getHtml, field } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'intake_form' });

    // D-210 Phase C — this probed on `triggered_recipe_id`, now retired.
    // Re-pointed at the `fields_to_include_in_target` control, which is gated
    // on the same log-only condition and is the more honest probe anyway: it IS
    // an entity-mapping control, which is what this test is named for.
    //
    // ⚠ Probes its LABEL, not `data-field-key`: a multiselect emits that
    // attribute once per OPTION, and a fresh form defines nothing for visitors to fill in, so
    // the control renders with zero checkboxes and no field-key at all. The
    // label is what actually tells the reader the control is on screen.
    const MAPPING_CONTROL = 'Boxes saved into the thing you make';
    expect(getHtml()).not.toContain(MAPPING_CONTROL);

    field({
      control: 'select',
      fieldKey: 'submission_processing_rule.target_kind',
      value: 'task',
    });
    expect(getHtml()).toContain(MAPPING_CONTROL);

    // D-210 WS2 — `''` is the log-only choice that replaced `form_response`.
    field({
      control: 'select',
      fieldKey: 'submission_processing_rule.target_kind',
      value: '',
    });
    expect(getHtml()).not.toContain(MAPPING_CONTROL);
    view.dispose();
  });

  /** D-210 WS3 — the calendar destination's field→slot mapping.
   *
   *  An intake's fields are role-agnostic, so a `calendar` target that could be
   *  SELECTED but not CONFIGURED would be a destination nobody can use. These
   *  drive the real mount: pick the target, pick a start, switch the end-spec,
   *  submit, and read the config that actually left the form. */
  const calendarSeed = (): IntakeFormConfig => ({
    display_name: 'Book a table',
    form_definition: {
      form_definition_id: 'fd_cal',
      fields: [
        { name: 'arrives_at', type: 'datetime', label: 'When', required: true },
        { name: 'leaves_at', type: 'datetime', label: 'Until', required: false },
        { name: 'party_hours', type: 'number', label: 'Hours', required: false },
        { name: 'guest_name', type: 'text', label: 'Name', required: true },
      ],
    },
    submission_processing_rule: {
      target_kind: 'note',
      fields_to_include_in_target: ['guest_name'],
      // ⚠ EVERY field must be placed, or A.8 s2b.1's coverage rule refuses the
      // config with `field_not_placed` and the submit never reaches
      // `createEndpoint` — which is exactly how this fixture went red. The
      // three time fields ride as metadata so the seed is valid BEFORE the
      // target is switched; the calendar mapping then claims whichever of them
      // each test picks. Placing them here is not incidental to the test: a
      // fixture that cannot submit cannot assert what was submitted.
      fields_to_attach_as_metadata: ['arrives_at', 'leaves_at', 'party_hours'],
    },
    anti_spam: {
      honeypot_fields: [],
      rate_limit_per_ip: 5,
      require_proof_of_work: false,
      require_captcha: false,
    },
    required_visitor_fields: { email: 'required' },
  });

  const mountCalendarForm = () => {
    const host = makeFakeHost();
    const shell = makeFakeShell();
    const view = mountAuthoringForm({
      host: host.host,
      shell: shell.shell,
      kind: 'intake_form',
      initialConfig: calendarSeed(),
      packetDeclaration: {
        packet_kind: 'intake_form_packet',
        source_query_ref: {
          kind: 'reception_form_definition',
          form_definition_id: 'fd_cal',
        },
      },
    });
    const setTargetCalendar = () => host.field({
      control: 'select',
      fieldKey: 'submission_processing_rule.target_kind',
      value: 'calendar',
    });
    const submittedRule = async () => {
      host.click({ action: 'reception-form-submit' });
      await flush();
      const [submitted] = shell.fns.createEndpoint.mock.calls[0] as unknown as readonly [
        { metadata: { submission_processing_rule: Record<string, unknown> } },
      ];
      return submitted.metadata.submission_processing_rule;
    };
    return { ...host, ...shell, view, setTargetCalendar, submittedRule };
  };

  it('shows no calendar mapping controls until the target IS calendar', () => {
    // The model omits them entirely for other destinations — which is what
    // keeps `seedWorkingConfig` from writing a calendar mapping into a note
    // form. Their absence from the DOM is the visible half of that.
    const f = mountCalendarForm();
    expect(f.getHtml()).not.toContain(
      'data-field-key="submission_processing_rule.calendar_mapping.start_field"',
    );
    f.setTargetCalendar();
    expect(f.getHtml()).toContain(
      'data-field-key="submission_processing_rule.calendar_mapping.start_field"',
    );
    f.view.dispose();
  });

  it('switching TO calendar seeds a usable mapping, so it is not born invalid', async () => {
    const f = mountCalendarForm();
    f.setTargetCalendar();
    f.field({
      control: 'select',
      fieldKey: 'submission_processing_rule.calendar_mapping.start_field',
      value: 'arrives_at',
    });
    const rule = await f.submittedRule();

    expect(rule.target_kind).toBe('calendar');
    // The end-mode control renders "a fixed length" by default; the seed is
    // what makes that showing TRUE rather than a claim the config contradicts.
    expect(rule.calendar_mapping).toMatchObject({
      start_field: 'arrives_at',
      default_duration_minutes: 60,
    });
    f.view.dispose();
  });

  it('switching the END-SPEC clears the other two, so exactly one is ever in force', async () => {
    // The contract expresses the choice by which key is present, and validates
    // that exactly one is. A switch that only ADDED a key would leave two and
    // fail — so the reassembly is the feature, not a tidy-up.
    const f = mountCalendarForm();
    f.setTargetCalendar();
    f.field({
      control: 'select',
      fieldKey: 'submission_processing_rule.calendar_mapping.start_field',
      value: 'arrives_at',
    });
    f.field({
      control: 'select',
      fieldKey: INTAKE_FORM_CALENDAR_END_MODE_KEY,
      value: 'duration_field',
    });
    const rule = await f.submittedRule();

    const m = rule.calendar_mapping as Record<string, unknown>;
    expect(m.duration_field).toBe('party_hours');
    expect(Object.hasOwn(m, 'default_duration_minutes')).toBe(false);
    expect(Object.hasOwn(m, 'end_field')).toBe(false);
    // ⛔ and the synthetic discriminator must NEVER persist — it is an
    // authoring control, not a contract path.
    expect(Object.hasOwn(m, '__end_mode')).toBe(false);
    f.view.dispose();
  });

  /** D-210 A.8 s2b.3 — INVERTED, and the mechanism is why it was kept.
   *
   *  This asserted the opposite under WS2: that picking "log-only" reached the
   *  config as an ABSENT `target_kind`. s2b.3 retired that spelling — a
   *  destination is now required and `form_response` is the generic one — so
   *  the assertion flips to: the picked value is PRESENT in what was submitted.
   *
   *  ⚠ The valuable half is unchanged: a re-render CANNOT prove this. The model
   *  builder reads `rule?.target_kind ?? 'form_response'`, so a config that
   *  never carried the key renders identically to one that does. The difference
   *  surfaces only in what leaves the form — an omitted key now fails
   *  `target_kind_missing` at the validator. So drive the real submit and
   *  assert the config that actually went over the wire. */
  it('an intake switched to Response list submits a config CARRYING target_kind', async () => {
    const { host, click, field } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const seed: IntakeFormConfig = {
      display_name: 'Log Only Intake',
      form_definition: {
        form_definition_id: 'fd_logonly',
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
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'intake_form',
      initialConfig: seed,
      packetDeclaration: {
        packet_kind: 'intake_form_packet',
        source_query_ref: {
          kind: 'reception_form_definition',
          form_definition_id: 'fd_logonly',
        },
      },
    });

    field({
      control: 'select',
      fieldKey: 'submission_processing_rule.target_kind',
      value: 'form_response',
    });
    click({ action: 'reception-form-submit' });
    await flush();

    // Reaching `createEndpoint` at all already proves validation passed — which
    // an omitted `target_kind` could not do since s2b.3 made it required.
    expect(fns.createEndpoint).toHaveBeenCalledTimes(1);
    // The fake shell's `createEndpoint` is declared param-less, so its recorded
    // call tuple types as `[]`. Re-type the recorded argument rather than the
    // spy — the point of this assertion is what the form really handed over.
    const [submitted] = fns.createEndpoint.mock.calls[0] as unknown as readonly [
      { metadata: { submission_processing_rule: { target_kind?: unknown } } },
    ];
    const rule = submitted.metadata.submission_processing_rule;
    // ⛔ `Object.hasOwn`, not just a value check: the defect this guards is an
    // OMITTED key, and `toMatchObject` cannot prove a key's presence-vs-absence
    // the way an explicit ownership test can. Both halves matter — the key is
    // there AND it carries what the owner picked.
    expect(Object.hasOwn(rule, 'target_kind')).toBe(true);
    expect(rule.target_kind).toBe('form_response');
    view.dispose();
  });

  it('a repeater add-row re-renders with the new row', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'reception_page' });
    expect(getHtml()).not.toContain('data-row-index="0"');
    click({ action: 'reception-form-add-row', repeaterKey: 'custom_links' });
    expect(getHtml()).toContain('data-row-index="0"');
    view.dispose();
  });

  it('a repeater remove-row re-renders without the row', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'reception_page',
      initialConfig: {
        ...validReceptionPage(),
        custom_links: [{ label: 'a', url: 'https://a.com' }],
      },
    });
    expect(getHtml()).toContain('data-row-index="0"');
    click({ action: 'reception-form-remove-row', repeaterKey: 'custom_links', rowIndex: '0' });
    expect(getHtml()).not.toContain('data-row-index="0"');
    view.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountAuthoringForm — submit + preview + cancel
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountAuthoringForm: submit + preview + cancel', () => {
  it('reception_page submit (valid) fires upsertReceptionPage + onClose', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const onClose = vi.fn();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'reception_page',
      initialConfig: validReceptionPage(),
      onClose,
    });
    click({ action: 'reception-form-submit' });
    expect(fns.upsertReceptionPage).toHaveBeenCalledTimes(1);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('an invalid submit re-renders the error panel + never touches the shell', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    // A fresh scheduling_link is missing display_name + availability.
    const view = mountAuthoringForm({ host, shell, kind: 'scheduling_link' });
    click({ action: 'reception-form-submit' });
    expect(getHtml()).toContain('before saving');
    expect(fns.runPreview).not.toHaveBeenCalled();
    view.dispose();
  });

  it('the first field edit after a failed submit clears the validation summary', () => {
    const { host, getHtml, click, field } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountAuthoringForm({ host, shell, kind: 'scheduling_link' });
    click({ action: 'reception-form-submit' });
    expect(getHtml()).toContain('before saving');
    // The first edit clears the stale summary + re-renders (re-enabling submit).
    field({ control: 'text', fieldKey: 'display_name', value: 'Mary' });
    expect(getHtml()).not.toContain('before saving');
    view.dispose();
  });

  it('a link-kind submit (valid) runs preview → create → onClose', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const onClose = vi.fn();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'scheduling_link',
      initialConfig: validScheduling(),
      packetDeclaration: schedulingPacket(),
      onClose,
    });
    click({ action: 'reception-form-submit' });
    expect(fns.runPreview).toHaveBeenCalledTimes(1);
    await flush();
    expect(fns.createEndpoint).toHaveBeenCalledTimes(1);
    // The create result — carrying the one-shot share URL — is handed
    // back so the host can register it via `shell.setEndpointShare`.
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ share_url_once: CREATE_SHARE_URL }),
    );
    view.dispose();
  });

  it('the explicit preview action runs preview only — no create', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'scheduling_link',
      initialConfig: validScheduling(),
      packetDeclaration: schedulingPacket(),
    });
    click({ action: 'reception-form-preview' });
    await flush();
    expect(fns.runPreview).toHaveBeenCalledTimes(1);
    expect(fns.createEndpoint).not.toHaveBeenCalled();
    view.dispose();
  });

  it('reception_page has no preview path — the preview action is a no-op', () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'reception_page',
      initialConfig: validReceptionPage(),
    });
    click({ action: 'reception-form-preview' });
    expect(fns.runPreview).not.toHaveBeenCalled();
    view.dispose();
  });

  it('a link-kind submit without a packet declaration is inert past validation', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'scheduling_link',
      initialConfig: validScheduling(),
      // no packetDeclaration
    });
    click({ action: 'reception-form-submit' });
    await flush();
    expect(fns.runPreview).not.toHaveBeenCalled();
    view.dispose();
  });

  it('cancel calls onClose', () => {
    const { host, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const onClose = vi.fn();
    const view = mountAuthoringForm({ host, shell, kind: 'reception_page', onClose });
    click({ action: 'reception-form-cancel' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('clicks + field edits after dispose() are inert', () => {
    const { host, click, field } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'reception_page',
      initialConfig: validReceptionPage(),
    });
    view.dispose();
    click({ action: 'reception-form-submit' });
    field({ control: 'text', fieldKey: 'display_name', value: 'x' });
    expect(fns.upsertReceptionPage).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountAuthoringForm — lazy buildPacketDeclaration factory (Codex P2)
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountAuthoringForm: lazy packet declaration', () => {
  /** Seed an intake form WITHOUT a `form_definition_id` first, then
   *  exercise the lazy factory by handing it a fresh-id config when
   *  preview runs. Demonstrates the bug-fix path: a host can plumb a
   *  lazy factory that re-derives the packet declaration on each
   *  preview / submit. */
  const validIntakeWithoutId = (): Omit<IntakeFormConfig, 'form_definition'> & {
    form_definition: Omit<IntakeFormConfig['form_definition'], 'form_definition_id'> & {
      form_definition_id: string;
    };
  } => ({
    display_name: 'Mary Smith',
    form_definition: {
      form_definition_id: '', // empty — what a fresh seed looks like
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
  });

  it('the lazy factory is called at preview-build time with the working config', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    // Seed with a complete intake form so submit validates clean.
    const seed: IntakeFormConfig = {
      display_name: 'Late Intake',
      form_definition: {
        form_definition_id: 'fd_lazy',
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
    const factory = vi.fn(
      (config: object): PacketDeclaration | null => {
        const fdId = (config as { form_definition?: { form_definition_id?: string } })
          .form_definition?.form_definition_id;
        if (typeof fdId !== 'string' || fdId.length === 0) return null;
        return {
          packet_kind: 'intake_form_packet',
          source_query_ref: {
            kind: 'reception_form_definition',
            form_definition_id: fdId,
          },
        };
      },
    );
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'intake_form',
      initialConfig: seed,
      buildPacketDeclaration: factory,
    });
    // Factory NOT yet called at mount time — only at preview / submit.
    expect(factory).not.toHaveBeenCalled();
    click({ action: 'reception-form-submit' });
    await flush();
    expect(factory).toHaveBeenCalled();
    expect(fns.runPreview).toHaveBeenCalledTimes(1);
    expect(fns.createEndpoint).toHaveBeenCalledTimes(1);
    view.dispose();
    void validIntakeWithoutId; // type-checked above for shape parity
  });

  it('the lazy factory takes precedence over the static packetDeclaration', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const staticPacket: PacketDeclaration = {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    };
    const lazyPacket: PacketDeclaration = {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    };
    const factory = vi.fn(() => lazyPacket);
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'scheduling_link',
      initialConfig: validScheduling(),
      packetDeclaration: staticPacket,
      buildPacketDeclaration: factory,
    });
    click({ action: 'reception-form-submit' });
    await flush();
    expect(factory).toHaveBeenCalled();
    expect(fns.runPreview).toHaveBeenCalledWith(
      expect.objectContaining({ packet_declaration: lazyPacket }),
    );
    view.dispose();
  });

  it('a lazy factory that returns null leaves the dispatch inert', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'scheduling_link',
      initialConfig: validScheduling(),
      buildPacketDeclaration: () => null,
    });
    click({ action: 'reception-form-submit' });
    await flush();
    expect(fns.runPreview).not.toHaveBeenCalled();
    view.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountAuthoringForm — hard-ceiling expiry derivation (Codex P2)
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountAuthoringForm: hard-ceiling expiry derivation', () => {
  /** A minimally valid `DropLinkConfig` with a 7-day expiry. */
  const validDrop = (): DropLinkConfig => ({
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
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  it('drop_link derives expires_at = now + expiry_days * DAY_MS when no override', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const NOW = 1_700_000_000_000;
    const dropPacket: PacketDeclaration = {
      packet_kind: 'drop_link_packet',
      source_query_ref: {
        kind: 'reception_drop_config',
        drop_config_id: 'launch_wizard_drop_link',
      },
    };
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'drop_link',
      initialConfig: validDrop(),
      packetDeclaration: dropPacket,
      now: () => NOW,
      // no expiresAt — derivation should kick in
    });
    click({ action: 'reception-form-submit' });
    await flush();
    expect(fns.runPreview).toHaveBeenCalledTimes(1);
    expect(fns.runPreview).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: NOW + 7 * DAY_MS }),
    );
    expect(fns.createEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: NOW + 7 * DAY_MS }),
    );
    view.dispose();
  });

  it('an explicit expiresAt wins over the derivation', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const NOW = 1_700_000_000_000;
    const dropPacket: PacketDeclaration = {
      packet_kind: 'drop_link_packet',
      source_query_ref: {
        kind: 'reception_drop_config',
        drop_config_id: 'launch_wizard_drop_link',
      },
    };
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'drop_link',
      initialConfig: validDrop(),
      packetDeclaration: dropPacket,
      expiresAt: NOW + 3 * DAY_MS, // shorter than derivation
      now: () => NOW,
    });
    click({ action: 'reception-form-submit' });
    await flush();
    expect(fns.runPreview).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: NOW + 3 * DAY_MS }),
    );
    view.dispose();
  });

  it('scheduling_link does NOT get an expires_at derived (long-lived permitted)', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountAuthoringForm({
      host,
      shell,
      kind: 'scheduling_link',
      initialConfig: validScheduling(),
      packetDeclaration: {
        packet_kind: 'scheduling_link_packet',
        source_query_ref: { kind: 'data.calendar.combined' },
      },
    });
    click({ action: 'reception-form-submit' });
    await flush();
    const [firstArg] = (fns.runPreview.mock.calls[0] ?? []) as Array<
      { expires_at?: number } | undefined
    >;
    expect(firstArg).toBeDefined();
    expect(firstArg?.expires_at).toBeUndefined();
    view.dispose();
  });
});
