/** D-145 PB6 — composer pipeline integration tests.
 *
 *  Covers full `composeAIOutput` flow: shape validation halt + per-
 *  event validation halt + ordering + dispatch + noise control +
 *  confirmation batching, end-to-end. */

import { describe, expect, it } from 'vitest';

import type { AIOutput, ExtractionEvent } from '@recued/contracts';

import {
  AI_OUTPUT_COMPOSER_ISSUE_KINDS,
  AI_OUTPUT_COMPOSER_ISSUE_KIND_SET,
  composeAIOutput,
} from '../ai-output/composer.js';

const evt = (
  kind: ExtractionEvent['kind'],
  confidence: number,
  source_message_id?: string,
): ExtractionEvent => ({
  kind,
  confidence,
  args: {},
  ...(source_message_id !== undefined ? { source_message_id } : {}),
});

describe('D-145 PB6 — AI_OUTPUT_COMPOSER_ISSUE_KINDS closed list', () => {
  it('contains exactly 2 entries', () => {
    expect(AI_OUTPUT_COMPOSER_ISSUE_KINDS.length).toBe(2);
    expect(AI_OUTPUT_COMPOSER_ISSUE_KIND_SET.size).toBe(2);
    expect(new Set(AI_OUTPUT_COMPOSER_ISSUE_KINDS)).toEqual(
      new Set(['ai_output_shape_invalid', 'extraction_event_invalid']),
    );
  });
});

describe('D-145 PB6 — composeAIOutput halts on shape failure', () => {
  it('returns issue + no composed when response not string', () => {
    const out: AIOutput = {
      response: 42 as unknown as string,
      events: [],
      tool_calls: [],
    };
    const result = composeAIOutput(out);
    expect(result.composed).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]!.kind).toBe('ai_output_shape_invalid');
  });

  it('does not run downstream stages when shape is invalid', () => {
    // events looks like a non-array — composer must not try to map.
    const out: AIOutput = {
      response: 'ok',
      events: 'oops' as unknown as AIOutput['events'],
      tool_calls: [],
    };
    const result = composeAIOutput(out);
    expect(result.composed).toBeUndefined();
    expect(
      result.issues.every((i) => i.kind === 'ai_output_shape_invalid'),
    ).toBe(true);
  });
});

describe('D-145 PB6 — composeAIOutput halts on per-event validation failure', () => {
  it('reports each invalid event with its index', () => {
    const out: AIOutput = {
      response: 'ok',
      events: [
        evt('extraction.commitment', 0.9),
        { kind: 'bogus.kind' as never, confidence: 0.5, args: {} },
        evt('extraction.note', NaN),
      ],
      tool_calls: [],
    };
    const result = composeAIOutput(out);
    expect(result.composed).toBeUndefined();
    const indexes = result.issues
      .filter((i) => i.kind === 'extraction_event_invalid')
      .map((i) => i.event_index);
    expect(indexes).toContain(1);
    expect(indexes).toContain(2);
  });

  it('Codex P2 fold — null event entry surfaces structured issue without throwing', () => {
    // Top-level shape gate sees `events` as an array (passes) but the
    // null entry would have thrown before the fold. Now the per-event
    // validator emits structural issues uniformly.
    const out = {
      response: 'ok',
      events: [
        evt('extraction.commitment', 0.9),
        null,
        evt('extraction.note', 0.7),
      ],
      tool_calls: [],
    };
    const result = composeAIOutput(out);
    expect(result.composed).toBeUndefined();
    const indexes = result.issues
      .filter((i) => i.kind === 'extraction_event_invalid')
      .map((i) => i.event_index);
    expect(indexes).toContain(1);
  });
});

describe('D-145 PB6 — composeAIOutput accepts unknown input (Codex P2 fold)', () => {
  it('null AIOutput surfaces every shape issue without throwing', () => {
    const result = composeAIOutput(null);
    expect(result.composed).toBeUndefined();
    expect(
      result.issues.every((i) => i.kind === 'ai_output_shape_invalid'),
    ).toBe(true);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });

  it('undefined AIOutput surfaces every shape issue without throwing', () => {
    const result = composeAIOutput(undefined);
    expect(result.composed).toBeUndefined();
    expect(
      result.issues.every((i) => i.kind === 'ai_output_shape_invalid'),
    ).toBe(true);
  });

  it('primitive AIOutput (string) surfaces every shape issue without throwing', () => {
    const result = composeAIOutput('not an output');
    expect(result.composed).toBeUndefined();
    expect(
      result.issues.every((i) => i.kind === 'ai_output_shape_invalid'),
    ).toBe(true);
  });
});

