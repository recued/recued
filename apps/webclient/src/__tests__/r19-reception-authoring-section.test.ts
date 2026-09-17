/** R19 Slice 2 — Reception ▸ Endpoints ▸ routed authoring section
 *  (`authoring-section.ts`).
 *
 *  The full-page authoring form that replaced the transparent modal (the
 *  "can't enable" fix). Driven through the same DOM-free fake pattern the
 *  rest of the reception mounts use, plus a fake `document` (the section
 *  builds its chrome with `createElement`, like the bootstrap + inbox
 *  panel). The form body is the unchanged `mountAuthoringForm`, so the
 *  assertions focus on what THIS module adds: the back-link, the seed
 *  precedence (transient seed → edit-fetch → blank), the create-close
 *  share capture, and the back navigation. */

import { describe, expect, it, vi } from 'vitest';
import type {
  IntakeFormConfig,
  ReceptionEndpointCreateResult,
  ReceptionPageConfig,
} from '@recued/contracts';

import {
  mountReceptionAuthoringSection,
  stashReceptionAuthoringSeed,
} from '../reception/authoring-section.js';
import type {
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../reception/page-shell.js';

const NOW = 1_700_000_000_000;

// ── Fake DOM element — innerHTML + childList + className + listeners.
//    `makeEl` returns it intersected with HTMLElement so it satisfies the
//    mount's `host: HTMLElement` param; only the members the section
//    touches are real. ──
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

/** Recursively gather every element's innerHTML + textContent — the
 *  form body lives in a child's `innerHTML` (set by `mountAuthoringForm`),
 *  the back-link in another child's `textContent`. */
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

/** Synthesize a `data-action` click on a form element (the dispatcher
 *  reads `target.closest('[data-action]').dataset.action`). */
const clickAction = (el: FakeEl, dataset: Record<string, string>): void => {
  const node = { dataset, closest: () => node } as unknown;
  el.fire('click', node);
};

// ── Fake shell — the slice the authoring form + section touch. ──
const baseState = (): ReceptionPageShellState => ({
  page: null,
  detail: null,
  abuse_inbox: null,
  view_as_visitor: null,
  status: { reception_public: true, emergency_disabled: false, base_url: null },
  last_error: null,
  loading: false,
});

const makeFakeShell = (createResult?: ReceptionEndpointCreateResult) => {
  const state = baseState();
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const fns = {
    runPreview: vi.fn(() => Promise.resolve({ preview_hash: 'ph' } as never)),
    createEndpoint: vi.fn(() =>
      Promise.resolve(
        createResult ?? {
          endpoint_id: 'ep-new',
          public_locator: 'pl-new',
          bearer_secret_once: 'bs-new',
          share_url_once: 'https://reception.example/x?t=once',
          enabled: false,
        },
      ),
    ),
    upsertReceptionPage: vi.fn(() => Promise.resolve(undefined)),
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

const makeConn = (config: ReceptionPageConfig | null) => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const conn = ((method: string, payload?: unknown) => {
    calls.push({ method, payload });
    if (method === 'reception.page.get') {
      return Promise.resolve({ config, last_updated_at: null });
    }
    return Promise.resolve(undefined);
  }) as never;
  return { conn, calls };
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const validIntake = (): IntakeFormConfig => ({
  display_name: 'Project intake',
  form_definition: {
    form_definition_id: 'fd_intake',
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

describe('R19 Slice 2 — mountReceptionAuthoringSection', () => {
  it('new mode renders the per-kind form full-page with a back-link', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const { conn } = makeConn(null);
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn,
      mode: 'new',
      kind: 'scheduling_link',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    const html = collectHtml(host);
    // The form rendered (its kind is stamped on the body) + the back-link.
    expect(html).toContain('data-kind="scheduling_link"');
    expect(html).toContain('← Endpoints');
    // The back-link points at the endpoints list.
    const back = findByClass(host, 'reception-authoring-back');
    expect(back?.getAttribute('href')).toBe('#reception/endpoints');
    mount.dispose();
  });

  it('edit + reception_page fetches reception.page.get and seeds the form', async () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const pageConfig = {
      display_overrides: { display_name: 'Mary Lin', preferred_contact_methods: [] },
      sections_enabled: {},
      linked_endpoints: {},
    } as unknown as ReceptionPageConfig;
    const { conn, calls } = makeConn(pageConfig);
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn,
      mode: 'edit',
      kind: 'reception_page',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    // Before the fetch resolves, a loading hint shows (no form yet).
    expect(collectHtml(host)).toContain('Loading page');
    await flush();
    expect(calls.some((c) => c.method === 'reception.page.get')).toBe(true);
    const html = collectHtml(host);
    expect(html).toContain('data-kind="reception_page"');
    expect(html).toContain('Mary Lin');
    mount.dispose();
  });

  it('edit + reception_page shows an error (NOT a blank form) when the fetch fails — no overwrite path', async () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    // A REJECTED page.get must not degrade to a blank submittable form: we
    // do not know whether a singleton exists, and a blank submit would
    // overwrite it. (Distinct from a successful `{ config: null }`, which
    // IS a true fresh install + a blank "Set up page" form.)
    const conn = ((method: string) =>
      method === 'reception.page.get'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(undefined)) as never;
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn,
      mode: 'edit',
      kind: 'reception_page',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    await flush();
    const html = collectHtml(host);
    expect(html).toContain('Recued could not load the page');
    // No submittable form → no blank-overwrite path; the back-link remains.
    expect(html).not.toContain('data-action="reception-form-submit"');
    expect(html).not.toContain('data-kind="reception_page"');
    expect(html).toContain('← Endpoints');
    mount.dispose();
  });

  it('a stashed transient seed wins over the edit-fetch (templates / AI handoff)', async () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const { conn, calls } = makeConn(null);
    // Stash a seed for intake_form (as the templates browser pick would),
    // then mount NEW intake_form — the seed is consumed, no fetch.
    stashReceptionAuthoringSeed('intake_form', validIntake());
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn,
      mode: 'new',
      kind: 'intake_form',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    await flush();
    const html = collectHtml(host);
    expect(html).toContain('data-kind="intake_form"');
    expect(html).toContain('Project intake');
    // No page.get fetch — the seed short-circuited it.
    expect(calls.length).toBe(0);
    mount.dispose();
  });

  it('a stashed seed for a DIFFERENT kind is discarded (single-use)', async () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const { conn } = makeConn(null);
    // Stash for intake_form but mount a scheduling_link — the mismatched
    // seed is cleared, the form opens blank.
    stashReceptionAuthoringSeed('intake_form', validIntake());
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn,
      mode: 'new',
      kind: 'scheduling_link',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    const html = collectHtml(host);
    expect(html).toContain('data-kind="scheduling_link"');
    expect(html).not.toContain('Project intake');
    mount.dispose();
    // And the stale seed must not leak into the NEXT intake_form mount.
    const host2 = makeEl('div');
    const m2 = mountReceptionAuthoringSection({
      host: host2,
      shell,
      conn: makeConn(null).conn,
      mode: 'new',
      kind: 'intake_form',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    expect(collectHtml(host2)).not.toContain('Project intake');
    m2.dispose();
  });

  it('a successful create captures the share URL then navigates back', async () => {
    const host = makeEl('div');
    const createResult: ReceptionEndpointCreateResult = {
      endpoint_id: 'ep-intake-routed',
      public_locator: 'pl-intake-routed',
      bearer_secret_once: 'bs-intake-routed',
      share_url_once: 'https://reception.example/intake?t=once',
      enabled: false,
    };
    const { shell, fns } = makeFakeShell(createResult);
    const onBack = vi.fn();
    // Seed a valid intake form so submit drives preview → create.
    stashReceptionAuthoringSeed('intake_form', validIntake());
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn: makeConn(null).conn,
      mode: 'new',
      kind: 'intake_form',
      onBack,
      document: makeDoc(),
      now: () => NOW,
    });
    const formHost = findByClass(host, 'reception-authoring-section-form');
    expect(formHost).not.toBeNull();
    clickAction(formHost!, { action: 'reception-form-submit' });
    await flush();
    expect(fns.runPreview).toHaveBeenCalledTimes(1);
    expect(fns.createEndpoint).toHaveBeenCalledTimes(1);
    // The one-shot share URL is registered before navigating away.
    expect(fns.setEndpointShare).toHaveBeenCalledWith(
      'ep-intake-routed',
      expect.objectContaining({ share_url: 'https://reception.example/intake?t=once' }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('a successful create lands on the new endpoint detail when a detail navigator is wired', async () => {
    const host = makeEl('div');
    const createResult: ReceptionEndpointCreateResult = {
      endpoint_id: 'ep-intake-routed',
      public_locator: 'pl-intake-routed',
      bearer_secret_once: 'bs-intake-routed',
      share_url_once: 'https://reception.example/intake?t=once',
      enabled: false,
    };
    const { shell, fns } = makeFakeShell(createResult);
    const onBack = vi.fn();
    const onNavigateToDetail = vi.fn();
    stashReceptionAuthoringSeed('intake_form', validIntake());
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn: makeConn(null).conn,
      mode: 'new',
      kind: 'intake_form',
      onBack,
      onNavigateToDetail,
      document: makeDoc(),
      now: () => NOW,
    });
    const formHost = findByClass(host, 'reception-authoring-section-form');
    clickAction(formHost!, { action: 'reception-form-submit' });
    await flush();
    // The one-shot share is still registered…
    expect(fns.setEndpointShare).toHaveBeenCalledWith(
      'ep-intake-routed',
      expect.objectContaining({ share_url: 'https://reception.example/intake?t=once' }),
    );
    // …and we land on the new endpoint's DETAIL (its Share Cards surface
    // immediately) — NOT the list.
    expect(onNavigateToDetail).toHaveBeenCalledWith('ep-intake-routed');
    expect(onBack).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('cancel navigates back without registering a share', () => {
    const host = makeEl('div');
    const { shell, fns } = makeFakeShell();
    const onBack = vi.fn();
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn: makeConn(null).conn,
      mode: 'new',
      kind: 'scheduling_link',
      onBack,
      document: makeDoc(),
      now: () => NOW,
    });
    const formHost = findByClass(host, 'reception-authoring-section-form');
    clickAction(formHost!, { action: 'reception-form-cancel' });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fns.setEndpointShare).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('dispose tears the form down + removes the chrome, idempotently', () => {
    const host = makeEl('div');
    const { shell } = makeFakeShell();
    const mount = mountReceptionAuthoringSection({
      host,
      shell,
      conn: makeConn(null).conn,
      mode: 'new',
      kind: 'drop_link',
      onBack: vi.fn(),
      document: makeDoc(),
      now: () => NOW,
    });
    expect(host.childList.length).toBe(1);
    mount.dispose();
    expect(host.childList.length).toBe(0);
    expect(() => {
      mount.dispose();
      mount.dispose();
    }).not.toThrow();
  });
});
