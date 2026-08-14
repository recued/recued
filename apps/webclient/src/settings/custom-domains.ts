/** D-235 P5 — Settings → Server → Domains.
 *
 *  The bring-your-own-domain flow: type a hostname, create the DNS it asks for,
 *  watch the checks go green, enrol.
 *
 *  ⛔ THE PANEL'S REAL JOB IS § 2.5 — the thing that falsified the first draft of
 *  the design. The obvious mental model is "point my domain at Recued and I'm
 *  done", and that model is HALF RIGHT, which is worse than wrong: the host
 *  CNAME makes the domain REACH the server while issuance still fails, because
 *  DNS-01 validates a DIFFERENT name (`_acme-challenge.<host>`) in a zone Recued
 *  cannot write. So the delegation is never described as optional or advanced,
 *  it always renders, and it keeps its own check.
 *
 *  ⚠ ONE RECORD CARD, THEN A STEP — not two cards (owner call, 2026-08-13).
 *  Two identical cards read as two independent things to work out, and the
 *  second carries no new decision: its name and value are the first record's
 *  with `_acme-challenge.` prepended. So the delegation leads with that RULE in
 *  words and then gives the exact strings, as an indented step rather than a
 *  co-equal box. § 2.5 is about the delegation never looking OPTIONAL, which is
 *  a different property from it looking EQUAL — `custom-domains.test.ts` pins
 *  the first (always rendered, no hedging words, states the consequence) rather
 *  than the card count.
 *
 *  ⚠ § 3.1's apex caveat is stated BEFORE the user goes to their DNS provider,
 *  not after it fails: RFC 1034 forbids a CNAME at a zone apex, so an apex user
 *  who follows the instructions literally produces a broken zone and blames us.
 *
 *  Read-only until the user acts. Preflight mutates nothing, so the panel can
 *  re-check as often as the user likes while they edit their zone.
 */

import { relativeDnsName } from '@recued/contracts';
import type {
  CustomDomainPreflightResult,
  CustomDomainPreflightCheckResult,
  CustomDomainIssuanceDecision,
  CustomDomainIssuanceBlocker,
  HostnameProjection,
} from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const CUSTOM_DOMAINS_PANEL_ATTR = 'data-recued-custom-domains';
export const CUSTOM_DOMAINS_INPUT_ATTR = 'data-recued-custom-domains-input';
export const CUSTOM_DOMAINS_CHECK_BTN_ATTR = 'data-recued-custom-domains-check';
export const CUSTOM_DOMAINS_ADD_BTN_ATTR = 'data-recued-custom-domains-add';
export const CUSTOM_DOMAINS_RECORD_ATTR = 'data-recued-custom-domains-record';
export const CUSTOM_DOMAINS_COPY_BTN_ATTR = 'data-recued-custom-domains-copy';
export const CUSTOM_DOMAINS_CHECK_ROW_ATTR = 'data-recued-custom-domains-check-row';
export const CUSTOM_DOMAINS_APEX_ATTR = 'data-recued-custom-domains-apex';
export const CUSTOM_DOMAINS_BLOCKER_ATTR = 'data-recued-custom-domains-blocker';
export const CUSTOM_DOMAINS_ERROR_ATTR = 'data-recued-custom-domains-error';
/** D-235 — the relative-name hint; carries the relative form so a test can
 *  assert the thing the user is meant to paste. */
export const CUSTOM_DOMAINS_RELATIVE_ATTR = 'data-recued-custom-domains-relative';
export const CUSTOM_DOMAINS_RECORD_NOTE_ATTR = 'data-recued-custom-domains-record-note';
/** The `_acme-challenge` delegation step. Rendered as an INSTRUCTION, not as a
 *  second record card — see the § 2.5 note in the module header. */
export const CUSTOM_DOMAINS_DELEGATION_ATTR = 'data-recued-custom-domains-delegation';

export type CustomDomainPreflightCaller = (args: {
  hostname: string;
}) => Promise<{ preflight: CustomDomainPreflightResult }>;

export type CustomDomainReadinessCaller = (args: {
  hostname: string;
}) => Promise<{
  decision: CustomDomainIssuanceDecision;
  preflight: CustomDomainPreflightResult;
}>;

