/** The three role axes, in a LEAF module that imports nothing.
 *
 *  ⚠ Why this is its own file rather than living in `notifications.ts` with
 *  `CHANNEL_ROLES`: `notifications.ts` builds that map by spreading
 *  `MESSENGER_VENDOR_SLUGS` from `messenger-vendors.ts`, and the messenger
 *  registry's own validator needs the axis list. A value import in both
 *  directions is a runtime cycle — whichever module evaluates first sees the
 *  other half-initialized, and the failure surfaces far away as
 *  "MESSENGER_VENDOR_SLUGS is not iterable" at import time. A type-only import
 *  hid this for as long as the axes were a type; the moment the list became a
 *  VALUE the cycle became real. Keeping the shared vocabulary in a leaf both
 *  sides depend on is the fix that stays fixed. */

/** What a notification channel can be USED for. Declared per channel; the
 *  owner's settings can only ever turn OFF something the channel could do. */
export interface ChannelRoles {
  /** Recued can alert you here, unprompted. */
  notification: boolean;
  /** Recued can ask you here, unprompted, and get an answer back. */
  approval: boolean;
  /** You can talk to Recued here — a chat turn. */
  messenger: boolean;
}

/** The axes, once, so every reader iterates the same list. Hand-spelling it per
 *  call site is how one site keeps checking two axes after a third is added —
 *  the ratchet below turns that into a compile error instead. */
export const CHANNEL_ROLE_AXES = [
  'notification',
  'approval',
  'messenger',
] as const satisfies readonly (keyof ChannelRoles)[];

export type ChannelRoleAxis = (typeof CHANNEL_ROLE_AXES)[number];

/** Compile-time exhaustiveness: `satisfies` proves every listed axis is a real
 *  key, this proves every real key is listed. Adding a field to `ChannelRoles`
 *  without adding it above fails to typecheck here. */
const _channelRoleAxesAreExhaustive: Exclude<keyof ChannelRoles, ChannelRoleAxis> extends never
  ? true
  : never = true;
void _channelRoleAxesAreExhaustive;

/** D-163 N.1 — HOW an ask renders on a channel, as opposed to WHAT the channel
 *  may be used for (`ChannelRoles` above).
 *
 *  ⚠ Lives in this leaf for the same reason the axes do. `messenger-vendors.ts`
 *  now declares a `capability` per vendor and validates it, while
 *  `notifications.ts` builds the per-channel table by spreading
 *  `MESSENGER_VENDOR_SLUGS` — so defining the vocabulary in `notifications.ts`
 *  and importing it into the registry would close exactly the runtime cycle this
 *  file was created to break.
 *
 *   - `inline`       — "Answer here". The medium renders option buttons and
 *                      decodes the press (an `InteractiveTransport`).
 *   - `landing-page` — "Answer via [link]". The medium carries a link to a
 *                      surface that renders the ask; `email` ships this.
 *   - `notify-only`  — cannot carry an ask at all. Receives a passive notify
 *                      that one is pending. ⛔ A `notify-only` channel MUST
 *                      declare `approval: false` — you cannot approve where you
 *                      cannot render — and that pairing is enforced at both
 *                      declaration load and channel construction. */
export const NOTIFICATION_CHANNEL_CAPABILITIES = [
  'inline',
  'landing-page',
  'notify-only',
] as const;

export type NotificationChannelCapability =
  (typeof NOTIFICATION_CHANNEL_CAPABILITIES)[number];

export const NOTIFICATION_CHANNEL_CAPABILITY_SET: ReadonlySet<string> = new Set(
  NOTIFICATION_CHANNEL_CAPABILITIES,
);

