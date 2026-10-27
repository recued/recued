import type { Collection } from './types.js';

/** Does `collection` mirror a source, so that a sync verdict describes it: D-236
 *  source freshness, the Digest's mailbox health?
 *
 *  ⛔ An SMTP-only account (D-331) is a `mail` collection that receives nothing.
 *  It holds only the copies Recued kept of what it sent, and its health reports
 *  no sync, ever. Read as a mirror it was "mail has not synced yet · needs
 *  attention" in every Digest and `stale` in every mail search, where `stale`
 *  tells the model an empty result is not a verified absence. There is no
 *  mailbox behind it to fall behind, so it gets no verdict. Every other
 *  collection, a mail collection that does not say, included, is a mirror. */
export const isMirroredCollection = (collection: Pick<Collection, 'platform'>): boolean =>
  collection.platform !== 'mail'
  || (collection as { receiveCapable?: unknown }).receiveCapable !== false;
