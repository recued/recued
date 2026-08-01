import { describe, expect, it } from 'vitest';

import type { ConnectionSetupGuideResult } from '@recued/ui-shared';
import {
  PROVIDER_SETUP_CONTINUITY_SESSION_KEY,
  createProviderSetupContinuityStore,
  type ProviderSetupContinuityStorage,
} from '../connections/provider-setup-continuity.js';

const NOW = 1_800_000_000_000;

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
};

const result = (): ConnectionSetupGuideResult => ({
  shared_context: {
    target_url: 'https://developer.example.com/apps',
    auth_type: 'oauth2_refresh',
    field_keys: [
      'name',
      'auth.type',
      'auth.client_id',
      'auth.client_secret',
      'auth.token_endpoint',
      'auth.scopes',
    ],
  },
  guide: {
    provider_name: 'Example Cloud',
    overview: 'Create a web OAuth app, then return to Recued.',
    field_suggestions: [
      {
        field_key: 'auth.client_id',
        suggested_value: 'CLIENT-ID-SENTINEL-MUST-NOT-PERSIST',
        guidance: 'Copy the provider-issued client ID from the app.',
        confidence: 'low',
      },
      {
        field_key: 'auth.client_secret',
        suggested_value: 'CLIENT-SECRET-SENTINEL-MUST-NOT-PERSIST',
        guidance: 'Copy the provider-issued secret into the live form only.',
        confidence: 'low',
      },
      {
        field_key: 'auth.token_endpoint',
        suggested_value:
          'https://oauth.example.com/token?client_secret=URL-SENTINEL-MUST-NOT-PERSIST#private',
        guidance: 'Verify the public token endpoint.',
        confidence: 'high',
      },
    ],
    steps: [{
      title: 'Create the app',
      instruction: 'Create a confidential web application.',
      field_keys: ['auth.client_id', 'auth.client_secret'],
    }],
    cautions: ['Use least-privilege scopes.'],
  },
});

