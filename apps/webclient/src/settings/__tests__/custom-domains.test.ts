/** D-235 P5 — the Domains section under Settings → Server → Hostnames.
 *
 *  ⚠ Drives a HAND-ROLLED fake document, which is the repo convention (no DOM
 *  library is installed) and which cannot see layout, CSS, or a real click
 *  path. The browser check that can lives in the `apps/webclient:verify` skill;
 *  this file is the fast regression net, not the proof it renders.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  evaluateCustomDomainPreflight,
  evaluateCustomDomainIssuanceEligibility,
} from '@recued/contracts';
import type {
  CustomDomainDnsObservation,
  CustomDomainPreflightResult,
} from '@recued/contracts';
import {
  mountCustomDomainsPanel,
  CUSTOM_DOMAINS_INPUT_ATTR,
  CUSTOM_DOMAINS_CHECK_BTN_ATTR,
  CUSTOM_DOMAINS_ADD_BTN_ATTR,
  CUSTOM_DOMAINS_RECORD_ATTR,
  CUSTOM_DOMAINS_CHECK_ROW_ATTR,
  CUSTOM_DOMAINS_APEX_ATTR,
  CUSTOM_DOMAINS_BLOCKER_ATTR,
  CUSTOM_DOMAINS_ERROR_ATTR,
  CUSTOM_DOMAINS_RELATIVE_ATTR,
  CUSTOM_DOMAINS_RECORD_NOTE_ATTR,
  CUSTOM_DOMAINS_DELEGATION_ATTR,
  CUSTOM_DOMAINS_COPY_BTN_ATTR,
  type CustomDomainReadinessCaller,
  type CustomDomainPreflightCaller,
  type CustomDomainEnrolCaller,
} from '../custom-domains.js';

// ── the fake document ───────────────────────────────────────────────────

interface FakeEvent {
  key?: string; keyCode?: number; isComposing?: boolean; repeat?: boolean;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault(): void;
}

interface FakeEl {
  tag: string;
  className: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(event: FakeEvent) => void>>;
  _text: string;
  textContent: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeEl): FakeEl;
  addEventListener(kind: string, fn: (event: FakeEvent) => void): void;
  dispatch(kind: string, init?: Partial<FakeEvent>): FakeEvent;
  remove(): void;
  focus(): void;
  contains(node: FakeEl | null): boolean;
  parent?: FakeEl;
  readonly childNodes: FakeEl[];
}

interface FakeRange { node: FakeEl | null; selectNodeContents(node: FakeEl): void }
interface FakeSelection {
  anchorNode: FakeEl | null; focusNode: FakeEl | null; anchorOffset: number; focusOffset: number;
  removeAllRanges(): void; addRange(range: FakeRange): void; toString(): string;
}
interface FakeDoc {
  activeElement: FakeEl | null;
  hidden?: boolean;
  defaultView?: { navigator: { clipboard?: { writeText(text: string): Promise<void> } } };
  createElement(tag: string): FakeEl;
  createRange(): FakeRange;
  getSelection(): FakeSelection;
}

const makeEl = (tag: string, doc?: FakeDoc): FakeEl => {
  const el = {
    tag,
    className: '',
    attrs: new Map<string, string>(),
    children: [] as FakeEl[],
    listeners: new Map<string, Array<(event: FakeEvent) => void>>(),
    _text: '',
    setAttribute(name: string, value: string) { el.attrs.set(name, value); },
    removeAttribute(name: string) { el.attrs.delete(name); },
    getAttribute(name: string) { return el.attrs.get(name) ?? null; },
    appendChild(child: FakeEl) { child.parent = el; el.children.push(child); return child; },
    addEventListener(kind: string, fn: (event: FakeEvent) => void) {
      const list = el.listeners.get(kind) ?? [];
      list.push(fn);
      el.listeners.set(kind, list);
    },
    dispatch(kind: string, init: Partial<FakeEvent> = {}): FakeEvent {
      const event: FakeEvent = { ...init, preventDefault() { event.defaultPrevented = true; } };
      for (const fn of el.listeners.get(kind) ?? []) fn(event);
      return event;
    },
    remove() {
      if (doc && el.contains(doc.activeElement)) doc.activeElement = null;
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      delete el.parent;
    },
    focus() { if (doc && !el.disabled) doc.activeElement = el; },
    contains(node: FakeEl | null): boolean { return node === el || el.children.some(child => child.contains(node)); },
    get childNodes() { return el.children; },
  } as unknown as FakeEl;
  Object.defineProperty(el, 'textContent', {
    get() {
      // Mirrors the DOM: an element's textContent is its own text plus every
      // descendant's, which is what the assertions below read.
      return el._text + el.children.map((c) => c.textContent).join('');
    },
    set(v: string) {
      if (doc?.activeElement && el.children.some(child => child.contains(doc.activeElement))) doc.activeElement = null;
      el._text = v;
      for (const child of el.children) delete child.parent;
      el.children = [];
    },
  });
  return el;
};

const makeDoc = (): FakeDoc => {
  const selection: FakeSelection = {
    anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0,
    removeAllRanges() { selection.anchorNode = null; selection.focusNode = null; },
    addRange(range) { selection.anchorNode = range.node; selection.focusNode = range.node; selection.anchorOffset = 0; selection.focusOffset = range.node?.textContent.length ?? 0; },
    toString() { return selection.anchorNode?.textContent ?? ''; },
  };
  const doc: FakeDoc = {
    activeElement: null, createElement: (tag) => makeEl(tag, doc), getSelection: () => selection,
    createRange() { const range: FakeRange = { node: null, selectNodeContents(node) { range.node = node; } }; return range; },
  };
  return doc;
};

/** Depth-first walk — replaces `querySelector`, which the fake does not have. */
const walk = (root: FakeEl): FakeEl[] => [root, ...root.children.flatMap(walk)];
const findByAttr = (root: FakeEl, attr: string): FakeEl[] =>
  walk(root).filter((e) => e.attrs.has(attr));
const firstByAttr = (root: FakeEl, attr: string): FakeEl | undefined =>
  findByAttr(root, attr)[0];
const textOf = (root: FakeEl): string => root.textContent;

// ── fixtures ────────────────────────────────────────────────────────────

