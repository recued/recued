/** D-339 slice 6 (§5.3) — an asset whose `settings.values_on_request` is on (a Body: "AI reads the
 *  numbers only when you allow it") shows a model's general reads the NAMES of its readings and
 *  states, never their values. The prefetch and `situation.query` (through situation access) and
 *  `work.read` / `work.search` (through the work read tool) apply it; the values come from the
 *  pack's `read-body-signals`, whose read always asks the owner.
 *
 *  The one exception is the daily (or weekly) stream's own AI suggestions while that stream's
 *  Include private items is on (D-340 §3.4): the owner chose to have private items named there.
 *
 *  ⛔ A state's TITLE is a value ("Recovery low · Anna's body"), so a state item is left out
 *  whole; its name stays in the list the asset's other items carry.
 *
 *  Slice 13: its dates and details are held the same way. "Ask with the numbers" keeps what the owner
 *  types about the person on the Body (a birth date, a gender) and sends the age, never the birth date;
 *  a general read showing the Body's dates would send the birth date on every turn that names it. The
 *  Body's own conversation and its approvals (`settings.chat_conversation`) are Recued's, not the
 *  model's, and are left out too.
 *
 *  Slice 15: a body goal (a pursuit, D-342 §17) takes its Body's privacy. Held, its reading is named
 *  (`goal`) and its numbers, kept in `settings.goal`, are left out with the rest; no recipe reads them,
 *  so it says that instead (`VALUES_ON_REQUEST_GOAL_HOW`).
 *
 *  Slice 16: a Body's own ranges (`settings.ranges`) are body numbers too: held, they are named
 *  (`ranges`) and left out with the rest.
 *
 *  Slice 12a: the note says what the owner's switch lets the owner's chats do (`chats`): ask first,
 *  read without asking, or nothing, with where to turn it on. Any other caller is told the read asks. */
import { BODY_NUMBERS_TURN_ON_UNDER, type BodyNumbersMode } from '@recued/contracts';
import { ASSET_CHAT_CONVERSATION, BODY_GOAL_SETTING, BODY_RANGES_SETTING, readBodyGoal, readBodyRanges, type Asset, type AssetFactContext, type SituationAssetDetails, type SituationItem, type SituationResult } from '@recued/contracts';

/** What such an asset keeps, by name: its readings, its states, its dates and its details. */
export interface WithheldValues {
  readonly readings: readonly string[];
  readonly states: readonly string[];
  readonly dates?: readonly string[];
  readonly attributes?: readonly string[];
  /** Slice 15 — a body goal's reading, in words. */
  readonly goal?: string;
  /** Slice 16 — the readings the owner set a range for, in words. */
  readonly ranges?: readonly string[];
  /** Slice 12a — for the owner's chats: their switch for a Body's numbers. Absent for any other caller. */
  readonly chats?: BodyNumbersMode;
}

/** What a model is told beside the names: the values are recorded and held, and how to read them.
 *  Without it a model that saw only the names told the owner "there are no sleep readings on file"
 *  (live, 2026-11-14, 2 runs in 2). Named by its title, not its slug: the chat's catalog guidance
 *  forbids a slug no listing or search gave. */
export const VALUES_ON_REQUEST_HOW = 'These values are recorded but held: the owner reads them out only on request. To read them, '
  + 'call "tools.search" for "how someone has slept and recovered, day by day" and run that recipe for this asset; it asks the '
  + 'owner first. Never say a value here is missing or not on file: it is held, not absent.';

/** Slice 12a — to the owner's chats with Body numbers on Allow: the same recipe, which then does not ask. */
export const VALUES_ON_REQUEST_ALLOW_HOW = 'These values are recorded but held out of general reads. To read them, '
  + 'call "tools.search" for "how someone has slept and recovered, day by day" and run that recipe for this asset; the '
  + 'owner lets their chats run it without asking. Never say a value here is missing or not on file: it is held, not absent.';

/** Slice 12a — to the owner's chats with Body numbers Off: nothing reads them, and where the owner turns
 *  them on (the owner, D-346: *"owner deserved to know everything"*). Said once, and only when needed. */
export const VALUES_ON_REQUEST_OFF_HOW = 'These values are recorded but held, and the owner has switched Body numbers off for '
  + 'their chats, so you cannot read them. Only if a request needs them, tell the owner once that you could answer '
  + `better with them, and that they can turn them on under ${BODY_NUMBERS_TURN_ON_UNDER}. Never say a value here is `
  + 'missing or not on file: it is held, not absent.';