export type CustomDomainEnrolCaller = (args: {
  hostname: string;
  cert_source: 'recued_acme_custom';
}) => Promise<{ hostname: HostnameProjection }>;

/** Per-check copy. ⚠ Written for someone standing in their DNS provider's
 *  console, so each line names the RECORD to look at rather than the internal
 *  check that failed. */
const CHECK_TITLES: Record<string, string> = {
  host_route: 'Your domain points at this server',
  acme_delegation: 'Certificate delegation',
  caa: 'Certificate authority permissions (CAA)',
};

const CHECK_DETAIL: Record<string, string> = {
  // host_route
  host_cname_matches_ddns: 'Resolves to your Recued address.',
  host_flattened_matches_ddns:
    'Resolves to the right address today, but as a flattened A record rather than a CNAME — '
    + 'if your provider does not keep it in sync with your Recued address, it will break when your IP changes.',
  host_flattened_stale:
    'Points at an address that is no longer yours. Replace it with a CNAME to your Recued address, '
    + 'or an ALIAS/ANAME if this is a zone apex.',
  host_cname_target_mismatch: 'Points somewhere else. Update it to your Recued address.',
  host_unresolved: 'Does not resolve. Add the record below.',
  host_ddns_baseline_unavailable:
    'We could not read your Recued address to compare against, so this one is unproven rather than wrong.',
  host_resolver_error: 'We could not look this up just now — this says nothing about your records.',
  // acme_delegation
  delegation_target_matches: 'Delegated to Recued. Certificates can be issued and renewed.',
  delegation_target_mismatch: 'Points somewhere else. Update it to the exact value below.',
  delegation_missing:
    'Not found. Without it Recued cannot prove it may issue certificates for this domain — '
    + 'pointing your domain at the server is not enough on its own.',
  delegation_not_a_cname:
    'A record exists at that name, but it is not a CNAME pointing at Recued. If your DNS provider '
    + 'proxies records — Cloudflare\'s orange cloud — set this one to "DNS only"; a proxied CNAME is '
    + 'hidden from the certificate authority and cannot be followed.',
  delegation_resolver_error: 'We could not look this up just now — this says nothing about your records.',
  // caa
  caa_absent: 'No restrictions — any certificate authority may issue.',
  caa_permits_all_rotation_cas: 'Permits every authority Recued uses.',
  caa_permits_some_rotation_cas:
    'Permits only some of the authorities Recued uses. Issuance would succeed sometimes and fail '
    + 'other times, months apart, with nothing obvious linking the two.',
  caa_permits_no_rotation_cas: 'Blocks every authority Recued uses.',
  caa_critical_unknown_tag:
    'Contains a critical record no authority will look past, so all issuance is refused.',
  caa_resolver_error: 'We could not look this up just now — this says nothing about your records.',
};

const STATUS_MARK: Record<string, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✕',
  unknown: '?',
};

/** ⚠ Deliberately NOT "error" copy for a gate that has not been reached. Every
 *  blocker names something the user does next, in their words. */
const BLOCKER_COPY: Record<CustomDomainIssuanceBlocker, string> = {
  not_a_custom_acme_hostname: 'This hostname is not set up as a Recued-managed custom domain yet.',
  ownership_unverified: 'Verify you own this hostname first — use the Verify action on its row.',
  ownership_proof_method_insufficient:
    'This hostname was verified with a certificate proof, which cannot authorize Recued to issue a '
    + 'new certificate. Re-verify with the DNS TXT or HTTP token challenge.',
  delegation_unchecked: 'Run the DNS check first.',
  delegation_unverified: 'The _acme-challenge delegation is not pointing at Recued yet.',
  caa_blocks_rotation: 'Your CAA records do not permit every certificate authority Recued uses.',
  subscription_inactive: 'Custom domains need an active Pro subscription.',
  hostname_disabled: 'This hostname is disabled. Enable it to have Recued manage its certificate.',
  custom_hostname_cap_reached:
    'You have reached the limit for custom domains on this server. Remove one to add another.',
};

export interface CustomDomainsPanelState {
  hostname: string;
  checking: boolean;
  enrolling: boolean;
  error: string | null;
  preflight: CustomDomainPreflightResult | null;
  decision: CustomDomainIssuanceDecision | null;
  enrolled: string | null;
}

