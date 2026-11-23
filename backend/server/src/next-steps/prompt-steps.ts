/** D-405 slice 1 — a setup hint from the owner's message itself, found before the model runs (ruling
 *  P1): the type of thing the message names, probed with the search the model would run of the owner's
 *  things. D-404's own wrapper (`thing-steps.ts`) then decides the step exactly as for the model's
 *  search, so its words, its ladder and the owner's switches all hold: a search the owner's switch
 *  refused states nothing. The step is the row under the answer; the model gets one line naming the
 *  type and the link as shown, never a thing's own name (ruling P5: a free-text line is not aliased
 *  the way a record is).
 *
 *  D-405 slice 2 — one of the owner's core features the message asks about with none connected (ruling
 *  P2): no mailbox, no calendar, no file source. A feature asked about comes first: with none connected,
 *  the request cannot be done at all, whatever thing it names. */
import {
  chatFixesOf,
  chatHintKeyOfFix,
  chatHintKeyOfOffer,
  featureStepWords,
  installOffersOf,
  thingPageSetupOf,
  type AssetClassPreset,
  type ChatDispatchResult,
  type ChatFix,
  type ChatSetupFeature,
  type InstallOffer,
} from '@recued/contracts';

import { readingSourceSentence, thingStepsSentence, typesNamedBy } from './thing-steps.js';

/** The owner is asking about their own things: a first-person word. "Does Japan require a visa?" is not
 *  about the owner's visa; "do I need a visa" is (ruling P3). */
const OWN_WORD_RE = /\b(?:i|i'm|i've|i'd|i'll|im|me|my|mine|myself|we|we're|we've|our|ours|us)\b/iu;

/** A reading's irregular forms in a question, read as the reading: "how have I slept" is about sleep
 *  (the word forms D-404 folds are regular ones only). */
const READING_FORMS: Readonly<Record<string, string>> = {
  slept: 'sleep',
  weigh: 'weight',
  weighs: 'weight',
  weighed: 'weight',
  weighing: 'weight',
};

/** D-405 slice 2 — the words that name one of the owner's core features. `words` count wherever they
 *  stand. `nouns` are also verbs, or name something being made rather than something the owner has
 *  ("file my taxes", "mail the cheque", "I'm meeting Anna", "make me a PDF"): each counts only within
 *  two words after a word that makes it one of the owner's ("my mail", "the lease PDF", "my next
 *  meeting"). Never "schedule" (a recipe's schedule) or "event". */
const FEATURE_WORDS: Readonly<Record<ChatSetupFeature, { readonly words: readonly string[]; readonly nouns: readonly string[] }>> = {
  mail: { words: ['email', 'emails', 'emailed', 'e-mail', 'e-mails', 'inbox', 'inboxes', 'mailbox', 'mailboxes', 'gmail'], nouns: ['mail'] },
  calendar: { words: ['calendar', 'calendars', 'agenda', 'meetings', 'appointment', 'appointments'], nouns: ['meeting'] },
  file: { words: ['files', 'folder', 'folders'], nouns: ['file', 'document', 'documents', 'pdf', 'pdfs', 'spreadsheet', 'spreadsheets'] },
};

/** The words that make a feature's noun one of the owner's. Not "a" ("make me a PDF") and not "this"
 *  ("summarize this document": what the owner pasted or sent here). */
const OWNED_BY = new Set(['my', 'our', 'the', 'any', 'all', 'some', 'that', 'those', 'new', 'unread', 'which', 'what']);

/** The core features the message names, each once, in the order it names them. */
export const featuresNamedBy = (message: string): ChatSetupFeature[] => {
  const words = message.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/gu) ?? [];
  const named: Array<{ readonly feature: ChatSetupFeature; readonly at: number }> = [];
  for (const [feature, table] of Object.entries(FEATURE_WORDS) as Array<[ChatSetupFeature, (typeof FEATURE_WORDS)[ChatSetupFeature]]>) {
    const at = words.findIndex((word, i) => table.words.includes(word)
      || (table.nouns.includes(word) && (OWNED_BY.has(words[i - 1] ?? '') || OWNED_BY.has(words[i - 2] ?? ''))));
    if (at >= 0) named.push({ feature, at });
  }
  return named.sort((a, b) => a.at - b.at).map((entry) => entry.feature);
};

/** What a feature with none connected means for the request, in the model's words (the owner is "the
 *  owner", never "you"), and where on the Connections page one is connected (the page's own lane names).
 *  ⛔ Every server has its own calendar (`local`), which Recued writes events to: what is missing is the
 *  owner's own, so their events elsewhere are what cannot be read. ⛔ And it is still read: live (3 runs,
 *  2026-11-19), a line saying only that it was "the only events to read" left one run answering "I can't
 *  check" without reading it, so a meeting added in Recued would have been missed. */
const FEATURE_GAP: Readonly<Record<ChatSetupFeature, { readonly gap: string; readonly lane: string; readonly one: string }>> = {
  mail: { gap: 'No mailbox is connected yet, so there is no mail of the owner\'s to search, and none can be sent for them', lane: 'Mail', one: 'one' },
  calendar: { gap: 'No calendar of the owner\'s is connected yet: the only calendar to read is Recued\'s own on this server, which '
    + 'holds only the events added in Recued. Read it as usual, and say their other calendars cannot be read until one is connected',
  lane: 'Calendar', one: 'one' },
  file: { gap: 'No file source is connected yet, so no folder of the owner\'s files can be searched', lane: 'Files', one: 'a folder' },
};

