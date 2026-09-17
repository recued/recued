import { describe, expect, it } from 'vitest';

import {
  parseReceptionAddress,
  receptionAddressSelection,
  receptionEndpointAuthoringAddress,
  receptionEndpointDetailAddress,
  receptionEndpointPairAddress,
  receptionSectionAddress,
} from '../reception/navigation.js';
import { parseShellRoute } from '../shell/route.js';

describe('Reception hierarchical navigation contract', () => {
  it('models section -> endpoint preview depth', () => {
    expect(receptionSectionAddress('endpoints').hash)
      .toBe('#reception/endpoints');
    expect(receptionEndpointDetailAddress('ep/one').hash)
      .toBe('#reception/endpoints/ep%2Fone');
    expect(receptionEndpointDetailAddress('ep/one').levels).toHaveLength(2);
  });

  it('models routed authoring and pair workspaces', () => {
    expect(receptionEndpointAuthoringAddress('new', 'scheduling_link').hash)
      .toBe('#reception/endpoints/new/scheduling_link');
    expect(receptionEndpointPairAddress('ep-1').hash)
      .toBe('#reception/endpoints/pair/ep-1');
  });

  it('parses valid depths and fails malformed authoring to the list', () => {
    expect(parseReceptionAddress(parseShellRoute('#reception/endpoints/ep-1')))
      .toEqual({ kind: 'endpoint-detail', endpointId: 'ep-1' });
    const malformed = parseReceptionAddress(parseShellRoute(
      '#reception/endpoints/edit/scheduling_link',
    ));
    expect(malformed).toEqual({ kind: 'section', section: 'endpoints' });
    expect(receptionAddressSelection(malformed!)).toEqual({
      section: 'endpoints',
      subview: null,
      value: null,
    });
  });
});
