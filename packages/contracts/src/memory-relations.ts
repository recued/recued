/** D-336 — the relations a saved fact can name, and the claim a note carries.
 *
 *  A claim is a note's summary decomposed, nothing more (owner, 2026-10-31): the
 *  summary says the fact in the owner's words and language; the claim says the same
 *  fact as subject, relation and object, so that one fact is one key in any wording.
 *  "Dana Whitfield's daughter is called Mia", "Mia is Dana Whitfield's daughter" and
 *  "Dana Whitfield 的女儿叫 Mia" are all Mia, "daughter of", Dana Whitfield.
 *
 *  One table serves the `memory.relations` guide, `memory.write`'s check and the
 *  owner's editors. Recued owns it, so each relation says what its ends are: an
 *  editor knows which end could be a contact, and the check refuses an asset where a
 *  person goes. The relation words are English whatever language the fact came in;
 *  the key is the list's word, so translating the editors later changes no stored
 *  claim.
 *
 *  Settled for v1 by the owner (*"good enough since it can be edit openly later at
 *  approval or in webclient"*): what it lacks, the owner types as a relation of
 *  their own (§3.11), which stays out of the list. A relation added later is a
 *  change here.
 *
 *  Spec: D-336 §3.1–§3.3. */

/** The groups the guide lists, a line each, in the order it lists them. */
export type MemoryRelationGroup =
  | 'family'
  | 'ties'
  | 'work'
  | 'services'
  | 'places'
  | 'names'
  | 'things'
  | 'preferences';

/** What one end of a relation holds. A `person` end may be a contact or the owner, a
 *  `thing` end an asset; a place, a name or text stays words. */
export type MemoryRelationEnd = 'person' | 'thing' | 'place' | 'name' | 'text';

/** One row of the list: relations that share their ends, their general form and an
 *  example. Every relation is read subject first ("Mia, daughter of, Dana"). */
export interface MemoryRelationRow {
  readonly group: MemoryRelationGroup;
  readonly relations: readonly string[];
  /** The form a fact takes when it says no more ("child of" for a daughter or a son
   *  the fact does not tell apart). A relation of its own, with the row's ends. */
  readonly general?: string;
  readonly subject: MemoryRelationEnd;
  readonly object: MemoryRelationEnd;
  /** A sentence and its claim, which shows which way round the row is written. */
  readonly example: {
    readonly said: string;
    readonly subject: string;
    readonly relation: string;
    readonly object: string;
  };
  /** What a model needs to know about this row beyond the example. */
  readonly note?: string;
}

/** The line each group is listed with, in the guide and the owner's picker. */
export const MEMORY_RELATION_GROUPS: ReadonlyArray<{
  readonly group: MemoryRelationGroup;
  readonly covers: string;
}> = [
  { group: 'family', covers: 'parents, children, siblings, grandparents, aunts, uncles, nieces, nephews, cousins, partners and exes, in-laws, step- and half-relations' },
  { group: 'ties', covers: 'godparents, friends, neighbours, housemates, classmates, guardians, membership' },
  { group: 'work', covers: 'where someone works or studies, their job, colleagues, managers, clients' },
  { group: 'services', covers: "someone's doctor, dentist, lawyer, accountant, teacher, coach or vet" },
  { group: 'places', covers: 'where someone lives, comes from or was born' },
  { group: 'names', covers: 'another name someone goes by' },
  { group: 'things', covers: 'what someone owns, a pet, where a thing is kept, a thing lent, borrowed or given' },
  { group: 'preferences', covers: 'what someone likes, dislikes, prefers, avoids or is allergic to' },
];

const ex = (said: string, subject: string, relation: string, object: string) =>
  ({ said, subject, relation, object }) as const;

