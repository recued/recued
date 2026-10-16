import { describe, expect, it } from 'vitest';
import type { PackReconnectGroup } from '@recued/contracts';
import { createReconnectWorklistContinuity, validateWorklistRepair } from '../settings/reconnect-worklist-continuity.js';
const group = (): PackReconnectGroup => ({ id: 'b'.repeat(64), fingerprint: 'c'.repeat(64), name: 'saved-mail', display_name: 'Saved mail',
  authentication: 'direct_oauth', required_scopes: ['Mail.Read'], reviewed: false, can_reconnect: true, can_mark_reviewed: true,
  items: [{ id: 'd'.repeat(64), pack_slug: 'mail', pack_name: 'Mail', version: 1, slot: 'graph', required_scopes: ['Mail.Read'],
    missing_scopes: [], coverage: 'unknown', reviewed: false }] });
describe('reconnect-later handoff', () => {
  it('carries installed scopes, expires, and returns verified reads without marking permissions reviewed', () => {
    let now = 100; const c = createReconnectWorklistContinuity({ now: () => now, id: () => 'ppr-' + 'a'.repeat(32) });
    const g = group(); const repair = c.begin(g, 'connections'); g.required_scopes.push('Mail.Send');
    expect(c.read(repair.id, repair.name)!.required_scopes).toEqual(['Mail.Read']);
    expect(validateWorklistRepair(repair, { groups: [group()], unresolved_packs: [] }, now)).toEqual(['Mail.Read']);
    c.finish(repair.id, true); expect(c.takeReturn('packs')).toBeUndefined();
    expect(c.takeReturn('connections')).toEqual({ name: 'saved-mail', verified: true }); expect(c.takeReturn('connections')).toBeUndefined();
    const next = c.begin(group(), 'packs'); now = next.expires_at; expect(c.read(next.id, next.name)).toBeUndefined();
  });
  it('refuses stale scopes and unsupported or unbound accounts', () => {
    const c = createReconnectWorklistContinuity(); const repair = c.begin(group(), 'packs');
    expect(() => validateWorklistRepair(repair, { groups: [{ ...group(), fingerprint: 'e'.repeat(64) }], unresolved_packs: [] })).toThrow('changed');
    expect(() => c.begin({ ...group(), can_reconnect: false }, 'packs')).toThrow('Refresh');
    expect(() => c.begin({ ...group(), name: undefined }, 'packs')).toThrow('Refresh');
  });
});
