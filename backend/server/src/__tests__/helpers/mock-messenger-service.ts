import { createServer, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export type MockMessengerVendor = 'telegram' | 'slack' | 'discord';
type JsonObject = Record<string, unknown>;
export interface MockMessengerEvent {
  cursor: number;
  envelopeId: string;
  payload: JsonObject;
}
export interface MockMessengerFile { filename: string; mime_type: string; bytes: Buffer }

const object = (text: string): JsonObject => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as JsonObject;
};
const json = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

/** One loopback service owns BOTH native intake and outbound receipts. The
 * production fetch/socket seams only redirect known vendor URLs here; real
 * HTTP, WebSocket framing, dispatch, SQLite admission and transport code run.
 * No vendor credentials or external network access are needed. */
export const createMockMessengerService = async (vendor: MockMessengerVendor) => {
  const botToken = 'fixture-bot-token';
  const appToken = 'fixture-app-token';
  const recipient = vendor === 'telegram' ? '-123' : vendor === 'slack' ? 'C123' : '1234';
  const thread = '1710000000.000001';
  const apiOrigin = `https://${vendor === 'telegram' ? 'api.telegram.org' : `${vendor}.com`}`;
  const sendPath = vendor === 'telegram' ? `/bot${botToken}/sendMessage`
    : vendor === 'slack' ? '/api/chat.postMessage' : `/api/v10/channels/${recipient}/messages`;
  const identityPath = vendor === 'telegram' ? `/bot${botToken}/getMe`
    : vendor === 'slack' ? '/api/auth.test' : '/api/v10/users/@me';
  const receivePaths = vendor === 'telegram' ? [`/bot${botToken}/deleteWebhook`, `/bot${botToken}/getUpdates`]
    : vendor === 'slack' ? ['/api/apps.connections.open'] : ['/api/v10/gateway/bot'];
  const socketUrl = vendor === 'slack' ? 'wss://wss-primary.slack.com/link/?ticket=fixture'
    : 'wss://gateway.discord.gg';
  const events: MockMessengerEvent[] = [];
  const posts: Array<{ id: string; text: string; body: JsonObject; echo: MockMessengerEvent; file?: MockMessengerFile }> = [];
  const incomingFiles = new Map<string, MockMessengerFile>();
  const stagedFiles = new Map<string, { filename: string; length: number; bytes?: Buffer }>();
  const requests: Array<{ path: string; body: JsonObject }> = [];
  const frames: Array<{ connection: number; body: JsonObject }> = [];
  const acknowledgements = new Set<string>();
  const lostAcknowledgements: string[] = [];
  const errors: string[] = [];
  const sockets = new Set<WebSocket>();
  let socket: WebSocket | undefined;
  let socketReady = false;
  let connections = 0;
  let cursor = vendor === 'telegram' ? 40 : vendor === 'discord' ? 10 : 0;
  let pendingPoll: { offset: number; response: ServerResponse } | undefined;
  let releasePost: (() => void) | undefined;
  let heldPost: Promise<void> | undefined;
  let loseNextAck = false;
  let omitSenderIdentity = false;

  const sendEvent = (event: MockMessengerEvent): void => {
    if (!socketReady || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(vendor === 'slack'
      ? { envelope_id: event.envelopeId, type: 'events_api', payload: event.payload }
      : { op: 0, t: 'MESSAGE_CREATE', s: event.cursor, d: event.payload }));
  };
  const flushPoll = (): void => {
    if (!pendingPoll) return;
    const available = events.filter(event => event.cursor >= pendingPoll!.offset);
    if (available.length === 0) return;
    const { response } = pendingPoll;
    pendingPoll = undefined;
    json(response, { ok: true, result: available.map(event => ({ update_id: event.cursor, ...event.payload })) });
  };
  const receive = (text: string, id: string, options: { bot?: boolean; replyTo?: string; file?: MockMessengerFile } = {}): MockMessengerEvent => {
    const bot = options.bot ?? false;
    const file = options.file;
    if (file) incomingFiles.set(id, file);
    const fileUrl = vendor === 'slack' ? `https://files.slack.com/files-pri/${id}`
      : `https://cdn.discordapp.com/attachments/${recipient}/${id}/file`;
    const payload: JsonObject = vendor === 'telegram' ? {
      message: { message_id: Number(id), message_thread_id: 77, chat: { id: Number(recipient) },
        from: { id: bot ? 123 : 456, is_bot: bot }, text,
        ...(file ? { document: { file_id: id, file_name: file.filename, mime_type: file.mime_type, file_size: file.bytes.length } } : {}),
        ...(options.replyTo ? { reply_to_message: { message_id: Number(options.replyTo) } } : {}),
      },
    } : vendor === 'slack' ? {
      type: 'event_callback', event_id: `Ev-${cursor + 1}`,
      event: { type: 'message', channel: recipient, user: bot ? 'UBOT' : 'U1', ts: id, thread_ts: thread, text,
        ...(file ? { files: [{ id, name: file.filename, mimetype: file.mime_type, size: file.bytes.length, url_private_download: fileUrl }] } : {}),
        // File-share echoes can identify the bot only by its user ID. Emit
        // them before the upload receipt to exercise production self-filtering.
        ...(bot && !file ? { bot_id: 'B1' } : {}),
      },
    } : {
      id, channel_id: recipient, author: { id: bot ? '123' : '456', bot }, content: text,
      ...(file ? { attachments: [{ id, filename: file.filename, content_type: file.mime_type, size: file.bytes.length, url: fileUrl }] } : {}),
      ...(options.replyTo ? { message_reference: { message_id: options.replyTo } } : {}),
    };
    const event = { cursor: ++cursor, envelopeId: `env-${cursor}`, payload };
    events.push(event);
    if (vendor === 'telegram') flushPoll(); else sendEvent(event);
    return event;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const contentType = request.headers['content-type'] ?? '';
      let file: MockMessengerFile | undefined;
      let body: JsonObject;
      if (contentType.startsWith('multipart/form-data')) {
        const form = await new Request('http://fixture', { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': contentType } }).formData();
        body = typeof form.get('payload_json') === 'string' ? object(String(form.get('payload_json'))) : {};
        for (const [name, value] of form) {
          if (typeof value === 'string' && name !== 'payload_json') {
            body[name] = name === 'reply_parameters' ? object(value) : name === 'message_thread_id' ? Number(value) : value;
          } else if (typeof value !== 'string') file = { filename: value.name, mime_type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
        }
      } else if (contentType.startsWith('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(bytes.toString()));
      else body = contentType === 'application/octet-stream' ? {} : bytes.length ? object(bytes.toString()) : {};
      const path = request.url!;
      requests.push({ path, body });
      const download = path.startsWith('/file/') || path.startsWith('/files-pri/') || path.startsWith('/attachments/');
      const upload = path.startsWith('/upload/v1/');
      const method = download || (vendor === 'discord' && path !== sendPath) ? 'GET' : 'POST';
      if (request.method !== method) throw new Error(`Incorrect HTTP method for ${path}`);
      if (vendor !== 'telegram' && !upload && !(vendor === 'discord' && download)) {
        const auth = path.endsWith('apps.connections.open') ? `Bearer ${appToken}`
          : `${vendor === 'slack' ? 'Bearer' : 'Bot'} ${botToken}`;
        if (request.headers.authorization !== auth) throw new Error(`Incorrect authorization for ${path}`);
      }
      if ((upload || (vendor === 'discord' && download)) && request.headers.authorization) throw new Error('Token leaked to file host');
      if (download) {
        const id = path.startsWith('/attachments/') ? path.split('/')[3]! : path.split('/').pop()!;
        const original = incomingFiles.get(id); if (!original) throw new Error('Unknown native file');
        response.writeHead(200, { 'Content-Type': original.mime_type }); response.end(original.bytes);
      } else if (path.endsWith('/getFile') || path.endsWith('/files.info')) {
        const id = String(body.file_id ?? body.file); const original = incomingFiles.get(id);
        if (!original) throw new Error('Unknown file ID');
        json(response, vendor === 'telegram' ? { ok: true, result: { file_path: `documents/${id}` } }
          : { ok: true, file: { name: original.filename, mimetype: original.mime_type, url_private_download: `https://files.slack.com/files-pri/${id}` } });
      } else if (path.endsWith('/files.getUploadURLExternal')) {
        const id = `F${stagedFiles.size + 1}`;
        stagedFiles.set(id, { filename: String(body.filename), length: Number(body.length) });
        json(response, { ok: true, file_id: id, upload_url: `https://files.slack.com/upload/v1/${id}` });
      } else if (upload) {
        const staged = stagedFiles.get(path.split('/').pop()!); if (!staged || bytes.length !== staged.length) throw new Error('Invalid upload');
        staged.bytes = bytes; response.writeHead(200); response.end(`OK - ${bytes.length}`);
      } else if (path === identityPath) {
        json(response, vendor === 'telegram' ? { ok: true, result: { id: 123, is_bot: true } }
          : vendor === 'slack' ? { ok: true, team_id: 'T1', bot_id: 'B1', ...(omitSenderIdentity ? {} : { user_id: 'UBOT' }) } : { id: '123', bot: true });
      } else if (path.endsWith('/deleteWebhook')) {
        if (body.drop_pending_updates !== false) throw new Error('Polling must retain pending updates');
        json(response, { ok: true, result: true });
      } else if (path.endsWith('/getUpdates')) {
        if (pendingPoll) throw new Error('Overlapping Telegram polls');
        pendingPoll = { offset: Number(body.offset), response };
        response.on('close', () => { if (pendingPoll?.response === response) pendingPoll = undefined; });
        flushPoll();
      } else if (receivePaths.includes(path)) {
        json(response, { ok: true, url: socketUrl });
      } else if (path === sendPath || path.endsWith('/sendDocument') || path.endsWith('/files.completeUploadExternal')) {
        const id = String(1000 + posts.length);
        const completion = path.endsWith('/files.completeUploadExternal');
        let fileId: string | undefined;
        if (completion) {
          const references = body.files;
          if (!Array.isArray(references) || body.channel_id !== recipient) throw new Error('File must publish to bound channel');
          fileId = String(object(JSON.stringify(references[0])).id);
          const staged = stagedFiles.get(fileId); if (!staged?.bytes) throw new Error('Unuploaded file');
          file = { filename: staged.filename, mime_type: 'application/octet-stream', bytes: staged.bytes };
        }
        const message = String(body.text ?? body.content ?? '');
        // Echo travels through the same receive runner, including while the
        // outbound HTTP receipt is held or its acknowledgement is lost.
        const echo = receive(message, id, { bot: true, ...(file ? { file } : {}) });
        posts.push({ id, text: message, body, echo, ...(file ? { file } : {}) });
        if (heldPost) await heldPost;
        json(response, vendor === 'telegram' ? { ok: true, result: { message_id: Number(id) } }
          : vendor === 'slack' ? completion ? { ok: true, files: [{ id: fileId }] } : { ok: true, ts: id, channel: recipient } : { id });
      } else {
        throw new Error(`Unexpected mock endpoint ${path}`);
      }
    })().catch((error: unknown) => {
      errors.push(String(error));
      response.writeHead(500); response.end();
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    const connection = ++connections;
    sockets.add(ws); socket = ws; socketReady = vendor === 'slack';
    ws.on('error', error => errors.push(error.message));
    ws.on('close', () => {
      sockets.delete(ws);
      if (socket === ws) { socket = undefined; socketReady = false; }
    });
    ws.on('message', data => {
      const body = object(data.toString());
      frames.push({ connection, body });
      if (vendor === 'slack') {
        if (loseNextAck) {
          loseNextAck = false;
          lostAcknowledgements.push(String(body.envelope_id));
          ws.close(4000, 'mock lost acknowledgement');
        } else acknowledgements.add(String(body.envelope_id));
      } else if (body.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      } else if (body.op === 2 || body.op === 6) {
        const resume = body.op === 6 ? Number(object(JSON.stringify(body.d)).seq) : 10;
        socketReady = true;
        if (body.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 10,
          d: { session_id: 'fixture-session', resume_gateway_url: socketUrl } }));
        for (const event of events.filter(event => event.cursor > resume)) sendEvent(event);
        if (body.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: ++cursor, d: {} }));
      }
    });
    if (vendor === 'slack') {
      for (const event of events.filter(event => !acknowledgements.has(event.envelopeId))) sendEvent(event);
    } else ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const base = `http://127.0.0.1:${address.port}`;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const fileApiPaths = vendor === 'telegram' ? [`/bot${botToken}/sendDocument`, `/bot${botToken}/getFile`]
      : vendor === 'slack' ? ['/api/files.getUploadURLExternal', '/api/files.completeUploadExternal', '/api/files.info'] : [];
    const fileHost = vendor === 'slack' ? url.origin === 'https://files.slack.com' && /^\/(upload\/v1|files-pri)\//.test(url.pathname)
      : vendor === 'discord' ? url.origin === 'https://cdn.discordapp.com' && url.pathname.startsWith(`/attachments/${recipient}/`)
        : url.origin === apiOrigin && url.pathname.startsWith(`/file/bot${botToken}/documents/`);
    if (!fileHost && (url.origin !== apiOrigin || ![identityPath, sendPath, ...receivePaths, ...fileApiPaths].includes(url.pathname))) {
      throw new Error(`Unexpected vendor URL: ${url.origin}${url.pathname}`);
    }
    return fetch(new URL(url.pathname, base), init);
  };
  const webSocketFactory = (input: string): WebSocket => {
    const url = new URL(input);
    if (url.origin !== new URL(socketUrl).origin || url.pathname !== new URL(socketUrl).pathname) {
      throw new Error('Unexpected vendor socket URL');
    }
    return new WebSocket(base.replace('http:', 'ws:'));
  };

  return {
    vendor, recipient, botToken, appToken, thread, events, posts, requests, frames, acknowledgements, lostAcknowledgements, errors,
    fetchImpl, webSocketFactory, receive,
    get connections() { return connections; },
    holdPosts() { heldPost = new Promise<void>(resolve => { releasePost = resolve; }); },
    releasePosts() { releasePost?.(); heldPost = undefined; },
    loseAcknowledgement() { loseNextAck = true; },
    omitSenderIdentity() { omitSenderIdentity = true; },
    async close() {
      releasePost?.();
      for (const ws of sockets) ws.terminate();
      pendingPoll?.response.destroy(); pendingPoll = undefined;
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};
