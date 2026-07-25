/** R19 Slice 3 — Reception ▸ Endpoints ▸ routed Launch Wizard section
 *  (`reception-launch-wizard-section.ts`).
 *
 *  The full-page Launch Wizard that replaced the transparent modal (the
 *  same "can't enable" fix Slice 2 applied to the per-kind authoring
 *  forms). Driven through the same DOM-free fake pattern the rest of the
 *  reception mounts use, plus a fake `document` (the section builds its
 *  chrome with `createElement`, like the bootstrap + authoring section).
 *
 *  The wizard body itself is the unchanged `mountLaunchWizard` — its
 *  step-cursor, validation, finish dispatch, and the four-config validity
 *  rules are covered by `d-149-settings-launch-wizard-mount.test.ts`, and
 *  the share-registration LOOP the section reuses is the same one
 *  `openLaunchWizard` runs in `d-149-settings-reception-page-host.test.ts`.
 *  So these assertions focus on what THIS module adds: the back-link
 *  chrome, the per-step-content forwarding, and the close handler —
 *  share capture on finish, back-nav on close, and the disposed-guard on
 *  a late finish. The close-handler tests use the injectable `mountWizard`
 *  seam to drive `onClose` directly (a fresh routed wizard is invalid by
 *  design — it carries no seed — so its real finish never fires; that is
 *  the wizard mount's tested contract, not this section's). */

import { describe, expect, it, vi } from 'vitest';
import type { ReceptionEndpointCreateResult } from '@recued/contracts';

import { mountReceptionWizardSection } from '../settings/reception-launch-wizard-section.js';
import type {
  LaunchWizardMount,
  LaunchWizardMountOptions,
} from '../settings/reception-launch-wizard-mount.js';
import { mountLaunchWizard } from '../settings/reception-launch-wizard-mount.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../settings/reception-page-shell.js';

const NOW = 1_700_000_000_000;

// ── Fake DOM element — innerHTML + childList + className + listeners
//    (the same shape the authoring-section test uses). ──
interface FakeEl {
  tagName: string;
  className: string;
  childList: FakeEl[];
  parentRef: FakeEl | null;
  innerHTML: string;
  textContent: string;
  attrs: Map<string, string>;
  addEventListener: (evt: string, fn: (e: Event) => void) => void;
  removeEventListener: (evt: string, fn: (e: Event) => void) => void;
  setAttribute: (n: string, v: string) => void;
  getAttribute: (n: string) => string | null;
  appendChild: (c: FakeEl) => FakeEl;
  removeChild: (c: FakeEl) => FakeEl;
  remove: () => void;
  contains: () => boolean;
  fire: (evt: string, target: unknown) => void;
}

const makeEl = (tag: string): HTMLElement & FakeEl => {
  let html = '';
  let text = '';
  const listeners: Record<string, Set<(e: Event) => void>> = {};
  const childList: FakeEl[] = [];
  const attrs = new Map<string, string>();
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    childList,
    parentRef: null,
    attrs,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = v;
    },
    addEventListener: (evt, fn) => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt, fn) => {
      listeners[evt]?.delete(fn);
    },
    setAttribute: (n, v) => {
      attrs.set(n, v);
    },
    getAttribute: (n) => attrs.get(n) ?? null,
    appendChild: (c) => {
      childList.push(c);
      c.parentRef = el;
      return c;
    },
    removeChild: (c) => {
      const i = childList.indexOf(c);
      if (i >= 0) childList.splice(i, 1);
      return c;
    },
    remove: () => {
      if (el.parentRef !== null) {
        const i = el.parentRef.childList.indexOf(el);
        if (i >= 0) el.parentRef.childList.splice(i, 1);
      }
    },
    contains: () => true,
    fire: (evt, target) => {
      for (const fn of [...(listeners[evt] ?? [])]) {
        fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
      }
    },
  };
  return el as unknown as HTMLElement & FakeEl;
};

const makeDoc = (): Document =>
  ({ createElement: (tag: string) => makeEl(tag) }) as unknown as Document;

const collectHtml = (el: FakeEl): string => {
  let out = (el.innerHTML ?? '') + (el.textContent ?? '');
  for (const c of el.childList) out += collectHtml(c);
  return out;
};

const findByClass = (el: FakeEl, cls: string): FakeEl | null => {
  if (el.className.includes(cls)) return el;
  for (const c of el.childList) {
    const found = findByClass(c, cls);
    if (found !== null) return found;
  }
  return null;
};

/** Synthesize a `data-action` click on a wizard element (the dispatcher
 *  reads `target.closest('[data-action]').dataset.action`). */
