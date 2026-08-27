/** Shared reference + provenance presentation.
 *
 * References answer "which exact object can I inspect?"; provenance answers
 * "where did this assertion come from?". They often sit beside each other but
 * are not interchangeable, so this module gives them separate primitives and
 * one visual grammar:
 *
 * - exact references remain copyable and may be links or delegated actions;
 * - provenance preserves a calm primary source plus an optional derived detail;
 * - recorded-reference disclosures never imply sentence-level citations;
 * - every interpolated value and attribute is escaped here, once.
 *
 * Pure string renderers cover template-based surfaces. The disclosure builder
 * covers DOM-owned surfaces such as Chat while retaining focus/event ownership
 * in the host through callbacks.
 */

import type { ProvenanceAttribution } from '@recued/contracts';
import { e } from './template.js';

export const REFERENCE_ATTR = 'data-recued-reference';
export const REFERENCE_ID_ATTR = 'data-recued-reference-id';
export const REFERENCE_DISCLOSURE_ATTR = 'data-recued-reference-disclosure';
export const REFERENCE_DISCLOSURE_TOGGLE_ATTR =
  'data-recued-reference-disclosure-toggle';
export const REFERENCE_ITEM_ATTR = 'data-recued-reference-item';
export const REFERENCE_OPEN_ATTR = 'data-recued-reference-open';
export const PROVENANCE_ATTR = 'data-recued-provenance';
export const PROVENANCE_PRIMARY_ATTR = 'data-recued-provenance-primary';
export const PROVENANCE_DETAIL_ATTR = 'data-recued-provenance-detail';

export type SharedHtmlAttributes = Readonly<Record<
  string,
  string | number | boolean | null | undefined
>>;

const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9:._-]*$/u;
const INERT_ATTRIBUTE_NAME = /^(?:aria-[a-z0-9._:-]+|data-[a-z0-9._:-]+|dir|id|lang|role|tabindex|title)$/iu;

const isInertAttributeName = (name: string): boolean =>
  ATTRIBUTE_NAME.test(name)
  && INERT_ATTRIBUTE_NAME.test(name)
  && !/^on/iu.test(name);

const isDelegatedActionAttributeName = (name: string): boolean =>
  /^data-/iu.test(name)
  && isInertAttributeName(name)
  && !/^data-recued-(?:reference|provenance)(?:-|$)/iu.test(name);

/** Attribute maps are intentionally limited to inert identity/accessibility
 * attributes. Event handlers belong in host code, never in rendered strings. */
const renderAttributes = (attributes: SharedHtmlAttributes | undefined): string => {
  if (attributes === undefined) return '';
  const rendered: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (
      !isInertAttributeName(name)
      || value === false
      || value === null
      || value === undefined
    ) continue;
    rendered.push(value === true ? name : `${name}="${e(String(value))}"`);
  }
  return rendered.length === 0 ? '' : ` ${rendered.join(' ')}`;
};

const classAttribute = (...values: Array<string | undefined>): string => {
  const value = values.filter((candidate): candidate is string =>
    candidate !== undefined && candidate.trim().length > 0).join(' ');
  return value.length === 0 ? '' : ` class="${e(value)}"`;
};

/** Reject active-content URL schemes. Hosts normally pass local hash routes,
 * but this keeps an untrusted reference from becoming a javascript: link. */
const safeHref = (href: string | undefined): string | undefined => {
  if (href === undefined) return undefined;
  const trimmed = href.trim();
  // Browsers discard ASCII whitespace/control characters while recognizing a
  // URL scheme. Check the same normalized prefix so `java\tscript:` cannot
  // bypass the active-content rejection below.
  const schemeProbe = trimmed.replace(/[\u0000-\u0020\u007f-\u009f]/gu, '');
  if (
    trimmed.length === 0
    || /^(?:javascript|data|vbscript):/iu.test(schemeProbe)
  ) {
    return undefined;
  }
  return trimmed;
};

export interface ReferenceAction {
  /** Delegated action attribute, e.g. `data-action`. */
  readonly attribute: string;
  readonly value: string;
}

export interface ReferenceLinkProps {
  readonly label: string;
  /** Exact underlying identifier. Stamped independently of the display label
   * so a truncated/human label never replaces the copyable identity. */
  readonly referenceId?: string;
  readonly href?: string;
  readonly action?: ReferenceAction;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly className?: string;
  readonly attributes?: SharedHtmlAttributes;
  /** Static references default to `<code>`; use `span` for prose labels. */
  readonly staticElement?: 'code' | 'span';
}