describe('D-145 PB6 — composeAIOutput happy path', () => {
  const sample: AIOutput = {
    response: 'Nice — what kind?',
    events: [
      evt('extraction.purchase', 0.95, 'msg-1'),
      evt('resolution.alias', 0.99, 'msg-1'),
      evt('extraction.plan', 0.7, 'msg-1'),
      evt('extraction.task', 0.65, 'msg-1'),
    ],
    tool_calls: [{ tool: 'mail-send', args: {} }],
  };

  it('composes successfully and emits no issues', () => {
    const result = composeAIOutput(sample);
    expect(result.issues).toEqual([]);
    expect(result.composed).toBeDefined();
  });

  it('preserves response + tool_calls', () => {
    const result = composeAIOutput(sample);
    const c = result.composed!;
    expect(c.response).toBe(sample.response);
    expect(c.tool_calls).toEqual(sample.tool_calls);
  });

  it('orders dispatched events resolution-first per § B.7.8', () => {
    const result = composeAIOutput(sample);
    const kinds = result.composed!.dispatched_events.map((d) => d.event.kind);
    // First event must be the resolution; rest are extractions in input order.
    expect(kinds[0]).toBe('resolution.alias');
    expect(kinds.slice(1)).toEqual([
      'extraction.purchase',
      'extraction.plan',
      'extraction.task',
    ]);
  });

  it('assigns dispatch tier per § B.7.7', () => {
    const result = composeAIOutput(sample);
    const dispatch = result.composed!.dispatched_events.map((d) => d.dispatch);
    // Order: [resolution.alias=0.99 auto, ext.purchase=0.95 auto,
    // ext.plan=0.7 confirm, ext.task=0.65 confirm]
    expect(dispatch).toEqual([
      'auto_save',
      'auto_save',
      'queue_for_confirm',
      'queue_for_confirm',
    ]);
  });

  it('groups medium-confidence events into one msg-1 confirmation group', () => {
    const result = composeAIOutput(sample);
    const groups = result.composed!.confirmation_groups;
    expect(groups.length).toBe(1);
    expect(groups[0]!.source_message_id).toBe('msg-1');
    expect(groups[0]!.events.length).toBe(2);
  });

  it('routes high + low events to passthrough_events', () => {
    const result = composeAIOutput(sample);
    const pass = result.composed!.passthrough_events;
    // 2 high events (resolution + extraction.purchase). No low here.
    expect(pass.length).toBe(2);
    expect(pass.every((p) => p.dispatch === 'auto_save')).toBe(true);
  });

  it('renders per-source noise_groups (single bucket here, inline)', () => {
    const result = composeAIOutput(sample);
    const ng = result.composed!.noise_groups;
    expect(ng.length).toBe(1);
    expect(ng[0]!.source_message_id).toBe('msg-1');
    expect(ng[0]!.mode).toBe('inline');
  });
});

describe('D-145 PB6 — composeAIOutput collapse-at-threshold', () => {
  it('msg with 7 events collapses to summary group', () => {
    const events: ExtractionEvent[] = Array.from({ length: 7 }, (_, i) =>
      evt(
        i % 2 === 0 ? 'extraction.commitment' : 'extraction.task',
        0.9,
        'msg-storm',
      ),
    );
    const out: AIOutput = {
      response: 'lots',
      events,
      tool_calls: [],
    };
    const result = composeAIOutput(out);
    const ng = result.composed!.noise_groups;
    expect(ng[0]!.mode).toBe('collapsed_summary');
    if (ng[0]!.mode === 'collapsed_summary') {
      expect(ng[0]!.count).toBe(7);
    }
  });
});

describe('D-145 PB6 — composer determinism (audit replay)', () => {
  it('same input → same composed output (deterministic)', () => {
    const out: AIOutput = {
      response: 'r',
      events: [
        evt('extraction.commitment', 0.92, 'msg-1'),
        evt('resolution.alias', 0.99, 'msg-1'),
        evt('extraction.note', 0.7, 'msg-1'),
      ],
      tool_calls: [],
    };
    const a = composeAIOutput(out);
    const b = composeAIOutput(out);
    // JSON parity is a sufficient determinism check (closed-list shapes).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
