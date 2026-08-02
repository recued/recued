/** D-192 messenger flagship (M1) — the `MessengerVendorDeclaration` registry.
 *
 *  The canonical-vocabulary half of the kinds-taxonomy §0 governing rule
 *  (D-192): "for any multi-vendor family, split the
 *  design into (1) a canonical vocabulary + a declaration the shared logic is
 *  written against ONCE and (2) a thin per-vendor adapter for only what can't
 *  generalize — the transport handshake, the auth flow, the API leaf." A new
 *  messenger vendor is one declaration entry here + its adapter leaf, NEVER a
 *  `switch (vendor)` or a hand-widened `{ slack, telegram }` map in shared code.
 *
 *  This mirrors the `CONNECTION_VENDOR_ENTITIES` precedent (`connection-
 *  vendors.ts`) DATA-first: the declaration carries the per-vendor FACTS that
 *  shared logic dispatches on (how a sender's platform id maps to an email, the
 *  inbound-verification scheme + secret field, the bound-conversation recipient
 *  field, the supported surfaces); the BEHAVIORAL leaves it names — the webhook
 *  signature verifier, the `@recued/transport` factory, the notification-channel
 *  boot fn — stay in the backend keyed by the `vendor` slug (contracts imports
 *  no runtime). The vendor slug IS the ref.
 *
 *  Scope note (what reads this today vs. what will). The load-bearing facet is
 *  `identity.platform_id_source` — the messenger→contact linker's WRITER half
 *  (M1's residual from M3: the reader seam landed, but nothing populates
 *  `contact_platform_link` for messenger, so a matched sender stays opaque).
 *  `ingress` / `recipient` / `surfaces` / `auth` are the owner-sketched
 *  vocabulary (taxonomy §3a) that the composer-retirement slice consumes when it
 *  folds the hardcoded vendor composers (`wire-vendor-webhook-
 *  port.ts`, `wire-messenger-turn.ts`, the notification registry) into
 *  registry iteration; they are grounded in real per-vendor variance today, not
 *  speculative — each maps to a documented difference (Slack HMAC signing-secret
 *  vs. Telegram constant-time secret-token; Slack string `channel_id` vs.
 *  Telegram string-or-numeric `chat_id`). Pure + unwired: this slice adds the
 *  declaration; the funnel/wire keep reading the bare `vendor` string.
 *
 *  This registry is now the SOLE messenger-vendor vocabulary: the messenger
 *  `ExecutionSource.vendor` (`commits.ts`) is validated against it via
 *  `isDeclaredMessengerVendor`. D-192 CORE #6 retired the former separate
 *  closed `MESSENGER_VENDORS` list (`slack | telegram | email`) whose `email`
 *  member was a category error. A `MessengerVendorDeclaration` is a CHAT
 *  TRANSPORT vendor (a `@recued/transport` `Transport`); `email` is the
 *  separately-built mail family / a D-158 notification channel, never a chat
 *  transport, so it is NOT declared here.
 *
 *  Spec: D-192 § 3a (M-1); decisions-log § D-192
 *  ("KINDS TAXONOMY RATIFIED" — M-1). */

// TYPE-ONLY, and it must stay that way: `connection.ts` imports
// `MESSENGER_VENDOR_SLUGS` from HERE at runtime, so a runtime import back would
// close a cycle. A `import type` is erased at compile time, so the dependency
// runs one way only. The behavior that pairs with the map below
// (`resolveMessengerSendToken`) therefore lives in `connection.ts`, beside its
// sibling `resolveBearerAccessToken` — which is where a credential resolver
// belongs anyway.
import type { ConnectionAuth } from './connection.js';
// A VALUE import, and the reason it points at `channel-roles.ts` rather than
// `notifications.ts`: that module imports THIS one at runtime (it splices
// `MESSENGER_VENDOR_SLUGS` and reads each declaration's `roles`), so importing a
// value back from it closes a real cycle — whichever side evaluates first sees
// the other half-built, and it surfaces as `MESSENGER_VENDOR_SLUGS is not
// iterable` at import time. A type-only import hid that for as long as the axes
// were a type; the leaf module is what keeps it one-way now that they are data.
import { CHANNEL_ROLE_AXES, type ChannelRoles } from './channel-roles.js';

// ────────────────────────────────────────────────────────────────
// The vendor slugs — the TYPE-LEVEL half of the registry (D-192 seam 10)
// ────────────────────────────────────────────────────────────────

/** Every declared messenger (chat transport) vendor slug, and the ONE place a
 *  new chat transport is named. Seam 10: the ~6 hand-maintained `ChannelName` /
 *  `NotificationSubtype` / delivery-channel mirror lists that used to each spell
 *  `'slack' | 'telegram'` now splice THIS in, so adding a vendor is one edit
 *  here — not six across four packages.
 *
 *  Why a const tuple rather than the runtime `listMessengerVendors()`: those
 *  vocabularies are closed literal unions carrying real compile-time guarantees
 *  — `RemoteChannelName = Exclude<ChannelName, 'ui'>` makes "you cannot toggle
 *  `ui`" a compile error rather than a runtime check, the readiness probe
 *  switches on the members, and the enroll-card map is keyed by subtype so a
 *  vendor without a card fails to compile. Deriving them from a runtime
 *  `readonly string[]` would collapse every one of them to `string` and silently
 *  drop all of it. A const tuple splices in with the literals intact
 *  (`['ui', 'bridge', ...MESSENGER_VENDOR_SLUGS, 'email'] as const`).
 *
 *  This is honest, not a retreat from §0.5: a messenger vendor is FIRST-PARTY (a
 *  declaration here + an adapter leaf in the backend), never pack-declared — the
 *  `Transport` handshake is code. The RUNTIME accessors stay open (they take a
 *  `registry` param), so a future merged registry can still carry an undeclared
 *  slug; such a vendor simply cannot back a notification channel — which is
 *  already the rule (`createRemoteChannel` fails LOUD on a slug ∉ `CHANNEL_NAMES`).
 *
 *  ⚠ ADDING A VENDOR: the slug here + a `MESSENGER_VENDOR_DECLARATIONS` entry
 *  (the boot check at the foot of this file enforces both, in BOTH directions) +
 *  the backend adapter leaves. Nothing else to widen. */
export const MESSENGER_VENDOR_SLUGS = ['slack', 'telegram', 'whatsapp', 'discord'] as const;
export type MessengerVendorSlug = (typeof MESSENGER_VENDOR_SLUGS)[number];

// ────────────────────────────────────────────────────────────────
// Closed enums (the declaration's controlled vocabulary)
// ────────────────────────────────────────────────────────────────

/** A conversation surface a vendor's transport can bind. Slack has all four
 *  (im / mpim / channel / thread_ts); Telegram binds private / group / channel
 *  (forum-topic threads are omitted — newer + partial bot support). */
