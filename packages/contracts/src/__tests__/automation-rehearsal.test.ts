import { expect, it } from 'vitest';
import { parseRehearsalDocument, parseRehearsalConfiguration, AUTOMATION_REHEARSAL_LIMITS } from '../automation-rehearsal.js';
import { isReservedLocalRpc } from '../mcp-tool-catalog.js';
it('keeps every rehearsal and activation method outside MCP', () => {
  for (const name of ['get', 'save', 'test', 'prepare', 'activate', 'delete']) expect(isReservedLocalRpc('automation.rehearsal.' + name)).toBe(true);
});
it('preserves ordinary trigger watch intervals and empty scalar filter values', () => {
  const configuration = { kind: 'trigger', enabled: true, pattern: 'data.task.**', filter: { 'record.subject': '' }, fields: null, watch_interval_ms: 50.5 };
  expect(parseRehearsalConfiguration(configuration)).toEqual(configuration);
  expect(() => parseRehearsalConfiguration({ ...configuration, watch_interval_ms: 0 })).toThrow();
});
it('bounds private scenario JSON and closes configuration and authority fields', () => {
  const doc = { title: 'Saved clock scenarios', candidate: { kind: 'timer', enabled: true, reset_circuit: false },
    cases: [{ id: 'due', name: 'Due timer', expected: 'start', input: { kind: 'clock', at: 1, last_run_at: null, next_run_at: 1, running: false, auto_disabled: false } }] };
  expect(parseRehearsalDocument(doc)).toEqual(doc);
  for (const key of ['source', 'proof', 'qualification', 'outcome']) expect(() => parseRehearsalDocument({ ...doc, [key]: 'owner' })).toThrow();
  expect(() => parseRehearsalConfiguration({ ...doc.candidate, dish_id: 'other' })).toThrow();
  expect(() => parseRehearsalDocument({ ...doc, cases: Array.from({ length: 41 }, () => doc.cases[0]) })).toThrow();
  expect(() => parseRehearsalDocument({ ...doc, title: 'x'.repeat(AUTOMATION_REHEARSAL_LIMITS.document_bytes + 1) })).toThrow();
});
