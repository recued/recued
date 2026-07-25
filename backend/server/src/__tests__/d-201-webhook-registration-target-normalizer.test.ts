import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookAccountResourceRegistrationTargetNormalizer,
} from '../webhook-account-resource-registration-target-normalizer.js';
import {
  WEBHOOK_REGISTRATION_TARGET_PROFILE_PRESETS,
  webhookRegistrationTargetProfilePreset,
} from '../webhook-registration-target-profile-presets.js';

const PRESET = {
  kind: 'account_or_account_resource.v1',
  account_kind: 'workspace',
  resource_kind: 'project',
} as const;

describe('D-201 Slice 9AE account/resource registration-target normalizer', () => {
  it('canonicalizes account and directly nested resource targets', () => {
    const normalizer =
      createWebhookAccountResourceRegistrationTargetNormalizer(PRESET);
    const account = normalizer.normalize({
      kind: 'workspace',
      key: 'OpenAI',
    });
    const resource = normalizer.normalize({
      kind: 'project',
      key: 'OpenAI/.GitHub',
    });

    expect(account).toEqual({ kind: 'workspace', key: 'openai' });
    expect(resource).toEqual({ kind: 'project', key: 'openai/.github' });
    expect(Object.isFrozen(account)).toBe(true);
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Object.isFrozen(normalizer)).toBe(true);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(() => JSON.stringify(normalizer.preset)).not.toThrow();
  });

  it.each([
    null,
    undefined,
    'openai/example',
    { kind: 'workspace', key: '' },
    { kind: 'workspace', key: ' openai' },
    { kind: 'workspace', key: 'openai/' },
    { kind: 'workspace', key: `${'a'.repeat(39)}b` },
    { kind: 'project', key: 'https://example.test/openai/example' },
    { kind: 'project', key: 'openai/team/example' },
    { kind: 'project', key: 'openai/' },
    { kind: 'project', key: '/example' },
    { kind: 'project', key: 'openai/...' },
    { kind: 'project', key: `openai/${'a'.repeat(101)}` },
    { kind: 'repository', key: 'openai/example' },
    { kind: 'project', key: 'openai/example', url: 'https://attacker.invalid' },
  ])('rejects noncanonical grammar and extra authority: %j', (value) => {
    const normalizer =
      createWebhookAccountResourceRegistrationTargetNormalizer(PRESET);
    expect(normalizer.normalize(value)).toBeNull();
  });

  it('accepts only exact own enumerable data targets without executing accessors', () => {
    const normalizer =
      createWebhookAccountResourceRegistrationTargetNormalizer(PRESET);

    expect(normalizer.normalize(Object.create({
      kind: 'project',
      key: 'openai/example',
    }))).toBeNull();

    const withSymbol = { kind: 'project', key: 'openai/example' } as Record<
      string | symbol,
      unknown
    >;
    withSymbol[Symbol('authority')] = true;
    expect(normalizer.normalize(withSymbol)).toBeNull();

    const withHidden = { kind: 'project', key: 'openai/example' };
    Object.defineProperty(withHidden, 'authority', { value: true });
    expect(normalizer.normalize(withHidden)).toBeNull();

    const getter = vi.fn(() => 'project');
    const accessor = { key: 'openai/example' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: getter });
    expect(normalizer.normalize(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    expect(normalizer.normalize(new Proxy({}, {
      ownKeys() {
        throw new Error('hostile target');
      },
    }))).toBeNull();
    expect(normalizer.normalize(new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile target');
      },
    }))).toBeNull();
  });

  it('accepts only exact trusted kind-label presets without executing accessors', () => {
    expect(() => createWebhookAccountResourceRegistrationTargetNormalizer(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_pattern.v1' },
      { ...PRESET, account_kind: 'Workspace' },
      { ...PRESET, account_kind: 'project' },
      { ...PRESET, resource_kind: 'project.path' },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile preset');
        },
      }),
    ]) {
      expect(() => createWebhookAccountResourceRegistrationTargetNormalizer(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 'project');
    const accessor = {
      kind: 'account_or_account_resource.v1',
      account_kind: 'workspace',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'resource_kind', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookAccountResourceRegistrationTargetNormalizer(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds GitHub labels and UI modes through trusted profile data only', () => {
    const selected = webhookRegistrationTargetProfilePreset(
      'github.webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'github.webhook.v1',
      modes: ['managed_endpoint'],
      normalizer: {
        kind: 'account_or_account_resource.v1',
        account_kind: 'organization',
        resource_kind: 'repository',
      },
      invalid_target_message: "GitHub managed registration requires registration_target { kind: 'repository', key: 'owner/repository' } or { kind: 'organization', key: 'organization' }",
    });
    expect(webhookRegistrationTargetProfilePreset('stripe.event.v1')).toBeNull();
    expect(Object.keys(WEBHOOK_REGISTRATION_TARGET_PROFILE_PRESETS))
      .toEqual(['github.webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_TARGET_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_TARGET_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.modes)).toBe(true);
    expect(Object.isFrozen(selected?.normalizer)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();

    const normalizer = createWebhookAccountResourceRegistrationTargetNormalizer(
      selected!.normalizer,
    );
    expect(normalizer.normalize({
      kind: 'repository',
      key: 'OpenAI/.GitHub',
    })).toEqual({ kind: 'repository', key: 'openai/.github' });
  });
});