const clickAction = (el: FakeEl, dataset: Record<string, string>): void => {
  const node = { dataset, closest: () => node } as unknown;
  el.fire('click', node);
};

// ── Fake shell — only the slice the wizard + section touch. ──
const baseState = (): ReceptionPageShellState => ({
  page: null,
  detail: null,
  abuse_inbox: null,
  view_as_visitor: null,
  status: { reception_public: true, emergency_disabled: false, base_url: null },
  last_error: null,
  loading: false,
});

const makeFakeShell = () => {
  const state = baseState();
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const fns = {
    runLaunchWizard: vi.fn(() =>
      Promise.resolve({ page_upserted: true, created: [] } as LaunchWizardRunResult),
    ),
    setEndpointShare: vi.fn((_id: string, _share: unknown) => undefined),
  };
  const shell = {
    getState: () => state,
    subscribe: (l: (s: ReceptionPageShellState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...fns,
  } as unknown as ReceptionPageShell;
  return { shell, fns };
};

/** A captured-onClose fake wizard mount — lets the section's close handler
 *  be driven directly (a real fresh wizard never reaches finish). */
const makeFakeWizard = () => {
  let captured: LaunchWizardMountOptions['onClose'];
  const update = vi.fn();
  const dispose = vi.fn();
  const mountWizard = ((opts: LaunchWizardMountOptions): LaunchWizardMount => {
    captured = opts.onClose;
    return { update, dispose };
  }) as typeof mountLaunchWizard;
  return {
    mountWizard,
    update,
    dispose,
    fireClose: (result?: LaunchWizardRunResult): void => captured?.(result),
  };
};

const createResult = (
  over: Partial<ReceptionEndpointCreateResult> & { endpoint_id: string },
): ReceptionEndpointCreateResult => ({
  endpoint_id: over.endpoint_id,
  public_locator: over.public_locator ?? `pl-${over.endpoint_id}`,
  bearer_secret_once: over.bearer_secret_once ?? `bs-${over.endpoint_id}`,
  share_url_once: over.share_url_once ?? `https://reception.example/${over.endpoint_id}?t=once`,
  enabled: over.enabled ?? false,
});

const EXPO = 'self_hosted_open';

describe('R19 Slice 3 — mountReceptionWizardSection', () => {
  it('renders the wizard full-page with a back-link to the endpoints list', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    const html = collectHtml(host);
    // The wizard chrome rendered (its title) + the section back-link.
    expect(html).toContain('Set up Reception');
    expect(html).toContain('← Endpoints');
    // The mount marker is present (bootstrap routing asserts on this).
    const root = findByClass(host, 'reception-wizard-section');
    expect(root?.getAttribute('data-reception-wizard-section')).toBe('');
    // The back-link points at the endpoints list.
    const back = findByClass(host, 'reception-wizard-section-back');
    expect(back?.getAttribute('href')).toBe('#reception/endpoints');
    mount.dispose();
  });

  it('forwards renderStepContent to the wizard for the non-config steps', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const renderStepContent = vi.fn((stepId: string): string | null =>
      stepId === 'profile_check' ? '<div class="probe-step">PROBE-CONTENT</div>' : null,
    );
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack: vi.fn(),
      renderStepContent,
      document: makeDoc(),
      now: () => NOW,
    });
    // The fresh wizard starts on `profile_check` (a non-config step), so the
    // section's forwarded seam fills its content slot.
    expect(renderStepContent).toHaveBeenCalledWith('profile_check');
    expect(collectHtml(host)).toContain('PROBE-CONTENT');
    mount.dispose();
  });

  it('cancel navigates back without registering a share', () => {
    const host = makeEl('div');
    const { shell, fns } = makeFakeShell();
    const onBack = vi.fn();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack,
      document: makeDoc(),
      now: () => NOW,
    });
    // The wizard's dispatcher lives on the section's wizard host.
    const wizardHost = findByClass(host, 'reception-wizard-section-body');
    expect(wizardHost).not.toBeNull();
    clickAction(wizardHost!, { action: 'reception-wizard-cancel' });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fns.setEndpointShare).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('a successful finish registers every created share URL then navigates back', () => {
    const host = makeEl('div');
    const { shell, fns } = makeFakeShell();
    const onBack = vi.fn();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack,
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    // The wizard hands back one created entry per provisioned link kind.
    fakeWizard.fireClose({
      page_upserted: true,
      created: [
        { kind: 'scheduling_link', result: createResult({ endpoint_id: 'ep-sched' }) },
        { kind: 'intake_form', result: createResult({ endpoint_id: 'ep-intake' }) },
      ],
    });
    // Every created endpoint's one-shot share URL is registered before nav.
    expect(fns.setEndpointShare).toHaveBeenCalledTimes(2);
    expect(fns.setEndpointShare).toHaveBeenCalledWith(
      'ep-sched',
      expect.objectContaining({
        share_url: 'https://reception.example/ep-sched?t=once',
      }),
    );
    expect(fns.setEndpointShare).toHaveBeenCalledWith(
      'ep-intake',
      expect.objectContaining({
        share_url: 'https://reception.example/ep-intake?t=once',
      }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('a finish that created exactly one shareable endpoint lands on its detail', () => {
    const host = makeEl('div');
    const { shell, fns } = makeFakeShell();
    const onBack = vi.fn();
    const onNavigateToDetail = vi.fn();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack,
      onNavigateToDetail,
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    fakeWizard.fireClose({
      page_upserted: true,
      created: [{ kind: 'intake_form', result: createResult({ endpoint_id: 'ep-only' }) }],
    });
    expect(fns.setEndpointShare).toHaveBeenCalledWith('ep-only', expect.anything());
    // One shareable endpoint → land on its detail so its Share Cards surface.
    expect(onNavigateToDetail).toHaveBeenCalledWith('ep-only');
    expect(onBack).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('a finish that created MULTIPLE shareable endpoints stays on the endpoints list', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const onBack = vi.fn();
    const onNavigateToDetail = vi.fn();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack,
      onNavigateToDetail,
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    fakeWizard.fireClose({
      page_upserted: true,
      created: [
        { kind: 'scheduling_link', result: createResult({ endpoint_id: 'ep-a' }) },
        { kind: 'intake_form', result: createResult({ endpoint_id: 'ep-b' }) },
      ],
    });
    // Two shareable endpoints → the list shows them all; no single detail.
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onNavigateToDetail).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('counts only shareable kinds — one link + a create-hidden status_link lands on the link detail', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const onBack = vi.fn();
    const onNavigateToDetail = vi.fn();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack,
      onNavigateToDetail,
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    fakeWizard.fireClose({
      page_upserted: true,
      created: [
        { kind: 'status_link', result: createResult({ endpoint_id: 'ep-status' }) },
        { kind: 'drop_link', result: createResult({ endpoint_id: 'ep-drop' }) },
      ],
    });
    // status_link is create-hidden (not shareable) → only ep-drop counts → its
    // detail, NOT the list.
    expect(onNavigateToDetail).toHaveBeenCalledWith('ep-drop');
    expect(onBack).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('skips a created entry whose kind is create-hidden (status_link)', () => {
    const host = makeEl('div');
    const { shell, fns } = makeFakeShell();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    fakeWizard.fireClose({
      page_upserted: true,
      created: [
        { kind: 'status_link', result: createResult({ endpoint_id: 'ep-status' }) },
        { kind: 'drop_link', result: createResult({ endpoint_id: 'ep-drop' }) },
      ],
    });
    // status_link is create-hidden → skipped; only the drop link registers.
    expect(fns.setEndpointShare).toHaveBeenCalledTimes(1);
    expect(fns.setEndpointShare).toHaveBeenCalledWith('ep-drop', expect.anything());
    mount.dispose();
  });

  it('a finish that resolves AFTER dispose registers shares but does NOT navigate', () => {
    const host = makeEl('div');
    const { shell, fns } = makeFakeShell();
    const onBack = vi.fn();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack,
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    // The user navigated away (disposed) while runLaunchWizard was in flight.
    mount.dispose();
    fakeWizard.fireClose({
      page_upserted: true,
      created: [{ kind: 'intake_form', result: createResult({ endpoint_id: 'ep-late' }) }],
    });
    // Shares still register (the shell outlives the section + the URL is
    // one-shot), but nav is guarded — the user must not be yanked back.
    expect(fns.setEndpointShare).toHaveBeenCalledWith('ep-late', expect.anything());
    expect(onBack).not.toHaveBeenCalled();
  });

  it('dispose tears the wizard down + removes the chrome, idempotently', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const fakeWizard = makeFakeWizard();
    const mount = mountReceptionWizardSection({
      host,
      shell,
      exposureProfile: EXPO,
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
      mountWizard: fakeWizard.mountWizard,
    });
    expect(host.childList.length).toBe(1);
    mount.dispose();
    expect(fakeWizard.dispose).toHaveBeenCalledTimes(1);
    expect(host.childList.length).toBe(0);
    expect(() => {
      mount.dispose();
      mount.dispose();
    }).not.toThrow();
  });
});
