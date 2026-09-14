/** D-265: verified Messenger ingress acknowledges encrypted durable admission.
 * All surfaces share one session FIFO; delivery and execution have separate
 * progress. The bound conversation remains the Messenger authority boundary. */

import { createMessengerAccountResolver } from './messenger-account-identity.js';
import { createMessengerAttachmentSource } from '../../chat-messenger-attachments.js';
import { messengerConnectionRefusesTurn } from '../../messenger-connection-roles.js';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import {
  createMessengerChannel,
  type MessengerMediaFileSink,
} from '@recued/messenger';
import { type TransportVendor } from '@recued/transport';
import type { ChatOrchestrator } from '../../chat-orchestrator.js';
import { detectMailAttachmentMimeType } from '../../collections/mail/provider.js';
import { looksLikeAudio } from '../../collections/file/audio-magic.js';
import type { InboundFileCollection } from '../../collections/file/inbound-file-collection.js';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import {
  buildMessengerCredentialResolvers,
  buildMessengerTransports,
} from './messenger-transport-leaves.js';

/** Accept one verified inbound vendor payload for a messenger turn.
 *  Resolves `true` when the payload is a user message in the bound
 *  conversation and a turn was QUEUED (not run — the turn completes on
 *  the shared session queue after this resolves); `false` when the payload
 *  is not a user message, the vendor credential is unresolved, or the
 *  message arrived outside the bound conversation. Rejects transient admission failures so the source retries before acknowledging. */
export type MessengerTurnIngest = (
  vendor: TransportVendor,
  connection_name: string,
  payload: unknown,
) => Promise<boolean>;

/** Deterministic chat-session id for a vendor's bound conversation.
 *  Keyed on `(vendor, recipient)` — NOT the vendor alone — so a rebind
 *  of `channel_id` / `chat_id` starts a fresh session and the prior
 *  conversation's tail stays inside the access boundary it was built
 *  in; re-binding back to the old conversation resumes its session.
 *  Collision-proof against chat's UUID session ids by the `messenger:`
 *  prefix. */
export const messengerSessionId = (
  vendor: TransportVendor,
  recipient: string,
): string => `messenger:${vendor}:${recipient}`;

