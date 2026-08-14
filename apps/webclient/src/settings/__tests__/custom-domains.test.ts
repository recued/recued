/** D-235 P5 — Settings → Server → Domains.
 *
 *  ⚠ Drives a HAND-ROLLED fake document, which is the repo convention (no DOM
 *  library is installed) and which cannot see layout, CSS, or a real click
 *  path. The browser check that can lives in the `apps/webclient:verify` skill;
 *  this file is the fast regression net, not the proof it renders.
 */

import { describe, it, expect } from 'vitest';

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
} from '../custom-domains.js';

// ── the fake document ───────────────────────────────────────────────────

interface FakeEl {
  tag: string;
  className: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  _text: string;
  textContent: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeEl): FakeEl;
  addEventListener(kind: string, fn: () => void): void;
  dispatch(kind: string): void;
  remove(): void;
  parent?: FakeEl;
  readonly childNodes: FakeEl[];
}

const makeEl = (tag: string): FakeEl => {
  const el = {
    tag,
    className: '',
    attrs: new Map<string, string>(),
    children: [] as FakeEl[],
    listeners: new Map<string, Array<() => void>>(),
    _text: '',
    setAttribute(name: string, value: string) { el.attrs.set(name, value); },
    getAttribute(name: string) { return el.attrs.get(name) ?? null; },
    appendChild(child: FakeEl) { child.parent = el; el.children.push(child); return child; },
    addEventListener(kind: string, fn: () => void) {
      const list = el.listeners.get(kind) ?? [];
      list.push(fn);
      el.listeners.set(kind, list);
    },
    dispatch(kind: string) { for (const fn of el.listeners.get(kind) ?? []) fn(); },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
    },
    get childNodes() { return el.children; },
  } as unknown as FakeEl;
  Object.defineProperty(el, 'textContent', {
    get() {
      // Mirrors the DOM: an element's textContent is its own text plus every
      // descendant's, which is what the assertions below read.
      return el._text + el.children.map((c) => c.textContent).join('');
    },
    set(v: string) { el._text = v; el.children = []; },
  });
  return el;
};

const makeDoc = () => ({ createElement: (tag: string) => makeEl(tag) });

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
  hostname?: string;
  observation?: Partial<CustomDomainDnsObservation>;
  enrolled?: boolean;
  withEnrol?: boolean;
  preflightThrows?: Error;
} = {}) => {
  const doc = makeDoc();
  const host = makeEl('div');
  const enrolCalls: unknown[] = [];
  const copied: string[] = [];
  const hostname = opts.hostname ?? 'recued.their-domain.com';

  const mount = mountCustomDomainsPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    writeClipboard: async (value: string) => { copied.push(value); },
    runPreflight: async () => {
      if (opts.preflightThrows) throw opts.preflightThrows;
      return { preflight: preflightFor(hostname, opts.observation) };
    },
    runReadiness: async () => {
      if (opts.preflightThrows) throw opts.preflightThrows;
      const preflight = preflightFor(hostname, opts.observation);
      return { preflight, decision: decisionFor(preflight, opts.enrolled ?? false) };
    },
    ...(opts.withEnrol === false
      ? {}
      : {
          runEnrol: async (args) => {
            enrolCalls.push(args);
            return { hostname: { hostname: args.hostname } as never };
          },
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
    expect(copy).toContain('no certificate can ever be issued');
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
    expect(copy).toContain('every certificate order fails');
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
    expect(textOf(firstByAttr(t.host, CUSTOM_DOMAINS_ERROR_ATTR)!)).toContain('Enter the hostname');
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
