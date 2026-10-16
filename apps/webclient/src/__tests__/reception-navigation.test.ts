import { describe, expect, it } from 'vitest';

import {
  parseReceptionAddress,
  receptionAddressSelection,
  receptionEndpointAuthoringAddress,
  receptionEndpointDetailAddress,
  receptionEndpointPairAddress,
  receptionSectionAddress,
  receptionCustomerJobAddress,
  receptionInboxTargetAddress,
  receptionSignoffAddress,
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


describe('Customer-work exact navigation',()=>{
  it('round trips job sections and selected reviews without losing encoded identity',()=>{
    const hash=receptionCustomerJobAddress('job/a #1','billing').hash;
    expect(parseReceptionAddress(parseShellRoute(hash))).toEqual({kind:'customer-job',jobId:'job/a #1',tab:'billing'});
    expect(parseReceptionAddress(parseShellRoute(receptionInboxTargetAddress('offer/a')))).toEqual({kind:'inbox-target',targetId:'offer/a'});
    expect(parseReceptionAddress(parseShellRoute(receptionSignoffAddress('offer/a')))).toEqual({kind:'signoff',signoffId:'offer/a'});
  });
});