const DDNS = 'alice.recued.net';
const DELEGATION_TARGET = '_acme-challenge.alice.recued.net';

const preflightFor = (
  hostname: string,
  over: Partial<CustomDomainDnsObservation> = {},
): CustomDomainPreflightResult =>
  evaluateCustomDomainPreflight({
    hostname,
    handle: 'alice',
    observation: {
      host_cnames: [DDNS],
      host_addresses: [],
      ddns_addresses: [],
      delegation_cnames: [DELEGATION_TARGET],
      caa_records: [],
      ...over,
    },
  });

const decisionFor = (preflight: CustomDomainPreflightResult, enrolled: boolean) =>
  evaluateCustomDomainIssuanceEligibility({
    row: enrolled
      ? {
          cert_source: 'recued_acme_custom',
          ownership_status: 'verified',
          verification_method: 'dns_txt',
          enabled: true,
        }
      : { cert_source: 'unregistered', ownership_status: 'pending', enabled: false },
    preflight,
    subscription_active: true,
    enrolled_custom_count: 1,
  });

const setup = (opts: {
  document?: FakeDoc;
  hostname?: string;
  observation?: Partial<CustomDomainDnsObservation>;
  enrolled?: boolean;
  withEnrol?: boolean;
  preflightThrows?: Error;
  runReadiness?: CustomDomainReadinessCaller | null;
  runPreflight?: CustomDomainPreflightCaller;
  runEnrol?: CustomDomainEnrolCaller;
  onEnrolled?: (hostname: string) => void;
  writeClipboard?: ((value: string) => Promise<void>) | null;
  nativeWriteClipboard?: (value: string) => Promise<void>;
} = {}) => {
  const doc = opts.document ?? makeDoc();
  if (opts.nativeWriteClipboard) doc.defaultView = { navigator: { clipboard: { writeText: opts.nativeWriteClipboard } } };
  const host = makeEl('div');
  const enrolCalls: unknown[] = [];
  const copied: string[] = [];
  const hostname = opts.hostname ?? 'recued.their-domain.com';

  const mount = mountCustomDomainsPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    ...(opts.writeClipboard === null ? {} : { writeClipboard: opts.writeClipboard ?? (async (value: string) => { copied.push(value); }) }),
    runPreflight: opts.runPreflight ?? (async () => {
      if (opts.preflightThrows) throw opts.preflightThrows;
      return { preflight: preflightFor(hostname, opts.observation) };
    }),
    ...(opts.runReadiness === null ? {} : { runReadiness: opts.runReadiness ?? (async () => {
      if (opts.preflightThrows) throw opts.preflightThrows;
      const preflight = preflightFor(hostname, opts.observation);
      return { preflight, decision: decisionFor(preflight, opts.enrolled ?? false) };
    }) }),
    ...(opts.onEnrolled ? { onEnrolled: opts.onEnrolled } : {}),
    ...(opts.withEnrol === false
      ? {}
      : {
          runEnrol: opts.runEnrol ?? (async (args) => {
            enrolCalls.push(args);
            return { hostname: { hostname: args.hostname } as never };
          }),
        }),
  });

  const type = (value: string): void => {
    const input = firstByAttr(host, CUSTOM_DOMAINS_INPUT_ATTR)!;
    input.value = value;
    input.dispatch('input');
  };
  const click = (attr: string): void => { firstByAttr(host, attr)?.dispatch('click'); };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  return { doc, host, mount, enrolCalls, copied, type, click, settle };
};

const checkStatus = (host: FakeEl, check: string): string | undefined =>
  findByAttr(host, CUSTOM_DOMAINS_CHECK_ROW_ATTR)
    .map((e) => e.getAttribute(CUSTOM_DOMAINS_CHECK_ROW_ATTR)!)
    .find((v) => v.startsWith(`${check}:`))
    ?.split(':')[1];

// ── the tests ───────────────────────────────────────────────────────────