const referenceAttributes = (props: ReferenceLinkProps): SharedHtmlAttributes => ({
  ...props.attributes,
  [REFERENCE_ATTR]: props.href !== undefined
    ? 'link'
    : props.action !== undefined
      ? 'action'
      : 'identity',
  ...(props.referenceId === undefined ? {} : { [REFERENCE_ID_ATTR]: props.referenceId }),
  ...(props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel }),
  ...(props.title === undefined ? {} : { title: props.title }),
  ...(props.disabled === true ? { 'aria-disabled': 'true' } : {}),
});

/** One exact reference as a safe HTML string. `href` wins over an action;
 * callers should supply only one. A rejected href degrades to static identity
 * rather than emitting an active-content link. */
export const renderReferenceLink = (props: ReferenceLinkProps): string => {
  const href = safeHref(props.href);
  const action = props.href === undefined
    && props.action !== undefined
    && isDelegatedActionAttributeName(props.action.attribute)
    ? props.action
    : undefined;
  const attrs = referenceAttributes({
    ...props,
    ...(href === undefined ? { href: undefined } : { href }),
    ...(action === undefined ? { action: undefined } : { action }),
  });
  if (href !== undefined) {
    return `<a${classAttribute('recued-reference', props.className)} href="${e(href)}"${renderAttributes(attrs)}>${e(props.label)}</a>`;
  }
  if (
    action !== undefined
  ) {
    return `<button type="button"${classAttribute('recued-reference', props.className)}${renderAttributes({
      ...attrs,
      [action.attribute]: action.value,
    })}>${e(props.label)}</button>`;
  }
  const tag = props.staticElement ?? 'code';
  return `<${tag}${classAttribute('recued-reference', props.className)}${renderAttributes(attrs)}>${e(props.label)}</${tag}>`;
};

