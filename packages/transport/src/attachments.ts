/** File sends share the transports' HTTP boundary. Every call publishes one
 * attachment; receipts belong to the caller's durable delivery journal. */
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { classifyHttpError, postFileBody, postJson, retryAfterSeconds, type HttpPostOutcome } from './http.js';
import type { OutboundAttachment, TransportSendResult } from './types.js';

interface Options { fetchImpl: typeof fetch; timeoutMs: number }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const attachmentFilename = (name: string | undefined, fallback = 'attachment'): string => {
  const base = name?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '_');
  return base && base !== '.' && base !== '..' ? base : fallback;
};
const invalid = (detail: string): TransportSendResult => ({ ok: false, error: { kind: 'invalid_request', detail } });
const missing = (): TransportSendResult => ({ ok: false, error: { kind: 'network', detail: 'Attachment receipt unavailable.' } });
const failure = (outcome: HttpPostOutcome): TransportSendResult | undefined => {
  if (outcome.ok) return undefined;
  return { ok: false, error: {
    kind: outcome.kind === 'http_error'
      ? ([400, 404, 413, 422].includes(outcome.status) ? 'invalid_request' : classifyHttpError(outcome.status)) : outcome.kind,
    detail: 'Attachment request failed.',
    ...(outcome.kind === 'http_error' && outcome.retry_after_ms !== undefined ? { retry_after_ms: outcome.retry_after_ms } : {}),
  } };
};
const blob = async (file: OutboundAttachment): Promise<Blob> => {
  const info = await stat(file.path);
  if (!info.isFile() || !Number.isSafeInteger(file.size) || file.size < 0 || info.size !== file.size) {
    throw new Error('Attachment bytes changed before upload.');
  }
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.mime_type) ? file.mime_type : 'application/octet-stream';
  return openAsBlob(file.path, { type });
};

export const sendTelegramAttachment = async (file: OutboundAttachment, options: Options): Promise<TransportSendResult> => {
  if ([file.reply_to_message_id, file.thread_id].some(id => id !== undefined
    && (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))))) return invalid('Invalid Telegram reply or thread.');
  const body = new FormData();
  body.set('chat_id', file.recipient);
  body.set('document', await blob(file), attachmentFilename(file.filename));
  if (file.thread_id) body.set('message_thread_id', file.thread_id);
  if (file.reply_to_message_id) body.set('reply_parameters', JSON.stringify({ message_id: Number(file.reply_to_message_id) }));
  await file.beforeSend?.();
  const outcome = await postFileBody(`https://api.telegram.org/bot${file.token}/sendDocument`, {
    ...options, headers: {}, body,
  });
  const error = failure(outcome); if (error) return error;
  if (!outcome.ok || !record(outcome.json)) return missing();
  const env = outcome.json;
  if (env.ok === false) return { ok: false, error: {
    kind: env.error_code === 429 ? 'rate_limited' : env.error_code === 401 || env.error_code === 403 ? 'auth'
      : env.error_code === 400 ? 'invalid_request' : 'vendor_error',
    detail: 'Telegram rejected the attachment.',
    ...(record(env.parameters) && retryAfterSeconds(env.parameters.retry_after) !== undefined
      ? { retry_after_ms: retryAfterSeconds(env.parameters.retry_after)! } : {}),
  } };
  if (env.ok !== true || !record(env.result) || !Number.isSafeInteger(env.result.message_id)) return missing();
  return { ok: true, vendor_message_id: String(env.result.message_id) };
};

export const sendDiscordAttachment = async (file: OutboundAttachment, options: Options): Promise<TransportSendResult> => {
  const filename = attachmentFilename(file.filename);
  const body = new FormData();
  body.set('files[0]', await blob(file), filename);
  body.set('payload_json', JSON.stringify({
    attachments: [{ id: 0, filename }], allowed_mentions: { parse: [], replied_user: false },
    ...(file.delivery_id ? { nonce: file.delivery_id, enforce_nonce: true } : {}),
    ...(file.reply_to_message_id ? { message_reference: { message_id: file.reply_to_message_id, fail_if_not_exists: true } } : {}),
  }));
  await file.beforeSend?.();
  const outcome = await postFileBody(`https://discord.com/api/v10/channels/${encodeURIComponent(file.recipient)}/messages`, {
    ...options, headers: { Authorization: `Bot ${file.token}` }, body,
  });
  const error = failure(outcome); if (error) return error;
  if (!outcome.ok || !record(outcome.json) || typeof outcome.json.id !== 'string' || !outcome.json.id) return missing();
  return { ok: true, vendor_message_id: outcome.json.id };
};