export interface MountCustomDomainsPanelOptions {
  host: HTMLElement;
  document?: Document;
  runPreflight: CustomDomainPreflightCaller;
  /** Absent ⇒ the panel checks DNS but does not offer to enrol. */
  runReadiness?: CustomDomainReadinessCaller;
  runEnrol?: CustomDomainEnrolCaller;
  /** Called after a successful enrolment so the sibling hostname list refreshes
   *  — the new row is the thing the user looks for next. */
  onEnrolled?: (hostname: string) => void;
  /** Clipboard seam. Absent ⇒ copy buttons render but fall back to selecting
   *  the text, which is what a browser without clipboard permission can do. */
  writeClipboard?: (text: string) => Promise<void>;
}

export interface CustomDomainsPanelMount {
  destroy(): void;
  /** Test/debug read of the current state. */
  state(): CustomDomainsPanelState;
}

export const CUSTOM_DOMAINS_PANEL_STYLES = `
[${CUSTOM_DOMAINS_PANEL_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.custom-domains-intro {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.custom-domains-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.custom-domains-input {
  flex: 1 1 240px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
}
.custom-domains-records {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.custom-domains-record {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.custom-domains-record-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.custom-domains-record-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}
.custom-domains-record-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.custom-domains-record-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
/* The delegation step. Deliberately NOT a .custom-domains-record: no border box,
   so it reads as the continuation of the record above rather than a second
   thing to evaluate. It keeps a left rule + indent so it is still visibly a
   required step and not a footnote — § 2.5 says it must never look optional.
   (No backticks in here: this block is a TS template literal.) */
.custom-domains-delegation {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-left: 10px;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--border);
}
.custom-domains-delegation-lead {
  font-size: 12px;
  line-height: 1.5;
}
.custom-domains-delegation-pair {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.custom-domains-apex {
  border-left: 3px solid var(--warn);
  background: var(--warn-bg);
  color: var(--warn);
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.custom-domains-check {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
  line-height: 1.5;
}
.custom-domains-check-mark {
  font-weight: 700;
  flex: 0 0 auto;
}
.custom-domains-check-pass .custom-domains-check-mark { color: var(--ok-fg); }
.custom-domains-check-warn .custom-domains-check-mark { color: var(--warn); }
.custom-domains-check-fail .custom-domains-check-mark { color: var(--danger); }
.custom-domains-check-unknown .custom-domains-check-mark { color: var(--muted); }
.custom-domains-check-title { font-weight: 600; }
.custom-domains-check-detail { color: var(--muted); }
.custom-domains-blockers {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.custom-domains-error {
  color: var(--danger);
  font-size: 12px;
}
`;

const normalize = (value: string): string =>
  value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.+$/, '');