describe('D-235 P5 — the Domains panel', () => {
  it('renders only the form until a check is run', () => {
    const t = setup();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBeDefined();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_RECORD_ATTR)).toBeUndefined();
  });

  it('⛔ ONE record card, and the delegation still spelled out beside it', async () => {
    // § 2.5, the mistake that falsified the first draft of the design: the host
    // CNAME makes the domain REACH the server while issuance still fails,
    // because DNS-01 validates a DIFFERENT name in a zone Recued cannot write.
    //
    // The delegation is now a STEP rather than a second card — it carries no
    // new decision (its name and value are the first record's with
    // `_acme-challenge.` prepended), so two co-equal cards overstated it as
    // two things to work out. What § 2.5 forbids is making it look OPTIONAL,
    // and that is what the rest of this file pins: it is always rendered, it
    // keeps its own check, and it keeps the two hints a live drive earned.
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(findByAttr(t.host, CUSTOM_DOMAINS_RECORD_ATTR)).toHaveLength(1);
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_DELEGATION_ATTR)).toBeDefined();
    // Both names and both values are still on the page, exact and copyable —
    // demoting the delegation must not mean paraphrasing it away.
    const text = textOf(t.host);
    expect(text).toContain('recued.their-domain.com');
    expect(text).toContain(DDNS);
    expect(text).toContain('_acme-challenge.recued.their-domain.com');
    expect(text).toContain(DELEGATION_TARGET);
  });

  it('⛔ no copy numbers the records — there is one card, so ordinals point at nothing', async () => {
    // The panel used to render two identical cards and its copy counted them:
    // "two DNS records, and it is the second one that does the work", "add the
    // first record below", "the first record alone is not enough". With one
    // card those ordinals have no referent on screen, and "two records" sends
    // the reader hunting for a second card that is not there.
    //
    // ⚠ "a second time" IS allowed and is the step's own phrasing — it counts
    //   the ACT of adding, not a numbered record. The distinction is the point.
    const t = setup({ observation: { host_cnames: [], delegation_cnames: [] } });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const copy = textOf(t.host).toLowerCase();
    for (const ordinal of [
      'first record',
      'second record',
      'two records',
      'two dns records',
      'the second one',
    ]) {
      expect(copy, `copy must not say "${ordinal}"`).not.toContain(ordinal);
    }
    // …and the § 2.5 warning is still made, without counting.
    expect(copy).toContain('no certificate will ever work');
  });

  it('the delegation step never reads as optional or advanced', async () => {
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const step = firstByAttr(t.host, CUSTOM_DOMAINS_DELEGATION_ATTR)!;
    const copy = textOf(step).toLowerCase();
    for (const hedge of ['optional', 'advanced', 'if you want', 'you may also']) {
      expect(copy, `delegation copy must not contain "${hedge}"`).not.toContain(hedge);
    }
    // States the consequence of skipping it, in the same breath as the ask.
    expect(copy).toContain('no certificate will ever work');
  });

  it('reports each check separately, so a half-right setup reads as half-right', async () => {
    const t = setup({ observation: { delegation_cnames: [] } });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(checkStatus(t.host, 'host_route')).toBe('pass');
    expect(checkStatus(t.host, 'acme_delegation')).toBe('fail');
    expect(textOf(t.host)).toContain('not enough on its own');
  });

  it('⚠ states the apex caveat BEFORE the user goes to their DNS provider', async () => {
    // RFC 1034 forbids a CNAME at a zone apex, so an apex user who follows the
    // instructions literally produces a broken zone and blames us.
    const t = setup({ hostname: 'their-domain.com' });
    t.type('their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const apex = firstByAttr(t.host, CUSTOM_DOMAINS_APEX_ATTR);
    expect(apex).toBeDefined();
    expect(textOf(apex!)).toMatch(/ALIAS|ANAME|flattening/);
  });

  it('does not cry apex on a subdomain', async () => {
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_APEX_ATTR)).toBeUndefined();
  });

  it('echoes what it actually saw, so a typo is findable', async () => {
    const t = setup({ observation: { delegation_cnames: ['_acme-challenge.bob.recued.net'] } });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(textOf(t.host)).toContain('Found: _acme-challenge.bob.recued.net');
  });

  it("⚠ a resolver failure never accuses the user's records", async () => {
    const t = setup({ observation: { delegation_cnames: [], delegation_resolver_error: true } });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(checkStatus(t.host, 'acme_delegation')).toBe('unknown');
    expect(textOf(t.host)).toContain('says nothing about your records');
  });

  it('names the CAA records to add rather than just refusing', async () => {
    const t = setup({
      enrolled: true,
      observation: { caa_records: [{ flags: 0, tag: 'issue', value: 'letsencrypt.org' }] },
    });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const blockers = findByAttr(t.host, CUSTOM_DOMAINS_BLOCKER_ATTR)
      .map((e) => e.getAttribute(CUSTOM_DOMAINS_BLOCKER_ATTR));
    expect(blockers).toContain('caa_blocks_rotation');
    expect(textOf(t.host)).toContain('sectigo.com');
    expect(textOf(t.host)).toContain('pki.goog');
  });

  it('⚠ does NOT report "not a custom domain" before the user has added one', async () => {
    // It is the ordinary state of a domain not yet enrolled — rendering it as a
    // blocker would read as an error at the exact moment nothing is wrong.
    const t = setup({ enrolled: false });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const blockers = findByAttr(t.host, CUSTOM_DOMAINS_BLOCKER_ATTR)
      .map((e) => e.getAttribute(CUSTOM_DOMAINS_BLOCKER_ATTR));
    expect(blockers).not.toContain('not_a_custom_acme_hostname');
  });

  it('enrols with the custom cert source', async () => {
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    t.click(CUSTOM_DOMAINS_ADD_BTN_ATTR);
    await t.settle();
    expect(t.enrolCalls).toEqual([
      { hostname: 'recued.their-domain.com', cert_source: 'recued_acme_custom' },
    ]);
  });

  it('normalizes a pasted URL into a hostname', async () => {
    // Users paste `https://recued.their-domain.com/` because that is what their
    // browser gave them.
    const t = setup();
    t.type('  HTTPS://Recued.Their-Domain.com/some/path  ');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    t.click(CUSTOM_DOMAINS_ADD_BTN_ATTR);
    await t.settle();
    expect(t.enrolCalls).toEqual([
      { hostname: 'recued.their-domain.com', cert_source: 'recued_acme_custom' },
    ]);
  });

  it('refuses to check an empty hostname', async () => {
    const t = setup();
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(textOf(firstByAttr(t.host, CUSTOM_DOMAINS_ERROR_ATTR)!)).toContain('Type the name you want to use');
  });

  it('surfaces an rpc failure rather than pretending the check passed', async () => {
    const t = setup({ preflightThrows: new Error('nope') });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_ERROR_ATTR)).toBeDefined();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_RECORD_ATTR)).toBeUndefined();
  });

  it('offers no Add button when the panel has no write caller', async () => {
    const t = setup({ withEnrol: false });
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_RECORD_ATTR)).toBeDefined();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)).toBeUndefined();
  });

  it('destroy removes the panel', () => {
    const t = setup();
    t.mount.destroy();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBeUndefined();
  });
});

