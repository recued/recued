/** D-323 — a pack or a recipe chat offers to install when nothing installed can
 *  do what the owner asked.
 *
 *  The server finds offers in its own copy of the marketplace catalogue, so the
 *  owner's words never leave it (ruling P1). An offer is something to look at,
 *  never something to run: it carries no `args_schema`, and installing it is the
 *  owner's, through the pack page or the recipe's install dialog and their
 *  consent dialog. Chat installs nothing.
 *
 *  Shared by the server, which finds the offers and attaches them to the turn's
 *  answer, and the web app, which shows them as links. */

/** At most this many offers for one request (ruling P3). */
export const INSTALL_OFFER_LIMIT = 3;

/** At most this many matching recipe names on one pack's offer. */
export const INSTALL_OFFER_RECIPE_NAMES_LIMIT = 3;

export interface InstallOffer {
  /** A pack, installed from its page; or a recipe that installs alone, from its
   *  install dialog (ruling P8). */
  readonly kind: 'pack' | 'recipe';
  /** The pack's slug, or the recipe's id. */
  readonly slug: string;
  /** Its name in the marketplace. The publisher's words: shown as data, never
   *  read as an instruction. */
  readonly name: string;
  /** Its publisher's handle. Only certified publishers are offered (ruling P4). */
  readonly publisher: string;
  /** The recipes in it that matched, by name, best first. A recipe offer names
   *  itself. At most {@link INSTALL_OFFER_RECIPE_NAMES_LIMIT}. */
  readonly recipes: ReadonlyArray<string>;
}

const OFFER_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OFFER_TEXT_MAX = 160;

const offerText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, OFFER_TEXT_MAX) : null;

/** The offers `value` holds, each checked: a known kind, a slug an address can
 *  carry, a name and a publisher, recipe names capped. Anything else is dropped,
 *  and at most {@link INSTALL_OFFER_LIMIT} are kept. One reader for every hop an
 *  offer takes (the search result, the stored answer, the web app), so none of
 *  them trusts the one before. */
export const installOffersOf = (value: unknown): InstallOffer[] => {
  if (!Array.isArray(value)) return [];
  const offers: InstallOffer[] = [];
  for (const raw of value) {
    if (offers.length >= INSTALL_OFFER_LIMIT) break;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const kind = row.kind === 'pack' || row.kind === 'recipe' ? row.kind : null;
    const slug = typeof row.slug === 'string' && OFFER_SLUG_RE.test(row.slug) ? row.slug : null;
    const name = offerText(row.name);
    const publisher = offerText(row.publisher);
    if (kind === null || slug === null || name === null || publisher === null) continue;
    const recipes = Array.isArray(row.recipes)
      ? row.recipes.map(offerText).filter((recipe): recipe is string => recipe !== null)
        .slice(0, INSTALL_OFFER_RECIPE_NAMES_LIMIT)
      : [];
    offers.push({ kind, slug, name, publisher, recipes });
  }
  return offers;
};