export const MESSENGER_SURFACES = ['dm', 'group', 'channel', 'thread'] as const;
export type MessengerSurface = (typeof MESSENGER_SURFACES)[number];
export const MESSENGER_SURFACE_SET: ReadonlySet<string> = new Set(MESSENGER_SURFACES);

/** How inbound messages arrive. A connection persists exactly one of these in
 *  `config.ingress_mode`; local outbound-established transports are the default
 *  where the vendor supports one, while webhook stays an explicit alternative. */
export const MESSENGER_INGRESS_MODES = ['webhook', 'socket', 'poll'] as const;
export type MessengerIngressMode = (typeof MESSENGER_INGRESS_MODES)[number];
export const MESSENGER_INGRESS_MODE_SET: ReadonlySet<string> = new Set(MESSENGER_INGRESS_MODES);
export const MESSENGER_INGRESS_MODE_CONFIG_KEY = 'ingress_mode';

/** Webhook inbound-verification scheme.
 *   - `hmac`         — Slack: HMAC-SHA256 over `v0:<ts>:<body>` keyed by the
 *     signing secret, with a replay window. WhatsApp: the same family — HMAC-SHA256
 *     over the raw body keyed by the Meta App Secret (`X-Hub-Signature-256`), but
 *     with no timestamp in the base string and therefore no replay window.
 *   - `secret_token` — Telegram: a constant-time compare of the
 *     `X-Telegram-Bot-Api-Secret-Token` header against a stored secret.
 *   - `ed25519`      — Discord: an ASYMMETRIC signature over `<timestamp><body>`,
 *     verified against the application's PUBLIC key. The first scheme here whose
 *     verification material is not a shared secret at all — see the `secret_field`
 *     note on `MessengerIngress`, which is why that facet is about the config KEY
 *     the verifier reads, not about secrecy. */
export const MESSENGER_VERIFICATIONS = ['hmac', 'secret_token', 'ed25519'] as const;
export type MessengerVerification = (typeof MESSENGER_VERIFICATIONS)[number];
export const MESSENGER_VERIFICATION_SET: ReadonlySet<string> = new Set(MESSENGER_VERIFICATIONS);

/** How a sender's platform-native id maps to a canonical Recued email — the
 *  driver for the M1 messenger→contact link WRITER (the M3 residual).
 *   - `profile_email` — the vendor exposes the sender's email on a profile
 *     lookup (Slack `users.info` with the `users:read.email` scope); the writer
 *     fetches it and records a `(vendor, platform_id) → email` link.
 *   - `none`          — the vendor exposes NO email (Telegram's Bot API surfaces
 *     only a numeric user id / username); the writer is a structural no-op and
 *     the sender stays an opaque `actor_platform_id` (the owner fills the
 *     counterparty at approval — the F1 nullable posture). */
export const MESSENGER_PLATFORM_ID_SOURCES = ['profile_email', 'none'] as const;
export type MessengerPlatformIdSource = (typeof MESSENGER_PLATFORM_ID_SOURCES)[number];
export const MESSENGER_PLATFORM_ID_SOURCE_SET: ReadonlySet<string> = new Set(
  MESSENGER_PLATFORM_ID_SOURCES,
);

/** Credential auth kind. Both current vendors use a BYO bot token; `oauth` +
 *  `cloud_api` (WhatsApp Cloud API) are declared extension points. */
export const MESSENGER_AUTH_KINDS = ['bot_token', 'oauth', 'cloud_api'] as const;
export type MessengerAuthKind = (typeof MESSENGER_AUTH_KINDS)[number];
export const MESSENGER_AUTH_KIND_SET: ReadonlySet<string> = new Set(MESSENGER_AUTH_KINDS);

/** Which STORED credential shapes each declared auth kind can actually be
 *  enrolled — and SENT — with. Two axes that are easy to conflate:
 *
 *    - `MessengerAuthKind` (`bot_token` / `oauth` / `cloud_api`) — the VENDOR's
 *      credential model, declared on the vendor entry.
 *    - `ConnectionAuth['type']` (`bearer` / `oauth2_refresh` / …) — the shape the
 *      credential is STORED in on the `connection.notification.<vendor>` row.
 *
 *  This map is the bridge, and the single authority on the question. It is
 *  deliberately narrow, because the substrate behind it is narrow: the messenger
 *  send path resolves a bearer token and nothing else, and there is NO
 *  token-refresh path for `kind: 'notification'` at all (both refreshers are
 *  hard-scoped to `kind: 'api'`). A credential that must be refreshed to stay
 *  valid therefore cannot be delivered.
 *
 *  So `oauth: []` is the honest answer, not an oversight — and the empty list is
 *  LOAD-BEARING: the boot check at the foot of this file refuses to declare a
 *  vendor whose auth kind has no deliverable shape. That closes a real trap the
 *  D-192 CORE #6 make-live surfaced. An `oauth2_refresh` notification row would
 *  enroll over rpc, PROBE GREEN (the prober reads `current_access_token` through
 *  `resolveBearerAccessToken`), report READY (the readiness probe only checks the
 *  row exists) — and then silently drop every single send, because the credential
 *  resolver returned null. Green, ready, and mute: exactly the silent-until-
 *  runtime class this whole arc exists to kill.
 *
 *  ⚠ Wiring `oauth` means THREE things, not one: a send-path token source (add
 *  `'oauth2_refresh'` here and `resolveMessengerSendToken` picks it up for free),
 *  a token refresher for `kind: 'notification'`, and an enroll card carrying the
 *  OAuth fields. Add the entry only once all three exist — the boot check is what
 *  stops a half-wired vendor from shipping. */
export const MESSENGER_AUTH_KIND_CONNECTION_TYPES: Record<
  MessengerAuthKind,
  ReadonlyArray<ConnectionAuth['type']>
> = {
  /** Slack `xoxb-…` / Telegram `<bot_id>:<secret>` — a static bearer token. */
  bot_token: ['bearer'],
  /** WhatsApp Cloud API — a long-lived bearer access token; same send path, so
   *  this is a statement of fact, not speculative wiring. */
  cloud_api: ['bearer'],
  /** Not deliverable yet — see above. Declaring a vendor with it fails boot. */
  oauth: [],
};

/** HTTP method a health probe issues. */
export const MESSENGER_PROBE_METHODS = ['GET', 'POST'] as const;
export type MessengerProbeMethod = (typeof MESSENGER_PROBE_METHODS)[number];
export const MESSENGER_PROBE_METHOD_SET: ReadonlySet<string> = new Set(MESSENGER_PROBE_METHODS);

