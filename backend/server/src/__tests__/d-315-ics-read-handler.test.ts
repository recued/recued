/** D-315 slice 7 — `core.storage.ics.read`'s handler: the I/O around the
 *  shared parser. What it reads, what it refuses without reading, and the two
 *  things only the server knows — the owner's addresses and zone. */

import { describe, expect, it } from 'vitest';

import { handleIcsRead, type IcsReadDeps } from '../collections/file/ics-read-handler.js';

const INVITE = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST',
  'BEGIN:VEVENT', 'UID:abc123@google.com', 'DTSTART:20261015T100000', 'DTEND:20261015T110000',
  'ORGANIZER:mailto:alice@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@alias.example',
  'SUMMARY:Quarterly planning', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

const files = (stored: Record<string, { hot: Record<string, unknown>; text: string }>) => {
  const reads: string[] = [];
  const deps: IcsReadDeps = {
    stat: (id) => stored[id]?.hot ?? null,
    readFile: async ({ record_id }, maxBytes) => {
      reads.push(record_id);
      const text = stored[record_id]!.text;
      if (Buffer.byteLength(text) > maxBytes) throw new Error('file_too_large');
      return { bytes_b64: Buffer.from(text).toString('base64') };
    },
    ownerAddresses: () => ['me@owner.example'],
    ownerTimeZone: () => 'America/Los_Angeles',
  };
  return { deps, reads };
};

describe('core.storage.ics.read', () => {
  it("reads an invite, its floating time in the owner's zone", async () => {
    const { deps } = files({ 'file:a': { hot: { filename: 'invite.ics', mime_type: 'text/calendar', size: INVITE.length }, text: INVITE } });
    const result = await handleIcsRead(deps, { record_id: 'file:a' });
    expect(result).toMatchObject({ found: true, record_id: 'file:a', filename: 'invite.ics', method: 'request', event_count: 1 });
    expect(result.event).toMatchObject({ summary: 'Quarterly planning', start: '2026-10-15T17:00:00.000Z', time_basis: 'floating' });
  });

  it("knows the owner by every mailbox's address, and by the addresses a recipe adds", async () => {
    const { deps } = files({ 'file:a': { hot: { filename: 'invite.ics', mime_type: 'text/calendar' }, text: INVITE } });
    expect((await handleIcsRead(deps, { record_id: 'file:a' })).event!.you.role).toBe('none');
    expect((await handleIcsRead(deps, { record_id: 'file:a', addresses: ['me@alias.example'] })).event!.you.role).toBe('attendee');
    // A setting holds them comma-separated.
    expect((await handleIcsRead(deps, { record_id: 'file:a', addresses: ' x@y.example , me@alias.example' })).event!.you)
      .toMatchObject({ role: 'attendee', email: 'me@alias.example', status: 'needs_action' });
  });

  it('a file that is no calendar is found: false — and its bytes are never read', async () => {
    const { deps, reads } = files({ 'file:pdf': { hot: { filename: 'agenda.pdf', mime_type: 'application/pdf', size: 10 }, text: '%PDF-1.4' } });
    expect(await handleIcsRead(deps, { record_id: 'file:pdf' })).toMatchObject({ found: false, method: 'none', event: null, events: [] });
    expect(reads).toEqual([]);
  });

  it('an .ics stored before invites were typed is read by its name', async () => {
    const { deps } = files({ 'file:old': { hot: { filename: 'invite.ics', mime_type: 'text/plain' }, text: INVITE } });
    expect((await handleIcsRead(deps, { record_id: 'file:old' })).found).toBe(true);
  });

  it('a calendar type over bytes that are no calendar is found: false', async () => {
    const { deps } = files({ 'file:x': { hot: { filename: 'x.ics', mime_type: 'text/calendar' }, text: 'not a calendar' } });
    expect((await handleIcsRead(deps, { record_id: 'file:x' })).found).toBe(false);
  });

  it('a file over the limit is refused unread, and says why', async () => {
    const { deps, reads } = files({ 'file:big': { hot: { filename: 'big.ics', mime_type: 'text/calendar', size: 5_000_000 }, text: INVITE } });
    expect(await handleIcsRead(deps, { record_id: 'file:big' })).toMatchObject({
      found: false, problems: ['the file is larger than 1048576 bytes'],
    });
    expect(reads).toEqual([]);
  });

  it('no id, or an id no file has, is an error — a recipe named something wrong', async () => {
    const { deps } = files({});
    await expect(handleIcsRead(deps, {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleIcsRead(deps, { record_id: 'file:nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
