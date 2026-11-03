/** D-336 §3.1 — the list a saved fact's relation comes from, and the key a claim makes.
 *
 *  The list is settled for v1 (owner, 2026-10-31): 97 relations in eight groups, general
 *  forms included, each naming what its ends are. These pin its shape, the words the
 *  owner ruled out ("is", birthdays), and the key: one fact is one key however its parts
 *  are spaced, cased or composed, and two values are two keys. */

import { describe, expect, it } from 'vitest';

import {
  claimEndNamingInWords,
  listedMemoryRelation,
  MEMORY_RELATION_GROUPS,
  MEMORY_RELATION_INDEX,
  MEMORY_RELATIONS,
  memoryClaimArgLine,
  memoryClaimKey,
  memoryClaimLine,
  memoryClaimSentence,
  memoryRelationsExclude,
  normalizeClaimText,
  readMemoryClaim,
  type MemoryClaim,
} from '../memory-relations.js';
import { TIER1_TOOL_DESCRIPTORS } from '../chat.js';
import { memorySaveConflictRows, tier1CallDetails } from '../grant-switch-guide.js';

const DAUGHTER: MemoryClaim = { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } };

describe('the relation list (§3.1)', () => {
  it('holds the 97 relations the owner settled, general forms included, each once', () => {
    const words = MEMORY_RELATIONS.flatMap((row) => [...row.relations, ...(row.general !== undefined ? [row.general] : [])]);
    // "friend of" is the general form of "best friend of" and a relation of its own.
    expect(new Set(words).size).toBe(97);
    expect(MEMORY_RELATION_INDEX.size).toBe(97);
    expect(words.filter((w) => w === 'friend of')).toHaveLength(2);
  });

  it('keeps the groups in the order the guide lists them, and every row in one', () => {
    expect(MEMORY_RELATION_GROUPS.map((g) => g.group)).toEqual(['family', 'ties', 'work', 'services', 'places', 'names', 'things', 'preferences']);
    const order = MEMORY_RELATION_GROUPS.map((g) => g.group);
    const seen = MEMORY_RELATIONS.map((row) => order.indexOf(row.group));
    expect(seen.every((at) => at >= 0)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("gives each row an example that names one of its own relations, written subject first", () => {
    for (const row of MEMORY_RELATIONS) {
      const own = [...row.relations, ...(row.general !== undefined ? [row.general] : [])];
      expect(own, row.example.said).toContain(row.example.relation);
      expect(row.example.said.toLowerCase(), row.example.said).toContain(row.example.subject.toLowerCase());
      expect(row.example.said.toLowerCase(), row.example.said).toContain(row.example.object.toLowerCase());
    }
  });

  it('says what each end holds: a person where a contact can go, a thing where an asset can', () => {
    expect(listedMemoryRelation('daughter of')).toMatchObject({ subject: 'person', object: 'person', general: 'child of' });
    expect(listedMemoryRelation('owns')).toMatchObject({ subject: 'person', object: 'thing' });
    expect(listedMemoryRelation('pet of')).toMatchObject({ subject: 'thing', object: 'person' });
    expect(listedMemoryRelation('lives in')).toMatchObject({ subject: 'person', object: 'place' });
    expect(listedMemoryRelation('called')).toMatchObject({ subject: 'person', object: 'name' });
    // A general form is a relation with its row's ends, and names no general form of its own.
    expect(listedMemoryRelation('child of')).toEqual({ relation: 'child of', group: 'family', subject: 'person', object: 'person' });
  });

  it('⛔ holds neither "is", which would take every fact, nor a birthday, which a contact keeps', () => {
    expect(listedMemoryRelation('is')).toBeUndefined();
    for (const word of ['birthday of', 'born on', 'anniversary of', 'married on']) {
      expect(listedMemoryRelation(word), word).toBeUndefined();
    }
  });

  it('finds a relation however it is spaced or cased, as the list spells it', () => {
    expect(listedMemoryRelation('  Daughter   OF ')?.relation).toBe('daughter of');
    expect(listedMemoryRelation('fiancée of')?.relation).toBe('fiancée of');
    // NFKC: a composed é and an e followed by a combining accent are one letter.
    expect(listedMemoryRelation('fiancée of')?.relation).toBe('fiancée of');
  });
});

describe('the claim key (§3.3)', () => {
  it('is one key for one fact, however its words are spaced, cased or composed', () => {
    const same: MemoryClaim[] = [
      DAUGHTER,
      { subject: { text: ' mia' }, relation: 'Daughter  of', object: { text: 'DANA   whitfield' } },
      // Full-width letters, as an IME may type them, read as the letters they are.
      { subject: { text: 'Ｍｉａ' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } },
    ];
    expect(new Set(same.map(memoryClaimKey)).size).toBe(1);
    expect(memoryClaimKey(DAUGHTER)).toBe(JSON.stringify(['text:mia', 'daughter of', 'text:dana whitfield']));
  });

  it('is two keys for two values, two directions, or two relations', () => {
    const key = memoryClaimKey(DAUGHTER);
    expect(memoryClaimKey({ ...DAUGHTER, subject: { text: 'Maya' } })).not.toBe(key);
    // Recued stores no inverse, so the other way round is another key (§3.1).
    expect(memoryClaimKey({ subject: { text: 'Dana Whitfield' }, relation: 'mother of', object: { text: 'Mia' } })).not.toBe(key);
    expect(memoryClaimKey({ ...DAUGHTER, relation: 'child of' })).not.toBe(key);
  });

  it('keys a linked end by its record and the owner as the owner, never by a name', () => {
    const linked: MemoryClaim = { ...DAUGHTER, object: { contact_id: 'ct-1', name: 'Dana Whitfield' } };
    expect(memoryClaimKey(linked)).toBe(JSON.stringify(['text:mia', 'daughter of', 'contact:ct-1']));
    expect(memoryClaimKey({ ...linked, object: { contact_id: 'ct-1', name: 'Dana W.' } })).toBe(memoryClaimKey(linked));
    expect(memoryClaimKey({ ...DAUGHTER, object: { owner: true } })).toBe(JSON.stringify(['text:mia', 'daughter of', 'owner']));
    // A person whose words are "owner" is not the fixed end.
    expect(memoryClaimKey({ ...DAUGHTER, object: { text: 'owner' } })).not.toBe(memoryClaimKey({ ...DAUGHTER, object: { owner: true } }));
  });

  it('cannot be forged by a part that spells another part', () => {
    const tricky: MemoryClaim = { subject: { text: 'mia","daughter of","text:dana' }, relation: 'x', object: { text: 'y' } };
    expect(memoryClaimKey(tricky)).not.toBe(memoryClaimKey(DAUGHTER));
    expect(JSON.parse(memoryClaimKey(tricky))).toHaveLength(3);
  });

  it('normalizes text as a key holds it: NFKC, trimmed, spaces collapsed, case-folded', () => {
    expect(normalizeClaimText('  Dana  Whitfield\n')).toBe('dana whitfield');
    expect(normalizeClaimText('ﬁancée')).toBe('fiancée');
  });
});

describe('a claim as the owner reads it, and read back from a file', () => {
  it('reads as one line, the owner as "you" and a linked end by its name', () => {
    expect(memoryClaimLine(DAUGHTER)).toBe('Mia, daughter of, Dana Whitfield');
    expect(memoryClaimLine({ ...DAUGHTER, object: { owner: true } })).toBe('Mia, daughter of, you');
    expect(memoryClaimLine({ ...DAUGHTER, object: { contact_id: 'ct-1', name: 'Dana' } })).toBe('Mia, daughter of, Dana');
  });

  it("reads a call's claim for its card, a linked end by the name recorded for it", () => {
    const call = { subject: 'Mia', relation: 'daughter of', object: { contact: 'dana@example.test' } };
    expect(memoryClaimArgLine(call, { 'dana@example.test': 'Dana Whitfield' })).toBe('Mia, daughter of, Dana Whitfield');
    expect(memoryClaimArgLine(call)).toBe('Mia, daughter of, dana@example.test');
    expect(memoryClaimArgLine({ subject: 'Mia', relation: 'owns', object: { asset: 'a-1' } })).toBe('Mia, owns, a thing you own');
    expect(memoryClaimArgLine({ subject: 'Mia', relation: 'daughter of', object: 'OWNER' })).toBe('Mia, daughter of, you');
    expect(memoryClaimArgLine({ subject: 'Mia', relation: 'daughter of' })).toBeUndefined();
    expect(memoryClaimArgLine('Mia, daughter of, Dana')).toBeUndefined();
  });

  it('reads a claim the owner changed while approving (slice E): its ends carry their names', () => {
    expect(memoryClaimArgLine({ ...DAUGHTER, object: { contact_id: 'ct-1', name: 'Dana Whitfield' } }))
      .toBe('Mia, daughter of, Dana Whitfield');
    expect(memoryClaimArgLine({ subject: { owner: true }, relation: 'owns', object: { asset_id: 'a-1', name: 'Blue bicycle' } }))
      .toBe('you, owns, Blue bicycle');
    // Names recorded for a call's ids do not rename an end that carries its own.
    expect(memoryClaimArgLine({ ...DAUGHTER, object: { contact_id: 'ct-1', name: 'Dana' } }, { 'ct-1': 'Someone else' }))
      .toBe('Mia, daughter of, Dana');
  });

  it("reads a stored claim back, an owner's own relation included, and refuses what is not one", () => {
    expect(readMemoryClaim(DAUGHTER)).toEqual(DAUGHTER);
    const own = { subject: { text: 'Lena' }, relation: "mother of my cousin's  boyfriend", object: { text: 'cousin Sara' } };
    expect(readMemoryClaim(own)?.relation).toBe("mother of my cousin's boyfriend");
    expect(readMemoryClaim({ ...DAUGHTER, object: { contact_id: 'ct-1' } })).toBeUndefined();
    expect(readMemoryClaim({ ...DAUGHTER, relation: 'x'.repeat(201) })).toBeUndefined();
    expect(readMemoryClaim({ ...DAUGHTER, subject: 'Mia' })).toBeUndefined();
    expect(readMemoryClaim(null)).toBeUndefined();
  });
});

describe('memory.write and memory.relations as the catalog carries them', () => {
  it('memory.write sends a fact about a person or a thing to memory.relations, the summary in the user\'s words', () => {
    // D-336 §3.2 — the one line the description gains.
    const write = TIER1_TOOL_DESCRIPTORS['memory.write'].description;
    expect(write).toMatch(/For a fact about a person or a thing, call `memory\.relations` and pass `claim` too; the summary stays in the user's own words and language\./);
    const claim = (TIER1_TOOL_DESCRIPTORS['memory.write'].arg_schema as { properties: { claim: { description: string; required: string[] } } }).properties.claim;
    expect(claim.required).toEqual(['subject', 'relation', 'object']);
    expect(claim.description).toMatch(/must be one `memory\.relations` lists; leave `claim` out when none fits/);
  });

  it('memory.relations offers exactly the groups the list holds', () => {
    const schema = TIER1_TOOL_DESCRIPTORS['memory.relations'].arg_schema as { properties: { group: { enum: string[] } } };
    expect(schema.properties.group.enum).toEqual(MEMORY_RELATION_GROUPS.map((g) => g.group));
    expect(TIER1_TOOL_DESCRIPTORS['memory.relations'].classification).toBe('read');
  });
});

describe('a claim as a sentence the owner reads (slice D)', () => {
  const said = (subject: string | { owner: true }, relation: string, object: string | { owner: true }) =>
    memoryClaimSentence({
      subject: typeof subject === 'string' ? { text: subject } : subject,
      relation,
      object: typeof object === 'string' ? { text: object } : object,
    });

  it('reads every listed relation as a sentence, each example as its sentence says it', () => {
    expect(said('Mia', 'daughter of', 'Dana Whitfield')).toBe("Mia is Dana Whitfield's daughter.");
    expect(said('Tom', 'boyfriend of', 'Sara')).toBe("Tom is Sara's boyfriend.");
    expect(said('Dr Ito', 'vet of', 'Rex')).toBe("Dr Ito is Rex's vet.");
    expect(said('Rex', 'pet of', 'Mia')).toBe("Rex is Mia's pet.");
    expect(said('Dana', 'member of', 'Cork Choir')).toBe('Dana is a member of Cork Choir.');
    expect(said('Dana', 'works at', 'Acme')).toBe('Dana works at Acme.');
    expect(said('Margaret', 'called', 'Peggy')).toBe('Margaret goes by Peggy.');
    expect(said('Dana', 'from', 'Galway')).toBe('Dana is from Galway.');
    expect(said('Mia', 'born in', 'Dublin')).toBe('Mia was born in Dublin.');
    expect(said('the kayak', 'kept at', 'the boat club')).toBe('The kayak is kept at the boat club.');
    expect(said('the watch', 'gift from', 'Dana')).toBe('The watch was a gift from Dana.');
    expect(said('Mia', 'allergic to', 'peanuts')).toBe('Mia is allergic to peanuts.');
    // Every relation the list holds reads as a sentence of its own, never the claim line.
    for (const relation of MEMORY_RELATION_INDEX.keys()) {
      expect(said('A', relation, 'B'), relation).not.toBe(`A, ${relation}, B.`);
    }
  });

  it('reads the owner as you, in either place', () => {
    expect(said('Mia', 'daughter of', { owner: true })).toBe('Mia is your daughter.');
    expect(said({ owner: true }, 'owns', 'a blue bicycle')).toBe('You own a blue bicycle.');
    expect(said({ owner: true }, 'sister of', 'Tom')).toBe("You are Tom's sister.");
    expect(said({ owner: true }, 'born in', 'Cork')).toBe('You were born in Cork.');
    expect(said('Dana', 'lives with', { owner: true })).toBe('Dana lives with you.');
  });

  it("reads a chain's phrase and a linked end's name as written, and an owner's own relation as the claim line", () => {
    expect(said('Lena', 'mother of', "my cousin Sara's boyfriend")).toBe("Lena is my cousin Sara's boyfriend's mother.");
    expect(memoryClaimSentence({ subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'ct-1', name: 'Dana Whitfield' } }))
      .toBe("Mia is Dana Whitfield's daughter.");
    expect(said('Lena', "mother of my cousin's boyfriend", 'cousin Sara')).toBe("Lena, mother of my cousin's boyfriend, cousin Sara.");
    // A name with its own capitals stays as written.
    expect(said('iPhone', 'gift from', 'Dana')).toBe('iPhone was a gift from Dana.');
  });
});

describe('D-336 slice G (§3.1) — the relations that exclude each other between the same two ends', () => {
  it('the family relations exclude each other, except a relation and its general form', () => {
    expect(memoryRelationsExclude('daughter of', 'sister of')).toBe(true);
    expect(memoryRelationsExclude('daughter of', 'son of')).toBe(true);
    expect(memoryRelationsExclude('wife of', 'girlfriend of')).toBe(true);
    expect(memoryRelationsExclude('mother of', 'stepmother of')).toBe(true);
    expect(memoryRelationsExclude('partner of', 'ex-partner of')).toBe(true);
    // A relation and its general form agree, either way round and however spelled.
    expect(memoryRelationsExclude('daughter of', 'child of')).toBe(false);
    expect(memoryRelationsExclude('Child  Of', 'son of')).toBe(false);
    expect(memoryRelationsExclude('wife of', 'partner of')).toBe(false);
    // A relation never excludes itself.
    expect(memoryRelationsExclude('sister of', 'Sister of')).toBe(false);
  });

  it('the other ties are not family, and three opposite pairs exclude each other', () => {
    expect(memoryRelationsExclude('godmother of', 'aunt of')).toBe(false);
    expect(memoryRelationsExclude('friend of', 'neighbour of')).toBe(false);
    expect(memoryRelationsExclude('likes', 'dislikes')).toBe(true);
    expect(memoryRelationsExclude('avoids', 'prefers')).toBe(true);
    expect(memoryRelationsExclude('borrowed from', 'lent to')).toBe(true);
    expect(memoryRelationsExclude('likes', 'prefers')).toBe(false);
    expect(memoryRelationsExclude('owns', 'prefers')).toBe(false);
    expect(memoryRelationsExclude('lent to', 'gift from')).toBe(false);
  });

  it("a relation of the owner's own excludes nothing", () => {
    expect(memoryRelationsExclude('is', 'daughter of')).toBe(false);
    expect(memoryRelationsExclude("mother of my cousin's boyfriend", 'sister of')).toBe(false);
  });
});

describe('D-336 slice G — a held save\'s conflicts on its card and its ask', () => {
  const CONFLICTS = [
    { kind: 'contradicts', memory_id: 'umem_1', summary: "Mia is Dana's daughter." },
    { kind: 'also_in_memory', memory_id: 'umem_2', summary: 'Dana lives in Dublin.' },
    { kind: 'also_in_memory', memory_id: 'umem_3', summary: 'Dana lives in Galway.' },
  ] as const;

  it('reads as rows after the arguments: what it contradicts, and what else memory holds', () => {
    expect(memorySaveConflictRows(CONFLICTS)).toEqual({
      Contradicts: '"Mia is Dana\'s daughter."',
      'Also in memory': '"Dana lives in Dublin." · "Dana lives in Galway."',
    });
    expect(tier1CallDetails('memory.write', { summary: "Mia is Dana's sister." }, undefined, CONFLICTS).args).toEqual({
      summary: "Mia is Dana's sister.",
      Contradicts: '"Mia is Dana\'s daughter."',
      'Also in memory': '"Dana lives in Dublin." · "Dana lives in Galway."',
    });
  });

  it('D-336 slice J — reads the same fact saved already as its own row, between the two', () => {
    const met = [
      CONFLICTS[1],
      { kind: 'saved_already', memory_id: 'umem_4', summary: "Dana's daughter is called Mia." },
      { kind: 'saved_already', memory_id: 'umem_5', summary: 'Dana Whitfield 的女儿叫 Mia。' },
      CONFLICTS[0],
    ];
    const rows = memorySaveConflictRows(met);
    expect(rows).toEqual({
      Contradicts: '"Mia is Dana\'s daughter."',
      'Saved already': '"Dana\'s daughter is called Mia." · "Dana Whitfield 的女儿叫 Mia。"',
      'Also in memory': '"Dana lives in Dublin."',
    });
    expect(Object.keys(rows)).toEqual(['Contradicts', 'Saved already', 'Also in memory']);
  });

  it('D-336 slice O — reads a save of the fact asked already, which has no note yet, after the fact saved already', () => {
    const met = [
      CONFLICTS[1],
      { kind: 'asked_already', summary: "Mia is Dana Whitfield's daughter." },
      { kind: 'saved_already', memory_id: 'umem_4', summary: "Dana's daughter is called Mia." },
      { kind: 'asked_already', summary: '' },
    ];
    const rows = memorySaveConflictRows(met);
    expect(rows).toEqual({
      'Saved already': '"Dana\'s daughter is called Mia."',
      'Asked already': '"Mia is Dana Whitfield\'s daughter."',
      'Also in memory': '"Dana lives in Dublin."',
    });
    expect(Object.keys(rows)).toEqual(['Saved already', 'Asked already', 'Also in memory']);
  });

  it('D-336 slice O\'s open item — reads a save asked again after this one, right after the ones asked already', () => {
    const rows = memorySaveConflictRows([
      { kind: 'asked_again', summary: 'Dana Whitfield 的女儿叫 Mia' },
      { kind: 'asked_already', summary: "Mia is Dana Whitfield's daughter." },
      CONFLICTS[1],
      { kind: 'asked_again', summary: '  ' },
    ]);
    expect(rows).toEqual({
      'Asked already': '"Mia is Dana Whitfield\'s daughter."',
      'Asked again': '"Dana Whitfield 的女儿叫 Mia"',
      'Also in memory': '"Dana lives in Dublin."',
    });
    expect(Object.keys(rows)).toEqual(['Asked already', 'Asked again', 'Also in memory']);
  });

  it('D-336 slice S — reads a save asked while it waits that it contradicts, right after what memory contradicts', () => {
    const rows = memorySaveConflictRows([
      { kind: 'asked_again', summary: 'Dana Whitfield 的女儿叫 Mia' },
      { kind: 'contradicts_asked', summary: "Mia is Dana Whitfield's sister." },
      CONFLICTS[0],
      { kind: 'contradicts_asked', summary: ' ' },
    ]);
    expect(Object.keys(rows)).toEqual(['Contradicts', 'Contradicts what was asked', 'Asked again']);
    expect(rows['Contradicts what was asked']).toBe('"Mia is Dana Whitfield\'s sister."');
  });

  it('reads defensively, as off a stored hold, and only for a save', () => {
    expect(memorySaveConflictRows(undefined)).toEqual({});
    expect(memorySaveConflictRows('nope')).toEqual({});
    expect(memorySaveConflictRows([null, 4, { kind: 'contradicts' }, { kind: 'other', summary: 'x' }, { kind: 'contradicts', summary: '  ' }])).toEqual({});
    expect(tier1CallDetails('work.create', { kind: 'task', title: 'x' }, undefined, CONFLICTS).args).toEqual({ title: 'x' });
  });
});

// D-336 (spec §39, §45) — what a "matched by name" line links: the one end naming the record in
// words, where its relation lets that end be a person (a contact) or a thing (a thing you own).
describe('claimEndNamingInWords', () => {
  const claim = (subject: string, relation: string, object: string) =>
    ({ subject: { text: subject }, relation, object: { text: object } });

  it('the end that names it, matched as a key holds it', () => {
    expect(claimEndNamingInWords(claim('Mia', 'daughter of', 'Dana  WHITFIELD'), 'Dana Whitfield', 'person')).toBe('object');
    expect(claimEndNamingInWords(claim('the drill', 'lent to', 'Tom'), 'The drill', 'thing')).toBe('subject');
  });

  it('none where the relation takes another kind there, where both ends name it, or for no name', () => {
    // "lent to" takes a thing first and a person second.
    expect(claimEndNamingInWords(claim('Tom', 'lent to', 'the drill'), 'Tom', 'person')).toBeUndefined();
    expect(claimEndNamingInWords(claim('the drill', 'lent to', 'Tom'), 'the drill', 'person')).toBeUndefined();
    expect(claimEndNamingInWords(claim('Dana', 'friend of', 'Dana'), 'Dana', 'person')).toBeUndefined();
    expect(claimEndNamingInWords(claim('Mia', 'daughter of', 'Dana'), '  ', 'person')).toBeUndefined();
    // A linked end is linked already.
    expect(claimEndNamingInWords({ subject: { contact_id: 'c1', name: 'Dana' }, relation: 'friend of', object: { text: 'Sam' } }, 'Dana', 'person'))
      .toBeUndefined();
  });

  it("the owner's own relation takes either kind", () => {
    expect(claimEndNamingInWords(claim('the drill', 'keeps an eye on', 'Tom'), 'the drill', 'thing')).toBe('subject');
    expect(claimEndNamingInWords(claim('the drill', 'keeps an eye on', 'Tom'), 'Tom', 'person')).toBe('object');
  });
});
