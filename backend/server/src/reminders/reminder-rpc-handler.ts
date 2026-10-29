/** The owner's Automation alarms and Data → Reminders use the same dispatchers.
 *
 *  ⛔ OWNER-ONLY, AND THE SAME ANSWERS AS THE OPS. `reminder.` is an MCP reserved
 *  prefix, so no door reaches these; a door reaches reminders only through the
 *  `core.reminder.*` op grants. Both run the one set of dispatchers, so the list
 *  on the screen and chat's "My reminders" word a time, refuse a passed one and
 *  say what happened in the same words. */

import { RpcError } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry, ReminderListPageInput } from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import { ReminderInputError, type ReminderDispatchers } from './reminder-service.js';
import { ReminderCreationConflictError, ReminderLimitError } from '../storage/reminder-store.js';

type ReminderMethods = 'reminder.create' | 'reminder.list' | 'reminder.update' | 'reminder.cancel';

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

const listPage = (value: unknown): ReminderListPageInput => {
  const fail = (message: string): never => { throw new RpcError('bad_request', message); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('Reminder search needs valid filters.');
  const raw = value as Record<string, unknown>;
  if (raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 200)) return fail('Reminder search must be text of at most 200 characters.');
  const instant = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && Math.abs(at) <= 8.64e15;
  if (raw.from !== undefined && !instant(raw.from) || raw.before !== undefined && !instant(raw.before)) return fail('Reminder dates must be valid instants.');
  if (typeof raw.from === 'number' && typeof raw.before === 'number' && raw.from >= raw.before) return fail('The last reminder date must follow the first.');
  let cursor: ReminderListPageInput['cursor'];
  if (raw.cursor !== undefined) {
    if (raw.cursor === null || typeof raw.cursor !== 'object' || Array.isArray(raw.cursor)) return fail('The reminder page is invalid. Refresh the list.');
    const row = raw.cursor as Record<string, unknown>;
    if (!instant(row.at) || typeof row.reminder_id !== 'string' || !row.reminder_id || row.reminder_id.length > 128) return fail('The reminder page is invalid. Refresh the list.');
    cursor = { at: row.at, reminder_id: row.reminder_id };
  }
  return {
    ...(typeof raw.query === 'string' ? { query: raw.query.trim() } : {}),
    ...(typeof raw.from === 'number' ? { from: raw.from } : {}),
    ...(typeof raw.before === 'number' ? { before: raw.before } : {}),
    ...(cursor ? { cursor } : {}),
  };
};

/** A refusal the owner can act on (a passed time, no words) reads as itself. */
const asRpcError = (err: unknown): never => {
  if (err instanceof ReminderCreationConflictError) throw new RpcError('conflict', err.message, 409);
  if (err instanceof ReminderInputError || err instanceof ReminderLimitError) throw new RpcError('bad_request', err.message);
  throw err;
};

export const makeReminderHandlers = (
  deps: { dispatchers: ReminderDispatchers } | undefined,
): HandlerSlice<ServerRpcRegistry, ReminderMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const { dispatchers } = deps;
  return {
    methods: ['reminder.create', 'reminder.list', 'reminder.update', 'reminder.cancel'],
    handlers: {
      'reminder.create': async (args, client) => {
        requireClient(client);
        const input = args as { text?: unknown; at?: unknown; creation_id?: unknown } | null | undefined;
        if (typeof input?.text !== 'string') throw new RpcError('bad_request', 'An alarm needs words to say.');
        if (typeof input.at !== 'number' || !Number.isFinite(input.at)) throw new RpcError('bad_request', 'An alarm needs a valid time.');
        if (typeof input.creation_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.creation_id)) {
          throw new RpcError('bad_request', 'An alarm needs a stable creation ID.');
        }
        return dispatchers.reminderCreate({ text: input.text, at: input.at,
          creation_id: JSON.stringify([client.instance_id, input.creation_id]), origin: { channel: 'manual' } }).catch(asRpcError);
      },
      'reminder.list': async (args, client) => {
        requireClient(client);
        const input = (args ?? {}) as { include_delivered?: unknown; limit?: unknown; page?: unknown };
        return dispatchers.reminderList({
          ...(input.include_delivered === true ? { include_delivered: true } : {}),
          ...(typeof input.limit === 'number' && Number.isFinite(input.limit) ? { limit: input.limit } : {}),
          ...(input.page !== undefined ? { page: listPage(input.page) } : {}),
        });
      },
      'reminder.update': async (args, client) => {
        requireClient(client);
        const reminder_id = requireId(args, 'reminder.update');
        const input = args as { text?: unknown; at?: unknown };
        const patch: { reminder_id: string; text?: string; at?: number } = { reminder_id };
        if (input.text !== undefined) {
          if (typeof input.text !== 'string') throw new RpcError('bad_request', 'A reminder needs words to say.');
          patch.text = input.text;
        }
        if (input.at !== undefined) {
          if (typeof input.at !== 'number' || !Number.isFinite(input.at)) throw new RpcError('bad_request', 'A reminder needs a valid time.');
          patch.at = input.at;
        }
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
