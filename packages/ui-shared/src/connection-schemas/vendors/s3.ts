/** D-192 file SOURCE family — Amazon S3 (+ S3-compatible) vendor schema.
 *
 *  The one non-OAuth vendor: S3 authenticates with an access-key-id +
 *  secret-access-key pair, carried on the connection substrate's `basic` auth
 *  (access_key = username, secret_key = password — the S3 file-source leaf
 *  reads exactly that, `file-source-adapters/s3.ts`). There is therefore NO
 *  `ConnectionVendorProvider` for `s3` (providers are OAuth-only); the enroll
 *  panel's provider consumers (`getVendorProvider` scope pre-fill,
 *  `syncVendorOAuthEndpointValue`) are all null-safe for a schema without one.
 *
 *  `config.vendor: 's3'` is what the file SOURCE reconciler keys on. `region`
 *  + `bucket` are required (SigV4 needs the region; the leaf fails closed
 *  without either). `endpoint` is the S3-compatible override (MinIO / R2 /
 *  Backblaze B2) — leave blank for AWS. Path-style addressing is inferred from
 *  the endpoint (the S3 client uses path-style whenever an endpoint is set), so
 *  no explicit `use_path_style` toggle is surfaced in v1; the rare custom-
 *  endpoint-with-virtual-host case is a CLI/rpc enrollment.
 *
 *  `config.import_scope` (Fork A) is the optional base folder / key-prefix glob
 *  that scopes the metadata mirror to a subtree — a bare prefix (`invoices/`)
 *  pushes down to the ListObjectsV2 `Prefix`. See
 *  `packages/contracts/src/import-scope.ts`.
 *
 *  Spec: `docs/d-192-file-source-family.md`; config shape matches
 *  `backend/server/src/file-source-adapters/s3.ts` verbatim. */

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

const S3_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'Lowercase identifier used in recipes (e.g. `s3`, `s3-archive`).',
    placeholder: 's3',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Amazon S3',
  },
  // Vendor discriminator — locked + hidden (same posture as the other vendors).
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'S3 vendor identifier — locked at enrollment.',
    placeholder: 's3',
    hidden: true,
  },
  {
    key: 'config.region',
    label: 'Region',
    type: 'text',
    placeholder: 'us-east-1',
    help: 'AWS region of the bucket (e.g. `us-east-1`). Required — SigV4 signs against it. For MinIO / R2, use `us-east-1` unless your endpoint requires otherwise.',
  },
  {
    key: 'config.bucket',
    label: 'Bucket',
    type: 'text',
    placeholder: 'my-bucket',
    help: 'The S3 bucket name to mirror file metadata from.',
  },
  {
    key: 'config.endpoint',
    label: 'Endpoint (optional)',
    type: 'url',
    optional: true,
    placeholder: 'https://s3.example.com',
    help:
      'S3-compatible endpoint override — set for MinIO / Cloudflare R2 / '
      + 'Backblaze B2. Leave blank for Amazon S3 (path-style addressing is used '
      + 'automatically when an endpoint is set).',
  },
  // Fork A escape hatch — the optional key-prefix glob that scopes the metadata
  // mirror to a subtree. For S3 a bare prefix reads as a BASE FOLDER: its
  // literal leading segment (up to the first wildcard, per `deriveScopePrefix`)
  // is pushed down to the ListObjectsV2 `Prefix`, so the walk lists only that
  // subtree SERVER-SIDE — real cost control on a large bucket, not just a
  // client-side filter. Empty = mirror the whole bucket.
  {
    key: 'config.import_scope',
    label: 'Base folder / prefix (optional)',
    type: 'text',
    optional: true,
    placeholder: 'invoices/',
    help:
      'A key prefix such as `invoices/` mirrors just that folder — recommended '
      + 'for large buckets, since it scopes the S3 list call server-side rather '
      + 'than after the fact. Globs work too (`invoices/**`, `**/*.pdf`). Leave '
      + 'blank to mirror the whole bucket. Metadata only — object contents are '
      + 'never fetched.',
  },
  // S3 auth is always the access-key/secret pair carried as `basic`. Hidden +
  // seeded, mirroring the other vendors' locked `auth.type`.
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['basic'],
    help: 'S3 uses an access-key-id + secret-access-key pair.',
    hidden: true,
  },
  {
    key: 'auth.username',
    label: 'Access Key ID',
    type: 'text',
    help: 'Your AWS (or S3-compatible) access key ID.',
  },
  {
    key: 'auth.password',
    label: 'Secret Access Key',
    type: 'secret',
    help: 'The secret access key paired with the access key ID.',
  },
];

/** Initial form values keyed by dotted-path schema key. No base URL (S3 URLs
 *  are region/bucket/endpoint-derived per request) and no token endpoint
 *  (S3 is not OAuth). */
export const S3_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  'config.vendor': 's3',
  'auth.type': 'basic',
};

export const s3Schema: VendorConnectionSchema = {
  vendor: 's3',
  kind: 'api',
  label: 'Amazon S3',
  description:
    'Object storage — mirror object metadata from an S3 (or S3-compatible: MinIO / R2 / B2) bucket into your warehouse (bytes never fetched). Access-key auth.',
  fields: S3_FIELDS,
  initialValues: S3_SCHEMA_INITIAL_VALUES,
};