describe('D-235 — the record cards say what a DNS provider actually wants', () => {
  it('⛔ shows the RELATIVE name too — an FQDN in a Name field doubles the domain', async () => {
    // Cloudflare turns `_acme-challenge.example.com` pasted into its Name field
    // into `_acme-challenge.example.com.example.com`: a record that looks
    // created, resolves nowhere, and fails as "delegation missing".
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const hints = findByAttr(t.host, CUSTOM_DOMAINS_RELATIVE_ATTR)
      .map((e) => e.getAttribute(CUSTOM_DOMAINS_RELATIVE_ATTR));
    expect(hints).toEqual(['recued', '_acme-challenge.recued']);
  });

  it('uses `@` for an apex host record', async () => {
    const t = setup({ hostname: 'their-domain.com' });
    t.type('their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const hints = findByAttr(t.host, CUSTOM_DOMAINS_RELATIVE_ATTR)
      .map((e) => e.getAttribute(CUSTOM_DOMAINS_RELATIVE_ATTR));
    expect(hints).toEqual(['@', '_acme-challenge']);
  });

  it('⚠ warns about the proxy toggle BEFORE the record is created', async () => {
    // Saying it after the check fails is a diagnosis; saying it beside the
    // record they are about to create is a prevention — and Cloudflare's
    // DEFAULT for a CNAME is the setting that breaks this.
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const notes = findByAttr(t.host, CUSTOM_DOMAINS_RECORD_NOTE_ATTR).map(textOf);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('DNS only');
    expect(notes[0]).toContain('trailing dot');
  });

  it('puts that warning on the DELEGATION step, not the routing record', async () => {
    // The proxy only breaks the record the CA has to follow.
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const card = firstByAttr(t.host, CUSTOM_DOMAINS_RECORD_ATTR)!;
    const step = firstByAttr(t.host, CUSTOM_DOMAINS_DELEGATION_ATTR)!;
    expect(findByAttr(card, CUSTOM_DOMAINS_RECORD_NOTE_ATTR)).toHaveLength(0);
    expect(findByAttr(step, CUSTOM_DOMAINS_RECORD_NOTE_ATTR)).toHaveLength(1);
  });

  it('the copy button survives the demotion — that value is the longest on the page', async () => {
    const t = setup();
    t.type('recued.their-domain.com');
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const step = firstByAttr(t.host, CUSTOM_DOMAINS_DELEGATION_ATTR)!;
    const copyBtn = firstByAttr(step, CUSTOM_DOMAINS_COPY_BTN_ATTR);
    expect(copyBtn).toBeDefined();
    copyBtn!.dispatch('click');
    await t.settle();
    expect(t.copied).toEqual([DELEGATION_TARGET]);
  });
});

const pending = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const ALPHA = 'alpha.example.test';
const BETA = 'beta.example.test';
const readinessFor = (hostname: string) => {
  const preflight = preflightFor(hostname);
  return { preflight, decision: decisionFor(preflight, false) };
};
const STATUS_ATTR = 'data-recued-custom-domains-status';

describe('custom-domain checks belong to the current draft', () => {
  it('clears obsolete instructions and prevents detached Add and Copy controls from acting', async () => {
    const t = setup({ hostname: ALPHA });
    t.type(ALPHA);
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
    const add = firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)!;
    const copy = firstByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR)!;
    input.focus();
    t.type(BETA);
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input);
    expect(t.doc.activeElement).toBe(input);
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_RECORD_ATTR)).toBeUndefined();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)).toBeUndefined();
    expect(t.mount.state()).toMatchObject({ hostname: BETA, preflight: null, decision: null });
    add.dispatch('click');
    copy.dispatch('click');
    await t.settle();
    expect(t.enrolCalls).toEqual([]);
    expect(t.copied).toEqual([]);
  });

  it('retains a check through equivalent URL, case and trailing-dot edits', async () => {
    const t = setup({ hostname: ALPHA });
    t.type(ALPHA);
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const preflight = t.mount.state().preflight;
    t.type('  HTTPS://Alpha.Example.Test./some/path  ');
    expect(t.mount.state().preflight).toBe(preflight);
    t.click(CUSTOM_DOMAINS_ADD_BTN_ATTR);
    await t.settle();
    expect(t.enrolCalls).toEqual([{ hostname: ALPHA, cert_source: 'recued_acme_custom' }]);
  });

  for (const seam of ['readiness', 'preflight'] as const) {
    for (const oldOutcome of ['success', 'error'] as const) {
      for (const newOutcome of ['success', 'error'] as const) {
        it(`${seam}: ignores old ${oldOutcome} while the new draft awaits ${newOutcome}`, async () => {
          const old = pending<ReturnType<typeof readinessFor>>();
          const next = pending<ReturnType<typeof readinessFor>>();
          const caller = vi.fn(({ hostname }: { hostname: string }) => hostname === ALPHA ? old.promise : next.promise);
          const t = setup(seam === 'readiness' ? { runReadiness: caller } : { runReadiness: null, runPreflight: caller });
          const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
          t.type(ALPHA);
          t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
          input.focus();
          t.type(BETA);
          t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
          expect(caller.mock.calls.map(([args]) => args.hostname)).toEqual([ALPHA, BETA]);
          if (oldOutcome === 'success') old.resolve(readinessFor(ALPHA));
          else old.reject(new Error('obsolete alpha failure'));
          await t.settle();
          expect(t.mount.state()).toMatchObject({ hostname: BETA, checking: true, preflight: null, error: null });
          expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input);
          expect(t.doc.activeElement).toBe(input);
          if (newOutcome === 'success') next.resolve(readinessFor(BETA));
          else next.reject(new Error('current beta failure'));
          await t.settle();
          expect(t.mount.state().checking).toBe(false);
          expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input);
          expect(t.doc.activeElement).toBe(input);
          if (newOutcome === 'success') expect(t.mount.state().preflight?.hostname).toBe(BETA);
          else expect(t.mount.state()).toMatchObject({ preflight: null, error: expect.any(String) });
          expect(textOf(t.host)).not.toContain('obsolete alpha failure');
        });
      }
    }

    it(`${seam}: cannot revive an earlier request after A → B → A`, async () => {
      const old = pending<ReturnType<typeof readinessFor>>();
      const caller = vi.fn(() => old.promise);
      const t = setup(seam === 'readiness' ? { runReadiness: caller } : { runReadiness: null, runPreflight: caller });
      t.type(ALPHA);
      t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
      t.type(BETA);
      t.type(ALPHA);
      old.resolve(readinessFor(ALPHA));
      await t.settle();
      expect(t.mount.state()).toMatchObject({ checking: false, preflight: null, decision: null });
      expect(firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)).toBeUndefined();
    });

    it(`${seam}: refuses a reply for a different hostname`, async () => {
      const caller = async () => readinessFor(BETA);
      const t = setup(seam === 'readiness' ? { runReadiness: caller } : { runReadiness: null, runPreflight: caller });
      t.type(ALPHA);
      t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
      await t.settle();
      expect(t.mount.state()).toMatchObject({ checking: false, preflight: null, decision: null, error: expect.any(String) });
      expect(firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)).toBeUndefined();
    });
  }

  it('clears an error when the hostname changes', async () => {
    const t = setup({ preflightThrows: new Error('failed alpha check') });
    t.type(ALPHA);
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_ERROR_ATTR)).toBeDefined();
    t.type(BETA);
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_ERROR_ATTR)).toBeUndefined();
  });

  for (const outcome of ['success', 'error'] as const) {
    for (const owner of ['check', 'input', 'outside'] as const) {
      it(`preserves ${owner} focus through check ${outcome} and ignores repeat activation`, async () => {
        const read = pending<ReturnType<typeof readinessFor>>();
        const caller = vi.fn(() => read.promise);
        const t = setup({ runReadiness: caller });
        const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
        const check = firstByAttr(t.host, CUSTOM_DOMAINS_CHECK_BTN_ATTR)!;
        const outside = t.doc.createElement('button');
        t.type(ALPHA);
        if (owner === 'check') check.focus();
        else if (owner === 'input') input.focus();
        else outside.focus();
        check.dispatch('click');
        check.dispatch('click');
        expect(caller).toHaveBeenCalledTimes(1);
        if (owner === 'check') expect(t.doc.activeElement?.getAttribute(STATUS_ATTR)).toBe('');
        if (outcome === 'success') read.resolve(readinessFor(ALPHA));
        else read.reject(new Error('lookup unavailable'));
        await t.settle();
        expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input);
        expect(firstByAttr(t.host, CUSTOM_DOMAINS_CHECK_BTN_ATTR)).toBe(check);
        expect(t.doc.activeElement).toBe(owner === 'check' ? check : owner === 'input' ? input : outside);
      });
    }
  }

  for (const callbackThrows of [false, true]) {
    it(`retains enrollment acknowledgment through a failed refresh, callback throws: ${callbackThrows}`, async () => {
      const refresh = pending<ReturnType<typeof readinessFor>>();
      const preflight = preflightFor(ALPHA, { delegation_cnames: [] });
      const caller = vi.fn().mockResolvedValueOnce({ preflight, decision: decisionFor(preflight, false) }).mockImplementation(() => refresh.promise);
      const onEnrolled = vi.fn(() => { if (callbackThrows) throw new Error('sibling refresh failed'); });
      const t = setup({ runReadiness: caller, onEnrolled });
      t.type(ALPHA);
      t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
      await t.settle();
      expect(t.mount.state().decision?.eligible).toBe(false);
      const add = firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)!;
      add.focus();
      add.dispatch('click');
      add.dispatch('click');
      await t.settle();
      expect(t.enrolCalls).toEqual([{ hostname: ALPHA, cert_source: 'recued_acme_custom' }]);
      expect(onEnrolled).toHaveBeenCalledExactlyOnceWith(ALPHA);
      expect(t.mount.state()).toMatchObject({ enrolled: ALPHA, checking: true, error: null });
      expect(textOf(t.host)).toContain(`${ALPHA} added.`);
      expect(firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)).toBeUndefined();
      add.dispatch('click');
      refresh.reject(new Error('refresh unavailable'));
      await t.settle();
      expect(t.enrolCalls).toHaveLength(1);
      expect(t.mount.state().enrolled).toBe(ALPHA);
      expect(textOf(t.host)).toContain(`${ALPHA} added.`);
      expect(firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)).toBeUndefined();
    });
  }

  it('holds the enrollment hostname fixed until the write settles', async () => {
    const write = pending<Awaited<ReturnType<CustomDomainEnrolCaller>>>();
    const caller = vi.fn(() => write.promise);
    const t = setup({ hostname: ALPHA, runEnrol: caller });
    t.type(ALPHA);
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    await t.settle();
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
    const check = firstByAttr(t.host, CUSTOM_DOMAINS_CHECK_BTN_ATTR)!;
    const add = firstByAttr(t.host, CUSTOM_DOMAINS_ADD_BTN_ATTR)!;
    add.dispatch('click');
    expect(input.disabled).toBe(true);
    expect(check.disabled).toBe(true);
    t.type(BETA);
    check.dispatch('click');
    add.dispatch('click');
    expect(caller).toHaveBeenCalledExactlyOnceWith({ hostname: ALPHA, cert_source: 'recued_acme_custom' });
    expect(t.mount.state().hostname).toBe(ALPHA);
    write.resolve({ hostname: { hostname: ALPHA } as never });
    await t.settle();
    expect(input.disabled).toBe(false);
    expect(t.mount.state().enrolled).toBe(ALPHA);
  });

  for (const outcome of ['success', 'error'] as const) {
    it(`ignores a check ${outcome} after disposal`, async () => {
      const read = pending<ReturnType<typeof readinessFor>>();
      const t = setup({ runReadiness: () => read.promise });
      t.type(ALPHA);
      t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
      const snapshot = t.mount.state();
      t.mount.destroy();
      const outside = t.doc.createElement('button');
      outside.focus();
      if (outcome === 'success') read.resolve(readinessFor(ALPHA));
      else read.reject(new Error('late failure'));
      await t.settle();
      expect(t.mount.state()).toEqual(snapshot);
      expect(t.doc.activeElement).toBe(outside);
      expect(t.host.children).toEqual([]);
    });
  }
});


