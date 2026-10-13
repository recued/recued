/** D-323 — the offers a chat turn's answer carries: the packs its calls came
 *  back needing (`needed-packs.ts`), then those the turn's LAST `tools.search`
 *  returned (ruling P3: every one), at most three in all, each once.
 *
 *  ⛔ THE LAST SEARCH DECIDES, NOT ANY SEARCH. A turn that searched, found
 *  nothing installed, then searched again and found an installed recipe to run
 *  has no business showing the first search's offers: the request was served.
 *  So only the final search counts, and one with no offers clears them.
 *
 *  🔑 A NEEDED PACK IS NOT CLEARED BY A SEARCH, AND COMES FIRST. A search's offer
 *  is a guess from the request's words. A needed pack is a fact: a recipe the
 *  owner has, or the document they asked about, cannot be used without it.
 *  Whatever the turn did next, it is still true.
 *
 *  Read from results the server itself produced, and checked again with the
 *  shared reader (`installOffersOf`), never from the model's text: the answer
 *  can link nothing but records, so the model never chooses a link. */

import { INSTALL_OFFER_LIMIT, installOffersOf, type InstallOffer } from '@recued/contracts';

import { TOOLS_SEARCH_TOOL_NAME } from '../chat-tools-search-name.js';

/** The offers in a search's result, or none for a failed search. */
const searchOffers = (result: unknown): unknown[] => {
  if (result === null || typeof result !== 'object') return [];
  const outcome = result as { ok?: unknown; result?: unknown };
  if (outcome.ok !== true || outcome.result === null || typeof outcome.result !== 'object') return [];
  const installable = (outcome.result as { installable?: unknown }).installable;
  return Array.isArray(installable) ? installable : [];
};

/** The offers on any other call's result: the host's `install_offers`, beside
 *  what the model reads, never inside it. */
const neededOffers = (result: unknown): unknown[] => {
  if (result === null || typeof result !== 'object') return [];
  const offers = (result as { install_offers?: unknown }).install_offers;
  return Array.isArray(offers) ? offers : [];
};

export const installOffersFromToolResults = (
  toolResults: ReadonlyArray<{ readonly tool_name: string; readonly result?: unknown }> | undefined,
): InstallOffer[] => {
  const needed: unknown[] = [];
  let lastSearch: unknown[] = [];
  for (const entry of toolResults ?? []) {
    if (entry.tool_name === TOOLS_SEARCH_TOOL_NAME) lastSearch = searchOffers(entry.result);
    else needed.push(...neededOffers(entry.result));
  }
  // One at a time through the reader, so a duplicate is dropped before the cap
  // counts it.
  const seen = new Set<string>();
  const offers: InstallOffer[] = [];
  for (const raw of [...needed, ...lastSearch]) {
    const [offer] = installOffersOf([raw]);
    if (offer === undefined) continue;
    const key = `${offer.kind}:${offer.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push(offer);
    if (offers.length >= INSTALL_OFFER_LIMIT) break;
  }
  return offers;
};
