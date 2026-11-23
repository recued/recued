/** An outside invite's iCalendar UID, read out of Exchange's meeting id.
 *
 *  Exchange keeps every meeting under a `GlobalObjectId`: a fixed class id,
 *  the instance's date, a creation time and eight reserved bytes (36 bytes),
 *  then the size of its data (4 bytes, little-endian) and the data. A meeting
 *  that came from outside Exchange, such as an invite a clinic or Gmail sent,
 *  keeps the invite's UID in that data, after the signature `vCal-Uid` and
 *  `01000000`, ending in a NUL ([MS-OXOCAL] PidLidGlobalObjectId; [MS-OXCICAL]
 *  UID). Graph's `iCalUId` is that id in hex. So an Outlook event made from an
 *  emailed invite read `040000008200E00074C5B7101A82E008…7643616C2D556964
 *  01000000<the UID>00`, never the invite's UID (measured live 2026-11-22, the
 *  mail realm), and every join by the invite's UID failed on Outlook: D-407's
 *  booking, and the recipes that tell one event from another by it. Exchange's
 *  own export writes the inner UID back, so an invite Recued reads from an
 *  Outlook meeting email (D-315 slice 7) carries that UID too.
 *
 *  ⛔ Only that form is read. A meeting made in Exchange has no signature, and
 *  its hex id IS the UID every other calendar sees. */

/** The `GlobalObjectId` class id every Exchange meeting id starts with. */
const CLASS_ID = '040000008200E00074C5B7101A82E008';
/** `vCal-Uid` and `01000000`: what starts the data of a meeting from outside. */
const OUTSIDE_SIGNATURE = '7643616C2D55696401000000';
/** Class id, instance date, creation time and reserved bytes, in hex. */
const HEADER_HEX = 72;
const SIZE_HEX = 8;

/** The UID an outside invite gave the meeting with this Exchange id, or
 *  undefined when the id holds none (a meeting made in Exchange, or no
 *  Exchange id at all). */
export const inviteUidFromExchangeId = (id: string | undefined): string | undefined => {
  if (id === undefined || id.length % 2 !== 0 || id.length <= HEADER_HEX + SIZE_HEX + OUTSIDE_SIGNATURE.length) return undefined;
  if (!/^[0-9a-f]+$/iu.test(id) || id.slice(0, CLASS_ID.length).toUpperCase() !== CLASS_ID) return undefined;
  const size = Buffer.from(id.slice(HEADER_HEX, HEADER_HEX + SIZE_HEX), 'hex').readUInt32LE(0);
  const data = id.slice(HEADER_HEX + SIZE_HEX);
  if (data.length !== size * 2 || data.slice(0, OUTSIDE_SIGNATURE.length).toUpperCase() !== OUTSIDE_SIGNATURE) return undefined;
  const bytes = Buffer.from(data.slice(OUTSIDE_SIGNATURE.length), 'hex');
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const uid = bytes.subarray(0, end).toString('utf8');
  // Not text: keep Exchange's id, which at least names the meeting.
  if (uid === '' || uid.includes('\uFFFD') || /[\u0000-\u001F\u007F]/u.test(uid)) return undefined;
  return uid;
};

/** Whether a stored UID is Exchange's id for a meeting from outside, which
 *  `inviteUidFromExchangeId` reads: a SQL test over an `ical_uid` column. */
export const EXCHANGE_OUTSIDE_ID_SQL = `(upper(substr(ical_uid, 1, ${CLASS_ID.length})) = '${CLASS_ID}' `
  + `AND upper(substr(ical_uid, ${HEADER_HEX + SIZE_HEX + 1}, ${OUTSIDE_SIGNATURE.length})) = '${OUTSIDE_SIGNATURE}')`;
