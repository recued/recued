import { describe, expect, it } from 'vitest';
import {
  MESSAGE_MATCH_MAX_PATTERNS,
  MESSAGE_MATCH_PATTERN_VALUE_MAX,
  MESSAGE_MATCH_TEXT_SCAN_MAX,
  matchMessage,
  messageMatches,
  tokenizeMessageText,
  validateMessageMatchPattern,
  validateMessageMatchPatterns,
  type MessageMatchPattern,
  type MessageProjection,
} from '../message-match.js';

const proj = (text: string, override: Partial<MessageProjection> = {}): MessageProjection => ({
  vendor: 'slack',
  sender: 'U0',
  text,
  ...override,
});

describe('tokenizeMessageText', () => {
  it('extracts lowercased tags, deduped in order of appearance', () => {
    expect(tokenizeMessageText('ship #commit now').tags).toEqual(['commit']);
    expect(tokenizeMessageText('(#commit),').tags).toEqual(['commit']);
    expect(tokenizeMessageText('C# and F#').tags).toEqual([]);
    expect(tokenizeMessageText('a#b').tags).toEqual([]);
    expect(tokenizeMessageText('#a#b').tags).toEqual(['a']);
    expect(tokenizeMessageText('#café #日本').tags).toEqual(['café', '日本']);
    expect(tokenizeMessageText('#x #X #x').tags).toEqual(['x']);
    expect(tokenizeMessageText('').tags).toEqual([]);
    expect(tokenizeMessageText('no tags').tags).toEqual([]);
  });

  it('extracts lowercased mentions, including Slack mention ids', () => {
    expect(tokenizeMessageText('@anna @bob').mentions).toEqual(['anna', 'bob']);
    expect(tokenizeMessageText('bob@acme.com').mentions).toEqual([]);
    expect(tokenizeMessageText('<@U08ABC>').mentions).toEqual(['u08abc']);
    expect(tokenizeMessageText('<@U08ABC|Anna>').mentions).toEqual(['u08abc']);
    expect(tokenizeMessageText('@Anna @anna').mentions).toEqual(['anna']);
  });

  it('does not scan text beyond the cap', () => {
    expect(
      tokenizeMessageText(`${'x'.repeat(MESSAGE_MATCH_TEXT_SCAN_MAX)} #late`).tags,
    ).not.toContain('late');
  });

  it('normalizes NFC and NFD tokens consistently', () => {
    expect(tokenizeMessageText('#café').tags).toEqual(['café']);
    expect(tokenizeMessageText('#cafe\u0301').tags).toEqual(['café']);
    expect(tokenizeMessageText('#cafe\u0301x').tags).toEqual(['caféx']);
    expect(tokenizeMessageText('café#x').tags).toEqual([]);
    expect(tokenizeMessageText('cafe\u0301#x').tags).toEqual([]);
  });
});

