/** D-346 follow-up (2026-11-08) — what a caller reads when an action, a tool or a recipe is
 *  switched off for it: the owner, their own row on the Contracts page; a contract's app, that
 *  the owner can turn it on for that contract. */
import { describe, expect, it } from 'vitest';

import { grantRefusalSentence, isOwnersOwnCall, neededSwitchRefusalSentence, readRefusalSentence } from '../grant-refusal-copy.js';

describe('grantRefusalSentence', () => {
  it('tells the owner where their own switch is', () => {
    expect(grantRefusalSentence("'recued-core.crm.deal.create'", true, 'Ops')).toBe(
      "'recued-core.crm.deal.create' is turned off for you, so it did not run. "
        + 'To use it, turn it on under Self (you) → Ops on the Contracts page.',
    );
  });

  it('tells any other contract only that it is not available, not why or where', () => {
    expect(grantRefusalSentence("'weekly-digest'", false, 'Recipes')).toBe(
      "'weekly-digest' is not available for this contract.",
    );
  });

  it('never points at Settings, where Contracts is not', () => {
    for (const owner of [true, false]) {
      expect(grantRefusalSentence("'x'", owner, 'Ops or Recipes')).not.toContain('Settings');
    }
  });
});

describe('neededSwitchRefusalSentence', () => {
  it('names an action switch the owner turned off by its title, on Ops', () => {
    expect(neededSwitchRefusalSentence("'memory.write'", 'core.memory.write', true)).toBe(
      "'memory.write' needs \"Save to your memory\", which is turned off for you, so it did not run. "
        + 'To use it, turn on "Save to your memory" under Self (you) → Ops on the Contracts page.',
    );
  });

  it('names a data switch the owner turned off by its title, on Entities', () => {
    expect(neededSwitchRefusalSentence("'contact.write'", 'data.contact', true)).toBe(
      "'contact.write' needs \"Your contacts\", which is turned off for you, so it did not run. "
        + 'To use it, turn on "Your contacts" under Self (you) → Entities on the Contracts page.',
    );
  });

  it('names a switch with no title by its id', () => {
    expect(neededSwitchRefusalSentence("'x'", 'core.not-a-switch', true)).toContain("turn on 'core.not-a-switch' under Self (you) → Ops");
  });

  it('tells any other contract only that the tool is not available, naming no switch', () => {
    expect(neededSwitchRefusalSentence("'memory.write'", 'core.memory.write', false)).toBe(
      "'memory.write' is not available for this contract.",
    );
  });
});

describe('readRefusalSentence', () => {
  it('tells the owner which data switch is off, on Entities', () => {
    expect(readRefusalSentence('Reading contacts', 'data.contact', true)).toBe(
      'Reading contacts is turned off for you. To allow it, turn on "Your contacts" under Self (you) → Entities '
        + 'on the Contracts page.',
    );
  });

  it('names an action switch on Ops, and a topic by its id on Entities', () => {
    expect(readRefusalSentence('Reading work items', 'core.work-entity.read', true))
      .toContain('turn on "Read tasks, notes and more" under Self (you) → Ops');
    expect(readRefusalSentence("Reading the topic 'x'", 'enrichment.x', true))
      .toContain("turn on 'enrichment.x' under Self (you) → Entities");
  });

  it('tells any other contract only that it is not available, naming no grant', () => {
    const said = readRefusalSentence('Reading contacts', 'data.contact', false);
    expect(said).toBe('Reading contacts is not available for this contract.');
    expect(said).not.toContain('data.');
  });
});

describe('isOwnersOwnCall', () => {
  it('is the owner’s chat and the owner’s schedules', () => {
    expect(isOwnersOwnCall({ channel: 'chat', actor: 'user_self' } as never)).toBe(true);
    expect(isOwnersOwnCall({
      channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r1',
    } as never)).toBe(true);
  });

  it('is not a contract’s call, a bare system run, or an unknown one', () => {
    expect(isOwnersOwnCall({ channel: 'mcp', actor: 'contracted_user', contract_id: 'ct_app_1' } as never)).toBe(false);
    expect(isOwnersOwnCall({ channel: 'system', actor: 'system' } as never)).toBe(false);
    expect(isOwnersOwnCall(undefined)).toBe(false);
  });
});
