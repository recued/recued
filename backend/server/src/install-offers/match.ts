/** D-323 — which packs or recipes in the marketplace catalogue would do what the
 *  owner asked, when nothing installed does.
 *
 *  Pure: a query and the catalogue in, at most {@link INSTALL_OFFER_LIMIT}
 *  offers out. The query is the English keywords chat writes for `tools.search`
 *  ("overdue invoices", "parcel tracking").
 *
 *  🔑 THE REQUEST'S SUBJECT, AND MOST OF ITS WEIGHT, IN FOLDED FORMS, ACROSS A
 *  PACK. Measured on 20 such queries (spec §3), the marketplace's own rule
 *  (`/catalog/search`: every word, as written, in one row) found a recipe for 15
 *  and a pack for 8. What it lost was word forms ("parcels" is not "parcel",
 *  "tracking" is not "track") and words spread over one pack ("rent" in "Collect
 *  the rent", "collection" in "Collection sheet", both Rental Book's). So here
 *  forms are folded, and a pack matches on its own words and its recipes' names
 *  together.
 *  ⛔ NOT EVERY WORD. That was the first rule, and it held on the queries above,
 *  which were written by hand. A model on a new server writes "rent collection
 *  tracking sheet" and "track expenses receipts" (measured 2026-10-12, spec
 *  §3a): one word the catalogue uses everywhere ("tracking" is in 76 rows) and
 *  every-word offered nothing. So a word weighs by how rare it is in the
 *  catalogue, a match must hold the rarest (the request's SUBJECT: "rent" is in
 *  one row) and {@link SHARE_OF_WEIGHT} of the weight.
 *  ⛔ And not "at least half the words" either, tried before every-word: it
 *  offered a ledger for "instagram post" (its "Post an entry"), document packs for
 *  "translate document", and Flink for "job application tracker"
 *  (stream-processing jobs). A wrong offer is worse than none, because the owner
 *  is shown it. The subject rule refuses all three: nothing in the catalogue
 *  says "instagram", "translate" names one pack, and "application" weighs too
 *  little of "job application tracker" alone.
 *
 *  What is never offered: anything installed, and anything from a publisher that
 *  is not certified (ruling P4). A recipe its pack installs is offered as that
 *  pack, naming its recipes that matched; a recipe that installs alone is offered
 *  as itself (ruling P8). */

import {
  INSTALL_OFFER_LIMIT,
  INSTALL_OFFER_RECIPE_NAMES_LIMIT,
  type InstallOffer,
} from '@recued/contracts';

import type { CatalogueRecipeRow, MarketplaceCatalogueSnapshot } from './catalogue.js';

/** Words that carry no capability: a request's grammar, not its subject. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into',
  'about', 'as', 'is', 'are', 'be', 'it', 'its', 'my', 'me', 'i', 'our', 'your', 'their', 'this',
  'that', 'these', 'those', 'all', 'any', 'some', 'every', 'each', 'please', 'can', 'could',
  'would', 'should', 'want', 'need', 'help', 'via', 'using', 'use', 'recued', 'up', 'out', 'off',
  'how', 'what', 'when', 'where', 'which', 'who', 'do', 'does', 'did',
]);

/** Fold a word's common forms to one: a plural, then `-ing`, `-ed` or `-ly`,
 *  then a final `e`. Light by design; it only has to make "parcels" meet
 *  "parcel", "tracking" meet "track", "meetings" meet "meeting" and "invoices"
 *  meet "invoice". Short words are left alone. */
