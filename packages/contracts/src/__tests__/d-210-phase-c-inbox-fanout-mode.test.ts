/** D-210 Phase C — `inbox_fanout_mode` on the `reception_page` singleton.
 *
 *  The setting picks which DEVICE surface a newly-held reception item
 *  reaches the owner on — `'approval'` (durable ask, actionable card) or
 *  `'notify'` (passive FYI, reviewed in the inbox). It is NOT a gate:
 *  both modes hold at the D-157 gate (inbox model "B").
 *
 *  What these tests pin:
 *    - the closed vocabulary is REFUSED at the rpc edge when violated
 *      (a typo'd write must not look accepted while devices keep the
 *      old behaviour);
 *    - `undefined` resolves to `'approval'`, and so does anything
 *      unrecognized — the fail-safe direction is the actionable card;
 *    - the field is genuinely OPTIONAL: a config that never mentions it
 *      carries no such key (`Object.hasOwn`, not `toMatchObject` —
 *      the latter cannot prove a key's absence). */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_INBOX_FANOUT_MODES,
  resolveReceptionInboxFanoutMode,
  validateReceptionPageConfig,
  type ReceptionPageConfig,
} from '../index.js';

const baseConfig: ReceptionPageConfig = {
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Available for client work',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: ['email'],
  },
  sections_enabled: {
    contact_card: true,
    contact_methods: true,
    availability_cta: false,
    intake_cta: false,
    drop_cta: false,
    custom_links: false,
    link_buttons: false,
  },
  linked_endpoints: {},
};

describe('D-210 Phase C — inbox_fanout_mode validator arm', () => {
  it('accepts every member of the closed vocabulary', () => {
    for (const mode of RECEPTION_INBOX_FANOUT_MODES) {
      const failures = validateReceptionPageConfig({
        ...baseConfig,
        inbox_fanout_mode: mode,
      });
      expect(failures).toEqual([]);
    }
  });

  it('accepts a config that omits the field entirely', () => {
    expect(validateReceptionPageConfig(baseConfig)).toEqual([]);
    // The field is optional in the SHAPE, not merely defaulted: a config
    // authored before Phase C carries no such key at all.
    expect(Object.hasOwn(baseConfig, 'inbox_fanout_mode')).toBe(false);
  });

  it('REFUSES an unrecognized value rather than silently defaulting it', () => {
    const failures = validateReceptionPageConfig({
      ...baseConfig,
      // A plausible typo — the kind of value a hand-written rpc call sends.
      inbox_fanout_mode: 'notification' as unknown as 'notify',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('inbox_fanout_mode_invalid');
    expect(failures[0]?.detail).toContain('notify | approval');
  });

  it('REFUSES a non-string value', () => {
    const failures = validateReceptionPageConfig({
      ...baseConfig,
      inbox_fanout_mode: true as unknown as 'notify',
    });
    expect(failures.map((f) => f.code)).toEqual(['inbox_fanout_mode_invalid']);
  });

  it('does not refuse an explicit `approval` (the default, written out)', () => {
    const failures = validateReceptionPageConfig({
      ...baseConfig,
      inbox_fanout_mode: 'approval',
    });
    expect(failures).toEqual([]);
  });
});

describe('D-210 Phase C — resolveReceptionInboxFanoutMode', () => {
  it('collapses absent to the actionable default', () => {
    expect(resolveReceptionInboxFanoutMode(undefined)).toBe('approval');
  });

  it('passes through both real modes', () => {
    expect(resolveReceptionInboxFanoutMode('notify')).toBe('notify');
    expect(resolveReceptionInboxFanoutMode('approval')).toBe('approval');
  });

  it('fails SAFE — an unrecognized stored value reads as approval, never notify', () => {
    // Direction matters: a hold that raises an actionable card the owner
    // did not ask for is noisy but recoverable; a hold that goes silently
    // passive because a stored value drifted is the failure that loses
    // the item. Anything not exactly 'notify' must land on 'approval'.
    for (const rot of ['', 'NOTIFY', 'notify ', 'silent', 'approve', 'null']) {
      expect(resolveReceptionInboxFanoutMode(rot)).toBe('approval');
    }
  });
});
