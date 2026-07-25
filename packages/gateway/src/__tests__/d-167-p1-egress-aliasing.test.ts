/** D-167 P1 - gateway egress aliasing tests for spec §"Runtime flow" and §"Gateway". */

import type { PiiAliasableData, PiiFieldTag } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  aliasArgsForEgress,
  aliasPacketForEgress,
  buildRedactionSummary,
  createSessionLedgerStore,
  noopFieldPrivacyResolver,
  restoreArgsForApproval,
  restoreForDisplay,
  shouldAliasForEgress,
  type AliasPacketInput,
  type AliasPacketResult,
  type EgressGateInput,
  type FieldPrivacyResolver,
} from '../pii-egress/index.js';

const zeroCounters = () => ({
  email: 0,
  name: 0,
  org: 0,
  phone: 0,
  address: 0,
  url: 0,
  external_id: 0,
  account_id: 0,
  content_text_replacements: 0,
});

const resolverFor = (fields: readonly PiiFieldTag[]): FieldPrivacyResolver => () => fields;

describe('aliasPacketForEgress', () => {
  it('aliases the worked example and emits the default alias summary', () => {
    const store = createSessionLedgerStore();
    const ledger = store.getOrCreate('chat-1');
    const packet = {
      owner_email: 'alice@acme.com',
      owner_name: 'Alice Chen',
      company_name: 'Acme',
      notes: 'Alice Chen confirmed renewal; Acme will sign by Friday. CC bob@acme.com on the contract email and ping acme.com/portal for the renewal page.',
    };
    const input: AliasPacketInput = {
      ledger,
      packet,
      resolver: resolverFor([
        { path: 'owner_email', kind: 'email' },
        { path: 'owner_name', kind: 'name' },
        { path: 'company_name', kind: 'org' },
        { path: 'notes', kind: 'content' },
      ]),
    };

    const result: AliasPacketResult = aliasPacketForEgress(input);

    expect(result.aliased).toEqual({
      owner_email: 'm1@d1.invalid',
      owner_name: 'pii.Person1',
      company_name: 'pii.Org1',
      notes: 'pii.Person1 confirmed renewal; pii.Org1 will sign by Friday. CC m2@d1.invalid on the contract email and ping d1.invalid/portal for the renewal page.',
    });
    expect(result.summary).toEqual({
      mode: 'alias',
      scope_kind: 'session',
      counts: {
        email: 1,
        name: 1,
        org: 1,
        content_text_replacements: 4,
      },
    });
  });

  it('flows a mode override into summary.mode', () => {
    const store = createSessionLedgerStore();
    const result = aliasPacketForEgress({
      ledger: store.getOrCreate('chat-1'),
      packet: { owner_name: 'Alice Chen' },
      resolver: resolverFor([{ path: 'owner_name', kind: 'name' }]),
      mode: 'alias_known_entities',
    });

    expect(result.aliased).toEqual({ owner_name: 'pii.Person1' });
    expect(result.summary).toEqual({
      mode: 'alias_known_entities',
      scope_kind: 'session',
      counts: { name: 1 },
    });
  });

  it('leaves packets unchanged with the noop resolver and emits empty counts', () => {
    const store = createSessionLedgerStore();
    const packet: PiiAliasableData = {
      owner: { email: 'alice@acme.com' },
      notes: 'Alice Chen at Acme',
    };

    const result = aliasPacketForEgress({
      ledger: store.getOrCreate('chat-1'),
      packet,
      resolver: noopFieldPrivacyResolver,
    });

    expect(result.aliased).toEqual(packet);
    expect(result.aliased).not.toBe(packet);
    expect(result.summary.counts).toEqual({});
  });
});

describe('gateway egress helpers', () => {
  it('buildRedactionSummary always uses session scope', () => {
    expect(buildRedactionSummary('drop', { ...zeroCounters(), phone: 2 })).toEqual({
      mode: 'drop',
      scope_kind: 'session',
      counts: { phone: 2 },
    });
  });

  it('shouldAliasForEgress follows owns_llm_egress exactly', () => {
    const owned: EgressGateInput = { owns_llm_egress: true };
    const external: EgressGateInput = { owns_llm_egress: false };

    expect(shouldAliasForEgress(owned)).toBe(true);
    expect(shouldAliasForEgress(external)).toBe(false);
  });
});

describe('gateway restore boundaries', () => {
  it('restores display text for canonical aliases, casing fallback, and unknown aliases', () => {
    const store = createSessionLedgerStore();
    const ledger = store.getOrCreate('chat-1');
    aliasPacketForEgress({
      ledger,
      packet: {
        owner_email: 'alice@acme.com',
        owner_name: 'Alice Chen',
        company_name: 'Acme',
      },
      resolver: resolverFor([
        { path: 'owner_email', kind: 'email' },
        { path: 'owner_name', kind: 'name' },
        { path: 'company_name', kind: 'org' },
      ]),
    });

    expect(restoreForDisplay(
      ledger,
      'pii.Person1 emailed m1@d1.invalid from pii.Org1; pii.person1 copied pii.Person99.',
    )).toBe('Alice Chen emailed alice@acme.com from Acme; Alice Chen copied pii.Person99.');
  });

  it('restores nested approval args before preview', () => {
    const store = createSessionLedgerStore();
    const ledger = store.getOrCreate('chat-1');
    aliasPacketForEgress({
      ledger,
      packet: {
        owner_email: 'alice@acme.com',
        owner_name: 'Alice Chen',
        company_name: 'Acme',
      },
      resolver: resolverFor([
        { path: 'owner_email', kind: 'email' },
        { path: 'owner_name', kind: 'name' },
        { path: 'company_name', kind: 'org' },
      ]),
    });

    expect(restoreArgsForApproval(ledger, {
      to: 'm1@d1.invalid',
      subject: 'Follow up with pii.Person1',
      payload: {
        mentions: ['pii.Person1', 'pii.Org1'],
        nested: { body: 'pii.Person1 at pii.Org1' },
      },
    })).toEqual({
      to: 'alice@acme.com',
      subject: 'Follow up with Alice Chen',
      payload: {
        mentions: ['Alice Chen', 'Acme'],
        nested: { body: 'Alice Chen at Acme' },
      },
    });
  });

  it('restores phone aliases through base-alias lookup when the suffix is wrong', () => {
    const store = createSessionLedgerStore();
    const ledger = store.getOrCreate('chat-1');
    aliasPacketForEgress({
      ledger,
      packet: { phone: '+44-20-7946-0958' },
      resolver: resolverFor([{ path: 'phone', kind: 'phone' }]),
    });

    expect(restoreForDisplay(ledger, 'Call pii.Phone1.gb or pii.Phone1.us.'))
      .toBe('Call +44-20-7946-0958 or +44-20-7946-0958.');
  });
});

