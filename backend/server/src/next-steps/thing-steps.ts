/** D-404 slice A (2026-11-18) — the step under a chat answer when a search of the owner's things
 *  found none of a type they have none of: "No Passport in Yours yet." and a link to Yours' form
 *  with that type chosen (`ChatFix` kind `thing`). The owner's ruling (P1): D-339 slice 12d's
 *  next step, built for every type of thing, not the Body alone.
 *
 *  🔑 THE SERVER NAMES THE TYPE, NEVER THE MODEL'S TEXT. The search's query is matched against the
 *  type registry (each type's own name, and a built-in type's other names), and the owner's own
 *  things are counted by type. The model decides only that it searched, as D-323's offers come
 *  from a search the model chose to make.
 *
 *  ⛔ NONE MEANS NONE BY TYPE AND NONE BY NAME. A thing of any type with that name is one (a pack's
 *  Passport beside the built-in Passport), and so is an untyped thing a search by the type's name
 *  finds ("Anna's passport"). Either one, and nothing is offered: an offer to add what the owner
 *  already has reads as Recued not knowing their things.
 *
 *  ⛔ THE MODEL IS TOLD IN THE RESULT IT READS, AND ONLY THE MODEL IS. The sentence goes in the
 *  search result's `hint`; the step beside it (`fixes`) is for the answer, which the model never
 *  reads. Without the sentence a model can say "I've added it" for a link it cannot press.
 *
 *  Only on the owner's own turns (`ownerCatalogGuard`, the guard D-323's offers use). The MCP
 *  surface reads the registry this wraps, so an AI app never meets it. */

import {
  CHAT_FIX_LIMIT,
  INSTALL_OFFER_LIMIT,
  PURSUIT_CLASS_ID,
  chatFixesOf,
  chatHintKeyOfFix,
  chatHintKeyOfOffer,
  installOffersOf,
  sourceStepWords,
  thingPageSetupOf,
  getKernelOp,
  thingStepWords,
  type InstallOffer,
  type AssetClassPreset,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ChatFix,
  type ExecutionSource,
  type InternalToolRegistry,
} from '@recued/contracts';

import type Database from 'better-sqlite3';

import { TOOLS_SEARCH_TOOL_NAME } from '../chat-tools-search-name.js';
import { assetTypes } from '../situations/asset-types.js';
import { ASSET_TABLE } from '../storage/work-entity-store.js';
import { capabilityWords, foldWordForm } from '../install-offers/match.js';
import { forwardedRegistryHooks } from '../registry-forwarding.js';
import type { CarriedHintKeys } from './carried-hints.js';

/** The search a step follows: the owner's things, `kind: 'asset'`. */
export const THING_SEARCH_TOOL = 'work.search';

/** A built-in type's other names, and the words that make the name mean something else.
 *  `also`: phrases, each matched when every one of its words is in the query ("car" for Vehicle).
 *  `not`: a word that, in the query, means it is not this type ("visa card").
 *  Keyed by the built-in type's id; a type of the same name (a pack's Passport) shares them. Every
 *  key is a built-in id: the test pins it, since a mistyped key would match nothing, silently. */
export const BUILT_IN_TYPE_WORDS: Readonly<Record<string, { readonly also?: readonly string[]; readonly not?: readonly string[] }>> = {
  id_card: { also: ['identity card'] },
  visa: { not: ['card', 'credit', 'debit'] },
  driving_licence: { also: ['driving license', 'driver license', 'driver licence'] },
  insurance_policy: { also: ['insurance'] },
  service_contract: { also: ['subscription'] },
  vehicle: { also: ['car', 'van', 'motorbike', 'motorcycle', 'truck'] },
  smoke_alarm: { also: ['smoke alarm', 'co alarm', 'carbon monoxide alarm', 'smoke detector', 'carbon monoxide detector'] },
  warranty_purchase: { also: ['warranty'] },
  home: { also: ['house', 'apartment'], not: ['assistant'] },
  heirloom: { also: ['heirloom', 'keepsake'] },
};

/** Types never offered: a pursuit is added on its own tab (D-342). */
const NEVER_OFFERED: ReadonlySet<string> = new Set([PURSUIT_CLASS_ID]);

interface Phrase {
  readonly text: string;
  readonly words: readonly string[];
  /** Its type's own name, rather than another name. */
  readonly own: boolean;
  /** D-404 slice D — a reading the type keeps ("sleep" for a Body), not a name for it. */
  readonly reading?: true;
}