describe('matchMessage', () => {
  it('matches tags with forgiving sigils and canonical matched shape', () => {
    const a: MessageMatchPattern = { kind: 'tag', value: '#commit' };
    const b: MessageMatchPattern = { kind: 'tag', value: 'commit' };
    const c: MessageMatchPattern = { kind: 'tag', value: '#Commit' };
    const missing: MessageMatchPattern = { kind: 'tag', value: 'urgent' };
    expect(matchMessage([a, b, c], proj('ship #Commit now'))).toEqual([
      { pattern: a, matched: '#commit' },
      { pattern: b, matched: '#commit' },
      { pattern: c, matched: '#commit' },
    ]);
    expect(matchMessage([missing], proj('ship #Commit now'))).toEqual([]);
  });

  it('matches mentions with forgiving sigils and canonical matched shape', () => {
    const slackId: MessageMatchPattern = { kind: 'mention', value: 'U08ABC' };
    const handle: MessageMatchPattern = { kind: 'mention', value: '@anna' };
    const cased: MessageMatchPattern = { kind: 'mention', value: '@Anna' };
    const missing: MessageMatchPattern = { kind: 'mention', value: 'bob' };
    expect(matchMessage([slackId], proj('ping <@U08ABC>'))).toEqual([
      { pattern: slackId, matched: '@u08abc' },
    ]);
    expect(matchMessage([handle, cased], proj('ping @anna'))).toEqual([
      { pattern: handle, matched: '@anna' },
      { pattern: cased, matched: '@anna' },
    ]);
    expect(matchMessage([missing], proj('ping @anna'))).toEqual([]);
  });

  it('matches content contains by default and preserves actual-case substring', () => {
    const pattern: MessageMatchPattern = { kind: 'content', value: "I'll send" };
    const missing: MessageMatchPattern = { kind: 'content', value: "I'll ship" };
    expect(matchMessage([pattern], proj("Sure I'LL SEND it"))).toEqual([
      { pattern, matched: "I'LL SEND" },
    ]);
    expect(matchMessage([missing], proj("Sure I'LL SEND it"))).toEqual([]);
  });

  it('matches content word mode only on token boundaries', () => {
    const pattern: MessageMatchPattern = { kind: 'content', value: 'commit', mode: 'word' };
    expect(matchMessage([pattern], proj('will Commit today'))).toEqual([
      { pattern, matched: 'Commit' },
    ]);
    expect(matchMessage([pattern], proj('I committed'))).toEqual([]);
  });

  it('treats regex-special content as a literal substring', () => {
    const pattern: MessageMatchPattern = { kind: 'content', value: 'a.b' };
    expect(matchMessage([pattern], proj('axb'))).toEqual([]);
    expect(matchMessage([pattern], proj('a.b'))).toEqual([{ pattern, matched: 'a.b' }]);
  });

  it('uses OR semantics and returns matches in pattern order', () => {
    const tagNope: MessageMatchPattern = { kind: 'tag', value: 'nope' };
    const friday: MessageMatchPattern = { kind: 'content', value: 'friday' };
    const tagX: MessageMatchPattern = { kind: 'tag', value: 'x' };
    expect(matchMessage([tagNope, friday, tagX], proj('by friday #x'))).toEqual([
      { pattern: friday, matched: 'friday' },
      { pattern: tagX, matched: '#x' },
    ]);
  });

  it('prefers structured projection tags and treats explicit empty arrays as authoritative', () => {
    const urgent: MessageMatchPattern = { kind: 'tag', value: 'urgent' };
    const real: MessageMatchPattern = { kind: 'tag', value: 'real' };
    expect(matchMessage([urgent], proj('no hashtag', { tags: ['urgent'] }))).toEqual([
      { pattern: urgent, matched: '#urgent' },
    ]);
    expect(matchMessage([real], proj('#real', { tags: [] }))).toEqual([]);
  });

  it('normalizes projection-supplied tag and mention sigils', () => {
    const tag: MessageMatchPattern = { kind: 'tag', value: 'commit' };
    const mention: MessageMatchPattern = { kind: 'mention', value: 'anna' };
    expect(matchMessage([tag], proj('x', { tags: ['#Commit'] }))).toEqual([
      { pattern: tag, matched: '#commit' },
    ]);
    expect(matchMessage([mention], proj('x', { mentions: ['@Anna'] }))).toEqual([
      { pattern: mention, matched: '@anna' },
    ]);
  });

  it('matches NFC and NFD tags equivalently', () => {
    const pattern: MessageMatchPattern = { kind: 'tag', value: 'café' };
    expect(matchMessage([pattern], proj('#café'))).toEqual([{ pattern, matched: '#café' }]);
    expect(matchMessage([pattern], proj('#cafe\u0301'))).toEqual([
      { pattern, matched: '#café' },
    ]);
    expect(matchMessage([pattern], proj('café#x'))).toEqual([]);
    expect(matchMessage([pattern], proj('cafe\u0301#x'))).toEqual([]);
  });

  it('returns empty results for empty pattern sets and caps pattern evaluation', () => {
    const match: MessageMatchPattern = { kind: 'tag', value: 'x' };
    const patterns: MessageMatchPattern[] = [
      ...Array.from({ length: MESSAGE_MATCH_MAX_PATTERNS }, () => ({
        kind: 'tag' as const,
        value: 'nope',
      })),
      match,
    ];
    expect(matchMessage([], proj('#x'))).toEqual([]);
    expect(matchMessage(patterns, proj('#x'))).toEqual([]);
  });

  it('fails closed on invalid runtime pattern values', () => {
    const empty: MessageMatchPattern = { kind: 'content', value: '' };
    const overCap: MessageMatchPattern = {
      kind: 'content',
      value: 'a'.repeat(MESSAGE_MATCH_PATTERN_VALUE_MAX + 1),
    };
    const nonString = { kind: 'content', value: 123 } as unknown as MessageMatchPattern;
    const badMode = {
      kind: 'content',
      value: 'hi',
      mode: 'nope',
    } as unknown as MessageMatchPattern;
    expect(matchMessage([empty], proj('anything'))).toEqual([]);
    expect(matchMessage([overCap], proj('a'.repeat(MESSAGE_MATCH_PATTERN_VALUE_MAX + 1)))).toEqual(
      [],
    );
    expect(() => matchMessage([nonString], proj('123'))).not.toThrow();
    expect(matchMessage([nonString], proj('123'))).toEqual([]);
    expect(matchMessage([badMode], proj('hi'))).toEqual([]);
  });

  it('skips a null / non-object member without throwing (poisoned array)', () => {
    // A malformed member (null / primitive) must not throw — it would poison an
    // otherwise-matching one-shot message (e.g. a messenger config carrying a
    // stray null in match_patterns).
    const valid: MessageMatchPattern = { kind: 'tag', value: 'commit' };
    const poisoned = [null, 'x', 42, valid] as unknown as MessageMatchPattern[];
    expect(() => matchMessage(poisoned, proj('do #commit'))).not.toThrow();
    expect(matchMessage(poisoned, proj('do #commit'))).toEqual([
      { pattern: valid, matched: '#commit' },
    ]);
    expect(matchMessage([null] as unknown as MessageMatchPattern[], proj('#commit'))).toEqual([]);
  });
});

