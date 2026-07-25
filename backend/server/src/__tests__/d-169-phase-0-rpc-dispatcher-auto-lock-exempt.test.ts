/** D-169 P0 - auto-lock idle exemption for bridge capability pushes. */

import { describe, expect, it } from 'vitest';
import { AUTO_LOCK_IDLE_EXEMPT } from '../rpc-dispatcher.js';

describe('D-169 P0 - AUTO_LOCK_IDLE_EXEMPT', () => {
  it('includes bridge.capabilityProfile.push', () => {
    expect(AUTO_LOCK_IDLE_EXEMPT.has('bridge.capabilityProfile.push')).toBe(true);
  });
});
