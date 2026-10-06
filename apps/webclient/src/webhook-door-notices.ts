/** D-209 — tell the owner when saving a dish's settings moved a webhook door.
 *
 *  A recipe's webhook runs with its MAIN dish's settings, so saving them can
 *  open the webhook's door, change what messages coming in may use, or close it
 *  (`followMainDishWebhookDoors` on the server). The dish rpcs return what
 *  moved as `webhook_doors`, and D-207 §5.1g requires the screen that saved to
 *  say it: a save that widens what a webhook may do must name what it now may.
 *
 *  A recipe's main dish is made or changed from many screens: a dish's
 *  settings (Recipes, Automation, the guided import), and also a schedule, an
 *  owner-made trigger, or switching a timer recipe on, each of which makes the
 *  main dish when the recipe has none. So the notice belongs to the RESULT, not
 *  to a screen: `withWebhookDoorNotices` wraps the app's one rpc connection, and
 *  every rpc in `DISH_WEBHOOK_DOOR_RPCS` announces whatever door it moved,
 *  whichever screen called it, including one added later. It rides the app's
 *  toast stack, and every notice STAYS until dismissed: a webhook that stopped
 *  working must not vanish in six seconds, and the list of what one may now
 *  use is a disclosure, not a flourish.
 *
 *  `webhookDoorToasts` turns a result into toasts; `announcingWebhookDoors`
 *  wraps one call. A result without `webhook_doors` (an older server, or a save
 *  that moved no door) presents nothing. */

import { DISH_WEBHOOK_DOOR_RPCS, type DishWebhookDoorChange } from '@recued/contracts';

export interface WebhookDoorToast {
  readonly title: string;
  readonly text: string;
  readonly sticky: true;
}

const STATES = new Set(['opened', 'unchanged', 'closed', 'kept_revoked']);

const stringsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;

/** The changes a dish rpc's result carries, read defensively: the result
 *  crossed the wire, so anything malformed is dropped rather than rendered. */
const changesOf = (result: unknown): DishWebhookDoorChange[] => {
  if (result === null || typeof result !== 'object') return [];
  const doors = (result as { webhook_doors?: unknown }).webhook_doors;
  if (!Array.isArray(doors)) return [];
  const changes: DishWebhookDoorChange[] = [];
  for (const door of doors) {
    if (door === null || typeof door !== 'object') continue;
    const d = door as Record<string, unknown>;
    if (typeof d.recipe_id !== 'string' || typeof d.state !== 'string' || !STATES.has(d.state)) continue;
    const added = stringsOf(d.added);
    const removed = stringsOf(d.removed);
    changes.push({
      recipe_id: d.recipe_id,
      ...(typeof d.recipe_name === 'string' ? { recipe_name: d.recipe_name } : {}),
      state: d.state as DishWebhookDoorChange['state'],
      was_open: d.was_open === true,
      ...(added !== undefined ? { added } : {}),
      ...(removed !== undefined ? { removed } : {}),
      ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
      ...(d.reason_code === 'no_account' || d.reason_code === 'refused' || d.reason_code === 'fault'
        ? { reason_code: d.reason_code }
        : {}),
    });
  }
  return changes;
};

/** One entry of a door's diff, in words: an account by name, a tool or an
 *  action by the id the Kitchen shows beside a webhook's switch. */
const entryLabel = (entry: string): string => {
  if (entry.startsWith('connection:')) return `the ${entry.slice('connection:'.length)} account`;
  if (entry.startsWith('ingredient:')) return entry.slice('ingredient:'.length);
  return entry;
};

const listOf = (entries: readonly string[] | undefined): string =>
  (entries ?? []).map(entryLabel).join(', ');

const sentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const closedText = (change: DishWebhookDoorChange): string => {
  switch (change.reason_code) {
    case 'no_account':
      return 'Messages coming in are refused until its settings choose an account.';
    case 'refused':
      return change.reason !== undefined && change.reason.trim() !== ''
        ? sentence(`Messages coming in are refused: ${change.reason}`)
        : 'Messages coming in are refused.';
    default:
      return 'Recued could not update this webhook, so messages coming in are refused for now. '
        + 'Save its settings again to retry.';
  }
};

/** The toasts a dish rpc's result calls for — none when it moved no door. */
export const webhookDoorToasts = (result: unknown): WebhookDoorToast[] =>
  changesOf(result).flatMap((change): WebhookDoorToast[] => {
    const name = change.recipe_name?.trim() || change.recipe_id;
    switch (change.state) {
      case 'opened': {
        const added = listOf(change.added);
        if (!change.was_open) {
          return [{
            title: `Webhook on: ${name}`,
            text: added === ''
              ? 'Messages coming in now run with these settings.'
              : `Messages coming in now run with these settings. They may use: ${added}.`,
            sticky: true,
          }];
        }
        const removed = listOf(change.removed);
        const parts = ['These settings changed what messages coming in may use.'];
        if (added !== '') parts.push(removed === '' ? `Now also: ${added}.` : `Now: ${added}.`);
        if (removed !== '') parts.push(`No longer: ${removed}.`);
        return [{ title: `Webhook changed: ${name}`, text: parts.join(' '), sticky: true }];
      }
      case 'closed':
        return [{
          title: change.was_open ? `Webhook off: ${name}` : `Webhook still off: ${name}`,
          text: closedText(change),
          sticky: true,
        }];
      case 'kept_revoked':
        return [{
          title: `Webhook still off: ${name}`,
          text: 'Its access was turned off, and changing its settings does not turn it back on.',
          sticky: true,
        }];
      default:
        // `unchanged` is not news; the server leaves it out of the rpc anyway.
        return [];
    }
  });

/** Wrap a dish rpc so the webhook doors its result moved reach the owner. The
 *  result passes through untouched, and a failed rpc is the caller's to show.
 *  ⚠ The save has already committed when the result arrives, so a notice that
 *  cannot be shown must never turn it into a failure on the caller's screen. */
export const announcingWebhookDoors = <A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
  present: (toast: WebhookDoorToast) => void,
): ((...args: A) => Promise<R>) =>
  (...args) => call(...args).then((result) => {
    try {
      for (const toast of webhookDoorToasts(result)) present(toast);
    } catch {
      // The toast stack is gone (the app is closing) or refused one; the
      // server logs every door change, and the save itself stands.
    }
    return result;
  });

const DOOR_RPCS: ReadonlySet<string> = new Set(DISH_WEBHOOK_DOOR_RPCS);

/** Wrap an rpc connection so every rpc in `DISH_WEBHOOK_DOOR_RPCS` announces
 *  the webhook doors its result moved. Every other call passes straight
 *  through, untouched; the connection's other members are kept as they are. */
export const withWebhookDoorNotices = <C extends { readonly call: unknown }>(
  conn: C,
  present: (toast: WebhookDoorToast) => void,
): C => {
  const call = conn.call as (method: string, ...rest: unknown[]) => Promise<unknown>;
  const announced = announcingWebhookDoors(call, present);
  const routed = (method: string, ...rest: unknown[]): Promise<unknown> =>
    DOOR_RPCS.has(method) ? announced(method, ...rest) : call(method, ...rest);
  return { ...conn, call: routed as C['call'] };
};