export const foldWordForm = (word: string): string => {
  let w = word;
  if (w.length >= 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    w = w.slice(0, -1);
  }
  if (w.length >= 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length >= 5 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length >= 6 && w.endsWith('ly')) w = w.slice(0, -2);
  if (w.length >= 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
};

/** A text's words, lower case, split at anything that is not a letter or a
 *  digit, stopwords dropped, forms folded. */
export const capabilityWords = (text: string): string[] =>
  text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .map(foldWordForm);

/** How strongly a matched word counts, by where it matched. */
const NAME_WEIGHT = 3;
const SLUG_WEIGHT = 2;
/** A word found in one of a pack's recipe names, matched for the pack. */
const MEMBER_WEIGHT = 2;
const TAG_WEIGHT = 1;
/** A longer query word may match the start of a longer row word
 *  ("reconcil" in "reconciliation"); a short one may not ("pay" in "payroll"). */
const PREFIX_MIN = 5;

/** A row's words, by where they came from. */
interface Words {
  readonly name: ReadonlySet<string>;
  readonly slug: ReadonlySet<string>;
  readonly members: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();

const wordsOf = (
  name: string,
  slug: string,
  tags: ReadonlyArray<string>,
  members: ReadonlyArray<string> = [],
): Words => ({
  name: new Set(capabilityWords(name)),
  slug: new Set(capabilityWords(slug)),
  members: members.length === 0 ? EMPTY : new Set(members.flatMap(capabilityWords)),
  // `pack:<slug>` names the pack again; the prefix itself says nothing.
  tags: new Set(tags.flatMap((tag) => capabilityWords(tag.replace(/^pack:/, '')))),
});

const hits = (words: ReadonlySet<string>, query: string): boolean => {
  if (words.has(query)) return true;
  if (query.length < PREFIX_MIN) return false;
  for (const word of words) if (word.length > query.length && word.startsWith(query)) return true;
  return false;
};

/** The share of a request's weight a match must hold besides its subject.
 *  Measured 2026-10-12 on the shipped catalogue (spec §3a): 0.6 offered a
 *  document pack for "translate document"; 0.7 offered nothing wrong on the
 *  requests measured, and still found Rental Book for the model's "rent
 *  collection tracking sheet". */
export const SHARE_OF_WEIGHT = 0.7;

/** Every row of one catalogue copy as a set of words: a pack with its own words
 *  and its recipes', a recipe that installs alone. How rare a word is, is how
 *  few of these hold it. Built once per copy. */
const rowsOf = (() => {
  const built = new WeakMap<MarketplaceCatalogueSnapshot, ReadonlyArray<ReadonlySet<string>>>();
  return (catalogue: MarketplaceCatalogueSnapshot): ReadonlyArray<ReadonlySet<string>> => {
    const known = built.get(catalogue);
    if (known !== undefined) return known;
    const members = new Map<string, CatalogueRecipeRow[]>();
    for (const recipe of catalogue.recipes) {
      const slug = bundlePackSlug(recipe);
      if (slug === null) continue;
      const list = members.get(slug);
      if (list === undefined) members.set(slug, [recipe]);
      else list.push(recipe);
    }
    const flat = (row: Words): ReadonlySet<string> => new Set([...row.name, ...row.slug, ...row.members, ...row.tags]);
    const rows: ReadonlySet<string>[] = [];
    for (const pack of catalogue.packs) {
      const own = wordsOf(pack.name, pack.slug, pack.tags);
      const words = new Set(flat(own));
      for (const recipe of members.get(pack.slug) ?? []) {
        for (const word of flat(wordsOf(recipe.name, recipe.recipe_id, recipe.tags))) words.add(word);
      }
      rows.push(words);
    }
    for (const recipe of catalogue.recipes) {
      if (bundlePackSlug(recipe) === null) rows.push(flat(wordsOf(recipe.name, recipe.recipe_id, recipe.tags)));
    }
    built.set(catalogue, rows);
    return rows;
  };
})();

/** What a request asks of a match, against one catalogue copy. */
interface Need {
  /** Its capability words, each once. */
  readonly words: ReadonlyArray<string>;
  /** The rarest of them in the catalogue (all of them, on a tie): what the
   *  request is about. A match holds every one. */
  readonly subject: ReadonlyArray<string>;
  /** Each word's weight: the rarer in the catalogue, the heavier. */
  readonly weight: ReadonlyMap<string, number>;
  readonly total: number;
}

const needOf = (catalogue: MarketplaceCatalogueSnapshot, query: string): Need | null => {
  const words = [...new Set(capabilityWords(query))];
  if (words.length === 0) return null;
  const rows = rowsOf(catalogue);
  const counts = new Map(words.map((q) => [q, rows.reduce((n, row) => n + (hits(row, q) ? 1 : 0), 0)]));
  const fewest = Math.min(...counts.values());
  // ln((N + 1) / (n + 1)): never negative, and largest for a word no row holds.
  const weight = new Map(words.map((q) => [q, Math.log((rows.length + 1) / (counts.get(q)! + 1))]));
  return {
    words,
    subject: words.filter((q) => counts.get(q) === fewest),
    weight,
    total: [...weight.values()].reduce((sum, w) => sum + w, 0),
  };
};

const holdsNeed = (need: Need, held: ReadonlySet<string>): boolean =>
  need.subject.every((q) => held.has(q))
  && need.words.reduce((sum, q) => sum + (held.has(q) ? need.weight.get(q)! : 0), 0)
    >= SHARE_OF_WEIGHT * need.total;

/** The weight of the request's words in `words`, or `null` unless they hold it. */
const scoreAll = (words: Words, need: Need): number | null => {
  let weight = 0;
  const held = new Set<string>();
  for (const q of need.words) {
    if (hits(words.name, q)) weight += NAME_WEIGHT;
    else if (hits(words.slug, q)) weight += SLUG_WEIGHT;
    else if (hits(words.members, q)) weight += MEMBER_WEIGHT;
    else if (hits(words.tags, q)) weight += TAG_WEIGHT;
    else continue;
    held.add(q);
  }
  return holdsNeed(need, held) ? weight : null;
};

/** How many of `query`'s words a recipe name holds: which recipes a pack's
 *  offer names when the pack matched only across them. */
const wordsInName = (name: string, query: ReadonlyArray<string>): number => {
  const words = new Set(capabilityWords(name));
  return query.filter((q) => hits(words, q)).length;
};

/** What the installed search found for a request, as text: an installed
 *  recipe's or action's name, description and tags. */
export interface InstalledMatchText {
  readonly name: string;
  readonly description?: string;
  readonly tags?: ReadonlyArray<string>;
}

/** Whether something installed already does what `query` asks (ruling P2): one
 *  of the installed search's matches holds the request's subject, as words.
 *
 *  ⛔ NOT "the installed search matched something". That search
 *  (`searchToolCatalog`) counts a word found as letters anywhere, which suits
 *  finding tools and not this: on a new server, "rent collection tracking sheet"
 *  matched Open commitments ("rent" in "for the cur*rent* view"), and four of six
 *  requests only the marketplace serves were matched by something installed, so
 *  none of the four was offered anything (measured 2026-10-12, spec §3a).
 *  ⛔ And not the catalogue's own rule either: an installed recipe is described
 *  in its own words, not the model's. The installed Today recipe never says
 *  "daily briefing schedule", and with that rule chat offered a Todoist digest
 *  beside it. It does say "today", the subject. */
export const installedHoldsRequest = (
  catalogue: MarketplaceCatalogueSnapshot,
  query: string,
  installed: ReadonlyArray<InstalledMatchText>,
): boolean => {
  if (installed.length === 0) return false;
  const need = needOf(catalogue, query);
  if (need === null) return false;
  return installed.some((entry) => {
    const words = new Set([
      ...capabilityWords(entry.name),
      ...capabilityWords(entry.description ?? ''),
      ...(entry.tags ?? []).flatMap(capabilityWords),
    ]);
    return need.subject.every((q) => hits(words, q));
  });
};

/** The pack a recipe row names: `<publisher>/<slug>` → `<slug>`. */
const bundlePackSlug = (row: CatalogueRecipeRow): string | null => {
  const bundle = row.recipe_bundle;
  if (bundle === undefined || bundle.length === 0) return null;
  const slash = bundle.lastIndexOf('/');
  const slug = slash === -1 ? bundle : bundle.slice(slash + 1);
  return slug.length > 0 ? slug : null;
};

export interface InstalledState {
  /** Every installed pack, bundled and from the marketplace (`listInstalledPacks`). */
  readonly packSlugs: ReadonlySet<string>;
  /** Whether a recipe is installed on this server (the recipe store's `get`). */
  readonly hasRecipe: (recipe_id: string) => boolean;
}

interface Candidate {
  readonly offer: Omit<InstallOffer, 'recipes'>;
  readonly weight: number;
  /** Recipe names, best first. */
  readonly recipes: ReadonlyArray<string>;
}

/** The offers for `query`: at most {@link INSTALL_OFFER_LIMIT}, best first.
 *  Empty when the query has no capability words, or nothing matches. */
export const matchInstallOffers = (
  catalogue: MarketplaceCatalogueSnapshot,
  query: string,
  installed: InstalledState,
): InstallOffer[] => {
  const need = needOf(catalogue, query);
  if (need === null) return [];

  // Each pack's recipes, from the rows that name it.
  const members = new Map<string, CatalogueRecipeRow[]>();
  for (const recipe of catalogue.recipes) {
    const slug = bundlePackSlug(recipe);
    if (slug === null) continue;
    const list = members.get(slug);
    if (list === undefined) members.set(slug, [recipe]);
    else list.push(recipe);
  }

  const candidates: Candidate[] = [];

  for (const pack of catalogue.packs) {
    if (!pack.publisher_certified || installed.packSlugs.has(pack.slug)) continue;
    const recipes = (members.get(pack.slug) ?? []).filter((recipe) => !installed.hasRecipe(recipe.recipe_id));
    const scored = recipes.map((recipe) => ({
      name: recipe.name,
      weight: scoreAll(wordsOf(recipe.name, recipe.recipe_id, recipe.tags), need),
      held: wordsInName(recipe.name, need.words),
    }));
    // A pack matches when one of its recipes holds the request, or when its own
    // words and its recipes' names do together and one word is its own. Without
    // that last clause "booking reminder" found Month-end closer ("Book bank
    // lines", "Month-end reminder"); with it applied to a single recipe too,
    // "quote release" lost Reception approval's "Release a customer-accepted quote".
    const own = wordsOf(pack.name, pack.slug, pack.tags);
    const best = Math.max(-1, ...scored.map((recipe) => recipe.weight ?? -1));
    let weight: number | null = best >= 0 ? best : null;
    if (weight === null && need.words.some((q) => hits(own.name, q) || hits(own.slug, q) || hits(own.tags, q))) {
      weight = scoreAll({ ...own, members: wordsOf('', '', [], recipes.map((recipe) => recipe.name)).members }, need);
    } else if (weight !== null) {
      weight = Math.max(weight, scoreAll(own, need) ?? -1);
    }
    if (weight === null) continue;
    // The recipes it names: those that hold the request, else those that hold most of its words.
    const named = scored
      .filter((recipe) => recipe.weight !== null || recipe.held > 0)
      .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1) || b.held - a.held || a.name.localeCompare(b.name))
      .slice(0, INSTALL_OFFER_RECIPE_NAMES_LIMIT)
      .map((recipe) => recipe.name);
    candidates.push({
      offer: { kind: 'pack', slug: pack.slug, name: pack.name, publisher: pack.publisher_id },
      weight,
      recipes: named,
    });
  }

  for (const recipe of catalogue.recipes) {
    if (!recipe.publisher_certified || bundlePackSlug(recipe) !== null) continue;
    if (installed.hasRecipe(recipe.recipe_id)) continue;
    const weight = scoreAll(wordsOf(recipe.name, recipe.recipe_id, recipe.tags), need);
    if (weight === null) continue;
    candidates.push({
      offer: { kind: 'recipe', slug: recipe.recipe_id, name: recipe.name, publisher: recipe.publisher_id },
      weight,
      recipes: [recipe.name],
    });
  }

  // A one-recipe pack whose recipe also installs alone (`meeting-notes-to-action`
  // is both) would be offered twice under one name. Keep the pack, which is
  // how the marketplace lists it, and let it name the recipe.
  const packs = new Map(candidates.filter((c) => c.offer.kind === 'pack').map((c) => [c.offer.slug, c]));
  const offers = candidates.flatMap((candidate): Candidate[] => {
    if (candidate.offer.kind !== 'recipe') return [candidate];
    const pack = packs.get(candidate.offer.slug);
    if (pack === undefined) return [candidate];
    packs.set(pack.offer.slug, {
      ...pack,
      weight: Math.max(pack.weight, candidate.weight),
      recipes: pack.recipes.length > 0 ? pack.recipes : candidate.recipes,
    });
    return [];
  }).map((candidate) => (candidate.offer.kind === 'pack' ? packs.get(candidate.offer.slug)! : candidate));

  return offers
    .sort((a, b) => b.weight - a.weight
      || a.offer.name.length - b.offer.name.length
      || a.offer.slug.localeCompare(b.offer.slug))
    .slice(0, INSTALL_OFFER_LIMIT)
    .map((candidate): InstallOffer => ({ ...candidate.offer, recipes: candidate.recipes }));
};
