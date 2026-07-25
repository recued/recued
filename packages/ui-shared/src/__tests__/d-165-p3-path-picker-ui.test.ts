/** D-165 P3.path-picker Slice 2 - connection enrollment UI coverage. */

import { describe, expect, it } from 'vitest';

import {
  apiSchema,
  buildConnectionEditDialogPatch,
  flattenConnectionViewIntoValues,
  initialConnectionsDialogState,
  initialConnectionsPageState,
  mcpSchemas,
  notificationSchemas,
  projectConnectionPayload,
  renderConnectionsPage,
  resolveConnectionSchema,
} from '../index.js';
import type {
  ConnectionsDialogState,
  ConnectionsPageState,
} from '../connections/index.js';

const sampleConnections = [
  {
    name: 'photos-api',
    kind: 'api' as const,
    display_name: 'Photos API',
    base_url: 'https://api.example.com',
  },
];

const baseState = (overrides?: Partial<ConnectionsPageState>): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  connections: sampleConnections,
  ...(overrides ?? {}),
});

const withDialog = (overrides: Partial<ConnectionsDialogState>): ConnectionsPageState => ({
  ...baseState(),
  dialog: { ...initialConnectionsDialogState(), ...overrides },
});

const fieldByKey = (
  schema: { fields: readonly { key: string; type?: string; optional?: boolean }[] },
  key: string,
) => schema.fields.find((f) => f.key === key);

const expectNoSubresourceField = (
  schema: { fields: readonly { key: string }[] },
): void => {
  expect(fieldByKey(schema, 'subresource_path')).toBeUndefined();
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const connectionFieldInput = (html: string, key: string): string => {
  const match = html.match(new RegExp(`<input[^>]*data-conn-field="${key}"[^>]*>`));
  expect(match).toBeTruthy();
  return match![0];
};

describe('D-165 P3.path-picker - schemas', () => {
  it('adds optional top-level subresource_path to the bare api schema', () => {
    const field = fieldByKey(apiSchema, 'subresource_path');
    expect(field).toBeDefined();
    expect(field!.type).toBe('text');
    expect(field!.optional).toBe(true);

    const resolved = resolveConnectionSchema('api');
    expect(resolved).toBeDefined();
    expect(fieldByKey(resolved!, 'subresource_path')).toBeDefined();
  });

  it('keeps flat vendor and non-hierarchical schemas free of subresource_path', () => {
    for (const schema of Object.values(mcpSchemas)) {
      expectNoSubresourceField(schema);
    }
    for (const schema of Object.values(notificationSchemas)) {
      expectNoSubresourceField(schema);
    }

    const hubspot = resolveConnectionSchema('api', undefined, 'hubspot');
    const salesforce = resolveConnectionSchema('api', undefined, 'salesforce');
    expect(hubspot).toBeDefined();
    expect(salesforce).toBeDefined();
    expectNoSubresourceField(hubspot!);
    expectNoSubresourceField(salesforce!);
  });
});

describe('D-165 P3.path-picker - payload projection', () => {
  const bearerValues = {
    name: 'photos-api',
    display_name: 'Photos API',
    'config.base_url': 'https://api.example.com',
    'auth.type': 'bearer',
    'auth.token': 'pat-xxx',
  };

  it('drops blank optional subresource_path from the enroll payload', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      bearerValues,
      'api',
      null,
    );

    expect(hasOwn(payload, 'subresource_path')).toBe(false);
    expect(payload.config).not.toHaveProperty('subresource_path');
    expect(payload.auth).not.toHaveProperty('subresource_path');
  });

  it('projects subresource_path as a top-level enroll payload field', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      { ...bearerValues, subresource_path: '/photos' },
      'api',
      null,
    );

    expect(payload.subresource_path).toBe('/photos');
    expect(payload.config).not.toHaveProperty('subresource_path');
    expect(payload.auth).not.toHaveProperty('subresource_path');
  });
});