describe('messageMatches', () => {
  it('returns whether any pattern matches', () => {
    expect(messageMatches([{ kind: 'tag', value: 'commit' }], proj('#commit'))).toBe(true);
    expect(messageMatches([{ kind: 'tag', value: 'commit' }], proj('no tag'))).toBe(false);
    expect(messageMatches([], proj('#commit'))).toBe(false);
  });
});

describe('validateMessageMatchPattern', () => {
  it('accepts valid tag, mention, and content patterns', () => {
    expect(validateMessageMatchPattern({ kind: 'tag', value: 'commit' })).toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'mention', value: 'anna' })).toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'content', value: 'commit' })).toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'content', value: 'commit', mode: 'word' })).toEqual(
      [],
    );
  });

  it('rejects one invalid field at a time', () => {
    expect(
      validateMessageMatchPattern(null as unknown as MessageMatchPattern),
    ).not.toEqual([]);
    expect(
      validateMessageMatchPattern('nope' as unknown as MessageMatchPattern),
    ).not.toEqual([]);
    expect(
      validateMessageMatchPattern({ kind: 'nope', value: 'commit' } as unknown as MessageMatchPattern),
    ).not.toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'tag', value: '' })).not.toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'tag', value: '   ' })).not.toEqual([]);
    expect(
      validateMessageMatchPattern({
        kind: 'tag',
        value: 'a'.repeat(MESSAGE_MATCH_PATTERN_VALUE_MAX + 1),
      }),
    ).not.toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'tag', value: 'two words' })).not.toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'tag', value: '#' })).not.toEqual([]);
    expect(
      validateMessageMatchPattern({
        kind: 'content',
        value: 'commit',
        mode: 'nope',
      } as unknown as MessageMatchPattern),
    ).not.toEqual([]);
  });

  it('shares tokenizer grammar for tag and mention values', () => {
    expect(validateMessageMatchPattern({ kind: 'tag', value: 'foo-bar' })).not.toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'tag', value: 'two words' })).not.toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'tag', value: 'café' })).toEqual([]);
    expect(validateMessageMatchPattern({ kind: 'mention', value: 'u_08' })).toEqual([]);
  });
});

describe('validateMessageMatchPatterns', () => {
  it('rejects an over-cap set with ONE bounded problem (no per-member enumeration)', () => {
    // A pathological array must not produce a per-member problem for each of
    // thousands of elements (bounded work + bounded error message).
    const patterns = Array.from(
      { length: MESSAGE_MATCH_MAX_PATTERNS + 5000 },
      () => null,
    ) as unknown as MessageMatchPattern[];
    const problems = validateMessageMatchPatterns(patterns);
    expect(problems).toEqual([
      `at most ${MESSAGE_MATCH_MAX_PATTERNS} patterns (got ${MESSAGE_MATCH_MAX_PATTERNS + 5000})`,
    ]);
  });

  it('prefixes per-entry paths for a within-cap set', () => {
    const problems = validateMessageMatchPatterns([
      { kind: 'tag', value: 'commit' },
      { kind: 'tag', value: 'two words' },
    ]);
    expect(problems.some((problem) => problem.startsWith('patterns[1].value'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('patterns[0]'))).toBe(false);
  });

  it('accepts a within-cap set of valid patterns', () => {
    expect(
      validateMessageMatchPatterns([
        { kind: 'tag', value: 'commit' },
        { kind: 'content', value: 'ship', mode: 'word' },
      ]),
    ).toEqual([]);
  });
});
