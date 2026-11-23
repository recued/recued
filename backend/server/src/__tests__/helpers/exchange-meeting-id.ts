/** Exchange's meeting ids as Graph gives them in `iCalUId`, for tests: one that
 *  wraps an outside invite's UID, and one for a meeting made in Exchange
 *  (`collections/calendar/exchange-invite-uid.ts`). ⚠ Graph never gives a
 *  plain UID such as `uid-1@outlook.com`: a fixture with one made the vendor
 *  up, and hid that no join by the invite's UID worked on Outlook. */

/** The id Graph gave the live check's event, byte for byte: an invite emailed
 *  from the mail realm's Gmail to its Outlook mailbox, which Exchange added to
 *  the calendar (2026-11-22). */
export const LIVE_EXCHANGE_INVITE_ID = '040000008200E00074C5B7101A82E008'
  + '00000000000000000000000000000000000000002D0000007643616C2D556964010000'
  + '00643430372D6C6976652D31373935343032343034407265637565642E7465737400';
/** The UID that invite gave the meeting. */
export const LIVE_INVITE_UID = 'd407-live-1795402404@recued.test';

/** Exchange's id for a meeting from outside: class id, instance date, creation
 *  time and reserved bytes, the data's size, then `vCal-Uid` 01000000, the
 *  invite's UID and a NUL. */
export const exchangeIdWrapping = (uid: string, opts: { instanceDate?: string; lowerCase?: boolean } = {}): string => {
  const data = Buffer.concat([Buffer.from('vCal-Uid', 'latin1'), Buffer.from([1, 0, 0, 0]), Buffer.from(uid, 'utf8'), Buffer.from([0])]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  const id = `040000008200E00074C5B7101A82E008${opts.instanceDate ?? '00000000'}${'0'.repeat(32)}${size.toString('hex')}${data.toString('hex')}`
    .toUpperCase();
  return opts.lowerCase === true ? id.toLowerCase() : id;
};

/** Exchange's id for a meeting made in Exchange: no signature, sixteen bytes
 *  of its own. Its hex IS the UID every other calendar sees. */
export const EXCHANGE_MADE_ID = '040000008200E00074C5B7101A82E00800000000'
  + '8026B4E8D35DDB01' + '0000000000000000' + '10000000' + '6F2A4B1E9C3D4E5F8A7B6C5D4E3F2A1B';
