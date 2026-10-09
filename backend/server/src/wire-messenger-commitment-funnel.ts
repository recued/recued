/** D-192 messenger flagship M4b — wire the message→commitment funnel onto the
 *  warehouse bus.
 *
 *  Mirrors the F1 `wireCommitmentEvidenceCapture` (`commitment-evidence-
 *  capture.ts`): subscribes to inbound messenger message events
 *  (`data.messenger.<vendor>.message.created`), reads the connection's declared
 *  match patterns (M2) from its `config_json.match_patterns`, and routes each
 *  matched message through `runMessageCommitmentFunnel` (M4a) → the F1
 *  `commitment-propose` gate → the D-173 inbox → mint.
 *
 *  Late-bound like the F1 capture: `getFire` / `getLedger` / `getConnectionStore`
 *  are read PER EVENT, so the subscriber can be composed before the post-listener
 *  runtime populates the fire (and is entirely inert on a dbless boot — no
 *  connection store, no ledger, no capture). Fire-and-forget on the emit chain:
 *  the run HOLDS at the gate, and a dispatch failure must never break the bus
 *  fan-out. */

import {
  MESSAGE_MATCH_CONFIG_KEY,
  MESSENGER_EVENT_PLATFORM,
  resolveMessengerSendToken,
  type MessageMatchPattern,
  type MessageProjection,
} from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

import type { FireCommitmentEvidenceProposal } from './commitment-evidence-capture.js';
import { messengerConnectionRefusesTurn } from './messenger-connection-roles.js';
import { decodeAuthFromStorage } from './connection-handler.js';
import type { KeyManager } from './key-manager.js';
import {
  ensureMessengerSenderLinked,
  MESSENGER_PROFILE_EMAIL_LEAVES,
} from './messenger-contact-linker.js';
import { runMessageCommitmentFunnel } from './message-commitment-funnel.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { ContactStore } from './storage/contact-store.js';
import type { MessageCommitmentLedger } from './storage/message-commitment-ledger.js';

/** The bus path for inbound messenger messages — `slug` is the vendor. */
const MESSENGER_MESSAGE_EVENT_PATTERN = `data.${MESSENGER_EVENT_PLATFORM}.*.message.created`;

