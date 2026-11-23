import type { ProactiveProposal, SituationRef } from '@recued/contracts';

/** Yours → a suggestion's "Why suggested", in the owner's words. It read
 *  "medium confidence · last_done · learner", the proposal's kind and origin codes, and an evidence
 *  record it could not link as "contact: c_81f2". The kind is left out: the card's title says what
 *  the suggestion is. Each map is closed (`Object.hasOwn`), so a code a newer server adds reads as
 *  a plain phrase rather than as itself. */
const CONFIDENCE_WORDS: Readonly<Record<ProactiveProposal['confidence'], string>> = {
  high: 'Fairly sure', medium: 'Somewhat sure', low: 'Not sure',
};
const LANE_WORDS: Readonly<Record<NonNullable<ProactiveProposal['lane']>, string>> = {
  likely_asset: 'looks like something you bought to keep',
  gift: 'looks like a gift',
  return: 'looks like a return',
  pickup: 'looks like something to pick up',
  bundle: 'looks like part of a bundle',
};
const ORIGIN_WORDS: Readonly<Record<ProactiveProposal['origin'], string>> = {
  intake: 'found in your mail and files',
  owner: 'from your own entry',
  learner: 'learned from what you did before',
  pack: 'from a pack you installed',
};
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  mail: 'an email', calendar: 'a calendar event', file: 'a file', contact: 'a contact',
  asset: 'something you own', episode: 'a past occasion', occasion: 'an occasion',
  commitment: 'a task', history_trace: 'kept evidence', pursuit: 'a pursuit',
};

const pick = <T extends string>(map: Readonly<Record<T, string>>, key: string | undefined): string | undefined =>
  key !== undefined && Object.hasOwn(map, key) ? map[key as T] : undefined;

/** "Somewhat sure · learned from what you did before". */
export const proposalWhyLine = (proposal: Pick<ProactiveProposal, 'confidence' | 'lane' | 'origin'>): string => {
  const sure = pick(CONFIDENCE_WORDS, proposal.confidence);
  const basis = pick(LANE_WORDS, proposal.lane) ?? pick(ORIGIN_WORDS, proposal.origin);
  return [sure, basis].filter((part): part is string => part !== undefined).join(' · ');
};

/** An evidence record Yours cannot open: what kind of record it is, never its id. */
export const proposalSourceWords = (source: Pick<SituationRef, 'collection'>): string =>
  `Based on ${pick(SOURCE_WORDS, source.collection) ?? 'one of your records'}`;