describe('multi-header auth - indexed form keys project into the headers array', () => {
  const base = {
    name: 'plaid',
    display_name: 'Plaid',
    'config.base_url': 'https://production.plaid.com',
    'auth.type': 'header',
  };

  it('projects a SINGLE header (row 0 only) into a 1-element array; blank row 1 dropped', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      { ...base, 'auth.headers.0.header_name': 'X-API-Key', 'auth.headers.0.value': 'k' },
      'api',
      null,
    );
    expect(payload.auth).toEqual({ type: 'header', headers: [{ header_name: 'X-API-Key', value: 'k' }] });
  });

  it('projects TWO headers (Plaid PLAID-CLIENT-ID + PLAID-SECRET) into a 2-element array', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      {
        ...base,
        'auth.headers.0.header_name': 'PLAID-CLIENT-ID',
        'auth.headers.0.value': 'cid',
        'auth.headers.1.header_name': 'PLAID-SECRET',
        'auth.headers.1.value': 'sec',
      },
      'api',
      null,
    );
    expect(payload.auth).toEqual({
      type: 'header',
      headers: [
        { header_name: 'PLAID-CLIENT-ID', value: 'cid' },
        { header_name: 'PLAID-SECRET', value: 'sec' },
      ],
    });
    expect(Array.isArray((payload.auth as { headers: unknown }).headers)).toBe(true);
  });

  it('projects THREE headers into a 3-element array (repeatable beyond the old fixed 2)', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      {
        ...base,
        'auth.headers.0.header_name': 'A', 'auth.headers.0.value': 'a',
        'auth.headers.1.header_name': 'B', 'auth.headers.1.value': 'b',
        'auth.headers.2.header_name': 'C', 'auth.headers.2.value': 'c',
      },
      'api',
      null,
    );
    expect(payload.auth).toEqual({
      type: 'header',
      headers: [
        { header_name: 'A', value: 'a' },
        { header_name: 'B', value: 'b' },
        { header_name: 'C', value: 'c' },
      ],
    });
  });

  it('drops a removed MIDDLE row + re-indexes contiguously — NO sparse hole', () => {
    // Form indices 0 and 2 are filled; index 1 was removed (its keys absent) —
    // a naive setDeep on the raw indices would build [A, <hole>, C].
    const payload = projectConnectionPayload(
      apiSchema,
      {
        ...base,
        'auth.headers.0.header_name': 'A', 'auth.headers.0.value': 'a',
        'auth.headers.2.header_name': 'C', 'auth.headers.2.value': 'c',
      },
      'api',
      null,
    );
    const headers = (
      payload.auth as unknown as { headers: Array<{ header_name: string; value: string }> }
    ).headers;
    expect(headers).toEqual([
      { header_name: 'A', value: 'a' },
      { header_name: 'C', value: 'c' },
    ]);
    expect(headers).toHaveLength(2);
    // No hole: every slot is a real object (a sparse array would have `in` gaps).
    expect(Object.keys(headers)).toEqual(['0', '1']);
  });

  it('drops a fully-blank (whitespace-only) row, keeps the filled one', () => {
    const payload = projectConnectionPayload(
      apiSchema,
      {
        ...base,
        'auth.headers.0.header_name': 'X-API-Key', 'auth.headers.0.value': 'k',
        'auth.headers.1.header_name': '  ', 'auth.headers.1.value': '',
      },
      'api',
      null,
    );
    expect(payload.auth).toEqual({
      type: 'header',
      headers: [{ header_name: 'X-API-Key', value: 'k' }],
    });
  });
});

describe('D-165 P3.path-picker - view flattening', () => {
  it('flattens subresource_path at the top level rather than under config', () => {
    const values = flattenConnectionViewIntoValues({
      name: 'photos-api',
      kind: 'api',
      display_name: 'Photos API',
      base_url: 'https://api.example.com',
      subresource_path: '/photos',
    });

    expect(values.subresource_path).toBe('/photos');
    expect(values['config.subresource_path']).toBeUndefined();
  });

  it('omits subresource_path when the view does not carry one', () => {
    const values = flattenConnectionViewIntoValues({
      name: 'photos-api',
      kind: 'api',
      display_name: 'Photos API',
      base_url: 'https://api.example.com',
    });

    expect(hasOwn(values, 'subresource_path')).toBe(false);
  });
});

describe('D-165 P3.path-picker - edit dialog hydration', () => {
  it('round-trips subresource_path into edit dialog values', () => {
    const patch = buildConnectionEditDialogPatch({
      name: 'photos-api',
      kind: 'api',
      display_name: 'Photos API',
      subresource_path: '/photos',
    } as Parameters<typeof buildConnectionEditDialogPatch>[0]);

    expect(patch.values.subresource_path).toBe('/photos');
  });
});

describe('D-165 P3.path-picker - rendered form', () => {
  it('renders subresource_path as an editable text input in create mode', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'create',
        kind: 'api',
        values: {
          name: 'photos-api',
          display_name: 'Photos API',
          'config.base_url': 'https://api.example.com',
          'auth.type': 'bearer',
          'auth.token': 'pat-xxx',
        },
      }),
    );

    const input = connectionFieldInput(html, 'subresource_path');
    expect(input).toContain('type="text"');
    expect(input).not.toContain('readonly');
  });

  it('renders subresource_path as a readonly text input in edit mode', () => {
    const html = renderConnectionsPage(
      withDialog({
        stage: 'form',
        mode: 'edit',
        kind: 'api',
        editingId: 'api/photos-api',
        values: {
          name: 'photos-api',
          display_name: 'Photos API',
          'config.base_url': 'https://api.example.com',
          subresource_path: '/photos',
          'auth.type': 'bearer',
        },
      }),
    );

    expect(html).toMatch(/<input[^>]*readonly[^>]*data-conn-field="subresource_path"/);
  });
});
