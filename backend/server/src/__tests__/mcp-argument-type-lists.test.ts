/** The MCP door checks a tool call's arguments against the schema the tool advertises. JSON Schema lets `type` name
 *  several types (`["string", "number"]`, `["integer", "null"]`); a value of any one is valid. Every such field was
 *  refused "uses an unsupported tool argument schema type" (found live 2026-11-21, D-407's MCP drive): no AI app could
 *  give a task a due date or change an occasion's alert. Checked against the shipped Tier-1 schemas too. */
import { describe, expect, it } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS } from '@recued/contracts';

import { mcpToolArguments, validateMcpToolArguments } from '../mcp-server.js';

const field = (schema: Record<string, unknown>) => ({ type: 'object', properties: { value: schema }, additionalProperties: false });

describe('MCP arguments: a type list', () => {
  it('takes a value of any type it names, and refuses the rest by naming them', () => {
    const either = field({ type: ['string', 'number'] });
    expect(validateMcpToolArguments(either, { value: '2026-11-26' })).toBeNull();
    expect(validateMcpToolArguments(either, { value: 1_795_737_600_000 })).toBeNull();
    expect(validateMcpToolArguments(either, { value: true })).toBe('arguments.value must be string or number');
    const orNone = field({ type: ['integer', 'null'], minimum: 0 });
    expect(validateMcpToolArguments(orNone, { value: 30 })).toBeNull();
    expect(validateMcpToolArguments(orNone, { value: null })).toBeNull();
    expect(validateMcpToolArguments(orNone, { value: 1.5 })).toBe('arguments.value must be integer or null');
    expect(validateMcpToolArguments(field({ type: 'null' }), { value: 0 })).toBe('arguments.value must be null');
    // A list keeps the rest of its schema: an enum still binds every member.
    expect(validateMcpToolArguments(field({ type: ['string', 'null'], enum: ['a', null] }), { value: 'b' }))
      .toBe('arguments.value must be one of the declared enum values');
  });

  it('a task\'s due date and an occasion\'s alert pass the shipped schemas', () => {
    const create = TIER1_TOOL_DESCRIPTORS['work.create'].arg_schema;
    const update = TIER1_TOOL_DESCRIPTORS['work.update'].arg_schema;
    expect(validateMcpToolArguments(create, { kind: 'task', title: 'Finish the slides', due_at: '2026-11-26' })).toBeNull();
    expect(validateMcpToolArguments(create, { kind: 'task', title: 'Finish the slides', due_at: 1_795_737_600_000 })).toBeNull();
    expect(validateMcpToolArguments(update, { kind: 'occasion', id: 'occ-1', alert_minutes_before: 120 })).toBeNull();
    expect(validateMcpToolArguments(update, { kind: 'occasion', id: 'occ-1', alert_minutes_before: null })).toBeNull();
    expect(validateMcpToolArguments(create, { kind: 'task', title: 'X', due_at: false })).toBe('arguments.due_at must be string or number');
  });
});

describe('MCP arguments: a work tool\'s due date on the owner\'s clock', () => {
  it('the day, or the day and time on the owner\'s clock, becomes the instant the chat would give it', () => {
    const deps = { ownerTimeZone: () => 'America/Los_Angeles' };
    // A day is kept as its UTC midnight, as a date-only due is; a time is read on the owner's clock.
    expect(mcpToolArguments('work.create', { kind: 'task', title: 'Slides', due_at: '2026-11-26' }, deps).due_at).toBe(Date.parse('2026-11-26T00:00:00Z'));
    expect(mcpToolArguments('work.create', { kind: 'task', title: 'Slides', due_at: '2026-11-26T17:00' }, deps).due_at).toBe(Date.parse('2026-11-27T01:00:00Z'));
    expect(mcpToolArguments('work.update', { kind: 'task', id: 't-1', due_at: '2026-11-26T09:30' }, deps).due_at).toBe(Date.parse('2026-11-26T17:30:00Z'));
    // Milliseconds, other tools and text that is no date pass as they came, for the tool to judge.
    expect(mcpToolArguments('work.create', { kind: 'task', title: 'Slides', due_at: 1_795_737_600_000 }, deps).due_at).toBe(1_795_737_600_000);
    expect(mcpToolArguments('calendar.create', { due_at: '2026-11-26' }, deps).due_at).toBe('2026-11-26');
    expect(mcpToolArguments('work.create', { kind: 'task', title: 'Slides', due_at: 'next week' }, deps).due_at).toBe('next week');
  });
});