/** Where the vendor's credential rides on a health probe — the second real
 *  per-vendor delta (with the URL + method) the probe dispatches on.
 *   - `bearer_header` — Slack: `Authorization: Bearer <token>` on `auth.test`.
 *     WhatsApp: the same, on Graph `/me`.
 *   - `url_token`     — Telegram: the bot token is baked into the URL PATH
 *     (`/bot<token>/getMe`), never a header; `MESSENGER_PROBE_TOKEN_PLACEHOLDER`
 *     marks the spot in the declared template.
 *   - `bot_header`    — Discord: `Authorization: Bot <token>`. Differs from
 *     `bearer_header` by ONE word, and that word is load-bearing: Discord reads
 *     `Bearer` as an OAuth2 user token, so probing a perfectly VALID bot token with
 *     the wrong scheme returns 401 and the channel reports `auth_failed` while being
 *     entirely healthy. A wrong-scheme probe fails the same way a wrong token does,
 *     which is exactly the kind of lie that is impossible to debug from the UI. */
export const MESSENGER_PROBE_AUTH_PLACEMENTS = [
  'bearer_header',
  'url_token',
  'bot_header',
] as const;
export type MessengerProbeAuthPlacement = (typeof MESSENGER_PROBE_AUTH_PLACEMENTS)[number];
export const MESSENGER_PROBE_AUTH_PLACEMENT_SET: ReadonlySet<string> = new Set(
  MESSENGER_PROBE_AUTH_PLACEMENTS,
);

/** The `health_probe.url` token placeholder. Present iff the placement is
 *  `url_token` (the validator enforces the biconditional both ways: a
 *  `url_token` template without it would probe UNAUTHENTICATED, and a
 *  `bearer_header` template with it would leave the literal in the path). */
export const MESSENGER_PROBE_TOKEN_PLACEHOLDER = '{token}';

// ────────────────────────────────────────────────────────────────
// The declaration shape
// ────────────────────────────────────────────────────────────────

/** The inbound-transport facet — how verified messages arrive. A declaration
 *  names its local-first default plus every supported alternative. Webhook
 *  capability additionally carries the verification scheme and plaintext
 *  `config_json` key holding its verification material. */
export interface MessengerIngress {
  /** Default for a NEW enrollment. Existing rows that predate
   *  `config.ingress_mode` resolve to webhook when webhook is supported. */
  mode: MessengerIngressMode;
  /** Every mode the vendor can run. Non-empty, unique, and includes `mode`. */
  supported_modes: readonly MessengerIngressMode[];
  /** Webhook verification scheme. Required iff webhook is supported. */
  verification?: MessengerVerification;
  /** The `config_json` field holding the inbound VERIFICATION MATERIAL
   *  (`signing_secret` for Slack, `webhook_secret` for Telegram, `app_secret` for
   *  WhatsApp, `public_key` for Discord). Required iff webhook is supported.
   *
   *  D-192 seam 11 — ONE generic reader pulls it off the row through this,
   *  replacing byte-identical per-vendor readers that differed only in which config
   *  key they read.
   *
   *  ⚠ The name says "secret" and that is now HALF right, which is worth stating
   *  rather than quietly tolerating. For `hmac` / `secret_token` the material IS a
   *  shared secret. For Discord's `ed25519` it is the application's **public key** —
   *  asymmetric verification needs no secret at all. What the facet actually names
   *  is *the config key the verifier reads*, and that is the only thing the generic
   *  reader needs. It is left named `secret_field` deliberately: renaming it would
   *  touch every declaration and every reader to buy a word, and the honest fix is
   *  this note. The one real consequence — `public_key` is in
   *  `CONNECTION_INBOUND_SECRET_FIELDS`, so it is stripped from the recipe-visible
   *  view like the genuine secrets. Harmless (it is public), and it keeps the
   *  generic machinery free of a special case. */
  secret_field?: string;
  /** The vendor's NATIVE inbound-id field — `event_id` (Slack), `update_id`
   *  (Telegram), `interaction_id` (Discord). Required for every ingress mode;
   *  local runners surface their native ids under the same key as webhooks.
   *
   *  D-192 seam 11 — this is the only thing the two `dispatch{Slack,Telegram}Event`
   *  wrappers actually knew. Both normalized `{ connection_name, payload, <id> }`
   *  onto the generic `MessengerInboundEvent`, differing solely in which key held
   *  the id and what name to reproduce verbatim in the log line. Declaring it
   *  collapses them into one normalizer, so a new transport dispatches with no
   *  wrapper of its own. */
  id_field: string;
  /** Per-mode NARROWING of the vendor `roles` ceiling. Absent (the norm) ⇒ every
   *  supported mode carries the full declared set.
   *
   *  Only Discord needs this today, and only on one axis. Slack (socket /
   *  webhook) and Telegram (poll / webhook) each deliver ordinary messages AND
   *  callbacks in either mode, so their roles do not move; Discord's Gateway
   *  carries `MESSAGE_CREATE` while its Interactions endpoint carries button
   *  presses and nothing else. `roles` therefore states what the VENDOR can do
   *  and this states what a MODE gives up — the two facts have different
   *  lifetimes and the ceiling is what makes the channel enrollable at all
   *  (`CHANNEL_ROLES` is keyed by channel, with no connection in hand).
   *
   *  NARROWING ONLY, enforced at load: a mode may turn a declared role off, and
   *  may never grant one the vendor does not declare — otherwise this becomes a
   *  second, contradicting source of truth for the same question. */
  mode_roles?: Readonly<Partial<Record<MessengerIngressMode, Partial<ChannelRoles>>>>;
}

/** The bound-conversation recipient facet — the single real per-vendor delta in
 *  the shared credential-resolution path (`wire-remote-channel.ts`): which
 *  `config_json` field names the bound conversation, and whether a numeric id
 *  is accepted + coerced. */
export interface MessengerRecipient {
  /** `config_json` field naming the bound conversation (`channel_id` /
   *  `chat_id`). */
  field: string;
  /** Whether a numeric id is accepted + coerced to string (Telegram `chat_id`)
   *  or a non-empty string is required (Slack `channel_id`, always `C…`). */
  numeric_ok: boolean;
}

/** The sender-identity facet — see `MESSENGER_PLATFORM_ID_SOURCES`. */
export interface MessengerIdentity {
  platform_id_source: MessengerPlatformIdSource;
}

/** The structured-projection facet — whether a per-vendor projector can supply
 *  structured `tags` / `mentions` beyond the matcher's text-derivation
 *  (`message-match.ts` `tokenizeMessageText`). Both are `false` today: the
 *  `@recued/transport` `ParsedInbound` is text-only, and the matcher already
 *  derives `#tags` / `<@USERID>` mentions from the message text, so no vendor
 *  supplies structured tokens yet. */
export interface MessengerProjection {
  structured_tags: boolean;
  structured_mentions: boolean;
}

/** The connection-health facet — the per-vendor facts the notification probe
 *  (`connection-handler.ts` `probeNotification`) dispatches on. Every chat
 *  transport's probe is the SAME shape (call the vendor's cheap authenticated
 *  identity endpoint, read the JSON envelope, classify), so the shared prober is
 *  written once against this facet and a new vendor is one entry here — never a
 *  new `switch (subtype)` arm. The response side needs no facet: both vendors'
 *  envelopes (and Graph's) classify off the HTTP status + an `ok: false` +
 *  `error` / `description` body the shared prober already reads. */