/** DOM twin of `renderReferenceLink`, used by DOM-owned nested surfaces. */
export const createReferenceElement = (
  doc: Document,
  props: ReferenceLinkProps,
): HTMLElement => {
  const href = safeHref(props.href);
  const action = props.href === undefined
    && props.action !== undefined
    && isDelegatedActionAttributeName(props.action.attribute)
    ? props.action
    : undefined;
  const tag = href !== undefined
    ? 'a'
    : action !== undefined
      ? 'button'
      : props.staticElement ?? 'code';
  const element = doc.createElement(tag);
  element.className = ['recued-reference', props.className]
    .filter((candidate): candidate is string =>
      candidate !== undefined && candidate.trim().length > 0)
    .join(' ');
  if (tag === 'button') element.setAttribute('type', 'button');
  if (href !== undefined) element.setAttribute('href', href);
  const attrs = referenceAttributes({
    ...props,
    ...(href === undefined ? { href: undefined } : { href }),
    ...(action === undefined ? { action: undefined } : { action }),
  });
  for (const [name, value] of Object.entries(attrs)) {
    if (
      !isInertAttributeName(name)
      || value === false
      || value === null
      || value === undefined
    ) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  if (
    href === undefined
    && action !== undefined
  ) {
    element.setAttribute(action.attribute, action.value);
  }
  element.textContent = props.label;
  return element;
};

export interface ReferenceIdentityProps {
  readonly value: string;
  readonly label?: string;
  readonly className?: string;
  readonly attributes?: SharedHtmlAttributes;
}

/** A labelled, copyable identity for metadata rows and receipts. */
export const renderReferenceIdentity = (props: ReferenceIdentityProps): string =>
  `<span${classAttribute('recued-reference-identity', props.className)}${renderAttributes({
    ...props.attributes,
    [REFERENCE_ATTR]: 'identity',
  })}>${props.label === undefined
    ? ''
    : `<span class="recued-reference-identity-label">${e(props.label)}</span>`}<code${renderAttributes({
      [REFERENCE_ID_ATTR]: props.value,
    })}>${e(props.value)}</code></span>`;

export type ProvenancePresentationKind =
  | 'user'
  | 'system'
  | 'agent'
  | 'visitor'
  | 'source'
  | 'derived'
  | 'neutral';

export interface ProvenancePresentationProps {
  readonly primary: string;
  readonly detail?: string;
  readonly kind?: ProvenancePresentationKind;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly primaryClassName?: string;
  readonly detailClassName?: string;
  readonly href?: string;
  readonly linkClassName?: string;
  readonly attributes?: SharedHtmlAttributes;
  readonly primaryAttributes?: SharedHtmlAttributes;
}

/** Render a source/actor plus optional canonical derived attribution. */
export const renderProvenance = (props: ProvenancePresentationProps): string => {
  const href = safeHref(props.href);
  const primaryAttrs = renderAttributes({
    ...props.primaryAttributes,
    [PROVENANCE_PRIMARY_ATTR]: true,
  });
  const primary = href === undefined
    ? `<span${classAttribute('recued-provenance-primary', props.primaryClassName)}${primaryAttrs}>${e(props.primary)}</span>`
    : `<a${classAttribute('recued-provenance-primary', props.primaryClassName, props.linkClassName)} href="${e(href)}"${primaryAttrs}>${e(props.primary)}</a>`;
  const detail = props.detail === undefined || props.detail.length === 0
    ? ''
    : `<span${classAttribute('recued-provenance-detail', props.detailClassName)} ${PROVENANCE_DETAIL_ATTR}>${e(props.detail)}</span>`;
  return `<span${classAttribute('recued-provenance', props.className)}${renderAttributes({
    ...props.attributes,
    [PROVENANCE_ATTR]: true,
    'data-kind': props.kind ?? 'neutral',
    ...(props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel }),
  })}>${primary}${detail}</span>`;
};

/** Canonical outside-actor projection. First-person rows pass `undefined` and
 * intentionally render nothing. */
export const renderProvenanceAttribution = (
  attribution: ProvenanceAttribution | undefined,
  options: Omit<ProvenancePresentationProps, 'primary' | 'detail' | 'kind'> = {},
): string => attribution === undefined
  ? ''
  : renderProvenance({
      ...options,
      primary: attribution.label,
      kind: attribution.kind,
    });

export interface ReferenceDisclosureItem {
  readonly label: string;
  readonly sourceLabel: string;
  readonly referenceId: string | null;
  readonly referenceIdLabel?: string;
  readonly missingReferenceLabel?: string;
  readonly href?: string;
  readonly openLabel?: string;
  readonly openAriaLabel?: string;
}

export interface ReferenceDisclosureLink {
  readonly href: string;
  readonly label: string;
  readonly ariaLabel?: string;
}

/** Compatibility hooks let an extracted route retain its public/test handles
 * while the component also emits the stable shared handles above. */
export interface ReferenceDisclosureHooks {
  readonly container?: string;
  readonly toggle?: string;
  readonly toggleKey?: { readonly attribute: string; readonly value: string };
  readonly item?: string;
  readonly id?: string;
  readonly open?: string;
}

export interface BuildReferenceDisclosureOptions {
  readonly document: Document;
  readonly items: ReadonlyArray<ReferenceDisclosureItem>;
  readonly expanded: boolean;
  readonly title: string;
  readonly detail: string;
  readonly toggleAriaLabel: string;
  readonly containerAriaLabel: string;
  readonly note?: string;
  readonly browse?: ReferenceDisclosureLink;
  readonly hooks?: ReferenceDisclosureHooks;
  readonly onToggle: () => void;
  readonly onOpen?: () => void;
}

const setHook = (
  element: HTMLElement,
  attribute: string | undefined,
  value = '',
): void => {
  if (attribute !== undefined && isInertAttributeName(attribute)) {
    element.setAttribute(attribute, value);
  }
};

/** Accessible, collapsible exact-reference disclosure. The host owns expanded
 * state and focus restoration; the shared component owns structure/copy-safe
 * identity rendering. */
export const buildReferenceDisclosure = (
  options: BuildReferenceDisclosureOptions,
): HTMLElement => {
  const { document: doc, hooks } = options;
  const container = doc.createElement('section');
  container.setAttribute(REFERENCE_DISCLOSURE_ATTR, '');
  setHook(container, hooks?.container);
  container.setAttribute('aria-label', options.containerAriaLabel);

  const toggle = doc.createElement('button');
  toggle.setAttribute('type', 'button');
  toggle.setAttribute(REFERENCE_DISCLOSURE_TOGGLE_ATTR, '');
  setHook(toggle, hooks?.toggle);
  if (hooks?.toggleKey !== undefined) {
    setHook(toggle, hooks.toggleKey.attribute, hooks.toggleKey.value);
  }
  toggle.setAttribute('aria-expanded', options.expanded ? 'true' : 'false');
  toggle.setAttribute('aria-label', options.toggleAriaLabel);

  const toggleCopy = doc.createElement('span');
  toggleCopy.className = 'recued-reference-toggle-copy';
  const toggleTitle = doc.createElement('span');
  toggleTitle.className = 'recued-reference-toggle-title';
  toggleTitle.textContent = options.title;
  toggleCopy.appendChild(toggleTitle);
  const toggleDetail = doc.createElement('span');
  toggleDetail.className = 'recued-reference-toggle-detail';
  toggleDetail.textContent = options.detail;
  toggleCopy.appendChild(toggleDetail);
  toggle.appendChild(toggleCopy);

  const toggleAction = doc.createElement('span');
  toggleAction.className = 'recued-reference-toggle-action';
  toggleAction.textContent = options.expanded ? 'Hide ↑' : 'Review ↓';
  toggle.appendChild(toggleAction);
  toggle.addEventListener('click', options.onToggle);
  container.appendChild(toggle);
  if (!options.expanded) return container;

  const body = doc.createElement('div');
  body.className = 'recued-reference-disclosure-body';
  if (options.note !== undefined && options.note.length > 0) {
    const note = doc.createElement('p');
    note.className = 'recued-reference-note';
    note.textContent = options.note;
    body.appendChild(note);
  }

  const list = doc.createElement('ol');
  list.className = 'recued-reference-list';
  for (const [index, reference] of options.items.entries()) {
    const item = doc.createElement('li');
    item.setAttribute(REFERENCE_ITEM_ATTR, String(index + 1));
    setHook(item, hooks?.item, String(index + 1));

    const number = doc.createElement('span');
    number.className = 'recued-reference-number';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = String(index + 1);
    item.appendChild(number);

    const copy = doc.createElement('div');
    copy.className = 'recued-reference-copy';
    const label = doc.createElement('strong');
    label.className = 'recued-reference-label';
    label.textContent = reference.label;
    copy.appendChild(label);

    const meta = doc.createElement('div');
    meta.className = 'recued-reference-meta';
    const source = doc.createElement('span');
    source.textContent = reference.sourceLabel;
    meta.appendChild(source);
    const separator = doc.createElement('span');
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '·';
    meta.appendChild(separator);
    if (reference.referenceId === null) {
      const missing = doc.createElement('span');
      missing.textContent = reference.missingReferenceLabel ?? 'Reference ID not recorded';
      meta.appendChild(missing);
    } else {
      const idLabel = doc.createElement('span');
      idLabel.textContent = reference.referenceIdLabel ?? 'Reference ID';
      meta.appendChild(idLabel);
      const referenceId = createReferenceElement(doc, {
        label: reference.referenceId,
        referenceId: reference.referenceId,
      });
      setHook(referenceId, hooks?.id);
      meta.appendChild(referenceId);
    }
    copy.appendChild(meta);

    const href = safeHref(reference.href);
    if (href !== undefined) {
      const open = createReferenceElement(doc, {
        label: reference.openLabel ?? 'Open reference',
        href,
        ...(reference.openAriaLabel === undefined
          ? {}
          : { ariaLabel: reference.openAriaLabel }),
        className: 'recued-reference-open',
      });
      open.setAttribute(REFERENCE_OPEN_ATTR, '');
      setHook(open, hooks?.open);
      if (options.onOpen !== undefined) open.addEventListener('click', options.onOpen);
      copy.appendChild(open);
    }
    item.appendChild(copy);
    list.appendChild(item);
  }
  body.appendChild(list);

  const browseHref = safeHref(options.browse?.href);
  if (options.browse !== undefined && browseHref !== undefined) {
    const browse = createReferenceElement(doc, {
      label: options.browse.label,
      href: browseHref,
      ...(options.browse.ariaLabel === undefined
        ? {}
        : { ariaLabel: options.browse.ariaLabel }),
      className: 'recued-reference-browse',
    });
    if (options.onOpen !== undefined) browse.addEventListener('click', options.onOpen);
    body.appendChild(browse);
  }
  container.appendChild(body);
  return container;
};

export const REFERENCE_PROVENANCE_STYLES = `
[${PROVENANCE_ATTR}] {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 7px;
  max-width: 100%;
  min-width: 0;
  color: var(--fg-muted, var(--muted));
  font-size: 11px;
  line-height: 1.4;
}
[${PROVENANCE_PRIMARY_ATTR}] {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  padding: 1px 6px;
  border: 1px solid var(--border, currentColor);
  border-radius: 999px;
  background: var(--surface-sunk, var(--surface-subtle));
  color: var(--fg-muted, var(--muted));
  font-weight: 650;
  text-decoration: none;
  overflow-wrap: anywhere;
}
[${PROVENANCE_ATTR}][data-kind="user"] [${PROVENANCE_PRIMARY_ATTR}],
[${PROVENANCE_ATTR}][data-kind="source"] [${PROVENANCE_PRIMARY_ATTR}] {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
  background: var(--accent-weak, var(--surface-sunk));
  color: var(--accent);
}
[${PROVENANCE_ATTR}][data-kind="agent"] [${PROVENANCE_PRIMARY_ATTR}] {
  border-color: color-mix(in srgb, #92400e 30%, var(--border));
  background: #fef3c7;
  color: #92400e;
}
[${PROVENANCE_ATTR}][data-kind="visitor"] [${PROVENANCE_PRIMARY_ATTR}] {
  border-color: color-mix(in srgb, var(--danger) 24%, var(--border));
  background: var(--danger-weak, var(--surface-sunk));
  color: var(--danger);
}
[${PROVENANCE_DETAIL_ATTR}] {
  min-width: 0;
  color: var(--fg-muted, var(--muted));
  overflow-wrap: anywhere;
}
[${REFERENCE_ATTR}] {
  max-width: 100%;
  min-width: 0;
  color: var(--accent);
  overflow-wrap: anywhere;
}
button[${REFERENCE_ATTR}] {
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  text-decoration: underline;
  cursor: pointer;
}
a[${REFERENCE_ATTR}] {
  text-decoration: underline;
}
[${REFERENCE_ATTR}][aria-disabled="true"] {
  opacity: 0.55;
  cursor: default;
}
code[${REFERENCE_ATTR}],
[${REFERENCE_ATTR}][${REFERENCE_ID_ATTR}],
[${REFERENCE_ID_ATTR}] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.recued-reference-identity {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
}
.recued-reference-identity-label {
  color: var(--fg-muted, var(--muted));
}
.recued-reference-identity [${REFERENCE_ID_ATTR}] {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface-sunk, var(--surface-subtle));
  color: var(--fg, inherit);
  overflow-wrap: anywhere;
  user-select: all;
}
[${REFERENCE_DISCLOSURE_ATTR}] {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
[${REFERENCE_DISCLOSURE_TOGGLE_ATTR}] {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[${REFERENCE_DISCLOSURE_TOGGLE_ATTR}]:hover,
[${REFERENCE_DISCLOSURE_TOGGLE_ATTR}]:focus-visible {
  background: var(--surface-subtle, var(--surface-sunk));
}
.recued-reference-toggle-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.recued-reference-toggle-title {
  font-size: 12px;
  font-weight: 700;
}
.recued-reference-toggle-detail {
  color: var(--muted, var(--fg-muted));
  font-size: 11px;
  line-height: 1.35;
}
.recued-reference-toggle-action {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 11px;
  font-weight: 680;
}
.recued-reference-disclosure-body {
  display: grid;
  gap: 9px;
  padding: 10px;
  border-top: 1px solid var(--border-subtle, var(--border));
}
.recued-reference-note {
  margin: 0;
  color: var(--muted, var(--fg-muted));
  font-size: 11px;
  line-height: 1.45;
}
.recued-reference-list {
  max-height: 260px;
  overflow: auto;
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${REFERENCE_ITEM_ATTR}] {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 8px;
  border: 1px solid var(--border-subtle, var(--border));
  border-radius: 7px;
  background: var(--surface-subtle, var(--surface-sunk));
}
.recued-reference-number {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--accent);
  font-size: 11px;
  font-weight: 720;
}
.recued-reference-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.recued-reference-label {
  color: var(--fg);
  font-size: 12px;
  font-weight: 680;
  overflow-wrap: anywhere;
}
.recued-reference-meta {
  display: flex;
  align-items: baseline;
  gap: 5px;
  flex-wrap: wrap;
  color: var(--muted, var(--fg-muted));
  font-size: 11px;
  line-height: 1.4;
}
.recued-reference-meta [${REFERENCE_ID_ATTR}] {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface);
  color: var(--fg);
  font-size: 10px;
  overflow-wrap: anywhere;
  user-select: all;
}
.recued-reference-open,
.recued-reference-browse {
  justify-self: start;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 680;
  text-decoration: none;
}
.recued-reference-open {
  margin-top: 3px;
  padding: 4px 7px;
}
.recued-reference-browse {
  padding: 5px 9px;
  border: 1px solid var(--border);
}
.recued-reference-open:hover,
.recued-reference-open:focus-visible,
.recued-reference-browse:hover,
.recued-reference-browse:focus-visible {
  background: var(--accent-weak);
}
.recued-reference-browse:hover,
.recued-reference-browse:focus-visible {
  border-color: var(--accent);
}
`;
