/** D-160 A.8 step 6 downstream consumer — messenger transport wiring.
 *
 *  `runMessengerTurn` landed on the chat orchestrator with the channel
 *  + transport deliberately UN-wired ("the BYO Slack/Telegram transport
 *  + verified webhook-inbound wiring is the deferred downstream
 *  consumer" — chat-orchestrator.ts `MessengerTurnInput` doc). This
 *  composer is that consumer: it turns a verified inbound Slack /
 *  Telegram USER MESSAGE (already HMAC- / secret-token-checked by the
 *  D-148 P9 webhook port, already determined not to be an ask callback
 *  by the D-163 inbound-answer dispatcher) into one `messenger` turn —
 *  `@recued/messenger` channel build → `channel.ingest(payload)` →
 *  `orchestrator.runMessengerTurn` → the framework delivers the final
 *  answer back over the SAME vendor transport.
 *
 *  Surface binding (the authorization gate). A messenger surface is
 *  bound to ONE configured conversation per vendor — the
 *  `connection.notification.<vendor>` row's recipient field
 *  (`channel_id` / `chat_id`), the same destination notification sends
 *  go to. An inbound message is accepted for a turn ONLY when (a) the
 *  delivery was verified against that CANONICAL vendor row
 *  (`connection_name === vendor`, D-163 I-4 — verification row and
 *  credential row must be the same row) and (b) it arrived in that
 *  configured conversation (Slack `event.channel` / Telegram
 *  `message.chat.id` equals the recipient); anything else — another
 *  channel the bot is in, a stranger DM-ing a public Telegram bot, a
 *  delivery signed by an alternate-named row — is logged + dropped. The turn then runs as the owner
 *  (`actor: 'user_self'`, the D-153 single-user-server invariant), so
 *  the binding gate is what keeps "can message the bot" from becoming
 *  "can drive the server": the owner picks the conversation (their DM
 *  with their BYO bot, a private channel) and membership of that
 *  conversation IS the access boundary. Risk-tier operations stay
 *  gated behind the MESSENGER policy cell + session grants regardless
 *  (D-177).
 *
 *  Decoupling from the webhook response (TR — vendor retry windows).
 *  Slack retries any delivery not answered within ~3 s; Telegram
 *  delivers updates one-at-a-time per webhook and re-sends on failure.
 *  A turn (LLM call + tool loop) runs for seconds-to-minutes, so
 *  `ingest` only parses + gates + ENQUEUES — the turn itself runs on a
 *  per-vendor FIFO queue (one conversation per vendor ⇒ serializing
 *  per vendor keeps turn order = message order without cross-vendor
 *  head-of-line blocking) and the webhook 200s immediately. A vendor
 *  redelivery of the same event is absorbed upstream by the port's
 *  idempotency ledger. Turn failures are logged, never propagated — a
 *  502 would make the vendor re-deliver and re-run a full AI turn.
 *
 *  One conversation, two windows (N.5): the channel is built over the
 *  orchestrator's OWN session-state store (`orchestrator.sessionStore`)
 *  and a deterministic `(vendor, recipient)` session id, so consecutive
 *  messages land in one durable chat session (`runMessengerTurn`
 *  auto-creates it + persists the user rows; assistant-row persistence
 *  is the orchestrator's documented deferral). Keying the session on
 *  the BOUND CONVERSATION — not the vendor alone — means rebinding
 *  `channel_id` / `chat_id` starts a fresh session: a tail built in a
 *  private DM never carries into a later-bound shared channel (codex
 *  HIGH fold).
 *
 *  Media rides the D-172 `received` inbound-file collection when it is
 *  composed (`origin: 'messenger_media'` — the slot D-172 reserved for
 *  exactly this consumer); absent, the channel degrades to its visible
 *  "file ingest is not configured" note.
 *
 *  Spec: D-160 § N.5 / A.5 / A.8 step 6; D-148
 *  § P9 / A.13; D-163 § N.5 / A.1. */

import { getMessengerVendorDeclaration } from '@recued/contracts';
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
 *  the per-vendor queue after this resolves); `false` when the payload
 *  is not a user message, the vendor credential is unresolved, or the
 *  message arrived outside the bound conversation. Never rejects. */
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
  if (!orchestrator || !connectionStore) return undefined;

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

  // Per-vendor FIFO — turn order = message order within a conversation;
  // a failed turn logs and the queue continues.
  const queueTails = new Map<TransportVendor, Promise<void>>();
  const enqueue = (vendor: TransportVendor, task: () => Promise<void>): void => {
    const tail = queueTails.get(vendor) ?? Promise.resolve();
    const next = tail.then(task).catch((e) => {
      log?.('warn', `messenger turn failed (${vendor})`, {
        error: e instanceof Error ? e.message : String(e),
      });
    });
    queueTails.set(vendor, next);
  };

  /** Resolve the vendor credential + run the binding gate against one
   *  payload. Shared by the pre-enqueue acceptance check AND the
   *  queued task's re-check (codex MED fold: a long prior turn must
   *  not leave later queued work running on a token / recipient that
   *  was revoked or rebound while it waited — the task re-resolves
   *  immediately before building the channel and drops on any
   *  change). A decode throw (locked keys, AEAD failure) is a drop,
   *  not a 502: the vendor would re-deliver a payload that can't
   *  resolve any differently right now. Conversation ids are routing
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
      return null;
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

    // D-192 — the vendor's DECLARED messenger role, checked BEFORE the payload.
    //
    // Discord carries no plain user messages at all (its Interactions webhook
    // delivers button presses; messages live on the Gateway, which we do not run), so
    // there is nothing here for a turn to run on. That was ALREADY true by accident —
    // `parseInbound` returns null, so the next line would refuse it anyway — but "by
    // accident" is the problem: it was a fact about the vendor, enforced only by a
    // leaf's return value, invisible to the registry and to the Settings UI. It is a
    // declaration now, so a vendor states what it is FOR and the shared code reads it.
    if (getMessengerVendorDeclaration(vendor)?.roles.messenger !== true) {
      log?.('info', `messenger turn skipped (${vendor}) — vendor declares no messenger role`, {
        connection_name,
      });
      return false;
    }

    // Not a user message (control event, bot echo, button press shapes
    // the answer dispatcher already consumed) — not ours.
    if (transport.parseInbound(payload) === null) return false;

    // Early acceptance check — cheap refusal before anything queues.
    if ((await resolveAndGate(vendor, connection_name, payload, 'accept')) === null) {
      return false;
    }

    enqueue(vendor, async () => {
      // Re-resolve + re-gate at run time (see resolveAndGate doc) so
      // the channel is built per message over the FRESH credential —
      // no token or recipient is held in a long-lived closure.
      const credential = await resolveAndGate(vendor, connection_name, payload, 'run');
      if (credential === null) return;
      const channel = createMessengerChannel({
        transport,
        sessionStore: orchestrator.sessionStore,
        token: credential.token,
        recipient: credential.recipient,
        sessionId: messengerSessionId(vendor, credential.recipient),
        ...(fileSink ? { fileSink } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      channel.onInbound(async (inbound) => {
        await orchestrator.runMessengerTurn({
          channel,
          sessionStore: orchestrator.sessionStore,
          inbound,
        });
      });
      await channel.ingest(payload);
    });
    return true;
  };
};
