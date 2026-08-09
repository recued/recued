/** SPIKE — Recued-to-Recued peer exchange profile.
 *
 * Written to answer one question: does a peer profile COMPOSE from the D-201
 * primitives, or does it fight them? Structurally it is the Stripe module with
 * the vendor removed — same neutral timestamped-HMAC JSON single-event
 * composer, same preset assembly, no peer-specific branch anywhere in request
 * orchestration, failure mapping, or clock gating.
 *
 * The envelope is ours:
 *
 *     { "v": "1", "kind": "appointment.reply",
 *       "action_ref": "...", "ts": 1730000000, "data": { ... } }
 *
 * `kind` routes at the trigger, `action_ref` is both correlation handle and
 * dedup identity, and `v` is pinned at admission so a future envelope cannot
 * reach a recipe expecting this one.
 */

import type { WebhookClockHealthAuthority } from './webhook-clock-health.js';
import { webhookTimestampedHmacDeliveryProfilePreset } from './webhook-delivery-engine-presets.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';
import {
  createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter,
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator,
  createTimestampedJsonSingleEventWebhookProfileAdapter,
} from './webhook-timestamped-json-single-event-profile.js';

const RECUED_PEER_PROFILE_ID = 'recued-peer.exchange.v1' as const;

const peerDeliveryEnginePreset = webhookTimestampedHmacDeliveryProfilePreset(
  RECUED_PEER_PROFILE_ID,
);
if (peerDeliveryEnginePreset === null) {
  throw new Error('Recued peer timestamped HMAC delivery preset is unavailable');
}
if (peerDeliveryEnginePreset.decoder === null) {
  throw new Error('Recued peer JSON delivery preset is unavailable');
}
if (peerDeliveryEnginePreset.event_normalizer === null) {
  throw new Error('Recued peer JSON event normalizer preset is unavailable');
}
if (peerDeliveryEnginePreset.event_projector === null) {
  throw new Error('Recued peer normalized event projector preset is unavailable');
}
if (peerDeliveryEnginePreset.delivery_deduplicator === null) {
  throw new Error('Recued peer delivery deduplicator preset is unavailable');
}

export const RECUED_PEER_TIMESTAMPED_HMAC_MECHANISM_PRESET =
  peerDeliveryEnginePreset.mechanism;
export const RECUED_PEER_JSON_OBJECT_DECODER_PRESET =
  peerDeliveryEnginePreset.decoder;
export const RECUED_PEER_JSON_EVENT_NORMALIZER_PRESET =
  peerDeliveryEnginePreset.event_normalizer;
export const RECUED_PEER_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET =
  peerDeliveryEnginePreset.event_projector;
export const RECUED_PEER_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET =
  peerDeliveryEnginePreset.delivery_deduplicator;

const peerCredentialShapeValidator =
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator(
    RECUED_PEER_PROFILE_ID,
  );

/** The peer signing secret is the whole delivery credential. Reject extra,
 * hidden, inherited, or accessor fields so an enrolment cannot carry ignored
 * authority beside the value the mechanism verifies.
 */
export const validateRecuedPeerWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => peerCredentialShapeValidator(credentials);

const peerProfileAdapter =
  createTimestampedJsonSingleEventWebhookProfileAdapter(RECUED_PEER_PROFILE_ID);

/** Pure adapter for profile fixtures. Production uses the clock-gated composer
 * below so caller-controlled wall time cannot become freshness authority.
 */
export const createRecuedPeerWebhookProfileAdapter = (
): WebhookIngressProfileAdapter => peerProfileAdapter;

export const createClockGatedRecuedPeerWebhookProfileAdapter = (
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter =>
  createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter(
    RECUED_PEER_PROFILE_ID,
    authority,
  );
