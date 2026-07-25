/** D-164 contextual deterministic NER — real-server proof.
 *
 *  Drives the live `createPromptCacheGateDeps` over a real ContactStore/FTS
 *  index and the real gate, matcher, unique-contact probe, and renderer. This is
 *  the seam unit-only NER tests cannot prove: the local index proposes a stored
 *  display name, NER binds its exact prompt span, and the indexed exact lookup
 *  still independently proves uniqueness before any answer is rendered. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';
import { runGate } from '@recued/middleware-prompt-cache';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
});

const seed = (email: string, name: string): void => {
  store.upsertManual({ email, name }, 1_000);
};

const makeContext = (text: string): { ctx: TurnContext; resolved: string[] } => {
  const entry: SessionEntry = {
    session_id: 'contextual-name-test',
    surface: 'chat',
    role: 'user',
    text,
    ts: 1,
  };
  const resolved: string[] = [];
  const ctx = {
    surface: 'chat',
    history: [entry],
    prompt: { contribute: () => undefined, parts: () => [] },
    resolve: (value: string) => { resolved.push(value); },
    state: new Map<string, unknown>(),
  } as unknown as TurnContext;
  return { ctx, resolved };
};

const run = async (text: string) => {
  const deps = createPromptCacheGateDeps(() => store, () => undefined);
  const { ctx, resolved } = makeContext(text);
  const outcome = await runGate(ctx, deps);
  return { outcome, resolved };
};

describe('D-164 contextual name recovery through the real server gate', () => {
  it.each([
    [
      'lowercase multi-token',
      'alice@context.test',
      'Alice Bond',
      "what is alice bond's email address?",
      "Alice Bond's email address is alice@context.test.",
    ],
    [
      'single-token',
      'sarah@context.test',
      'Sarah',
      "what is Sarah's email address?",
      "Sarah's email address is sarah@context.test.",
    ],
    [
      'hyphenated',
      'jean-luc@context.test',
      'Jean-Luc Picard',
      "what is Jean-Luc Picard's email address?",
      "Jean-Luc Picard's email address is jean-luc@context.test.",
    ],
    [
      'apostrophe',
      'oconnor@context.test',
      'O’Connor Smith',
      'what is O’Connor Smith’s email address?',
      "O’Connor Smith's email address is oconnor@context.test.",
    ],
    [
      'initialed',
      'oppenheimer@context.test',
      'J. Robert Oppenheimer',
      "what is J. Robert Oppenheimer's email address?",
      "J. Robert Oppenheimer's email address is oppenheimer@context.test.",
    ],
    [
      'Japanese intent with Latin name',
      'alice.tanaka@context.test',
      'Alice Tanaka',
      'alice tanakaのメールアドレスは？',
      'Alice Tanakaのメールアドレスはalice.tanaka@context.testです。',
    ],
    [
      'Chinese intent with Latin name',
      'alice.zhang@context.test',
      'Alice Zhang',
      '请问alice zhang的邮箱是什么？',
      'Alice Zhang的电子邮件地址是alice.zhang@context.test。',
    ],
  ])('short-circuits a %s request with zero model work', async (
    _label,
    email,
    name,
    text,
    rendered,
  ) => {
    seed(email, name);

    const result = await run(text);

    expect(result.outcome).toEqual({ kind: 'short-circuit', text: rendered });
    expect(result.resolved).toEqual([rendered]);
  });

  it('normalises NFC/NFD for matching while rendering the stored canonical spelling', async () => {
    seed('elodie@context.test', 'Élodie Martin');
    const decomposed = 'E\u0301lodie Martin';

    const result = await run(`What is ${decomposed}’s email address?`);

    expect(result.outcome).toEqual({
      kind: 'short-circuit',
      text: "Élodie Martin's email address is elodie@context.test.",
    });
  });

  it('binds an exact email to its contact even when display-name uniqueness is impossible', async () => {
    store.upsertManual({
      email: 'alice.one@context.test',
      name: 'Alex Smith',
      phone: '+14155550101',
    }, 1_000);
    store.upsertManual({
      email: 'alice.two@context.test',
      name: 'Alex Smith',
      phone: '+14155550102',
    }, 1_001);

    const result = await run("what is alice.two@context.test's phone number?");

    expect(result.outcome).toEqual({
      kind: 'short-circuit',
      text: "Alex Smith's phone number is +14155550102.",
    });
  });

  it('binds a strict E.164 phone to one contact without country inference', async () => {
    store.upsertManual({
      email: 'phone.owner@context.test',
      name: 'Phone Owner',
      phone: '+14155550103',
    }, 1_000);

    const result = await run("what is +14155550103's email address?");

    expect(result.outcome).toEqual({
      kind: 'short-circuit',
      text: "Phone Owner's email address is phone.owner@context.test.",
    });

    store.upsertManual({
      email: 'phone.collision@context.test',
      name: 'Other Phone Owner',
      phone: '+14155550103',
    }, 1_001);
    expect((await run("what is +14155550103's email address?")).outcome.kind)
      .toBe('pass-through');
    expect((await run("what is ++14155550103's email address?")).outcome.kind)
      .toBe('pass-through');
  });

  it('uses a confidence-1 chat alias without mutating last_resolved_at during NER', async () => {
    const alice = store.upsertManual({
      email: 'alias.owner@context.test',
      name: 'Alice Bond',
    }, 1_000);
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    }, 1_001);

    const result = await run("what is mom's email address?");

    expect(result.outcome).toEqual({
      kind: 'short-circuit',
      text: "Alice Bond's email address is alias.owner@context.test.",
    });
    expect(store.listContactAliases(alice.contact_id!, 'chat_alias')[0]?.last_resolved_at)
      .toBeUndefined();
  });

  it('re-attests an alias at the probe and defers if its mapping changed', async () => {
    const alice = store.upsertManual({
      email: 'alias.race@context.test',
      name: 'Alice Bond',
    }, 1_000);
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    }, 1_001);
    const originalPeek = store.peekByAlias.bind(store);
    let momReads = 0;
    vi.spyOn(store, 'peekByAlias').mockImplementation((input) => {
      if (input.alias_pattern.toLowerCase() === 'mom') {
        momReads += 1;
        if (momReads > 1) return { contact: null, confidence: 0, alternatives: [] };
      }
      return originalPeek(input);
    });

    expect((await run("what is mom's email address?")).outcome.kind)
      .toBe('pass-through');
    expect(momReads).toBe(2);
  });

  it('does not manufacture ambiguity when an exact alias equals the display name', async () => {
    const alice = store.upsertManual({
      email: 'same.alias@context.test',
      name: 'Alice Bond',
    }, 1_000);
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Alice Bond',
      source: 'manual',
    }, 1_001);

    expect((await run("what is Alice Bond's email address?")).outcome).toEqual({
      kind: 'short-circuit',
      text: "Alice Bond's email address is same.alias@context.test.",
    });
  });

  it('requires an explicit platform qualifier for a platform id', async () => {
    const alice = store.upsertManual({
      email: 'github.owner@context.test',
      name: 'Alice Bond',
    }, 1_000);
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'platform_id',
      platform: 'github',
      alias_pattern: 'alice-gh',
      source: 'manual',
    }, 1_001);

    expect((await run("what is GitHub @alice-gh's email address?")).outcome).toEqual({
      kind: 'short-circuit',
      text: "Alice Bond's email address is github.owner@context.test.",
    });
    expect((await run("what is @alice-gh's email address?")).outcome.kind)
      .toBe('pass-through');
  });

  it('keeps lower-confidence inferred aliases out of deterministic NER', async () => {
    const alice = store.upsertManual({
      email: 'inferred.alias@context.test',
      name: 'Alice Bond',
    }, 1_000);
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'the closer',
      source: 'derived',
      confidence: 0.8,
    }, 1_001);

    expect((await run("what is the closer's email address?")).outcome)
      .toEqual({ kind: 'pass-through', reason: 'no-extraction' });
  });

  it('renders strict title/birthday reads and a complete two-contact list', async () => {
    store.upsertManual({
      email: 'alice@context.test',
      name: 'Alice Bond',
      title: 'Director',
      birthday: '--03-04',
    }, 1_000);
    store.upsertManual({
      email: 'bob@context.test',
      name: 'Bob Stone',
      title: 'Engineer',
      birthday: '1985-09-12',
    }, 1_001);

    expect((await run("what is alice bond's job title?")).outcome).toEqual({
      kind: 'short-circuit',
      text: "Alice Bond's job title is Director.",
    });
    expect((await run("when is bob stone's birthday?")).outcome).toEqual({
      kind: 'short-circuit',
      text: "Bob Stone's birthday is 1985-09-12.",
    });
    expect((await run('what are the job titles for alice bond and bob stone?')).outcome)
      .toEqual({
        kind: 'short-circuit',
        text: 'Job titles:\n- Alice Bond: Director\n- Bob Stone: Engineer',
      });
  });

  it('keeps a write-shaped request on the model path even when every email is known', async () => {
    store.upsertManual({
      email: 'current@context.test',
      name: 'Current Contact',
    }, 1_000);
    store.upsertManual({
      email: 'replacement@context.test',
      name: 'Replacement Contact',
    }, 1_001);

    expect((await run(
      "change current@context.test's email to replacement@context.test",
    )).outcome.kind).toBe('pass-through');
  });

  it('defers two canonically-equal stored names instead of asserting false uniqueness', async () => {
    seed('elodie-one@context.test', 'Élodie Martin');
    seed('elodie-two@context.test', 'E\u0301lodie Martin');

    const result = await run('What is Élodie Martin’s email address?');

    expect(result.outcome).toEqual({ kind: 'pass-through', reason: 'no-data-presence' });
    expect(result.resolved).toEqual([]);
  });

  it.each([
    [
      'two recovered names',
      "what is alice bond's email and bob stone's phone?",
      'no-template',
    ],
    [
      'mutation intent',
      "change alice bond's email to replacement@example.com",
      'no-template',
    ],
  ])('fails closed on %s', async (_label, text, reason) => {
    seed('alice@context.test', 'Alice Bond');
    seed('bob@context.test', 'Bob Stone');

    const result = await run(text);

    expect(result.outcome).toEqual({ kind: 'pass-through', reason });
    expect(result.resolved).toEqual([]);
  });

  it('does not resolve a stored suffix as an unknown lowercase full name', async () => {
    seed('bond@context.test', 'Bond');

    const result = await run("what is alice bond's email address?");

    expect(result.outcome).toEqual({ kind: 'pass-through', reason: 'no-extraction' });
    expect(result.resolved).toEqual([]);
  });
});