/** What the model reads when a feature the owner asked about has none connected, with the row's link as
 *  the owner sees it. */
export const featureStepSentence = (feature: ChatSetupFeature): string => {
  const gap = FEATURE_GAP[feature];
  return `${gap.gap}. They connect ${gap.one} in Connections, under ${gap.lane}; `
    + `in the app, the link "${featureStepWords(feature).link}" under your answer opens it. Never say one is connected until it is.`;
};

/** A step found from the message: the row's step, the model's line, and its key. */
export interface PromptSetupStep {
  readonly fixes: readonly ChatFix[];
  readonly offers: readonly InstallOffer[];
  /** One sentence for the model, from the step's own words, naming the type or the feature, never a thing. */
  readonly line: string;
  /** The step's key: an earlier answer of the conversation that carried it means none now (P3). */
  readonly key: string;
}

export interface PromptSetupDeps {
  /** Every type of thing the server knows. */
  readonly types: () => readonly AssetClassPreset[];
  /** `work.search` of the owner's things, as the model's own search runs, D-404's steps included.
   *  Null when the owner's switch does not admit the search. */
  readonly search: (query: string) => Promise<ChatDispatchResult | null>;
  /** D-405 slice 2 — whether any of a core feature is connected (a mailbox, a calendar, a file
   *  source), or null when the owner's switches do not let chat say: chat may not read that feature,
   *  or their "Suggest packs" switch is off (ruling P3). Absent: no feature hints. */
  readonly featureConnected?: (feature: ChatSetupFeature) => boolean | null | Promise<boolean | null>;
  /** D-405 slice 2 — whether the conversation holds a file the owner sent: "the file" is then that
   *  one, not a folder of theirs. Absent: it holds none. */
  readonly conversationHasFiles?: () => boolean | Promise<boolean>;
  /** D-405 slice 3 — whether the owner said "Not now" to this hint. A thing's or a pack's comes through
   *  the search, which leaves it out already; a feature's is asked here. */
  readonly hidden?: (key: string) => boolean;
}

/** D-405 slice 2 — the first core feature the message asks about that has none connected. */
const featureSetupStep = async (message: string, deps: PromptSetupDeps): Promise<PromptSetupStep | null> => {
  if (deps.featureConnected === undefined) return null;
  for (const feature of featuresNamedBy(message)) {
    const fix: ChatFix = { kind: 'feature', feature };
    const key = chatHintKeyOfFix(fix)!;
    if (deps.hidden?.(key) === true) continue;
    if (feature === 'file' && (await deps.conversationHasFiles?.()) === true) continue;
    if ((await deps.featureConnected(feature)) !== false) continue;
    return { fixes: [fix], offers: [], line: featureStepSentence(feature), key };
  }
  return null;
};

/** The setup step the owner's message names, or null: none named, not about the owner's own things,
 *  a search the owner's switch refused, or nothing to set up (they have it, and it has readings). */
export const promptSetupStep = async (message: string, deps: PromptSetupDeps): Promise<PromptSetupStep | null> => {
  if (!OWN_WORD_RE.test(message)) return null;
  const feature = await featureSetupStep(message, deps);
  if (feature !== null) return feature;
  const read = message.replace(/[A-Za-z]+/gu, (word) => READING_FORMS[word.toLowerCase()] ?? word);
  const named = typesNamedBy(read, deps.types())[0];
  if (named === undefined) return null;
  // The words that named it: a reading searches by the reading, so D-404's reading path runs.
  const result = await deps.search(named.reading ?? named.phrase);
  if (result === null || !result.ok) return null;
  const fix = chatFixesOf(result.fixes).find((candidate) => candidate.kind === 'thing' || candidate.kind === 'source');
  if (fix?.kind === 'thing') {
    return { fixes: [fix], offers: [], line: thingStepsSentence([fix.type_name]), key: chatHintKeyOfFix(fix)! };
  }
  const subject = `The owner's ${named.name}`;
  if (fix?.kind === 'source') {
    // D-339 slice 23 — the same words as the row's link: a pack set up on the thing's page says that button's.
    return { fixes: [fix], offers: [], line: readingSourceSentence(subject, [fix.pack_name], true, thingPageSetupOf(fix)), key: chatHintKeyOfFix(fix)! };
  }
  const offer = installOffersOf(result.install_offers)[0];
  if (offer !== undefined) {
    return { fixes: [], offers: [offer], line: readingSourceSentence(subject, [offer.name], false), key: chatHintKeyOfOffer(offer) };
  }
  return null;
};

/** The keys of the setup steps a stored answer carried, as `promptSetupStep` keys them: a hint's own
 *  key (`chatHintKeyOfFix` / `chatHintKeyOfOffer`), the one "Not now" holds against too. */
export const setupStepKeysOf = (message: { readonly role?: unknown; readonly fixes?: unknown; readonly install_offers?: unknown }): string[] => {
  if (message.role !== 'assistant') return [];
  return [
    ...chatFixesOf(message.fixes).flatMap((fix) => { const key = chatHintKeyOfFix(fix); return key === null ? [] : [key]; }),
    ...installOffersOf(message.install_offers).map(chatHintKeyOfOffer),
  ];
};