export interface MessengerHealthProbe {
  /** Probe endpoint. Absolute + `https:` (it carries the credential). Contains
   *  `MESSENGER_PROBE_TOKEN_PLACEHOLDER` iff `auth` is `url_token`. */
  url: string;
  method: MessengerProbeMethod;
  /** Where the credential rides — see `MESSENGER_PROBE_AUTH_PLACEMENTS`. */
  auth: MessengerProbeAuthPlacement;
}

/** One messenger (chat transport) vendor declaration — the canonical vocabulary
 *  a new vendor joins the family through (§0). The `vendor` slug is the registry
 *  key AND the `connection.notification.<vendor>` row key (D-163 I-4: the
 *  verification row and the credential row are the same row). */
export interface MessengerVendorDeclaration {
  /** Lowercase vendor slug — `/^[a-z][a-z0-9_]*$/`. */
  vendor: string;
  /** Human-readable label (settings UI + validator error messages). */
  display_name: string;
  /** The conversation surfaces the vendor's transport binds. Non-empty. */
  surfaces: readonly MessengerSurface[];
  /** Inbound transport facet. */
  ingress: MessengerIngress;
  /** Bound-conversation recipient facet. */
  recipient: MessengerRecipient;
  /** Sender-identity facet (the M1 link-writer driver). */
  identity: MessengerIdentity;
  /** Structured-projection facet. */
  projection: MessengerProjection;
  /** Credential auth kind. */
  auth: MessengerAuthKind;
  /** D-192 — WHAT THIS VENDOR IS FOR: the three axes (notify / approve / converse).
   *
   *  Declared, not inferred. Discord's inability to carry a conversation used to be
   *  expressed only by `parseInbound` returning null — which WORKS (the turn and the
   *  funnel both gate on it) but says so nowhere a human or a UI can read. WhatsApp's
   *  inability to be reached unprompted was expressed only in prose. Both are vendor
   *  FACTS, so both belong in the declaration, where the shared code and the Settings
   *  UI can both read them.
   *
   *  ⚠ These are independent, and all four shipped vendors sit in different quadrants
   *  — see `CHANNEL_ROLES`. A vendor with every role `false` fails the boot check. */
  roles: ChannelRoles;
  /** Connection-health facet (D-192 CORE #6 seam 8). Required: every chat
   *  transport authenticates a bot credential, so every one of them HAS a cheap
   *  endpoint that verifies it — and a vendor that silently reported `unknown`
   *  health forever would be a worse failure than a loud boot-time one. A
   *  genuinely probe-less vendor would widen this to an explicit variant, never
   *  to mere absence. */
  health_probe: MessengerHealthProbe;
}

// ────────────────────────────────────────────────────────────────
// Validation (hoisted above the registry initializer)
// ────────────────────────────────────────────────────────────────

/** Same lowercase identifier rule the connection-vendor registry uses (one
 *  grammar across the codebase — vendor slugs, step ids, refs). */
const MESSENGER_VENDOR_REGEX = /^[a-z][a-z0-9_]*$/;

/** Strict per-entry shape validator — returns issue strings (empty when the
 *  entry is well-formed). `buildMessengerVendorDeclaration` throws on a
 *  non-empty result so a misconfigured entry surfaces at boot, not at the first
 *  inbound message. Mirrors `assertConnectionVendorEntityShape`. */
