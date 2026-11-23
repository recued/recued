/** D-201 — what this server tells Settings it can do for one webhook profile:
 *  the registration modes it can carry out, how it recognises a repeated
 *  delivery and (Slice 10C) the event catalog it admits, grammar included, so
 *  Settings checks a typed event name against the server's own language
 *  rather than a copy of a vendor's rule. */

import type {
  WebhookEventTypeCatalog,
  WebhookProfileDescriptor,
  WebhookProfileRuntimeCapabilityView,
} from '@recued/contracts';

const projectEventTypeCatalog = (
  catalog: WebhookEventTypeCatalog,
): WebhookEventTypeCatalog => catalog.kind === 'closed'
  ? Object.freeze({
      kind: 'closed' as const,
      values: Object.freeze([...catalog.values]),
    })
  : Object.freeze({
      kind: 'open' as const,
      known_values: Object.freeze([...catalog.known_values]),
      grammar: Object.freeze({ ...catalog.grammar }),
      // D-201 Slice 10T — and the names the service never lists back.
      ...(catalog.never_listed !== undefined
        ? { never_listed: Object.freeze([...catalog.never_listed]) }
        : {}),
    });

/** `managedRegistrationAvailable`: whether this server can register the
 *  address at the service itself (a registration adapter is composed). */
export const webhookProfileRuntimeCapability = (
  descriptor: WebhookProfileDescriptor,
  managedRegistrationAvailable: boolean,
): WebhookProfileRuntimeCapabilityView => Object.freeze({
  profile_id: descriptor.profile_id,
  registration_modes: Object.freeze(descriptor.registration_modes.filter((mode) =>
    mode !== 'managed_endpoint' || managedRegistrationAvailable)),
  deduplication: Object.freeze({
    ...descriptor.deduplication,
    identity: Object.freeze({ ...descriptor.deduplication.identity }),
  }),
  event_types: projectEventTypeCatalog(descriptor.event_types),
});
