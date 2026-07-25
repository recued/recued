/** Grant-foundation slice 3 (D-187 amendment `693b7d03`) — the unified grant-entry
 *  taxonomy (`grant-entry.ts`) + the pure grant-resolution rule (`grant-resolve.ts`).
 *
 *  Pins the fail-closed primitives: prefix classification is UNAMBIGUOUS (an
 *  `operation_id` never collides with the `data.` / `enrichment.` reserved prefixes,
 *  even a kernel op with `data`/`enrichment` MID-path), format↔parse round-trips, the
 *  `opGrantEntry` reserved-prefix fail-loud guard, and the three-state resolve where an
 *  explicit revoke (`false`) BEATS a permissive author default. */

import { describe, expect, it } from 'vitest';

import {
  classifyGrantEntry,
  collectionGrantEntry,
  isCollectionGrantEntry,
  isOpGrantEntry,
  isTopicGrantEntry,
  opGrantEntry,
  parseGrantEntry,
  topicGrantEntry,
} from '../grant-entry.js';
import {
  isGrantedReadAdmissible,
  isOwnerDefaultOnlyEntry,
  ownerOnlyAdjustedAuthorDefault,
  OWNER_DEFAULT_ONLY_GRANT_ENTRIES,
  resolveGrantEntry,
} from '../grant-resolve.js';
import { OWNER_CONTRACT_ID } from '../contract-definition.js';

describe('grant-entry taxonomy — format', () => {
  it('formats each kind with its prefix (op verbatim)', () => {
    expect(collectionGrantEntry('mail')).toBe('data.mail');
    expect(topicGrantEntry('embedding')).toBe('enrichment.embedding');
    expect(opGrantEntry('core.mail.send')).toBe('core.mail.send');
    expect(opGrantEntry('recued-core/hubspot.deal.read')).toBe('recued-core/hubspot.deal.read');
  });

  it('opGrantEntry fails LOUD on a reserved-prefix id (would mis-classify at the gate)', () => {
    expect(() => opGrantEntry('data.mail')).toThrow(/reserved_prefix/);
    expect(() => opGrantEntry('enrichment.embedding')).toThrow(/reserved_prefix/);
  });
});

describe('grant-entry taxonomy — classify (syntactic, unambiguous)', () => {
  it('classifies by prefix; an op id never collides with data./enrichment.', () => {
    expect(classifyGrantEntry('data.mail')).toBe('collection');
    expect(classifyGrantEntry('enrichment.embedding')).toBe('topic');
    expect(classifyGrantEntry('core.mail.send')).toBe('op');
    expect(classifyGrantEntry('recued-core/hubspot.deal.read')).toBe('op');
  });

  it('a kernel op with data/enrichment MID-path is still op (prefix is leading-only)', () => {
    // `core.data.enrichment.list` starts with `core.`, NOT `data.`/`enrichment.`.
    expect(classifyGrantEntry('core.data.enrichment.list')).toBe('op');
    expect(classifyGrantEntry('core.data.calendar.create')).toBe('op');
    expect(isOpGrantEntry('core.data.enrichment.list')).toBe(true);
    expect(isCollectionGrantEntry('data.mail')).toBe(true);
    expect(isTopicGrantEntry('enrichment.embedding')).toBe(true);
  });
});

describe('grant-entry taxonomy — parse round-trips the formatters', () => {
  it('parses each kind back to its payload', () => {
    expect(parseGrantEntry(collectionGrantEntry('contact'))).toEqual({ kind: 'collection', value: 'contact' });
    expect(parseGrantEntry(topicGrantEntry('thread_signals'))).toEqual({ kind: 'topic', value: 'thread_signals' });
    expect(parseGrantEntry('core.mail.send')).toEqual({ kind: 'op', value: 'core.mail.send' });
    expect(parseGrantEntry('recued-core/hubspot.deal.read')).toEqual({
      kind: 'op',
      value: 'recued-core/hubspot.deal.read',
    });
  });
});

describe('grant-resolve — three-state rule (explicit ?? authorDefault)', () => {
  it('an explicit grant/revoke wins; only absence falls back', () => {
    expect(resolveGrantEntry(true, false)).toBe(true);
    // The load-bearing case: an explicit revoke BEATS a permissive author default.
    expect(resolveGrantEntry(false, true)).toBe(false);
    expect(resolveGrantEntry(undefined, true)).toBe(true);
    expect(resolveGrantEntry(undefined, false)).toBe(false);
  });
});

