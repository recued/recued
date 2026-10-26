/** D-323 — the offers for packs a chat call needed and did not have: a run or a
 *  schedule refused `pack_not_installed` (the recipe's own `depends_on`), or
 *  `document.read` with no reader pack installed. The turn's answer carries
 *  them as links, as it carries a search's offers.
 *
 *  🔑 NOTHING HERE MATCHES WORDS. The server names the packs: a recipe's
 *  declaration, or the readers `document.read` can use. So ruling P2 (offer
 *  only when nothing installed matches) has nothing to decide: the call came
 *  back because the pack is missing. The other rulings hold as for a search:
 *  the owner's switch (P7), certified publishers only (P4), never something
 *  installed, at most three (P3), and only the owner's own chat. A door's or an
 *  outside caller's turn gets none (§4.7), by the same guard that refuses them
 *  `tools.search`.
 *
 *  ⛔ THE MODEL IS TOLD IN THE TEXT IT READS, AND ONLY THE MODEL IS. The sentence
 *  about the link goes in the result's `hint`, which the owner's activity row
 *  never shows (see `withOffers`). `install_offers` beside it is for the answer,
 *  which the model never reads. Without that sentence a refusal ends "Install it
 *  and run again", which a model can take as its own job. */

import {
  INSTALL_OFFER_LIMIT,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ExecutionSource,
  type InstallOffer,
  type InternalToolRegistry,
} from '@recued/contracts';

import type { MarketplaceCatalogue } from './catalogue.js';
import { FIRST_CATALOGUE_WAIT_MS } from './source.js';
import { forwardedRegistryHooks } from '../registry-forwarding.js';

/** The packs a refusal names as data: `details.missing_packs` of a
 *  `pack_not_installed` error, the shape the run and the schedule both throw.
 *  Never read from the message. Any other error names none. */
export const missingPacksOfRefusal = (error: unknown): string[] => {
  if (error === null || typeof error !== 'object') return [];
  if ((error as { code?: unknown }).code !== 'pack_not_installed') return [];
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') return [];
  const packs = (details as { missing_packs?: unknown }).missing_packs;
  return Array.isArray(packs)
    ? packs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
    : [];
};

/** The offers for packs named as `<publisher>.<pack>`. */
export type NeededPackOffers = (packRefs: ReadonlyArray<string>) => Promise<InstallOffer[]>;

export interface NeededPackOffersDeps {
  readonly catalogue: MarketplaceCatalogue;
  /** The owner's switch (ruling P7), the one a search's offers read. */
  readonly enabled: () => boolean;
  /** Every installed pack's slug, read per call. */
  readonly installedPackSlugs: () => ReadonlySet<string>;
  readonly waitMs?: number;
}

/** Each pack the catalogue lists under the same publisher and slug, from a
 *  certified publisher and not installed, in the order named. A pack the
 *  marketplace does not have (a local one) gets no offer: its link would lead to
 *  a page that cannot install it. Waits for a new server's first download as a
 *  search does. */
export const createNeededPackOffers = (deps: NeededPackOffersDeps): NeededPackOffers =>
  async (packRefs) => {
    if (packRefs.length === 0 || !deps.enabled()) return [];
    const catalogue = await deps.catalogue.ready(deps.waitMs ?? FIRST_CATALOGUE_WAIT_MS);
    if (catalogue === null) return [];
    const installed = deps.installedPackSlugs();
    const offers: InstallOffer[] = [];
    for (const ref of new Set(packRefs)) {
      if (offers.length >= INSTALL_OFFER_LIMIT) break;
      const dot = ref.indexOf('.');
      if (dot <= 0) continue;
      const publisher = ref.slice(0, dot);
      const slug = ref.slice(dot + 1);
      if (installed.has(slug)) continue;
      const row = catalogue.packs.find((pack) => pack.slug === slug && pack.publisher_id === publisher);
      if (row === undefined || !row.publisher_certified) continue;
      offers.push({ kind: 'pack', slug: row.slug, name: row.name, publisher: row.publisher_id, recipes: [] });
    }
    return offers;
  };

/** "a", "a and b", "a, b and c". */
const joinNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** What the model reads after the call's own words, once its packs are
 *  offered. The names are the publisher's, capped by the catalogue and quoted
 *  as data. */
