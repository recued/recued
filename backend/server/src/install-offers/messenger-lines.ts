/** D-323 — an answer's install offers, as the plain-text lines a Slack or
 *  Telegram reply ends with (ruling P5).
 *
 *  A messenger answer is plain text, and a web app address (`#packs/<slug>`)
 *  means nothing there, so each offer gets a full link to the server's own web
 *  app when the server has a public address. Without one there is no address a
 *  phone could open, so the lines say where to look instead. Either way the
 *  install happens in Recued, through its consent dialog. */

import { installOffersOf } from '@recued/contracts';

import { buildPacksSurfaceLink } from '../ask-landing-answer-link.js';

export const messengerInstallOfferLines = (
  offers: unknown,
  publicBaseUrl: string | null,
): string => {
  const checked = installOffersOf(offers);
  if (checked.length === 0) return '';
  const packLink = buildPacksSurfaceLink(publicBaseUrl);
  const lines = checked.map((offer) => {
    if (publicBaseUrl === null || packLink === null) return `- ${offer.name}`;
    const link = offer.kind === 'pack'
      ? packLink(offer.slug)
      : `${publicBaseUrl}/#recipes/install/${encodeURIComponent(offer.slug)}`;
    return `- ${offer.name}: ${link}`;
  });
  const lead = publicBaseUrl === null
    ? 'From the marketplace, not installed yet. Open Recued to install:'
    : 'From the marketplace, not installed yet:';
  return `\n\n${lead}\n${lines.join('\n')}`;
};
