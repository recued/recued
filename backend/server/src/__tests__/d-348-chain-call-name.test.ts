/** D-348 slice 3 — a chain's call by the name its approvals use: a chat write as "Allow in this
 *  chat" names it, a recipe's step or a pack action as the approval card's Action row does. */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { ChatDispatchContext } from '@recued/contracts';

import { chainCallName, chainCallPinLabels } from '../chain-call-name.js';

const manifests: Record<string, { name: string }> = { 'mail-send': { name: 'Send mail' } };
const getManifest = (slug: string) => manifests[slug];

describe('D-348 slice 3 — a call by its name', () => {
  it('a chat write as "Allow in this chat" names it', () => {
    expect(chainCallName({ op: 'tier1:work.create:task' }, getManifest)).toBe('Add a task');
    expect(chainCallName({ op: 'tier1:no.such:tool' }, getManifest)).toBeUndefined();
  });

  it('a recipe step by its operation, else its ingredient', () => {
    expect(chainCallName({ op: 'step:send-composed-mail@h|mail-send||' }, getManifest)).toBe('Send mail');
    expect(chainCallName({ op: 'step:r@h|crm|recued-core/hubspot.deal.update|hubspot' }, getManifest))
      .toBe('Update deal · HubSpot');
  });

  it('a pack action by its catalog operation', () => {
    expect(chainCallName({ op: 'op:recued-core/hubspot|deal.update|hubspot' }, getManifest)).toBe('Update deal · HubSpot');
  });

  it('nothing for what it cannot name', () => {
    expect(chainCallName({ op: 'step:r@h|unknown-thing||' }, getManifest)).toBeUndefined();
    expect(chainCallName({ op: 'nonsense' }, getManifest)).toBeUndefined();
  });
});

describe('D-348 — the values a chat write names, as its approval card names them', () => {
  // Live, 2026-11-13: a suggestion read "Change a calendar event · Source ID: 54d0ecc0-…".
  const lookups: Array<{ tool: string; args: unknown; ctx: ChatDispatchContext }> = [];
  const registry = {
    askValueLabels: async (tool: string, args: unknown, ctx: ChatDispatchContext) => {
      lookups.push({ tool, args, ctx });
      return tool === 'calendar.update' ? { source_id: { 'evt-1': 'Team sync, Sat 14 Nov 10:00' } } : undefined;
    },
  };

  it('looks its pinned values up as its card does, on the owner\'s clock', async () => {
    lookups.length = 0;
    expect(await chainCallPinLabels({ op: 'tier1:calendar.update:local', pins: { source_id: ['evt-1'] } }, registry, 'Europe/Dublin'))
      .toEqual({ source_id: { 'evt-1': 'Team sync, Sat 14 Nov 10:00' } });
    expect(lookups).toEqual([{ tool: 'calendar.update', args: { source_id: 'evt-1' },
      ctx: { channel: 'internal_function_call', time_zone: 'Europe/Dublin' } }]);
  });

  it('with what its operation says of it: another calendar, a record\'s kind', async () => {
    lookups.length = 0;
    await chainCallPinLabels({ op: 'tier1:calendar.update:work', pins: { source_id: ['evt-2'] } }, registry, undefined);
    await chainCallPinLabels({ op: 'tier1:work.update:task', pins: { id: ['task-1'] } }, registry, undefined);
    expect(lookups.map(({ tool, args }) => ({ tool, args }))).toEqual([
      { tool: 'calendar.update', args: { source_id: 'evt-2', calendar_id: 'work' } },
      { tool: 'work.update', args: { id: 'task-1', kind: 'task' } },
    ]);
  });

  it('nothing for another call, one that names nothing, no lookup, or a lookup that fails', async () => {
    lookups.length = 0;
    expect(await chainCallPinLabels({ op: 'op:recued-core/hubspot|deal.update|hubspot', pins: { deal_id: ['9'] } }, registry, undefined))
      .toBeUndefined();
    expect(await chainCallPinLabels({ op: 'tier1:work.create:task', pins: {} }, registry, undefined)).toBeUndefined();
    expect(lookups).toEqual([]);
    const pinned = { op: 'tier1:calendar.update:local', pins: { source_id: ['e'] } };
    expect(await chainCallPinLabels(pinned, undefined, undefined)).toBeUndefined();
    expect(await chainCallPinLabels(pinned, { askValueLabels: async () => { throw new Error('locked'); } }, undefined))
      .toBeUndefined();
  });

  it('the server composes Contracts with it, over the chat\'s own lookup and the owner\'s zone', () => {
    const source = readFileSync(new URL('../serve/compose-listeners.ts', import.meta.url), 'utf8');
    expect(source).toContain('labelChainCall: (signature) => chainCallPinLabels(signature, app.internalRegistryRef,');
  });
});