export function assertMessengerVendorDeclarationShape(entry: unknown): string[] {
  const issues: string[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['expected object'];
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.vendor !== 'string' || !MESSENGER_VENDOR_REGEX.test(e.vendor)) {
    issues.push(`field 'vendor' must match ${MESSENGER_VENDOR_REGEX.source}`);
  }
  if (typeof e.display_name !== 'string' || e.display_name.length === 0) {
    issues.push("field 'display_name' must be a non-empty string");
  }

  if (!Array.isArray(e.surfaces) || e.surfaces.length === 0) {
    issues.push("field 'surfaces' must be a non-empty array");
  } else {
    const seen = new Set<string>();
    e.surfaces.forEach((s, idx) => {
      if (typeof s !== 'string' || !MESSENGER_SURFACE_SET.has(s)) {
        issues.push(`surfaces[${idx}] must be one of ${MESSENGER_SURFACES.join(' / ')}`);
      } else if (seen.has(s)) {
        issues.push(`surfaces[${idx}] duplicate surface '${s}'`);
      } else {
        seen.add(s);
      }
    });
  }

  // Ingress — one default plus a non-empty supported set. Webhook verification
  // material is required exactly when webhook is one of the supported modes;
  // the native id key is shared by webhook and local runners.
  if (e.ingress === null || typeof e.ingress !== 'object' || Array.isArray(e.ingress)) {
    issues.push("field 'ingress' must be an object");
  } else {
    const ing = e.ingress as Record<string, unknown>;
    const mode = typeof ing.mode === 'string' && MESSENGER_INGRESS_MODE_SET.has(ing.mode)
      ? ing.mode as MessengerIngressMode
      : null;
    if (mode === null) {
      issues.push(`ingress.mode must be one of ${MESSENGER_INGRESS_MODES.join(' / ')}`);
    }
    const supported = Array.isArray(ing.supported_modes) ? ing.supported_modes : null;
    if (supported === null || supported.length === 0) {
      issues.push("ingress.supported_modes must be a non-empty array");
    } else {
      const seen = new Set<string>();
      supported.forEach((candidate, idx) => {
        if (typeof candidate !== 'string' || !MESSENGER_INGRESS_MODE_SET.has(candidate)) {
          issues.push(
            `ingress.supported_modes[${idx}] must be one of ${MESSENGER_INGRESS_MODES.join(' / ')}`,
          );
        } else if (seen.has(candidate)) {
          issues.push(`ingress.supported_modes[${idx}] duplicate mode '${candidate}'`);
        } else {
          seen.add(candidate);
        }
      });
      if (mode !== null && !seen.has(mode)) {
        issues.push('ingress.supported_modes must include ingress.mode');
      }
    }
    const supportsWebhook = supported?.includes('webhook') === true;
    if (supportsWebhook) {
      if (typeof ing.verification !== 'string' || !MESSENGER_VERIFICATION_SET.has(ing.verification)) {
        issues.push(
          `ingress.verification must be one of ${MESSENGER_VERIFICATIONS.join(' / ')} when webhook is supported`,
        );
      }
      if (typeof ing.secret_field !== 'string' || ing.secret_field.length === 0) {
        issues.push("ingress.secret_field must be a non-empty string when webhook is supported");
      }
    } else {
      if (ing.verification !== undefined) {
        issues.push('ingress.verification is only valid when webhook is supported');
      }
      if (ing.secret_field !== undefined) {
        issues.push('ingress.secret_field is only valid when webhook is supported');
      }
    }
    if (typeof ing.id_field !== 'string' || ing.id_field.length === 0) {
      issues.push('ingress.id_field must be a non-empty string');
    }
    // Per-mode role narrowing. The ceiling is `roles`; this may only take away.
    if (ing.mode_roles !== undefined) {
      if (
        ing.mode_roles === null
        || typeof ing.mode_roles !== 'object'
        || Array.isArray(ing.mode_roles)
      ) {
        issues.push('ingress.mode_roles must be an object');
      } else {
        const ceiling = (e.roles !== null && typeof e.roles === 'object' && !Array.isArray(e.roles))
          ? e.roles as Record<string, unknown>
          : null;
        for (const [modeKey, override] of Object.entries(ing.mode_roles)) {
          if (supported !== null && !supported.includes(modeKey)) {
            issues.push(`ingress.mode_roles['${modeKey}'] is not one of ingress.supported_modes`);
            continue;
          }
          if (override === null || typeof override !== 'object' || Array.isArray(override)) {
            issues.push(`ingress.mode_roles['${modeKey}'] must be an object`);
            continue;
          }
          const entries = Object.entries(override as Record<string, unknown>);
          if (entries.length === 0) {
            issues.push(`ingress.mode_roles['${modeKey}'] declares no narrowing — omit it instead`);
          }
          for (const [axis, value] of entries) {
            if (!CHANNEL_ROLE_AXES.includes(axis as (typeof CHANNEL_ROLE_AXES)[number])) {
              issues.push(`ingress.mode_roles['${modeKey}'].${axis} is not a role axis`);
            } else if (typeof value !== 'boolean') {
              issues.push(`ingress.mode_roles['${modeKey}'].${axis} must be a boolean`);
            } else if (value === true && ceiling !== null && ceiling[axis] !== true) {
              // A mode may not grant what the vendor does not declare, or the
              // ceiling stops being the answer to "can this channel do X".
              issues.push(
                `ingress.mode_roles['${modeKey}'].${axis} may not grant a role absent from 'roles'`,
              );
            } else if (value === true) {
              issues.push(
                `ingress.mode_roles['${modeKey}'].${axis} repeats the ceiling — narrowing only`,
              );
            }
          }
          // A mode that gives up every axis is an inert mode — the same shape
          // the vendor-level role check already refuses.
          if (ceiling !== null) {
            const narrowed = CHANNEL_ROLE_AXES.filter((axis) =>
              ((override as Record<string, unknown>)[axis] ?? ceiling[axis]) === true);
            if (narrowed.length === 0) {
              issues.push(
                `ingress.mode_roles['${modeKey}'] leaves the mode with no role at all`,
              );
            }
          }
        }
      }
    }
  }

  if (e.recipient === null || typeof e.recipient !== 'object' || Array.isArray(e.recipient)) {
    issues.push("field 'recipient' must be an object");
  } else {
    const r = e.recipient as Record<string, unknown>;
    if (typeof r.field !== 'string' || r.field.length === 0) {
      issues.push("recipient.field must be a non-empty string");
    }
    if (typeof r.numeric_ok !== 'boolean') {
      issues.push("recipient.numeric_ok must be a boolean");
    }
  }

  if (e.identity === null || typeof e.identity !== 'object' || Array.isArray(e.identity)) {
    issues.push("field 'identity' must be an object");
  } else {
    const id = e.identity as Record<string, unknown>;
    if (
      typeof id.platform_id_source !== 'string' ||
      !MESSENGER_PLATFORM_ID_SOURCE_SET.has(id.platform_id_source)
    ) {
      issues.push(
        `identity.platform_id_source must be one of ${MESSENGER_PLATFORM_ID_SOURCES.join(' / ')}`,
      );
    }
  }

  if (e.projection === null || typeof e.projection !== 'object' || Array.isArray(e.projection)) {
    issues.push("field 'projection' must be an object");
  } else {
    const p = e.projection as Record<string, unknown>;
    if (typeof p.structured_tags !== 'boolean') {
      issues.push('projection.structured_tags must be a boolean');
    }
    if (typeof p.structured_mentions !== 'boolean') {
      issues.push('projection.structured_mentions must be a boolean');
    }
  }

  if (typeof e.auth !== 'string' || !MESSENGER_AUTH_KIND_SET.has(e.auth)) {
    issues.push(`field 'auth' must be one of ${MESSENGER_AUTH_KINDS.join(' / ')}`);
  }

  // Roles — all three required, all booleans, and at least ONE true. A vendor
  // declaring no role would enrol, probe, and sit there doing nothing: the
  // silent-until-runtime shape this arc keeps meeting.
  if (e.roles === null || typeof e.roles !== 'object' || Array.isArray(e.roles)) {
    issues.push("field 'roles' must be an object");
  } else {
    const r = e.roles as Record<string, unknown>;
    for (const axis of CHANNEL_ROLE_AXES) {
      if (typeof r[axis] !== 'boolean') {
        issues.push(`roles.${axis} must be a boolean`);
      }
    }
    if (r.notification === false && r.approval === false && r.messenger === false) {
      issues.push(
        "field 'roles' declares no role at all — a vendor that can neither notify, "
        + 'approve, nor converse cannot do anything',
      );
    }
  }

  // Health probe — the URL carries the vendor's credential (in a header, or in
  // the path itself), so both the transport (https) and the placement/template
  // agreement are validated here rather than trusted at probe time.
  if (
    e.health_probe === null ||
    typeof e.health_probe !== 'object' ||
    Array.isArray(e.health_probe)
  ) {
    issues.push("field 'health_probe' must be an object");
  } else {
    const hp = e.health_probe as Record<string, unknown>;
    const url = typeof hp.url === 'string' && hp.url.length > 0 ? hp.url : null;
    if (url === null) {
      issues.push('health_probe.url must be a non-empty string');
    }
    if (typeof hp.method !== 'string' || !MESSENGER_PROBE_METHOD_SET.has(hp.method)) {
      issues.push(`health_probe.method must be one of ${MESSENGER_PROBE_METHODS.join(' / ')}`);
    }
    const placement =
      typeof hp.auth === 'string' && MESSENGER_PROBE_AUTH_PLACEMENT_SET.has(hp.auth)
        ? hp.auth
        : null;
    if (placement === null) {
      issues.push(
        `health_probe.auth must be one of ${MESSENGER_PROBE_AUTH_PLACEMENTS.join(' / ')}`,
      );
    }
    if (url !== null) {
      // Parse with the placeholder filled — a bare `{token}` is legal in a path
      // segment, but resolving it keeps the check honest for either placement.
      let parsed: URL | null = null;
      try {
        parsed = new URL(url.split(MESSENGER_PROBE_TOKEN_PLACEHOLDER).join('probe-token'));
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        issues.push('health_probe.url must be an absolute URL');
      } else if (parsed.protocol !== 'https:') {
        issues.push("health_probe.url must use https (the probe carries the vendor's credential)");
      }
      if (placement !== null) {
        const templated = url.includes(MESSENGER_PROBE_TOKEN_PLACEHOLDER);
        if (placement === 'url_token' && !templated) {
          issues.push(
            `health_probe.url must contain the ${MESSENGER_PROBE_TOKEN_PLACEHOLDER} placeholder when health_probe.auth is 'url_token' (else the probe would run unauthenticated)`,
          );
        }
        if (placement === 'bearer_header' && templated) {
          issues.push(
            `health_probe.url must not contain the ${MESSENGER_PROBE_TOKEN_PLACEHOLDER} placeholder when health_probe.auth is 'bearer_header'`,
          );
        }
      }
    }
  }

  return issues;
}