export interface ComposeMessengerTurnIngestDeps {
  /** The chat orchestrator — `runMessengerTurn` + the shared session
   *  store. Absent (dbless / pre-LLM boot) ⇒ composer returns
   *  undefined. */
  orchestrator?: ChatOrchestrator;
  /** Backs the per-vendor credential read. Absent ⇒ undefined (no
   *  rows to resolve against — same posture as the webhook port). */
  connectionStore?: ConnectionStoreSqlite;
  /** Optional sub-DEK source for the credential decode — re-read per
   *  call so a boot→unlock transition lands without a rebuild. */
  keys?: KeyManager;
  /** D-172 `received` collection — inbound media lands here as
   *  `origin: 'messenger_media'`. Absent ⇒ the channel's visible
   *  "file ingest is not configured" degrade. */
  fileCollection?: InboundFileCollection;
  /** Operator-facing diagnostics — the binding-gate refusal line is
   *  the one that matters (a stranger messaging the bot). */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
  /** Server-local scratch dir media downloads stream into before CAS ingest
   *  (D-172 streaming ingest). MUST be on the data volume, NOT a tmpfs `/tmp`
   *  (which would route a large download back through RAM). Absent ⇒ the
   *  transport default (`os.tmpdir()`). */
  downloadDir?: string;
  /** Test seams. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const credentialKey = (token: string): string => createHash('sha256').update(token).digest('hex');

// D-192 CORE #6 — the per-vendor conversation-shape extraction moved onto the
// `Transport.parseConversationId` method (Slack `event.channel`, Telegram
// `message.chat.id`). The turn's binding gate + the D-181 live-control composer
// both call `transport.parseConversationId(payload)` — no shared `switch(vendor)`.

/** Compose the messenger turn ingest. Returns `undefined` when the
 *  orchestrator or connection store is unwired — the dispatcher seam
 *  stays absent and inbound user messages keep the pre-slice posture
 *  (warehouse event + log). */
export const composeMessengerTurnIngest = (
  deps: ComposeMessengerTurnIngestDeps,
): MessengerTurnIngest | undefined => {
  const { orchestrator, connectionStore, fileCollection, log } = deps;
  if (!orchestrator || !connectionStore || !orchestrator.turnQueue) return undefined;
  const queue = orchestrator.turnQueue;
  const bridge = orchestrator.messengerBridge;
  const accountFor = createMessengerAccountResolver(deps.fetchImpl, deps.timeoutMs);
  const mirrored = (vendor: string): boolean => bridge !== undefined && ['slack', 'telegram', 'discord'].includes(vendor);

  // Claim the media scratch dir owner-only before any transport writes into it.
  // A download lands the vendor's photo / voice note / PDF there in PLAINTEXT
  // until the CAS ingest encrypts it, and the transports create the directory
  // lazily at Node's default 0777 & umask. Creating it first at 0700 makes the
  // tree untraversable to other local accounts, which is what actually protects
  // the files — the transports write them at the default 0666 & umask. Best
  // effort: an unwritable data volume surfaces on the download itself, and a
  // hygiene step must never fail the wiring.
  if (deps.downloadDir !== undefined) {
    try {
      mkdirSync(deps.downloadDir, { recursive: true, mode: 0o700 });
    } catch {
      /* surfaces on the first download instead */
    }
  }

  // D-192 CORE #6 — the vendor→transport and vendor→credential-resolver maps
  // are built by iterating the messenger registry + the slug-keyed leaves (no
  // hardcoded `{ slack, telegram }`; a new chat transport flows through with no
  // edit here). The factories `??`-default every option.
  const transports = buildMessengerTransports({
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    downloadDir: deps.downloadDir,
  });
  const resolveCredential = buildMessengerCredentialResolvers({
    connectionStore,
    ...(deps.keys ? { keys: deps.keys } : {}),
  });

  if (bridge) for (const vendor of ['slack', 'telegram', 'discord']) {
    bridge.register(vendor, {
      revision: () => {
        const row = connectionStore.get('notification', vendor);
        return createHash('sha256').update(JSON.stringify([
          row?.auth_ciphertext, row?.config_json, row?.subtype, deps.keys?.state(),
        ])).digest('hex');
      },
      resolve: async () => {
        if (messengerConnectionRefusesTurn(connectionStore, vendor, vendor)) return null;
        const credential = await resolveCredential[vendor]();
        return credential ? { ...credential, account: await accountFor(vendor, credential.token) } : null;
      },
      send: (message) => transports[vendor].send(message),
      ...(fileCollection && transports[vendor].sendAttachment ? {
        attachments: createMessengerAttachmentSource(fileCollection, deps.downloadDir),
        sendAttachment: transports[vendor].sendAttachment,
      } : {}),
    });
  }

  const fileSink: MessengerMediaFileSink | undefined = fileCollection
    ? {
        async ingest(input) {
          try {
            // D-172 N.1 — the stored mime is SERVER-DETECTED (magic bytes), not
            // the vendor-reported value. Reuse the mail attachment detector
            // (known image/PDF signatures + text normalization; falls back to
            // the reported mime for unknown binary).
            let mime = detectMailAttachmentMimeType(input.head_bytes, input.mime_type);
            // The detector has no audio signatures, so an `audio/*` result here
            // is an UNVERIFIED reported label. Trust it only when the head bytes
            // match a known audio container; otherwise downgrade so the derived
            // `media_class` is not `voice` and the eager transcribe path (A.9)
            // can't be forced by mislabelling non-audio bytes `audio/*` (Codex
            // review-of-fix). Real voice notes (Ogg/MP3/M4A/WAV/FLAC) pass.
            if (mime.startsWith('audio/') && !looksLikeAudio(input.head_bytes)) {
              mime = 'application/octet-stream';
            }
            // `src_path` streams the already-downloaded temp into the CAS via
            // BlobStore.putFile — the bytes never sit fully in memory at any hop.
            const record = await fileCollection.ingest({
              src_path: input.temp_path,
              size_bytes: input.size,
              filename: input.filename,
              mime_type: mime,
              origin: 'messenger_media',
              source_id: input.source_id,
            });
            return {
              file_id: record.record_id,
              media_class: record.hot_fields.media_class,
            };
          } finally {
            // The producer owns the temp file — delete once CAS-ingested (or on
            // failure). Best-effort; a stranded temp is reaped by ops cleanup.
            await unlink(input.temp_path).catch(() => {});
          }
        },
      }
    : undefined;

  /** Resolve the vendor credential + run the binding gate against one
   *  payload. Shared by the pre-enqueue acceptance check AND the
   *  queued task's re-check (codex MED fold: a long prior turn must
   *  not leave later queued work running on a token / recipient that
   *  was revoked or rebound while it waited — the task re-resolves
   *  immediately before building the channel and drops on any
   *  change). A decode throw (locked keys, AEAD failure) propagates
   *  before acknowledgement so the source can retry. Conversation ids are routing
   *  identifiers, not secrets — plain equality. */
  const resolveAndGate = async (
    vendor: TransportVendor,
    connection_name: string,
    payload: unknown,
    stage: 'accept' | 'run',
  ): Promise<{ token: string; recipient: string } | null> => {
    let credential: { token: string; recipient: string } | null = null;
    try {
      credential = await resolveCredential[vendor]();
    } catch (e) {
      log?.('warn', `messenger turn ${stage === 'accept' ? 'skipped' : 'dropped at run'} (${vendor}) — credential decode failed`, {
        connection_name,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new Error('Messenger credentials are temporarily unavailable.');
    }
    if (credential === null) {
      log?.('info', `messenger turn ${stage === 'accept' ? 'skipped' : 'dropped at run'} (${vendor}) — no credential / recipient enrolled`, {
        connection_name,
      });
      return null;
    }
    const conversation = transports[vendor].parseConversationId(payload);
    if (conversation === null || conversation !== credential.recipient) {
      log?.('warn', `messenger turn refused${stage === 'run' ? ' at run' : ''} (${vendor}) — message outside the bound conversation`, {
        connection_name,
        ...(conversation !== null ? { conversation } : {}),
      });
      return null;
    }
    return credential;
  };

  queue.register('messenger', async (command, turn, assertActive, complete) => {
    const { vendor, connection_name, payload, binding_key } = command.input as {
      vendor: string; connection_name: string; payload: unknown; binding_key: string;
    };
    if (messengerConnectionRefusesTurn(connectionStore, vendor, connection_name)) throw new Error('Messenger role was revoked.');
    const credential = await resolveAndGate(vendor, connection_name, payload, 'run');
    if (!credential) throw new Error('Messenger binding changed before execution.');
    const account = mirrored(vendor) ? await accountFor(vendor, credential.token) : credentialKey(credential.token);
    if (mirrored(vendor)) {
      const sender = await accountFor.senderId(vendor, credential.token);
      const incoming = transports[vendor].parseInbound(payload);
      if (sender === incoming?.from) throw new Error('Messenger bot echoes cannot start owner turns.');
      if (vendor === 'slack' && incoming?.media?.length && !sender) throw new Error('Messenger bot author identity unavailable.');
    }
    // Stage-2 accepted jobs pinned the exact credential digest. That evidence
    // can adopt the old session when the same credential is still configured.
    const legacyProof = binding_key === credentialKey(credential.token);
    if (account !== binding_key && !legacyProof) throw new Error('Messenger binding changed before execution.');
    if (mirrored(vendor) && legacyProof) bridge!.bind(vendor, credential.recipient, account, command.session_id);
    assertActive();
    const channel = createMessengerChannel({ transport: transports[vendor],
      sessionStore: orchestrator.sessionStore, token: credential.token,
      recipient: credential.recipient, sessionId: command.session_id,
      ...(fileSink ? { fileSink: { ingest: (input) => fileSink.ingest({ ...input,
        // Vendor message IDs (especially Telegram's counters) are not global.
        // Pin the file identity to the same audience/account as its chat.
        source_id: JSON.stringify([vendor, credential.recipient, account, input.source_id]),
      }) } } : {}), ...(deps.now ? { now: deps.now } : {}),
    });
    const executionChannel = mirrored(vendor) ? { surface: channel.surface,
      onInbound: channel.onInbound, deliver: async () => { bridge!.kick(); },
    } : channel;
    channel.onInbound(async (inbound) => {
      assertActive();
      const parsed = transports[vendor].parseInbound(payload);
      // Slack can include its own thread timestamp on a root message. That
      // identifies the destination thread, not a reply to itself.
      const replyTo = parsed?.reply_to_message_id !== parsed?.vendor_message_id ? parsed?.reply_to_message_id : undefined;
      await orchestrator.runMessengerTurn({ channel: executionChannel, sessionStore: orchestrator.sessionStore,
        inbound, queue_turn_id: turn, assert_active: assertActive, complete_turn: complete,
        model_routing_snapshot: command.input.model_routing_snapshot as ReturnType<typeof queue.routing>,
        ...(replyTo ? { native_reply_to: replyTo, native_reply_vendor: vendor } : {}),
        native_reply_context: replyTo
          ? (await bridge?.nativeReply(command.session_id, vendor, replyTo))
            ?? await queue.nativeReply(command.session_id, vendor, replyTo) : undefined,
        ...(parsed?.thread_id ? { native_thread_id: parsed.thread_id } : {}),
      });
    });
    try { await channel.ingest(payload); }
    catch (error) { log?.('warn', `messenger turn failed (${vendor})`, { turn_id: turn }); throw error; }
    return { turn_id: turn };
  });

  return async (vendor, connection_name, payload) => {
    const transport = transports[vendor];

    // The messenger surface rides the CANONICAL vendor row only —
    // the row whose name IS the vendor (D-163 I-4 lock-step). The
    // webhook port verified this delivery against the row named
    // `<connection_name>`; accepting any other name here would run a
    // turn whose signature verification and credential/binding read
    // come from two DIFFERENT rows (codex HIGH fold). Alternate-named
    // rows still verify + emit warehouse events; they never start
    // turns.
    if (connection_name !== vendor) {
      log?.('info', `messenger turn skipped (${vendor}) — non-canonical connection row`, {
        connection_name,
      });
      return false;
    }

    // D-192 — the DECLARED messenger role, checked BEFORE the payload, and read
    // for the mode this connection actually runs. Discord's Gateway carries
    // ordinary messages while its Interactions webhook carries only button
    // presses, so the same vendor is conversational in one mode and not the
    // other; the transport parser still rejects non-message shapes below.
    if (messengerConnectionRefusesTurn(connectionStore, vendor, connection_name)) {
      log?.('info', `messenger turn skipped (${vendor}) — connection declares no messenger role`, {
        connection_name,
      });
      return false;
    }

    const parsed = transport.parseInbound(payload);
    if (!parsed) return false;
    const credential = await resolveAndGate(vendor, connection_name, payload, 'accept');
    if (!credential) return false;
    if (!parsed.vendor_message_id) throw new Error('Messenger message has no stable delivery identity.');
    const binding_key = mirrored(vendor) ? await accountFor(vendor, credential.token) : credentialKey(credential.token);
    if (mirrored(vendor)) {
      const sender = await accountFor.senderId(vendor, credential.token);
      if (sender === parsed.from) return false;
      if (vendor === 'slack' && parsed.media?.length && !sender) throw new Error('Messenger bot author identity unavailable.');
    }
    const native_receipt = { vendor, recipient: credential.recipient, message_id: parsed.vendor_message_id,
      account: binding_key, ...(parsed.thread_id ? { thread_id: parsed.thread_id } : {}),
    };
    if (queue.nativeSession(native_receipt) === null) return false;
    const session_id = mirrored(vendor)
      ? bridge!.bind(vendor, credential.recipient, binding_key).session_id
      : messengerSessionId(vendor, credential.recipient);
    queue.ensureSession(session_id, `${vendor} · ${credential.recipient}`);
    const model_routing_snapshot = queue.routing(session_id);
    await queue.submit({ family: 'messenger', session_id, message: parsed.text,
      input: { vendor, connection_name, payload, binding_key, model_routing_snapshot },
      comparison: { vendor, binding_key, from: parsed.from, text: parsed.text, media: parsed.media ?? [],
        reply_to: parsed.reply_to_message_id ?? null, thread: parsed.thread_id ?? null, model_routing_snapshot },
      native_receipt,
    }, `native:${vendor}:${parsed.vendor_message_id}`);
    return true;
  };
};
