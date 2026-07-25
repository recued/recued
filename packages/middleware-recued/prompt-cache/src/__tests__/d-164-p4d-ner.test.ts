import { describe, expect, it } from 'vitest';

import {
  extract,
  detectLanguages,
  type ExtractionResult,
  type ExtractOptions,
  gateExtraction,
  gateOne,
  type LanguageRules,
  type RawSlot,
  type SlotKind,
  type SlotValue,
} from '../ner/index';
import { extractRawSlots } from '../ner/extract';
import { EN_RULES } from '../ner/languages/en';
import { DE_RULES } from '../ner/languages/de';
import { ES_RULES } from '../ner/languages/es';
import { FR_RULES } from '../ner/languages/fr';
import { JA_RULES } from '../ner/languages/ja';
import { PT_RULES } from '../ner/languages/pt';
import { ZH_RULES } from '../ner/languages/zh';

const SLOT_KIND_REGISTRY: ReadonlyArray<SlotKind> = [
  'entity.name',
  'entity.email',
  'date',
  'time',
];

const makeRawSlot = (
  kind: SlotKind,
  raw: string,
  position = 0,
): RawSlot => ({
  kind,
  raw,
  position,
});

const extractWithOptions = (
  text: string,
  opts?: ExtractOptions,
): ExtractionResult | null => extract(text, opts);

const slotShapes = (
  slots: ReadonlyArray<SlotValue>,
): ReadonlyArray<Pick<SlotValue, 'kind' | 'raw' | 'value'>> => (
  slots.map(({ kind, raw, value }) => ({ kind, raw, value }))
);

const extractShape = (
  text: string,
  opts?: ExtractOptions,
): { readonly locale: string; readonly slots: ReturnType<typeof slotShapes> } | null => {
  const result = extractWithOptions(text, opts);
  if (result === null) return null;
  return {
    locale: result.locale,
    slots: slotShapes(result.slots),
  };
};

const LATIN_LANGUAGE_CASES: ReadonlyArray<
  readonly [string, LanguageRules, string, string]
> = [
  ['de', DE_RULES, 'Wie lautet die E-Mail-Adresse von Jörg Müller?', 'Jörg Müller'],
  ['es', ES_RULES, '¿Cuál es el correo electrónico de María García?', 'María García'],
  ['fr', FR_RULES, 'Quelle est l’adresse e-mail de François Dupont ?', 'François Dupont'],
  ['pt', PT_RULES, 'Qual é o e-mail de João da Silva?', 'João da Silva'],
];

describe('D-164 P4d slot vocabulary', () => {
  it('keeps the universal slot vocabulary closed to entity.name, entity.email, date, and time', () => {
    const raws = extractRawSlots(
      'about Mary Jane Watson at bob@example.com on 2024-02-29 23:59',
      EN_RULES,
    );

    expect(SLOT_KIND_REGISTRY).toEqual([
      'entity.name',
      'entity.email',
      'date',
      'time',
    ]);
    expect([...new Set(raws.map((slot) => slot.kind))].sort()).toEqual(
      [...SLOT_KIND_REGISTRY].sort(),
    );
  });
});

describe('D-164 P4d extractRawSlots', () => {
  it('returns [] for empty text without calling the language extractor', () => {
    let calls = 0;
    const language: LanguageRules = {
      locale: 'test',
      extract: () => {
        calls += 1;
        return [makeRawSlot('entity.name', 'Alice Bond')];
      },
    };

    expect(extractRawSlots('', language)).toEqual([]);
    expect(calls).toEqual(0);
  });

  it('returns universal spans before language spans in discovery order', () => {
    const language: LanguageRules = {
      locale: 'test',
      extract: () => [makeRawSlot('entity.name', 'Alice Bond', 0)],
    };

    const raws = extractRawSlots(
      'Alice Bond emailed bob@example.com on 2024-02-29 at 23:59',
      language,
    );

    // Discovery order: email -> date -> time -> name; not position order.
    expect(raws.map(({ kind, raw }) => ({ kind, raw }))).toEqual([
      { kind: 'entity.email', raw: 'bob@example.com' },
      { kind: 'date', raw: '2024-02-29' },
      { kind: 'time', raw: '23:59' },
      { kind: 'entity.name', raw: 'Alice Bond' },
    ]);
  });
});