describe('aliasArgsForEgress — forward re-alias of restored args (D-167 N.10)', () => {
  /** Seed a ledger with a contact the way the egress alias pass would. */
  const seeded = () => {
    const store = createSessionLedgerStore();
    const ledger = store.getOrCreate('chat-1');
    aliasPacketForEgress({
      ledger,
      packet: { owner_email: 'alice@acme.com', owner_name: 'Alice Chen' },
      resolver: resolverFor([
        { path: 'owner_email', kind: 'email' },
        { path: 'owner_name', kind: 'name' },
      ]),
    });
    return ledger;
  };

  it('re-aliases ledger-known real values in nested args + reports the summary', () => {
    const ledger = seeded();
    const { aliased, summary } = aliasArgsForEgress(ledger, {
      to: 'alice@acme.com',
      payload: { mentions: ['Alice Chen'], nested: { body: 'Alice Chen at home' } },
    });
    expect(aliased).toEqual({
      to: 'm1@d1.invalid',
      payload: { mentions: ['pii.Person1'], nested: { body: 'pii.Person1 at home' } },
    });
    // A content scan only ever produces content_text_replacements.
    expect(summary.counts.content_text_replacements).toBeGreaterThan(0);
  });

  it('round-trips with restoreArgsForApproval', () => {
    const ledger = seeded();
    const real = { to: 'alice@acme.com', note: 'ping Alice Chen', n: 7 };
    const { aliased } = aliasArgsForEgress(ledger, real);
    expect(restoreArgsForApproval(ledger, aliased)).toEqual(real);
  });

  it('aliases a value under a literal-dot arg key (value-based, not dot-path)', () => {
    const ledger = seeded();
    const { aliased } = aliasArgsForEgress(ledger, { 'filter.email': 'alice@acme.com' });
    expect((aliased as Record<string, unknown>)['filter.email']).toBe('m1@d1.invalid');
  });

  it('passes an unknown value through with an empty summary (ledger-anchored)', () => {
    const ledger = seeded();
    const { aliased, summary } = aliasArgsForEgress(ledger, { to: 'zoe@elsewhere.com' });
    expect(aliased).toEqual({ to: 'zoe@elsewhere.com' });
    expect(Object.keys(summary.counts)).toHaveLength(0);
  });
});

describe('session ledger store', () => {
  it('returns the same ledger reference for repeated getOrCreate calls', () => {
    const store = createSessionLedgerStore();
    const first = store.getOrCreate('chat-1');
    const second = store.getOrCreate('chat-1');

    expect(second).toBe(first);
    expect(store.get('chat-1')).toBe(first);
    expect(store.size()).toBe(1);
  });

  it('reuses aliases across packets within one session', () => {
    const store = createSessionLedgerStore();
    const ledger = store.getOrCreate('chat-1');
    const resolver = resolverFor([{ path: 'owner_email', kind: 'email' }]);

    expect(aliasPacketForEgress({
      ledger,
      packet: { owner_email: 'alice@acme.com' },
      resolver,
    }).aliased).toEqual({ owner_email: 'm1@d1.invalid' });
    expect(aliasPacketForEgress({
      ledger,
      packet: { owner_email: 'alice@acme.com' },
      resolver,
    }).aliased).toEqual({ owner_email: 'm1@d1.invalid' });
  });

  it('isolates alias numbering across sessions', () => {
    const store = createSessionLedgerStore();
    const resolver = resolverFor([{ path: 'owner_name', kind: 'name' }]);

    expect(aliasPacketForEgress({
      ledger: store.getOrCreate('chat-a'),
      packet: { owner_name: 'Alice Chen' },
      resolver,
    }).aliased).toEqual({ owner_name: 'pii.Person1' });
    expect(aliasPacketForEgress({
      ledger: store.getOrCreate('chat-b'),
      packet: { owner_name: 'Bob Smith' },
      resolver,
    }).aliased).toEqual({ owner_name: 'pii.Person1' });
    expect(store.size()).toBe(2);
  });

  it('drops sessions idempotently and get returns undefined after drop', () => {
    const store = createSessionLedgerStore();
    store.getOrCreate('chat-1');
    store.getOrCreate('chat-2');

    expect(store.size()).toBe(2);
    store.drop('chat-1');
    expect(store.size()).toBe(1);
    expect(store.get('chat-1')).toBeUndefined();
    store.drop('chat-1');
    expect(store.size()).toBe(1);
  });
});
