/** D-192 file SOURCE family — S3 + Dropbox vendor connection schemas.
 *
 *  Covers: both schemas declare the locked `config.vendor` discriminator + the
 *  `import_scope` escape hatch; S3 uses hidden `basic` auth (access-key/secret,
 *  the shape `file-source-adapters/s3.ts` reads) with no OAuth fields + no
 *  `use_path_style` toggle; Dropbox mirrors Google's hidden `oauth2_refresh`;
 *  the registry / resolveVendorSchema / initialVendorSchemaValues /
 *  VENDOR_CONNECTION_CHOICES / resolveConnectionSchema all surface them; and —
 *  the load-bearing part — `projectConnectionPayload` produces the EXACT
 *  `{config, auth}` shape each adapter leaf reads. */

import { describe, expect, it } from 'vitest';

import {
  BOX_API_BASE,
  BOX_OAUTH_TOKEN_URL,
  DROPBOX_API_BASE,
  DROPBOX_OAUTH_TOKEN_URL,
  MICROSOFT_GRAPH_API_BASE,
  MICROSOFT_TOKEN_URL,
} from '@recued/contracts';

import {
  BOX_SCHEMA_INITIAL_VALUES,
  DROPBOX_SCHEMA_INITIAL_VALUES,
  ONEDRIVE_SCHEMA_INITIAL_VALUES,
  SHAREPOINT_SCHEMA_INITIAL_VALUES,
  S3_SCHEMA_INITIAL_VALUES,
  VENDOR_CONNECTION_CHOICES,
  VENDOR_CONNECTION_SCHEMAS,
  apiSchema,
  boxSchema,
  dropboxSchema,
  initialVendorSchemaValues,
  onedriveSchema,
  resolveConnectionSchema,
  resolveVendorSchema,
  sharepointSchema,
  s3Schema,
  notionSchema,
  NOTION_SCHEMA_INITIAL_VALUES,
} from '../connection-schemas/index.js';
import { projectConnectionPayload } from '../connections/payload.js';
import { validateConnectionForm } from '../connections/page.js';

// ════════════════════════════════════════════════════════════════
// S3 schema (basic auth)
// ════════════════════════════════════════════════════════════════

describe('D-192 — s3Schema fields', () => {
  const field = (key: string) => s3Schema.fields.find((f) => f.key === key);

  it('declares vendor segment + kind=api', () => {
    expect(s3Schema.vendor).toBe('s3');
    expect(s3Schema.kind).toBe('api');
    expect(s3Schema.label).toBe('Amazon S3');
  });

  it('locks + hides the config.vendor discriminator', () => {
    const v = field('config.vendor');
    expect(v).toBeDefined();
    expect(v!.hidden).toBe(true);
  });

  it('requires region + bucket', () => {
    expect(field('config.region')).toBeDefined();
    expect(field('config.region')!.optional).toBeFalsy();
    expect(field('config.bucket')).toBeDefined();
    expect(field('config.bucket')!.optional).toBeFalsy();
  });

  it('offers an optional endpoint (S3-compatible) + import_scope', () => {
    expect(field('config.endpoint')!.optional).toBe(true);
    expect(field('config.import_scope')!.optional).toBe(true);
  });

  it('hides auth.type locked to the basic access-key carrier', () => {
    const authType = field('auth.type');
    expect(authType!.type).toBe('select');
    expect(authType!.options).toEqual(['basic']);
    expect(authType!.hidden).toBe(true);
  });

  it('carries the access-key-id (text) + secret-access-key (secret) fields', () => {
    expect(field('auth.username')).toBeDefined();
    expect(field('auth.username')!.type).toBe('text');
    expect(field('auth.password')!.type).toBe('secret');
  });

  it('surfaces no use_path_style toggle (inferred from endpoint) + no base_url', () => {
    expect(field('config.use_path_style')).toBeUndefined();
    expect(field('config.base_url')).toBeUndefined();
  });

  it('has no OAuth fields (S3 is basic auth)', () => {
    expect(field('auth.client_id')).toBeUndefined();
    expect(field('auth.refresh_token')).toBeUndefined();
  });
});

