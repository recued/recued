import { describe, expect, it } from 'vitest';

import {
  aliasCandidateValuesForEgress,
  aliasPacketForEgress,
  createSessionLedgerStore,
} from '../pii-egress/index.js';

describe('D-213 Track B — allocate only candidates present in the packet', () => {
  it('aliases a present candidate and allocates nothing for an absent one', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const result = aliasCandidateValuesForEgress(
      ledger,
      {
        user_message: 'Ask Alice Ada about the renewal',
        recall_context: [{ result: { content: 'Alice Ada owns it' } }],
      },
      [
        { value: 'Alice Ada', kind: 'name' },
        { value: 'Absent Corporation', kind: 'org' },
      ],
      ['Ask Alice'],
    );
    expect(JSON.stringify(result.aliased)).not.toContain('Alice Ada');
    expect(JSON.stringify(result.aliased)).toContain('pii.Person1.alice');
    expect(ledger.byKindRealValue.has('name::Alice Ada')).toBe(true);
    expect(ledger.byKindRealValue.has('org::Absent Corporation')).toBe(false);
  });

  it('does not allocate an id whose only occurrence cannot pass the content boundary', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const packet = { prior_tool_calls: [{ result: 'x_CONTACT-77' }] };
    const result = aliasCandidateValuesForEgress(
      ledger,
      packet,
      [{ value: 'CONTACT-77', kind: 'external_id' }],
      [],
    );
    expect(result.aliased).toEqual(packet);
    expect(ledger.byKindRealValue.has('external_id::CONTACT-77')).toBe(false);
  });

  it('allocates and replaces a distinctive id when it is actually model-visible', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const result = aliasCandidateValuesForEgress(
      ledger,
      { recall_context: [{ result: { id: 'CONTACT-77' } }] },
      [{ value: 'CONTACT-77', kind: 'external_id' }],
      [],
    );
    expect(JSON.stringify(result.aliased)).toContain('pii.Id1');
    expect(ledger.byKindRealValue.has('external_id::CONTACT-77')).toBe(true);
  });

  it('protects a retained known value that appears only in a nested data key', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const result = aliasCandidateValuesForEgress(
      ledger,
      {
        recall_context: [{
          result: { 'owner_Alice Ada': 'historical relationship' },
        }],
      },
      [{ value: 'Alice Ada', kind: 'name' }],
      [],
    );
    const serialized = JSON.stringify(result.aliased);
    expect(serialized).not.toContain('Alice Ada');
    expect(serialized).toContain('owner_pii.Person1');
    expect(ledger.byKindRealValue.has('name::Alice Ada')).toBe(true);
  });

  it('does not allocate a candidate found only in a stripped unsafe member', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const result = aliasCandidateValuesForEgress(
      ledger,
      { constructor: 'Alice Ada', safe: 'history' },
      [{ value: 'Alice Ada', kind: 'name' }],
      [],
    );
    expect(result.aliased).toEqual({ safe: 'history' });
    expect(ledger.byKindRealValue.has('name::Alice Ada')).toBe(false);
  });

  it('does not allocate an absent URL merely because another path shares its host', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const packet = {
      recall_context: [{ result: 'Read https://acme.example/public' }],
    };
    const result = aliasCandidateValuesForEgress(
      ledger,
      packet,
      [{ value: 'https://acme.example/private', kind: 'url' }],
      [],
    );
    expect(result.aliased).toEqual(packet);
    expect(
      ledger.byKindRealValue.has('url::https://acme.example/private'),
    ).toBe(false);
  });

  it('preserves existing current-session numbering while appending a recalled value', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const first = aliasPacketForEgress({
      ledger,
      packet: { owner: 'Current Person' },
      resolver: () => [{ path: 'owner', kind: 'name' }],
    });
    expect((first.aliased as { owner: string }).owner).toBe('pii.Person1');
    const recalled = aliasCandidateValuesForEgress(
      ledger,
      { recall_context: [{ result: 'Historical Person' }] },
      [{ value: 'Historical Person', kind: 'name' }],
      [],
    );
    expect(JSON.stringify(recalled.aliased)).toContain('pii.Person2');
    expect(
      ledger.byKindRealValue.get('name::Current Person')?.alias_value,
    ).toBe('pii.Person1');
  });

  it('does not consume numbering for absent identifier candidates', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const result = aliasCandidateValuesForEgress(
      ledger,
      { recall_context: [{ result: 'CONTACT-77' }] },
      [
        { value: 'ABSENT-10', kind: 'external_id' },
        { value: 'CONTACT-77', kind: 'external_id' },
      ],
      [],
    );
    expect(JSON.stringify(result.aliased)).toContain('pii.Id1');
    expect(ledger.byKindRealValue.has('external_id::ABSENT-10')).toBe(false);
    expect(
      ledger.byKindRealValue.get('external_id::CONTACT-77')?.alias_value,
    ).toBe('pii.Id1');
  });

  it('keeps exact-casing siblings under one canonical identity number', () => {
    const ledger = createSessionLedgerStore().getOrCreate('s');
    const result = aliasCandidateValuesForEgress(
      ledger,
      { recall_context: [{ result: 'Alice Ada / ALICE ADA' }] },
      [
        { value: 'Alice Ada', kind: 'name' },
        { value: 'ALICE ADA', kind: 'name' },
      ],
      [],
    );
    expect(JSON.stringify(result.aliased)).toContain(
      'pii.Person1 / cap_pii.Person1',
    );
    expect(ledger.byKindRealValue.get('name::Alice Ada')?.alias_value).toBe(
      'pii.Person1',
    );
    expect(ledger.byKindRealValue.get('name::ALICE ADA')?.alias_value).toBe(
      'cap_pii.Person1',
    );
  });
});