export const mountCustomDomainsPanel = (
  opts: MountCustomDomainsPanelOptions,
): CustomDomainsPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountCustomDomainsPanel: no document available - pass `opts.document` for non-browser environments',
    );
  }

  let state: CustomDomainsPanelState = {
    hostname: '',
    checking: false,
    enrolling: false,
    error: null,
    preflight: null,
    decision: null,
    enrolled: null,
  };
  let destroyed = false;

  const root = doc.createElement('div');
  root.setAttribute(CUSTOM_DOMAINS_PANEL_ATTR, '');
  opts.host.appendChild(root);

  const setState = (next: Partial<CustomDomainsPanelState>): void => {
    state = { ...state, ...next };
    render();
  };

  const el = (
    tag: string,
    className?: string,
    text?: string,
  ): HTMLElement => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const makeButton = (
    label: string,
    attr: string,
    onClick: () => void,
    disabled = false,
  ): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute(attr, '');
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  };

  const runCheck = async (): Promise<void> => {
    const hostname = normalize(state.hostname);
    if (hostname.length === 0) {
      setState({ error: 'Enter the hostname you want to use.' });
      return;
    }
    setState({ checking: true, error: null, enrolled: null });
    try {
      // Prefer the readiness call: it runs the SAME preflight and adds the
      // gate's verdict, so asking twice cannot produce two different answers
      // about one zone the user may be editing as we look.
      if (opts.runReadiness) {
        const result = await opts.runReadiness({ hostname });
        if (destroyed) return;
        setState({
          checking: false,
          preflight: result.preflight,
          decision: result.decision,
        });
        return;
      }
      const result = await opts.runPreflight({ hostname });
      if (destroyed) return;
      setState({ checking: false, preflight: result.preflight, decision: null });
    } catch (err) {
      if (destroyed) return;
      setState({ checking: false, error: humanizeRpcError(err) });
    }
  };

  const runEnrol = async (): Promise<void> => {
    if (!opts.runEnrol) return;
    const hostname = normalize(state.hostname);
    setState({ enrolling: true, error: null });
    try {
      await opts.runEnrol({ hostname, cert_source: 'recued_acme_custom' });
      if (destroyed) return;
      setState({ enrolling: false, enrolled: hostname });
      opts.onEnrolled?.(hostname);
      // Re-check so the row's state reflects what the server now believes,
      // rather than what we believed a moment before the write.
      void runCheck();
    } catch (err) {
      if (destroyed) return;
      setState({ enrolling: false, error: humanizeRpcError(err) });
    }
  };

  const renderRecord = (
    parent: HTMLElement,
    label: string,
    record: { name: string; type: string; value: string },
    hostname: string,
    note?: string,
  ): void => {
    const box = el('div', 'custom-domains-record');
    box.setAttribute(CUSTOM_DOMAINS_RECORD_ATTR, label);
    box.appendChild(el('div', 'custom-domains-record-label', label));
    for (const [field, value] of [
      ['Name', record.name],
      ['Type', record.type],
      ['Value', record.value],
    ] as const) {
      const row = el('div', 'custom-domains-record-row');
      row.appendChild(el('span', 'custom-domains-record-label', field));
      row.appendChild(el('span', 'custom-domains-record-value', value));
      box.appendChild(row);
    }
    // ⛔ THE FULL NAME IS CORRECT AND IS THE WRONG THING TO PASTE. Every major
    //   provider's Name field is RELATIVE to the zone, so an FQDN silently
    //   becomes `_acme-challenge.example.com.example.com` — a record that looks
    //   created, resolves nowhere, and fails as "delegation missing". Showing
    //   both forms costs one line and removes the whole class of mistake.
    const short = relativeDnsName(record.name, hostname);
    if (short !== record.name) {
      const hint = el(
        'div',
        'custom-domains-record-hint',
        `Most DNS providers want the name relative to your zone — enter just: ${short}`,
      );
      hint.setAttribute(CUSTOM_DOMAINS_RELATIVE_ATTR, short);
      box.appendChild(hint);
    }
    if (note !== undefined) {
      const noteEl = el('div', 'custom-domains-record-hint', note);
      noteEl.setAttribute(CUSTOM_DOMAINS_RECORD_NOTE_ATTR, '');
      box.appendChild(noteEl);
    }
    box.appendChild(
      makeButton('Copy value', CUSTOM_DOMAINS_COPY_BTN_ATTR, () => {
        void opts.writeClipboard?.(record.value);
      }),
    );
    parent.appendChild(box);
  };

  /** The `_acme-challenge` delegation, rendered as the SECOND STEP of one task
   *  rather than as a second record card.
   *
   *  ⛔ § 2.5 still governs: the delegation is not optional and not advanced,
   *  and the panel must not let "point my domain at Recued and I'm done" feel
   *  complete. What changed is only the VISUAL WEIGHT — two identical cards
   *  read as two independent things to evaluate, when the second carries no
   *  new decision: its name and value are the first record's with
   *  `_acme-challenge.` prepended. Leading with that rule in words, and then
   *  giving the exact strings, says "same record again, one prefix" instead of
   *  "here is another record to work out".
   *
   *  ⚠ WHAT MUST NOT BE LOST IN THE DEMOTION — both of these were REAL defects
   *  a live drive found, not hypotheticals:
   *    - the relative-name hint (a provider Name field is relative; pasting the
   *      FQDN yields `_acme-challenge.example.com.example.com`), and
   *    - the Cloudflare proxy note (their DEFAULT for a CNAME is proxied, which
   *      hides the record from the CA — we then reported "no CNAME", i.e. "you
   *      did not create it", to someone looking straight at it).
   *  Both stay, and so does the copy button: the value is the longest string on
   *  the page and the one nobody should retype. */
  const renderDelegationStep = (
    parent: HTMLElement,
    preflight: CustomDomainPreflightResult,
  ): void => {
    const record = preflight.required_records.delegation;
    const box = el('div', 'custom-domains-delegation');
    box.setAttribute(CUSTOM_DOMAINS_DELEGATION_ATTR, '');

    box.appendChild(
      el(
        'div',
        'custom-domains-delegation-lead',
        'Then add that same record a second time, with _acme-challenge. in front of '
          + 'both the name and the value. This is what lets Recued prove it may issue '
          + 'certificates for your domain — without it the domain reaches your server '
          + 'but every certificate order fails.',
      ),
    );

    const pair = el('div', 'custom-domains-delegation-pair');
    for (const [field, value] of [
      ['Name', record.name],
      ['Value', record.value],
    ] as const) {
      const row = el('div', 'custom-domains-record-row');
      row.appendChild(el('span', 'custom-domains-record-label', field));
      row.appendChild(el('span', 'custom-domains-record-value', value));
      pair.appendChild(row);
    }
    box.appendChild(pair);

    const short = relativeDnsName(record.name, preflight.hostname);
    if (short !== record.name) {
      const hint = el(
        'div',
        'custom-domains-record-hint',
        `Most DNS providers want the name relative to your zone — enter just: ${short}`,
      );
      hint.setAttribute(CUSTOM_DOMAINS_RELATIVE_ATTR, short);
      box.appendChild(hint);
    }

    const note = el(
      'div',
      'custom-domains-record-hint',
      'If your provider proxies records — Cloudflare\'s orange cloud — set THIS one to '
        + '"DNS only". A proxied CNAME is hidden from the certificate authority and cannot be '
        + 'followed. A trailing dot on the value is fine either way.',
    );
    note.setAttribute(CUSTOM_DOMAINS_RECORD_NOTE_ATTR, '');
    box.appendChild(note);

    box.appendChild(
      makeButton('Copy value', CUSTOM_DOMAINS_COPY_BTN_ATTR, () => {
        void opts.writeClipboard?.(record.value);
      }),
    );
    parent.appendChild(box);
  };

  const renderCheck = (
    parent: HTMLElement,
    check: CustomDomainPreflightCheckResult,
  ): void => {
    const row = el('div', `custom-domains-check custom-domains-check-${check.status}`);
    row.setAttribute(CUSTOM_DOMAINS_CHECK_ROW_ATTR, `${check.check}:${check.status}`);
    row.appendChild(
      el('span', 'custom-domains-check-mark', STATUS_MARK[check.status] ?? '·'),
    );
    const body = el('div');
    body.appendChild(
      el('div', 'custom-domains-check-title', CHECK_TITLES[check.check] ?? check.check),
    );
    body.appendChild(
      el('div', 'custom-domains-check-detail', CHECK_DETAIL[check.code] ?? check.code),
    );
    // Echo what we actually saw, so a user comparing against their zone editor
    // can spot a typo without us having to guess which character is wrong.
    if (check.observed !== undefined && check.observed.length > 0) {
      body.appendChild(
        el('div', 'custom-domains-check-detail', `Found: ${check.observed.join(', ')}`),
      );
    }
    row.appendChild(body);
    parent.appendChild(row);
  };

  const render = (): void => {
    root.textContent = '';

    root.appendChild(
      el(
        'div',
        'custom-domains-intro',
        // ⚠ NO ORDINALS. The old copy said "two DNS records, and it is the
        //   second one that does the work" — written when the panel rendered
        //   two identical cards. With one card and a step, "the second one"
        //   has nothing to point at until you scroll, and "two records" primes
        //   you to hunt for a second card that is not there. Say the SHAPE
        //   instead (one CNAME, entered twice), which is also what the step
        //   below says, so the two never disagree.
        //   § 2.5's warning stays — it is the last clause, and it is the whole
        //   reason this panel exists.
        'Use a domain you own — Recued issues and renews its certificate for you. '
          + 'That takes one CNAME, entered twice: once to point the domain at your server, '
          + 'and once more with an _acme-challenge. prefix so Recued can prove it may issue '
          + 'certificates. Without the prefixed one your domain will reach your server, but '
          + 'no certificate can ever be issued.',
      ),
    );

    const form = el('div', 'custom-domains-form');
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'custom-domains-input';
    input.placeholder = 'recued.your-domain.com';
    input.value = state.hostname;
    input.setAttribute(CUSTOM_DOMAINS_INPUT_ATTR, '');
    input.addEventListener('input', () => {
      state = { ...state, hostname: input.value };
    });
    form.appendChild(input);
    form.appendChild(
      makeButton(
        state.checking ? 'Checking…' : 'Check DNS',
        CUSTOM_DOMAINS_CHECK_BTN_ATTR,
        () => { void runCheck(); },
        state.checking,
      ),
    );
    root.appendChild(form);

    if (state.error !== null) {
      const error = el('div', 'custom-domains-error', state.error);
      error.setAttribute(CUSTOM_DOMAINS_ERROR_ATTR, '');
      root.appendChild(error);
    }

    const preflight = state.preflight;
    if (preflight === null) return;

    // ⚠ § 3.1 — ABOVE THE RECORDS, NOT BELOW THEM. The caveat changes what the
    //   user should DO with the first record (an ALIAS/ANAME, not the CNAME the
    //   card shows), so a reader who meets it afterwards has already copied the
    //   wrong thing. Caught by looking at the rendered panel; both orderings
    //   pass every assertion, which is why only a real browser shows it.
    if (preflight.apex_cname_caveat) {
      const apex = el(
        'div',
        'custom-domains-apex',
        `${preflight.hostname} looks like the root of your domain, and DNS does not allow a CNAME there. `
          // Scoped to the ROUTING record on purpose: `_acme-challenge.<apex>` is
          // a subdomain of the apex, not the apex, so a CNAME there is legal and
          // needs no flattening. Naming the record by what it DOES keeps that
          // distinction after the ordinals went away.
          + 'Use your provider\'s ALIAS, ANAME or "CNAME flattening" option for the record '
          + 'that points your domain at the server — '
          + 'Cloudflare, Route 53, DNSimple and deSEC all support it. A subdomain like '
          + `recued.${preflight.hostname} avoids the problem entirely and works everywhere.`,
      );
      apex.setAttribute(CUSTOM_DOMAINS_APEX_ATTR, '');
      root.appendChild(apex);
    }

    // ── the record, then the delegation step ───────────────────────────
    const records = el('div', 'custom-domains-records');
    renderRecord(
      records,
      'Point your domain here',
      preflight.required_records.host,
      preflight.hostname,
    );
    renderDelegationStep(records, preflight);
    root.appendChild(records);

    // ── the checks ─────────────────────────────────────────────────────
    const checks = el('div', 'custom-domains-records');
    for (const check of preflight.checks) renderCheck(checks, check);
    root.appendChild(checks);

    // ── what is left to do ─────────────────────────────────────────────
    const decision = state.decision;
    if (decision !== null && !decision.eligible) {
      const blockers = el('div', 'custom-domains-blockers');
      for (const blocker of decision.blockers) {
        // `not_a_custom_acme_hostname` before enrolment is not a problem, it is
        // the ordinary state of a domain the user has not added yet — saying so
        // would read as an error at the exact moment nothing is wrong.
        if (blocker === 'not_a_custom_acme_hostname' && state.enrolled === null) continue;
        const line = el('div', undefined, `• ${BLOCKER_COPY[blocker]}`);
        line.setAttribute(CUSTOM_DOMAINS_BLOCKER_ATTR, blocker);
        blockers.appendChild(line);
      }
      if (decision.missing_caa_identifiers.length > 0) {
        blockers.appendChild(
          el(
            'div',
            undefined,
            `Add these CAA "issue" records on your domain: ${decision.missing_caa_identifiers.join(', ')}`,
          ),
        );
      }
      if (blockers.childNodes.length > 0) root.appendChild(blockers);
    }

    if (state.enrolled !== null) {
      root.appendChild(
        el(
          'div',
          'custom-domains-intro',
          `${state.enrolled} added. Recued will issue its certificate once the checks above pass, `
            + 'and renew it from then on.',
        ),
      );
    }

    if (opts.runEnrol !== undefined && state.enrolled === null) {
      root.appendChild(
        makeButton(
          state.enrolling ? 'Adding…' : 'Add this domain',
          CUSTOM_DOMAINS_ADD_BTN_ATTR,
          () => { void runEnrol(); },
          state.enrolling,
        ),
      );
    }
  };

  render();

  return {
    destroy() {
      destroyed = true;
      root.remove();
    },
    state: () => state,
  };
};
