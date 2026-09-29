/**
 * D-315 §4, §5 — who is whose: the one rule every matcher shares.
 *
 * A reading is matched with a candidate — the markup's reading with a
 * template's, a new reading with the fact it replaces, an answer with the fact
 * it fills, a fact with its thing — only when exactly one candidate could be
 * it, and no reading that could not be one with it could be that candidate.
 * Candidates that are one another count as one, and so do readings: two blocks
 * of one parcel both take the markup's reading of it. Where two that are not
 * one another could be it — a refund naming only its order, beside two returns
 * of it — it is neither's, whichever came first. Taken in turn, the first of
 * several won, and the order the markup, the blocks or the mail came in
 * decided.
 *
 * Spec: D-315 §4, §5, §13 (the matching sweep).
 */

import { identitiesDisagree } from './thing-fold.js';

/** Could two readings be one another: an identity key they share, and none
 *  both hold whole that differs (§3.1). */
export const couldBeOne = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((key) => b.includes(key)) && !identitiesDisagree(a, b);

/** Whether some two of `items` are `apart` — not one another — so that what
 *  could be both of them is neither's. */
export const someApart = <T>(items: readonly T[], apart: (a: T, b: T) => boolean): boolean =>
  items.some((a, i) => items.slice(i + 1).some((b) => apart(a, b)));

/** What a reading said, as text that is the same however its keys were
 *  written down: at every depth, in the order of their names. */
const said = (reading: { readonly variables: Readonly<Record<string, unknown>>; readonly data?: unknown }): string =>
  JSON.stringify([reading.variables, reading.data ?? null], (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== null && item !== undefined)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : value);

/** An order of readings by what they say — never by when they came: the
 *  values each read, then its data. */
export const byWhatItSays = (
  a: { readonly variables: Readonly<Record<string, unknown>>; readonly data?: unknown },
  b: { readonly variables: Readonly<Record<string, unknown>>; readonly data?: unknown },
): number => {
  const [x, y] = [said(a), said(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Each reading with the candidate it is, by the rule: every candidate it
 *  could be is one another, and every reading that could be that candidate is
 *  one another with it — or none. Of candidates that are one another, the
 *  first by `rank` for that reading, an order of what they say, never of when
 *  they came. Readings that are one another may `share` one; otherwise each
 *  candidate goes once, the readings taking theirs in `readingRank` order. */
export const pairEach = <R, C>(options: {
  readonly readings: readonly R[];
  readonly candidates: readonly C[];
  readonly could: (reading: R, candidate: C) => boolean;
  readonly readingsApart: (a: R, b: R) => boolean;
  readonly candidatesApart: (a: C, b: C) => boolean;
  readonly rank: (reading: R, a: C, b: C) => number;
  readonly readingRank: (a: R, b: R) => number;
  readonly share: boolean;
}): Map<R, C> => {
  const { readings, candidates, could } = options;
  const paired = new Map<R, C>();
  const taken = new Set<C>();
  const namedBy = new Map<C, R[]>(candidates.map((candidate) => [candidate, readings.filter((reading) => could(reading, candidate))]));
  for (const reading of [...readings].sort(options.readingRank)) {
    const named = candidates.filter((candidate) => could(reading, candidate));
    if (named.length === 0 || someApart(named, options.candidatesApart)) continue;
    const open = named
      .filter((candidate) => !someApart(namedBy.get(candidate)!, options.readingsApart))
      .filter((candidate) => options.share || !taken.has(candidate))
      .sort((a, b) => options.rank(reading, a, b));
    const candidate = open[0];
    if (candidate === undefined) continue;
    paired.set(reading, candidate);
    taken.add(candidate);
  }
  return paired;
};

/** The groups of `items` that are one thing, as the set of them says,
 *  whatever order they came in (§5): items that could be one another are one,
 *  and no group holds two that are not one another. What two such could both
 *  be is neither's; what is left, and what was undecided, are settled again the
 *  same way — so an item as undecided as another is one with it only where
 *  neither could be two others that are not one another. Where no item could be
 *  two such and a chain of them still joins two, each is its own. Read by their
 *  identity keys; items that hold the same keys are read alike. */
export const thingGroups = <T extends { readonly identity_keys: readonly string[] }>(
  items: readonly T[],
): { readonly members: T[]; readonly undecided: boolean }[] => {
  const bySignature = new Map<string, T[]>();
  for (const item of items) {
    const signature = [...item.identity_keys].sort().join('\u0000');
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), item]);
  }
  type Kind = { readonly keys: readonly string[]; readonly members: T[] };
  const kinds: Kind[] = [...bySignature.values()].map((members) => ({ keys: members[0]!.identity_keys, members }));
  const could = (a: Kind, b: Kind): boolean => couldBeOne(a.keys, b.keys);
  const apart = (a: Kind, b: Kind): boolean => identitiesDisagree(a.keys, b.keys);
  const groups: { members: T[]; undecided: boolean }[] = [];
  const settle = (set: readonly Kind[], undecided: boolean): void => {
    for (const component of componentsOf(set, could)) {
      if (!someApart(component, apart)) {
        groups.push({ members: component.flatMap((kind) => kind.members), undecided });
        continue;
      }
      // Two in it are not one another: what could be two such is neither's.
      const unsure = component.filter((kind) => someApart(component.filter((other) => other !== kind && could(kind, other)), apart));
      if (unsure.length === 0 || unsure.length === component.length) {
        for (const kind of component) groups.push({ members: [...kind.members], undecided: true });
        continue;
      }
      settle(component.filter((kind) => !unsure.includes(kind)), undecided);
      settle(unsure, true);
    }
  };
  settle(kinds, false);
  return groups;
};

/** The parts of `items` that `linked` joins, each item with every item it is
 *  linked to through others. */
const componentsOf = <K>(items: readonly K[], linked: (a: K, b: K) => boolean): K[][] => {
  const parent = items.map((_, i) => i);
  const root = (i: number): number => {
    let at = i;
    while (parent[at] !== at) at = parent[at]!;
    return at;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (!linked(items[i]!, items[j]!)) continue;
      const [a, b] = [root(i), root(j)];
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const parts = new Map<number, K[]>();
  items.forEach((item, i) => parts.set(root(i), [...(parts.get(root(i)) ?? []), item]));
  return [...parts.values()];
};
