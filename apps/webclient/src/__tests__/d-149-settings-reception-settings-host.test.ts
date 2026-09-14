/** D-149 follow-on § A.9 — Reception Settings composition acceptance.
 *
 *  `mountReceptionSettings` is the PWA-shell wiring layer: it composes
 *  `mountReceptionPromptsHost` + `mountReceptionPageHost` over three
 *  pre-built host elements + bridges the page host's `onPromptAction`
 *  to the prompts host's `open()`. These tests drive it through the
 *  same DOM-free fake-host pattern every Reception mount test uses,
 *  with a fake shell that returns deterministic results.
 *
 *  The non-obvious things under test:
 *    - the three hosts mount in the right order (prompts first, page
 *      second — DD#2), so the page host's `onPromptAction` binds to a
 *      live prompts-host handle synchronously;
 *    - clicks on the page mount's prompt-driven `data-action` buttons
 *      land the right prompt modal in the prompts-host element WITHOUT
 *      touching the modalHost element;
 *    - clicks on the page mount's mount-launching `data-action` buttons
 *      land the right satellite in the modalHost element WITHOUT
 *      touching the promptsHost element;
 *    - dispose tears down both hosts in reverse mount order (DD#3) and
 *      is idempotent (DD#5);
 *    - every seam (resolvePageConfig / resolveTemplateSeed /
 *      buildPacketDeclaration / renderWizardStepContent / onSwitchProfile
 *      / now / onPromptClose) is forwarded verbatim;
 *    - the `now` seam is shared across both hosts. */

import { describe, expect, it, vi } from 'vitest';
import type {
  EndpointSummary,
  IntakeFormConfig,
  IntakeFormTemplate,
  IntakeFormTemplateRef,
  PacketDeclaration,
  ReceptionEndpointCreateResult,
  ReceptionEndpointKind,
  ReceptionEndpointPreviewResult,
  ReceptionEndpointRotateResult,
  ReceptionPageConfig,
  ShareCardsInput,
} from '@recued/contracts';
import {
  INTAKE_FORM_TEMPLATE_REFS,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
} from '@recued/contracts';

