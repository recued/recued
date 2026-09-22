import { describe, it, expect } from 'vitest';
import {
  INSTANCE_PREFS,
  DEFAULT_INSTANCE_PREFS,
  applyPrefsPatch,
  getPref,
  sanitizePrefsPatch,
} from '../prefs.js';
// D-168: SYNC_OBJECTS registry retired. ⛔ Its named successor was never
// built: `sync_transport` is absent from `contract-schema.ts` and
// `contract.connection_record` has no runtime path. The TODO that stood
// here — "once D-166's contract-schema substrate lands, add a ratchet
// asserting connection_record's schema entry carries sync_transport:
// 'pair'" — is DELETED, not deferred. `connection_record` was ruled
// won't-do 2026-08-11 (D-166 amendment); that ratchet would have pinned a
// mechanism that is not coming. Connections reach clients by pull
// (`collection.connection.list`) plus `recipe_runnability_changed`.
// `prefs` itself is pair-scoped via the pair rpc/storage path and has
// never depended on either registry.

describe('INSTANCE_PREFS registry', () => {
  /** ⛔⛔ `typeof` IS NOT THE DISCRIMINANT ANY MORE, and this ratchet is what
   *  said so. D-282 slice C added `string_list` — whose `typeof` is `'object'`,
   *  not its spec name — and the whole point of naming the kind rather than
   *  reusing a `typeof` result is that `'object'` would admit every object
   *  shape there is. The registry's invariant is unchanged (a default must be
   *  the kind it declares); only the way to ASK has to follow. */
  it('every registered key has a default that matches its declared type', () => {
    for (const [key, spec] of Object.entries(INSTANCE_PREFS)) {
      if (spec.type === 'string_list') {
        expect(Array.isArray(spec.default), key).toBe(true);
        // Every seeded item must satisfy the spec's own rule — a default that
        // the validator would reject falls back to itself forever.
        for (const item of spec.default) {
          expect(typeof item, key).toBe('string');
          expect(spec.item_pattern.test(item), `${key}: ${item}`).toBe(true);
        }
        expect(spec.default.length, key).toBeLessThanOrEqual(spec.max_items);
      } else {
        expect(typeof spec.default).toBe(spec.type);
      }
      expect(DEFAULT_INSTANCE_PREFS[key as keyof typeof INSTANCE_PREFS])
        .toBe(spec.default);
    }
  });

  it('cache.sync_l2 defaults to true so roaming is opt-in, not opt-out', () => {
    expect(DEFAULT_INSTANCE_PREFS['cache.sync_l2']).toBe(true);
  });
});

describe('applyPrefsPatch', () => {
  it('fills unspecified keys with registered defaults', () => {
    const result = applyPrefsPatch({}, {});
    expect(result).toEqual(DEFAULT_INSTANCE_PREFS);
  });

  it('overrides with patch values when present', () => {
    const result = applyPrefsPatch({}, { 'cache.sync_l2': false });
    expect(result['cache.sync_l2']).toBe(false);
  });

  it('drops unknown keys (forward-compat for older consumers)', () => {
    const result = applyPrefsPatch({}, { 'future.not_yet_shipped': true } as Record<string, unknown>);
    expect(result).toEqual(DEFAULT_INSTANCE_PREFS);
    expect('future.not_yet_shipped' in result).toBe(false);
  });

  it('drops wrong-typed values rather than crashing', () => {
    const result = applyPrefsPatch(
      {},
      { 'cache.sync_l2': 'definitely not a boolean' } as Record<string, unknown>,
    );
    expect(result['cache.sync_l2']).toBe(DEFAULT_INSTANCE_PREFS['cache.sync_l2']);
  });

  it('preserves current values for keys not in the patch', () => {
    const result = applyPrefsPatch({ 'cache.sync_l2': false }, {});
    expect(result['cache.sync_l2']).toBe(false);
  });

  it('later patch beats earlier current for the same key', () => {
    const result = applyPrefsPatch({ 'cache.sync_l2': true }, { 'cache.sync_l2': false });
    expect(result['cache.sync_l2']).toBe(false);
  });

  it('ignores inherited preference values in patch objects', () => {
    const patch = Object.create({ 'cache.sync_l2': false }) as Record<string, unknown>;
    const result = applyPrefsPatch({}, patch);
    expect(result['cache.sync_l2']).toBe(DEFAULT_INSTANCE_PREFS['cache.sync_l2']);
  });
});

