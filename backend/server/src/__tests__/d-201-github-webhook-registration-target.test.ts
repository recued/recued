import { describe, expect, it, vi } from 'vitest';

import { canonicalGitHubWebhookRegistrationTarget } from '../connections/providers/github-webhook-registration-target.js';

describe('D-201 Slices 8D + 9AE GitHub webhook registration target', () => {
  it('canonicalizes only repository and organization scope keys', () => {
    expect(canonicalGitHubWebhookRegistrationTarget({
      kind: 'repository',
      key: 'OpenAI/.GitHub',
    })).toEqual({ kind: 'repository', key: 'openai/.github' });
    expect(canonicalGitHubWebhookRegistrationTarget({
      kind: 'organization',
      key: 'OpenAI',
    })).toEqual({ kind: 'organization', key: 'openai' });
  });

  it.each([
    null,
    { kind: 'repository', key: 'https://github.com/openai/example' },
    { kind: 'repository', key: 'openai/team/example' },
    { kind: 'repository', key: 'openai/' },
    { kind: 'organization', key: 'openai/example' },
    { kind: 'organization', key: ' openai' },
    { kind: 'account', key: 'openai' },
    { kind: 'repository', key: 'openai/example', url: 'https://attacker.invalid' },
  ])('rejects URLs, paths, unknown kinds, whitespace, and extra authority: %j', (value) => {
    expect(canonicalGitHubWebhookRegistrationTarget(value)).toBeNull();
  });

  it('rejects inherited and accessor-backed target fields without reading them', () => {
    expect(canonicalGitHubWebhookRegistrationTarget(Object.create({
      kind: 'repository',
      key: 'openai/example',
    }))).toBeNull();

    const getter = vi.fn(() => 'repository');
    const accessor = { key: 'openai/example' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: getter });
    expect(canonicalGitHubWebhookRegistrationTarget(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