export interface MessengerCommitmentFunnelDeps {
  bus: WarehouseEventBus;
  /** Late-bound connection store — the per-connection `match_patterns` live in
   *  `config_json`. Undefined (dbless / pre-store) ⇒ no patterns ⇒ skip. */
  getConnectionStore: () => ConnectionStoreSqlite | undefined;
  /** Late-bound F1 proposal dispatch (reused verbatim). */
  getFire: () => FireCommitmentEvidenceProposal | undefined;
  /** Late-bound message dedup ledger. */
  getLedger: () => MessageCommitmentLedger | undefined;
  /** Late-bound contact store — the M3 messenger→contact linker resolves
   *  the `(vendor, from)` sender through its `contact_platform_link` table.
   *  Absent (dbless / pre-store) ⇒ the sender stays unresolved and the
   *  proposal's counterparty defaults EMPTY (owner fills at approval). */
  getContactStore?: () => ContactStore | undefined;
  /** M1b — sub-DEK source for decoding a vendor's bot token, needed by the
   *  declaration-driven link WRITER's profile fetch (Slack `users.info`).
   *  Re-read per call (like `createRemoteCredentialResolver`) so a boot→unlock
   *  transition lands without a rebuild. Absent ⇒ a plaintext-auth row still
   *  decodes (dbless / no-vault), an encrypted row does not ⇒ no token ⇒ the
   *  writer no-ops (the sender stays opaque). */
  keys?: KeyManager;
  /** M1b test seam — inject `fetch` for the profile-email leaf. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Read + coerce the declared match patterns for a messenger connection from
 *  its `config_json.match_patterns`. Fail-OPEN to `[]` on a missing store, a
 *  missing/malformed row, a JSON parse error, or a non-array field — the funnel
 *  then simply doesn't match. (An INDIVIDUAL malformed pattern is safe to pass
 *  through: M2's `matchMessage` fail-CLOSES per bad member, so it never matches
 *  and never throws.) */
export const readMessengerMatchPatterns = (
  store: ConnectionStoreSqlite | undefined,
  connectionName: string,
): readonly MessageMatchPattern[] => {
  if (store === undefined) return [];
  const row = store.get('notification', connectionName);
  if (row === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    return [];
  }
  const raw = (parsed as { [MESSAGE_MATCH_CONFIG_KEY]?: unknown } | null)?.[
    MESSAGE_MATCH_CONFIG_KEY
  ];
  return Array.isArray(raw) ? (raw as MessageMatchPattern[]) : [];
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const wireMessengerCommitmentFunnel = (
  deps: MessengerCommitmentFunnelDeps,
): (() => Promise<void>) => {
  const now = deps.now ?? ((): number => Date.now());
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let stopPromise: Promise<void> | undefined;

  // M1b — read the vendor's send token from its canonical
  // `connection.notification.<vendor>` row (D-163 I-4), late-bound + decoded
  // per call (a boot→unlock transition lands without a rebuild). No store / no
  // row / locked keys / undeliverable auth shape / decode failure ⇒ null (the
  // writer no-ops). The auth-shape question goes through the shared messenger
  // send-credential seam (D-192 CORE #6 make-live) — this was the second of the
  // two generic sites that hand-rolled `auth.type === 'bearer'` and silently
  // no-opped on anything else.
  const resolveBotToken = async (vendor: string): Promise<string | null> => {
    const store = deps.getConnectionStore();
    if (store === undefined) return null;
    const row = store.get('notification', vendor);
    if (row === null) return null;
    const keyProvider = deps.keys ? deps.keys.keyProvider('connection') : undefined;
    try {
      const auth = await decodeAuthFromStorage(
        row.auth_ciphertext,
        { kind: row.kind, name: row.name },
        keyProvider,
      );
      return resolveMessengerSendToken(auth) ?? null;
    } catch {
      return null;
    }
  };

  // M1b — the declaration-driven WRITER's vendor-agnostic profile→email
  // resolver: dispatch to the vendor's profile-email adapter leaf
  // (`MESSENGER_PROFILE_EMAIL_LEAVES`, keyed by slug). A vendor without a leaf
  // (Telegram) resolves to null → the writer no-ops.
  const fetchProfileEmail = async (
    vendor: string,
    platform_id: string,
  ): Promise<string | null> => {
    const leaf = MESSENGER_PROFILE_EMAIL_LEAVES[vendor];
    if (leaf === undefined) return null;
    const token = await resolveBotToken(vendor);
    if (token === null) return null;
    return leaf(token, platform_id, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  };

  const onEvent = (ev: WarehouseEvent): void => {
    if (closed) return;
    // Only inbound messenger message-created events (the subscribe pattern
    // already narrows to this; the guard is defense in depth).
    if (ev.platform !== MESSENGER_EVENT_PLATFORM) return;
    if (ev.entity_type !== 'message' || ev.event_kind !== 'created') return;
    if (ev.record === undefined) return;

    const text = asString(ev.record.text);
    const from = asString(ev.record.from);
    const vendor = asString(ev.record.vendor);
    const connectionName = asString(ev.record.connection_name);
    // Missing any identifying field ⇒ nothing to project (the funnel's own
    // fail-closed compose would reject it anyway).
    if (text === undefined || from === undefined || vendor === undefined || connectionName === undefined) {
      return;
    }

    // D-192 — the DECLARED messenger role for the mode this connection runs.
    // The funnel is a message-triggered surface, so a mode that carries no
    // ordinary messages (Discord's Interactions webhook) has no business here
    // even if some future ingress path emitted an event by mistake.
    const store = deps.getConnectionStore();
    if (messengerConnectionRefusesTurn(store, vendor, connectionName)) return;

    const patterns = readMessengerMatchPatterns(store, connectionName);
    if (patterns.length === 0) return; // no declared patterns — nothing to match

    const ledger = deps.getLedger();
    if (ledger === undefined) return; // dbless — no dedup, no capture (F1 posture)

    const projection: MessageProjection = {
      vendor,
      sender: from,
      text,
      // The bus record carries no true send time; the event arrival time IS the
      // best available send timestamp (the record is deliberately minimal).
      sent_at: ev.at,
    };

    // M3 — the messenger→contact linker seam. Read the contact store per
    // event (late-bound like every other dep); its `lookupPlatformLink` /
    // `resolveCanonicalEmail` map `(vendor, from)` → the sender's canonical
    // contact. Absent ⇒ the funnel's resolver fails closed (no counterparty).
    const contactStore = deps.getContactStore?.();

    // Fire-and-forget: the run HOLDS at the gate (nothing to await on the emit
    // chain), and the funnel is internally guarded — but a catastrophic ledger
    // throw is caught here so a fold can never crash the bus fan-out.
    let tracked!: Promise<void>;
    tracked = runMessageCommitmentFunnel(
      {
        getFire: deps.getFire,
        ledger,
        ...(contactStore !== undefined
          ? {
              lookupPlatformLink: (v: string, p: string): string | null =>
                contactStore.lookupPlatformLink(v, p),
              resolveCanonical: (email: string): string | undefined =>
                contactStore.resolveCanonicalEmail(email).canonical_email,
              // M1b — learn the matched sender's `(vendor, platform_id) → email`
              // link (fail-open) BEFORE the M3 resolve above reads it. D-192
              // slice 4 stamps `connectionName` (the receiving connection) so a
              // connection teardown can retract exactly these links.
              ensureSenderLinked: (v: string, p: string): Promise<void> =>
                ensureMessengerSenderLinked(
                  {
                    lookupPlatformLink: (lv, lp) => contactStore.lookupPlatformLink(lv, lp),
                    linkPlatformId: (i) => contactStore.linkPlatformId(i),
                    fetchProfileEmail,
                    now,
                  },
                  { vendor: v, platform_id: p, connection_name: connectionName },
                ),
            }
          : {}),
        now,
      },
      { projection, patterns, message_id: ev.record_id },
    ).catch(() => {
      /* the failure is audited on the execute path; never abort the emit chain */
    }).then(() => {
      // The lifecycle tracks completion only; the funnel outcome is consumed
      // internally and must not widen the drain promise's type.
    }).finally(() => {
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
  };

  const unsubscribe = deps.bus.subscribe(MESSENGER_MESSAGE_EVENT_PATTERN, onEvent);
  return () => {
    if (stopPromise) return stopPromise;
    closed = true;
    unsubscribe();
    stopPromise = Promise.allSettled([...inFlight]).then(() => undefined);
    return stopPromise;
  };
};