describe('provider-app setup continuity', () => {
  it('persists only safe guide context and transferable suggestions', () => {
    const storage = memoryStorage();
    const store = createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => NOW,
    });

    expect(store.write({
      schemaKind: 'bare_api',
      schemaVendor: null,
      resumeFieldKey: 'auth.client_secret',
      result: result(),
    })).toBe(true);
    const raw = storage.data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY) ?? '';
    expect(raw).toContain('https://developer.example.com/apps');
    expect(raw).toContain('https://oauth.example.com/token');
    expect(raw).toContain('"resume_field_key":"auth.client_secret"');
    expect(raw).not.toContain('CLIENT-ID-SENTINEL-MUST-NOT-PERSIST');
    expect(raw).not.toContain('CLIENT-SECRET-SENTINEL-MUST-NOT-PERSIST');
    expect(raw).not.toContain('URL-SENTINEL-MUST-NOT-PERSIST');
    expect(raw).not.toContain('form_values');
    expect(raw).not.toContain('refresh_token_value');
    expect(store.write({
      schemaKind: 'registered_vendor',
      schemaVendor: null,
      resumeFieldKey: 'auth.client_secret',
      result: result(),
    })).toBe(false);
    expect(store.write({
      schemaKind: 'bare_api',
      schemaVendor: null,
      resumeFieldKey: 'auth.refresh_token',
      result: result(),
    })).toBe(false);
    expect(storage.data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(raw);

    const restored = store.read();
    expect(restored?.schemaKind).toBe('bare_api');
    expect(restored?.resumeFieldKey).toBe('auth.client_secret');
    expect(restored?.result.guide.field_suggestions).toEqual([
      {
        field_key: 'auth.client_id',
        guidance: 'Copy the provider-issued client ID from the app.',
        confidence: 'low',
      },
      {
        field_key: 'auth.client_secret',
        guidance: 'Copy the provider-issued secret into the live form only.',
        confidence: 'low',
      },
      {
        field_key: 'auth.token_endpoint',
        suggested_value: 'https://oauth.example.com/token',
        guidance: 'Verify the public token endpoint.',
        confidence: 'high',
      },
    ]);
    // A route remount may peek again until the owner explicitly resumes.
    expect(store.read()).toEqual(restored);
  });

  it('keeps another profile opaque without destroying its draft', () => {
    const storage = memoryStorage();
    const office = createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => NOW,
    });
    expect(office.write({
      schemaKind: 'registered_vendor',
      schemaVendor: 'hubspot',
      resumeFieldKey: 'auth.client_secret',
      result: result(),
    })).toBe(true);

    const personal = createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-personal',
      now: () => NOW + 1,
    });
    expect(personal.read()).toBeNull();
    personal.retire();
    expect(storage.data.has(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(true);
    expect(createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 2,
    }).read()).toMatchObject({ schemaVendor: 'hubspot' });
  });

  it('retires stale, future, malformed, credential-bearing, or widened envelopes', () => {
    const cases: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.saved_at = NOW - 2 * 60 * 60 * 1_000 - 1; },
      (value) => { value.saved_at = NOW + 1; },
      (value) => { value.credential_snapshot = { client_secret: 'NOPE' }; },
      (value) => {
        const nested = value.result as Record<string, unknown>;
        nested.credentials = 'NOPE';
      },
      (value) => { value.resume_field_key = 'auth.refresh_token'; },
      (value) => {
        const nested = value.result as Record<string, unknown>;
        const guide = nested.guide as Record<string, unknown>;
        const suggestions = guide.field_suggestions as Array<Record<string, unknown>>;
        suggestions[1]!.suggested_value = 'TAMPERED-SECRET-MUST-BE-RETIRED';
      },
    ];
    for (const mutate of cases) {
      const storage = memoryStorage();
      const writer = createProviderSetupContinuityStore({
        storage,
        scopeId: 'profile-office',
        now: () => NOW,
      });
      expect(writer.write({
        schemaKind: 'bare_api',
        schemaVendor: null,
        resumeFieldKey: 'auth.client_secret',
        result: result(),
      })).toBe(true);
      const value = JSON.parse(
        storage.data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)!,
      ) as Record<string, unknown>;
      mutate(value);
      storage.setItem(PROVIDER_SETUP_CONTINUITY_SESSION_KEY, JSON.stringify(value));

      const reader = createProviderSetupContinuityStore({
        storage,
        scopeId: 'profile-office',
        now: () => NOW,
      });
      expect(reader.read()).toBeNull();
      expect(storage.data.has(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(false);
    }
  });

  it('is one-shot even when physical removal is denied and fails softly', () => {
    const backing = memoryStorage();
    const storage: ProviderSetupContinuityStorage = {
      getItem: backing.getItem,
      setItem: backing.setItem,
      removeItem: () => { throw new Error('denied'); },
    };
    const store = createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => NOW,
    });
    expect(store.write({
      schemaKind: 'bare_api',
      schemaVendor: null,
      resumeFieldKey: 'auth.client_secret',
      result: result(),
    })).toBe(true);
    expect(store.read()).not.toBeNull();
    store.retire();
    expect(store.read()).toBeNull();
    expect(backing.data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY))
      .toBe('{"version":1,"retired":true}');
    expect(createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 1,
    }).read()).toBeNull();

    // A browser can deny an overwrite (for example under quota pressure) but
    // still permit removal. Retirement must try both mutations independently.
    const removable = memoryStorage();
    expect(createProviderSetupContinuityStore({
      storage: removable,
      scopeId: 'profile-office',
      now: () => NOW,
    }).write({
      schemaKind: 'bare_api',
      schemaVendor: null,
      resumeFieldKey: 'auth.client_secret',
      result: result(),
    })).toBe(true);
    const setDenied: ProviderSetupContinuityStorage = {
      getItem: removable.getItem,
      setItem: () => { throw new Error('quota'); },
      removeItem: removable.removeItem,
    };
    const removableReader = createProviderSetupContinuityStore({
      storage: setDenied,
      scopeId: 'profile-office',
      now: () => NOW + 1,
    });
    expect(removableReader.read()).not.toBeNull();
    removableReader.retire();
    expect(removable.data.has(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(false);

    const denied: ProviderSetupContinuityStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(createProviderSetupContinuityStore({
      storage: denied,
      scopeId: 'profile-office',
    }).write({
      schemaKind: 'bare_api',
      schemaVendor: null,
      resumeFieldKey: 'auth.client_secret',
      result: result(),
    })).toBe(false);
    expect(createProviderSetupContinuityStore({
      storage: denied,
      scopeId: 'profile-office',
    }).read()).toBeNull();
  });
});
