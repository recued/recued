/** Graph's `iCalUId` is Exchange's meeting id in hex, and one from an outside
 *  invite wraps the invite's UID (measured live on the mail realm's Outlook,
 *  2026-11-22). */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EXCHANGE_OUTSIDE_ID_SQL, inviteUidFromExchangeId } from '../exchange-invite-uid.js';
import {
  EXCHANGE_MADE_ID, exchangeIdWrapping, LIVE_EXCHANGE_INVITE_ID, LIVE_INVITE_UID,
} from '../../../__tests__/helpers/exchange-meeting-id.js';

describe("an outside invite's UID, read out of Exchange's meeting id", () => {
  it("reads it from the id Graph gave the live check's event, byte for byte", () => {
    expect(inviteUidFromExchangeId(LIVE_EXCHANGE_INVITE_ID)).toBe(LIVE_INVITE_UID);
    // The tests' builder makes exactly those bytes.
    expect(exchangeIdWrapping(LIVE_INVITE_UID)).toBe(LIVE_EXCHANGE_INVITE_ID);
  });

  it('in lower case, for one occurrence of a series, and for a UID beyond ASCII', () => {
    expect(inviteUidFromExchangeId(exchangeIdWrapping('abc@clinic.example', { lowerCase: true }))).toBe('abc@clinic.example');
    expect(inviteUidFromExchangeId(exchangeIdWrapping('weekly@clinic.example', { instanceDate: '07EA0C0A' }))).toBe('weekly@clinic.example');
    expect(inviteUidFromExchangeId(exchangeIdWrapping('rendez-vous-é@clinique.example'))).toBe('rendez-vous-é@clinique.example');
  });

  it('reads none from a meeting made in Exchange, whose id is its UID, nor from anything else', () => {
    expect(inviteUidFromExchangeId(EXCHANGE_MADE_ID)).toBeUndefined();
    const notOne = [
      undefined, '', 'uid-1@outlook.com', 'AAMkAEVENT1=',
      LIVE_EXCHANGE_INVITE_ID.slice(0, -2), // shorter than its size says
      `${LIVE_EXCHANGE_INVITE_ID}00`, // longer than its size says
      `X${LIVE_EXCHANGE_INVITE_ID.slice(1)}`, // not hex
      `05${LIVE_EXCHANGE_INVITE_ID.slice(2)}`, // another class id
      LIVE_EXCHANGE_INVITE_ID.replace('7643616C2D556964', '7643616C2D556965'), // no `vCal-Uid` signature
      exchangeIdWrapping(''), // no UID
      exchangeIdWrapping('line\nbreak'), // not a UID's text
    ];
    for (const id of notOne) expect(inviteUidFromExchangeId(id)).toBeUndefined();
  });

  it('the stored-row test picks exactly the ids it reads', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (ical_uid TEXT)');
      const ids = [LIVE_EXCHANGE_INVITE_ID, exchangeIdWrapping('abc@clinic.example', { lowerCase: true }), EXCHANGE_MADE_ID, 'uid-1@outlook.com', ''];
      for (const id of ids) db.prepare('INSERT INTO t VALUES (?)').run(id);
      const picked = (db.prepare(`SELECT ical_uid FROM t WHERE ${EXCHANGE_OUTSIDE_ID_SQL}`).all() as Array<{ ical_uid: string }>)
        .map((row) => row.ical_uid);
      expect(picked).toEqual([LIVE_EXCHANGE_INVITE_ID, exchangeIdWrapping('abc@clinic.example', { lowerCase: true })]);
    } finally {
      db.close();
    }
  });
});