/** The list (D-336 §3.1): 97 relations, general forms included. */
export const MEMORY_RELATIONS: readonly MemoryRelationRow[] = [
  // ── Family ──
  { group: 'family', relations: ['mother of', 'father of'], general: 'parent of', subject: 'person', object: 'person',
    example: ex("Dana is Mia's mother", 'Dana', 'mother of', 'Mia') },
  { group: 'family', relations: ['daughter of', 'son of'], general: 'child of', subject: 'person', object: 'person',
    example: ex("Mia is Dana's daughter", 'Mia', 'daughter of', 'Dana') },
  { group: 'family', relations: ['stepmother of', 'stepfather of'], general: 'stepparent of', subject: 'person', object: 'person',
    example: ex("Lena is Mia's stepmother", 'Lena', 'stepmother of', 'Mia') },
  { group: 'family', relations: ['stepdaughter of', 'stepson of'], general: 'stepchild of', subject: 'person', object: 'person',
    example: ex("Mia is Lena's stepdaughter", 'Mia', 'stepdaughter of', 'Lena') },
  { group: 'family', relations: ['sister of', 'brother of'], general: 'sibling of', subject: 'person', object: 'person',
    example: ex("Sara is Tom's sister", 'Sara', 'sister of', 'Tom') },
  { group: 'family', relations: ['half-sister of', 'half-brother of'], general: 'half-sibling of', subject: 'person', object: 'person',
    example: ex("Ana is Tom's half-sister", 'Ana', 'half-sister of', 'Tom') },
  { group: 'family', relations: ['stepsister of', 'stepbrother of'], general: 'stepsibling of', subject: 'person', object: 'person',
    example: ex("Sam is Mia's stepbrother", 'Sam', 'stepbrother of', 'Mia') },
  { group: 'family', relations: ['grandmother of', 'grandfather of'], general: 'grandparent of', subject: 'person', object: 'person',
    example: ex("Rose is Mia's grandmother", 'Rose', 'grandmother of', 'Mia') },
  { group: 'family', relations: ['granddaughter of', 'grandson of'], general: 'grandchild of', subject: 'person', object: 'person',
    example: ex("Mia is Rose's granddaughter", 'Mia', 'granddaughter of', 'Rose') },
  { group: 'family', relations: ['aunt of', 'uncle of', 'niece of', 'nephew of', 'cousin of'], subject: 'person', object: 'person',
    example: ex("Sara is Mia's aunt", 'Sara', 'aunt of', 'Mia') },
  { group: 'family', relations: ['wife of', 'husband of', 'fiancée of', 'fiancé of', 'girlfriend of', 'boyfriend of'], general: 'partner of',
    subject: 'person', object: 'person', example: ex("Tom is Sara's boyfriend", 'Tom', 'boyfriend of', 'Sara') },
  { group: 'family', relations: ['ex-wife of', 'ex-husband of', 'ex-girlfriend of', 'ex-boyfriend of'], general: 'ex-partner of',
    subject: 'person', object: 'person', example: ex("Lena is Tom's ex-wife", 'Lena', 'ex-wife of', 'Tom') },
  { group: 'family', relations: ['mother-in-law of', 'father-in-law of'], general: 'parent-in-law of', subject: 'person', object: 'person',
    example: ex("Rose is Tom's mother-in-law", 'Rose', 'mother-in-law of', 'Tom') },
  { group: 'family', relations: ['daughter-in-law of', 'son-in-law of'], general: 'child-in-law of', subject: 'person', object: 'person',
    example: ex("Tom is Rose's son-in-law", 'Tom', 'son-in-law of', 'Rose') },
  { group: 'family', relations: ['sister-in-law of', 'brother-in-law of'], general: 'sibling-in-law of', subject: 'person', object: 'person',
    example: ex("Sara is Sam's sister-in-law", 'Sara', 'sister-in-law of', 'Sam') },
  // ── Other ties ── not family, so a godmother can also be an aunt.
  { group: 'ties', relations: ['godmother of', 'godfather of'], general: 'godparent of', subject: 'person', object: 'person',
    example: ex("Sara is Mia's godmother", 'Sara', 'godmother of', 'Mia') },
  { group: 'ties', relations: ['goddaughter of', 'godson of'], general: 'godchild of', subject: 'person', object: 'person',
    example: ex("Mia is Sara's goddaughter", 'Mia', 'goddaughter of', 'Sara') },
  { group: 'ties', relations: ['best friend of'], general: 'friend of', subject: 'person', object: 'person',
    example: ex("Ana is Dana's best friend", 'Ana', 'best friend of', 'Dana') },
  { group: 'ties', relations: ['friend of', 'guardian of', 'neighbour of', 'lives with', 'housemate of', 'classmate of'],
    subject: 'person', object: 'person', example: ex("Sam is Dana's neighbour", 'Sam', 'neighbour of', 'Dana') },
  { group: 'ties', relations: ['member of'], subject: 'person', object: 'name',
    example: ex('Dana is a member of the Cork Choir', 'Dana', 'member of', 'Cork Choir') },
  // ── Work ──
  { group: 'work', relations: ['works at', 'studies at'], subject: 'person', object: 'name',
    example: ex('Dana works at Acme', 'Dana', 'works at', 'Acme') },
  { group: 'work', relations: ['works as'], subject: 'person', object: 'text',
    example: ex('Dana works as a nurse', 'Dana', 'works as', 'nurse') },
  { group: 'work', relations: ['colleague of', 'manager of', 'reports to', 'assistant of', 'client of'], subject: 'person', object: 'person',
    example: ex("Priya is Sam's manager", 'Priya', 'manager of', 'Sam') },
  // ── Services ──
  { group: 'services', relations: ['doctor of', 'dentist of', 'lawyer of', 'accountant of', 'teacher of', 'coach of'],
    subject: 'person', object: 'person', example: ex("Dr Shah is Dana's doctor", 'Dr Shah', 'doctor of', 'Dana') },
  { group: 'services', relations: ['vet of'], subject: 'person', object: 'thing',
    example: ex("Dr Ito is Rex's vet", 'Dr Ito', 'vet of', 'Rex') },
  // ── Places ──
  { group: 'places', relations: ['lives in', 'from', 'born in'], subject: 'person', object: 'place',
    example: ex('Dana is from Galway', 'Dana', 'from', 'Galway') },
  // ── Names ──
  { group: 'names', relations: ['called'], subject: 'person', object: 'name',
    example: ex('Margaret goes by Peggy', 'Margaret', 'called', 'Peggy'),
    note: "Another name the person goes by: \"named\", \"known as\" and \"goes by\" are all called. Someone named through a tie is the tie: \"Dana's daughter is called Mia\" is Mia, daughter of, Dana." },
  // ── Things ──
  { group: 'things', relations: ['owns'], subject: 'person', object: 'thing',
    example: ex('Mia owns a blue bicycle', 'Mia', 'owns', 'a blue bicycle') },
  { group: 'things', relations: ['pet of'], subject: 'thing', object: 'person',
    example: ex("Rex is Mia's dog", 'Rex', 'pet of', 'Mia') },
  { group: 'things', relations: ['kept at'], subject: 'thing', object: 'place',
    example: ex('The kayak is kept at the boat club', 'the kayak', 'kept at', 'the boat club') },
  { group: 'things', relations: ['lent to', 'borrowed from', 'gift from'], subject: 'thing', object: 'person',
    example: ex('The drill was lent to Tom', 'the drill', 'lent to', 'Tom') },
  // ── Preferences ──
  { group: 'preferences', relations: ['likes', 'dislikes', 'prefers', 'avoids', 'allergic to'], subject: 'person', object: 'text',
    example: ex('Mia is allergic to peanuts', 'Mia', 'allergic to', 'peanuts') },
];

