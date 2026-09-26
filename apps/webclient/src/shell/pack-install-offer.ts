/** The "install the missing pack" offer — one component every run surface slots
 *  into its error slot.
 *
 *  ── Why a component and not copy ────────────────────────────────────
 *  `rpc-error-copy.ts` turns an error into a STRING, which is right for every
 *  error whose only remedy is "try again later". A missing pack is different:
 *  the remedy is a button. So this cannot live in `classifyRpcError` — its
 *  return type structurally cannot carry an action.
 *
 *  ── Why shared rather than per-surface ──────────────────────────────
 *  A run can fail from seven error sites in the recipes route alone, plus the
 *  pack app view's own execute path. Wiring the offer at one of them leaves the
 *  rest rendering `pack not installed: recued-core.docling` as bare text — and
 *  an offer that appears on the recipe detail but not in the pack app view is
 *  exactly the inconsistency a user notices. The same argument the server side
 *  already follows: the scheduler gate, the uninstall disclosure and this offer
 *  all read `missingPackDependencies`, so no surface names a different pack.
 *
 *  ── The install dialog offers the same way ───────────────────────────
 *  `settings/packs-install-dialog.ts` names and links a missing pack with
 *  {@link packInstallOfferName} / {@link packInstallOfferHref}, so both offers
 *  send the owner to the same place. Its list is not `depends_on`: it is the
 *  packs whose operations the install could not bind (`unboundPackRefs`),
 *  because that dialog HOLDS Install on it, and a pack a recipe declares but
 *  never calls must not hold an install that would succeed.
 *
 *  ── ⛔ IT LINKS, IT DOES NOT INSTALL ─────────────────────────────────
 *  The obvious build is an Install button calling `packs.installBySlug`. That
 *  would be a consent bypass: the rpc takes `granted_permissions` and an
 *  `expected_manifest_hash` "rendered by the detail consent surface", and the
 *  packs panel collects both through a dialog that shows what the pack may do.
 *  A button here would have to invent that consent — silently granting whatever
 *  the pack asks for because a run failed.
 *
 *  So the offer NAMES the packs and links each to `#packs/<slug>`, where the
 *  real install flow and its consent dialog already live. One fewer thing for
 *  this module to get wrong, and the user still sees what they are agreeing to.
 *
 *  ── Shape ───────────────────────────────────────────────────────────
 *  Pure render (HTML string), mirroring `collection-explorer.ts`. Anchors, not
 *  buttons — the destination is a route, so it must middle-click, open in a new
 *  tab, and survive a refresh like every other link in the shell.
 */

import { RpcError } from '@recued/contracts';
import { serializeShellRoute } from './route.js';

/** Marks the offer container — the browser-verify handle, and what a host
 *  asserts on rather than a CSS class. */
export const PACK_INSTALL_OFFER_ATTR = 'data-recued-pack-install-offer';
/** The pack_ref each link addresses. Lets a host (or a test) read what was
 *  offered without scraping the href. */
export const PACK_INSTALL_OFFER_REF_ATTR = 'data-pack-install-ref';

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The pack slug a user recognises — `recued-core.officecli` → `officecli`.
 *  The publisher-qualified ref stays the machine identity (and the button's
 *  value); showing it whole would put an implementation detail in a sentence.
 *  Exported with {@link packInstallOfferHref} so the install dialog's offer
 *  names and links a missing pack exactly as this one does. */
export const packInstallOfferName = (packRef: string): string => {
  const dot = packRef.indexOf('.');
  return dot === -1 ? packRef : packRef.slice(dot + 1);
};

/** Where an offer sends the owner for a missing pack: its `#packs/<slug>`
 *  detail, which resolves it and holds its own install dialog. */
export const packInstallOfferHref = (packRef: string): string =>
  serializeShellRoute('packs', packInstallOfferName(packRef));

/** The packs a failed run says it needs, or null when this error is not that.
 *
 *  ⛔ Reads `details.missing_packs` — never the message. The server sets the
 *  typed field precisely so no surface has to parse prose, and a message-parsing
 *  fallback here would quietly become the real contract the first time the
 *  wording changed. An error carrying the code but no usable list is treated as
 *  NOT an offer: better to show the plain error than an offer with no packs in
 *  it. */
export const missingPacksFromError = (err: unknown): string[] | null => {
  const code = err instanceof RpcError
    ? err.code
    : (err && typeof err === 'object' && 'code' in err
      && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : null);
  if (code !== 'pack_not_installed') return null;
  const details = (err as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') return null;
  const packs = (details as { missing_packs?: unknown }).missing_packs;
  if (!Array.isArray(packs)) return null;
  const out = packs.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return out.length > 0 ? out : null;
};

/** Render the offer. `actionAttr` is the host route's action-attribute name so
 *  one shared component works under each route's existing click dispatcher. */
export const renderPackInstallOffer = (missing: readonly string[]): string => {
  if (missing.length === 0) return '';
  const many = missing.length > 1;
  const rows = missing.map((ref) => {
    const slug = packInstallOfferName(ref);
    // The link text IS the pack name — a separate label beside it rendered the
    // slug twice per row ("officecli   Get officecli"), which the render test
    // was happy to assert and only the browser made obvious.
    return `<a class="recipes-button pack-offer-link"`
      + ` href="${e(packInstallOfferHref(ref))}"`
      + ` ${PACK_INSTALL_OFFER_REF_ATTR}="${e(ref)}"`
      + `>Get ${e(slug)}</a>`;
  }).join('');
  return `<div class="pack-offer" ${PACK_INSTALL_OFFER_ATTR} role="group"`
    + ` aria-label="Install missing packs">`
    + `<p class="pack-offer-lead">`
    + `This recipe needs ${many ? 'packs' : 'a pack'} you don’t have installed`
    + ` yet. Install ${many ? 'them' : 'it'}, then run again.</p>`
    + `<div class="pack-offer-row">${rows}</div>`
    + `</div>`;
};

export const PACK_INSTALL_OFFER_STYLES = `
.pack-offer { display: flex; flex-direction: column; gap: 8px; padding: 12px;
  border: 1px solid var(--border); border-radius: 0.5rem;
  background: var(--surface-sunk); color: var(--fg); }
.pack-offer-lead { margin: 0; font-size: 13px; color: var(--fg); }
.pack-offer-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pack-offer-link { text-decoration: none; font-weight: 600; }
`;