/** D-404 slice D — the words of a reading's id that say what it is: its unit and its method dropped
 *  ("sleep_minutes" is sleep, "hrv_rmssd" is hrv, "vo2_max" is vo2). */
const READING_NOISE: ReadonlySet<string> = new Set(['minute', 'minutes', 'hour', 'hours', 'deviation', 'rmssd', 'sdnn', 'max', 'ms', 'pct', 'percent']);
const readingPhrases = (type: AssetClassPreset): Phrase[] => Object.keys(type.fields.readings ?? {}).flatMap((field) => {
  const text = field.split('_').filter((word) => word.length > 0 && !READING_NOISE.has(word)).join(' ');
  const words = capabilityWords(text);
  return words.length === 0 ? [] : [{ text, words, own: false, reading: true as const }];
});

/** Every type of one name: they are one kind of thing to the owner. */
interface TypeGroup {
  readonly name: string;
  readonly types: AssetClassPreset[];
  readonly phrases: Phrase[];
  readonly not: Set<string>;
}

/** The owner's own type of that name, then an installed pack's, then the built-in one: a pack's
 *  carries more (Travel documents' Passport checks booked trips), and the owner's own is theirs. */
const rank = (type: AssetClassPreset): number =>
  type.origin === 'owner' ? 0 : type.origin.startsWith('pack:') ? 1 : 2;

const groupsOf = (types: readonly AssetClassPreset[]): TypeGroup[] => {
  const groups = new Map<string, TypeGroup>();
  for (const type of types) {
    if (NEVER_OFFERED.has(type.id)) continue;
    const name = type.name.trim();
    const words = capabilityWords(name);
    if (words.length === 0) continue;
    const key = words.join(' ');
    let group = groups.get(key);
    if (group === undefined) {
      group = { name, types: [], phrases: [{ text: name, words, own: true }], not: new Set() };
      groups.set(key, group);
    }
    group.types.push(type);
    const extra = type.origin === 'builtin' && Object.hasOwn(BUILT_IN_TYPE_WORDS, type.id)
      ? BUILT_IN_TYPE_WORDS[type.id]!
      : undefined;
    for (const phrase of extra?.also ?? []) group.phrases.push({ text: phrase, words: capabilityWords(phrase), own: false });
    for (const word of extra?.not ?? []) group.not.add(foldWordForm(word.toLowerCase()));
    for (const phrase of readingPhrases(type)) {
      if (!group.phrases.some((held) => held.text === phrase.text)) group.phrases.push(phrase);
    }
  }
  return [...groups.values()];
};

/** D-404 slice B1 — the ids of every type with the same name as `typeId`'s (itself included), as
 *  "does the owner have one" counts them: a pack's Passport is a passport. Empty for an unknown type. */
export const typeIdsNamedLike = (typeId: string, types: readonly AssetClassPreset[]): string[] => {
  const type = types.find((candidate) => candidate.id === typeId);
  if (type === undefined) return [];
  const key = capabilityWords(type.name).join(' ');
  return types.filter((candidate) => capabilityWords(candidate.name).join(' ') === key).map((candidate) => candidate.id);
};

/** D-404 slice E — the types a recipe fills itself: a step that creates a thing of the type, as
 *  Paperless's sync creates its documents. The owner is never told to add one of those by hand.
 *  ⛔ BOTH FORMS: the recipe as written (`op: core.work-entity.asset.create`, `args.class_id`) and as
 *  the server stores it once installed (`ingredient: 'asset-create'`, `input.class_id`). Found live
 *  (2026-11-19): read against the JSON only, Paperless asked for a "Document with an expiry date". */
export const typesARecipeCreates = (recipe: unknown, types: readonly AssetClassPreset[]): string[] => {
  if (!isRecord(recipe) || !Array.isArray(recipe.steps)) return [];
  const known = new Set(types.map((type) => type.id));
  return recipe.steps.flatMap((step) => {
    if (!isRecord(step)) return [];
    // As `stepDispatch` (`packages/recipes/src/step-dispatch.ts`) reads a step: an op by the
    // ingredient the kernel registry backs it with, an ingredient by its slug, `core-` stripped.
    const slug = typeof step.ingredient === 'string' ? step.ingredient
      : typeof step.op === 'string' ? getKernelOp(step.op)?.backing_slug : undefined;
    const into = slug?.replace(/^core-/u, '') === 'asset-create' ? (typeof step.ingredient === 'string' ? step.input : step.args) : undefined;
    return isRecord(into) && typeof into.class_id === 'string' && known.has(into.class_id) ? [into.class_id] : [];
  });
};