/** Throwing wrapper — vendor entries run through `build*` so misconfiguration
 *  surfaces at module load. */
export function assertMessengerVendorDeclarationValid(entry: MessengerVendorDeclaration): void {
  const issues = assertMessengerVendorDeclarationShape(entry);
  if (issues.length > 0) {
    throw new Error(
      `invalid MessengerVendorDeclaration '${String(
        (entry as { vendor?: unknown }).vendor,
      )}': ${issues.join('; ')}`,
    );
  }
}

/** Build + validate one declaration. Keeps the registry literal honest (a typo
 *  in a surface / verification / source throws at load). Mirrors
 *  `buildConnectionVendorEntity`. */
export function buildMessengerVendorDeclaration(
  input: MessengerVendorDeclaration,
): MessengerVendorDeclaration {
  assertMessengerVendorDeclarationValid(input);
  return input;
}

/** Cross-entry registry validator — catches a duplicate `vendor` slug (each
 *  vendor may be declared at most once). Returns issue strings; empty when
 *  clean. Mirrors `assertConnectionVendorRegistry`. */
export function assertMessengerVendorRegistry(
  registry: ReadonlyArray<MessengerVendorDeclaration>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  registry.forEach((entry, idx) => {
    for (const i of assertMessengerVendorDeclarationShape(entry)) issues.push(`[${idx}] ${i}`);
    if (seen.has(entry.vendor)) {
      issues.push(`[${idx}] duplicate vendor '${entry.vendor}' — only one entry per vendor allowed`);
    } else {
      seen.add(entry.vendor);
    }
  });
  return issues;
}

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

/** D-192 M1 — the messenger (chat transport) vendor registry. Slack + Telegram
 *  are the two D-148 P9 inbound transports; Discord / Teams / WhatsApp arrive as
 *  one declaration entry + an adapter leaf each (§0). Every facet is grounded in
 *  the live substrate (the webhook descriptors, the `@recued/transport`
 *  transports, the recipient resolvers). */
