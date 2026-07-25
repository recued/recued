/** Phase 7 (D-110) — S3 bucket notification parser.
 *
 *  Parses an AWS S3 Event payload (either the raw POST body or the
 *  `Records` array of a signed SNS envelope) into the canonical
 *  FileAdapterEvent stream. Bucket notifications are optional — the
 *  adapter falls back to polling when caps.watch === 'poll'. When
 *  the user configures a notification destination + webhook, this
 *  module is what turns the JSON into events.
 *
 *  We accept two shapes:
 *    - Direct S3 event (POST from an SNS http subscriber or from a
 *      Lambda that proxies the event).
 *    - SNS envelope (subscribed via HTTP/S) — extracts the nested
 *      `Message` JSON then applies the same parse.
 *
 *  Events of type `ObjectCreated:*` map to `change`;
 *  `ObjectRemoved:*` map to `remove`. Other event types
 *  (restore, replication) are ignored.
 */

import type { FileAdapterEvent } from '../../adapter-registry.js';

interface S3EventRecord {
  eventName?: string;
  s3?: {
    bucket?: { name?: string };
    object?: { key?: string };
  };
}

interface S3EventEnvelope {
  Records?: S3EventRecord[];
}

const decodeKey = (encoded: string): string => {
  // S3 URL-encodes '+' as ' ' — decodeURIComponent handles percent
  // escapes; we restore the plus-to-space for parity.
  const decoded = decodeURIComponent(encoded.replace(/\+/g, ' '));
  return decoded;
};

const eventType = (eventName: string): FileAdapterEvent['type'] | null => {
  if (eventName.startsWith('ObjectCreated:')) return 'change';
  if (eventName.startsWith('ObjectRemoved:')) return 'remove';
  return null;
};

export const parseS3Notification = (
  body: string,
  expectedBucket?: string,
): FileAdapterEvent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  // SNS envelope — Message field carries the real S3 event as JSON.
  const envelope = parsed as { Type?: string; Message?: string } & S3EventEnvelope;
  if (envelope.Type === 'Notification' && typeof envelope.Message === 'string') {
    return parseS3Notification(envelope.Message, expectedBucket);
  }

  const events: FileAdapterEvent[] = [];
  const records = envelope.Records ?? [];
  for (const record of records) {
    const name = record.eventName;
    const bucket = record.s3?.bucket?.name;
    const key = record.s3?.object?.key;
    if (!name || !bucket || !key) continue;
    if (expectedBucket && bucket !== expectedBucket) continue;
    const t = eventType(name);
    if (!t) continue;
    events.push({ type: t, path: decodeKey(key) });
  }
  return events;
};
