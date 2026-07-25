/**
 * Server-minted provenance binding for a scheduling reservation's deterministic
 * booking id.
 *
 * The materialize ingredient is callable by recipes, so neither
 * `booking_request_id` nor `booking_id` is authoritative merely because it
 * arrived at the projection seam.  The scheduling drain is the component that
 * knows both values are related; it binds that exact pair with the reception
 * key and the mint verifies it before reading either caller-selected record.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const DOMAIN = Buffer.from('recued.reception.booking-binding.v1\0', 'utf8');
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;

const encodePart = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

const message = (booking_request_id: string, booking_id: string): Buffer =>
  Buffer.concat([
    DOMAIN,
    encodePart(booking_request_id),
    encodePart(booking_id),
  ]);

export const mintReceptionBookingBinding = (
  key: Uint8Array,
  input: {
    readonly booking_request_id: string;
    readonly booking_id: string;
  },
): string => {
  if (input.booking_request_id.length === 0 || input.booking_id.length === 0) {
    throw new Error('reception booking binding requires non-empty ids');
  }
  return createHmac('sha256', Buffer.from(key))
    .update(message(input.booking_request_id, input.booking_id))
    .digest('base64url');
};

export const verifyReceptionBookingBinding = (
  key: Uint8Array,
  input: {
    readonly booking_request_id: string;
    readonly booking_id: string;
    readonly booking_binding: string;
  },
): boolean => {
  if (
    input.booking_request_id.length === 0
    || input.booking_id.length === 0
    || !BINDING_RE.test(input.booking_binding)
  ) {
    return false;
  }
  const expected = Buffer.from(
    mintReceptionBookingBinding(key, input),
    'ascii',
  );
  const received = Buffer.from(input.booking_binding, 'ascii');
  return received.length === expected.length && timingSafeEqual(received, expected);
};
