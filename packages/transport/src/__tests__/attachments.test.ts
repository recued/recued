import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscordTransport, createSlackTransport, createTelegramTransport, type OutboundAttachment } from '../index.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'transport-files-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'private-file');
  const bytes = Buffer.from('%PDF-original 🐈\0binary\xff'); writeFileSync(path, bytes, { mode: 0o600 });
  const file: OutboundAttachment = { path, filename: 'Résumé 🐈.pdf', mime_type: 'application/pdf', size: bytes.length,
    token: 'private-token', recipient: '123', reply_to_message_id: '456', delivery_id: 'stable-attempt',
  };
  return { dir, bytes, file };
};

describe('attachment upload protocols', () => {
  it.each(['telegram', 'discord'] as const)('%s streams original bytes and filename in one multipart publication', async vendor => {
    const f = fixture(); let calls = 0;
    const beforeSend = vi.fn(async () => {});
    const fetchImpl: typeof fetch = async (input, init) => {
      calls++; expect(beforeSend).toHaveBeenCalledTimes(1); expect(init?.redirect).toBe('error');
      expect(String(input)).toBe(vendor === 'telegram' ? 'https://api.telegram.org/botprivate-token/sendDocument'
        : 'https://discord.com/api/v10/channels/123/messages');
      expect(new Headers(init?.headers).get('content-type')).toBeNull();
      expect(new Headers(init?.headers).get('authorization')).toBe(vendor === 'discord' ? 'Bot private-token' : null);
      const body = init?.body; expect(body).toBeInstanceOf(FormData);
      if (!(body instanceof FormData)) throw new Error('Expected multipart upload');
      const data = body.get(vendor === 'telegram' ? 'document' : 'files[0]');
      if (!(data instanceof File)) throw new Error('Expected file body');
      expect(data.name).toBe(f.file.filename); expect(data.type).toBe('application/pdf');
      expect(Buffer.from(await data.arrayBuffer())).toEqual(f.bytes);
      if (vendor === 'telegram') {
        expect(body.get('chat_id')).toBe('123'); expect(body.get('message_thread_id')).toBe('77');
        expect(JSON.parse(String(body.get('reply_parameters')))).toEqual({ message_id: 456 });
      } else expect(JSON.parse(String(body.get('payload_json')))).toEqual({
        attachments: [{ id: 0, filename: f.file.filename }], allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: '456', fail_if_not_exists: true }, nonce: 'stable-attempt', enforce_nonce: true,
      });
      return Response.json(vendor === 'telegram' ? { ok: true, result: { message_id: 789 } } : { id: '789' });
    };
    const transport = vendor === 'telegram' ? createTelegramTransport({ fetchImpl }) : createDiscordTransport({ fetchImpl });
    expect(await transport.sendAttachment!({ ...f.file, thread_id: '77', beforeSend })).toEqual({ ok: true, vendor_message_id: '789' });
    expect(calls).toBe(1);
  });

  it('Slack reserves, streams without credentials, and explicitly publishes to the bound parent thread', async () => {
    const f = fixture(); const calls: string[] = []; const beforeSend = vi.fn(async () => {});
    const transport = createSlackTransport({ fetchImpl: async (input, init) => {
      const url = String(input); calls.push(url); expect(init?.redirect).toBe('error');
      expect(beforeSend).toHaveBeenCalledTimes(calls.length);
      if (calls.length === 1) {
        expect(url).toBe('https://slack.com/api/files.getUploadURLExternal');
        expect(new URLSearchParams(String(init?.body)).get('filename')).toBe(f.file.filename);
        expect(new URLSearchParams(String(init?.body)).get('length')).toBe(String(f.bytes.length));
        return Response.json({ ok: true, file_id: 'F1', upload_url: 'https://files.slack.com/upload/v1/signed' });
      }
      if (calls.length === 2) {
        expect(url).toBe('https://files.slack.com/upload/v1/signed');
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        if (!(init?.body instanceof Blob)) throw new Error('Expected streamed blob');
        expect(Buffer.from(await init.body.arrayBuffer())).toEqual(f.bytes);
        return new Response(`OK - ${f.bytes.length}`);
      }
      expect(url).toBe('https://slack.com/api/files.completeUploadExternal');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token');
      expect(JSON.parse(String(init?.body))).toEqual({ files: [{ id: 'F1', title: f.file.filename }], channel_id: 'C1', thread_ts: '111.000001' });
      return Response.json({ ok: true, files: [{ id: 'F1' }] });
    } });
    expect(await transport.sendAttachment!({ ...f.file, recipient: 'C1', thread_id: '111.000001', beforeSend }))
      .toEqual({ ok: true, vendor_file_id: 'F1' });
    expect(calls).toHaveLength(3);
  });

  it.each(['https://evil.example/upload/v1/x', 'http://files.slack.com/upload/x', 'https://user:pass@files.slack.com/upload/x',
    'https://files.slack.com:8443/upload/x', 'https://files.slack.com/other/x'])('refuses an untrusted Slack upload URL: %s', async url => {
    const f = fixture(); const fetchImpl = vi.fn(async () => Response.json({ ok: true, file_id: 'F1', upload_url: url }));
    const result = await createSlackTransport({ fetchImpl }).sendAttachment!(f.file);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } }); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rechecks authority after Slack has accepted staged bytes and prevents publication after revocation', async () => {
    const f = fixture(); let phases = 0;
    const fetchImpl = vi.fn(async () => phases === 1
      ? Response.json({ ok: true, file_id: 'F1', upload_url: 'https://files.slack.com/upload/v1/one' }) : new Response('OK - bytes'));
    const beforeSend = async () => { if (++phases === 3) throw new Error('connection revoked'); };
    await expect(createSlackTransport({ fetchImpl }).sendAttachment!({ ...f.file, beforeSend })).rejects.toThrow('connection revoked');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['missing_scope', 'internal_error', 'bad_receipt'] as const)('retains the distinction between Slack %s and confirmed publication', async failure => {
    const f = fixture(); let call = 0;
    const transport = createSlackTransport({ fetchImpl: async () => {
      if (++call === 1) return Response.json({ ok: true, file_id: 'F1', upload_url: 'https://files.slack.com/upload/v1/one' });
      if (call === 2) return new Response('OK - bytes');
      return Response.json(failure === 'bad_receipt' ? { ok: true, files: [{ id: 'another-file' }] } : { ok: false, error: failure });
    } });
    expect(await transport.sendAttachment!(f.file)).toMatchObject({ ok: false,
      error: { kind: failure === 'missing_scope' ? 'auth' : failure === 'internal_error' ? 'vendor_error' : 'network' },
    });
  });

  it.each(['telegram', 'discord', 'slack'] as const)('%s treats a rejected oversized upload as a definite failure', async vendor => {
    const f = fixture(); const fetchImpl: typeof fetch = async () => new Response('too large', { status: 413 });
    const transport = vendor === 'telegram' ? createTelegramTransport({ fetchImpl })
      : vendor === 'discord' ? createDiscordTransport({ fetchImpl }) : createSlackTransport({ fetchImpl });
    expect(await transport.sendAttachment!(f.file)).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });

  it('refuses a size mismatch without any network request', async () => {
    const f = fixture(); const fetchImpl = vi.fn();
    await expect(createDiscordTransport({ fetchImpl }).sendAttachment!({ ...f.file, size: f.file.size + 1 })).rejects.toThrow('bytes changed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Discord inbound file download', () => {
  it('downloads from the pinned CDN without bot credentials and preserves the original filename', async () => {
    const f = fixture(); const transport = createDiscordTransport({ downloadDir: f.dir, fetchImpl: async (input, init) => {
      expect(String(input)).toBe('https://cdn.discordapp.com/attachments/1/2/file?signature=fixture');
      expect(new Headers(init?.headers).has('authorization')).toBe(false); expect(init?.redirect).toBe('error');
      return new Response(new Uint8Array(f.bytes), { headers: { 'Content-Type': 'application/pdf' } });
    } });
    const inbound = transport.parseInbound({ id: '3', channel_id: '1', author: { id: 'owner' }, content: '',
      attachments: [{ id: '2', filename: f.file.filename, url: 'https://cdn.discordapp.com/attachments/1/2/file?signature=fixture', content_type: 'application/pdf', size: f.bytes.length }],
    });
    expect(inbound?.media).toHaveLength(1);
    const result = await transport.fetchMedia!(inbound!.media![0]!, 'must-not-leak');
    expect(result).toMatchObject({ filename: f.file.filename, size: f.bytes.length, mime_type: 'application/pdf' });
  });
  it.each(['https://evil.example/file', 'https://cdn.discordapp.com.evil.example/attachments/1',
    'https://user@cdn.discordapp.com/attachments/1', 'https://cdn.discordapp.com/other/1'])('rejects %s before download', async remote_url => {
    const f = fixture(); const fetchImpl = vi.fn(); const before = readdirSync(f.dir);
    await expect(createDiscordTransport({ downloadDir: f.dir, fetchImpl }).fetchMedia!({ remote_url, mime: 'text/plain', type: 'file', size: 1 }, 'secret')).rejects.toThrow('destination');
    expect(fetchImpl).not.toHaveBeenCalled(); expect(readdirSync(f.dir)).toEqual(before);
  });
});