describe('D-164 P4d extract email folds', () => {
  it.each([
    [
      'URL path suffix',
      'open https://bob@example.com/profile',
      'bob@example.com',
    ],
    [
      'filesystem path suffix',
      'send to /alice@x.com\\path',
      'alice@x.com',
    ],
    [
      'sentence bridge with uppercase next token',
      'email bob@example.com.Then show details',
      'bob@example.com',
    ],
  ])('emits only the email address for %s', (_label, text, email) => {
    expect(extractShape(text, { locale: 'en' })).toEqual({
      locale: 'en',
      slots: [
        { kind: 'entity.email', raw: email, value: email },
      ],
    });
  });

  it('keeps a plain lowercase-TLD email as the passing reference case', () => {
    expect(extractShape('email bob@example.com then show details', { locale: 'en' })).toEqual({
      locale: 'en',
      slots: [
        {
          kind: 'entity.email',
          raw: 'bob@example.com',
          value: 'bob@example.com',
        },
      ],
    });
  });
});

describe('D-164 P4d extract date folds', () => {
  it.each([
    ['non-leap Feb 29 round-trip mismatch', '2023-02-29'],
    ['invalid month and day', '2026-13-99'],
    ['invalid calendar day', '2026-04-31'],
    ['year below YEAR_FLOOR 1900', '0000-01-01'],
    ['year above YEAR_CEILING 2100', '9999-12-31'],
  ])('drops %s (%s)', (_label, raw) => {
    expect(extractShape(`meet on ${raw}`, { locale: 'en' })).toEqual(null);
  });

  it('accepts leap-year Feb 29 as the passing reference case', () => {
    expect(extractShape('meet on 2024-02-29', { locale: 'en' })).toEqual({
      locale: 'en',
      slots: [
        { kind: 'date', raw: '2024-02-29', value: '2024-02-29' },
      ],
    });
  });
});

describe('D-164 P4d extract time folds', () => {
  it('drops fractional seconds instead of backtracking to HH:MM', () => {
    expect(extractShape('at 23:59:59.123 here', { locale: 'en' })).toEqual(null);
  });

  it('accepts HH:MM:SS as the passing reference case', () => {
    expect(extractShape('at 23:59:59 here', { locale: 'en' })).toEqual({
      locale: 'en',
      slots: [
        { kind: 'time', raw: '23:59:59', value: '23:59:59' },
      ],
    });
  });

  it('drops 24:00 after the certainty gate', () => {
    expect(extractShape('at 24:00', { locale: 'en' })).toEqual(null);
  });
});

describe('D-164 P4d EN_RULES name certainty', () => {
  it('drops hyphen and apostrophe name fragments without emitting partial names', () => {
    for (const text of [
      'about Jean-Luc Picard',
      "about O'Brien Smith",
      "about Jane O'Connor",
    ]) {
      expect(extractWithOptions(text, { locale: 'en' })).toEqual(null);
    }
  });

  it('drops command-verb heads at the start of a proper-noun run', () => {
    for (const text of [
      'Status: Email Alice Smith',
      'Find Mary Jane Watson',
      'Search Bob Anderson',
    ]) {
      expect(extractWithOptions(text, { locale: 'en' })).toEqual(null);
    }
  });

  it('extracts a non-fragment three-word proper-noun run', () => {
    expect(EN_RULES.extract('near Mary Jane Watson')).toEqual([
      {
        kind: 'entity.name',
        raw: 'Mary Jane Watson',
        position: 5,
      },
    ]);
  });

  it('extracts a non-command two-word proper-noun run', () => {
    expect(EN_RULES.extract('near Alice Bond')).toEqual([
      {
        kind: 'entity.name',
        raw: 'Alice Bond',
        position: 5,
      },
    ]);
  });

  it('drops one-word mixed-case and all-caps-headed candidates', () => {
    expect(EN_RULES.extract('near McDonald')).toEqual([]);
    expect(EN_RULES.extract('near NASA Programs')).toEqual([]);
  });

  it('keeps a non-command name as the passing reference case', () => {
    expect(extractShape('status: about Alice Smith', { locale: 'en' })).toEqual({
      locale: 'en',
      slots: [
        {
          kind: 'entity.name',
          raw: 'Alice Smith',
          value: 'Alice Smith',
        },
      ],
    });
  });
});

