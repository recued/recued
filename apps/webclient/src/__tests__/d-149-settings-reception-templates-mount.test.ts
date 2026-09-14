/** D-149 § A.10 follow-on — standalone templates-browser modal mount
 *  (`mountTemplatesBrowser`) acceptance.
 *
 *  The browser projection (`buildIntakeFormTemplatesBrowserModel`) is
 *  pure + tested elsewhere; this suite drives the mount through the
 *  DOM-free fake-host pattern every Reception mount test uses (the
 *  `reception-authoring-mount` / `reception-page-host` shape). The
 *  non-obvious things under test: the gallery renders a card per supplied
 *  template; a "Use template" click hands the right `template_ref` to
 *  `onUseTemplate` + closes; a partial template set surfaces the
 *  "N of M loaded" note honestly; an empty set renders the empty state. */

import { describe, expect, it, vi } from 'vitest';
import type {
  IntakeFormTemplate,
  IntakeFormTemplateRef,
} from '@recued/contracts';
import { INTAKE_FORM_TEMPLATE_REFS } from '@recued/contracts';

import { mountTemplatesBrowser } from '../settings/reception-templates-mount.js';

// ── Fixtures ──────────────────────────────────────────────────────

/** A minimally valid `IntakeFormTemplate` keyed on a real closed-list
 *  ref. One honeypot field (`website`) is excluded from the visitor
 *  counts; the suggested SI + anti-spam carry the substrate defaults. */
const makeTemplate = (
  ref: IntakeFormTemplateRef,
  name: string,
): IntakeFormTemplate =>
  ({
    template_ref: ref,
    version: '1.0.0',
    name,
    description: `${name} — collects a visitor's details.`,
    submission_processing_rule: {
      target_kind: 'task',
      fields_to_include_in_target: ['your_name'],
      fields_to_attach_as_metadata: [],
    },
    form_definition: {
      fields: [
        { name: 'your_name', type: 'text', label: 'Your name', required: true },
        { name: 'company', type: 'text', label: 'Company', required: false },
        { name: 'website', type: 'text', label: 'Website', required: false },
      ],
    },
    required_visitor_fields: { email: 'required' },
    anti_spam_defaults: {
      honeypot_fields: ['website'],
      rate_limit_per_ip: 5,
      require_proof_of_work: false,
      require_captcha: false,
    },
    suggested_standing_instruction: {
      scope: { kind: 'global' },
      action: {
        kind: 'route_to_project',
        project_name: 'Inbound',
        create_if_missing: true,
      },
      rationale: 'Keeps every inbound submission in one project.',
    },
  }) as unknown as IntakeFormTemplate;

/** The first two closed-list refs — enough to render a multi-card
 *  gallery while leaving the rest "missing" for the partial-load note. */
const TWO_REFS = INTAKE_FORM_TEMPLATE_REFS.slice(0, 2) as ReadonlyArray<
  IntakeFormTemplateRef
>;

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
    // No `querySelector` — the mount's focus-on-open guard tolerates its
    // absence (the DOM-free host can't focus).
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
  };
};

// ══════════════════════════════════════════════════════════════════
// Render
// ══════════════════════════════════════════════════════════════════

