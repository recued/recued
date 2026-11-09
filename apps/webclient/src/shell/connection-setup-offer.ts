/** The "set up the missing connection" offer (D-321 P2): a run refused because
 *  a pack it signs in through lists connections and none of them is set up
 *  (`connection_not_set_up`, D-320 audit) says where to set one up, as a run
 *  missing a pack says where to get it (`pack-install-offer.ts`).
 *
 *  ── Why ─────────────────────────────────────────────────────────────
 *  The refusal ended on a sentence: "Recipe 'search-web-exa' needs a connection
 *  for 'exa', and its pack's connection 'exa' is not set up. Set it up under
 *  Connections, …" (live, the Exa pack's Use tab). It names the recipe and the
 *  slot by id and leaves the owner to find the form. The offer names the
 *  service and links to its form, opened for the pack's sign-in.
 *
 *  ── Where it goes ────────────────────────────────────────────────────
 *  The vendor's Connections form with the pack as its source
 *  (`connectionsEnrollAddress`), the same link the pack page's readiness row
 *  ("Set up →") follows, so both set one up the same way. That needs the vendor
 *  and the pack, which the server sends only to the owner. Without the vendor
 *  (the server could not read the pack's manifest) it links to the pack's page,
 *  whose "What this pack needs" card links on; without either (a server from
 *  before D-321 sends only the slot) it opens Connections.
 *
 *  ── ⛔ IT LINKS, IT DOES NOT CONNECT ─────────────────────────────────
 *  Setting up a connection takes a credential and its consent, which the form
 *  collects. Nothing here can stand in for that. */

import {
  CONNECTION_NOT_SET_UP,
  RpcError,
  type ConnectionNotSetUpDetails,
} from '@recued/contracts';

import { connectionsEnrollAddress, connectionsLaneAddress } from '../connections/connections-navigation.js';
import { serializeShellRoute } from './route.js';

/** Marks the offer: what a host or a test asserts on. */
export const CONNECTION_SETUP_OFFER_ATTR = 'data-recued-connection-setup-offer';
/** The slot the link sets up. */
export const CONNECTION_SETUP_OFFER_SLOT_ATTR = 'data-connection-setup-slot';

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

/** What a refused run needs set up, or null when the error is not that.
 *
 *  ⛔ Reads `details`, never the message, as `missingPacksFromError` does: the
 *  message is the model's to read and may change. An error with the code and
 *  no slot is not an offer. */
export const connectionSetupFromError = (err: unknown): ConnectionNotSetUpDetails | null => {
  const code = err instanceof RpcError
    ? err.code
    : (err && typeof err === 'object' && 'code' in err
      && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : null);
  if (code !== CONNECTION_NOT_SET_UP) return null;
  const details = (err as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') return null;
  const read = details as Record<string, unknown>;
  const slot = text(read.slot);
  if (slot === undefined) return null;
  const pack_slug = text(read.pack_slug);
  const vendor = text(read.vendor);
  const label = text(read.label);
  return {
    slot,
    ...(pack_slug !== undefined ? { pack_slug } : {}),
    ...(vendor !== undefined ? { vendor } : {}),
    ...(label !== undefined ? { label } : {}),
  };
};

/** The sentence the offer leads with. */
export const connectionSetupLead = (need: ConnectionNotSetUpDetails): string =>
  `This needs a connection to ${need.label ?? need.slot}, and none is set up for it yet. `
  + 'Set one up, then run again.';

/** Where the offer sends the owner, and what its link says. */
export const connectionSetupLink = (need: ConnectionNotSetUpDetails): { href: string; text: string } => {
  const label = need.label ?? need.slot;
  if (need.vendor !== undefined && need.pack_slug !== undefined) {
    return {
      href: connectionsEnrollAddress(need.vendor, { slug: need.pack_slug, slot: need.slot }).hash,
      text: `Set up ${label}`,
    };
  }
  if (need.pack_slug !== undefined) {
    return { href: serializeShellRoute('packs', need.pack_slug), text: 'Open its pack' };
  }
  return { href: connectionsLaneAddress('others').hash, text: 'Open Connections' };
};

/** The offer, for a host that draws HTML (the pack app view, a recipe's page).
 *  It wears the install offer's classes, so the two read as one kind of thing;
 *  a host that shows one injects `PACK_INSTALL_OFFER_STYLES` already. */
export const renderConnectionSetupOffer = (need: ConnectionNotSetUpDetails): string => {
  const link = connectionSetupLink(need);
  return `<div class="pack-offer" ${CONNECTION_SETUP_OFFER_ATTR} role="group"`
    + ` aria-label="Set up a connection">`
    + `<p class="pack-offer-lead">${e(connectionSetupLead(need))}</p>`
    + `<div class="pack-offer-row">`
    + `<a class="recipes-button pack-offer-link" href="${e(link.href)}"`
    + ` ${CONNECTION_SETUP_OFFER_SLOT_ATTR}="${e(need.slot)}">${e(link.text)}</a>`
    + `</div>`
    + `</div>`;
};