describe('D-164 P4d EN_RULES name recall refinements', () => {
  it('emits a prompt-initial name (no longer dropped as sentence-initial)', () => {
    expect(EN_RULES.extract('Maya Chen has not replied to my email')).toEqual([
      { kind: 'entity.name', raw: 'Maya Chen', position: 0 },
    ]);
  });

  it('emits a name behind an abbreviated title (period no longer reads as a boundary)', () => {
    expect(
      EN_RULES.extract('How engaged has Dr. Aris Thorne been lately').map((s) => s.raw),
    ).toContain('Aris Thorne');
  });

  it('emits the first name after a clause break', () => {
    expect(
      EN_RULES.extract('The proposal was rejected. Maya Chen also flagged it').map((s) => s.raw),
    ).toContain('Maya Chen');
  });

  it('keeps a possessive name intact (straight and curly apostrophe)', () => {
    for (const text of [
      "What is the status of Ben Carter's renewal",
      'What is the status of Ben Carter’s renewal',
    ]) {
      expect(EN_RULES.extract(text).map((s) => s.raw)).toContain('Ben Carter');
    }
  });

  it('still drops leading hyphen / apostrophe name fragments', () => {
    expect(EN_RULES.extract('about Jean-Luc Picard')).toEqual([]);
    expect(EN_RULES.extract("about O'Brien Smith")).toEqual([]);
  });

  it('still drops command / imperative heads whole', () => {
    expect(EN_RULES.extract('Find Mary Jane Watson')).toEqual([]);
    expect(EN_RULES.extract('Schedule Mary Jane Watson')).toEqual([]);
  });

  it('trims a fused leading-aux + abbreviated title, keeping only the real name', () => {
    const out = EN_RULES.extract('Does Dr. Aris Thorne have my report').map((s) => s.raw);
    expect(out).toContain('Aris Thorne');
    expect(out).not.toContain('Does Dr');
    expect(out).not.toContain('Does');
  });

  it('strips a genealogical suffix while keeping the name', () => {
    expect(EN_RULES.extract('email Martin Luther King Jr. today').map((s) => s.raw)).toEqual([
      'Martin Luther King',
    ]);
  });
});