const COPY_STATUS = 'data-recued-custom-domains-copy-status';
const checkedCopyPanel = async (opts: Parameters<typeof setup>[0] = {}) => {
  const t = setup({ hostname: ALPHA, ...opts });
  t.type(ALPHA); t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR); await t.settle();
  return t;
};

describe('custom-domain clipboard ownership and recovery', () => {
  it('defaults to the document clipboard and copies the exact value for each record', async () => {
    const writer = vi.fn(async (_value: string) => {});
    const t = await checkedCopyPanel({ writeClipboard: null, nativeWriteClipboard: writer });
    const buttons = findByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR);
    for (const button of buttons) { button.focus(); button.dispatch('click'); await t.settle(); expect(t.doc.activeElement).toBe(button); }
    expect(writer.mock.calls).toEqual([[DDNS], [DELEGATION_TARGET]]);
    expect(findByAttr(t.host, COPY_STATUS).map(textOf)).toEqual(['Value copied.', 'Value copied.']);
    expect(findByAttr(t.host, COPY_STATUS).map(e => e.getAttribute('role'))).toEqual(['status', 'status']);
  });

  it('uses an injected writer without consulting the browser clipboard', async () => {
    const writer = vi.fn(async (_value: string) => {});
    const native = vi.fn(async (_value: string) => {});
    const t = await checkedCopyPanel({ writeClipboard: writer, nativeWriteClipboard: native });
    t.click(CUSTOM_DOMAINS_COPY_BTN_ATTR); await t.settle();
    expect(writer).toHaveBeenCalledExactlyOnceWith(DDNS); expect(native).not.toHaveBeenCalled();
  });

  it('keeps the active button mounted and focusable, prevents repeats, and permits a later copy', async () => {
    const write = pending<void>(); const writer = vi.fn(() => write.promise);
    const t = await checkedCopyPanel({ writeClipboard: writer });
    const button = firstByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR)!;
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
    button.focus(); button.dispatch('click'); button.dispatch('click');
    expect(writer).toHaveBeenCalledTimes(1); expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(textOf(firstByAttr(t.host, COPY_STATUS)!)).toBe('Copying value…');
    expect(t.doc.activeElement).toBe(button);
    write.resolve(); await t.settle();
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input);
    expect(firstByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR)).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('false'); expect(t.doc.activeElement).toBe(button);
    button.dispatch('click'); await t.settle(); expect(writer).toHaveBeenCalledTimes(2);
  });

  for (const failure of ['denied', 'synchronous', 'missing', 'getter'] as const) {
    it(`offers exact manual selection when clipboard access is ${failure}`, async () => {
      const writer = failure === 'denied' ? async () => { throw new Error('denied'); }
        : failure === 'synchronous' ? () => { throw new Error('synchronous failure'); } : null;
      const t = await checkedCopyPanel({ writeClipboard: writer });
      if (failure === 'getter') Object.defineProperty(t.doc, 'defaultView', { get() { throw new Error('clipboard getter denied'); } });
      const button = findByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR)[1]!;
      button.focus(); button.dispatch('click'); await t.settle();
      expect(t.doc.getSelection().toString()).toBe(DELEGATION_TARGET);
      expect(t.doc.activeElement?.textContent).toBe(DELEGATION_TARGET);
      expect(findByAttr(t.host, COPY_STATUS)[1]?.textContent).toContain('Copy it manually');
      expect(findByAttr(t.host, COPY_STATUS)[1]?.textContent).not.toContain('copied');
      expect(button.getAttribute('aria-disabled')).toBe('false');
    });
  }

  for (const owner of ['outside', 'selection', 'hidden'] as const) {
    it(`does not take ${owner} ownership after a delayed copy failure`, async () => {
      const write = pending<void>(); const t = await checkedCopyPanel({ writeClipboard: () => write.promise });
      const button = firstByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR)!;
      button.focus(); button.dispatch('click');
      const outside = t.doc.createElement('p'); outside.textContent = 'Someone else selected this';
      if (owner === 'outside') outside.focus();
      if (owner === 'selection') { const range = t.doc.createRange(); range.selectNodeContents(outside); t.doc.getSelection().addRange(range); }
      if (owner === 'hidden') t.doc.hidden = true;
      write.reject(new Error('denied')); await t.settle();
      expect(t.doc.activeElement).toBe(owner === 'outside' ? outside : button);
      expect(t.doc.getSelection().toString()).toBe(owner === 'selection' ? outside.textContent : '');
      expect(firstByAttr(t.host, COPY_STATUS)?.textContent).toContain('Copy it manually');
    });
  }

  for (const outcome of ['success', 'error'] as const) {
    for (const invalidation of ['edit', 'recheck', 'destroy'] as const) {
      it(`ignores late copy ${outcome} after ${invalidation}`, async () => {
        const write = pending<void>(); const writer = vi.fn(() => write.promise);
        const t = await checkedCopyPanel({ writeClipboard: writer });
        const button = firstByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR)!;
        const feedback = firstByAttr(t.host, COPY_STATUS)!;
        button.focus(); button.dispatch('click');
        const outside = t.doc.createElement('button'); outside.focus();
        if (invalidation === 'edit') t.type(BETA);
        else if (invalidation === 'recheck') { t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR); await t.settle(); }
        else t.mount.destroy();
        if (outcome === 'success') write.resolve(); else write.reject(new Error('obsolete denial'));
        await t.settle(); button.dispatch('click'); await t.settle();
        expect(writer).toHaveBeenCalledTimes(1); expect(feedback.textContent).toBe('Copying value…');
        expect(t.doc.activeElement).toBe(outside); expect(t.doc.getSelection().toString()).toBe('');
        expect(textOf(t.host)).not.toContain('Copy it manually'); expect(textOf(t.host)).not.toContain('Value copied.');
      });
    }
  }

  it('keeps feedback scoped to its record when the other record is copied', async () => {
    const hostWrite = pending<void>();
    const writer = vi.fn((value: string) => value === DDNS ? hostWrite.promise : Promise.resolve());
    const t = await checkedCopyPanel({ writeClipboard: writer });
    const buttons = findByAttr(t.host, CUSTOM_DOMAINS_COPY_BTN_ATTR);
    buttons[0]!.dispatch('click'); buttons[1]!.dispatch('click'); await t.settle();
    expect(findByAttr(t.host, COPY_STATUS).map(textOf)).toEqual(['Copying value…', 'Value copied.']);
    hostWrite.resolve(); await t.settle();
    expect(findByAttr(t.host, COPY_STATUS).map(textOf)).toEqual(['Value copied.', 'Value copied.']);
  });
});