export const neededPacksSentence = (offers: ReadonlyArray<InstallOffer>): string => {
  const one = offers.length === 1;
  return `${one ? 'The pack' : 'The packs'} ${joinNames(offers.map((offer) => `"${offer.name}"`))} `
    + `${one ? 'is' : 'are'} in the Recued marketplace, not installed. The owner sees `
    + `${one ? 'it' : 'each one'} as a link under your answer and installs it from there. You cannot `
    + 'install a pack, and calling this again will not help until the owner has. In one or two '
    + 'sentences, say what is needed and that the link under your answer installs it. Never say you '
    + 'installed it.';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The result with its offers, and the model told in its `hint`.
 *
 *  ⛔ A REFUSAL BECOMES A RESULT, AS A FAILED RUN DOES (D-182). The owner's
 *  activity row shows a failed call's `detail` ("couldn't run X: …"), so the
 *  model's sentence cannot go there. Live (2026-10-13), the first cut appended
 *  it to the detail, and the owner's row read "…Install it and run again. The
 *  pack "Rental Book" is in the Recued market…", the start of words meant for
 *  the model. So the model reads `ok: true`, `needs_pack`
 *  with the refusal's words and the sentence, as `document.read` answers; the
 *  row reads `run_failed`, the refusal as it was. A result the model could not
 *  be told in is returned as it was, offers and all left off. */
const withOffers = (
  result: ChatDispatchResult,
  offers: ReadonlyArray<InstallOffer>,
): ChatDispatchResult => {
  const sentence = neededPacksSentence(offers);
  if (!result.ok) {
    const refusal = result.detail !== undefined && result.detail.length > 0 ? result.detail : 'the run did not complete';
    return {
      ok: true,
      result: { status: 'needs_pack', message: refusal, hint: sentence },
      run_failed: { detail: refusal },
      ...(result.run_id !== undefined ? { run_id: result.run_id } : {}),
      ...(result.dish_id !== undefined ? { dish_id: result.dish_id } : {}),
      ...(result.missing_packs !== undefined ? { missing_packs: result.missing_packs } : {}),
      install_offers: offers,
    };
  }
  if (!isRecord(result.result)) return result;
  const hint = result.result.hint;
  return {
    ...result,
    result: { ...result.result, hint: typeof hint === 'string' && hint.length > 0 ? `${hint} ${sentence}` : sentence },
    install_offers: offers,
  };
};

export interface NeededPackOffersWrapOptions {
  readonly offers: NeededPackOffers;
  /** `tools.search`'s guard (`createChatOwnerCatalogGuard`): it throws for a
   *  source the owner does not govern. The same one, so a search's offers and
   *  these answer "is this the owner's turn" alike. */
  readonly ownerCatalogGuard?: (source?: ExecutionSource) => void;
}

/** The chat registry, with offers on every call that comes back naming packs
 *  it needed. Chat only: the MCP surface reads the registry this wraps. No
 *  options (no catalogue on this server): the registry as it was. */
export const wrapRegistryWithNeededPackOffers = (
  inner: InternalToolRegistry,
  opts: NeededPackOffersWrapOptions | undefined,
): InternalToolRegistry => {
  if (opts === undefined) return inner;
  const ownerTurn = (ctx: ChatDispatchContext): boolean => {
    try {
      opts.ownerCatalogGuard?.(ctx.execution_source);
      return true;
    } catch {
      return false;
    }
  };
  return {
    list: () => inner.list(),
    listByTier: (tier) => inner.listByTier(tier),
    getByName: (name) => inner.getByName(name),
    ...forwardedRegistryHooks(inner),
    subscribeRefresh: (callback) => inner.subscribeRefresh(callback),
    dispatch: async (name, args, ctx) => {
      const result = await inner.dispatch(name, args, ctx);
      const needed = result.missing_packs ?? [];
      if (needed.length === 0 || !ownerTurn(ctx)) return result;
      // An offer is an extra: a lookup that fails leaves the call's answer as it was.
      const offers = await opts.offers(needed).catch((): InstallOffer[] => []);
      return offers.length === 0 ? result : withOffers(result, offers);
    },
  };
};
