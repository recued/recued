/** D-405 slice 6 (2026-11-19) — the row under an answer whose turn searched mail, a calendar or files
 *  with none of the owner's connected: "No mailbox is connected yet." with "Connect your mail".
 *
 *  Slice 2 found the gap from the owner's words only. "What did Anna send me last week?" names no
 *  feature, so it got no row, although the model searched mail and found no mailbox. The row now comes
 *  from that search too.
 *
 *  🔑 THE SEARCH SAYS WHERE THE MODEL LOOKED, THE SERVER'S FACT SAYS WHETHER ANY IS CONNECTED. Whether
 *  one is connected is the fact the Set up page and slice 2 read (`setup-features.ts`), so the three
 *  never disagree. The searches that count:
 *  - `mail.search` that answered with no mailbox (`collections: []`);
 *  - `calendar.search` that answered with none but the server's own calendar (`local`);
 *  - `file.search` over all of the owner's files (`scope: 'all'`), and one of the conversation's own
 *    files (its default scope) while the conversation holds no file the owner sent: slice 2's rule, since
 *    "the file" is then none of theirs. Live, a model asked "Find my lease agreement." searched only the
 *    conversation's (empty) files in 1 of 3 runs and asked whether it was "in a folder on your computer or
 *    a connected service?", with no row under it.
 *  A search the owner's switch refused (`ok: false`) does not count: its own row says how to turn the
 *  switch on.
 *
 *  ⛔ NO LINE FOR THE MODEL. The search's result has already told it: no mailbox (`collections: []`,
 *  which the tool's description reads as none enrolled), only Recued's own calendar
 *  (`calendar_addresses` names its provider "Recued, on this server"), the files it found. A line would
 *  have to be decided before the model answers, but the rules that leave the row out (once per
 *  conversation, one per answer) are decided after it. A line pointing at a link the answer then
 *  lacks is worse than no line. */

import { chatHintKeyOfFix, type ChatFix, type ChatSetupFeature } from '@recued/contracts';

import { DEFAULT_LOCAL_CALENDAR_SLUG } from '../collections/calendar/local-provider.js';

/** A call of the turn, as the turn's result lists it. */
export interface SearchedToolResult {
  readonly tool_name: string;
  readonly args?: unknown;
  readonly result?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The search's own answer, or null for a call that failed or was refused. */
const answerOf = (result: unknown): Record<string, unknown> | null =>
  isRecord(result) && result.ok === true && isRecord(result.result) ? result.result : null;

export interface SearchedFeatureOptions {
  /** Whether the conversation holds a file the owner sent. A search of the conversation's own files counts
   *  only when it does not (`false`); unknown, or absent, it does not count. */
  readonly conversationHoldsFiles?: boolean;
}

/** Whether a file search read only the conversation's own files (its default scope). */
export const isConversationFileSearch = (entry: SearchedToolResult): boolean =>
  entry.tool_name === 'file.search' && !(isRecord(entry.args) && entry.args.scope === 'all');

/** The feature a call searched without reaching any source of the owner's, or null. */
const featureSearchedWithNone = (entry: SearchedToolResult, opts: SearchedFeatureOptions): ChatSetupFeature | null => {
  const answer = answerOf(entry.result);
  if (answer === null) return null;
  const collections = Array.isArray(answer.collections) ? answer.collections : null;
  if (entry.tool_name === 'mail.search') return collections !== null && collections.length === 0 ? 'mail' : null;
  if (entry.tool_name === 'calendar.search') {
    return collections !== null && collections.every((slug) => slug === DEFAULT_LOCAL_CALENDAR_SLUG) ? 'calendar' : null;
  }
  if (entry.tool_name === 'file.search') return !isConversationFileSearch(entry) || opts.conversationHoldsFiles === false ? 'file' : null;
  return null;
};

/** The features the turn's own searches found none of the owner's in, in the order searched, once each. */
export const featuresSearchedWithNone = (
  toolResults: ReadonlyArray<SearchedToolResult> | undefined,
  opts: SearchedFeatureOptions = {},
): ChatSetupFeature[] => {
  const features: ChatSetupFeature[] = [];
  for (const entry of toolResults ?? []) {
    const feature = featureSearchedWithNone(entry, opts);
    if (feature !== null && !features.includes(feature)) features.push(feature);
  }
  return features;
};

/** A step found from the turn's searches: the row's step and its key. No line (see above). */
export interface SearchedFeatureStep {
  readonly fixes: readonly ChatFix[];
  /** The step's key: an earlier answer of the conversation that carried it means none now (P3). */
  readonly key: string;
}

export interface SearchedFeatureDeps {
  /** Slice 2's (`PromptSetupDeps.featureConnected`): whether any of a feature is connected, or null
   *  when the owner's switches do not let chat say. */
  readonly featureConnected: (feature: ChatSetupFeature) => boolean | null | Promise<boolean | null>;
  /** D-405 slice 3 — whether the owner said "Not now" to this hint. */
  readonly hidden?: (key: string) => boolean;
}

/** The step for the first of these features with none connected, the ones set aside left out. */
export const searchedFeatureStep = async (
  features: readonly ChatSetupFeature[],
  deps: SearchedFeatureDeps,
): Promise<SearchedFeatureStep | null> => {
  for (const feature of features) {
    const fix: ChatFix = { kind: 'feature', feature };
    const key = chatHintKeyOfFix(fix)!;
    if (deps.hidden?.(key) === true) continue;
    if ((await deps.featureConnected(feature)) !== false) continue;
    return { fixes: [fix], key };
  }
  return null;
};
