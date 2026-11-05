/** Where a situation's record opens in the app: an asset, an occasion or an episode in Yours, a
 *  calendar event in its own calendar, anything else on its Data page. Today's rows link with it,
 *  and so do the names an Agenda links (D-338 §11), so a name and its row open the same place. */
import type { SituationRef } from '@recued/contracts';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';

export const situationRefHref = (ref: SituationRef): string => {
  if (ref.collection === 'asset') return serializeShellRoute('yours', 'asset', ref.id);
  // Yours selects one at `#yours/occasions/occasion/<id>` and `#yours/episodes/episode/<id>`.
  if (ref.collection === 'episode') return serializeShellRoute('yours', 'episodes', 'episode', ref.id);
  if (ref.collection === 'occasion') return serializeShellRoute('yours', 'occasions', 'occasion', ref.id);
  if (ref.collection === 'calendar' && ref.id.includes(':')) return serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: ref.id.slice(0, ref.id.indexOf(':')), recordId: ref.id.slice(ref.id.indexOf(':') + 1) });
  if (ref.collection === 'reminder') return '#data/reminder';
  // A bill or delivery opens as itself: the facts list alone left the owner to find it.
  if (ref.collection === 'mail_fact') return serializeShellRoute('data', 'mail_fact', 'thing', ref.id);
  return serializeShellRoute('data', ref.collection, ref.id);
};
