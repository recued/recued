/** D-194 2b-2 — the install dialog's "Connect account" section.
 *
 *  A pure model + render sibling of `install-grant-picker.ts` (host owns the
 *  state; this reads props + wires callbacks). Where the grant picker chooses
 *  WHAT access a connection gets, this chooses WHICH connection instance the
 *  pack binds — the owner's `chosen_connection`, threaded into `packs.install`
 *  (2b-1) so the grant + catalog binding re-source to it (step 3a).
 *
 *  Model A (owner-decided): connect is OPTIONAL. The pack installs whether or
 *  not a connection is picked; deny-until-granted keeps an unconnected pack
 *  inert, and the pack-list-row readiness control
 *  (`connections-readiness-controls.ts`) already surfaces the post-install
 *  "not set up" + Connect CTA. So the Install button is NEVER gated on this
 *  section.
 *
 *  Reuse presentation (spec §6 — collapse + Customize): when the pack's
 *  endpoint (`api_base`) matches ≥1 existing connection (`findEndpointCandidates`,
 *  step 2a), the host pre-selects the first candidate and this renders a
 *  COLLAPSED one-liner ("Will connect: <account>") with a "Use a different
 *  account" expander → a radio list of candidates + a "Don't connect now" option
 *  + a deep-link to enroll a NEW account. With NO candidate it renders just the
 *  enroll deep-link + "install now, connect later" hint.
 *
 *  "Connect a new account" is a DEEP-LINK to the existing BYO enroll form
 *  (`#connections/others/enroll/<vendor>`), identical to the readiness control's
 *  CTA — it navigates away (v1; inline enroll is a later improvement). Because
 *  connect is optional, navigating away never strands an install.
 */

import { serializeShellRoute } from '../shell/route.js';
import type { ConnectionRequirement, EndpointCandidate } from '@recued/contracts';

/** The section wrapper — carries no value (presence marks the Connect section). */
export const INSTALL_CONNECT_ATTR = 'data-recued-install-connect';
/** One reuse-candidate radio. `data-connection` = the connection's name. */
export const INSTALL_CONNECT_CANDIDATE_ATTR = 'data-recued-install-connect-candidate';
/** The "Don't connect now" radio (chosen = undefined). */
export const INSTALL_CONNECT_NONE_ATTR = 'data-recued-install-connect-none';
/** The "Use a different account" expander toggle (collapsed → expanded). */
export const INSTALL_CONNECT_CUSTOMIZE_ATTR = 'data-recued-install-connect-customize';
/** The deep-link to the BYO enroll form for this vendor. */
export const INSTALL_CONNECT_ENROLL_ATTR = 'data-recued-install-connect-enroll';

const COPY = {
  heading: (vendor: string): string => `Connect your ${vendor} account`,
  empty: (vendor: string): string => `No ${vendor} account is connected yet.`,
  enroll_empty: (vendor: string): string => `Connect ${vendor}`,
  enroll_more: 'Connect a new account',
  hint: 'You can install now and connect it later.',
  summary_prefix: 'Will connect: ',
  none_label: 'Not now — install only',
  customize: 'Use a different account',
  none_option: "Don't connect now (install only)",
  arrow: ' →',
};

/** The connection to pre-select when the dialog opens: the first endpoint
 *  candidate (`findEndpointCandidates` returns them name-sorted), or undefined
 *  when none exist (nothing to reuse → the owner enrolls, or installs
 *  unconnected). Pure — the host calls it once on open to seed its pick. */
export const defaultChosenConnection = (
  candidates: readonly EndpointCandidate[],
): string | undefined => (candidates.length > 0 ? candidates[0].name : undefined);