/** One listed relation, with what its row says about it. */
export interface MemoryRelationEntry {
  /** The list's word, as it is stored. */
  readonly relation: string;
  readonly group: MemoryRelationGroup;
  readonly subject: MemoryRelationEnd;
  readonly object: MemoryRelationEnd;
  /** The general form of its row, when it has one and is not it. */
  readonly general?: string;
}

/** Text as a key holds it: NFKC, trimmed, spaces collapsed, case-folded. */
export const normalizeClaimText = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

/** Every listed relation by its normalized word. A word two rows list ("friend of",
 *  the general form of "best friend of" and a relation of its own) is its first row's. */
export const MEMORY_RELATION_INDEX: ReadonlyMap<string, MemoryRelationEntry> = (() => {
  const index = new Map<string, MemoryRelationEntry>();
  for (const row of MEMORY_RELATIONS) {
    const words = row.general === undefined ? row.relations : [...row.relations, row.general];
    for (const relation of words) {
      const key = normalizeClaimText(relation);
      if (index.has(key)) continue;
      index.set(key, {
        relation, group: row.group, subject: row.subject, object: row.object,
        ...(row.general !== undefined && row.general !== relation ? { general: row.general } : {}),
      });
    }
  }
  return index;
})();

/** The listed relation a word names, or `undefined` for a word the list lacks (an
 *  owner's own relation, §3.11). Read from the list, never stored, so a relation the
 *  list later gains counts as listed from then on. */
export const listedMemoryRelation = (word: string): MemoryRelationEntry | undefined =>
  MEMORY_RELATION_INDEX.get(normalizeClaimText(word));

