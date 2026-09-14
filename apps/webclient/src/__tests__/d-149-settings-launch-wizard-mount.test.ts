/** D-149 § A.20.1 follow-on — Settings → Server → Reception Launch
 *  Wizard mount acceptance.
 *
 *  `mountLaunchWizard` is the wizard's step-cursor + per-step
 *  working-config container — tested through the same extended DOM-free
 *  fake host the authoring-mount test uses (`input` / `change` field-event
 *  simulation + `click`) + a fake shell. The non-obvious things under
 *  test: the config-editing steps embed `renderAuthoringForm` into the
 *  renderer's `data-wizard-step` slot via string injection; the
 *  non-config steps' slots are filled by the `renderStepContent` host
 *  seam; the cursor navigation hops over the excluded optional
 *  `drop_link` step; finish validates then fires `shell.runLaunchWizard`. */

import { describe, expect, it, vi } from 'vitest';
import type {
  DropLinkConfig,
  IntakeFormConfig,
  ReceptionPageConfig,
  SchedulingLinkConfig,
} from '@recued/contracts';
import { RECEPTION_RECOMMENDED_EXPOSURE_PROFILE } from '@recued/contracts';

import {
  mountLaunchWizard,
  LAUNCH_WIZARD_MOUNT_STYLES,
} from '../settings/reception-launch-wizard-mount.js';
import type { LaunchWizardRunResult } from '../settings/reception-page-shell.js';
import type { ReceptionPageShell } from '../settings/reception-page-shell.js';

const NOW = 1_700_000_000_000;

// ── Fixtures — the minimal valid per-kind configs the wizard produces ──

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

const goodConfigs = () => ({
  reception_page: goodReceptionPage,
  scheduling_link: goodScheduling,
  intake_form: goodIntake,
  drop_link: goodDrop,
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
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
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

const makeFakeShell = () => {
  const fns = {
    runLaunchWizard: vi.fn(() =>
      Promise.resolve({ page_upserted: true, created: [] } as LaunchWizardRunResult),
    ),
  };
  return { shell: fns as unknown as ReceptionPageShell, fns };
};

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const baseOpts = (host: HTMLElement, shell: ReceptionPageShell) => ({
  host,
  shell,
  exposureProfile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  now: () => NOW,
});

// ══════════════════════════════════════════════════════════════════
// mountLaunchWizard — lifecycle + frame
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountLaunchWizard: lifecycle + frame', () => {
  it('renders the wizard frame on mount + installs the click + input + change listeners', () => {
    const { host, getHtml, listenerCount } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard(baseOpts(host, shell));
    expect(getHtml()).toContain('Set up Reception');
    expect(getHtml()).toContain('Step 1 of 7');
    expect(listenerCount()).toBe(3);
    view.dispose();
  });

  it('dispose() detaches every listener + clears the host, idempotently', () => {
    const { host, getHtml, listenerCount } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard(baseOpts(host, shell));
    view.dispose();
    expect(listenerCount()).toBe(0);
    expect(getHtml()).toBe('');
    expect(() => view.dispose()).not.toThrow();
  });

  it('LAUNCH_WIZARD_MOUNT_STYLES hides the embedded authoring action bar', () => {
    expect(LAUNCH_WIZARD_MOUNT_STYLES.length).toBeGreaterThan(0);
    expect(LAUNCH_WIZARD_MOUNT_STYLES).toContain('.reception-wizard-step-slot');
    expect(LAUNCH_WIZARD_MOUNT_STYLES).toContain('display: none');
  });
});

