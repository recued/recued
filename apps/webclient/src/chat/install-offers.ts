/** D-323 — the marketplace packs (or recipes) a chat answer offers, when nothing
 *  installed could do what the owner asked: a link to each one's install page,
 *  under the answer.
 *
 *  ⛔ IT LINKS, IT DOES NOT INSTALL — the rule `shell/pack-install-offer.ts`
 *  records for a failed run, for the same reason. Installing takes the owner's
 *  consent to what the pack may do, which only the pack page's dialog (or a
 *  standalone recipe's install dialog) collects. A button here would have to
 *  invent it.
 *
 *  The offers come from a typed field the server stamped from its own search
 *  result (`ChatMessage.install_offers`), never from the model's text, and are
 *  checked again here with the shared reader before anything becomes a link. */

import { installOffersOf, type ChatMessage, type InstallOffer } from '@recued/contracts';

import { serializeShellRoute } from '../shell/route.js';

/** Marks the offers under an answer — what a host or a drive asserts on. */
export const CHAT_INSTALL_OFFERS_ATTR = 'data-chat-install-offers';
/** On each link: the slug it offers. */
export const CHAT_INSTALL_OFFER_ATTR = 'data-chat-install-offer';

export interface ChatInstallOfferLink {
  readonly kind: InstallOffer['kind'];
  readonly slug: string;
  readonly href: string;
  readonly label: string;
  /** The matching recipes of a pack, said beside its link. Empty when there is
   *  nothing to add to the name. */
  readonly detail: string;
}

/** Where an offer leads: a pack's page, which resolves it from the marketplace
 *  and holds its Install button; a standalone recipe's install dialog. */
export const installOfferHref = (offer: InstallOffer): string =>
  offer.kind === 'pack'
    ? serializeShellRoute('packs', offer.slug)
    : serializeShellRoute('recipes', 'install', offer.slug);

/** The links an answer shows. None for anything but an assistant answer. */
export const chatInstallOfferLinks = (
  message: Pick<ChatMessage, 'role' | 'install_offers'>,
): ChatInstallOfferLink[] =>
  message.role !== 'assistant'
    ? []
    : installOffersOf(message.install_offers).map((offer) => ({
      kind: offer.kind,
      slug: offer.slug,
      href: installOfferHref(offer),
      label: `Get ${offer.name}`,
      detail: offer.kind === 'pack' ? offer.recipes.join(' · ') : '',
    }));

export const buildChatInstallOffers = (
  doc: Document,
  links: readonly ChatInstallOfferLink[],
): HTMLElement => {
  const root = doc.createElement('div');
  root.className = 'chat-install-offers';
  root.setAttribute(CHAT_INSTALL_OFFERS_ATTR, '');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'From the marketplace, not installed yet');
  const lead = doc.createElement('p');
  lead.className = 'chat-install-offers-lead';
  lead.textContent = 'From the marketplace, not installed yet:';
  root.appendChild(lead);
  const list = doc.createElement('ul');
  list.className = 'chat-install-offers-list';
  for (const link of links) {
    const item = doc.createElement('li');
    const anchor = doc.createElement('a');
    anchor.className = 'chat-install-offer-link';
    anchor.href = link.href;
    anchor.textContent = link.label;
    anchor.setAttribute(CHAT_INSTALL_OFFER_ATTR, link.slug);
    item.appendChild(anchor);
    if (link.detail !== '') {
      const detail = doc.createElement('span');
      detail.className = 'chat-install-offer-detail';
      detail.textContent = link.detail;
      item.appendChild(detail);
    }
    list.appendChild(item);
  }
  root.appendChild(list);
  return root;
};

export const CHAT_INSTALL_OFFERS_STYLES = `
.chat-install-offers { display: grid; gap: 6px; margin-top: 8px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 0.5rem; background: var(--surface-sunk); color: var(--fg); }
.chat-install-offers-lead { margin: 0; font-size: 12px; color: var(--muted); }
.chat-install-offers-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.chat-install-offers-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.chat-install-offer-link { font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.chat-install-offer-link:hover, .chat-install-offer-link:focus-visible { text-decoration: underline; }
.chat-install-offer-detail { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
`;