/** D-404 — the owner's things by type, read from the asset table. */
export const createThingTypeQueries = (db: Database.Database) => {
  const anyOf = (typeIds: readonly string[], states: string): boolean => typeIds.length > 0
    && db.prepare(`SELECT 1 FROM ${ASSET_TABLE} WHERE class_id IN (${typeIds.map(() => '?').join(',')})
      AND deleted_at IS NULL${states} LIMIT 1`).get(...typeIds) !== undefined;
  /** One the owner has in use (active or lent): what makes chat's "Add a Passport" land. */
  const hasThingOfTypes = (typeIds: readonly string[]): boolean => anyOf(typeIds, " AND status IN ('active','lent')");
  /** The types an installed pack is for, when the owner has nothing in Yours of any of them, so the
   *  pack has nothing to work on: those its recipes act on (`typesARecipeActsOn`), or, for a pack
   *  that ships no recipes (Travel documents), every type it ships; never one a recipe of it creates
   *  (`typesARecipeCreates`) or a pursuit. "In Yours" is any thing not deleted, retired or sold
   *  included, so the page's "No Passport in Yours yet" is never false; one of the same name counts
   *  (a built-in Passport for the pack's). Empty once the owner has one of any of them: a Travel
   *  documents with a passport works, and is not asked for a visa. */
  const packMissingThings = (pack: { publisher: string; slug: string; recipes: readonly unknown[]; ships_recipes: boolean }):
    Array<{ type_id: string; type_name: string }> => {
    const all = assetTypes(db).list();
    const created = new Set(pack.recipes.flatMap((recipe) => typesARecipeCreates(recipe, all)));
    const forPack = (pack.ships_recipes
      ? [...new Map(pack.recipes.flatMap((recipe) => typesARecipeActsOn(recipe, all)).map((type) => [type.id, type])).values()]
      : all.filter((type) => type.origin === `pack:${pack.publisher}/${pack.slug}`))
      .filter((type) => !NEVER_OFFERED.has(type.id) && !created.has(type.id));
    if (forPack.some((type) => anyOf(typeIdsNamedLike(type.id, all), ''))) return [];
    return forPack.map((type) => ({ type_id: type.id, type_name: type.name.trim() }));
  };
  return { hasThingOfTypes, packMissingThings };
};

/** A type the query names, with the phrase that named it and the type a link would open. */
export interface NamedThingType {
  readonly name: string;
  readonly type: AssetClassPreset;
  /** Every type of that name, for "does the owner have one". */
  readonly type_ids: readonly string[];
  /** The words that named it, to search the owner's things by. */
  readonly phrase: string;
  /** The query held nothing but those words, so its own search already searched by them. */
  readonly whole_query: boolean;
  /** D-404 slice D — named by a reading it keeps ("sleep"), not by a name: the reading. */
  readonly reading?: string;
}

/** The types `query` names: every word of a type's name in it, or of one of a built-in type's
 *  other names, and none of the words that make it something else. An other name the query uses
 *  for a type it names by its own name is left out ("car", when the owner has a type called Car).
 *  In the order the registry lists them. */
