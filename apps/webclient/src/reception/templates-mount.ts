/** D-149 § A.10 follow-on — Reception → Intake forms →
 *  Templates browser MODAL mount.
 *
 *  `templates.ts` is the projection layer
 *  (`buildIntakeFormTemplatesBrowserModel` → `IntakeFormTemplatesBrowserModel`,
 *  a list of `IntakeFormTemplateCardModel`); `page-render.ts`
 *  already renders an INLINE templates panel inside the spine list view.
 *  **This is the standalone gallery the daily-use "+ New" entry point
 *  opens** — a self-contained satellite mount (the
 *  `view-as-visitor.ts` / `authoring-mount.ts` shape)
 *  the host lands in its `modalHost` when the desktop "+ New" link / mobile
 *  FAB fires `reception-open-templates`.
 *
 *  ── One export ────────────────────────────────────────────────────
 *    - **`mountTemplatesBrowser(opts)`** — seeds the browser model from
 *      the supplied raw templates, renders a card-per-template gallery
 *      into a host element, installs a delegated `data-action` dispatcher
 *      ("Use template" per card + a close control), and on a "Use
 *      template" click hands the card's `template_ref` to
 *      `onUseTemplate` then closes. Returns a `dispose()` handle (the
 *      `mountAuthoringForm` handle shape).
 *
 *  ── Projection only, like every Reception satellite ───────────────
 *  The mount owns NO rpc + NO seed conversion: `onLoadTemplates` refreshes
 *  the route cache and returns the gallery data; `onUseTemplate(ref)` hands
 *  the closed-list ref back to the host, which resolves the seed
 *  (`resolveTemplateSeed`) + opens the authoring form. The mount never
 *  touches `@recued/contracts` template conversion — it renders the
 *  projected card model + dispatches the ref, exactly as
 *  `view-as-visitor.ts` renders + dispatches without owning the
 *  preview rpc.
 *
 *  ── a11y ──────────────────────────────────────────────────────────
 *  The modal heading carries `tabindex="-1"` + is focused on open (the
 *  same focus-the-heading-on-open convention the satellites follow); the
 *  Use / close controls are native `<button>`s. The named dialog traps Tab;
 *  Escape or Close returns focus to the visible New control.
 *
 *  Spec: D-149 § A.10 (Pre-built intake_form templates). */

import {
  isReceptionEndpointKind,
  type IntakeFormTemplate,
  type ReceptionConfigTemplate,
  // D-220 Slice B — pack-shipped intake templates, listed beside the Foundation set.
  type PackReceptionTemplateListing,
  type PackReceptionTemplateUnavailable,
  type ReceptionConfigTemplateKind,
  type ReceptionEndpointKind,
  type ReceptionTemplateListResult,
} from '@recued/contracts';

import { e } from '@recued/ui-shared/template';
import {
  badge,
  button,
  emptyHint,
  inlineHint,
  panel,
} from '@recued/ui-shared/primitives';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';
import { wireFocusTrap } from '@recued/ui-shared/focus-trap';
import { trackCustomerWorkspaceFocus } from './customer-workspace-focus.js';

import {
  buildIntakeFormTemplatesBrowserModel,
  buildPackIntakeFormTemplatesBrowserModel,
  type IntakeFormTemplateCardModel,
  type PackIntakeFormTemplateCardModel,
} from './templates.js';
import {
  RECEPTION_CONFIG_TEMPLATE_KIND_COPY,
  buildReceptionConfigTemplatesBrowserModel,
  type ReceptionConfigTemplateCardModel,
} from './config-templates.js';

// ════════════════════════════════════════════════════════════════
// Action surface
// ════════════════════════════════════════════════════════════════

/** Every `data-action` the templates-browser mount emits. The
 *  dispatcher is typed against this union (tsc enforces a handler per
 *  action). */
export const TEMPLATES_BROWSER_ACTIONS = [
  'reception-template-use',
  'reception-template-close',
  // D-151 P2 — intent-first "Draft it with AI" submit.
  'reception-template-propose',
  'reception-template-reload',
  'reception-template-review',
] as const;