/** Resolve the connection the install will bind — the value BOTH the render (the
 *  picker's `chosen`) and submit (the rpc's `chosen_connection`) must read, so they
 *  can never disagree. `explicit` is the owner's picker interaction: `touched` when
 *  they used the picker, `pick` their choice (a name, or `undefined` = "don't
 *  connect now").
 *
 *  An explicit choice is honored ONLY while it's still valid: `undefined`
 *  (don't-connect) is always valid; a NAMED pick is valid only while it's still a
 *  candidate. If the async candidate list dropped it after the pick (the connection
 *  was deleted, or the list refreshed), fall back to the pre-selected default — so
 *  the render never shows an unchecked list while submit binds a vanished
 *  connection. Untouched → the default. */
export const resolveChosenConnection = (
  explicit: { touched: boolean; pick: string | undefined },
  candidates: readonly EndpointCandidate[],
): string | undefined => {
  if (
    explicit.touched &&
    (explicit.pick === undefined || candidates.some((c) => c.name === explicit.pick))
  ) {
    return explicit.pick;
  }
  return defaultChosenConnection(candidates);
};

export interface RenderInstallConnectPickerOptions {
  /** DOM document seam (mirrors the dialog's). */
  document: Document;
  /** The (single, v1) connection this pack needs. */
  requirement: ConnectionRequirement;
  /** Existing endpoint-match candidates (empty ⇒ enroll-only). */
  candidates: readonly EndpointCandidate[];
  /** The currently-picked connection name, or undefined = "don't connect now". */
  chosen: string | undefined;
  /** Whether the "Use a different account" expander is open. */
  expanded: boolean;
  /** Disable interaction while an install rpc is in flight. */
  disabled: boolean;
  /** Pick a candidate by name, or undefined to install without connecting. */
  onPick: (name: string | undefined) => void;
  /** Toggle the collapsed/expanded reuse list. */
  onToggleExpanded: () => void;
}

/** Build the Connect-account section. Pure DOM construction over the props; all
 *  state lives on the host, reached via `onPick` / `onToggleExpanded`. The enroll
 *  affordance is a plain `<a>` (navigation, no callback). */
export const renderInstallConnectPicker = (
  opts: RenderInstallConnectPickerOptions,
): HTMLElement => {
  const { document: doc, requirement, candidates, chosen, expanded, disabled } = opts;
  const vendor = requirement.vendor;
  const enrollHref = serializeShellRoute('connections', 'others', 'enroll', vendor);

  const section = doc.createElement('section');
  section.setAttribute(INSTALL_CONNECT_ATTR, '');
  section.className = 'packs-dialog-connect';

  const heading = doc.createElement('p');
  heading.className = 'packs-dialog-summary packs-dialog-connect-heading';
  heading.textContent = COPY.heading(vendor);
  section.appendChild(heading);

  // Build the enroll deep-link once — reused by both the empty + expanded paths.
  const enrollLink = (label: string): HTMLAnchorElement => {
    const a = doc.createElement('a');
    a.className = 'packs-dialog-connect-enroll rx-link';
    a.setAttribute(INSTALL_CONNECT_ENROLL_ATTR, '');
    a.setAttribute('href', enrollHref);
    a.textContent = `${label}${COPY.arrow}`;
    // While an install is in flight, discourage navigating away mid-rpc.
    if (disabled) a.setAttribute('aria-disabled', 'true');
    return a;
  };

  if (candidates.length === 0) {
    // No reusable connection — enroll, or install now and connect later.
    const empty = doc.createElement('p');
    empty.className = 'packs-dialog-connect-empty';
    empty.textContent = COPY.empty(vendor);
    section.appendChild(empty);
    section.appendChild(enrollLink(COPY.enroll_empty(vendor)));
    const hint = doc.createElement('p');
    hint.className = 'packs-dialog-connect-hint';
    hint.textContent = COPY.hint;
    section.appendChild(hint);
    return section;
  }

  if (!expanded) {
    // Collapsed — the pre-selected pick, one line, with a Customize expander.
    const chosenCandidate = candidates.find((c) => c.name === chosen);
    const summary = doc.createElement('p');
    summary.className = 'packs-dialog-connect-summary';
    summary.textContent =
      COPY.summary_prefix + (chosenCandidate ? chosenCandidate.display_name : COPY.none_label);
    section.appendChild(summary);

    const customize = doc.createElement('button');
    customize.type = 'button';
    customize.className = 'packs-dialog-connect-customize rx-link';
    customize.setAttribute(INSTALL_CONNECT_CUSTOMIZE_ATTR, '');
    customize.textContent = COPY.customize;
    if (disabled) customize.disabled = true;
    else customize.addEventListener('click', () => opts.onToggleExpanded());
    section.appendChild(customize);
    return section;
  }

  // Expanded — radio list of candidates + a "don't connect" option + enroll.
  // A shared radio group name makes the options mutually exclusive.
  const groupName = 'packs-dialog-connect-choice';
  const list = doc.createElement('ul');
  list.className = 'packs-dialog-connect-list';

  const radioRow = (
    attr: string,
    connectionName: string | undefined,
    label: string,
    isChosen: boolean,
  ): HTMLElement => {
    const li = doc.createElement('li');
    li.className = 'packs-dialog-connect-row';
    const lbl = doc.createElement('label');
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = groupName;
    radio.setAttribute(attr, connectionName ?? '');
    radio.checked = isChosen;
    if (disabled) radio.disabled = true;
    else radio.addEventListener('change', () => opts.onPick(connectionName));
    const text = doc.createElement('span');
    text.className = 'packs-dialog-connect-option-label';
    text.textContent = label;
    lbl.appendChild(radio);
    lbl.appendChild(text);
    li.appendChild(lbl);
    return li;
  };

  for (const c of candidates) {
    list.appendChild(
      radioRow(INSTALL_CONNECT_CANDIDATE_ATTR, c.name, c.display_name, c.name === chosen),
    );
  }
  list.appendChild(
    radioRow(INSTALL_CONNECT_NONE_ATTR, undefined, COPY.none_option, chosen === undefined),
  );
  section.appendChild(list);
  section.appendChild(enrollLink(COPY.enroll_more));
  return section;
};

