import { describe, it, expect } from 'vitest';
import {
  createLedger,
  aliasIdentifierField,
  buildKnownValueIndex,
  aliasKnownValuesInContent,
  decorateOverlapReveal,
  restoreInString,
  tokenizeForOverlap,
  type KnownValueSeed,
  type Ledger,
} from '../pii-alias.js';

const index = (seeds: readonly KnownValueSeed[]) => buildKnownValueIndex(seeds);

const expectRestoredClean = (ledger: Ledger, text: string, expected: string): void => {
  const restored = restoreInString(ledger, text);
  expect(restored).toBe(expected);
  expect(restored).not.toContain('pii.');
  expect(restored).not.toContain('.invalid');
};

describe('decorateOverlapReveal — recall overlap suffix', () => {
  it('decorates a basic name overlap and restore strips the disclosed suffix', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Sarah Smith owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('who is Sarah'));

    expect(text).toBe('memory says pii.Person1 owns the rollout');
    expect(decorated).toBe('memory says pii.Person1.sarah owns the rollout');
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('does not over-reveal undisclosed surname tokens', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Sarah Smith owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('who is Sarah'));

    expect(decorated).toContain('pii.Person1.sarah');
    expect(decorated).not.toMatch(/smith/i);
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('leaves a bare person alias unchanged when there is no disclosed overlap', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Bob Jones owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Bob Jones', kind: 'name' }]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('who is Sarah'));

    expect(text).toBe('memory says pii.Person1 owns the rollout');
    expect(decorated).toBe(text);
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('decorates every disclosed entity token in entity order', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Sarah Smith owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('Sarah Smith'));

    expect(decorated).toBe('memory says pii.Person1.sarah.smith owns the rollout');
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('caps an overlap suffix at three segments', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Ana Maria Lucia Castellanos owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Ana Maria Lucia Castellanos', kind: 'name' }]),
    );
    const decorated = decorateOverlapReveal(
      ledger,
      text,
      tokenizeForOverlap('Ana Maria Lucia Castellanos'),
    );
    const suffix = decorated.match(/\bpii\.Person1((?:\.[a-z0-9-]+)+)\b/)?.[1] ?? '';

    expect(decorated).toContain('pii.Person1.ana.maria.lucia');
    expect(decorated).not.toContain('castellanos');
    expect(suffix.split('.').filter(Boolean)).toHaveLength(3);
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('decorates an org overlap without revealing the undisclosed org tail', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Acme Corporation owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Acme Corporation', kind: 'org' }]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('tell me about Acme'));

    expect(text).toBe('memory says pii.Org1 owns the rollout');
    expect(decorated).toBe('memory says pii.Org1.acme owns the rollout');
    expect(decorated).not.toMatch(/corporation/i);
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('is idempotent across repeated overlap decoration', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Sarah Smith owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
    );
    const disclosed = tokenizeForOverlap('who is Sarah');
    const once = decorateOverlapReveal(ledger, text, disclosed);
    const twice = decorateOverlapReveal(ledger, once, disclosed);

    expect(once).toBe('memory says pii.Person1.sarah owns the rollout');
    expect(twice).toBe(once);
    expectRestoredClean(ledger, twice, recalled);
  });

  it('leaves phone, address, and email composite aliases untouched', () => {
    const ledger = createLedger('s');
    const recalled = 'call +1 415 555 0199 or email alice@acme.com';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([]),
      [
        { kind: 'phone', value: '+14155550199' },
        { kind: 'email', value: 'alice@acme.com' },
      ],
    );
    const addressAlias = aliasIdentifierField(
      ledger,
      'address',
      '1 Main St, San Francisco, CA 94102, USA',
    );
    const aliased = `${text}; office ${addressAlias}`;
    const decorated = decorateOverlapReveal(
      ledger,
      aliased,
      tokenizeForOverlap('alice Acme 415 San Francisco'),
    );

    expect(text).toContain('pii.Phone1.us');
    expect(text).toContain('m1@d1.invalid');
    expect(addressAlias).toBe('pii.Address1.san-francisco.ca.usa');
    expect(decorated).toBe(aliased);
    expect(decorated).toContain('pii.Phone1.us');
    expect(decorated).toContain('m1@d1.invalid');
    expect(decorated).toContain('pii.Address1.san-francisco.ca.usa');
    expectRestoredClean(
      ledger,
      decorated,
      'call +14155550199 or email alice@acme.com; office 1 Main St, San Francisco, CA 94102, USA',
    );
  });

  it('decorates casing siblings and restores the exact uppercase variant', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says SARAH SMITH owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('sarah'));

    expect(text).toBe('memory says cap_pii.Person1 owns the rollout');
    expect(decorated).toBe('memory says cap_pii.Person1.sarah owns the rollout');
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('fails closed for accent and non-Latin overlap suffixes', () => {
    const accentLedger = createLedger('accent');
    const accentRecalled = 'memory says José Smith owns the rollout';
    const { text: accentText } = aliasKnownValuesInContent(
      accentLedger,
      accentRecalled,
      index([{ value: 'José Smith', kind: 'name' }]),
    );
    const accentDecorated = decorateOverlapReveal(
      accentLedger,
      accentText,
      tokenizeForOverlap('Jose'),
    );

    expect(accentText).toBe('memory says pii.Person1 owns the rollout');
    expect(accentDecorated).toBe(accentText);
    expectRestoredClean(accentLedger, accentDecorated, accentRecalled);

    const scriptLedger = createLedger('script');
    const scriptRecalled = 'memory says 東京 太郎 owns the rollout';
    const { text: scriptText } = aliasKnownValuesInContent(
      scriptLedger,
      scriptRecalled,
      index([{ value: '東京 太郎', kind: 'name' }]),
    );
    const scriptDecorated = decorateOverlapReveal(
      scriptLedger,
      scriptText,
      tokenizeForOverlap('東京 太郎'),
    );

    expect(scriptText).toBe('memory says pii.Person1 owns the rollout');
    expect(scriptDecorated).toBe(scriptText);
    expectRestoredClean(scriptLedger, scriptDecorated, scriptRecalled);
  });

  it('reveals only the disclosed entity and leaves a co-occurring undisclosed one opaque', () => {
    // The headline "protection scales with disclosure" property in ONE pass: the
    // user partially named Sarah (revealed) but said nothing of Bob (stays fully
    // opaque). Exercises per-match independence — one alias decorated, the next
    // left bare, in a single global replace.
    const ledger = createLedger('s');
    const recalled = 'memory says Sarah Smith and Bob Jones own the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([
        { value: 'Sarah Smith', kind: 'name' },
        { value: 'Bob Jones', kind: 'name' },
      ]),
    );
    const decorated = decorateOverlapReveal(ledger, text, tokenizeForOverlap('who is Sarah'));

    expect(text).toBe('memory says pii.Person1 and pii.Person2 own the rollout');
    expect(decorated).toBe('memory says pii.Person1.sarah and pii.Person2 own the rollout');
    expectRestoredClean(ledger, decorated, recalled);
  });

  it('returns input unchanged for an empty disclosed set or empty text', () => {
    const ledger = createLedger('s');
    const recalled = 'memory says Sarah Smith owns the rollout';
    const { text } = aliasKnownValuesInContent(
      ledger,
      recalled,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
    );

    expect(decorateOverlapReveal(ledger, text, new Set())).toBe(text);
    expect(decorateOverlapReveal(ledger, '', tokenizeForOverlap('Sarah'))).toBe('');
  });
});

describe('tokenizeForOverlap', () => {
  it('folds casing, drops single-codepoint tokens, and returns a Set', () => {
    const upper = tokenizeForOverlap('Sarah');
    const lower = tokenizeForOverlap('sarah a I');
    const [folded] = [...upper];

    expect(upper).toBeInstanceOf(Set);
    expect(lower).toBeInstanceOf(Set);
    expect(lower.has(folded!)).toBe(true);
    expect([...tokenizeForOverlap('Sarah')]).toEqual([...tokenizeForOverlap('sarah')]);
    expect(tokenizeForOverlap('a I')).toEqual(new Set());
  });
});