describe('grant-resolve — read gate (verb-op ∧ entry)', () => {
  it('admits only when BOTH the verb-op and the entry grant resolve true', () => {
    expect(isGrantedReadAdmissible(true, true)).toBe(true);
    expect(isGrantedReadAdmissible(true, false)).toBe(false);
    expect(isGrantedReadAdmissible(false, true)).toBe(false);
    expect(isGrantedReadAdmissible(false, false)).toBe(false);
  });
});

describe('OWNER-default-only sensitive surfaces (D-187 slice 3b)', () => {
  it('covers engagements, audit, memory, the work graph, webhook, and free-form response gates', () => {
    expect([...OWNER_DEFAULT_ONLY_GRANT_ENTRIES].sort()).toEqual([
      // D-198 follow-on — run history is its OWN domain now (was
      // `core.memory.audit.read`, which read as part of the knowledge-pool family).
      'core.audit.read',
      'core.contact.engagements.read',
      'core.data.form-response.get',
      'core.data.form-response.list',
      // D-210 A.8 slice 2a — the lifecycle WRITE. A read of visitor answers is
      // owner-default-only, so a write that moves a visitor's state must be at
      // least as closed.
      'core.data.form-response.set-state',
      'core.data.webhook.get',
      'core.data.webhook.list',
      // D-198 Slice 4 — collective-memory write/read: owner-on, door-off default.
      'core.memory.read',
      'core.memory.write',
      'core.webhook.event.get',
      // 2026-07-16 — the work graph (task/note/commitment/project) behind the
      // Tier-1 `work.search` / `work.read` tools. Their READ had no grant handle
      // at all while all 15 work-entity WRITES had one, so they were default-ON
      // for every door. NB this is the CAPABILITY axis — the `data.<kind>`
      // collections deliberately keep their admit-all default (2026-07-12 ruling).
      'core.work-entity.read',
      'data.form_response',
      'data.webhook',
    ]);
  });

  it('isOwnerDefaultOnlyEntry recognizes members + rejects non-members', () => {
    expect(isOwnerDefaultOnlyEntry('core.audit.read')).toBe(true);
    expect(isOwnerDefaultOnlyEntry('data.webhook')).toBe(true);
    expect(isOwnerDefaultOnlyEntry('core.data.form-response.get')).toBe(true);
    expect(isOwnerDefaultOnlyEntry('core.data.form-response.set-state')).toBe(true);
    expect(isOwnerDefaultOnlyEntry('data.form_response')).toBe(true);
    expect(isOwnerDefaultOnlyEntry('core.webhook.event.get')).toBe(true);
    // a normal read op / collection / topic is NOT owner-only.
    expect(isOwnerDefaultOnlyEntry('core.mail.get')).toBe(false);
    expect(isOwnerDefaultOnlyEntry('data.mail')).toBe(false);
    expect(isOwnerDefaultOnlyEntry('core.data.enrichment.read')).toBe(false); // slice-3 verb, NOT owner-only
  });

  it('ownerOnlyAdjustedAuthorDefault: owner + contract-free admit; a live door denies; non-members pass through', () => {
    const SENS = 'core.audit.read';
    const NORMAL = 'core.mail.get';
    // sensitive: ON for the owner, ON for a contract-free ('') dispatch (owner-trust),
    // OFF for a live non-owner door — REGARDLESS of the permissive `normalDefault`.
    expect(ownerOnlyAdjustedAuthorDefault(SENS, OWNER_CONTRACT_ID, false)).toBe(true);
    expect(ownerOnlyAdjustedAuthorDefault(SENS, '', false)).toBe(true);
    expect(ownerOnlyAdjustedAuthorDefault(SENS, 'ct-door', true)).toBe(false);
    expect(
      ownerOnlyAdjustedAuthorDefault(
        'core.data.form-response.get',
        'ct-door',
        true,
      ),
    ).toBe(false);
    // non-sensitive: passes `normalDefault` through untouched (no override).
    expect(ownerOnlyAdjustedAuthorDefault(NORMAL, 'ct-door', true)).toBe(true);
    expect(ownerOnlyAdjustedAuthorDefault(NORMAL, 'ct-door', false)).toBe(false);
  });
});