// ══════════════════════════════════════════════════════════════════
// mountLaunchWizard — per-step content slot
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountLaunchWizard: step content slot', () => {
  it('a config-editing step injects renderAuthoringForm into the slot', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'reception_page',
    });
    expect(getHtml()).toContain('data-wizard-step="reception_page"');
    // The injected authoring form for the reception_page kind.
    expect(getHtml()).toContain('data-kind="reception_page"');
    expect(getHtml()).toContain('data-field-key="display_name"');
    view.dispose();
  });

  it('a non-config step uses the renderStepContent host seam', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const renderStepContent = vi.fn((stepId: string) =>
      stepId === 'profile_check' ? '<p data-test="custom-gate">posture</p>' : null,
    );
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'profile_check',
      renderStepContent,
    });
    expect(renderStepContent).toHaveBeenCalledWith('profile_check');
    expect(getHtml()).toContain('data-test="custom-gate"');
    view.dispose();
  });

  it('a non-config step with no renderStepContent leaves the slot empty', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'share',
    });
    expect(getHtml()).toContain('data-wizard-step="share"></div>');
    view.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountLaunchWizard — navigation
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountLaunchWizard: navigation', () => {
  it('reception-wizard-next advances the cursor', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard(baseOpts(host, shell));
    expect(getHtml()).toContain('data-current-step="profile_check"');
    click({ action: 'reception-wizard-next' });
    expect(getHtml()).toContain('data-current-step="reception_page"');
    view.dispose();
  });

  it('reception-wizard-prev steps back', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'intake_form',
    });
    click({ action: 'reception-wizard-prev' });
    expect(getHtml()).toContain('data-current-step="scheduling_link"');
    view.dispose();
  });

  it('reception-wizard-goto-step jumps to a named step', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard(baseOpts(host, shell));
    click({ action: 'reception-wizard-goto-step', stepId: 'share' });
    expect(getHtml()).toContain('data-current-step="share"');
    view.dispose();
  });

  it('reception-wizard-toggle-drop-link flips the active-step count 7 ↔ 6', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'drop_link',
    });
    expect(getHtml()).toContain('of 7');
    click({ action: 'reception-wizard-toggle-drop-link' });
    expect(getHtml()).toContain('of 6');
    view.dispose();
  });

  it('reception-wizard-switch-profile forwards to onSwitchProfile', () => {
    const { host, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const onSwitchProfile = vi.fn();
    const view = mountLaunchWizard({ ...baseOpts(host, shell), onSwitchProfile });
    click({ action: 'reception-wizard-switch-profile' });
    expect(onSwitchProfile).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('reception-wizard-cancel calls onClose', () => {
    const { host, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const onClose = vi.fn();
    const view = mountLaunchWizard({ ...baseOpts(host, shell), onClose });
    click({ action: 'reception-wizard-cancel' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountLaunchWizard — config-step editing
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountLaunchWizard: config-step editing', () => {
  it('a field edit on a config step is preserved across a re-render', () => {
    const { host, getHtml, click, field } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'reception_page',
    });
    field({ control: 'text', fieldKey: 'display_name', value: 'Mary Edited' });
    // The field edit is silent; force a re-render via the drop-link toggle
    // and assert the reception_page step content reflects the edit.
    click({ action: 'reception-wizard-toggle-drop-link' });
    expect(getHtml()).toContain('value="Mary Edited"');
    view.dispose();
  });

  it('a repeater add-row on a config step re-renders with the new row', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'reception_page',
    });
    expect(getHtml()).not.toContain('data-row-index="0"');
    click({ action: 'reception-form-add-row', repeaterKey: 'custom_links' });
    expect(getHtml()).toContain('data-row-index="0"');
    view.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// mountLaunchWizard — finish + plan preview
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountLaunchWizard: finish + plan preview', () => {
  it('the live plan preview appears once the four working configs validate clean', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialConfigs: goodConfigs(),
    });
    expect(getHtml()).toContain('What this will set up for you');
    view.dispose();
  });

  it('no plan preview when the configs are incomplete (fresh seed)', () => {
    const { host, getHtml } = makeFakeHost();
    const { shell } = makeFakeShell();
    const view = mountLaunchWizard(baseOpts(host, shell));
    expect(getHtml()).not.toContain('What this will set up for you');
    view.dispose();
  });

  it('finish (valid configs) fires shell.runLaunchWizard + onClose', async () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const onClose = vi.fn();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'share',
      initialConfigs: goodConfigs(),
      onClose,
    });
    click({ action: 'reception-wizard-finish' });
    expect(fns.runLaunchWizard).toHaveBeenCalledTimes(1);
    await flush();
    // The run result — each `created[].result` carries a one-shot share
    // URL — is handed back so the host can register the Share Cards.
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ page_upserted: true }),
    );
    view.dispose();
  });

  it('finish (invalid configs) renders the validation gate + never touches the shell', () => {
    const { host, getHtml, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    // Fresh seed ⇒ the four configs are incomplete ⇒ the wizard input is invalid.
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'share',
    });
    click({ action: 'reception-wizard-finish' });
    expect(getHtml()).toContain('before you finish');
    expect(fns.runLaunchWizard).not.toHaveBeenCalled();
    view.dispose();
  });

  it('clicks after dispose() are inert', () => {
    const { host, click } = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const view = mountLaunchWizard({
      ...baseOpts(host, shell),
      initialStep: 'share',
      initialConfigs: goodConfigs(),
    });
    view.dispose();
    click({ action: 'reception-wizard-finish' });
    expect(fns.runLaunchWizard).not.toHaveBeenCalled();
  });
});