describe('D-164 contextual known-name recovery', () => {
  it.each([
    ["what is alice bond's email?", 'Alice Bond', 'alice bond'],
    ["what is Sarah's email?", 'Sarah', 'Sarah'],
    ["what is Jean-Luc Picard's email?", 'Jean-Luc Picard', 'Jean-Luc Picard'],
    ['what is O’Connor Smith’s email?', 'O’Connor Smith', 'O’Connor Smith'],
    ["what is J. Robert Oppenheimer's email?", 'J. Robert Oppenheimer', 'J. Robert Oppenheimer'],
  ])('recovers an exact stored Latin name in %s', (text, canonical, raw) => {
    const result = extract(text, { knownNames: [canonical] });
    expect(result?.slots.filter((slot) => slot.kind === 'entity.name')).toEqual([{
      kind: 'entity.name',
      value: canonical,
      raw,
      position: text.indexOf(raw),
    }]);
  });

  it('uses the containing known name instead of a typography-derived partial name', () => {
    const result = extract("what is J. Robert Oppenheimer's email?", {
      knownNames: ['J. Robert Oppenheimer'],
    });
    expect(result?.slots.filter((slot) => slot.kind === 'entity.name').map((slot) => slot.value))
      .toEqual(['J. Robert Oppenheimer']);
    expect(result?.slots.map((slot) => slot.value)).not.toContain('Robert Oppenheimer');
  });

  it('drops an initialed-name suffix when no contextual candidate can prove the full span', () => {
    expect(extract("what is J. Robert Oppenheimer's email?")).toBeNull();
  });

  it('carries the canonical warehouse spelling while preserving a decomposed prompt span', () => {
    const decomposed = 'E\u0301lodie Martin';
    const text = `What is ${decomposed}’s email?`;
    const result = extract(text, { knownNames: ['Élodie Martin'] });
    expect(result?.slots.filter((slot) => slot.kind === 'entity.name')).toEqual([{
      kind: 'entity.name',
      value: 'Élodie Martin',
      raw: decomposed,
      position: text.indexOf(decomposed),
    }]);
  });

  it.each([
    ['alice bondのメールアドレスは？', 'ja'],
    ['请问alice bond的邮箱是什么？', 'zh'],
  ])('recovers a Latin name adjacent to CJK grammar: %s', (text, locale) => {
    const result = extract(text, { knownNames: ['Alice Bond'] });
    expect(result?.locale).toBe(locale);
    expect(result?.slots.filter((slot) => slot.kind === 'entity.name').map((slot) => slot.value))
      .toEqual(['Alice Bond']);
  });

  it('preserves two distinct recovered names for the downstream ambiguity guard', () => {
    const result = extract("what is alice bond's email and bob stone's phone?", {
      knownNames: ['Alice Bond', 'Bob Stone'],
    });
    expect(result?.slots.filter((slot) => slot.kind === 'entity.name').map((slot) => slot.value))
      .toEqual(['Alice Bond', 'Bob Stone']);
  });

  it.each([
    ['what is Sarahson’s email?', 'Sarah'],
    ['what is Jean-Sarah’s email?', 'Sarah'],
    ["what is O'Sarah's email?", 'Sarah'],
    ['what is ﬃ’s email?', 'Fi'],
    ["what is alice bond's email?", 'Bond'],
    ["what is alice bond smith's email?", 'Bond Smith'],
    ["what is will sarah's email?", 'Sarah'],
  ])('does not recover a known value from inside a longer Latin name atom: %s', (text, name) => {
    expect(extract(text, { knownNames: [name] })).toBeNull();
  });

  it.each([
    ["what is Sarah's email?", 'Sarah'],
    ["what's Sarah's email?", 'Sarah'],
    ['wo arbeitet Sarah?', 'Sarah'],
    ['¿dónde trabaja Sarah?', 'Sarah'],
    ['où travaille Sarah ?', 'Sarah'],
    ['onde trabalha Sarah?', 'Sarah'],
  ])('retains a single-token name in an anchored read context: %s', (text, name) => {
    expect(extract(text, { knownNames: [name] })?.slots.map((slot) => slot.value))
      .toEqual([name]);
  });

  it('does not widen compatibility lookalikes beyond canonical NFC/NFD equivalence', () => {
    expect(extract('what is ﬃ’s email?', { knownNames: ['Ffi'] })).toBeNull();
    expect(extract('what is Ａｌｉｃｅ’s email?', { knownNames: ['Alice'] })).toBeNull();
  });

  it('leaves unmatched and non-Latin proposals inert', () => {
    expect(extract('what is alice bond’s email?', { knownNames: ['Bob Stone', '张伟'] }))
      .toBeNull();
  });
});

describe('D-164 P4d locale normalisation', () => {
  it.each([
    ['en-US'],
    ['En-Us'],
    ['en_US'],
  ])('normalises %s to the English primary tag', (locale) => {
    expect(extractShape('email bob@example.com', { locale })).toEqual({
      locale: 'en',
      slots: [
        {
          kind: 'entity.email',
          raw: 'bob@example.com',
          value: 'bob@example.com',
        },
      ],
    });
  });

  it('falls back from an unknown locale to English and reports the resolved locale', () => {
    expect(extractShape('email bob@example.com', { locale: 'xx' })).toEqual({
      locale: 'en',
      slots: [
        {
          kind: 'entity.email',
          raw: 'bob@example.com',
          value: 'bob@example.com',
        },
      ],
    });
  });

  it('defaults to English when no locale is supplied', () => {
    expect(extractShape('email bob@example.com')).toEqual({
      locale: 'en',
      slots: [
        {
          kind: 'entity.email',
          raw: 'bob@example.com',
          value: 'bob@example.com',
        },
      ],
    });
  });
});