export type TemplatesBrowserAction = (typeof TEMPLATES_BROWSER_ACTIONS)[number];

/** Attribute marker on the modal heading — focused on open + a test hook
 *  to locate the gallery without scraping copy. */
export const TEMPLATES_BROWSER_HEADING_ATTR = 'data-recued-templates-heading';

/** D-151 P2 — marker on the intent free-text input (the handler reads its
 *  value off the host). */
export const TEMPLATES_BROWSER_INTENT_INPUT_ATTR = 'data-recued-intent-input';

/** D-151 P2 — marker on the aria-live status line (Drafting… / suggestion
 *  note / friendly error). */
export const TEMPLATES_BROWSER_INTENT_STATUS_ATTR = 'data-recued-intent-status';

// ════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════

/** `data-*` attribute string from a flat record — keys emitted verbatim
 *  as `data-<key>` (callers pass already-kebab keys), values escaped.
 *  Mirrors `page-render.ts`. */
const dataAttrs = (data: Readonly<Record<string, string | undefined>>): string =>
  Object.entries(data)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `data-${k}="${e(v)}"`)
    .join(' ');

/** One template gallery card — the projection of one
 *  `IntakeFormTemplateCardModel`. Mirrors the inline-panel card in
 *  `page-render.ts` (`renderTemplateCard`), widened with the
 *  suggested-SI / anti-spam one-liners + a primary "Use template" CTA. */
const renderTemplateCard = (card: IntakeFormTemplateCardModel): string => {
  const fieldLine =
    card.collected.field_labels.length > 0
      ? card.collected.field_labels.map((f) => e(f.label)).join(', ')
      : 'nothing for visitors to fill in';
  return `
    <div class="reception-template-card" ${dataAttrs({ 'template-ref': card.template_ref })}>
      <div class="reception-template-card-head">
        <span class="reception-template-name">${e(card.name)}</span>
        ${badge({ label: card.target_kind_label, tone: 'accent' })}
      </div>
      <p class="reception-template-desc">${e(card.description)}</p>
      <p class="reception-row-meta">
        Collects: ${fieldLine}
        · ${card.collected.required_field_count} required
        · email ${e(card.collects_email_label.toLowerCase())}
      </p>
      <p class="reception-row-meta">Anti-spam: ${e(card.anti_spam.summary_label)}</p>
      ${button({
        label: 'Use template',
        size: 'sm',
        variant: 'primary',
        action: 'reception-template-use',
        data: { 'template-ref': card.template_ref, kind: 'intake_form' },
        title: `Use the ${card.name} template`,
      })}
    </div>
  `;
};

/** One config-template gallery card (`scheduling_link` / `reception_page` /
 *  `drop_link` / `approval_link`). Slimmer than the intake card — name +
 *  kind badge + a one-line summary of what the starting config sets up. The
 *  "Use template" button carries the card's `kind` so the host opens the
 *  right per-kind authoring form. */
const renderConfigTemplateCard = (card: ReceptionConfigTemplateCardModel): string => `
    <div class="reception-template-card" ${dataAttrs({ 'template-ref': card.template_ref })}>
      <div class="reception-template-card-head">
        <span class="reception-template-name">${e(card.name)}</span>
        ${badge({ label: card.kind_label, tone: 'accent' })}
      </div>
      <p class="reception-template-desc">${e(card.description)}</p>
      <p class="reception-row-meta">${e(card.summary_label)}</p>
      ${button({
        label: 'Use template',
        size: 'sm',
        variant: 'primary',
        action: 'reception-template-use',
        data: { 'template-ref': card.template_ref, kind: card.kind },
        title: `Use the ${card.name} template`,
      })}
    </div>
  `;

/** D-220 Slice B — one PACK template card. The intake card plus a provenance
 *  line ("From <pack> (v<n>)") and a `data-pack-slug` marker. The "Use
 *  template" button carries the `pack:` ref under the same action + kind as
 *  a Foundation card, so the host's seed resolver is the one place that
 *  knows which cache a ref lives in. Every string here is third-party pack
 *  content and is escaped on the way into markup. */
