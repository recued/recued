/** D-162 P0 -- batch prompt builders for contracted ai-* slugs. */

import { describe, expect, it } from 'vitest';

import { buildContractedPrompt } from '../prompts.js';
import { LLMError } from '../types.js';

const expectAIOutputInvalid = (fn: () => unknown): LLMError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    return error as LLMError;
  }

  throw new Error('Expected LLMError with code AI_OUTPUT_INVALID');
};

const batchRecords = [
  { record_id: 'r1', text: 'First record' },
  { record_id: 'r2', text: 'Second record' },
];

describe('D-162 P0 I-1 / N.7 single-mode prompt bytes', () => {
  it('ai-classify is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-classify', {
      'llm.data': 'hello world',
      'llm.categories': ['greeting', 'question'],
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a classifier. Choose exactly one category from the provided list that best fits the data. Output a confidence between 0 and 1 and a one-sentence reasoning.

      Schema: { "category": "<one of the provided categories>", "confidence": <0-1>, "reasoning": "<one sentence>" }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Categories: ["greeting","question"]

      Data:
      hello world",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-score is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-score', {
      'llm.data': 'product',
      'llm.criteria': ['quality', 'value'],
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a scoring engine. Score the data against each criterion on the provided scale. Produce a per-criterion breakdown, an overall score (average, rounded to one decimal), and a brief reasoning.

      Schema: { "score": <number>, "breakdown": [{ "criterion": "<name>", "score": <number>, "notes": "<short>" }], "reasoning": "<2-3 sentences>" }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Scale: 0-10
      Criteria: ["quality","value"]

      Data:
      product",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-extract is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-extract', {
      'llm.data': { body: 'Alice <alice@example.com>' },
      'llm.fields': ['name', 'email'],
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a field extractor. Extract the requested fields from the data. If a field is not present, set its value to null. Do not invent values.

      Schema: an object with exactly these keys: ["name","email"]. Each value is the extracted content (string, number, array, or null).

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Fields: ["name","email"]

      Data:
      {
        "body": "Alice <alice@example.com>"
      }",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-summarize is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-summarize', {
      'llm.data': 'Long text',
      'llm.max_length': 50,
      'llm.focus': 'risks',
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a summarizer. Produce a summary of at most 50 words and extract 3-5 key points.
      Focus area: risks

      Schema: { "summary": "<<=50 words>", "key_points": ["<point>", ...] }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Data:
      Long text",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-sentiment is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-sentiment', {
      'llm.data': 'great!',
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a sentiment analyzer. Classify the overall sentiment of the data and list the signals that led to the classification.

      Schema: { "sentiment": "positive" | "neutral" | "negative", "score": <-1 to 1>, "signals": ["<short phrase>", ...] }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Data:
      great!",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-compare is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-compare', {
      'llm.data_a': { name: 'Alice' },
      'llm.data_b': { name: 'Bob' },
      'llm.dimensions': ['price', 'quality'],
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a comparator. Compare specifically along these dimensions: ["price","quality"]. List concrete differences and similarities between data A and data B, then give a recommendation that answers "which one and why" in one sentence.

      Schema: { "differences": ["<statement>", ...], "similarities": ["<statement>", ...], "recommendation": "<one sentence>" }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Data A:
      {
        "name": "Alice"
      }

      Data B:
      {
        "name": "Bob"
      }",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-generate is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-generate', {
      'llm.data': 'source',
      'llm.template_type': 'email',
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a content generator. Produce a email using the provided data, in a neutral tone. Keep it concise and ready to use.

      Schema: { "content": "<the generated text>" }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Data:
      source",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-translate is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-translate', {
      'llm.data': 'hello',
      'llm.target_language': 'French',
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a translator. Translate the data into French, preserving meaning and tone. Identify the source language (ISO 639-1 code). Report a confidence between 0 and 1.

      Schema: { "translated": "<translated text>", "source_language": "<iso-639-1>", "confidence": <0-1> }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Data:
      hello",
          "role": "user",
        },
      ]
    `);
  });

  it('ai-rewrite is byte-unchanged in single mode', () => {
    expect(buildContractedPrompt('ai-rewrite', {
      'llm.data': 'text',
      'llm.style': 'formal',
    })).toMatchInlineSnapshot(`
      [
        {
          "content": "You are a rewriter. Rewrite the data in the formal style.
      Preserve the original meaning. Do not add or remove information.

      Schema: { "rewritten": "<rewritten text>" }

      Respond with ONLY a valid JSON object matching the exact schema. No markdown, no code fences, no preamble, no explanation outside the JSON.",
          "role": "system",
        },
        {
          "content": "Data:
      text",
          "role": "user",
        },
      ]
    `);
  });
});

describe('D-162 P0 batch prompt shape', () => {
  const batchCases: Array<{
    slug: string;
    input: Record<string, unknown>;
  }> = [
    {
      slug: 'ai-classify',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
        'llm.categories': ['support', 'sales'],
      },
    },
    {
      slug: 'ai-score',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
        'llm.criteria': ['urgency', 'fit'],
      },
    },
    {
      slug: 'ai-extract',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
        'llm.fields': ['company', 'email'],
      },
    },
    {
      slug: 'ai-summarize',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
      },
    },
    {
      slug: 'ai-sentiment',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
      },
    },
    {
      slug: 'ai-generate',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
        'llm.template_type': 'email',
      },
    },
    {
      slug: 'ai-translate',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
        'llm.target_language': 'French',
      },
    },
    {
      slug: 'ai-rewrite',
      input: {
        'llm.data': batchRecords,
        'llm.id_field': 'record_id',
        'llm.style': 'formal',
      },
    },
  ];

  it.each(batchCases)('$slug builds a JSON-array batch prompt naming id_field verbatim', ({ slug, input }) => {
    const messages = buildContractedPrompt(slug, input);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');

    const system = messages[0]!.content;
    expect(system).toContain('Schema: a JSON array');
    expect(system).toContain('Respond with ONLY a valid JSON array');
    expect(system).toContain('{ "record_id": <the record\'s id, copied verbatim>,');
  });

  it('keeps array llm.data without llm.id_field in single mode', () => {
    const messages = buildContractedPrompt('ai-classify', {
      'llm.data': batchRecords,
      'llm.categories': ['support', 'sales'],
    });

    expect(messages[0]!.content).toContain('Respond with ONLY a valid JSON object');
    expect(messages[0]!.content).not.toContain('Respond with ONLY a valid JSON array');
    expect(messages[1]!.content).toContain('Data:');
    expect(messages[1]!.content).not.toContain('Records:');
  });
});

describe('D-162 P0 N.2 batch input checks', () => {
  it('throws AI_OUTPUT_INVALID for a non-object element', () => {
    const error = expectAIOutputInvalid(() => buildContractedPrompt('ai-classify', {
      'llm.data': [{ record_id: 'r1' }, 'not an object'],
      'llm.id_field': 'record_id',
      'llm.categories': ['support'],
    }));

    expect(error.message).toContain('llm.data[1] must be a non-null object');
  });

  it('throws AI_OUTPUT_INVALID for missing or empty id_field values', () => {
    const missing = expectAIOutputInvalid(() => buildContractedPrompt('ai-classify', {
      'llm.data': [{ record_id: 'r1' }, { text: 'missing id' }],
      'llm.id_field': 'record_id',
      'llm.categories': ['support'],
    }));
    expect(missing.message).toContain('missing a non-empty "record_id" value');

    const empty = expectAIOutputInvalid(() => buildContractedPrompt('ai-classify', {
      'llm.data': [{ record_id: 'r1' }, { record_id: '', text: 'empty id' }],
      'llm.id_field': 'record_id',
      'llm.categories': ['support'],
    }));
    expect(empty.message).toContain('missing a non-empty "record_id" value');
  });

  it('throws AI_OUTPUT_INVALID for duplicate id_field values', () => {
    const error = expectAIOutputInvalid(() => buildContractedPrompt('ai-classify', {
      'llm.data': [{ record_id: 'r1' }, { record_id: 'r1' }],
      'llm.id_field': 'record_id',
      'llm.categories': ['support'],
    }));

    expect(error.message).toContain('duplicate llm.id_field value "r1"');
  });

  it('throws AI_OUTPUT_INVALID when ai-classify id_field collides with a result field', () => {
    const error = expectAIOutputInvalid(() => buildContractedPrompt('ai-classify', {
      'llm.data': [{ category: 'r1', text: 'record' }],
      'llm.id_field': 'category',
      'llm.categories': ['support'],
    }));

    expect(error.message).toContain('collides with a contracted result field');
  });

  it('throws AI_OUTPUT_INVALID when ai-extract id_field collides with llm.fields', () => {
    const error = expectAIOutputInvalid(() => buildContractedPrompt('ai-extract', {
      'llm.data': [{ email: 'r1', text: 'alice@example.com' }],
      'llm.id_field': 'email',
      'llm.fields': ['email', 'name'],
    }));

    expect(error.message).toContain('collides with a contracted result field');
  });
});

describe('D-162 P0 I-6 ai-compare batch rejection', () => {
  it('throws AI_OUTPUT_INVALID when ai-compare receives a non-empty llm.id_field', () => {
    const error = expectAIOutputInvalid(() => buildContractedPrompt('ai-compare', {
      'llm.data_a': { name: 'Alice' },
      'llm.data_b': { name: 'Bob' },
      'llm.id_field': 'record_id',
    }));

    expect(error.message).toContain('ai-compare does not support batch mode');
  });
});
