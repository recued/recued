/** What a recipe card says about a recipe's reach: the notification channels
 *  its body names, and the enrichments it reads.
 *
 *  ⛔⛔ COMPUTED FROM THE WHOLE BODY, SO NEVER FROM A `recipe.list` ROW. Both
 *  usually live in `steps`, which a list row has not carried since f95faec10.
 *  The Recipes route used to scan the row. Over the 2,373 shipped recipes that
 *  left all 46 enrichment badges empty, and under-reported channels on 165 of
 *  the 403 that name one. Nothing failed, the pills just stopped appearing.
 *  The server now projects both onto the row (`ServerRecipeListEntry.
 *  notification_channels` / `consumed_enrichments`) from the body it holds.
 *  The client scans only as the fallback for an older server, whose rows
 *  still carry the body.
 *
 *  One definition for both ends, so the projection and the fallback cannot
 *  drift apart. */

import { NOTIFICATION_CHANNEL_NAMES, type NotificationChannelName } from './notifications.js';

/** The notification channels the body names, in vocabulary order. The
 *  vocabulary comes from contracts, so a newly declared chat transport is
 *  detected with no edit here (D-192 seam 10).
 *
 *  ⚠ A SUBSTRING SCAN OF THE WHOLE BODY, kept exactly as the card has always
 *  computed it. It is coarse: `ui` matches inside ordinary words (2,294 of the
 *  shipped recipes report it). Narrowing that is a display change of its
 *  own; this module only moves the scan to where the body is. */
export const recipeNotificationChannels = (recipe: unknown): NotificationChannelName[] => {
  const body = (JSON.stringify(recipe) ?? '').toLowerCase();
  return NOTIFICATION_CHANNEL_NAMES.filter((channel) => body.includes(channel));
};

/** The `data.enrichment.*` refs the body reads, deduplicated, in first-seen
 *  order, at most four: a card shows a few pills, not an inventory. */
export const recipeConsumedEnrichments = (recipe: unknown): string[] => {
  const matches = (JSON.stringify(recipe) ?? '').match(/data\.enrichment\.[a-zA-Z0-9_.-]+/g) ?? [];
  return [...new Set(matches)].slice(0, 4);
};
