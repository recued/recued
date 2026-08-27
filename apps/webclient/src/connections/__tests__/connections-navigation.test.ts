import { describe, expect, it } from 'vitest';

import {
  connectionsAccountAddress,
  connectionsAddressSelection,
  connectionsEnrollAddress,
  connectionsLaneAddress,
  parseConnectionsAddress,
} from '../connections-navigation.js';
import { parseShellRoute } from '../../shell/route.js';

describe('Connections hierarchical navigation contract', () => {
  it('models lane -> account depth', () => {
    expect(connectionsLaneAddress('mail').hash).toBe('#connections/mail');
    expect(connectionsAccountAddress('mail', 'work/mail').hash)
      .toBe('#connections/mail/work%2Fmail');
    expect(connectionsAccountAddress('mail', 'work/mail').levels.map((level) => level.key))
      .toEqual(['connections-lane:mail', 'connections-account:work/mail']);
  });

  it('models the routed enrollment workspace without treating it as an account', () => {
    expect(connectionsEnrollAddress('google/calendar').hash)
      .toBe('#connections/others/enroll/google%2Fcalendar');
    expect(parseConnectionsAddress(parseShellRoute(
      '#connections/others/enroll/google%2Fcalendar',
    ))).toEqual({
      kind: 'enroll',
      vendor: 'google/calendar',
    });
  });

  it('parses account detail and degrades unknown tails to their lane', () => {
    expect(parseConnectionsAddress(parseShellRoute('#connections/file/archive')))
      .toEqual({ kind: 'account', lane: 'file', slug: 'archive' });
    expect(parseConnectionsAddress(parseShellRoute(
      '#connections/others/retry-credential-rotation/api/main',
    ))).toEqual({ kind: 'lane', tab: 'others' });
    expect(parseConnectionsAddress(parseShellRoute('#connections/unknown')))
      .toEqual({ kind: 'lane', tab: 'mail' });
  });

  it('projects one typed selection for route bootstrap', () => {
    expect(connectionsAddressSelection({
      kind: 'account',
      lane: 'calendar',
      slug: 'team',
    })).toEqual({
      tab: 'calendar',
      detailSlug: 'team',
      enrollVendor: null,
    });
  });
});