/** The opposites outside the family that exclude each other (§3.1, settled with the
 *  longer list). */
const OPPOSITE_RELATIONS: ReadonlyArray<readonly [string, string]> = [
  ['likes', 'dislikes'],
  ['prefers', 'avoids'],
  ['lent to', 'borrowed from'],
];

/** D-336 slice G (§3.1) — whether two relations cannot both hold between the same two ends,
 *  which makes two notes that say them a contradiction (§3.9). The family relations exclude
 *  each other, except a relation and its general form ("daughter of" and "child of", "wife
 *  of" and "partner of"); the other ties are not family, so a godmother can also be an aunt;
 *  three opposite pairs exclude each other; the rest exclude nothing, so "owns" and "prefers"
 *  can both hold for one thing. A relation of the owner's own excludes nothing (§3.11). */
export const memoryRelationsExclude = (a: string, b: string): boolean => {
  const first = listedMemoryRelation(a);
  const second = listedMemoryRelation(b);
  if (first === undefined || second === undefined || first.relation === second.relation) return false;
  if (first.group === 'family' && second.group === 'family') {
    return first.general !== second.relation && second.general !== first.relation;
  }
  return OPPOSITE_RELATIONS.some(([x, y]) =>
    (first.relation === x && second.relation === y) || (first.relation === y && second.relation === x));
};

/** The longest part of a claim, in characters: a relation, or an end's words. */
export const MEMORY_CLAIM_PART_MAX = 200;

/** One end of a stored claim. Text is kept as written; a linked end keeps its
 *  record's id, which the key uses, and the name it had when linked, which export
 *  writes beside it so an import can fall back to the name. */
export type MemoryClaimEnd =
  | { readonly text: string }
  | { readonly owner: true }
  | { readonly contact_id: string; readonly name: string }
  | { readonly asset_id: string; readonly name: string };

/** A note's claim as stored, exported and imported (D-336 §3.3, §3.8): `relation` is
 *  the list's word, or the owner's own words as they wrote them. */
export interface MemoryClaim {
  readonly subject: MemoryClaimEnd;
  readonly relation: string;
  readonly object: MemoryClaimEnd;
}

/** D-336 slice G (§3.9) — a note already in memory that a save meets: one it contradicts
 *  (the same two ends, with a relation the list says excludes the save's), or another note
 *  on the same thing (the same subject and relation, another object: a second parent, a
 *  move). Slice J: or the same fact saved already (the same subject, relation and object,
 *  `saved_already`). Shown to the owner on the save's card and told to the agent; never a
 *  refusal. Slice O: or a save of the same fact asked before this one and still waiting
 *  for the owner when this one was held (`asked_already`), which has no note yet, so no
 *  `memory_id`: it is named by its summary. */
export type MemorySaveConflict =
  | {
      readonly kind: 'contradicts' | 'saved_already' | 'also_in_memory';
      readonly memory_id: string;
      /** The note's summary, as the feed shows it. */
      readonly summary: string;
    }
  | {
      /** `asked_again` (slice O's open item, the owner: "Asked again"): a save of the same fact
       *  asked AFTER this one, while this one waits; added to this one's card when that one is
       *  held. `contradicts_asked` (slice S): a save asked while this one waits, before or
       *  after it, that this one contradicts, by the rule a note in memory is contradicted;
       *  the later save lists it when held, and the earlier gains it then. */
      readonly kind: 'asked_already' | 'asked_again' | 'contradicts_asked';
      /** The waiting save's summary, as it would be saved. */
      readonly summary: string;
    };

/** One end as a key holds it: a linked end by its record's id, the owner as `owner`,
 *  text normalized. Slice C recalls notes by it (`about`), so each end is stored too. */
export const memoryClaimEndKey = (end: MemoryClaimEnd): string => {
  if ('owner' in end) return 'owner';
  if ('contact_id' in end) return `contact:${end.contact_id}`;
  if ('asset_id' in end) return `asset:${end.asset_id}`;
  return `text:${normalizeClaimText(end.text)}`;
};

/** The claim as one key (D-336 §3.3): an id as it is, text normalized. Two notes with
 *  one key state one claim, whatever their summaries say. */
export const memoryClaimKey = (claim: MemoryClaim): string =>
  JSON.stringify([
    memoryClaimEndKey(claim.subject),
    normalizeClaimText(claim.relation),
    memoryClaimEndKey(claim.object),
  ]);