const slackFailure = (outcome: HttpPostOutcome): TransportSendResult | undefined => {
  const http = failure(outcome); if (http) return http;
  if (!outcome.ok || !record(outcome.json)) return missing();
  if (outcome.json.ok === true) return undefined;
  if (outcome.json.ok !== false) return missing();
  const code = outcome.json.error;
  return { ok: false, error: {
    kind: code === 'ratelimited' ? 'rate_limited'
      : ['not_authed', 'invalid_auth', 'token_revoked', 'missing_scope', 'account_inactive'].includes(String(code)) ? 'auth'
        : ['invalid_arguments', 'invalid_arg_name', 'invalid_array_arg', 'invalid_channel', 'channel_not_found', 'not_in_channel',
          'is_archived', 'file_not_found', 'file_uploads_disabled', 'file_too_large', 'no_file_data', 'invalid_thread_ts'].includes(String(code)) ? 'invalid_request' : 'vendor_error',
    detail: 'Slack rejected the attachment.',
  } };
};

export const sendSlackAttachment = async (file: OutboundAttachment, options: Options): Promise<TransportSendResult> => {
  if (!file.recipient) return invalid('Slack attachments require a destination.');
  const data = await blob(file);
  const filename = attachmentFilename(file.filename);
  const headers = { Authorization: `Bearer ${file.token}`, 'Content-Type': 'application/json; charset=utf-8' };
  await file.beforeSend?.();
  const reservation = await postJson('https://slack.com/api/files.getUploadURLExternal', {
    ...options, headers: { Authorization: headers.Authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ filename, length: String(file.size) }).toString(),
  });
  const reservedError = slackFailure(reservation); if (reservedError) return reservedError;
  if (!reservation.ok || !record(reservation.json) || typeof reservation.json.upload_url !== 'string'
    || typeof reservation.json.file_id !== 'string' || !reservation.json.file_id) return missing();
  const id = reservation.json.file_id;
  let upload: URL;
  try { upload = new URL(reservation.json.upload_url); } catch { return invalid('Invalid Slack upload destination.'); }
  // A vendor response cannot send owner bytes or credentials to an arbitrary
  // host. The signed upload URL needs no bearer token and cannot redirect.
  if (upload.protocol !== 'https:' || upload.hostname !== 'files.slack.com' || upload.port
    || upload.username || upload.password || !upload.pathname.startsWith('/upload/')) return invalid('Invalid Slack upload destination.');
  await file.beforeSend?.();
  const uploaded = await postFileBody(upload.href, {
    ...options, headers: { 'Content-Type': 'application/octet-stream' }, body: data, responseText: true,
  });
  const uploadedError = failure(uploaded); if (uploadedError) return uploadedError;
  const thread = file.thread_id ?? file.reply_to_message_id;
  await file.beforeSend?.();
  const completed = await postJson('https://slack.com/api/files.completeUploadExternal', {
    ...options, headers, body: JSON.stringify({ files: [{ id, title: filename }], channel_id: file.recipient,
      ...(thread ? { thread_ts: thread } : {}),
    }),
  });
  const completedError = slackFailure(completed); if (completedError) return completedError;
  if (!completed.ok || !record(completed.json) || !Array.isArray(completed.json.files)) return missing();
  const receipt = completed.json.files.find((value: unknown) => record(value) && value.id === id);
  if (!record(receipt)) return missing();
  // Slack confirms publication by file ID. It does not promise a message ts in
  // this envelope; never use an F… file ID as a chat reply/thread timestamp.
  let ts: string | undefined;
  if (record(receipt.shares)) for (const visibility of ['public', 'private']) {
    const group = receipt.shares[visibility];
    const shares = record(group) ? group[file.recipient] : undefined;
    if (Array.isArray(shares)) for (const share of shares) {
      if (record(share) && typeof share.ts === 'string' && share.ts) ts = share.ts;
    }
  }
  return { ok: true, vendor_file_id: id, ...(ts ? { vendor_message_id: ts } : {}) };
};