describe('getPref', () => {
  it('returns the stored value when present', () => {
    expect(getPref({ 'cache.sync_l2': false }, 'cache.sync_l2')).toBe(false);
  });

  it('returns the default when missing', () => {
    expect(getPref({}, 'cache.sync_l2'))
      .toBe(INSTANCE_PREFS['cache.sync_l2'].default);
  });

  it('returns the default when prefs is undefined', () => {
    expect(getPref(undefined, 'cache.sync_l2'))
      .toBe(INSTANCE_PREFS['cache.sync_l2'].default);
  });

  it('returns the default when stored value has the wrong type', () => {
    expect(getPref({ 'cache.sync_l2': 'nope' as unknown as boolean }, 'cache.sync_l2'))
      .toBe(INSTANCE_PREFS['cache.sync_l2'].default);
  });

  it('returns the default for inherited preference values', () => {
    const prefs = Object.create({ 'cache.sync_l2': false }) as Partial<typeof DEFAULT_INSTANCE_PREFS>;
    expect(getPref(prefs, 'cache.sync_l2')).toBe(INSTANCE_PREFS['cache.sync_l2'].default);
  });
});

describe('sanitizePrefsPatch', () => {
  it('ignores inherited preference values', () => {
    const patch = Object.create({ 'cache.sync_l2': false }) as Record<string, unknown>;
    expect(sanitizePrefsPatch(patch)).toEqual({});
  });
});

import {
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  transparencyStreamSettingsFromPrefs,
} from '../transparency-stream/settings.js';

describe('transparency stream preference validation', () => {
  it('accepts allowed string pref values and rejects out-of-enum strings', () => {
    const accepted = applyPrefsPatch(
      {},
      { 'ui.transparency.max_redaction_tier': 'none' },
    );
    expect(accepted['ui.transparency.max_redaction_tier']).toBe('none');

    const rejected = applyPrefsPatch(
      {},
      { 'ui.transparency.max_redaction_tier': 'bogus' },
    );
    expect(rejected['ui.transparency.max_redaction_tier']).toBe(
      DEFAULT_INSTANCE_PREFS['ui.transparency.max_redaction_tier'],
    );
  });

  it('drops out-of-enum string values already present in current storage', () => {
    const current = {
      'ui.transparency.max_redaction_tier': 'bogus',
    } as unknown as Partial<typeof DEFAULT_INSTANCE_PREFS>;
    const result = applyPrefsPatch(current, {});

    expect(result['ui.transparency.max_redaction_tier']).toBe(
      DEFAULT_INSTANCE_PREFS['ui.transparency.max_redaction_tier'],
    );
  });

  it('gates string pref reads and sanitized patches through the allowed list', () => {
    const invalid = {
      'ui.transparency.max_redaction_tier': 'bogus',
    } as unknown as Partial<typeof DEFAULT_INSTANCE_PREFS>;
    const valid = {
      'ui.transparency.max_redaction_tier': 'none',
    } as Partial<typeof DEFAULT_INSTANCE_PREFS>;

    expect(getPref(invalid, 'ui.transparency.max_redaction_tier')).toBe(
      DEFAULT_INSTANCE_PREFS['ui.transparency.max_redaction_tier'],
    );
    expect(getPref(valid, 'ui.transparency.max_redaction_tier')).toBe('none');
    expect(
      sanitizePrefsPatch({ 'ui.transparency.max_redaction_tier': 'bogus' }),
    ).toEqual({});
    expect(
      sanitizePrefsPatch({ 'ui.transparency.max_redaction_tier': 'none' }),
    ).toEqual({ 'ui.transparency.max_redaction_tier': 'none' });
  });
});

describe('transparency stream settings from prefs', () => {
  it('mirrors the registered defaults when prefs are absent', () => {
    const settings = transparencyStreamSettingsFromPrefs(undefined);
    const defaults = DEFAULT_TRANSPARENCY_STREAM_SETTINGS;

    expect(settings.enabled).toBe(defaults.enabled);
    expect(settings.visible_classes.ai_emitted).toBe(
      defaults.visible_classes.ai_emitted,
    );
    expect(settings.visible_classes.engine_brokering).toBe(
      defaults.visible_classes.engine_brokering,
    );
    expect(settings.visible_classes.failure).toBe(
      defaults.visible_classes.failure,
    );
    expect(settings.visible_classes.orchestration).toBe(
      defaults.visible_classes.orchestration,
    );
    expect(settings.max_redaction_tier).toBe(defaults.max_redaction_tier);
    expect(Array.from(settings.hidden_network_domains)).toEqual(
      Array.from(defaults.hidden_network_domains),
    );
  });

  it('honors transparency prefs while keeping failures visible', () => {
    const settings = transparencyStreamSettingsFromPrefs({
      'ui.transparency.enabled': false,
      'ui.transparency.class.orchestration': true,
      'ui.transparency.max_redaction_tier': 'none',
    });

    expect(settings.enabled).toBe(false);
    expect(settings.visible_classes.ai_emitted).toBe(true);
    expect(settings.visible_classes.engine_brokering).toBe(true);
    expect(settings.visible_classes.orchestration).toBe(true);
    expect(settings.visible_classes.failure).toBe(true);
    expect(settings.max_redaction_tier).toBe('none');
  });
});
