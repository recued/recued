import { RpcError, type HandlerSlice, type ServerRpcRegistry, type YoursCommand, type YoursReadRequest } from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import type { YoursService } from './yours-service.js';

const owner = (client: WsClient) => {
  if (!client.instance_id || client.client_kind !== 'webclient') throw new RpcError('unauthorized', 'Yours requires a paired webclient.', 401);
  return { channel: 'user' as const, actor: 'user_self' as const, user_id: client.user_id ?? 'local',
    client_token_id: client.client_token_id ?? client.instance_id };
};
const errors = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); }
  catch (error) { if (error instanceof RpcError) throw error; throw new RpcError('bad_request', error instanceof Error ? error.message : String(error), 400); }
};
export const makeYoursHandlers = (service?: YoursService): HandlerSlice<ServerRpcRegistry, 'yours.read' | 'yours.change' | 'yours.today' | 'yours.delivery' | 'yours.learning' | 'yours.sphere' | 'yours.spheres', WsClient> | undefined => service ? {
  methods: ['yours.read', 'yours.change', 'yours.today', 'yours.delivery', 'yours.learning', 'yours.sphere', 'yours.spheres'],
  handlers: {
    'yours.delivery': async (_args, client) => { owner(client); return errors(async () => service.deliveryStatus()); },
    'yours.learning': async (_args, client) => { owner(client); return errors(() => service.learningStatus()); },
    'yours.today': async (args, client) => { owner(client); return errors(() => service.today(args)); },
    'yours.read': async (args, client) => { owner(client); return errors(() => service.snapshot((args ?? {}) as YoursReadRequest)); },
    'yours.sphere': async (args, client) => { owner(client); return errors(async () => service.placement(args?.ref)); },
    'yours.spheres': async (args, client) => { owner(client); return errors(async () => {
      if (!Array.isArray(args?.refs) || args.refs.length > 500) throw new Error('Choose up to 500 records to place');
      return { placements: args.refs.map(ref => ({ ref, ...service.placement(ref) })) };
    }); },
    'yours.change': async (args, client) => { const actor = owner(client); return errors(() => service.command(args as YoursCommand, actor)); },
  },
} : undefined;