/** Slice 15 — said of a held body goal in place of the above: no recipe reads a goal, so the only way its
 *  numbers reach a model is the owner's own message. */
export const VALUES_ON_REQUEST_GOAL_HOW = 'This is a goal on a Body. Its numbers are held, and so are its dates and details: they reach '
  + 'you only when the owner sends them in a message. Never say one is missing or not set: it is held, not absent.';

/** Slice 16 — said beside the rest when a held Body has the owner's own ranges, which no recipe reads. */
export const VALUES_ON_REQUEST_RANGES_HOW = 'Its ranges (the owner\'s own normal for a reading) are held too, and that recipe does not read them: '
  + 'they reach you only when the owner sends them in a message.';

/** A Body's readings in words; another asset's reading is its key with spaces. */
const READING_WORDS: Readonly<Record<string, string>> = {
  sleep_minutes: 'sleep', hrv_rmssd: 'HRV (RMSSD)', hrv_sdnn: 'HRV (SDNN)', resting_heart_rate: 'resting heart rate',
  respiratory_rate: 'respiratory rate', spo2: 'SpO2', skin_temp_deviation: 'skin temperature', steps: 'steps',
  active_energy: 'active energy', weight: 'weight', vo2_max: 'VO2 max',
  // D-339 slice 14 — the rest of what Apple Health sends; any other is its key with spaces.
  blood_pressure_systolic: 'blood pressure (systolic)', blood_pressure_diastolic: 'blood pressure (diastolic)',
  blood_glucose: 'blood sugar', exercise_minutes: 'exercise',
};
export const readingWords = (name: string): string =>
  Object.hasOwn(READING_WORDS, name) ? READING_WORDS[name]! : name.replaceAll('_', ' ');

/** Said too when the asset holds dates or details: that recipe does not read them, so a model asked
 *  "how old is she?" says they are held rather than asking the owner for a run that cannot answer. */
export const VALUES_ON_REQUEST_DETAILS_HOW = 'Its dates and details here (such as a birth date) are held too, and that recipe does not read them: '
  + 'they reach you only when the owner sends them in a message.';

/** The names an asset keeps when it withholds its values, or `undefined` when it does not. */
export const withheldValuesOf = (asset: Pick<Asset, 'settings' | 'readings' | 'rules'> & Partial<Pick<Asset, 'dates' | 'attributes'>> | null | undefined): WithheldValues | undefined => {
  if (asset?.settings?.values_on_request !== true) return undefined;
  const dates = Object.keys(asset.dates ?? {}).map(name => name.replaceAll('_', ' '));
  const attributes = Object.keys(asset.attributes ?? {}).map(name => name.replaceAll('_', ' '));
  const goal = readBodyGoal(asset.settings);
  const ranges = Object.keys(readBodyRanges(asset.settings)).map(readingWords);
  return {
    // D-339 slice 14: a reading with no value yet holds nothing, so it is not named. A Body of type
    // version 2 has every reading Apple Health can send, most of them empty until something sends one.
    readings: Object.entries(asset.readings ?? {}).filter(([, reading]) => reading != null).map(([name]) => readingWords(name)),
    states: (asset.rules ?? []).filter(rule => rule.enabled && rule.reaction?.state === true).map(rule => rule.title),
    ...(dates.length ? { dates } : {}), ...(attributes.length ? { attributes } : {}),
    ...(goal ? { goal: readingWords(goal.reading) } : {}), ...(ranges.length ? { ranges } : {}),
  };
};