export const MESSENGER_VENDOR_DECLARATIONS: ReadonlyArray<MessengerVendorDeclaration> = [
  buildMessengerVendorDeclaration({
    vendor: 'slack',
    display_name: 'Slack',
    surfaces: ['dm', 'group', 'channel', 'thread'],
    ingress: {
      mode: 'socket',
      supported_modes: ['socket', 'webhook'],
      verification: 'hmac',
      secret_field: 'signing_secret',
      id_field: 'event_id',
    },
    recipient: { field: 'channel_id', numeric_ok: false },
    // Slack `users.info` exposes `user.profile.email` with the
    // `users:read.email` scope — the M1 writer resolves a sender's `U…` id to
    // a canonical contact.
    identity: { platform_id_source: 'profile_email' },
    projection: { structured_tags: false, structured_mentions: false },
    auth: 'bot_token',
    // Everything. Slack is the reference shape.
    roles: { notification: true, approval: true, messenger: true },
    // `auth.test` is Slack's canonical token-verification endpoint: POST with
    // the bot token as a bearer header, `{ ok: false, error: 'invalid_auth' }`
    // on a bad token.
    health_probe: {
      url: 'https://slack.com/api/auth.test',
      method: 'POST',
      auth: 'bearer_header',
    },
  }),
  buildMessengerVendorDeclaration({
    vendor: 'telegram',
    display_name: 'Telegram',
    surfaces: ['dm', 'group', 'channel'],
    ingress: {
      mode: 'poll',
      supported_modes: ['poll', 'webhook'],
      verification: 'secret_token',
      secret_field: 'webhook_secret',
      id_field: 'update_id',
    },
    recipient: { field: 'chat_id', numeric_ok: true },
    // Telegram's Bot API exposes only a numeric user id / username, never an
    // email — the link writer is a structural no-op; the sender stays opaque.
    identity: { platform_id_source: 'none' },
    projection: { structured_tags: false, structured_mentions: false },
    auth: 'bot_token',
    // Everything. A user must `/start` the bot once, ever — a ONE-TIME unlock, not a
    // rolling window, so proactive reach never expires (contrast WhatsApp).
    roles: { notification: true, approval: true, messenger: true },
    // Telegram's Bot API takes NO auth header — the bot token is the URL path
    // segment (`/bot<token>/getMe`), so the token is substituted into the
    // template rather than applied as a header. `getMe` answers
    // `{ ok: false, description: 'Unauthorized' }` on a bad token.
    health_probe: {
      url: `https://api.telegram.org/bot${MESSENGER_PROBE_TOKEN_PLACEHOLDER}/getMe`,
      method: 'GET',
      auth: 'url_token',
    },
  }),
  buildMessengerVendorDeclaration({
    vendor: 'whatsapp',
    // ⚠ "WhatsApp Business API", not "WhatsApp". This is the Meta Cloud API on a
    // BUSINESS number — someone reading "WhatsApp" in a settings list will reasonably
    // assume their personal number works, and it does not.
    display_name: 'WhatsApp Business API',
    // Cloud API messages ONE WhatsApp user at a time. There is no group or
    // channel bot surface (business messaging cannot join a group), so `dm` is
    // the only truthful surface — not a v1 narrowing.
    surfaces: ['dm'],
    ingress: {
      mode: 'webhook',
      supported_modes: ['webhook'],
      // Meta signs the RAW request body with the App Secret and presents it as
      // `X-Hub-Signature-256: sha256=<hex>` — the same shared-secret HMAC family
      // as Slack, differing only in the base string (Slack prefixes `v0:<ts>:`
      // and gets a replay window from it; Meta signs the body alone, so there is
      // no timestamp to bound a replay with — the idempotency ledger is the only
      // replay defence, and it is exact here because Meta retries byte-identical
      // deliveries).
      verification: 'hmac',
      secret_field: 'app_secret',
      // ⚠ A PLAIN KEY NAME, never a path — the registry's `id_field` is read as a
      // flat property off the PROVIDER EVENT, not off the vendor payload. WhatsApp's
      // native message id is nested (`entry[].changes[].value.messages[].id`), so
      // the provider leaf walks it and re-surfaces it under this flat key. The
      // nesting is leaf work, exactly as the seam intends.
      id_field: 'message_id',
    },
    // ⚠ WhatsApp's conversation address is a PAIR, not an id: a send needs BOTH
    // the business phone-number id (it is the URL path) and the user's `wa_id`
    // (it is the body's `to`). `wa_id` names the half the owner enrolls; the
    // WhatsApp leaf composes the two into one opaque address string, because a
    // WhatsApp conversation genuinely IS a number-pair. See `whatsapp.ts`
    // `encodeWhatsAppAddress`.
    recipient: { field: 'wa_id', numeric_ok: true },
    // The Cloud API exposes a sender's `wa_id` (a phone number) and a profile
    // name — never an email. The contact-link writer is a structural no-op and
    // the sender stays opaque, as with Telegram. (A phone number IS a strong
    // contact key, but `MESSENGER_PLATFORM_ID_SOURCES` admits only `profile_email`
    // / `none` today; a phone-keyed source is a separate, honest widening.)
    identity: { platform_id_source: 'none' },
    projection: { structured_tags: false, structured_mentions: false },
    // Already declared AND already deliverable (`cloud_api: ['bearer']`) — the
    // Cloud API takes a long-lived bearer access token, so the send path and the
    // enroll gate take this vendor as-is.
    auth: 'cloud_api',
    // ⚠ CONVERSATION ONLY. Meta permits a business to message a user ONLY within 24
    // hours of THAT USER's last message (outside it: a pre-approved template, billed
    // per conversation). Recued's notify + approve axes are both UNPROMPTED by
    // definition — Recued speaks first — which is exactly what the window forbids: an
    // approval sent into a quiet thread fails with Meta error 131047. So WhatsApp is
    // the one channel of the four that cannot be relied on to reach you, and it is
    // declared honestly rather than offered with a footnote.
    //
    // The messenger axis is unaffected, and works cleanly: YOU open the window by
    // messaging, and Recued replies inside it. That is the whole shape of this vendor.
    //
    // KNOWN COST, accepted: an approval raised DURING a WhatsApp conversation also goes
    // elsewhere, even though the window is definitionally open at that moment. Fixing
    // that properly means tracking last-inbound-time per conversation and gating the ask
    // on it — real state, real complexity — so the simple honest `false` wins until it
    // actually bites. The follow-on, if it does, is a `reply_only` state on this axis.
    roles: { notification: false, approval: false, messenger: true },
    // Graph's identity node. It carries NO id, which matters: `health_probe.url`
    // is a static template with no config interpolation, so a per-connection
    // `/{phone_number_id}` endpoint could not be declared here. `/me` also
    // classifies correctly by luck of the placement — Graph answers a bad
    // *query-param* token with 400 (which the prober would read as `unreachable`)
    // but a bad *Bearer header* with 401, which is what the prober sends and what
    // it maps to `auth_failed`. Verified against the live API, not assumed.
    health_probe: {
      url: 'https://graph.facebook.com/v22.0/me',
      method: 'GET',
      auth: 'bearer_header',
    },
  }),
  buildMessengerVendorDeclaration({
    vendor: 'discord',
    display_name: 'Discord',
    // A bot posts to a channel by id; a DM is just a channel you open first. The
    // id is the id either way, which is why the recipient facet is simple here.
    surfaces: ['dm', 'channel', 'thread'],
    ingress: {
      // Gateway is the local-first full-chat path: outbound WSS carries
      // MESSAGE_CREATE plus interaction events without opening a public listener.
      // The advanced webhook alternative remains approvals-only because Discord's
      // Interactions endpoint does not deliver ordinary messages.
      mode: 'socket',
      supported_modes: ['socket', 'webhook'],
      // ⚠ THE ONE ROLE THAT MOVES WITH THE MODE, in the whole registry.
      // Gateway carries MESSAGE_CREATE, so Discord is a full conversation there.
      // The Interactions endpoint carries button presses and nothing else — no
      // ordinary message ever arrives — so webhook mode is notify + approve, the
      // shape Discord shipped as before the Gateway existed. Stating it here
      // keeps `roles` meaning "what this vendor can do" (which is what makes the
      // channel enrollable at all) while the mode says what it gives up.
      mode_roles: { webhook: { messenger: false } },
      // ASYMMETRIC — the first non-shared-secret scheme. Signature over
      // `<X-Signature-Timestamp><raw body>`, verified against the app's PUBLIC key.
      verification: 'ed25519',
      // A PUBLIC key, despite the facet's name — see `MessengerIngress.secret_field`.
      secret_field: 'public_key',
      // Every interaction carries a unique snowflake `id`, flat on the envelope.
      id_field: 'interaction_id',
    },
    // The channel id IS the send URL's path segment AND the bound conversation —
    // no pair needed (contrast WhatsApp, whose send URL is account-scoped). A
    // Discord snowflake is a numeric string; accept it typed either way.
    recipient: { field: 'channel_id', numeric_ok: true },
    // The interaction carries `member.user.id` / `user.id` — a snowflake, never an
    // email. Structural no-op, as with Telegram and WhatsApp.
    identity: { platform_id_source: 'none' },
    projection: { structured_tags: false, structured_mentions: false },
    auth: 'bot_token',
    // Gateway MESSAGE_CREATE makes Discord a full conversation channel in local
    // mode; Interactions continues carrying approval presses in either mode.
    roles: { notification: true, approval: true, messenger: true },
    // ⚠ `bot_header`, NOT `bearer_header`. Discord reads `Bearer` as an OAuth2 user
    // token, so probing a perfectly valid BOT token with the wrong scheme returns
    // 401 and reports `auth_failed` on a healthy channel. Verified against the live
    // API: `/users/@me` answers 401 for a bad token under either scheme, which is
    // precisely why the wrong scheme would be indistinguishable from a wrong token.
    health_probe: {
      url: 'https://discord.com/api/v10/users/@me',
      method: 'GET',
      auth: 'bot_header',
    },
  }),
];

// ────────────────────────────────────────────────────────────────
// Accessors (defaulted-registry param — a live/merged registry can be passed)
// ────────────────────────────────────────────────────────────────

/** Look up one vendor's declaration. Returns `null` for an undeclared vendor
 *  (the caller treats it as a plain, un-generalized string). */
export const getMessengerVendorDeclaration = (
  vendor: string,
  registry: ReadonlyArray<MessengerVendorDeclaration> = MESSENGER_VENDOR_DECLARATIONS,
): MessengerVendorDeclaration | null => {
  for (const entry of registry) {
    if (entry.vendor === vendor) return entry;
  }
  return null;
};

/** Is `mode` a declared option for this vendor? Kept beside the registry so
 *  enrollment, webhook routing, and the local supervisor cannot drift. */
export const messengerVendorSupportsIngressMode = (
  declaration: MessengerVendorDeclaration,
  mode: unknown,
): mode is MessengerIngressMode =>
  typeof mode === 'string'
  && MESSENGER_INGRESS_MODE_SET.has(mode)
  && declaration.ingress.supported_modes.includes(mode as MessengerIngressMode);