/** D-336 (spec §39, §45) — the end of a relationship that names a record in words: by its name,
 *  matched as a key holds it, at an end its relation lets be that kind (`person` for a contact,
 *  `thing` for a thing you own; the owner's own relation takes either). None when both ends name
 *  it, which says nothing of which one is it. What a "matched by name" line links. */
export const claimEndNamingInWords = (
  claim: MemoryClaim,
  name: string,
  kind: 'person' | 'thing',
): 'subject' | 'object' | undefined => {
  const trimmed = name.trim();
  if (trimmed === '') return undefined;
  const key = memoryClaimEndKey({ text: trimmed });
  const listed = listedMemoryRelation(claim.relation);
  const ends = (['subject', 'object'] as const).filter((place) => {
    const end = claim[place];
    const takes = listed?.[place];
    return 'text' in end && memoryClaimEndKey(end) === key && (takes === undefined || takes === kind);
  });
  return ends.length === 1 ? ends[0] : undefined;
};

/** An end in the owner's words: a linked end by the name it was linked with, and the
 *  owner as "you". */
export const memoryClaimEndWords = (end: MemoryClaimEnd): string =>
  'owner' in end ? 'you' : 'text' in end ? end.text : end.name;

/** A claim as one line: "Mia, daughter of, Dana Whitfield". */
export const memoryClaimLine = (claim: MemoryClaim): string =>
  `${memoryClaimEndWords(claim.subject)}, ${claim.relation}, ${memoryClaimEndWords(claim.object)}`;

/** How a listed relation reads as a sentence (slice D). A relation "<noun> of" reads
 *  "Mia is Dana's daughter"; the rest are listed by hand, each with the verb's form for
 *  "you" ("Dana owns", "You own"). */
type RelationSaying =
  | { readonly form: 'noun'; readonly noun: string }
  | { readonly form: 'verb'; readonly verb: string; readonly base: string }
  | { readonly form: 'be'; readonly rest: string }
  | { readonly form: 'was'; readonly rest: string };

const RELATION_SAYINGS: Readonly<Record<string, RelationSaying>> = {
  'member of': { form: 'be', rest: 'a member of' },
  'lives with': { form: 'verb', verb: 'lives with', base: 'live with' },
  'reports to': { form: 'verb', verb: 'reports to', base: 'report to' },
  'works at': { form: 'verb', verb: 'works at', base: 'work at' },
  'studies at': { form: 'verb', verb: 'studies at', base: 'study at' },
  'works as': { form: 'verb', verb: 'works as', base: 'work as' },
  'lives in': { form: 'verb', verb: 'lives in', base: 'live in' },
  'from': { form: 'be', rest: 'from' },
  'born in': { form: 'was', rest: 'born in' },
  'called': { form: 'verb', verb: 'goes by', base: 'go by' },
  'owns': { form: 'verb', verb: 'owns', base: 'own' },
  'kept at': { form: 'be', rest: 'kept at' },
  'lent to': { form: 'was', rest: 'lent to' },
  'borrowed from': { form: 'was', rest: 'borrowed from' },
  'gift from': { form: 'was', rest: 'a gift from' },
  'likes': { form: 'verb', verb: 'likes', base: 'like' },
  'dislikes': { form: 'verb', verb: 'dislikes', base: 'dislike' },
  'prefers': { form: 'verb', verb: 'prefers', base: 'prefer' },
  'avoids': { form: 'verb', verb: 'avoids', base: 'avoid' },
  'allergic to': { form: 'be', rest: 'allergic to' },
};

const sayingOf = (relation: string): RelationSaying | undefined => {
  const listed = listedMemoryRelation(relation);
  if (listed === undefined) return undefined;
  const word = listed.relation;
  if (Object.hasOwn(RELATION_SAYINGS, word)) return RELATION_SAYINGS[word];
  return word.endsWith(' of') ? { form: 'noun', noun: word.slice(0, -' of'.length) } : undefined;
};

/** A first word with no capital is the start of the sentence, so it takes one ("the
 *  kayak" → "The kayak"); a word that already has one is a name as written ("iPhone"). */
const sentenceStart = (words: string): string => {
  const first = words.split(/\s/u, 1)[0] ?? '';
  return first !== '' && first === first.toLowerCase() ? words.charAt(0).toUpperCase() + words.slice(1) : words;
};