describe('D-192 — S3_SCHEMA_INITIAL_VALUES', () => {
  it('locks vendor=s3 + auth.type=basic', () => {
    expect(S3_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('s3');
    expect(S3_SCHEMA_INITIAL_VALUES['auth.type']).toBe('basic');
  });

  it('pre-fills no secrets + no base_url', () => {
    expect(S3_SCHEMA_INITIAL_VALUES['auth.password']).toBeUndefined();
    expect(S3_SCHEMA_INITIAL_VALUES['config.base_url']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// Dropbox schema (oauth2_refresh)
// ════════════════════════════════════════════════════════════════

describe('D-192 — dropboxSchema fields', () => {
  const field = (key: string) => dropboxSchema.fields.find((f) => f.key === key);

  it('declares vendor segment + kind=api', () => {
    expect(dropboxSchema.vendor).toBe('dropbox');
    expect(dropboxSchema.kind).toBe('api');
    expect(dropboxSchema.label).toBe('Dropbox');
  });

  it('locks + hides the config.vendor discriminator', () => {
    expect(field('config.vendor')!.hidden).toBe(true);
  });

  it('hides auth.type locked to oauth2_refresh (a Dropbox access token is short-lived)', () => {
    const authType = field('auth.type');
    expect(authType!.type).toBe('select');
    expect(authType!.options).toEqual(['oauth2_refresh']);
    expect(authType!.hidden).toBe(true);
  });

  it('carries the BYO OAuth app fields + the dance-filled refresh token', () => {
    expect(field('auth.client_id')).toBeDefined();
    expect(field('auth.client_secret')!.type).toBe('secret');
    expect(field('auth.refresh_token')!.type).toBe('secret');
  });

  it('offers the optional import_scope escape hatch', () => {
    expect(field('config.import_scope')!.optional).toBe(true);
  });
});

describe('D-192 — DROPBOX_SCHEMA_INITIAL_VALUES', () => {
  it('locks vendor=dropbox + seeds the fixed base URL + token endpoint + auth.type', () => {
    expect(DROPBOX_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('dropbox');
    expect(DROPBOX_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(DROPBOX_API_BASE);
    expect(DROPBOX_SCHEMA_INITIAL_VALUES['auth.type']).toBe('oauth2_refresh');
    expect(DROPBOX_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(DROPBOX_OAUTH_TOKEN_URL);
  });

  it('pre-fills no secrets', () => {
    expect(DROPBOX_SCHEMA_INITIAL_VALUES['auth.client_secret']).toBeUndefined();
    expect(DROPBOX_SCHEMA_INITIAL_VALUES['auth.refresh_token']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// OneDrive schema (oauth2_refresh — Microsoft Graph)
// ════════════════════════════════════════════════════════════════

describe('D-192 — onedriveSchema fields', () => {
  const field = (key: string) => onedriveSchema.fields.find((f) => f.key === key);

  it('declares vendor segment + kind=api', () => {
    expect(onedriveSchema.vendor).toBe('onedrive');
    expect(onedriveSchema.kind).toBe('api');
    expect(onedriveSchema.label).toBe('OneDrive');
  });

  it('locks + hides the config.vendor discriminator', () => {
    expect(field('config.vendor')!.hidden).toBe(true);
  });

  it('hides auth.type locked to oauth2_refresh (a Graph access token is short-lived)', () => {
    const authType = field('auth.type');
    expect(authType!.type).toBe('select');
    expect(authType!.options).toEqual(['oauth2_refresh']);
    expect(authType!.hidden).toBe(true);
  });

  it('carries the BYO Entra OAuth app fields + the dance-filled refresh token', () => {
    expect(field('auth.client_id')).toBeDefined();
    expect(field('auth.client_secret')!.type).toBe('secret');
    expect(field('auth.refresh_token')!.type).toBe('secret');
  });

  it('offers the optional import_scope escape hatch + the optional drive_id', () => {
    expect(field('config.import_scope')!.optional).toBe(true);
    // drive_id is the one field OneDrive adds vs Dropbox — the leaf reads it to
    // target a non-default / SharePoint drive.
    expect(field('config.drive_id')).toBeDefined();
    expect(field('config.drive_id')!.optional).toBe(true);
  });
});

describe('D-192 — ONEDRIVE_SCHEMA_INITIAL_VALUES', () => {
  it('locks vendor=onedrive + seeds the fixed base URL + token endpoint + auth.type', () => {
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('onedrive');
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(MICROSOFT_GRAPH_API_BASE);
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['auth.type']).toBe('oauth2_refresh');
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(MICROSOFT_TOKEN_URL);
  });

  it('pre-fills no secrets + no drive_id', () => {
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['auth.client_secret']).toBeUndefined();
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['auth.refresh_token']).toBeUndefined();
    expect(ONEDRIVE_SCHEMA_INITIAL_VALUES['config.drive_id']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// Box schema (oauth2_refresh — /2.0/events)
// ════════════════════════════════════════════════════════════════

describe('D-192 — boxSchema fields', () => {
  const field = (key: string) => boxSchema.fields.find((f) => f.key === key);

  it('declares vendor segment + kind=api', () => {
    expect(boxSchema.vendor).toBe('box');
    expect(boxSchema.kind).toBe('api');
    expect(boxSchema.label).toBe('Box');
  });

  it('locks + hides the config.vendor discriminator', () => {
    expect(field('config.vendor')!.hidden).toBe(true);
  });

  it('hides auth.type locked to oauth2_refresh (a Box access token is short-lived)', () => {
    const authType = field('auth.type');
    expect(authType!.type).toBe('select');
    expect(authType!.options).toEqual(['oauth2_refresh']);
    expect(authType!.hidden).toBe(true);
  });

  it('carries the BYO Box OAuth app fields + the dance-filled refresh token', () => {
    expect(field('auth.client_id')).toBeDefined();
    expect(field('auth.client_secret')!.type).toBe('secret');
    expect(field('auth.refresh_token')!.type).toBe('secret');
  });

  it('offers the optional import_scope escape hatch + the optional folder_id', () => {
    expect(field('config.import_scope')!.optional).toBe(true);
    // folder_id is the one field Box adds vs Dropbox — the leaf reads it to bound
    // the tree walk to a folder subtree.
    expect(field('config.folder_id')).toBeDefined();
    expect(field('config.folder_id')!.optional).toBe(true);
  });
});

describe('D-192 — BOX_SCHEMA_INITIAL_VALUES', () => {
  it('locks vendor=box + seeds the fixed base URL + token endpoint + auth.type', () => {
    expect(BOX_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('box');
    expect(BOX_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(BOX_API_BASE);
    expect(BOX_SCHEMA_INITIAL_VALUES['auth.type']).toBe('oauth2_refresh');
    expect(BOX_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(BOX_OAUTH_TOKEN_URL);
  });

  it('pre-fills no secrets + no folder_id', () => {
    expect(BOX_SCHEMA_INITIAL_VALUES['auth.client_secret']).toBeUndefined();
    expect(BOX_SCHEMA_INITIAL_VALUES['auth.refresh_token']).toBeUndefined();
    expect(BOX_SCHEMA_INITIAL_VALUES['config.folder_id']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// Notion schema (bearer auth — the one non-OAuth, non-basic file vendor)
// ════════════════════════════════════════════════════════════════

describe('D-192 — notionSchema fields', () => {
  const field = (key: string) => notionSchema.fields.find((f) => f.key === key);

  it('declares vendor segment + kind=api', () => {
    expect(notionSchema.vendor).toBe('notion');
    expect(notionSchema.kind).toBe('api');
    expect(notionSchema.label).toBe('Notion');
  });

  it('locks + hides the config.vendor discriminator', () => {
    expect(field('config.vendor')!.hidden).toBe(true);
  });

  it('hides auth.type locked to bearer (a Notion integration token is long-lived)', () => {
    const authType = field('auth.type');
    expect(authType!.type).toBe('select');
    expect(authType!.options).toEqual(['bearer']);
    expect(authType!.hidden).toBe(true);
  });

  it('carries the pasted integration token as a secret (no OAuth app fields)', () => {
    expect(field('auth.token')!.type).toBe('secret');
    // No oauth2_refresh machinery — Notion tokens don't rotate.
    expect(field('auth.client_id')).toBeUndefined();
    expect(field('auth.refresh_token')).toBeUndefined();
  });

  it('offers the optional import_scope escape hatch', () => {
    expect(field('config.import_scope')!.optional).toBe(true);
  });
});

describe('D-192 — NOTION_SCHEMA_INITIAL_VALUES', () => {
  it('locks vendor=notion + auth.type=bearer, pre-fills no secret', () => {
    expect(NOTION_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('notion');
    expect(NOTION_SCHEMA_INITIAL_VALUES['auth.type']).toBe('bearer');
    expect(NOTION_SCHEMA_INITIAL_VALUES['auth.token']).toBeUndefined();
  });
});

describe('D-192 — Notion enrollment projects a bearer-auth payload the leaf reads', () => {
  it('projects auth.bearer(token) + config.{vendor} — the shape resolveBearerAccessToken + the leaf read', () => {
    const payload = projectConnectionPayload(
      notionSchema,
      {
        ...NOTION_SCHEMA_INITIAL_VALUES, // vendor=notion + auth.type=bearer
        name: 'notion',
        display_name: 'Notion',
        'auth.token': 'ntn_integration-secret-xyz',
      },
      'api',
      null,
    );
    expect(payload.name).toBe('notion');
    expect(payload.kind).toBe('api');
    expect(payload.config).toEqual({ vendor: 'notion' });
    expect(payload.auth).toEqual({ type: 'bearer', token: 'ntn_integration-secret-xyz' });
  });
});

// ════════════════════════════════════════════════════════════════
// Registry surfacing
// ════════════════════════════════════════════════════════════════

describe('D-192 — registry surfaces every file vendor', () => {
  it('VENDOR_CONNECTION_SCHEMAS exposes dropbox + onedrive + box + sharepoint + s3 + notion', () => {
    expect(VENDOR_CONNECTION_SCHEMAS.dropbox).toBe(dropboxSchema);
    expect(VENDOR_CONNECTION_SCHEMAS.onedrive).toBe(onedriveSchema);
    expect(VENDOR_CONNECTION_SCHEMAS.box).toBe(boxSchema);
    expect(VENDOR_CONNECTION_SCHEMAS.sharepoint).toBe(sharepointSchema);
    expect(VENDOR_CONNECTION_SCHEMAS.s3).toBe(s3Schema);
    expect(VENDOR_CONNECTION_SCHEMAS.notion).toBe(notionSchema);
  });

  it('resolveVendorSchema resolves each', () => {
    expect(resolveVendorSchema('dropbox')).toBe(dropboxSchema);
    expect(resolveVendorSchema('onedrive')).toBe(onedriveSchema);
    expect(resolveVendorSchema('box')).toBe(boxSchema);
    expect(resolveVendorSchema('sharepoint')).toBe(sharepointSchema);
    expect(resolveVendorSchema('s3')).toBe(s3Schema);
    expect(resolveVendorSchema('notion')).toBe(notionSchema);
  });

  it('initialVendorSchemaValues returns each vendor its seed', () => {
    expect(initialVendorSchemaValues('dropbox')).toBe(DROPBOX_SCHEMA_INITIAL_VALUES);
    expect(initialVendorSchemaValues('onedrive')).toBe(ONEDRIVE_SCHEMA_INITIAL_VALUES);
    expect(initialVendorSchemaValues('box')).toBe(BOX_SCHEMA_INITIAL_VALUES);
    expect(initialVendorSchemaValues('sharepoint')).toBe(SHAREPOINT_SCHEMA_INITIAL_VALUES);
    expect(initialVendorSchemaValues('s3')).toBe(S3_SCHEMA_INITIAL_VALUES);
    expect(initialVendorSchemaValues('notion')).toBe(NOTION_SCHEMA_INITIAL_VALUES);
  });

  it('resolveConnectionSchema(api, _, vendor) takes the vendor schema (deep-link path)', () => {
    expect(resolveConnectionSchema('api', undefined, 'dropbox')).toBe(dropboxSchema);
    expect(resolveConnectionSchema('api', undefined, 'onedrive')).toBe(onedriveSchema);
    expect(resolveConnectionSchema('api', undefined, 'box')).toBe(boxSchema);
    expect(resolveConnectionSchema('api', undefined, 'sharepoint')).toBe(sharepointSchema);
    expect(resolveConnectionSchema('api', undefined, 's3')).toBe(s3Schema);
    // Unknown vendor still falls through to the bare api schema.
    expect(resolveConnectionSchema('api', undefined, 'nope')).toBe(apiSchema);
  });

  it('VENDOR_CONNECTION_CHOICES carries a card row for each', () => {
    const vendors = VENDOR_CONNECTION_CHOICES.map((c) => c.vendor);
    expect(vendors).toContain('dropbox');
    expect(vendors).toContain('onedrive');
    expect(vendors).toContain('box');
    expect(vendors).toContain('sharepoint');
    expect(vendors).toContain('s3');
  });
});

// ════════════════════════════════════════════════════════════════
// Projection — the exact {config, auth} shape each leaf reads
// ════════════════════════════════════════════════════════════════

describe('D-192 — S3 enrollment projects a basic-auth payload the leaf reads', () => {
  it('projects auth.basic (access_key=username, secret=password) + config.{vendor,region,bucket}', () => {
    const payload = projectConnectionPayload(
      s3Schema,
      {
        ...S3_SCHEMA_INITIAL_VALUES, // vendor=s3 + auth.type=basic
        name: 's3',
        display_name: 'Amazon S3',
        'config.region': 'us-east-1',
        'config.bucket': 'my-bucket',
        'auth.username': 'AKIAEXAMPLE',
        'auth.password': 'secret-key-xyz',
      },
      'api',
      null,
    );
    expect(payload.name).toBe('s3');
    expect(payload.kind).toBe('api');
    expect(payload.config).toEqual({ vendor: 's3', region: 'us-east-1', bucket: 'my-bucket' });
    expect(payload.auth).toEqual({
      type: 'basic',
      username: 'AKIAEXAMPLE',
      password: 'secret-key-xyz',
    });
  });

  it('carries an optional endpoint + import_scope into config when supplied', () => {
    const payload = projectConnectionPayload(
      s3Schema,
      {
        ...S3_SCHEMA_INITIAL_VALUES,
        name: 's3',
        display_name: 'MinIO',
        'config.region': 'us-east-1',
        'config.bucket': 'assets',
        'config.endpoint': 'https://minio.example.com',
        'config.import_scope': 'reports/**',
        'auth.username': 'minio',
        'auth.password': 'minio-secret',
      },
      'api',
      null,
    );
    expect(payload.config).toEqual({
      vendor: 's3',
      region: 'us-east-1',
      bucket: 'assets',
      endpoint: 'https://minio.example.com',
      import_scope: 'reports/**',
    });
  });

  it('validateConnectionForm passes for a complete S3 form', () => {
    const values = {
      ...S3_SCHEMA_INITIAL_VALUES,
      name: 's3',
      display_name: 'Amazon S3',
      'config.region': 'us-east-1',
      'config.bucket': 'my-bucket',
      'auth.username': 'AKIAEXAMPLE',
      'auth.password': 'secret-key-xyz',
    };
    expect(validateConnectionForm(s3Schema, values, undefined, 'create')).toBeNull();
  });

  it('validateConnectionForm rejects an S3 form missing the bucket', () => {
    const values = {
      ...S3_SCHEMA_INITIAL_VALUES,
      name: 's3',
      display_name: 'Amazon S3',
      'config.region': 'us-east-1',
      'auth.username': 'AKIAEXAMPLE',
      'auth.password': 'secret-key-xyz',
    };
    expect(validateConnectionForm(s3Schema, values, undefined, 'create')).not.toBeNull();
  });
});

describe('D-192 — Dropbox enrollment projects an oauth2_refresh payload', () => {
  it('projects auth.oauth2_refresh + config.{vendor,base_url} (post-dance)', () => {
    const payload = projectConnectionPayload(
      dropboxSchema,
      {
        ...DROPBOX_SCHEMA_INITIAL_VALUES,
        name: 'dropbox',
        display_name: 'Dropbox',
        'auth.client_id': 'app-key-123',
        'auth.client_secret': 'app-secret-xyz',
        'auth.refresh_token': 'refresh-token-abc', // the in-app dance fills this
      },
      'api',
      null,
    );
    expect(payload.config).toEqual({ vendor: 'dropbox', base_url: DROPBOX_API_BASE });
    expect(payload.auth).toEqual({
      type: 'oauth2_refresh',
      client_id: 'app-key-123',
      client_secret: 'app-secret-xyz',
      refresh_token: 'refresh-token-abc',
      token_endpoint: DROPBOX_OAUTH_TOKEN_URL,
    });
  });

  it('carries an optional import_scope into config when supplied', () => {
    const payload = projectConnectionPayload(
      dropboxSchema,
      {
        ...DROPBOX_SCHEMA_INITIAL_VALUES,
        name: 'dropbox',
        display_name: 'Dropbox',
        'config.import_scope': 'Work/**',
        'auth.client_id': 'app-key-123',
        'auth.client_secret': 'app-secret-xyz',
        'auth.refresh_token': 'refresh-token-abc',
      },
      'api',
      null,
    );
    expect((payload.config as Record<string, unknown>).import_scope).toBe('Work/**');
  });
});

describe('D-192 — OneDrive enrollment projects an oauth2_refresh payload the leaf reads', () => {
  it('projects auth.oauth2_refresh + config.{vendor,base_url} (post-dance)', () => {
    const payload = projectConnectionPayload(
      onedriveSchema,
      {
        ...ONEDRIVE_SCHEMA_INITIAL_VALUES,
        name: 'onedrive',
        display_name: 'OneDrive',
        'auth.client_id': 'entra-app-123',
        'auth.client_secret': 'entra-secret-xyz',
        'auth.refresh_token': 'refresh-token-abc', // the in-app dance fills this
      },
      'api',
      null,
    );
    expect(payload.config).toEqual({ vendor: 'onedrive', base_url: MICROSOFT_GRAPH_API_BASE });
    expect(payload.auth).toEqual({
      type: 'oauth2_refresh',
      client_id: 'entra-app-123',
      client_secret: 'entra-secret-xyz',
      refresh_token: 'refresh-token-abc',
      token_endpoint: MICROSOFT_TOKEN_URL,
    });
  });

  it('carries the optional import_scope + drive_id into config when supplied', () => {
    const payload = projectConnectionPayload(
      onedriveSchema,
      {
        ...ONEDRIVE_SCHEMA_INITIAL_VALUES,
        name: 'onedrive',
        display_name: 'OneDrive',
        'config.import_scope': 'Work/**',
        'config.drive_id': 'b!AbCdEf-drive-id',
        'auth.client_id': 'entra-app-123',
        'auth.client_secret': 'entra-secret-xyz',
        'auth.refresh_token': 'refresh-token-abc',
      },
      'api',
      null,
    );
    const config = payload.config as Record<string, unknown>;
    expect(config.import_scope).toBe('Work/**');
    expect(config.drive_id).toBe('b!AbCdEf-drive-id');
  });
});

describe('D-192 — Box enrollment projects an oauth2_refresh payload the leaf reads', () => {
  it('projects auth.oauth2_refresh + config.{vendor,base_url} (post-dance)', () => {
    const payload = projectConnectionPayload(
      boxSchema,
      {
        ...BOX_SCHEMA_INITIAL_VALUES,
        name: 'box',
        display_name: 'Box',
        'auth.client_id': 'box-app-123',
        'auth.client_secret': 'box-secret-xyz',
        'auth.refresh_token': 'refresh-token-abc', // the in-app dance fills this
      },
      'api',
      null,
    );
    expect(payload.config).toEqual({ vendor: 'box', base_url: BOX_API_BASE });
    expect(payload.auth).toEqual({
      type: 'oauth2_refresh',
      client_id: 'box-app-123',
      client_secret: 'box-secret-xyz',
      refresh_token: 'refresh-token-abc',
      token_endpoint: BOX_OAUTH_TOKEN_URL,
    });
  });

  it('carries the optional import_scope + folder_id into config when supplied', () => {
    const payload = projectConnectionPayload(
      boxSchema,
      {
        ...BOX_SCHEMA_INITIAL_VALUES,
        name: 'box',
        display_name: 'Box',
        'config.import_scope': 'Work/**',
        'config.folder_id': '0',
        'auth.client_id': 'box-app-123',
        'auth.client_secret': 'box-secret-xyz',
        'auth.refresh_token': 'refresh-token-abc',
      },
      'api',
      null,
    );
    const config = payload.config as Record<string, unknown>;
    expect(config.import_scope).toBe('Work/**');
    expect(config.folder_id).toBe('0');
  });
});

// ════════════════════════════════════════════════════════════════
// SharePoint schema (oauth2_refresh — an OneDrive enrollment variant)
//
// A document library IS a Graph drive, so SharePoint rides the OneDrive leaf;
// enrollment differs in exactly two ways, both asserted here: `config.drive_id`
// is REQUIRED (no /me/drive default) and the Entra app needs `Sites.Read.All`.
// ════════════════════════════════════════════════════════════════

describe('D-192 — sharepointSchema fields', () => {
  const field = (key: string) => sharepointSchema.fields.find((f) => f.key === key);

  it('declares vendor segment + kind=api', () => {
    expect(sharepointSchema.vendor).toBe('sharepoint');
    expect(sharepointSchema.kind).toBe('api');
    expect(sharepointSchema.label).toBe('SharePoint');
  });

  it('locks + hides the config.vendor discriminator', () => {
    expect(field('config.vendor')!.hidden).toBe(true);
  });

  it('hides auth.type locked to oauth2_refresh (a Graph access token is short-lived)', () => {
    const authType = field('auth.type');
    expect(authType!.type).toBe('select');
    expect(authType!.options).toEqual(['oauth2_refresh']);
    expect(authType!.hidden).toBe(true);
  });

  it('carries the BYO Entra OAuth app fields + the dance-filled refresh token', () => {
    expect(field('auth.client_id')).toBeDefined();
    expect(field('auth.client_secret')!.type).toBe('secret');
    expect(field('auth.refresh_token')!.type).toBe('secret');
  });

  it('offers config.site_url (primary) + an OPTIONAL config.drive_id advanced override (D-192 CORE #5e)', () => {
    // D-192 CORE #5e: SharePoint still has no /me/drive fallback, but the library
    // is now targeted by a pasted `config.site_url` (the server resolves the drive
    // id at enrollment) OR a hand-copied `config.drive_id` (the advanced override).
    // BOTH are form-optional (a cross-field "exactly one" rule is enforced at the
    // enroll rpc, not the form); the leaf always reads the resolved `drive_id`.
    const siteUrl = field('config.site_url');
    expect(siteUrl).toBeDefined();
    expect(siteUrl!.type).toBe('url');
    expect(siteUrl!.optional).toBe(true);
    const driveId = field('config.drive_id');
    expect(driveId).toBeDefined();
    expect(driveId!.optional).toBe(true);
    expect(field('config.import_scope')!.optional).toBe(true);
  });

  it('points the client_id help at the Sites.Read.All Graph permission', () => {
    // SharePoint needs Sites.Read.All (OneDrive-only Files.Read 403s on a site
    // drive); the enrollment guidance must say so, not carry OneDrive's copy.
    expect(field('auth.client_id')!.help).toContain('Sites.Read.All');
    expect(field('auth.client_id')!.help).not.toContain('Files.Read`,');
  });
});

describe('D-192 — SHAREPOINT_SCHEMA_INITIAL_VALUES', () => {
  it('locks vendor=sharepoint + seeds the fixed base URL + token endpoint + auth.type', () => {
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('sharepoint');
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(MICROSOFT_GRAPH_API_BASE);
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['auth.type']).toBe('oauth2_refresh');
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(MICROSOFT_TOKEN_URL);
  });

  it('pre-fills no secrets + no target (the user pastes a site URL or a drive id)', () => {
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['auth.client_secret']).toBeUndefined();
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['auth.refresh_token']).toBeUndefined();
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['config.drive_id']).toBeUndefined();
    expect(SHAREPOINT_SCHEMA_INITIAL_VALUES['config.site_url']).toBeUndefined();
  });
});

describe('D-192 — SharePoint enrollment projects an oauth2_refresh payload the leaf reads', () => {
  const completeForm = () => ({
    ...SHAREPOINT_SCHEMA_INITIAL_VALUES,
    name: 'sharepoint',
    display_name: 'SharePoint',
    'config.drive_id': 'b!AbCdEf-library-drive',
    'auth.client_id': 'entra-app-123',
    'auth.client_secret': 'entra-secret-xyz',
    'auth.refresh_token': 'refresh-token-abc', // the in-app dance fills this
  });

  it('projects auth.oauth2_refresh + config.{vendor,base_url,drive_id} (post-dance)', () => {
    const payload = projectConnectionPayload(sharepointSchema, completeForm(), 'api', null);
    expect(payload.config).toEqual({
      vendor: 'sharepoint',
      base_url: MICROSOFT_GRAPH_API_BASE,
      drive_id: 'b!AbCdEf-library-drive',
    });
    expect(payload.auth).toEqual({
      type: 'oauth2_refresh',
      client_id: 'entra-app-123',
      client_secret: 'entra-secret-xyz',
      refresh_token: 'refresh-token-abc',
      token_endpoint: MICROSOFT_TOKEN_URL,
    });
  });

  it('validateConnectionForm passes for a complete SharePoint form', () => {
    expect(validateConnectionForm(sharepointSchema, completeForm(), undefined, 'create')).toBeNull();
  });

  it('validateConnectionForm ACCEPTS a SharePoint form with a site_url and no drive_id (server resolves it at enroll)', () => {
    // D-192 CORE #5e: drive_id is now optional (auto-resolved from site_url), so a
    // site-URL-only form is form-valid; the "exactly one target" rule lives at the
    // enroll rpc (covered by d-192-sharepoint-enroll-resolve.test.ts), not the form.
    const values = { ...completeForm() };
    delete (values as Record<string, unknown>)['config.drive_id'];
    (values as Record<string, unknown>)['config.site_url'] =
      'https://contoso.sharepoint.com/sites/TeamDocs';
    expect(validateConnectionForm(sharepointSchema, values, undefined, 'create')).toBeNull();
  });

  it('carries the optional import_scope into config when supplied', () => {
    const payload = projectConnectionPayload(
      sharepointSchema,
      { ...completeForm(), 'config.import_scope': 'Shared Documents/**' },
      'api',
      null,
    );
    expect((payload.config as Record<string, unknown>).import_scope).toBe('Shared Documents/**');
  });
});
