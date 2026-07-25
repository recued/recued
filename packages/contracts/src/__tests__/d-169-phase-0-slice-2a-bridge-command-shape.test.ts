/** D-169 P0 Slice 2A — BridgeCommand envelope shape pin.
 *
 *  Pre-D-169 the per-command scope rode inside a server-signed
 *  `BridgeAuthority` struct embedded in `BridgeCommand.authority`. This
 *  slice retires the signing layer + lifts the scope shape (action ×
 *  target_domain_pattern × timeout) to plain top-level fields.
 *
 *  This test pins the new shape so future drift between server-side
 *  producer (`backend/server/src/bridges/dispatcher.ts`) and
 *  bridge-side consumer (`apps/bridge/src/queue/dispatcher.ts`) fails
 *  loudly at the contract layer.
 */

import { describe, it, expect } from 'vitest';
import type { BridgeCommand } from '../bridge.js';

describe('D-169 P0 Slice 2A — BridgeCommand shape', () => {
  it('top-level `action` + `target_domain_pattern` fields are required (no nested authority)', () => {
    const command: BridgeCommand = {
      command_id: 'cmd-1',
      recipe_run_id: 'run-1',
      step_id: 'step-1',
      ingredient: {
        publisher_id: 'recued-core',
        slug: 'draft-email-reader-hubspot',
        version: '1.0.0',
        surface_kind: 'reading',
        domain_allowlist: ['*://app.hubspot.com/*'],
        domain_allowlist_signature: 'PUB_SIG',
      },
      action: 'read_dom',
      target_domain_pattern: '*://app.hubspot.com/*',
      args: { selector: '#email-subject' },
      expects_output_keys: ['text'],
      timeout_ms: 5_000,
      idempotency_key: 'idem-1',
    };
    expect(command.action).toBe('read_dom');
    expect(command.target_domain_pattern).toBe('*://app.hubspot.com/*');
    // Compile-time + runtime: `authority` is no longer on the struct.
    expect((command as unknown as Record<string, unknown>).authority).toBeUndefined();
  });

  it('round-trips through JSON without loss', () => {
    const command: BridgeCommand = {
      command_id: 'cmd-1',
      recipe_run_id: 'run-1',
      step_id: 'step-1',
      ingredient: {
        publisher_id: 'recued-core',
        slug: 'draft-email-reader-hubspot',
        version: '1.0.0',
        surface_kind: 'reading',
        domain_allowlist: ['*://app.hubspot.com/*'],
        domain_allowlist_signature: 'PUB_SIG',
      },
      action: 'click',
      target_domain_pattern: '*://app.hubspot.com/*',
      args: {},
      expects_output_keys: [],
      timeout_ms: 30_000,
      idempotency_key: 'idem-2',
    };
    const decoded = JSON.parse(JSON.stringify(command)) as BridgeCommand;
    expect(decoded.action).toBe('click');
    expect(decoded.target_domain_pattern).toBe('*://app.hubspot.com/*');
    expect(decoded.command_id).toBe('cmd-1');
  });
});