/** Self-scoped presentation for the optional account-binding step. The pack
 *  route joins this beside the Access × Scope picker styles. */
export const INSTALL_CONNECT_PICKER_STYLES = `
[data-recued-install-connect] {
  display: grid;
  gap: 10px;
  margin: 16px 0 4px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
[data-recued-install-connect] .packs-dialog-connect-heading {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
}
[data-recued-install-connect] .packs-dialog-connect-empty,
[data-recued-install-connect] .packs-dialog-connect-hint,
[data-recued-install-connect] .packs-dialog-connect-summary {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg-muted);
}
[data-recued-install-connect] .packs-dialog-connect-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid var(--accent);
  border-radius: 9px;
  background: var(--accent-weak);
  color: var(--fg);
  font-weight: 650;
}
[data-recued-install-connect] .packs-dialog-connect-summary::before {
  content: "✓";
  color: var(--accent);
  font-weight: 750;
}
[data-recued-install-connect] .packs-dialog-connect-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-recued-install-connect] .packs-dialog-connect-row label {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 9px;
  align-items: center;
  min-height: 42px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
[data-recued-install-connect] .packs-dialog-connect-row label:hover {
  border-color: var(--border-strong);
}
[data-recued-install-connect] .packs-dialog-connect-row label:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 3px 0 0 var(--accent);
}
[data-recued-install-connect] input[type="radio"] {
  width: 17px;
  height: 17px;
  margin: 0;
  accent-color: var(--accent);
}
[data-recued-install-connect] .packs-dialog-connect-option-label {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
[data-recued-install-connect] .packs-dialog-connect-customize,
[data-recued-install-connect] .packs-dialog-connect-enroll {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 6px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
}
[data-recued-install-connect] .packs-dialog-connect-customize:hover,
[data-recued-install-connect] .packs-dialog-connect-enroll:hover {
  background: var(--accent-weak);
}
[data-recued-install-connect] :is(
  .packs-dialog-connect-customize,
  .packs-dialog-connect-enroll,
  input
):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 560px) {
  [data-recued-install-connect] { padding: 13px; }
}
`;
