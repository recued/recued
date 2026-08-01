import { describe, expect, it, vi } from 'vitest';

import { RpcError } from '@recued/contracts';
import {
  buildConnectionSetupGuidePrompt,
  canonicalizeConnectionSetupGuideUrl,
  CONNECTION_SETUP_GUIDE_TIMEOUT_MS,
  generateConnectionSetupGuide,
} from '../connection-setup-guide.js';
import { makeConnectionHandlers } from '../connection-handler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

const request = () => ({
  target_url: 'https://developer.example.com/apps?access_token=DO-NOT-SHARE#secret',
  auth_type: 'oauth2_refresh' as const,
  field_keys: [
    'name',
    'display_name',
    'config.base_url',
    'auth.type',
    'auth.client_id',
    'auth.client_secret',
    'auth.token_endpoint',
    'auth.scopes',
  ],
});

const validModelJson = JSON.stringify({
  provider_name: 'Example Cloud',
  overview: 'Create an OAuth app, then copy its issued credentials into Recued.',
  field_suggestions: [
    {
      field_key: 'config.base_url',
      suggested_value: 'https://api.example.com/',
      guidance: 'Use the production API root documented by the provider.',
      confidence: 'high',
    },
    {
      field_key: 'auth.client_secret',
      suggested_value: 'MODEL-INVENTED-SECRET',
      guidance: 'Create the app and copy the secret shown by the provider.',
      confidence: 'high',
    },
    {
      field_key: 'not.a.real.field',
      suggested_value: 'ignored',
      guidance: 'ignored',
      confidence: 'high',
    },
  ],
  steps: [
    {
      title: 'Create an OAuth app',
      instruction: 'Open the provider portal and create a confidential web app.',
      field_keys: ['auth.client_id', 'auth.client_secret', 'not.a.real.field'],
    },
  ],
  cautions: ['Request only the scopes your recipes need.'],
});

describe('connection setup guide privacy boundary', () => {
  it('keeps the owner-triggered model call on a finite recovery bound', () => {
    expect(CONNECTION_SETUP_GUIDE_TIMEOUT_MS).toBe(90_000);
  });

  it('canonicalizes a public HTTPS URL and strips query + fragment data', () => {
    expect(canonicalizeConnectionSetupGuideUrl(request().target_url))
      .toBe('https://developer.example.com/apps');
  });

  it.each([
    'http://developer.example.com/apps',
    'https://localhost/apps',
    'https://localhost./apps',
    'https://192.168.1.8/apps',
    'https://[::ffff:127.0.0.1]/apps',
    'https://user:password@developer.example.com/apps',
  ])('rejects unsafe guide URL %s', (url) => {
    expect(() => canonicalizeConnectionSetupGuideUrl(url)).toThrow(RpcError);
  });

  it('does not mistake an ordinary public domain for a private IPv6 address', () => {
    expect(canonicalizeConnectionSetupGuideUrl('https://fc.example.com/apps'))
      .toBe('https://fc.example.com/apps');
  });

  it('builds a prompt from server-owned field descriptions, never form values', () => {
    const prompt = buildConnectionSetupGuidePrompt({
      target_url: 'https://developer.example.com/apps',
      auth_type: 'oauth2_refresh',
      field_keys: ['auth.client_id', 'auth.client_secret'],
    });
    expect(prompt).toContain('The identifier issued after the owner creates an OAuth app.');
    expect(prompt).toContain('never invent or echo a value');
    expect(prompt).not.toContain('DO-NOT-SHARE');
  });

  it('returns only reviewed fields and drops model-invented credential values', async () => {
    let sentPrompt = '';
    const result = await generateConnectionSetupGuide({
      generate: async (prompt) => {
        sentPrompt = prompt;
        return `\n\`\`\`json\n${validModelJson}\n\`\`\``;
      },
    }, {
      ...request(),
      // A direct paired caller can send extra JSON keys despite the TypeScript
      // contract. The server projection must ignore them rather than letting a
      // secret hitchhike into model context.
      unreviewed_form_values: {
        'auth.client_secret': 'EXTRA-SECRET-DO-NOT-SHARE',
      },
    });

    expect(sentPrompt).not.toContain('DO-NOT-SHARE');
    expect(sentPrompt).not.toContain('EXTRA-SECRET-DO-NOT-SHARE');
    expect(result.shared_context.target_url).toBe('https://developer.example.com/apps');
    expect(result.guide.field_suggestions).toEqual([
      {
        field_key: 'config.base_url',
        suggested_value: 'https://api.example.com/',
        guidance: 'Use the production API root documented by the provider.',
        confidence: 'high',
      },
      {
        field_key: 'auth.client_secret',
        guidance: 'Create the app and copy the secret shown by the provider.',
        confidence: 'high',
      },
    ]);
    expect(result.guide.steps[0]?.field_keys).toEqual([
      'auth.client_id',
      'auth.client_secret',
    ]);
    expect(JSON.stringify(result)).not.toContain('MODEL-INVENTED-SECRET');
    expect(result.guide.cautions).toContain(
      'Verify endpoint and scope recommendations against the provider’s current documentation before saving.',
    );
  });

  it('rejects an arbitrary field before invoking the model', async () => {
    const generate = vi.fn(async () => validModelJson);
    await expect(generateConnectionSetupGuide({ generate }, {
      ...request(),
      field_keys: ['auth.client_secret', 'notes.DO-NOT-SHARE'],
    })).rejects.toMatchObject({ code: 'bad_request' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects malformed model output instead of rendering unvalidated prose', async () => {
    await expect(generateConnectionSetupGuide({
      generate: async () => 'Follow these steps and paste your secret here.',
    }, request())).rejects.toMatchObject({ code: 'ai_invalid_output' });
  });
});

describe('collection.connection.suggestSetup rpc boundary', () => {
  it('is honest when the configured-AI caller is absent', async () => {
    const handlers = makeConnectionHandlers({
      store: {} as ConnectionStoreSqlite,
    })!.handlers;
    await expect(handlers['collection.connection.suggestSetup']!(request(), {} as never))
      .rejects.toMatchObject({ code: 'not_configured' });
  });

  it('allows only one paid guide generation at a time', async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const handlers = makeConnectionHandlers({
      store: {} as ConnectionStoreSqlite,
      setupGuide: { generate: () => pending },
    })!.handlers;
    const first = handlers['collection.connection.suggestSetup']!(request(), {} as never);
    await Promise.resolve();
    await expect(handlers['collection.connection.suggestSetup']!(request(), {} as never))
      .rejects.toMatchObject({ code: 'conflict' });
    release(validModelJson);
    await expect(first).resolves.toMatchObject({
      guide: { provider_name: 'Example Cloud' },
    });
  });
});