/** D-336 slice D — a claim as the owner reads it: "Mia is Dana Whitfield's daughter.",
 *  "You own a blue bicycle.", "Mia is your daughter." A relation of the owner's own,
 *  which the list cannot phrase, reads as written: "Lena, mother of my cousin's
 *  boyfriend, cousin Sara." */
export const memoryClaimSentence = (claim: MemoryClaim): string => {
  const saying = sayingOf(claim.relation);
  const subjectIsYou = 'owner' in claim.subject;
  const objectIsYou = 'owner' in claim.object;
  const subject = subjectIsYou ? 'You' : sentenceStart(memoryClaimEndWords(claim.subject));
  const object = objectIsYou ? 'you' : memoryClaimEndWords(claim.object);
  if (saying === undefined) return `${sentenceStart(memoryClaimLine(claim))}.`;
  switch (saying.form) {
    case 'noun':
      return `${subject} ${subjectIsYou ? 'are' : 'is'} ${objectIsYou ? 'your' : `${object}'s`} ${saying.noun}.`;
    case 'verb':
      return `${subject} ${subjectIsYou ? saying.base : saying.verb} ${object}.`;
    case 'be':
      return `${subject} ${subjectIsYou ? 'are' : 'is'} ${saying.rest} ${object}.`;
    case 'was':
      return `${subject} ${subjectIsYou ? 'were' : 'was'} ${saying.rest} ${object}.`;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A `memory.write` call's `claim` as one line for its approval, or `undefined` when
 *  it is not one (the card then shows it as it came). An end is as the call wrote it:
 *  words, "owner", `{contact: target_id}` or `{asset: id}`. A linked end reads as the
 *  name recorded for it (`names`, the card's `value_labels` for `claim`), else as the
 *  email a contact is found by, or as "a thing you own". A claim the owner changed while
 *  approving (D-336 slice E) is a stored claim, its ends carrying their names. */
export const memoryClaimArgLine = (
  value: unknown,
  names?: Readonly<Record<string, string>>,
): string | undefined => {
  const owners = readMemoryClaim(value);
  if (owners !== undefined) return memoryClaimLine(owners);
  if (!isPlainObject(value) || typeof value.relation !== 'string' || value.relation.trim() === '') return undefined;
  const named = (id: string): string | undefined =>
    names !== undefined && Object.hasOwn(names, id) && typeof names[id] === 'string' ? names[id] : undefined;
  const end = (raw: unknown): string | undefined => {
    if (typeof raw === 'string') {
      const words = raw.trim();
      if (words === '') return undefined;
      return normalizeClaimText(words) === 'owner' ? 'you' : words;
    }
    if (!isPlainObject(raw)) return undefined;
    if (typeof raw.contact === 'string' && raw.contact.trim() !== '') return named(raw.contact) ?? raw.contact.trim();
    if (typeof raw.asset === 'string' && raw.asset.trim() !== '') return named(raw.asset) ?? 'a thing you own';
    return undefined;
  };
  const subject = end(value.subject);
  const object = end(value.object);
  return subject === undefined || object === undefined
    ? undefined
    : `${subject}, ${value.relation.trim()}, ${object}`;
};

const boundedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MEMORY_CLAIM_PART_MAX ? trimmed : undefined;
};

/** A stored claim end read back off the wire or a file, or `undefined` when it is not
 *  one. Defensive: an import file is the owner's to edit. */
export const readMemoryClaimEnd = (value: unknown): MemoryClaimEnd | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (value.owner === true) return { owner: true };
  const text = boundedText(value.text);
  if (text !== undefined) return { text };
  const name = boundedText(value.name);
  if (name === undefined) return undefined;
  const contact = boundedText(value.contact_id);
  if (contact !== undefined) return { contact_id: contact, name };
  const asset = boundedText(value.asset_id);
  if (asset !== undefined) return { asset_id: asset, name };
  return undefined;
};

/** A stored claim read back, or `undefined` when it is not one. The relation is
 *  checked for its bound only: an owner's own relation is as valid as a listed one. */
export const readMemoryClaim = (value: unknown): MemoryClaim | undefined => {
  if (!isPlainObject(value)) return undefined;
  const subject = readMemoryClaimEnd(value.subject);
  const relation = boundedText(value.relation);
  const object = readMemoryClaimEnd(value.object);
  if (subject === undefined || relation === undefined || object === undefined) return undefined;
  return { subject, relation: relation.replace(/\s+/gu, ' '), object };
};
