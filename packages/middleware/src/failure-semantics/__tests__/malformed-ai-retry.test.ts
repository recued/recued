/** D-145 PB15 — malformed-AI retry wrapper tests. */

import { describe, it, expect } from 'vitest';
import {
  MALFORMED_AI_RETRY_PROMPT_NOTE,
  withMalformedAiRetry,
  type ValidateAiResult,
} from '../malformed-ai-retry.js';
import type { TransparencyEventEnvelope } from '@recued/contracts';

interface ParsedShape {
  readonly response: string;
}

describe('D-145 PB15 — withMalformedAiRetry', () => {
  it('returns ok on first attempt when validation passes', async () => {
    const emitted: TransparencyEventEnvelope[] = [];
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => 'good',
      validate: (raw): ValidateAiResult<ParsedShape> => ({
        kind: 'ok',
        value: { response: raw },
      }),
      emit: (env) => emitted.push(env),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.recovered_after_retry).toBe(false);
      expect(result.value.response).toBe('good');
    }
    expect(emitted.length).toBe(0);
  });

  it('emits ai_call.malformed + retries when first attempt malformed', async () => {
    const emitted: TransparencyEventEnvelope[] = [];
    let attempts = 0;
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => {
        attempts++;
        return attempts === 1 ? 'malformed' : 'good';
      },
      validate: (raw) =>
        raw === 'good'
          ? { kind: 'ok', value: { response: raw } }
          : { kind: 'malformed', reason: 'missing_response_field' },
      emit: (env) => emitted.push(env),
    });
    expect(attempts).toBe(2);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.recovered_after_retry).toBe(true);
    }
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.event.kind).toBe('ai_call.malformed');
  });

  it('threads the substrate prompt note on retry', async () => {
    const promptNotes: Array<string | undefined> = [];
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async (promptNote) => {
        promptNotes.push(promptNote);
        return promptNotes.length === 1 ? 'malformed' : 'good';
      },
      validate: (raw) =>
        raw === 'good'
          ? { kind: 'ok', value: { response: raw } }
          : { kind: 'malformed', reason: 'shape_drift' },
      emit: () => {},
    });
    expect(result.kind).toBe('ok');
    expect(promptNotes[0]).toBeUndefined();
    expect(promptNotes[1]).toBe(MALFORMED_AI_RETRY_PROMPT_NOTE);
  });

  it('emits giving_up_malformed + degrades on second malformed return', async () => {
    const emitted: TransparencyEventEnvelope[] = [];
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => 'malformed',
      validate: () => ({ kind: 'malformed', reason: 'persistent_shape_drift' }),
      emit: (env) => emitted.push(env),
    });
    expect(result.kind).toBe('degraded');
    if (result.kind === 'degraded') {
      expect(result.round1_reason).toBe('persistent_shape_drift');
      expect(result.round2_reason).toBe('persistent_shape_drift');
    }
    expect(emitted.length).toBe(2);
    expect(emitted[0]!.event.kind).toBe('ai_call.malformed');
    expect(emitted[1]!.event.kind).toBe('ai_call.giving_up_malformed');
  });

  it('extracts salvageable text via injected salvage extractor', async () => {
    const raw = 'some-garbage-with-text';
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => raw,
      validate: () => ({ kind: 'malformed', reason: 'no_shape' }),
      salvage: (r) => `salvaged:${r.length}`,
      emit: () => {},
    });
    expect(result.kind).toBe('degraded');
    if (result.kind === 'degraded') {
      expect(result.salvaged_response).toBe(`salvaged:${raw.length}`);
    }
  });

  it('omits salvaged_response when extractor returns undefined / empty', async () => {
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => 'x',
      validate: () => ({ kind: 'malformed', reason: 'no_shape' }),
      salvage: () => undefined,
      emit: () => {},
    });
    if (result.kind === 'degraded') {
      expect(result.salvaged_response).toBeUndefined();
    }
  });

  it('allows custom retry_prompt_note override', async () => {
    const promptNotes: Array<string | undefined> = [];
    await withMalformedAiRetry<string, ParsedShape>({
      attempt: async (note) => {
        promptNotes.push(note);
        return 'malformed';
      },
      validate: () => ({ kind: 'malformed', reason: 'never' }),
      retry_prompt_note: 'custom-note',
      emit: () => {},
    });
    expect(promptNotes[1]).toBe('custom-note');
  });

  it('threads round index to the malformed event', async () => {
    const emitted: TransparencyEventEnvelope[] = [];
    await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => 'malformed',
      validate: () => ({ kind: 'malformed', reason: 'r' }),
      round: 4,
      emit: (env) => emitted.push(env),
    });
    const malformedEvent = emitted[0]!.event;
    if (malformedEvent.kind === 'ai_call.malformed') {
      expect(malformedEvent.round).toBe(4);
    }
  });

  it('default round is 0 when not specified', async () => {
    const emitted: TransparencyEventEnvelope[] = [];
    await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => 'malformed',
      validate: () => ({ kind: 'malformed', reason: 'r' }),
      emit: (env) => emitted.push(env),
    });
    const ev = emitted[0]!.event;
    if (ev.kind === 'ai_call.malformed') {
      expect(ev.round).toBe(0);
    }
  });

  it('records both round reasons in the degraded result', async () => {
    let attempts = 0;
    const result = await withMalformedAiRetry<string, ParsedShape>({
      attempt: async () => {
        attempts++;
        return `attempt-${attempts}`;
      },
      validate: (raw) =>
        raw === 'attempt-1'
          ? { kind: 'malformed', reason: 'reason_first' }
          : { kind: 'malformed', reason: 'reason_second' },
      emit: () => {},
    });
    if (result.kind === 'degraded') {
      expect(result.round1_reason).toBe('reason_first');
      expect(result.round2_reason).toBe('reason_second');
    }
  });
});