describe('custom-domain Enter checks', () => {
  for (const seam of ['readiness', 'preflight'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      it(`${seam}: Enter normalizes the hostname and retains input focus through ${outcome}`, async () => {
        const read = pending<ReturnType<typeof readinessFor>>(); const caller = vi.fn(() => read.promise);
        const t = setup(seam === 'readiness' ? { runReadiness: caller } : { runReadiness: null, runPreflight: caller });
        const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
        t.type('  HTTPS://Alpha.Example.Test./some/path  '); input.focus();
        expect(input.dispatch('keydown', { key: 'Enter' }).defaultPrevented).toBe(true);
        expect(caller).toHaveBeenCalledExactlyOnceWith({ hostname: ALPHA });
        expect(t.doc.activeElement).toBe(input); expect(t.mount.state().checking).toBe(true);
        input.dispatch('keydown', { key: 'Enter' });
        expect(caller).toHaveBeenCalledTimes(1);
        if (outcome === 'success') read.resolve(readinessFor(ALPHA)); else read.reject(new Error('DNS unavailable'));
        await t.settle();
        expect(t.mount.state().checking).toBe(false); expect(t.doc.activeElement).toBe(input);
        expect(firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input);
        expect(t.enrolCalls).toEqual([]);
        input.dispatch('keydown', { key: 'Enter', repeat: true });
        expect(caller).toHaveBeenCalledTimes(1);
        input.dispatch('keydown', { key: 'Enter' }); await t.settle();
        expect(caller).toHaveBeenCalledTimes(2);
      });
    }
  }

  it('reports an empty Enter check without issuing a read or moving focus', async () => {
    const caller = vi.fn(async () => readinessFor(ALPHA)); const t = setup({ runReadiness: caller });
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!; input.focus();
    expect(input.dispatch('keydown', { key: 'Enter' }).defaultPrevented).toBe(true);
    expect(caller).not.toHaveBeenCalled(); expect(t.enrolCalls).toEqual([]);
    expect(t.mount.state().error).toContain('Type the name'); expect(t.doc.activeElement).toBe(input);
  });

  const ignored: Partial<FakeEvent>[] = [
    { key: 'Escape' }, { key: ' ' }, { key: 'Enter', altKey: true }, { key: 'Enter', ctrlKey: true },
    { key: 'Enter', metaKey: true }, { key: 'Enter', shiftKey: true },
    { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', defaultPrevented: true },
  ];
  it.each(ignored)('leaves a non-submit keyboard event alone: %j', async init => {
    const caller = vi.fn(async () => readinessFor(ALPHA)); const t = setup({ runReadiness: caller });
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!; t.type(ALPHA); input.focus();
    const event = input.dispatch('keydown', init);
    expect(Boolean(event.defaultPrevented)).toBe(Boolean(init.defaultPrevented));
    await t.settle(); expect(caller).not.toHaveBeenCalled(); expect(t.enrolCalls).toEqual([]);
    expect(t.mount.state().error).toBeNull(); expect(t.doc.activeElement).toBe(input);
  });

  it('does not start a check from a repeat event, including after a previous check settles', () => {
    const caller = vi.fn(async () => readinessFor(ALPHA)); const t = setup({ runReadiness: caller });
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!; t.type(ALPHA); input.focus();
    expect(input.dispatch('keydown', { key: 'Enter', repeat: true }).defaultPrevented).toBe(true);
    expect(caller).not.toHaveBeenCalled();
  });

  it('keeps composition ownership even when Enter lacks the isComposing flag', async () => {
    const caller = vi.fn(async () => readinessFor(ALPHA)); const t = setup({ runReadiness: caller });
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!; t.type(ALPHA); input.focus();
    input.dispatch('compositionstart');
    expect(input.dispatch('keydown', { key: 'Enter', isComposing: false }).defaultPrevented).not.toBe(true);
    expect(caller).not.toHaveBeenCalled();
    input.dispatch('compositionend');
    input.dispatch('keydown', { key: 'Enter', isComposing: false, keyCode: 229 });
    expect(caller).not.toHaveBeenCalled();
    input.dispatch('keydown', { key: 'Enter' }); await t.settle();
    expect(caller).toHaveBeenCalledTimes(1); expect(t.doc.activeElement).toBe(input);
  });

  it('does not turn Enter into a DNS read or second write during enrollment', async () => {
    const read = vi.fn(async () => readinessFor(ALPHA));
    const write = pending<Awaited<ReturnType<CustomDomainEnrolCaller>>>(); const enroll = vi.fn(() => write.promise);
    const t = setup({ runReadiness: read, runEnrol: enroll }); t.type(ALPHA);
    t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR); await t.settle(); t.click(CUSTOM_DOMAINS_ADD_BTN_ATTR);
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!;
    expect(input.disabled).toBe(true); input.dispatch('keydown', { key: 'Enter' }); input.dispatch('keydown', { key: 'Enter', repeat: true });
    expect(read).toHaveBeenCalledTimes(1); expect(enroll).toHaveBeenCalledTimes(1);
    t.mount.destroy(); write.resolve({ hostname: { hostname: ALPHA } as never }); await t.settle();
  });

  it('ignores Enter from a disposed input', () => {
    const caller = vi.fn(async () => readinessFor(ALPHA)); const t = setup({ runReadiness: caller });
    const input = firstByAttr(t.host, CUSTOM_DOMAINS_INPUT_ATTR)!; t.type(ALPHA); t.mount.destroy();
    expect(input.dispatch('keydown', { key: 'Enter' }).defaultPrevented).not.toBe(true);
    expect(caller).not.toHaveBeenCalled();
  });
});


