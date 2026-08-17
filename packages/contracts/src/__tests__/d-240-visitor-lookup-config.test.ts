/** D-240 slice 1 — the `visitor_lookup` config, its per-kind mode gate, and the
 *  cross-field rule that stops a link being minted for nobody.
 *
 *  ⚠ TWO LAYERS, DELIBERATELY. The standalone validator proves each RULE; the
 *  block at the bottom drives `validateIntakeFormConfig` to prove the rules are
 *  WIRED. A rule that holds in isolation and is never called is the shape this
 *  repo keeps paying for — a validator with no caller refuses nothing. */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_RECORD_KINDS,
  VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
  VISITOR_LOOKUP_ANCHOR_FIELD_TYPES,
  VISITOR_LOOKUP_COMPLETABLE_TARGET_KINDS,
  VISITOR_LOOKUP_DEFAULT_GRACE_MS,
  VISITOR_LOOKUP_DEFAULT_TTL_MS,
  VISITOR_LOOKUP_MAX_TTL_MS,
  VISITOR_LOOKUP_MIN_TTL_MS,
  VISITOR_LOOKUP_MODES,
  VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND,
  VISITOR_LOOKUP_SUPPORTED_MODES,
  VISITOR_LOOKUP_SUPPORTED_MODE_SET,
  resolveVisitorLookupExpiry,
  validateIntakeFormConfig,
  validateVisitorLookupConfig,
  type IntakeFormConfig,
  type ReceptionRecordKind,
  type VisitorLookupConfig,
  type VisitorLookupValidationContext,
} from '../index.js';

