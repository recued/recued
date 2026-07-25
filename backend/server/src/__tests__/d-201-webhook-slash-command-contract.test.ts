import { describe, expect, it } from 'vitest';

import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import { createBuiltinWebhookDeliveryProfileAdapters } from '../webhook-delivery-profile-presets.js';
import { BUILTIN_WEBHOOK_PROFILE_POLICIES } from '../webhook-profile-policy.js';

const healthyClock: WebhookClockHealthAuthority = {
  check: async () => ({
    healthy: true,
    trusted_now_ms: 2_000_000_000_000,
    maximum_error_ms: 1_000,
    checked_at: 2_000_000_000_000,
  }),
};

describe('D-201 Slices 8W + 8X Slack slash-command contract', () => {
  it('reuses the closed Slack signing-secret policy without adding a target', () => {
    const policy = BUILTIN_WEBHOOK_PROFILE_POLICIES.get(
      'slack.slash-command.v1',
    );
    expect(policy.validateCredentialShape({ signing_secret: 'slack-secret' }))
      .toBe(true);
    expect(policy.validateCredentialShape({})).toBe(false);
    expect(policy.validateCredentialShape({
      signing_secret: 'slack-secret',
      ignored: 'authority',
    })).toBe(false);
    expect(policy.resolveRegistrationTarget(undefined, 'manual')).toEqual({
      ok: true,
      target: null,
    });
    expect(policy.resolveRegistrationTarget({
      kind: 'command',
      key: '/deploy',
    }, 'manual')).toEqual({
      ok: false,
      message: "registration_target is not supported for profile 'slack.slash-command.v1' in registration_mode 'manual'",
    });
  });

  it('stays absent without clock authority and mounts only the handshake-free adapter with one', () => {
    expect(createBuiltinWebhookDeliveryProfileAdapters(null)
      .map((adapter) => adapter.profile_id))
      .not.toContain('slack.slash-command.v1');
    const adapter = createBuiltinWebhookDeliveryProfileAdapters(healthyClock)
      .find((candidate) => candidate.profile_id === 'slack.slash-command.v1');
    expect(adapter).toBeDefined();
    expect(adapter?.handleHandshake).toBeUndefined();
    expect(adapter?.buildTestDelivery).toBeUndefined();
  });
});
