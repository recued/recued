/** Shared free-mail / consumer-mail provider domain set.
 *
 *  Lifted from A.10 `company` at the second caller (A.16 `organization`)
 *  per the codebase convention of extracting helpers when a second
 *  producer needs the same constant. Centralising means a domain added
 *  to (or removed from) the consumer-mail set lands in both producers
 *  in one edit; both surfaces emit the same `domain_category: 'free_mail'`
 *  / "skip" semantics for the same input.
 *
 *  The list is intentionally hand-curated rather than scraped — adding
 *  a domain is a deliberate choice + a follow-up commit so we don't
 *  accidentally widen the free-mail surface past what users actually
 *  mean by "consumer". */

export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.jp',
  'ymail.com',
  'rocketmail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'fastmail.com',
  'zoho.com',
  'tutanota.com',
  'tutamail.com',
  'qq.com',
  '163.com',
  '126.com',
]);