describe('§9 — one source piece recalled into two sessions is NOT correlatable', () => {
  // ⛔ This replaces the C1 source-scanning ratchet the 2026-07-24 audit found
  // missing, and is strictly stronger: a ratchet checks that nobody wrote the
  // forbidden code, this checks the property the ratchet was protecting.
  //
  // 🔑 Owner, 2026-07-25: "if that piece is later recalled into a third session
  // it is a different alias — this is the strongest evidence of our PII design."
  // Stated positively: if one source piece carried ONE token everywhere it was
  // recalled, that token would BE the stable cross-session identifier §9
  // forbids — anyone holding two sessions' `chat_egress` could join them on it.
  const recallTheSamePiece = (
    sessionId: string,
    priorPeople: readonly string[],
  ): string => {
    const ledger = createSessionLedgerStore().getOrCreate(sessionId);
    // Each session has its own prior history, so its namespace is at its own
    // position when the shared piece arrives.
    for (const person of priorPeople) {
      aliasCandidateValuesForEgress(
        ledger,
        { user_message: `note about ${person}` },
        [{ value: person, kind: 'name' }],
        [],
      );
    }
    // The IDENTICAL source piece is now recalled into this session.
    const { aliased } = aliasCandidateValuesForEgress(
      ledger,
      { recall_context: [{ result: { content: 'John Adams owes a reply' } }] },
      [{ value: 'John Adams', kind: 'name' }],
      [],
    );
    return JSON.stringify(aliased);
  };

  it('gives the same person a different alias in each recalling session', () => {
    const inB = recallTheSamePiece('sessionB', ['Mary Chen']);
    const inC = recallTheSamePiece('sessionC', ['Ann Lee', 'Bo Ruiz']);

    // Same person, same source piece, two sessions — two different tokens.
    expect(inB).toContain('pii.Person2');
    expect(inC).toContain('pii.Person3');
    expect(inB).not.toContain('pii.Person3');
    expect(inC).not.toContain('pii.Person2');

    // The real value never travels, in either.
    expect(inB).not.toContain('John Adams');
    expect(inC).not.toContain('John Adams');
  });

  it('derives the alias from the SESSION namespace, never from the value', () => {
    // The same value first into two otherwise-identical sessions collides on
    // Person1 — which is fine, and is exactly why the assertion above varies the
    // prior history. What must never happen is a value-derived token: that would
    // make the alias stable across every session that ever saw this person.
    const firstInX = recallTheSamePiece('sessionX', []);
    const firstInY = recallTheSamePiece('sessionY', []);
    expect(firstInX).toContain('pii.Person1');
    expect(firstInY).toContain('pii.Person1');
    // …and one prior person is enough to move it, proving position not identity.
    expect(recallTheSamePiece('sessionZ', ['Mary Chen'])).toContain('pii.Person2');
  });
});