/** Resolve a persisted connection's active ingress. New enrollment always
 *  writes the explicit default. Absence therefore means a pre-upgrade row, and
 *  preserves its historical webhook behavior when possible. An explicit bad
 *  value is rejected (`null`) instead of silently selecting another mode. */
export const resolveMessengerConnectionIngressMode = (
  declaration: MessengerVendorDeclaration,
  config: Readonly<Record<string, unknown>>,
): MessengerIngressMode | null => {
  const raw = config[MESSENGER_INGRESS_MODE_CONFIG_KEY];
  if (raw === undefined) {
    return declaration.ingress.supported_modes.includes('webhook')
      ? 'webhook'
      : declaration.ingress.mode;
  }
  return messengerVendorSupportsIngressMode(declaration, raw) ? raw : null;
};

/** The roles a vendor actually carries in one ingress mode — the declared
 *  ceiling with that mode's narrowing applied. The ONE seam for "can this
 *  connection do X", so the turn, the funnel, and the Settings axis cannot
 *  answer it three ways.
 *
 *  `mode === null` means the mode could not be resolved (a malformed or
 *  unsupported `config.ingress_mode`). That fails CLOSED to the floor — what is
 *  true in EVERY supported mode — because an unresolvable mode is not evidence
 *  of a capability. */
export const resolveMessengerVendorRoles = (
  declaration: MessengerVendorDeclaration,
  mode: MessengerIngressMode | null,
): ChannelRoles => {
  const ceiling = declaration.roles;
  const overrides = declaration.ingress.mode_roles;
  if (overrides === undefined) return { ...ceiling };
  const modes = mode === null ? declaration.ingress.supported_modes : [mode];
  const resolved = { ...ceiling };
  for (const axis of CHANNEL_ROLE_AXES) {
    // Narrowing only, so a role survives exactly when every mode in scope keeps
    // it — which for a single mode is that mode, and for the null floor is all.
    resolved[axis] = ceiling[axis]
      && modes.every((candidate) => overrides[candidate]?.[axis] !== false);
  }
  return resolved;
};

/** Convenience over `resolveMessengerVendorRoles` for a stored connection: read
 *  the row's active mode, then narrow. Same fail-closed posture. */
export const resolveMessengerConnectionRoles = (
  declaration: MessengerVendorDeclaration,
  config: Readonly<Record<string, unknown>>,
): ChannelRoles => resolveMessengerVendorRoles(
  declaration,
  resolveMessengerConnectionIngressMode(declaration, config),
);

/** List every declared vendor slug (insertion order, deduped). */
export const listMessengerVendors = (
  registry: ReadonlyArray<MessengerVendorDeclaration> = MESSENGER_VENDOR_DECLARATIONS,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of registry) {
    if (seen.has(entry.vendor)) continue;
    seen.add(entry.vendor);
    out.push(entry.vendor);
  }
  return out;
};

/** Predicate — true when `vendor` has a declaration. */
export const isDeclaredMessengerVendor = (
  vendor: unknown,
  registry: ReadonlyArray<MessengerVendorDeclaration> = MESSENGER_VENDOR_DECLARATIONS,
): vendor is string =>
  typeof vendor === 'string' && getMessengerVendorDeclaration(vendor, registry) !== null;

// Boot-time registry self-validation (mirrors `connection-vendors.ts`). Each
// entry is already validated in isolation by `buildMessengerVendorDeclaration`;
// this catches the CROSS-ENTRY invariant a per-entry check cannot — a duplicate
// `vendor` slug (two individually-valid entries) — so a bad future edit fails at
// module load, not silently (the second entry would otherwise be shadowed by
// every accessor).
const _bootIssues = assertMessengerVendorRegistry(MESSENGER_VENDOR_DECLARATIONS);
if (_bootIssues.length > 0) {
  throw new Error(`MESSENGER_VENDOR_DECLARATIONS boot validation failed: ${_bootIssues.join('; ')}`);
}

// Seam 10 — the slug tuple and the declarations must name the SAME vendors, in
// BOTH directions. They are two halves of one registry (the tuple is the
// type-level half, the declarations the data half), and each half is useless
// without the other: a declared vendor missing from the tuple would be
// UNROUTABLE (no `ChannelName`, so `createRemoteChannel` rejects it and it can
// never back a channel), while a slug with no declaration would TYPE as routable
// but have no facets (no ingress, no recipient field, no health probe) and blow
// up at the first use. Both are silent-until-runtime failures, so they fail at
// module load instead.
const _declaredVendors = new Set(MESSENGER_VENDOR_DECLARATIONS.map((e) => e.vendor));
const _slugSet: ReadonlySet<string> = new Set(MESSENGER_VENDOR_SLUGS);
const _slugsWithoutDeclaration = MESSENGER_VENDOR_SLUGS.filter((s) => !_declaredVendors.has(s));
const _declarationsWithoutSlug = [..._declaredVendors].filter((v) => !_slugSet.has(v));
if (_slugsWithoutDeclaration.length > 0 || _declarationsWithoutSlug.length > 0) {
  throw new Error(
    'messenger registry boot validation failed — MESSENGER_VENDOR_SLUGS and ' +
      'MESSENGER_VENDOR_DECLARATIONS disagree: ' +
      [
        _slugsWithoutDeclaration.length > 0
          ? `slug(s) with no declaration: ${_slugsWithoutDeclaration.join(', ')}`
          : '',
        _declarationsWithoutSlug.length > 0
          ? `declaration(s) with no slug: ${_declarationsWithoutSlug.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('; '),
  );
}

// A vendor whose declared auth kind has NO deliverable `ConnectionAuth` shape
// (`MESSENGER_AUTH_KIND_CONNECTION_TYPES`) could enroll a row that probes green,
// reports ready, and then silently drops every send — the failure this map exists
// to prevent. It cannot be caught per-entry (the shape validator only sees the
// kind, not whether the substrate can deliver it), and it cannot be caught by the
// compiler (the map is total over `MessengerAuthKind` by type, but a kind may
// legitimately map to the empty list). So it fails at module load, loudly, the
// same way the two cross-checks above do — and the message says what to build.
const _undeliverable = MESSENGER_VENDOR_DECLARATIONS.filter(
  (entry) => MESSENGER_AUTH_KIND_CONNECTION_TYPES[entry.auth].length === 0,
);
if (_undeliverable.length > 0) {
  throw new Error(
    'messenger registry boot validation failed — vendor(s) declared with a credential ' +
      'model the send path cannot deliver: ' +
      _undeliverable.map((e) => `${e.vendor} (auth: '${e.auth}')`).join(', ') +
      ". Wire the kind first — a deliverable shape in MESSENGER_AUTH_KIND_CONNECTION_TYPES, " +
      "a token refresher for kind: 'notification', and an enroll card — or the connection " +
      'would enroll, probe healthy, and then silently never deliver a single message.',
  );
}
