/** D-160 P3 -- server commit Gateway dispatch_depth wiring. */

import { describe, expect, it } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';

import { buildCommitRunIdentity } from '../commit-gateway-wiring.js';

const source = (): ExecutionSource => ({
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'sender-1',
});

describe('D-160 P3 buildCommitRunIdentity dispatch_depth', () => {
  it('threads a supplied dispatch_depth onto CommitRunIdentity', () => {
    const identity = buildCommitRunIdentity({
      request_id: 'run-1',
      source: source(),
      channel_session_id: 'messenger:session-1',
      correlation_id: 'corr-1',
      dispatch_depth: 17,
    });

    expect(identity).toMatchObject({
      request_id: 'run-1',
      channel_session_id: 'messenger:session-1',
      correlation_id: 'corr-1',
      dispatch_depth: 17,
    });
  });

  it('defaults dispatch_depth to 0 when omitted', () => {
    const identity = buildCommitRunIdentity({
      request_id: 'run-2',
      source: source(),
      channel_session_id: 'messenger:session-1',
      correlation_id: 'corr-2',
    });

    expect(identity.dispatch_depth).toBe(0);
  });
});