describe('D-164 P4d gateOne', () => {
  it('canonicalises entity.email to lowercase while retaining the raw span', () => {
    expect(gateOne(makeRawSlot('entity.email', 'Bob@Example.COM', 7))).toEqual({
      kind: 'entity.email',
      value: 'bob@example.com',
      raw: 'Bob@Example.COM',
      position: 7,
    });
  });

  it.each([
    ['year below floor', '1899-12-31'],
    ['year above ceiling', '2101-01-01'],
    ['month out of range', '2026-13-01'],
    ['day out of range', '2026-04-32'],
    ['round-trip mismatch', '2026-04-31'],
  ])('drops date for %s (%s)', (_label, raw) => {
    expect(gateOne(makeRawSlot('date', raw, 11))).toEqual(null);
  });

  it('accepts a valid date inside the documented 1900..2100 window', () => {
    expect(gateOne(makeRawSlot('date', '2024-02-29', 11))).toEqual({
      kind: 'date',
      value: '2024-02-29',
      raw: '2024-02-29',
      position: 11,
    });
  });

  it.each([
    [
      '23:59',
      {
        kind: 'time',
        value: '23:59',
        raw: '23:59',
        position: 4,
      },
    ],
    ['24:00', null],
    ['29:59', null],
  ])('gates time boundary %s', (raw, expected) => {
    expect(gateOne(makeRawSlot('time', raw, 4))).toEqual(expected);
  });

  it('passes entity.name through without an extra certainty rule', () => {
    expect(gateOne(makeRawSlot('entity.name', 'Alice Bond', 13))).toEqual({
      kind: 'entity.name',
      value: 'Alice Bond',
      raw: 'Alice Bond',
      position: 13,
    });
  });
});

describe('D-164 P4d gateExtraction', () => {
  it('returns [] for empty input', () => {
    expect(gateExtraction([])).toEqual([]);
  });

  it('keeps only certain slots from mixed input in input order', () => {
    expect(gateExtraction([
      makeRawSlot('entity.email', 'Bob@Example.COM', 0),
      makeRawSlot('date', '2023-02-29', 16),
      makeRawSlot('time', '24:00', 27),
      makeRawSlot('entity.name', 'Alice Bond', 33),
    ])).toEqual([
      {
        kind: 'entity.email',
        value: 'bob@example.com',
        raw: 'Bob@Example.COM',
        position: 0,
      },
      {
        kind: 'entity.name',
        value: 'Alice Bond',
        raw: 'Alice Bond',
        position: 33,
      },
    ]);
  });

  it('keeps all certain slots with canonical values', () => {
    expect(gateExtraction([
      makeRawSlot('entity.email', 'bob@example.com', 1),
      makeRawSlot('date', '2024-02-29', 2),
      makeRawSlot('time', '23:59:59', 3),
      makeRawSlot('entity.name', 'Alice Bond', 4),
    ])).toEqual([
      {
        kind: 'entity.email',
        value: 'bob@example.com',
        raw: 'bob@example.com',
        position: 1,
      },
      {
        kind: 'date',
        value: '2024-02-29',
        raw: '2024-02-29',
        position: 2,
      },
      {
        kind: 'time',
        value: '23:59:59',
        raw: '23:59:59',
        position: 3,
      },
      {
        kind: 'entity.name',
        value: 'Alice Bond',
        raw: 'Alice Bond',
        position: 4,
      },
    ]);
  });

  it('preserves discovery-order input rather than sorting by text position', () => {
    const slots = gateExtraction([
      makeRawSlot('entity.email', 'bob@example.com', 40),
      makeRawSlot('date', '2024-02-29', 30),
      makeRawSlot('time', '23:59', 20),
      makeRawSlot('entity.name', 'Alice Bond', 10),
    ]);

    expect(slots.map(({ kind, position }) => ({ kind, position }))).toEqual([
      { kind: 'entity.email', position: 40 },
      { kind: 'date', position: 30 },
      { kind: 'time', position: 20 },
      { kind: 'entity.name', position: 10 },
    ]);
  });
});