describe('D-149 § A.10 — mountTemplatesBrowser: render', () => {
  it('renders one card per supplied template with its name + anti-spam line', () => {
    const { host, getHtml } = makeFakeHost();
    const templates = TWO_REFS.map((ref, i) => makeTemplate(ref, `Template ${i}`));
    const mount = mountTemplatesBrowser({
      host,
      templates,
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    const out = getHtml();
    // A card per template_ref.
    for (const ref of TWO_REFS) {
      expect(out).toContain(`data-template-ref="${ref}"`);
    }
    expect(out).toContain('Template 0');
    expect(out).toContain('Template 1');
    // The anti-spam one-liner from the projection (5 per IP + 1 honeypot).
    expect(out).toContain('Anti-spam:');
    // The honeypot field (`website`) is excluded from the visitor "Collects" line.
    expect(out).toContain('Collects: Your name, Company');
    expect(out).not.toContain('Website,');
    // A "Use template" button carrying the ref.
    expect(out).toContain('data-action="reception-template-use"');
    mount.dispose();
  });

  it('surfaces the partial-load note when fewer than the closed list is supplied', () => {
    const { host, getHtml } = makeFakeHost();
    const templates = TWO_REFS.map((ref, i) => makeTemplate(ref, `Template ${i}`));
    const mount = mountTemplatesBrowser({
      host,
      templates,
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    // 2 of N loaded — the honest partial-load note.
    expect(getHtml()).toContain(
      `${TWO_REFS.length} of ${INTAKE_FORM_TEMPLATE_REFS.length} Foundation-pack templates loaded.`,
    );
    mount.dispose();
  });

  it('renders the empty state when no templates are supplied', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    expect(getHtml()).toContain('Foundation pack may not be installed');
    expect(getHtml()).not.toContain('data-action="reception-template-use"');
    mount.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// D-151 P2 — intent-first "Describe it with AI"
// ══════════════════════════════════════════════════════════════════

/** A fake host that DOES support `querySelector` (the intent handler
 *  reads the input value + writes the status line off the host). Returns
 *  stub elements keyed on the selector substring; the intent input's value
 *  is seeded via `setIntent`. */
const makeIntentHost = (intentValue: string) => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const input = { value: intentValue } as { value: string };
  const status = { textContent: '' } as { textContent: string | null };
  const submit = { disabled: false } as { disabled: boolean };
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
    querySelector: (selector: string) => {
      if (selector.includes('intent-input')) return input;
      if (selector.includes('intent-status')) return status;
      if (selector.includes('intent-submit')) return submit;
      return null;
    },
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    status,
    submit,
    setIntent: (v: string) => {
      input.value = v;
    },
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
  };
};

describe('D-151 P2 — mountTemplatesBrowser: intent-first', () => {
  it('hides the Describe-it section when onProposeIntent is absent', () => {
    const { host, getHtml } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    expect(getHtml()).not.toContain('data-recued-intent-input');
    expect(getHtml()).not.toContain('reception-template-propose');
    mount.dispose();
  });

  it('renders the Describe-it section when onProposeIntent is wired', () => {
    const { host, getHtml } = makeIntentHost('');
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate: vi.fn(),
      onProposeIntent: vi.fn(),
      onUseProposed: vi.fn(),
      onClose: vi.fn(),
    });
    expect(getHtml()).toContain('data-recued-intent-input');
    expect(getHtml()).toContain('Let AI write it');
    mount.dispose();
  });

  it('submit calls onProposeIntent; ok → onUseProposed(kind, config) + close', async () => {
    const { host, click, status } = makeIntentHost('a form for speaker bios');
    const config = { display_name: 'Bios' };
    const onProposeIntent = vi
      .fn()
      .mockResolvedValue({ ok: true, kind: 'intake_form', config, reason: 'detected a form' });
    const onUseProposed = vi.fn();
    const onClose = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate: vi.fn(),
      onProposeIntent,
      onUseProposed,
      onClose,
    });
    click({ action: 'reception-template-propose' });
    expect(onProposeIntent).toHaveBeenCalledWith('a form for speaker bios');
    await Promise.resolve();
    await Promise.resolve();
    expect(onUseProposed).toHaveBeenCalledTimes(1);
    expect(onUseProposed).toHaveBeenCalledWith('intake_form', config);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(status.textContent).toContain('AI thinks you want a intake_form');
    expect(status.textContent).toContain('detected a form');
    mount.dispose();
  });

  it('!ok → shows the friendly message inline, gallery stays (no close)', async () => {
    const { host, click, status, getHtml } = makeIntentHost('something');
    const onProposeIntent = vi
      .fn()
      .mockResolvedValue({ ok: false, message: 'AI not configured — pick a template.' });
    const onUseProposed = vi.fn();
    const onClose = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'Still here')],
      onUseTemplate: vi.fn(),
      onProposeIntent,
      onUseProposed,
      onClose,
    });
    click({ action: 'reception-template-propose' });
    await Promise.resolve();
    await Promise.resolve();
    expect(onUseProposed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(status.textContent).toBe('AI not configured — pick a template.');
    // The gallery is still rendered + usable.
    expect(getHtml()).toContain('Still here');
    mount.dispose();
  });

  it('empty intent → no rpc, prompts the user to describe first', () => {
    const { host, click, status } = makeIntentHost('   ');
    const onProposeIntent = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate: vi.fn(),
      onProposeIntent,
      onUseProposed: vi.fn(),
      onClose: vi.fn(),
    });
    click({ action: 'reception-template-propose' });
    expect(onProposeIntent).not.toHaveBeenCalled();
    expect(status.textContent).toContain('Say what you need first');
    mount.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Interaction
// ══════════════════════════════════════════════════════════════════

describe('D-149 § A.10 — mountTemplatesBrowser: interaction', () => {
  it('a "Use template" click fires onUseTemplate with the ref then closes', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const onClose = vi.fn();
    const ref = TWO_REFS[0]!;
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(ref, 'Pick me')],
      onUseTemplate,
      onClose,
    });
    click({ action: 'reception-template-use', templateRef: ref });
    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    // D-151 — the intake card stamps `kind: 'intake_form'` on its button;
    // a click without an explicit kind also falls back to intake_form.
    expect(onUseTemplate).toHaveBeenCalledWith(ref, 'intake_form');
    // "then close" — onClose fires after the pick.
    expect(onClose).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('a "Use template" click missing a templateRef is a no-op', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const onClose = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate,
      onClose,
    });
    click({ action: 'reception-template-use' });
    expect(onUseTemplate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('the close control fires onClose without onUseTemplate', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const onClose = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate,
      onClose,
    });
    click({ action: 'reception-template-close' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUseTemplate).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('dispose() detaches the listener + clears the host, idempotently', () => {
    const { host, getHtml, listenerCount } = makeFakeHost();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate: vi.fn(),
      onClose: vi.fn(),
    });
    expect(listenerCount()).toBeGreaterThan(0);
    mount.dispose();
    expect(listenerCount()).toBe(0);
    expect(getHtml()).toBe('');
    expect(() => mount.dispose()).not.toThrow();
  });

  it('clicks after dispose() are inert', () => {
    const { host, click } = makeFakeHost();
    const onUseTemplate = vi.fn();
    const mount = mountTemplatesBrowser({
      host,
      templates: [makeTemplate(TWO_REFS[0]!, 'X')],
      onUseTemplate,
      onClose: vi.fn(),
    });
    mount.dispose();
    click({ action: 'reception-template-use', templateRef: TWO_REFS[0]! });
    expect(onUseTemplate).not.toHaveBeenCalled();
  });
});
