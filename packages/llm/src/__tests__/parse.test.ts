import { describe, it, expect } from 'vitest';
import { AI_RESULT_FIELDS } from '@recued/contracts';
import { extractJSON, parseJSONObject, parseContractedOutput } from '../parse.js';

describe('extractJSON', () => {
  it('returns null for empty input', () => {
    expect(extractJSON('')).toBeNull();
    expect(extractJSON('   ')).toBeNull();
  });

  it('returns bare object as-is', () => {
    expect(extractJSON('{"a": 1}')).toBe('{"a": 1}');
  });

  it('strips ```json code fence', () => {
    expect(extractJSON('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('strips unlabeled code fence', () => {
    expect(extractJSON('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('finds embedded object with preamble text', () => {
    expect(extractJSON('Here is the result: {"a": 1} hope that helps')).toBe('{"a": 1}');
  });

  it('handles nested braces inside strings', () => {
    const result = extractJSON('{"a": "hello {world}", "b": 2}');
    expect(result).toBe('{"a": "hello {world}", "b": 2}');
  });

  it('handles escaped quotes in strings', () => {
    const result = extractJSON('{"a": "He said \\"hi\\"", "b": 1}');
    expect(result).toContain('He said');
  });

  it('returns null when no balanced object found', () => {
    expect(extractJSON('{ unclosed')).toBeNull();
    expect(extractJSON('no braces at all')).toBeNull();
  });
});

describe('parseJSONObject', () => {
  it('returns null for invalid JSON', () => {
    expect(parseJSONObject('not json')).toBeNull();
  });

  it('returns null for array (not object)', () => {
    expect(parseJSONObject('[1, 2, 3]')).toBeNull();
  });

  it('returns null for string (not object)', () => {
    expect(parseJSONObject('"just a string"')).toBeNull();
  });

  it('parses plain object', () => {
    expect(parseJSONObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses object in code fence', () => {
    expect(parseJSONObject('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });
});

describe('parseContractedOutput — ai-classify', () => {
  it('accepts well-formed output', () => {
    const result = parseContractedOutput('ai-classify',
      '{"category": "greeting", "confidence": 0.9, "reasoning": "says hello"}');
    expect(result).toEqual({ category: 'greeting', confidence: 0.9, reasoning: 'says hello' });
  });

  it('clamps confidence to [0, 1]', () => {
    const over = parseContractedOutput('ai-classify',
      '{"category": "a", "confidence": 1.5, "reasoning": "x"}');
    expect(over?.confidence).toBe(1);

    const under = parseContractedOutput('ai-classify',
      '{"category": "a", "confidence": -0.2, "reasoning": "x"}');
    expect(under?.confidence).toBe(0);
  });

  it('rejects missing category', () => {
    expect(parseContractedOutput('ai-classify',
      '{"confidence": 0.5, "reasoning": "x"}')).toBeNull();
  });

  it('rejects non-numeric confidence', () => {
    expect(parseContractedOutput('ai-classify',
      '{"category": "a", "confidence": "high", "reasoning": "x"}')).toBeNull();
  });
});

describe('parseContractedOutput — ai-score', () => {
  it('accepts valid score output', () => {
    const result = parseContractedOutput('ai-score', JSON.stringify({
      score: 7.5,
      breakdown: [{ criterion: 'quality', score: 8, notes: 'solid' }],
      reasoning: 'Looks good.',
    }));
    expect(result).toBeTruthy();
    expect((result as Record<string, unknown>).score).toBe(7.5);
  });

  it('rejects breakdown items missing criterion', () => {
    const result = parseContractedOutput('ai-score', JSON.stringify({
      score: 5, breakdown: [{ score: 5 }], reasoning: 'r',
    }));
    expect(result).toBeNull();
  });
});

describe('parseContractedOutput — ai-extract', () => {
  it('accepts any object shape', () => {
    const result = parseContractedOutput('ai-extract', '{"name": "Alice", "email": null}');
    expect(result).toEqual({ name: 'Alice', email: null });
  });
});

describe('parseContractedOutput — ai-summarize', () => {
  it('accepts summary + key_points', () => {
    const result = parseContractedOutput('ai-summarize',
      '{"summary": "brief", "key_points": ["a", "b"]}');
    expect(result).toEqual({ summary: 'brief', key_points: ['a', 'b'] });
  });

  it('rejects non-string key_points', () => {
    expect(parseContractedOutput('ai-summarize',
      '{"summary": "s", "key_points": [1, 2]}')).toBeNull();
  });
});

describe('parseContractedOutput — ai-sentiment', () => {
  it('accepts positive/neutral/negative', () => {
    for (const sentiment of ['positive', 'neutral', 'negative']) {
      const result = parseContractedOutput('ai-sentiment',
        `{"sentiment": "${sentiment}", "score": 0.5, "signals": ["s1"]}`);
      expect(result).toBeTruthy();
    }
  });

  it('rejects unknown sentiment label', () => {
    expect(parseContractedOutput('ai-sentiment',
      '{"sentiment": "angry", "score": 0.5, "signals": []}')).toBeNull();
  });

  it('clamps score to [-1, 1]', () => {
    const result = parseContractedOutput('ai-sentiment',
      '{"sentiment": "positive", "score": 2, "signals": []}');
    expect((result as Record<string, unknown>).score).toBe(1);
  });
});

describe('parseContractedOutput — ai-compare', () => {
  it('accepts full shape', () => {
    const result = parseContractedOutput('ai-compare', JSON.stringify({
      differences: ['a differs'],
      similarities: ['both red'],
      recommendation: 'pick A',
    }));
    expect(result).toBeTruthy();
  });
});

describe('parseContractedOutput — ai-generate / ai-rewrite', () => {
  it('ai-generate needs content', () => {
    expect(parseContractedOutput('ai-generate', '{"content": "hi"}')).toEqual({ content: 'hi' });
    expect(parseContractedOutput('ai-generate', '{}')).toBeNull();
  });

  it('ai-rewrite needs rewritten', () => {
    expect(parseContractedOutput('ai-rewrite', '{"rewritten": "new"}')).toEqual({ rewritten: 'new' });
    expect(parseContractedOutput('ai-rewrite', '{"content": "wrong field"}')).toBeNull();
  });
});

describe('parseContractedOutput — ai-translate', () => {
  it('accepts full shape with clamped confidence', () => {
    const result = parseContractedOutput('ai-translate', JSON.stringify({
      translated: 'bonjour', source_language: 'en', confidence: 0.95,
    }));
    expect(result).toEqual({ translated: 'bonjour', source_language: 'en', confidence: 0.95 });
  });
});

describe('parseContractedOutput — unknown slug', () => {
  it('returns null', () => {
    expect(parseContractedOutput('ai-unknown', '{"anything": true}')).toBeNull();
  });
});

describe('parseContractedOutput — malformed responses', () => {
  it('returns null for non-JSON prose', () => {
    expect(parseContractedOutput('ai-classify', 'I think it is greeting')).toBeNull();
  });

  it('handles model responses with preamble', () => {
    const result = parseContractedOutput('ai-classify',
      'Sure! Here you go:\n```json\n{"category": "greeting", "confidence": 0.9, "reasoning": "hi"}\n```');
    expect(result).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────
// extractJSON — edge cases in the balanced-brace scanner
// ────────────────────────────────────────────────────────────────

describe('extractJSON — scanner edge cases', () => {
  it('treats backslash-x as an escape (next char skipped — not a quote)', () => {
    // The "\\{" has a literal backslash followed by {. Inside a string,
    // the backslash marks the next char as escaped. The } must still close.
    const input = '{"a": "path\\\\to\\\\thing", "b": 1}';
    expect(extractJSON(input)).toBe('{"a": "path\\\\to\\\\thing", "b": 1}');
  });

  it('skips braces that appear inside strings (scanner does not count them)', () => {
    const input = '{"msg": "has } inside", "n": 1}';
    expect(extractJSON(input)).toBe('{"msg": "has } inside", "n": 1}');
  });

  it('ignores characters inside strings that are not braces or quotes', () => {
    // Characters like colons/commas inside strings hit the inString continue
    // path without affecting depth.
    const input = '{"msg": "a: b, c"}';
    expect(extractJSON(input)).toBe('{"msg": "a: b, c"}');
  });
});

// ────────────────────────────────────────────────────────────────
// parseContractedOutput — validator rejection paths
// ────────────────────────────────────────────────────────────────

describe('parseContractedOutput — ai-classify rejection paths', () => {
  it('rejects missing reasoning', () => {
    expect(parseContractedOutput('ai-classify',
      '{"category": "a", "confidence": 0.5}')).toBeNull();
  });
});

describe('parseContractedOutput — ai-score rejection paths', () => {
  it('rejects missing score', () => {
    expect(parseContractedOutput('ai-score', JSON.stringify({
      breakdown: [{ criterion: 'c', score: 1 }], reasoning: 'r',
    }))).toBeNull();
  });

  it('rejects non-array breakdown', () => {
    expect(parseContractedOutput('ai-score', JSON.stringify({
      score: 5, breakdown: 'not an array', reasoning: 'r',
    }))).toBeNull();
  });

  it('rejects missing reasoning', () => {
    expect(parseContractedOutput('ai-score', JSON.stringify({
      score: 5, breakdown: [{ criterion: 'c', score: 5 }],
    }))).toBeNull();
  });

  it('rejects breakdown item with non-numeric score', () => {
    expect(parseContractedOutput('ai-score', JSON.stringify({
      score: 5, breakdown: [{ criterion: 'c', score: 'high' }], reasoning: 'r',
    }))).toBeNull();
  });

  it('rejects breakdown item that is an array (non-object)', () => {
    expect(parseContractedOutput('ai-score', JSON.stringify({
      score: 5, breakdown: [['not', 'an', 'object']], reasoning: 'r',
    }))).toBeNull();
  });
});

describe('parseContractedOutput — ai-summarize rejection paths', () => {
  it('rejects missing summary', () => {
    expect(parseContractedOutput('ai-summarize',
      '{"key_points": ["a"]}')).toBeNull();
  });
});

describe('parseContractedOutput — ai-sentiment rejection paths', () => {
  it('rejects missing score', () => {
    expect(parseContractedOutput('ai-sentiment',
      '{"sentiment": "positive", "signals": []}')).toBeNull();
  });

  it('rejects non-string-array signals', () => {
    expect(parseContractedOutput('ai-sentiment',
      '{"sentiment": "positive", "score": 0.5, "signals": [1, 2]}')).toBeNull();
  });

  it('clamps score to -1 on the negative side', () => {
    const r = parseContractedOutput('ai-sentiment',
      '{"sentiment": "negative", "score": -5, "signals": []}');
    expect((r as Record<string, unknown>).score).toBe(-1);
  });
});

describe('parseContractedOutput — ai-compare rejection paths', () => {
  it('rejects non-string-array differences', () => {
    expect(parseContractedOutput('ai-compare', JSON.stringify({
      differences: [1, 2], similarities: [], recommendation: 'x',
    }))).toBeNull();
  });

  it('rejects non-string-array similarities', () => {
    expect(parseContractedOutput('ai-compare', JSON.stringify({
      differences: [], similarities: [42], recommendation: 'x',
    }))).toBeNull();
  });

  it('rejects missing recommendation', () => {
    expect(parseContractedOutput('ai-compare', JSON.stringify({
      differences: [], similarities: [],
    }))).toBeNull();
  });
});

describe('parseContractedOutput — ai-translate rejection paths', () => {
  it('rejects missing translated', () => {
    expect(parseContractedOutput('ai-translate', JSON.stringify({
      source_language: 'en', confidence: 0.9,
    }))).toBeNull();
  });

  it('rejects missing source_language', () => {
    expect(parseContractedOutput('ai-translate', JSON.stringify({
      translated: 'bonjour', confidence: 0.9,
    }))).toBeNull();
  });

  it('rejects missing confidence', () => {
    expect(parseContractedOutput('ai-translate', JSON.stringify({
      translated: 'bonjour', source_language: 'en',
    }))).toBeNull();
  });

  it('clamps confidence above 1 and below 0', () => {
    const over = parseContractedOutput('ai-translate', JSON.stringify({
      translated: 't', source_language: 'en', confidence: 5,
    }));
    expect((over as Record<string, unknown>).confidence).toBe(1);
    const under = parseContractedOutput('ai-translate', JSON.stringify({
      translated: 't', source_language: 'en', confidence: -0.5,
    }));
    expect((under as Record<string, unknown>).confidence).toBe(0);
  });
});

describe('parseContractedOutput — non-object JSON input', () => {
  it('returns null when the root payload is a JSON array', () => {
    expect(parseContractedOutput('ai-classify', '[1, 2, 3]')).toBeNull();
  });

  it('returns null when the extractor finds no object at all', () => {
    expect(parseContractedOutput('ai-classify', 'not json and no braces')).toBeNull();
  });
});

/** The recipe validator's `ai_result_field_unknown` rule trusts this: a contracted
 *  result carries exactly its `AI_RESULT_FIELDS`, never a field the model added.
 *  If a parser starts keeping another field, list it there too, or the validator
 *  warns on every read of it. */
describe('a contracted result carries exactly its AI_RESULT_FIELDS', () => {
  const VALID: Record<keyof typeof AI_RESULT_FIELDS, Record<string, unknown>> = {
    'ai-classify': { category: 'a', confidence: 0.5, reasoning: 'r' },
    'ai-score': { score: 7, breakdown: [{ criterion: 'c', score: 7 }], reasoning: 'r' },
    'ai-summarize': { summary: 's', key_points: ['k'] },
    'ai-sentiment': { sentiment: 'positive', score: 0.5, signals: ['s'] },
    'ai-generate': { content: 'c' },
    'ai-translate': { translated: 't', source_language: 'en', confidence: 0.9 },
    'ai-rewrite': { rewritten: 'r' },
  };

  it.each(Object.keys(VALID) as Array<keyof typeof AI_RESULT_FIELDS>)('%s', (slug) => {
    // `confidence` is what two shipped recipes read off `ai-score` and never got.
    const parsed = parseContractedOutput(slug, JSON.stringify({ ...VALID[slug], confidence: 0.8, extra: 'x' }));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).sort()).toEqual([...AI_RESULT_FIELDS[slug]].sort());
  });
});
