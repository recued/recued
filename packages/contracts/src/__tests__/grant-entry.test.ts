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
  declaredOperationIdReservedPrefix,
  INGREDIENT_GRANT_PREFIX,
  isCollectionGrantEntry,
  isOpGrantEntry,
  isTopicGrantEntry,
  opGrantEntry,
  parseGrantEntry,
  primitiveGrantEntry,
  topicGrantEntry,
} from '../grant-entry.js';
import {
  isGrantedReadAdmissible,
  isOwnerDefaultOnlyEntry,
  ownerOnlyAdjustedAuthorDefault,
  isGeneratedPackOpEntry,
  isThirdPartyPackOpEntry,
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

  it('keeps server-owned op ids grantable while reserving them from declarations', () => {
    const primitive = primitiveGrantEntry('recipe.run');
    const ingredient = `${INGREDIENT_GRANT_PREFIX}mail-send_01234567`;
    for (const opId of ['core.mail.send', primitive, ingredient]) {
      expect(opGrantEntry(opId), opId).toBe(opId);
      expect(classifyGrantEntry(opId), opId).toBe('op');
      expect(declaredOperationIdReservedPrefix(opId), opId).toBeDefined();
    }
    expect(declaredOperationIdReservedPrefix('alice.mail-pack.message.send')).toBeUndefined();
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
      // Slice 2 — the Tier-1 calendar writes (owner-on / door-off). They ALSO
      // carry plan-approval; the grant simply runs first.
      'core.data.calendar.create',
      'core.data.calendar.update',
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
      // Slice 1 — the Tier-1 `work.create` writes. Same posture as the READ
      // below and `core.memory.write` above: owner-on, door-off. Per KIND, so
      // granting a door "may add notes" never also grants "may commit me".
      'core.work-entity.commitment.create',
      // Slice 3 — the `work.update` writes, per kind, plus the SEPARATE
      // completion op: `done` is the completion bit and travels alone.
      'core.work-entity.commitment.update',
      'core.work-entity.note.create',
      'core.work-entity.note.update',
      'core.work-entity.project.create',
      'core.work-entity.project.update',
      // 2026-07-16 — the work graph (task/note/commitment/project) behind the
      // Tier-1 `work.search` / `work.read` tools. Their READ had no grant handle
      // at all while all 15 work-entity WRITES had one, so they were default-ON
      // for every door. NB this is the CAPABILITY axis — the `data.<kind>`
      // collections deliberately keep their admit-all default (2026-07-12 ruling).
      'core.work-entity.read',
      'core.work-entity.task.create',
      'core.work-entity.task.mark-done',
      'core.work-entity.task.update',
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

describe('D-225 § 9.6 — generated-pack ops are owner-default-only', () => {
  const GEN_OP = 'recued-local.mcp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.delete_all_a1b2c3d4';
  const DOOR = 'door_abc';

  it('⛔ a WILDCARD door does NOT get a generated-pack op by default', () => {
    // The hole: `opAuthorDefault` is permissive for a wildcard door, so an op
    // with no grant row was ADMITTED. A third party adding a tool to a server
    // we enrolled would become reachable with no owner action at all.
    expect(ownerOnlyAdjustedAuthorDefault(GEN_OP, DOOR, /* normalDefault */ true)).toBe(false);
  });

  it('✅ the OWNER still gets it by default — owner chat is unaffected', () => {
    // The permitting half, and the one that matters: this is a TIGHTEN for
    // doors only. If it flipped the owner too, the chat wire built in § 9.5.1
    // would have been switched off by the fix for a different problem.
    expect(ownerOnlyAdjustedAuthorDefault(GEN_OP, OWNER_CONTRACT_ID, true)).toBe(true);
    expect(ownerOnlyAdjustedAuthorDefault(GEN_OP, '', true)).toBe(true);
  });

  it('recognises the CLASS, not an enumeration', () => {
    // A generated op id is per-user derived and can never be in a hardcoded
    // list, which is why the check is on the publisher.
    expect(isGeneratedPackOpEntry(GEN_OP)).toBe(true);
    expect(isGeneratedPackOpEntry('recued-local.mcp-0000.anything_00000000')).toBe(true);
    expect(isOwnerDefaultOnlyEntry(GEN_OP)).toBe(true);
  });

  it('⛔ does NOT catch an ordinary pack, a kernel op, or a collection entry', () => {
    // The blast radius. Widening this set silently would turn every door's
    // existing grants off, which is a worse failure than the hole it closes.
    for (const key of [
      'recued-core.hubspot.deal.read',
      'core.mail.send',
      'data.mail',
      'some-publisher.pack.op',
      // A publisher that merely STARTS with the reserved handle's letters must
      // not match — the dot boundary is what makes the prefix exact.
      'recued-localish.pack.op',
    ]) {
      expect(isGeneratedPackOpEntry(key), key).toBe(false);
    }
  });

  it('an explicit grant row still wins — a door the owner granted is unchanged', () => {
    // This gate only supplies the DEFAULT. The owner can still grant a
    // generated op to a door deliberately; that is the whole point of making it
    // require naming rather than making it unreachable.
    expect(resolveGrantEntry(true, ownerOnlyAdjustedAuthorDefault(GEN_OP, DOOR, true))).toBe(true);
  });
});

describe('§ 234.4p.16e — EVERY Tier-P pack op is owner-default-only', () => {
  it('covers ordinary installed packs, not just runtime-generated ones', () => {
    // ⛔ THE POINT OF THE GENERALISATION. `opAuthorDefault` reads a WILDCARD
    // door (empty `scope.operation_ids`) as permissive, and `isOpGranted`
    // resolves `explicit row ?? author-default` — so before this, a wildcard
    // door reached any ORDINARY pack op with no grant row anywhere. D-225 § 9.6
    // had closed exactly that hole for GENERATED packs; the same sentence is
    // true of a marketplace pack, whose updates can add ops too.
    expect(isThirdPartyPackOpEntry('recued-core.hubspot.deal_read')).toBe(true);
    expect(isThirdPartyPackOpEntry('acme.widgets.thing_create')).toBe(true);
    // A generated op is a SUBSET, still covered.
    expect(isThirdPartyPackOpEntry('recued-local.mcp-0000.anything_00000000')).toBe(true);
    // ⇒ and therefore owner-default-only, which is what a door actually reads.
    expect(isOwnerDefaultOnlyEntry('recued-core.hubspot.deal_read')).toBe(true);
  });

  it('does NOT sweep in kernel ops', () => {
    // ⛔ TIGHTEN ONLY WHAT THE REASON COVERS. `core.*` is Recued's own surface,
    // not a third party's declaration; covering it would silently revoke every
    // wildcard door's primitives — a far larger behaviour change wearing the
    // same commit.
    expect(isThirdPartyPackOpEntry('core.mail.send')).toBe(false);
    expect(isThirdPartyPackOpEntry('core.storage.shared.list')).toBe(false);
    // Non-op entry kinds are untouched.
    expect(isThirdPartyPackOpEntry('data.mail')).toBe(false);
    expect(isThirdPartyPackOpEntry('enrichment.embedding')).toBe(false);
  });
});
