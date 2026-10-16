/** D-324 — the Data → Reminders list's rpc: `reminder.list`, `reminder.update`,
 *  `reminder.cancel`.
 *
 *  ⛔ OWNER-ONLY, AND THE SAME ANSWERS AS THE OPS. `reminder.` is an MCP reserved
 *  prefix, so no door reaches these; a door reaches reminders only through the
 *  `core.reminder.*` op grants. Both run the one set of dispatchers, so the list
 *  on the screen and chat's "My reminders" word a time, refuse a passed one and
 *  say what happened in the same words. */

import { RpcError } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import { ReminderInputError, type ReminderDispatchers } from './reminder-service.js';

type ReminderMethods = 'reminder.list' | 'reminder.update' | 'reminder.cancel';

/** The owner's webclient only, as the Data screens' other rpc are: never a
 *  Bridge, the CLI or MCP. */
const requireClient = (client: WsClient): void => {
  if (!client.instance_id || client.client_kind !== 'webclient') {
    throw new RpcError('unauthorized', 'Reminders require a paired webclient.', 401);
  }
};

const requireId = (raw: unknown, method: string): string => {
  const id = (raw as { reminder_id?: unknown } | undefined)?.reminder_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new RpcError('bad_request', `${method}: reminder_id is required`);
  }
  return id;
};

/** A refusal the owner can act on (a passed time, no words) reads as itself. */
const asRpcError = (err: unknown): never => {
  if (err instanceof ReminderInputError) throw new RpcError('bad_request', err.message);
  throw err;
};

export const makeReminderHandlers = (
  deps: { dispatchers: ReminderDispatchers } | undefined,
): HandlerSlice<ServerRpcRegistry, ReminderMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const { dispatchers } = deps;
  return {
    methods: ['reminder.list', 'reminder.update', 'reminder.cancel'],
    handlers: {
      'reminder.list': async (args, client) => {
        requireClient(client);
        const input = (args ?? {}) as { include_delivered?: unknown; limit?: unknown };
        return dispatchers.reminderList({
          ...(input.include_delivered === true ? { include_delivered: true } : {}),
          ...(typeof input.limit === 'number' && Number.isFinite(input.limit) ? { limit: input.limit } : {}),
        });
      },
      'reminder.update': async (args, client) => {
        requireClient(client);
        const reminder_id = requireId(args, 'reminder.update');
        const input = args as { text?: unknown; at?: unknown };
        const patch: { reminder_id: string; text?: string; at?: number } = { reminder_id };
        if (typeof input.text === 'string' && input.text.trim().length > 0) patch.text = input.text;
        if (typeof input.at === 'number' && Number.isFinite(input.at)) patch.at = input.at;
        if (patch.text === undefined && patch.at === undefined) {
          throw new RpcError('bad_request', 'reminder.update: give a new text, a new time, or both');
        }
        return dispatchers.reminderUpdate(patch).catch(asRpcError);
      },
      'reminder.cancel': async (args, client) => {
        requireClient(client);
        return dispatchers.reminderCancel({ reminder_id: requireId(args, 'reminder.cancel') });
      },
    },
  };
};