const fields = (...pairs: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, string> =>
  new Map(pairs.map(([n, t]) => [n, t]));

const ctx = (
  over: Partial<VisitorLookupValidationContext> = {},
): VisitorLookupValidationContext => ({
  record_kind: 'intake_form',
  receipt_enabled: true,
  field_types: fields(['event_date', 'date'], ['notes', 'textarea']),
  ...over,
});

const codes = (
  config: unknown,
  over: Partial<VisitorLookupValidationContext> = {},
): ReadonlyArray<string> =>
  validateVisitorLookupConfig(config, ctx(over)).map((f) => f.code);

const fixedConfig: VisitorLookupConfig = {
  enabled: true,
  expiry: { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
};

describe('D-240 § D6 — the per-record-kind mode gate', () => {
  it('permits the three intake modes on an intake form', () => {
    // ⚠ THE PERMITTING CASE FIRST. A refusal alone cannot tell a targeted gate
    // from a validator that rejects everything.
    //
    // ⚠ The assertion is that THIS GATE does not fire — not that the config is
    // wholly valid. Two of the three are permitted-for-kind and not yet MINTABLE
    // (slice 2's `visitor_lookup_mode_unsupported`), which is a different rule
    // tested below. Conflating them would make this test fail for a reason it is
    // not about, every time a slice lands.
    for (const expiry of [
      fixedConfig.expiry,
      { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      { mode: 'after_field', field: 'event_date', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
    ]) {
      expect(codes({ enabled: true, expiry }))
        .not.toContain('visitor_lookup_mode_not_permitted_for_kind');
    }
    // And the one that IS fully supported today validates clean end to end.
    expect(codes(fixedConfig)).toEqual([]);
  });

  it('permits `after_event` on a booking', () => {
    expect(codes(
      { enabled: true, expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
      { record_kind: 'scheduling_link' },
    )).toEqual([]);
  });

  it('⛔ refuses `after_event` on an intake — it has no event to anchor on', () => {
    expect(codes({
      enabled: true, expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
    })).toEqual(['visitor_lookup_mode_not_permitted_for_kind']);
  });

  it('⛔ refuses all three intake modes on a booking — the slot IS its lifecycle', () => {
    for (const expiry of [
      { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
      { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      { mode: 'after_field', field: 'event_date', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
    ]) {
      expect(codes({ enabled: true, expiry }, { record_kind: 'scheduling_link' }))
        .toEqual(['visitor_lookup_mode_not_permitted_for_kind']);
    }
  });

  it('⛔⛔ the permitted table covers every record kind — DERIVED, not hand-listed', () => {
    // The table is keyed on the closed union so a third record kind is a type
    // error. This asserts the RUNTIME half of that: a kind present in the
    // vocabulary but absent from the table would throw on lookup, and the type
    // error only fires if someone recompiles contracts.
    for (const kind of RECEPTION_RECORD_KINDS) {
      const permitted = VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND[kind];
      expect(permitted, `no permitted modes declared for '${kind}'`).toBeDefined();
      expect(permitted.length).toBeGreaterThan(0);
      for (const mode of permitted) expect(VISITOR_LOOKUP_MODES).toContain(mode);
    }
  });

  it('⛔ every mode is reachable from some kind — a mode nothing admits is dead config', () => {
    const reachable = new Set(
      (Object.keys(VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND) as ReceptionRecordKind[])
        .flatMap((k) => [...VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND[k]]),
    );
    expect([...VISITOR_LOOKUP_MODES].filter((m) => !reachable.has(m))).toEqual([]);
  });

  it('refuses an unknown mode rather than coercing it', () => {
    expect(codes({ enabled: true, expiry: { mode: 'whenever', ttl_ms: 1 } }))
      .toEqual(['visitor_lookup_mode_unknown']);
  });
});

describe('D-240 § D4 — a lookup without a receipt reaches nobody', () => {
  it('⛔ refuses an ENABLED lookup when no receipt is enabled', () => {
    expect(codes(fixedConfig, { receipt_enabled: false }))
      .toEqual(['visitor_lookup_requires_receipt']);
  });

  it('⚠ but NOT when the lookup is disabled — a disabled lookup mints nothing', () => {
    expect(codes({ ...fixedConfig, enabled: false }, { receipt_enabled: false })).toEqual([]);
  });
});

describe('D-240 § D9 — the `after_field` anchor is visitor-supplied, so it is fenced', () => {
  // ⚠ These used to carry `visitor_lookup_mode_unsupported` too, because
  // `after_field` was permitted-for-kind but not yet mintable. Slice 5 built it,
  // so a well-formed config is now clean and the refusals below are the anchor
  // rule ALONE. `toContain` is kept where a case could carry more than one
  // failure.
  it('accepts both date-ish field types and nothing else', () => {
    expect(VISITOR_LOOKUP_ANCHOR_FIELD_TYPES).toEqual(['date', 'datetime']);
    for (const type of VISITOR_LOOKUP_ANCHOR_FIELD_TYPES) {
      expect(codes(
        { enabled: true, expiry: { mode: 'after_field', field: 'when', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS } },
        { field_types: fields(['when', type]) },
      )).toEqual([]);
    }
  });

  it('⛔ refuses an anchor on a field the form does not collect', () => {
    expect(codes({
      enabled: true,
      expiry: { mode: 'after_field', field: 'nope', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
    })).toContain('visitor_lookup_field_missing');
  });

  it('⛔⛔ refuses an anchor on a TEXT field — an unvalidated string the submitter controls', () => {
    expect(codes({
      enabled: true,
      expiry: { mode: 'after_field', field: 'notes', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
    })).toContain('visitor_lookup_field_not_a_date');
  });

  it('refuses a missing / blank field name', () => {
    expect(codes({ enabled: true, expiry: { mode: 'after_field', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS } }))
      .toContain('visitor_lookup_field_missing');
    expect(codes({ enabled: true, expiry: { mode: 'after_field', field: '  ', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS } }))
      .toContain('visitor_lookup_field_missing');
  });
});

describe('D-240 slice 2 — a mode no submit path mints is refused at write time', () => {
  it('⚠ EVERY mode is supported now — the unsupported branch has no live case', () => {
    // This test twice named a mode that was "not built yet" (`until_resolved`
    // until slice 4, `after_field` until slice 5). Slice 5 completed the list, so
    // there is no such mode left to name and the old assertion has no premise.
    //
    // ⇒ Re-aimed at what SURVIVES: the list is complete, which is why the
    // refusal is unreachable — rather than deleted, because a mode added later
    // must land in that list or start refusing, and this is what says so.
    expect([...VISITOR_LOOKUP_SUPPORTED_MODES].sort()).toEqual([...VISITOR_LOOKUP_MODES].sort());
    for (const mode of VISITOR_LOOKUP_MODES) {
      expect(VISITOR_LOOKUP_SUPPORTED_MODE_SET.has(mode), `'${mode}' is not mintable`).toBe(true);
    }
  });

  it('⛔ an UNKNOWN mode is still refused, and with its own code', () => {
    // `_unknown` and `_unsupported` stay distinct facts even with nothing
    // currently unsupported: a typo and a not-yet-built mode are different
    // repairs, and a caller switching on the code must tell them apart.
    expect(codes({ enabled: true, expiry: { mode: 'nonsense', grace_ms: 1 } }))
      .toEqual(['visitor_lookup_mode_unknown']);
  });

  it('⚠ permits every SUPPORTED mode on the kind that admits it', () => {
    // The permitting half — without it the refusal above could be a validator
    // that rejects every mode.
    expect(codes(fixedConfig)).toEqual([]);
    expect(codes(
      { enabled: true, expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
      { record_kind: 'scheduling_link' },
    )).toEqual([]);
  });

  it('⛔ the supported list is a SUBSET of the mode vocabulary, never a stray literal', () => {
    for (const mode of VISITOR_LOOKUP_SUPPORTED_MODES) {
      expect(VISITOR_LOOKUP_MODES).toContain(mode);
    }
  });
});

describe('D-240 slice 2 — resolveVisitorLookupExpiry', () => {
  const NOW = 1_700_000_000_000;

  it('`fixed` counts from the mint, and always sets a ceiling', () => {
    const r = resolveVisitorLookupExpiry({
      expiry: { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS }, now: NOW,
    });
    expect(r).toEqual({
      kind: 'resolved',
      expires_at: NOW + VISITOR_LOOKUP_DEFAULT_TTL_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
    });
  });

  it('`after_event` anchors on the slot end plus grace', () => {
    const slot_end_at = NOW + 7 * 24 * 60 * 60 * 1000;
    const r = resolveVisitorLookupExpiry({
      expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      now: NOW,
      slot_end_at,
    });
    expect(r).toEqual({
      kind: 'resolved',
      expires_at: slot_end_at + VISITOR_LOOKUP_DEFAULT_GRACE_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
    });
  });

  it('⛔⛔ clamps the SUM — a far-future booking cannot outlive the ceiling', () => {
    // The validator bounds what an AUTHOR types; this bounds what the arithmetic
    // PRODUCES. A booking three years out plus a legitimate 30-day grace is a
    // three-year credential unless the sum is clamped, and no config says so.
    const r = resolveVisitorLookupExpiry({
      expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      now: NOW,
      slot_end_at: NOW + 3 * 365 * 24 * 60 * 60 * 1000,
    });
    expect(r).toEqual({
      kind: 'resolved',
      expires_at: NOW + VISITOR_LOOKUP_MAX_TTL_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
    });
  });

  it('⚠ a booking already PAST still gets its grace from now, not a dead link', () => {
    // The receipt is handed over at submit, so an expiry behind the mint is a
    // link that never worked once.
    const r = resolveVisitorLookupExpiry({
      expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      now: NOW,
      slot_end_at: NOW - 10 * 24 * 60 * 60 * 1000,
    });
    expect(r).toEqual({
      kind: 'resolved',
      expires_at: NOW + VISITOR_LOOKUP_DEFAULT_GRACE_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
    });
  });

  it('⛔ `after_event` with no slot is REFUSED, never silently re-anchored', () => {
    expect(resolveVisitorLookupExpiry({
      expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS }, now: NOW,
    })).toEqual({ kind: 'anchor_missing', mode: 'after_event' });
  });

  it('⚠ NO mode resolves to `unsupported` any more — every arm computes', () => {
    // The converse of the completeness assertion above, at the resolver. A mode
    // added to the vocabulary without an arm here would surface as `unsupported`
    // at MINT time — a link that silently never issues — so this is the guard
    // that turns that into a red.
    for (const expiry of [
      { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
      { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      { mode: 'after_field', field: 'when', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
      { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
    ] as const) {
      const out = resolveVisitorLookupExpiry({
        expiry, now: NOW, slot_end_at: NOW, field_value: '2026-06-15',
      });
      expect(out.kind, `'${expiry.mode}' resolved to ${out.kind}`).not.toBe('unsupported');
    }
  });

  it('⛔ `until_resolved` resolves DEFERRED — no anchor exists at mint', () => {
    // Slice 4. Its own arm rather than a null `expires_at`, so the deferred case
    // is a branch the compiler asks every consumer about.
    expect(resolveVisitorLookupExpiry({
      expiry: { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS }, now: NOW,
    })).toEqual({
      kind: 'deferred',
      grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
    });
  });
});

describe('D-240 — duration bounds', () => {
  it('accepts the two documented defaults', () => {
    expect(codes(fixedConfig)).toEqual([]);
    // The grace default is exercised on the mode that HAS a submit path today;
    // `until_resolved` carries the same default and only the unsupported code.
    expect(codes(
      { enabled: true, expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
      { record_kind: 'scheduling_link' },
    )).toEqual([]);
  });

  it('refuses below the floor, above the ceiling, and non-integers', () => {
    for (const ttl_ms of [
      VISITOR_LOOKUP_MIN_TTL_MS - 1,
      VISITOR_LOOKUP_MAX_TTL_MS + 1,
      1.5,
      Number.NaN,
      '30d' as unknown as number,
    ]) {
      expect(codes({ enabled: true, expiry: { mode: 'fixed', ttl_ms } }))
        .toContain('visitor_lookup_ttl_out_of_range');
    }
  });

  it('accepts the exact boundaries — the bound is inclusive, not off by one', () => {
    expect(codes({ enabled: true, expiry: { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_MIN_TTL_MS } })).toEqual([]);
    expect(codes({ enabled: true, expiry: { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_MAX_TTL_MS } })).toEqual([]);
  });

  it('⛔⛔ § D10 — the absolute ceiling EXCEEDS the authored maximum', () => {
    // Otherwise the backstop would truncate a legitimately-authored maximum
    // window, and a config the validator accepted would die early in the field.
    expect(VISITOR_LOOKUP_ABSOLUTE_CEILING_MS).toBeGreaterThan(VISITOR_LOOKUP_MAX_TTL_MS);
  });
});

describe('D-240 — shape', () => {
  it('refuses a non-object config and a non-object expiry', () => {
    expect(codes(null)).toEqual(['visitor_lookup_not_object']);
    expect(codes([])).toEqual(['visitor_lookup_not_object']);
    expect(codes({ enabled: true })).toEqual(['visitor_lookup_not_object']);
  });

  it('refuses a non-boolean `enabled`', () => {
    expect(codes({ enabled: 'yes', expiry: fixedConfig.expiry }))
      .toContain('visitor_lookup_enabled_invalid');
  });
});

// ════════════════════════════════════════════════════════════════
// WIRED — the same rules through the real parent validator
// ════════════════════════════════════════════════════════════════

const goodForm: IntakeFormConfig = {
  display_name: 'Purchase request',
  instructions: 'Tell us what you need.',
  success_message: 'Thanks — we will be in touch.',
  submit_button_label: 'Submit request',
  form_definition: {
    form_definition_id: 'fd_purchase_request_v1',
    fields: [
      { name: 'item', type: 'text', label: 'What do you need?', required: true },
      { name: 'needed_by', type: 'date', label: 'Needed by', required: true },
    ],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['item', 'needed_by'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
};

const formCodes = (over: Partial<IntakeFormConfig>): ReadonlyArray<string> =>
  validateIntakeFormConfig({ ...goodForm, ...over }).map((f) => f.code);

describe('D-240 — wired into validateIntakeFormConfig', () => {
  it('the baseline form is valid, and stays valid with a well-formed lookup', () => {
    // ⚠ The permitting case for everything below: without it a refusal could be
    // coming from the baseline rather than from the viewback config.
    expect(formCodes({})).toEqual([]);
    expect(formCodes({
      visitor_receipt: { enabled: true },
      visitor_lookup: fixedConfig,
    })).toEqual([]);
  });

  it('⛔ the receipt rule FIRES through the parent — not just in isolation', () => {
    expect(formCodes({ visitor_lookup: fixedConfig })).toEqual(['visitor_lookup_invalid']);
  });

  it('a disabled receipt is not an enabled one', () => {
    expect(formCodes({
      visitor_receipt: { enabled: false },
      visitor_lookup: fixedConfig,
    })).toEqual(['visitor_lookup_invalid']);
  });

  it('the parent surfaces WHICH rule failed in the detail, not just that one did', () => {
    const [failure] = validateIntakeFormConfig({ ...goodForm, visitor_lookup: fixedConfig });
    expect(failure?.detail).toContain('visitor_lookup_requires_receipt');
  });

  it('⛔ the form-field anchor is resolved from THIS form definition', () => {
    // The context the parent builds is the real join under test: the anchor must
    // be checked against the fields THIS form declares.
    //
    // ⚠ The assertion is on WHICH rule trips, read out of the detail the parent
    // forwards — a bare `visitor_lookup_invalid` would pass whether or not the
    // field lookup happened at all. Since slice 5 the valid anchor is fully
    // clean, which is the stronger form of the same check.
    const detailFor = (field: string): string => {
      const [failure] = validateIntakeFormConfig({
        ...goodForm,
        visitor_receipt: { enabled: true },
        visitor_lookup: {
          enabled: true,
          expiry: { mode: 'after_field', field, ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
        },
      });
      return failure?.detail ?? '';
    };
    // `needed_by` IS a date on this form ⇒ nothing to complain about.
    expect(detailFor('needed_by')).toBe('');
    // `item` is a `text` field on this form ⇒ the anchor rule fires.
    expect(detailFor('item')).toContain('visitor_lookup_field_not_a_date');
  });

  it('an absent visitor_lookup changes nothing — the field is optional', () => {
    expect(formCodes({ visitor_receipt: { enabled: true } })).toEqual([]);
  });
});

describe('D-240 § D7 — `until_resolved` needs a destination that can finish', () => {
  it('⛔⛔ refuses it on a target kind that never completes', () => {
    // `note` / `calendar` / `contact` have no completion concept, so the stamp
    // sweep could never fire and the credential would live to the 180-day
    // ceiling — the owner having configured "a month after it's done".
    for (const target_kind of ['note', 'calendar', 'contact']) {
      expect(codes(
        { enabled: true, expiry: { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
        { target_kind },
      )).toEqual(['visitor_lookup_target_has_no_completion']);
    }
  });

  it('⚠ permits it on every kind that DOES report completion', () => {
    for (const target_kind of VISITOR_LOOKUP_COMPLETABLE_TARGET_KINDS) {
      expect(codes(
        { enabled: true, expiry: { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
        { target_kind },
      ), `'${target_kind}' was refused`).toEqual([]);
    }
  });

  it('⚠ and does NOT constrain the other modes — only this one needs an ending', () => {
    expect(codes(fixedConfig, { target_kind: 'note' })).toEqual([]);
  });

  it('skips the check when the caller does not know its destination', () => {
    expect(codes({
      enabled: true, expiry: { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
    })).toEqual([]);
  });
});
