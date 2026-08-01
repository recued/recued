/** D-223 Slice 1 — hints reach form state, and nothing else.
 *
 *  The decision's claim is that a hinted value always lands somewhere the owner
 *  can see and change. Two conditions carry that and neither is free: the field
 *  must be visible and editable, and the value must still be admissible. */

import { describe, expect, it } from 'vitest';

import {
  applyConnectionHints,
  connectionHintSetupSlug,
  connectionHintValues,
  type ConnectionHintSource,
} from '../connections/apply-hints.js';
import type { ConnectionSchema } from '../connection-schemas/types.js';

const schema = (over: Partial<ConnectionSchema> = {}): ConnectionSchema => ({
  kind: 'api',
  label: 'API',
  description: 'Generic',
  fields: [
    { key: 'config.base_url', label: 'Base URL', type: 'url' },
    { key: 'auth.scope', label: 'Scope', type: 'text' },
    { key: 'config.locked', label: 'Locked', type: 'text', hidden: true },
    { key: 'config.frozen', label: 'Frozen', type: 'text', readonly: true },
  ],
  ...over,
} as ConnectionSchema);

const source = (values: Record<string, string>, publisher = 'acme-co') => ([{
  publisher,
  hints: [{ connection: 'acme', values }],
}]);

describe('D-223 — applying connection hints', () => {
  it('places a value on a visible, editable field (the permitting case)', () => {
    // ⭐ Everything else here proves a drop. This is the input that must WORK, and
    // it is what separates the rule from a blanket refusal to seed anything.
    const applied = applyConnectionHints(
      schema(), source({ 'config.base_url': 'https://api.acme.example' }), 'acme',
    );
    expect(applied).toEqual([
      { key: 'config.base_url', value: 'https://api.acme.example', publisher: 'acme-co' },
    ]);
    expect(connectionHintValues(applied)).toEqual({
      'config.base_url': 'https://api.acme.example',
    });
  });

  it('DROPS a hint aimed at a hidden or readonly field', () => {
    // The boundary. A registered vendor schema fixes values the owner never sees
    // — Microsoft's Graph base is the live example — and a hint landing there
    // would set something invisible. Not an error: the pack may be generic and
    // the vendor schema specific, so the value is simply not placed.
    //
    // ⚠ The witness has to be a key that IS admissible and IS hidden. A first
    // version used `config.locked` / `config.frozen`, which are not in the
    // admitted key set at all — so the admission filter dropped them and the test
    // passed while proving nothing about visibility. Removing the hidden check
    // left it green. `config.base_url` is the honest witness precisely because a
    // real vendor schema (Microsoft's fixed Graph base) hides it.
    const hidesBase = schema({
      fields: [
        { key: 'config.base_url', label: 'Base URL', type: 'url', hidden: true },
        { key: 'auth.scope', label: 'Scope', type: 'text' },
      ],
    } as Partial<ConnectionSchema>);
    const locksBase = schema({
      fields: [
        { key: 'config.base_url', label: 'Base URL', type: 'url', readonly: true },
        { key: 'auth.scope', label: 'Scope', type: 'text' },
      ],
    } as Partial<ConnectionSchema>);
    const value = { 'config.base_url': 'https://api.acme.example' };

    // The same hint that WORKS against the generic schema is dropped here — which
    // is what isolates visibility as the reason.
    expect(applyConnectionHints(schema(), source(value), 'acme')).toHaveLength(1);
    expect(applyConnectionHints(hidesBase, source(value), 'acme')).toEqual([]);
    expect(applyConnectionHints(locksBase, source(value), 'acme')).toEqual([]);
  });

  it('drops a hint for a field the schema does not have at all', () => {
    expect(applyConnectionHints(schema(), source({ 'auth.token_endpoint': 'https://a.example/t' }), 'acme'))
      .toEqual([]);
  });

  it('re-checks admission rather than trusting publish time', () => {
    // An installed pack can predate a tightening of the filter, so the gate runs
    // again here. Private host and non-https are the cases that matter.
    expect(applyConnectionHints(schema(), source({ 'config.base_url': 'https://127.0.0.1' }), 'acme'))
      .toEqual([]);
    expect(applyConnectionHints(schema(), source({ 'config.base_url': 'http://api.acme.example' }), 'acme'))
      .toEqual([]);
  });

  it('only applies hints for the connection being enrolled', () => {
    const sources: ConnectionHintSource[] = [{
      publisher: 'acme-co',
      hints: [
        { connection: 'other', values: { 'config.base_url': 'https://other.example' } },
        { connection: 'acme', values: { 'auth.scope': 'tasks.read' } },
      ],
    }];
    expect(applyConnectionHints(schema(), sources, 'acme'))
      .toEqual([{ key: 'auth.scope', value: 'tasks.read', publisher: 'acme-co' }]);
  });

  it('first admitted value wins, so install order cannot decide', () => {
    // Two packs hinting one field is a conflict with no principled winner.
    // Letting the last one through would make the result depend on install order.
    const sources = [
      { publisher: 'first-co', hints: [{ connection: 'acme', values: { 'auth.scope': 'a' } }] },
      { publisher: 'second-co', hints: [{ connection: 'acme', values: { 'auth.scope': 'b' } }] },
    ];
    expect(applyConnectionHints(schema(), sources, 'acme'))
      .toEqual([{ key: 'auth.scope', value: 'a', publisher: 'first-co' }]);
  });

  it('carries the publisher so the value can be attributed', () => {
    const applied = applyConnectionHints(schema(), source({ 'auth.scope': 'x' }, 'third-party'), 'acme');
    expect(applied[0]?.publisher).toBe('third-party');
  });

  it('is inert without a schema or a connection', () => {
    expect(applyConnectionHints(undefined, source({ 'auth.scope': 'x' }), 'acme')).toEqual([]);
    expect(applyConnectionHints(schema(), source({ 'auth.scope': 'x' }), '')).toEqual([]);
  });
});

