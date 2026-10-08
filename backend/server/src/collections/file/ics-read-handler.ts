/** D-315 slice 7 (ruling 34) — `core.storage.ics.read`: one stored iCalendar
 *  file — an invite, a guest's answer, a cancellation — read into its method
 *  and its events, with the owner placed in each (organizer, guest, neither).
 *
 *  🔑 THE PARSER IS NOT HERE. `parseIcs` is a pure function in
 *  `@recued/transforms`, and mail ingest keys its one-run-per-invite rule off
 *  the same module (`icsInviteKey`): the file the recipe reads is read exactly
 *  as the email's copy was told apart. This file owns the I/O and the two
 *  things only the server knows — the owner's addresses (every connected
 *  mailbox's own) and the owner's zone (a floating time, an all-day event's
 *  midnight).
 *
 *  ⚠ A file that is not a calendar is `found: false`, not an error: an invite
 *  recipe wakes on calendar files, but a recipe may name any file, and "this is
 *  no invite" is an answer, not a failure. Its type is checked before its bytes
 *  are read, so a PDF costs no read.
 *
 *  ⛔ Fenced as `data.file` (`deriveDispatchScope`), the gate every read of a
 *  stored file's content passes — the same read `data-file-read` makes. */

import { RpcError } from '@recued/contracts';
import { ICS_MAX_BYTES, looksLikeIcs, parseIcs, type IcsEvent, type IcsMethod } from '@recued/transforms';

export interface IcsReadDeps {
  /** A received file's hot fields, without its bytes; `null` when no file has
   *  that id. */
  readonly stat: (record_id: string) => Readonly<Record<string, unknown>> | null;
  /** The gated read of the file's bytes, refusing one over `maxBytes`. */
  readonly readFile: (input: { record_id: string }, maxBytes: number) => Promise<{ bytes_b64: string }>;
  /** Every connected mailbox's own address. */
  readonly ownerAddresses: () => readonly string[];
  /** The owner's IANA zone. */
  readonly ownerTimeZone: () => string;
}

export interface IcsReadInput {
  readonly record_id?: unknown;
  /** The owner's other addresses — an alias the mailboxes do not name. */
  readonly addresses?: unknown;
}

export interface IcsReadResponse {
  /** Whether the file is an iCalendar object with at least its frame read. */
  readonly found: boolean;
  readonly record_id: string;
  readonly filename: string | null;
  readonly method: IcsMethod;
  readonly event: IcsEvent | null;
  readonly events: readonly IcsEvent[];
  readonly event_count: number;
  readonly truncated: boolean;
  readonly problems: readonly string[];
}

const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics', 'text/x-vcalendar']);

const nothing = (record_id: string, filename: string | null, problems: readonly string[] = []): IcsReadResponse => ({
  found: false, record_id, filename, method: 'none', event: null, events: [], event_count: 0, truncated: false, problems,
});

const addressList = (raw: unknown): string[] => {
  if (raw === undefined || raw === null || raw === '') return [];
  // A setting may hold one address or several, comma-separated.
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter((a) => a.length > 0);
};

export const handleIcsRead = async (deps: IcsReadDeps, input: IcsReadInput): Promise<IcsReadResponse> => {
  const record_id = typeof input.record_id === 'string' ? input.record_id.trim() : '';
  if (record_id.length === 0) throw new RpcError('bad_request', 'ics.read: record_id is required', 400);
  const hot = deps.stat(record_id);
  if (hot === null) throw new RpcError('not_found', `ics.read: no stored file '${record_id}'`, 404);
  const filename = typeof hot.filename === 'string' ? hot.filename : null;
  const mime = typeof hot.mime_type === 'string' ? hot.mime_type.toLowerCase() : '';
  if (!CALENDAR_TYPES.has(mime) && !/\.ics$/i.test(filename ?? '')) return nothing(record_id, filename);
  if (typeof hot.size === 'number' && hot.size > ICS_MAX_BYTES) {
    return nothing(record_id, filename, [`the file is larger than ${ICS_MAX_BYTES} bytes`]);
  }
  const { bytes_b64 } = await deps.readFile({ record_id }, ICS_MAX_BYTES);
  const bytes = new Uint8Array(Buffer.from(bytes_b64, 'base64'));
  if (!looksLikeIcs(bytes)) return nothing(record_id, filename);
  const parsed = parseIcs(bytes, {
    timeZone: deps.ownerTimeZone(),
    addresses: [...deps.ownerAddresses(), ...addressList(input.addresses)],
  });
  if (!parsed.ok) return nothing(record_id, filename, parsed.problems);
  return {
    found: true,
    record_id,
    filename,
    method: parsed.method,
    event: parsed.event,
    events: parsed.events,
    event_count: parsed.event_count,
    truncated: parsed.truncated,
    problems: parsed.problems,
  };
};
