/** D-149 P2 § A.5 — per-kind reception handler registry.
 *
 *  Maps each `ReceptionPacketKind` to its handler skeleton. P3 will
 *  wire this registry into the path-routing dispatch — at P2 the
 *  registry is exported so the role-boundary lint can scan all six
 *  handlers without ad-hoc path discovery.
 *
 *  Adding a new reception kind = adding the kind to the
 *  `RECEPTION_PACKET_KINDS` closed list in `redacted-packet.ts`
 *  AND adding a handler skeleton file here AND wiring it into the
 *  registry below. TypeScript's exhaustive map check surfaces any
 *  drift between the three locations. */

import { RECEPTION_PACKET_KINDS, type ReceptionPacketKind } from '../redacted-packet.js';
import { handleApprovalLinkPacket } from './approval-link.js';
import { handleDropLinkPacket } from './drop-link.js';
import { handleIntakeFormPacket } from './intake-form.js';
import { handleReceptionPagePacket } from './reception-page.js';
import { handleSchedulingLinkPacket } from './scheduling-link.js';
import { handleStatusLinkPacket } from './status-link.js';
import type { ReceptionKindHandler } from './types.js';

export type { ReceptionKindHandler } from './types.js';
export {
  handleReceptionPagePacket,
  handleSchedulingLinkPacket,
  handleIntakeFormPacket,
  handleDropLinkPacket,
  handleApprovalLinkPacket,
  handleStatusLinkPacket,
};

/** Closed-list map — every reception kind has a handler skeleton.
 *  TypeScript checks exhaustiveness via the `Record<...>` constraint;
 *  adding a kind without adding a handler entry surfaces here. */
export const RECEPTION_KIND_HANDLERS: Readonly<Record<ReceptionPacketKind, ReceptionKindHandler>> = {
  reception_page_packet: handleReceptionPagePacket,
  scheduling_link_packet: handleSchedulingLinkPacket,
  intake_form_packet: handleIntakeFormPacket,
  drop_link_packet: handleDropLinkPacket,
  approval_link_packet: handleApprovalLinkPacket,
  status_link_packet: handleStatusLinkPacket,
};

/** Substrate self-check — asserts every entry in `RECEPTION_PACKET_KINDS`
 *  has a matching handler entry. Mirrors the closed-list ratchet
 *  pattern from `redacted-packet.ts`; throws on drift so the boot
 *  path surfaces misconfiguration immediately. */
export const assertReceptionHandlerRegistryComplete = (): void => {
  const missing: ReceptionPacketKind[] = [];
  for (const kind of RECEPTION_PACKET_KINDS) {
    if (typeof RECEPTION_KIND_HANDLERS[kind] !== 'function') missing.push(kind);
  }
  if (missing.length > 0) {
    throw new Error(`RECEPTION_KIND_HANDLERS missing entries: ${missing.join(', ')}`);
  }
};
