/** Narrow DOM-watch classification shared by authoring and publish policy.
 *
 * Keep this independent of the full trigger-sugar registry: the public Edge
 * recipe gate needs only this structural check and must not pull the entire
 * connection-vendor graph into its generated bundle. */

import type { RecipeEventTrigger } from './recipe.js';
import { DOM_WATCH_PLATFORM } from './watch.js';

/** DOM-watch shorthand. The poll source emits only `updated`, so the authored
 * form deliberately exposes `changed` and no created/removed variants. */
export const ELEMENT_ON_SHORTHAND = 'element.changed';

/** True when an entry subscribes to a DOM watch through either the shorthand
 * or the raw `data.dom.*` bus namespace. */
export const isDomWatchTriggerEntry = (
  entry: Pick<RecipeEventTrigger, 'on' | 'event'>,
): boolean =>
  entry.on === ELEMENT_ON_SHORTHAND
  || (typeof entry.event === 'string'
    && entry.event.startsWith(`data.${DOM_WATCH_PLATFORM}.`));