export const typesNamedBy = (query: string, types: readonly AssetClassPreset[]): NamedThingType[] => {
  const queryWords = new Set(capabilityWords(query));
  if (queryWords.size === 0) return [];
  const hit = (phrase: Phrase): boolean => phrase.words.length > 0 && phrase.words.every((word) => queryWords.has(word));
  const matched: Array<{ readonly group: TypeGroup; readonly phrase: Phrase }> = [];
  const groups = groupsOf(types).filter((group) => ![...group.not].some((word) => queryWords.has(word)));
  for (const group of groups) {
    const phrase = group.phrases.find((candidate) => candidate.own && hit(candidate))
      ?? group.phrases.find((candidate) => !candidate.own && candidate.reading !== true && hit(candidate));
    if (phrase !== undefined) matched.push({ group, phrase });
  }
  // D-404 slice D — a reading names a type only when nothing in the query names one: "how did I
  // sleep" is about a Body, "the battery of my smoke alarm" is about the alarm, not every type
  // with a battery.
  if (matched.length === 0) {
    for (const group of groups) {
      const phrase = group.phrases.find((candidate) => candidate.reading === true && hit(candidate));
      if (phrase !== undefined) matched.push({ group, phrase });
    }
  }
  const ownWords = new Set(matched.filter((entry) => entry.phrase.own).flatMap((entry) => entry.phrase.words));
  return matched
    .filter((entry) => entry.phrase.own || !entry.phrase.words.every((word) => ownWords.has(word)))
    .map(({ group, phrase }) => ({
      name: group.name,
      type: [...group.types].sort((a, b) => rank(a) - rank(b))[0]!,
      type_ids: group.types.map((type) => type.id),
      // A reading searches the owner's things by the type's name: a thing called "sleep" is not a Body.
      phrase: phrase.reading === true ? group.name : phrase.text,
      whole_query: phrase.reading !== true && phrase.words.length === queryWords.size && phrase.words.every((word) => queryWords.has(word)),
      ...(phrase.reading === true ? { reading: phrase.text } : {}),
    }));
};

/** D-404 slice D — the types a recipe acts on: a setting that takes a thing (`page_binding.kind:
 *  'asset'`), and the type a step checks a thing against (`{{step.<id>.entity.class_id}} equal
 *  <type>`), else every type its pack ships. None for a recipe that takes no thing. Read from the
 *  recipe as installed, never from the model's words. */
export const typesARecipeActsOn = (recipe: unknown, types: readonly AssetClassPreset[]): AssetClassPreset[] => {
  if (!isRecord(recipe)) return [];
  const variables = isRecord(recipe.variables) ? recipe.variables : {};
  const settings = Object.entries(variables)
    .filter(([, value]) => isRecord(value) && isRecord(value.page_binding) && value.page_binding.kind === 'asset')
    .map(([key]) => key);
  if (settings.length === 0) return [];
  const steps = Array.isArray(recipe.steps) ? recipe.steps.filter(isRecord) : [];
  // ⛔ ANY STEP'S CHECK, NOT ONLY ONE ON THE GET OF THAT SETTING. Live (2026-11-18), the installed
  // copy of "How someone has slept" did not match the first cut, which also required its get step
  // as the JSON writes it; it fell back to every type its pack ships (a Body and a Wearable).
  const known = new Set(types.map((type) => type.id));
  const checked = steps.flatMap((step) => step.transform === 'compare' && step.operator === 'equal'
    && typeof step.left === 'string' && /^\{\{\s*step\.[A-Za-z0-9_]+\.entity\.class_id\s*\}\}$/u.test(step.left)
    && typeof step.right === 'string' && known.has(step.right) ? [step.right] : []);
  if (checked.length > 0) return types.filter((type) => checked.includes(type.id));
  const bundle = isRecord(recipe.metadata) ? recipe.metadata.recipe_bundle : undefined;
  return typeof bundle === 'string' ? types.filter((type) => type.origin === `pack:${bundle}`) : [];
};

const quoted = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** What the model reads after the search's own words, once its steps are under the answer. The
 *  names are the types' own, quoted as data; the links as the owner sees them. */
