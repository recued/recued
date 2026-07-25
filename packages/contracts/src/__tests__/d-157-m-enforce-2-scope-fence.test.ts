/** M-ENFORCE-2 — `deriveDispatchScope` + the scope fence it feeds.
 *
 *  Pins the dispatch → `data.*` / `connection.*` scope-path derivation and its
 *  interaction with `evaluateScopeRestrictions` against the webhook reconcilers'
 *  `['connection.api.*', 'data.enrichment.*']` fence. D-187 retired the matrix
 *  `(webhook, system)` cell + the `EffectivePolicy` wrapper; the fence is now the
 *  bare `scope_restrictions` list a contract's grant rows resolve to. The
 *  gateway-side wiring (`evaluatePreflightAdmission` + the per-call probe) is
 *  pinned in `packages/gateway/src/__tests__/`.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveDispatchScope,
  evaluateScopeRestrictions,
  matchScopePattern,
} from '@recued/contracts';

describe('M-ENFORCE-2 deriveDispatchScope', () => {
  it('derives connection.<connection_kind> from the resolved input', () => {
    expect(
      deriveDispatchScope(
        { kind: 'connection', slug: 'deal-reader-hubspot' },
        { connection_kind: 'api', connection: 'hub' },
      ),
    ).toBe('connection.api');
    expect(
      deriveDispatchScope(
        { kind: 'connection', slug: 'slack-post' },
        { connection_kind: 'notification' },
      ),
    ).toBe('connection.notification');
    expect(
      deriveDispatchScope(
        { kind: 'connection', slug: 'mcp-tool' },
        { connection_kind: 'mcp' },
      ),
    ).toBe('connection.mcp');
  });

  it('fails closed to bare connection when connection_kind is absent / non-string', () => {
    // The `*-catalog` + connection-management wrappers carry no
    // `connection_kind`; a templated value that resolved to a non-string
    // also lands here. Bare `connection` matches no `connection.<sub>.*`
    // restriction.
    expect(
      deriveDispatchScope({ kind: 'connection', slug: 'hubspot-catalog' }, {}),
    ).toBe('connection');
    expect(
      deriveDispatchScope({ kind: 'connection', slug: 'x' }, undefined),
    ).toBe('connection');
    expect(
      deriveDispatchScope(
        { kind: 'connection', slug: 'x' },
        { connection_kind: 42 },
      ),
    ).toBe('connection');
    expect(
      deriveDispatchScope(
        { kind: 'connection', slug: 'x' },
        { connection_kind: '' },
      ),
    ).toBe('connection');
  });

  it('derives data.<collection> from the storage slug, canonicalizing email -> mail', () => {
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-upsert' }, {}),
    ).toBe('data.enrichment');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-list' }, {}),
    ).toBe('data.enrichment');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'email-get' }, {}),
    ).toBe('data.mail');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'calendar-create' }, {}),
    ).toBe('data.calendar');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'shared-write' }, {}),
    ).toBe('data.shared');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'shared-compare-and-set' }, {}),
    ).toBe('data.shared');
  });

  it('uses the whole slug as the collection when there is no dash', () => {
    expect(deriveDispatchScope({ kind: 'storage', slug: 'contact' }, {})).toBe(
      'data.contact',
    );
  });

  it('special-cases data-file-read to data.file (not data.data) — D-172 review F2.B', () => {
    // The file-read collection is the slug's SECOND segment (`file`), not its
    // leading `data` segment, so the generic leading-segment rule would
    // mis-derive `data.data` and mis-evaluate any `data.file` scope_restrictions
    // — for BOTH the D-172 F2 mail-send-attachment gate AND the first-class
    // `data-file-read` ingredient dispatch.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'data-file-read' }, {}),
    ).toBe('data.file');
    // The special-case must affect ONLY `data-file-read`: every other storage
    // slug keeps the generic leading-segment rule unchanged.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'mail-send' }, {}),
    ).toBe('data.mail');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-upsert' }, {}),
    ).toBe('data.enrichment');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'file-write' }, {}),
    ).toBe('data.file');
    // D-185 Slice 4 — `file-persist` (the temp→cas keep step) rides the generic
    // leading-segment rule to `data.file`, so it is gated under the SAME scope as
    // the other file ops (an owner's data.file write grant covers it).
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'file-persist' }, {}),
    ).toBe('data.file');
    // D-200's strict renderer consumes a durable file and produces a temp file;
    // its `file-*` slug keeps both sides under the same data.file scope fence.
    expect(
      deriveDispatchScope(
        { kind: 'storage', slug: 'file-render-markdown-template' },
        {},
      ),
    ).toBe('data.file');
  });

  it('special-cases form-response-get to the canonical data.form_response collection', () => {
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'form-response-get' }, {}),
    ).toBe('data.form_response');
    // The special case is exact: similarly prefixed storage slugs continue to
    // use the generic leading segment instead of inheriting response access.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'form-list' }, {}),
    ).toBe('data.form');
  });

  it('derives data.enrichment.<topic> for enrichment ops carrying a topic (per-topic resource row)', () => {
    // Enrichment access gates PER-TOPIC: the resolved `topic` arg becomes the
    // scope row a contract grants. Read (`enrichment-list`) and write
    // (`enrichment-upsert`) both key on the topic so the fence is symmetric.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-list' }, { topic: 'transcript' }),
    ).toBe('data.enrichment.transcript');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-upsert' }, { topic: 'summary' }),
    ).toBe('data.enrichment.summary');
    // No / empty topic (the handler rejects a topic-less call) → bare family
    // scope, still matched by a `data.enrichment.*` grant.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-list' }, {}),
    ).toBe('data.enrichment');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'enrichment-list' }, { topic: '' }),
    ).toBe('data.enrichment');
    // The per-topic refinement affects ONLY enrichment ops — a non-enrichment
    // storage slug that happens to carry a `topic` arg is unchanged.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'mail-send' }, { topic: 'transcript' }),
    ).toBe('data.mail');
  });

  it('special-cases timeline-read to the ENTITY collection, not data.timeline — D-177 read-gate', () => {
    // Reading X's timeline requires X's collection scope (same invariant as a
    // direct read + the MCP meta-tool fence). The generic leading-segment rule
    // would yield the fixed `data.timeline`, over-restricting a collection-
    // scoped door and (if `data.timeline` were granted) letting it read any
    // entity ungated.
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'timeline-read' }, { entity: 'contact:bob@example.com' }),
    ).toBe('data.contact');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'timeline-read' }, { entity: 'mail:msg-1' }),
    ).toBe('data.mail');
    // email-prefixed entity canonicalizes to mail (same alias as the slug rule).
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'timeline-read' }, { entity: 'email:msg-1' }),
    ).toBe('data.mail');
  });

  it('timeline-read falls back to data.timeline for a dotted/platform-ref or unparseable entity', () => {
    // A dotted platform-ref prefix (its own gate decides) and any entity the
    // gate can't parse into a raw collection keep the prior `data.timeline`
    // behavior — no incorrect widening to a synthetic `data.connection.…` scope.
    expect(
      deriveDispatchScope(
        { kind: 'storage', slug: 'timeline-read' },
        { entity: 'connection.api.hubspot.contact:deal_42' },
      ),
    ).toBe('data.timeline');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'timeline-read' }, { entity: 'no-colon' }),
    ).toBe('data.timeline');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'timeline-read' }, { entity: ':leading-colon' }),
    ).toBe('data.timeline');
    expect(
      deriveDispatchScope({ kind: 'storage', slug: 'timeline-read' }, {}),
    ).toBe('data.timeline');
  });

  it('returns null for every kind that touches no gated scope family', () => {
    for (const kind of ['http', 'ai', 'mcp', 'dom', 'chat', 'service'] as const) {
      expect(deriveDispatchScope({ kind, slug: `${kind}-tool` }, {})).toBeNull();
    }
  });
});

describe('M-ENFORCE-2 webhook scope fence (connection.api + data.enrichment)', () => {
  // The restrictions the retired (webhook, system) cell once carried; now the
  // fence the webhook reconcilers' grant rows resolve to (D-187).
  const WEBHOOK_RESTRICTIONS = ['connection.api.*', 'data.enrichment.*'];

  it('admits connection.api + data.enrichment paths', () => {
    for (const path of [
      'connection.api',
      'connection.api.hubspot',
      'data.enrichment',
      'data.enrichment.connection.api.hubspot.deal.1.summary',
    ]) {
      expect(evaluateScopeRestrictions(WEBHOOK_RESTRICTIONS, path)).toEqual({ verdict: 'admit' });
    }
  });

  it('denies notification / mcp sends, bare connection, and non-enrichment collections', () => {
    for (const path of [
      'connection.notification',
      'connection.mcp',
      'connection',
      'data.mail',
      'data.shared',
      'data.memory',
    ]) {
      expect(evaluateScopeRestrictions(WEBHOOK_RESTRICTIONS, path)).toMatchObject({
        verdict: 'deny',
        code: 'scope_not_in_restrictions',
      });
    }
  });

  it('the derived scope round-trips through the webhook restrictions', () => {
    const verdictFor = (
      kind: 'connection' | 'storage',
      slug: string,
      input: Record<string, unknown>,
    ) =>
      evaluateScopeRestrictions(
        WEBHOOK_RESTRICTIONS,
        deriveDispatchScope({ kind, slug }, input)!,
      ).verdict;

    // The two flows a webhook reconciler legitimately runs.
    expect(verdictFor('connection', 'deal-reader-hubspot', { connection_kind: 'api' })).toBe('admit');
    expect(verdictFor('storage', 'enrichment-upsert', {})).toBe('admit');
    // The things the fence exists to block.
    expect(verdictFor('connection', 'slack-post', { connection_kind: 'notification' })).toBe('deny');
    expect(verdictFor('storage', 'email-get', {})).toBe('deny');
  });
});

describe('M-ENFORCE-2 per-topic enrichment fence', () => {
  const enrichmentScope = (topic: string): string =>
    deriveDispatchScope({ kind: 'storage', slug: 'enrichment-list' }, { topic })!;

  it('a data.enrichment.<topic> restriction admits only that topic', () => {
    const scopes = ['data.enrichment.transcript'];
    // The granted topic admits...
    expect(evaluateScopeRestrictions(scopes, enrichmentScope('transcript')).verdict).toBe('admit');
    // ...a different topic is denied. This is the per-topic control the
    // unification gives the owner: a contract granted `transcript` can NOT read
    // `summary` (the file-content topics transcript/caption/extracted_text become
    // their own grantable rows instead of riding a blanket `data.enrichment`).
    expect(evaluateScopeRestrictions(scopes, enrichmentScope('summary'))).toMatchObject({
      verdict: 'deny',
      code: 'scope_not_in_restrictions',
    });
  });

  it('a data.enrichment.* grant still covers every topic (webhook reconcilers unaffected)', () => {
    const scopes = ['data.enrichment.*'];
    for (const topic of ['transcript', 'summary', 'extracted_text']) {
      expect(evaluateScopeRestrictions(scopes, enrichmentScope(topic)).verdict).toBe('admit');
    }
    // The reconciler's WRITE (per-topic upsert) admits under the same wildcard.
    expect(
      evaluateScopeRestrictions(
        scopes,
        deriveDispatchScope({ kind: 'storage', slug: 'enrichment-upsert' }, { topic: 'lifecycle_stage_inferred' })!,
      ).verdict,
    ).toBe('admit');
  });
});

describe('M-ENFORCE-2 scope fence is inert without restrictions', () => {
  it('an empty restriction list admits every derived path', () => {
    for (const path of ['connection.notification', 'data.mail', 'data.memory']) {
      expect(evaluateScopeRestrictions([], path)).toEqual({ verdict: 'admit' });
    }
  });
});

describe('M-ENFORCE-2 matchScopePattern bare-prefix equality', () => {
  it('matches the bare sub-kind prefix against the trailing-glob pattern', () => {
    // The derivation omits the trailing `.<name>` segment; the fence still
    // matches `connection.api` against `connection.api.*` exactly.
    expect(matchScopePattern('connection.api.*', 'connection.api')).toBe(true);
    expect(matchScopePattern('connection.api.*', 'connection.notification')).toBe(false);
    expect(matchScopePattern('data.enrichment.*', 'data.enrichment')).toBe(true);
    expect(matchScopePattern('data.enrichment.*', 'data.enrichmentx')).toBe(false);
  });
});