import {
  mountReceptionSettings,
  RECEPTION_SETTINGS_SHELL_SLOTS,
  RECEPTION_SETTINGS_SHELL_STYLES,
} from '../settings/reception-settings-host.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../settings/reception-page-shell.js';
import { buildReceptionPageModel } from '../settings/reception.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────
// Fake hosts — three of them, one per slot. The fake supports the
// click + input + change events the underlying mounts attach.
// ──────────────────────────────────────────────────────────────────

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
    listenerCount: () =>
      Object.values(listeners).reduce((total, set) => total + set.size, 0),
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
    field: (opts: {
      promptField: string;
      kind: 'text' | 'date' | 'textarea' | 'select' | 'checkbox';
      value?: string;
      checked?: boolean;
    }) => {
      const dataset: Record<string, string> = { promptField: opts.promptField };
      const tagName =
        opts.kind === 'select'
          ? 'SELECT'
          : opts.kind === 'textarea'
            ? 'TEXTAREA'
            : 'INPUT';
      const type =
        opts.kind === 'checkbox'
          ? 'checkbox'
          : opts.kind === 'date'
            ? 'date'
            : 'text';
      const evt =
        opts.kind === 'select' || opts.kind === 'checkbox' ? 'change' : 'input';
      const el = {
        dataset,
        tagName,
        type,
        value: opts.value ?? '',
        checked: opts.checked ?? false,
        closest: (sel: string) => (sel === '[data-prompt-field]' ? el : null),
      } as unknown;
      fire(evt, el);
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake shell — both the page host + the prompts host drive rpc through
// this. Seeds a loaded page model so the prompts host's row lookups
// (for rotate-share registration + hard-ceiling gating) succeed.
// ──────────────────────────────────────────────────────────────────

const placeholderPacket = (kind: ReceptionEndpointKind): PacketDeclaration => ({
  packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[kind],
  source_query_ref:
    kind === 'reception_page'
      ? { kind: 'reception_page_config' }
      : { kind: 'data.calendar.combined' },
});

const summary = (
  over: Partial<EndpointSummary> & {
    endpoint_id: string;
    kind: ReceptionEndpointKind;
  },
): EndpointSummary => ({
  endpoint_id: over.endpoint_id,
  kind: over.kind,
  metadata: over.metadata ?? {},
  enabled: over.enabled ?? true,
  packet_declaration: over.packet_declaration ?? placeholderPacket(over.kind),
  expires_at: over.expires_at ?? null,
  long_lived_acknowledged_at: over.long_lived_acknowledged_at ?? null,
  revoked_at: over.revoked_at ?? null,
  revocation_reason: over.revocation_reason ?? null,
  audit_count: over.audit_count ?? 0,
  last_accessed_at: over.last_accessed_at ?? null,
  created_at: over.created_at ?? NOW - DAY_MS,
  created_by_client_id: over.created_by_client_id ?? 'cli-test',
});

const makeFakeShell = (overrides?: {
  createResult?: ReceptionEndpointCreateResult;
  runResult?: LaunchWizardRunResult;
  rotateResult?: ReceptionEndpointRotateResult;
}) => {
  const endpoints: ReadonlyArray<EndpointSummary> = [
    summary({ endpoint_id: 'ep-sched', kind: 'scheduling_link' }),
    summary({ endpoint_id: 'ep-drop', kind: 'drop_link', expires_at: NOW + 7 * DAY_MS }),
    summary({ endpoint_id: 'ep-intake', kind: 'intake_form' }),
  ];
  let current: ReceptionPageShellState = {
    page: buildReceptionPageModel({
      endpoints,
      status: {
        reception_public: true,
        emergency_disabled: false,
        base_url: 'https://reception.example',
      },
      now: NOW,
    }),
    detail: null,
    abuse_inbox: null,
    view_as_visitor: null,
    status: {
      reception_public: true,
      emergency_disabled: false,
      base_url: 'https://reception.example',
    },
    last_error: null,
    loading: false,
  };
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const noop = (): void => undefined;
  const fns = {
    loadPage: vi.fn(() => Promise.resolve(undefined)),
    enableEndpoint: vi.fn(() => Promise.resolve(undefined)),
    disableEndpoint: vi.fn(() => Promise.resolve(undefined)),
    revokeEndpoint: vi.fn(() => Promise.resolve(undefined)),
    extendEndpoint: vi.fn(() => Promise.resolve(undefined)),
    rotateToken: vi.fn(() =>
      Promise.resolve(
        overrides?.rotateResult ?? {
          bearer_secret_once: 'bs-rotated',
          share_url_once: 'https://reception.example/rotated?t=once',
        },
      ),
    ),
    emergencyDisableAll: vi.fn(() => Promise.resolve(undefined)),
    openDetail: vi.fn(() => Promise.resolve(undefined)),
    previewEndpointAsVisitor: vi.fn(() => Promise.resolve(undefined)),
    loadAbuseInbox: vi.fn(() => Promise.resolve(undefined)),
    banIp: vi.fn(() => Promise.resolve(undefined)),
    unbanIp: vi.fn(() => Promise.resolve(undefined)),
    runPreview: vi.fn(() =>
      Promise.resolve({
        preview_hash: 'ph-test',
      } as unknown as ReceptionEndpointPreviewResult),
    ),
    createEndpoint: vi.fn(() =>
      Promise.resolve(
        overrides?.createResult ?? {
          endpoint_id: 'ep-fresh',
          public_locator: 'pl-fresh',
          bearer_secret_once: 'bs-fresh',
          share_url_once: 'https://reception.example/new?t=once',
          enabled: false,
        },
      ),
    ),
    upsertReceptionPage: vi.fn(() => Promise.resolve(undefined)),
    runLaunchWizard: vi.fn(() => Promise.resolve(overrides?.runResult ?? { page_upserted: true, created: [] })),
    closeDetail: vi.fn(noop),
    closeViewAsVisitor: vi.fn(noop),
    setStatus: vi.fn(noop),
    setEndpointShare: vi.fn((_id: string, _share: ShareCardsInput): void => undefined),
    dispose: vi.fn(noop),
  };
  const shell = {
    getState: () => current,
    subscribe: (l: (s: ReceptionPageShellState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...fns,
  } as unknown as ReceptionPageShell;
  return { shell, fns };
};

const baseOpts = (
  pageHost: HTMLElement,
  modalHost: HTMLElement,
  promptsHost: HTMLElement,
  shell: ReceptionPageShell,
) => ({
  pageHost,
  modalHost,
  promptsHost,
  shell,
  exposureProfile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  now: () => NOW,
});

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════
// Closed-list invariants
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — settings host closed lists', () => {
  it('exposes the three shell slot names', () => {
    expect(new Set(RECEPTION_SETTINGS_SHELL_SLOTS)).toEqual(
      new Set(['page', 'modal', 'prompts']),
    );
  });

  it('exports a non-empty CSS string for the recommended layout', () => {
    expect(RECEPTION_SETTINGS_SHELL_STYLES.length).toBeGreaterThan(0);
    // Sanity check — the styles target all three slots.
    for (const slot of RECEPTION_SETTINGS_SHELL_SLOTS) {
      expect(RECEPTION_SETTINGS_SHELL_STYLES).toContain(`data-reception-shell-slot="${slot}"`);
    }
  });

  it('overlay slots are scrollable when content exceeds the viewport (Codex P2 fold)', () => {
    // `position: fixed; inset: 0` without `overflow-y: auto` clips the
    // top edge of a tall mount (the wizard's preview step + the long
    // authoring fieldsets routinely exceed mobile / small-laptop
    // viewports). Lock the scrollability in via the styles export so
    // consumers stamping these recommended styles do not inherit a
    // viewport-clipping defect.
    expect(RECEPTION_SETTINGS_SHELL_STYLES).toContain('overflow-y: auto');
    expect(RECEPTION_SETTINGS_SHELL_STYLES).toContain('align-items: flex-start');
    expect(RECEPTION_SETTINGS_SHELL_STYLES).toContain('backdrop-filter: blur(8px)');
  });
});

// ══════════════════════════════════════════════════════════════════
// Lifecycle — mount, dispose, idempotent
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionSettings: lifecycle', () => {
  it('mounts the page-spine list onto pageHost + leaves modalHost + promptsHost empty', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    expect(page.getHtml().length).toBeGreaterThan(0);
    expect(modal.getHtml()).toBe('');
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });

  it('attaches listeners to all three host elements at mount time', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    // The page mount installs click delegation; the prompts host installs
    // click + input + change. The modal host stays bare until a satellite
    // mounts (the inner page host doesn't bind listeners to modalHost
    // itself).
    expect(page.listenerCount()).toBeGreaterThan(0);
    expect(prompts.listenerCount()).toBeGreaterThan(0);
    host.dispose();
  });

  it('dispose() tears down all three hosts + every listener, idempotently', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    // Open one satellite + one prompt so dispose has work to do.
    page.click({ action: 'reception-new-endpoint', kind: 'intake_form' });
    page.click({ action: 'reception-extend', endpointId: 'ep-sched' });
    expect(modal.getHtml().length).toBeGreaterThan(0);
    expect(prompts.getHtml().length).toBeGreaterThan(0);
    host.dispose();
    expect(page.listenerCount()).toBe(0);
    expect(modal.listenerCount()).toBe(0);
    expect(prompts.listenerCount()).toBe(0);
    expect(page.getHtml()).toBe('');
    expect(modal.getHtml()).toBe('');
    expect(prompts.getHtml()).toBe('');
    expect(() => host.dispose()).not.toThrow();
  });

  it('update() drives a page-mount redraw without touching the satellite or prompts hosts', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    const before = page.getHtml();
    host.update();
    expect(page.getHtml()).toBe(before);
    expect(modal.getHtml()).toBe('');
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });

  it('update() after dispose() is a no-op', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    host.dispose();
    // The inner page host throws on `update()` after dispose; the shell
    // guards against that with its own `disposed` flag.
    expect(() => host.update()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// Prompt-driven action bridge — the load-bearing wiring
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionSettings: prompt bridge', () => {
  it('a reception-extend click on the page lands the extend modal on promptsHost (not modalHost)', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-extend', endpointId: 'ep-sched' });
    expect(prompts.getHtml()).toContain('Give it more time');
    expect(prompts.getHtml()).toContain('ep-sched');
    expect(modal.getHtml()).toBe('');
    host.dispose();
  });

  it('a reception-rotate-token click on the page lands the rotate modal on promptsHost', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-rotate-token', endpointId: 'ep-sched' });
    expect(prompts.getHtml()).toContain('Swap the secret');
    expect(modal.getHtml()).toBe('');
    host.dispose();
  });

  it('a reception-revoke click on the page lands the revoke modal on promptsHost', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-revoke', endpointId: 'ep-sched' });
    expect(prompts.getHtml()).toContain('Take this link back');
    expect(modal.getHtml()).toBe('');
    host.dispose();
  });

  it('a reception-emergency-disable-all click on the page lands the kill-switch modal on promptsHost', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-emergency-disable-all' });
    expect(prompts.getHtml()).toContain('Turn Reception off right now?');
    expect(modal.getHtml()).toBe('');
    host.dispose();
  });

  it('a prompt-driven action against the singleton is a no-op (DD#2 of prompts host)', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    // The page renderer never emits this for the singleton, but a hand-
    // crafted dataset still gets bridged + the prompts host bails.
    page.click({
      action: 'reception-extend',
      endpointId: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
    });
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });

  it('submit on the extend prompt fires shell.extendEndpoint + closes the prompt', async () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-extend', endpointId: 'ep-sched' });
    // Pick a date in the future (the modal pre-fills with the seeded
    // expiry; field-edit it so DD#7's "preserve original" path doesn't
    // apply).
    const tomorrow = new Date(NOW + 30 * DAY_MS).toISOString().slice(0, 10);
    prompts.field({ promptField: 'expires_at_date', kind: 'date', value: tomorrow });
    prompts.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).toHaveBeenCalledTimes(1);
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });

  it('cancel on the extend prompt does NOT fire shell.extendEndpoint + closes the prompt', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-extend', endpointId: 'ep-sched' });
    expect(prompts.getHtml()).toContain('Give it more time');
    prompts.click({ action: 'reception-prompt-cancel' });
    expect(fns.extendEndpoint).not.toHaveBeenCalled();
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });

  it('an open prompt + an open satellite coexist (DD#1 of prompts host)', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    // The page-host docstring DD#1 explicitly designs for this case —
    // a prompt + an authoring mount can want the same DOM column.
    page.click({ action: 'reception-new-endpoint', kind: 'intake_form' });
    page.click({ action: 'reception-rotate-token', endpointId: 'ep-sched' });
    expect(modal.getHtml()).toContain('data-kind="intake_form"');
    expect(prompts.getHtml()).toContain('Swap the secret');
    host.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Mount-launching action bridge — the modal slot, not the prompt slot
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionSettings: mount bridge', () => {
  it('a reception-new-endpoint click on the page lands the authoring mount on modalHost (not promptsHost)', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-new-endpoint', kind: 'intake_form' });
    expect(modal.getHtml()).toContain('data-kind="intake_form"');
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });

  it('a reception-launch-wizard click on the page lands the wizard mount on modalHost', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-launch-wizard' });
    expect(modal.getHtml()).toContain('Set up Reception');
    expect(prompts.getHtml()).toBe('');
    host.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Forwarded seams — every page-host seam reaches the page host
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionSettings: seam forwarding', () => {
  it('resolvePageConfig is forwarded to the page host', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const resolvePageConfig = vi.fn((): ReceptionPageConfig | null => ({
      display_overrides: {
        display_name: 'Mary',
        tagline: 'Reach me here',
        tz_label: 'America/Los_Angeles',
        preferred_contact_methods: [],
      },
      sections_enabled: {},
      linked_endpoints: {},
    }));
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      resolvePageConfig,
    });
    page.click({ action: 'reception-edit-page' });
    expect(resolvePageConfig).toHaveBeenCalledTimes(1);
    expect(modal.getHtml()).toContain('value="Mary"');
    host.dispose();
  });

  it('resolveTemplateSeed is forwarded to the page host', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const seed: IntakeFormConfig = {
      display_name: 'Foundation Inquiry',
      form_definition: {
        form_definition_id: 'fd_foundation_inquiry',
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
    const ref = INTAKE_FORM_TEMPLATE_REFS[0] as IntakeFormTemplateRef;
    const template = {
      template_ref: ref,
      version: '1.0.0',
      name: 'Foundation Inquiry',
      description: 'Collects a visitor inquiry.',
      submission_processing_rule: {
        target_kind: 'task',
        fields_to_include_in_target: ['your_name'],
        fields_to_attach_as_metadata: [],
      },
      form_definition: {
        fields: [{ name: 'your_name', type: 'text', label: 'Your name', required: true }],
      },
      required_visitor_fields: { email: 'required' },
      anti_spam_defaults: {
        honeypot_fields: [],
        rate_limit_per_ip: 5,
        require_proof_of_work: false,
        require_captcha: false,
      },
    } as unknown as IntakeFormTemplate;
    const resolveTemplateSeed = vi.fn(
      (r: string): IntakeFormConfig | null => (r === ref ? seed : null),
    );
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      getTemplates: () => [template],
      resolveTemplateSeed,
    });
    // R19 Slice 2 deleted the `reception-use-template` page action; the
    // live path is the templates-browser pick (open the gallery → use a
    // card → the seed resolves + the intake_form authoring form opens).
    page.click({ action: 'reception-open-templates' });
    modal.click({ action: 'reception-template-use', templateRef: ref });
    expect(resolveTemplateSeed).toHaveBeenCalledWith(ref);
    expect(modal.getHtml()).toContain('value="Foundation Inquiry"');
    host.dispose();
  });

  it('getTemplates is forwarded to the page host (the open-templates gallery renders the cards)', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const ref = INTAKE_FORM_TEMPLATE_REFS[0] as IntakeFormTemplateRef;
    const template = {
      template_ref: ref,
      version: '1.0.0',
      name: 'Client inquiry',
      description: 'Collects a visitor inquiry.',
      submission_processing_rule: {
        target_kind: 'task',
        fields_to_include_in_target: ['your_name'],
        fields_to_attach_as_metadata: [],
      },
      form_definition: {
        fields: [
          { name: 'your_name', type: 'text', label: 'Your name', required: true },
        ],
      },
      required_visitor_fields: { email: 'required' },
      anti_spam_defaults: {
        honeypot_fields: [],
        rate_limit_per_ip: 5,
        require_proof_of_work: false,
        require_captcha: false,
      },
      suggested_standing_instruction: {
        scope: { kind: 'global' },
        action: { kind: 'notify_user' },
        rationale: 'Surfaces each submission to you.',
      },
    } as unknown as IntakeFormTemplate;
    const getTemplates = vi.fn(() => [template]);
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      getTemplates,
    });
    page.click({ action: 'reception-open-templates' });
    expect(getTemplates).toHaveBeenCalled();
    // The gallery's intake section heading is "Let people send you answers" (the
    // assertion had drifted to a stale "Intake form templates" string).
    expect(modal.getHtml()).toContain('Intake forms');
    expect(modal.getHtml()).toContain('Client inquiry');
    host.dispose();
  });

  it('buildPacketDeclaration is forwarded to the page host (called lazily at preview time)', async () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const buildPacketDeclaration = vi.fn(
      (kind: string, _config: object): PacketDeclaration | null =>
        kind === 'approval_link'
          ? {
              packet_kind: 'approval_link_packet',
              source_query_ref: {
                kind: 'reception_approval_intent',
                intent_id: 'shell-override',
              },
            }
          : null,
    );
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      buildPacketDeclaration,
    });
    page.click({ action: 'reception-new-endpoint', kind: 'approval_link' });
    expect(buildPacketDeclaration).not.toHaveBeenCalled();
    modal.click({ action: 'reception-form-preview' });
    await flush();
    expect(buildPacketDeclaration).toHaveBeenCalledWith('approval_link', expect.any(Object));
    host.dispose();
  });

  it('renderWizardStepContent is forwarded to the page host', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const renderWizardStepContent = vi.fn((stepId: string) =>
      stepId === 'profile_check' ? '<p data-test="wired">posture</p>' : null,
    );
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      renderWizardStepContent,
    });
    page.click({ action: 'reception-launch-wizard' });
    expect(renderWizardStepContent).toHaveBeenCalledWith('profile_check');
    expect(modal.getHtml()).toContain('data-test="wired"');
    host.dispose();
  });

  it('onSwitchProfile is forwarded to the page host', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const onSwitchProfile = vi.fn();
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      exposureProfile: 'paranoid',
      onSwitchProfile,
    });
    page.click({ action: 'reception-launch-wizard' });
    modal.click({ action: 'reception-wizard-switch-profile' });
    expect(onSwitchProfile).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('onPromptClose is forwarded to the prompts host', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const onPromptClose = vi.fn();
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      onPromptClose,
    });
    page.click({ action: 'reception-extend', endpointId: 'ep-sched' });
    prompts.click({ action: 'reception-prompt-cancel' });
    expect(onPromptClose).toHaveBeenCalledTimes(1);
    expect(onPromptClose).toHaveBeenCalledWith('extend');
    host.dispose();
  });

  it('gateEditPage is forwarded to the page host', () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const gateEditPage = vi.fn(() => true);
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      gateEditPage,
    });
    // The page mount reads the gate on render — the gate function fired.
    expect(gateEditPage).toHaveBeenCalled();
    // A click on the gated Edit-page action must NOT mount the authoring form.
    page.click({ action: 'reception-edit-page' });
    expect(modal.getHtml()).toBe('');
    host.dispose();
  });

  it('the now seam is threaded into both hosts (rotate share-card uses it for expiry-note)', async () => {
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const customNow = vi.fn(() => NOW);
    const host = mountReceptionSettings({
      ...baseOpts(page.host, modal.host, prompts.host, shell),
      now: customNow,
    });
    page.click({ action: 'reception-rotate-token', endpointId: 'ep-drop' });
    prompts.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.rotateToken).toHaveBeenCalledTimes(1);
    expect(fns.setEndpointShare).toHaveBeenCalledTimes(1);
    // The expiry-note copy is composed via `computeExpiryLabel(row.expires_at, now)`,
    // so customNow must have been called at least once.
    expect(customNow).toHaveBeenCalled();
    host.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Mount order — DD#2 (prompts first so the page host's onPromptAction
// binds to a live handle synchronously)
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionSettings: mount order', () => {
  it('prompts host is live by the time the page mount fires its first prompt-driven action', () => {
    // The acceptance: a click on a prompt-driven action that arrives in
    // the same tick as the page host's mount lands the prompt modal.
    // This proves the bridge captured `promptsHost.open` synchronously.
    const page = makeFakeHost();
    const modal = makeFakeHost();
    const prompts = makeFakeHost();
    const { shell } = makeFakeShell();
    const host = mountReceptionSettings(baseOpts(page.host, modal.host, prompts.host, shell));
    page.click({ action: 'reception-extend', endpointId: 'ep-sched' });
    expect(prompts.getHtml()).toContain('Give it more time');
    host.dispose();
  });
});