describe('D-164 P4d extract end-to-end shapes', () => {
  it('returns a multi-slot result with discovery-order slots and resolved locale', () => {
    expect(extractShape(
      'email bob@example.com on 2024-02-29 at 23:59 about Mary Jane Watson',
      { locale: 'en' },
    )).toEqual({
      locale: 'en',
      slots: [
        {
          kind: 'entity.email',
          raw: 'bob@example.com',
          value: 'bob@example.com',
        },
        { kind: 'date', raw: '2024-02-29', value: '2024-02-29' },
        { kind: 'time', raw: '23:59', value: '23:59' },
        {
          kind: 'entity.name',
          raw: 'Mary Jane Watson',
          value: 'Mary Jane Watson',
        },
      ],
    });
  });

  it('returns null when the certainty gate empties the extraction', () => {
    expect(extractWithOptions(
      'Find Mary Jane Watson at 24:00 on 2023-02-29',
      { locale: 'en' },
    )).toEqual(null);
  });
});

describe('D-164 P4d multilingual extraction ladder', () => {
  it.each(LATIN_LANGUAGE_CASES)(
    '%s extracts a Unicode Latin name and reports that intent locale',
    (locale, rules, text, name) => {
      expect(rules.extract(text)).toContainEqual({
        kind: 'entity.name',
        raw: name,
        position: text.indexOf(name),
      });
      expect(extractShape(text, { locale })).toEqual({
        locale,
        slots: [{ kind: 'entity.name', raw: name, value: name }],
      });
    },
  );

  it('extracts a Japanese name only in a deterministic intent context', () => {
    expect(JA_RULES.extract('山田太郎のメールアドレスは？')).toEqual([
      { kind: 'entity.name', raw: '山田太郎', position: 0 },
    ]);
    expect(JA_RULES.extract('山田太郎について教えて')).toEqual([]);
  });

  it('extracts a Chinese name only in a deterministic intent context', () => {
    expect(ZH_RULES.extract('请问张伟的邮箱是什么？')).toEqual([
      { kind: 'entity.name', raw: '张伟', position: 2 },
    ]);
    expect(ZH_RULES.extract('告诉我张伟的故事')).toEqual([]);
  });

  it('uses intent words for the primary locale and scripts for additional candidates', () => {
    const text = "What's 山田太郎's email?";
    expect(detectLanguages(text)).toEqual({
      locale: 'en',
      localeCandidates: ['en', 'ja', 'zh'],
    });
    expect(extract(text)).toEqual({
      locale: 'en',
      localeCandidates: ['en', 'ja', 'zh'],
      slots: [{
        kind: 'entity.name',
        raw: '山田太郎',
        value: '山田太郎',
        position: 7,
      }],
    });
  });

  it('keeps the longest cross-bundle span for a spaced Japanese name', () => {
    const result = extract("What's 山田 太郎's email?");
    expect(result?.locale).toBe('en');
    expect(result?.slots.map((slot) => slot.value)).toEqual(['山田 太郎']);
  });

  it('keeps the request language when an accented foreign name appears in English', () => {
    const result = extract('What is María García’s email address?');
    expect(result?.locale).toBe('en');
    expect(result?.localeCandidates).toEqual(expect.arrayContaining(['es', 'fr', 'pt']));
    expect(result?.slots.map((slot) => slot.value)).toEqual(['María García']);
  });

  it('merges and deduplicates bundles instead of selecting only one language', () => {
    const result = extract(
      "¿Cuál es el correo electrónico de María García? What's 山田太郎's email?",
    );
    expect(result?.locale).toBe('es');
    expect(result?.slots.filter((slot) => slot.kind === 'entity.name').map((slot) => slot.value))
      .toEqual(['María García', '山田太郎']);
    expect(result?.localeCandidates).toEqual(expect.arrayContaining(['es', 'ja', 'zh']));
  });
});
