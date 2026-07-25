/** SMB-finance wedge slice 3 — connection.api response_capture (binary) mode.
 *
 *  When the engine sets the `__rc_capture` wire key (storage-gdrive
 *  `file.download`), the handler reads the raw response BODY (arrayBuffer) and
 *  returns `{ status, headers, bytes_b64, mime_type, filename }` instead of
 *  JSON/text-parsing it — so the catalog gateway can ingest the bytes into the
 *  CAS and return a `file_ref`. A recipe can never set `__rc_capture` (the
 *  gateway strips the `__rc_` prefix); these tests drive the wire key directly,
 *  as the gateway would. */

import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import type { ConnectionApiHandlerDeps } from '../connection-api.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const row: ConnectionRow = {
  pk: 'api:google',
  kind: 'api',
  name: 'google',
  display_name: 'Google Drive',
  config_json: '{"base_url":"https://www.googleapis.com/drive/v3"}',
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const auth: ConnectionAuth = { type: 'bearer', token: 'tok' };

const mkCall = (input: Record<string, unknown>): ResolvedCall => ({
  slug: 'google-drive',
  risk_tier: 'read',
  input,
  output: {},
});

const mkHandler = (response: Response): { deps: ConnectionApiHandlerDeps } => ({
  deps: {
    decodeAuth: async () => auth,
    persistAuth: async () => {},
    fetchImpl: (async () => response) as unknown as typeof fetch,
  },
});

const captureInput = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'GET',
  path: '/files/abc',
  connection_kind: 'api',
  connection: 'google',
  'query.alt': 'media',
  __rc_capture: '1',
  __rc_mime: 'application/octet-stream',
  ...extra,
});

describe('connection.api — response_capture (binary) mode', () => {
  it('returns base64 bytes + mime + filename instead of JSON-parsing', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="invoice.pdf"' },
    });
    const { deps } = mkHandler(response);
    const handler = createConnectionApiHandler(deps);

    const out = (await handler(row, captureInput(), mkCall(captureInput()))) as Record<string, unknown>;

    expect(out.status).toBe(200);
    expect(out.bytes_b64).toBe(Buffer.from(bytes).toString('base64'));
    // server-detected content-type wins (params stripped)
    expect(out.mime_type).toBe('application/pdf');
    // header filename used when no filename arg supplied
    expect(out.filename).toBe('invoice.pdf');
    // NOT the normal {status, headers, result} JSON shape
    expect(out.result).toBeUndefined();
  });

  it('prefers the __rc_filename arg over Content-Disposition', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="from-header.png"' },
    });
    const { deps } = mkHandler(response);
    const handler = createConnectionApiHandler(deps);
    const input = captureInput({ __rc_filename: 'receipt.png' });

    const out = (await handler(row, input, mkCall(input))) as Record<string, unknown>;
    expect(out.filename).toBe('receipt.png');
    expect(out.mime_type).toBe('image/png');
  });

  it('falls back to the spec mime + "download" filename when the response declares neither', async () => {
    const response = new Response(new Uint8Array([9]), { status: 200 });
    const { deps } = mkHandler(response);
    const handler = createConnectionApiHandler(deps);
    const input = captureInput();

    const out = (await handler(row, input, mkCall(input))) as Record<string, unknown>;
    // no content-type → spec fallback mime (__rc_mime); no content-disposition → 'download'
    expect(out.mime_type).toBe('application/octet-stream');
    expect(out.filename).toBe('download');
  });

  it('rejects a download whose Content-Length exceeds the cap (before buffering)', async () => {
    const response = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
    });
    const { deps } = mkHandler(response);
    const handler = createConnectionApiHandler(deps);
    const input = captureInput();

    await expect(handler(row, input, mkCall(input))).rejects.toBeInstanceOf(IngredientError);
  });

  it('does NOT binary-capture a normal call (no __rc_capture) — returns the parsed JSON shape', async () => {
    const response = new Response(JSON.stringify({ files: [{ id: 'x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { deps } = mkHandler(response);
    const handler = createConnectionApiHandler(deps);
    const input: Record<string, unknown> = { method: 'GET', path: '/files', connection_kind: 'api', connection: 'google' };

    const out = (await handler(row, input, mkCall(input))) as Record<string, unknown>;
    expect(out.bytes_b64).toBeUndefined();
    expect((out.result as { files?: unknown }).files).toEqual([{ id: 'x' }]);
  });
});
