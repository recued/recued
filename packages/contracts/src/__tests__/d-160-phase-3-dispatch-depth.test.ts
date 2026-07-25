/** D-160 P3 -- dispatch-depth hop primitive. */

import { describe, expect, it } from 'vitest';

import {
  MAX_DISPATCH_DEPTH,
  nextDispatchDepth,
} from '../commits.js';

describe('D-160 P3 nextDispatchDepth', () => {
  it('increments a parent dispatch depth by exactly one', () => {
    expect(nextDispatchDepth(0)).toBe(1);
    expect(nextDispatchDepth(7)).toBe(8);
  });

  it('composes N hops as parent plus N', () => {
    const parent = 3;
    const hops = 11;
    let depth = parent;
    for (let i = 0; i < hops; i += 1) {
      depth = nextDispatchDepth(depth);
    }

    expect(depth).toBe(parent + hops);
  });

  it('crosses MAX_DISPATCH_DEPTH cleanly without enforcing the ceiling', () => {
    expect(nextDispatchDepth(MAX_DISPATCH_DEPTH))
      .toBe(MAX_DISPATCH_DEPTH + 1);
  });
});