describe('D-223 — which connection a hint-only pack DISCLOSES', () => {
  const hints = [{ connection: 'acme', values: { 'config.base_url': 'https://api.acme.example' } }];

  it('names the connection for a pack that hints but declares no descriptor', () => {
    // The install dialog's Connect section renders only for a
    // `connection_requirements` descriptor, so a hint-only pack would otherwise
    // say nothing at all about the connection it wants. This drives a one-line
    // disclosure there.
    //
    // ⚠ THIS IS NOT WHAT MAKES THE HINT PATH REACHABLE, though an earlier
    // revision of this test said so and shipped a set-up link on that premise.
    // Live-server run 2026-07-30 falsified it twice over: the enroll form
    // reached from the install dialog came up BLANK (hints come from INSTALLED
    // packs, and mid-install the pack is not one), while the pack DETAIL's
    // pre-existing "Set up →" row reached the same form fully pre-filled and
    // attributed. Reachability was already there; only the disclosure was
    // missing. See `packs-install-dialog.ts`.
    expect(connectionHintSetupSlug(hints, false)).toBe('acme');
  });

  it('stays out of the way when a descriptor is present', () => {
    // That pack already has the Connect section, and a hint must never add
    // adoption to it — the picker offers reuse of an EXISTING credential, which
    // is the one capability a hint deliberately does not carry.
    expect(connectionHintSetupSlug(hints, true)).toBeUndefined();
  });

  it('discloses nothing when there is nothing to pre-fill', () => {
    // A disclosure with no values behind it just names a connection the pack
    // never suggested anything for.
    expect(connectionHintSetupSlug(undefined, false)).toBeUndefined();
    expect(connectionHintSetupSlug([], false)).toBeUndefined();
    expect(connectionHintSetupSlug([{ connection: '', values: {} }], false)).toBeUndefined();
  });
});