const renderPackTemplateCard = (card: PackIntakeFormTemplateCardModel): string => {
  const fieldLine =
    card.collected.field_labels.length > 0
      ? card.collected.field_labels.map((f) => e(f.label)).join(', ')
      : 'nothing for visitors to fill in';
  return `
    <div class="reception-template-card" ${dataAttrs({ 'template-ref': card.template_ref, 'pack-slug': card.pack_slug })}>
      <div class="reception-template-card-head">
        <span class="reception-template-name">${e(card.name)}</span>
        ${badge({ label: card.target_kind_label, tone: 'accent' })}
      </div>
      <p class="reception-template-desc">${e(card.description)}</p>
      <p class="reception-row-meta">${e(card.provenance_label)}</p>
      <p class="reception-row-meta">
        Collects: ${fieldLine}
        · ${card.collected.required_field_count} required
        · email ${e(card.collects_email_label.toLowerCase())}
      </p>
      <p class="reception-row-meta">Anti-spam: ${e(card.anti_spam.summary_label)}</p>
      ${button({
        label: 'Use template',
        size: 'sm',
        variant: 'primary',
        action: 'reception-template-use',
        data: { 'template-ref': card.template_ref, kind: 'intake_form' },
        title: `Use the ${card.name} template`,
      })}
    </div>
  `;
};

/** D-151 P2 — the intent-first "Describe it" section rendered ABOVE the
 *  template cards (the intent-first sibling of the gallery). Rendered only
 *  when `onProposeIntent` is wired; absent ⇒ this returns '' so the AI
 *  entry stays hidden on servers without a propose path. The status line
 *  is `aria-live="polite"` so a screen reader announces Drafting… / the
 *  suggestion note / the friendly error. The input is labelled + submits
 *  on Enter (a native form sharing the delegated dispatcher). No raw
 *  prompts / confidence are ever shown
 *  (I-19) — only the redacted `reason`. */
const renderIntentSection = (): string => `
  <form class="reception-intent" data-action="reception-template-propose">
    <label class="reception-intent-label" for="reception-intent-text">
      Describe what you need — Recued drafts the endpoint for you
    </label>
    <div class="reception-intent-row">
      <input
        id="reception-intent-text"
        type="text"
        class="reception-intent-input"
        ${TEMPLATES_BROWSER_INTENT_INPUT_ATTR}
        placeholder="e.g. a form to collect speaker bios for my conference"
        autocomplete="off"
      />
      ${button({
        id: 'reception-intent-submit',
        label: 'Let AI write it',
        size: 'sm',
        variant: 'primary',
        action: 'reception-template-propose',
        data: {},
        title: 'Write me one from what I said',
      })}
    </div>
    <p
      class="reception-intent-status"
      ${TEMPLATES_BROWSER_INTENT_STATUS_ATTR}
      aria-live="polite"
    ></p>
  </form>
`;

/** Render one titled section (kind group) with its card grid. Omitted
 *  entirely (returns '') when the section has no cards — the gallery only
 *  shows the kinds whose templates actually loaded. */
const renderSection = (title: string, help: string, cardsHtml: string): string =>
  cardsHtml.length === 0
    ? ''
    : `
    <section class="reception-templates-browser-section">
      <h4 class="reception-templates-browser-section-title">${e(title)}</h4>
      <p class="reception-templates-browser-section-help">${e(help)}</p>
      <div class="reception-templates-browser-grid">${cardsHtml}</div>
    </section>
  `;

/** Render the whole templates-browser modal from the raw templates. Pure
 *  — no I/O, no host reference. `intentEnabled` gates the Describe-it
 *  section (the intent-first sibling) — false hides it entirely. The
 *  gallery groups cards by kind: intake forms, then each config-template
 *  kind (scheduling links, contact pages). */