export const thingStepsSentence = (names: readonly string[]): string => {
  const one = names.length === 1;
  const links = names.map((name) => `"${thingStepWords(name).link}"`);
  return `${one ? `No ${names[0]} is` : `None of ${quoted(names)} is`} in Yours yet. The owner can add `
    + `${one ? 'one' : 'each'} in Yours, under Assets, with Create asset; in the app, `
    + `${one ? `the link ${links[0]}` : `the links ${quoted(links)}`} under your answer `
    + `${one ? 'opens it' : 'open them'} with the type chosen. If they told you its details, you may offer `
    + 'to add it for them with work.create, which asks them first. Never say it is added until it is.';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The query of a search of the owner's things, or null for any other call. */
const thingSearchQuery = (args: unknown): string | null => {
  if (!isRecord(args) || args.kind !== 'asset' || typeof args.query !== 'string') return null;
  const query = args.query.trim();
  return query.length > 0 ? query : null;
};

/** Whether a search ran and found nothing: `ok`, a total of 0, no entities.
 *
 *  ⛔ A SEARCH THE OWNER'S OWN SWITCH REFUSED DID NOT RUN. It answers with the same empty list (the
 *  guided empty, D-205), a sentence saying the read is off, and that switch as a fix. "No Passport
 *  in Yours" there would tell the model a fact about the owner's things that the owner switched off
 *  for their chats. So a result carrying any fix, or marked refused, found nothing only in form. */
const foundNothing = (result: ChatDispatchResult): boolean => {
  if (!result.ok || !isRecord(result.result)) return false;
  if ((result.fixes?.length ?? 0) > 0 || result.result.refused === true) return false;
  const entities = result.result.entities;
  return result.result.total === 0 && (entities === undefined || (Array.isArray(entities) && entities.length === 0));
};

/** D-404 step 4 — one of the owner's things of a type: its name, and whether it has any reading yet. */
export interface ThingReadings {
  readonly id: string;
  readonly name: string;
  readonly has_readings: boolean;
}

/** D-404 step 4 — a pack that feeds a type's readings (it extends the type's own pack), and whether
 *  it is installed. */
export interface FeedingPack {
  readonly slug: string;
  readonly name: string;
  readonly publisher: string;
  readonly installed: boolean;
}

export interface ThingStepsDeps {
  /** D-404 step 4 — the owner's things (active or lent) of any of these types. Absent: no step 4. */
  readonly thingsOfTypes?: (typeIds: readonly string[]) => ReadonlyArray<ThingReadings>;
  /** D-404 step 4 — the certified packs extending this pack, from the catalogue copy; a pack not
   *  installed only while the owner lets chat suggest packs. Absent: no step 4. */
  readonly feedingPacks?: (packSlug: string) => Promise<ReadonlyArray<FeedingPack>>;
  /** D-404 slice D — the installed recipe a `tools.search` match names (`<publisher>/<recipe_id>`),
   *  or null. Absent: an installed recipe that acts on a thing offers nothing. */
  readonly recipeForTool?: (toolName: string) => unknown;
  /** Every type of thing the server knows, read per call. Absent or failing: no step. */
  readonly types: () => readonly AssetClassPreset[];
  /** Whether the owner has a thing (active or lent) of any of these types. */
  readonly hasThingOfTypes: (typeIds: readonly string[]) => boolean;
  /** `tools.search`'s guard (`createChatOwnerCatalogGuard`): it throws for a source the owner does
   *  not govern. The same one D-323's offers use, so both answer "is this the owner's turn" alike. */
  readonly ownerCatalogGuard?: (source?: ExecutionSource) => void;
  /** D-405 slice 3 — whether the owner said "Not now" to this hint (`chatHintKeyOfFix` / `chatHintKeyOfOffer`).
   *  A hidden step is left out whole: its row, and the sentence the model reads about it. */
  readonly hidden?: (key: string) => boolean;
  /** D-405 slice 8 — the hint keys earlier answers of the call's conversation carried
   *  (`next-steps/carried-hints.ts`): each is left out as a hidden one is, never the same step twice in one
   *  conversation (ruling P3). Absent, or failing: none left out. */
  readonly carried?: CarriedHintKeys;
}

/** D-405 slice 8 — the deps for one call: a step an earlier answer of its conversation carried is left
 *  out with the ones the owner set aside, its row and its sentence together. */
const withCarried = async (deps: ThingStepsDeps, ctx: ChatDispatchContext): Promise<ThingStepsDeps> => {
  const carried = deps.carried === undefined ? undefined : await deps.carried(ctx).catch(() => undefined);
  if (carried === undefined || carried.size === 0) return deps;
  return { ...deps, hidden: (key) => deps.hidden?.(key) === true || carried.has(key) };
};

/** D-405 slice 3 — whether the owner set this step aside. */
const hiddenFix = (deps: ThingStepsDeps, fix: ChatFix): boolean => {
  const key = chatHintKeyOfFix(fix);
  return key !== null && deps.hidden?.(key) === true;
};

/** D-404 step 4 — what the model reads when the owner has the thing but none of theirs has a reading
 *  yet: what feeds them, and where. The thing's and the pack's names are data. D-339 slice 23: a pack set up
 *  on the thing's own page (`thingPageSetup`, that button's words) is set up there, not on its page. */
export const readingSourceSentence = (thing: string, packs: readonly string[], installed: boolean, thingPageSetup?: string): string => installed
  ? `${thing} has no readings yet. ${packs[0]} is installed and sends them once it is set up: the owner sees `
    + `"${sourceStepWords(thing, packs[0] ?? '', thingPageSetup).link}" under your answer, which opens `
    + `${thingPageSetup === undefined ? 'its page' : 'its setup in Yours'}. Say this first. `
    + 'Never say it is set up until it is.'
  : `${thing} has no readings yet. They come from ${quoted(packs)}, which ${packs.length === 1 ? 'is' : 'are'} not installed: `
    + `the owner sees ${packs.length === 1 ? 'it' : 'each'} as a link under your answer, installs it there, then sets it up. `
    + 'Say this first. Never say it is installed or set up until it is.';

interface SourceStep {
  readonly fix?: ChatFix;
  readonly offers?: InstallOffer[];
  readonly sentence: string;
}

/** D-404 step 4 — the step for a type the owner has things of, none with a reading: the installed pack
 *  that feeds them (set it up), else the ones that would (install). None for a type that keeps no
 *  readings, a built-in type (no pack feeds it), or when any of the owner's things has a reading. */
const readingSourceStep = async (
  deps: ThingStepsDeps,
  type: AssetClassPreset,
  typeIds: readonly string[],
): Promise<SourceStep | null> => {
  if (deps.thingsOfTypes === undefined || deps.feedingPacks === undefined) return null;
  if (Object.keys(type.fields.readings ?? {}).length === 0) return null;
  const pack = /^pack:[^/]+\/(.+)$/u.exec(type.origin)?.[1];
  if (pack === undefined) return null;
  const things = deps.thingsOfTypes(typeIds);
  if (things.length === 0 || things.some((thing) => thing.has_readings)) return null;
  const feeding = await deps.feedingPacks(pack);
  const thing = things[0]!.name;
  const installed = feeding.find((candidate) => candidate.installed);
  if (installed !== undefined) {
    // D-339 slice 23 — the thing named, by its id: a pack set up on its page (a Body's Connect Apple Health) opens it.
    const fix: ChatFix = { kind: 'source', thing_name: thing, pack_slug: installed.slug, pack_name: installed.name, thing_id: things[0]!.id };
    return hiddenFix(deps, fix) ? null : { fix, sentence: readingSourceSentence(thing, [installed.name], true, thingPageSetupOf(fix)) };
  }
  const offers = installOffersOf(feeding
    .filter((candidate) => deps.hidden?.(chatHintKeyOfOffer({ kind: 'pack', slug: candidate.slug })) !== true)
    .slice(0, INSTALL_OFFER_LIMIT)
    .map((candidate) => ({ kind: 'pack', slug: candidate.slug, name: candidate.name, publisher: candidate.publisher, recipes: [] })));
  return offers.length === 0 ? null : { offers, sentence: readingSourceSentence(thing, offers.map((offer) => offer.name), false) };
};

/** The steps for one empty search of the owner's things, and the result the model reads. */
const withThingSteps = async (
  inner: InternalToolRegistry,
  deps: ThingStepsDeps,
  query: string,
  result: ChatDispatchResult,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult> => {
  if (!result.ok || !isRecord(result.result)) return result;
  const steps: ChatFix[] = [];
  const sources: SourceStep[] = [];
  for (const named of typesNamedBy(query, deps.types())) {
    if (steps.length + sources.length >= CHAT_FIX_LIMIT) break;
    if (deps.hasThingOfTypes(named.type_ids)) {
      // D-404 step 4 — the owner has one, and none of theirs has a reading yet: what feeds them.
      const source = await readingSourceStep(deps, named.type, named.type_ids);
      if (source !== null) sources.push(source);
      continue;
    }
    if (!named.whole_query) {
      // The query held more than the type's words ("passport expiry"), so a passport whose text
      // lacks "expiry" was not found by it. Searched again by the type's words alone.
      const again = await inner.dispatch(THING_SEARCH_TOOL, { kind: 'asset', query: named.phrase }, ctx);
      if (!again.ok || !foundNothing(again)) continue;
    }
    const step: ChatFix = { kind: 'thing', type_id: named.type.id, type_name: named.name };
    if (!hiddenFix(deps, step)) steps.push(step);
  }
  const checked = chatFixesOf(steps);
  if (checked.length === 0 && sources.length === 0) return result;
  const sentences = [
    ...(checked.length > 0 ? [thingStepsSentence(checked.map((step) => (step.kind === 'thing' ? step.type_name : '')))] : []),
    ...sources.map((source) => source.sentence),
  ].join(' ');
  const hint = result.result.hint;
  const fixes = chatFixesOf([...checked, ...sources.flatMap((source) => (source.fix !== undefined ? [source.fix] : []))]);
  const offers = installOffersOf(sources.flatMap((source) => source.offers ?? []));
  return {
    ...result,
    result: { ...result.result, hint: typeof hint === 'string' && hint.length > 0 ? `${hint} ${sentences}` : sentences },
    ...(fixes.length > 0 ? { fixes } : {}),
    // A non-search call's offers are D-323's "needed" offers: the answer shows them first.
    ...(offers.length > 0 ? { install_offers: offers } : {}),
  };
};

/** D-404 slice D — what the model reads when a capability search needs a thing the owner has none of:
 *  what cannot work until there is one, where it is added, and that it comes before anything to
 *  install (the ladder's next step). `what` is a reading ("sleep") or a recipe's own name. */
export const thingFirstSentence = (steps: ReadonlyArray<{ readonly name: string; readonly what: string }>): string => {
  const needs = steps.map((step) => `Nothing can work on ${step.what} for the owner until they have ${articledName(step.name)} in Yours, and there is none yet.`);
  const links = steps.map((step) => `"${thingStepWords(step.name).link}"`);
  return `${needs.join(' ')} The owner adds ${steps.length === 1 ? 'one' : 'each'} in Yours, under Assets, with Create asset; in the app, `
    + `${steps.length === 1 ? `the link ${links[0]}` : `the links ${quoted(links)}`} under your answer `
    + `${steps.length === 1 ? 'opens it' : 'open them'} with the type chosen. Say this first, before anything to install. `
    + 'Never say it is added until it is.';
};
/** "a Body", "an ID card": the link's own article, without its "Add". */
const articledName = (name: string): string => thingStepWords(name).link.replace(/^Add /u, '');

/** D-404 slice D — the steps for a capability search (`tools.search`): a type the request names by a
 *  reading it keeps ("sleep": a Body) when the search offers a pack extending the type's own, and
 *  the types an installed recipe it found acts on, each one
 *  the owner has none of (by type, and by a search of its name). Not a type it names by name: a
 *  search for what can be done about a passport is not the owner looking for theirs. */
const withToolSearchThingSteps = async (
  inner: InternalToolRegistry,
  deps: ThingStepsDeps,
  query: string,
  result: ChatDispatchResult,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult> => {
  if (!result.ok || !isRecord(result.result)) return result;
  const types = deps.types();
  const wanted = new Map<string, { readonly type: AssetClassPreset; readonly type_ids: readonly string[]; readonly what: string }>();
  // ⛔ A reading alone is too common a word here ("distance", "weight", "steps"): a capability search
  // for "distance between two cities" is not about a Body. So a reading names a type only when the
  // search offers a pack that extends the pack shipping it (`body-signals-apple-health` extends
  // `body-signals`): then the request is about that pack's thing, and the thing comes before its source.
  const offered = Array.isArray(result.result.installable)
    ? result.result.installable.filter(isRecord).flatMap((offer) => (offer.kind === 'pack' && typeof offer.slug === 'string' ? [offer.slug] : []))
    : [];
  const extendsPackOf = (type: AssetClassPreset): boolean => {
    const pack = /^pack:[^/]+\/(.+)$/u.exec(type.origin)?.[1];
    return pack !== undefined && offered.some((slug) => slug.startsWith(`${pack}-`));
  };
  for (const named of typesNamedBy(query, types)) {
    if (named.reading === undefined || wanted.has(named.name)) continue;
    if (!types.filter((type) => named.type_ids.includes(type.id)).some(extendsPackOf)) continue;
    wanted.set(named.name, { type: named.type, type_ids: named.type_ids, what: named.reading });
  }
  const matches = Array.isArray(result.result.matches) ? result.result.matches.filter(isRecord) : [];
  for (const match of matches) {
    if (typeof match.recipe_slug !== 'string' || deps.recipeForTool === undefined) continue;
    const recipe = deps.recipeForTool(match.recipe_slug);
    if (!isRecord(recipe)) continue;
    const label = isRecord(recipe.metadata) && typeof recipe.metadata.name === 'string' && recipe.metadata.name.trim() !== ''
      ? `"${recipe.metadata.name.trim()}"` : match.recipe_slug;
    for (const acted of typesARecipeActsOn(recipe, types)) {
      if (NEVER_OFFERED.has(acted.id)) continue;
      const ids = typeIdsNamedLike(acted.id, types);
      const name = acted.name.trim();
      if (wanted.has(name)) continue;
      const best = types.filter((type) => ids.includes(type.id)).sort((a, b) => rank(a) - rank(b))[0] ?? acted;
      wanted.set(name, { type: best, type_ids: ids, what: label });
    }
  }
  const steps: Array<{ readonly fix: ChatFix; readonly name: string; readonly what: string }> = [];
  const sources: SourceStep[] = [];
  for (const [name, want] of wanted) {
    if (steps.length + sources.length >= CHAT_FIX_LIMIT) break;
    if (deps.hasThingOfTypes(want.type_ids)) {
      // D-404 step 4 — the owner has one, and none of theirs has a reading yet: what feeds them.
      const source = await readingSourceStep(deps, want.type, want.type_ids);
      if (source !== null) sources.push(source);
      continue;
    }
    const again = await inner.dispatch(THING_SEARCH_TOOL, { kind: 'asset', query: name }, ctx);
    if (!again.ok || !foundNothing(again)) continue;
    const fix: ChatFix = { kind: 'thing', type_id: want.type.id, type_name: name };
    if (!hiddenFix(deps, fix)) steps.push({ fix, name, what: want.what });
  }
  const checked = chatFixesOf(steps.map((step) => step.fix));
  const said = steps.filter((step) => checked.some((fix) => fix.kind === 'thing' && fix.type_id === (step.fix as { type_id: string }).type_id));
  if (said.length === 0 && sources.length === 0) return result;
  const guidance = result.result.guidance;
  const sentence = [...(said.length > 0 ? [thingFirstSentence(said)] : []), ...sources.map((source) => source.sentence)].join(' ');
  // D-404 step 4 — a feeding pack not installed joins the search's own offers (D-323's `installable`,
  // which the answer shows), each once; one installed is a `source` fix.
  const held = Array.isArray(result.result.installable) ? result.result.installable : [];
  const offers = installOffersOf([...sources.flatMap((source) => source.offers ?? []), ...held]
    .filter((offer, index, all) => all.findIndex((other) => isRecord(other) && isRecord(offer) && other.slug === offer.slug) === index));
  const fixes = chatFixesOf([...(result.fixes ?? []), ...checked, ...sources.flatMap((source) => (source.fix !== undefined ? [source.fix] : []))]);
  return {
    ...result,
    result: { ...result.result, guidance: typeof guidance === 'string' && guidance.length > 0 ? `${sentence} ${guidance}` : sentence,
      ...(offers.length > 0 ? { installable: offers } : {}) },
    ...(fixes.length > 0 ? { fixes } : {}),
  };
};

/** The chat registry, with a step under the answer on every empty search of the owner's things
 *  that names a type they have none of. Chat only. No deps (no asset types on this server): the
 *  registry as it was. A step is an extra: anything that fails leaves the search's answer as it was. */
export const wrapRegistryWithThingSteps = (
  inner: InternalToolRegistry,
  deps: ThingStepsDeps | undefined,
): InternalToolRegistry => {
  if (deps === undefined) return inner;
  const ownerTurn = (ctx: ChatDispatchContext): boolean => {
    try {
      deps.ownerCatalogGuard?.(ctx.execution_source);
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
      if (name === TOOLS_SEARCH_TOOL_NAME) {
        const query = isRecord(args) && typeof args.query === 'string' ? args.query.trim() : '';
        if (query.length === 0 || !ownerTurn(ctx)) return result;
        try {
          return await withToolSearchThingSteps(inner, await withCarried(deps, ctx), query, result, ctx);
        } catch {
          return result;
        }
      }
      if (name !== THING_SEARCH_TOOL) return result;
      const query = thingSearchQuery(args);
      if (query === null || !foundNothing(result) || !ownerTurn(ctx)) return result;
      try {
        return await withThingSteps(inner, await withCarried(deps, ctx), query, result, ctx);
      } catch {
        return result;
      }
    },
  };
};