/** What a model is told in place of the values: the names, and how they are held. */
export const valuesOnRequestNote = (withheld: WithheldValues): NonNullable<SituationAssetDetails['values_on_request']> => ({
  readings: [...withheld.readings], states: [...withheld.states],
  ...(withheld.dates?.length ? { dates: [...withheld.dates] } : {}),
  ...(withheld.attributes?.length ? { attributes: [...withheld.attributes] } : {}),
  ...(withheld.goal ? { goal: withheld.goal } : {}),
  ...(withheld.ranges?.length ? { ranges: [...withheld.ranges] } : {}),
  how: withheld.goal ? VALUES_ON_REQUEST_GOAL_HOW : [
    withheld.chats === 'off' ? VALUES_ON_REQUEST_OFF_HOW : withheld.chats === 'allow' ? VALUES_ON_REQUEST_ALLOW_HOW : VALUES_ON_REQUEST_HOW,
    // Off, no recipe was named, so the sentences below say only how these reach a model.
    ...(withheld.dates?.length || withheld.attributes?.length
      ? [withheld.chats === 'off' ? VALUES_ON_REQUEST_DETAILS_HOW.replace(', and that recipe does not read them', '') : VALUES_ON_REQUEST_DETAILS_HOW] : []),
    ...(withheld.ranges?.length
      ? [withheld.chats === 'off' ? VALUES_ON_REQUEST_RANGES_HOW.replace(', and that recipe does not read them', '') : VALUES_ON_REQUEST_RANGES_HOW] : [])].join(' '),
});

/** Settings a model never reads from an asset that holds its values: the Body's conversation and the
 *  owner's approvals, and (slice 15) a body goal's numbers. */
export const withoutPrivateSettings = <T extends Record<string, unknown>>(settings: T): T => {
  if (![ASSET_CHAT_CONVERSATION, BODY_GOAL_SETTING, BODY_RANGES_SETTING].some(key => Object.hasOwn(settings, key))) return settings;
  const { [ASSET_CHAT_CONVERSATION]: _kept, [BODY_GOAL_SETTING]: _goal, [BODY_RANGES_SETTING]: _ranges, ...rest } = settings;
  return rest as T;
};

/** An item's details with the values taken out and the names put in. */
export const namesOnlyDetails = (details: SituationAssetDetails, withheld: WithheldValues): SituationAssetDetails => {
  const { readings: _values, dates: _dates, attributes: _attributes, goal: _goal, ranges: _ranges, left_out, settings, ...rest } = details;
  const left = left_out?.filter(name => !name.startsWith('readings.') && !name.startsWith('dates.') && !name.startsWith('attributes.')
    && name !== `settings.${BODY_GOAL_SETTING}` && name !== `settings.${BODY_RANGES_SETTING}`);
  return { ...rest, ...(settings ? { settings: withoutPrivateSettings(settings) } : {}), ...(left?.length ? { left_out: left } : {}),
    values_on_request: valuesOnRequestNote(withheld) };
};

/** A situation result as a model's general read shows it: an asset that withholds its values keeps
 *  their names on its items, and its state items are left out (counted as omitted). */
export const withholdSituationValues = (result: SituationResult, withheldOf: (assetId: string) => WithheldValues | undefined): SituationResult => {
  const cache = new Map<string, WithheldValues | undefined>();
  const of = (item: SituationItem): WithheldValues | undefined => {
    if (item.ref.collection !== 'asset') return undefined;
    if (!cache.has(item.ref.id)) cache.set(item.ref.id, withheldOf(item.ref.id));
    return cache.get(item.ref.id);
  };
  let dropped = 0;
  const clusters = result.clusters.flatMap(cluster => {
    const items = cluster.items.flatMap((item): SituationItem[] => {
      const withheld = of(item);
      if (!withheld) return [item];
      if (item.kind === 'asset_state') { dropped += 1; return []; }
      return [item.details ? { ...item, details: namesOnlyDetails(item.details, withheld) } : item];
    });
    if (!items.length) return [];
    return [{ ...cluster, items, omitted: cluster.omitted + (cluster.items.length - items.length) }];
  });
  const fact_context = result.fact_context ? withholdFactContextValues(result.fact_context, withheldOf) : undefined;
  return { ...result, clusters, omitted: result.omitted + dropped, ...(fact_context ? { fact_context } : {}) };
};

/** A fact-context packet with such an asset's readings, observations, dates and details named, their
 *  values left out (`value_omitted`, the form the packet already uses for a value it cannot carry). */
export const withholdFactContextValues = (packet: AssetFactContext, withheldOf: (assetId: string) => WithheldValues | undefined): AssetFactContext => ({
  ...packet,
  nodes: packet.nodes.map(node => {
    if (node.kind !== 'field' || !['readings', 'observations', 'dates', 'attributes'].includes(node.ref.group)) return node;
    if (!withheldOf(node.ref.asset_id)) return node;
    return { ...node, value: null, value_omitted: true as const };
  }),
});