const renderTemplatesBrowser = (
  templates: ReadonlyArray<IntakeFormTemplate>,
  configTemplates: ReadonlyArray<ReceptionConfigTemplate>,
  intentEnabled: boolean,
  packTemplates: ReadonlyArray<PackReceptionTemplateListing> = [],
  packTemplatesUnavailable: ReadonlyArray<PackReceptionTemplateUnavailable> = [],
  read: { loading: boolean; error: boolean; reloadable: boolean } = { loading: false, error: false, reloadable: false },
): string => {
  const intakeModel = buildIntakeFormTemplatesBrowserModel({ templates });
  const configModel = buildReceptionConfigTemplatesBrowserModel({ templates: configTemplates });
  // D-220 Slice B — templates INSTALLED PACKS shipped. Their own section,
  // never merged into the Foundation cards: different provenance, different
  // trust, and the card says which pack it came from.
  const packModel = buildPackIntakeFormTemplatesBrowserModel({
    listings: packTemplates,
    unavailable: packTemplatesUnavailable,
  });

  // Cards grouped by kind, in canonical order: intake, then each config
  // kind. A config card carries its own `kind`; group on it.
  const configByKind = (kind: ReceptionConfigTemplateKind): string =>
    configModel.cards
      .filter((c) => c.kind === kind)
      .map(renderConfigTemplateCard)
      .join('');

  const sections = [
    renderSection(
      'Intake forms',
      'Let people send you answers. Each one arrives for you to look at.',
      intakeModel.cards.map(renderTemplateCard).join(''),
    ),
    // D-220 Slice B — rendered only when a pack shipped something; a server
    // with no pack templates shows no empty pack section.
    packModel.is_empty
      ? ''
      : renderSection(
          'From the Packs you have',
          'Forms that come with a Pack, made to match what its Recipes read. Look at them and change them before you switch one on. Installing a Pack never switches a form on.',
          packModel.cards.map(renderPackTemplateCard).join(''),
        ),
    renderSection(
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.scheduling_link.label + 's',
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.scheduling_link.help,
      configByKind('scheduling_link'),
    ),
    renderSection(
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.reception_page.label + 's',
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.reception_page.help,
      configByKind('reception_page'),
    ),
    renderSection(
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.drop_link.label + 's',
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.drop_link.help,
      configByKind('drop_link'),
    ),
    renderSection(
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.approval_link.label + 's',
      RECEPTION_CONFIG_TEMPLATE_KIND_COPY.approval_link.help,
      configByKind('approval_link'),
    ),
  ].join('');

  const allEmpty = intakeModel.is_empty && configModel.is_empty && packModel.is_empty;
  const body = read.loading
    ? '<p class="reception-templates-read-status" role="status" aria-label="Loading templates">Loading templates…</p>'
    : read.error
    ? '<p class="reception-templates-read-status" role="alert">Could not load templates. Retry to get the latest starting points.</p>'
    : allEmpty
    ? emptyHint({
        message:
          'No Reception templates are available. Install the Foundation pack or a Pack with intake templates, then refresh.',
      })
    : sections;

  // Honestly surface a partial load — PER substrate, and only when that
  // substrate loaded SOME but not ALL of its closed list. A substrate
  // that loaded NOTHING is silent (its section simply doesn't render) so
  // a pack version that predates the config templates never shows an
  // alarming "0 of 6" note.
  const partialNote = (
    total: number,
    missing: number,
    noun: string,
  ): string =>
    total > 0 && missing > 0
      ? inlineHint(`${total} of ${total + missing} ${noun} loaded.`)
      : '';
  const intakePartial = partialNote(
    intakeModel.total,
    intakeModel.missing_refs.length,
    'Foundation-pack templates',
  );
  const configPartial = partialNote(
    configModel.total,
    configModel.missing_refs.length,
    'Foundation-pack config templates',
  );
  // D-220 Slice B — a stored pack template the server could not admit (a
  // matrix tightened after the install) is SAID, not dropped: the honesty
  // the Foundation `missing_refs` note gives its closed list, for the
  // persisted model. Refs are third-party strings; `inlineHint` escapes the
  // whole message on the way into markup, so the text is handed over raw.
  const packUnavailableNote = packModel.unavailable.length > 0
    ? inlineHint(
        `${packModel.unavailable.length} pack template${packModel.unavailable.length === 1 ? '' : 's'} could not be loaded: `
        + packModel.unavailable.map((u) => `${u.template_ref} (${u.reason})`).join(', ')
        + '.',
      )
    : '';

  return `
    <div class="reception-templates-browser" role="dialog" aria-modal="true" aria-labelledby="reception-templates-title" tabindex="-1">
      <div class="reception-templates-browser-head">
        <h3 id="reception-templates-title" class="reception-templates-browser-title" ${TEMPLATES_BROWSER_HEADING_ATTR} tabindex="-1">
          Reception templates
        </h3>
        ${button({
          label: 'Close',
          size: 'xs',
          action: 'reception-template-close',
          data: {},
          title: 'Close templates',
        })}
      </div>
      <p class="reception-templates-browser-desc">
        Choose a starting point, then review and edit it before creating an endpoint.
      </p>
      ${intentEnabled ? renderIntentSection() : ''}
      ${read.reloadable ? `<div class="reception-templates-toolbar">${button({ label: read.error ? 'Retry templates' : 'Refresh templates', size: 'sm', action: 'reception-template-reload', data: {}, disabled: read.loading })}</div>` : ''}
      ${!read.loading && !read.error ? intakePartial + configPartial + packUnavailableNote : ''}
      ${body}
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Options for `mountTemplatesBrowser`. */
export interface TemplatesBrowserMountOptions {
  /** Host element the gallery renders into — cleared on `dispose()`. */
  host: HTMLElement;
  /** The raw Foundation-pack intake_form templates to project. The host
   *  supplies these from the route's `reception.template.list` cache; an
   *  empty array (with an empty `configTemplates`) renders the empty state
   *  only after an optional `onLoadTemplates` read has succeeded. */
  templates: ReadonlyArray<IntakeFormTemplate>;
  /** D-151 — the raw non-intake config templates (`scheduling_link` +
   *  `reception_page`) from the same `reception.template.list` cache.
   *  Defaults to an empty array (no config-template sections render). */
  configTemplates?: ReadonlyArray<ReceptionConfigTemplate>;
  /** D-220 Slice B — intake templates INSTALLED PACKS shipped, from the same
   *  `reception.template.list` cache (`pack_templates`). Defaults to an empty
   *  array (no pack section renders). */
  packTemplates?: ReadonlyArray<PackReceptionTemplateListing>;
  /** D-220 Slice B — stored pack templates the server could not admit
   *  (`pack_templates_unavailable`); rendered as an inline note. */
  packTemplatesUnavailable?: ReadonlyArray<PackReceptionTemplateUnavailable>;
  /** Explicit gallery reads share the route cache used to resolve selected seeds. */
  onLoadTemplates?: () => Promise<ReceptionTemplateListResult>;
  /** Clock seam — accepted for parity with the sibling mounts (the
   *  templates browser carries no relative timestamps today, so it is
   *  unused). Defaults to `Date.now`. */
  now?: () => number;
  /** Called with a card's closed-list `template_ref` + its reception
   *  `kind` when the user picks "Use template". The host resolves the seed
   *  for that kind + opens the matching authoring form; the mount closes
   *  itself right after (via `onClose`). The kind is `'intake_form'` for
   *  the intake cards and the card's own kind for the config-template
   *  cards. */
  onUseTemplate: (templateRef: string, kind: ReceptionEndpointKind) => void;
  /** D-151 P2 — intent-first authoring seam. When provided, the gallery
   *  renders a "Describe it with AI" section at the top (the intent-first
   *  sibling of the template cards); absent ⇒ that section is hidden. On
   *  submit the mount disables the input and button, shows an inline "Drafting…"
   *  status, and calls this with the free text. On `ok` it shows a one-line
   *  suggestion note then hands `(kind, config)` to `onUseProposed`, unless
   *  a later interaction has taken ownership; that draft waits for review;
   *  on `!ok` it shows the friendly `message` inline + leaves the gallery
   *  usable (the degraded path). */
  onProposeIntent?: (
    intent: string,
  ) => Promise<
    | { ok: true; kind: ReceptionEndpointKind; config: object; reason?: string }
    | { ok: false; message: string }
  >;
  /** D-151 P2 — called with the AI-proposed `(kind, config)` after a
   *  successful propose. The host opens the authoring form seeded with
   *  `config`; the mount closes itself right after (via `onClose`). Only
   *  meaningful when `onProposeIntent` is wired. */
  onUseProposed?: (kind: ReceptionEndpointKind, config: object) => void;
  /** Called when the user closes the gallery (the close control) AND
   *  immediately after a "Use template" pick — the host tears the mount
   *  down. */
  onClose: (reason?: 'selection') => void;
}

/** Mounted templates-browser handle. */
export interface TemplatesBrowserMount {
  /** Detach the dispatcher + clear the host. Idempotent. */
  dispose(): void;
}

/** Mount the standalone templates-browser gallery into a host element.
 *  Renders a card per Foundation-pack template, installs a delegated
 *  `data-action` dispatcher, and focuses the modal heading on open. A
 *  "Use template" click hands the card's `template_ref` to `onUseTemplate`
 *  then closes; the close control calls `onClose`. */
export const mountTemplatesBrowser = (
  opts: TemplatesBrowserMountOptions,
): TemplatesBrowserMount => {
  const { host } = opts;
  const doc = host.ownerDocument;
  const opener = doc?.activeElement as HTMLElement | null;
  const focusOwner = doc ? trackCustomerWorkspaceFocus(doc) : null;
  const intentEnabled = opts.onProposeIntent !== undefined;
  let disposed = false;
  let proposing = false;
  let loading = opts.onLoadTemplates !== undefined;
  let loadError = false;
  let status = '';
  let ready: { kind: ReceptionEndpointKind; config: object } | null = null;
  let catalog: ReceptionTemplateListResult = {
    templates: opts.templates, config_templates: opts.configTemplates ?? [],
    pack_templates: opts.packTemplates ?? [], pack_templates_unavailable: opts.packTemplatesUnavailable ?? [],
  };
  const find = (attr: string): (HTMLElement & { value?: string; disabled?: boolean }) | null =>
    typeof host.querySelector === 'function' ? host.querySelector(`[${attr}]`) : null;
  const setStatus = (message: string): void => {
    status = message;
    const el = find(TEMPLATES_BROWSER_INTENT_STATUS_ATTR);
    if (el) el.textContent = message;
  };
  // Catalog reads can settle while the owner is still typing. Keep the input,
  // caret and modal scroll, and never pull focus back from another overlay.
  const render = (): void => {
    const input = find(TEMPLATES_BROWSER_INTENT_INPUT_ATTR) as HTMLInputElement | null;
    const value = input?.value;
    const selection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
    const active = doc?.activeElement;
    const activeAction = active && host.contains(active) ? (active as HTMLElement).dataset.action : undefined;
    const inputFocused = active === input && input !== null;
    const headingFocused = active === find(TEMPLATES_BROWSER_HEADING_ATTR) && active != null;
    const scroll = host.scrollTop;
    host.innerHTML = renderTemplatesBrowser(catalog.templates, catalog.config_templates, intentEnabled,
      catalog.pack_templates ?? [], catalog.pack_templates_unavailable ?? [],
      { loading, error: loadError, reloadable: opts.onLoadTemplates !== undefined });
    const nextInput = find(TEMPLATES_BROWSER_INTENT_INPUT_ATTR) as HTMLInputElement | null;
    if (nextInput) {
      if (value !== undefined) nextInput.value = value;
      nextInput.disabled = proposing;
    }
    const submit = find('id="reception-intent-submit"');
    if (submit) submit.disabled = proposing;
    setStatus(status);
    if (ready) find(TEMPLATES_BROWSER_INTENT_STATUS_ATTR)?.insertAdjacentHTML?.('afterend', button({
      label: 'Review AI draft', size: 'sm', action: 'reception-template-review', data: {},
    }));
    const target = inputFocused && !proposing ? nextInput
      : headingFocused ? find(TEMPLATES_BROWSER_HEADING_ATTR)
      : activeAction ? find(`data-action="${activeAction}"`) : null;
    if (target && !target.disabled) target.focus?.({ preventScroll: true });
    if (inputFocused && nextInput && selection?.[0] != null && selection[1] != null)
      nextInput.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
    host.scrollTop = scroll;
  };
  const reload = async (): Promise<void> => {
    if (disposed || !opts.onLoadTemplates) return;
    loading = true; loadError = false; render();
    const ownsFocus = focusOwner?.capture() ?? (() => true);
    try {
      const next = await opts.onLoadTemplates();
      if (disposed) return;
      catalog = next;
    } catch {
      if (disposed) return;
      loadError = true;
    }
    if (disposed) return;
    loading = false; render();
    if (ownsFocus() && doc && doc.activeElement === doc.body)
      find('data-action="reception-template-reload"')?.focus?.({ preventScroll: true });
  };
  const close = (): void => {
    if (disposed) return;
    opts.onClose();
    // The page may have re-rendered its New control since the gallery opened.
    const fallback = doc ? [...doc.querySelectorAll<HTMLElement>('[data-action="reception-open-templates"]')]
      .find(node => node.getClientRects().length > 0) : null;
    const source = opener?.closest?.<HTMLElement>('[data-action="reception-open-templates"]');
    (source?.isConnected && source.getClientRects().length > 0 ? source : fallback)?.focus?.({ preventScroll: true });
  };
  const useProposal = (): void => {
    if (disposed || !ready) return;
    opts.onUseProposed?.(ready.kind, ready.config);
    opts.onClose('selection');
  };
  render();
  find(TEMPLATES_BROWSER_HEADING_ATTR)?.focus?.();
  const trap = doc ? wireFocusTrap({ document: doc, getContainer: () => host.querySelector('.reception-templates-browser'),
    initialFocus: false, restoreFocus: false }) : null;
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !host.contains(doc?.activeElement ?? null)) return;
    event.preventDefault(); event.stopPropagation(); close();
  };
  host.addEventListener('keydown', onKeydown);

  const handlers = {
    'reception-template-use': (dataset: DOMStringMap) => {
      if (disposed || loading || loadError || dataset.templateRef === undefined) return;
      const rawKind = dataset.kind;
      const kind: ReceptionEndpointKind = rawKind !== undefined && isReceptionEndpointKind(rawKind) ? rawKind : 'intake_form';
      opts.onUseTemplate(dataset.templateRef, kind);
      opts.onClose('selection');
    },
    'reception-template-close': close,
    'reception-template-reload': () => { if (!loading) void reload(); },
    'reception-template-review': useProposal,
    'reception-template-propose': () => {
      if (disposed || proposing || !opts.onProposeIntent) return;
      const intent = (find(TEMPLATES_BROWSER_INTENT_INPUT_ATTR)?.value ?? '').trim();
      if (!intent) { setStatus('Say what you need first, then let AI write it.'); return; }
      proposing = true; ready = null; status = 'Drafting…'; render();
      const ownsFocus = focusOwner?.capture() ?? (() => true);
      void opts.onProposeIntent(intent).then(result => {
        if (disposed) return;
        proposing = false;
        if (result.ok) {
          ready = { kind: result.kind, config: result.config };
          status = `AI thinks you want a ${result.kind}${result.reason ? ` — ${result.reason}` : ''}`;
          // A later owner interaction must not be replaced by async navigation.
          // Keep the proposal here until they explicitly choose to review it.
          if (ownsFocus()) { setStatus(status); useProposal(); return; }
          status = 'Your AI draft is ready. Review it when you are ready.';
        } else status = result.message;
        const restoreInput = ownsFocus() && doc && doc.activeElement === doc.body;
        render();
        if (restoreInput) find(TEMPLATES_BROWSER_INTENT_INPUT_ATTR)?.focus?.({ preventScroll: true });
      }, () => {
        if (disposed) return;
        proposing = false;
        status = 'Recued could not write that. Pick a template below, or make one yourself.';
        const restoreInput = ownsFocus() && doc && doc.activeElement === doc.body;
        render();
        if (restoreInput) find(TEMPLATES_BROWSER_INTENT_INPUT_ATTR)?.focus?.({ preventScroll: true });
      });
    },
  } satisfies Record<TemplatesBrowserAction, (dataset: DOMStringMap) => void>;
  const detach = createActionDispatcher<TemplatesBrowserAction>({ root: host, events: ['click', 'submit'], handlers,
    shouldDispatch: (target, event) => event.type !== 'click' || target.tagName !== 'FORM',
  });
  const onInput = (event: Event): void => {
    if (proposing || event.target !== find(TEMPLATES_BROWSER_INTENT_INPUT_ATTR)) return;
    if (ready) { ready = null; status = ''; render(); }
    else setStatus('');
  };
  host.addEventListener('input', onInput);
  if (opts.onLoadTemplates) void reload();
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detach(); trap?.release(); focusOwner?.dispose(); host.removeEventListener('keydown', onKeydown); host.removeEventListener('input', onInput);
      host.innerHTML = '';
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — self-contained `.reception-templates-browser-*` selectors,
// colours from the shared CSS custom properties (same convention as
// `RECEPTION_PAGE_STYLES` / `RECEPTION_AUTHORING_STYLES`). The card
// chrome reuses the `.reception-template-*` selectors the inline panel
// already ships (`RECEPTION_PAGE_STYLES`).
// ════════════════════════════════════════════════════════════════

export const RECEPTION_TEMPLATES_BROWSER_STYLES = `
.reception-templates-browser {
  display: flex;
  flex-direction: column;
  gap: 20px;
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  max-width: 1100px;
  padding: clamp(16px, 3vw, 28px);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow-wrap: anywhere;
}
.reception-templates-browser-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.reception-templates-browser-title {
  font-size: clamp(18px, 2.2vw, 22px);
  line-height: 1.3;
  letter-spacing: -.025em;
  font-weight: 650;
  margin: 6px 0 0;
  flex: 1;
  min-width: 0;
}
.reception-templates-browser :is(button,input):focus-visible,
.reception-templates-browser-title:focus-visible {
  outline: 2px solid var(--accent, var(--fg));
  outline-offset: 3px;
}
.reception-templates-browser-desc,
.reception-templates-browser-section-help {
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg-muted);
  margin: 0;
  max-width: 76ch;
}
.reception-templates-toolbar {
  display: flex;
  justify-content: flex-end;
}
.reception-templates-read-status {
  margin: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
  font-size: 13px;
  line-height: 1.6;
}
.reception-templates-browser-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
.reception-templates-browser-section-title {
  font-size: 15px;
  font-weight: 650;
  margin: 0;
}
.reception-templates-browser-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.reception-templates-browser .reception-template-card {
  min-width: 0;
  padding: 18px;
  gap: 10px;
  background: var(--surface-sunk);
  border-radius: 10px;
}
.reception-templates-browser .reception-template-card-head {
  align-items: flex-start;
  flex-wrap: wrap;
}
.reception-templates-browser .reception-template-name {
  font-size: 14px;
  line-height: 1.4;
}
.reception-templates-browser :is(.reception-template-desc,.reception-row-meta) {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
.reception-templates-browser button {
  min-height: 40px;
  max-width: 100%;
  white-space: normal;
}
.reception-templates-browser .reception-template-card > button {
  align-self: flex-start;
  margin-top: auto;
}
.reception-intent {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
.reception-intent-label {
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
}
.reception-intent-row {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}
.reception-intent-input {
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  background: var(--bg);
  color: var(--fg);
}
.reception-intent-row button { flex-shrink: 0; }
.reception-intent-status {
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg-muted);
  margin: 0;
  min-height: 1em;
}
@media (max-width: 700px) {
  .reception-templates-browser-grid { grid-template-columns: minmax(0, 1fr); }
  .reception-intent-row { flex-direction: column; align-items: stretch; }
  .reception-intent, .reception-templates-browser .reception-template-card { padding: 14px; }
}
`;
