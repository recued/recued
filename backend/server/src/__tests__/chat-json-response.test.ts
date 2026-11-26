import { describe, expect, it } from 'vitest';
import { validateAIOutput } from '@recued/contracts';
import { requestsJsonResponse, serializeJsonResponse } from '../chat-json-response.js';

describe('literal JSON in the chat reply envelope', () => {
  it('recognizes an explicit output instruction and keeps prose requests distinct', () => {
    expect(requestsJsonResponse('Read the stock ledger. Return JSON with a rows array.')).toBe(true);
    expect(requestsJsonResponse('Answer in valid JSON.')).toBe(true);
    expect(requestsJsonResponse('Explain what JSON means in one sentence.')).toBe(false);
    expect(requestsJsonResponse('Return a string saying where the JSON file is.')).toBe(false);
  });

  it('serializes object and array answers into the existing string field', () => {
    for (const value of [{ rows: [{ bin: 'BIN-17', on_hand: 41 }] }, ['ready']]) {
      const body = { response: value, events: [], tool_calls: [] };
      const normalized = serializeJsonResponse(body);
      expect(normalized).toEqual({ ...body, response: JSON.stringify(value) });
      expect(validateAIOutput(normalized)).toEqual([]);
    }
  });

  it('preserves reply text and the validation of malformed or unfinished frames', () => {
    for (const body of [
      { response: 'Please wait.', events: [], tool_calls: [] },
      { response: 'null', events: [], tool_calls: [] },
      { response: { rows: [] }, events: [], tool_calls: [{ tool: 'something', args: {} }] },
      { response: false, events: [], tool_calls: [] },
    ]) expect(serializeJsonResponse(body)).toBe(body);
    expect(validateAIOutput(serializeJsonResponse({ response: [], events: null, tool_calls: [] })))
      .toEqual([expect.objectContaining({ kind: 'events_not_array' })]);
  });
});
