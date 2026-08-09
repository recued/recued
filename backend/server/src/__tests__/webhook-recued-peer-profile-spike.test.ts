/** SPIKE probe — does the Recued peer profile actually COMPOSE at runtime?
 *
 * `tsc` cannot answer this. The preset registry validates each preset against
 * its descriptor at MODULE LOAD and throws on mismatch, and the profile module
 * throws if any composed preset came back null. So importing the module is the
 * test: it either assembles from the D-201 primitives or it does not.
 */

import { describe, expect, it } from 'vitest';

import { webhookProfile } from '@recued/contracts';
import {
  RECUED_PEER_JSON_EVENT_NORMALIZER_PRESET,
  RECUED_PEER_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  RECUED_PEER_TIMESTAMPED_HMAC_MECHANISM_PRESET,
  createRecuedPeerWebhookProfileAdapter,
  validateRecuedPeerWebhookCredentialShape,
} from '../webhook-recued-peer-profile.js';

describe('recued-peer.exchange.v1 composes from D-201 primitives', () => {
  it('assembles an ingress adapter with no peer-specific code path', () => {
    expect(createRecuedPeerWebhookProfileAdapter()).toBeTruthy();
    expect(RECUED_PEER_TIMESTAMPED_HMAC_MECHANISM_PRESET).toBeTruthy();
  });

  it('routes on the envelope kind rather than a single literal event type', () => {
    // The whole reason this is not just `generic.timestamped-raw-body-hmac`.
    expect(RECUED_PEER_JSON_EVENT_NORMALIZER_PRESET?.event_type_field).toBe('kind');
    const descriptor = webhookProfile('recued-peer.exchange.v1');
    expect(descriptor?.event_types.kind).toBe('open');
  });

  it('requires action_ref and uses it as the dedup identity', () => {
    expect(RECUED_PEER_JSON_EVENT_NORMALIZER_PRESET?.event_id_field).toBe('action_ref');
    expect(RECUED_PEER_JSON_EVENT_NORMALIZER_PRESET?.event_id_required).toBe(true);
    // `WebhookNormalizedDeliveryDeduplicatorPreset` is a three-member union and
    // `stable_id_prefix` is absent from the paired-id member, so the property
    // read needs the discriminant first. Narrowed rather than cast: this now
    // also pins WHICH deduplicator the peer profile uses, which is the thing a
    // cast would have quietly stopped checking.
    const dedup = RECUED_PEER_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET;
    expect(dedup?.kind).toBe('normalized_id_or_timestamp_body_sha256.v1');
    if (dedup?.kind !== 'normalized_id_or_timestamp_body_sha256.v1') {
      throw new Error('peer profile must use the id-or-timestamp-body deduplicator');
    }
    expect(dedup.stable_id_prefix).toBe('recued:peer:');
  });

  it('pins the protocol version at admission', () => {
    expect(RECUED_PEER_JSON_EVENT_NORMALIZER_PRESET?.exact_string_requirement)
      .toEqual({ field: 'v', value: '1' });
  });

  it('mints the signing secret rather than asking the owner to type one', () => {
    const descriptor = webhookProfile('recued-peer.exchange.v1');
    expect(descriptor?.fields).toHaveLength(1);
    expect(descriptor?.fields[0]?.source).toBe('recued_generated');
  });

  it('rejects a credential object carrying spare authority', () => {
    expect(validateRecuedPeerWebhookCredentialShape({ signing_secret: 's' })).toBe(true);
    expect(validateRecuedPeerWebhookCredentialShape({ signing_secret: 's', extra: 'x' }))
      .toBe(false);
  });
});
