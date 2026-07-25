import { describe, expect, it } from 'vitest';

import {
  TAVILY_API_BASE,
  TAVILY_SCHEMA_INITIAL_VALUES,
  VENDOR_CONNECTION_CHOICES,
  initialVendorSchemaValues,
  resolveConnectionSchema,
  resolveVendorSchema,
  tavilySchema,
} from '../connection-schemas/index.js';
import { projectConnectionPayload } from '../connections/payload.js';
import { validateConnectionForm } from '../connections/page.js';

const field = (key: string) =>
  tavilySchema.fields.find((candidate) => candidate.key === key);

describe('Tavily connection enrollment', () => {
  it('is registered for pack deep links with the fixed Tavily origin', () => {
    expect(resolveVendorSchema('tavily')).toBe(tavilySchema);
    expect(resolveConnectionSchema('api', undefined, 'tavily')).toBe(tavilySchema);
    expect(initialVendorSchemaValues('tavily')).toBe(TAVILY_SCHEMA_INITIAL_VALUES);
    expect(VENDOR_CONNECTION_CHOICES).toContainEqual({
      vendor: 'tavily',
      label: 'Tavily',
      description: tavilySchema.description,
    });
    expect(field('config.base_url')).toMatchObject({
      type: 'url',
      readonly: true,
    });
  });

  it('prefills the only supported origin and authentication mode', () => {
    expect(TAVILY_SCHEMA_INITIAL_VALUES).toEqual({
      name: 'tavily',
      display_name: 'Tavily',
      'config.vendor': 'tavily',
      'config.base_url': TAVILY_API_BASE,
      'auth.type': 'bearer',
    });
    expect(field('auth.type')).toMatchObject({
      options: ['bearer'],
      hidden: true,
    });
    expect(field('auth.token')).toMatchObject({
      label: 'Tavily API Key',
      type: 'secret',
    });
    expect(tavilySchema.probe).toBeUndefined();
  });

  it('validates and projects the API-key enrollment exactly', () => {
    const values = {
      ...TAVILY_SCHEMA_INITIAL_VALUES,
      'auth.token': 'tvly-test-key',
    };

    expect(validateConnectionForm(
      tavilySchema,
      values,
      undefined,
      'create',
    )).toBeNull();
    expect(projectConnectionPayload(
      tavilySchema,
      values,
      'api',
      null,
    )).toEqual({
      name: 'tavily',
      kind: 'api',
      display_name: 'Tavily',
      config: {
        vendor: 'tavily',
        base_url: TAVILY_API_BASE,
      },
      auth: {
        type: 'bearer',
        token: 'tvly-test-key',
      },
    });
  });
});