describe('custom-domain validation associations', () => {
  const required = 'Type the name you want to use.';
  const validate = (t: ReturnType<typeof setup>) => {
    const input = firstByAttr(t.host,CUSTOM_DOMAINS_INPUT_ATTR)!; input.focus(); input.dispatch('keydown',{key:'Enter'});
    return input;
  };
  const association = (t: ReturnType<typeof setup>) => {
    const input = firstByAttr(t.host,CUSTOM_DOMAINS_INPUT_ATTR)!; const error = firstByAttr(t.host,CUSTOM_DOMAINS_ERROR_ATTR)!;
    const id = error.getAttribute('id')!; expect(id).toMatch(/^custom-domain-validation-\d+$/);
    expect(input.getAttribute('aria-invalid')).toBe('true'); expect(input.getAttribute('aria-describedby')!.split(/\s+/)).toContain(id);
    expect(error.textContent).toBe(required); expect(error.getAttribute('role')).toBe('alert'); return {input,error,id};
  };
  const clean = (input: FakeEl) => { expect(input.getAttribute('aria-invalid')).toBeNull(); expect(input.getAttribute('aria-describedby')).toBeNull(); };
  for (const raw of ['', '   ', 'https://']) {
    it(`describes a known empty-hostname validation without a read: ${JSON.stringify(raw)}`, () => {
      const read = vi.fn(async () => readinessFor(ALPHA)); const t = setup({runReadiness:read}); t.type(raw); const input = validate(t);
      association(t); expect(t.doc.activeElement).toBe(input); expect(input.value).toBe(raw); expect(read).not.toHaveBeenCalled(); expect(t.enrolCalls).toEqual([]); t.mount.destroy();
    });
  }
  for (const correction of ['  AlPhA.Example.test  ', ' ', 'https://']) {
    it(`clears local feedback on an accepted native edit without replacing the input: ${JSON.stringify(correction)}`, () => {
      const t = setup(); const input = validate(t); association(t); t.type(correction);
      expect(firstByAttr(t.host,CUSTOM_DOMAINS_INPUT_ATTR)).toBe(input); expect(t.doc.activeElement).toBe(input);
      expect(input.value).toBe(correction); expect(t.mount.state().hostname).toBe(correction); expect(t.mount.state().error).toBeNull();
      expect(firstByAttr(t.host,CUSTOM_DOMAINS_ERROR_ATTR)).toBeUndefined(); clean(input); t.mount.destroy();
    });
  }
  it('associates button validation without taking outside focus', () => {
    const t = setup(); const outside = t.doc.createElement('button'); outside.focus(); t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR);
    association(t); expect(t.doc.activeElement).toBe(outside); t.mount.destroy();
  });
  it('uses a separate message identity for panels in the same document', () => {
    const doc = makeDoc(); const first = setup({document:doc}); const second = setup({document:doc}); validate(first); const a = association(first); validate(second); const b = association(second);
    expect(a.id).not.toBe(b.id); expect(a.input.getAttribute('aria-describedby')).toBe(a.id); expect(b.input.getAttribute('aria-describedby')).toBe(b.id);
    first.mount.destroy(); expect(b.input.getAttribute('aria-describedby')).toBe(b.id); second.mount.destroy();
  });
  it('merges other descriptions once and restores the previous invalid state', () => {
    const t = setup(); const input = firstByAttr(t.host,CUSTOM_DOMAINS_INPUT_ATTR)!;
    input.setAttribute('aria-describedby','first-hint second-hint'); input.setAttribute('aria-invalid','grammar'); validate(t); const {id} = association(t);
    validate(t); expect(association(t).id).toBe(id); expect(input.getAttribute('aria-describedby')).toBe(`first-hint second-hint ${id}`);
    t.type(ALPHA); expect(input.getAttribute('aria-describedby')).toBe('first-hint second-hint'); expect(input.getAttribute('aria-invalid')).toBe('grammar'); t.mount.destroy();
  });
  it('preserves attribute changes made by another owner while feedback is active', () => {
    const t = setup(); const input = validate(t); const {id} = association(t);
    input.setAttribute('aria-describedby',`new-hint ${id}`); input.setAttribute('aria-invalid','spelling'); t.type(ALPHA);
    expect(input.getAttribute('aria-describedby')).toBe('new-hint'); expect(input.getAttribute('aria-invalid')).toBe('spelling'); t.mount.destroy();
  });
  it('does not classify a matching DNS error message as local validation', async () => {
    const t = setup({runReadiness:async () => {throw new Error(required);}}); const input = validate(t); association(t);
    t.type(ALPHA); t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR); clean(input); expect(t.mount.state().checking).toBe(true); await t.settle();
    expect(t.mount.state().error).toBe(required); expect(firstByAttr(t.host,CUSTOM_DOMAINS_ERROR_ATTR)!.getAttribute('id')).toBeNull(); clean(input); t.mount.destroy();
  });
  it('does not classify a matching enrollment error as local validation', async () => {
    const t = setup({hostname:ALPHA,runEnrol:async () => {throw new Error(required);}}); const input = validate(t); association(t);
    t.type(ALPHA); t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR); await t.settle(); t.click(CUSTOM_DOMAINS_ADD_BTN_ATTR); await t.settle();
    expect(t.mount.state().error).toBe(required); clean(input); expect(firstByAttr(t.host,CUSTOM_DOMAINS_ERROR_ATTR)!.getAttribute('id')).toBeNull(); t.mount.destroy();
  });
  for (const outcome of ['success','error'] as const) {
    it(`ignores a stale DNS ${outcome} after local validation takes ownership`, async () => {
      const deferred = pending<ReturnType<typeof readinessFor>>(); const t = setup({runReadiness:() => deferred.promise});
      t.type(ALPHA); t.click(CUSTOM_DOMAINS_CHECK_BTN_ATTR); t.type(''); validate(t); const {id,error} = association(t);
      if (outcome==='success') deferred.resolve(readinessFor(ALPHA)); else deferred.reject(new Error('Stale DNS failure'));
      await t.settle(); expect(association(t).id).toBe(id); expect(firstByAttr(t.host,CUSTOM_DOMAINS_ERROR_ATTR)).toBe(error); expect(t.mount.state().error).toBe(required); t.mount.destroy();
    });
  }
  it('removes only its association on teardown and ignores retired input events', () => {
    const t = setup(); const input = firstByAttr(t.host,CUSTOM_DOMAINS_INPUT_ATTR)!; input.setAttribute('aria-describedby','retained-hint'); input.setAttribute('aria-invalid','false');
    validate(t); association(t); t.mount.destroy(); expect(input.getAttribute('aria-describedby')).toBe('retained-hint'); expect(input.getAttribute('aria-invalid')).toBe('false');
    const before = t.mount.state(); input.value=ALPHA; input.dispatch('input'); input.dispatch('keydown',{key:'Enter'}); expect(t.mount.state()).toBe(before); t.mount.destroy();
  });
});


describe('custom-domain validation ownership audit', () => {
  for (const newer of ['spelling',null] as const) {
    it(`preserves a newer invalid state across repeated validation: ${JSON.stringify(newer)}`,() => {
      const t=setup(); const input=firstByAttr(t.host,CUSTOM_DOMAINS_INPUT_ATTR)!;
      input.setAttribute('aria-invalid','grammar'); input.focus(); input.dispatch('keydown',{key:'Enter'});
      const id=firstByAttr(t.host,CUSTOM_DOMAINS_ERROR_ATTR)!.getAttribute('id')!;
      if (newer===null) input.removeAttribute('aria-invalid'); else input.setAttribute('aria-invalid',newer);
      input.setAttribute('aria-describedby',`new-hint ${id}`);
      input.dispatch('keydown',{key:'Enter'}); expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe(`new-hint ${id}`);
      t.type(ALPHA); expect(input.getAttribute('aria-invalid')).toBe(newer); expect(input.getAttribute('aria-describedby')).toBe('new-hint');
      expect(t.mount.state().error).toBeNull(); expect(t.doc.activeElement).toBe(input); t.mount.destroy();
    });
  }
});
